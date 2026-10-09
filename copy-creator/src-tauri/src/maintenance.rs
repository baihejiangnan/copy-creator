//! One periodic worker, no catch-up queue. A paused/contended due pass stays due.
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const INTERVAL: Duration = Duration::from_secs(3600);
const RETRY: Duration = Duration::from_secs(1);
const ERROR_RETRY: Duration = Duration::from_secs(60);

#[derive(Clone, Copy)]
enum Outcome { Complete, Deferred, Failed }

struct Schedule { next: Instant, interval: Duration }
impl Schedule {
    fn new(now: Instant, interval: Duration) -> Self { Self { next: now + interval, interval } }
    fn wait(&self, now: Instant) -> Duration { self.next.saturating_duration_since(now) }
    fn finish(&mut self, now: Instant, outcome: Outcome) {
        self.next = now + match outcome {
            Outcome::Complete => self.interval,
            Outcome::Deferred => RETRY,
            Outcome::Failed => ERROR_RETRY,
        };
    }
}

fn interval_for_identifier(identifier: &str, requested: Option<&str>) -> Duration {
    // Accelerated wall-clock QA is opt-in, unavailable in normal builds and
    // forbidden for the production identity even in a diagnostics build.
    if cfg!(feature = "diagnostics") && identifier != "com.copycreator.app" {
        if let Some(ms) = requested.and_then(|value| value.parse::<u64>().ok()) {
            if (5000..=3_600_000).contains(&ms) { return Duration::from_millis(ms); }
        }
    }
    INTERVAL
}

pub(crate) fn start(app: &AppHandle) -> std::io::Result<()> {
    let app = app.clone();
    let interval = interval_for_identifier(&app.config().identifier,
        std::env::var("COPY_CREATOR_QA_PRUNE_INTERVAL_MS").ok().as_deref());
    std::thread::Builder::new().name("clipboard-prune-worker".into()).spawn(move || {
        log::debug!(target: "copy_creator::metrics", "maintenance interval_ms={}", interval.as_millis());
        let mut schedule = Schedule::new(Instant::now(), interval);
        loop {
            std::thread::sleep(schedule.wait(Instant::now()));
            let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
            let outcome = if let Some(_producer) = lifecycle.try_producer() {
                match crate::db::prune_old_records_background(&app) {
                    Ok(clipboard_done) => {
                        match crate::notes::prune_expired(&app) {
                            Ok(notes_done) if clipboard_done && notes_done => Outcome::Complete,
                            Ok(_) => Outcome::Deferred,
                            Err(()) => Outcome::Failed,
                        }
                    }
                    Err(_) => { log::warn!("periodic clipboard pruning failed"); Outcome::Failed }
                }
            } else { Outcome::Deferred };
            log::debug!(target: "copy_creator::metrics", "maintenance complete={} deferred={}",
                matches!(outcome, Outcome::Complete), matches!(outcome, Outcome::Deferred));
            // The producer guard has ended before sleeping: backup/relocation
            // waits for at most this accepted bounded pass, not an entire TTL sweep.
            schedule.finish(Instant::now(), outcome);
        }
    }).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paused_due_pass_retries_without_waiting_another_hour_or_building_a_backlog() {
        let now = Instant::now();
        let mut schedule = Schedule::new(now, INTERVAL);
        assert_eq!(schedule.wait(now), INTERVAL);
        let due = now + INTERVAL;
        assert!(schedule.wait(due).is_zero());
        schedule.finish(due, Outcome::Deferred);
        assert_eq!(schedule.wait(due), RETRY);
        // A long backup or machine suspension does not enqueue missed hourly runs.
        let resumed = due + INTERVAL * 4;
        assert!(schedule.wait(resumed).is_zero());
        schedule.finish(resumed, Outcome::Complete);
        assert_eq!(schedule.wait(resumed), INTERVAL);
        schedule.finish(resumed + INTERVAL, Outcome::Failed);
        assert_eq!(schedule.wait(resumed + INTERVAL), ERROR_RETRY);
    }
    #[test]
    fn accelerated_qa_clock_never_applies_to_production_or_normal_builds() {
        assert_eq!(interval_for_identifier("com.copycreator.app", Some("5000")), INTERVAL);
        for value in [None, Some("0"), Some("4999"), Some("3600001"), Some("invalid")] {
            assert_eq!(interval_for_identifier("com.copycreator.qa20261007", value), INTERVAL);
        }
        assert_eq!(interval_for_identifier("com.copycreator.qa20261007", Some("5000")),
            if cfg!(feature="diagnostics") { Duration::from_secs(5) } else { INTERVAL });
    }
}
