mod clipboard;
mod clipboard_wake;
mod secrets;
mod db;
mod paste;
mod shortcut;
#[cfg(target_os = "windows")]
mod single_instance;
mod translator;
mod tray;
mod vault;
mod vault_crypto;
mod backup;
mod updates;
mod update_package;
mod update_signature;
mod notes;
mod suiji;
mod lifecycle;
mod storage;
mod storage_events;
mod note_backup;
mod backup_limits;
mod note_files;
mod clipboard_usage;
mod db_metrics;
mod maintenance;
#[cfg(test)]
mod db_benchmarks;
mod note_search;
#[cfg(test)]
mod note_search_tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;

static MAIN_WINDOW_PINNED: AtomicBool = AtomicBool::new(false);
static LAST_MINIMIZED_AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
static NATIVE_DIALOG_OPEN: AtomicBool = AtomicBool::new(false);
// One native picker for the whole app. The callback owns this guard so an IPC
// timeout cannot release admission/auto-hide protection while its modal window
// is still alive. Parent ownership also handles transient foreground changes.
pub(crate) struct NativeDialogScope;
impl NativeDialogScope {
    pub(crate) fn new() -> Option<Self> { NATIVE_DIALOG_OPEN.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).ok().map(|_|Self) }
}
impl Drop for NativeDialogScope {
    fn drop(&mut self) { NATIVE_DIALOG_OPEN.store(false, Ordering::SeqCst); }
}

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
fn foreground_belongs_to_window(window: &tauri::WebviewWindow) -> bool {
    use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GA_ROOTOWNER}};
    let Ok(raw) = window.hwnd() else { return true; };
    unsafe {
        let foreground = GetForegroundWindow();
        !foreground.is_invalid() && GetAncestor(foreground, GA_ROOTOWNER) == HWND(raw.0)
    }
}

#[cfg(target_os = "windows")]
fn install_auto_hide_on_focus_loss(window: &tauri::WebviewWindow) {
    let event_window = window.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = lifecycle::hide_main(&event_window);
            }
            tauri::WindowEvent::Focused(true) => {
                // Focus gained — clear the minimise timestamp so future
                // Focused(false) events go through the normal auto-hide path.
                if let Some(lock) = LAST_MINIMIZED_AT.get() {
                    *lock.lock().unwrap() = None;
                }
            }
            tauri::WindowEvent::Focused(false) => {
                if MAIN_WINDOW_PINNED.load(Ordering::SeqCst)
                    || NATIVE_DIALOG_OPEN.load(Ordering::SeqCst)
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
                        || NATIVE_DIALOG_OPEN.load(Ordering::SeqCst)
                        || window.is_minimized().unwrap_or(false)
                        || window.is_focused().unwrap_or(false)
                        || foreground_belongs_to_window(&window)
                    {
                        return;
                    }
                    if let Err(error) = lifecycle::hide_main(&window) {
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
    // A verified portable successor waits before opening storage, registering
    // shortcuts, or starting clipboard producers owned by its predecessor.
    if update_package::wait_for_update_parent().is_err() {
        return;
    }
    let context = tauri::generate_context!();
    // Before any WebView, storage, tray, shortcut or clipboard producer exists.
    #[cfg(target_os = "windows")]
    let instance = match single_instance::Instance::acquire(
        &context.config().identifier,
        !std::env::args_os().skip(1).any(|arg| arg == "--hidden"),
    ) {
        Ok(Some(instance)) => instance,
        Ok(None) => return,
        Err(error) => {
            log::error!("single instance initialization failed: {error}");
            return;
        }
    };
    let autostart_name = autostart_entry_name(
        &context.package_info().name,
        &context.config().identifier,
    );
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::Builder::new()
            .app_name(autostart_name)
            .arg("--hidden")
            .build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut_key, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        shortcut::handle_shortcut(app,shortcut_key);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            #[cfg(target_os = "windows")]
            {
                app.manage(instance);
            }
            if cfg!(feature = "diagnostics") {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Warn)
                        .level_for("copy_creator::metrics", log::LevelFilter::Debug)
                        .targets([tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("db-metrics".into()),
                        }).filter(|metadata| metadata.target() == "copy_creator::metrics")])
                        .max_file_size(2_000_000)
                        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                        .build(),
                )?;
            } else if cfg!(debug_assertions) {
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
            app.manage(vault::VaultState::default());
            app.manage(backup::BackupState::default());
            app.manage(updates::UpdateState::default());
            app.manage(lifecycle::LifecycleState::default());
            db::enforce_clipboard_limits(app.handle()).ok();

            // Repair autostart registry entry to ensure --hidden arg is present
            let autostart = app.autolaunch();
            if autostart.is_enabled().unwrap_or(false) {
                let _ = autostart.enable();
            }

            maintenance::start(app.handle())?;

            app.handle().manage(tray::TrayState {
                tray: std::sync::Mutex::new(None),
            });
            tray::create_tray(app.handle())?;
            db::prune_old_records(app.handle()).ok();
            let _ = notes::prune_expired(app.handle());

            clipboard::start_monitor(app.handle())?;

            shortcut::install_mouse_hook(app.handle());

            // Create hidden radial menu popup window
            {
                use tauri::WebviewUrl;
                use tauri::WebviewWindowBuilder;
                let radial = WebviewWindowBuilder::new(
                    app,
                    "radial-menu",
                    WebviewUrl::App("radial.html".into()),
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

            shortcut::initialize_note_shortcut(app.handle());

            // Show main window when not auto-started (after all init is done)
            if !is_autostart {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = lifecycle::show_main(&window);
                }
            }

            vault::start_lock_worker(app.handle())?;
            #[cfg(target_os = "windows")]
            app.state::<single_instance::Instance>().listen(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lifecycle::hide_main_window,
            lifecycle::lifecycle_ready,
            lifecycle::lifecycle_saved,
            lifecycle::lifecycle_cancel,
            lifecycle::request_app_restart,
            lifecycle::request_app_elevated_restart,
            lifecycle::begin_storage_operation,
            lifecycle::end_storage_operation,
            db::change_storage_directory,
            db::get_storage_epoch,
            notes::list_notes,
            notes::list_suiji,
            notes::organize_note,
            suiji::get_suiji_groups,
            suiji::save_suiji_group,
            notes::get_note,
            notes::create_note,
            notes::save_note,
            notes::set_note_state,
            notes::capture_clipboard_as_note,
            note_files::select_note_files,
            note_files::reveal_note_reference,
            vault::get_vault_status,
            vault::setup_vault,
            vault::unlock_vault,
            vault::lock_vault,
            vault::touch_vault,
            vault::list_vault_entries,
            vault::get_vault_entry,
            vault::save_vault_entry,
            vault::delete_vault_entry,
            vault::generate_vault_password,
            vault::copy_vault_field,
            vault::paste_vault_field,
            vault::copy_vault_generated_password,
            vault::copy_vault_text,
            vault::change_vault_master,
            db::get_clipboard_records,
            db::get_clipboard_record_content,
            clipboard::open_external_link,
            updates::get_app_info,
            updates::check_for_updates,
            updates::download_update,
            updates::launch_update,
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
            db::save_clipboard_limit,
            shortcut::save_shortcut,
            shortcut::save_note_shortcut,
            shortcut::pending_note_request,
            shortcut::ack_note_request,
            shortcut::note_shortcut_status,
            db::set_settings_batch,
            backup::export_user_data,
            backup::select_user_data_import,
            backup::preview_user_data_import,
            backup::import_user_data,
            backup::cancel_user_data_import,
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
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { ref api, code, .. } = event {
                log::debug!(target: "copy_creator::metrics", "operation=lifecycle stage=exit_requested approved={}", app.state::<lifecycle::LifecycleState>().approved_exit());
                if !app.state::<lifecycle::LifecycleState>().approved_exit() {
                    api.prevent_exit();
                    lifecycle::request_exit(app, code.unwrap_or(0));
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                log::debug!(target: "copy_creator::metrics", "operation=lifecycle stage=runtime_exit");
            }
        });
}

fn autostart_entry_name(product_name: &str, identifier: &str) -> String {
    // The plugin keys Windows Run by name, not Tauri identifier. Keep the
    // established production entry, but isolate alternate/QA identities.
    if identifier == "com.copycreator.app" {
        product_name.to_string()
    } else {
        format!("{product_name} ({identifier})")
    }
}

#[cfg(test)]
mod autostart_identity_tests {
    #[test]
    fn alternate_identifiers_cannot_repair_the_production_autostart_entry() {
        let production = super::autostart_entry_name("Copy Creator", "com.copycreator.app");
        assert_eq!(production, "Copy Creator");
        let qa = super::autostart_entry_name("Copy Creator", "com.copycreator.qa20261007");
        let search = super::autostart_entry_name("Copy Creator", "com.copycreator.qa20261007search");
        assert_ne!(qa, production);
        assert_ne!(search, production);
        assert_ne!(qa, search);
    }
}
