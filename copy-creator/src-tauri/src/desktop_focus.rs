//! Main/radial focus policy. Native paste-target tracking is a separate concern.
#[derive(Default)]
struct FocusState {
    main_visible: bool,
    radial_visible: bool,
    main_focused: bool,
    radial_focused: bool,
    main_minimized: bool,
    pinned: bool,
    dialog: bool,
    cursor_inside: bool,
}

fn hides(state: &FocusState) -> (bool, bool) {
    if state.main_focused || state.radial_focused || state.dialog || state.cursor_inside {
        return (false, false);
    }
    (
        state.main_visible && !state.pinned && !state.main_minimized,
        state.radial_visible,
    )
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn install(app: &tauri::AppHandle) {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;
    use tauri::Manager;

    struct Scheduled(Arc<AtomicBool>);
    impl Drop for Scheduled {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }

    let pending = Arc::new(AtomicBool::new(false));
    for label in ["main", "radial-menu"] {
        let Some(window) = app.get_webview_window(label) else {
            continue;
        };
        let app = app.clone();
        let pending = pending.clone();
        window.on_window_event(move |event| {
            if !matches!(event, tauri::WindowEvent::Focused(false))
                || pending.swap(true, Ordering::SeqCst) { return; }
            let scheduled = Scheduled(pending.clone());
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let callback_app = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let _scheduled = scheduled;
                    // A failed state query must not hide an owned dialog/window.
                    let snapshot = || -> Option<(FocusState, tauri::WebviewWindow, Option<tauri::WebviewWindow>)> {
                        let main = callback_app.get_webview_window("main")?;
                        let radial = callback_app.get_webview_window("radial-menu");
                        let state = FocusState {
                            main_visible: main.is_visible().ok()?,
                            radial_visible: radial.as_ref().map(|w| w.is_visible()).transpose().ok()?.unwrap_or(false),
                            main_focused: main.is_focused().ok()?,
                            radial_focused: radial.as_ref().map(|w| w.is_focused()).transpose().ok()?.unwrap_or(false),
                            main_minimized: main.is_minimized().ok()?,
                            pinned: crate::MAIN_WINDOW_PINNED.load(Ordering::SeqCst),
                            dialog: crate::NATIVE_DIALOG_OPEN.load(Ordering::SeqCst),
                            cursor_inside: cursor_inside(&main),
                        };
                        Some((state, main, radial))
                    };
                    let Some((state, main, radial)) = snapshot() else { return; };
                    let (hide_main, hide_radial) = hides(&state);
                    if hide_radial {
                        if let Some(radial) = radial { let _ = radial.hide(); }
                    }
                    if hide_main { let _ = crate::lifecycle::hide_main(&main); }
                });
            });
        });
    }
}

#[cfg(not(target_os = "windows"))]
fn cursor_inside(window: &tauri::WebviewWindow) -> bool {
    let (Ok(cursor), Ok(origin), Ok(size)) = (
        window.cursor_position(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return false;
    };
    cursor.x >= origin.x as f64
        && cursor.y >= origin.y as f64
        && cursor.x < origin.x as f64 + size.width as f64
        && cursor.y < origin.y as f64 + size.height as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn main_and_radial_focus_protect_each_other() {
        for main_focused in [false, true] {
            let state = FocusState {
                main_visible: true,
                radial_visible: true,
                main_focused,
                radial_focused: !main_focused,
                ..Default::default()
            };
            assert_eq!(hides(&state), (false, false));
        }
    }
    #[test]
    fn dialogs_and_native_popups_preserve_both_windows() {
        for cursor_inside in [false, true] {
            let state = FocusState {
                main_visible: true,
                radial_visible: true,
                cursor_inside,
                dialog: !cursor_inside,
                ..Default::default()
            };
            assert_eq!(hides(&state), (false, false));
        }
    }
    #[test]
    fn external_focus_hides_except_pinned_or_minimized_main() {
        let mut state = FocusState {
            main_visible: true,
            radial_visible: true,
            ..Default::default()
        };
        assert_eq!(hides(&state), (true, true));
        state.pinned = true;
        assert_eq!(hides(&state), (false, true));
        state.pinned = false;
        state.main_minimized = true;
        assert_eq!(hides(&state), (false, true));
        state.main_visible = false;
        state.radial_visible = false;
        assert_eq!(hides(&state), (false, false));
    }
}
