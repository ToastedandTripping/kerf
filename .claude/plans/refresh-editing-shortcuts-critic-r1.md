# Critic Review — Refresh: Editing and Shortcuts

**Plan:** `.claude/plans/refresh-editing-shortcuts.md`
**Reviewed against:** worktree `session-8b2728` at `cdb75aa` (the empty snap-toggle branch the plan
anticipated is already gone; the plan's shortcuts.ts line numbers are stale from that point down).
**Reviewer:** separate Fable critic, read-only. Every citation below was opened in the tree, not taken
from the plan.

## Verdict: APPROVE WITH CHANGES

Two must-fold changes before ExitPlanMode, neither of which touches the technical design. The code
diagnosis is sound in every fix I traced (F1 through F9), the red-first tests do fail today for the
stated reasons, and the shared module preserves what the three copies agree on. What is missing is
(a) a product decision the plan makes on the owner's behalf from an unverified premise, and (b) the
rubric's batch waiver and Parking Lot routing.

---

## Applicability

**Project type:** desktop CAD/CAM app (Tauri/React), UI and editing layer only. No Rust, no serial,
no G-code generation touched.

| Dim | Fires? | Tag | Why |
|---|---|---|---|
| X1 Physical safety | **Fires, narrowly (F9 only)** | GATING | F9 writes `layer.speed`, which feeds feed-rate. Nothing else in the plan reaches the machine. |
| X2 Privacy | Does not fire | N/A | No personal, client or health data anywhere in scope. |
| X3 Evidence | Does not fire | N/A | No research or public claims; findings are code-traced. |
| X4 Audience/brand | Does not fire | N/A | No client- or public-facing output. |
| X5 Concurrency | Fires | ADVISORY | Window keydown listeners stack (shortcuts, palette, sheet, every dialog's Escape); F7 changes who wins. |
| X6 Operability | Fires | ADVISORY | Ships in a released app; F7's guard has a silent failure mode. |
| X7 Self-modification | Does not fire | N/A | No MARVIN gates, hooks or skills. |
| X8 Deps/perf/cost | Does not fire | N/A | No new packages; one `querySelector` per keydown is not a hot path. |

---

## Core dimensions

### 1. Problem-fit — CONCERN
`## Intent (grilled)` exists with a written skip line; goal matches the Summary. No DECISIONS.md entry
is contradicted (all rulings there are hardware/streaming/geometry). The concern is the Ctrl+Shift+V
remap, which the plan decides with "(From memory, not checked here: Illustrator uses it that way)".
That premise is now checked, and it matters more than the plan lets on. See **Blocking B1**.

### 2. Approach soundness — PASS
Plain-function module over `useStore.getState()` is the right seam: it removes the three-way drift
without touching `AppState`, and the two commands that already exist as store actions are forwarded,
not re-implemented. The DOM guard for F7 is the correct choice over `openDialogs.size` today: I
confirmed four modal surfaces keep their open state outside the store (PowerCurveEditor `:319`,
OnboardingOverlay conditionally mounted at App.tsx:386, the recovery prompt at App.tsx:389, and the
palette/sheet until F4). Group children are group-local (`buildGroupObject` re-bases via `movePartial`,
geometry/index.ts:460-490), so `movePartial` on the cloned root is the whole offset; the plan's F1
paste is correct for groups.

### 3. Completeness — PASS
Every paste entry point is covered (Ctrl+V, Alt+V, menu Paste, menu Paste in Place); every delete
entry point except the context menu, which is correctly excluded (already `withUndo`, Viewport.tsx
owned by another relay). All three raw-`addObject` import sites are named and I found no fourth
(`grep -rn "addObject(" src --include=*.ts --include=*.tsx` outside tests: the remaining callers are
inside `withUndo` wrappers or the store's own actions).

One gap the plan half-names: `handleViewportKeyDown` runs before the input guard, so node Delete
fires from a side-panel number field. It is in "Observed, not fixed". Fine to leave, but see
dimension 4 on where it must be recorded.

### 4. Right-sizing & reuse — CONCERN
Reuse is good (`deepCloneObject`, `withUndo`, `clampSpeed`, `handleToolChange`, `rotate90`,
`setSnapToGrid` all already exist). Two rubric requirements are unmet:

- **Batch size.** Eleven production files plus seven test files in one relay, no dependency graph,
  no waiver. F1-F7 are one subsystem (command dispatch) and could carry a one-line waiver on that
  basis; F8 (imports) and F9 (layer strip) are not that subsystem and are independent of F1-F7.
- **Parking Lot.** The four "Observed, not fixed" items, the dropped ui-11, the remaining ui-2
  duplication (Select All, Convert to Path, z-order, zoom) and core-5's second half are named as
  out of scope but not routed to `ROADMAP.md -> ## Parking Lot — every deferral, one index`, whose
  own rule reads "a deferral is recorded here or it does not exist."

See **Blocking B2**.

### 5. Security — PASS
No secrets, no network, no file-system writes beyond what the existing import paths already do.
F8 wraps existing writes in undo; it does not widen them.

### 6. Failure modes — PASS
Empty selection, empty clipboard, missing object, and no-op writes are all handled in the module.
`withUndo` pushes only on reference change, so a `removeObjects([])` that produced a new array is
the exact reason today's empty Delete records a blank step; the module's early return closes it.
F7's failure mode (a modal without the attribute) is named and pointed at Phase 5.

### 7. Change safety — PASS
Every change is a code edit on a session branch; no migrations, no destructive steps. F8 makes
three currently irreversible user actions reversible.

### 8. Data integrity & compatibility — PASS
No file-format or store-shape change. Saved projects are untouched. Pasted names unchanged (no
" copy" suffix), as stated.

### 9. Verifiability — PASS (with two advisories)
I checked each "red today" claim against the current code rather than the plan's description.
Every one holds; details in **Focus (1)** below. Two advisories: the F2 empty-selection cases have
no positive control in the same test, and the "813" baseline is stale (see A1, A6).

### 10. Maintainability — PASS
The module is the single door for five commands and forwards the other two; `switchTool` removes
a third copy of the tool-change ritual. ARCHITECTURE.md gets its line. The `_testClipboardOp`
export dies with its only consumer migrated.

---

## Conditional dimensions

### X1 Physical & human safety — PASS
F9 clamps to `[1, machine max]`, identical to LayerPanel's `SpeedInput` (`SpeedInput.tsx:54-57`),
and max is chosen by the same `fill`/`fillLine` predicate (`LayerPanel.tsx:546`). Worst physical
case: a cleared field commits speed 1 mm/min, which generation now *accepts* where 0 was refused.
That is parity with the Layers panel, the user sees "1" in the box, and it is the same keystroke
path as today (today "" writes 0 and the next digit appends to it). Not a regression; noted as A4.
Nothing else in the plan can reach the beam.

### X5 Concurrency & re-entrancy — PASS
F7's guard reads the DOM at event time, and React's unmount is asynchronous, so an Escape that
closes a dialog is also suppressed in `useKeyboardShortcuts` on that same event. Deterministic and
an improvement (today Escape with the `?` sheet open *also* deselects and switches tool). Pre-existing
and unchanged: Ctrl+K and `?` still open their surfaces over any other modal, because their listeners
are separate. Advisory A5.

### X6 Operability — CONCERN (advisory)
If a stray `aria-modal="true"` element ever persists (a future dialog hidden by CSS instead of
unmounted), every global shortcut dies with no error and no console line. Cheap mitigation: the guard
can log once per stuck element in dev builds. Not required; see A5.

---

## Focus questions from the orchestrator

### (1) Do the "fails today" tests fail for the stated reason, and pass only because of the fix?

Yes for all of them. Traced:

- **F1.1 (group paste, unique ids).** Today all four paste paths re-ID the root only (`shortcuts.ts:103-107`, `:119-122`; `MenuBar.tsx:464-468`) and `movePartial` on a group returns transform only, so children keep ids a,b. `applyPartialsDeep` (`index.ts:130-142`) writes into every copy. Red for the stated reason. The probe file (`scratchpad/refresh/probe/paste.probe.test.tsx`) exists and drives exactly this.
- **F1.2 (Alt+V shares points).** `shortcuts.ts:119-122` spreads `...o` with no `movePartial`; `points` is the same reference. Red. After the fix `movePartial(c, x, y)` with `d=0` recomputes the transform from `pointsBBox`, which ignores handles (`geometry/index.ts:196-210`), so "transform equals the original's" holds for the existing fixture with off-bbox handles. The existing pasteInPlace assertion in `shortcutsWriters.test.tsx` already proves that path green.
- **F1.3 (Ctrl+C with nothing selected).** `setClipboard(objects.filter(...))` writes `[]`. Red.
- **F2 (order and selection after undo).** Hand-rolled undo re-appends (`shortcuts.ts:249-257`; `addObject` appends at `index.ts:174-184`) and never restores selection. Red as `["B","C","A"]`, `selectedIds: []`. Empty-selection cases: keyboard pushes unconditionally; menu goes through `withUndo`, and `removeObjects([])` returns a fresh array from `filter`, so the `!==` guard passes and an entry is pushed. Both red.
- **F3.** `ctrl && key === "v"` has no `!shift` guard (`:96`); `e.key` for Ctrl+Shift+V lowercases to `v`; the paste fires. Red. Palette `arr-flip-v` has no `shortcut` (`CommandPalette.tsx:305-310`). Red.
- **F4.1.** `document.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }))` at `MenuBar.tsx:416` is non-bubbling and targeted at `document`; a non-capture `window` listener is never invoked. Red in jsdom as in Chrome.
- **F5.** Palette calls `setActiveTool` only (`:156-204`); `handleToolChange` is what sets/clears `nodeEditState`. All three red. "Node Edit" substring-matches "Node Edit Tool".
- **F6.** No `s`, `[` or `]` handler exists (the empty `s` block is already deleted at `cdb75aa`). Red.
- **F7.1-.4.** Input guard only bails on INPUT/TEXTAREA/SELECT; a focused BUTTON passes, Tab is `preventDefault`ed at `:232-240`. The modal probe exists and reproduces it. Red.
- **F8.** All three sites are raw `addObject` (`imageImport.ts:107`, `ImageImportDialog.tsx:89`, `App.tsx:370-373`); the stack does not grow. Red. The Import button's accessible name is exactly "Import" (`:353`); the other button is "Cancel".
- **F9.** `Number("") === 0` passes straight to `updateLayer`; `updateLayer` clamps power only (`index.ts:301-308`). Red. The plan's layer inputs are correct: `DEFAULT_LAYERS[0]` is Engrave/`fill`, `[1]` is Score/`line` (`types.ts:282-306`). `rasterMaxSpeed(6000,5000) = 6000`, `effectiveMaxSpeed = 5000`. Note the *existing* test's comment "first layer (Cut — index 0)" is wrong; fix it in passing (A6).

No test pins the wrong input.

### (2) Does `editCommands` preserve every behavior the three copies agree on?

Agreed-on behaviors preserved: copy filters top-level `objects` by `selectedIds`; cut = copy then
`withUndo("cut")` remove; paste selects the pasted set; paste keeps names; +10 mm offset for plain
paste; `duplicateInPlace` and `flipObjects` forwarded unchanged; Delete via `withUndo("delete")`.

Divergences the plan resolves **and states**: id scheme (menu private vs `generateId`), Alt+V
skipping `movePartial`, keyboard Delete's hand-rolled undo, no group re-ID anywhere, empty-selection
copy/cut/delete, empty-clipboard paste.

Divergences resolved **silently** (none harmful, listed for the record):
- Keyboard Alt+V today does *not* recompute the transform from points; after F1 it does (self-healing
  bbox, as the menu path already does). Visible only on a drifted object.
- Ctrl+Alt+V today hits the Ctrl+V branch (offset paste). After F3's `!shift` guard it still does;
  unchanged, but worth knowing Alt+V is never reachable with Ctrl held.
- Ctrl+Shift+X today cuts (no shift guard on X). The module call keeps that; fine.
- Today Escape with the `?` sheet open both closes the sheet *and* deselects/switches tool. After F7
  it only closes the sheet. Better, but it is a behavior change the plan does not name.

### (3) Is a document-wide `[aria-modal="true"]` check safe?

Today, yes. I opened all 18 sites. Every one is either behind `if (!open) return null`
(SvgImport `:205`, ImageTrace `:458`, ProjectNotes `:28`, MaterialTest `:326`, PdfImport `:234`,
DitherPreview `:48`, QrCode `:46`, Settings `:35`, VariableText `:84`, GrblSettings `:131`,
Nesting `:50`, ImageImport `:60`, PowerCurveEditor `:319`, CommandPalette `:445`,
ShortcutOverlay `:97`) or conditionally mounted (Onboarding, App.tsx:386; recovery prompt,
App.tsx:389). No element carries `role="dialog"` without `aria-modal`, and no non-modal panel
carries `aria-modal`. No dialog is hidden by CSS while mounted. ImageTraceDialog has two
`aria-modal` roots (`:469` no-image branch, `:677` main) but both sit under the same `:458` return.

Consequences worth naming:
- **Onboarding overlay:** first launch, every shortcut is dead until the user clicks through. It has
  no Escape handler. That is what modal means, and it is the correct call, but it is a visible change
  on first run.
- **Recovery prompt:** same; Ctrl+O/Ctrl+N behind "Recover unsaved work?" now do nothing. Correct.
- **Vitest isolation:** `globals: true` is set, so testing-library auto-cleanup runs; a dialog from
  a previous test will not leak into the DOM and vacuously satisfy a "nothing happened" assertion.
  Tests that render a dialog and then assert a shortcut *did* fire in the same test must unmount it
  first (F7.4 does exactly this).
- **Future hazard is real but named:** a modal that forgets the attribute escapes the guard; a
  non-modal that adds it kills every shortcut silently. Phase 5 ModalShell is the right owner. A
  dev-only `console.warn` on a stuck element is cheap (A5).

### (4) Ctrl+Shift+V as Flip Vertical — product call

The plan's premise is now verified, and it cuts both ways:

- **Illustrator:** Shift+Ctrl+V is Paste in Place by default (Adobe's default-shortcuts page,
  https://helpx.adobe.com/illustrator/using/default-keyboard-shortcuts.html). The plan's memory was right.
- **LightBurn:** Ctrl+Shift+V is **Flip Vertical** and Alt+V is **Paste in Place**
  (https://docs.lightburnsoftware.com/Hotkeys.html). Kerf's existing Alt+V, the menu label since the
  initial commit, and the plan's remap are all *exactly* LightBurn's bindings. That is almost certainly
  where they came from, and the ROADMAP measures Kerf against LightBurn by name.

So the choice is not "plan vs habit"; it is **LightBurn muscle memory vs Illustrator muscle memory**,
and the owner has both. That is a preference call, and Critical Rule 5 says preference-dependent
decisions are presented as options, not made in plan mode. The plan should **surface it, not decide
it**, and the cheapest place is the plan's own Intent section at approval time, so nothing is built
twice. Both outcomes are one line in shortcuts.ts plus three labels.

Suggested decision block (structured-decisions shape):

1. **Which app's habit should Ctrl+Shift+V follow in Kerf: LightBurn (flip vertical) or Illustrator (paste in place)?**
2. **Today:** the Arrange menu says Ctrl+Shift+V flips vertically; pressing it actually pastes a
   copy 10 mm down-right. Alt+V pastes in place and is labelled correctly.
3. **Tension:** the label and the key disagree (finding ui-3). Either the key changes or the label
   does. Flip Horizontal already lives on Ctrl+Shift+H.
4. **Options:**
   - **A. LightBurn parity (the plan):** Ctrl+Shift+V = Flip Vertical, Alt+V = Paste in Place.
     Cost: none beyond the plan. Risk: an Illustrator reflex mirrors the selection instead of
     pasting. The flip is visible and undoable, and nothing gets pasted, so it is noticed. Makes
     nothing impossible later.
   - **B. Illustrator parity:** Ctrl+Shift+V = Paste in Place (Alt+V kept as an alias), Flip
     Vertical loses its key and the label is removed (or gets a new one). Cost: the H/V flip pair
     is no longer symmetric; three labels change instead of one branch. Risk: a LightBurn reflex
     pastes in place instead of flipping, which is harmless. Makes the H/V symmetry harder to
     restore later without a second remap.
   - **C. Neither key does anything surprising:** Ctrl+Shift+V unbound, label removed, Alt+V stays.
     Lowest surprise, lowest utility.
5. **Recommendation:** A, because every other Kerf binding in this area already follows LightBurn
   and consistency beats one imported reflex. Cost of being wrong: a mirrored part cut once before
   the habit adjusts, on an asymmetric design where the flip was not noticed. Undo is one keystroke.
6. **Reversibility:** fully, one line. **If nothing is decided for a month:** the label keeps lying
   and the key keeps pasting.

### (5) Undo wrapping for imports: double entries, auto-save, isDirty?

No double entries on any of the three paths:
- **ImageImportDialog:** `handleImport` adds one object, then `onImported(autoTrace)` opens the trace
  dialog 100 ms later; a trace is a *separate user action* with its own `withUndo("trace")`. One entry
  per action, as it should be.
- **imageImport.ts:** one `addObject` inside `onload`; `store` is captured before `onload` but
  `withUndo` reads live state through `get()`, so the stale snapshot is harmless (plan says so;
  confirmed at `index.ts:411-427`).
- **PDF vectors:** `objects.forEach(addObject)` inside one `withUndo` produces one entry; the
  before/after arrays differ once, not N times, because `withUndo` compares only the outer references.
- **isDirty:** `addObject` already sets it; `withUndo` does not touch it; undo/redo set it `true`
  (pre-existing behavior for every undoable action). No change.
- **Auto-save:** `startAutoSave` polls `isDirty` every 60 s (`autoSave.ts:21-25`) and never reads
  the undo stacks. No interaction.
- **Image data round-trip:** `pushObjectsUndo` strips `imageData` to `__UNDO_REF__` and restores it
  from `capturedImages`, keyed by id, populated from both snapshots (`index.ts:62-116`). Redo gets
  the original string. The plan's F8.1 third assertion is sound.

One thing the plan should say out loud: `withUndo` snapshots `objects` only. Layer changes,
`activeLayerIndex`, dialog data and the pending-image payload are not part of the entry. For these
three imports that is fine (they change only `objects` and selection).

---

## Stress tests

### Pre-mortem — three months out
1. **A mirrored part was cut.** Lee pressed Ctrl+Shift+V from Illustrator habit on an asymmetric
   bracket, did not look, generated, cut. Type-specific worst case: wrong geometry burned into
   material. We should have seen: the plan surfacing the choice, and the owner choosing with both
   apps' bindings in front of him. Fix is B1.
2. **Every shortcut died after a dialog refactor.** Phase 5 ModalShell (or a smaller change) left
   an `aria-modal` root mounted but hidden; no error anywhere; a bug report reads "keyboard stopped
   working." We should have seen: a dev-only warning, and the code comment that names the contract.
   Mitigation A5.
3. **The strip's speed field commits "1600" when "600" was typed.** Clearing writes 1, the next
   keystrokes append. Parity with LayerPanel, so nobody flagged it, and the job ran at 2.7x the
   intended feed (under-cut, not fire). Should have seen: the plan's own note that commit-on-blur
   was deferred, recorded in the Parking Lot so it can be scheduled. A4/B2.

### Load-bearing assumptions
- **Every modal today carries `aria-modal="true"` and unmounts when closed.** Verified for all 18.
  High confidence. If wrong: a shortcut leak or a dead keyboard, both visible.
- **Group children are group-local, so `movePartial` on the cloned root is the whole paste offset.**
  Verified at `buildGroupObject`. High confidence. If wrong: pasted group children would sit over
  the originals; the F1 browser step would catch it.
- **`withUndo` pushes iff the `objects` reference changed.** Verified. High confidence.
- **Importing `App.tsx` in a test file is viable.** `shortcutsWriters.test.tsx` already imports
  `MenuBar`, which imports `App`; it is green. High confidence.
- **The owner wants LightBurn's Ctrl+Shift+V.** Unverified. This is B1.

### Inversion
- *Store-check guard (`openDialogs.size`) wins* if every modal's open state lives in `openDialogs`.
  Not true today (four exceptions), and F4 moves two of them in, leaving PowerCurveEditor, onboarding
  and the recovery prompt. Phase 5 is where that condition becomes true; the DOM guard is the right
  bridge and can be swapped then without changing any test but F7.3.
- *Relabel instead of rebind (option B/C above)* wins if the owner's reflex is Illustrator's. Partly
  true by the orchestrator's own note. Hence: ask.
- *Clamp in `updateLayer` instead of the strip* wins if a third speed writer appears. Today there
  are two and both clamp at the control; the plan's reason (max depends on mode and connection state,
  which `updateLayer` does not know) holds.

---

## Findings

### Blocking (fold before ExitPlanMode)

**B1. Ctrl+Shift+V is a preference call and must be presented to Lee, not decided.** Replace the
"from memory, not checked" sentence in Key decisions with the verified facts (Illustrator: Paste in
Place; LightBurn: Flip Vertical, Alt+V Paste in Place, i.e. Kerf's current bindings are LightBurn's)
and the six-part decision block above. Default to option A if he does not object; F3 is unchanged
under A and becomes a label fix plus a one-branch change under B.

**B2. Batch waiver and Parking Lot routing.** Add a one-line waiver: F1-F7 are one subsystem
(keyboard/menu/palette dispatch) and F8/F9 are independent riders; either declare them a second
batch or state why one relay is right. Then route to `ROADMAP.md -> ## Parking Lot` (Stage 3.5 can
do the write, but the plan must name it): the input-guard ordering defect, `constants.formatTime`'s
`Math.ceil` bug, the macOS Alt+V question, the remaining ui-2 duplication, core-5's toolHandler "add"
commands, and the ui-11 drop with F10's reason.

### Advisory (should fold; not gate-blocking)

**A1. Positive controls next to the "nothing happened" assertions.** F2's empty-selection cases
assert `undoStack.length` unchanged; pair each with a same-test action that *does* push, so a dead
handler cannot pass them. F3 already does this for the count check.

**A2. Guard S on `!shift` for consistency with the tool keys.** `!ctrl && !alt && key === "s"`
makes Shift+S toggle snap; harmless, but the tool branch requires `!shift` and the sheet lists "S".

**A3. Name the Escape behavior change.** After F7, Escape with the `?` sheet or palette open no
longer also deselects / switches tool. Say so in F7's risk line and in the ROADMAP shipped entry.

**A4. Record the strip's typing feel as a deferral, not a footnote.** "Clearing shows 1, next digit
appends" is parity with LayerPanel and acceptable, but commit-on-blur is a real UX item; it belongs
in the Parking Lot (B2), not only in F9's Risk paragraph.

**A5. Dev-only warning in the F7 guard.** When the guard suppresses a key, `import.meta.env.DEV &&
console.warn` once per element identity. Costs two lines; turns the silent failure mode into a
visible one. Also state in the comment that `?` and Ctrl+K deliberately still work behind other
modals (separate listeners) so nobody "fixes" it.

**A6. Numbers and comments.** The JS baseline is **823**, not 813 (`npx vitest run` on this tree,
51 files, 823 passed). The plan's shortcuts.ts line numbers below `:318` are off by five since
`cdb75aa`. While in `activeLayerStrip.test.tsx`, correct the "Cut — index 0" comment: index 0 is
Engrave.

**A7. `PASTE_OFFSET_MM`.** Put it in `lib/constants.ts` beside `MIN_ZOOM`/`MAX_ZOOM` rather than
private to the module, so the ROADMAP/help text can cite one number.

---

## Overall

The engineering is right: every diagnosis I opened matches the tree, every red-first test is red for
the reason given, the module keeps the three copies' shared behavior and names the divergences it
resolves (I found four more it resolves silently, all benign), the DOM modal guard is safe against
all 18 modal surfaces that exist today, and the import undo wrapping produces one entry per action
with no auto-save or `isDirty` interaction. What blocks is not code. The plan makes a keyboard-habit
call for the owner on an unverified premise, when the verified facts show his two design tools
disagree on that exact key; that goes to him as a structured choice. And the rubric's batch waiver
plus Parking Lot routing are missing, which is how deferrals stop existing. Fold B1 and B2 and this
plan is ready for relay.

**Prioritized must-fix:** B1, B2, then A1, A5, A6.
