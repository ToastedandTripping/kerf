## Applicability

Project type: Standard-tier laser CAD/CAM desktop-app correctness fix, asynchronous generated-job publication guard, and owner-operated physical qualification. Reviewed revision 4 as an independent critic. Plan references below are line numbers in `kerf-power-curve-presets.md`. Source checked at HEAD `4c82aa1`; `git diff 70cdfa1 HEAD` is empty for the store, MachinePanel and MaterialTestDialog files underlying the findings.

- Core 1–10: all fire, all **[GATING]**: Problem-fit; Approach soundness; Completeness; Right-sizing & reuse; Security; Failure modes; Change safety; Data integrity & compatibility; Verifiability; Maintainability.
- X1 Physical & human safety: **fires [GATING]** — preset values become laser power, and the plan includes powered hardware tests and a job-publication interlock.
- X2 Privacy & data stewardship: **does not fire, N/A** — synthetic gradients and project fixtures do not contain personal/client records; the controller-model evidence is permitted by the 2026-09-27 DECISIONS amendment. Keep any incident narrative or new diagnostic capture in the existing private evidence location.
- X3 Evidence & source integrity: **fires [GATING]** — source claims determine which publication paths are exempted from the safety guard, and the plan supplies public claims that the race is fixed.
- X4 Audience, brand & money accuracy: **fires [ADVISORY]** — public release-note wording; no money, legal terms or signature.
- X5 Concurrency & re-entrancy: **fires [GATING]** — overlapping asynchronous generation shares a store and feeds X1-class output.
- X6 Operability & observability: **fires [ADVISORY]** — released desktop app, stale-result feedback and owner qualification evidence.
- X7 Self-modification safety: **does not fire, N/A** — the plan changes Kerf, not MARVIN gates, hooks, skills or automation; invoking an existing mutation runner is not modifying it.
- X8 Dependencies, performance & cost: **fires [ADVISORY]** — revision increments enter shared object-edit paths, including frequent updates; no new package/service is proposed.

## Dimension verdicts

PASS — 1 Problem-fit [GATING]: The explicit grilled-intent skip and Summary (L5–13) satisfy the Standard-tier requirement; correcting preset polarity and first-open rendering matches TB3, preserves saved custom curves, and does not reinstate the release blocks lifted in DECISIONS.

FAIL — 2 Approach soundness [GATING]: “It increments at every site that raises staleness today (the 12 sites, `setWorkspaceSize` … and `applyObjects`)” (L58) is an incomplete enumeration: `setGrblSValueMax` also conditionally raises staleness (`store/index.ts:614–626`), but its condition is absent from both the design and G5; changing the power scale while generation is pending therefore permits completion to clear the stale flag. Fix: include power-scale changes, regardless of whether a prior result exists, and use current store state at publication, with a behavioral regression test.

FAIL — 3 Completeness [GATING]: “new project resets it” (L42) understates the actual `loadProject` transition (`store/index.ts:505–527`), shared by Open and New: it replaces the entire design and clears the result, yet L58 gives it no revision/epoch increment. Start generation in A, load B with the same bed/origin, then resolve A: neither proposed check changes, so A publishes current in B. Fix: invalidate in-flight work on every project replacement with a non-reused identity and test Open and New, including a previously empty result slot.

CONCERN — 4 Right-sizing & reuse [GATING]: The eight-file `tb3` waiver and serialized ROADMAP integration are explicit, but `tb3-guard` crosses store and panel subsystem roots (L74) without its own waiver; the L93 waiver explicitly applies to the other batch. Fix: add the short store-to-handler atomicity justification to `tb3-guard`, and keep the guard corrections inside that bounded batch rather than expanding into all of TB6.

PASS — 5 Security [GATING]: The proposed mutations introduce no credential, network, authentication or untrusted executable surface; the committed owner project is a synthetic fixture. Job correctness and physical blast radius are assessed under the active safety dimensions below.

CONCERN — 6 Failure modes [GATING]: L61 specifies “drop this result and say nothing,” but the modified handler also owns a boolean return, console reporting, an additional asynchronous image-ratio check and `finally { setGenerating(false) }` (`MachinePanel.tsx:381–416`); the plan specifies only result publication. Fix: define obsolete-call success/failure/finally behavior and test that an older call cannot clear the busy state or replace a warning while a newer call is pending; retain T4's rejected-regeneration test.

CONCERN — 7 Change safety [GATING]: “Revert is one commit” (L244) is not established by the two dependent batches (L70–75), and the rollback paragraph only describes preset definitions despite new store/handler contracts. Fix: state the actual squash or reverse-dependency revert procedure, including setter/type changes and revision state, and distinguish reverting the preset correction from removing the publication guard; saved raw points must remain untouched.

FAIL — 8 Data integrity & compatibility [GATING]: “It is never shown as current” (L64) fails on project replacement: the saved curves survive, but an old project's executable artifact can be attached to the new project as current. Fix: reject results from another project epoch rather than merely displaying them in the replacement project, and keep the no-migration round trip and pinned-base goldens.

FAIL — 9 Verifiability [GATING]: G5 says “the count is exact, so a new raiser without the increment turns it red” (L108), yet it enumerates only the 12-form pattern and two named exceptions; the already-existing differently shaped power-scale raiser and `loadProject` are outside that inventory. G1–G4 can all pass while both unsafe traces remain. Fix: add deferred-promise behavioral tests for power-scale change, Open/New, and identity reuse/remount, asserting real store state and START/FRAME refusal; inventory actual mutations rather than treating a regex count as exhaustive, and mutate each newly covered invalidation to prove its test fails.

CONCERN — 10 Maintainability [GATING]: Current instructions disagree: L37 and L248 say TB3 closes the race, but T4 says it “is TB6's” (L129) and the owner prerequisite says “until TB6 lands” an edit can publish current (L228). Fix: reconcile the live design, tests, owner card and Parking Lot status around precisely what this guard closes; historical fold tables can remain explicitly historical.

FAIL — X1 Physical & human safety [GATING]: The claimed interlock “START and FRAME stay blocked” (L64) cannot protect a result whose stale flag is incorrectly false; `canStartJob.ts:191–195` checks result existence and that flag, not project/generation identity. With otherwise eligible machine state, the A→Open B→A completion trace can admit A's powered job against B's displayed design; an omitted power-scale invalidation adds incorrect-output risk. Fix: close these software invalidation paths and prove admission refusal before declaring the guard safe; framing a bounding box and the owner's “make no edit” instruction cannot verify job identity or power distribution. The type-specific worst case is unintended laser marking/material damage or fire.

FAIL — X3 Evidence & source integrity [GATING]: “MaterialTestDialog.tsx:283 … publishes the material-test program” (L43) and “is synchronous” (L65) misread the source: L273–294 construct a local `displayGate` argument with `gcodeResult: null` and `gcodeStale: false`, with no store write; the actual material generation handler at L192 awaits `generateMaterialTestGcode` and later streams its local program. Fix: replace the publication inventory with actual store mutations, remove the fictitious publisher allowlist, and distinguish local-program admission from design-result publication; do not broaden the guard on the basis of this false premise.

CONCERN — X4 Audience, brand & money accuracy [ADVISORY]: The release note says a result finishing after a design change “is now marked out of date” (L55), but opening a different design remains a counterexample. Fix: finalize this claim only after the corrected guard tests pass, describe its actual scope, and retain the explicit pick → Apply → save legacy instructions.

FAIL — X5 Concurrency & re-entrancy [GATING]: L59 permits a “module- or ref-held counter” without specifying the lifetime of the last-published sequence or project identity, while L61 only rejects an older result after a newer generation publishes; changing projects without starting another generation bypasses this rule entirely. Fix: define a single coherent publication protocol with project epoch, input revision and ordered request identity, specify remount/reset semantics, and exercise both completion orders and project replacement; counters must not reset into a still-pending request's identity.

CONCERN — X6 Operability & observability [ADVISORY]: The owner evidence record and “not physically qualified” status are concrete, but L248 requires marking the entire indexed race shipped even though its stated guard misses ordinary replacement and scale-change paths. Fix: close the item only against the expanded evidence matrix, retain any residual work under TB6, and specify where stale versus discarded generation is visible without implying a superseded request succeeded.

PASS — X8 Dependencies, performance & cost [ADVISORY]: The proposed runtime work is constant-time revision/sequence bookkeeping on existing mutations; fixtures, source scans and mutation runs are test-only, with no new runtime dependency or service cost.

## Stress test 1 — Pre-mortem

It is three months out, and this failed:

1. **Wrong project reaches the laser.** An image-heavy generation is pending when the owner opens another project. The replacement clears the visible result but does not advance the guard's identity. The first job completes and appears current in the new design. START's other prerequisites can all pass. Worst case: the laser marks the wrong stock or starts a fire with the previous job's power/geometry. The warning was visible in the plan's own reset inventory, but the implementation only counted staleness-raising edits.
2. **Machine settings invalidate a pending job without invalidating its ticket.** A changed power-scale value raises the old stale flag, then completion overwrites it with `false` because the proposed revision did not change. The owner sees a current result containing S values derived from older settings. The missing `setGrblSValueMax` branch was already present at the pinned base; G5's exact count gave false assurance instead of testing this transition.
3. **Green tests and misleading closure persist together.** G1–G5 pass, the Parking Lot item is marked shipped, and a later author relies on the claim that all result publishers were reviewed. The purported material-test publisher was only a display predicate input, while real project replacement was unguarded. A source-shape test and a mistaken allowlist become the inherited specification.

## Stress test 2 — Load-bearing assumptions

- **Every generation-invalidating transition is in the enumerated raisers. Confidence: disproven by source.** `loadProject` and `setGrblSValueMax` are missing from the proposed revision inventory. Consequence: old output is current after a state change. Resolve before implementation by enumerating all relevant mutations and specifying replacement semantics.
- **A per-call counter plus a design revision has stable identity for the lifetime of every pending promise. Confidence: low/unverified.** The module/ref choice and reset/remount behavior are unspecified. Consequence: sequence reuse or separate component lifetimes can admit an obsolete result. Resolve before implementation with an explicit ownership/lifetime contract and deferred-promise tests.
- **MaterialTestDialog is a synchronous result publisher deserving an exception. Confidence: disproven by source.** It asynchronously produces a local program and the cited lines are display-only inputs. Consequence: the audit exempts the wrong thing and confuses two admission paths. Resolve before implementation by correcting the source inventory; this does not by itself require redesigning material tests in TB3.
- **Mirrored presets preserve saved-job output when stored points are untouched. Confidence: high for the design, implementation evidence pending.** The raw-point format supports this; T5 and base-captured N3 are appropriate independent checks. Consequence if broken: older saved jobs silently change burn output. Capture the goldens before production edits and retain their provenance.

## Stress test 3 — Inversion

For the rejected deferral of the publication guard to TB6 to win, TB3 would need an already-enforced invariant that pending generation cannot survive an invalidating edit or project replacement as current. The owner instruction to avoid edits is not that invariant, and the inspected source lacks it; those conditions are not true. A narrow guard is still justified, but it must cover the real state transitions. For migrating old preset-shaped arrays to win, files would need trustworthy provenance distinguishing deliberate custom curves from preset selection, plus authorization to change existing jobs. The plan states files contain only raw points, so those conditions are also not true; retaining no migration remains justified.

## Overall verdict

**FAIL — gate blocked.** The preset and rendering changes are well specified, but revision 4's new safety argument rests on an incomplete invalidation inventory and an incorrectly identified publication site. Its own tests can pass while generation from another project is published as current, leaving START and FRAME with no stale signal to reject. Correct the publication contract and evidence before claiming the race closed; this is a bounded correction to the proposed guard, not a demand to implement all of TB6 or reinstate a lifted hardware release gate.

## Prioritized must-fix list

1. **P0:** Invalidate pending generations on Open/New and power-scale changes; reject cross-project completions and define non-reused project/request identities with current-state publication checks.
2. **P0:** Add behavioral regressions and mutation checks for those transitions, both completion orders, and reset/remount semantics; prove START and FRAME cannot admit the obsolete result. Replace the incomplete G5 exhaustiveness claim.
3. **P1:** Correct the MaterialTestDialog evidence and remove its fictitious publication exception; name actual store publishers and resets.
4. **P1:** Define superseded success, error and cleanup behavior so old calls cannot alter a newer call's busy/warning state.
5. **P1:** Reconcile TB3/TB6 ownership, shipped status and release wording; document the guard batch's subsystem waiver and a rollback procedure consistent with the actual commit structure.
