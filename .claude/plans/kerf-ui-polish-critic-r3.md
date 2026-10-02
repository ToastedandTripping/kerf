# Critic round 3: kerf-ui-polish.md (revision 3)

Independent adversarial review. Reviewer: Fable. Rubric: `~/marvin/rules/plan-critic-rubric.md` v2, applied in full (all gating dimensions, not only the round-2 must-fixes), because revision 3 changed the batch graph and touched copy across Track A. Plan under review: `.claude/plans/kerf-ui-polish.md` revision 3 at `marvin/kerf-gap` 57768f9. Round 2 (Fable, FAIL on change safety only) at `kerf-ui-polish-critic-r2.md`; revision 2 preserved at `kerf-ui-polish-r2.md`.

Ground truth re-opened for this round: `.claude/DECISIONS.md`, `ROADMAP.md` at HEAD and 958d22b, `.claude/plans/kerf-safety-motion-trust.md:230-240`, `useFocusTrap.ts`, `useFocusTrap.test.tsx`, `machineJobLoop.test.tsx` (:534, :950-1050, :1002-1011, :1170-1176, :1181-1238, :1253-1261), `commandSurfaces.test.tsx:45-50`, `store/index.ts` (:71-398, :572-610, :838-856), `connection.ts` (disconnect path, `machinePosition` writers), `MachinePanel.tsx:428-438`, `JobActionBar.tsx:105-142`, `materialTestGcode.ts`, `gcodeGen.ts:294/:393/:449/:666-709`, `PropertiesPanel.tsx:294-300`, `dxfImport.ts`, `SvgImportDialog.tsx:510-520`, `fileOps/index.ts:275-310`, `fileDrop.ts`, `MenuBar.tsx:396-418`, `src-tauri/src/commands/gcode.rs:200-212`, and the scratchpad walker (`polish/access/audit.mjs`, present, 2,561 bytes). Every ledger set (item table, acceptance ledger, Copy ledger) was diffed against revision 2.

## Applicability

Unchanged from round 2: safety-critical desktop laser-control app; Track A (presentation only) is the dispatch; Track B is judged on carriage. Complex tier; `## Intent` with a written grill skip.

Core 1–10 GATING. **X1** fires, GATING (STOP, job bar, Machine panel banners, Material Test, Fire). **X2 does not fire**, N/A: no personal, health, child or client data is handled; Project Notes is restyled, its content untouched. **X3** fires, GATING (operator-facing copy about what Kerf sends and what the controller reports). **X4** ADVISORY. **X5** ADVISORY (no new timer or shared state; lands on files that own them). **X6** ADVISORY. **X7 does not fire**, N/A: no MARVIN gate, hook, skill or automation is modified. **X8** ADVISORY.

## The six disputes

Each was checked against the tree. The author is right on all six; two of them corrected errors of mine, four improved on my proposed fixes.

| Dispute | Finding | Verdict |
|---|---|---|
| "Send to Machine" sites: 6, not 7 | `grep -n` gives exactly :950, :983, :1004, :1029, :1039, :1050. I wrote "and one more"; there is none. | **Conceded.** My count was wrong. |
| The Fire line did not shift to :683 | `ROADMAP.md:661` reads "The Fire button is dark on stock GRBL after any job" at HEAD as at 958d22b; the 22 Parking Lot lines were appended after :679. I had verified :633 and :650 unchanged and then assumed :661 moved anyway. | **Conceded.** My citation was wrong; the plan's was right. |
| 9(c): jsdom cannot prove the wrap | `useFocusTrap.test.tsx:12-22` stubs `HTMLElement.prototype.offsetParent` to `parentNode` for exactly this reason (its own header comment says so); `nestingDialogFocus.test.tsx` and `appRecoveryFocus.test.tsx` do the same. `modalShell.test.tsx` adopts the stub and adds a mutation (stub removed must fail the initial-focus case). | **Conceded.** My concern was true of bare jsdom and false of this repo. |
| P58a wording: "Kerf found no alarm code in the console." over my "Check the console." | `alarmCode` is derived by scanning `consoleLines` for the last `ALARM:` line (MachinePanel.tsx:435-436); the console is clearable and bounded. The author's sentence states exactly what the code did and nothing about what the controller sent. Mine, and my "No alarm code was received", both overclaimed. | **Conceded**; theirs is the better code fact. |
| P54: "starts at X0 Y0", not "near" | The program's first motion line is `G0 X0 Y0` (materialTestGcode.ts:31). "Starts at" is the code fact; "near" was my hedge against the grid being laid out from 10-15 mm, which the second clause of the wiring test pins separately ("nearest G1 with S above 0 within 20 mm"). | **Conceded.** |
| D5 reasoning | I wrote that file colour is "exactly the cue the owner uses to check assignment before a burn". It is not: today's canvas colour is the file's, so a red outline on Cut looks like Engrave. The layer colour would be the assignment cue; the file colour is a cue only at import-mapping time. The conclusion (ask Lee) stands and is adopted as D5; my reason for it was inverted. | **Conceded** on the reasoning. |
| A7 mechanism: `layerContents` to A7 rather than the P35b caption to A6 | Moving the caption to A6 would have put `JobActionBar.tsx` in two batches, breaking the one-file-one-batch invariant I was checking. Moving the helper to A7 keeps it; A6 reads it after A7 merges. | **Conceded**; the author's mechanism is correct and mine was not. |

The three test breakages the author found while folding (`getByText("Positioning (10mm)")` ×3 at :1181/:1226/:1238; the C3 header assertion at :1255-1260; `getByText("Fire")` at :534 and `queryByRole("alert")` at :1002-1011 and :1174) are all real on the tree and all now named in their batches with teeth checks. I missed them in round 2; the plan's own "pre-existing tests unmodified" claim is now true for A7 and A11 and precisely qualified for A12.

## Round-2 fold check

| r2 finding | r3 | Verified |
|---|---|---|
| 7 FAIL: P61 "0.5 s pulse", P12 "(its safety-door input)" | Fire label unchanged, title and caption name the three commands and the S formula; Door line names the state word and no cause. | Yes. Both strings are in the Copy ledger with "command description only" and "controller report" bases; `jobBarPresentation.test.tsx` and `machinePanelPresentation.test.tsx` assert the exact texts and ban "pulse" and durations. |
| 2 CONCERN: close button takes initial focus | Close button last in DOM order, absolutely positioned; principle 6 states the contract; `modalShell.test.tsx` asserts it under the stub; A3/A4/A5/A11 record `document.activeElement` on open before any key; TB9 owns the contract from A3's merge. | Yes. The alternative (default `initialFocus` in the trap) was correctly rejected: `src/lib/hooks/` is on the scope deny-list. "None of the twelve migrated dialogs has a focusable element before its content" holds for Settings (first control is the width input, :129-130); the others are the batch's browser recording to prove. |
| 3a CONCERN: D1 fallback vs A12 → A3 → D1 | Banner moved to A2 (no colour dependency); A12 depends on motion-trust, A1, A2; D1 gates A3, A4, A5, A11 and nothing else; "Which answer matters most" says so to Lee. | Yes; graph and prose agree. |
| 3b CONCERN: "Start test" breaks a safety test | Label stays "Send to Machine"; A11 asserts the file passes unmodified including its six sites. | Yes. |
| 9a CONCERN: Razor rule 2 vs primitives | Verification 2 gains a primitive-equivalence clause: `ModalButton`, the close button and Banner actions bind the prop directly; Segmented's per-option rule maps old `onClick` to `onChange(value)` byte-for-byte; forwarding proven once in `segmented.test.tsx`, `modalShell.test.tsx`, `banner.test.tsx`; Razor records the mapping per adoption. | Yes. Specific enough to apply without judgement calls. |
| 9b CONCERN: unnamed test edit | A12 names its two edits in `machineJobLoop.test.tsx` (Positioning ×3; the C3 header assertion, which would otherwise fail on `"stale"` and pass vacuously on `"idle"`), with teeth checks; the file is in B4's set (kerf-safety-motion-trust.md:236 confirms `MachinePanel.tsx`, `machineJobLoop.test.tsx`), so A12 alone touches it. | Yes. |
| 9c | conceded above | |
| 4 notes: cross-root sentence; A5 behind D2 | Sentence corrected with every multi-directory batch named and a waiver line; `--bg-preview` keeps today's navy until D2, which lands as a two-value token commit. | Yes. |
| 1 CONCERN: P26 is Lee's call | D5, seven parts, recommendation (a); `CANVAS_COLOUR_SOURCE` ships `"file"`, both positions tested in A9; D5 (a) is a one-constant commit. | Yes. |
| 10 CONCERN: header tree claim; ROADMAP lines | Header states the six-file diff and that nothing under `src/`, `src-tauri/` or DECISIONS differs; detail citations re-cited at HEAD with their `###` heading (:773, :1107, :1108 verified). | Yes. |
| X3 residuals: P58a, P54, P60a | As disputed above, plus `$20` clause dropped rather than cited (consistent with DECISIONS 2026-09-05). | Yes. |
| cargo test not evidence | Dropped per batch, with the reason; CI runs it on master. | Yes. |

Nothing relabelled; nothing deferred that was owed.

## Graph invariants, re-verified on revision 3

- **No file in two batches.** `layerContents.ts`/`.test.ts` are A7's only (A6 reads them). `Banner.tsx`/`banner.test.tsx` are A2's only. `modalFocusContainment.test.tsx` is A3's only. `machineJobLoop.test.tsx` is A12's only (A7 and A11 read it as evidence). `index.css` is A1's, plus A8's D4 append after A1 merges and the D2 token commit; `LayerPanel.tsx` is A6's plus the D1 commit; `layerDisplayColor.ts` is A9's plus the D5 commit. All three decision commits are declared exceptions with their own checks and revert. Holds.
- **Primitives before users.** Chevron and Banner (A2) before A3, A4, A5, A6, A11, A12, each of which lists A2 as a dependency. ModalShell, `ModalButton`, Segmented (A3) before A4, A5, A11. `layerContents` (A7) before A6. Holds. One ambiguity, not a defect: the acceptance ledger's P52 row lists `LayerPanel.tsx` and `SpeedInput.tsx` under "A3 creates; A4, A5, A6, A11 use", but A6's share of P52 is the inline `accentColor` deletions, not Segmented, and A6 correctly does not depend on A3. Reword the row so a reader does not infer a missing edge.
- **Size.** A2 and A3 are at 8 files; A6, A7 at 5; A12 at 4; the rest 3 to 5. Within the eight-file bound; the directory waiver is now stated.
- **Waves.** A1; then A2, A7, A8, A9, A10 (five, at the fleet cap; STOP's presentation is in this wave); then A3, A6, A12-if-merged; then A4, A5, A11. Every wave's dependencies are in an earlier wave. Holds.
- **Ledger coverage.** Item table and acceptance ledger carry the same 52 ids (set-diffed). Holds.

## Copy ledger, string by string

Every string was checked against its stated basis. All hold. Notes where a citation is loose but the fact is true:

- **P29a** cites `store/index.ts:393, :610, :842, :851` for the `gcodeStale` writers. Those are the setters' field lines (`workspaceWidth`, `grblSValueMax`, `startCorner`, `originTop`); the `gcodeStale` assignments are at :395-398, :610, :844, :853. The claim ("set by design edits and by the bed size, start corner, origin and `$30` writers") is true. Cite the `gcodeStale` lines.
- **P67** "last known": `setMachineConnected(false)` clears `machineHomed` and `softLimitsActive` and leaves `machinePosition` alone (store/index.ts:598-604); `disconnect()` writes no position (connection.ts, the only writer is the status handler at :645). So the readout is the last reported position while stale or disconnected. Holds.
- **P40a** "drawn shapes and DXF imports go here": `toolHandler.ts:1229, :1421` and `dxfImport.ts:171, :211, :289, :343` hold. `SvgImportDialog.tsx:515` also passes `activeLayerIndex` into `walkElementWithLayers` (as the fallback for the colour mapping), so the caption under-claims rather than over-claims. Acceptable.
- **P56a step 5** "with the laser commanded off": the FRAME program is `M5`, five `G0`s, `M5` (JobActionBar.tsx:136-140). This is a command description and does not say the beam is dark; `onboardingCopy.test.tsx` bans "laser off" and the string does not contain it. Holds. If a shorter form is wanted, "FRAME sends M5, then moves around the job's bounding box, then M5 again" removes the word "laser" entirely; optional.
- **P58a**, **P54**, **P61**, **P12**, **P60a**: as disputed and conceded above; each basis verified.
- **P65** "First cut starts near"; "Changes the cut order only. The design does not move.": `start_corner` feeds `start_point_from_corner` and `order_objects` and nothing else (gcode.rs:205-209). Holds.
- **P7**, **P66a**, **P62a**, **P35a/b**, **P24a/b**, **P16a**, **P15**, **P27**, **P45a**, **P53**, **P55a**, **P22**, **P38**, **P48**, **P30a**, **P57a**, **P73**, **P9a/b**, **P10a**, **P14a**, **P56a steps 1-4**: bases re-opened in round 2 or this round; all hold.
- **Kept verbatim, routed to TB7**: the five strings are correctly identified as claims the code does not establish, and Track A moves none of them into a new place except the state labels into the Machine header, which the status bar already shows.

**No remaining physical-behaviour claim.** Every verb that could describe emission, heat or motion now describes a command sent or G-code generated, and the string tests ban the words that slipped in round 2.

## Dimension verdicts

### Core

1. **Problem-fit: PASS [GATING].** Charter loop, house style, DECISIONS honoured (Min Pwr 2026-09-27; copy rule 2026-09-10/27; the stop path, Pause and the wedge untouched; 2026-09-05 applied to every controller claim). The one product call made under a technical delegation is now D5. The Decisions section's own rule ("only look-and-feel and product-default calls") is now consistent with its contents.
2. **Approach soundness: PASS [GATING].** Track split, frozen primitives, pure helpers, prop-level equivalence, the shell's DOM-order focus contract, and decision seams as single constants or tokens with their own commits. The decoupling pattern (D2 token, D5 constant, D1 slider commit) is the right shape; the plan chose not to apply it to `ModalButton`'s primary colour, so D1 still holds A3, A4, A5 and A11. That is a stated trade, visible to Lee under "Which answer matters most", not a defect.
3. **Completeness: PASS [GATING].** Refusal matrix verified (round 2). D-fallbacks consistent with the graph. Every pre-existing test the batches touch is named (A3, A6, A12) with mutations; the three breakages revision 2 missed are named. The Copy ledger closes the class.
4. **Right-sizing & reuse: PASS [GATING].** Graph invariants above. Deferrals indexed (22 Parking Lot lines verified at HEAD). The P52 ledger-row wording note stands.
5. **Security: PASS [GATING].** Unchanged from round 2.
6. **Failure modes: PASS [GATING].** Track A has no asynchronous path; A12's pre-check handles B4 drift; each decision commit has its own check and revert.
7. **Change safety: PASS [GATING].** Every Track A item passes the five-part test (re-walked for the items whose rows changed: P12, P23, P24a, P24b, P26, P29a, P40a, P45a, P48, P52, P54, P57a, P58a, P60a, P61, P73). Every added or changed string is in the Copy ledger with a basis that holds. Revert path per batch and per decision commit stated.
8. **Data integrity & compatibility: PASS [GATING].** No store shape, saved format or generation input changes; the D2, D5 and D1 seams change no stored value.
9. **Verifiability: PASS [GATING].** Primitive-equivalence clause; the stub makes the shell's focus assertions real; string tests assert exact texts and ban the physical vocabulary; A12's test edits carry teeth checks; `commandSurfaces.test.tsx` passes because `displayShortcut(label, isMac)` takes the platform as a parameter and the palette's production detection reads false under jsdom (the plan says so at A10). One note: cite the `gcodeStale` lines for P29a (above).
10. **Maintainability: PASS [GATING].** Header and citations corrected; ARCHITECTURE delta owned per batch including the new constants; the one-file rule and its exceptions are explicit.

### Conditional

- **X1 Physical & human safety: PASS [GATING].** STOP never dimmed while enabled, solid in every uncertain state, and now in the second wave on A1 alone. No control path, admission, default or reachability changes. Hardware tests: none, with the reason. The pre-existing STOP-under-modal hazard remains indexed for TB1.
- **X3 Evidence & source integrity: PASS [GATING].** Copy ledger verified string by string; no physical-behaviour claim remains; the GRBL-doc claims are dropped rather than cited, per DECISIONS 2026-09-05; the five unqualified legacy strings are named and routed.
- **X4: PASS [ADVISORY].** **X5: PASS [ADVISORY].** **X6: PASS [ADVISORY]** (walker source confirmed present; A1 commits it). **X8: PASS [ADVISORY].**

## Three stress tests

**Pre-mortem.** (1) *A dialog's base recording is skipped.* A4 migrates five dialogs and one of them (Power Curve, with its canvas) has a focusable before its content that the per-file check missed; focus opens on the wrong control and nobody compared. The plan's defence is the recorded `document.activeElement` at base and head for every migrated dialog; the relay must actually produce both recordings, and Razor should refuse a batch whose evidence directory lacks the base one. (2) *B4 lands late and A12's citations rot.* The pre-check says re-locate; the risk is a Ted that re-locates by grep and misses a moved `disabled=`. Razor's diff against B4's version is the defence. (3) *Lee answers D1 (b).* Four batches then ship tan primaries with dark text; the Copy ledger and tests are colour-agnostic, so nothing else moves. Type-specific worst case for Track A as a whole: an operator misreads a state word; the string tests and the never-dimmed STOP are the controls.

**Load-bearing assumptions.** The protected-symbol rule is now applicable to primitives (clause written; confidence high). B4 merges before A12 (unknown; A12 waits, nothing else does). The scratchpad walker survives until A1 (confirmed present today). Lee answers D1 (medium; the cost of silence is stated to him).

**Inversion.** *Apply the D2/D5 seam pattern to D1 too* (ModalButton primary as a token that keeps today's colour until D1): wins if D1 is slow and the Trace fix matters more than colour consistency. The plan has made that trade visible rather than taking it; acceptable either way, and a one-paragraph change if Lee's silence stretches. *Skip the shell*: still loses; the focus defect is fixed inside it and TB1 needs the seam.

## Track B carriage

Unchanged from round 2 and verified: TB1 carries round-1 must-fix 1 and the STOP half of 2 verbatim; TB2 carries must-fix 4; TB3 to TB10 carry their named requirements. TB9 now also owns ModalShell's focus contract by name. No gap.

## Overall verdict

**PASS.** Revision 3 resolves the round-2 FAIL and every concern, and in six places improves on the fixes I proposed; it also found three test breakages that round 2 missed and named them with teeth checks. The Copy ledger is the right instrument for this class of defect: every string Track A writes now has a basis that I could open and confirm, and no physical-behaviour claim remains. The batch graph invariants hold after the moves (Banner to A2, `layerContents` to A7, A7 off A6), the waves respect the fleet cap, and the decision seams are single values with their own commits. What remains is cosmetic and goes in the must-fix list as P2 and P3 items; none blocks the gate.

## Must-fix list

1. **P2, dimension 9/10.** P29a: cite the `gcodeStale` assignment lines (`store/index.ts:395-398, :610, :844, :853`), not the setters' field lines.
2. **P3, dimension 4.** Acceptance ledger P52 row: separate "Segmented (A3 creates; A4, A5, A11 use)" from "inline `accentColor` deletions (A6)", so no reader infers an A6 → A3 edge.
3. **P3, optional.** Onboarding step 5: "FRAME sends M5, then moves around the job's bounding box, then M5 again" removes the word "laser" from Track A entirely; the current string is already compliant.
