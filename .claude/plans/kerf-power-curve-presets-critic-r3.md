## Applicability

Project type: Standard-tier desktop laser-control application correctness fix, with persisted project compatibility, generated G-code, release copy, and an owner-operated hardware qualification procedure. Reviewed revision 3 against the supplied rubric and repository HEAD `b8f1642`; this is a plan review, not execution of the proposed tests.

- Core 1–10: all active, each **[GATING]**: Problem-fit; Approach soundness; Completeness; Right-sizing & reuse; Security; Failure modes; Change safety; Data integrity & compatibility; Verifiability; Maintainability.
- X1 Physical & human safety: **fires [GATING]** because preset values change laser output and the plan instructs actual burns, including a material-test fallback.
- X2 Privacy & data stewardship: **does not fire — N/A**; this change handles synthetic image fixtures and curve values, with no personal/client-data collection, access, or retention changes.
- X3 Evidence & source integrity: **does not fire — N/A**; this is an implementation plan and its narrow defect release note, not research, civic analysis, or a factual decision-support publication. Technical claims are checked under the core dimensions.
- X4 Audience, brand & money accuracy: **fires [ADVISORY]** because it supplies user-facing release instructions; no money, legal terms, or signature is involved.
- X5 Concurrency & re-entrancy: **fires [GATING]** because asynchronous generation publishes shared state while the editor can apply new values; X1 makes this conditional gating.
- X6 Operability & observability: **fires [ADVISORY]** because the change ships in a released desktop application and assigns qualification status and operator procedures.
- X7 Self-modification safety: **does not fire — N/A**; using existing test/mutation tooling does not change MARVIN gates, hooks, skills, or automation.
- X8 Dependencies, performance & cost: **fires [ADVISORY]** because the affected canvas draw callback also runs during interactive hover/drag; no new external package or service is proposed.

## Dimension verdicts

PASS — 1 Problem-fit [GATING]: The explicit grill skip and Summary meet the Standard-tier requirement, and the three deliverables match the binding TB3 requirements in `kerf-ui-polish.md`; preserving raw saved points respects the stated compatibility contract.

PASS — 2 Approach soundness [GATING]: Mirroring the preset power values matches `build_power_curve_lut`'s power-to-shade convention, the Posterize integer bands match its flat-segment behavior, and adding `open` to the draw effect addresses the conditional canvas mount.

CONCERN — 3 Completeness [GATING]: Step 3 promises a committed fixture with “the recipe above,” but that recipe's speed is owner/material-dependent and its power only an upper bound; specify exact fixture settings and either a matching qualified material recipe or an explicit permitted adjustment-and-regenerate procedure before the legacy run.

CONCERN — 4 Right-sizing & reuse [GATING]: The eight-file, multi-root waiver and actual ROADMAP deferral exist, but “does not touch `src/index.css`, so it can run beside polish A1” proves only production-code separation; identify ownership or serialized integration of the shared ROADMAP updates and qualify the independence claim accordingly.

PASS — 5 Security [GATING]: Production scope is two constant arrays and a draw-effect trigger; no new input decoder, privilege, network endpoint, credential handling, or command execution is introduced.

PASS — 6 Failure modes [GATING]: Null canvas context and rejected regeneration have explicit behavior and proposed tests; the successful-but-obsolete publication path is separately failed under X5 rather than being mistaken for a handled rejection.

PASS — 7 Change safety [GATING]: The rollback paragraph accurately distinguishes reverting preset definitions from preserving already-saved raw points; the software change is reversible without a destructive migration, while physical-test defects are assessed under X1.

PASS — 8 Data integrity & compatibility [GATING]: T5 exercises save/validate/load/request serialization for both legacy arrays and both corrected presets, and N3 separately pins legacy/Linear engine output against a recorded base revision without rewriting saved curves.

CONCERN — 9 Verifiability [GATING]: T3/m7 and the base goldens give meaningful checks, but N2's spatial decoder is a new test oracle without a specified falsification check; add a mutation that shifts a powered segment or corrupts its S token and require N2 itself to fail, independently of T1/T2/N1.

PASS — 10 Maintainability [GATING]: The production change stays at the preset/editor seam, T2 detects drift between language-specific test constants, and release guidance plus the indexed TB6 deferral make the compatibility policy and remaining work discoverable.

FAIL — X1 Physical & human safety [GATING]: “run Kerf's material test on it first” (line 176) escapes the stated ≤20% recipe, and “switch the controller off ... isolates the laser physically” (line 181) asserts an unverified hardware property; remove the fallback unless it has its own bounded approved recipe, and name/verify the actual laser-supply disconnect before any powered card.

CONCERN — X4 Audience, brand & money accuracy [ADVISORY]: “pick the preset, press Apply, then save the project” omits the known generation-race restriction that appears only in the owner card; until X5 is closed, include the operational limitation in user-facing known-issue instructions without presenting it as an interlock.

FAIL — X5 Concurrency & re-entrancy [GATING]: “TB3 neither introduces it nor relies on it” (line 37) does not protect the Apply-to-generation workflow from the admitted stale-success race; require the relevant TB6 publication guard as a dependency or add a narrowly scoped enforced guard with overlap tests before treating this workflow as safe.

CONCERN — X6 Operability & observability [ADVISORY]: “flips to qualified only when the owner card passes” (line 162) does not define the evidence record; require build/commit, controller, material, exact power/speed, photos and per-step outcome, and qualify only the tested output behavior rather than implying general physical safety.

PASS — X8 Dependencies, performance & cost [ADVISORY]: No dependency/service is added, preset sizes are unchanged, and the effect adds drawing on opening without adding a timer or increasing work per hover/drag draw.

## Stress test 1 — Pre-mortem

Three months out, the type-specific worst case is a laser burn igniting material or marking an unintended region while the operator believes the corrected curve is active.

1. The owner has no known speed for the chosen scrap, follows line 176, and runs a much stronger calibration job before the supposedly bounded test. `src/components/panels/MaterialTestDialog.tsx:102–114` initializes power from 10 to 100%, speed from 300 to 3000, and `cutBorder` to true. The card neither overrides those settings nor supplies a separate qualified recipe. Selecting “the lightest cell” afterward cannot limit exposure from cells already burned. The ≤20% statement applies to the gradient layer, not this other generator. The plan should have treated this branch as another hardware test, or stopped the card when no qualified recipe exists.

2. A user starts generating a legacy job, applies corrected S-Curve while that generation is pending, and gets the old result published with `gcodeStale=false`. The UI now contains the corrected curve but the executable job still burns the old negative. `updateLayer` only marks an existing result stale, while `setGcodeResult` unconditionally clears staleness; the current source confirms the plan's diagnosis. The defect is pre-existing, but the newly recommended re-pick workflow traverses it. Indexing TB6 assigns ownership; it does not prevent the interleaving. T4's rejection case cannot detect successful stale publication. A no-edit instruction in the owner's test card covers neither normal users nor competing generation completions.

3. STOP does not respond during a burn, and the operator follows the claimed physical isolation procedure. The plan supplies no evidence that the controller switch disconnects every laser power supply on the tested machine. This review does not assert that it fails on Lee's hardware; it rejects the unsupported guarantee. If the supply is independent, controller-off is not the promised interlock. Identify the device that actually removes laser power, establish it before testing, and do not make waiting for software response a prerequisite to using it. Removing electrical power also does not extinguish already-burning material; the card needs an explicit fire-response prerequisite, not only a command-abort procedure.

## Stress test 2 — Load-bearing assumptions

| Assumption | Confidence and evidence | Consequence if wrong / required resolution |
|---|---|---|
| The new descending points yield the intended direction and plateaus. | High: inspected the LUT's power-to-shade mapping and flat-segment tangent handling; N1/N2 still need implementation and execution. | Wrong exposure distribution; resolve through the proposed native checks before any burn. |
| Corrected points displayed after Apply correspond to the result made executable. | Low for overlapping generation: the opposite behavior is explicitly admitted and visible in the store/publication code. | An old negative can execute as current. Resolve before implementation is declared complete through a publication guard/dependency and deterministic pending-generation tests, both with and without a prior result. |
| All owner-card branches stay within a known material-specific exposure envelope. | Low: the material-test fallback has independent settings, including a 100% default maximum; the committed fixture has no specified numerical speed. | Fire or material damage despite the card's cap. Resolve before creating a runnable qualification fixture: name a qualified recipe or stop as inconclusive. |
| The named controller switch physically removes laser power. | Unverified: no wiring/model-specific evidence is supplied for the assertion. | The last-resort control may not stop hazardous output. Resolve before powered testing by identifying and checking the actual supply disconnect. |

## Stress test 3 — Inversion

Automatic migration would beat preserving old points only if the file format recorded reliable preset provenance and the owner explicitly accepted the changed output. The plan establishes neither: a deliberate custom curve and an old preset are indistinguishable raw points. That rejected alternative should stay rejected.

Deferring the general generation repair is reasonable only if TB3's affected workflow is already protected, or its safety depends on a prerequisite that is actually enforced. Neither is true here: the plan explicitly admits the race and offers only an owner-card instruction. A narrow revision/publication prerequisite wins over taking all of TB6 into this batch; it closes the hazardous interleaving without requiring the unrelated Preview and job-outcome work.

Stopping the owner card when no qualified recipe exists beats the proposed material-test fallback whenever the fallback lacks its own safe bounds. That condition is already true. The current release decisions do not require inventing a release gate, but lifting a historical release block does not establish that this new test procedure is bounded.

## Overall verdict

**FAIL — blocked on X1 and X5.** The preset math, draw fix, and compatibility approach are suitable, and the earlier testing gaps are substantially addressed. Revision 3 nevertheless substitutes a documented deferral for an enforced concurrency control and sends an operator from a capped gradient test into an independently configured calibration burn. The claimed controller-switch isolation also needs machine-specific substantiation. These findings do not require rewriting saved projects, absorbing all of TB6, or reversing Lee's release rulings; they require protecting the affected publication workflow and making every branch of the proposed hardware test match its claimed limits.

## Prioritized must-fix list

1. **P0 — X1:** Remove the unbounded material-test fallback or reference a separately qualified bounded procedure; identify and verify the actual laser-power disconnect, and specify readiness for an actual material fire before powered testing.
2. **P0 — X5:** Add an enforced revision/publication guard or make the corresponding TB6 work a dependency. Test Apply during pending generation with both null and existing results, and out-of-order overlapping completions if multiple generation entry points can overlap; obsolete output must not become executable as current.
3. **P1 — 3/X6:** Give the committed owner fixture exact settings tied to a qualified material recipe, define allowed adjustments and regeneration, and require a build- and recipe-specific evidence record.
4. **P1 — 9:** Prove the N2 spatial oracle rejects a deliberately displaced or wrongly powered segment, not merely a changed preset constant.
5. **P2 — 4/X4:** Account for shared ROADMAP integration and expose any remaining generation limitation in the release instructions until the enforced fix lands.
