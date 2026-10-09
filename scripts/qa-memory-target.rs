// Experimental QA-only command. Never compiled into the default application.
use tauri::Manager;
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL};
use windows_core_for_webview::Interface;

#[tauri::command]
pub async fn qa_memory_target(app: tauri::AppHandle, low: bool) -> Result<Vec<(String, bool)>, String> {
    if app.config().identifier != "com.copycreator.qa20261007" {
        return Err("QA identity required".into());
    }
    let mut results = Vec::new();
    for label in ["main", "radial"] {
        let Some(window) = app.get_webview_window(label) else { continue };
        // The caller must actually hide every affected native window first.
        if low && window.is_visible().map_err(|_| "Visibility unavailable")? {
            return Err("Low target requires hidden windows".into());
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window.with_webview(move |platform| {
            let result = unsafe {
                platform.controller().CoreWebView2()
                    .and_then(|view| view.cast::<ICoreWebView2_19>())
                    .and_then(|view| view.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(if low { 1 } else { 0 })))
                    .is_ok()
            };
            let _ = sender.send(result);
        }).map_err(|_| "WebView dispatch failed")?;
        let accepted = receiver.await.map_err(|_| "WebView callback unavailable")?;
        results.push((label.into(), accepted));
    }
    Ok(results)
}
