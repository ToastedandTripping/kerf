# Fence Wiring — Batch 1.1 Reopen (RF-15)

> **Revision r1, 2026-09-24.** This revision folds critic round 1 (`fence-wiring-1.1-reopen-critic.md`, APPROVE WITH CHANGES). It closes B1: when the reset re-send fails, admission stays closed even if the stop's own banner arrives, and the TS mapping keeps STOP live. It also folds advisories A1 through A12, states R2's red-today reason, and adds the pre-mortem #2 negative control.
>
> **Revision r2, 2026-09-24.** This revision folds critic round 2 (`fence-wiring-1.1-reopen-critic.md`, APPROVE WITH CHANGES; round 1 is now `-critic-r1.md`).
>
> - **B1-r2.** Every TS stop clears `jobRunning` before calling `emergencyStop`. Mapping `in-flight-unreset` to `"unknown"` therefore cannot keep STOP live on its own. The branch now re-arms `jobRunning` explicitly, guarded on `machineConnected`, and names disconnect/reconnect as the fallback. T4b runs in the production STOP order, and T4c proves that a second STOP recovers the machine.
> - **Revision r3, 2026-09-24.** Critic round 3 returned APPROVE WITH CHANGES with nothing blocking; the plan has converged. This revision folds five advisory items:
>   - R8c: a second STOP recovers from Unknown, proven in Rust.
>   - A tail clear of `jobRunning` in `disconnect()`, with test T4b(iii-b).
>   - T4b(iv) now asserts zero `serial_stop`.
>   - The `$X`/`ALARM:3` disarm is named in the Parking Lot and in ARCHITECTURE.
>   - Keep-awake wording, in-flight refusals recording `wrote: true`, `messages: []` in the fixture, and the relay-log note on the Idle-over-Disconnected fix.
> - **Advisories.** A1: `serial_job_end` becomes a CAS, and branch (b) keeps the epoch-then-idle order. A2: R2 gets a decoy. A7: the `stop_confirming` position is pinned. A5/LB-5: the counting and recording rules are stated. A3, A4, A6, A8 and A9 are folded.

## Intent (grilled)

**Summary:** Once STOP has closed a job, no line from that job reaches the laser. The backend now enforces this on both production send paths; today the per-line loop's `jobRunning` check is the only guard.

- Every job line carries the epoch of the job that was admitted.
- The backend checks that epoch while it holds the command lock, immediately before the write, in both per-line and buffered modes.
- A line refused this way comes back to TypeScript as a distinct refusal. A refusal is never read as "complete" or "disconnected", and it never causes TypeScript to send anything else.
- A line that was already being written when STOP landed is caught after the write. The backend then sends one more realtime reset, so the controller is reset again after that line.
- If that extra reset cannot be sent, admission stays closed, the operator is told to use the physical stop, and the STOP button stays live.
- Console commands, `$H`, jog and settings writes behave as they do today.

**Skip note:** Derived from RF-15 and Lee's 2026-09-22 ruling to fix it next. No grill session was held. RF-15 is in `~/marvin/state/audits/kerf-astra-2026-09-08/PLAN.md` (addendum table). Batch 1.1 and the "Relay verification contract" are in the same file.

**Key decisions:**

- **Per-line granularity in the buffered pump, not per-window.** Reasons, from the pump's structure (`serial_pump.rs:542-586`):
  - Phase A is a `while` loop that writes one line per iteration and already checks `job_abort` once per line (`:543`). A permit check fits at the same point with no restructuring.
  - A "window" is not a code unit. It is simply wherever the loop happens to `break` on budget.
  - A per-window check would let a whole RX window go out on one stale check. That is 4-8 lines at today's 127-byte budget. The owner's controller advertises a 65536-byte RX buffer (DECISIONS 2026-09-05), so the budget is a knob someone will raise.
  - A per-line post-write check tells us exactly which line was in flight.
  - Cost per line is two SeqCst loads and one leaf mutex, microseconds against about 2.6 ms of wire time for a 30-byte line at 115200 baud.

- **The authoritative permit check moves under the command lock, before the pre-write drain and before `PumpFlight`. A cheap pre-lock fast-fail stays beside it (critic A4).**
  - Today the only check runs before the lock wait (`serial.rs:458`; the lock is taken at `:464`).
  - The stop's own banner read `try_lock`s the command lock (`serial.rs:1017`). So a producer that has already passed the check can sit on the lock through the entire stop, write after the `0x18`, and only afterwards report "permit expired" (`:498`).
  - The under-lock check turns that common case from detection into prevention. It also means a refused send consumes no reader bytes, so it cannot eat the reset banner the stop is waiting for.
  - The pre-lock check (`permit_precheck`: phase and epoch, no generation capture) refuses an obviously stale send without parking a blocking-pool thread behind a minutes-long buffered pump. It is an optimisation only. The under-lock check is the one that counts.

- **The residual race gets one more realtime `0x18` from the backend, never an M5 and never an ack-awaited write.**
  - The race: the stop closes admission between the writer's under-lock check and its write syscall. This window lasts microseconds. Closing it would require the stop to wait on a writer, which the 2026-09-20 ruling forbids ("0x18 immediately").
  - The post-write generation check (`try_permit_end`) catches every line that could have landed after the stop's `0x18`. F1 gives the ordering argument, and states its tty assumption.
  - On detection the writer drops the command lock and writes `0x18` once more on the realtime handle, retrying once as the A6 fix does. The controller is therefore reset again after the stale line.
  - The critic confirmed this is inside the 2026-09-20 ruling. It is the same realtime byte, with no hold, no M5 and no ack wait, and PLAN 1.1 already required it ("ensure reset is ordered after it or mark submission unconfirmed"). No new ruling is needed.
  - The DECISIONS pin that protects it is proposed for the relay log. Wording is in Files → Out of scope (critic A1).
  - Rejected alternative 1: a submission mutex the stop waits on, bounded at 250 ms as PLAN 1.1 suggested. It delays the `0x18` and conflicts with the ruling.
  - Rejected alternative 2: mark the phase Unknown and do nothing else. GRBL accepts lines immediately after the banner, and RF-1 shows the generators emit a standalone `M3`.

- **A failed re-send closes admission against every later Idle store (critic B1).**
  - `resend_reset_after_in_flight` sets `resend_failed` and stores Unknown if both of its `0x18` attempts fail.
  - `serial_stop_inner` honours the flag when it builds its result. It skips the Idle transition and returns `SubmittedUnconfirmed`, even if it observed a banner.
  - The stop's Idle transition becomes a compare-and-swap from Stopping, so a late Idle can no longer overwrite Unknown from either side.
  - `serial_job_end_inner` also becomes a CAS, from Active to Idle. This means no unconditional Idle store remains on any path next to the stop (critic r2 A1).
  - TypeScript maps `refused: in-flight-unreset` to endState `"unknown"`, not `"cancelled"`, and sets `machineState` to alarm.
  - **The mapping alone does not keep STOP live** (critic r2 B1-r2). Every production stop (`JobActionBar.tsx:115-117`, `jobStream.ts:42-43`, `connection.ts:240-242`) calls `setJobRunning(false)` *before* `emergencyStop()`. The refusal therefore always arrives with `jobRunning` already false, and `session.end("unknown")` only declines to clear it (`jobSession.ts:211-215`). So the branch re-arms explicitly before `session.end`: `if (useStore.getState().machineConnected) store.setJobRunning(true)`.
    - The re-arm re-enables STOP (`JobActionBar.tsx:296`), re-acquires keep-awake, blocks START and FRAME, and suspends the poll. This is the same state the drain-timeout `unknown` produces.
    - Keep-awake is released and then re-acquired, not held continuously: `handleStop`'s clear releases it and the re-arm acquires it again (critic r3 A5a).
    - The second-STOP race is unreachable. The STOP button is disabled from `handleStop`'s clear until the re-arm itself (critic r3 A5d).
    - Two mechanisms keep a stale re-arm from outliving the disconnect race (critic r3 A1):
      - The `machineConnected` guard covers the ordering in which teardown has already been published.
      - A tail clear in `disconnect()` covers the other ordering. That is the one in which the writer's rejection reaches TS before `disconnect()` has run `setMachineConnected(false)`. See F4.
    - Without the tail clear, a surviving `jobRunning` would hold keep-awake, leave polling suspended after reconnect, and block START.
    - The message names disconnect and reconnect as the fallback if the second STOP cannot confirm.

- **The re-send does not go through `serial_stop_inner`.** A second stop call while the first is still observing takes the joiner branch (`serial.rs:909-930`), which returns without writing `0x18`. The module doc claims otherwise (`serial_session.rs:26-27`); F6 corrects it.

- **The refusal is a stable string prefix inside the existing `Err(String)` and `string[]` contracts, not a new IPC type.**
  - The contract strings are listed in F1.
  - On the TS side a refusal becomes one sentinel response, `refused:…`, which `jobStream` checks before any other classification.
  - Only `jobStream` can receive a refusal. A typed result would touch every `send()` caller (Console, settings, jog, MachinePanel). The constants make a later switch to a type mechanical.
  - Tauri rejects an `Err(String)` command with the raw string, so `String(e)` in production is the bare contract text. The harness must reproduce that (critic A2).

- **`serial_send` stays one command with `job_epoch: Option<u64>`. There is no separate job-line command.**
  - The fail-open risk is key drift: a renamed parameter makes Tauri deserialize a missing key to `None` (`tauri-2.10.2/src/ipc/command.rs:134-145`), which silently unfences the job.
  - Two tests close that risk. The Rust IPC test sends the literal JSON key `jobEpoch` through the real `#[tauri::command]`, and the TS test pins the same key on every job-line invoke.
  - `serial_stream_job` takes a required `job_epoch: u64`, so an omitted key is rejected (`command.rs:100`) and the command fails closed.

- **`StreamJobOptions.session` becomes required.** Today it is optional (`jobStream.ts:70`), which makes an unfenced job path type-legal. All four production callers already pass one (`JobActionBar.tsx:84,169`, `MaterialTestDialog.tsx:415,447`). The no-session "legacy" branches become unreachable and are deleted. Tests that call `streamJob` without a session get one from the harness.

- **RF-8 is fixed here.** The buffered outcome chain starts at `endState = "complete"` and has no final `else` (`jobStream.ts:168`, `:174-246`). A new `refused:` outcome string would therefore report a stopped job as complete. The default becomes `"unknown"` and an explicit final branch is added.

- **The `job_abort` reset at stream entry is deleted** (`serial.rs:699`).
  - It clears the shared abort flag before taking the lock or checking anything. That is the exact R3 defect PLAN 1.1 said to remove ("Never clear a shared abort flag before taking ownership").
  - `serial_job_begin_inner` already clears the flag under `admitted_job` (`serial.rs:1098`). Once `:699` is deleted, that is the only clearer.

- **The wrapper test uses `tauri::test` (mock runtime), as a `[dev-dependencies]` feature of the existing `tauri` crate.**
  - The `test` feature has no dependencies (`tauri-2.10.2/Cargo.toml:120`), and resolver 2 keeps it out of `cargo build` and `--features sim`. No new crate is added.
  - It is the only way to drive the real `#[tauri::command] serial_send` body, including argument deserialization.
  - The critic verified three things in source. The IPC path is the production `generate_handler!` wrapper. The ACL does not block app commands under `mock_context`. Async commands run on the tokio `async_runtime`.

- **Batch-size waiver (critic A11).** This batch exceeds eight files and spans two subsystem roots (Rust serial and TS machine). The reason: the refusal contract string is produced in Rust and consumed in TS, so splitting the batch would ship a fail-open intermediate in which every job line is refusable but TS still maps refusals to `error:disconnected`.

## Context

Batch 1.1 built the admission fence in `src-tauri/src/commands/serial_session.rs`: phase, epoch, `admitted_job`, `permit_generation`, and `try_permit_begin`/`try_permit_end`. Razor passed it with "per-line admission" in its summary. Production never uses it:

- `serial_send` always calls `serial_send_inner(&inner, &command, None)` (`serial.rs:545`).
- The TS invoke carries no epoch (`connection.ts:273`).
- `serial_stream_job` takes no job epoch at all. Its only epoch read is `session.epoch`, captured as `lock_epoch` for snapshot publication (`serial.rs:709`). It never calls `try_permit_*` and never checks the phase.
- ARCHITECTURE.md's "Admission fence" paragraph (`ARCHITECTURE.md:378-386`) already records this honestly.
- The fence is exercised only by unit tests that pass `Some(epoch)` directly.

Stop itself is unaffected. `serial_stop_inner` closes admission (phase Stopping, `admitted_job` cleared, generation bumped) and writes `0x18` on the realtime handle without touching the command lock (`serial.rs:932-995`).

What the gap leaves open is a stale producer:

- **Per-line mode:** the only barrier is the TS loop's `jobRunning` check (`jobStream.ts:325`), which the IPC queue can outrun. A send invoked before STOP can execute in Rust after it.
- **Buffered mode:** a queued second `serial_stream_job` clears `job_abort` and runs the whole job, `$32=1` included, after the reset. The running pump is fenced only by the shared `job_abort` flag.

Governing rulings (DECISIONS.md):

- Abort, 2026-09-20: "Abort sends 0x18 immediately — no feed hold, no M5, no ack wait … Retain the 0x18 write-failure retry."
- Engineering pin 2026-07-05, amended 2026-09-22: "The prohibition on any ack-awaited write in the abort path stands."
- The `$32` pin: the buffered `$32=1` gate stays as it is, now behind the entry permit. The per-line `$32` gap is batches 2.1 and 2.2.

Lock order (ARCHITECTURE.md "Serial Lock Order"; `serial.rs:3-33`) is unchanged:

- The new permit check takes `admitted_job` (leaf) while holding `command` (3), which the table allows.
- `permit_granted` is emitted after `admitted_job` is released, so no leaf is taken under another leaf.
- The re-send takes `realtime` (2) only after `command` is dropped, so connect stays "the one nesting exception".
- The stop path still never takes `command`.

## Fixes

### F1. Session protocol: refusal contract, in-flight re-send, resend-failure closure, observable permit (`serial_session.rs`, `serial.rs` stop)

**Diagnosis (re-verified 2026-09-22):**

- `try_permit_begin` (`serial_session.rs:161-181`) returns a bare `"session not active (phase=…)"` or `"epoch mismatch: …"` string with no stable prefix.
- `try_permit_end` (`:185-192`) only reports.
- `StopResult::SubmittedUnconfirmed.in_flight_write` is hard-coded `false` at every construction (`serial.rs:925`, `:1055`).
- No event marks a granted permit.
- The stop's confirmed branch calls `increment_epoch(); set_idle()` (`serial.rs:1033-1036`), and `set_idle` is an unconditional store (`serial_session.rs:195-197`). Any Unknown written concurrently can therefore be overwritten with Idle.
- The module doc's claim "Single-flight gates only the observation/result phase, not the 0x18 send" (`serial_session.rs:26-27`) is contradicted by the joiner branch (`serial.rs:909-930`).

**Fix:**

1. **Refusal contract.** Add `pub(crate) const REFUSED_PREFIX: &str = "refused:";` and constructors for the contract strings. Both Rust and TS tests pin these:
   - `refused: not-admitted: session not active (phase=<name>)`
   - `refused: not-admitted: epoch mismatch (job <E>, admitted <none|N>)`
   - `refused: in-flight: line written as admission closed; reset re-sent after it (the line may have preceded the stop's reset)`
   - `refused: in-flight-unreset: line written as admission closed; reset re-send failed (<err>); use the machine's physical stop`

2. **Permit functions.**
   - `try_permit_begin` returns the not-admitted forms. On success it emits `permit_granted` after releasing the `admitted_job` guard.
   - A new `permit_precheck(epoch) -> Result<(), String>` checks phase and epoch without capturing a generation, emits `permit_prechecked` on success, and returns the same not-admitted strings on refusal.

3. **In-flight flags and helpers.** Add `in_flight_write_detected: AtomicBool` and `resend_failed: AtomicBool` to `SerialSession`, plus two helpers:
   - `mark_in_flight(&self)` sets `in_flight_write_detected`.
   - `mark_resend_failed(&self)` sets `resend_failed`, then stores `PHASE_UNKNOWN` with a plain store, so Unknown always wins over a later store.

4. **Re-send helper.** Add `pub(crate) fn resend_reset_after_in_flight(inner: &SerialInner) -> Result<(), String>` in `serial.rs`, beside `send_byte_inner`:
   - It calls `mark_in_flight`.
   - It takes **only** `realtime` and writes `0x18`, retrying once on write failure. Its flush behaviour is the same as the stop's Step 5 (see critic A12, under Deferrals).
   - It emits `in_flight_reset_resent`.
   - If both attempts fail, it calls `mark_resend_failed` and returns `Err`.
   - Callers must have dropped the `command` guard. This is stated in its doc comment and in the lock table (F6).

5. **Stop changes (`serial_stop_inner`), limited to the result-construction phase.** The `0x18` sequence itself is untouched.
   - **Step 2** clears `in_flight_write_detected` and `resend_failed` before bumping the generation.
   - **Result construction:**
     - (a) If `resend_failed` is set, do not transition to Idle.
       - Clear `banner_observed`, the same way the confirmed branch does today (`serial.rs:1038`; critic r2 A4).
       - Return `SubmittedUnconfirmed { in_flight_write: true, … }` with the message "one job line reached the controller around STOP and the reset re-send failed; use the machine's physical stop. Beam state unqualified."
       - This holds even when `banner_observed` was set.
       - The physical-stop message comes **only** from this branch.
     - (b) Otherwise, when the banner was observed, run these steps in this exact order:
       1. Read `resend_failed` (this is branch (a)'s check).
       2. Emit `stop_confirming`.
       3. `increment_epoch()`. This keeps today's increment-then-idle order (`serial.rs:1039-1040`; critic r2 A1), so no job can be admitted under the old epoch between the CAS and the increment. An increment before a failed CAS is harmless.
       4. Call `set_idle_from_stopping()`, which is a `compare_exchange(PHASE_STOPPING, PHASE_IDLE)`.
       - A comment beside the emit reads: "`stop_confirming` is emitted after the `resend_failed` read and before the epoch increment and CAS; R8a becomes tautological if it moves above the read" (critic r2 A7).
       - If the CAS succeeds, return `Confirmed`.
       - If it fails (a concurrent `mark_resend_failed` moved the phase to Unknown), leave the phase alone and return `SubmittedUnconfirmed { in_flight_write: in_flight_write_detected, … }`.
     - (c) The unconfirmed path is unchanged, except that `in_flight_write` now reads `in_flight_write_detected`.
     - When `in_flight_write_detected` is set on either result variant, append the message line "one job line may have been in flight as STOP landed; reset re-sent after it".
   - **Connect** keeps its unconditional Idle store, renamed `set_idle_on_connect()` so no stop path can call it.
   - **`serial_job_end_inner` becomes `compare_exchange(PHASE_ACTIVE, PHASE_IDLE)`** (critic r2 A1).
     - It still clears `admitted_job` and returns `Ok` when the CAS fails, because the job is over either way.
     - The round-1 claim that it "cannot overwrite Unknown" was false for one ordering (critic r2 interleaving #13): the stop's CAS runs, a new job is admitted, the writer's late `mark_resend_failed` lands, that new job's lines are refused, and `serial_job_end(E_new)` then stores Idle. The window is microseconds against an IPC round trip, which makes it structural rather than reachable, but one CAS closes it.

**Ordering argument** (this goes into the `serial_session.rs` module doc):

- **Assumption (critic A3 / LB-1).** Writes from the writer and realtime clones share one tty output queue and land on the wire in syscall order. This holds for the Linux and macOS tty layers. If it did not hold, the argument below would be decorative.
- **The two sequences.**
  - The stop does: phase store → generation bump → `0x18`.
  - The writer does, under the lock: load g0 → load phase → write+flush → load g1.
- **Why detection is complete.**
  - If the writer's phase load sees Active, its g0 load preceded the bump.
  - Suppose a line lands after the stop's `0x18`. Then its write syscall ran after the stop's `0x18` syscall, which follows the bump. The g1 load comes after the write, so g1 ≠ g0 and the writer detects it.
  - If g1 = g0, the write completed before the bump, and therefore before the `0x18`.
- **The false positive, which is harmless.** `serialport`'s `flush()` is `tcdrain` (`serialport-4.8.1/src/posix/tty.rs:486`). A line queued *before* the `0x18`, whose drain returns after the bump, is also reported as in flight. The second `0x18` costs one extra reset and banner. This is why the contract text says "the line may have preceded the stop's reset".
- **Only the stop bumps the generation (LB-2, verified `serial.rs:944`).** So the re-send can never reset an idle controller.
- **Guarantee.** Every job line on the wire after the stop's `0x18` is followed either by a writer-issued `0x18`, or by Unknown plus a physical-stop instruction with admission closed.

**Tests (red-first):**

- F2 (R3, R4) and F3 (R7) drive this protocol through the production bodies.
- Unit additions in `serial_session.rs`:
  - The refusal strings start with `REFUSED_PREFIX` and name the phase.
  - `permit_granted` is emitted only on success.
  - `set_idle_from_stopping` from Unknown returns false and leaves Unknown.
  - **`rf15_job_end_does_not_overwrite_unknown`:** set phase Unknown and `admitted_job = Some(id)`, then call `serial_job_end_inner(id)`. It returns `Ok`, `admitted_job` is `None`, and the phase is still Unknown. Mutant: restore the unconditional Idle store → **RED**.
- **R8a `rf15_resend_failure_during_confirm_keeps_admission_closed`** (the CAS).
  - A stop with a scripted banner. The test observer, on the `stop_confirming` event, calls the production `inner.session.mark_resend_failed()`. This models the concurrent writer through the same function the helper calls, so it copies no logic. The observer takes no realtime lock, so it cannot deadlock.
  - Assert: phase is Unknown after the stop; `serial_job_begin_inner` refuses; the result is `SubmittedUnconfirmed`.
  - Mutant: replace the CAS with the old unconditional `set_idle()`. Phase ends Idle and job begin succeeds → **RED**.
  - **The emit position is load-bearing (critic r2 A7).** R8a reaches the CAS only because `stop_confirming` is emitted after the `resend_failed` read. The test's doc comment says so, and so does the comment beside the emit (F1.5 (b)).
  - A second mutant pins the position: move the emit above the flag read. Branch (a) then catches the observer's mark, and R8a's `SubmittedUnconfirmed` assertion still holds. To make that mutant visible, R8a also asserts that the result **lacks** the physical-stop message, which branch (a) alone produces. Moving the emit → **RED**.
- **R8b `rf15_resend_failure_end_to_end_stop_reports_physical_stop`** (the flag).
  - Admitted E. `hold_next_write(Writer, "line")`. `fail_writes_after(Realtime, 1)`, so the stop's own `0x18` succeeds and every later realtime write fails. The stop's banner sits behind a read hold, `HoldUntilRelease "banner"`.
  - Sequence:
    1. The sender parks in the write.
    2. The stop runs to its `0x18` and starts its banner loop.
    3. Release `line`.
    4. The sender detects in flight; both re-send attempts fail; it returns.
    5. Then release `banner`.
  - Assert:
    - The sender returns `refused: in-flight-unreset:`.
    - The stop result is `SubmittedUnconfirmed` with `in_flight_write == true` and the physical-stop message.
    - Phase is Unknown, and `serial_job_begin_inner` refuses.
  - Mutants:
    - Drop the `resend_failed` check in the stop's result construction. The CAS fails on Unknown, so the result is a generic unconfirmed one without the physical-stop message → **RED**.
    - Drop the `mark_resend_failed` call in the helper. The phase is Stopping, the CAS succeeds, and the stop goes Idle → **RED**.
- **R8c `rf15_second_stop_recovers_from_unknown`** (critic r3 A2). This is the Rust proof behind the operator message's "then press STOP in Kerf" and F6's invariant sentence.
  - Setup: continue from R8b's end state, where phase is Unknown and `resend_failed` is set.
  - Action: run a second `serial_stop_inner` with a scripted banner. Realtime writes succeed again, because the test clears the ScriptedPort write fault.
  - Assert:
    - The result is `Confirmed`.
    - Phase is Idle.
    - `serial_job_begin_inner` succeeds.
    - The result lacks the physical-stop line, because Step 2 cleared `resend_failed`.
  - Mutant: make Step 2's Stopping store a CAS from Active (the "never clobber Unknown" refactor someone will propose). The phase stays Unknown, the Stopping→Idle CAS fails, and `serial_job_begin_inner` refuses → **RED**.
- Mutant for the prefix: change the refusal text to drop the prefix. R1(b) and T6 go **RED**.

### F2. Per-line: gate `serial_send` on the job epoch (`serial.rs`, `Cargo.toml`, `scripted_port.rs`)

**Diagnosis (re-verified 2026-09-22):**

- `serial.rs:545`: the wrapper passes `None`.
- `:458-462`: the permit is checked before the lock wait at `:464`.
- `:489-500`: the line is written first, then the post-write check returns `"permit expired: …"`. The line is already on the wire, with nothing ordered after it.
- `b1_send_after_stop_refused` (`serial.rs:1897`) gives its writer and realtime handles separate `MockPort`s, so the `0x18` is never in `written`. The test's comment "The only write should be the 0x18 from stop" is false, and the test cannot order anything.
- `ScriptedPort` has read hold points only (`scripted_port.rs:37`). No test in the tree uses it; the only mention outside `sim/` is the doc comment at `serial.rs:268`.

**Fix:**

1. `serial_send` gains `job_epoch: Option<u64>` and calls `serial_send_inner(&inner, &command, job_epoch)`.
2. `serial_send_inner` with `Some(e)`:
   - Run `permit_precheck(e)` before the lock. On refusal, return the not-admitted `Err` without waiting.
   - Take the lock.
   - Run `try_permit_begin(Some(e))` → g0. On refusal, return the not-admitted `Err`, with no reader or writer touched.
   - Then `PumpFlight::begin` → drain → write+flush → `try_permit_end(g0)`.
   - If the end check fails: drop `_flight` and the guard, call `resend_reset_after_in_flight`, and return `refused: in-flight…` or `refused: in-flight-unreset…`.
   - The `None` path is byte-for-byte unchanged.
3. `ScriptedPort` gains two test-only faults, both `#[cfg(any(test, feature = "sim"))]`:
   - `hold_next_write(role, id)`: the next write from that role parks until `release_hold(id)`. The brain lock is not held while parked; this is the same pattern as the read hold.
     - **The write is recorded in the trace at release, never at park time.**
     - This rule is written into the fault's doc comment and asserted by a ScriptedPort self-test: while the write is parked, the trace holds a `HoldReached` and no `Write` for it.
     - If the write were recorded at park time, R4 and R7's "last Writer write is followed by a Realtime `0x18`" would pass on the *stop's* `0x18`, and the re-send mutant would survive (critic r2 LB-5).
   - `fail_writes_after(role, n)`: that role's `write()` calls after the n-th return an I/O error.
     - **Only `write()` calls are counted; `flush()` is never counted** (critic r2 A5).
     - R8b depends on this rule: the stop's `write_all` + `flush` (`serial.rs:968-971`) is write #1, and the re-send's first attempt is write #2.
     - The rule is written into the doc comment.
4. `src-tauri/Cargo.toml` `[dev-dependencies]` gains `tauri = { version = "2", features = ["test"] }`.

**Test-time rule (critic A8).** `serial_stop_inner`'s banner wait is a real 3 s `Instant` deadline (`serial.rs:1005`); a no-op sleeper busy-spins it.

- Every R-test stop gets a scripted banner that its try-lock read, or the pump, can observe. No test waits on the deadline.
- Every R-test runs inside `ScriptedPort::run_scenario` with a 2 s deadline, below the stop's 3 s. A test that silently falls through to the real deadline fails loudly instead of running slow.
- Barriers are events and hold points, never sleeps.
- The stop's production deadline is not changed. The stop sequence is out of scope.

**Tests.** Every mutant is run through `~/marvin/scripts/mutation-battery.mjs`, and the red results are saved in its journal.

- **R1 `rf15_ipc_serial_send_carries_job_epoch`.**
  - Setup: `tauri::test::mock_builder().manage(SerialState(inner)).invoke_handler(generate_handler![serial_send])`, then `get_ipc_response` with body `{"command":"G1 X1","jobEpoch":E}`. `inner` runs on a `ScriptedPort` whose writer and realtime share one brain.
  - (a) Positive control. Phase Active, admitted E, scripted `ok` → `Ok`, and the line is in the trace. This proves the test can see a write.
  - (b) Run `serial_stop_inner` with a scripted banner, then make the same IPC call. Expect an `Err` beginning `refused: not-admitted:`, and zero Writer writes after the Realtime `0x18`.
  - (c) The same call without `jobEpoch`, made after the stop, still writes. The console path is intact.
    - **The assertion is on the trace, not on `Ok`** (critic r2 A8). Its pump may reach EOF on the exhausted script and return `Err("disconnected: …")`. The Writer write in the trace is the evidence.
  - Mutants:
    - The wrapper passes `None` → (b) **RED**.
    - Rename the Rust parameter → the key goes missing and deserializes to `None` → (b) **RED**.
  - **This is the test that fails if the production command body passes `None` for a job line.** It drives the real `#[tauri::command]` and copies no logic.
- **R2 `rf15_per_line_stale_send_after_stop_refused_nothing_after_reset`.** Inner level, one-brain ordered trace.
  - Sequence: connect state → `serial_job_begin_inner` → one accepted line → `serial_stop_inner`, confirmed by a scripted banner → the test pushes a `stale_send_begin` marker event → `serial_send_inner(…, Some(E))`.
  - **Decoy (critic r2 A2).** The script queues one `Data(b"ok\n")` step after the banner.
    - `drain_classified` reads only what `available_now()` reports (`serial_pump.rs:326`), and `ScriptedPort::bytes_to_read` counts queued `Data` steps (`scripted_port.rs:389-402`).
    - Without the decoy, an exhausted script would give the drain mutant nothing to read, and the `ReadData` assertion could not fire.
    - The green path leaves the decoy unread. The mutant consumes it.
  - Assert:
    - The result is an `Err` starting with `refused: not-admitted:`.
    - No Writer write follows the Realtime `0x18`.
    - No `ReadData` event follows the `stale_send_begin` marker. This is scoped per critic A7: the stop's own banner read precedes the marker.
  - **Red today on the prefix assertion only.** Today's pre-lock check already refuses this send, but its text `session not active (phase=…)` has no prefix. The mechanism is exercised by the mutants.
  - Mutants:
    - Delete both permit calls → **RED**.
    - Move the under-lock check after the drain → **RED** on the `ReadData` assertion. This mutant disables the precheck too, so that the send reaches the lock.
- **R3 `rf15_per_line_permit_checked_after_lock_wait`.**
  - Sequence:
    1. Admitted E. The test thread holds `inner.command`.
    2. Spawn a sender with `Some(E)`.
    3. Wait for `permit_prechecked` in the trace. It arrives in both the green and the mutant direction, because the precheck runs before the lock, so the wait costs no time.
    4. Run `serial_stop_inner` on another thread. It only `try_lock`s the command lock.
    5. Once the Realtime `0x18` appears, release the lock. The stop's try-lock read then gets its scripted banner.
    6. Join.
  - Assert:
    - The sender returns `refused: not-admitted:`.
    - Zero Writer writes follow the stop's `0x18`.
    - The trace has no `permit_granted` event (critic A8: assert absence, never wait for it).
  - Mutant: **delete the under-lock check**, keeping the precheck (critic A4). The sender passed its precheck before the stop and writes after the `0x18` → **RED**.
- **R4 `rf15_per_line_in_flight_write_followed_by_reset`.**
  - Sequence: admitted E; `hold_next_write(Writer, "line")`; the sender passes its checks and parks in the write; the stop runs to its `0x18`; release the hold. The stop then reads its scripted banner once the sender drops the lock.
  - Assert:
    - The sender returns `refused: in-flight:`.
    - The trace's last Writer write is followed by a Realtime `0x18`.
    - The stop result carries `in_flight_write == true` if unconfirmed, or the in-flight message line on either variant.
  - Mutants:
    - Delete the `try_permit_end` check → **RED**.
    - Delete the re-send → **RED**.
    - Route the re-send through `serial_stop_inner` → **RED**, because the joiner writes nothing.
- **Existing tests.**
  - `b1_send_after_stop_refused` keeps its `is_err` assertion; its false comment is corrected.
  - `b1_console_send_bypasses_permit` stays green unchanged, which proves the `None` path is intact.

**Risk.** A wrongly ordered gate falsely refuses a legitimate line mid-job, which aborts real jobs. R1(a), R2's accepted first line and owner step 3 are the positive controls.

### F3. Buffered: gate `serial_stream_job` at entry and per line (`serial.rs`, `serial_pump.rs`)

**Diagnosis (re-verified 2026-09-22):**

- `serial.rs:693-697`: `serial_stream_job_inner(inner, gcode, on_event)` takes no job epoch.
- `:699`: it clears `job_abort` before the lock.
- `:701-760`: it writes `$32=1` and starts the pump with no phase check.
- `serial_pump.rs:504-512`: `run_buffered_pump` knows only `abort: &AtomicBool`. Its per-line write is at `:556-563`, guarded only by `:543`.

**Fix:**

1. **Entry gate.** The signatures become `serial_stream_job(state, gcode, job_epoch: u64, channel)` and `serial_stream_job_inner(inner, gcode, job_epoch, on_event)`.
   - Delete the `job_abort.store(false)` at entry.
   - Run `permit_precheck(job_epoch)` before the lock.
   - After the lock, and **before** the drain and before `$32=1`, run `try_permit_begin(Some(job_epoch))`. On refusal, return `Err(refused: not-admitted…)` with nothing read or written.
   - Bracket the `$32=1` write with the same begin/end pair, since it is written on the job's behalf.
2. **Per-line gate in the pump.** `run_buffered_pump` gains a `gate: &dyn SubmissionGate` parameter.
   - `trait SubmissionGate { fn begin(&self) -> Result<u64, String>; fn end(&self, g0: u64) -> Result<(), String>; }` lives in `serial_pump.rs`, so the pump stays session-agnostic.
   - In Phase A, call `gate.begin()` after the existing abort check and before `write_all`, and `gate.end(g0)` after `flush`.
   - Add a new outcome, `BufferedPumpOutcome::Refused { line_index, in_flight: bool, reason: String }`.
   - `serial.rs` implements the gate as `JobPermit { session, epoch }`.
   - Pump unit tests pass an always-open `OpenGate`.
3. **Re-send and outcome strings.** The stream body drops the lock where it does today (`serial.rs:801-802`).
   - If the pump returned `Refused { in_flight: true }`, call `resend_reset_after_in_flight` after the drop.
   - The outcome strings are `refused: not-admitted: …`, `refused: in-flight…` and `refused: in-flight-unreset…`. They are returned as `Ok`, like the other pump outcomes, and the `Finished` event carries the same string.

**Update sweep (critic A9).**

- "Every `sim_integration` test calling `serial_stream_job_inner`" is **the empty set**. The only callers are the wrapper (`serial.rs:867`) and `pin_stream_writes_dollar32_first` (`:1828`). The latter begins a job and passes its epoch.
- The real update list is the seven `run_buffered_pump(` call sites: 1 production, 4 in `serial.rs` sim tests and 2 in `serial_pump.rs`. Each gains a gate argument. The relay log names each one.

**Tests:**

- **R5 `rf15_buffered_stream_after_stop_refused_at_entry`.**
  - Sequence: begin E → stop, confirmed by banner → `serial_stream_job_inner(…, E, …)`.
  - Assert:
    - The result is an `Err` starting with `refused: not-admitted:`.
    - No Writer write follows the Realtime `0x18`, not even `$32=1`.
    - `job_abort` is still `true`.
  - Mutants:
    - Delete both entry checks → **RED**.
    - Restore `job_abort.store(false)` at entry → **RED** on the flag.
- **R6 `rf15_buffered_mid_job_gate_independent_of_abort_flag`.** A mechanism test.
  - Sequence:
    1. The pump runs for E with a read hold parked in Phase B and the budget full.
    2. `serial_stop_inner` runs to its `0x18`.
    3. The test clears `job_abort`.
    4. Release the hold with `ok\r\n` followed by a scripted banner.
  - Assert: the outcome is `refused: not-admitted:`, and no Writer write follows the `0x18`. The stop then confirms on the banner after the pump drops the lock.
  - The test's comment states the reasoning (critic A6):
    - The production clearer of `job_abort` is `serial_job_begin_inner`.
    - It cannot coincide with a live pump. A stop confirms only when a reader publishes the banner, and while the pump holds `command` it is the only reader, and seeing the banner ends it.
    - The hand clear models the class (R3), not a reachable production sequence.
  - Mutant: delete `gate.begin()` in Phase A → **RED**.
- **R7 `rf15_buffered_in_flight_line_followed_by_reset`.**
  - Sequence: write hold on line k of a running pump; the stop runs to its `0x18`; release.
  - Assert: the outcome is `refused: in-flight:`, and the trace's last Writer write is followed by a Realtime `0x18`.
  - Mutants:
    - Delete `gate.end()` → **RED**.
    - Delete the wrapper's re-send → **RED**.

**Risk.**

- A pump gate that refused on a spurious generation change would abort buffered jobs. Only the stop bumps the generation (LB-2).
- Buffered mode stays opt-in, and `perLine` remains the default (DECISIONS pin).

### F4. TS transport: thread the epoch, surface the refusal (`connection.ts`)

**Diagnosis (re-verified 2026-09-22):**

- `connection.ts:269-310`: `send(command)` invokes `serial_send` with `{ command }` only.
- `:305-308`: **every** rejection maps to `["error:disconnected"]`. Once the fence is wired, a refusal would be read as a dead port, and `jobStream.ts:350-358` would tear the connection down.

**Fix:**

- New signature: `send(command: string, opts?: { jobEpoch?: number })`.
  - The invoke args are `{ command }` when `jobEpoch` is undefined, so console, `$H`, jog and settings calls are unchanged on the wire.
  - Otherwise they are `{ command, jobEpoch }`.
- Export `PERMIT_REFUSED_PREFIX = "refused:"`.
- In the `catch`, if `String(e)` starts with the prefix:
  - Log a console line: `Not sent: <reason>` for not-admitted, or the in-flight text for `in-flight*`, since those lines were sent.
  - Return `[msg]` without the `error:disconnected` mapping.
- The check stays `startsWith` and never becomes `includes` (critic A2).
- All other rejections are unchanged.
- **Tail clear in `disconnect()` (critic r3 A1).** After `store.setMachineConnected(false)` (`connection.ts:260`), and also on its `catch` path, call `store.setJobRunning(false)`. That way no in-flight-unreset re-arm that raced teardown can outlive it. T4b(iii-b) covers this.
- **The "sent" echo precedes the invoke, and that is accepted** (critic r2 A6).
  - `send()` logs the command as `"sent"` before invoking (`connection.ts:272`).
  - A refused job line therefore reads in the console as the line, then `Not sent: <reason>`. That pairing is the honest record of what the app attempted.
  - Moving the echo would change the timing of every console command, for one case that only arises during a stop.

**Test.**

- **T6** (`connection.test.ts`):
  - `send("G1 X1", { jobEpoch: 7 })` invokes `serial_send` with exactly `{ command: "G1 X1", jobEpoch: 7 }`.
  - `send("$$")` invokes with `{ command: "$$" }` and no `jobEpoch` key.
  - A raw-string rejection `"refused: not-admitted: …"` returns `["refused: not-admitted: …"]`.
  - A `disconnected: …` rejection still returns `["error:disconnected"]`.
- Mutants:
  - Drop the `jobEpoch` key → **RED**.
  - Remove the refusal branch → **RED**.

**Risk.** Existing tests that assert `toHaveBeenCalledWith("serial_send", { command })` for job lines need the key added. Each is updated, never loosened to `expect.anything()`.

### F5. Job loop: send job lines with the epoch; map refusal; RF-8 (`jobStream.ts`)

**Diagnosis (re-verified 2026-09-22):**

- `jobStream.ts:331`: `machineConnection.send(lines[i])` carries no epoch.
- `:336`: a `refused:` response would fall through every branch and the loop would continue to the next line.
- `:172`: the buffered invoke carries no epoch.
- `:168`: `endState` defaults to `"complete"`, and `:174-246` has no final `else` (RF-8).
- `:247-255`: the buffered `catch` treats any message containing `"disconnected"` as a dead port, and the Rust refusal text `phase=disconnected` would trip it.
- `:263` and `:424`: the post-loop `emergencyStop` fires for every non-complete, non-alarm end while `jobRunning` is true.
- `:431`: the post-loop `else` logs `"<label> aborted"`.
- `:70`: `session` is optional.
- Header `:8-14` and doc `:84-89` still describe an "M5 + softReset" volley (RF-16).

**Fix:**

1. **Required session.** `StreamJobOptions.session: JobSession` becomes required. Delete the no-session branches, which are now unreachable: the `else if (opts.waitForIdle)` idle loops in both paths, and the legacy cleanup `else`.
2. **Per-line.** Call `send(lines[i], { jobEpoch: session.jobId })`. The **first** check after the call is `responses.find(r => r.startsWith(PERMIT_REFUSED_PREFIX))`. If it finds a refusal, set `refused = true`, set `endState` per the table below, and break.
3. **Buffered.**
   - Invoke `{ gcode, jobEpoch: session.jobId, channel }`.
   - Initialise `let endState = "unknown"`.
   - The first branch is `outcome.startsWith("refused:")` → `refused = true`, `endState` per the table.
   - A final `else` logs `"<label> ended with an unrecognised result (<outcome>); controller state unknown"` and leaves `"unknown"`.
   - In the `catch`, the refusal-prefix check comes **before** the `disconnected`/`Not connected` check.
4. **The refusal contract:**

| Backend answer | Line written after STOP? | `endState` | `jobRunning` after | TS sends anything more? | Port torn down? | Operator sees (console / UI) |
|---|---|---|---|---|---|---|
| `refused: not-admitted: …` | No | `cancelled` | false | **No**: no `emergencyStop`, no M5, no line, whatever `jobRunning` says | No | The console echo shows the line as sent, then `Not sent: <reason>`, then `<label> stopped: the controller is no longer accepting this job's lines (<phase or epoch reason>). Nothing further was sent.` |
| `refused: in-flight: …` | Possibly one line; the backend re-sent `0x18` after it | `cancelled` | false | **No** | No | `<label> stopped: one line may have reached the controller as STOP landed. Kerf sent the reset again after it. Beam state unqualified — verify visually.` |
| `refused: in-flight-unreset: …` | Possibly one line; the reset re-send failed | **`unknown`** | **Re-armed to true** when `machineConnected` (see below), so STOP is live (`JobActionBar.tsx:296`). Stays false when disconnected. | **No** automatic stop; the operator can press STOP, which goes through the shared `serial_stop` | No | `<label> stopped: one line may have reached the controller after STOP and the reset could not be re-sent. Use the machine's physical stop, then press STOP in Kerf; if STOP cannot confirm, disconnect and reconnect. Status updates pause until STOP. Beam state unqualified.` It also calls `setMachineState("alarm")`, mirroring `emergencyStop`'s `submissionFailed` handling. |

   - A refusal is **never** `complete`.
   - `refused = true` skips both post-loop `emergencyStop` blocks. It also skips the `"<label> aborted"` line at `:431` (critic A5) and the "cancelled"/"complete" console lines. The table's message is the only one logged.
   - **Why a refusal never triggers an automatic stop.** The backend has already reset the controller, or handed it to another admission. A `0x18` sent on an epoch mismatch could reset a job that is not this producer's.
   - **The in-flight-unreset case (B1 and B1-r2).** The backend has already closed admission (F1). The branch runs in this order:
     1. `setMachineState("alarm")`.
     2. `if (useStore.getState().machineConnected) store.setJobRunning(true)`. This re-arm is needed because every production stop cleared `jobRunning` before the refusal could arrive.
     3. Log the table's message.
     4. `session.end("unknown")`.
   - The operator gets the STOP button back. The retry goes through the same shared stop: a second STOP's Step 2 stores Stopping, and a banner then moves it to Idle through the CAS. If that STOP cannot confirm, the message names disconnect and reconnect, and connect performs a DTR reset plus `0x18` (`serial.rs:290-312`).
   - With `jobRunning` true, the 250 ms status poll is suspended until STOP (critic r2 A9), which the message states. START and FRAME stay refused by `canStartJob` (`jobRunning`, and `machineState === "alarm"`, `canStartJob.ts:172,181`) and by Rust (phase Unknown).
   - `session.end(endState)` still runs, and it releases this session only. `"unknown"` keeps `jobRunning` and keep-awake held (`jobSession.ts:208-215`). A stale id that `serial_job_end` refuses is non-fatal (`:197-201`).
5. **RF-16, comments only, in this file.** Rewrite the header's safety contract and the `streamJob` docblock to describe the shared `serial_stop` (`0x18`, per 2026-09-20) and the refusal contract. No behaviour change.

**Tests** (`jobStream.test.ts`, plus the harness extension):

- **Harness** (`serialTraceHarness.ts`): add `enableFenceModel()`.
  - `serial_job_begin` admits the returned epoch, and `serial_job_end` clears it.
  - `serial_stop` closes admission and resolves a `confirmed` `StopResult` fixture. The fixture carries `messages: []` at minimum, because `emergencyStop` iterates it (critic r3 A5c).
  - A `simulateReconnect()` helper clears the admission.
  - Each `serial_send` is evaluated **at resolution time**, which for deferred sends means inside `releaseInvoke`. This models Rust executing late.
    - A numeric `jobEpoch` that is not admitted rejects.
    - An absent `jobEpoch` is accepted, modelling the `None` bypass.
    - Each record gets `wrote: boolean`.
    - Not-admitted refusals record `wrote: false`.
    - `in-flight` and `in-flight-unreset` refusals record `wrote: true`, because the line reached the port (critic r3 A5b). T1's "no `wrote === true` after `serial_stop`" applies to not-admitted sends only, and the test says so.
  - **Rejection fidelity (critic A2).**
    - `reject` is retyped `(error: unknown)`. The fence model rejects with the **raw string**, e.g. `"refused: not-admitted: session not active (phase=stopping)"`, exactly as Tauri rejects an `Err(String)`. Never `new Error(…)`.
    - A recorder self-test asserts `String(rejection) === "refused: not-admitted: session not active (phase=stopping)"`. Mutant: reject with `new Error(…)` → **RED**.
- **T1: a late per-line send from the stopped job is refused and writes nothing.**
  - Setup: `perLine`, session begun, a 3-line job, `serial_send` deferred.
  - Sequence:
    1. Once the first send is invoked, perform JobActionBar's STOP sequence: `stopActiveSession()` (not awaited), `setJobRunning(false)`, `await emergencyStop()`.
    2. Release the deferred send.
  - Assert:
    - The released send was invoked with `jobEpoch === session.jobId` and has `wrote === false`.
    - No `serial_send` record after `serial_stop` has `wrote === true`.
    - Exactly one `serial_stop`; no `serial_send` of `M5`; no `serial_disconnect`.
    - `machineConnected` is still `true`.
    - `endState === "cancelled"`.
    - The not-admitted console line is present.
    - **No** console line matching `/aborted/`, `/Disconnected/` or `/complete/` (critic A5).
  - Mutants:
    - Drop `{ jobEpoch }` at `:331` → the model accepts the late send → **RED**.
    - Remove the refused branch → the send maps through `error:` handling → **RED** on `serial_disconnect`/`machineConnected`.
    - Remove the `refused` guard on the `"aborted"` line → **RED**.
- **T2: a refusal with `jobRunning` still true never completes and sends no stop.**
  - Setup: the fence model closes admission directly, with no TS STOP.
  - Assert: `endState === "cancelled"`; zero `serial_stop`; exactly one `serial_send` issued.
  - Mutants:
    - Continue past a refusal → the job ends `"complete"` → **RED**.
    - Drop the `refused` guard on the post-loop stop → **RED**.
- **T3: buffered entry refusal.**
  - Setup: the invoke rejects with the raw string `refused: not-admitted: session not active (phase=disconnected)`.
  - Assert: `cancelled`; `portDisconnected === false`; no `serial_disconnect`; no `serial_stop`.
  - Mutant: put the `disconnected` check first → **RED**.
- **T4: buffered `Ok("refused: in-flight: …")`** → `cancelled`, the in-flight console line, no `serial_stop`.
- **T4b (critic B1 and B1-r2): `in-flight-unreset`.** The harness gains `releaseInvokeReject(index, rawString)`, and a release with an `in-flight-unreset` string moves the fence model to `unknown`, in which `serial_job_begin` rejects.
  - **(i) Production STOP order, per-line.**
    - Sequence: with the first `serial_send` deferred, run `handleStop`'s exact sequence: `stopActiveSession()` (not awaited), `setJobRunning(false)`, `await emergencyStop()`. Then release the send with the raw `refused: in-flight-unreset: …` string.
    - Assert: `endState === "unknown"`; `jobRunning === true` (re-armed); `machineState === "alarm"`; zero further `serial_send`; exactly one `serial_stop`; the physical-stop line is present, including "disconnect and reconnect".
    - Mutants:
      - Drop the re-arm → `jobRunning === false` → **RED**.
      - Map it to `"cancelled"` → **RED**.
  - **(ii) Buffered, same production order.** Same assertions, with `serial_stream_job` resolving `Ok("refused: in-flight-unreset: …")`.
  - **(iii) Disconnected.** Same as (i), but `machineConnected` is set to `false` before the release, as it would be after disconnect's teardown. Assert `jobRunning === false` and `machineState === "alarm"`. Mutant: drop the `machineConnected` guard → **RED**.
  - **(iii-b) Disconnect race, refusal first (critic r3 A1).**
    - Sequence:
      1. Defer `serial_disconnect`.
      2. Run `machineConnection.disconnect()` with a job active.
      3. While `serial_disconnect` is still pending, release the per-line send with the raw `refused: in-flight-unreset: …` string. The re-arm fires, because `machineConnected` is still `true`.
      4. Resolve `serial_disconnect`.
    - Assert `jobRunning === false` and `machineConnected === false`.
    - Mutant: drop the tail clear in `disconnect()` → `jobRunning === true` → **RED**.
  - **(iv) No TS stop (the R6-class control).** The fence model closes admission with `jobRunning` still true.
    - The assertions are those of (i) with one exception: **zero** `serial_stop`, not one (critic r3 A3). The property under test is that a refusal never triggers a stop.
    - Mutant: drop the `refused` guard on the post-loop stop → one `serial_stop` → **RED**.
- **T4c: a second STOP recovers (critic B1-r2 item 4).**
  - Sequence:
    1. Continue from T4b(i): the model is `unknown` and `jobRunning` is true.
    2. `beginJobSession("Job")` returns `null`, because the model rejects `serial_job_begin`.
    3. Run `handleStop`'s sequence again. The model's `serial_stop` confirms and moves to Idle.
  - Assert:
    - Exactly two `serial_stop` records.
    - `jobRunning === false`.
    - `beginJobSession("Job")` now returns a session with a new `jobId`.
  - `machineState` stays `"alarm"` until the resumed status poll writes the controller's real state. The test asserts the backend admission, not the UI state, and says so in its comment.
  - Mutant: make the model's second `serial_stop` leave `unknown` in place. `beginJobSession` stays `null` → **RED**. This proves the assertion can fail.
- **T5 (RF-8): buffered `Ok("bogus")`** → `endState === "unknown"` and never `"complete"`.
  - Mutant: restore the `"complete"` default → **RED**.
- **T7: every job-line `serial_send` from `streamJob` carries `jobEpoch === session.jobId`**, and the buffered invoke carries `jobEpoch`.
  - This includes Frame through `machineJobLoop.test.tsx`'s JobActionBar path.
  - Negative control (critic pre-mortem #2): after `beginJobSession`, `simulateReconnect()` runs before the first line. The first send is refused (not admitted), and the job ends `cancelled`, never `complete`.
- **Updated tests.** The `streamJob` calls in `jobStream.test.ts` at `:86,100,113,119,138,152,165,171` begin a session via the recorder.

**Risk.**

- If the post-loop guard is keyed wrongly, a real error could skip its stop. T2's mutant and the existing error-path test (`jobStream.test.ts:123`) pin both directions.
- An unrecognised buffered outcome now leaves `jobRunning` true until STOP. That is the intended fail-safe.

### F6. Documentation (`ARCHITECTURE.md`, module docs)

- **ARCHITECTURE.md, "Admission fence."** Replace the gap paragraph (`:381-386`) with the implemented protocol:
  - job lines carry the epoch;
  - precheck plus under-lock check before drain and write;
  - post-write detection and the realtime re-send;
  - `resend_failed` and the `Stopping→Idle` CAS;
  - per-line gating in the buffered pump;
  - the refusal strings and the TS mapping table.
- **Correct the admission invariant sentence to what the code does.** A later stop can clear Unknown: its Step 2 stores Stopping unconditionally, and a banner it observes lets the CAS move Stopping→Idle. The existing sentence "after an unconfirmed or failed stop no job can begin until reconnect" is therefore wrong. It becomes: "after an unconfirmed or failed stop, or a failed in-flight re-send, no job can begin until a later stop is confirmed by a reset banner or the port is reconnected". That later stop is the recovery the operator's live STOP button reaches.
- **"Stop" paragraph.** Add that `in_flight_write` is set by a detected in-flight line, and that `resend_failed` forces `SubmittedUnconfirmed`.
- **Lock table.** Add `resend_reset_after_in_flight` to `realtime`'s "Held by" column, noted "(after dropping `command`)". The order is unchanged.
- **Disconnect-with-job race (critic A10), documented as expected.** Disconnect runs the stop, then teardown. A late in-flight detection's re-send then hits "not connected" and reports `in-flight-unreset`. That is honest (the port is gone, and the physical stop is the only recourse), and it is not a bug to chase.
- **Two stale-mark orderings (critic r2 A3), documented as expected in the `serial_session.rs` module doc and in ARCHITECTURE.md.** Both are conservative, and both will look like bugs to a future reader:
  - (i) A writer from stop S can mark `resend_failed` after a later stop S2 has cleared the flag in its Step 2. S2 then returns `SubmittedUnconfirmed` with the physical-stop line even though its own reset succeeded. The operator presses STOP again.
  - (ii) On the disconnect race, the writer's Unknown store can land after `set_disconnected`, leaving the phase Unknown while disconnected. `set_idle_on_connect` clears it, and connect performs a real reset.
- **`serial_job_end_inner` CAS.** The Admission fence paragraph states that ending a job moves Active→Idle only, and never overwrites Unknown.
- **ALARM disarm (critic r3 A4).** The Admission fence paragraph states that after an `in-flight-unreset` the app holds STOP live, and that a manual write such as a console `$X`, Test Fire or a settings write can drain an `ALARM:3` line through `surfaceUnsolicited`, which clears `jobRunning`. STOP then goes grey while the backend is still Unknown, and reconnect is the recovery. The paragraph points to the Parking Lot line.
- **`serial.rs` module doc.** Mirror the above.
- **`serial_session.rs` module doc.**
  - Add the F1 ordering argument, with its tty assumption.
  - Correct the single-flight claim: a joiner waits, returns `last_stop` and sends no byte.

### F7. RF-11: connect-guard test calls the connect body (`serial.rs` tests)

**Diagnosis (re-verified 2026-09-22):** `already_connected_guard_disconnects_first` (`serial.rs:1851`) re-implements the guard inside the test body. The PLAN addendum attaches RF-11 to "next Rust batch touching serial.rs", which is this one.

**Fix:** Call `serial_connect_inner` twice with a `ScriptedPort` factory. Assert that the first connection's handles were torn down before the second connection's DTR toggle, as recorded in the trace.

**Test.** Mutant: delete the guard at `serial.rs:279-281` → **RED**.

**Risk:** None to production. The change is test-only.

## Dependency Graph

```
ScriptedPort write hold + write-failure (F2.3) ─┐
tauri test feature (F2.4) ──────────────────────┤
F1 session protocol + stop result changes ──────┼─> F2 per-line gate + R1–R4, R8a/R8b
                                                └─> F3 buffered gate + R5–R7
F2 + F3 (Rust contract strings fixed) ─> F4 connection.ts ─> F5 jobStream + harness + T1–T7
F2 + F3 + F5 ─> F6 docs
F7 independent (after F2.3 lands)
```

This is one integration unit, and Rust and TS merge together (see the batch-size waiver). No tag or installer is cut between the halves.

## Hardware note

- **In-app scripted-port smoke: not available.** Batch 0.1 specified "a test-only selectable scripted port under the existing `sim` feature for the later Tauri smoke". It does not exist. The `sim` feature only compiles `src/sim` (`lib.rs:3-4`), and `serial_connect` always opens a real `serialport` (`serial.rs:352-376`).
- The browser dev server cannot reach `invoke`. Under the CLAUDE.md SOP this change is therefore **owner hardware test required**, and the relay logs these steps in ROADMAP `next`.
- Evidence is status-only (DECISIONS 2026-09-10). These steps check what the software did, never whether the beam went dark.

**Owner steps** (Falcon connected, default per-line mode):

1. **Stop mid-frame.** Frame a design; the Frame program is M5-bracketed and the beam stays off. Press STOP halfway through.
   - The head stops.
   - The console shows "Emergency stop initiated", "STOP: 0x18 sent" and a reset line, then "Frame cancelled" or the "no longer accepting this job's lines" message.
   - There is **no** "Disconnected", and the machine still shows as connected.
2. **Frame again.** Press FRAME straight away. It runs to the end and logs "Frame complete". This proves a new job is admitted after a confirmed stop.
3. **Full job.** Run a short, low-power job on scrap to completion, with your normal precautions. Expect "Job complete". This rules out a false refusal cutting a real job short.
4. **Idle commands.** While idle, type `$$` in the console, jog once and home once. All three work.

Buffered mode is not owner-tested here. It is opt-in behind a devtools-only switch, and the default stays per-line. That gap is recorded in ROADMAP `next` beside gate D1c. The in-flight and resend-failure paths cannot be triggered by hand, so R4, R7, R8a and R8b are their only evidence.

## Files

**In scope:**

- `src-tauri/src/commands/serial_session.rs`: F1, F6.
- `src-tauri/src/commands/serial.rs`: F1.4, F1.5, F2, F3.1, F3.3, F6, F7, plus existing-test updates.
- `src-tauri/src/commands/serial_pump.rs`: `SubmissionGate`, the `Refused` outcome, `OpenGate` for its tests.
- `src-tauri/src/sim/scripted_port.rs`: write hold and write failure (test-only).
- `src-tauri/Cargo.toml`: the `[dev-dependencies] tauri` `test` feature only.
- `src/lib/machine/connection.ts`: F4.
- `src/lib/machine/jobStream.ts`: F5.
- `src/lib/machine/__tests__/serialTraceHarness.ts`, `jobStream.test.ts`, `connection.test.ts`.
- `src/components/panels/__tests__/machineJobLoop.test.tsx`: only the arg assertions the new key breaks, plus T7's Frame check.
- `ARCHITECTURE.md`: F6.
- `ROADMAP.md`: owner steps in `next`, the Parking Lot lines under Deferrals, and the shipped line (relay-design).

**Out of scope:**

- `src/lib/machine/jobSession.ts`. It already exposes `jobId`, and `end("unknown")` already retains `jobRunning`.
- `JobActionBar.tsx` and `MaterialTestDialog.tsx` (frozen). Both already pass a session, and the STOP button is already enabled whenever `jobRunning` is true.
- `src-tauri/src/lib.rs`. No new command.
- `src-tauri/src/sim/grbl.rs` simulator physics.
- All G-code generators.
- The per-line `$32` gate (batches 2.1/2.2).
- The stop's `0x18` sequence (Steps 1-6 up to the banner wait). Only Step 2's flag clears and the result construction change (F1.5).
- `.claude/DECISIONS.md`. The implementer **proposes** this engineering pin in the relay log, and Lee approves it at relay close in the structured-decisions shape. The wording is critic A1's, so no future reader "deduplicates" the second byte:
  > **A refused job line never maps to complete and never triggers a stop from TS; the backend alone re-sends `0x18` once, on the realtime handle, after a detected in-flight line.** One stop may therefore put up to two `0x18` on the wire and produce two banners; that is by design and is not a retry to remove. The re-send never routes through the stop's single-flight joiner, which sends nothing. If the re-send fails, admission stays closed (the stop cannot confirm to Idle) and the operator keeps STOP.

## Deferrals

Each deferral gets a Parking Lot index line: `ROADMAP.md:414`, `## Parking Lot — every deferral, one index`.

- **Unfenced non-job writes during Stopping and Unknown.** `None`-epoch sends are not gated on phase, by design. Consequences:
  - Test Fire's `M3 S…` / `G4 P0.5` / `M5` sequence (`MachinePanel.tsx:902-904`) and console input can still reach the controller after a STOP.
  - A console send drained during a stop's observation window drops the reset banner without publishing `banner_observed`, which pushes that stop to Unknown.
  - **The re-armed `unknown` state is disarmed by any manual write that drains an ALARM line** (critic r3 A4).
    - `surfaceUnsolicited` clears `jobRunning` on any drained `ALARM` line (`connection.ts:51-53`).
    - GRBL 1.1 prints `ALARM:3` when `0x18` lands mid-cycle. This comes from GRBL source; it is not verified in this tree, and the simulator does not model it.
    - With polling suspended after the re-arm, only a `None`-epoch write drains that line: a console `$X`, Test Fire, or a settings write.
    - That drain greys STOP out while Rust is still Unknown, and reconnect becomes the only recovery.
    - The drain-timeout `unknown` shares this exposure, and has done so all along. There is no code change here.
  - Parked as "1.x follow-up: phase policy for manual writes (including the `$X`/`ALARM:3` `surfaceUnsolicited` disarm of a re-armed `unknown`)".
- **The stop's Step 5 flush is a `tcdrain` (critic A12).** This is the "blocking output drain from realtime submission" that PLAN 1.1 asked to remove. It is pre-existing, and this batch's re-send copies it deliberately. The relay log says so, and the next batch that touches the stop picks it up.
- **RF-16 remainder.** `connection.abortJob`'s stale comment and its zero callers (`connection.ts:452`).
- **Tauri scripted-port smoke** (the undelivered batch 0.1 item). This is the only end-to-end check of IPC queue ordering (critic pre-mortem #3). Kept high in the Parking Lot.
- **Buffered-mode owner test:** stays behind gate D1c.

## Done when

- **Baseline recorded at relay start:** HEAD, platform and suite counts. The caller stated **823 JS / 310 Rust**; the relay re-counts from an actual run and records any mismatch rather than assuming it.
- **New tests green and proven:** R1-R8c, F1's unit additions (including `rf15_job_end_does_not_overwrite_unknown`), the ScriptedPort record-at-release self-test, F7, and T1-T7 (including T4b (i), (ii), (iii), (iii-b) and (iv), T4c and the harness self-test).
  - Each named mutant is run through `~/marvin/scripts/mutation-battery.mjs`, with its red result saved in the journal.
  - The relay log names **the assertion that killed each mutant**, not only the test (critic r2 pre-mortem #3). A mutant killed by the wrong assertion (for example, R2's drain mutant killed by the prefix check rather than the `ReadData` check) counts as not killed.
  - The reviewer confirms each test reaches the changed production body. R1 goes through the real `#[tauri::command]`.
  - The relay log records that R2 is red today on the prefix assertion only.
- **Full suites:**
  - `npm test`: 823 plus new, 0 failures.
  - `env -u KERF_UPDATE_GOLDEN cargo test --manifest-path src-tauri/Cargo.toml`: 310 plus new, 0 failures. No golden is regenerated. No R-test takes longer than its 2 s scenario deadline.
- **Static checks, all clean or passing:**
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
  - `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
  - `npm run format:check` (prettier)
  - `npx tsc --noEmit`, `npm run lint`, `npm run build`
  - `cargo check --manifest-path src-tauri/Cargo.toml`
  - `cargo check --manifest-path src-tauri/Cargo.toml --features sim`. The ScriptedPort faults must compile under `sim` and be absent without it.
- **Zustand selector rule** checked on every touched `useStore` call (CLAUDE.md).
- **Docs:** ARCHITECTURE.md's "Admission fence" paragraph no longer describes a gap, and its admission invariant sentence matches the code.
- **ROADMAP:** `next` carries the four owner steps, flagged "owner hardware test required", and the Parking Lot carries the deferral lines.
- **Relay log:** carries the proposed DECISIONS pin (A1 wording) and the A12 note.
- **Relay log, CAS note:** the log also records that the branch (b) CAS fixes a latent Idle-over-Disconnected store (critic r3 A6). Without it, a `disconnect_inner_with_job` joiner that times out and tears down before the original stop confirms lets that stop store Idle over Disconnected. Razor must not read the CAS as belt-and-braces only.
- **Razor review**, concurrency-focused: the permit ordering and its tty assumption, the `resend_failed`/CAS interplay (B1), the lock-order table, and the re-send's lock discipline.
