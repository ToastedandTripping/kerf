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
//! epoch precondition. Single-flight: a second stop call while the first is
//! observing is a JOINER — it waits for the first to finish, returns
//! `last_stop`, and sends no byte at all. Anything that must put a second
//! `0x18` on the wire (the in-flight re-send) must therefore never route
//! through `serial_stop_inner`.
//!
//! ## Job-line admission (RF-15)
//!
//! Every job line carries the epoch of the admitted job. Both production send
//! paths (`serial_send` with `job_epoch`, and `serial_stream_job`, per line in
//! the buffered pump) run `permit_precheck` before waiting on the command lock
//! (a fast-fail optimisation only) and the authoritative `try_permit_begin`
//! while holding the command lock, before any drain or write. A refused line
//! returns a `refused:`-prefixed contract string and touches neither reader
//! nor writer.
//!
//! ### Ordering argument (post-write detection)
//!
//! **Assumption:** writes from the writer and realtime clones share one tty
//! output queue and land on the wire in syscall order (true for the Linux and
//! macOS tty layers). If this did not hold, the argument below would be
//! decorative.
//!
//! - The stop does: phase store → generation bump → `0x18`.
//! - The writer does, under the command lock: load g0 → load phase →
//!   write+flush → load g1.
//! - If the writer's phase load saw Active, its g0 load preceded the bump.
//!   A line that lands after the stop's `0x18` was written by a syscall after
//!   the `0x18` syscall, which follows the bump; g1 is loaded after the write,
//!   so g1 != g0 and the writer detects it. If g1 = g0 the write completed
//!   before the bump, and therefore before the `0x18`.
//! - False positive (harmless): `flush()` is `tcdrain`, so a line queued
//!   *before* the `0x18` whose drain returns after the bump is also reported
//!   in flight. The second `0x18` costs one extra reset and banner, hence
//!   the contract text "the line may have preceded the stop's reset".
//! - Only the stop bumps the generation, so the re-send can never reset an
//!   idle controller.
//! - On detection the writer drops the command lock and writes `0x18` once
//!   more on the realtime handle (`resend_reset_after_in_flight`, retry once).
//!   If both attempts fail it sets `resend_failed` and stores Unknown; the
//!   stop then refuses to confirm to Idle (its Idle transition is a CAS from
//!   Stopping) and reports the physical-stop instruction.
//! - **Guarantee:** every job line on the wire after the stop's `0x18` is
//!   followed either by a writer-issued `0x18`, or by Unknown plus a
//!   physical-stop instruction with admission closed.
//!
//! ### Two stale-mark orderings (expected, conservative)
//!
//! - A writer from stop S can mark `resend_failed` after a later stop S2 has
//!   cleared it in its Step 2. S2 then returns `SubmittedUnconfirmed` with the
//!   physical-stop line although its own reset succeeded; the operator presses
//!   STOP again.
//! - On the disconnect race the writer's Unknown store can land after
//!   `set_disconnected`, leaving phase Unknown while disconnected.
//!   `set_idle_on_connect` clears it, and connect performs a real reset.
//!
//! Ending a job (`serial_job_end`) moves Active→Idle only (CAS); it never
//! overwrites Unknown.

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

/// Refusal: the line was written as admission closed; the reset was re-sent.
pub(crate) fn refused_in_flight() -> String {
    format!(
        "{REFUSED_PREFIX} in-flight: line written as admission closed; reset re-sent after it (the line may have preceded the stop's reset)"
    )
}

/// Refusal: the line was written as admission closed and the re-send failed.
pub(crate) fn refused_in_flight_unreset(err: &str) -> String {
    format!(
        "{REFUSED_PREFIX} in-flight-unreset: line written as admission closed; reset re-send failed ({err}); use the machine's physical stop"
    )
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
    /// Set when a writer detected a job line written as admission closed.
    /// Cleared by the stop's Step 2.
    pub(crate) in_flight_write_detected: AtomicBool,
    /// Set when the in-flight reset re-send failed (both attempts). Forces the
    /// stop's result to `SubmittedUnconfirmed`. Cleared by the stop's Step 2.
    pub(crate) resend_failed: AtomicBool,
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
            in_flight_write_detected: AtomicBool::new(false),
            resend_failed: AtomicBool::new(false),
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

    /// Try to acquire a submission permit. Returns g0 if the session is
    /// active (and, with `Some(epoch)`, that epoch is the admitted job);
    /// otherwise a `refused: not-admitted:` contract string.
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
    /// This function performs steps 1-2 and must be called while holding the
    /// command lock, before any drain or write. The caller performs 4-5 via
    /// `try_permit_end`. Emits `permit_granted` on success, after the
    /// `admitted_job` guard is released.
    pub(crate) fn try_permit_begin(&self, epoch: Option<u64>) -> Result<u64, String> {
        let g0 = self.permit_generation.load(Ordering::SeqCst);
        self.check_admission(epoch)?;
        self.emit("permit_granted");
        Ok(g0)
    }

    /// Pre-lock fast-fail: phase + epoch, no generation capture. An
    /// optimisation only; the under-lock `try_permit_begin` is the check that
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

    /// Record that a job line was written as admission closed.
    pub(crate) fn mark_in_flight(&self) {
        self.in_flight_write_detected.store(true, Ordering::SeqCst);
    }

    /// Record that the in-flight reset re-send failed, then store Unknown
    /// with a plain store so Unknown wins over any later CAS to Idle.
    /// Never emits (it may run inside a test observer).
    pub(crate) fn mark_resend_failed(&self) {
        self.resend_failed.store(true, Ordering::SeqCst);
        self.phase.store(PHASE_UNKNOWN, Ordering::SeqCst);
    }

    /// Unconditional Idle store: connect ONLY. No stop path may call this.
    pub(crate) fn set_idle_on_connect(&self) {
        self.phase.store(PHASE_IDLE, Ordering::SeqCst);
    }

    /// The stop's confirmed transition: Stopping→Idle by CAS. Returns false
    /// (leaving the phase alone) if anything moved it off Stopping, e.g. a
    /// concurrent `mark_resend_failed` storing Unknown.
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
            in_flight_write: true,
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
        assert!(refused_in_flight().starts_with("refused: in-flight: "));
        assert!(refused_in_flight_unreset("boom").starts_with("refused: in-flight-unreset: "));
        assert!(refused_in_flight_unreset("boom").contains("(boom)"));
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
