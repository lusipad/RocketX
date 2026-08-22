use std::{sync::Mutex, time::Duration};

use serde::Serialize;

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RuntimeStatus {
    Idle,
    Starting,
    Running,
    Stopping,
    Backoff,
    Blocked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SupervisorPolicy {
    pub(crate) max_failures: u32,
    pub(crate) base_backoff: Duration,
    pub(crate) max_backoff: Duration,
    pub(crate) stable_after: Duration,
}

impl Default for SupervisorPolicy {
    fn default() -> Self {
        Self {
            max_failures: 3,
            base_backoff: Duration::from_millis(250),
            max_backoff: Duration::from_secs(5),
            stable_after: Duration::from_secs(30),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SupervisorSnapshot {
    pub(crate) status: RuntimeStatus,
    pub(crate) failures: u32,
    pub(crate) restart_after: Option<Duration>,
}

pub(crate) fn observe_exit(
    supervisor: &Mutex<RuntimeSupervisor>,
    now_ms: u64,
    intentional: bool,
) -> SupervisorSnapshot {
    supervisor
        .lock()
        .map(|mut value| {
            value.mark_exit(now_ms, intentional);
            value.snapshot(now_ms)
        })
        .unwrap_or(SupervisorSnapshot {
            status: RuntimeStatus::Blocked,
            failures: 0,
            restart_after: None,
        })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StartError {
    Backoff(Duration),
    Blocked,
    Stopping,
}

pub(crate) struct RuntimeSupervisor {
    policy: SupervisorPolicy,
    status: RuntimeStatus,
    failures: u32,
    started_at_ms: Option<u64>,
    restart_at_ms: Option<u64>,
}

impl RuntimeSupervisor {
    pub(crate) fn new(policy: SupervisorPolicy) -> Self {
        Self {
            policy,
            status: RuntimeStatus::Idle,
            failures: 0,
            started_at_ms: None,
            restart_at_ms: None,
        }
    }

    pub(crate) fn begin_start(&mut self, now_ms: u64) -> Result<(), StartError> {
        match self.status {
            RuntimeStatus::Blocked => return Err(StartError::Blocked),
            RuntimeStatus::Backoff => {
                let restart_at = self.restart_at_ms.unwrap_or(now_ms);
                if now_ms < restart_at {
                    return Err(StartError::Backoff(Duration::from_millis(
                        restart_at - now_ms,
                    )));
                }
            }
            RuntimeStatus::Starting | RuntimeStatus::Running => return Ok(()),
            RuntimeStatus::Stopping => return Err(StartError::Stopping),
            RuntimeStatus::Idle => {}
        }
        self.status = RuntimeStatus::Starting;
        self.restart_at_ms = None;
        Ok(())
    }

    pub(crate) fn mark_running(&mut self, now_ms: u64) {
        self.status = RuntimeStatus::Running;
        self.started_at_ms = Some(now_ms);
    }

    pub(crate) fn request_stop(&mut self) {
        if !matches!(self.status, RuntimeStatus::Idle | RuntimeStatus::Blocked) {
            self.status = RuntimeStatus::Stopping;
        }
    }

    pub(crate) fn mark_stopped(&mut self) {
        self.status = RuntimeStatus::Idle;
        self.started_at_ms = None;
        self.restart_at_ms = None;
    }

    pub(crate) fn mark_exit(&mut self, now_ms: u64, intentional: bool) {
        if intentional || self.status == RuntimeStatus::Stopping {
            self.mark_stopped();
            return;
        }
        if self.started_at_ms.is_some_and(|started| {
            now_ms.saturating_sub(started) >= self.policy.stable_after.as_millis() as u64
        }) {
            self.failures = 0;
        }
        self.failures = self.failures.saturating_add(1);
        self.started_at_ms = None;
        if self.failures > self.policy.max_failures {
            self.status = RuntimeStatus::Blocked;
            self.restart_at_ms = None;
            return;
        }
        let exponent = self.failures.saturating_sub(1).min(31);
        let multiplier = 1_u32 << exponent;
        let backoff = self
            .policy
            .base_backoff
            .checked_mul(multiplier)
            .unwrap_or(self.policy.max_backoff)
            .min(self.policy.max_backoff);
        self.status = RuntimeStatus::Backoff;
        self.restart_at_ms = Some(now_ms.saturating_add(backoff.as_millis() as u64));
    }

    pub(crate) fn snapshot(&self, now_ms: u64) -> SupervisorSnapshot {
        SupervisorSnapshot {
            status: self.status,
            failures: self.failures,
            restart_after: self
                .restart_at_ms
                .map(|restart_at| Duration::from_millis(restart_at.saturating_sub(now_ms))),
        }
    }
}

impl Default for RuntimeSupervisor {
    fn default() -> Self {
        Self::new(SupervisorPolicy::default())
    }
}

#[cfg(test)]
mod tests {
    use super::{RuntimeStatus, RuntimeSupervisor, StartError, SupervisorPolicy};
    use std::time::Duration;

    fn policy() -> SupervisorPolicy {
        SupervisorPolicy {
            max_failures: 2,
            base_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_millis(250),
            stable_after: Duration::from_millis(1_000),
        }
    }

    #[test]
    fn crash_enters_exponential_backoff_then_blocks_after_limit() {
        let mut supervisor = RuntimeSupervisor::new(policy());
        supervisor.begin_start(0).unwrap();
        supervisor.mark_running(0);
        supervisor.mark_exit(10, false);
        assert_eq!(supervisor.snapshot(10).status, RuntimeStatus::Backoff);
        assert_eq!(
            supervisor.snapshot(10).restart_after,
            Some(Duration::from_millis(100))
        );
        assert!(matches!(
            supervisor.begin_start(50),
            Err(StartError::Backoff(_))
        ));
        supervisor.begin_start(110).unwrap();
        supervisor.mark_running(110);
        supervisor.mark_exit(120, false);
        assert_eq!(
            supervisor.snapshot(120).restart_after,
            Some(Duration::from_millis(200))
        );
        supervisor.begin_start(320).unwrap();
        supervisor.mark_running(320);
        supervisor.mark_exit(330, false);
        assert_eq!(supervisor.snapshot(330).status, RuntimeStatus::Blocked);
        assert_eq!(supervisor.begin_start(10_000), Err(StartError::Blocked));
    }

    #[test]
    fn stable_runtime_resets_crash_budget_and_explicit_stop_is_idle() {
        let mut supervisor = RuntimeSupervisor::new(policy());
        supervisor.begin_start(0).unwrap();
        supervisor.mark_running(0);
        supervisor.mark_exit(10, false);
        supervisor.begin_start(110).unwrap();
        supervisor.mark_running(110);
        supervisor.mark_exit(1_200, false);
        assert_eq!(supervisor.snapshot(1_200).failures, 1);
        supervisor.begin_start(1_300).unwrap();
        supervisor.mark_running(1_300);
        supervisor.request_stop();
        supervisor.mark_exit(1_301, false);
        assert_eq!(supervisor.snapshot(1_301).status, RuntimeStatus::Idle);
    }

    #[test]
    fn a_stopping_runtime_cannot_be_started_again_before_exit_is_observed() {
        let mut supervisor = RuntimeSupervisor::new(policy());
        supervisor.begin_start(0).unwrap();
        supervisor.mark_running(0);
        supervisor.request_stop();
        assert_eq!(supervisor.begin_start(1), Err(StartError::Stopping));
        supervisor.mark_exit(2, false);
        assert_eq!(supervisor.snapshot(2).status, RuntimeStatus::Idle);
        supervisor.begin_start(3).unwrap();
    }
}
