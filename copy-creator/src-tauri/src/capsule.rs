use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub(crate) const WINDOW_LABEL: &str = "capsule";

pub(crate) const WINDOW_WIDTH: f64 = 460.0;
pub(crate) const WINDOW_HEIGHT: f64 = 76.0;
// Expanded height = 76px base + 6px row gap + 120px capped text + 10px shadow room.
pub(crate) const WINDOW_HEIGHT_EXPANDED: f64 = 212.0;
const TOP_MARGIN: f64 = 24.0;
const MAX_SOURCE_CHARS: usize = 2048;
const MAX_DISPLAY_CHARS: usize = 120;
const DEDUPE_WINDOW: Duration = Duration::from_millis(1200);
const DEFAULT_DURATION_SECONDS: u64 = 5;
const MIN_DURATION_SECONDS: u64 = 3;
const MAX_DURATION_SECONDS: u64 = 10;
const MAX_ICON_BYTES: u64 = 512 * 1024;
const ICON_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
// Cursor mode offsets the capsule below/right of the pointer so it never sits
// exactly under the cursor or intercepts the click that follows a copy.
const CURSOR_OFFSET_X: f64 = 16.0;
const CURSOR_OFFSET_Y: f64 = 16.0;
// Edge clamp keeps the pill fully on-screen in every position mode.
const EDGE_MARGIN: f64 = 8.0;
// Blacklist cache TTL: settings writes invalidate eagerly, this only bounds a
// stale cache if a setting changed through a path that skipped the hook.
const BLACKLIST_TTL: Duration = Duration::from_secs(30);

static VISIBLE: AtomicBool = AtomicBool::new(false);
// Bumped on every clipboard event so a slow path lookup cannot show a stale capsule.
static COPY_GENERATION: AtomicU64 = AtomicU64::new(0);
// Re-copying the same target inside this window must not re-open the capsule.
static LAST_SHOWN: Mutex<Option<(String, Instant)>> = Mutex::new(None);
// Cached lowercase process blacklist; the u64 generation bumps on writes.
static BLACKLIST: Mutex<Option<(u64, Vec<String>, Instant)>> = Mutex::new(None);
static BLACKLIST_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
// Process that owned the foreground at the moment of the last clipboard event.
// The settings page reads it for the "add current foreground app" shortcut,
// because while settings are open the foreground window is Copy Creator itself.
static LAST_COPY_SOURCE: Mutex<Option<String>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CapsuleKind {
    Url,
    File,
    Folder,
}

impl CapsuleKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Url => "url",
            Self::File => "file",
            Self::Folder => "folder",
        }
    }

    fn icon_setting(self) -> &'static str {
        match self {
            Self::Url => "capsule_icon_url",
            Self::File => "capsule_icon_file",
            Self::Folder => "capsule_icon_folder",
        }
    }
}

#[derive(Clone, Serialize)]
struct ShowPayload {
    kind: CapsuleKind,
    text: String,
    display: String,
    #[serde(rename = "durationMs")]
    duration_ms: u64,
}

fn parse_kind(value: &str) -> Option<CapsuleKind> {
    match value {
        "url" => Some(CapsuleKind::Url),
        "file" => Some(CapsuleKind::File),
        "folder" => Some(CapsuleKind::Folder),
        _ => None,
    }
}

fn setting_flag(app: &AppHandle, key: &str) -> bool {
    crate::db::get_setting_sync(app, key)
        .map(|value| value != "0")
        .unwrap_or(true)
}

fn duration_seconds(app: &AppHandle) -> u64 {
    crate::db::get_setting_sync(app, "capsule_duration_seconds")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| (MIN_DURATION_SECONDS..=MAX_DURATION_SECONDS).contains(value))
        .unwrap_or(DEFAULT_DURATION_SECONDS)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PositionMode {
    Top,
    Bottom,
    Cursor,
    Fixed,
}

fn position_mode(app: &AppHandle) -> PositionMode {
    match crate::db::get_setting_sync(app, "capsule_position_mode").as_deref() {
        Some("bottom") => PositionMode::Bottom,
        Some("cursor") => PositionMode::Cursor,
        Some("fixed") => PositionMode::Fixed,
        _ => PositionMode::Top,
    }
}

fn fixed_position(app: &AppHandle) -> Option<(i32, i32)> {
    let x = crate::db::get_setting_sync(app, "capsule_fixed_x")?
        .trim()
        .parse::<i32>()
        .ok()?;
    let y = crate::db::get_setting_sync(app, "capsule_fixed_y")?
        .trim()
        .parse::<i32>()
        .ok()?;
    Some((x, y))
}

fn trigger_mode_is_modifier(app: &AppHandle) -> Option<&'static str> {
    if crate::db::get_setting_sync(app, "capsule_trigger_mode").as_deref() != Some("modifier") {
        return None;
    }
    let key = crate::db::get_setting_sync(app, "capsule_modifier_key").unwrap_or_default();
    let key = key.trim().to_ascii_lowercase();
    match key.as_str() {
        "alt" => Some("alt"),
        "shift" => Some("shift"),
        _ => Some("ctrl"),
    }
}

fn parse_blacklist(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.trim_start_matches('*').to_ascii_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect()
}

// The blacklist lives in memory between copies; copies never touch the
// database. Writes bump a generation so a stale cache is dropped immediately.
fn blacklist(app: &AppHandle) -> Vec<String> {
    let generation = BLACKLIST_GENERATION.load(Ordering::SeqCst);
    if let Ok(guard) = BLACKLIST.lock() {
        if let Some((cached_generation, entries, at)) = guard.as_ref() {
            if *cached_generation == generation && at.elapsed() < BLACKLIST_TTL {
                return entries.clone();
            }
        }
    }
    let entries = crate::db::get_setting_sync(app, "capsule_blacklist")
        .map(|raw| parse_blacklist(&raw))
        .unwrap_or_default();
    if let Ok(mut guard) = BLACKLIST.lock() {
        *guard = Some((generation, entries.clone(), Instant::now()));
    }
    entries
}

pub(crate) fn notify_setting_changed(key: &str) {
    if key == "capsule_blacklist" {
        BLACKLIST_GENERATION.fetch_add(1, Ordering::SeqCst);
    }
}

// Explorer's "Copy as path" wraps the value in double quotes, so unwrap once up
// front and use the plain value for detection, for the label and for the open
// target. Keeping one normalised copy avoids showing or opening stray quotes.
fn normalize_copied_text(text: &str) -> &str {
    let trimmed = text.trim();
    trimmed
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .map(str::trim)
        .unwrap_or(trimmed)
}

fn detect_url(text: &str) -> Option<CapsuleKind> {
    let trimmed = normalize_copied_text(text);
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_SOURCE_CHARS
        || trimmed.chars().any(char::is_control)
    {
        return None;
    }
    detect_url_prefix(trimmed)
}

// Pure syntax check; never touches the filesystem, so UNC shares cannot block
// the clipboard thread. Callers do the metadata lookup off that thread.
fn path_candidate(text: &str) -> Option<&str> {
    let candidate = text;
    if candidate.contains('\0') {
        return None;
    }
    let lower = candidate.to_ascii_lowercase();
    // Explorer shell addresses and CLSID monikers are not real filesystem paths.
    if lower.starts_with("shell:") || candidate.starts_with("::{") {
        return None;
    }
    let bytes = candidate.as_bytes();
    let drive_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    let unc = candidate
        .strip_prefix(r"\\")
        .is_some_and(|rest| rest.split('\\').any(|part| !part.is_empty()));
    (drive_absolute || unc).then_some(candidate)
}

fn detect_path(text: &str) -> Option<CapsuleKind> {
    let candidate = path_candidate(text)?;
    let metadata = std::fs::metadata(candidate).ok()?;
    if metadata.is_dir() {
        Some(CapsuleKind::Folder)
    } else if metadata.is_file() {
        Some(CapsuleKind::File)
    } else {
        None
    }
}

fn detect_url_prefix(text: &str) -> Option<CapsuleKind> {
    let lower = text.to_lowercase();
    for prefix in ["http://", "https://"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            if !rest.trim().is_empty() && !rest.contains(char::is_whitespace) {
                return Some(CapsuleKind::Url);
            }
        }
    }
    if let Some(rest) = lower.strip_prefix("www.") {
        if rest.contains('.') && !rest.contains(char::is_whitespace) {
            return Some(CapsuleKind::Url);
        }
    }
    None
}

fn display_text(text: &str) -> String {
    if text.chars().count() <= MAX_DISPLAY_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(MAX_DISPLAY_CHARS - 1).collect();
    out.push('…');
    out
}

fn is_duplicate(kind: CapsuleKind, text: &str) -> bool {
    let key = format!("{}|{}", kind.as_str(), text);
    let Ok(mut last) = LAST_SHOWN.lock() else {
        return false;
    };
    if let Some((previous, at)) = last.as_ref() {
        if previous == &key && at.elapsed() < DEDUPE_WINDOW {
            return true;
        }
    }
    *last = Some((key, Instant::now()));
    false
}

#[cfg(target_os="windows")]
pub(crate) fn ensure_no_activate(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    let hwnd = window.hwnd().unwrap_or_default();
    if hwnd.is_invalid() {
        return;
    }
    let hwnd = HWND(hwnd.0);
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let desired = current | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize);
        if desired != current {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, desired);
        }
    }
}

#[cfg(target_os = "windows")]
fn modifier_held(wanted: &str) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT,
    };
    let virtual_key = match wanted {
        "alt" => VK_MENU,
        "shift" => VK_SHIFT,
        _ => VK_CONTROL,
    };
    // The high bit of the 16-bit return signals the key is down. GetAsyncKeyState
    // (not GetKeyState) is required here: the clipboard monitor thread never pumps
    // messages, so GetKeyState would keep reporting the state as of that thread's
    // last message lookup and miss modifier presses.
    unsafe { GetAsyncKeyState(virtual_key.0 as i32) < 0 }
}

#[cfg(not(target_os = "windows"))]
fn modifier_held(_wanted: &str) -> bool {
    false
}

// Foreground process name for the blacklist. On any failure the caller lets the
// capsule through: a detection miss must not suppress legitimate copies.
#[cfg(target_os = "windows")]
fn foreground_process_name() -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{GetModuleBaseNameW, K32GetModuleFileNameExW};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        // GetWindowThreadProcessId lives in WindowsAndMessaging but takes a
        // mut pointer for the id out-param.
        windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 260];
        // Prefer the base name: it is what users recognise (e.g. "chrome.exe").
        let length = GetModuleBaseNameW(handle, None, &mut buffer);
        let name = if length > 0 {
            String::from_utf16_lossy(&buffer[..length as usize])
        } else {
            let length = K32GetModuleFileNameExW(handle, None, &mut buffer);
            if length > 0 {
                let full = String::from_utf16_lossy(&buffer[..length as usize]);
                full.rsplit(['\\', '/']).next().unwrap_or("").to_string()
            } else {
                String::new()
            }
        };
        let _ = CloseHandle(handle);
        if name.is_empty() { None } else { Some(name) }
    }
}

#[cfg(not(target_os = "windows"))]
fn foreground_process_name() -> Option<String> {
    None
}

fn foreground_blacklisted(app: &AppHandle) -> bool {
    let Some(name) = foreground_process_name() else {
        // A failed lookup must not swallow the capsule; default to allow.
        return false;
    };
    let lowered = name.to_ascii_lowercase();
    // Compare both with and without the .exe suffix so "KeePassXC" and
    // "KeePassXC.exe" blacklist entries behave identically.
    let bare = lowered.strip_suffix(".exe").unwrap_or(&lowered);
    let entries = blacklist(app);
    entries.iter().any(|entry| {
        let entry_bare = entry.strip_suffix(".exe").unwrap_or(entry);
        lowered == *entry || bare == entry_bare
    })
}

// Fullscreen means exclusive or borderless fullscreen. A plain maximised
// window is never fullscreen: maximisation stops above the taskbar, so its
// rect is smaller than the monitor rect even when both look "screen sized".
#[cfg(target_os = "windows")]
fn foreground_is_fullscreen() -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITOR_DEFAULTTONEAREST, MONITORINFO,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect, GWL_STYLE, WS_CAPTION,
        WS_THICKFRAME,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return false;
        }
        // The desktop (Progman) and its wallpaper host (WorkerW) cover every
        // monitor with no chrome by definition; treating them as fullscreen
        // would silence the capsule whenever the user copies from the desktop.
        let mut class_buf = [0u16; 16];
        let class_len = GetClassNameW(hwnd, &mut class_buf);
        if class_len > 0 {
            let class = String::from_utf16_lossy(&class_buf[..class_len as usize]);
            if class == "Progman" || class == "WorkerW" {
                return false;
            }
        }
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let covers_monitor = rect.left <= info.rcMonitor.left
                && rect.top <= info.rcMonitor.top
                && rect.right >= info.rcMonitor.right
                && rect.bottom >= info.rcMonitor.bottom;
            // A maximised window reports a "maximised" style bit and never
            // covers the taskbar area; borderless fullscreen covers it all
            // while keeping none of the resize/caption chrome.
            let has_chrome = style & (WS_CAPTION.0 | WS_THICKFRAME.0) as i32 != 0;
            if covers_monitor && !has_chrome {
                return true;
            }
        }
        false
    }
}

#[cfg(not(target_os = "windows"))]
fn foreground_is_fullscreen() -> bool {
    false
}

// Centre the capsule on the monitor that owns the pointer, honouring its DPI
// scale so the pill keeps the same visual size on mixed-density desktops.
// `expanded` grows the window downward from the same anchor so the full text
// bubble fits instead of being clipped by the 76px window.
fn place(window: &WebviewWindow, mode: PositionMode, fixed: Option<(i32, i32)>, expanded: bool) {
    let cursor = window.cursor_position().ok();
    let monitor = cursor
        .as_ref()
        .and_then(|cursor| window.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let origin = monitor.position();
    let size = monitor.size();
    let scale_f = monitor.scale_factor();
    let width = (WINDOW_WIDTH * scale_f).round() as i32;
    let base_height = (WINDOW_HEIGHT * scale_f).round() as i32;
    let height = if expanded {
        (WINDOW_HEIGHT_EXPANDED * scale_f).round() as i32
    } else {
        base_height
    };
    let edge = (EDGE_MARGIN * scale_f).round() as i32;
    let monitor_left = origin.x;
    let monitor_right = origin.x + size.width as i32;
    let clamp_x = |x: i32| x.clamp(monitor_left + edge, monitor_right - width - edge);
    let clamp_y = |y: i32| {
        y.clamp(
            origin.y + edge,
            origin.y + size.height as i32 - height - edge,
        )
    };
    let (x, y) = match mode {
        PositionMode::Top => {
            let margin = (TOP_MARGIN * scale_f).round() as i32;
            (clamp_x(monitor_left + (size.width as i32 - width) / 2), origin.y + margin)
        }
        PositionMode::Bottom => {
            let margin = (TOP_MARGIN * scale_f).round() as i32;
            (
                clamp_x(monitor_left + (size.width as i32 - width) / 2),
                origin.y + size.height as i32 - height - margin,
            )
        }
        PositionMode::Cursor => {
            let Some(cursor) = cursor else {
                return;
            };
            let offset_x = (CURSOR_OFFSET_X * scale_f).round() as i32;
            let offset_y = (CURSOR_OFFSET_Y * scale_f).round() as i32;
            let x = cursor.x as i32 + offset_x;
            let y = cursor.y as i32 + offset_y;
            // Shift left/up instead of clamping so the pill never jumps
            // across the pointer near the screen's right/bottom edge.
            let x = if x + width + edge > monitor_right {
                cursor.x as i32 - width - offset_x
            } else {
                x
            };
            let y = if y + height + edge > origin.y + size.height as i32 {
                cursor.y as i32 - height - offset_y
            } else {
                y
            };
            (clamp_x(x), clamp_y(y))
        }
        PositionMode::Fixed => match fixed {
            Some((fixed_x, fixed_y)) => (fixed_x, fixed_y),
            // No remembered position yet: fall back to the top default.
            None => {
                let margin = (TOP_MARGIN * scale_f).round() as i32;
                (
                    clamp_x(monitor_left + (size.width as i32 - width) / 2),
                    origin.y + margin,
                )
            }
        },
    };
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
        width as u32,
        height as u32,
    )));
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        x, y,
    )));
}

pub(crate) fn is_visible() -> bool {
    VISIBLE.load(Ordering::SeqCst)
}

pub(crate) fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
        // The next show starts collapsed; leaving the expanded height would
        // reserve an invisible click-blocking strip below the pill.
        let scale = window.scale_factor().unwrap_or(1.0);
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
            (WINDOW_WIDTH * scale).round() as u32,
            (WINDOW_HEIGHT * scale).round() as u32,
        )));
    }
    VISIBLE.store(false, Ordering::SeqCst);
}

// The low level mouse hook reports physical screen pixels, so compare against
// the window rect without any DPI conversion.
pub(crate) fn click_outside(app: &AppHandle, screen_x: i32, screen_y: i32) -> bool {
    if !is_visible() {
        return false;
    }
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return false;
    };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return false;
    };
    let inside = screen_x >= position.x
        && screen_x < position.x + size.width as i32
        && screen_y >= position.y
        && screen_y < position.y + size.height as i32;
    !inside
}

pub(crate) fn maybe_show(app: &AppHandle, record_type: &str, content: &str) {
    // Only text derived records can become a capsule; image and file records
    // keep their existing clipboard history behaviour untouched.
    if record_type == "image" || record_type == "file" {
        return;
    }
    // Every clipboard event invalidates a path probe still running for an older copy.
    let generation = COPY_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if !setting_flag(app, "capsule_enabled") {
        return;
    }
    // Record the process that was foreground at copy time for the settings
    // page shortcut, regardless of whether this copy ends up gated.
    if let Some(name) = foreground_process_name() {
        if let Ok(mut guard) = LAST_COPY_SOURCE.lock() {
            *guard = Some(name);
        }
    }
    // Gate order per spec: own-copy exclusion (handled by the caller) >
    // blacklist > fullscreen > modifier gate > detection. Every gate runs once
    // per clipboard event; there is no polling anywhere.
    if foreground_blacklisted(app) {
        return;
    }
    if setting_flag(app, "capsule_fullscreen_enabled") && foreground_is_fullscreen() {
        return;
    }
    if let Some(wanted) = trigger_mode_is_modifier(app) {
        if !modifier_held(wanted) {
            return;
        }
    }
    let target = normalize_copied_text(content);
    if target.is_empty()
        || target.chars().count() > MAX_SOURCE_CHARS
        || target.chars().any(char::is_control)
    {
        return;
    }
    if setting_flag(app, "capsule_url_enabled") {
        if let Some(kind) = detect_url_prefix(target) {
            show_kind(app, kind, target, generation);
            return;
        }
    }
    if setting_flag(app, "capsule_path_enabled") {
        let Some(candidate) = path_candidate(target) else {
            return;
        };
        let candidate = candidate.to_string();
        let app = app.clone();
        // Metadata on a UNC share or a sleeping drive can block for seconds.
        // Probing off the clipboard thread keeps capture, the lifecycle producer
        // and the save barrier free; a newer copy invalidates this result.
        tauri::async_runtime::spawn_blocking(move || {
            let Some(kind) = detect_path(&candidate) else {
                return;
            };
            show_kind(&app, kind, &candidate, generation);
        });
    }
}

// Bumped on every clipboard event; a delayed probe must not show stale content.
fn show_kind(app: &AppHandle, kind: CapsuleKind, target: &str, generation: u64) {
    if COPY_GENERATION.load(Ordering::SeqCst) != generation {
        return;
    }
    if is_duplicate(kind, target) {
        return;
    }
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let mode = position_mode(app);
    let fixed = if mode == PositionMode::Fixed {
        fixed_position(app)
    } else {
        None
    };
    place(&window, mode, fixed, false);
    #[cfg(target_os = "windows")]
    ensure_no_activate(&window);
    if window.show().is_err() {
        return;
    }
    VISIBLE.store(true, Ordering::SeqCst);
    let payload = ShowPayload {
        kind,
        text: target.to_string(),
        display: display_text(target),
        duration_ms: duration_seconds(app) * 1000,
    };
    if let Err(error) = window.emit("capsule-show", payload) {
        log::warn!("failed to emit capsule-show: {error}");
    }
}

// The webview asks for the taller window before painting the full-text bubble.
#[tauri::command]
pub fn capsule_set_expanded(app: AppHandle, expanded: bool) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let mode = position_mode(&app);
    let fixed = if mode == PositionMode::Fixed {
        fixed_position(&app)
    } else {
        None
    };
    place(&window, mode, fixed, expanded);
    #[cfg(target_os = "windows")]
    ensure_no_activate(&window);
}

#[cfg(target_os = "windows")]
fn reveal_path(path: &std::path::Path, is_directory: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{w, PCWSTR};
    use windows::Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::{
            Shell::{Common::ITEMIDLIST, SHOpenFolderAndSelectItems, SHParseDisplayName, ShellExecuteW},
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
    };
    struct ComScope(bool);
    impl Drop for ComScope {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize(); }
            }
        }
    }
    struct ItemId(*mut ITEMIDLIST);
    impl Drop for ItemId {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CoTaskMemFree(Some(self.0.cast())); }
            }
        }
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        // An existing apartment stays owned by its initializer; every successful
        // call, including S_FALSE, gets exactly one uninitialize.
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
            return Err("capsule.openFailed".into());
        }
        let _com = ComScope(initialized.is_ok());
        if is_directory {
            let result = ShellExecuteW(None, w!("open"), PCWSTR(wide.as_ptr()), None, None, SW_SHOWNORMAL);
            if result.0 as isize <= 32 {
                return Err("capsule.openFailed".into());
            }
        } else {
            let mut item = ItemId(std::ptr::null_mut());
            SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut item.0, 0, None)
                .map_err(|_| "capsule.openFailed")?;
            if item.0.is_null() {
                return Err("capsule.openFailed".into());
            }
            // With no child array Windows opens the parent and selects this
            // exact PIDL, avoiding Explorer command line parsing entirely.
            SHOpenFolderAndSelectItems(item.0, None, 0).map_err(|_| "capsule.openFailed")?;
        }
    }
    Ok(())
}

fn reveal_target(path: &std::path::Path, is_directory: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        reveal_path(path, is_directory)
    }
    #[cfg(not(target_os = "windows"))]
    {
        crate::desktop_open::reveal_path(path, is_directory).map_err(|_| "capsule.openFailed".to_string())
    }
}

fn normalize_url(text: &str) -> String {
    if text.to_ascii_lowercase().starts_with("www.") {
        format!("https://{text}")
    } else {
        text.to_string()
    }
}

#[tauri::command]
pub async fn capsule_open(app: AppHandle, kind: String, text: String) -> Result<(), String> {
    let outcome = open_target(kind, text).await;
    // The capsule is dismissed whether or not the shell accepted the target.
    // Leaving it visible after a failure would strand a transparent window that
    // still swallows clicks over that screen area.
    hide(&app);
    outcome
}

async fn open_target(kind: String, text: String) -> Result<(), String> {
    let Some(kind) = parse_kind(&kind) else {
        return Err("capsule.openFailed".into());
    };
    let target = normalize_copied_text(&text).to_string();
    if target.is_empty() {
        return Err("capsule.openFailed".into());
    }
    match kind {
        CapsuleKind::Url => crate::clipboard::open_external_link(normalize_url(&target)).await,
        CapsuleKind::File | CapsuleKind::Folder => {
            let path = std::path::PathBuf::from(target);
            let is_directory = kind == CapsuleKind::Folder;
            tauri::async_runtime::spawn_blocking(move || reveal_target(&path, is_directory))
                .await
                .map_err(|_| "capsule.openFailed".to_string())?
        }
    }
}

#[tauri::command]
pub fn capsule_hide(app: AppHandle) {
    hide(&app);
}

fn mime_for(path: &std::path::Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}

// A broken custom icon must never break the capsule, so every failure path
// degrades to the bundled default icon.
#[tauri::command]
pub fn capsule_icon_data_uri(app: AppHandle, kind: String) -> Option<String> {
    use base64::Engine;
    let kind = parse_kind(&kind)?;
    let value = crate::db::get_setting_sync(&app, kind.icon_setting())?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = std::path::Path::new(trimmed);
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_ICON_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{encoded}", mime_for(path)))
}

#[tauri::command]
pub async fn select_capsule_icon(
    app: AppHandle,
    kind: String,
    expected_storage_epoch: Option<u64>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let kind = parse_kind(&kind).ok_or("capsule.iconSelectFailed")?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    crate::lifecycle::allow_write(&app)?;
    let dialog = crate::NativeDialogScope::new().ok_or("notes.busy")?;
    let (send, receive) = tokio::sync::oneshot::channel();
    let parent = app.get_webview_window("main").ok_or("capsule.iconSelectFailed")?;
    app.dialog()
        .file()
        .set_parent(&parent)
        .set_title("Capsule icon")
        .add_filter("Image", &ICON_EXTENSIONS)
        .pick_file(move |file| {
            let _dialog = dialog;
            let _ = send.send(file);
        });
    let selected = tokio::time::timeout(Duration::from_secs(120), receive)
        .await
        .map_err(|_| "capsule.iconSelectFailed")?
        .map_err(|_| "capsule.iconSelectFailed")?;
    let Some(file) = selected else {
        return Ok(None);
    };
    let target = file.to_string();
    if target.is_empty() {
        return Ok(None);
    }
    crate::db::set_setting(
        app.clone(),
        kind.icon_setting().to_string(),
        target.clone(),
        expected_storage_epoch,
    )?;
    Ok(Some(target))
}

#[tauri::command]
pub fn reset_capsule_icon(
    app: AppHandle,
    kind: String,
    expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let kind = parse_kind(&kind).ok_or("capsule.iconSelectFailed")?;
    crate::db::set_setting(app, kind.icon_setting().to_string(), String::new(), expected_storage_epoch)
}

// Remembered position for the "fixed" mode. Coordinates are physical screen
// pixels as reported by the drag in the capsule webview, so no DPI conversion
// is applied here.
#[tauri::command]
pub fn capsule_save_fixed_position(
    app: AppHandle,
    x: i32,
    y: i32,
    expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    crate::db::set_settings_batch(
        app,
        [
            ("capsule_fixed_x".to_string(), x.to_string()),
            ("capsule_fixed_y".to_string(), y.to_string()),
        ]
        .into_iter()
        .collect(),
        expected_storage_epoch,
    )
}

#[tauri::command]
pub fn capsule_reset_fixed_position(
    app: AppHandle,
    expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    crate::db::set_settings_batch(
        app,
        [
            ("capsule_fixed_x".to_string(), String::new()),
            ("capsule_fixed_y".to_string(), String::new()),
        ]
        .into_iter()
        .collect(),
        expected_storage_epoch,
    )
}

// Exposed for the settings page "add current foreground app" shortcut. While
// settings are open the foreground window is Copy Creator itself, so the
// caller resolves the process recorded at the moment of the last copy.
#[tauri::command]
pub fn capsule_last_copy_source() -> Option<String> {
    LAST_COPY_SOURCE.lock().ok().and_then(|guard| guard.clone())
}

#[tauri::command]
pub fn capsule_blacklist_changed() {
    BLACKLIST_GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_detection_accepts_required_prefixes() {
        assert_eq!(detect_url("https://example.com"), Some(CapsuleKind::Url));
        assert_eq!(detect_url("http://example.com/a?b=1"), Some(CapsuleKind::Url));
        assert_eq!(detect_url("www.example.com"), Some(CapsuleKind::Url));
        assert_eq!(detect_url("HTTPS://EXAMPLE.COM"), Some(CapsuleKind::Url));
        assert_eq!(detect_url("https://"), None);
        assert_eq!(detect_url("www.example.com extra"), None);
        assert_eq!(detect_url("ftp://example.com"), None);
    }

    #[test]
    fn path_detection_ignores_shell_addresses() {
        assert_eq!(detect_path("shell:AppsFolder"), None);
        assert_eq!(detect_path("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"), None);
        assert_eq!(detect_path(r"C:\definitely\missing\path\for\capsule\test"), None);
    }

    #[test]
    fn path_candidate_accepts_absolute_paths_without_touching_disk() {
        assert_eq!(
            path_candidate(r"C:\Windows\win.ini"),
            Some(r"C:\Windows\win.ini")
        );
        assert_eq!(path_candidate("D:/data"), Some("D:/data"));
        assert_eq!(
            path_candidate(r"\\server\share\file.txt"),
            Some(r"\\server\share\file.txt")
        );
        // Syntax only: an unreachable UNC share must still pass this gate so the
        // metadata probe can run off the clipboard thread.
        assert_eq!(
            path_candidate(r"\\offline-host\share\file.txt"),
            Some(r"\\offline-host\share\file.txt")
        );
        assert_eq!(path_candidate("relative\\path"), None);
        assert_eq!(path_candidate(r"\\"), None);
        assert_eq!(path_candidate("shell:AppsFolder"), None);
    }

    #[test]
    fn display_text_truncates_long_values() {
        let short = "https://example.com";
        assert_eq!(display_text(short), short);
        let long: String = "a".repeat(MAX_DISPLAY_CHARS + 10);
        let shown = display_text(&long);
        assert_eq!(shown.chars().count(), MAX_DISPLAY_CHARS);
        assert!(shown.ends_with('…'));
    }

    #[test]
    fn url_normalisation_adds_scheme() {
        assert_eq!(normalize_url("www.example.com"), "https://www.example.com");
        assert_eq!(normalize_url("https://example.com"), "https://example.com");
    }

    #[test]
    fn copied_text_unwraps_explorer_quotes() {
        assert_eq!(normalize_copied_text("\"C:\\Windows\\win.ini\""), r"C:\Windows\win.ini");
        assert_eq!(normalize_copied_text("  C:\\Windows  "), r"C:\Windows");
        assert_eq!(normalize_copied_text("\"https://example.com\""), "https://example.com");
        assert_eq!(normalize_copied_text("\""), "\"");
    }

    #[test]
    fn mime_mapping_follows_extension() {
        assert_eq!(mime_for(std::path::Path::new("a.png")), "image/png");
        assert_eq!(mime_for(std::path::Path::new("a.JPG")), "image/jpeg");
        assert_eq!(mime_for(std::path::Path::new("a.svg")), "image/svg+xml");
        assert_eq!(mime_for(std::path::Path::new("a.unknown")), "image/png");
    }

    #[test]
    fn parse_kind_rejects_unknown_labels() {
        assert_eq!(parse_kind("url"), Some(CapsuleKind::Url));
        assert_eq!(parse_kind("file"), Some(CapsuleKind::File));
        assert_eq!(parse_kind("folder"), Some(CapsuleKind::Folder));
        assert_eq!(parse_kind("other"), None);
    }

    #[test]
    fn blacklist_parsing_normalises_entries() {
        assert!(parse_blacklist("").is_empty());
        assert!(parse_blacklist(" , ,").is_empty());
        assert_eq!(parse_blacklist("KeePassXC.exe, cs2"), vec!["keepassxc.exe", "cs2"]);
        assert_eq!(parse_blacklist("  CHROME.EXE  "), vec!["chrome.exe"]);
        // Star prefixes from wildcard-style entries are stripped, not matched.
        assert_eq!(parse_blacklist("*cs2*"), vec!["cs2*"]);
    }

    #[test]
    fn blacklist_matching_tolerates_exe_suffix() {
        let entries = vec!["keepassxc.exe".to_string()];
        let hit = |name: &str| {
            let lowered = name.to_ascii_lowercase();
            let bare = lowered.strip_suffix(".exe").unwrap_or(&lowered);
            entries.iter().any(|entry| {
                let entry_bare = entry.strip_suffix(".exe").unwrap_or(entry);
                lowered == *entry || bare == entry_bare
            })
        };
        assert!(hit("KeePassXC.exe"));
        assert!(hit("keepassxc"));
        assert!(!hit("keepassxc2.exe"));
        assert!(!hit("notepad.exe"));
    }
}
