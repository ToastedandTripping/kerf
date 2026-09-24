# Fence — one stop, one reset (replace the in-flight re-send with a submission critical section)

> **Revision r1, 2026-09-24:** folds critic round 1 (`curried-pondering-honey-critic.md`, APPROVE WITH CHANGES; design sound, verification plan fixed):
> - must-fix 1: `$32=1` banner publication, and O3's real result
> - must-fix 2: unit-level killer for M4
> - must-fix 3: R8c rewritten through `SubmissionFailed`
> - must-fix 4: O4 uses the command-lock barrier
> - must-fix 5: O1 parked-state barrier
> - must-fix 6: batch waiver
> - must-fix 7: pin bound and premise, and `submit` added to A12
> - must-fix 8: residuals named, path fix, Razor grep hazard
>
> Target repo: kerf. Branch base: `marvin/session-8b2728` at 68b34b0 (contains the merged `kerf-fence-reopen` relay, 66c950a). On approval, this plan is copied to `.claude/plans/fence-single-reset.md` in the kerf worktree with its critic file beside it, and run as relay `kerf-fence-single-reset`.

## Context

Relay `kerf-fence-reopen` (RF-15) wired the admission fence to both production send paths. Razor passed it. It closes a race by detecting it and then repairing it:

1. A writer passes the permit check.
2. STOP closes admission and writes `0x18`.
3. The writer then writes its job line, which lands after the reset.
4. `try_permit_end` notices that the generation changed.
5. The writer re-sends a second `0x18` (`resend_reset_after_in_flight`).
6. If that re-send fails, a whole failure state follows: `resend_failed`, `mark_resend_failed`, phase Unknown, `refused: in-flight-unreset`, and TypeScript re-arming `jobRunning` to keep STOP live.

Razor's notes N2 (a wrong Confirmed message in one window) and N3 (a second `0x18` writer beside the one shared stop) are both consequences of this design. N3 would have needed a new standing ruling to explain it away.

**Lee, 2026-09-24:** "Let's figure out the right way to patch this and not try to design work around."

**Root cause.** Admission is decided in one step and the line is written in another, and STOP can land between them. Nothing orders "admission check + write" against "admission close + reset". The second reset repairs a race the design permits instead of making the race impossible.

**Intended outcome.** A job line is either written before STOP closes admission, and so sits ahead of the stop's single `0x18` in the port's output queue, or it is refused. One stop sends one reset. The in-flight state, the re-send, the re-send-failure state and their TypeScript branches are deleted.

## Intent (grilled)

**Skip note:** no grill. Intent comes from Lee's instruction above and the relay record.

- Make a job line landing after the stop's reset structurally impossible. Detecting it is not enough.
- Keep Lee's 2026-09-20 ruling intact: `0x18` immediately, with no feed hold, no M5 and no ack wait, and the write-failure retry retained. The stop waits on nothing that the machine or an acknowledgement controls.
- Keep "Every abort routes through one shared stop operation": `serial_stop_inner` becomes the only production writer of `0x18` for an abort again.
- Delete the machinery that existed only to repair the race. Anything that stays is behaviour that must stay.

## Why a lock does not violate "0x18 immediately"

The plan for `kerf-fence-reopen` rejected "a submission mutex the stop waits on, bounded at 250 ms". That mutex would have been held across the whole send, including the `tcdrain` flush that waits for bytes to leave the wire. This plan holds its lock across exactly two things: the admission check and one `write()` syscall. It does not cover the flush, the drain or the response wait.

Verified in the tree:

- **One output queue for both handles.** The realtime handle is `port.try_clone()` (`serial.rs:305`). In serialport 4.8.1, `try_clone_native` is `fcntl(F_DUPFD_CLOEXEC)` (`posix/tty.rs:392-393`). Both handles are therefore the same open tty and share one kernel output queue. The stop's `0x18` cannot reach the wire ahead of line bytes that are already queued, whatever the app does.
- **What `write()` waits on.** `TTYPort::write` polls for writability with the port's timeout and then calls `write(2)` (`posix/tty.rs:478-484`). It returns once the bytes are copied into the queue, not once they are transmitted.
- **Worst case.** The port timeout is 1000 ms (`serial.rs:377`). If the queue has room, the lock is held for microseconds. If the queue is full (the device is not draining), the stop's own `0x18` write blocks in the same poll on the same queue, so the lock adds no delay the kernel would not already impose. The one real difference is in a dead-port case: the stop can report `SubmissionFailed` up to about 1 s later. Stated, and accepted.

## Design

### New lock: `SerialSession::submit: Mutex<()>`

The `submit` lock is held only while a single write call is in progress.

- **Lock order:** `command` → `submit` → `admitted_job` (leaf).
  - Nothing takes `submit` while holding `realtime` or `admitted_job`.
  - `submit` is never held across a read, a flush, a drain, a pump wait, or an event emit to the observer.
  - Update the lock-order table in `serial.rs` (module doc) and in ARCHITECTURE.md "Serial Lock Order".
- **Poison handling:** every acquisition uses `unwrap_or_else(|e| e.into_inner())`, the same as the stop's other locks. A panicked writer can never stop STOP.

### Writer side: one helper, used by all three production job writes

`SerialSession::admit_and_write(epoch, write: impl FnOnce() -> io::Result<()>) -> Result<io::Result<()>, String>`:

1. Take `submit`.
2. `check_admission(Some(epoch))`. On failure, return the existing `refused: not-admitted:` string, having written nothing.
3. Call `write()`, which is one `write_all` of the line bytes.
4. Drop `submit`.
5. Return the write's io result.

The caller does the flush after the helper returns, outside the lock. Events are emitted after the lock is dropped.

The helper is used at three sites:

- **`serial_send_inner`** (per-line, `job_epoch: Some`):
  - Replace the write and flush and the `try_permit_end` block with `admit_and_write`, then flush.
  - `permit_precheck`, before the command lock, stays as the fast-fail.
  - `try_permit_begin`, under `command` before the drain, stays as the pre-drain refusal, so a refused send consumes no reader bytes. It is renamed or documented as non-authoritative, and it no longer returns a generation.
- **`serial_stream_job_inner`, the `$32=1` bracket:** the same shape. The whole `try_permit_end` / `mark_in_flight` / resend block is deleted.
- **`run_buffered_pump` Phase A:**
  - `SubmissionGate` becomes one method, `fn admit_write(&self, write: &mut dyn FnMut() -> io::Result<()>) -> Result<io::Result<()>, String>`.
  - `JobPermit` implements it with `admit_and_write`. `OpenGate` just calls `write`.
  - A refusal returns `BufferedPumpOutcome::Refused { line_index, reason }`, and the `in_flight` field is deleted.
  - The flush follows the helper, outside the lock.

`None`-epoch writes (console, `$H`, jog, settings, Test Fire) do not take `submit` and are unchanged. Phase policy for manual writes stays parked (ROADMAP Parking Lot, 1.x follow-up). See Residuals below.

**Premise of the bound (state it in the doc comment):** the lock covers one `write(2)` after `POLLOUT`, on a blocking fd (`tty.rs:177-178`). A job line is at most 127 bytes (the RX budget, `serial_pump.rs:553-565`), far smaller than the driver buffer, so "one write call" equals "one line", and the hold is bounded by the port timeout (1000 ms). If lines ever grew past the driver buffer, this premise would need revisiting.

### Also fixed: the `$32=1` pump publishes a banner it consumes (critic C3a, pre-existing hole)

In `serial_stream_job_inner`, after the `$32=1` `run_pump` returns, mirror `serial_send_inner`'s banner publication (`serial.rs`, the block after its `run_pump`). If the pump ended on Banner while `stop_in_flight` is set, store `banner_observed = true` and emit `banner_observed`, before returning `Err("$32=1 gate failed…")`.

Without this, a STOP landing during the `$32=1` exchange loses its banner to that pump, and the stop goes Unknown after 3 s. That happens today, and O3 depends on the fix.

### Stop side: `serial_stop_inner` Step 2

- Take `submit`, then `admitted_job`.
- Set phase Stopping and clear `admitted_job`.
- Release both, then continue exactly as today: `invalidate_snapshot`, `job_abort`, `banner_observed` clear, Step 5 `0x18` with retry-once, Step 6 banner wait.
- The `0x18` write is not under `submit`: once admission is closed, any later writer is refused under the lock, so ordering is already fixed.
- Delete from Step 2: the `in_flight_write_detected` and `resend_failed` clears and the `permit_generation` bump.

**Ordering argument (the whole fix).**

- A writer holding `submit` finishes its `write()` before the stop can close admission. Its bytes are in the queue before the stop's `0x18` is written. GRBL receives the line, then the reset, and the reset discards the RX buffer and the planner.
- A writer that takes `submit` after the stop released it sees Stopping, Unknown or Idle with `admitted_job == None`, and is refused with nothing written.
- No interleaving puts job bytes after the stop's `0x18`.

### Deletions (the workaround, in full)

**Rust:**

- `resend_reset_after_in_flight`
- `try_permit_end`
- `mark_in_flight`
- `mark_resend_failed`
- the fields `in_flight_write_detected`, `resend_failed` and `permit_generation`
- `refused_in_flight`, `refused_in_flight_unreset` and `PHYSICAL_STOP_AFTER_RESEND_FAILED`
- the `IN_FLIGHT_LINE` message
- the stop's result branch (a), the resend-failed branch
- `StopResult::SubmittedUnconfirmed.in_flight_write` (serde `inFlightWrite`). TS reads it only in `connection.test.ts:491`, a fixture.
- the `in_flight_refused` / `resend` handling in `serial_stream_job_inner`

**TS (`jobStream.ts handleRefusal`):**

- Delete the `in-flight-unreset` branch, including the `setJobRunning(true)` re-arm and the alarm.
- Delete the `in-flight` branch.
- `not-admitted` maps to `"cancelled"`, as today.
- `connection.ts`: keep the `disconnect()` tail clear of `jobRunning`, which is correct hygiene on its own terms. Rewrite its comment, which cites in-flight-unreset.

**Comment to rewrite:** the stop's CAS-false branch comment names `mark_resend_failed`. After the deletion, only a disconnect race reaches that branch, so rewrite the comment as well as the code.

**Kept, not deleted:**

- `set_idle_from_stopping` (CAS): it also fixes the latent Idle-over-Disconnected store (critic r3 A6).
- The `serial_job_end` CAS: Unknown is still reachable by a banner timeout.
- The refusal-contract prefix and `startsWith` discipline.
- RF-8 (buffered outcome defaults to `unknown`).
- RF-11.

### Result contract after the change

**Backend refusals** are only `refused: not-admitted: …`.

**Stop results:**

- `Confirmed`
- `SubmittedUnconfirmed`, when no banner arrives before the deadline
- `SubmissionFailed`, when both `0x18` attempts fail

A line written just before STOP behaves like the common case that already exists, where STOP lands during a line's response wait: the per-line pump sees the banner and returns, and the TS loop stops on `jobRunning`.

### Residuals (X1: what "structurally impossible" does and does not mean)

**The guarantee after this change:** no job-epoch byte is enqueued after admission closes, and the stop's `0x18` is enqueued after admission closes. So at most one already-admitted line precedes the reset on the wire, and nothing follows it.

1. **Inherent, unchanged.** That one preceding line can execute before the reset arrives. For an `M3 S…` line, that is about 3 ms of beam at wire speed. Beam state stays unqualified (DECISIONS 2026-09-10, status-only evidence).
2. **Parked, unchanged.** `None`-epoch writes are not phase-gated and can land after STOP: the console, Test Fire's `M3 S…`/`G4`/`M5` (`MachinePanel.tsx`), and settings. This is the Parking Lot's "phase policy for manual writes" item, and this plan does not close it.
3. **Control against regression.** A future job-write site added without `admit_and_write` would reopen the race. The doc invariant ("every job-epoch write goes through `admit_and_write`") and a Razor grep enforce it. The grep covers `write_all`, `write(` and `write_fmt` on the command channel, per relay.

## Files

| File | Change |
|---|---|
| `src-tauri/src/commands/serial_session.rs` | `submit` lock, `admit_and_write`, deletions, doc |
| `src-tauri/src/commands/serial.rs` | three call sites, stop Step 2, result branches, lock table, tests |
| `src-tauri/src/commands/serial_pump.rs` | `SubmissionGate::admit_write`, `Refused` without `in_flight`, Phase A |
| `src-tauri/src/sim/scripted_port.rs` | only if a test needs a hold inside `write()` that it lacks today (it has `hold_next_write`) |
| `src/lib/machine/jobStream.ts` | `handleRefusal` down to one branch |
| `src/lib/machine/connection.ts` | comment only |
| `src/lib/machine/__tests__/jobStream.test.ts`, `connection.test.ts` (the `inFlightWrite` fixture), `serialTraceHarness.ts` (the in-flight / in-flight-unreset model at about `:99-113`, `:331`) | remove in-flight tests and fixtures; harness model loses in-flight. `src/components/panels/__tests__/machineJobLoop.test.tsx` has no in-flight case and is expected untouched |
| `ARCHITECTURE.md` | lock table, "Admission fence" paragraph |
| `ROADMAP.md` | see "ROADMAP updates" below |

**ROADMAP updates:**

- In the RF-15 owner-test bullet, drop "Rust R4, R7, R8a and R8b are their only evidence" and name the new ordering tests.
- In the Parking Lot, close the N2 item with "(closed {date}, kerf-fence-single-reset: the re-send it described was removed)", keeping the detail entry.
- The A12 line: the re-send's copy of the `tcdrain` is gone, and the stop's own remains parked. Add that a wedged-but-present adapter (`POLLOUT` reported, URBs no longer completing) is the same pathology for the stop's `tcdrain` and for a writer parked in `write(2)` under `submit`. The lock does not widen that exposure, but both belong to the same parked item.

**Batch waiver:** 12 files, one subsystem root (the serial admission fence). Every file changes for one invariant: one stop, one reset, admission atomic with the write. Independence between files is not claimed, and splitting would ship an intermediate where the TS contract and the Rust refusals disagree.

**Out of scope, untouched:** `jobSession.ts`, `JobActionBar.tsx`, `MaterialTestDialog.tsx`, `lib.rs`, `sim/grbl.rs`, all G-code generators and golden files, and the stop's Step 5 `tcdrain` (A12, parked).

## Tests

**Rust, new (under `rf15::`, trace-ordered, ScriptedPort, no sleeps as barriers):**

- **O1, per-line.**
  - Setup: the writer is parked inside its `write()` (`hold_next_write(Writer, "line")`), and the stop is spawned.
  - Then `wait_until(stop_in_flight)`: `StopGuard::begin` sets it before Step 2, so the stop thread has provably entered and is waiting on `submit`.
  - Assert, while the hold is still parked: the trace has no `Write{Realtime,[0x18]}`, and `admission_closed` has not been emitted. Without the barrier these negatives could pass only because the stop thread had not run yet.
  - Release the hold.
  - Assert: the trace shows `Write{Writer,"G1 X5\n"}` before `Write{Realtime,[0x18]}`; there is no Writer write after the `0x18`; the send result is Ok or a banner-terminated pump; there is exactly one `0x18` in the trace.
  - This is today's R4 scenario with the opposite required outcome.
- **O2, buffered.** O1's shape on a Phase A line.
- **O3, `$32=1` bracket.**
  - O1's shape on the `$32=1` write.
  - Expected result, stated honestly: the stream returns `Err` beginning `$32=1 gate failed` (its pump read the banner instead of `ok`), and the stop returns `Confirmed` off the published banner, within the scenario deadline.
  - O3 depends on the `$32=1` banner-publication fix above.
- **O4, stop first.**
  - Setup: the writer is parked on the command lock, using R3's barrier shape. `drain_classified` is non-blocking by contract, so no hold point exists on the pre-drain read. The stop runs to completion, and then the command lock is released.
  - Assert: the writer is refused with `refused: not-admitted:`, zero Writer writes follow the `0x18`, and there is exactly one `0x18`.
  - Killer for M8 (below). It cannot reach M4, because the kept pre-drain `try_permit_begin` refuses first.
- **U1 and U2, unit tests (killers for M4).**
  - U1 is a `SerialSession` test beside `try_permit_begin_refuses_non_active`. It calls `admit_and_write(e, || { called = true; Ok(()) })` twice: with phase Stopping, and with phase Active and `admitted_job = None`. It asserts the closure was never invoked and the result starts `refused: not-admitted:`.
  - U2 is the same test through `JobPermit::admit_write`.
- **O5, one reset per stop.** Across all rf15 tests, a trace helper asserts at most one `0x18` per stop invocation. "Per stop invocation" means between consecutive `stop_requested` session events. Two-stop tests therefore count two stops and two resets.

**Rust, kept and adjusted:**

- Keep R1, R2, R3, R5, R6, `rf15_job_end_does_not_overwrite_unknown`, `rf15_second_stop_recovers_from_unknown` and RF-11. Adapt any that asserted the `in_flight` field or the generation.
- Delete R4, R7, R8a and R8b and their helpers (`r8b_resend_failure`, `last_writer_write_followed_by_reset` if it is left unused).
- **Rewrite R8c** (`rf15_second_stop_recovers_from_unknown`), because its current precondition `r8b_resend_failure` is deleted. The new version:
  1. Reaches Unknown through `SubmissionFailed`: `base.fail_writes_after(HandleRole::Realtime, 0)` makes both `0x18` attempts fail, and the phase goes to Unknown.
  2. Calls `clear_write_faults` and pushes a banner.
  3. Runs a second stop, which returns `Confirmed` and phase Idle.
  4. Checks that `serial_job_begin_inner` succeeds.
  
  This keeps the "Unknown is recoverable by a second STOP" evidence without the 3 s real-time banner timeout.

**TS:**

- Delete T4b(i)-(iv), T4c and any in-flight or in-flight-unreset cases.
- Keep T1, T2 (`not-admitted` → `cancelled`, nothing further sent) and T7.
- Add one assertion that a string beginning `refused: in-flight` (now unknown to the contract) is still never mapped to `complete` or `disconnected`: the default branch is `cancelled`, with no send. The default branch logs the whole string as its detail when the `not-admitted` regex does not match, which is acceptable.

**Mutation battery (`scripts/mutation-battery.mjs`, never hand-rolled).** Each mutant is named with the assertion expected to kill it:

| Mutant | Expected killer |
|---|---|
| M1: the writer skips `submit` (check and write outside the lock) | O1: `0x18` precedes the line, or appears while the hold is parked |
| M2: the stop closes admission without `submit` | O1 |
| M3: the stop takes `submit` *after* the `0x18` write | O1 |
| M4: `admit_and_write` checks admission after the write | U1 and U2: the closure was invoked when refused |
| M5: Phase A calls `write` outside `admit_write` | O2 |
| M6: the `$32=1` bracket calls `write` outside `admit_and_write` | O3 |
| M7: `handleRefusal` default returns `complete` | TS T2 |
| M8: both the pre-drain `try_permit_begin` and the check inside `admit_and_write` removed | O4: a Writer write after the `0x18` |
| M9: the `$32=1` banner publication removed | O3: the stop is not `Confirmed` within the deadline |

**Gates:** `cargo test`, clippy `-D warnings`, `cargo fmt --check`, `tsc`, eslint (0 errors), prettier, vitest, `npm run build`.

## Stress tests

**Pre-mortem.** It is three months out and this failed.

1. **STOP felt late on a stalled port.** A USB adapter wedged with the queue full, so the writer held `submit` in poll for 1 s and the stop reported `SubmissionFailed` about 2 s after the press instead of about 1 s. The laser's own state was the same either way, because the `0x18` could not have left sooner. Mitigation is the operator message that already exists ("use the machine's physical emergency stop"). If Lee wants tighter host latency, a bounded `try_lock` loop is the follow-up, not a second reset.
2. **Deadlock through a new nesting.** Some future path takes `submit` while holding `admitted_job` or `realtime`. The lock table and the doc invariant forbid it, and review checks it. The stop takes `submit` → `admitted_job` (leaf) only.
3. **The worst case for this project type, the laser fires after STOP.** A job line reaches the controller after the reset. Every production job-byte write goes through `admit_and_write`; O1-O4 pin the order; M1-M9 and U1-U2 prove the tests can see a regression. The residual risk is a new job-write site added later without the helper. The doc invariant says "every job-epoch write goes through `admit_and_write`", and Razor greps `write_all` in the three functions.

**Load-bearing assumptions.**

1. **Both handles share one kernel output queue, in FIFO order.** High confidence: verified `F_DUPFD_CLOEXEC` in serialport 4.8.1, one tty, and one driver write path on Linux and macOS. If wrong, a `0x18` could overtake queued line bytes, and the old design had the same exposure for any line queued before the stop.
2. **A GRBL reset discards bytes received ahead of it** (RX buffer flush and planner reset). This is the same assumption the 2026-09-20 ruling and the current re-send rely on. The vendor-fork caveat (DECISIONS 2026-09-05) applies to both designs equally. Status-only evidence (DECISIONS 2026-09-10) means the beam state is never claimed.
3. **`write()` returns on enqueue, not on transmit.** Verified: `TTYPort::write` is `poll` + `write(2)`, and the transmit wait is only in `flush` (`tcdrain`), which stays outside the lock.

**Inversion: what would have to be true for the detect-and-re-send design to win?** The writer's `write()` would have to be able to hold the lock long enough to delay a `0x18` that could otherwise reach the wire sooner. That requires the two handles to have independent output paths, and they do not (assumption 1). The condition is false in this tree.

## Standing decisions touched

- **2026-09-20, "Abort sends 0x18 immediately — no feed hold, no M5, no ack wait":** kept. No hold, no M5 and no ack wait are added, and the retry is kept. The stop waits for at most one in-progress `write(2)` enqueue, which the kernel would impose on its own `0x18` anyway.
- **2026-09-10 (amended 2026-09-22), "Every abort routes through one shared stop operation":** restored in full. `serial_stop_inner` is again the only abort-path writer of `0x18`.
- **Engineering pin, "never contain an ack-awaited write":** unaffected.
- **Proposed at relay close (for Lee, not auto-written):** an Engineering pin reading "Job-line admission and the job-line write are one critical section shared with the stop's admission close; the stop sends one reset and no path re-sends it." Its paragraph must state three things:
  - **the bound:** the stop waits for at most one `write(2)` after `POLLOUT`, at most the port timeout;
  - **the premise:** job lines are far smaller than the driver buffer, and both handles are one tty with one output queue;
  - **what it never waits on:** the controller, an acknowledgement, or transmission (`tcdrain` stays outside the lock).
  
  It closes with the reason: a future reader who sees the stop wait on a lock could read it as a breach of "0x18 immediately", and the reset could not reach the wire any sooner than those queued bytes anyway.

## Hardware note (owner test, after merge)

These are the same four steps already in ROADMAP `next`:

1. Stop mid-frame.
2. Frame again.
3. Run a full job on scrap.
4. While idle: `$$`, jog, home.

The fence's promise is now simpler, so no step changes. The in-flight path can no longer be triggered by anyone; O1-O4 are its evidence.

## Verification

1. **Relay worktree:** all gates listed under Tests, plus the battery journal with M1-M9 killed by the named assertions. Pre-shas must match the committed files.
2. **Razor review, concurrency-first:**
   - lock order and the table;
   - that `submit` is never held across a flush, read or emit;
   - that every job-epoch write site uses the helper (grep `write_all` in `serial_send_inner`, `serial_stream_job_inner` and `run_buffered_pump` Phase A);
   - that zero references remain to the deleted symbols. Grep the exact identifiers (`in_flight_write_detected`, `resend_failed`, `permit_generation`, `mark_in_flight`, `try_permit_end`, `resend_reset_after_in_flight`, `refused_in_flight`, `inFlightWrite`, `in-flight-unreset`). The token `in_flight` alone also matches `pump_in_flight`, `PumpFlight` and the pump's `InFlightLine` RX accounting, which are correct and stay;
   - the `$32=1` banner publication;
   - that the TS refusal contract has no in-flight branches;
   - that the out-of-scope files and goldens are byte-identical.
3. **Browser:** the dev server cannot reach `invoke`, so there is no in-browser check of the serial path. The owner hardware test above is the end-to-end check.
