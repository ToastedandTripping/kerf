## Applicability

Project type: Standard-tier desktop laser-control software change: raster presets, asynchronous G-code publication, saved-project compatibility, release copy, and an owner-operated hardware qualification card. Reviewed revision 6 against the working tree at `8101ace`; this is a plan review, not an implementation or hardware qualification.

Active universal dimensions, all [GATING]: 1 Problem-fit; 2 Approach soundness; 3 Completeness; 4 Right-sizing & reuse; 5 Security; 6 Failure modes; 7 Change safety; 8 Data integrity & compatibility; 9 Verifiability; 10 Maintainability.

- X1 fires [GATING]: changed presets determine laser power and the plan explicitly runs hardware burns.
- X2 does not fire — N/A: the scoped fixtures are synthetic gradients, and the change introduces no personal/client-record collection or processing; specified evidence is controller/build/material information and burn photos, not personal records.
- X3 fires [GATING]: source-derived safety and compatibility claims support release decisions and public release wording.
- X4 fires [ADVISORY]: user-facing release copy is included, without a monetary, legal, or signature obligation.
- X5 fires [GATING]: asynchronous generation, project replacement, remounts, and shared store publication are central; X1 makes concurrency gating.
- X6 fires [ADVISORY]: this ships in a released application and changes its diagnostics and qualification status.
- X7 does not fire — N/A: invoking the existing mutation harness does not modify MARVIN's gates, hooks, skills, or automation.
- X8 fires [ADVISORY]: a subscription runs on shared-store updates, and native builds plus mutation runs consume substantial local resources; no new external dependency is proposed.

## Dimension verdicts

PASS — 1 Problem-fit [GATING]: the Intent section contains an explicit grill skip, preserves saved raw points, and respects the release and beam-evidence rulings in DECISIONS.
PASS — 2 Approach soundness [GATING]: reversing the two value tables and drawing on open address the defects; epoch, sequence, and captured-input comparisons distinguish replacement, supersession, and stale completion.
CONCERN — 3 Completeness [GATING]: the owner setup permits “scrap card or a 3 mm plywood offcut” (L329), but the fixed recipe requires “material: scrap card” (L334); remove the plywood option so the supposedly fixed card has one interpretation.
PASS — 4 Right-sizing & reuse [GATING]: the two batches have a declared dependency, bounded file lists, a multi-root waiver, and serialized ROADMAP integration; deferred work has named ownership and an explicit index update.
PASS — 5 Security [GATING]: the change adds no credentials, remote access, or new privileged command surface; fixtures and source scans remain local.
PASS — 6 Failure modes [GATING]: rejected generation preserves the result, obsolete errors lose their status banner, discarded work cannot publish, and null canvas context applies nothing implicitly.
PASS — 7 Change safety [GATING]: dependency-ordered reverts and the merge revert are specified, including the return of the publication race and the persistence of already-saved corrected points.
PASS — 8 Data integrity & compatibility [GATING]: raw curves remain unmigrated, runtime counters stay outside project serialization, and T5 plus pinned-base native goldens cover the relevant persisted/output boundaries.
CONCERN — 9 Verifiability [GATING]: the strict mock omits the panel's mount-time `list_serial_ports` call, whose exception production catches, and the four-token tripwire does not prove allowed access sites; explicitly stub mount plumbing, assert the unknown-call ledger is empty, and strengthen or narrow the tripwire as detailed below.
CONCERN — 10 Maintainability [GATING]: “useStore appears exactly four times” (L71) is sensitive to harmless text edits while missing changes inside an existing occurrence; replace the count with site-aware checks or label it only an additive-access tripwire and assign same-site changes to review.
PASS — X1 Physical & human safety [GATING]: within this change's scope, stale/missing results retain START/FRAME admission checks, hardware testing is owner-only and bounded, and STOP failure has an independently identified physical laser-supply disconnect; this is not a claim that the application or card is physically qualified.
CONCERN — X3 Evidence & source integrity [GATING]: “A new store access anywhere in the module fails the tripwire” (L71) exceeds what a token count proves; restrict the claim or test permitted AST access shapes, including the count-preserving counterexample below.
PASS — X4 Audience, brand & money accuracy [ADVISORY]: the release note specifies pick, Apply, and save, distinguishes stale publication from project discard, and does not claim saved curves are repaired automatically.
PASS — X5 Concurrency & re-entrancy [GATING]: the installed Zustand listener loop supports the stated nested-write ordering, while G3/G6/G7/G11 cover project replacement, both completion orders, persistent identities, and the sparse-analysis await.
PASS — X6 Operability & observability [ADVISORY]: published-stale, discarded, and obsolete-failure outcomes have distinct diagnostics; pending hardware qualification is explicitly separate from implementation status.
PASS — X8 Dependencies, performance & cost [ADVISORY]: the production subscription compares twelve references/scalars without deep cloning, and the native mutation specification names a disk floor and shared target directory without adding packages or services.

### Specific concerns and evidence

**The occurrence count is a tripwire, not an access boundary.** L71 says it “closes that gap for this module” and that “A new store access anywhere in the module fails the tripwire.” Keep the same four `useStore` tokens but change the default logger from `useStore.getState().addConsoleLine(msg, level)` to a block that assigns `const live = useStore.getState()` and reads `live.camera` before logging. That adds a live state dependency during generation without adding a fifth token; `tsc` also accepts it. Likewise, counting does not establish that the four occurrences remain at the four named sites. Mutant m17 proves only detection of an additional spelled-out occurrence. This is not evidence that today's twelve inputs are incomplete, nor a reason to redesign the ticket protocol. Fix the overclaim and explicitly make same-site/alias changes a review obligation, or check the allowed access expressions structurally and add a count-preserving mutant. Do not advertise a count as exhaustive enforcement.

**The supposedly strict invoke harness silently encounters an unhandled command.** L159 says it answers only the two generation commands and “Any other command name throws.” However, the real `MachinePanel` mount effect calls `refreshPorts()` (`MachinePanel.tsx:334`), which calls `machineConnection.listPorts()`. That invokes `list_serial_ports`, catches the thrown exception, logs it, and returns `[]` (`connection.ts:440-447`). Consequently the baseline can pass while the strict mock throws on every mount, including the G6 remount. The existing `gcodeFailureLoud` harness explicitly answers this command. Add `list_serial_ports: []` to the non-generation plumbing, keep the generation calls deferred, record unknown commands before throwing, and assert the unknown-command collection is empty. Throwing alone is not a test failure when production catches the exception. Retain the separate assertions that neither job-dispatch command was called. This is a localized harness correction, not evidence that the production publication protocol fails.

**The fixed material has two contradictory instructions.** L329 offers plywood; L334 fixes scrap card, and L342 permits only a power change. Remove the unused plywood alternative. Otherwise an owner can follow Setup exactly and still violate the qualification recipe, making the observed tonal comparison less reproducible. The named physical isolation and abort procedure should remain unchanged.

## Stress test 1 — Pre-mortem

Three months out, the most serious type-specific failure is the laser burning an obsolete program at the wrong power or location, damaging the workpiece or starting a fire.

1. A later generator edit adds a live-state read through an already-counted store access. The count and compiler remain green, but the result no longer corresponds wholly to its captured ticket. The warning sign was treating four tokens as proof of four approved read expressions. Narrow the claim and enforce the review obligation before implementation.
2. The regression harness produces caught “unexpected invoke” errors on every mount. A future unexpected dependency is dismissed as the same harmless console noise, and a negative-path test passes because a different dependency failed first. The warning sign was permitting baseline unknown-command exceptions rather than requiring a clean command ledger.
3. The operator exports an old result after editing and later runs the file through another sender. START/FRAME protection in Kerf does not travel with that file. L376's “a file, not a laser path in Kerf” correctly limits the local path but does not make the exported artifact nonhazardous. This is an explicitly parked pre-existing issue, not a newly discovered blocker for TB3; preserve the TB6 entry and do not let release copy imply all outgoing G-code is protected.

## Stress test 2 — Load-bearing assumptions

- **Generation inputs remain immutable references — medium-high confidence.** The design relies on the repository's immutable-update convention and passes captured objects/layers to asynchronous work. An in-place nested mutation defeats both snapshot identity and reference comparison. Resolve before implementation by recording the scoped writer/helper audit in Razor's brief; the review must include mutations through nested aliases, not merely extra `useStore` occurrences.
- **The raiser registers first under the installed Zustand implementation — high confidence for this tree.** `node_modules/zustand/vanilla.js` evaluates `listener(state, previousState)` for each listener using the current mutable state binding, so later outer notifications see the nested stale write. A future library or registration-order change can invalidate that reasoning; G12 is required evidence, not optional documentation.
- **Every project replacement reaches `loadProject` — high confidence for the inspected paths.** The epoch guard depends on this single replacement seam; a future bypass could attach A's output to B. Keep G3's actual Open/New paths and G7's lifetime assertions.
- **The physical disconnect really removes laser-module power — unverified, resolve before the owner card.** The plan correctly assigns wiring identification to the owner and refuses the card if uncertain. If wrong, a frozen application or failed STOP can leave hazardous output energized; software tests cannot discharge this assumption.

## Stress test 3 — Inversion

A migration of old preset-shaped arrays would beat preservation only if the file recorded reliable preset provenance and the owner authorized changing those jobs. Neither condition holds: arbitrary custom curves and old preset selections share the same raw-point representation. Keep the no-migration choice. A hand-incremented revision counter would beat the selected input comparison if every generator-relevant mutation passed through a single audited revision boundary, including nested changes; the plan's own repeated omissions show that condition is not presently true. Conversely, a smaller additive-access tripwire plus an honest review obligation already beats an overstated “closed gap” claim: it describes exactly the protection this revision actually provides without expanding the implementation.

## Overall verdict

CONCERN — no blocking FAIL identified in revision 6. The publication protocol is coherent against the inspected source, including the specific Zustand re-entrancy semantics, and the owner release rulings do not need reopening. The remaining corrections concern an overstated source-scan guarantee, a caught mount-time mock exception, and contradictory card material wording. Fold these into the plan before implementation; do not treat this review as evidence that the proposed tests have run or the hardware is qualified.

Prioritized must-fix list:

1. Correct L71/G10b's enforcement claim: either validate permitted access shapes and kill a count-preserving mutant, or explicitly document same-site/alias reads as a Razor review obligation.
2. Repair the strict harness specification: answer `list_serial_ports`, record all unexpected invokes, and assert an empty unknown-command ledger even when production catches exceptions.
3. Make the owner card consistently specify scrap card; remove the contradictory plywood option.
