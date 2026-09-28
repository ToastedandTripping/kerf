Applicability

Project type: safety-critical desktop laser-controller software; manual motion admission, serial command lifecycle, React operator UI, and owner hardware qualification. Reviewed revision 2 of `kerf-safety-s3c.md` against the supplied rubric and the local connection/status/serial implementation, CLAUDE.md, DECISIONS.md and ROADMAP.md. This is a plan review, not a hardware qualification or an implementation test run.

Active universal dimensions: 1 Problem-fit [GATING]; 2 Approach soundness [GATING]; 3 Completeness [GATING]; 4 Right-sizing & reuse [GATING]; 5 Security [GATING]; 6 Failure modes [GATING]; 7 Change safety [GATING]; 8 Data integrity & compatibility [GATING]; 9 Verifiability [GATING]; 10 Maintainability [GATING].

X1 Physical & human safety FIRES [GATING]: commands move a laser gantry; false position trust can drive it into a mechanical limit or a person.
X2 Privacy & data stewardship DOES NOT FIRE — N/A: this change handles controller status and motion state, not personal/client records or their storage.
X3 Evidence & source integrity DOES NOT FIRE — N/A: this is an engineering implementation plan, not research, civic analysis or factual public output; its safety evidence is assessed under core 9 and X1.
X4 Audience, brand & money accuracy FIRES [ADVISORY]: operator-facing refusal messages change; no prices, legal terms or signature are involved.
X5 Concurrency & re-entrancy FIRES [GATING]: asynchronous commands, polls, reset and reconnect share state; X1 makes this gating.
X6 Operability & observability FIRES [ADVISORY]: the change ships in a desktop application and must explain field refusals and recovery.
X7 Self-modification safety DOES NOT FIRE — N/A: this changes Kerf's machine gate, not MARVIN's own gates, hooks, skills or automation; invoking review machinery is not modifying it.
X8 Dependencies, performance & cost FIRES [ADVISORY]: the lease participates in the existing periodic status-poll and command hot paths; no new dependency is proposed.

Dimension verdicts

1. Problem-fit — PASS [GATING]: the Intent section explicitly records the skipped separate grill and existing rulings, and the Summary targets unearned homing trust and overlapping manual motion; no contradictory standing decision was identified.
2. Approach soundness — FAIL [GATING]: “Trust is true only if a plain `$H` completed cleanly, in this session” cannot establish continuing trust when observed reset banners never revoke it; add controller-reset recognition and invalidate trust on every reset delivery path (finding A).
3. Completeness — FAIL [GATING]: “That send settles, different `sessionGen` | Ignored” covers the lease and grant but leaves existing response-side position writes and poll consumers outside the fence; specify whole-result session rejection before any safety-state mutation (finding B).
4. Right-sizing & reuse — PASS [GATING]: the nine-file batch has an explicit cohesion waiver and independence declaration, reuses the store and gate, and names indexed ROADMAP Parking Lot destinations for each deferral; those documentation writes must actually occur at Stage 3.5.
5. Security — PASS [GATING]: no new secret, authorization boundary, package, network interface or execution capability is introduced; the existing unrestricted console remains an explicitly stated policy boundary.
6. Failure modes — FAIL [GATING]: “Any other poll ... none” and the reset rows address application-initiated reset but omit an unsolicited controller restart; a later Idle can release the lease while trust still describes the pre-reset coordinate system; revoke on reset evidence and test recovery through a fresh full home (finding A).
7. Change safety — CONCERN [GATING]: “revert the merge” explicitly restores W1/W2, while “run jog steps after `$H`” does not control console-motion overlap; define a rollback operating restriction that prevents both hazards, such as disabling button jogging until corrected software is restored, and carry it onto the owner card.
8. Data integrity & compatibility — FAIL [GATING]: “The module value is authoritative and the store copy is for the panel” protects the lease, not `machinePosition`; an old response can overwrite current coordinates while current homing and freshness remain valid; fence all position/state writes by session and test the actual subsequent jog distance (finding B).
9. Verifiability — FAIL [GATING]: “Step 3's measured jog is the acceptance check for the frame” confuses displacement with absolute origin and axis coverage, while T10 checks only homing/lease and T8's exact Home-reason expectation omits alarm-state recovery; add frame qualification and adversarial end-to-end lifecycle traces with reachable fixture states (findings B–D).
10. Maintainability — CONCERN [GATING]: “optional callback” and “Ted report states which of the two it used” leave a safety requirement as an implementation choice, and the store fallback clears only half the trust state; require one mandatory revocation contract that atomically clears trust and advances its generation, with a clear ownership seam (finding E).
X1. Physical & human safety — FAIL [GATING]: “whether its `$H` homes both X and Y” remains unqualified, yet `$H` `ok` grants both-axis trust and steps 1–5 would close the gap; require measured origin, direction, extent and both-axis homing acceptance before closure, and correct the hardware move instructions (finding C).
X4. Audience, brand & money accuracy — CONCERN [ADVISORY]: “Move the head from the console instead” recommends the deliberately unclipped path immediately after explaining that Kerf cannot locate the bed edge; remove that instruction or explicitly say console movement bypasses bed protection.
X5. Concurrency & re-entrancy — FAIL [GATING]: “A settle from an earlier session changes nothing” is stronger than the specified fence, because stale response/poll processing can still write current position, state and trust; fence the full asynchronous result and add reconnect-plus-late-result tests (finding B).
X6. Operability & observability — CONCERN [ADVISORY]: “Jogging resumes once it reports Idle ... press STOP” omits that STOP revokes homing and a stuck outstanding invoke is not cleared by Idle; distinguish waiting for motion completion from a stuck command and document the required reconnect/home recovery.
X8. Dependencies, performance & cost — PASS [ADVISORY]: counters and scalar checks add constant work to existing sends/polls, with no new service, package, polling frequency or per-call spend.

Concrete blocking findings

A. An observed controller reset is not a revocation event.

The table lists “ALARM seen on any path” and “`softReset()` or `emergencyStop()` invoked,” but no reset banner. Section 2 adds only ALARM handling to `surfaceUnsolicited` and the response loop. Existing `connection.ts:51–68` logs other lines; `machineStatus.ts:131–144` likewise logs non-ALARM events. The native `serial_send_inner` explicitly recognizes `PumpTerminal::Banner` and returns the pump's lines in `SendOutcome.responses`; reset evidence is therefore a real protocol case, not an invented transport failure.

Counterexample: home successfully; move away from home; the controller restarts without the app invoking either reset wrapper; a banner is delivered through a command response, drained line or status event; the plan only logs it. Once the controller provides an accepted Idle (and any alarm has been unlocked), `machineHomed` can still be true while coordinates have been reinitialized. The gate then trusts a bed origin it has not earned in that controller lifetime. The Summary promises “no alarm, reset, stop ... has happened since,” not merely “no app reset function was called.”

Fix: name the supported reset evidence, route it through generation-advancing revocation, and test each delivery path beginning from an already homed machine. Any protocol path that consumes a reset without exposing it must be addressed or explicitly block trust. Add reset-during-home tests so a delayed `ok` cannot regrant. Do not require a coincident ALARM as the reset detector.

B. Session fencing stops at bookkeeping, leaving the coordinates unprotected.

The plan puts the same-session check on “That send settles” and the Grant bullets. It does not put it before the existing `send()` response processing. That processing parses a returned `<...Pos:...>` report and calls `setMachinePosition` regardless of session. T10 only asserts “not homed” and “the new session's lease is unaffected”; it never verifies that the new session's coordinates survive.

Counterexample: an old command result is delayed; disconnect/reconnect, home and obtain fresh current coordinates; the old result then arrives containing a position report. Its lease decrement and grant are ignored, but the unchanged response loop overwrites the current coordinates. The current session's homed flag, freshness and position kind can still pass the gate, so the next jog is clipped against the wrong position. This trace is within the delayed-old-completion model the plan itself requires T10 to exercise.

Polls need the same treatment: `resetStatusConsumer()` resets the epoch/sequence watermarks, and `consumeStatusOutcome()` mutates store state before the lease-release condition is evaluated. A tick mismatch prevents release, not those writes. A late old poll arriving before a new-session report can be accepted against the reset watermark. Stale events also run before snapshot validation.

Fix: capture session at every relevant asynchronous entry and discard stale results before response/status/event safety-state writes; harmless diagnostic logging can remain explicitly tagged. Test old command positions, old poll positions and old ALARM events against a newly connected/homed session, including results arriving before its first fresh poll. Assert the next emitted jog's literal coordinates/distance, not only flags.

C. The hardware acceptance card cannot validate the assumed frame.

The plan admits “whether its `$H` homes both X and Y” is unqualified and says “Step 3's measured jog is the acceptance check for the frame.” A machine with an origin translated by 100 mm still moves exactly 10 mm on a relative 10 mm command. An X-only homing implementation also passes an X displacement test while leaving Y untrusted. Neither defect is disproved by steps 1–5. `jogEnvelope()` assumes X `[0, bed]` and a Y range selected by `originTop`; a clean acknowledgement alone does not connect those ranges to physical travel.

Fix: specify supported firmware/frame assumptions and a laser-isolated qualification that records both axes' homing, physical home corner, MPos after pull-off, axis direction, and usable extents against the clipping envelope. A mismatch or untested axis must prevent declaring the gap closed; scope admission to qualified configurations if the assumption cannot otherwise be established.

The card also begins at “head mid-bed” but then homes before issuing “`G1 X` (current + 20)” and current +30. After homing, that direction is not proven to point inward or have sufficient clearance. It does not establish G21/G90 or reconcile current machine position with work offsets. Specify units, distance mode, coordinate frame, inward direction, verified remaining travel, and an independent physical stop procedure if the software STOP under test fails. Laser isolation prevents emission; it does not prevent a gantry collision or pinch injury.

D. The test contract contains an unreachable refusal expectation and weak oracles.

T8 promises each case yields `JOG_REASON_HOME`, including “(d) an Alarm snapshot,” but the planned gate order is “not connected, alarm, job, motion ... trust.” The snapshot explicitly sets `machineState = "alarm"`, so a direct jog yields the alarm reason. Pending re-home case (g) similarly hits motion before trust. State injection to force the desired message would conceal the transitions under test.

Fix: assert the immediate alarm/motion refusal first, then explicitly complete the command or unlock and obtain a fresh post-settle Idle, and only then assert Home refusal. Add reset-banner, late-position-result, reset-during-home, and post-home ALARM-versus-delayed-grant traces to the battery. Require the release predicate to use literal snapshot `state === "idle"`: the current `machineStateToStore` also maps Check and Sleep to idle, so reusing the existing predicate would not satisfy “Idle from the snapshot.” Add Check/Sleep negatives. Preserve the red-before-production requirement and kill mutants on observable unsafe sends or wrong coordinates.

E. Clearing the homed boolean is not equivalent to revoking a pending grant.

Section 4 says “The store setter cannot bump `trustGen`” and calls its boolean clear a “fallback.” A pending `$H` can subsequently set the boolean true if that fallback was the only clear: its captured generation still matches. The normal poll callback can close that path, but making it optional and leaving “which of the two” to the report means the plan does not require the one control that prevents regrant.

Fix: make generation advancement inseparable from revocation, either through a required injected lifecycle interface or a small shared state owner that avoids circular imports. Enumerate all production callers. Test revocation while a home result is pending, followed by a delayed clean acknowledgement; checking an already-false boolean is insufficient.

Three stress tests

Pre-mortem — three months out, this failed:

1. After an unnoticed controller restart, the UI still considers the machine homed. A fresh Idle makes the controls look healthy, and a clipped jog hits the gantry end because the reported origin changed. Worst case: mechanical damage or a hand pinched by unexpected motion; laser emission remains a separate hazard that these controls do not qualify. The missing reset-banner row was the warning.
2. A reconnect appears to repair a stuck command, but its late response then overwrites the newly homed position. The next Position Laser move is calculated from stale coordinates. The test suite stayed green because T10 inspected counters and homing, not the position used by the next command.
3. The owner card passes a 10 mm X jog and the ROADMAP calls the safety gap closed. Y was never shown to home or match the assumed negative/positive range. A later Y move damages the machine. The disclosed but unresolved both-axis assumption and displacement-only acceptance were the warnings.

Load-bearing assumptions:

- A plain `$H` `ok` establishes both X and Y in exactly Kerf's clipping frame. Confidence: LOW; the plan explicitly says this is unqualified. Consequence: bounded jogs are physically unbounded relative to the real bed. Resolve before implementation treats the flag as sufficient authority, or explicitly gate its use pending qualification.
- Every loss of controller position trust reaches an application reset function or ALARM callback. Confidence: LOW; the native transport explicitly handles reset banners, which the plan does not revoke on. Consequence: silent reuse of pre-reset trust. Resolve before implementation by covering actual protocol reset evidence.
- Rejecting an old settlement means an old asynchronous result cannot mutate the new session. Confidence: LOW; existing response and status consumers write independently of the lease check. Consequence: mixed-session coordinates and authority. Resolve before implementation with a whole-result fence contract.
- The proposed idle predicate means literal controller Idle. Confidence: MEDIUM only if implemented directly; the existing state mapper includes Check and Sleep. Consequence: release in an unqualified controller mode. Resolve in the plan and pin with negative tests before implementation.

Inversion:

For the rejected `$22=0` operator-attestation alternative to win, it would need an unambiguous physical frame, a motion-free attestation window, explicit hazard presentation and hardware evidence. None is established here, so failing closed on those machines remains justified. But `$22=1` currently avoids those same frame-evidence requirements by treating a plain command acknowledgement as proof. The plan's own “whether its `$H` homes both X and Y” disclosure means the condition under which narrower admission wins is already present: the homing-to-frame contract is unknown. Restricting trusted admission to a qualified frame, or holding closure until that contract is measured, beats an unconditional whole-bed trust grant. Likewise, mandatory shared revocation beats an optional callback if any caller can clear trust without invalidating a pending grant; the proposed fallback already has that property.

Overall verdict: FAIL — the gate is blocked by reset coverage, incomplete session fencing, and an acceptance test that cannot establish the claimed physical frame. The counted lease improves the earlier plan, but those defects still allow a valid-looking jog admission to use an unearned or obsolete position. The fixes should preserve the existing scope where possible; neither additional passing mocks nor a single measured displacement can substitute for the missing lifecycle and physical-frame guarantees.

Prioritized must-fix list:

1. P0: Revoke position trust on observed controller resets across responses, drains and status events, and prevent delayed home acknowledgements from restoring it.
2. P0: Fence entire command and poll results before current-session safety-state writes; prove the next jog cannot use an old position after reconnect.
3. P0: Replace the 10 mm frame oracle with both-axis origin/direction/extent qualification; correct hardware steps for modes, offsets, clearance and independent stopping, and keep closure blocked until acceptance passes.
4. P1: Make revocation and generation advancement one mandatory operation; test in-flight home grants against every revocation route.
5. P1: Repair T8's state transitions, require literal Idle with Check/Sleep negatives, and add behavioral mutants for the new failure traces.
6. P1: Remove the unqualified console workaround; document stuck-command recovery and a rollback operating restriction covering both W1 and W2.
