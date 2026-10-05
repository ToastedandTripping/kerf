## Applicability

Project type: Complex desktop laser-control software change: STOP reachability, asynchronous controller-state accounting, and a native-dialog/reload interlock. Reviewed revision 6 as an independent critic; current design, transition table and batch tests are normative, as the plan requires. Line references below are to `kerf-stop-reachability.md` unless a source file is named.

- Core 1–10: all active [GATING]: Problem-fit; Approach soundness; Completeness; Right-sizing & reuse; Security; Failure modes; Change safety; Data integrity & compatibility; Verifiability; Maintainability.
- X1 fires [GATING]: operator controls dispatch laser-controller resets and M5; an incorrect interlock can leave emission or motion behind an input-blocking dialog.
- X2 does not fire — N/A: this change does not introduce handling of personal, health, child or client records; existing generic project persistence is not a personal-data feature in this plan.
- X3 fires [GATING]: controller, bridge and platform claims are load-bearing evidence for safety decisions and release claims.
- X4 fires [ADVISORY]: operator messages and release notes are public-facing output; no invoice, legal term or signature is involved. Safety consequences of misleading copy are also judged under X1.
- X5 fires [GATING]: concurrent IPCs, retries, late replies, re-entry and navigation share controller state; X1 makes this gating.
- X6 fires [ADVISORY]: this ships in a desktop application with automatic connection, watchdogs and operational recovery.
- X7 does not fire — N/A: Kerf's machine interlock and project lint rules are not changes to MARVIN's own gates, hooks, skills or automation; invoking existing review/mutation tooling does not activate X7.
- X8 fires [ADVISORY]: STOP is latency-sensitive and creates native blocking tasks; polling, outstanding requests and a pinned external bridge affect performance and dependency risk.

## Dimension verdicts

PASS — 1. Problem-fit [GATING]: the grilled-intent skip is written, the Summary targets the reported STOP holes, and D1–D3 match the recorded owner rulings; the defects below are failures to deliver that intent.
FAIL — 2. Approach soundness [GATING]: the claimed lifetime exclusion permits a possibly energizing connect/reset after dialog admission (F1); block non-emergency energizing entry points and resolve the emergency-reset exception explicitly.
FAIL — 3. Completeness [GATING]: disconnected-dialog/late-auto-connect and reset-under-open-dialog schedules are missing, despite being admitted by the command table (F1); add real-wrapper tests in both directions.
PASS — 4. Right-sizing & reuse [GATING]: shared normalization, batch ownership/dependencies, the nine-file and subsystem waivers, and ROADMAP deferral entries satisfy the structural rubric; the bridge deferral's safety argument still fails F2.
PASS — 5. Security [GATING]: no new secret, permission or remote trust boundary is introduced; DOM fault text uses `textContent`, and syntax-rule limitations are disclosed.
FAIL — 6. Failure modes [GATING]: a transport failure is assumed to terminate native work and elapsed time is treated as canceled navigation (F2, F4); retain exclusion until completion/cancellation is established, or change those designs.
CONCERN — 7. Change safety [GATING]: code rollback is explicit, but the expanded accidental-reset paths are called “not a hazard” despite startup-block emission (F1); correct the risk assessment and make isolated-power/startup checks prerequisites to reset qualification.
FAIL — 8. Data integrity & compatibility [GATING]: the authoritative in-flight set can cease representing live native work if bridge fallback overlaps its first execution (F2); prove execution lifetime or represent ambiguous native work conservatively.
FAIL — 9. Verifiability [GATING]: normative tests demand mutually inconsistent reset output states and W5 cannot produce its claimed reservation through the real exclusion path (F3); repair the oracles and test bridge/lifetime counterexamples.
CONCERN — 10. Maintainability [GATING]: non-normative history is labeled, but current tests, risk prose and indexed deferrals still contain obsolete reset-clear claims (F3); reconcile the normative sections and ROADMAP against the authoritative table.
FAIL — X1. Physical & human safety [GATING]: permitted operations can energize the controller while a native dialog remains open, and accidental resets are incorrectly declared harmless (F1); establish an interlock or explicit qualified prerequisite for those paths before claiming closure.
FAIL — X3. Evidence & source integrity [GATING]: “every native execution … has returned” is not established by the cited JS bridge, and five seconds of page survival does not prove navigation failure (F2, F4); provide the missing platform evidence or remove reliance on the claims.
CONCERN — X4. Audience, brand & money accuracy [ADVISORY]: “nothing is admitted while one is open” and “not a hazard” overstate the actual command policy (F1); narrow operator/release claims only after the remaining hazards have a concrete control.
FAIL — X5. Concurrency & re-entrancy [GATING]: auto-connect can cross the open-dialog interval, fallback executions lack lifetime accounting, and pending navigation can outlive its flag (F1, F2, F4); test and close all three schedules.
CONCERN — X6. Operability & observability [ADVISORY]: the welcome-guide timer restores controls without knowing navigation was canceled (F4); use a recoverable lifecycle with an observable terminal outcome.
PASS — X8. Dependencies, performance & cost [ADVISORY]: no package is added, attempt retention is capped, native request growth is acknowledged, and the plan explicitly measures 1,000 outstanding presses; bridge correctness remains a separate gating defect.

## Findings and required corrections

### F1 — P0: the dialog exclusion does not exclude operations the plan itself says can energize the laser

Design D's admission table excludes `serial_connect` from the refused commands and exempts byte `0x18`; `serial_stop` bypasses the wrapper entirely. Design G then promises: “So no job begins, no line or motion byte is written, and no stream starts while a dialog is open.” Physical failure outcomes goes further: “nothing is admitted while one is open.” But Diagnosis 10 says connect writes a reset and that “the controller can command output that no Kerf byte contains.” Updating `outputMayBeOn` after admission does not close an already-open native dialog.

A concrete existing entry point makes the connect case more than a hypothetical new caller. `MachinePanel.tsx:338` starts `autoConnect()`. In `connection.ts:461–468`, auto-connect awaits `listPorts()` **before** it invokes `connect()`. That wait is not in the planned ledger. Schedule: hold `listPorts`; while disconnected and the ledger is empty, open a guarded native file dialog (explicitly allowed by Design G); resolve `listPorts`; auto-connect posts `serial_connect`, which is not an admission. Native connect toggles DTR and writes `0x18` (`serial.rs:342–366`). Under the plan's startup-block model, this can command emission or motion while the native dialog remains open. Subsequent settings sends being refused does not undo the reset. The same omission applies to reconnect requests that arrive during the dialog lifetime.

There is also a required emergency exception, not solved by refusing connect: B4 T6 and W6 deliberately allow STOP while the surface remains open. A clean M5 before opening does not disable stored startup blocks. STOP or the exempt raw soft reset can invalidate that off state and run startup code under the dialog. STOP must not be delayed or refused, but that requirement does not prove the remaining window safe. The plan currently has neither a dialog-dismissal contract nor a qualified controller prerequisite that resolves it.

The new reachability paths also amplify accidental-reset exposure. Design A says a click meant for the dialog corner can reset the controller, “a lost job or lost homing, not a hazard”; R1, R9 and R13 repeat that assessment. It contradicts revision 6's reset model. Merely listing the overlap is no longer an adequate answer if a dialog's ordinary action is underneath a potentially energizing STOP.

Required correction: refuse/defer `serial_connect` and other non-emergency startup-triggering operations for the entire blocking-surface interval, including delayed auto-connect. Separately specify how an unconditional emergency reset and an already-open native surface coexist safely: for example a demonstrably effective surface lifecycle plus an explicit controller qualification requirement, or a design avoiding the blocking surface. Do not add work before the reset or silently add an M5 to STOP. Require tests for disconnected Open → delayed auto-connect, connected Open → reconnect, and Open → STOP/soft-reset with modeled startup output; the assertion must cover surface/input state as well as the boolean. Reassess overlapping dialog controls and accidental chords as possible physical hazards. Make power isolation and the startup configuration check prerequisites to owner reset tests; D-10 currently appears after checks that already reset/Home the controller.

### F2 — P0: the “pinned fact” about IPC lifetime is an unsupported transport inference

Diagnosis 4, line 95: “The failure handler runs after a response failed or the request never left, so any first execution has already finished or never started.” It concludes: “a settled promise means every native execution of that request has returned, or none ran.” Design D explicitly rests both clean-M5 and stop identity on that conclusion.

The installed `tauri-2.10.2/scripts/ipc-protocol.js:42–68` does not establish this. Its failure handler covers rejection of the `fetch` itself as well as response parsing. It re-sends the same message; it neither cancels nor joins a first execution nor requests confirmation that it never started. `scripts/core.js:81–110` settles the promise from a response callback and unregisters the other callback; it does not count executions. Command handlers awaiting their own `spawn_blocking` tasks prove lifetime for that invocation, not for a duplicate invocation whose response channel failed.

I exercised the installed retry script in a Node VM with a transport stub that marks the first execution running, rejects its fetch, and answers the fallback through `runCallback`. Result: `settled=true`, `retryPosted=true`, `firstNativeRunning=true`. This is a counterexample to the **JS-only proof**, not an observed WebKit failure or proof that the specific platform actually produces that transport schedule. Excluding that schedule requires evidence from the installed native custom-protocol/WebKit path; the cited JS is insufficient.

If that exclusion is false, an M3 request can settle through a retry while its original execution is still pending; a subsequent apparently clean M5 can clear the TS record; the original write can then land after the clear and after dialog admission. Likewise an uncounted native stop owner breaks the episode identity inference. Labeling duplicate sends parked does not remove these dependencies.

Required correction: trace and demonstrate the platform guarantee covering failure before dispatch, failure after dispatch, and failure while reading a response, or change execution accounting/transport behavior so ambiguity remains blocking until native completion is known. Test the actual bridge with an execution held across fallback settlement. Do not declare the IPC assumption resolved or copy it into ROADMAP as a fact until then. A native operation id alone is insufficient unless its lifetime accounts for every execution.

### F3 — P1: current acceptance oracles still contradict the new policy

B1a line 455 requires a clean confirmed STOP to yield “`confirmed`, and output off.” B1a line 463 requires the same clean confirmed reset to leave output “on”; the authoritative table also sets every STOP to on. These are both current batch tests, so the history disclaimer cannot settle the conflict. The correct revision-6 expectation is confirmed reset **with output maybe on**, followed by a distinct clean M5 if off is required.

B4 W5 says “the re-check fails (a `send` reserved from inside the `confirm` stub).” The flag is already held. Through the real `send`/`invokeMachine` path, step 1 refuses that send **before reservation**, so it cannot invalidate quiescence as stated. Use an actually allowed state-changing event, such as an emergency STOP, to invalidate the re-check; keep the refused-send case as a positive control that no reservation occurred.

The revision drift is not confined to history: the Deferrals block and actual ROADMAP's Fire entry still say “an acknowledged `M5` or a confirmed stop.” Diagnosis 10's realtime-byte row says “no new on command” for soft reset before a later row correctly says the opposite. Correct those copies. Explicitly seed clean M5 evidence in browser/dialog positive controls following auto-connect; merely reaching fresh Idle no longer enables Open.

Required correction: reconcile all current reset, connect and open-dialog fixtures against the authoritative table, specify necessary setup rather than silently resetting module booleans, and retain negative mutations proving that confirmed STOP never clears output. Add F1 and F2 schedules independently of the table; deriving every test from the table cannot discover omissions in the table.

### F4 — P1: a surviving page is not evidence that its reload was canceled

Design G lines 368 and 378 releases the flag after 5,000 ms if the page survives: “navigation refused or failed.” The observable fact is only that the old document still runs. The plan supplies no bound on navigation completion, no cancellation acknowledgment, and no cancellation operation. Schedule: reload remains pending beyond five seconds; timer clears the flag; a job starts; navigation finally replaces the document, removing STOP and its module state mid-job. W1 only stubs reload to do nothing and therefore cannot distinguish that schedule from terminal failure.

Required correction: do not use elapsed time as proof of cancellation. Prefer showing the Welcome Guide without discarding the page, or define a native/navigation lifecycle that proves failure/cancellation before releasing admissions. If the chosen API cannot provide that proof, record that limitation and re-plan the recovery instead of declaring every exit covered. Add a delayed-navigation case in which the old page survives past the grace interval and then navigates; admissions must not resume into that pending navigation.

## Three stress tests

### Pre-mortem

Three months out, the type-specific worst case is a stationary laser beam burning material or injuring an operator while a native dialog or discarded window prevents software STOP.

1. The operator opens a project during startup. Port enumeration finishes after Open is displayed; auto-connect resets the controller and a stored startup block energizes output. The ledger accurately records “maybe on” too late. We should have tested the disconnected-dialog interval against the pre-connect await, not only attempted START under a dialog.
2. A transport error triggers fallback during an outstanding native write. The retry answers, the ledger releases its only record, and M5 apparently clears output. A late original execution re-arms it after Open. We should have demanded native lifetime evidence instead of equating one callback with every execution.
3. Welcome Guide takes longer than its grace interval to navigate. The timer re-enables commands, the operator starts work, and the old page then disappears. We should have tested late navigation instead of only a reload stub that never navigates.

### Load-bearing assumptions

- **All possibly energizing operations are excluded during a blocking surface — confidence: low; contradicted by the specified admission table.** Consequence: F1's reset/connect path creates hazardous output under the surface. Resolve before implementation.
- **Promise settlement contains every native execution — confidence: low/unverified at the transport boundary.** Individual Rust command lifetimes are supported; failure/retry lifetime across executions is not. Consequence: both clean-M5 and stop-identity proofs fail. Resolve before implementation.
- **Five-second survival means reload cannot happen later — confidence: low; no cancellation evidence.** Consequence: admission resumes before document destruction. Resolve before implementation.
- **Raised STOP remains above all ordinary overlays in the shipped webview — confidence: medium.** Source shape and planned browser tests support it, while WebKit and hardware qualification remain explicitly owed. Consequence if wrong: first click misses STOP; retain the named desktop/hardware gate and portal fallback.

### Inversion

A native completion/identity design wins if TS cannot prove the transport lifetime on which its set depends. That condition is presently unresolved, and the installed bridge's retry behavior makes it material; “no native change” cannot substitute for the missing proof. A native solution must account for duplicate executions and ordering, not merely stamp responses with ids. A nonblocking Welcome Guide or file workflow wins if a blocking surface cannot coexist with unconditional potentially energizing resets, or reload cannot expose terminal cancellation. Those conditions are already present in this specification. A different STOP placement wins if a dialog action is physically covered by STOP: revision 6 removes the earlier basis for dismissing an accidental reset as harmless, so the measured overlap must now inform the design before it is parked.

## Overall verdict

**FAIL — gate blocked.** Revision 6 recognizes startup-block emission at dialog entry but does not carry that model through the dialog's lifetime, and it declares a transport-lifetime inference proven without evidence for the relevant failure boundary. These defects undermine physical exclusion and state accounting; the reload timer introduces a separate lifetime gap, and contradictory current tests prevent a coherent acceptance result. The reachability design and explicit qualification split do not compensate for these failures. Correct the invariants and their counterexample tests before authorizing implementation of the whole plan.

Prioritized must-fix list:

1. **P0 — F1:** close delayed auto-connect/reconnect under dialogs; resolve reset-under-dialog safety without delaying STOP; correct accidental-reset hazards and owner-check prerequisites.
2. **P0 — F2:** prove or replace the bridge lifetime assumption, covering duplicate execution after fallback settlement; update the claimed closure and ROADMAP evidence.
3. **P1 — F4:** replace timer-based navigation completion inference with a provable lifecycle or non-reloading design; test delayed navigation.
4. **P1 — F3:** repair contradictory reset-clear tests, W5's impossible reservation, positive-control setup, and obsolete normative/ROADMAP claims; add the missing adversarial schedules.
