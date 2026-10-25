use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub(crate) const WINDOW_LABEL: &str = "capsule";

pub(crate) const WINDOW_WIDTH: f64 = 460.0;
pub(crate) const WINDOW_HEIGHT: f64 = 76.0;
const TOP_MARGIN: f64 = 24.0;
const MAX_SOURCE_CHARS: usize = 2048;
const MAX_DISPLAY_CHARS: usize = 120;
const DEDUPE_WINDOW: Duration = Duration::from_millis(1200);
const DEFAULT_DURATION_SECONDS: u64 = 5;
const MIN_DURATION_SECONDS: u64 = 3;
const MAX_DURATION_SECONDS: u64 = 10;
const MAX_ICON_BYTES: u64 = 512 * 1024;
const ICON_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];

static VISIBLE: AtomicBool = AtomicBool::new(false);
// Re-copying the same target inside this window must not re-open the capsule.
static LAST_SHOWN: Mutex<Option<(String, Instant)>> = Mutex::new(None);

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

fn detect_path(text: &str) -> Option<CapsuleKind> {
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
    if !drive_absolute && !unc {
        return None;
    }
    let metadata = std::fs::metadata(candidate).ok()?;
    if metadata.is_dir() {
        Some(CapsuleKind::Folder)
    } else if metadata.is_file() {
        Some(CapsuleKind::File)
    } else {
        None
    }
}

fn detect(app: &AppHandle, text: &str) -> Option<CapsuleKind> {
    let trimmed = normalize_copied_text(text);
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_SOURCE_CHARS
        || trimmed.chars().any(char::is_control)
    {
        return None;
    }
    if !setting_flag(app, "capsule_enabled") {
        return None;
    }
    if setting_flag(app, "capsule_url_enabled") {
        if let Some(kind) = detect_url(trimmed) {
            return Some(kind);
        }
    }
    if setting_flag(app, "capsule_path_enabled") {
        if let Some(kind) = detect_path(trimmed) {
            return Some(kind);
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

// Centre the capsule on the monitor that owns the pointer, honouring its DPI
// scale so the pill keeps the same visual size on mixed-density desktops.
fn place(window: &WebviewWindow) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let monitor = window
        .cursor_position()
        .ok()
        .and_then(|cursor| window.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let origin = monitor.position();
    let size = monitor.size();
    let width = (WINDOW_WIDTH * scale).round() as i32;
    let margin = (TOP_MARGIN * scale).round() as i32;
    let x = origin.x + (size.width as i32 - width) / 2;
    let y = origin.y + margin;
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)));
}

pub(crate) fn is_visible() -> bool {
    VISIBLE.load(Ordering::SeqCst)
}

pub(crate) fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
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
    let Some(kind) = detect(app, content) else {
        return;
    };
    let target = normalize_copied_text(content);
    if is_duplicate(kind, target) {
        return;
    }
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    place(&window);
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
}
