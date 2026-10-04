# Applicability

Project type: a laser-control desktop application correctness change affecting raster power, a React canvas lifecycle fix, and release documentation. Reviewed revision 1 against the supplied rubric, the parent plan's TB3 requirements, standing DECISIONS, and the current source tree (HEAD `70cdfa1`; the plan cites diagnosis base `8e7dfcc`). No implementation or physical test was performed.

Active universal dimensions: 1 Problem-fit [GATING]; 2 Approach soundness [GATING]; 3 Completeness [GATING]; 4 Right-sizing & reuse [GATING]; 5 Security [GATING]; 6 Failure modes [GATING]; 7 Change safety [GATING]; 8 Data integrity & compatibility [GATING]; 9 Verifiability [GATING]; 10 Maintainability [GATING].

- X1 Physical & human safety [GATING] fires: preset values become laser power commands, and the plan explicitly prescribes powered engraving.
- X2 Privacy & data stewardship: N/A, does not fire; the proposed fixtures are synthetic ramps and curve arrays, with no personal/client records or new collection path in scope.
- X3 Evidence & source integrity: N/A, does not fire; this is a software correction with source-based diagnosis, not research or public factual analysis. Technical proof and release-copy accuracy are assessed under 9 and X4.
- X4 Audience, brand & money accuracy [ADVISORY] fires: the plan supplies user-facing release instructions; no money, legal terms, or signature is involved.
- X5 Concurrency & re-entrancy [GATING] fires: reopening the editor and applying shared layer state while generation may be in flight are retriggerable paths. Gating follows the rubric's X1-class rule.
- X6 Operability & observability [ADVISORY] fires: this ships in a released desktop application with owner verification and release-session handoffs.
- X7 Self-modification safety: N/A, does not fire; using the existing mutation runner does not modify MARVIN gates, hooks, skills, or automation.
- X8 Dependencies, performance & cost: N/A; no added dependency, service, polling, or substantial hot-path work is proposed. The existing bounded canvas draw gains an open trigger.

# Dimension verdicts

PASS — 1 Problem-fit [GATING]: Lines 5–13 contain an explicit grill skip and target the parent TB3 defect; preserving stored curves accords with the standing preference against silently changing saved jobs.

PASS — 2 Approach soundness [GATING]: Lines 31–35 mirror the inverted powers and add the canvas mount trigger without changing native production code; the inspected LUT convention and React effect support these corrections.

FAIL — 3 Completeness [GATING]: Lines 63–68 test only old S-Curve loading/highlighting and line 81 generates only the new S-Curve, leaving Posterize and the actual Apply-to-raster path without equivalent coverage; add both presets through Apply, save/reopen, raster request construction, and old/new generation.

CONCERN — 4 Right-sizing & reuse [GATING]: “Three code files” (line 47) spans frontend and native roots without declaring a tier, local dependency graph, or cross-root waiver; declare Simple if justified, or specify dependent frontend/native batches (or an explicit single-batch waiver), preserving TB3-before-A4 and indexing any new deferral in ROADMAP.

PASS — 5 Security [GATING]: The listed edits add no privilege, network, secret, or untrusted-input surface; test source reads are local repository reads.

CONCERN — 6 Failure modes [GATING]: “Nothing else in the editor changes” (line 34) leaves failure behavior implicit, including the existing null-context early return and failed generation; name and verify that unavailable rendering or generation does not silently apply a replacement curve or dispatch a job, without expanding this into unrelated error-handling work.

CONCERN — 7 Change safety [GATING]: “Projects are unaffected either way, because no stored data changes” (line 116) is too broad: applying and saving a corrected preset does store new raw points; document that revert restores preset definitions but preserves any saved corrected points and may remove their preset highlight.

FAIL — 8 Data integrity & compatibility [GATING]: “This pins ‘saved projects unchanged’” (line 67) overclaims a parse-only check and a private vector builder call; the binding parent requires a save/reopen round trip and byte-identical old-project generation, so add real serialization/reopening plus baseline-versus-candidate raster G-code comparison for both legacy arrays.

FAIL — 9 Verifiability [GATING]: “At least one `stroke` call” (line 60) accepts grid-only rendering, and “S word per burned pixel” (line 80) ignores compressed segments and omitted white pixels; assert the actual curve path, decode spatial power coverage, use an independent expected oracle, and specify an executable pinned-base comparison and mutation restoration procedure.

CONCERN — 10 Maintainability [GATING]: Line 59's source-sync pin can work, but line 65 calls a non-exported helper and line 89 leaves mutation targets unspecified; choose existing public seams, make fixture extraction fail on missing/duplicate arrays, and identify where mutation definitions and artifacts live within the declared file scope.

FAIL — X1 Physical & human safety [GATING]: “Owner hardware (fire precautions; status-only evidence)” (line 111) names neither a bounded burn setup nor failure-to-safe-state procedure and blurs commanded status with visible material results; specify the owner-only safe test envelope, physical isolation/abort actions, applicable existing interlocks, and unqualified release status under DECISIONS.

CONCERN — X4 Audience, brand & money accuracy [ADVISORY]: “Four bands” (line 111) implies a useful fourth width although the proposed zero-power band is only shade 255, and “pick the preset again” (line 36) omits Apply; describe the exact band boundaries and give complete apply/save/preview instructions.

CONCERN — X5 Concurrency & re-entrancy [GATING]: The single closed-to-open transition in line 60 does not cover reopen, changed incoming points, or applying while a generation snapshot exists; add focused repeated-open/Cancel/Apply checks and identify the existing generation snapshot rule so a pending job cannot acquire mixed curve state.

CONCERN — X6 Operability & observability [ADVISORY]: A release-note line “owed by the release session” (line 36) plus a ROADMAP “shipped entry” (line 45) can mark work complete while hardware evidence is still pending; name the release handoff and distinguish implementation shipped, owner test pending, and physically qualified in the recorded status.

# Three stress tests

## 1. Pre-mortem

1. **Three months later a corrected preset scorches scrap or starts a fire during qualification.** Selecting the corrected curve intentionally moves maximum commanded power to the opposite end of the image. The owner instruction merely says “engrave it on scrap,” with no named material, conservative power/speed envelope, dimensions, operating mode, setup isolation, or response to unexpected emission or loss of controller response. The type-specific worst case is sustained laser emission causing fire or injury, not merely a negative photo. The warning sign was treating “fire precautions” as an executable control. Name the existing interlocks and a physical power-isolation fallback; do not assume software status proves beam-off. DECISIONS' status-only entry and its 2026-09-25 witness amendment explicitly limit what may be claimed and keep existing blocks in force until accepted evidence exists. This correction need not redesign the stop system, but its test card must respect that boundary.

2. **A saved legacy job generates differently while all new tests pass.** T4 reads a layer and tests `buildCutLayer`; that helper is private in `src/lib/machine/gcodeGen.ts:80`, and the raster invocation constructs its own request around lines 697–729, with another power-curve mapping around line 1244. A vector helper check cannot establish the raster path's preservation. N2 compares Linear/no-curve across revisions, not the loaded legacy raster. The parent plan at lines 576–577 explicitly requires old layers to “load[] and generate[] byte-identically” and a “save/reopen round trip.” Test those operations with old S-Curve and old Posterize fixtures through the real raster entry point, including request capture and fixed-baseline output.

3. **The evidence suite stays green while the curve is absent or the output is wrongly sampled.** The draw routine strokes 18 grid lines and a dashed diagonal before it strokes the curve, so deleting the curve block still satisfies T3's stated oracle. The scanner in `mask_fill.rs:684–718` merges equal rounded S values into one move, while white pixels can be absent from burn runs. Merely sorting emitted S words cannot prove per-pixel placement or the unburned endpoint, and accepting “not burned” without checking spatial coverage is especially weak. Record the curve-specific path and test deletion of that block; interpret motion spans, power, and gaps against known ramp coordinates. Include exact Posterize plateaus and boundaries (0–84, 85–169, 170–254, 255), not just monotonicity.

## 2. Load-bearing assumptions

- **Preset Y means normalized power, with the corrected endpoints intended. Confidence: high.** The component comments and native LUT implementation agree. If wrong, the correction reverses exposure again. No external research is needed; retain direct engine output assertions.
- **Raw stored points survive all save/load and raster generation paths. Confidence: medium.** The inspected mappings preserve raw points, but the planned test does not traverse the complete route. If wrong, existing jobs silently change material output. Resolve before implementation by identifying the real serializer, parser, and raster request entry points, then make them the regression seam.
- **A emitted S token can stand in for one ramp pixel. Confidence: low; contradicted by inspected compression code.** If assumed, the generation test misindexes power or skips precisely the white endpoint it claims to prove. Resolve before implementation with a segment-aware oracle and explicit geometry, interval, adjustments, power range, and disabled unrelated transforms. `ImageEngraveRequest` has `power`, `power_min`, and `s_value_max`, not request fields named `s_min`/`s_max`; specify their concrete values.
- **The owner card supplies sufficient physical qualification. Confidence: low/unverified.** Status reports cannot establish burn darkness or optical shutdown; visible material results establish only the observed material outcome. If mistaken, a successful software test becomes an unsupported safety claim. Resolve the test prerequisites and evidence limits before scheduling powered work, while allowing software verification to proceed independently.

## 3. Inversion

The rejected automatic migration would win only if stored points unambiguously identified an erroneous preset selection and the user authorized changing that saved job's output. Neither is established: the file contains raw points, indistinguishable from an intentional custom negative curve. Keep no migration. Conversely, a smaller LUT-only proof would suffice if preset values never reached hazardous output; that condition is false. The appropriate reduction is to reuse existing save/load, raster request, and motion-interpretation seams instead of adding a source accessor or treating duplicated literals as independent evidence. The current implementation already makes those distinctions important.

# Overall verdict

**FAIL — gate blocked.** The proposed production correction is plausible and small, but the plan does not meet its own binding saved-job acceptance contract, its canvas and G-code oracles cannot establish their stated claims, and the powered verification instruction lacks an actionable safety boundary. Fix the evidence and owner-test specification while retaining the narrow preset/effect change and no-migration policy. Pending physical evidence must remain visibly pending; a ROADMAP shipped label or simulated status cannot qualify it.

Prioritized must-fix list:

1. **P0:** Replace line 111 with an owner-only bounded test card that names existing interlocks, setup isolation, abort/physical isolation on failure, evidence limits, and the standing release blocks; do not claim shutdown from status or schedule unqualified powered work implicitly.
2. **P1:** Meet the parent contract for both old presets: actual save/reopen, real raster request path, and byte-identical baseline/candidate generation; include both corrected presets through Apply and generation.
3. **P1:** Repair the proof oracles: curve-specific drawing, spatial reconstruction of compressed G-code and missing white pixels, exact Posterize levels, pinned-base comparison commands/artifacts, and uniquely targeted/restored mutations that demonstrably fail the relevant assertions.
4. **P2:** Declare tier/batch dependencies or waiver, test reopen and job-snapshot behavior, correct rollback wording, and make release instructions and pending hardware status explicit. Index any resulting deferral in ROADMAP.
