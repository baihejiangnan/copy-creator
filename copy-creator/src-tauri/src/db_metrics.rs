//! Optional scoped SQLite metrics. No SQL text, parameters or record identity
//! leave the callback. Default builds do not install a SQLite profiler.
use rusqlite::Connection;

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct SqlMetrics {
    pub statements: u64,
    // SQLite's profile timer is approximately millisecond resolution. Keep
    // its integer units explicit; zero does not mean the statement was free.
    pub elapsed_ms: u128,
}

#[cfg(feature = "diagnostics")]
mod enabled {
    use super::*;
    use std::{cell::Cell, time::Duration};
    thread_local! {
        static CURRENT: Cell<SqlMetrics> = Cell::new(SqlMetrics { statements: 0, elapsed_ms: 0 });
    }
    fn statement_finished(_sql: &str, elapsed: Duration) {
        CURRENT.with(|current| {
            let mut metrics = current.get();
            metrics.statements = metrics.statements.saturating_add(1);
            metrics.elapsed_ms = metrics.elapsed_ms.saturating_add(elapsed.as_millis());
            current.set(metrics);
        });
    }
    struct Profile<'a>(&'a mut Connection);
    impl Drop for Profile<'_> {
        fn drop(&mut self) {
            self.0.profile(None);
            CURRENT.with(|current| current.set(SqlMetrics::default()));
        }
    }
    pub(super) fn measure<T>(conn: &mut Connection, action: impl FnOnce(&mut Connection) -> T) -> (T, Option<SqlMetrics>) {
        CURRENT.with(|current| current.set(SqlMetrics::default()));
        conn.profile(Some(statement_finished));
        let profile = Profile(conn);
        let value = action(profile.0);
        let metrics = CURRENT.with(Cell::get);
        drop(profile);
        (value, Some(metrics))
    }
}

pub(crate) fn measure<T>(conn: &mut Connection, action: impl FnOnce(&mut Connection) -> T) -> (T, Option<SqlMetrics>) {
    #[cfg(feature = "diagnostics")]
    { enabled::measure(conn, action) }
    #[cfg(not(feature = "diagnostics"))]
    { (action(conn), None) }
}

// These labels are fixed call-site names, never paths, tokens or user values.
// A connection scope includes Rust work performed while holding that mutex;
// SQLite's profile aggregate is reported separately, with millisecond units.
pub(crate) fn backup_connection<T>(
    state: &crate::db::DbState,
    stage: &'static str,
    lock_error: &'static str,
    action: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    #[cfg(not(feature = "diagnostics"))]
    {
        let _ = stage;
        let mut conn = state.conn.lock().map_err(|_| lock_error)?;
        action(&mut conn)
    }
    #[cfg(feature = "diagnostics")]
    {
        let waiting = std::time::Instant::now();
        let mut conn = state.conn.lock().map_err(|_| lock_error)?;
        let lock_wait_us = waiting.elapsed().as_micros();
        let executing = std::time::Instant::now();
        let (result, sql) = measure(&mut conn, action);
        let held_us = executing.elapsed().as_micros();
        drop(conn);
        let sql = sql.unwrap_or_default();
        log::debug!(target: "copy_creator::metrics", "backup stage={stage} ok={} lock_wait_us={lock_wait_us} held_us={held_us} sql_count={} sql_profile_ms={}", result.is_ok(), sql.statements, sql.elapsed_ms);
        result
    }
}

pub(crate) fn backup_worker<T>(
    operation: &'static str,
    accepted: std::time::Instant,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    #[cfg(not(feature = "diagnostics"))]
    { let _ = (operation, accepted); action() }
    #[cfg(feature = "diagnostics")]
    {
        let queued_us = accepted.elapsed().as_micros();
        let executing = std::time::Instant::now();
        let result = action();
        log::debug!(target: "copy_creator::metrics", "backup operation={operation} ok={} queued_us={queued_us} worker_us={}", result.is_ok(), executing.elapsed().as_micros());
        result
    }
}

#[cfg(all(test, feature = "diagnostics"))]
mod tests {
    use super::*;
    #[test]
    fn scopes_reset_after_errors_and_panics_and_do_not_mix_threads() {
        let mut conn = Connection::open_in_memory().unwrap();
        let (failure, first) = measure(&mut conn, |conn| -> rusqlite::Result<()> {
            conn.execute_batch("CREATE TABLE fixture(value TEXT)")?;
            conn.execute("INSERT INTO fixture VALUES (?1)", ["synthetic-private-text"])?;
            conn.execute_batch("SELECT * FROM missing_table")
        });
        assert!(failure.is_err());
        assert_eq!(first.unwrap().statements, 2);
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            measure(&mut conn, |conn| {
                conn.execute_batch("SELECT 1").unwrap();
                panic!("synthetic failure");
            });
        }));
        assert!(panic.is_err());
        conn.execute_batch("SELECT 2").unwrap(); // outside scope is excluded
        let peer = std::thread::spawn(|| {
            let mut conn = Connection::open_in_memory().unwrap();
            measure(&mut conn, |conn| conn.execute_batch("SELECT 3; SELECT 4").unwrap()).1.unwrap()
        });
        let (_, last) = measure(&mut conn, |conn| conn.execute_batch("SELECT 5").unwrap());
        assert_eq!(last.unwrap().statements, 1);
        assert_eq!(peer.join().unwrap().statements, 2);
        // The aggregate type holds numbers only; no SQL or values are retained.
        assert!(!format!("{:?}", first).contains("synthetic-private-text"));
    }
}
