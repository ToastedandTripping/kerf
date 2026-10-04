## Applicability

Project type: Standard-tier desktop laser-control software correctness change, with G-code regression fixtures, release copy, and an owner-operated physical qualification.

All universal dimensions are active and [GATING]: 1 Problem-fit; 2 Approach soundness; 3 Completeness; 4 Right-sizing & reuse; 5 Security; 6 Failure modes; 7 Change safety; 8 Data integrity & compatibility; 9 Verifiability; 10 Maintainability.

- X1 fires [GATING]: preset values change laser energy distribution and the plan instructs physical burns.
- X2 does not fire — N/A: this change does not introduce handling of personal, health, child, or client records; synthetic image fixtures suffice.
- X3 does not fire — N/A: this is software implementation and its verification, not a research or public factual-analysis deliverable; code claims are checked under the core dimensions.
- X4 fires [ADVISORY]: user-facing release copy and qualification status, without money, legal terms, or a signature.
- X5 fires [GATING]: asynchronous generation shares mutable application state with repeatable Apply actions; X1 makes this gating.
- X6 fires [ADVISORY]: this ships in a released desktop application.
- X7 does not fire — N/A: invoking existing verification tooling does not modify MARVIN gates, hooks, skills, or automation.
- X8 does not fire — N/A: no added dependency, service, polling, per-call cost, or production hot-path algorithm change; the proposed changes are preset constants and a dialog-open redraw.

Reviewed revision 2 against the supplied rubric, the binding TB3 entry in the parent plan, relevant DECISIONS entries, ROADMAP, and local source at e88d91f. The plan cites diagnostic base 70cdfa1; current-tree observations below are identified explicitly. No implementation or hardware tests were run.

## Dimension verdicts

PASS — 1 Problem-fit [GATING]: the explicit grill skip and Summary match TB3's preset-direction, initial-draw, and saved-project requirements; retaining raw saved points and the amended release policy is consistent with DECISIONS.
PASS — 2 Approach soundness [GATING]: reversing the two preset power tables and adding open to the guarded draw effect addresses the stated defects without changing the interpolation or stored representation.
CONCERN — 3 Completeness [GATING]: “Set its layer to Variable (M4) power” (L162) does not specify grayscale dithering, minimum power, image adjustments, or raster interval, so the three-band acceptance is not reproducible; specify the full owner-test configuration and explicit regeneration before each burn.
CONCERN — 4 Right-sizing & reuse [GATING]: the four-file table (L53–58) omits the three committed goldens required at L120; list all seven files, extend the waiver to the actual roots, and account for any additional files required by the concurrency fix.
PASS — 5 Security [GATING]: the proposed production changes add no privileges, external inputs, credentials, network surface, or new parsing path.
CONCERN — 6 Failure modes [GATING]: “failed generation” is marked addressed by “the generation snapshot” (L190), but a snapshot neither handles invoke rejection nor proves retention of a safely blocked old result; name and test the failed-regeneration path after Apply, including an existing result.
PASS — 7 Change safety [GATING]: rollback explicitly distinguishes restoring preset definitions from restoring saved data, and no destructive migration is proposed.
PASS — 8 Data integrity & compatibility [GATING]: T5 covers the actual serialization/load/request seams for both legacy curves, and N3 pins legacy output without rewriting saved points.
CONCERN — 9 Verifiability [GATING]: “one arc call at each control point” (L81) proves control handles, not the curve stroke; assert the curve-specific path and stroke, clear recordings between opens, and add a mutation removing only the curve-rendering loop.
PASS — 10 Maintainability [GATING]: the production change remains localized, duplicate language fixtures have a failing synchronization check, and the owner/release documentation has a named home.
FAIL — X1 Physical & human safety [GATING]: “Open a project saved before the fix … It still engraves the old way” (L168) can replace the bounded test settings with arbitrary saved power, mode, passes, geometry, and enabled layers; use a dedicated bounded legacy fixture, reverify the complete burn envelope after loading, and name the physical isolation action and worst-case outcomes.
PASS — X4 Audience, brand & money accuracy [ADVISORY]: release copy accurately states legacy retention and explicitly requires picking, Apply, and save.
PASS — X6 Operability & observability [ADVISORY]: the plan distinguishes merged implementation, pending owner evidence, and physical qualification, without claiming the existing release gates were reinstated.
FAIL — X5 Concurrency & re-entrancy [GATING]: “a result generated before the Apply is flagged out of date. It is never silently mixed” (L36) is contradicted by unconditional stale-flag clearing on completion; guard result publication with generation/design identity and prove Apply-during-generation cannot publish a current-looking obsolete result.

## Findings supporting the blocking verdicts

### The generation snapshot does not protect publication

The plan's L35–36 claims an Apply during generation affects the next generation and that the old result remains flagged. The first claim can hold while the second fails. In the inspected tree:

- `generateGcode()` captures `useStore.getState()` at `src/lib/machine/gcodeGen.ts:906`.
- `updateLayer` sets staleness only when a result already exists (`src/app/store/index.ts:345–351`).
- `handleGenerateGcode` awaits the old generation and then unconditionally calls `setGcodeResult(result)` (`src/components/panels/MachinePanel.tsx:385–386`).
- That setter explicitly writes `gcodeStale: false` (`src/app/store/index.ts:692`).

Sequence: start generation using old points; Apply corrected points while the request is pending; resolve the old request; completion clears staleness. With no previous result, Apply does not even establish the flag. With an existing result, completion erases it. The ordinary START stale check (`canStartJob.ts:194`) then cannot distinguish that obsolete result.

This is a pre-existing race, not evidence that changing preset constants creates it. It nevertheless directly defeats the control this revision uses to close X5. Add a delayed-invoke integration test driving the real completion path, with and without a prior result. The result must be rejected or retained as stale when its input revision no longer matches; repeat with overlapping generations and reversed completion order if that entry point is reachable. A test merely asserting the captured request contains the old points would certify the snapshot while missing the bug. If owned elsewhere, make the proven fix an explicit dependency rather than claiming closure.

### The physical card loses its envelope on project load

L162 bounds the newly created gradient. L168 subsequently loads an unspecified older project. Project loading restores job settings and objects, so the previous “no more than 20%” instruction cannot mechanically constrain the newly loaded document. FRAME in L163 also precedes this load; it does not validate the replacement job's bounds.

Use an archived pre-fix project containing only the test gradient and old raw points, with its safety-relevant settings enumerated and checked after loading. Preserve the legacy curve while bounding power, minimum power, speed, M4 mode, passes, geometry, layer enablement, and transformations. Regenerate, inspect the resulting job, and frame that exact job before each burn. Byte preservation belongs to T5/N3; there is no need to burn an arbitrary historical job to prove it.

The card also says “physical power switch or E-stop” (L160) but then “STOP, then the physical switch” (L164). Identify the device that actually isolates laser power on the owner's setup and require immediate isolation without waiting for a UI response on flame or unresponsive control. A generic 20% ceiling is not an energy limit across different machines and speeds; retain only an already established safe material/machine recipe, with a skip condition if none exists. Name the worst cases: stock ignition, off-stock marking, and continued emission after STOP. The amended DECISIONS release permission does not turn these into proven safe control paths.

## Three stress tests

### Pre-mortem

It is three months out and this failed:

1. Lee selects the corrected preset during a slow generation. The older inverted job finishes and is marked current. START burns the bright background rather than the intended dark image, ruining the workpiece and potentially increasing sustained heating. We should have caught the unconditional stale reset, not accepted “reads the store once” as concurrency protection.
2. The owner follows the legacy check by opening a production project. Saved high power, multiple passes, or extra layers replace the small test job. The type-specific worst case is ignition or a burn outside the verified scrap area; a stale frame and an unspecified physical cutoff are inadequate controls.
3. The physical Posterize card fails or is incorrectly marked qualified because the layer retained a dithering mode or image adjustment that changes the expected bands. The software regression fixture explicitly selects grayscale, but the owner card does not. A reproducible recipe and retained settings/G-code evidence would have exposed the mismatch.

### Load-bearing assumptions

- **Snapshot implies safely published result — confidence: contradicted in the inspected tree.** Consequence: obsolete laser output can appear current after Apply. Resolve before implementation by specifying a publication guard and its regression test.
- **The bounded recipe survives opening the legacy project — confidence: low and unsupported.** Consequence: an owner test can send a different, higher-energy job. Resolve before physical execution; the corrected procedure belongs in this plan before approval.
- **Preset points retain their meaning through serialization, interpolation, and scanning — confidence: high from inspected seams, pending T2/T5/N1–N3.** Consequence if wrong: wrong spatial power or changed legacy output. Pin the actual capture commit and keep fixture generation separate from assertion.
- **Three optical bands follow from the stated physical setup — confidence: medium-low.** Consequence: inconclusive or misleading qualification because dithering, minimum power, and material response are unspecified. Resolve configuration before execution and permit inconclusive evidence rather than tuning the acceptance result into existence.

### Inversion

Automatic migration would win only if a stored curve carried reliable preset identity and an explicit owner-approved migration policy. The plan establishes that files contain raw points; those conditions are not present, so preserving old points remains justified.

A separate prerequisite for generation publication would win over the claim that this is an isolated preset-only batch if asynchronous results can overwrite edit-time staleness. That condition is already present in the inspected code. Either expand and re-size the plan to close it or establish a dependency on its tested fix. Declaring the snapshot sufficient is not a third option.

## Overall verdict

FAIL: the preset correction itself is sound, but this revision claims a concurrency safeguard that the current code does not provide and leaves the legacy physical test outside its own safety envelope. These are gating X5 and X1 failures. The revised tests and no-migration strategy substantially address compatibility, but the fold table overstates closure of generation failure and re-entrancy. Preserve the narrow preset fix while explicitly resolving its safety dependencies and making the hardware recipe bounded and reproducible.

## Prioritized must-fix list

1. **P0:** replace the false stale-result claim with a proven publication guard or an explicit prerequisite; test delayed generation across Apply and any reachable overlapping completion.
2. **P0:** replace the arbitrary legacy burn with a dedicated bounded fixture; verify settings after load, regenerate and frame each job, and specify immediate physical laser isolation and worst-case outcomes.
3. **P1:** specify grayscale, minimum power, neutral image adjustments, interval, and an established safe material recipe for the owner card; do not infer physical qualification from unspecified settings.
4. **P1:** test failed regeneration after Apply and test the actual curve stroke, not only handle arcs; correct the corresponding fold-table closure claims.
5. **P2:** include all three golden files and any concurrency work in the batch inventory, waiver, and dependencies; index any deferred prerequisite in the ROADMAP Parking Lot.

