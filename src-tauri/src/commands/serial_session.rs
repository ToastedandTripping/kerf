//! Session-level admission fence for the serial command layer.
//!
//! `SerialSession` tracks connection epochs, job phases, submission permits,
//! and the stop operation. It is a field of `SerialInner` — NOT a lock itself.
//! Its fields are atomics plus small leaf mutexes.
//!
//! ## Epoch
//!
//! Incremented on connect, on confirmed stop, and on disconnect. A stale epoch
//! makes a job begin or a per-line write refuse without touching the wire.
//!
//! ## Phase
//!
//! `Disconnected` → `Idle` (connect) → `Active` (job begin) → `Stopping`
//! (stop) → `Idle` (confirmed) or `Unknown` (unconfirmed).
//!
//! ## Submission permit
//!
//! The permit is NOT a lock. It is a generation-checked atomic comparison with
//! a phase gate. See `try_permit()` for the protocol.
//!
//! ## Stop operation
//!
//! Sends `0x18` immediately per the 2026-09-20 DECISIONS ruling (no feed hold,
//! no M5, no ack wait). `0x18` is idempotent and realtime; the stop takes no
//! epoch precondition. Single-flight gates only the observation/result phase,
//! not the `0x18` send.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;

use super::grbl_status::GrblSnapshot;

/// Phase of the serial session.
pub const PHASE_DISCONNECTED: u8 = 0;
pub const PHASE_IDLE: u8 = 1;
pub const PHASE_ACTIVE: u8 = 2;
pub const PHASE_STOPPING: u8 = 3;
pub const PHASE_UNKNOWN: u8 = 4;

/// Result of a stop operation. Serialized for the TS side (B4 consumes this).
/// The `tag = "outcome"` with `rename_all = "camelCase"` camelCases variant
/// names only. Field names use explicit `#[serde(rename)]` for TS compatibility.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum StopResult {
    /// Reset banner observed within the deadline.
    Confirmed {
        #[serde(rename = "epochBefore")]
        epoch_before: u64,
        #[serde(rename = "epochAfter")]
        epoch_after: u64,
        messages: Vec<String>,
    },
    /// `0x18` sent but banner not observed within the deadline.
    SubmittedUnconfirmed {
        epoch: u64,
        #[serde(rename = "inFlightWrite")]
        in_flight_write: bool,
        messages: Vec<String>,
    },
    /// `0x18` write failed (both attempts).
    SubmissionFailed {
        epoch: u64,
        error: String,
        messages: Vec<String>,
    },
}

impl StopResult {
    /// Console messages this result carries. Used by B4's TS-side display.
    #[allow(dead_code)]
    pub fn messages(&self) -> &[String] {
        match self {
            StopResult::Confirmed { messages, .. } => messages,
            StopResult::SubmittedUnconfirmed { messages, .. } => messages,
            StopResult::SubmissionFailed { messages, .. } => messages,
        }
    }
}

/// Type alias to avoid clippy::type_complexity on the observer.
type SessionObserver = Box<dyn Fn(&str) + Send + Sync>;

/// The session-level admission fence. Lives as a field of `SerialInner`.
pub struct SerialSession {
    /// Connection epoch — incremented on connect, confirmed stop, disconnect.
    pub(crate) epoch: AtomicU64,
    /// Phase: disconnected=0, idle=1, active=2, stopping=3, unknown=4.
    pub(crate) phase: AtomicU8,
    /// The epoch at which the current job was admitted. None if no job.
    pub(crate) admitted_job: Mutex<Option<u64>>,
    /// True while a stop operation is in the observation phase (RAII-guarded).
    pub(crate) stop_in_flight: AtomicBool,
    /// Set by ANY body that reads a Banner line while `stop_in_flight` is true.
    pub(crate) banner_observed: AtomicBool,
    /// Incremented on stop; writers compare before+after write.
    pub(crate) permit_generation: AtomicU64,
    /// Result slot for joiners — written by the stop, read+cleared by the joiner.
    pub(crate) last_stop: Mutex<Option<StopResult>>,
    /// Session-event sink for tests. Production leaves this None.
    pub(crate) observer: Mutex<Option<SessionObserver>>,
    /// Set when an event-sink failure caused the stop (so the wrapper can
    /// distinguish sink failure from user cancel).
    pub(crate) sink_failed: AtomicBool,
    /// Monotonic status snapshot sequence counter.
    pub(crate) snapshot_seq: AtomicU64,
    /// Last parsed status snapshot. Leaf lock — never held while waiting on
    /// anything (lock-order table: leaf, alongside admitted_job/last_stop/observer).
    pub(crate) snapshot: Mutex<Option<GrblSnapshot>>,
}

impl Default for SerialSession {
    fn default() -> Self {
        Self {
            epoch: AtomicU64::new(0),
            phase: AtomicU8::new(PHASE_DISCONNECTED),
            admitted_job: Mutex::new(None),
            stop_in_flight: AtomicBool::new(false),
            banner_observed: AtomicBool::new(false),
            permit_generation: AtomicU64::new(0),
            last_stop: Mutex::new(None),
            observer: Mutex::new(None),
            sink_failed: AtomicBool::new(false),
            snapshot_seq: AtomicU64::new(0),
            snapshot: Mutex::new(None),
        }
    }
}

impl SerialSession {
    /// Emit a session event to the observer (if set).
    pub(crate) fn emit(&self, event: &str) {
        if let Ok(guard) = self.observer.lock() {
            if let Some(ref f) = *guard {
                f(event);
            }
        }
    }

    /// Increment epoch and return the new value.
    pub(crate) fn increment_epoch(&self) -> u64 {
        self.epoch.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Try to acquire a submission permit. Returns Ok(()) if the session
    /// is active and the generation has not changed, Err otherwise.
    ///
    /// The permit is NOT a lock. It is a generation-checked atomic comparison
    /// with a phase gate:
    ///
    /// 1. g0 = permit_generation (SeqCst)
    /// 2. if phase != active → refuse
    /// 3. (caller writes the line)
    /// 4. g1 = permit_generation (SeqCst)
    /// 5. if g0 != g1 → in-flight write detected
    ///
    /// This function performs steps 1-2. The caller must perform step 4-5 after
    /// the write. Returns g0 on success for the caller to compare.
    pub(crate) fn try_permit_begin(&self, epoch: Option<u64>) -> Result<u64, String> {
        let g0 = self.permit_generation.load(Ordering::SeqCst);
        let current_phase = self.phase.load(Ordering::SeqCst);
        if current_phase != PHASE_ACTIVE {
            return Err(format!(
                "session not active (phase={})",
                phase_name(current_phase)
            ));
        }
        if let Some(ep) = epoch {
            // Check epoch against admitted job
            let admitted = self
                .admitted_job
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if *admitted != Some(ep) {
                return Err(format!(
                    "epoch mismatch: expected {:?}, got {}",
                    *admitted, ep
                ));
            }
        }
        Ok(g0)
    }

    /// Check whether the generation changed after a write. Returns Ok if
    /// unchanged, Err with a description if a stop happened during the write.
    pub(crate) fn try_permit_end(&self, g0: u64) -> Result<(), String> {
        let g1 = self.permit_generation.load(Ordering::SeqCst);
        if g0 != g1 {
            Err("in-flight write detected: permit generation changed during write".to_string())
        } else {
            Ok(())
        }
    }

    /// Transition to idle phase (from connect or confirmed stop).
    pub(crate) fn set_idle(&self) {
        self.phase.store(PHASE_IDLE, Ordering::SeqCst);
    }

    /// Publish a parsed status snapshot. Enforces monotonic `(epoch, seq)`:
    /// a snapshot with a stale epoch or lower seq is silently dropped.
    /// `lock_epoch` is the epoch captured when the command lock was acquired
    /// (not the current epoch — prevents post-stop snapshots carrying pre-stop epochs).
    pub(crate) fn publish_snapshot(&self, raw: &str, lock_epoch: u64) {
        let seq = self.snapshot_seq.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(parsed) = super::grbl_status::parse_status_frame(raw, lock_epoch, seq) {
            let mut guard = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
            // Monotonic: reject if epoch regressed or (same epoch, lower seq).
            if let Some(ref existing) = *guard {
                if lock_epoch < existing.epoch
                    || (lock_epoch == existing.epoch && seq <= existing.seq)
                {
                    return;
                }
            }
            *guard = Some(parsed);
        }
    }

    /// Invalidate the snapshot (on stop or disconnect). The next reader sees None.
    pub(crate) fn invalidate_snapshot(&self) {
        let mut guard = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }

    /// Read the current snapshot (if any). Returns a clone.
    pub(crate) fn read_snapshot(&self) -> Option<GrblSnapshot> {
        let guard = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        guard.clone()
    }

    /// Transition to disconnected phase and reset state.
    pub(crate) fn set_disconnected(&self) {
        self.phase.store(PHASE_DISCONNECTED, Ordering::SeqCst);
        // Clear admitted job
        let mut aj = self.admitted_job.lock().unwrap_or_else(|e| e.into_inner());
        *aj = None;
    }
}

/// RAII guard for the `stop_in_flight` flag. Sets true on creation,
/// clears on Drop (panic-safe).
pub(crate) struct StopGuard<'a> {
    flag: &'a AtomicBool,
}

impl<'a> StopGuard<'a> {
    /// Begin a stop observation phase. Returns None if a stop is already in
    /// flight (the caller should join instead).
    pub(crate) fn begin(flag: &'a AtomicBool) -> Option<Self> {
        // If already true, another stop is in the observation phase.
        if flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            Some(Self { flag })
        } else {
            None
        }
    }
}

impl Drop for StopGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

/// Human-readable phase name.
pub fn phase_name(phase: u8) -> &'static str {
    match phase {
        PHASE_DISCONNECTED => "disconnected",
        PHASE_IDLE => "idle",
        PHASE_ACTIVE => "active",
        PHASE_STOPPING => "stopping",
        PHASE_UNKNOWN => "unknown",
        _ => "invalid",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_result_serde_confirmed() {
        let result = StopResult::Confirmed {
            epoch_before: 1,
            epoch_after: 2,
            messages: vec![
                "STOP: 0x18 sent".to_string(),
                "STOP: reset confirmed. Controller reset confirmed. Beam state unqualified — verify visually.".to_string(),
            ],
        };
        let json = serde_json::to_string_pretty(&result).unwrap();
        let parsed: StopResult = serde_json::from_str(&json).unwrap();
        assert_eq!(result, parsed);
        // Pin the shape for B4's TS test
        assert!(json.contains("\"outcome\": \"confirmed\""), "json: {json}");
        assert!(json.contains("\"epochBefore\""), "json: {json}");
        assert!(json.contains("\"epochAfter\""), "json: {json}");
        assert!(json.contains("\"messages\""), "json: {json}");
    }

    #[test]
    fn stop_result_serde_submitted_unconfirmed() {
        let result = StopResult::SubmittedUnconfirmed {
            epoch: 3,
            in_flight_write: true,
            messages: vec![
                "STOP: 0x18 sent".to_string(),
                "STOP: unconfirmed — use the machine's physical stop. Beam state unqualified — verify visually.".to_string(),
            ],
        };
        let json = serde_json::to_string_pretty(&result).unwrap();
        let parsed: StopResult = serde_json::from_str(&json).unwrap();
        assert_eq!(result, parsed);
        assert!(json.contains("\"outcome\": \"submittedUnconfirmed\""), "json: {json}");
        assert!(json.contains("\"inFlightWrite\""), "json: {json}");
    }

    #[test]
    fn stop_result_serde_submission_failed() {
        let result = StopResult::SubmissionFailed {
            epoch: 4,
            error: "write failed".to_string(),
            messages: vec![
                "STOP failed: could not send reset. Use the machine's physical emergency stop. Beam state unqualified.".to_string(),
            ],
        };
        let json = serde_json::to_string_pretty(&result).unwrap();
        let parsed: StopResult = serde_json::from_str(&json).unwrap();
        assert_eq!(result, parsed);
        assert!(json.contains("\"outcome\": \"submissionFailed\""));
    }

    #[test]
    fn stop_guard_raii() {
        let flag = AtomicBool::new(false);
        {
            let guard = StopGuard::begin(&flag);
            assert!(guard.is_some());
            assert!(flag.load(Ordering::SeqCst));
            // Second attempt should return None (single-flight)
            assert!(StopGuard::begin(&flag).is_none());
        }
        assert!(!flag.load(Ordering::SeqCst));
    }

    #[test]
    fn stop_guard_panic_safe() {
        let flag = AtomicBool::new(false);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = StopGuard::begin(&flag);
            panic!("simulated panic");
        }));
        assert!(result.is_err());
        assert!(!flag.load(Ordering::SeqCst));
    }

    #[test]
    fn try_permit_begin_refuses_non_active() {
        let session = SerialSession::default();
        session.phase.store(PHASE_IDLE, Ordering::SeqCst);
        assert!(session.try_permit_begin(None).is_err());
    }

    #[test]
    fn try_permit_begin_accepts_active() {
        let session = SerialSession::default();
        session.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
        *session.admitted_job.lock().unwrap() = Some(1);
        assert!(session.try_permit_begin(Some(1)).is_ok());
    }

    #[test]
    fn try_permit_begin_refuses_wrong_epoch() {
        let session = SerialSession::default();
        session.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
        *session.admitted_job.lock().unwrap() = Some(1);
        assert!(session.try_permit_begin(Some(99)).is_err());
    }

    #[test]
    fn try_permit_end_detects_generation_change() {
        let session = SerialSession::default();
        let g0 = session.permit_generation.load(Ordering::SeqCst);
        session.permit_generation.fetch_add(1, Ordering::SeqCst);
        assert!(session.try_permit_end(g0).is_err());
    }

    #[test]
    fn default_phase_is_disconnected() {
        let session = SerialSession::default();
        assert_eq!(session.phase.load(Ordering::SeqCst), PHASE_DISCONNECTED);
        assert_eq!(session.epoch.load(Ordering::SeqCst), 0);
    }
}
