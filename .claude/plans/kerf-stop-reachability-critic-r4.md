## Applicability

Project type: safety-critical desktop laser-control software (Tauri/React/Rust), including operator controls, asynchronous serial-command bookkeeping, and release-facing safety claims. Reviewed revision 4 of `kerf-stop-reachability.md`; line references below refer to that file. I also inspected the relevant connection, native serial, status-consumer, DECISIONS and ROADMAP sources. The current checkout is `545539b`; the inspected connection and native serial files have no diff from the plan's `e4af84e` baseline. This is a plan review, not hardware qualification or an implementation test run.

Active universal dimensions: 1 Problem-fit [GATING]; 2 Approach soundness [GATING]; 3 Completeness [GATING]; 4 Right-sizing & reuse [GATING]; 5 Security [GATING]; 6 Failure modes [GATING]; 7 Change safety [GATING]; 8 Data integrity & compatibility [GATING]; 9 Verifiability [GATING]; 10 Maintainability [GATING].

- X1 Physical & human safety fires [GATING]: this changes access to a laser's stop and decides when a blocking surface may obscure that access.
- X2 Privacy & data stewardship does not fire — N/A: the change introduces runtime machine state and dialog admission, not collection, retention or access changes for personal/client records; project-save compatibility remains covered by dimension 8.
- X3 Evidence & source integrity fires [GATING]: the plan makes load-bearing claims about native command ordering, reset confirmation and commanded output, and uses them to justify safety decisions and public copy.
- X4 Audience, brand & money accuracy fires [ADVISORY]: operator messages and release notes are changed; no money, legal terms or signature is involved.
- X5 Concurrency & re-entrancy fires [GATING]: overlapping IPC, native worker tasks, synchronous store subscribers and timers affect X1 safety.
- X6 Operability & observability fires [ADVISORY]: the released desktop app needs actionable failures and owner qualification.
- X7 Self-modification safety does not fire — N/A: these are Kerf application controls and repository lint rules, not changes to MARVIN's own gates, hooks, skills or automation.
- X8 Dependencies, performance & cost fires [ADVISORY]: per-command bookkeeping and repeated STOP requests affect a latency-sensitive path and outstanding native tasks.

## Dimension verdicts

1. Problem-fit — PASS [GATING]: the Complex plan includes an explicit grilled-intent skip, targets the stated STOP reachability problem, and preserves the cited reset/Pause rulings in its declared scope.

2. Approach soundness — FAIL [GATING]: request sequence numbers do not establish the wire ordering needed for either reset-based or M5-based output clearance; fix F1 before using this ledger as a dialog interlock.

**F1 — An earlier request can execute after the supposedly clearing operation.** Lines 268–269 set on state “at reservation” and clear it using “the request's own number, so any later on request still wins.” Lines 287–288 supersede only an admission requested *after* the episode begins and taint only overlapping *stop-capable* commands. These rules omit ordinary commands already outstanding when STOP is pressed.

Concrete schedule: with a known floor, reserve and post console `G1 M3 S100` as request 10, but hold its native execution before the command lock. Press STOP as request 11. Let the reset finish and return a fresh confirmed answer while request 10 remains pending. There has been no later admission, no foreign stop owner and no connection change. The plan therefore permits “Stopped” and `noteResetConfirmed(11)`, making output off. Now let request 10 execute and acknowledge. Its on effect occurred only at reservation; settlement does not reassert it. After a fresh Idle poll, all dialog predicates can pass despite the later commanded-on write. If the send instead completes before the delayed stop reply arrives, the same bookkeeping can still incorrectly clear it.

This is allowed by the inspected native source: `src-tauri/src/commands/serial.rs:718–731` runs each send in `spawn_blocking`; `serial_send_inner` takes the command mutex at lines 561–565; the non-job, non-jog branch at lines 628–630 writes without the stop admission fence. The plan itself acknowledges at line 558 that “Console, Fire and settings writes are not phase-gated natively and can land after a stop.” Its following claim that “each such send now supersedes the stop's line” is false when the request preceded the press.

The M5 path has the same problem without STOP: reserve on request 10, then off request 11; native worker/lock acquisition can execute M5 first and the on command second. The resulting `lastOffSeq = 11` still defeats `lastOnSeq = 10`. Posting IPC in one JS task does not prove FIFO acquisition of a native mutex by independent blocking workers.

**Fix:** specify a conservative happens-before rule. A reset must not confirm/clear output when an earlier potentially writing request overlaps it unless native evidence establishes its write preceded the reset. An M5 may clear only when its ordering after every potentially energizing request is established, not merely numbered later. One TS-only option is to retain ambiguity through overlapping intervals and require a new acknowledged off operation requested after all ambiguous activity has settled; STOP itself must still dispatch immediately. A native ordering token is another option, requiring an explicitly revised scope. Preserve the uncertainty after an overlapping request settles; simply waiting for counts to reach zero does not establish which write was last.

3. Completeness — FAIL [GATING]: the explicit re-entrant STOP path can insert a reset before the outer command's post without superseding that new stop; fix F2 and cover both pending-before-press and nested-press schedules.

**F2 — The listener reservation fix leaves a post-reset command hole.** Lines 260–262 order reservation, listeners, then post. Line 265 says “emergencyStop is never refused, re-entrant or not,” and line 413 expressly tests that a subscriber calling `emergencyStop()` still posts `serial_stop`.

Begin with a settled confirmed view. An outer `send("G1 M3 S100")` reserves its on effect, then supersedes that view. A subscriber reacts to the clear by calling `emergencyStop()`. That reset is posted and its episode begins inside the listener. Only after the listener returns does the outer wrapper post `serial_send`. The outer supersede event already ran before the new stop episode existed. No second supersede event is specified, and the outer ordinary send does not taint the episode. The wire can therefore receive reset then on while the new episode remains eligible for confirmation. The named test checks only that the reset was posted; it never checks this later command or the final output state.

**Fix:** a STOP occurring during an admission's listener phase must invalidate the reserved admission before its post, or permanently mark the new episode/output ordering as ambiguous. Define the post-listener recheck and its reservation cleanup explicitly. Test the actual IPC ordering and ensuing views through the real wrappers. F1's overlap rule must cover this pre-post reservation too.

4. Right-sizing & reuse — CONCERN [GATING]: the file budgets, subsystem waivers and Parking Lot entries exist, but line 502 falsely says B4 is “file-independent of B1a, B1b and B2”; correct it to acknowledge B1b's shared `eslint.config.js`, as the ownership table already does.

5. Security — PASS [GATING]: no new credentials, remote service or authorization surface is introduced; proposed restrictions narrow direct IPC/dialog access, with their static-analysis limits disclosed.

6. Failure modes — FAIL [GATING]: the independent display fault flag is absent from the dialog predicate, allowing store-publication failure to bypass the uncertain-stop exclusion; fix F3.

**F3 — A failsafe banner is not a failsafe admission decision.** Lines 300–301 allow `setStopOutcome` itself to throw and make the corrective uncertain write “best-effort.” Line 409 explicitly tests the case where that action also throws. Yet lines 343–348 consult only `s.stopOutcome?.phase` for stop uncertainty; they do not consult the module's sticky fault flag or authoritative outcome state.

Start from an off, settled-confirmed baseline. Make `beginStopAttempt` fail during compute and make both outcome publications throw, exactly as the planned fault test permits. The store can retain its old confirmed view while the module is faulted and the DOM banner says not to trust the job bar. The attempt returns 0. Once its IPC settles, the counts drop; a fresh Idle report can restore idle proof, and the previous off record can still hold. `machineQuiescent()` then accepts the stale confirmed store value and permits a blocking dialog. The proposed independent warning is visible but does not enforce the independent safety state.

**Fix:** expose a non-publishing, connection-scoped fault/uncertainty accessor and include it in the connected quiescence predicate. Make failure of that accessor refuse admission. Add an integrated fault-to-dialog test with both publications throwing, a settled IPC and a fresh Idle report; the dialog and reload must remain refused until the documented recovery clears the fault. Merely testing that the banner exists is insufficient.

7. Change safety — PASS [GATING]: the plan specifies reverse-dependency reverts, no persisted-format migration, physical-stop-first recovery, and separately tracked owner qualification; these do not cure the admission defects above but provide a concrete recovery process.

8. Data integrity & compatibility — FAIL [GATING]: F1 can record output as off and an episode as confirmed despite a later effective on write; fix command-order identity and retain ambiguity without changing persisted project data.

9. Verifiability — FAIL [GATING]: the proposed tests mostly encode the request-order assumption and omit its counterexamples; add F1–F3 schedules and mutations that fail when ambiguity/fault checks are removed.

Line 414 tests “Off requested, on requested, off acknowledged → on.” That is useful but covers only an on request numbered *after* the off. It omits on requested first but executed last, and on pending before STOP. Lines 423 and 534 test admissions *after* a stop request, not outstanding ordinary admissions before it. The same-tick test at lines 412 and 514 proves JS posting behavior, not native write order. Exercise controlled native execution/write ordering, or conservatively classify every unproven overlap in TS tests without asserting native FIFO. Use existing native test seams or a separate evidence harness if production Rust must remain untouched; no implementation mutation is required merely to expose this schedule. Include a positive control where all earlier requests have settled before a fresh off request, so the repair does not reduce to permanently refusing every dialog.

10. Maintainability — CONCERN [GATING]: the combined stream wrapper has contradictory API specifications; choose one signature and align Design D, B1a tests, B1b wiring and the scan.

Line 256 routes `serial_stream_job` through `invokeActivity(cmd, args, { stopCapable: true })`; line 420 instead specifies `invokeStopCapable` “with the activity flag”; line 406 calls `invokeStopCapable("serial_stream_job")` without describing that flag. This matters because `invokeStopCapable` explicitly skips admission exclusion at line 265. A worker following the wrong version can omit either dialog exclusion or stop taint. Define one combined operation that always performs both roles, with a direct held-dialog stream test.

X1. Physical & human safety — FAIL [GATING]: F1/F2 permit a commanded-on laser after a reset or M5 while the UI certifies off and later opens a blocking surface; establish write-order-safe clearance and fault-independent admission before implementation.

X3. Evidence & source integrity — FAIL [GATING]: “each such send now supersedes” (line 558) and “any later on request still wins” (line 269) do not support claims about later physical writes; replace those claims with a proven ordering invariant and the corresponding evidence.

X4. Audience, brand & money accuracy — CONCERN [ADVISORY]: “Stopped. The controller was reset” (line 380) can label a reset preceding a queued on write, and line 357 says deliberate disconnect “does not leave a commanded beam behind” despite permitted stop failure; fix F1/F2 and change the latter claim to “attempts a reset,” preserving uncertain guidance.

X5. Concurrency & re-entrancy — FAIL [GATING]: reserved-before-listeners protects dialog entrance but not STOP/write ordering or off-clear ordering; close F1/F2 with explicit overlap and post-listener invariants.

X6. Operability & observability — CONCERN [ADVISORY]: after a sticky display fault, “Not until the machine reports idle” (line 388) offers an ineffective recovery even when Idle is already proven; make fault refusal cause-specific and point to the existing physical-stop, save, restart sequence.

X8. Dependencies, performance & cost — PASS [ADVISORY]: no new runtime dependency is proposed, retained attempt state/timers are capped, and line 274 explicitly distinguishes those bounds from unthrottled outstanding STOP promises/native tasks.

## Stress test 1 — Pre-mortem

Three months out, the type-specific worst case is a laser firing or remaining commanded on while Kerf shows “Stopped” and a native dialog takes away software STOP; material ignition or injury is possible. First, an operator sends a console/Fire command and immediately presses STOP. The reset runs ahead of the queued command, but request-number clearance hides the later on write. The warning sign was the plan's own admission that ordinary console writes are not fenced.

Second, two machine actions overlap and M5 executes before an earlier requested on command. Both promises settle successfully, so no error path runs; the ledger labels the higher numbered M5 authoritative. The tests stayed green because they resolved promises in the intended request order without proving wire order.

Third, an outcome publication fails. The separate banner appears, satisfying the fault tests, but dialog admission continues reading the stale store view. A fresh Idle report then unlocks a file dialog despite the sticky stop-display fault. The missing signal was a cross-module test from fault injection all the way to blocking-surface admission.

## Stress test 2 — Load-bearing assumptions

- **TS request order is sufficient to establish the last commanded output. Confidence: low; contradicted by the native worker/mutex design and F2's explicit nesting. Consequence:** false off and false “Stopped,” followed by unsafe dialog admission. **Resolve before implementation.**
- **Every command capable of running native STOP is counted for its whole lifetime. Confidence: medium-high for the inspected caller inventory, conditional on correct combined-stream wiring. Consequence if wrong:** an unseen owner can reintroduce historical-result confirmation. Normalize the wrapper API and preserve the stated scan/review obligations.
- **A sticky outcome fault necessarily appears as an uncertain store view. Confidence: low; the plan explicitly allows that publication to fail. Consequence:** the visual failsafe does not keep the dialog guard closed. **Resolve before implementation** by reading independent authoritative fault state.
- **Raised STOP and at least one chord work in the shipped webview under the relevant overlay/input states. Confidence: medium pending the named owner checks. Consequence if wrong:** Chrome evidence would overstate desktop reachability. Keep qualification outstanding until D/H evidence is recorded; this plan review supplies none.

## Stress test 3 — Inversion

The rejected native-evidence alternative wins when the TS inference needs to know whether a reset/off operation preceded or followed outstanding writes, or must accumulate enough conservative rules that routine STOP/M5 rarely restores usability. Those conditions are already partly true: F1 shows the current inference is unsound and F2 adds a synchronous ordering case. A native stop operation id alone would repair identity, not order ordinary writes against a reset; the alternative must supply authoritative write/reset ordering or a fence covering those writes. If Rust remains out of scope, the conservative TS alternative must explicitly retain ambiguity and require a fresh ordered off operation. The raised-versus-portal choice does not affect any of these defects; no evidence here requires changing that UI choice.

## Overall verdict

**FAIL — gate blocked.** Revision 4 closes the previously identified simple Idle/beam-state mistake but replaces it with an unproven request-order model. The reset and M5 paths can clear commanded output even though an earlier requested ordinary write executes afterward; the permitted re-entrant STOP path creates the same inversion before IPC posting. Separately, a display fault does not reliably close dialog admission because the guard trusts a store write the fault model allows to fail. These are failures of the proposed controls, not missing hardware certification or merely conservative wording. Fix the ordering and fault invariants, then prove their counterexample schedules before implementation proceeds.

Prioritized must-fix list:

1. **P0 — F1:** make reset/M5 output clearance depend on proven happens-before ordering; retain uncertainty across overlapping ordinary writes, including those requested before STOP. Add pending-before-press and reversed-native-write tests with safe sequential positive controls.
2. **P0 — F2:** handle STOP during admission listeners before the outer post, without delaying or refusing STOP; assert the final command order, stop view and dialog eligibility.
3. **P1 — F3:** include authoritative sticky fault/uncertainty state in quiescence and test refusal with failed store publication; give a cause-specific recovery message.
4. **P1 — verification and claims:** add mutations for the new invariants and remove claims equating reservation order with wire order or an attempted disconnect reset with guaranteed commanded-off output.
5. **P2 — specification consistency:** choose one combined stream wrapper API and correct B4's file-independence sentence; preserve the existing file budget, dependency order and qualification split.
