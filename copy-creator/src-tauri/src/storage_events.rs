use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
struct StorageEvent<T> {
    storage_epoch: u64,
    value: T,
}

// The caller must prevent connection replacement through emission, by retaining
// its lifecycle producer permit or exclusive handoff lease (or during startup).
// This keeps the mutation and its identity stamp on the same connection.
// Do not lock conn here: some callers emit while already holding that mutex.
pub(crate) fn emit<T: Serialize + Clone>(app: &AppHandle, event: &str, value: T) -> tauri::Result<()> {
    let storage_epoch = app.state::<crate::db::DbState>().storage_epoch.load(Ordering::Relaxed);
    emit_at(app, event, value, storage_epoch)
}

// For events whose origin was captured before releasing the session/DB guard.
pub(crate) fn emit_at<T: Serialize + Clone>(app: &AppHandle, event: &str, value: T, storage_epoch: u64) -> tauri::Result<()> {
    app.emit(event, StorageEvent { storage_epoch, value })
}
