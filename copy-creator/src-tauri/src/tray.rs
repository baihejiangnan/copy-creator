use std::path::Path;
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

pub struct TrayState {
    pub tray: Mutex<Option<tauri::tray::TrayIcon>>,
}

static TRAY_REFRESH_SENDER: OnceLock<SyncSender<()>> = OnceLock::new();

fn compact_text(value: &str, max_chars: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let preview: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{preview}...")
    } else {
        preview
    }
}

fn menu_title(record: &crate::db::ClipboardActionRecord, lang: &str) -> String {
    let favorite = if record.is_favorite { "★ " } else { "" };
    let value = if record.user_api_key || crate::db::is_api_key(&record.content) {
        format!("API Key · {}", crate::db::make_key_preview(&record.content))
    } else {
        match record.record_type.as_str() {
            "image" => {
                let label = if lang == "en" { "Image" } else { "图片" };
                let time = chrono::DateTime::parse_from_rfc3339(&record.created_at)
                    .map(|value| {
                        value
                            .with_timezone(&chrono::Local)
                            .format("%m-%d %H:%M")
                            .to_string()
                    })
                    .unwrap_or_default();
                format!("{label} · {time}")
            }
            "file" => Path::new(&record.content)
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| compact_text(name, 36))
                .unwrap_or_else(|| compact_text(&record.content, 36)),
            _ => compact_text(&record.content, 36),
        }
    };
    format!("{favorite}{}", value.replace('&', "&&"))
}

fn build_tray_menu(
    app: &AppHandle,
    lang: &str,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let (recent_text, copy_text, paste_text, show_text, quit_text, empty_text, unread_text) =
        if lang == "en" {
            (
                "Recent Clipboard",
                "Copy",
                "Paste",
                "Show Window",
                "Quit",
                "No records",
                "unread",
            )
        } else {
            (
                "最近剪贴板",
                "复制",
                "粘贴",
                "显示窗口",
                "退出",
                "暂无记录",
                "条未读",
            )
        };

    let unread_count = crate::db::get_unread_count_sync(app);
    let (epoch, recent) = crate::db::get_recent_clipboard_records(app, 8)?;
    let mut builder = MenuBuilder::new(app);

    if unread_count > 0 {
        let label = format!("{unread_count} {unread_text}");
        let unread = MenuItemBuilder::with_id("unread-count", label)
            .enabled(false)
            .build(app)?;
        builder = builder.item(&unread).separator();
    }

    let heading = MenuItemBuilder::with_id("recent-heading", recent_text)
        .enabled(false)
        .build(app)?;
    builder = builder.item(&heading);

    if recent.is_empty() {
        let empty = MenuItemBuilder::with_id("recent-empty", empty_text)
            .enabled(false)
            .build(app)?;
        builder = builder.item(&empty);
    } else {
        for record in recent {
            let copy = MenuItemBuilder::with_id(format!("tray-copy:{epoch}:{}", record.id), copy_text)
                .build(app)?;
            let paste = MenuItemBuilder::with_id(format!("tray-paste:{epoch}:{}", record.id), paste_text)
                .build(app)?;
            let submenu = SubmenuBuilder::with_id(
                app,
                format!("tray-record:{epoch}:{}", record.id),
                menu_title(&record, lang),
            )
            .item(&copy)
            .item(&paste)
            .build()?;
            builder = builder.item(&submenu);
        }
    }

    let show = MenuItemBuilder::with_id("show", show_text).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", quit_text).build(app)?;
    builder
        .separator()
        .item(&show)
        .item(&quit)
        .build()
        .map_err(Into::into)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        crate::lifecycle::show_main(&window).ok();
        window.set_focus().ok();
    }
}

pub fn create_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let lang = crate::db::get_setting_sync(app, "language").unwrap_or_else(|| "zh-CN".to_string());
    let menu = build_tray_menu(app, &lang)?;

    let icon_bytes = include_bytes!("../icons/icon.png");
    let img = image::load_from_memory(icon_bytes)
        .expect("Failed to decode tray icon")
        .into_rgba8();
    let (w, h) = img.dimensions();
    let icon = tauri::image::Image::new_owned(img.into_raw(), w, h);

    let tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("Copy Creator")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some((epoch, record_id, paste_after)) = parse_record_action(id) {
                crate::paste::run_record_action(app, epoch, record_id.to_string(), paste_after).ok();
            } else {
                match id {
                    "show" => show_main_window(app),
                    "quit" => {
                        crate::lifecycle::request_exit(app, 0);
                    }
                    _ => {}
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                if button_state != tauri::tray::MouseButtonState::Down {
                    return;
                }
                if button == tauri::tray::MouseButton::Left {
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        if window.is_minimized().unwrap_or(false) {
                            show_main_window(&app);
                        } else if window.is_visible().unwrap_or(false) {
                            crate::lifecycle::hide_main(&window).ok();
                        } else {
                            show_main_window(&app);
                        }
                    }
                }
            }
        })
        .build(app)?;

    let state = app.state::<TrayState>();
    *state.tray.lock().unwrap() = Some(tray);
    Ok(())
}

pub fn refresh_tray_menu(app: &AppHandle) -> Result<(), String> {
    let Some(state) = app.try_state::<TrayState>() else {
        return Ok(());
    };
    let lang = crate::db::get_setting_sync(app, "language").unwrap_or_else(|| "zh-CN".to_string());
    let menu = build_tray_menu(app, &lang).map_err(|e| e.to_string())?;
    let unread_count = crate::db::get_unread_count_sync(app);
    let tooltip = if unread_count > 0 {
        format!("Copy Creator ({unread_count})")
    } else {
        "Copy Creator".to_string()
    };

    let tray_guard = state.tray.lock().map_err(|e| e.to_string())?;
    if let Some(tray) = tray_guard.as_ref() {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn schedule_tray_refresh(app: &AppHandle) {
    let sender = TRAY_REFRESH_SENDER.get_or_init(|| {
        let (sender, receiver) = sync_channel(1);
        let app = app.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("tray-refresh-worker".to_string())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    std::thread::sleep(Duration::from_millis(75));
                    while receiver.try_recv().is_ok() {}
                    if let Err(error) = refresh_tray_menu(&app) {
                        log::warn!("tray refresh failed: {error}");
                    }
                }
            })
        {
            log::error!("failed to start tray refresh worker: {error}");
        }
        sender
    });

    match sender.try_send(()) {
        Ok(()) | Err(TrySendError::Full(())) => {}
        Err(TrySendError::Disconnected(())) => {
            log::error!("tray refresh worker disconnected");
        }
    }
}

#[tauri::command]
pub fn update_tray_language(app: AppHandle) -> Result<(), String> {
    refresh_tray_menu(&app)
}

// IDs carry the identity of the rows read under the same connection lock.
// A still-open old menu must never resolve its record ID in a new database.
fn parse_record_action(id: &str) -> Option<(u64, &str, bool)> {
    let (rest, paste_after) = if let Some(rest) = id.strip_prefix("tray-copy:") {
        (rest, false)
    } else {
        (id.strip_prefix("tray-paste:")?, true)
    };
    let (epoch, record_id) = rest.split_once(':')?;
    if record_id.is_empty() { return None; }
    Some((epoch.parse().ok()?, record_id, paste_after))
}

#[cfg(test)]
mod action_identity_tests {
    use super::parse_record_action;
    #[test]
    fn menu_actions_preserve_the_row_identity_and_reject_unstamped_ids() {
        assert_eq!(parse_record_action("tray-copy:1:same-id"), Some((1, "same-id", false)));
        assert_eq!(parse_record_action("tray-paste:2:same-id"), Some((2, "same-id", true)));
        for id in ["tray-copy:same-id", "tray-paste:bad:same-id", "tray-copy:1:", "show", "quit"] {
            assert_eq!(parse_record_action(id), None);
        }
    }
}
