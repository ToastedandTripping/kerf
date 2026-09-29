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
//! paths (`serial_send` with `job_epoch`, `serial_stream_job` per line in the
//! buffered pump) run `permit_precheck` before
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
//! - **Lock order:** `command` → `submit` → `trust` → {`admitted_job`,
//!   `snapshot`} (leaves; `admitted_job` may nest `snapshot` in
//!   `set_disconnected`), plus `realtime` → `trust` (connect install).
//!   Nothing takes `submit` while holding `realtime`, `trust` or a leaf.
//!   Every holder of `trust` releases it before any I/O. Every acquisition
//!   recovers from poison, so a panicked writer never stops STOP.
//!
//! ## Motion trust (relay kerf-safety-motion-trust, B1)
//!
//! `trust: Mutex<MotionTrust>` records what the native layer has SEEN, so a
//! later batch can admit a jog only from a clean home, a post-motion
//! observation, mm units and the current connection. B1 keeps the state and
//! never refuses anything:
//!
//! - `conn_id`: issued at connect install (under `command` + `realtime`),
//!   zeroed at disconnect (under `command`).
//! - `trust_epoch`: advanced by every position-invalidating event: a noted
//!   Banner, ALARM line or `<Alarm…>` frame on ANY read path (the `on_line`
//!   hook), STOP's `close_admission`, a raw `0x18`/`0x85` (bumped under
//!   `submit`), a `$H…` write, a frame-affecting settings write, `$RST=`, a
//!   motion send that fails after its write, connect and disconnect.
//! - `homed_at`: the epoch at which a plain `$H` returned `ok` with no
//!   invalidating line during its call.
//! - The motion ledger: `motion_pending` (RAII-counted motion sends, counted
//!   before the `command` wait) and `motion_writes` (bumped at each motion
//!   write, clearing `observed`). Job lines are motion.
//! - `observed`: the observation barrier's frame (`serial.rs`, run from the
//!   status poll), current only while connection, epoch and write count all
//!   still match and it was a literal Idle with a finite MPos.
//! - `units_mm`: the `conn_id` at which `$$` returned `$13=0`; cleared by any
//!   settings write, `$RST=`, a `$$` without it, and connect/disconnect.
//!
//! Ending a job (`serial_job_end`) moves Active→Idle only (CAS); it never
//! overwrites Unknown.

use serde::{Deserialize, Serialize};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use super::grbl_status::{GrblSnapshot, MachineState, PositionKind};
use super::serial_pump::LineClass;

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
    /// anything (lock-order table: leaf below `trust`, alongside
    /// admitted_job/last_stop/observer).
    pub(crate) snapshot: Mutex<Option<GrblSnapshot>>,
    /// Motion trust (see the module doc). Order: below `submit` and
    /// `realtime`, above the leaves. Never held across I/O. Take it only
    /// through `trust()`, which recovers poison.
    pub(crate) trust: Mutex<MotionTrust>,
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
            trust: Mutex::new(MotionTrust::default()),
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
        #[cfg(test)]
        let _rk = lock_rank::hold(lock_rank::SUBMIT, "submit");
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
            #[cfg(test)]
            let _rk = lock_rank::hold(lock_rank::ADMITTED_JOB, "admitted_job");
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
        // Motion trust: a STOP invalidates position, before its `0x18`.
        self.trust().bump();
        #[cfg(test)]
        let _rk = lock_rank::hold(lock_rank::ADMITTED_JOB, "admitted_job");
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
    ///
    /// Returns the parsed frame (published or not), so the observation
    /// barrier can build its observation from exactly the frame it read.
    pub(crate) fn publish_snapshot(&self, raw: &str, lock_epoch: u64) -> Option<GrblSnapshot> {
        let seq = self.snapshot_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let parsed = super::grbl_status::parse_status_frame(raw, lock_epoch, seq)?;
        #[cfg(test)]
        let _rk = lock_rank::hold(lock_rank::SNAPSHOT, "snapshot");
        let mut guard = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        // Monotonic: reject if epoch regressed or (same epoch, lower seq).
        if let Some(ref existing) = *guard {
            if lock_epoch < existing.epoch || (lock_epoch == existing.epoch && seq <= existing.seq)
            {
                return Some(parsed);
            }
        }
        *guard = Some(parsed.clone());
        Some(parsed)
    }

    /// Invalidate the snapshot (on stop or disconnect). The next reader sees None.
    pub(crate) fn invalidate_snapshot(&self) {
        #[cfg(test)]
        let _rk = lock_rank::hold(lock_rank::SNAPSHOT, "snapshot");
        let mut guard = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }

    /// Read the current snapshot (if any). Returns a clone.
    ///
    /// The trust fields (`connId`, `trustEpoch`, `homed`, `unitsMm`,
    /// `motionPending`, `observedSeq`, `observedPos`, and `units`) are
    /// overlaid from the CURRENT trust state at read time, so every reader
    /// sees trust as it is now, not as it was when the frame arrived.
    pub(crate) fn read_snapshot(&self) -> Option<GrblSnapshot> {
        let view = self.trust_view();
        #[cfg(test)]
        let _rk = lock_rank::hold(lock_rank::SNAPSHOT, "snapshot");
        let guard = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        guard.clone().map(|mut s| {
            view.apply(&mut s);
            s
        })
    }

    /// Transition to disconnected phase and reset state.
    pub(crate) fn set_disconnected(&self) {
        self.phase.store(PHASE_DISCONNECTED, Ordering::SeqCst);
        // Clear admitted job
        #[cfg(test)]
        let _rk = lock_rank::hold(lock_rank::ADMITTED_JOB, "admitted_job");
        let mut aj = self.admitted_job.lock().unwrap_or_else(|e| e.into_inner());
        *aj = None;
        // Invalidate snapshot: after disconnect + reconnect to a different
        // machine, stale position data must not be readable.
        self.invalidate_snapshot();
    }
}

// ---------------------------------------------------------------------------
// Motion trust (relay kerf-safety-motion-trust, B1): state, ledger, units,
// observation and the outbound grammar. B1 records; it never refuses.
// ---------------------------------------------------------------------------

/// Quiesce before the observation barrier's drain: the barrier waits until
/// this long after the last motion send returned. A hardware-qualified
/// parameter (owner card step 4): the assumption is that the owner's
/// controller starts a cycle within this window of the motion's `ok`.
pub(crate) const OBSERVE_QUIESCE_MS: u64 = 150;

/// Bound on the barrier's probe read: the first status frame after its `?`.
pub(crate) const OBSERVE_PROBE_MS: u64 = 500;

/// One barrier observation: the status frame read after the barrier's own
/// probe, with the trust basis captured when the barrier began.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Observation {
    pub(crate) conn_id: u64,
    pub(crate) trust_epoch: u64,
    pub(crate) after_writes: u64,
    /// The frame's snapshot `seq`.
    pub(crate) seq: u64,
    /// Literal `Idle` with a finite MPos.
    pub(crate) idle_mpos: bool,
    /// The frame's MPos when `idle_mpos`.
    pub(crate) mpos: Option<[f64; 3]>,
}

/// Native motion-trust state. See the module doc.
#[derive(Debug, Default)]
pub(crate) struct MotionTrust {
    /// Current connection; 0 = disconnected.
    pub(crate) conn_id: u64,
    /// Advances on every position-invalidating event.
    pub(crate) trust_epoch: u64,
    /// `trust_epoch` at which a clean `$H` completed.
    pub(crate) homed_at: Option<u64>,
    /// Motion sends (jog, `$H`, console motion, job lines) entered and not
    /// returned.
    pub(crate) motion_pending: u32,
    /// Motion writes made (bumped at write).
    pub(crate) motion_writes: u64,
    /// The latest barrier observation.
    pub(crate) observed: Option<Observation>,
    /// `conn_id` at which `$13=0` was read.
    pub(crate) units_mm: Option<u64>,
    /// Last connection id issued (ids start at 1).
    pub(crate) last_conn_id: u64,
    /// When the last motion send returned (the barrier's quiesce anchor).
    pub(crate) last_motion_end: Option<Instant>,
}

impl MotionTrust {
    pub(crate) fn bump(&mut self) {
        self.trust_epoch += 1;
    }

    pub(crate) fn homed(&self) -> bool {
        self.homed_at == Some(self.trust_epoch)
    }

    /// The observation, if it is still current: same connection, same
    /// epoch, no motion write since, and a literal Idle with MPos.
    pub(crate) fn current_observation(&self) -> Option<Observation> {
        self.observed.filter(|o| {
            o.conn_id == self.conn_id
                && o.trust_epoch == self.trust_epoch
                && o.after_writes == self.motion_writes
                && o.idle_mpos
        })
    }

    fn reset_for_connection(&mut self, conn_id: u64) {
        self.conn_id = conn_id;
        self.bump();
        self.homed_at = None;
        self.observed = None;
        self.units_mm = None;
    }
}

/// Trust as serialised onto a snapshot (and read by tests).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct TrustView {
    pub(crate) conn_id: u64,
    pub(crate) trust_epoch: u64,
    pub(crate) homed: bool,
    pub(crate) units_mm: bool,
    pub(crate) motion_pending: bool,
    pub(crate) observed_seq: Option<u64>,
    pub(crate) observed_pos: Option<[f64; 3]>,
}

impl TrustView {
    pub(crate) fn apply(&self, s: &mut GrblSnapshot) {
        s.conn_id = self.conn_id;
        s.trust_epoch = self.trust_epoch;
        s.homed = self.homed;
        s.units_mm = self.units_mm;
        s.motion_pending = self.motion_pending;
        s.observed_seq = self.observed_seq;
        s.observed_pos = self.observed_pos;
        // Kerf refuses rather than converts: `Inches` is never set.
        s.units = if self.units_mm {
            super::grbl_status::UnitsValidity::Mm
        } else {
            super::grbl_status::UnitsValidity::Unknown
        };
    }
}

/// The barrier's basis, captured when it begins (before its drain).
#[derive(Debug, Clone, Copy)]
pub(crate) struct BarrierBasis {
    pub(crate) conn_id: u64,
    pub(crate) trust_epoch: u64,
    pub(crate) motion_writes: u64,
    pub(crate) last_motion_end: Option<Instant>,
}

/// `trust` guard: poison-recovering, rank-tracked in tests.
pub(crate) struct TrustGuard<'a> {
    g: MutexGuard<'a, MotionTrust>,
    #[cfg(test)]
    _rank: lock_rank::Token,
}

impl std::ops::Deref for TrustGuard<'_> {
    type Target = MotionTrust;
    fn deref(&self) -> &MotionTrust {
        &self.g
    }
}

impl std::ops::DerefMut for TrustGuard<'_> {
    fn deref_mut(&mut self) -> &mut MotionTrust {
        &mut self.g
    }
}

/// RAII count of one motion send in the ledger. Constructed before the
/// `command` wait; dropping it (every return path, panics included)
/// decrements `motion_pending` and stamps the quiesce anchor.
pub(crate) struct MotionGuard<'a> {
    session: &'a SerialSession,
}

impl Drop for MotionGuard<'_> {
    fn drop(&mut self) {
        let mut t = self.session.trust();
        t.motion_pending = t.motion_pending.saturating_sub(1);
        t.last_motion_end = Some(Instant::now());
    }
}

/// What a write did to trust, kept by the send for its after-pump step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WriteNote {
    /// `Some(h)`: a plain `$H` was written at epoch `h`.
    pub(crate) home_at: Option<u64>,
    /// The line counted as a motion write.
    pub(crate) motion: bool,
}

/// Frame-affecting settings keys: a write to one invalidates position
/// (direction, report units, limits/homing, steps/mm, max rate, accel,
/// travel).
pub(crate) fn frame_affecting_key(key: u32) -> bool {
    matches!(key, 3 | 13 | 20..=27 | 100..=102 | 110..=112 | 120..=122 | 130..=132)
}

/// True when a `<…>` status frame's state field is `Alarm`.
fn status_is_alarm(line: &str) -> bool {
    line.strip_prefix('<')
        .map(|rest| {
            let state = rest.split(['|', '>']).next().unwrap_or("");
            state == "Alarm" || state.starts_with("Alarm:")
        })
        .unwrap_or(false)
}

impl SerialSession {
    /// The `trust` lock. Poison is recovered, so a panicked holder can never
    /// block STOP. Never hold it across I/O.
    pub(crate) fn trust(&self) -> TrustGuard<'_> {
        #[cfg(test)]
        let rank = lock_rank::hold(lock_rank::TRUST, "trust");
        let g = self.trust.lock().unwrap_or_else(|e| e.into_inner());
        TrustGuard {
            g,
            #[cfg(test)]
            _rank: rank,
        }
    }

    /// The `on_line` hook body: every line any native read path extracts.
    /// A Banner, an ALARM line, or a `<Alarm…>` status frame advances the
    /// trust epoch (revoking homed and any observation).
    pub(crate) fn trust_note_line(&self, line: &str, class: LineClass) {
        let invalidates = match class {
            LineClass::Banner | LineClass::Alarm => true,
            LineClass::Status => status_is_alarm(line),
            _ => false,
        };
        if invalidates {
            self.trust().bump();
        }
    }

    /// Advance the trust epoch (STOP's admission close, a raw reset/cancel).
    pub(crate) fn trust_bump(&self) {
        self.trust().bump();
    }

    /// Connect install (caller holds `command` + `realtime`): a new
    /// connection id and a fresh, untrusted state.
    pub(crate) fn trust_on_connect(&self) -> u64 {
        let mut t = self.trust();
        t.last_conn_id += 1;
        let c = t.last_conn_id;
        t.reset_for_connection(c);
        c
    }

    /// Disconnect teardown (caller holds `command`).
    pub(crate) fn trust_on_disconnect(&self) {
        self.trust().reset_for_connection(0);
    }

    /// Count one motion send into the ledger. Call after classification and
    /// BEFORE the `command` wait, so sends queued on `command` all count.
    pub(crate) fn motion_enter(&self) -> MotionGuard<'_> {
        self.trust().motion_pending += 1;
        MotionGuard { session: self }
    }

    /// Record a line about to be written. `class` is `None` for a payload
    /// the grammar calls malformed (B1 still writes it, so it is treated as
    /// the worst case: motion, invalidating, units cleared). `job_line`
    /// marks a job line, which is always motion.
    pub(crate) fn trust_note_write(&self, class: Option<Outbound>, job_line: bool) -> WriteNote {
        let mut t = self.trust();
        let motion = job_line || class.is_none_or(|c| c.is_motion());
        if motion {
            t.motion_writes += 1;
            t.observed = None;
        }
        let mut home_at = None;
        match class {
            Some(Outbound::Home) => {
                t.bump();
                home_at = Some(t.trust_epoch);
            }
            Some(Outbound::HomeAxis) => t.bump(),
            Some(Outbound::SettingsWrite { key, startup }) => {
                if !startup && frame_affecting_key(key) {
                    t.bump();
                }
                t.units_mm = None;
            }
            Some(Outbound::Reset) | None => {
                t.bump();
                t.units_mm = None;
            }
            _ => {}
        }
        WriteNote { home_at, motion }
    }

    /// A plain `$H` written at epoch `h` returned: grant only on a terminal
    /// `ok` with the epoch unchanged since the write.
    pub(crate) fn trust_note_home(&self, h: u64, ok_terminal: bool) {
        let mut t = self.trust();
        if ok_terminal && t.trust_epoch == h {
            t.homed_at = Some(h);
        }
    }

    /// A `$$` returned. `lines` is `Some` only for a pump that returned `Ok`
    /// with a terminal `ok`. Units become mm only for a `$13=0` reply line
    /// with no `$13=` line of another value, on the current connection.
    pub(crate) fn trust_note_settings_read(&self, lines: Option<&[String]>) {
        let mm = lines.is_some_and(|ls| {
            let mut zero = false;
            for l in ls {
                if let Some(v) = l.trim().strip_prefix("$13=") {
                    if v.trim() == "0" {
                        zero = true;
                    } else {
                        return false;
                    }
                }
            }
            zero
        });
        let mut t = self.trust();
        t.units_mm = if mm && t.conn_id != 0 {
            Some(t.conn_id)
        } else {
            None
        };
    }

    /// A motion send's pump returned (caller still holds `command`): stamp
    /// the barrier's quiesce anchor before `command` is released, so a
    /// barrier that takes `command` next cannot see an older anchor.
    pub(crate) fn trust_note_motion_end(&self) {
        self.trust().last_motion_end = Some(Instant::now());
    }

    /// A motion send failed after its write (I/O, flush, missing terminal):
    /// position unknown.
    pub(crate) fn trust_note_motion_failure(&self) {
        self.trust().bump();
    }

    /// A job was admitted (caller holds `submit`): any observation predates it.
    pub(crate) fn trust_note_job_admitted(&self) {
        self.trust().observed = None;
    }

    /// True when the observation is not current (barrier needed).
    pub(crate) fn observation_stale(&self) -> bool {
        self.trust().current_observation().is_none()
    }

    /// Capture the barrier's basis, before its drain.
    pub(crate) fn barrier_basis(&self) -> BarrierBasis {
        let t = self.trust();
        BarrierBasis {
            conn_id: t.conn_id,
            trust_epoch: t.trust_epoch,
            motion_writes: t.motion_writes,
            last_motion_end: t.last_motion_end,
        }
    }

    /// Store the barrier's observation of `frame` against the basis captured
    /// at its start. Anything that moved during the barrier leaves it stale.
    pub(crate) fn record_observation(&self, basis: BarrierBasis, frame: &GrblSnapshot) {
        let idle_mpos = frame.state == MachineState::Idle
            && frame.position_kind == Some(PositionKind::MPos)
            && frame
                .position
                .is_some_and(|p| p.iter().all(|v| v.is_finite()));
        let o = Observation {
            conn_id: basis.conn_id,
            trust_epoch: basis.trust_epoch,
            after_writes: basis.motion_writes,
            seq: frame.seq,
            idle_mpos,
            mpos: if idle_mpos { frame.position } else { None },
        };
        self.trust().observed = Some(o);
    }

    /// The trust fields as a snapshot carries them.
    pub(crate) fn trust_view(&self) -> TrustView {
        let t = self.trust();
        let cur = t.current_observation();
        TrustView {
            conn_id: t.conn_id,
            trust_epoch: t.trust_epoch,
            homed: t.homed(),
            units_mm: t.units_mm.is_some() && t.units_mm == Some(t.conn_id),
            motion_pending: t.motion_pending > 0,
            observed_seq: cur.map(|o| o.seq),
            observed_pos: cur.and_then(|o| o.mpos),
        }
    }
}

// ---------------------------------------------------------------------------
// The outbound command grammar (`classify_outbound`). B1 is classify-only:
// the result drives trust bookkeeping; nothing is refused.
// ---------------------------------------------------------------------------

/// Classification of one outbound command line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outbound {
    /// `$J=…`
    Jog,
    /// Exactly `$H`.
    Home,
    /// `$H…` other than `$H` (single-axis homing).
    HomeAxis,
    /// `$<n>=…` (`startup: false`) or `$N<n>=…` (`startup: true`, a stored
    /// startup line run after every reset). `key` is `u32::MAX` if `n`
    /// does not fit.
    SettingsWrite {
        key: u32,
        startup: bool,
    },
    /// `$$`
    SettingsRead,
    /// `$RST=…`
    Reset,
    /// G-code with an axis word, or `G28`/`G30`/`G38`.
    Motion,
    Other,
}

impl Outbound {
    pub(crate) fn is_motion(self) -> bool {
        matches!(
            self,
            Outbound::Jog | Outbound::Home | Outbound::HomeAxis | Outbound::Motion
        )
    }
}

/// Normalise as GRBL 1.1's line reader does before executing a line (and as
/// `normalizeGrblLine` does in `connection.ts`): drop `(…)` comments (an
/// unclosed `(` runs to the end), cut at `;`, delete every byte `<= 0x20`
/// and every `/`, upper-case.
pub(crate) fn normalize_grbl_line(cmd: &str) -> String {
    let mut no_parens = String::with_capacity(cmd.len());
    let mut in_comment = false;
    for ch in cmd.chars() {
        if in_comment {
            if ch == ')' {
                in_comment = false;
            }
        } else if ch == '(' {
            in_comment = true;
        } else {
            no_parens.push(ch);
        }
    }
    let code = no_parens.split(';').next().unwrap_or("");
    code.chars()
        .filter(|&c| c as u32 > 0x20 && c != '/')
        .collect::<String>()
        .to_ascii_uppercase()
}

/// `$<digits>=` → the key; `None` if the shape does not match.
fn settings_key(after_dollar: &str) -> Option<u32> {
    let digits: String = after_dollar
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() || !after_dollar[digits.len()..].starts_with('=') {
        return None;
    }
    Some(digits.parse::<u32>().unwrap_or(u32::MAX))
}

/// Motion rule for normalised G-code (ported from S3c's `isMotionCommand`):
/// an axis word (`[XYZABC][-+]?[.0-9]`), or `G` + zeros + `28`/`30`/`38`
/// not followed by a digit (`G28`, `G30`, `G38.2`; not `G280`).
fn is_motion_gcode(n: &str) -> bool {
    let b = n.as_bytes();
    for i in 0..b.len() {
        match b[i] {
            b'X' | b'Y' | b'Z' | b'A' | b'B' | b'C' => {
                let mut j = i + 1;
                if j < b.len() && (b[j] == b'-' || b[j] == b'+') {
                    j += 1;
                }
                if j < b.len() && (b[j] == b'.' || b[j].is_ascii_digit()) {
                    return true;
                }
            }
            b'G' => {
                let mut j = i + 1;
                while j < b.len() && b[j] == b'0' {
                    j += 1;
                }
                if j + 1 < b.len() {
                    let two = &b[j..j + 2];
                    if (two == b"28" || two == b"30" || two == b"38")
                        && !(j + 2 < b.len() && b[j + 2].is_ascii_digit())
                    {
                        return true;
                    }
                }
            }
            _ => {}
        }
    }
    false
}

/// The one outbound command grammar. `Err` is a malformed payload: a line
/// delimiter, a control byte, a non-ASCII byte, or a realtime character
/// (`?`, `!`, `~`), any of which makes the line mean something different to
/// GRBL than to a prefix check. In B1 an `Err` is NOT refused (the caller
/// still writes it and records it as the worst case); the `malformed`
/// refusal is B2+B3.
pub(crate) fn classify_outbound(cmd: &str) -> Result<Outbound, String> {
    for b in cmd.bytes() {
        let why = match b {
            b'\r' | b'\n' => Some("line delimiter"),
            0x00..=0x1f => Some("control byte"),
            0x7f..=0xff => Some("non-ASCII byte"),
            b'?' | b'!' | b'~' => Some("realtime character"),
            _ => None,
        };
        if let Some(why) = why {
            return Err(format!("{REFUSED_PREFIX} malformed: {why} (0x{b:02x})"));
        }
    }
    let n = normalize_grbl_line(cmd);
    let class = if n.starts_with("$J=") {
        Outbound::Jog
    } else if n == "$H" {
        Outbound::Home
    } else if n.starts_with("$H") {
        Outbound::HomeAxis
    } else if n.starts_with("$RST=") {
        Outbound::Reset
    } else if n == "$$" {
        Outbound::SettingsRead
    } else if let Some(rest) = n.strip_prefix("$N") {
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if rest[digits..].starts_with('=') {
            Outbound::SettingsWrite {
                key: rest[..digits].parse::<u32>().unwrap_or(u32::MAX),
                startup: true,
            }
        } else {
            Outbound::Other
        }
    } else if let Some(key) = n.strip_prefix('$').and_then(settings_key) {
        Outbound::SettingsWrite {
            key,
            startup: false,
        }
    } else if n.starts_with('$') {
        Outbound::Other
    } else if is_motion_gcode(&n) {
        Outbound::Motion
    } else {
        Outbound::Other
    };
    Ok(class)
}

// ---------------------------------------------------------------------------
// Lock-rank tracker (tests only, N13): a thread-local stack of held ranks.
// A blocking acquisition must rank strictly above everything this thread
// holds; an inversion panics. `try_lock` holds are recorded, not checked.
// ---------------------------------------------------------------------------
#[cfg(test)]
pub(crate) mod lock_rank {
    use std::cell::RefCell;

    pub(crate) const COMMAND: u8 = 1;
    pub(crate) const SUBMIT: u8 = 2;
    pub(crate) const REALTIME: u8 = 3;
    pub(crate) const TRUST: u8 = 4;
    pub(crate) const ADMITTED_JOB: u8 = 5;
    pub(crate) const SNAPSHOT: u8 = 6;

    thread_local! {
        static HELD: RefCell<Vec<(u8, &'static str)>> = const { RefCell::new(Vec::new()) };
    }

    pub(crate) struct Token {
        rank: u8,
    }

    /// A blocking acquisition of `name` at `rank`.
    pub(crate) fn hold(rank: u8, name: &'static str) -> Token {
        HELD.with(|h| {
            let h = &mut *h.borrow_mut();
            if let Some(&(r, n)) = h.iter().find(|(r, _)| *r >= rank) {
                panic!("lock-order inversion: taking {name} (rank {rank}) while holding {n} (rank {r}); held: {h:?}");
            }
            h.push((rank, name));
        });
        Token { rank }
    }

    /// A `try_lock` acquisition: recorded (so nested takes are checked
    /// against it), never checked itself (it cannot wait).
    pub(crate) fn hold_try(rank: u8, name: &'static str) -> Token {
        HELD.with(|h| h.borrow_mut().push((rank, name)));
        Token { rank }
    }

    /// Ranks this thread currently holds.
    #[allow(dead_code)]
    pub(crate) fn held() -> Vec<u8> {
        HELD.with(|h| h.borrow().iter().map(|(r, _)| *r).collect())
    }

    impl Drop for Token {
        fn drop(&mut self) {
            HELD.with(|h| {
                let h = &mut *h.borrow_mut();
                if let Some(i) = h.iter().rposition(|(r, _)| *r == self.rank) {
                    h.remove(i);
                }
            });
        }
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
