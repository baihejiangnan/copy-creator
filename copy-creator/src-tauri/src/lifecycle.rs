//! Main-webview save handoff. A restart must be requested here: Tauri's
//! RESTART_EXIT_CODE cannot be cancelled through ExitRequested.prevent_exit.
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock, RwLock, RwLockReadGuard,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const SAVE_DEADLINE: Duration = Duration::from_secs(15);
#[derive(Clone, Copy, Debug, PartialEq)]
enum Termination {
    Exit(i32),
    Restart,
}
struct Pending {
    id: String,
    session: Option<String>,
    kind: Termination,
    started: Instant,
    finishing: bool,
}
struct Lease {
    token: String,
    session: String,
    kind: String,
    epoch: u64,
    active: usize,
    end_requested: bool,
}
#[derive(Default)]
struct Protocol {
    session: Option<String>,
    pending: Option<Pending>,
    lease: Option<Lease>,
}
impl Protocol {
    fn request(&mut self, kind: Termination) -> Result<String, String> {
        if self.pending.is_some() || self.lease.is_some() {
            return Err("lifecycle.busy".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.pending = Some(Pending {
            id: id.clone(),
            session: self.session.clone(),
            kind,
            started: Instant::now(),
            finishing: false,
        });
        Ok(id)
    }
    fn ready(&mut self, session: String) -> Result<bool, String> {
        if self.pending.as_ref().is_some_and(|p| p.finishing) {
            return Err("lifecycle.busy".into());
        }
        // A replacement WebView cannot vouch for the previous JS drafts.
        // Initial readiness may bind an unassigned request; reloading an
        // existing session must instead cancel its unconfirmed termination.
        let cancelled = self.pending.is_some()
            && self.session.as_deref().is_some_and(|previous| previous != session);
        if cancelled { self.pending = None; }
        self.session = Some(session.clone());
        if let Some(pending) = self.pending.as_mut() {
            pending.session = Some(session);
        }
        Ok(cancelled)
    }
    fn accept(&mut self, id: &str, session: &str) -> Result<Termination, String> {
        let pending = self.pending.as_mut().ok_or("lifecycle.expired")?;
        if pending.id != id
            || pending.session.as_deref() != Some(session)
            || self.session.as_deref() != Some(session)
            || pending.started.elapsed() >= SAVE_DEADLINE
            || pending.finishing
        {
            return Err("lifecycle.expired".into());
        }
        pending.finishing = true;
        Ok(pending.kind)
    }
    fn cancel(&mut self, id: &str, session: &str) -> bool {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.id == id && p.session.as_deref() == Some(session) && !p.finishing)
        {
            self.pending = None;
            true
        } else {
            false
        }
    }
    fn claim(&mut self, token: &str, kind: &str) -> Result<u64, String> {
        let lease = self.lease.as_mut().ok_or("lifecycle.expired")?;
        if lease.token != token || lease.kind != kind || lease.active != 0 || lease.end_requested {
            return Err("lifecycle.expired".into());
        }
        lease.active += 1;
        Ok(lease.epoch)
    }
    fn release(&mut self, token: &str) -> bool {
        if let Some(lease) = self.lease.as_mut().filter(|l| l.token == token) {
            lease.active = lease.active.saturating_sub(1);
            if lease.active == 0 && lease.end_requested {
                self.lease = None;
                return true;
            }
        }
        false
    }
    fn end_lease(&mut self, session: &str, token: &str) -> Result<bool, String> {
        let Some(lease) = self.lease.as_mut() else {
            return Ok(false);
        };
        if lease.session != session || lease.token != token {
            return Err("lifecycle.expired".into());
        }
        lease.end_requested = true;
        if lease.active == 0 {
            self.lease = None;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}
#[derive(Default)]
pub struct LifecycleState {
    protocol: Mutex<Protocol>,
    paused: AtomicBool,
    producers: RwLock<()>,
    approved_exit: AtomicBool,
}
/// Own the native worker, not its webview response. Reload/end cannot resume
/// producers while this worker is still reading files or committing data.
pub(crate) struct OperationGuard {
    app: AppHandle,
    token: String,
    pub epoch: u64,
}
impl OperationGuard {
    pub fn validate_epoch(&self, db: &crate::db::DbState) -> Result<(), String> {
        if db.storage_epoch.load(Ordering::Relaxed) == self.epoch {
            Ok(())
        } else {
            Err("notes.storageChanged".into())
        }
    }
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        let state = self.app.state::<LifecycleState>();
        if let Ok(mut protocol) = state.protocol.lock() {
            if protocol.release(&self.token) {
                state.paused.store(false, Ordering::SeqCst);
            }
        };
    }
}
pub(crate) fn claim_operation(
    app: &AppHandle,
    token: &str,
    kind: &str,
) -> Result<OperationGuard, String> {
    let state = app.state::<LifecycleState>();
    let mut protocol = state.protocol.lock().map_err(|_| "lifecycle.failed")?;
    let epoch = protocol.claim(token, kind)?;
    Ok(OperationGuard {
        app: app.clone(),
        token: token.into(),
        epoch,
    })
}
pub(crate) fn allow_write(app: &AppHandle) -> Result<(), String> {
    if app.state::<LifecycleState>().is_paused() {
        Err("lifecycle.busy".into())
    } else {
        Ok(())
    }
}
fn async_operations() -> &'static Arc<tokio::sync::Semaphore> {
    static OPERATIONS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    OPERATIONS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(16)))
}
pub(crate) fn accept_async_operation(
    app: &AppHandle,
) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
    let state = app.state::<LifecycleState>();
    let _acceptance = state.try_producer().ok_or("lifecycle.busy")?;
    async_operations()
        .clone()
        .try_acquire_owned()
        .map_err(|_| "lifecycle.busy".into())
}
impl LifecycleState {
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
    /// Hold through the complete capture/cleanup, including filesystem work.
    /// Test again after taking the guard to close the pause/acquire race.
    pub fn try_producer(&self) -> Option<RwLockReadGuard<'_, ()>> {
        if self.is_paused() {
            return None;
        }
        let guard = self.producers.try_read().ok()?;
        if self.is_paused() {
            None
        } else {
            Some(guard)
        }
    }
    pub fn approved_exit(&self) -> bool {
        self.approved_exit.load(Ordering::SeqCst)
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveRequest {
    request_id: String,
    session_id: String,
    purpose: &'static str,
}
fn deliver(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<LifecycleState>();
    let request = {
        let protocol = state.protocol.lock().map_err(|_| "lifecycle.failed")?;
        protocol.pending.as_ref().and_then(|pending| {
            pending.session.as_ref().map(|session| SaveRequest {
                request_id: pending.id.clone(),
                session_id: session.clone(),
                purpose: if pending.kind == Termination::Restart {
                    "restart"
                } else {
                    "exit"
                },
            })
        })
    };
    if let Some(request) = request {
        app.emit_to("main", "lifecycle-save-request", request)
            .map_err(|_| "lifecycle.failed")?;
    }
    Ok(())
}
fn show_failure(app: &AppHandle, code: &str) {
    let _ = app.emit_to("main", "lifecycle-error", code);
    if let Some(window) = app.get_webview_window("main") {
        let _ = show_main(&window);
        let _ = window.set_focus();
    }
}
fn request(app: &AppHandle, kind: Termination) -> Result<(), String> {
    let state = app.state::<LifecycleState>();
    if state.is_paused() {
        return Err("lifecycle.busy".into());
    }
    let id = state
        .protocol
        .lock()
        .map_err(|_| "lifecycle.failed")?
        .request(kind)?;
    if let Err(error) = deliver(app) {
        state
            .protocol
            .lock()
            .map_err(|_| "lifecycle.failed")?
            .pending = None;
        return Err(error);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_DEADLINE);
        let state = app.state::<LifecycleState>();
        let expired = if let Ok(mut protocol) = state.protocol.lock() {
            if protocol
                .pending
                .as_ref()
                .is_some_and(|p| p.id == id && !p.finishing)
            {
                protocol.pending = None;
                true
            } else {
                false
            }
        } else {
            false
        };
        if expired {
            show_failure(&app, "lifecycle.saveTimeout");
        }
    });
    Ok(())
}
pub fn request_exit(app: &AppHandle, code: i32) {
    if let Err(error) = request(app, Termination::Exit(code)) {
        show_failure(app, &error);
    }
}
fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("lifecycle.mainOnly".into())
    }
}
#[tauri::command]
pub fn lifecycle_ready(
    app: AppHandle,
    window: WebviewWindow,
    session_id: String,
) -> Result<(), String> {
    main_only(&window)?;
    uuid::Uuid::parse_str(&session_id).map_err(|_| "lifecycle.invalidSession")?;
    let state = app.state::<LifecycleState>();
    let cancelled;
    {
        let mut protocol = state.protocol.lock().map_err(|_| "lifecycle.failed")?;
        cancelled = protocol.ready(session_id.clone())?;
        if let Some(lease) = protocol.lease.as_mut().filter(|l| l.session != session_id) {
            lease.end_requested = true;
            if lease.active == 0 {
                protocol.lease = None;
                state.paused.store(false, Ordering::SeqCst);
            }
        }
    }
    if cancelled { show_failure(&app, "lifecycle.sessionChanged"); }
    deliver(&app)
}
async fn drain_backend(app: AppHandle) -> Result<(), String> {
    // First wait for producers and save acceptance guards. Only then can all
    // accepted note permits be drained without racing a not-yet-enqueued save.
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<LifecycleState>();
        let _producers = state.producers.write().map_err(|_| "lifecycle.failed")?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "lifecycle.failed".to_string())??;
    crate::notes::drain_accepted_writes().await?;
    let operations = async_operations()
        .clone()
        .acquire_many_owned(16)
        .await
        .map_err(|_| "lifecycle.failed")?;
    drop(operations);
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<crate::db::DbState>();
        let _conn = db.conn.lock().map_err(|_| "lifecycle.failed")?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "lifecycle.failed".to_string())?
}
#[tauri::command]
pub async fn begin_storage_operation(
    app: AppHandle,
    window: WebviewWindow,
    session_id: String,
    kind: String,
    expected_storage_epoch: u64,
    operation_token: String,
) -> Result<(), String> {
    main_only(&window)?;
    if !matches!(kind.as_str(), "export" | "import" | "storage") {
        return Err("lifecycle.invalidOperation".into());
    }
    let state = app.state::<LifecycleState>();
    uuid::Uuid::parse_str(&operation_token).map_err(|_| "lifecycle.invalidOperation")?;
    let token = operation_token;
    {
        let mut protocol = state.protocol.lock().map_err(|_| "lifecycle.failed")?;
        if protocol.session.as_deref() != Some(&session_id)
            || protocol.pending.is_some()
            || protocol.lease.is_some()
            || state.is_paused()
        {
            return Err("lifecycle.busy".into());
        }
        protocol.lease = Some(Lease {
            token: token.clone(),
            session: session_id,
            kind,
            epoch: expected_storage_epoch,
            active: 1,
            end_requested: false,
        });
        state.paused.store(true, Ordering::SeqCst);
    }
    let guard = OperationGuard {
        app: app.clone(),
        token: token.clone(),
        epoch: expected_storage_epoch,
    };
    let drained = tokio::time::timeout(Duration::from_secs(5), drain_backend(app.clone()))
        .await
        .map_err(|_| "lifecycle.saveTimeout".to_string())
        .and_then(|result| result);
    let result = drained.and_then(|()| {
        let db = app.state::<crate::db::DbState>();
        let _conn = db.conn.lock().map_err(|_| "lifecycle.failed")?;
        guard.validate_epoch(&db)
    });
    if result.is_err() {
        if let Some(lease) = state
            .protocol
            .lock()
            .map_err(|_| "lifecycle.failed")?
            .lease
            .as_mut()
        {
            lease.end_requested = true;
        }
    }
    drop(guard);
    result
}
#[tauri::command]
pub fn end_storage_operation(
    app: AppHandle,
    window: WebviewWindow,
    session_id: String,
    operation_token: String,
) -> Result<(), String> {
    main_only(&window)?;
    let state = app.state::<LifecycleState>();
    let mut protocol = state.protocol.lock().map_err(|_| "lifecycle.failed")?;
    if protocol.end_lease(&session_id, &operation_token)? {
        state.paused.store(false, Ordering::SeqCst);
    }
    Ok(())
}
#[tauri::command]
pub fn request_app_restart(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    request(&app, Termination::Restart)
}
#[tauri::command]
pub fn lifecycle_cancel(
    app: AppHandle,
    window: WebviewWindow,
    request_id: String,
    session_id: String,
) -> Result<(), String> {
    main_only(&window)?;
    if app
        .state::<LifecycleState>()
        .protocol
        .lock()
        .map_err(|_| "lifecycle.failed")?
        .cancel(&request_id, &session_id)
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = show_main(&window);
            let _ = window.set_focus();
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn lifecycle_saved(
    app: AppHandle,
    window: WebviewWindow,
    request_id: String,
    session_id: String,
) -> Result<(), String> {
    main_only(&window)?;
    let state = app.state::<LifecycleState>();
    let kind = state
        .protocol
        .lock()
        .map_err(|_| "lifecycle.failed")?
        .accept(&request_id, &session_id)?;
    log::debug!(target: "copy_creator::metrics", "operation=lifecycle stage=save_acknowledged");
    state.paused.store(true, Ordering::SeqCst);
    let drained = tokio::time::timeout(Duration::from_secs(5), drain_backend(app.clone()))
        .await
        .map_err(|_| "lifecycle.saveTimeout".to_string())
        .and_then(|result| result);
    let result = drained.and_then(|()| {
        log::debug!(target: "copy_creator::metrics", "operation=lifecycle stage=backend_drained");
        crate::vault::lock_and_notify(&app);
        crate::paste::clear_sensitive_clipboard();
        state.approved_exit.store(true, Ordering::SeqCst);
        match kind {
            Termination::Exit(code) => {
                log::debug!(target: "copy_creator::metrics", "operation=lifecycle stage=request_exit");
                #[cfg(target_os = "windows")]
                {
                    // Like restart, Windows can acknowledge RequestExit but
                    // leave the event loop alive after a cancelled handoff.
                    // Every accepted writer is drained above, and WAL/FULL
                    // commits have completed. Run Tauri's documented cleanup
                    // on its main thread, then terminate immediately.
                    let exit = app.clone();
                    app.run_on_main_thread(move || {
                        exit.cleanup_before_exit();
                        std::process::exit(code);
                    })
                    .map_err(|_| "lifecycle.failed".to_string())
                }
                #[cfg(not(target_os = "windows"))]
                {
                    app.exit(code);
                    Ok(())
                }
            }
            Termination::Restart => {
                log::debug!(target: "copy_creator::metrics", "operation=lifecycle stage=request_restart");
                // Windows Release can acknowledge RequestExit without reaching
                // LoopDestroyed after a native picker and a dirty-note flush.
                // Tauri's main-thread restart performs its cleanup and relaunch
                // directly. Our own save acknowledgement, producer drain and
                // sensitive-data cleanup have already completed above.
                #[cfg(target_os = "windows")]
                {
                    let restart = app.clone();
                    app.run_on_main_thread(move || restart.restart())
                        .map_err(|_| "lifecycle.failed".to_string())
                }
                #[cfg(not(target_os = "windows"))]
                {
                    app.request_restart();
                    Ok(())
                }
            }
        }
    });
    if let Err(error) = &result {
        state.approved_exit.store(false, Ordering::SeqCst);
        state.paused.store(false, Ordering::SeqCst);
        state
            .protocol
            .lock()
            .map_err(|_| "lifecycle.failed")?
            .pending = None;
        show_failure(&app, error);
    }
    result
}
pub fn hint_hide(app: &AppHandle) {
    let _ = app.emit_to("main", "lifecycle-hide", ());
}

pub fn show_main(window: &WebviewWindow) -> tauri::Result<()> {
    window.show()?;
    let visible = window.is_visible()? && !window.is_minimized()?;
    let _ = window.emit_to("main", "main-window-visibility", visible);
    Ok(())
}

pub fn hide_main(window: &WebviewWindow) -> tauri::Result<()> {
    hint_hide(window.app_handle());
    window.hide()?;
    let _ = window.emit_to("main", "main-window-visibility", false);
    Ok(())
}

#[tauri::command]
pub fn hide_main_window(window: WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    hide_main(&window).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ready_and_ack_are_bound_to_current_main_session_and_request() {
        let mut protocol = Protocol::default();
        let id = protocol.request(Termination::Restart).unwrap();
        assert!(protocol.accept(&id, "old").is_err());
        protocol.ready("old".into()).unwrap();
        assert!(protocol.accept("wrong", "old").is_err());
        assert_eq!(protocol.accept(&id, "old").unwrap(), Termination::Restart);
        assert!(protocol.accept(&id, "old").is_err());
        assert!(protocol.ready("another".into()).is_err());
    }
    #[test]
    fn a_reloaded_session_cannot_confirm_the_previous_sessions_unconfirmed_handoff() {
        let mut protocol = Protocol::default();
        protocol.ready("old".into()).unwrap();
        let id = protocol.request(Termination::Restart).unwrap();
        protocol.ready("new".into()).unwrap();
        assert!(protocol.pending.is_none(), "a reload must cancel rather than rebind an existing handoff");
        assert!(protocol.accept(&id, "old").is_err());
        assert!(protocol.accept(&id, "new").is_err());
        let next = protocol.request(Termination::Exit(0)).unwrap();
        assert_eq!(protocol.accept(&next, "new").unwrap(), Termination::Exit(0));
    }
    #[test]
    fn cancellation_and_timeout_never_approve_an_exit() {
        let mut protocol = Protocol::default();
        protocol.ready("main".into()).unwrap();
        let id = protocol.request(Termination::Exit(0)).unwrap();
        assert!(protocol.request(Termination::Restart).is_err());
        assert!(!protocol.cancel(&id, "other"));
        assert!(protocol.cancel(&id, "main"));
        assert!(protocol.accept(&id, "main").is_err());
        let id = protocol.request(Termination::Exit(0)).unwrap();
        protocol.pending.as_mut().unwrap().started = Instant::now() - SAVE_DEADLINE;
        assert!(protocol.accept(&id, "main").is_err());
    }
    #[test]
    fn paused_producers_cannot_update_sequence_or_files_until_resumed() {
        let state = LifecycleState::default();
        let guard = state.try_producer().unwrap();
        state.paused.store(true, Ordering::SeqCst);
        assert!(state.try_producer().is_none());
        assert!(state.producers.try_write().is_err());
        drop(guard);
        assert!(state.producers.try_write().is_ok());
        state.paused.store(false, Ordering::SeqCst);
        assert!(state.try_producer().is_some());
        assert!(!state.approved_exit());
    }
    fn leased() -> Protocol {
        Protocol {
            session: Some("main".into()),
            pending: None,
            lease: Some(Lease {
                token: "operation".into(),
                session: "main".into(),
                kind: "import".into(),
                epoch: 7,
                active: 0,
                end_requested: false,
            }),
        }
    }
    #[test]
    fn a_lease_is_bound_to_one_operation_and_excludes_termination() {
        let mut protocol = leased();
        assert!(protocol.request(Termination::Exit(0)).is_err());
        assert!(protocol.claim("wrong", "import").is_err());
        assert!(protocol.claim("operation", "export").is_err());
        assert_eq!(protocol.claim("operation", "import").unwrap(), 7);
        assert!(protocol.claim("operation", "import").is_err());
        assert!(!protocol.release("operation"));
        assert_eq!(protocol.claim("operation", "import").unwrap(), 7);
    }
    #[test]
    fn end_during_a_native_worker_defers_resume_until_the_worker_drops() {
        let mut protocol = leased();
        protocol.claim("operation", "import").unwrap();
        assert!(!protocol.end_lease("main", "operation").unwrap());
        assert!(protocol.lease.is_some());
        assert!(protocol.claim("operation", "import").is_err());
        assert!(!protocol.release("other"));
        assert!(protocol.release("operation"));
        assert!(protocol.lease.is_none());
        assert!(!protocol.end_lease("main", "operation").unwrap());
        assert!(protocol.request(Termination::Restart).is_ok());
    }
    #[test]
    fn stale_end_cannot_resume_or_cancel_another_sessions_operation() {
        let mut protocol = leased();
        assert!(protocol.end_lease("old", "operation").is_err());
        assert!(protocol.end_lease("main", "old-token").is_err());
        assert!(protocol.lease.is_some());
        assert!(protocol.end_lease("main", "operation").unwrap());
        protocol.lease = leased().lease;
        assert!(protocol.end_lease("main", "old-token").is_err());
        assert!(protocol.lease.is_some());
    }
}
