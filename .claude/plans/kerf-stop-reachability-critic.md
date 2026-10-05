## Applicability

Project type: Complex, safety-critical laser-control desktop application (Tauri/React/Rust), including operator UI, command coordination and release claims. This is an independent review of revision 3, not acceptance of its fold table. References below are to the supplied plan unless another file is named.

Core 1–10: all active [GATING]: Problem-fit; Approach soundness; Completeness; Right-sizing & reuse; Security; Failure modes; Change safety; Data integrity & compatibility; Verifiability; Maintainability.
X1 fires [GATING]: STOP reachability and blocking-window admission affect access to a running laser's stop.
X2 does not fire — N/A: the changes do not introduce personal/client-record collection, storage or access; existing project-file operations are only wrapped for dialog admission.
X3 fires [GATING]: firmware, platform-input and safety-evidence claims determine engineering and release decisions.
X4 fires [ADVISORY]: operator copy and release notes are public-facing, with no money, legal terms or signature involved; physical safety is separately gated under X1.
X5 fires [GATING]: asynchronous IPC, synchronous store subscribers, repeated STOP and reconnect share state; X1 makes concurrency gating.
X6 fires [ADVISORY]: the changes ship in a desktop application and require field diagnosis and owner qualification.
X7 does not fire — N/A: this changes Kerf application code and its tests, not MARVIN's own gates, hooks, skills or automation; using relay and mutation tooling does not itself modify those systems.
X8 fires [ADVISORY]: every machine admission gains synchronous bookkeeping/listeners, and stop attempts and timers need bounded retention.

## Dimension verdicts

FAIL — 1. Problem-fit [GATING]: the required reachable STOP is still lost after stationary laser activation because Design G treats fresh Idle as quiescence despite the plan's own Fire diagnosis and DECISIONS; resolve F1 before claiming the blocking-dialog hole closed.
FAIL — 2. Approach soundness [GATING]: the positive-evidence predicate proves motion-idle, not absence of commanded hazardous output, and listener-before-reservation ordering breaks exclusion under re-entry; implement F1 and F2.
FAIL — 3. Completeness [GATING]: T1–T6 omit a settled standalone M3, an unsuccessful M5 followed by Idle, and synchronous re-entry during supersede publication; add the F1/F2 transitions and recovery criteria.
PASS — 4. Right-sizing & reuse [GATING]: the plan provides explicit subsystem-root waivers, file ownership and runnable dependencies, reuses the existing stop path, and indexes the named deferrals in ROADMAP.
PASS — 5. Security [GATING]: the design adds no credentials, remote trust boundary or dependency, and the independent banner uses textContent rather than injecting markup.
FAIL — 6. Failure modes [GATING]: a failed de-energizing send can settle the ledger and then be overwritten as eligible by a fresh Idle report; preserve hazardous-output uncertainty independently of successful motion polling (F1).
PASS — 7. Change safety [GATING]: reverse-dependency reverts, unchanged native stop semantics, runtime-only state and explicit owner checks provide an actionable recovery path; reverting B4 is correctly disclosed as reopening the old hole.
CONCERN — 8. Data integrity & compatibility [GATING]: Design D gives a late prior-connection reply permission to raise the floor but does not specify connection attribution for a fault while processing that reply; specify and test whether an old reply may poison the new connection's fault flag/banner, while preserving conservative handling of current-connection faults (F4).
FAIL — 9. Verifiability [GATING]: the extensive matrix does not exercise F1/F2, and the alias-proof enforcement claim exceeds the stated scan; add independent counterexample fixtures and source-scan escape tests (F1–F3).
CONCERN — 10. Maintainability [GATING]: the absolute claim “Enforcement that aliases cannot evade” is unsupported by the listed lexical patterns; define an enforceable source convention or use syntax-aware restrictions with bypass fixtures (F3).
FAIL — X1. Physical & human safety [GATING]: the laser can remain commanded on while a newly allowed native dialog captures input or Welcome Guide discards STOP; an Idle report cannot serve as the missing output interlock (F1).
FAIL — X3. Evidence & source integrity [GATING]: Design G's “positive evidence” conclusion contradicts Diagnosis 6 and DECISIONS' stationary-M3 evidence; narrow the claim and supply a separate commanded-output exclusion proof (F1), and withdraw the absolute scan guarantee (F3).
CONCERN — X4. Audience, brand & money accuracy [ADVISORY]: D1 says Shift+Esc has “no typing system or keyboard layout” that claims it while Design C explicitly leaves composing-engine interception to D-7; use the same qualified delivery claim in D1 (F5).
FAIL — X5. Concurrency & re-entrancy [GATING]: invokeActivity calls its publishing listener before raising its counter/generation, allowing a synchronous subscriber to enter a dialog before the original admission is posted; reserve before callbacks and test re-entry (F2).
CONCERN — X6. Operability & observability [ADVISORY]: R11 names restart as recovery from a permanently outstanding IPC, but restart discards software STOP while controller activity may persist; specify physical-stop-first recovery and preserving unsaved work where possible (F6).
CONCERN — X8. Dependencies, performance & cost [ADVISORY]: “Counts are integers, so memory is bounded whatever happens” bounds bookkeeping, not the promises/native tasks from 100 unresolved presses; scope the claim to tracked state and measure the outstanding-request behavior without throttling STOP (F7).

## Findings and concrete repairs

### F1 — Fresh Idle does not exclude stationary commanded emission (blocking)

Design G lines 303–310 admits a connected machine when it is idle, fresh, has no pending flags and idleProven(). Line 316 calls this “positive evidence.” Yet Diagnosis 6, line 114, explicitly says “the store can read idle ... while the beam is commanded on (Fire).” This is not merely the unavoidable inability to observe photons. Kerf can itself have commanded the spindle on, and the predicate ignores that fact.

Counterexample: send a console M3 with positive S in the applicable modal state; receive ok; receive a new Idle report after the send has settled; choose Open or Welcome Guide. There is no job session, motionPending need not be true, both counts are zero, and idleProven becomes true. Open can capture STOP input; reload destroys it. The stationary commanded output has not been cancelled. The project's .claude/DECISIONS.md:178 explicitly records that standalone positive-S M3 can light a stationary beam in G1 modal state and that Fire deliberately uses console-style M3. No new external firmware assumption is necessary to identify this contradiction.

The failure variant is also missing: Fire sends M3, dwell, M5; M5 fails or returns a controller error; a later Idle report arrives. connection.ts:650–725 returns responses/errors rather than guaranteeing successful deactivation, and MachinePanel.tsx:1128–1130 awaits sends without validating an off result. Tracking only the sends' lifetimes loses the hazard when those lifetimes end. T5 (line 422) checks held sends and the instant before a new poll, stopping exactly before this hole.

Required repair: define persistent commanded-output/unknown-output exclusion for blocking surfaces, with explicit handling of raw console commands, Fire, failed off commands and initial/reconnected state. Specify what evidence can clear that exclusion; neither Idle nor the vendor A:S flag is a beam-off proof (DECISIONS:282–285). If that cannot be established within TB1, keep blocking surfaces unavailable in the ambiguous state or choose a nonblocking product path and re-plan the scope. Do not insert M5 or waits ahead of STOP. Add real-module/mock-wire transitions for standalone M3→ok→fresh Idle→Open/reload and Fire→failed M5→fresh Idle, including a safe-clear positive control. Record hardware limits without claiming optical certification.

### F2 — The exclusion check is not atomic with respect to synchronous observers (blocking)

Line 235 specifies: “Otherwise it calls the activity listener ... raises the in-flight count and the generation, and calls invoke.” Design D says that listener publishes via Zustand, whose synchronous subscribers are explicitly acknowledged in the plan.

Start from fresh proven Idle with a settled confirmed stop line. A console send enters invokeActivity and passes blockingOpen(). Supersede clears the confirmed line and publishes. A synchronous subscriber calls guarded open() at this publication. Counts and generation are still the old values, the line is now null, and the machine has no job or provisional motion for a non-motion console command. machineQuiescent passes and blockingBegin reserves the dialog. Control returns to the original wrapper, which increments its counter and posts the command without rechecking. A machine command has now been admitted under the supposedly exclusive dialog. This is a concrete permitted re-entry schedule, not a claim that such a subscriber already exists today.

Required repair: reserve activity/count/generation before invoking any externally callable listener, keeping supersede before IPC and handling synchronous failure without leaking the reservation. Define the combined activity/stop-capable stream wrapper's reservation order as well. Test an actual synchronous store subscriber attempting open/reload during supersede; assert that no blocking surface enters before settlement and renewed proof. A same-tick test does not establish this: re-entry happens within that tick.

### F3 — Lexical scan is not alias-proof (must fix the control or its claim)

Line 324 says “Enforcement that aliases cannot evade” and concludes “A new dialog anywhere in Kerf therefore has to go through the seam.” The specified patterns miss ordinary syntax such as `const { confirm: ask } = window; ask(...)`, `window["confirm"](...)`, or `const nav = window.location; nav.reload()`. Comments stripped and a minimum file count do not cure these omissions. The native-caller scan similarly depends on a restricted source shape, so its assumptions must be explicit rather than treated as a general call-graph proof.

Required repair: reject unsupported access forms through a defined syntax-aware rule, or narrow the guarantee to supported patterns with an explicit review requirement for other global/native invocation forms. Add bypass fixtures alongside the positive controls. This is a future-maintenance vulnerability, not evidence of a currently hidden dialog call.

### F4–F7 — Remaining concerns

F4: Design D says a foreign-connection result “changes neither the view nor machineState,” but the universal stopFault path marks “the connection's faulted flag” without an event connection. Hold A on connection 1, start connection 2 and confirm B, then deliver A with a throwing epochAfter getter (already a named fault fixture). Specify whether A faults connection 1 only or intentionally invalidates connection 2, and make the banner policy consistent; do not silently claim both isolation and global poisoning.

F5: D1 option (a)'s “no typing system ... claims it” overstates the separately acknowledged composing-engine uncertainty. Replace it with the bounded finding about checked defaults and delivery-dependent operation.

F6: R11 says dialogs remain refused “until Kerf restarts,” while Physical failure outcomes says “The app process exits. Nothing is sent.” Add an explicit physical-stop-first recovery instruction for this hung-request state; do not present restart as the act that makes the machine safe.

F7: Line 239's integer-counter claim is broader than B1a's 32-record retention proof. The dispatched requests and native joiners can still remain alive. Measure or document that resource limit separately, preserving the rule that every STOP dispatches; do not invent a throttle as the repair.

## Stress test 1 — Pre-mortem

Three months out, the type-specific worst case is a stationary laser continuing to burn material, potentially starting a fire or injuring the operator, while a native dialog or reload removes software STOP. A console M3 or unsuccessful Fire shutdown was followed by Idle, and the admission test treated it as safe. The warning signs were already in Diagnosis 6 and DECISIONS; T5 never advanced to the next Idle poll.

Second, an ordinary new synchronous store subscriber opens a dialog when the previous stop line clears. The original console command then passes into native beneath it. The team thought single-threaded JavaScript and “same tick” meant mutual exclusion; the specified callback ordering left a re-entry window.

Third, a native request hangs and the interface permanently refuses file dialogs. The operator restarts to recover, losing software STOP and potentially unsaved work while the controller remains active. R11 described the symptom but omitted the safe recovery sequence.

## Stress test 2 — Load-bearing assumptions

- Fresh Idle plus no in-flight commands excludes hazardous Kerf-commanded output: LOW confidence, contradicted by the plan and DECISIONS for stationary M3. Consequence: blocking UI removes STOP during emission. Resolve before implementation (F1).
- No callback can re-enter dialog admission between the wrapper's check and reservation: LOW confidence; Zustand publication expressly permits synchronous observers. Consequence: the lifetime-exclusion invariant is false. Resolve before implementation (F2).
- Every native stop owner remains contained in one of the five tracked command lifetimes: MEDIUM confidence for the inspected current source; the proposed scan protects only its recognized source forms. Consequence if wrong: the inferred stop identity can accept an unrelated historical result. Keep the assumption explicit and test source changes that evade lexical matching (F3).
- Shipped webviews deliver at least one stop chord and honor the raised in-place surface: MEDIUM confidence until D/H evidence exists. Consequence: browser success can coexist with an unreachable desktop STOP. Preserve the plan's implemented/qualified distinction; this review does not count planned owner checks as completed evidence.

## Stress test 3 — Inversion

The rejected native operation-id change wins if proving owner containment and maintaining taint/floor inference costs more than adding explicit native identity. Several preconditions already exist: a known historical-result replay, five tracked command types, cross-connection rules and a source-shape scan. The native-change boundary justifies separate planning, not treating TS inference as intrinsically simpler. Compare total proof burden before adding another inference rule.

The portal wins only if a real ancestor stacking context cannot be removed; no inspected evidence yet establishes that condition, and a body portal still cannot defeat the top layer. For blocking surfaces, a nonblocking alternative wins whenever safe admission cannot be established without disabling necessary file work. F1 shows that fresh Idle alone already fails that test; this alternative deserves consideration rather than another motion-only flag.

## Overall verdict

FAIL — do not pass the gate. Revision 3 has a materially better specification and meaningful verification infrastructure, but it still permits blocking UI after stationary commanded laser activation and specifies a non-atomic admission wrapper under synchronous re-entry. Those are failures of the proposed controls, not merely missing owner measurements. Correct the invariants and add the counterexample schedules before another critic pass; retain the separate desktop/hardware qualification status and the unchanged immediate-reset contract.

Prioritized must-fix list:

1. P0: Replace motion-idle-only dialog admission with a justified commanded-output/uncertainty exclusion, including standalone M3 and unsuccessful M5; add F1 negative and safe-clear tests.
2. P1: Reserve activity before listeners, define combined wrapper ordering, and prove exclusion against synchronous subscriber re-entry (F2).
3. P1: Repair or explicitly narrow the alias-proof enforcement claim; add bypass fixtures and source-shape obligations (F3).
4. P2: Specify late foreign-connection fault ownership and test its banner/view effects (F4).
5. P2: Document physical-stop-first hung-request recovery; qualify D1's delivery claim and bound the resource claim to what is actually tracked (F5–F7).
