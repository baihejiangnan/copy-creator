use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};

use base64::Engine as _;

pub static PASTING: AtomicBool = AtomicBool::new(false);
static SENSITIVE_CLIPBOARD_SEQUENCE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

pub fn sensitive_clipboard_sequence() -> u32 {
    SENSITIVE_CLIPBOARD_SEQUENCE.load(Ordering::SeqCst)
}

pub fn clear_sensitive_clipboard() {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard};
        let expected = sensitive_clipboard_sequence();
        if expected == 0 || OpenClipboard(None).is_err() { return; }
        // Check while holding the native clipboard lock, so a later user copy
        // cannot be erased between checking ownership and clearing the data.
        let current = GetClipboardSequenceNumber();
        let finished = current != expected || EmptyClipboard().is_ok();
        let _ = CloseClipboard();
        if finished {
            let _ = SENSITIVE_CLIPBOARD_SEQUENCE.compare_exchange(expected, 0, Ordering::SeqCst, Ordering::SeqCst);
        }
    }
}

pub fn copy_sensitive_text(app: AppHandle, text: String) -> Result<(), String> {
    if PASTING.swap(true, Ordering::SeqCst) { return Err("vault.clipboardBusy".into()); }
    let _guard = PasteGuard;
    let text = zeroize::Zeroizing::new(text);
    write_sensitive_clipboard(&app, &text).map(|_| ())
}

// The caller keeps PasteGuard alive for the entire copy / focus / paste operation.
fn write_sensitive_clipboard(app: &AppHandle, text: &str) -> Result<u32, String> {
    let _capture = crate::clipboard::capture_guard();
    #[cfg(target_os = "windows")]
    let sequence = write_private_clipboard_text(app, text)?;
    #[cfg(not(target_os = "windows"))]
    let sequence = {
        app.clipboard().write_text(text).map_err(|_| "vault.copyFailed")?;
        0
    };
    SENSITIVE_CLIPBOARD_SEQUENCE.store(sequence, Ordering::SeqCst);
    crate::clipboard::sync_monitor_cache(app);
    std::thread::spawn(move || {
        thread::sleep(Duration::from_secs(30));
        for _ in 0..10 {
            if sensitive_clipboard_sequence() != sequence { break; }
            clear_sensitive_clipboard();
            thread::sleep(Duration::from_millis(50));
        }
    });
    Ok(sequence)
}

#[cfg(target_os = "windows")]
fn write_private_clipboard_text(app: &AppHandle, text: &str) -> Result<u32, String> {
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::DataExchange::{EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW};
    let window = app.get_webview_window("main").ok_or("vault.copyFailed")?;
    let raw_hwnd = window.hwnd().map_err(|_| "vault.copyFailed")?;
    unsafe { OpenClipboard(HWND(raw_hwnd.0)) }.map_err(|_| "vault.clipboardBusy")?;
    let _clipboard = WindowsClipboardSession;
    unsafe { EmptyClipboard() }.map_err(|_| "vault.copyFailed")?;
    // Register the documented Windows opt-out formats in the same clipboard
    // transaction as the text. The OS sees the protection flags before closing.
    for name in [w!("CanIncludeInClipboardHistory"), w!("CanUploadToCloudClipboard"), w!("ExcludeClipboardContentFromMonitorProcessing")] {
        let format = unsafe { RegisterClipboardFormatW(name) };
        if format == 0 { return Err("vault.copyFailed".into()); }
        set_clipboard_bytes(format, &0u32.to_le_bytes(), "private flag").map_err(|_| "vault.copyFailed")?;
    }
    let bytes = zeroize::Zeroizing::new(text.encode_utf16().chain(std::iter::once(0)).flat_map(u16::to_le_bytes).collect::<Vec<_>>());
    set_clipboard_bytes(13, &bytes, "private text").map_err(|_| "vault.copyFailed")?;
    Ok(unsafe { GetClipboardSequenceNumber() })
}

#[cfg(target_os = "windows")]
static LAST_FOREGROUND_TARGET: Mutex<Option<ForegroundTarget>> = Mutex::new(None);

#[cfg(target_os = "windows")]
fn process_is_elevated(process_id: u32) -> Option<bool> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) { unsafe { let _ = CloseHandle(self.0); } }
    }
    unsafe {
        let process = OwnedHandle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?);
        let mut token = HANDLE::default();
        OpenProcessToken(process.0, TOKEN_QUERY, &mut token).ok()?;
        let token = OwnedHandle(token);
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0;
        GetTokenInformation(token.0, TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut returned).ok()?;
        Some(elevation.TokenIsElevated != 0)
    }
}

#[cfg(target_os = "windows")]
fn elevation_blocks_paste(source: Option<bool>, target: Option<bool>) -> bool {
    // Unknown token information does not prove a permission mismatch.
    source == Some(false) && target == Some(true)
}

#[cfg(target_os = "windows")]
fn target_requires_elevation(target: ForegroundTarget) -> bool {
    elevation_blocks_paste(process_is_elevated(std::process::id()),
        process_is_elevated(target.window_process))
}

// Keep the window, focused control and their owners together. A paste snapshots
// this value once, so a later foreground event cannot redirect a credential.
#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Default)]
struct ForegroundTarget {
    window: usize,
    focus: usize,
    window_thread: u32,
    window_process: u32,
    focus_thread: u32,
    focus_process: u32,
}

#[cfg(target_os = "windows")]
fn window_identity(hwnd: windows::Win32::Foundation::HWND) -> (u32, u32) {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let mut process = 0;
    let thread = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process)) };
    (thread, process)
}

#[cfg(target_os = "windows")]
impl ForegroundTarget {
    fn window(self) -> windows::Win32::Foundation::HWND {
        windows::Win32::Foundation::HWND(self.window as *mut core::ffi::c_void)
    }

    fn focus(self) -> windows::Win32::Foundation::HWND {
        windows::Win32::Foundation::HWND(self.focus as *mut core::ffi::c_void)
    }

    fn valid(self, require_focus: bool) -> bool {
        use windows::Win32::UI::WindowsAndMessaging::{IsChild, IsWindow};
        let window = self.window();
        let focus = self.focus();
        unsafe {
            if window.is_invalid()
                || window.0 == OUR_HWND.load(Ordering::SeqCst)
                || window.0 == RADIAL_HWND.load(Ordering::SeqCst)
                || !IsWindow(window).as_bool()
                || self.window_thread == 0
                || self.window_process == 0
                || window_identity(window) != (self.window_thread, self.window_process)
            {
                return false;
            }
            if !require_focus {
                return true;
            }
            !focus.is_invalid()
                && IsWindow(focus).as_bool()
                && self.focus_thread != 0
                && self.focus_process != 0
                && window_identity(focus) == (self.focus_thread, self.focus_process)
                && (focus == window || IsChild(window, focus).as_bool())
        }
    }
}

#[cfg(target_os = "windows")]
static OUR_HWND: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(ptr::null_mut());

#[cfg(target_os = "windows")]
static RADIAL_HWND: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(ptr::null_mut());

#[cfg(target_os = "windows")]
pub fn register_radial_hwnd(window: &tauri::WebviewWindow) {
    let hwnd = window.hwnd().unwrap_or_default();
    RADIAL_HWND.store(hwnd.0, Ordering::SeqCst);
}

#[cfg(target_os = "windows")]
fn remember_foreground_target(hwnd: windows::Win32::Foundation::HWND, thread_id: u32) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
    };

    // Native tray menus and file dialogs belong to this process too. They must
    // not replace the last external window when they take foreground/focus.
    if hwnd.is_invalid() || window_identity(hwnd).1 == std::process::id() {
        return;
    }

    unsafe {
        let target_thread = if thread_id == 0 {
            GetWindowThreadProcessId(hwnd, None)
        } else {
            thread_id
        };
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        let focus = if target_thread != 0 && GetGUIThreadInfo(target_thread, &mut info).is_ok() {
            if !info.hwndFocus.is_invalid() {
                info.hwndFocus
            } else if !info.hwndCaret.is_invalid() {
                info.hwndCaret
            } else {
                HWND::default()
            }
        } else {
            HWND::default()
        };
        let (window_thread, window_process) = window_identity(hwnd);
        let (focus_thread, focus_process) = window_identity(focus);
        if let Ok(mut saved) = LAST_FOREGROUND_TARGET.lock() {
            *saved = Some(ForegroundTarget {
                window: hwnd.0 as usize,
                focus: focus.0 as usize,
                window_thread,
                window_process,
                focus_thread,
                focus_process,
            });
        }

        log::debug!(
            "[paste] saved foreground=0x{:x}, focus=0x{:x}, thread={}",
            hwnd.0 as usize,
            focus.0 as usize,
            target_thread
        );
    }
}

#[cfg(target_os = "windows")]
pub fn save_foreground_window() {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    unsafe {
        let hwnd = GetForegroundWindow();
        let our = OUR_HWND.load(Ordering::SeqCst);
        let radial = RADIAL_HWND.load(Ordering::SeqCst);
        if !hwnd.is_invalid() && hwnd.0 != our && hwnd.0 != radial {
            remember_foreground_target(hwnd, GetWindowThreadProcessId(hwnd, None));
        }
    }
}

#[cfg(target_os = "windows")]
fn saved_target_has_focus(saved: ForegroundTarget, require_focus: bool) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, IsChild, IsWindow,
        GUITHREADINFO,
    };

    unsafe {
        let target = saved.window();
        if !saved.valid(require_focus) || GetForegroundWindow() != target {
            return false;
        }

        let saved_focus = saved.focus();
        if saved_focus.is_invalid() || !IsWindow(saved_focus).as_bool() {
            return !require_focus;
        }

        let focus_thread = GetWindowThreadProcessId(saved_focus, None);
        if focus_thread == 0 {
            return false;
        }
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if GetGUIThreadInfo(focus_thread, &mut info).is_err() {
            return false;
        }

        let current_focus = if !info.hwndFocus.is_invalid() {
            info.hwndFocus
        } else {
            info.hwndCaret
        };
        if current_focus.is_invalid() {
            return false;
        }
        current_focus == saved_focus
            || (!require_focus && (IsChild(saved_focus, current_focus).as_bool()
                || IsChild(current_focus, saved_focus).as_bool()))
    }
}

#[cfg(target_os = "windows")]
fn restore_foreground_target(saved: ForegroundTarget, require_focus: bool) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowThreadProcessId, IsWindow, PeekMessageW, SetForegroundWindow, MSG, PM_NOREMOVE,
    };

    unsafe {
        let target = saved.window();
        if !saved.valid(require_focus) {
            return false;
        }

        let saved_focus = saved.focus();
        let focus_valid = !saved_focus.is_invalid() && IsWindow(saved_focus).as_bool();
        let current_thread = GetCurrentThreadId();
        let target_thread = GetWindowThreadProcessId(target, None);
        let focus_thread = if focus_valid {
            GetWindowThreadProcessId(saved_focus, None)
        } else {
            0
        };

        // AttachThreadInput requires the caller to own a message queue.
        let mut message = MSG::default();
        let _ = PeekMessageW(&mut message, HWND::default(), 0, 0, PM_NOREMOVE);

        let attached_target = target_thread != 0
            && target_thread != current_thread
            && AttachThreadInput(current_thread, target_thread, true).as_bool();
        let attached_focus = focus_thread != 0
            && focus_thread != current_thread
            && focus_thread != target_thread
            && AttachThreadInput(current_thread, focus_thread, true).as_bool();

        let foreground_set = SetForegroundWindow(target).as_bool();
        if focus_valid {
            let _ = SetFocus(saved_focus);
        }
        let ready = saved_target_has_focus(saved, require_focus);

        if attached_focus {
            let _ = AttachThreadInput(current_thread, focus_thread, false);
        }
        if attached_target {
            let _ = AttachThreadInput(current_thread, target_thread, false);
        }

        log::debug!(
            "[paste] restore foreground=0x{:x}, focus=0x{:x}, set={}, ready={}",
            target.0 as usize,
            saved_focus.0 as usize,
            foreground_set,
            ready
        );
        ready || (!require_focus && foreground_set && !focus_valid)
    }
}

#[cfg(target_os = "windows")]
fn restore_foreground_target_and_wait(saved: ForegroundTarget, require_focus: bool) -> bool {
    let _ = restore_foreground_target(saved, require_focus);
    let start = std::time::Instant::now();
    let timeout = Duration::from_millis(180);
    let mut retried = false;

    loop {
        if saved_target_has_focus(saved, require_focus) {
            return true;
        }
        if !retried && start.elapsed() >= Duration::from_millis(60) {
            let _ = restore_foreground_target(saved, require_focus);
            retried = true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "windows")]
fn paste_modifiers_released() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    [VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN, VK_SHIFT]
        .iter()
        .all(|key| unsafe { (GetAsyncKeyState(key.0 as i32) as u16) & 0x8000 == 0 })
}

pub fn paste_sensitive_text(app: AppHandle, text: zeroize::Zeroizing<String>) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, text);
        Err("vault.pasteUnsupported".into())
    }

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
        use windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;

        if PASTING.swap(true, Ordering::SeqCst) {
            return Err("vault.clipboardBusy".into());
        }
        let _guard = PasteGuard;
        let target = LAST_FOREGROUND_TARGET
            .lock()
            .map_err(|_| "vault.pasteNoTarget")?
            .filter(|target| target.valid(false))
            .ok_or("vault.pasteNoTarget")?;
        // Refuse before copying credentials, hiding windows or sending input.
        if target_requires_elevation(target) {
            return Err("vault.pasteRequiresElevation".into());
        }
        if !target.valid(true) {
            return Err("vault.pasteNoTarget".into());
        }
        let window = app.get_webview_window("main").ok_or("vault.pasteFailed")?;
        let hide = !window.is_always_on_top().map_err(|_| "vault.pasteFailed")?;
        let mut enigo = Enigo::new(&Settings::default()).map_err(|_| "vault.pasteFailed")?;

        // Do not reinterpret Ctrl+V as a different shortcut if popup gesture
        // modifiers remain held. In this case no credential is copied either.
        let start = std::time::Instant::now();
        while !paste_modifiers_released() {
            if start.elapsed() >= Duration::from_millis(500) {
                return Err("vault.pasteModifiersHeld".into());
            }
            thread::sleep(Duration::from_millis(10));
        }
        if !target.valid(true) {
            return Err("vault.pasteNoTarget".into());
        }

        let sequence = write_sensitive_clipboard(&app, &text)?;
        let result = (|| {
            unsafe { let _ = AllowSetForegroundWindow(0xFFFFFFFF); }
            if let Some(radial) = app.get_webview_window("radial-menu") {
                radial.hide().map_err(|_| "vault.pasteFailed")?;
            }
            if hide {
                crate::lifecycle::hide_main(&window).map_err(|_| "vault.pasteFailed")?;
            }
            if !restore_foreground_target_and_wait(target, true) {
                return Err("vault.pasteNoTarget");
            }
            if !paste_modifiers_released() {
                return Err("vault.pasteModifiersHeld");
            }
            if unsafe { GetClipboardSequenceNumber() } != sequence {
                return Err("vault.pasteClipboardChanged");
            }

            let pressed = enigo.key(Key::Control, Direction::Press);
            // Check the same captured window / control and clipboard again
            // immediately before V. Always release our Ctrl, including errors.
            let pasted = if pressed.is_err() {
                Err("vault.pasteFailed")
            } else if !saved_target_has_focus(target, true) {
                Err("vault.pasteNoTarget")
            } else if unsafe { GetClipboardSequenceNumber() } != sequence {
                Err("vault.pasteClipboardChanged")
            } else {
                enigo.key(Key::V, Direction::Click).map_err(|_| "vault.pasteFailed")
            };
            let released = enigo.key(Key::Control, Direction::Release).map_err(|_| "vault.pasteFailed");
            pasted.and(released)
        })();

        if let Err(error) = result {
            clear_sensitive_clipboard();
            if hide {
                // Return to the locked app so a focus failure is visible and
                // the user can retry or choose the ordinary copy button.
                let _ = crate::lifecycle::show_main(&window);
                let _ = window.set_focus();
            }
            return Err(error.into());
        }
        Ok(())
    }
}

#[cfg(all(test, target_os = "windows"))]
mod private_paste_tests {
    use super::ForegroundTarget;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WINDOW_STYLE};

    #[test]
    fn elevation_warning_requires_a_confirmed_mismatch() {
        for source in [Some(false), Some(true), None] {
            for target in [Some(false), Some(true), None] {
                assert_eq!(super::elevation_blocks_paste(source, target),
                    source == Some(false) && target == Some(true));
            }
        }
    }

    #[test]
    fn native_token_query_accepts_self_and_rejects_missing_process() {
        let own = super::process_is_elevated(std::process::id());
        assert!(own.is_some());
        assert!(!super::elevation_blocks_paste(own, own));
        assert_eq!(super::process_is_elevated(0), None);
    }

    #[test]
    #[ignore = "Requires an explicitly selected elevated process; reads tokens only, sends no input"]
    fn confirmed_elevated_process_requires_warning() {
        let process = std::env::var("COPY_CREATOR_TEST_ELEVATED_PID")
            .expect("Select a known elevated test target PID").parse().unwrap();
        assert_eq!(super::process_is_elevated(std::process::id()), Some(false));
        assert_eq!(super::process_is_elevated(process), Some(true));
        assert!(super::target_requires_elevation(ForegroundTarget {
            window_process: process, ..Default::default()
        }));
    }

    struct HiddenTestWindow(HWND);

    impl HiddenTestWindow {
        fn new() -> Self {
            // No WS_VISIBLE, focus changes, clipboard writes or keyboard input.
            Self(unsafe { CreateWindowExW(
                WINDOW_EX_STYLE::default(), windows::core::w!("STATIC"),
                windows::core::w!("private paste validation"), WINDOW_STYLE::default(),
                0, 0, 1, 1, None, None, None, None,
            ) }.unwrap())
        }

        fn target(&self) -> ForegroundTarget {
            let (thread, process) = super::window_identity(self.0);
            ForegroundTarget {
                window: self.0.0 as usize, focus: self.0.0 as usize,
                window_thread: thread, window_process: process,
                focus_thread: thread, focus_process: process,
            }
        }
    }

    impl Drop for HiddenTestWindow {
        fn drop(&mut self) { unsafe { let _ = DestroyWindow(self.0); } }
    }

    #[test]
    fn an_owned_native_menu_or_dialog_cannot_replace_the_external_paste_target() {
        let native_window = HiddenTestWindow::new();
        *super::LAST_FOREGROUND_TARGET.lock().unwrap() = None;
        super::remember_foreground_target(native_window.0, 0);
        assert!(super::LAST_FOREGROUND_TARGET.lock().unwrap().is_none());
    }

    #[test]
    fn missing_or_destroyed_target_never_allows_private_paste() {
        let missing = ForegroundTarget::default();
        assert!(!missing.valid(true));
        assert!(!super::saved_target_has_focus(missing, true));
        let invalid = ForegroundTarget {
            window: usize::MAX,
            focus: usize::MAX,
            window_thread: 1,
            window_process: 1,
            focus_thread: 1,
            focus_process: 1,
        };
        assert!(!invalid.valid(true));
        assert!(!super::restore_foreground_target_and_wait(invalid, true));
    }

    #[test]
    fn private_paste_rejects_replaced_window_owners_and_closed_controls() {
        let window = HiddenTestWindow::new();
        let target = window.target();
        assert!(target.valid(true));
        assert!(!ForegroundTarget { window_process: target.window_process + 1, ..target }.valid(true));
        assert!(!ForegroundTarget { focus_thread: target.focus_thread + 1, ..target }.valid(true));
        assert!(!ForegroundTarget { focus: 0, ..target }.valid(true));
        // Ordinary clipboard pastes retain the previous no-control fallback.
        assert!(ForegroundTarget { focus: 0, ..target }.valid(false));
        drop(window);
        assert!(!target.valid(true));
    }

    #[test]
    fn private_paste_rejects_a_control_from_a_different_window() {
        let window = HiddenTestWindow::new();
        let other = HiddenTestWindow::new();
        let target = window.target();
        let other_target = other.target();
        assert!(!ForegroundTarget {
            focus: other_target.focus,
            focus_thread: other_target.focus_thread,
            focus_process: other_target.focus_process,
            ..target
        }.valid(true));
    }
}

#[cfg(target_os = "windows")]
pub fn init_foreground_tracker(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::Accessibility::SetWinEventHook;
    use windows::Win32::UI::WindowsAndMessaging::WINEVENT_OUTOFCONTEXT;

    const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;
    const EVENT_OBJECT_FOCUS: u32 = 0x8005;

    let our_hwnd = window.hwnd().unwrap_or_default();
    OUR_HWND.store(our_hwnd.0, Ordering::SeqCst);

    unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(foreground_change_hook),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        // When a pinned panel stays open, selecting another control inside the
        // same external window does not raise a foreground-window event.
        SetWinEventHook(
            EVENT_OBJECT_FOCUS,
            EVENT_OBJECT_FOCUS,
            None,
            Some(focus_change_hook),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn foreground_change_hook(
    _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
    _event: u32,
    hwnd: windows::Win32::Foundation::HWND,
    _id_object: i32,
    _id_child: i32,
    event_thread: u32,
    _event_time: u32,
) {
    let our = OUR_HWND.load(Ordering::SeqCst);
    let radial = RADIAL_HWND.load(Ordering::SeqCst);
    if !PASTING.load(Ordering::SeqCst) && hwnd.0 != our && hwnd.0 != radial && !hwnd.is_invalid() {
        remember_foreground_target(hwnd, event_thread);
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn focus_change_hook(
    _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
    _event: u32,
    hwnd: windows::Win32::Foundation::HWND,
    _id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GA_ROOT};
    if PASTING.load(Ordering::SeqCst) || hwnd.is_invalid() { return; }
    let root = GetAncestor(hwnd, GA_ROOT);
    if !root.is_invalid()
        && root == GetForegroundWindow()
        && root.0 != OUR_HWND.load(Ordering::SeqCst)
        && root.0 != RADIAL_HWND.load(Ordering::SeqCst)
    {
        remember_foreground_target(root, 0);
    }
}

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

struct CachedImage {
    rgba: Arc<Vec<u8>>,
    width: u32,
    height: u32,
    png_bytes: Arc<Vec<u8>>,
}

struct ImageCache {
    epoch: Option<u64>,
    map: HashMap<String, CachedImage>,
    order: Vec<String>,
}

impl ImageCache {
    fn bind_epoch(&mut self, epoch: u64) {
        if self.epoch != Some(epoch) {
            self.map.clear();
            self.order.clear();
            self.epoch = Some(epoch);
        }
    }
}

static IMAGE_CACHE: OnceLock<Mutex<ImageCache>> = OnceLock::new();

fn get_image_cache() -> &'static Mutex<ImageCache> {
    IMAGE_CACHE.get_or_init(|| {
        Mutex::new(ImageCache {
            epoch: None,
            map: HashMap::new(),
            order: Vec::new(),
        })
    })
}

struct PasteGuard;

impl Drop for PasteGuard {
    fn drop(&mut self) {
        PASTING.store(false, Ordering::SeqCst);
    }
}

pub fn cache_image(app: &AppHandle, path: String, rgba: Vec<u8>, width: u32, height: u32, png_bytes: Vec<u8>) {
    let mut cache = get_image_cache().lock().unwrap();
    cache.bind_epoch(app.state::<crate::db::DbState>().storage_epoch.load(Ordering::Relaxed));
    // Evict oldest entries (deterministic insertion order)
    if cache.map.len() >= 30 {
        let evict_count = 15.min(cache.order.len());
        let evicted: Vec<String> = cache.order.drain(..evict_count).collect();
        for k in &evicted {
            cache.map.remove(k);
        }
    }
    cache.order.push(path.clone());
    cache.map.insert(
        path,
        CachedImage {
            rgba: Arc::new(rgba),
            width,
            height,
            png_bytes: Arc::new(png_bytes),
        },
    );
}

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

type ClipboardImageData = (Arc<Vec<u8>>, u32, u32, Arc<Vec<u8>>);

fn paste_directory_for_identifier(base: &std::path::Path, identifier: &str) -> std::path::PathBuf {
    use sha2::{Digest, Sha256};
    if identifier == "com.copycreator.app" {
        base.join("copy_creator_paste")
    } else {
        // Keep alternate instances out of the legacy production cleanup tree.
        // A digest gives a fixed, safe path component for any configured ID.
        base.join("copy_creator_paste_instances").join(format!("{:x}", Sha256::digest(identifier.as_bytes())))
    }
}

pub(crate) fn paste_image_directory(app: &AppHandle) -> std::path::PathBuf {
    paste_directory_for_identifier(&std::env::temp_dir(), &app.config().identifier)
}

fn load_image_for_clipboard(app: &AppHandle, path: &str) -> Result<ClipboardImageData, String> {
    {
        let mut cache = get_image_cache().lock().map_err(|_| "clipboard.copyFailed")?;
        cache.bind_epoch(app.state::<crate::db::DbState>().storage_epoch.load(Ordering::Relaxed));
        if let Some(cached) = cache.map.get(path) {
            return Ok((
                cached.rgba.clone(),
                cached.width,
                cached.height,
                cached.png_bytes.clone(),
            ));
        }
    }

    let image_path = crate::db::get_storage_dir(app).join(path);
    let bytes = std::fs::read(&image_path)
        .map_err(|e| format!("read image {}: {e}", image_path.display()))?;
    let image = image::load_from_memory(&bytes).map_err(|e| format!("decode image: {e}"))?;
    let rgba = image.to_rgba8().into_raw();
    let (width, height) = (image.width(), image.height());
    let png_bytes = if image::guess_format(&bytes).ok() == Some(image::ImageFormat::Png) {
        bytes
    } else {
        let mut output = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|e| format!("encode clipboard PNG: {e}"))?;
        output.into_inner()
    };

    cache_image(
        app,
        path.to_string(),
        rgba.clone(),
        width,
        height,
        png_bytes.clone(),
    );
    Ok((Arc::new(rgba), width, height, Arc::new(png_bytes)))
}

fn paste_with_defocus(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let clipboard_sequence = unsafe {
        windows::Win32::System::DataExchange::GetClipboardSequenceNumber()
    };
    #[cfg(target_os = "windows")]
    let target = LAST_FOREGROUND_TARGET.lock().map_err(|_| "clipboard.pasteFailed")?
        .filter(|target| target.valid(false)).ok_or("clipboard.pasteFailed")?;
    #[cfg(target_os = "windows")]
    if target_requires_elevation(target) {
        return Err("clipboard.pasteRequiresElevation".into());
    }
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;
        let _ = AllowSetForegroundWindow(0xFFFFFFFF);
    }

    // Hide radial popup if visible
    if let Some(radial) = app.get_webview_window("radial-menu") {
        let _ = radial.hide();
    }

    let window = app.get_webview_window("main").ok_or("no window")?;

    if !window.is_always_on_top().unwrap_or(false) {
        crate::lifecycle::hide_main(&window).map_err(|e| e.to_string())?;
    }

    // Wait for modifiers from the popup gestures to be released before sending Ctrl+V.
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
        };
        let start = std::time::Instant::now();
        let timeout = Duration::from_millis(500);
        loop {
            let ctrl_up = unsafe { (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16) & 0x8000 } == 0;
            let alt_up = unsafe { (GetAsyncKeyState(VK_MENU.0 as i32) as u16) & 0x8000 } == 0;
            let win_up = unsafe {
                (GetAsyncKeyState(VK_LWIN.0 as i32) as u16) & 0x8000 == 0
                    && (GetAsyncKeyState(VK_RWIN.0 as i32) as u16) & 0x8000 == 0
            };
            let shift_up = unsafe { (GetAsyncKeyState(VK_SHIFT.0 as i32) as u16) & 0x8000 } == 0;
            if ctrl_up && alt_up && win_up && shift_up {
                break;
            }
            if start.elapsed() > timeout {
                return Err("clipboard.pasteFailed".into());
            }
            thread::sleep(Duration::from_millis(10));
        }
        if !restore_foreground_target_and_wait(target, false) {
            return Err("clipboard.pasteFailed".into());
        }
        // Give clipboard-change consumers and target activation a bounded
        // settling interval. Foreground/focus/modifiers are checked again below;
        // this is not a confirmation that the destination has pasted anything.
        thread::sleep(Duration::from_millis(100));
    }

    #[cfg(not(target_os = "windows"))]
    {
        thread::sleep(Duration::from_millis(200));
    }

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        if !saved_target_has_focus(target, false) || !paste_modifiers_released() {
            return Err("clipboard.pasteFailed".into());
        }
        let pressed = enigo.key(Key::Control, Direction::Press);
        thread::sleep(Duration::from_millis(30));
        let pasted = if pressed.is_ok() && saved_target_has_focus(target, false) {
            // Windows shell clipboard consumers can temporarily hold the
            // clipboard after a write. Wait before sending V, never resend it:
            // a blind retry could duplicate content in an external application.
            use windows::Win32::Foundation::HWND;
            use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardSequenceNumber, OpenClipboard};
            use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};
            let target_ready = || {
                saved_target_has_focus(target, false)
                    && unsafe { GetClipboardSequenceNumber() } == clipboard_sequence
                    && [VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN].iter().all(|key| {
                        unsafe { (GetAsyncKeyState(key.0 as i32) as u16) & 0x8000 == 0 }
                    })
            };
            let deadline = std::time::Instant::now() + Duration::from_millis(200);
            let ready = loop {
                if !target_ready() { break false; }
                if unsafe { OpenClipboard(HWND::default()) }.is_ok() {
                    let _ = unsafe { CloseClipboard() };
                    break true;
                }
                if std::time::Instant::now() >= deadline { break false; }
                thread::sleep(Duration::from_millis(5));
            };
            if ready && target_ready() {
                enigo.key(Key::V, Direction::Click).map_err(|_| "clipboard.pasteFailed")
            } else { Err("clipboard.pasteFailed") }
        } else { Err("clipboard.pasteFailed") };
        thread::sleep(Duration::from_millis(10));
        let released = enigo.key(Key::Control, Direction::Release).map_err(|_| "clipboard.pasteFailed");
        pasted.and(released)?;
    }

    #[cfg(target_os = "macos")]
    {
        enigo
            .key(Key::Meta, Direction::Press)
            .map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(30));
        enigo
            .key(Key::V, Direction::Press)
            .map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(10));
        enigo
            .key(Key::V, Direction::Release)
            .map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(10));
        enigo
            .key(Key::Meta, Direction::Release)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn build_image_html(png_bytes: &[u8]) -> Vec<u8> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(png_bytes);
    let img_tag = format!("<img src=\"data:image/png;base64,{}\"/>", b64);
    let fragment = format!("<!--StartFragment-->{}<!--EndFragment-->", img_tag);
    let html_body = format!("<html><body>{}</body></html>", fragment);

    // Build a template header with placeholder zeros to measure its exact length
    let placeholder_header = "Version:0.9\r\nStartHTML:00000000\r\nEndHTML:00000000\r\nStartFragment:00000000\r\nEndFragment:00000000\r\n";
    let header_len = placeholder_header.len();

    // Offsets are byte positions in the combined data (header + body)
    let start_html = header_len;
    let end_html = header_len + html_body.len();
    let start_frag = header_len + html_body.find(&fragment).unwrap_or(0);
    let end_frag =
        header_len + html_body.find("<!--EndFragment-->").unwrap_or(0) + "<!--EndFragment-->".len();

    let header = format!(
        "Version:0.9\r\nStartHTML:{:08}\r\nEndHTML:{:08}\r\nStartFragment:{:08}\r\nEndFragment:{:08}\r\n",
        start_html, end_html, start_frag, end_frag,
    );

    let mut result = header.into_bytes();
    result.extend_from_slice(html_body.as_bytes());
    result
}

#[cfg(target_os = "windows")]
struct WindowsClipboardSession;

#[cfg(target_os = "windows")]
impl WindowsClipboardSession {
    fn open() -> Result<Self, String> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::System::DataExchange::OpenClipboard;

        unsafe { OpenClipboard(HWND::default()) }
            .map_err(|error| format!("OpenClipboard failed: {error}"))?;
        Ok(Self)
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsClipboardSession {
    fn drop(&mut self) {
        use windows::Win32::System::DataExchange::CloseClipboard;

        let _ = unsafe { CloseClipboard() };
    }
}

#[cfg(target_os = "windows")]
struct OwnedGlobalMemory {
    handle: Option<windows::Win32::Foundation::HGLOBAL>,
}

#[cfg(target_os = "windows")]
impl OwnedGlobalMemory {
    fn copy_from(bytes: &[u8], label: &str) -> Result<Self, String> {
        use windows::Win32::System::Memory::{
            GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
        };

        if bytes.is_empty() {
            return Err(format!("{label} clipboard data is empty"));
        }

        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }
            .map_err(|error| format!("GlobalAlloc {label} failed: {error}"))?;
        let memory = Self {
            handle: Some(handle),
        };
        let pointer = unsafe { GlobalLock(handle) };
        if pointer.is_null() {
            return Err(format!("GlobalLock {label} failed"));
        }

        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer as *mut u8, bytes.len());
            let _ = GlobalUnlock(handle);
        }
        Ok(memory)
    }

    fn as_handle(&self) -> windows::Win32::Foundation::HANDLE {
        windows::Win32::Foundation::HANDLE(
            self.handle
                .as_ref()
                .expect("global memory was already transferred")
                .0,
        )
    }

    fn transfer_to_clipboard(mut self) {
        self.handle = None;
    }
}

#[cfg(target_os = "windows")]
impl Drop for OwnedGlobalMemory {
    fn drop(&mut self) {
        use windows::Win32::Foundation::GlobalFree;

        if let Some(handle) = self.handle.take() {
            let _ = unsafe { GlobalFree(handle) };
        }
    }
}

#[cfg(target_os = "windows")]
fn set_clipboard_bytes(format: u32, bytes: &[u8], label: &str) -> Result<(), String> {
    use windows::Win32::System::DataExchange::SetClipboardData;

    let memory = OwnedGlobalMemory::copy_from(bytes, label)?;
    unsafe { SetClipboardData(format, memory.as_handle()) }
        .map_err(|error| format!("SetClipboardData {label} failed: {error}"))?;
    memory.transfer_to_clipboard();
    Ok(())
}

#[cfg(target_os = "windows")]
fn build_clipboard_dib(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let width_i32 = i32::try_from(width).map_err(|_| "Image width is too large".to_string())?;
    let height_i32 = i32::try_from(height).map_err(|_| "Image height is too large".to_string())?;
    if width_i32 <= 0 || height_i32 <= 0 {
        return Err("Image dimensions must be positive".to_string());
    }

    let pixel_count = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| "Image dimensions overflow".to_string())?;
    let rgba_len = pixel_count
        .checked_mul(4)
        .ok_or_else(|| "Image byte length overflow".to_string())?;
    if rgba.len() != rgba_len {
        return Err(format!(
            "Invalid RGBA length: expected {rgba_len}, got {}",
            rgba.len()
        ));
    }

    let dib_size = 40usize
        .checked_add(rgba_len)
        .ok_or_else(|| "DIB allocation size overflow".to_string())?;
    let image_size = u32::try_from(rgba_len)
        .map_err(|_| "Image data is too large for a Windows DIB".to_string())?;
    let top_down_height = height_i32
        .checked_neg()
        .ok_or_else(|| "Image height cannot be represented as a DIB".to_string())?;

    let mut dib = vec![0u8; dib_size];
    dib[0..4].copy_from_slice(&40u32.to_le_bytes());
    dib[4..8].copy_from_slice(&width_i32.to_le_bytes());
    dib[8..12].copy_from_slice(&top_down_height.to_le_bytes());
    dib[12..14].copy_from_slice(&1u16.to_le_bytes());
    dib[14..16].copy_from_slice(&32u16.to_le_bytes());
    dib[20..24].copy_from_slice(&image_size.to_le_bytes());

    for (source, destination) in rgba.chunks_exact(4).zip(dib[40..].chunks_exact_mut(4)) {
        destination.copy_from_slice(&[source[2], source[1], source[0], source[3]]);
    }
    Ok(dib)
}

#[cfg(all(test, target_os = "windows"))]
mod windows_clipboard_tests {
    use super::build_clipboard_dib;

    #[test]
    fn builds_checked_top_down_bgra_dib() {
        let dib = build_clipboard_dib(&[1, 2, 3, 4, 5, 6, 7, 8], 2, 1)
            .expect("valid RGBA should produce a DIB");

        assert_eq!(&dib[4..8], &2i32.to_le_bytes());
        assert_eq!(&dib[8..12], &(-1i32).to_le_bytes());
        assert_eq!(&dib[40..48], &[3, 2, 1, 4, 7, 6, 5, 8]);
    }

    #[test]
    fn rejects_mismatched_rgba_length() {
        assert!(build_clipboard_dib(&[0; 7], 2, 1).is_err());
        assert!(build_clipboard_dib(&[], 0, 1).is_err());
    }
}

#[cfg(target_os = "windows")]
fn write_image_to_clipboard(app: &AppHandle, rgba: &[u8], w: u32, h: u32, png_bytes: &[u8]) -> Result<(), String> {
    use windows::Win32::System::DataExchange::{EmptyClipboard, RegisterClipboardFormatW};
    use windows::Win32::UI::Shell::DROPFILES;

    const CF_DIB: u32 = 8;
    const CF_HDROP: u32 = 15;
    const MAX_CLIPBOARD_PNG_BYTES: usize = 512 * 1024 * 1024;

    let dib = build_clipboard_dib(rgba, w, h)?;
    if png_bytes.is_empty() || png_bytes.len() > MAX_CLIPBOARD_PNG_BYTES {
        return Err("PNG clipboard data has an invalid size".to_string());
    }

    // Write PNG to a temp file for CF_HDROP
    let temp_png_path = {
        let mut dir = paste_image_directory(app);
        std::fs::create_dir_all(&dir).ok();
        dir.push(format!("paste_{}.png", uuid::Uuid::new_v4()));
        std::fs::write(&dir, png_bytes).map_err(|e| format!("Temp file write: {}", e))?;
        dir
    };
    let wide_path: Vec<u16> = temp_png_path
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0u16))
        .collect();

    let _clipboard = WindowsClipboardSession::open()?;
    unsafe { EmptyClipboard() }.map_err(|error| format!("EmptyClipboard failed: {error}"))?;
    set_clipboard_bytes(CF_DIB, &dib, "DIB")?;

    unsafe {
        let png_format_name: Vec<u16> = "PNG\0".encode_utf16().collect();
        let cf_png = RegisterClipboardFormatW(windows::core::PCWSTR(png_format_name.as_ptr()));
        if cf_png != 0 {
            set_clipboard_bytes(cf_png, png_bytes, "PNG")?;
        }

        // Write HTML format for Electron/Chromium-based apps (Feishu, DingTalk, etc.)
        let html_data = build_image_html(png_bytes);
        let html_format_name: Vec<u16> = "HTML Format\0".encode_utf16().collect();
        let cf_html = RegisterClipboardFormatW(windows::core::PCWSTR(html_format_name.as_ptr()));
        if cf_html != 0 {
            set_clipboard_bytes(cf_html, &html_data, "HTML")?;
        }

        // Write CF_HDROP (temp file path) — required by Electron/Chromium apps
        {
            let dropfiles_size = std::mem::size_of::<DROPFILES>();
            let path_bytes = wide_path
                .len()
                .checked_mul(std::mem::size_of::<u16>())
                .ok_or_else(|| "HDROP path size overflow".to_string())?;
            let data_size = dropfiles_size
                .checked_add(path_bytes)
                .ok_or_else(|| "HDROP allocation size overflow".to_string())?;
            let mut data: Vec<u8> = vec![0u8; data_size];
            let dropfiles_offset = u32::try_from(dropfiles_size)
                .map_err(|_| "DROPFILES header is too large".to_string())?;
            data[0..4].copy_from_slice(&dropfiles_offset.to_le_bytes());
            data[16..20].copy_from_slice(&1i32.to_le_bytes());
            for (destination, unit) in data[dropfiles_size..]
                .chunks_exact_mut(2)
                .zip(wide_path.iter())
            {
                destination.copy_from_slice(&unit.to_le_bytes());
            }
            set_clipboard_bytes(CF_HDROP, &data, "HDROP")?;
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn write_files_to_clipboard(paths: &[String]) -> Result<(), String> {
    use windows::Win32::System::DataExchange::EmptyClipboard;
    use windows::Win32::UI::Shell::DROPFILES;

    const CF_HDROP: u32 = 15;

    if paths.is_empty() {
        return Err("No files were provided for the clipboard".to_string());
    }

    let wide_paths: Vec<Vec<u16>> = paths
        .iter()
        .map(|p| p.encode_utf16().chain(std::iter::once(0u16)).collect())
        .collect();
    let total_wide_len = wide_paths
        .iter()
        .try_fold(1usize, |total, path| total.checked_add(path.len()))
        .ok_or_else(|| "File path clipboard data is too large".to_string())?;

    let dropfiles_size = std::mem::size_of::<DROPFILES>();
    let path_bytes = total_wide_len
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or_else(|| "File path clipboard byte length overflow".to_string())?;
    let data_size = dropfiles_size
        .checked_add(path_bytes)
        .ok_or_else(|| "HDROP allocation size overflow".to_string())?;

    let mut data: Vec<u8> = vec![0u8; data_size];
    let dropfiles_offset =
        u32::try_from(dropfiles_size).map_err(|_| "DROPFILES header is too large".to_string())?;
    data[0..4].copy_from_slice(&dropfiles_offset.to_le_bytes());
    data[16..20].copy_from_slice(&1i32.to_le_bytes());

    let mut position = dropfiles_size;
    for path in &wide_paths {
        for unit in path {
            data[position..position + 2].copy_from_slice(&unit.to_le_bytes());
            position += 2;
        }
    }

    let _clipboard = WindowsClipboardSession::open()?;
    unsafe { EmptyClipboard() }.map_err(|error| format!("EmptyClipboard failed: {error}"))?;
    set_clipboard_bytes(CF_HDROP, &data, "HDROP")?;

    Ok(())
}

enum ClipboardAction {
    Text(String),
    Image(String),
    File(String),
}

// Runs only inside a registered blocking worker. Its permit covers decoding,
// clipboard ownership, focus restoration and the final key release.
fn perform_action(app: &AppHandle, action: ClipboardAction, paste_after: bool) -> Result<(), String> {
    if PASTING.swap(true, Ordering::SeqCst) {
        return Err("clipboard.busy".into());
    }
    let _guard = PasteGuard;
    match action {
        ClipboardAction::Text(text) => {
            let _capture = crate::clipboard::capture_guard();
            app.clipboard().write_text(text).map_err(|_| "clipboard.copyFailed")?;
            crate::clipboard::sync_monitor_cache(app);
        }
        ClipboardAction::Image(path) => {
            let (rgba, width, height, png) = load_image_for_clipboard(app, &path)
                .map_err(|_| "clipboard.copyFailed")?;
            let _capture = crate::clipboard::capture_guard();
            #[cfg(target_os = "windows")]
            write_image_to_clipboard(app, &rgba, width, height, &png).map_err(|_| "clipboard.copyFailed")?;
            #[cfg(not(target_os = "windows"))]
            app.clipboard().write_image(&tauri::image::Image::new_owned(rgba.to_vec(), width, height))
                .map_err(|_| "clipboard.copyFailed")?;
            crate::clipboard::sync_monitor_cache(app);
        }
        ClipboardAction::File(path) => {
            std::fs::metadata(&path).map_err(|_| "notes.fileMissing")?;
            let _capture = crate::clipboard::capture_guard();
            #[cfg(target_os = "windows")]
            write_files_to_clipboard(std::slice::from_ref(&path)).map_err(|_| "clipboard.copyFailed")?;
            #[cfg(not(target_os = "windows"))]
            app.clipboard().write_text(&path).map_err(|_| "clipboard.copyFailed")?;
            crate::clipboard::sync_monitor_cache(app);
        }
    }
    if paste_after {
        if let Err(error) = paste_with_defocus(app) {
            // The worker permit keeps the event tied to this storage identity.
            // Emit no target, clipboard contents or platform error details.
            if error == "clipboard.pasteRequiresElevation" {
                let _ = crate::storage_events::emit(app, "clipboard-paste-failed", "requiresElevation");
                return Err(error);
            }
            let _ = crate::storage_events::emit(app, "clipboard-paste-failed", true);
            return Err("clipboard.pasteFailed".into());
        }
    }
    Ok(())
}

async fn run_action(app: AppHandle, expected_storage_epoch: u64, action: ClipboardAction, paste_after: bool) -> Result<(), String> {
    let permit = crate::lifecycle::accept_async_operation(&app)?;
    crate::db::require_storage_epoch(&app, Some(expected_storage_epoch))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        perform_action(&app, action, paste_after)
    }).await.map_err(|_| "clipboard.copyFailed")?
}

#[tauri::command]
pub async fn copy_text(app: AppHandle, text: String, expected_storage_epoch: u64) -> Result<(), String> {
    run_action(app, expected_storage_epoch, ClipboardAction::Text(text), false).await
}

#[tauri::command]
pub async fn paste_text(app: AppHandle, text: String, expected_storage_epoch: u64) -> Result<(), String> {
    run_action(app, expected_storage_epoch, ClipboardAction::Text(text), true).await
}

#[tauri::command]
pub async fn copy_image(app: AppHandle, path: String, expected_storage_epoch: u64) -> Result<(), String> {
    run_action(app, expected_storage_epoch, ClipboardAction::Image(path), false).await
}

#[tauri::command]
pub async fn paste_image(app: AppHandle, path: String, expected_storage_epoch: u64) -> Result<(), String> {
    run_action(app, expected_storage_epoch, ClipboardAction::Image(path), true).await
}

#[tauri::command]
pub async fn copy_file(app: AppHandle, path: String, expected_storage_epoch: u64) -> Result<(), String> {
    run_action(app, expected_storage_epoch, ClipboardAction::File(path), false).await
}

#[tauri::command]
pub async fn paste_file(app: AppHandle, path: String, expected_storage_epoch: u64) -> Result<(), String> {
    run_action(app, expected_storage_epoch, ClipboardAction::File(path), true).await
}

pub fn run_record_action(app: &AppHandle, epoch: u64, id: String, paste_after: bool) -> Result<(), String> {
    let permit = crate::lifecycle::accept_async_operation(app)?;
    crate::db::require_storage_epoch(app, Some(epoch))?;
    let app = app.clone();
    // The native menu callback must stay nonblocking. Register before spawning,
    // so a handoff cannot drain between the callback and the worker's start.
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let result = crate::db::get_clipboard_action_record(&app, &id).and_then(|record| {
            let action = match record.record_type.as_str() {
                "image" => ClipboardAction::Image(record.content),
                "file" => ClipboardAction::File(record.content),
                _ => ClipboardAction::Text(record.content),
            };
            perform_action(&app, action, paste_after)
        });
        if result.is_err() { log::warn!("tray clipboard action failed"); }
    });
    Ok(())
}

#[cfg(test)]
mod cache_identity_tests {
    use super::*;
    #[test]
    fn alternate_instances_never_write_or_clean_the_production_paste_directory() {
        let base = std::path::Path::new("synthetic-temp-root");
        let production = paste_directory_for_identifier(base, "com.copycreator.app");
        let qa = paste_directory_for_identifier(base, "com.copycreator.qa20261007");
        let other = paste_directory_for_identifier(base, "com.copycreator.other");
        assert_eq!(production, base.join("copy_creator_paste"));
        assert!(!qa.starts_with(&production));
        assert_ne!(qa, other);
        assert_eq!(qa, paste_directory_for_identifier(base, "com.copycreator.qa20261007"));
        assert_eq!(qa.file_name().unwrap().to_string_lossy().len(), 64);
        assert!(paste_directory_for_identifier(base, "../../com.copycreator.app").starts_with(base.join("copy_creator_paste_instances")));
    }
    #[test]
    fn identical_relative_paths_cannot_reuse_images_from_a_previous_store() {
        let mut cache = ImageCache { epoch: Some(1), map: HashMap::new(), order: vec!["images/same.png".into()] };
        cache.map.insert("images/same.png".into(), CachedImage { rgba: Arc::new(vec![1,2,3,4]), width: 1, height: 1, png_bytes: Arc::new(vec![5]) });
        cache.bind_epoch(1);
        assert_eq!(cache.map.len(), 1);
        cache.bind_epoch(2);
        assert!(cache.map.is_empty());
        assert!(cache.order.is_empty());
        assert_eq!(cache.epoch, Some(2));
    }
}
