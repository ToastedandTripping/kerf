# Critic review, round 2 — Fence Wiring, Batch 1.1 Reopen (RF-15), revision r1

Plan: `.claude/plans/fence-wiring-1.1-reopen.md` (revision r1, 2026-09-24)
Round 1: `.claude/plans/fence-wiring-1.1-reopen-critic-r1.md` (APPROVE WITH CHANGES; not re-confirmed here)
Rubric: `~/marvin/rules/plan-critic-rubric.md` (v2)
Reviewer: fresh critic subagent (Fable), read-only against the tree at HEAD `229398f`
Read for this review: the plan; round 1; `CLAUDE.md`; `.claude/DECISIONS.md`; `ARCHITECTURE.md` (Serial Lock Order, Machine Communication, Stop, Admission fence); `serial_session.rs` (whole), `serial.rs` (module doc, connect, disconnect, `serial_send_inner`, `serial_stream_job_inner`, `serial_stop_inner`, job begin/end, the `mod tests` block), `serial_pump.rs` (`drain_classified`, `PumpReader::available_now`, `run_buffered_pump` Phase A/B), `scripted_port.rs` (whole); `jobStream.ts`, `jobSession.ts`, `connection.ts` (`surfaceUnsolicited`, poll suspension, `disconnect`, `send`, `emergencyStop`), `JobActionBar.tsx` (handlers and the STOP button gate), `canStartJob.ts` gates, `serialTraceHarness.ts` surface, `keepAwake.ts`.

## Verdict: APPROVE WITH CHANGES

One blocking finding (B1-r2). It is the TS half of round 1's B1: the revision keeps `jobRunning` true on `in-flight-unreset` so STOP stays live, but every production stop clears `jobRunning` *before* the refusal can arrive, so in the path that actually happens the STOP button is grey and the console tells the operator to press it. The Rust fence holds regardless (admission is closed and `serial_job_begin` refuses), so the beam-safety worst case is not reopened; what is reopened is the operator's recovery, which is what round 1 made blocking. Fix is two lines of plan text and one test variant.

---

## Applicability block

**Project type:** desktop CAD/CAM controlling a laser cutter; this batch is the serial admission fence around STOP, in Rust (Tauri command bodies) and the TS transport / job loop.

| Dimension | Fires? | Tag | Why |
|---|---|---|---|
| Core 1–10 | always | GATING | — |
| X1 Physical & human safety | **yes** | **GATING** | Decides whether stale G-code (including a standalone `M3 S…`, RF-1) reaches a controller after STOP, and whether the operator can reach a second `0x18` from the app. |
| X2 Privacy | no | N/A | No personal, health, child or client data. Attested. |
| X3 Evidence & source integrity | no | N/A | No research or public claims; every claim below is a code citation. Attested. |
| X4 Audience/brand/money | no | N/A | Console strings only. |
| X5 Concurrency & re-entrancy | yes | **GATING** (X1-class) | Writer thread, stop thread, connect/disconnect, and an IPC queue that can execute a send after STOP. |
| X6 Operability | yes | ADVISORY | Released app; the operator acts on console lines and button state. |
| X7 Self-modification | no | N/A | No MARVIN gates, hooks or skills. Attested. |
| X8 Dependencies/perf/cost | yes | ADVISORY | `tauri` `test` feature as a dev-dependency; two atomic loads plus a leaf mutex per line. |

---

## Direct answers to the five probes

### (1) Is the new state machine free of lost-update races? The interleavings.

State: `phase ∈ {Disconnected, Idle, Active, Stopping, Unknown}`, `permit_generation`, `admitted_job`, `in_flight_write_detected`, `resend_failed`. Writers of `phase`: stop Step 2 (plain store Stopping), stop (a)/(b)/(c) (CAS Stopping→Idle, or plain store Unknown), `mark_resend_failed` (plain store Unknown), `serial_job_begin_inner` (store Active under `admitted_job`), `serial_job_end_inner` (store Idle under `admitted_job`, `serial.rs:1119`), `set_idle_on_connect` (plain store Idle), `set_disconnected` (plain store Disconnected).

I enumerated the writer (W) against one stop (S), a later stop (S2), connect/disconnect, and the TS invoke order. Notation: W's steps are `g0 → phase → drain → write+flush → g1 → [drop lock] → resend(×2) → mark`.

| # | Interleaving | End state | Safe? |
|---|---|---|---|
| 1 | S completes (Step 2 bump) before W's `g0` | W refused at precheck or under lock; nothing written | yes |
| 2 | W's `g0`/phase pass; S bumps during W's drain (before the write) | line lands after `0x18`; `g1≠g0` → re-send | yes: the post-write check is after the write, so a bump anywhere before `g1` is caught |
| 3 | W's write completes before the bump, `tcdrain` returns after it | false positive; extra `0x18` | yes (plan says so) |
| 4 | W marks `resend_failed` + Unknown before S reads the flag | S → (a) `SubmittedUnconfirmed`, phase Unknown | yes |
| 5 | W sets `resend_failed`, S reads it, S returns (a), W then stores Unknown | Unknown | yes |
| 6 | S reads flag false, CAS Stopping→Idle succeeds, **then** W marks | Unknown wins (plain store); S already returned `Confirmed` to TS; W returns `in-flight-unreset` | yes for admission (job begin refuses). See **A1** for the one Idle store that can still follow. |
| 7 | W stores Unknown, then S's CAS | CAS fails → (b)-fail `SubmittedUnconfirmed` | yes |
| 8 | Stale W (from S) marks *after* S2's Step 2 clear | S2 → (a) even though its own reset succeeded; or S2's CAS fails on Unknown | yes, conservative: the operator presses STOP a third time. Document (A3). |
| 9 | S2 Step 2 stores Stopping over W's Unknown; S2 banner; CAS → Idle | Idle | yes: this is the intended recovery, and S2's `0x18` was written after W's stale line |
| 10 | Disconnect: teardown takes `realtime` before W's re-send | W gets "not connected" → `resend_failed`, Unknown store may land after `set_disconnected` | harmless: phase Unknown while disconnected; connect stores Idle unconditionally (A3) |
| 11 | Connect after 10: `set_idle_on_connect` | Idle with `resend_failed` still true | harmless: the flag is read only in the stop's result phase, and Step 2 clears it first |
| 12 | Two STOPs: S2 joins S1 (joiner) | returns `last_stop`, writes nothing | unchanged; the re-send never uses the joiner |
| 13 | S CAS succeeds → TS `serial_job_begin` admits E_new (phase Active) → W's late Unknown store → new job's lines refused → TS `session.end` → `serial_job_end_inner(E_new)` **stores Idle** | **Idle after a failed re-send** | **not safe, but the window is the microseconds between S's CAS and W's failed re-send, into which an IPC round trip must fit. Structural, not reachable. A1.** |

Verdict on (1): no lost update that opens admission except #13, which the plan's own text claims is impossible ("`serial_job_end_inner` … cannot overwrite Unknown") and is closed by one CAS. Every other ordering ends Unknown or in a confirmed-reset Idle. `Ordering::SeqCst` on every atomic makes the "phase before generation" argument hold across threads.

One order change to flag: today's confirmed branch does `increment_epoch(); set_idle()` (`serial.rs:1039-1040`). The plan's (b) does CAS first, then increments. Between the CAS and the increment, `serial_job_begin_inner` can admit a job under the *old* epoch (`:1096`), which the old TS session's `serial_job_end(E_old)` would then match and end. Same nanosecond-class window as #13; keep today's order (increment, then CAS). Folded into A1.

### (2) After `in-flight-unreset` → `"unknown"` with alarm set: can the operator recover, can a job start, can anything auto-send?

**Rust side, yes.** Phase Unknown, `admitted_job` None. `serial_job_begin_inner` refuses (`:1089`). A second STOP → Step 2 clears both flags, stores Stopping, bumps, writes `0x18`; on a banner the CAS Stopping→Idle succeeds → Confirmed → Idle; a new job is admitted. If that `0x18` fails → `SubmissionFailed`, Unknown, and reconnect (DTR toggle + `0x18` + banner, `serial.rs:290-312`) is the remaining path and does a real reset. The F6 invariant sentence is right.

**TS side, not as written — this is B1-r2.** `JobActionBar.handleStop` (`:115-117`) is `stopActiveSession(); setJobRunning(false); await emergencyStop()`. `pauseJob` (`jobStream.ts:42-43`) and `connection.disconnect()` (`:240-242`) do the same. The Rust stop that produces the refusal is invoked *after* `setJobRunning(false)`, so by the time the per-line `send` resolves `refused: in-flight-unreset`, `jobRunning` is already false. `session.end("unknown")` (`jobSession.ts:211`) merely *does not clear* `jobRunning`; it does not set it. Result: `jobRunning === false`, STOP disabled (`JobActionBar.tsx:296`), `machineState === "alarm"`, and the console says "then press STOP". The one case where `jobRunning` would still be true — a refusal with no TS stop — is the R6 class, which the plan itself says is not a reachable production sequence.

What the operator can then do: START/FRAME are gated by `canStartJob` (`machineState === "alarm"` refuses, `:172`) and by `beginJobSession` → `serial_job_begin` refuses (phase Unknown). So nothing starts. Recovery is disconnect → connect, which the message does not say. **Nothing auto-sends**: `refused = true` skips both post-loop `emergencyStop` blocks; polling is suspended only while `jobRunning`, and with it false the 250 ms poll resumes (that is harmless, `?` is realtime).

### (3) Does `permit_precheck` plus the under-lock check leave a path where a line is written without the authoritative check?

No. In `serial_send_inner` the sequence is precheck → `lock` → `try_permit_begin` → `PumpFlight` → drain → write; the precheck can only return early, never skip. In `serial_stream_job_inner` it is precheck → lock → `try_permit_begin` → `$32=1` bracketed by begin/end → per-line `gate.begin()` in Phase A after the abort check and before `write_all`, `gate.end(g0)` after `flush`. The window between the `$32=1` bracket's `end` and the first line's `gate.begin()` contains only reads (the `$32=1` pump and the second drain). The `None` path is untouched. Two things worth pinning in review: `permit_precheck` must capture no generation (the plan says so — if it did, a reviewer might be tempted to reuse it as `g0`, which would widen the window to include the lock wait), and the precheck's `permit_prechecked` emit takes the `observer` leaf before `command` is held, which the lock table allows.

### (4) Does every mutant go red? Does any test depend on real time?

Checked each against the code paths:

- **R1** (a)(b)(c): red for the stated reason; the wrapper passes `None` (`serial.rs:545`). (c) must assert on the trace, not on `Ok` — the console send's pump will hit EOF on an exhausted script and return `Err("disconnected: …")` while the write is in the trace. The plan says "still writes"; keep it a trace assertion.
- **R2**: red today on the prefix only, as stated. **The "move the under-lock check after the drain" mutant is not detectable by the `ReadData` assertion as scripted.** `drain_classified` reads only what `available_now()` reports (`serial_pump.rs:326`), and `ScriptedPort::bytes_to_read` counts queued `Data` steps up to the first `Timeout`/`Hold` (`scripted_port.rs:389-402`). After the stop's `try_lock` read has consumed the banner, an exhausted script reports 0, the mutant's drain reads nothing, no `ReadData` is traced, and the mutant survives. The script needs a decoy `Data` step (e.g. `ok\n`) queued after the banner so the mutant drain produces a `ReadData` after the `stale_send_begin` marker. Name it in the plan (A2).
- **R3**: red today (`:458` passes before the lock wait; `:498` reports after the write). Green path is event-driven; the trace wait for `permit_prechecked` costs nothing because the emit precedes the lock wait.
- **R4 / R7**: red today (no re-send exists). Trace order works because the held write is recorded at release, so the trace reads `[Realtime 0x18 (stop), Writer line, Realtime 0x18 (re-send)]`. The "route through `serial_stop_inner`" mutant goes red because the joiner writes nothing; it may also spin the joiner's 3 s poll, which the 2 s scenario deadline reports as a failure — still red, just slower.
- **R5 / R6**: red for the stated reasons.
- **R8a**: red as designed, **but only because `stop_confirming` is emitted between the `resend_failed` read and the CAS.** If a later refactor moves the emit above the flag read, the observer's `mark_resend_failed` is caught by branch (a) and the CAS mutant can no longer be reached — R8a goes tautological while staying green. Pin the emit position with a comment naming R8a (A8).
- **R8b**: red on both mutants, provided `fail_writes_after(role, n)` counts `write()` calls and not `flush()`; the stop does `write_all` then `flush` on the realtime handle (`serial.rs:968-971`) and ignores the flush result, so the count is what decides whether the re-send's first attempt is write #2. State the counting rule (A5).
- **T1–T7**: red for the stated reasons. **T4b is green against the production STOP order while the property it names is false there** — see B1-r2; T4b as written closes admission from the harness with `jobRunning` still true, which is the sequence production never runs.
- **Real time:** no R-test waits on the stop's 3 s deadline if every stop has a readable banner; the `HoldUntilRelease` poll is a 5 ms sleep loop, bounded by the release; `run_scenario` at 2 s turns any fall-through into a loud failure. The stop's banner loop with a no-op sleeper busy-spins `try_lock` while a sender is parked in a write hold (R4, R7, R8b) — CPU, not wall-clock. TS tests: the refused paths never reach `session.drain`, so no 200 ms polls; T7's negative control refuses on the first line. Nothing depends on wall-clock.

### (5) DECISIONS contradictions?

None found.
- **2026-09-20 abort ruling.** The stop's Steps 1–6 are untouched; only Step 2's two flag clears and the result construction change. The re-send is a realtime `0x18` with the A6 retry, no hold, no M5, no ack wait. Its `flush()` is a `tcdrain` on the output queue, copied from the stop's own Step 5 (round 1 A12, deferred); it waits on the OS output queue, not on a controller reply, so it is not an ack-awaited write.
- **2026-07-05 pin as amended 2026-09-22** ("no ack-awaited write in the abort path stands"). Same answer. The writer never waits on the stop and the stop never waits on the writer.
- **`$32=1` pin / START gate (2026-09-10).** The buffered `$32=1` write stays, now behind the entry permit and bracketed; the TS START gate (`canStartJob` on `grblLaserMode`) is untouched; `perLine` stays the default.
- **Status-only evidence (2026-09-10).** Owner steps are status-only and say so.
- **Pause is stop (2026-09-10).** `pauseJob` still routes through `emergencyStop`; it is one of the three paths that clears `jobRunning` first (B1-r2).

---

## Core dimensions

1. **Problem-fit — PASS.** `## Intent (grilled)` present with a skip line naming RF-15 and the 2026-09-22 ruling; goal matches Summary. No DECISIONS contradiction (probe 5).
2. **Approach soundness — PASS.** Prevention under the lock, detection after the write, ordered realtime re-send, and a CAS so a confirm cannot reopen admission over a writer's Unknown. The plain-store-Unknown-wins choice is the right one: every ordering in the table above ends conservative.
3. **Completeness — CONCERN.** (a) The `in-flight-unreset` recovery contract is stated for a `jobRunning` value production never has at that moment (B1-r2). (b) The claim that `serial_job_end_inner` cannot overwrite Unknown is false in interleaving #13 (A1). (c) The disconnect-race Unknown store after `set_disconnected` is not named (A3).
4. **Right-sizing & reuse — PASS.** Waiver stated; deferrals indexed; `ScriptedPort` extended, `SubmissionGate` keeps the pump session-agnostic.
5. **Security — PASS.** No secrets, local IPC, fail-closed on the buffered command's missing key.
6. **Failure modes — PASS.** Re-send failure, sink failure, disconnect race, unconfirmed stop, and the stale-mark-poisons-later-stop case (#8) all end closed or conservative.
7. **Change safety — PASS.** One integration unit, revertible, owner steps named.
8. **Data integrity & compatibility — PASS.** No saved artifacts; IPC key follows the `jobId` precedent.
9. **Verifiability — CONCERN.** R2's drain mutant is undetectable without a decoy (A2); R8a's red depends on an emit position nothing pins (A8); T4b cannot observe the production STOP order (B1-r2); `fail_writes_after`'s counting rule is unstated (A5).
10. **Maintainability — PASS.** Constants, one prefix, doc corrections, the lock table entry for the re-send.

## Conditional dimensions

- **X1 Physical & human safety — CONCERN (gating).** Admission closes on every failure path in Rust, including the re-send double failure, and the re-send is ordered after any in-flight line. The concern is human: at the one moment the software says "use the physical stop, then press STOP", the STOP button is disabled and the actual recovery (reconnect) is not named. Worst physical outcome of the residual: none new — no job can start from Unknown — but an operator who reads "press STOP", finds it grey, and starts clicking is not in a state anyone designed. Fix in B1-r2. Interleaving #13 is the only path to Idle after a failed re-send; unreachable in practice, one CAS to close (A1).
- **X5 Concurrency — PASS (gating).** Enumerated above. Lock order unchanged and correct: the re-send takes `realtime` with `command` dropped; connect's nesting (`command` then `realtime`) cannot cycle with it.
- **X6 Operability — CONCERN (advisory).** The "sent" console line is logged before the invoke (`connection.ts:272`), so a refused job line shows as "sent" then "Not sent" (A6). With `jobRunning` re-armed per the B1-r2 fix, polling stays suspended until STOP — consistent with the drain-timeout `unknown` and worth one sentence in the message.
- **X8 Dependencies — PASS (advisory).** Unchanged from round 1.

---

## Blocking findings

**B1-r2. The TS half of round 1's B1 does not take effect in any production stop path, and the console message tells the operator to press a disabled button.**
Mechanism: `handleStop` (`JobActionBar.tsx:115-117`), `pauseJob` (`jobStream.ts:42-43`) and `disconnect()` (`connection.ts:240-242`) all call `setJobRunning(false)` *before* `emergencyStop()`. The Rust stop that produces `refused: in-flight-unreset` runs inside that `emergencyStop`, so the refusal always resolves with `jobRunning` already false. `session.end("unknown")` only refrains from clearing `jobRunning` (`jobSession.ts:211-215`); it never sets it. Net: STOP disabled (`JobActionBar.tsx:296`), `machineState` alarm, START/FRAME refused by `canStartJob` and by Rust, and a message that says "then press STOP". T4b as specified closes admission from the harness with no TS stop, so it passes against code that has this behaviour.
Fix (plan text, small):
1. In the `in-flight-unreset` branch, before `session.end("unknown")`, re-arm explicitly: `if (useStore.getState().machineConnected) store.setJobRunning(true)`. This re-enables STOP, keeps keep-awake held, blocks START/FRAME (`canStartJob` "Job already running"), and suspends the poll, exactly as the drain-timeout `unknown` does today. The `machineConnected` guard is for the A10 disconnect race: after teardown there is no STOP to re-arm and a true `jobRunning` on a disconnected app would block START after reconnect until a spurious STOP.
2. The message becomes: "…Use the machine's physical stop, then press STOP in Kerf; if STOP cannot confirm, disconnect and reconnect." Operator recovery is now stated for both outcomes.
3. T4b gains the production variant: perform `handleStop`'s sequence (`stopActiveSession()` not awaited, `setJobRunning(false)`, `await emergencyStop()`) with the per-line send deferred, release it as `refused: in-flight-unreset`, then assert `jobRunning === true`, `machineState === "alarm"`, `endState === "unknown"`, zero further `serial_send`, exactly one `serial_stop`. Mutant: drop the re-arm → `jobRunning === false` → RED. Keep the existing T4b (no TS stop) as the R6-class control. A second variant with `machineConnected === false` asserts `jobRunning === false`.
4. Then a second STOP press must be shown to work in the harness: `handleStop` again → `serial_stop` → fence model confirms → Idle; `beginJobSession` succeeds. That is the recovery the F6 sentence promises; test it once.

## Advisory findings

**A1. Close the one remaining unconditional Idle store on the stop-adjacent path, and keep today's epoch order.** `serial_job_end_inner` stores Idle whenever `admitted_job == id` (`serial.rs:1119`). In interleaving #13 (stop CAS → new job admitted → writer's late `mark_resend_failed` → new job refused → `serial_job_end(E_new)`) that store overwrites the writer's Unknown after a failed re-send; the plan's sentence "it cannot overwrite Unknown" is false for that ordering. The window is microseconds against an IPC round trip, so it is structural rather than reachable, and the fix is one line: make the end transition `compare_exchange(PHASE_ACTIVE, PHASE_IDLE)` and still clear `admitted_job` and return `Ok` when the CAS fails (the job is over either way). Add a unit test: phase Unknown, `admitted_job = Some(id)`, `serial_job_end_inner(id)` → phase still Unknown. Separately, in branch (b) increment the epoch *before* the CAS, as today's code does (`:1039-1040`), so a job cannot be admitted under the old epoch between the two; incrementing before a failed CAS is harmless. Correct the F1.5 sentence accordingly.

**A2. R2's drain mutant needs a decoy.** After the stop's `try_lock` read consumes the banner, an exhausted script makes `available_now()` return 0 (`serial_pump.rs:326`, `scripted_port.rs:389-402`), the mutant's drain reads nothing, and the `ReadData` assertion cannot fire. Queue one `Data(b"ok\n")` step after the banner; assert the green path leaves it unread (no `ReadData` after the marker) and the mutant consumes it.

**A3. Document the two stale-mark orderings as expected, in the module doc.** (i) A writer from stop S marking `resend_failed` after S2's Step 2 clear pushes S2 to `SubmittedUnconfirmed` with the physical-stop line even though S2's own reset succeeded; the operator presses STOP again, and that is the conservative direction. (ii) On the disconnect race, the writer's Unknown store can land after `set_disconnected`, leaving phase Unknown while disconnected; `set_idle_on_connect` clears it and connect performs a real reset. Neither is a bug to chase; both will look like one to a future reader.

**A4. Branch (a) should clear `banner_observed` like the confirmed branch does** (`serial.rs:1038`). Not a safety issue (the next stop clears it before its `0x18`), but a stale true flag on a `SubmittedUnconfirmed` result is the kind of thing a later test reads as a signal.

**A5. State `fail_writes_after`'s counting rule**: `write()` calls only, `flush()` never counted. R8b's "the stop's own `0x18` succeeds and every later realtime write fails" depends on it.

**A6. The "sent" console line precedes the invoke** (`connection.ts:272`), so a refused job line reads "sent" then "Not sent". Either log job lines as sent only after a non-refused resolution, or accept it and say so in F4; the table's "Operator sees" column currently implies the former.

**A7. R8a's observer hook must not be the only thing that fixes the emit position.** Note in the test and beside the emit: "`stop_confirming` is emitted after the `resend_failed` read and before the CAS; R8a is tautological if it moves above the read."

**A8. R1(c) asserts on the trace, not on `Ok`.** The console send after a confirmed stop writes, then its pump hits EOF on the exhausted script and returns `Err("disconnected: …")`. The write is the evidence.

**A9. Message hygiene for the re-armed state.** With `jobRunning` true after B1-r2, the 250 ms poll is suspended until STOP (same as the drain-timeout `unknown`). One clause in the message ("status updates pause until STOP") saves a support question.

---

## Pre-mortem — "three months out, this failed"

1. **The operator hit the physical stop, saw "then press STOP", found STOP grey, and reconnected without pressing anything.** That reconnect did a DTR reset and everything was fine — but the console had lied about the recovery path, and the next time it happens the operator will not trust the message that matters. Fix: B1-r2. What we should have seen: T4b exercising the production STOP order.
2. **A real job died at line 1 with "no longer accepting this job's lines" after a STOP had just confirmed.** The reconnect-between-begin-and-send negative control (T7) is in the plan; the residual is the A1 epoch order — a job admitted under the old epoch is ended by the old session's `serial_job_end`. Nanosecond window; the fix is to keep today's order.
3. **The battery journal shows R2's drain mutant "killed", and it was not.** The mutant was killed by the prefix assertion, not the `ReadData` one, because the drain had nothing to read. The relay log would have said "R2 red on the prefix only" for today's tree and nobody would have asked which assertion killed the mutant. Fix: A2, and have the battery journal name the failing assertion per mutant.

## Load-bearing assumptions

- **LB-1 (from round 1, still unstated in code):** tty writes from cloned fds land in syscall order. The plan puts it in the module doc; keep it there.
- **LB-2 (verified):** only the stop bumps `permit_generation` in production (`serial.rs:944`).
- **LB-3 (verified this round):** every TS-initiated stop clears `jobRunning` before invoking `serial_stop` (`JobActionBar.tsx:116`, `jobStream.ts:42`, `connection.ts:240`). This is what makes B1-r2 true, and it is also what the "unknown" mapping silently assumed away.
- **LB-4 (verified):** `canStartJob` refuses on `machineState === "alarm"` and on `jobRunning` (`canStartJob.ts:172,181`), and `beginJobSession` refuses when `serial_job_begin` rejects. Rust is the fence; TS is the second layer. Both hold in the Unknown state regardless of B1-r2.
- **LB-5 (medium confidence, resolve at implementation):** `ScriptedPort`'s write hold records the write at release, so trace order is `[stop 0x18, held line, re-send 0x18]`. If the implementer records it at park time instead, R4/R7's "last Writer write is followed by a Realtime `0x18`" would pass on the *stop's* `0x18` and the re-send mutant would survive. Pin "recorded at release" in the fault's doc comment and in the test.

## Inversion

*For "map `in-flight-unreset` to `cancelled` and tell the operator to reconnect" (the alternative to re-arming `jobRunning`) to win,* the reconnect would have to be the better recovery than a second STOP. It arguably is — connect does a DTR hardware reset plus `0x18` plus a banner read, which is stronger than another realtime byte — and it needs no re-arm logic. What it costs is the stated design of the last two rounds and a keep-awake release while the beam state is unqualified. Both are defensible; the plan chose STOP-stays-live, so the plan has to make it true (B1-r2 option 1) or change the message (option 2 alone). I recommend doing both: re-arm, and name reconnect as the fallback.

*For a CAS in `serial_job_end_inner` (A1) to be unnecessary,* the writer's failed re-send would have to be unable to land after a job begin. It can, in a window no operator can hit. Cheap enough to close anyway.

*For per-window pump gating to win over per-line,* the RX budget would have to stay at 127 bytes forever. The owner's controller advertises 65536; rejection stands.

## Overall verdict

APPROVE WITH CHANGES. The revision closes round 1's Rust-side B1 correctly: the `resend_failed` flag, the Stopping→Idle CAS and the plain-store Unknown make every enumerated interleaving end closed or conservative, the lock order is intact, and nothing contradicts the abort ruling or the standing pins. The TS half of B1 does not survive contact with the production STOP sequence — `jobRunning` is already false when the refusal arrives, so STOP is grey exactly when the message says to press it — and the test that would have shown it (T4b) is built so it cannot. That is a small text fix and one test variant, not a design change. The remaining items are a decoy for R2's drain mutant, a CAS in `serial_job_end_inner` to make the plan's "cannot overwrite Unknown" claim true, and documentation of two stale-mark orderings that will otherwise be filed as bugs.

## Must-fix, prioritised

1. **B1-r2** — re-arm `jobRunning` (guarded on `machineConnected`) on `in-flight-unreset`, fix the message to name reconnect as the fallback, and add the T4b production-order variant plus the second-STOP recovery test.
2. **A1** — CAS Active→Idle in `serial_job_end_inner` with a unit test; keep increment-then-CAS order in branch (b); correct the F1.5 sentence.
3. **A2** — decoy `Data` step after the banner in R2 so the drain mutant is detectable; journal names the killing assertion.
4. **A7 / A5 / LB-5** — pin the `stop_confirming` emit position, the `fail_writes_after` counting rule, and "write hold records at release".
5. **A3, A4, A6, A8, A9** — as written; none blocks.
