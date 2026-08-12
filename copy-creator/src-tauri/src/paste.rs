use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};

use base64::Engine as _;

pub static PASTING: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
static LAST_FOREGROUND_HWND: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(ptr::null_mut());

#[cfg(target_os = "windows")]
static LAST_FOCUS_HWND: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(ptr::null_mut());

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

    if hwnd.is_invalid() {
        return;
    }

    unsafe {
        LAST_FOREGROUND_HWND.store(hwnd.0, Ordering::SeqCst);

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
        LAST_FOCUS_HWND.store(focus.0, Ordering::SeqCst);

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
fn saved_target_has_focus() -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, IsChild, IsWindow,
        GUITHREADINFO,
    };

    unsafe {
        let target = HWND(LAST_FOREGROUND_HWND.load(Ordering::SeqCst));
        if target.is_invalid() || !IsWindow(target).as_bool() || GetForegroundWindow() != target {
            return false;
        }

        let saved_focus = HWND(LAST_FOCUS_HWND.load(Ordering::SeqCst));
        if saved_focus.is_invalid() || !IsWindow(saved_focus).as_bool() {
            return true;
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
            || IsChild(saved_focus, current_focus).as_bool()
            || IsChild(current_focus, saved_focus).as_bool()
    }
}

#[cfg(target_os = "windows")]
fn restore_foreground_target() -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowThreadProcessId, IsWindow, PeekMessageW, SetForegroundWindow, MSG, PM_NOREMOVE,
    };

    unsafe {
        let target = HWND(LAST_FOREGROUND_HWND.load(Ordering::SeqCst));
        if target.is_invalid() || !IsWindow(target).as_bool() {
            return false;
        }

        let saved_focus = HWND(LAST_FOCUS_HWND.load(Ordering::SeqCst));
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
        let ready = saved_target_has_focus();

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
        ready || (foreground_set && !focus_valid)
    }
}

#[cfg(target_os = "windows")]
fn restore_foreground_target_and_wait() -> bool {
    let _ = restore_foreground_target();
    let start = std::time::Instant::now();
    let timeout = Duration::from_millis(180);
    let mut retried = false;

    loop {
        if saved_target_has_focus() {
            return true;
        }
        if !retried && start.elapsed() >= Duration::from_millis(60) {
            let _ = restore_foreground_target();
            retried = true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "windows")]
pub fn init_foreground_tracker(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::Accessibility::SetWinEventHook;
    use windows::Win32::UI::WindowsAndMessaging::WINEVENT_OUTOFCONTEXT;

    const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;

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

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

struct CachedImage {
    rgba: Arc<Vec<u8>>,
    width: u32,
    height: u32,
    png_bytes: Arc<Vec<u8>>,
}

struct ImageCache {
    map: HashMap<String, CachedImage>,
    order: Vec<String>,
}

static IMAGE_CACHE: OnceLock<Mutex<ImageCache>> = OnceLock::new();

fn get_image_cache() -> &'static Mutex<ImageCache> {
    IMAGE_CACHE.get_or_init(|| {
        Mutex::new(ImageCache {
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

pub fn cache_image(path: String, rgba: Vec<u8>, width: u32, height: u32, png_bytes: Vec<u8>) {
    let mut cache = get_image_cache().lock().unwrap();
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

fn load_image_for_clipboard(app: &AppHandle, path: &str) -> Result<ClipboardImageData, String> {
    {
        let cache = get_image_cache().lock().map_err(|e| e.to_string())?;
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
        window.hide().map_err(|e| e.to_string())?;
    }

    // Wait for modifiers from the popup gestures to be released before sending Ctrl+V.
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN,
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
            if ctrl_up && alt_up && win_up {
                break;
            }
            if start.elapsed() > timeout {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let restored = restore_foreground_target_and_wait();
        if !restored {
            log::warn!("[paste] target focus was not confirmed before Ctrl+V");
        }
        thread::sleep(Duration::from_millis(10));
    }

    #[cfg(not(target_os = "windows"))]
    {
        thread::sleep(Duration::from_millis(200));
    }

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        enigo
            .key(Key::Control, Direction::Press)
            .map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(30));
        enigo
            .key(Key::V, Direction::Click)
            .map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(10));
        enigo
            .key(Key::Control, Direction::Release)
            .map_err(|e| e.to_string())?;
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
fn write_image_to_clipboard(rgba: &[u8], w: u32, h: u32, png_bytes: &[u8]) -> Result<(), String> {
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
        let mut dir = std::env::temp_dir();
        dir.push("copy_creator_paste");
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

fn write_text(app: AppHandle, text: String, paste_after: bool) -> Result<(), String> {
    if PASTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let guard = PasteGuard;

    if let Err(e) = app.clipboard().write_text(text) {
        drop(guard);
        return Err(e.to_string());
    }

    crate::clipboard::sync_monitor_cache(&app);

    if paste_after {
        let handle = app.clone();
        std::thread::spawn(move || {
            let _guard = guard;
            paste_with_defocus(&handle).ok();
        });
    } else {
        drop(guard);
    }

    Ok(())
}

#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    write_text(app, text, false)
}

#[tauri::command]
pub fn paste_text(app: AppHandle, text: String) -> Result<(), String> {
    write_text(app, text, true)
}

fn write_image(app: AppHandle, path: String, paste_after: bool) -> Result<(), String> {
    if PASTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        let _guard = PasteGuard;
        let (rgba, w, h, png) = match load_image_for_clipboard(&handle, &path) {
            Ok(image) => image,
            Err(error) => {
                log::error!("write_image: {error}");
                return;
            }
        };

        #[cfg(target_os = "windows")]
        {
            if let Err(e) = write_image_to_clipboard(&rgba, w, h, &png) {
                log::error!("write_image: clipboard error: {e}");
                return;
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let tauri_img = tauri::image::Image::new_owned(rgba.to_vec(), w, h);
            if let Err(e) = handle.clipboard().write_image(&tauri_img) {
                log::error!("paste_image: write clipboard error: {}", e);
                return;
            }
        }

        crate::clipboard::sync_monitor_cache(&handle);
        if paste_after {
            paste_with_defocus(&handle).ok();
        }
    });

    Ok(())
}

#[tauri::command]
pub fn copy_image(app: AppHandle, path: String) -> Result<(), String> {
    write_image(app, path, false)
}

#[tauri::command]
pub fn paste_image(app: AppHandle, path: String) -> Result<(), String> {
    write_image(app, path, true)
}

fn write_file(app: AppHandle, path: String, paste_after: bool) -> Result<(), String> {
    if PASTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let file_meta = std::fs::metadata(&path);
    if file_meta.is_err() {
        log::error!("write_file: file not found: {}", path);
        PASTING.store(false, Ordering::SeqCst);
        return Err(format!("File not found: {}", path));
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        let _guard = PasteGuard;

        #[cfg(target_os = "windows")]
        {
            if let Err(e) = write_files_to_clipboard(std::slice::from_ref(&path)) {
                log::error!("write_file: clipboard error: {}", e);
                return;
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            if let Err(e) = handle.clipboard().write_text(&path) {
                log::error!("paste_file: write clipboard error: {}", e);
                return;
            }
        }

        crate::clipboard::sync_monitor_cache(&handle);
        if paste_after {
            paste_with_defocus(&handle).ok();
        }
    });

    Ok(())
}

#[tauri::command]
pub fn copy_file(app: AppHandle, path: String) -> Result<(), String> {
    write_file(app, path, false)
}

#[tauri::command]
pub fn paste_file(app: AppHandle, path: String) -> Result<(), String> {
    write_file(app, path, true)
}

fn run_record_action(app: &AppHandle, id: &str, paste_after: bool) -> Result<(), String> {
    let record = crate::db::get_clipboard_action_record(app, id)?;
    match (record.record_type.as_str(), paste_after) {
        ("image", false) => copy_image(app.clone(), record.content),
        ("image", true) => paste_image(app.clone(), record.content),
        ("file", false) => copy_file(app.clone(), record.content),
        ("file", true) => paste_file(app.clone(), record.content),
        (_, false) => copy_text(app.clone(), record.content),
        (_, true) => paste_text(app.clone(), record.content),
    }
}

pub fn copy_record_by_id(app: &AppHandle, id: &str) -> Result<(), String> {
    run_record_action(app, id, false)
}

pub fn paste_record_by_id(app: &AppHandle, id: &str) -> Result<(), String> {
    run_record_action(app, id, true)
}
