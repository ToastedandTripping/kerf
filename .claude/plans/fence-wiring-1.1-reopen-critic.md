# Critic review, round 3 — Fence Wiring, Batch 1.1 Reopen (RF-15), revision r2

Plan: `.claude/plans/fence-wiring-1.1-reopen.md` (revision r2, 2026-09-24)
Round 1: `-critic-r1.md` (APPROVE WITH CHANGES). Round 2: `-critic-r2.md` (APPROVE WITH CHANGES). Neither is re-litigated here; this round hunts for what the r2 fold introduced.
Rubric: `~/marvin/rules/plan-critic-rubric.md` (v2)
Reviewer: fresh critic subagent (Fable), read-only against the tree at HEAD `6e3378b` (plan file modified in the working tree, read as modified)
Read for this review: the plan; both prior rounds; `CLAUDE.md`; `.claude/DECISIONS.md`; `ARCHITECTURE.md` (Status polling, Stop, Pause, Admission fence, Idle-stall, Keep-awake); `serial_session.rs` (whole); `serial.rs` (lock table, `disconnect_inner_with_job`, `serial_send_inner`, `serial_stop_inner`, `serial_job_begin_inner`, `serial_job_end_inner`); `scripted_port.rs` (`Read`/`Write` impls, `TraceEvent`); `jobStream.ts` (whole), `jobSession.ts` (whole), `connection.ts` (`surfaceUnsolicited`, `connect`, `disconnect`, `send`, `pollStatus` 3-strike, `emergencyStop`), `JobActionBar.tsx` (handlers, STOP gate), `canStartJob.ts` gates, `keepAwake.ts`, `serialTraceHarness.ts` (whole), `MachinePanel.tsx:124` (the Disconnect button).

## Verdict: APPROVE WITH CHANGES

**No blocking findings.** The r2 fold holds: the guarded re-arm cannot be raced by a second STOP from the UI (the button is grey between `handleStop`'s clear and the re-arm, so the only interleaver is `disconnect()`), the `serial_job_end` CAS leaves no path stuck in Active or Stopping, T4b (i)-(iv), T4c and the R2 decoy go red for the stated reasons, and the harness model matches the Rust state machine where the tests depend on it. The advisories below are fold-in-place items (one hardening line, one missing Rust test, two spec corrections, one documentation consequence). **None needs a fourth critic round**; the implementer folds them and the relay proceeds.

---

## Applicability block

**Project type:** desktop CAD/CAM controlling a laser cutter; this batch is the serial admission fence around STOP (Rust command bodies, TS transport and job loop).

| Dimension | Fires? | Tag | Why |
|---|---|---|---|
| Core 1–10 | always | GATING | — |
| X1 Physical & human safety | **yes** | **GATING** | Whether stale G-code reaches a reset controller, and whether the operator can reach a second `0x18` from the app. |
| X2 Privacy | no | N/A | No personal, health, child or client data. Attested. |
| X3 Evidence & source integrity | no | N/A | No research or public claims; every claim is a code citation. Attested. |
| X4 Audience/brand/money | no | N/A | Console strings only. |
| X5 Concurrency & re-entrancy | yes | **GATING** (X1-class) | Writer, stop, disconnect and poll threads; an IPC queue that resolves after STOP. |
| X6 Operability | yes | ADVISORY | Operator acts on button state and console lines. |
| X7 Self-modification | no | N/A | No MARVIN gates, hooks or skills. Attested. |
| X8 Dependencies/perf/cost | yes | ADVISORY | Unchanged from rounds 1 and 2. |

---

## Direct answers to the four probes

### (1) The guarded re-arm: can it race a second STOP, a disconnect, or the 3-strike disconnect?

**A second STOP from the UI cannot interleave.** `handleStop` (`JobActionBar.tsx:115-117`) sets `jobRunning` false before `emergencyStop()`, and the STOP button is `disabled={!machineConnected || !jobRunning}` (`:296`). So between the clear and the refusal's re-arm there is no STOP to press; the same holds for PAUSE (`:280-282`). The first moment a second STOP is possible is *after* the re-arm, and that order is exactly T4c. The TS analogue of round 2's stale-mark ordering (i) (a refusal landing after a later stop has already confirmed) is therefore reachable only through `disconnect()`, covered next. Verdict: no stuck-true and no dead-STOP from a second STOP.

**Post-re-arm second STOP is consistent.** STOP#2 → `stopActiveSession()` (session already ended, returns), `setJobRunning(false)`, `serial_stop` → Step 2 stores Stopping over Unknown, banner, CAS → Idle → `Confirmed`. `session.end("unknown")`'s `serial_job_end(E)` finds `admitted_job == None` and returns the existing non-fatal mismatch (`jobSession.ts:197-201`). If STOP#2's `0x18` fails → `SubmissionFailed`, alarm, `jobRunning` false, and the message's "disconnect and reconnect" is the path. Nothing sticks.

**`disconnect()` is the one interleaver, and the guard reads stale state in the ordering it was written for (A1).** `disconnect()` (`connection.ts:230-266`) runs `setJobRunning(false)` → `await emergencyStop()` → `await invoke("serial_disconnect")` → `setMachineConnected(false)`. The `in-flight-unreset` refusal in the A10 race is *produced by* the Rust teardown inside `serial_disconnect` (the re-send hits "not connected"), so the writer's rejection and the disconnect's resolution are two IPC responses racing to the TS event loop. When the rejection lands first, `useStore.getState().machineConnected` is still `true`, the re-arm fires, and `disconnect()` then completes with `jobRunning === true` and `machineConnected === false`. Consequences: keep-awake re-acquired and never released (`keepAwake.ts:53-62` releases only on true→false); on reconnect `connect()` re-subscribes and the next store change sets `jobPollingSuspended = state.jobRunning` (`:167`), so status never updates; START refused by `canStartJob` ("Job already running", `canStartJob.ts:181`); STOP *is* enabled (connected and `jobRunning`), so one press clears it. Fail-closed and recoverable, and per round 2's A10 the ordering needs the writer to be descheduled for seconds, so this is advisory, not blocking. The plan's sentence "the `machineConnected` guard covers the disconnect race" is nonetheless false for that ordering, and T4b(iii) tests the other ordering only. One-line hardening in an in-scope file: `disconnect()` clears `jobRunning` after `setMachineConnected(false)` (a `finally`-style tail, so a re-arm cannot survive teardown), plus a T4b(iii-b) variant that releases the refusal while `serial_disconnect` is deferred. See A1.

**The 3-strike disconnect cannot leave it stuck.** The poll is off while `jobRunning` is true, so strikes accrue only in the window between `handleStop`'s clear and the re-arm (poll resumes on the subscription at `:167`). If three strikes land first, `pollStatus` sets `machineConnected` false *before* calling `disconnect()` (`connection.ts:391-398`), so the later refusal sees the guard false and does not re-arm. If the refusal lands first, the re-arm suspends the poll and no strike can follow. Both orders end consistent.

**An in-flight poll can land one status write after the re-arm.** A `serial_get_status` issued in the resumed window resolves after the re-arm and `consumeStatusOutcome` writes the controller's real state over the branch's `"alarm"`. With `jobRunning` true, START is still refused and STOP is still live, so this is cosmetic; the message's "status updates pause until STOP" is then off by one poll. No action.

### (2) The `serial_job_end` CAS Active→Idle: can any legitimate path leave Active or Stopping stuck?

No new one. Enumerated phase writers after r2: stop Step 2 (plain store Stopping, under `admitted_job`), stop (b) CAS Stopping→Idle, stop (c)/`SubmissionFailed` (plain store Unknown), `mark_resend_failed` (plain store Unknown), `serial_job_begin_inner` (Idle→Active under `admitted_job`), `serial_job_end_inner` (CAS Active→Idle under `admitted_job`), `set_idle_on_connect`, `set_disconnected`.

- **Active.** `job_end` takes `admitted_job` first (`serial.rs:1105-1118`), and Step 2 stores Stopping and clears `admitted_job` under that same lock, so `job_end` observes either (Active, Some) or (Stopping, None). The CAS fails only when something else already moved the phase (Unknown store, Disconnected), in which case leaving it alone is the point. Active sticks only if `job_end` is never invoked, which is pre-existing and recoverable by STOP (Step 2 is unconditional).
- **Stopping.** Every exit of `serial_stop_inner` writes Idle or Unknown except branch (a), which reads `resend_failed` true; `mark_resend_failed` sets the flag *then* stores Unknown, so (a) can observe Stopping for the microseconds before that store lands, and it then lands. The joiner writes no phase. Nothing leaves Stopping standing.
- **A latent bug the CAS fixes, worth one sentence in the relay log.** Today's confirmed branch `set_idle()` is unconditional (`serial.rs:1040`), so a `disconnect_inner_with_job` joiner that times out at 3 s, tears down and stores Disconnected can be overwritten with Idle by the original stop's confirm. With the CAS Stopping→Idle that store fails and the phase stays Disconnected.
- **Acceptable and disclosed?** Yes. Unknown requires a later confirmed stop or reconnect (F6's corrected invariant sentence), and the plan says so. One disclosure gap is A2: the Rust half of that recovery ("Step 2 stores Stopping over Unknown; a banner moves it to Idle through the CAS") has no Rust test; the plan cites T4c for it, and T4c proves it against the harness model only.

### (3) T4b (i)-(iv), T4c, and the R2 decoy: red for the stated reason?

- **T4b(i)** — the production order, per-line. After `handleStop`'s sequence the harness `serial_stop` closes admission and resolves confirmed; the deferred send is rejected with the raw `in-flight-unreset` string; `connection.send` returns `[msg]`; the loop's first check sets `refused`, the branch sets alarm, re-arms (harness `machineConnected` true), logs, breaks; `refused` skips the post-loop stop; `session.end("unknown")` retains `jobRunning`. Mutant "drop the re-arm" → `jobRunning === false` → RED. Mutant "map to cancelled" → `session.end("cancelled")` clears `jobRunning` and `endState` is wrong → RED. **The "exactly one `serial_stop`" assertion also kills a missing `refused` guard on the post-loop stop with the re-armed `jobRunning`** (the post-loop `else` at `jobStream.ts:424` would fire a second `serial_stop`); worth naming as the killing assertion in the journal.
- **T4b(ii)** — buffered, same order, `Ok("refused: in-flight-unreset: …")` hits the new first branch. RED for the same two mutants.
- **T4b(iii)** — `machineConnected` false before release; mutant "drop the guard" → `jobRunning === true` → RED. Correct for the ordering it models; see A1 for the ordering it does not.
- **T4b(iv)** — no TS stop, `jobRunning` still true. RED for the re-arm mutant only if the assertion is on `endState`/`machineState`, since `jobRunning` is already true; that is fine as a control. **But "the assertions are the same as (i)" cannot include "exactly one `serial_stop`"** — with no TS stop the count must be zero, and zero is the property that matters (a refusal never triggers a stop). A3.
- **T4c** — after T4b(i), `stopActiveSession()`'s continuation clears `stoppingPromise` on the microtask queued by `session.end`'s `_settledResolve()`, which runs before `streamJob`'s own continuation, so `beginJobSession` reaches `serial_job_begin` and the model rejects → `null`. Second `handleStop` → second `serial_stop` → model confirms → Idle → `beginJobSession` returns a session. The stated mutant (model leaves `unknown`) is a harness mutant; it proves the assertion is live, and T4c does carry real TS value (a `session.end("unknown")` that failed to clear `activeSession` would fail it). What it cannot prove is the Rust recovery. A2.
- **R2 decoy** — `ScriptedPort::read` pushes `ReadData` on every served chunk (`scripted_port.rs:215`) and `bytes_to_read` counts queued `Data` steps, so a `Data(b"ok\n")` after the banner is reported by `available_now()`. Green path: the stop's `try_lock` read consumes the banner and breaks (`serial.rs:1015-1028`); the precheck refuses the stale send before the lock; nothing reads; no `ReadData` after the marker. Mutant (precheck disabled, under-lock check moved after the drain): the send takes the lock, `PumpFlight::begin`, `drain_classified` reads the decoy → `ReadData` after `stale_send_begin` → RED on the `ReadData` assertion, which is the stated reason. The prefix assertion still goes red on today's tree as the plan says.

### (4) Rust state machine vs the harness model

Model states: admitted(E) / closed(idle) / unknown / reconnected(idle). Transitions the tests depend on, checked against Rust:

| Model | Rust | Consistent? |
|---|---|---|
| `serial_stop` from admitted → closed, confirmed | Step 2 + banner + CAS → Idle | yes |
| `serial_stop` from unknown → idle, confirmed (T4c) | Step 2 stores Stopping over Unknown, banner, CAS → Idle | yes |
| `releaseInvokeReject(in-flight-unreset)` after a confirmed stop → unknown | round 2 interleaving #6: CAS then writer's plain Unknown store | yes |
| `serial_job_end` clears the admission, never leaves unknown | CAS Active→Idle fails on Unknown | yes, and T4c step 2 pins it (a model that cleared unknown on `job_end` would hand T4c a session) |
| `serial_job_begin` rejects in unknown | refuses unless Idle (`serial.rs:1089`) | yes |
| absent `jobEpoch` accepted | `None` bypass | yes |
| `simulateReconnect()` → idle | `set_idle_on_connect` | yes |

Two fidelity nits, neither affecting a verdict: the model's example rejection says `phase=stopping` where Rust after a confirmed stop would say `phase=idle` (tests match the prefix; the exact string is only the recorder self-test's fixture); and an in-flight refusal's record should carry `wrote: true` (the line was written), which the plan leaves unstated. The confirmed `StopResult` fixture must carry `messages: []` at least, because `emergencyStop` iterates `result.messages` (`connection.ts:545`) and a fixture without it throws into the catch, which sets alarm and logs "E-stop send failed" in every T-test.

---

## Core dimensions

1. **Problem-fit — PASS.** Intent section present with skip line; goal matches Summary; no DECISIONS contradiction (rounds 1–2 checked; the r2 fold adds no wire behaviour).
2. **Approach soundness — PASS.** Guarded re-arm is the right shape given LB-3; the STOP-button gate makes the second-STOP race unreachable by construction, which the plan could say in one sentence.
3. **Completeness — CONCERN.** The disconnect-race guard reads stale TS state in the ordering it exists for (A1); the re-armed state inherits the `surfaceUnsolicited` ALARM disarm from the drain-timeout `unknown` (A4). Both fail closed.
4. **Right-sizing & reuse — PASS.** Waiver stands; A1's fix is one line in an in-scope file.
5. **Security — PASS.** Unchanged.
6. **Failure modes — PASS.** Every enumerated ordering ends Unknown or in a confirmed-reset Idle; the CAS also closes a latent Idle-over-Disconnected store.
7. **Change safety — PASS.** Unchanged.
8. **Data integrity & compatibility — PASS.** Unchanged.
9. **Verifiability — CONCERN.** The Rust recovery from Unknown by a second stop, which the operator message and the F6 invariant both promise, has no Rust test (A2); T4b(iv)'s assertion set is mis-specified (A3).
10. **Maintainability — PASS.** Constants, CAS, doc corrections.

## Conditional dimensions

- **X1 Physical & human safety — PASS (gating).** No new path lets a job line reach a reset controller; every residual ends with admission closed and either a live STOP or a stated reconnect. The worst physical outcome of A1 is a held sleep inhibitor and a frozen status panel until one STOP press; of A4, a grey STOP with Rust Unknown, where reconnect performs a hardware reset.
- **X5 Concurrency — PASS (gating).** Re-arm vs second STOP: unreachable from the UI. Re-arm vs disconnect: consistent in one order, stuck-but-recoverable in the other (A1). Re-arm vs 3-strike: consistent in both orders. CAS: no stuck phase.
- **X6 Operability — CONCERN (advisory).** A1's stale re-arm shows up as "reconnected, status frozen, START dead, STOP lit" with no console line explaining why; A4's disarm shows up as "STOP grey right after I typed `$X`". Both need one sentence each.
- **X8 Dependencies — PASS (advisory).** Unchanged.

---

## Blocking findings

None.

## Advisory findings

**A1. The `machineConnected` guard reads stale state in the A10 ordering, so `disconnect()` needs a tail clear.** The `in-flight-unreset` refusal in the disconnect race is caused by the Rust teardown inside `serial_disconnect`, so the writer's rejection can reach TS before `disconnect()` runs `setMachineConnected(false)` (`connection.ts:260`). The re-arm then fires and survives teardown: keep-awake held, `jobPollingSuspended` true after reconnect (`:167`), START refused, STOP lit until pressed. Fix: in `disconnect()`, after `setMachineConnected(false)` (and on its catch path), `store.setJobRunning(false)`, so no re-arm outlives teardown; correct the plan sentence to "the guard covers the ordering where teardown has already been published; the tail clear covers the other". Test: T4b(iii-b) — defer `serial_disconnect`, run `disconnect()`, release the refusal while `serial_disconnect` is pending, then resolve it; assert `jobRunning === false` and `machineConnected === false`. Mutant: drop the tail clear → `jobRunning === true` → RED. Reachability is what round 2 said for A10 (the writer must lose the race to a whole stop plus teardown), which is why this is advisory.

**A2. The Rust recovery from Unknown has no Rust test.** The message says "then press STOP in Kerf", F6's invariant says "until a later stop is confirmed by a reset banner", and the only test of it is T4c against the harness model. Add **R8c `rf15_second_stop_recovers_from_unknown`**: continue from R8b's end state (phase Unknown, `resend_failed` set), run `serial_stop_inner` with a scripted banner, assert `Confirmed`, phase Idle, `serial_job_begin_inner` succeeds, and the result lacks the physical-stop line (Step 2 cleared the flag). Mutant: make Step 2's Stopping store a CAS from Active (the "never clobber Unknown" refactor someone will propose) → CAS Stopping→Idle fails → `serial_job_begin_inner` refuses → RED. Cheap, and it is the test that makes the operator message true on the Rust side.

**A3. T4b(iv) must assert zero `serial_stop`, not one.** "The assertions are the same as (i)" copies "exactly one `serial_stop`" into a variant with no TS stop. Zero is the property (a refusal never triggers a stop). State it.

**A4. The re-armed state inherits the ALARM disarm, and the manual-write deferral should name it.** `surfaceUnsolicited` clears `jobRunning` on any drained `ALARM` line (`connection.ts:51-53`). GRBL 1.1 raises `EXEC_ALARM_ABORT_CYCLE` when `0x18` lands mid-cycle and prints `ALARM:3` (from GRBL source, not verified in this tree; the sim does not model it). Polls are suspended after the re-arm, so the line is drained only by a `None`-epoch write: a console `$X`, Test Fire, or a settings write. That drain clears `jobRunning`, STOP goes grey with Rust Unknown, and the message's "if STOP cannot confirm" does not describe it; reconnect is the recovery. The class pre-exists (the drain-timeout `unknown` has the same exposure), so no code change here; add the consequence to the "phase policy for manual writes" Parking Lot line and to the ARCHITECTURE "Admission fence" paragraph, and consider one clause in the message ("press STOP before sending anything else").

**A5. Small fidelity items.** (a) "keeps keep-awake held" is release-then-reacquire (`handleStop`'s clear releases, the re-arm re-acquires); say so, or a reader will look for a continuity that does not exist. (b) In-flight refusals should record `wrote: true` in the model. (c) The confirmed `StopResult` fixture carries `messages: []` at minimum (`emergencyStop` iterates it). (d) The plan may state in one sentence why the second-STOP race is unreachable: the STOP button is disabled from `handleStop`'s clear until the re-arm.

**A6. Relay-log note, no plan change.** The CAS in branch (b) fixes a latent Idle-over-Disconnected store when a `disconnect_inner_with_job` joiner times out and tears down before the original stop confirms. Name it so Razor does not read the CAS as belt-and-braces only.

---

## Pre-mortem — "three months out, this failed"

1. **The operator unplugged mid-job, reconnected, and the status panel froze with START dead and STOP lit.** The refusal beat the disconnect's `setMachineConnected(false)` by one event-loop turn, the re-arm survived teardown, and nothing in the console said why. They pressed STOP on an idle machine and it cleared. Nobody filed it because it "fixed itself". Fix: A1. What we should have seen: T4b(iii-b).
2. **Someone "cleaned up" Step 2 so a stop never overwrites Unknown, and the physical-stop message became a lie.** Every R-test stayed green because none of them stops twice. The operator followed the message, STOP returned `SubmittedUnconfirmed` forever, and the only exit was reconnect. Fix: A2. Type-specific worst case: none new for the beam (admission stayed closed), but the recovery the message names was gone.
3. **After a real `in-flight-unreset`, the operator typed `$X` first, STOP went grey, and they reconnected without ever pressing it.** `ALARM:3` came back in the drain and `surfaceUnsolicited` disarmed the button. Reconnect did a real reset, so nothing burned, but the console's instructions did not survive the first thing a GRBL operator does on seeing "alarm". Fix: A4's sentence.

## Load-bearing assumptions

- **LB-1 (rounds 1–2, still unstated in code):** tty writes from cloned fds land in syscall order. Module doc, as planned.
- **LB-3 (verified again):** every TS stop clears `jobRunning` before invoking `serial_stop`. It is also what makes the second-STOP race unreachable: the button is grey for the whole window.
- **LB-6 (new, verified):** `pollStatus` sets `machineConnected` false *before* calling `disconnect()` on the third strike (`connection.ts:391-398`). If a later refactor moved that into `disconnect()`, the 3-strike path would acquire A1's stale-guard ordering. Worth one comment at `:391`.
- **LB-7 (new, medium confidence):** `_settledResolve()` runs before `session.end` returns, so `stoppingPromise` clears before `streamJob` resolves. T4c depends on it; if a future `end()` resolves settled after returning, T4c reports "previous job is still stopping" and the fix is an `await stopActiveSession()` in the test, not in production.

## Inversion

*For "tell the operator to reconnect, never re-arm" to win over the guarded re-arm,* the reconnect would have to be the better recovery in every ordering. It is stronger (DTR plus `0x18`), needs no A1 tail clear, and cannot be disarmed by A4's ALARM drain. What it costs is a released sleep inhibitor while the beam state is unqualified and a message that skips the app's own stop. Rounds 1–2 chose STOP-stays-live with reconnect as the fallback; A1 and A4 are the price of that choice and both are one line each. The choice stands.

*For A1 to be unnecessary,* the writer's failed re-send would have to be unable to reach TS before `disconnect()` publishes teardown. It can, in an ordering no operator will hit on purpose. One line closes it.

*For A2 to be unnecessary,* T4c would have to exercise `serial_stop_inner`. It exercises a fixture.

## Overall verdict

APPROVE WITH CHANGES, none blocking, no fourth round needed. The r2 fold is correct where it matters: the re-arm cannot be raced by a second STOP because the button is grey until the re-arm itself, the `serial_job_end` CAS leaves no phase stuck and quietly fixes an Idle-over-Disconnected store, the T4b variants and T4c go red for the reasons given, the R2 decoy is observable through `ReadData`, and the harness model agrees with the Rust state machine at every transition a test depends on. What the fold leaves is a guard that reads TS state one event-loop turn stale in the disconnect race it was written for (fail-closed, one STOP press to clear, one line to prevent), a Rust recovery path that only a TS fixture vouches for (one test), a mis-copied assertion set in T4b(iv), and an inherited ALARM disarm that the manual-write deferral should name.

## Must-fix, prioritised

1. **A2** — add R8c so the second-STOP recovery is proven in Rust, with the Step-2-CAS mutant.
2. **A1** — tail clear of `jobRunning` in `disconnect()` after `setMachineConnected(false)`, corrected plan sentence, T4b(iii-b) with its mutant.
3. **A3** — T4b(iv) asserts zero `serial_stop`.
4. **A4** — Parking Lot line and ARCHITECTURE sentence for the ALARM disarm in the re-armed state; optional message clause.
5. **A5 / A6** — fidelity items and the relay-log note; none blocks.
