## Applicability

Project type: safety-critical desktop laser-controller software, with serial concurrency, operator-facing recovery instructions, and a physical qualification procedure. Review of revision 4 against the supplied rubric; repository evidence inspected at working-tree HEAD `a86eb95` (the plan cites `aa06a3f`). This is a plan review, not an executed software or hardware qualification.

- Core 1–10: all active **[GATING]**: Problem-fit; Approach soundness; Completeness; Right-sizing & reuse; Security; Failure modes; Change safety; Data integrity & compatibility; Verifiability; Maintainability.
- X1 fires **[GATING]**: changes admission of physical laser-carriage motion and prescribes hardware tests.
- X2 does not fire — **N/A**: this change handles controller state, not personal/client records; it does not propose publishing raw diagnostic captures.
- X3 fires **[GATING]**: makes hardware-qualification and W1/W2 closure claims used to decide whether motion is safe.
- X4 fires **[ADVISORY]**: changes operator-facing reasons, recovery advice and release notes; no money, contract or signature.
- X5 fires **[GATING]**: overlapping commands, polls and reconnects share state; X1 makes this gating.
- X6 fires **[ADVISORY]**: released desktop app with asynchronous polling and operator recovery.
- X7 does not fire — **N/A**: changes Kerf's machine-admission logic, not MARVIN's gates, hooks, skills or automation; use of the critic workflow does not activate it.
- X8 fires **[ADVISORY]**: modifies the recurring status-poll path and adds a UI timer, though no dependency is added.

## Dimension verdicts

PASS — 1. Problem-fit [GATING]: The explicit Intent section and Summary target the recorded homing and post-motion freshness defects; the written no-separate-grill explanation satisfies the structural requirement, and no contradictory standing decision was found in `.claude/DECISIONS.md`.
FAIL — 2. Approach soundness [GATING]: “the position write [is] unchanged” (L156) leaves another writer able to replace the supposedly qualified coordinate after release; bind admission to an authoritative validated coordinate sample, as detailed in A.
FAIL — 3. Completeness [GATING]: “Any other poll … none (the hold stays)” (L106) specifies no invalidation when the hold is already false; add post-release invalidation and cover all coordinate writers, not only the first releasing poll (A).
PASS — 4. Right-sizing & reuse [GATING]: The nine-file batch has an explicit contract-based waiver, a dependency graph and a named independent Rust batch; Stage 3.5 explicitly owns six Parking Lot index entries and architecture documentation, though those entries must actually land before closure.
PASS — 5. Security [GATING]: No new secrets, privileges, dependencies or external inputs are introduced; the physical command-admission defects are gating findings under X1/X5 rather than an invented authentication requirement.
FAIL — 6. Failure modes [GATING]: “If it has stopped moving, reconnect and Home again” directs an operator into a known unfenced pending-command path; visible stillness does not establish that queued native writes are cancelled (B); make recovery safe before recommending it.
CONCERN — 7. Change safety [GATING]: “revert the merge” (L308) restores known unsafe jog behavior and relies solely on an operating restriction; specify a reversible fail-closed fallback preserving jog refusal, plus owner-visible rollback instructions before use.
FAIL — 8. Data integrity & compatibility [GATING]: Finite MPos is treated as sufficient while units remain unqualified and raw command reports can overwrite the coordinate without its kind or age (A, C); retain coordinate, kind, units and freshness as one validated admission record.
FAIL — 9. Verifiability [GATING]: “W1/W2 are recorded as closed” (L289) rests on a card that can reject a correct frame and does not test the post-release coordinate corruption case; add the counterexamples in A–D and repair the card before using its result as closure evidence.
CONCERN — 10. Maintainability [GATING]: Separate `motionHeld`, store `motionInFlight`, and a module-global `lastReportPositionValid` create synchronized state obligations; centralize lease transitions and return validity with the consumed report rather than relying on a side-channel boolean.
FAIL — X1. Physical & human safety [GATING]: “at least 5 mm … on the side … ‘into the bed’” (L274) does not protect the opposite side during an explicitly unqualified direction test, and the failed-frame response is expressly “not an interlock” (L290); add physical test safeguards and enforce qualification refusal (D).
FAIL — X3. Evidence & source integrity [GATING]: “the frame fails (Kerf's bed is larger than the machine)” (L283) does not follow from reaching the 15 mm test reserve; distinguish an inconclusive safety stop from measured frame failure and narrow closure to what was actually demonstrated (D).
CONCERN — X4. Audience, brand & money accuracy [ADVISORY]: The one-size-fits-all reconnect note also appears for WPos-only controllers that the plan says “will never release” (L307); provide cause-specific advice and avoid implying homing establishes frame correctness before qualification.
CONCERN — X5. Concurrency & re-entrancy [GATING]: The within-connection count/tick/generation contract is useful, but “It fences only the lease and the grant” (L95) deliberately leaves state mutations and native queued writes unfenced; keep S3d as a separate implementation if desired, but make safe recovery/release depend on it or equivalent containment (B).
CONCERN — X6. Operability & observability [ADVISORY]: All persistent holds collapse into one five-second note; expose whether the hold is awaiting an invoke, valid MPos, or literal Idle, and record actionable recovery rather than repeatedly suggesting a reconnect that cannot fix missing MPos.
PASS — X8. Dependencies, performance & cost [ADVISORY]: No added package/service, constant-size state and poll checks, and an effect timer with cleanup present no identified material cost or performance expansion.

### A. The fresh sample is not the coordinate necessarily used for clipping

The plan says “Nothing else in the consumer changes” (Freshness) and “the position write [is] unchanged” (L156). In the inspected `connection.ts:643–660`, `send()` accepts either `[MW]Pos`, parses it, and writes `machinePosition` without updating `positionKind`, report age, or a lease for non-motion commands. Thus the lease's validated MPos is not an enduring admission record.

A concrete injected-response regression: establish clean homing and release with MPos X=200, bed width 205, kind `machine`, offset zero. Complete a non-motion send with `<Idle|WPos:10,0,0>` in its response. The preserved writer replaces X with 10 and leaves the old kind/offset metadata. The next +10 jog sends `X10.000`, rather than the physically safe `X5.000`. This uses a response shape the existing code explicitly supports, inside one connection; S3d cannot fix it. The protocol must reject or correctly interpret such a sample even if it is unexpected.

Likewise, after release, a newer Idle with invalid position advances `lastValidStatusTime` while retaining the prior coordinate (`machineStatus.ts:175–197`). L106 merely preserves a hold that is already false. T12 only tests bad reports while a motion hold is active, so it cannot detect this state. Subsequent reports can also replace MPos with WPos while the lease stays released.

Fix: make the clipped position's validity, coordinate system, age and ordering explicit at every jog admission. Prevent raw response writes from bypassing that contract, or keep those writes display-only. Test non-motion responses, newer invalid reports and kind changes after successful release, with exact edge-sensitive send/refusal assertions.

### B. A scoped claim does not make the recommended reconnect safe

The Split correctly admits: “A send queued on the native command mutex can acquire it after a disconnect and reconnect, and write its bytes to the new controller.” The inspected `serial_send_inner` confirms that non-job writes have no epoch check. The same plan then recommends reconnect when an invoke has not settled.

A stationary carriage is consistent with a command waiting on that mutex. Clearing the TS lease does not cancel that native request. It can execute on the new connection independently of whether the new UI has admitted a jog; a delayed old reply can also replace state after a new `$H`. The plan's “residual window is a late reply … after the new connection's `$H`” understates its own native-write finding: physical command replay is a separate hazard. Revoking `machineHomed` only blocks later UI jog admission, not already submitted bytes.

Fix: either deliver connection fencing before making this the recovery path, or provide a demonstrably safe cancellation/quiescence procedure and a deployment dependency that prevents exposure. Separate batches are reasonable; treating the separate batch as optional to safe recovery is not. Add a native-boundary overlap test with a queued non-job motion, disconnect/reconnect, and proof that stale bytes are never written. Do not claim a TS mocked-invoke test proves that property.

### C. “Finite MPos” is not a complete machine-coordinate contract

The freshness definition only requires finite XYZ and `positionKind === "MPos"`. The existing snapshot carries `units`, but the inspected native parser (`grbl_status.rs`, snapshot construction) sets it to `UnitsValidity::Unknown`; the consumer writes coordinates unchanged. Kerf's clipping dimensions and emitted `$J=G21` distances are millimeters. Neither this plan's release predicate nor its hardware card establishes the units of reported positions. Setting G21 on a move is not evidence about the separate incoming report representation.

Fix: identify and verify the report-unit source, normalize incoming coordinates or refuse unqualified units, and test a non-mm/unknown report against a near-edge jog. If this is deliberately a controller-specific qualification, name and enforce that boundary. Do not simply require `snap.units === "Mm"` without changing the producer: the current producer would then block every report.

### D. The hardware card cannot support its claimed safety or conclusion

“Each step bounds its own motion” (L260) is false for the direction test. L274 measures only intended inward clearance; L277 explicitly anticipates outward motion. If home pull-off leaves less than 1 mm on the outward side, the first 1 mm test can hit the frame before the operator can observe failure. Having a switch within reach is not an interlock for a move described as lasting “well under a second.” Qualify homing/limit protection and both possible directions first, or use a physically safe test location/procedure with bounded clearance in both directions. State the collision outcome explicitly.

The extent test has a separate oracle defect. A correct bed whose software edge coincides with the physical travel limit can reach 15 mm remaining while still allowing another inward-to-edge step. Stopping at the prescribed reserve therefore does not prove that the bed is oversized. “At least 0 mm” (L281) also omits measurement uncertainty and stopping margin. Use an explicit positive reserve with quantified measurement tolerance and outcomes PASSED / FAILED / INCONCLUSIVE; a bounded test that cannot safely reach the claimed boundary is inconclusive, not evidence of oversized geometry.

Finally, “FAILED (frame)” leaves the same arrows and Position Laser enabled while promising only an operating restriction. Honesty about this does not satisfy X1's explicit-interlock rule. Preserve a qualification/refusal state keyed to the relevant machine configuration, or supply an equivalent enforceable containment. Scope W1/W2 closure to the paths, controller and geometry actually tested; Position Laser is explicitly excluded from this card.

## Stress test 1 — Pre-mortem

Three months out, the type-specific worst case is a carriage striking the frame or trapping a hand; with laser power enabled in ordinary operation, unintended motion can also carry hazardous output onto unintended material. The isolated-power card does not qualify normal-operation beam safety.

1. A settings/console command returns an in-pump WPos sample after the lease released; the raw writer mislabels it as the prior machine coordinate, and clipping permits an extra 5 mm into the frame. We should have tested competing position writers after release, not only the release predicate.
2. A stalled operator follows the reconnect note. A queued native motion survives the connection replacement and executes on the new controller despite the UI's homing refusal. We should have treated the admitted S3d defect as a recovery dependency.
3. The first direction probe goes outward into insufficient pull-off clearance, or a correct machine receives a false frame-failure label at the 15 mm reserve. The operator is then directed to unrestricted console moves. We should have audited both possible directions and the logic of the hardware oracle before using it as closure evidence.

## Stress test 2 — Load-bearing assumptions

- **The releasing MPos remains the authoritative position used by the next jog — low confidence, contradicted by an existing writer.** If wrong, a green lease can accompany incorrect clipping. Resolve before implementation with one admission-coordinate contract (A).
- **Finite MPos is expressed in Kerf's millimeters — unverified.** The native parser explicitly labels units Unknown. If wrong, distance-to-edge calculations are dimensionally incorrect. Resolve before implementation (C).
- **Reconnect plus Home safely recovers an unresolved command — low confidence, contradicted by the stated native queue defect.** If wrong, stale bytes execute despite revoked trust. Resolve before shipping the advice or permitting that recovery (B).
- **A clean full `$H` plus this card establishes the assumed physical frame — low confidence until hardware qualification.** The card does not safely establish direction in every stated failure case, and its reserve cannot prove an oversized envelope. If wrong, software trust is granted to the wrong physical model. Correct the procedure and enforce the qualification boundary (D).

## Stress test 3 — Inversion

The rejected cross-connection work would win as a prerequisite if ordinary recovery crosses a connection boundary while native sends remain pending. That condition is already present in the five-second reconnect advice. It need not be merged into the same nine-file batch; S3d can remain separately reviewed while becoming a prerequisite for this recovery behavior. An explicit per-machine qualification refusal would beat the operating-restriction alternative if homing does not establish the assumed coordinate frame or the frame card fails. The plan already anticipates both conditions. Centralized coordinate validation would beat preserving the old raw writer if a non-motion response can alter the clipped coordinate; the existing writer already does exactly that.

## Overall verdict

**FAIL — gate blocked.** Revision 4 improves the motion-settle contract but still qualifies only a release event, not the coordinate subsequently consumed by the jog gate. It also recommends a recovery path through a known unfenced native-write hazard and overclaims the safety and meaning of its hardware card. These are concrete violations of active gating dimensions, not requests to absorb every adjacent safety project. Preserve the batch split where useful, but make dependencies, coordinate provenance and enforceable physical containment real before claiming software or hardware closure.

## Prioritized must-fix list

1. **P0:** Close the alternate position-writer and post-release validity holes; add exact-send regressions for A and establish report-unit handling in C.
2. **P0:** Make unresolved-command recovery safe at the native write boundary; require S3d or equivalent proven containment before shipping the reconnect instruction.
3. **P0:** Repair the direction-test safeguards, add enforceable refusal for failed/unqualified frame assumptions, and replace the false 15 mm failure inference with a tolerance-aware, potentially inconclusive qualification result.
4. **P1:** Extend the test/mutation plan to these missing states and narrow W1/W2 closure to demonstrated behavior; include a native overlap test for any connection-safety claim.
5. **P1:** Specify a fail-closed rollback, cause-specific hold diagnostics and actionable WPos-only recovery; centralize lease transitions and bind report validity to its returned sample.
