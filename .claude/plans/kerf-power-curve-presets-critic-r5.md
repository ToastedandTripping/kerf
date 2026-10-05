## Applicability

Project type: safety-relevant desktop laser CAD/CAM correctness fix, with asynchronous generation, saved-project compatibility, release copy and an owner hardware test. Reviewed revision 5 against the supplied rubric; checked relevant source in the target worktree at `18b4ef3`, the parent TB3 requirements, and Kerf's `.claude/DECISIONS.md`. This is an independent review, not implementation or hardware qualification.

Active universal dimensions, all [GATING]: 1 Problem-fit; 2 Approach soundness; 3 Completeness; 4 Right-sizing & reuse; 5 Security; 6 Failure modes; 7 Change safety; 8 Data integrity & compatibility; 9 Verifiability; 10 Maintainability.

- X1 fires [GATING]: preset values reach laser G-code, and the plan prescribes physical burns.
- X2 does not fire — N/A: this change neither introduces personal/client records nor changes their collection, access or retention; synthetic project fixtures are used.
- X3 fires [GATING]: source-derived safety and correctness claims support the release decision and public release note.
- X4 fires [ADVISORY]: user-facing release wording and warnings are included; no money, legal terms or signature is involved.
- X5 fires [GATING]: asynchronous generation, replacement and remount share state; X1 makes concurrency gating.
- X6 fires [ADVISORY]: the change ships in a released desktop application and needs actionable runtime evidence.
- X7 does not fire — N/A: using the existing mutation harness does not modify MARVIN gates, hooks, skills or automation.
- X8 fires [ADVISORY]: a subscription runs on every store notification, including frequent machine/UI updates; no new dependency is proposed.

## Dimension verdicts

1 Problem-fit [GATING] — PASS: the written grill skip and Summary address the parent TB3 requirements, and preserving stored points accords with the stated compatibility intent and checked decisions.
2 Approach soundness [GATING] — CONCERN: the ticket protocol is plausible, but “a new state read inside `generateGcode` ... is a `tsc` error” overstates what `Pick` enforces; restrict the claim to reads through `inputs` and explicitly control direct store reads and helper dependencies.
3 Completeness [GATING] — CONCERN: “the handler, every duty specified” misses invalidation during its awaited sparse-image analysis after publication; specify the resulting warning/Preview behavior and add a deferred-analysis replacement case.
4 Right-sizing & reuse [GATING] — PASS: both batches fit the eight-file limit, dependency order and shared ROADMAP integration are explicit, and the cross-directory atomicity explanation supplies a substantive waiver rationale even though calling all of `src` one subsystem is imprecise.
5 Security [GATING] — PASS: no new credential, network, shell-input or permission boundary is introduced; the change uses existing generation and project-loading seams.
6 Failure modes [GATING] — CONCERN: “a real failure and touches nothing” contradicts the specified status and console writes on rejection from an obsolete project; label obsolete failures with their context and test them after replacement/supersession.
7 Change safety [GATING] — PASS: production Rust and stored data remain untouched, rollback distinguishes the dependent batches, and rollback explicitly acknowledges restoration of the race.
8 Data integrity & compatibility [GATING] — PASS: epoch separation, raw-point preservation, real save/open seams and pinned-base output goldens address project contamination and compatibility without guessing users' intended curves.
9 Verifiability [GATING] — FAIL: the guard harness names a nonexistent vector invoke and assumes simultaneous pending paths, m8 is assigned to a Vitest-only battery although N2 is Rust, and G5 requires no-op behavior contradicted by retained setters; repair these executable specifications before implementation.
10 Maintainability [GATING] — CONCERN: the same-result subscription exception treats simultaneous result/input writes as trusted without a provenance check; document and check the production write boundary rather than claiming removal of one setter prevents future bypasses.
X1 Physical & human safety [GATING] — CONCERN: the bounded card and physical-disconnect abort are explicit, but START/FRAME safety evidence depends on the broken guard harness; repair and execute that evidence before claiming admission protection, and retain the stated unqualified hardware status.
X3 Evidence & source integrity [GATING] — FAIL: the claims “generate_vector_gcode” and “so both invoke paths are pending” conflict with the actual generator, while the compiler claim exceeds its demonstrated enforcement; correct the source trace and qualify the claimed controls.
X4 Audience, brand & money accuracy [ADVISORY] — CONCERN: “Discarded an earlier G-code generation; a newer one is running” is false in G6's B-finishes-first case; say that a newer generation was started or superseded this result.
X5 Concurrency & re-entrancy [GATING] — CONCERN: the publication identities cover the main completion race, but subsequent awaits and synchronous subscription ordering are not tested; add post-publication invalidation and subscriber-observation cases without overstating atomicity.
X6 Operability & observability [ADVISORY] — CONCERN: G9's “exactly one console line” ignores generator warnings emitted before discard; distinguish the handler's discard line from generation diagnostics and associate obsolete diagnostics with their generation/project.
X8 Dependencies, performance & cost [ADVISORY] — PASS: twelve reference/value comparisons per notification are bounded, no packages are added, and the proposed subscription avoids cloning image data.

## Findings and concrete repairs

### A. The guard harness cannot exercise the described sequence

Plan line 140 specifies “`generate_image_gcode` / `generate_vector_gcode` returning deferred promises” and “One image object and one rectangle are seeded, so both invoke paths are pending.” In the actual `src/lib/machine/gcodeGen.ts`, raster generation is awaited at line 1100; the vector invocation follows at line 1182 and is named **`generate_gcode`**. It cannot already be pending while the earlier raster promise is unresolved. A harness waiting for both calls before releasing either hangs; a permissive default mock risks passing without exercising the vector path.

Fix: use the real command name, make unknown invoke names fail, and describe the actual sequence. Hold raster, mutate, release raster, wait for vector, release vector. Add a second case that mutates while vector is pending. Resolve every outstanding promise in remount cases. Assert that START/FRAME refusal has the intended reason and produces no dispatch. G5's laser-mode-off row also needs care: a competing laser-mode refusal must not substitute for the stale-result assertion.

### B. The native decoder mutation is never run by its assigned command

Plan line 226 says “N2 itself must fail on each,” independently for an X displacement and an S corruption. Line 250 assigns m8 to “the vitest spec (m1-m13, m15, m16)” and runs only a separate tsc spec. N2 is a native Rust test. Vitest's T2 reads two Rust preset constants; it does not execute the N2 decoder. Changing the native fixture-transform hook therefore cannot produce the promised N2 failure under that command. Running unmutated cargo tests elsewhere does not falsify the oracle.

Fix: give the two m8 variants distinct mutation entries in a cargo-test battery with the exact native test filter, feature/environment settings and unmutated baseline. Confirm each fails the spatial/power assertion, rather than a syntax or build error. Keep TS source-sync mutants and the compiler mutant in their appropriate batteries. Update the verification and closure criteria to name all three commands.

### C. G5's no-op requirement conflicts with the implementation constraints

Plan line 150 requires “setting the same value leaves a current result current.” Design 5 also keeps “The 15 existing raisers ... redundant and harmless.” `setStartCorner` and `setOriginTop` at `store/index.ts:861-875` set staleness whenever a result exists, even for the same value. `updateLayer` replaces the layers array and raises staleness as well. A new reference comparator cannot undo those earlier writes; the proposed subscription only changes false to true. Thus G5 cannot pass as written while these setters remain unchanged.

Fix: either explicitly limit the no-op controls to scalar setters that already preserve currentness (machine settings and workspace dimensions), retaining conservative invalidation elsewhere, or include value-equality changes and their review in scope. Do not weaken assertions silently during implementation. Reference identity is not semantic equality for newly allocated arrays.

### D. The type and publication boundaries are narrower than claimed

Design 5 says “From then on, a new state read inside `generateGcode` that is not in the key set is a `tsc` error” while explicitly introducing `useStore.getState().addConsoleLine` calls inside that function. `useStore.getState().camera` is still legal TypeScript; m14 only proves that `store.camera` fails on the narrowed local variable. Helper functions can also acquire new external dependencies without changing that type. Likewise, removing `setGcodeResult` does not make `useStore.setState({ gcodeResult, ... })` illegal. The subscription deliberately trusts simultaneous input/result changes, and G8/m16 preserve that exception because tests need it. Test convenience is not evidence that an arbitrary input/result pair is coherent.

Fix: state the actual guarantee and add a source-boundary check or separate generation core with no store import if automatic prevention is required. Establish that production result writes use the ticket action (apart from explicit clearing), with direct pair-seeding confined to tests. This does not require inventing a malicious-caller threat model; it prevents ordinary future code from accidentally bypassing the advertised invariant.

### E. Publication is not the end of the handler's asynchronous work

The “published” branch preserves “today's sparse-image check.” That code awaits `Promise.all(getImageContentRatio(...))` after publishing (`MachinePanel.tsx:401-411`). During this await, project B can load and clear the result; afterward A can set a sparse warning and return true, allowing the Preview continuation (`:1270-1273`) to open Preview in B. G9 only tests calls already obsolete when `publishGeneration` runs. This finding concerns side effects after a successful publication; it does not claim the epoch guard itself publishes A into B.

Fix: revalidate identity after that await and before warning/Preview side effects, or explicitly define and defer that behavior with narrower handler guarantees. Exercise it with deferred content analysis and both replacement and remount/supersession. Separately, the generator itself emits console warnings before publication, so “exactly one console line” must mean one discard-outcome line, not one total line across a warning-producing run.

The statement “Zustand 5 notifies subscribers synchronously inside `set`, so no reader can observe the gap” also needs precision. Installed `zustand/vanilla.js` assigns state before iterating listeners; the raiser is a second, nested write. Registering it first may make subsequent ordinary readers see the corrected state, but synchronicity alone does not prove that. Test the actual registration/order invariant and avoid calling two writes universally atomic.

## Stress test 1 — Pre-mortem

Three months out, the laser engraves the wrong program or at the wrong effective power: this is the type-specific worst case, potentially ruining material or starting a fire. A miswired deferred-invoke harness passed without testing the vector completion phase, and the shipped-entry evidence overstated what admission had actually been exercised against. The warning signs were a nonexistent command name and an impossible simultaneous-pending setup.

A later generator change reads another machine field directly from the store. TypeScript stays green, tickets omit that dependency, and a program generated for earlier settings remains apparently current. The warning sign was treating a narrowed local variable as a whole-function dependency restriction.

The owner changes projects while long-job image analysis is pending. A stale warning or Preview opens in the new project and undermines trust in which generation the UI describes. The warning sign was equating publication completion with completion of all handler side effects.

## Stress test 2 — Load-bearing assumptions

- **Generation-input snapshots remain immutable and complete — medium confidence.** The twelve-field inventory is concrete, but a selector rule about stable references does not itself enforce immutability or forbid helper/global reads. If wrong, unchanged reference comparisons can certify changed inputs. Resolve the claimed enforcement boundary before implementation.
- **The harness models the real invoke sequence — low confidence as written.** Source disproves the command name and pending-order description. If wrong, the principal concurrency evidence hangs or tests a different path. Resolve before implementation.
- **The mutation command executes the oracle it claims to test — low confidence as written.** The specified Vitest command cannot run native N2. If wrong, the decoder remains unchallenged despite a claimed mutation proof. Resolve before implementation.
- **The identified physical disconnect removes laser-module power — unverified until the owner card.** Failure leaves emergency software STOP as an unreliable fallback during the card. The plan correctly requires identifying the supply and declining the run if uncertain; this remains an owner prerequisite, not software-test evidence.

## Stress test 3 — Inversion

The rejected hand-incremented revision approach would win if all generation-affecting mutations passed through one enforced mutation boundary, instead of a growing inventory of setters. That condition is not shown and the plan documents missed setters, so returning to that approach is not justified. A small pure generation core with explicit inputs would beat the current broad compiler-enforcement claim if automatic prevention of hidden reads is required; the current ability to call `useStore.getState()` already establishes that need for either stronger enforcement or narrower wording. Automatic migration of old curves would win only with trustworthy provenance distinguishing old presets from deliberate custom curves; raw points provide none, so that condition is absent.

## Overall verdict

FAIL — blocked on core dimension 9 and gating X3. The preset correction and project/sequence ticket design are credible, but this revision still specifies tests that cannot run as described and claims guarantees stronger than the proposed controls. The round-five cap is not evidence and does not override these failures. Fix the executable verification contract and narrow or enforce the disputed guarantees before implementation; no broad redesign of the preset fix or change to the owner's release rulings is required.

## Prioritized must-fix list

1. **P0:** Correct the guard command names and sequential deferred-promise harness; cover mutations during both raster and vector waits with real admission assertions.
2. **P0:** Run each m8 mutation through an explicit native cargo-test battery and require the intended assertion failure.
3. **P1:** Reconcile G5 no-op expectations with the retained setters and reference-equality semantics.
4. **P1:** Correct the compiler/publication-boundary claims; document or enforce the allowed production reads and writes.
5. **P1:** Specify and test identity handling after sparse-image analysis; qualify the subscription atomicity claim with actual ordering evidence.
6. **P2:** Correct supersession wording, distinguish discard lines from earlier generator diagnostics, and contextualize obsolete-call failures.
