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
//! Admission is a phase + epoch check (`check_admission`). The check that
//! counts is made inside the `submit` critical section by `admit_and_write`,
//! atomically with the job line's single `write()` call. See "Job-line
//! admission" below.
//!
//! ## Stop operation
//!
//! Sends `0x18` immediately per the 2026-09-20 DECISIONS ruling (no feed hold,
//! no M5, no ack wait). `0x18` is idempotent and realtime; the stop takes no
//! epoch precondition. Single-flight: a second stop call while the first is
//! observing is a JOINER — it waits for the first to finish, returns
//! `last_stop`, and sends no byte at all. `serial_stop_inner` is the only
//! production writer of an abort `0x18`; no path re-sends it.
//!
//! ## Job-line admission (RF-15, submission critical section)
//!
//! Every job line carries the epoch of the admitted job. **Invariant: every
//! job-epoch write goes through `admit_and_write`.** Both production send
//! paths (`serial_send` with `job_epoch`, `serial_stream_job` for its `$32=1`
//! bracket and per line in the buffered pump) run `permit_precheck` before
//! waiting on the command lock (fast-fail only) and `try_permit_begin` while
//! holding the command lock, before any drain (non-authoritative: it only
//! spares a refused send the drain). The authoritative check is inside
//! `admit_and_write`. A refused line returns a `refused: not-admitted:`
//! contract string and writes nothing.
//!
//! ### Ordering argument
//!
//! - The writer, holding `submit`: check admission → one `write()` of the
//!   line → drop `submit`. The flush (`tcdrain`), reads and emits happen
//!   after the lock is dropped.
//! - The stop's Step 2, holding `submit` then `admitted_job`: phase Stopping,
//!   `admitted_job` cleared → drop both → later, `0x18`.
//! - A writer holding `submit` finishes its `write()` before the stop can
//!   close admission, so its bytes are queued before the stop's `0x18`. A
//!   writer taking `submit` after the stop released it sees admission closed
//!   and is refused with nothing written. No interleaving puts job bytes after
//!   the stop's `0x18`.
//! - **Assumption:** the writer and realtime handles are one tty
//!   (`try_clone` = `F_DUPFD_CLOEXEC`) with one kernel output queue, so bytes
//!   reach the wire in `write(2)` order.
//! - **Bound (premise):** `submit` covers the line's `write_all` (normally
//!   one `write(2)` after `POLLOUT` on a blocking fd). Buffered job lines are
//!   capped at 127 bytes (the RX budget); per-line job lines are uncapped but
//!   GRBL-sized, far below the driver buffer. Ordering never depends on
//!   length: the whole `write_all` runs under `submit`. Only the latency bound
//!   depends on it: the hold is one port timeout (1000 ms) per partial write,
//!   so a line past the driver buffer stretches it by one timeout per extra
//!   write. `write()` returns on enqueue, not on transmit. The stop never
//!   waits on the controller, an acknowledgement, or transmission.
//! - **Close under the lock:** the stop's admission close is
//!   `close_admission`, which takes the `submit` guard by reference, so the
//!   caller must hold it while phase and `admitted_job` are written (a
//!   barrier-only take-and-drop would let a writer pass the check in the gap).
//! - **Lock order:** `command` → `submit` → `admitted_job` (leaf). Nothing
//!   takes `submit` while holding `realtime` or `admitted_job`. Every
//!   acquisition recovers from poison, so a panicked writer never stops STOP.
//!
//! Ending a job (`serial_job_end`) moves Active→Idle only (CAS); it never
//! overwrites Unknown.

use serde::{Deserialize, Serialize};
use std::io;
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
    SubmittedUnconfirmed { epoch: u64, messages: Vec<String> },
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

/// Stable prefix of every job-line refusal. TS (`connection.ts`
/// `PERMIT_REFUSED_PREFIX`) matches it with `startsWith`.
pub(crate) const REFUSED_PREFIX: &str = "refused:";

/// Refusal: the session is not in the Active phase.
pub(crate) fn refused_not_active(phase: u8) -> String {
    format!(
        "{REFUSED_PREFIX} not-admitted: session not active (phase={})",
        phase_name(phase)
    )
}

/// Refusal: the line's job epoch is not the admitted job.
pub(crate) fn refused_epoch_mismatch(job: u64, admitted: Option<u64>) -> String {
    let admitted = match admitted {
        Some(n) => n.to_string(),
        None => "none".to_string(),
    };
    format!("{REFUSED_PREFIX} not-admitted: epoch mismatch (job {job}, admitted {admitted})")
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
    /// Submission critical section: held only across a job line's admission
    /// check plus its single `write()` call (`admit_and_write`), and by the
    /// stop's admission close. Never held across a read, flush, drain, pump
    /// wait or emit. Lock order: `command` → `submit` → `admitted_job`.
    pub(crate) submit: Mutex<()>,
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
            submit: Mutex::new(()),
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

    /// Pre-drain admission check, made while holding the command lock before
    /// any drain. NON-AUTHORITATIVE: it only spares a refused send the drain
    /// (so a refusal here consumes no reader bytes). The check that counts is the
    /// one inside `admit_and_write`. Emits `permit_granted` on success, after
    /// the `admitted_job` guard is released.
    pub(crate) fn try_permit_begin(&self, epoch: Option<u64>) -> Result<(), String> {
        self.check_admission(epoch)?;
        self.emit("permit_granted");
        Ok(())
    }

    /// The submission critical section. Takes `submit`, checks admission for
    /// `epoch`, and on success calls `write` (one `write_all` of the line
    /// bytes) before dropping `submit`. Returns the write's io result, or a
    /// `refused: not-admitted:` string with nothing written.
    ///
    /// The caller flushes AFTER this returns, outside the lock, and emits
    /// nothing while it is held. **Every job-epoch write goes through here.**
    ///
    /// Bound: the lock covers the line's `write_all`. Ordering never depends
    /// on line length; the hold is one port timeout (1000 ms) per partial
    /// write (buffered lines are capped at 127 bytes, per-line lines are
    /// uncapped but GRBL-sized, far below the driver buffer).
    pub(crate) fn admit_and_write(
        &self,
        epoch: u64,
        write: impl FnOnce() -> io::Result<()>,
    ) -> Result<io::Result<()>, String> {
        let _submit = self.submit.lock().unwrap_or_else(|e| e.into_inner());
        self.check_admission(Some(epoch))?;
        Ok(write())
    }

    /// Pre-lock fast-fail: phase + epoch, no generation capture. An
    /// optimisation only; the check inside `admit_and_write` is the one that
    /// counts. Emits `permit_prechecked` on success.
    pub(crate) fn permit_precheck(&self, epoch: u64) -> Result<(), String> {
        self.check_admission(Some(epoch))?;
        self.emit("permit_prechecked");
        Ok(())
    }

    /// Shared phase + epoch check. The `admitted_job` guard is dropped before
    /// returning, so callers may emit afterwards (no leaf under leaf).
    fn check_admission(&self, epoch: Option<u64>) -> Result<(), String> {
        let current_phase = self.phase.load(Ordering::SeqCst);
        if current_phase != PHASE_ACTIVE {
            return Err(refused_not_active(current_phase));
        }
        if let Some(ep) = epoch {
            let admitted = *self.admitted_job.lock().unwrap_or_else(|e| e.into_inner());
            if admitted != Some(ep) {
                return Err(refused_epoch_mismatch(ep, admitted));
            }
        }
        Ok(())
    }

    /// The stop's admission close: phase Stopping and `admitted_job` cleared.
    /// `_held` is the `submit` guard: the caller must HOLD `submit` across
    /// this call (not take-and-drop it as a barrier), or a writer could pass
    /// `check_admission` in the gap and write after the stop's `0x18`.
    pub(crate) fn close_admission(&self, _held: &std::sync::MutexGuard<'_, ()>) {
        #[cfg(test)]
        assert!(
            self.submit.try_lock().is_err(),
            "close_admission: submit must be held while admission closes"
        );
        let mut aj = self.admitted_job.lock().unwrap_or_else(|e| e.into_inner());
        self.phase.store(PHASE_STOPPING, Ordering::SeqCst);
        *aj = None;
    }

    /// Unconditional Idle store: connect ONLY. No stop path may call this.
    pub(crate) fn set_idle_on_connect(&self) {
        self.phase.store(PHASE_IDLE, Ordering::SeqCst);
    }

    /// The stop's confirmed transition: Stopping→Idle by CAS. Returns false
    /// (leaving the phase alone) if anything moved it off Stopping, e.g. a
    /// concurrent disconnect storing Disconnected.
    pub(crate) fn set_idle_from_stopping(&self) -> bool {
        self.phase
            .compare_exchange(
                PHASE_STOPPING,
                PHASE_IDLE,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
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
        // Invalidate snapshot: after disconnect + reconnect to a different
        // machine, stale position data must not be readable.
        self.invalidate_snapshot();
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
        if flag
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
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
            messages: vec![
                "STOP: 0x18 sent".to_string(),
                "STOP: unconfirmed — use the machine's physical stop. Beam state unqualified — verify visually.".to_string(),
            ],
        };
        let json = serde_json::to_string_pretty(&result).unwrap();
        let parsed: StopResult = serde_json::from_str(&json).unwrap();
        assert_eq!(result, parsed);
        assert!(
            json.contains("\"outcome\": \"submittedUnconfirmed\""),
            "json: {json}"
        );
        assert!(!json.contains("inFlightWrite"), "json: {json}");
        assert!(json.contains("\"epoch\": 3"), "json: {json}");
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

    /// U1 (kills M4): a refused `admit_and_write` never invokes the write.
    #[test]
    fn rf15_u1_admit_and_write_refuses_without_writing() {
        let session = SerialSession::default();
        // Stopping phase.
        session.phase.store(PHASE_STOPPING, Ordering::SeqCst);
        *session.admitted_job.lock().unwrap() = Some(1);
        let mut called = false;
        let r = session.admit_and_write(1, || {
            called = true;
            Ok(())
        });
        assert!(!called, "U1: write invoked while Stopping");
        assert!(r.unwrap_err().starts_with("refused: not-admitted:"));
        // Active, but admission closed (admitted_job None).
        session.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
        *session.admitted_job.lock().unwrap() = None;
        let mut called = false;
        let r = session.admit_and_write(1, || {
            called = true;
            Ok(())
        });
        assert!(!called, "U1: write invoked with admitted_job None");
        assert!(r.unwrap_err().starts_with("refused: not-admitted:"));
        // Positive sibling: admitted → the write runs and its result returns.
        *session.admitted_job.lock().unwrap() = Some(1);
        let mut called = false;
        let r = session.admit_and_write(1, || {
            called = true;
            Err(io::Error::other("boom"))
        });
        assert!(called, "U1: admitted write not invoked");
        assert_eq!(r.unwrap().unwrap_err().to_string(), "boom");
    }

    /// W1: `close_admission` closes admission only while `submit` is held.
    #[test]
    fn rf15_close_admission_under_submit() {
        let session = SerialSession::default();
        session.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
        *session.admitted_job.lock().unwrap() = Some(1);
        let held = session.submit.lock().unwrap();
        session.close_admission(&held);
        drop(held);
        assert_eq!(session.phase.load(Ordering::SeqCst), PHASE_STOPPING);
        assert!(session.admitted_job.lock().unwrap().is_none());
    }

    /// W1: a barrier-only take-and-drop of `submit` trips the held assertion.
    #[test]
    #[should_panic(expected = "submit must be held")]
    fn rf15_close_admission_panics_when_submit_not_held() {
        let session = SerialSession::default();
        drop(session.submit.lock().unwrap());
        let other = Mutex::new(());
        let not_submit = other.lock().unwrap();
        session.close_admission(&not_submit);
    }

    /// `admit_and_write` holds `submit` across the write (the closure cannot
    /// take it), and releases it afterwards.
    #[test]
    fn rf15_admit_and_write_holds_submit_during_write() {
        let session = SerialSession::default();
        session.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
        *session.admitted_job.lock().unwrap() = Some(1);
        let r = session.admit_and_write(1, || {
            assert!(session.submit.try_lock().is_err(), "submit not held");
            Ok(())
        });
        assert!(r.unwrap().is_ok());
        assert!(session.submit.try_lock().is_ok(), "submit not released");
    }

    #[test]
    fn rf15_refusal_strings_carry_prefix_and_name_phase() {
        let session = SerialSession::default();
        session.phase.store(PHASE_STOPPING, Ordering::SeqCst);
        let e = session.try_permit_begin(Some(1)).unwrap_err();
        assert_eq!(
            e,
            "refused: not-admitted: session not active (phase=stopping)"
        );
        assert!(e.starts_with(REFUSED_PREFIX));
        let e = session.permit_precheck(1).unwrap_err();
        assert_eq!(
            e,
            "refused: not-admitted: session not active (phase=stopping)"
        );

        session.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
        let e = session.try_permit_begin(Some(5)).unwrap_err();
        assert_eq!(
            e,
            "refused: not-admitted: epoch mismatch (job 5, admitted none)"
        );
        *session.admitted_job.lock().unwrap() = Some(3);
        let e = session.permit_precheck(5).unwrap_err();
        assert_eq!(
            e,
            "refused: not-admitted: epoch mismatch (job 5, admitted 3)"
        );
    }

    #[test]
    fn rf15_permit_granted_emitted_only_on_success() {
        let session = SerialSession::default();
        let events = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let ev = events.clone();
        *session.observer.lock().unwrap() = Some(Box::new(move |e: &str| {
            ev.lock().unwrap().push(e.to_string());
        }));
        session.phase.store(PHASE_IDLE, Ordering::SeqCst);
        assert!(session.try_permit_begin(Some(1)).is_err());
        assert!(session.permit_precheck(1).is_err());
        assert!(events.lock().unwrap().is_empty());

        session.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
        *session.admitted_job.lock().unwrap() = Some(1);
        assert!(session.permit_precheck(1).is_ok());
        assert!(session.try_permit_begin(Some(1)).is_ok());
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "permit_prechecked".to_string(),
                "permit_granted".to_string()
            ]
        );
    }

    #[test]
    fn rf15_set_idle_from_stopping_leaves_unknown() {
        let session = SerialSession::default();
        session.phase.store(PHASE_UNKNOWN, Ordering::SeqCst);
        assert!(!session.set_idle_from_stopping());
        assert_eq!(session.phase.load(Ordering::SeqCst), PHASE_UNKNOWN);
        session.phase.store(PHASE_STOPPING, Ordering::SeqCst);
        assert!(session.set_idle_from_stopping());
        assert_eq!(session.phase.load(Ordering::SeqCst), PHASE_IDLE);
    }

    #[test]
    fn default_phase_is_disconnected() {
        let session = SerialSession::default();
        assert_eq!(session.phase.load(Ordering::SeqCst), PHASE_DISCONNECTED);
        assert_eq!(session.epoch.load(Ordering::SeqCst), 0);
    }
}
