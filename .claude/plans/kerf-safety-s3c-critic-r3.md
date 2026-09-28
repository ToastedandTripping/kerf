## Applicability

Project type: safety-critical desktop laser-controller software, asynchronous serial motion admission, and owner-operated hardware qualification. This review evaluates revision 3 against the actual repository (HEAD `c2d5fca`); it is an independent review, not implementation approval.

- Core 1–10: all active **[GATING]**.
- X1 Physical & human safety: fires **[GATING]** because the changes admit gantry motion and the verification commands physically move a laser machine.
- X2 Privacy & data stewardship: **N/A — does not fire**; this change does not introduce handling of personal, health, child, or client records. Hardware observations should remain summaries under the existing DECISIONS diagnostic-log rule.
- X3 Evidence & source integrity: **N/A — does not fire**; this is an implementation and hardware-test plan, not research or public factual analysis. Technical assertions and hardware evidence are assessed under core verifiability and X1.
- X4 Audience, brand & money accuracy: fires **[ADVISORY]** because it changes operator-facing refusal and recovery text; no money, legal terms, or signature is involved.
- X5 Concurrency & re-entrancy: fires **[GATING]**, as required for X1-class work, because commands, polls, STOP and connection lifetimes overlap.
- X6 Operability & observability: fires **[ADVISORY]** because this changes a released application's machine-control behavior and field recovery.
- X7 Self-modification safety: **N/A — does not fire**; Kerf's machine admission gate is not a MARVIN gate, hook, skill, or automation change.
- X8 Dependencies, performance & cost: fires **[ADVISORY]** because this modifies the recurring status-poll and command hot paths, although it adds no packages.

## Dimension verdicts

PASS — 1. Problem-fit [GATING]: The Intent section and Summary address the stated homing and unsettled-motion gaps; requiring homing does not undo DECISIONS' existing bed-confirmation refusal.
FAIL — 2. Approach soundness [GATING]: The release predicate “`accepted`, a real report, snapshot `state === "idle"`” (plan line 96) does not prove a fresh usable position; require a valid post-settle position with coordinate identity before admitting a jog (A).
FAIL — 3. Completeness [GATING]: “Any line … that starts with `ALARM`” (line 92) omits an in-pump `<Alarm|…>` report, while `getStatusReport()` remains an unfenced event consumer; enumerate and cover these paths explicitly (B).
CONCERN — 4. Right-sizing & reuse [GATING]: The nine-file waiver is reasoned, but “Stage 3.5 … each with an index line” is only a future destination and the named S3c Parking Lot section is absent from ROADMAP; add the actual indexed deferrals and account for documentation edits in the graph.
PASS — 5. Security [GATING]: The proposed implementation introduces no credentials, permissions, remote endpoints or dependencies; the principal blast radius is physical motion, assessed under X1.
FAIL — 6. Failure modes [GATING]: “A poll result arrives, `pgen !== sessionGen` … Discarded before `consumeStatusOutcome`” (line 94) specifies successful results but leaves the existing rejection handler able to count old failures and disconnect a new session; fence catch/finally and test late rejections (B).
FAIL — 7. Change safety [GATING]: “Irreversible steps: none” (line 290) is false for a hardware card that can crash the gantry, and “admission stays as shipped” after a failed frame check (line 272) leaves a known unsafe frame usable; specify bounded qualification and a concrete containment state (D).
FAIL — 8. Data integrity & compatibility [GATING]: “The settings-write lines are unchanged” conflicts with “No result or poll from an earlier connection writes anything” (line 110): the current settings-write finally mutates global settings before the proposed result fence; make those mutations session-aware (B).
FAIL — 9. Verifiability [GATING]: T12's “`X10.000` … clipped against 200, not 10” need not distinguish either position, and the tests omit invalid-position Idle releases and stale rejection side effects; use an edge-sensitive independent oracle and add negative cases (A, B, C).
CONCERN — 10. Maintainability [GATING]: Invariant 1 says the hold is false only after a post-settle Idle, but the connect/disconnect row explicitly clears it without Idle; describe the disconnected/untrusted initialization exception and specify the stale-send return contract for callers.
CONCERN — X1. Physical & human safety [GATING]: Laser isolation addresses emission during the card, but “Press X+ once (10 mm step)” and the far-corner Position Laser move test an unknown frame by moving through it; resolve D before hardware execution, and keep qualification failure from being described as software safety closure.
CONCERN — X4. Audience, brand & money accuracy [ADVISORY]: “press STOP or reconnect, then Home again” suggests recovery from a permanently unsettled invoke, but STOP neither clears the outstanding count nor proves the blocked pump returns; qualify that advice and test the promised recovery path.
CONCERN — X5. Concurrency & re-entrancy [GATING]: A TS reply fence cannot prevent an already queued non-job native command from executing against a later channel; prove native lifetime ordering or carry a connection token to the actual write boundary (E).
CONCERN — X6. Operability & observability [ADVISORY]: “software-closed, hardware-unqualified” after an observed mismatch conflates untested behavior with known failure; record failed qualification distinctly, expose the operating restriction, and name who clears it and on what evidence.
PASS — X8. Dependencies, performance & cost [ADVISORY]: Counters and generation checks add constant-time work to existing commands and polls without new polling, services, packages or persistent data.

### A. An accepted Idle can freshen an old position

The plan quotes the current consumer's acceptance as sufficient for release. In `src/lib/machine/machineStatus.ts`, `consumeStatusOutcome` advances `lastValidStatusTime` and writes state before validating position. Null or nonfinite position skips the coordinate write but still returns acceptance. It retains the preceding `machinePosition` and `positionKind`.

Concrete failure: home, obtain a valid machine position near the middle, issue console motion toward an edge, then receive a newer literal-Idle snapshot with a missing or invalid position. The proposed predicate releases the hold, status eligibility becomes fresh, and the jog gate can use the older coordinates. That is exactly the stale-distance admission this relay must exclude. A valid state report is not necessarily a valid position report.

Require position eligibility tied to the accepted report and current motion/session generation. A malformed report must leave jogging blocked, rather than refresh the eligibility of retained coordinates. Test missing position, missing identity, and nonfinite coordinates after motion; a later valid Idle must recover and emit a distance clipped at the actual edge.

### B. The claimed whole-session fence is not whole

The plan says “The **whole result is discarded**” and separately says “The settings-write lines are unchanged.” Current `connection.ts` executes `invalidateGrblSettingsSilently()` in the inner `finally` around `invoke`, before processing its result. A pending old-session settings write can therefore invalidate the new controller before the proposed arrival check. Moving the response-loop check cannot prevent this.

The existing `pollStatus()` catch increments `consecutivePollFailures` and, after three failures, clears connection/job state and calls `disconnect()`. The plan does not place the session check in that catch. Delayed old-session rejections must not disconnect the replacement connection. Similarly, `getStatusReport()` directly surfaces events through `surfaceUnsolicited`; adding revocation there without fencing this caller lets a delayed old-session event revoke newly earned trust.

Finally, `send()` currently handles lines starting `<` as status samples and continues before its ALARM response handling. A `<Alarm|…>` report does not start with `ALARM`; the proposed predicates do not revoke on it. Require alarm-state detection from command status reports without restoring the unwanted machine-state writes the existing comment warns about.

Fix the control-flow contract for resolve, reject and finally, plus all event consumers. Tests must cover late settings-write settlement, three late poll rejections, a late `getStatusReport()` ALARM/banner, and a command response containing only an alarm status report followed by later recovery to Idle.

### C. The improved distance oracle remains nondiscriminating

T12 says the new position is `(200,150)`, the stale position is `(10,10)`, and the expected relative jog is `$J=G21 G91 X10.000 F1000`. Unless the test's explicit bed boundary makes one starting point clip, both produce X10. The position assertion detects overwriting, but the literal-send assertion does not independently prove that admission used the correct coordinate.

Set the bed and positions explicitly: for example, bed width 205, current X=200, stale X=10, requested +10. The correct send is X5; the stale-coordinate send is X10. Run the send-fence and poll-fence mutants against that observable difference, and cover a late result before any fresh current-session position with zero sends.

### D. Recording a failed frame does not contain it

The card instructs “If the direction is outward … stop” only after commanding a 10 mm move from the physical home corner. Its far-corner step similarly relies on noticing an approach to the frame. Neither guarantees room to stop. “Feed 300 mm/min or less for every console move” does not constrain button jogs or Position Laser; those use their own `feedRate` parameters in `connection.ts`. The fold's assertion that the card runs “at 300 mm/min or less” consequently overstates the procedure.

Specify a physically measured clearance and a small, explicit low-feed displacement before the direction test; ensure the actual button/Position Laser feed is bounded too. Require a verified coordinate mapping before the long extent move. An independent power switch is useful emergency mitigation, not proof a commanded outward move cannot hit the frame before reaction.

If qualification fails, name and enforce containment, or state a concrete release/operating restriction consistent with the owner's standing full-feature ruling. Do not silently amend that ruling, but do not present a ROADMAP label as an interlock either. A machine that has demonstrated a wrong envelope is not merely awaiting evidence. Software revert is reversible; physical damage from the card is not.

### E. Result fencing is not submission fencing

In `src-tauri/src/commands/serial.rs`, `serial_send_inner` waits on the command mutex, obtains the current channel, then writes non-job commands through `None => channel.writer.write_all(...)`. Job commands have an epoch check; non-job commands do not. The plan itself correctly says TS submission and native lock acquisition are not atomic, but applies that insight only to poll release.

A delayed old command can be discarded in TS after its bytes have already reached a replacement channel. Establish whether teardown ordering excludes that schedule with a native test, rather than a mock that simply returns an old reply. If it does not, a session token checked at the native write boundary is necessary and the nine-file scope must expand. This is a resolve-before-implementation uncertainty, not a claim that every reconnect necessarily exhibits it.

## Stress test 1 — Pre-mortem

Three months out, a homed machine moves near its edge from the console. A malformed but accepted Idle refreshes the old position and clears the lease. The next button jog is clipped against the wrong starting point and drives the gantry into the frame. The type-specific worst case is damaged hardware/material or a hand caught by unexpected gantry movement; laser isolation in the owner card does not protect normal operation. Missing-position status fixtures should have exposed this.

After intermittent USB trouble, late poll failures disconnect a newly homed session, or an old settings write invalidates the new controller. Operators repeatedly reconnect and home because the advertised recovery appears unreliable. The missing rejection/finally and alternate-consumer tests were the warning.

The owner discovers that the home corner does not match the envelope, records “software-closed, hardware-unqualified,” and later uses Position Laser with admission unchanged. The known mismatch becomes a frame strike. The warning was the explicit instruction to keep the admission behavior after failure, plus qualification moves whose speed was never actually constrained.

## Stress test 2 — Load-bearing assumptions

1. **Accepted Idle implies a current usable position — low confidence; contradicted by the consumer's field-level validation.** If false, clipping is based on pre-motion coordinates. Resolve before implementation by defining separate position eligibility and tests.
2. **Every old-session completion becomes inert — low confidence; current finally/catch paths and `getStatusReport()` are counterexamples to the specified fence placement.** If false, a new session loses settings, trust or connection state. Resolve before implementation with a complete async-path inventory.
3. **Native teardown prevents old non-job sends from reaching a replacement channel — unverified.** If false, discarding replies hides a real physical command outside the current lease. Resolve before implementation with native scheduling tests or a write-time lifetime fence.
4. **Full `$H` establishes the envelope used by this application — unverified until owner qualification.** If false, clean acknowledgements establish completion, not a correct physical coordinate mapping. Resolve before hardware admission/qualification closure; do not infer frame correctness from `$H` success alone.

## Stress test 3 — Inversion

A larger change to status-position eligibility or native submission ownership wins over the chosen TS-only batch if freshness and lifetime cannot be guaranteed at the current seams. The first condition is already true: the consumer accepts state without accepting a new position. The native condition is still unproved and deserves a targeted test before preserving the file cap. Deferring the frame model wins only while unqualified or failed frames are explicitly contained; the current “admission stays as shipped” defeats that premise. Reintroducing operator attestation for `$22=0` would win only with an independently qualified frame and motion-free current-session procedure; the plan supplies neither, so that rejected alternative remains rejected.

## Overall verdict

**FAIL — gate blocked.** Revision 3 strengthens homing revocation but still equates accepted state with fresh position and places an incomplete fence around asynchronous side effects. Those defects undermine its central safety contract. The hardware card also overstates its speed control and treats an observed frame failure as documentation rather than containment. The batch waiver and mutation count do not compensate for these missing contracts; correct the plan and add discriminating tests before implementation approval.

## Prioritized must-fix list

1. **P0:** Require fresh, valid post-motion position provenance before release/admission; test malformed and positionless Idle reports with an edge-sensitive send oracle.
2. **P0:** Fence old-session resolve/reject/finally effects and every event consumer; cover in-pump alarm snapshots and late poll failures explicitly.
3. **P0:** Make hardware qualification physically bounded, constrain actual jog feeds, and specify containment/release behavior after a failed frame check.
4. **P1:** Prove native non-job submission lifetime ordering; add a write-time session fence if teardown cannot guarantee it.
5. **P1:** Correct T12's distance oracle, lifecycle initialization invariant, stale-send return contract and STOP recovery claim; add the actual ROADMAP indexes and documentation work to the dependency graph.
