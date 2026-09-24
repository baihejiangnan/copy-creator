mod clipboard;
mod secrets;
mod db;
mod paste;
mod shortcut;
mod translator;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;

static MAIN_WINDOW_PINNED: AtomicBool = AtomicBool::new(false);
static LAST_MINIMIZED_AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

#[cfg(target_os = "windows")]
fn apply_backdrop_effect(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_WINDOW_CORNER_PREFERENCE,
    };

    let hwnd = window.hwnd().unwrap_or_default();
    if hwnd.is_invalid() {
        return;
    }

    let hwnd = HWND(hwnd.0);

    let backdrop_type: i32 = 3;
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE,
            &backdrop_type as *const i32 as *const _,
            std::mem::size_of::<i32>() as u32,
        )
    };

    if let Err(e) = result {
        log::warn!("Failed to set DWM backdrop type: {:?}", e);
    }

    let corner_preference: i32 = 2; // DWMWCP_ROUND
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner_preference as *const i32 as *const _,
            std::mem::size_of::<i32>() as u32,
        )
    };

    if let Err(e) = result {
        log::warn!("Failed to set DWM corner preference: {:?}", e);
    }
}

#[cfg(target_os = "windows")]
fn cursor_is_inside_window(window: &tauri::WebviewWindow) -> bool {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};

    let Ok(raw_hwnd) = window.hwnd() else {
        return true;
    };
    let hwnd = HWND(raw_hwnd.0);
    if hwnd.is_invalid() {
        return true;
    }

    let mut cursor = POINT::default();
    let mut rect = RECT::default();
    if unsafe { GetCursorPos(&mut cursor) }.is_err()
        || unsafe { GetWindowRect(hwnd, &mut rect) }.is_err()
    {
        return true;
    }

    cursor.x >= rect.left && cursor.x < rect.right && cursor.y >= rect.top && cursor.y < rect.bottom
}

#[cfg(target_os = "windows")]
fn install_auto_hide_on_focus_loss(window: &tauri::WebviewWindow) {
    let event_window = window.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Focused(true) => {
                // Focus gained — clear the minimise timestamp so future
                // Focused(false) events go through the normal auto-hide path.
                if let Some(lock) = LAST_MINIMIZED_AT.get() {
                    *lock.lock().unwrap() = None;
                }
            }
            tauri::WindowEvent::Focused(false) => {
                if MAIN_WINDOW_PINNED.load(Ordering::SeqCst)
                    || cursor_is_inside_window(&event_window)
                {
                    return;
                }

                if event_window.is_minimized().unwrap_or(false) {
                    // Record the moment the window was seen minimised.
                    let lock =
                        LAST_MINIMIZED_AT.get_or_init(|| Mutex::new(None));
                    *lock.lock().unwrap() = Some(Instant::now());
                    return;
                }

                // If the window was minimised within the last 3 seconds,
                // suppress auto-hide — the user is most likely restoring it
                // via the taskbar and the Focused(false) event is transient.
                let recently_minimized = LAST_MINIMIZED_AT
                    .get()
                    .and_then(|lock| {
                        lock.lock().unwrap().map(|t| {
                            t.elapsed() < std::time::Duration::from_secs(3)
                        })
                    })
                    .unwrap_or(false);

                if recently_minimized {
                    return;
                }

                // Normal path: defer the hide briefly so transient focus
                // changes (e.g. the Focused(false) that fires *before* a
                // minimise actually completes) can settle.
                let window = event_window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    if MAIN_WINDOW_PINNED.load(Ordering::SeqCst)
                        || window.is_minimized().unwrap_or(false)
                        || window.is_focused().unwrap_or(false)
                    {
                        return;
                    }
                    if let Err(error) = window.hide() {
                        log::warn!("failed to hide unfocused main window: {error}");
                    }
                });
            }
            _ => {}
        }
    });
}

#[tauri::command]
fn toggle_always_on_top(app: tauri::AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "window not found".to_string())?;
    let current = window.is_always_on_top().map_err(|e| e.to_string())?;
    let next = !current;
    window.set_always_on_top(next).map_err(|e| e.to_string())?;
    MAIN_WINDOW_PINNED.store(next, Ordering::SeqCst);
    Ok(next)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        shortcut::toggle_window(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                    apply_backdrop_effect(&window);
                    MAIN_WINDOW_PINNED
                        .store(window.is_always_on_top().unwrap_or(false), Ordering::SeqCst);
                    install_auto_hide_on_focus_loss(&window);
                    paste::init_foreground_tracker(&window);
                }
            }

            let is_autostart = std::env::args().any(|a| a == "--hidden");

            db::init_db(app.handle())?;
            db::enforce_clipboard_limits(app.handle()).ok();

            // Repair autostart registry entry to ensure --hidden arg is present
            let autostart = app.autolaunch();
            if autostart.is_enabled().unwrap_or(false) {
                let _ = autostart.enable();
            }

            // Periodic pruning every hour
            let prune_handle = app.handle().clone();
            std::thread::Builder::new()
                .name("clipboard-prune-worker".to_string())
                .spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(3600));
                    if let Err(error) = db::prune_old_records(&prune_handle) {
                        log::warn!("periodic clipboard pruning failed: {error}");
                    }
                })?;

            app.handle().manage(tray::TrayState {
                tray: std::sync::Mutex::new(None),
            });
            tray::create_tray(app.handle())?;
            db::prune_old_records(app.handle()).ok();

            clipboard::start_monitor(app.handle())?;

            shortcut::install_mouse_hook(app.handle());

            // Create hidden radial menu popup window
            {
                use tauri::WebviewUrl;
                use tauri::WebviewWindowBuilder;
                let radial = WebviewWindowBuilder::new(
                    app,
                    "radial-menu",
                    WebviewUrl::App("index.html?radial=1".into()),
                )
                .title("")
                .inner_size(300.0, 420.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .visible(false)
                .shadow(true)
                .skip_taskbar(true)
                .resizable(false)
                .build()?;
                let _ = radial.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                #[cfg(target_os = "windows")]
                {
                    apply_backdrop_effect(&radial);
                    paste::register_radial_hwnd(&radial);
                }
                log::info!("Radial menu popup window created");
            }

            if let Ok(key) = db::get_setting(app.handle().clone(), "shortcut_key".to_string()) {
                if !key.is_empty() {
                    if let Err(e) = shortcut::register_keyboard_shortcut(app.handle(), &key) {
                        log::warn!("Failed to register keyboard shortcut '{}': {}", key, e);
                    }
                }
            }

            // Show main window when not auto-started (after all init is done)
            if !is_autostart {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::get_clipboard_records,
            db::get_clipboard_record_content,
            clipboard::open_external_link,
            db::delete_clipboard_record,
            db::toggle_clipboard_favorite,
            db::set_clipboard_favorite_note,
            db::get_clipboard_storage_stats,
            db::preview_clipboard_cleanup,
            db::apply_clipboard_cleanup,
            db::get_clipboard_unread_count,
            db::mark_clipboard_read,
            db::get_phrase_groups,
            db::create_phrase_group,
            db::update_phrase_group,
            db::delete_phrase_group,
            db::get_phrases,
            db::create_phrase,
            db::update_phrase,
            db::delete_phrase,
            db::get_translation_history,
            db::clear_translation_history,
            db::get_setting,
            db::get_all_settings,
            db::set_setting,
            db::set_settings_batch,
            db::export_user_data,
            db::import_user_data,
            paste::copy_text,
            paste::copy_image,
            paste::copy_file,
            paste::paste_text,
            paste::paste_image,
            paste::paste_file,
            db::get_image_base64,
            db::get_image_thumbnail,
            db::ensure_thumbnail,
            db::get_storage_path,
            db::select_storage_folder,
            translator::translate,
            shortcut::update_shortcut,
            shortcut::set_radial_menu_enabled,
            tray::update_tray_language,
            db::check_api_key,
            db::save_api_key_label,
            db::list_api_services,
            db::get_api_key_label,
            db::delete_api_key_label,
            db::list_api_key_labels,
            db::mark_expired,
            db::export_labels_json,
            db::mark_toast_shown,
            db::is_toast_shown,
            db::set_user_api_key,
            toggle_always_on_top,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
