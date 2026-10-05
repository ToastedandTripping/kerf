## Applicability

Project type: safety-critical desktop laser-controller software (Tauri/React/Rust), with concurrent serial commands, operator-facing safety claims, and release qualification. Reviewed revision 5 of `kerf-stop-reachability.md`; line references below are to that file unless a source file is named. This is an independent review, not implementation or hardware qualification.

- Core 1–10: all active **[GATING]**: Problem-fit; Approach soundness; Completeness; Right-sizing & reuse; Security; Failure modes; Change safety; Data integrity & compatibility; Verifiability; Maintainability.
- X1 Physical & human safety: fires **[GATING]** because STOP reachability and the dialog interlock affect access to a laser's stop.
- X2 Privacy & data stewardship: **N/A — does not fire**; this plan changes dialog admission, not personal/client-data collection, access, retention, or project serialization.
- X3 Evidence & source integrity: fires **[GATING]** because controller-behavior claims justify a safety interlock and operator-facing assurances.
- X4 Audience, brand & money accuracy: fires **[ADVISORY]** because it changes public release notes and operator copy; no money, legal terms, or signature is involved. Physical consequences of misleading copy are separately gating under X1/X3.
- X5 Concurrency & re-entrancy: fires **[GATING]**, as required for X1-class work: overlapping IPCs, stop episodes, microtasks, reconnects, and native dialogs share state.
- X6 Operability & observability: fires **[ADVISORY]** because this ships in the released desktop application.
- X7 Self-modification safety: **N/A — does not fire**; application ESLint rules and machine interlocks are not changes to MARVIN's own gates, hooks, skills, or automation. Recording DECISIONS is not a gate implementation change.
- X8 Dependencies, performance & cost: fires **[ADVISORY]** because every machine request gains bookkeeping, and repeated STOP requests create outstanding native tasks.

## Dimension verdicts

PASS — 1. Problem-fit [GATING]: The explicit grilled-intent skip and Summary at lines 7–11 address the actual hidden-STOP problem; preserving immediate reset dispatch and separating implementation from owner qualification match the cited DECISIONS.

FAIL — 2. Approach soundness [GATING]: The output classifier at lines 265–269 can leave `outputMayBeOn=false` after an accepted spindle-enable command; fix F1 by using controller-equivalent normalization with conservative handling of unknown syntax.

**F1 — P0: retaining comments is not conservatively over-counting.** Line 266 says, “Comments are not stripped for this rule, so `(M3)` counts as on,” and recognizes an M followed directly by 3/4 after removing whitespace. Consider sequential acknowledged commands `G1 S100`, `M5`, then `M(x)3` (or `M/3`). The first establishes positive modal S; the clean M5 sets the ledger off; the last contains neither a contiguous M3 nor an S word under the proposed normalization. Yet the existing `normalizeGrblLine` in `src/lib/machine/connection.ts:148–158` and native `normalize_grbl_line` in `src-tauri/src/commands/serial_session.rs:1008` strip comments and `/`, producing `M3`. Native `classify_outbound` accepts these printable single-line inputs and `serial_send_inner` writes them. The existing send path passes the original command to IPC; it does not repair the ledger's classifier first.

Stock GRBL removes embedded comments and slash characters before execution, and its G-code parser retains spindle speed across M5 and enables the spindle for M3 in G1 mode. Thus a subsequent Idle report does not rescue this predicate. These sources establish a supported-controller counterexample, not an observation of Lee's vendor fork. [GRBL line reader](https://raw.githubusercontent.com/gnea/grbl/master/grbl/protocol.c), [GRBL G-code parser](https://raw.githubusercontent.com/gnea/grbl/master/grbl/gcode.c).

Fix: reuse/extract the existing normalization contract rather than introducing a weaker parser. If raw comments must over-count, OR that check with the normalized-code check. Apply consistent tokenization to stream clearing too. Add both counterexamples through real `send` → ledger → fresh Idle → Open/Welcome Guide, with no new positive S in the final command; assert refusal. Do not run these with laser power enabled.

FAIL — 3. Completeness [GATING]: “Every path” in Diagnosis 10 omits controller startup programs executed by reset/connect/homing; fix F2 by accounting for these paths before treating a banner or `$H` as output-safe.

**F2 — P0: native-port coverage is not controller-command coverage.** Line 134 concludes, “Every byte that can turn the laser on is a TS string or byte passed through `serial_send`, `serial_send_byte` or `serial_stream_job`.” Line 147 labels `$H` and system/settings lines as unable to leave output on. Line 268 then accepts a connect banner or confirmed reset as clean-clear evidence. None accounts for stored `$N` startup programs. The local code already acknowledges this: `connection.ts:160–161` says a startup block runs after every reset, and native `Outbound::SettingsWrite` documents the same at `serial_session.rs:979–980`.

In stock GRBL, the initialization banner is printed before `protocol_main_loop`; that loop executes stored startup blocks when unlocked. Successful full homing also executes them. A stored `G1 M3 S100` therefore supplies a concrete counterexample: a clean reset/connect can produce the banner and then command stationary output on, or `$H` can re-enable output after a previous acknowledged M5. All tracked IPCs may settle and the next report may be Idle. The ledger then admits the blocking dialog. This is an additional commanded-on path, not the already-disclosed possibility of hardware ignoring a valid off command. [GRBL initialization](https://raw.githubusercontent.com/gnea/grbl/master/grbl/main.c), [GRBL startup and homing implementation](https://raw.githubusercontent.com/gnea/grbl/master/grbl/system.c).

Fix: either establish and invalidate a verified safe-startup precondition, including pre-existing controller configuration, or keep output unknown for reset/connect and startup-triggering commands until independent clean off evidence exists. Audit other reset-triggering system commands under that policy. Do not add M5 before STOP or alter the single-reset contract. Model startup execution in tests and name a power-isolated owner check; stock source is not proof of this vendor controller, per DECISIONS 2026-09-05.

CONCERN — 4. Right-sizing & reuse [GATING]: File caps, the explicit subsystem waiver, dependency order, and Parking Lot indexing are present, but line 266 rebuilds weaker normalization already in `connection.ts`; fix F1 by sharing that contract and updating the declared batch scope if extraction needs another file.

PASS — 5. Security [GATING]: No new authority, secret handling, or external service is introduced; `textContent` is specified for the failsafe and the lint rules explicitly acknowledge their bypass limits.

CONCERN — 6. Failure modes [GATING]: `reloadForWelcomeGuide` at line 338 lacks guaranteed blocking-flag cleanup on exceptions; fix F4 with explicit cancellation/error cleanup and a defined lock lifetime through successful page discard.

**F4 — P1: the reload seam has no complete failure transition.** Line 337 gives plugin dialogs `try/finally`; line 338 does not give the reload path one. It says “If dirty, ... `confirm` ...; `blockingEnd()`; return on Cancel,” then calls a second predicate, `reset()`, and reload. It is unclear whether the clean branch releases the flag, and there is no exception cleanup if confirm throws. `resetOnboarding` really calls `localStorage.removeItem` (`OnboardingOverlay.tsx:183–185`), another potentially throwing operation. A failed reload can leave the page alive. Define the flag state for clean/dirty, OK/Cancel, thrown confirm/reset, and unsuccessful navigation. Test each, including recovery of admissions after cancellation/error and continued STOP dispatch. A synchronous second check is not a cleanup mechanism.

PASS — 7. Change safety [GATING]: Lines 592–599 give reverse-dependency rollback, runtime-only state, separate documentation commits, and implementation-versus-qualification tracking; no native transport or saved-format migration is authorized.

FAIL — 8. Data integrity & compatibility [GATING]: The authoritative output record can contradict accepted controller commands under F1/F2 even without concurrency; correct its semantics and test those transitions before using it as the dialog's source of truth.

FAIL — 9. Verifiability [GATING]: The retained foreign-fault positive control at line 410 contradicts the revision-5 overlap rule; fix F3 and add non-tautological controller-normalization/startup cases for F1/F2.

**F3 — P1: a required test cannot pass the stated model.** Line 410 specifies: “hold A on connection 1; connect 2; one accepted snapshot; B resolves a fresh `confirmed`, so the view is `confirmed`,” before A finally answers with a throwing getter. But line 295 explicitly says the ledger's set “is not reset” on reconnect, and lines 285–290 make an earlier episode's in-flight stop an unfenced request that dirties B. With A held, B must settle uncertain. The floor and new connection cannot override that rule. An implementation that makes this test pass by dropping A would violate the set's lifetime invariant.

Fix: retain A and expect B to be uncertain; assert that the foreign fault changes neither B's existing view nor the current fault flag/banner. Then settle/release A and use a separate clean C to demonstrate confirmation on the new connection. Add a mutation proving that resetting the ledger on reconnect fails. Audit inherited positive controls against the revised invariants instead of weakening the implementation to preserve old expectations.

CONCERN — 10. Maintainability [GATING]: Line 3 and the fold tables preserve superseded mechanisms as history while F3 shows a stale requirement survived in active tests; fix F3 and make the current transition/expectation tables authoritative, with historical folds clearly non-normative.

FAIL — X1. Physical & human safety [GATING]: F1/F2 can open a native dialog or discard the page while output is commanded on, removing software STOP during a stationary burn; close both paths and add isolated hardware qualification before claiming the interlock is safe.

FAIL — X3. Evidence & source integrity [GATING]: Line 134's exhaustive TS-byte argument and line 268's banner-to-off inference do not establish controller output state; fix F2, distinguish supported stock behavior from owner observations, and resolve the IPC-lifetime assumption at line 269 before implementation relies on it.

CONCERN — X4. Audience, brand & money accuracy [ADVISORY]: Line 599 promises file dialogs wait until the last laser instruction was off, but F1/F2 permit the opposite and line 356 explicitly exempts disconnected states; fix the interlock and make release wording match its actual connected/disconnected scope.

CONCERN — X5. Concurrency & re-entrancy [GATING]: The no-foreign-code reservation scheme is coherent, but its reconnect test requires discarding precisely the outstanding request the overlap rule must retain; fix F3 and pin error/navigation lifetime behavior under F4.

CONCERN — X6. Operability & observability [ADVISORY]: F4 can leave ordinary operations locked out after a failed Welcome Guide action without a specified cause or recovery; provide cleanup and visible error feedback, and retain the existing physical-stop-first recovery for actual machine uncertainty.

PASS — X8. Dependencies, performance & cost [ADVISORY]: No package is added; attempt retention and timers are bounded, outstanding native work is honestly uncapped, and the 1000-press measurement is scoped to TS rather than claimed as native-load qualification.

## Stress test 1 — Pre-mortem

Three months after release, a user sends an accepted commented or slash-separated M3 after M5. The app still records output off, receives Idle, and permits Open. The native picker captures input while the stationary laser burns material. The type-specific worst case is fire or injury with software STOP unavailable. The warning sign was treating raw-text over-counting as equivalent to controller normalization.

A user reconnects to a controller with an existing spindle-enabling startup block, or homes after an M5. The banner/settled command is treated as safe, but startup execution restores output. The UI permits Welcome Guide and discards its stop listener. The warning sign was proving completeness over host port writes while ignoring commands executed inside the controller.

During implementation, the foreign-fault test fails, so a developer clears outstanding ledger entries on reconnect to obtain the requested confirmed view. A late native operation is now untracked. The warning sign was an impossible positive control in the approved plan, not missing mutation-test volume.

## Stress test 2 — Load-bearing assumptions

1. **All accepted energizing commands match the proposed lexical rule. Confidence: disproven.** Existing normalization and F1 supply counterexamples. Consequence: false output-off and admitted blocking surfaces. Resolve before implementation by sharing the normalization contract and testing semantic variants.
2. **A clean reset/banner means no subsequent controller-generated on instruction. Confidence: low; contradicted for supported stock GRBL with startup blocks.** Owner configuration and vendor behavior are unverified. Consequence: the clean-clear proof fails even with perfect IPC ordering. Resolve before implementation through F2's explicit policy, then qualify it without powered emission.
3. **A settled IPC promise always means all corresponding native work has ended. Confidence: medium for normal native results, unverified for bridge failures.** Rust awaits its blocking tasks, but line 269 itself admits a Tauri rejection could break containment. Consequence: a later clear can be counted while earlier native work still runs. Resolve the installed bridge's rejection behavior before implementation; otherwise retain uncertainty for ambiguous transport failure rather than treating rejection as proof of completion.
4. **CSS hit-testing and delivered keyboard events survive the shipped webviews. Confidence: medium.** Browser tests support only their browser/runtime; D/H owner checks remain necessary. Consequence: visible STOP may not receive input on the deployed platform. The plan correctly keeps these checks as qualification prerequisites; do not convert pending checks into release claims.

## Stress test 3 — Inversion

The rejected native approach wins if proving host-side identity and command lifetime costs more than adding native evidence at the actual operation boundary. The repeated revision history, bridge-lifetime assumption, and contradictory reconnect test already put pressure on that choice. However, a native operation id alone fixes neither controller grammar nor startup execution; it is not a substitute for F1/F2. A narrower conservative policy—unknown output after startup-triggering operations until explicit clean off evidence—wins if the plan cannot verify controller configuration. That condition is already true. The portal alternative wins only if the shipped webview defeats the ancestor/hit-test proof; the plan appropriately leaves that as an empirical fallback.

## Overall verdict

**FAIL — gate blocked.** Revision 5 improves host-side overlap accounting, but the dialog interlock still has two concrete false-safe paths outside that accounting, and one mandatory test contradicts the new model. These are not requests for another layer of speculative machinery: reuse the existing command grammar, account for controller startup execution, and make the test oracle agree with the stated lifetime rule. This is the plan's declared fifth-round cap (line 3), so route this failed verdict to Lee under that cap rather than silently starting a sixth autonomous revision; this review does not authorize an override.

Prioritized must-fix list:

1. **P0 — F1:** Normalize commands as the controller does; test commented/slash-separated M3 after a clean M5 through the actual dialog seam.
2. **P0 — F2:** Remove unconditional banner/reset-to-output-off inference unless startup behavior is established safe; cover homing and other startup/reset triggers, with isolated qualification and accurate copy.
3. **P1 — F3:** Correct the impossible reconnect/foreign-fault positive control; prove outstanding requests survive reconnect and confirmation returns only after a genuinely clean episode.
4. **P1 — containment evidence:** Resolve the installed IPC bridge's early-rejection behavior or explicitly preserve uncertainty on ambiguous transport failures.
5. **P1 — F4:** Specify and test Welcome Guide blocking-flag cleanup for cancellation, exceptions, and failed navigation; update active tests, batch scope, and release wording to the corrected design.
