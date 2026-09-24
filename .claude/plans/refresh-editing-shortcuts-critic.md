# Critic Review (round 4, owner-requested) — Refresh: Editing and Shortcuts

**Plan:** `.claude/plans/refresh-editing-shortcuts.md` (round-3 folds applied: B1 dispatch rule, A1 snap reset,
A2 `switchTool` import, A3 Escape wording, A4 warn spy, A5 red-on-the-named-assertion)
**Earlier rounds:** `-critic-r1.md`, `-critic-r2.md`, `-critic-r3.md`. Settled points are not re-litigated.
This round has one job: verify the round-3 fold and hunt for anything it introduced.
**Reviewed against:** worktree `session-8b2728` at `6e3378b` (plans commit; no `src/` change since `229398f`,
which touched Rust only). Baseline 823 JS / 310 Rust taken from the brief; nothing in `src/` moved since round 3
measured 823.
**Reviewer:** separate Fable critic, read-only except this file. Every citation below was opened in the tree.
One scratch probe was run outside the repo (`scratchpad/refresh/probe/r4flush.probe.test.tsx`, 7/7).

## Verdict: APPROVE

The fold is correct and complete. The dispatch rule is stated once, plan-wide, with a trigger condition, two
accepted forms and an explicit carve-out, and the list of governed tests is exhaustive: I enumerated every
keyboard dispatch in every planned test and found no DOM-dependent one outside the five named. A probe with the
real store's `openDialogs` and a stand-in for the post-F4 overlay and post-F7 guard shows both accepted forms
deliver the F7.5 flow green in both window-listener orders, and the raw form fails exactly as round 3 said.
The store reset covers every field a test asserts from a starting value. The `switchTool` import swap is right
under `noUnusedLocals`. The Escape wording matches the code. The warn spy is safe on its path. Every red-first
claim still fails on the assertion the plan names. Six advisory items follow, none of which changes a design
decision; the largest is one sentence about how the spy is restored.

---

## Applicability

**Project type:** desktop CAD/CAM app (Tauri/React), keyboard/menu/palette dispatch and undo layer. No Rust,
serial or G-code generation touched.

| Dim | Fires? | Tag | Why |
|---|---|---|---|
| X1 Physical safety | **Fires, narrowly (F9)** | GATING | F9 writes `layer.speed`; the clamp only tightens the write door. Unchanged since round 1. |
| X2 Privacy | Does not fire | N/A | No personal, client or health data in scope. |
| X3 Evidence | Does not fire | N/A | No research or public claims; the Ctrl+Shift+V point is ruled by Lee, not sourced. |
| X4 Audience/brand | Does not fire | N/A | Nothing client- or public-facing. |
| X5 Concurrency | Fires | ADVISORY | Several `window` keydown listeners on one event; F7 decides which one acts. |
| X6 Operability | Fires | ADVISORY | Released app; F7's dev warning. |
| X7 Self-modification | Does not fire | N/A | No MARVIN gates, hooks or skills. |
| X8 Deps/perf/cost | Does not fire | N/A | No packages; one `querySelector` per keydown. |

---

## The six questions, answered against the tree

### Q1. Is the dispatch rule stated so it cannot be misapplied, and applied everywhere it is needed?

**Stated: yes.** F1 "Keyboard dispatch rule (applies to the whole plan)" gives (a) the trigger, "a key followed
by a DOM assertion, or by a second key whose handling depends on DOM the first key produced"; (b) two accepted
forms, `act(() => …)` or `fireEvent.keyDown(window, …)`; (c) the carve-out, raw `key()` for store-only
assertions; (d) the named list. Each governed test repeats the instruction locally (F3 label check, F4.2 "every
key here", F4.3 "Ctrl+K and Escape", F5 "Ctrl+K … The Enter goes to the input via `fireEvent.keyDown(input, …)`",
F7.5 "the `?` and both Escapes"). Done-when line 383 restates it. An implementer who follows either the F1
paragraph or any local note lands on the same practice.

**Applied everywhere: yes.** Every keyboard dispatch in the plan's tests, classified:

| Test | Keys | What the next line reads | Needs the rule? |
|---|---|---|---|
| F1.1 | Ctrl+C, Ctrl+V, Alt+V, then menu clicks | store (ids, `points` identity); the menu item actions read `useStore.getState()` live | No (clicks are `fireEvent`, act-wrapped) |
| F1.2, F1.3 | Alt+V; Ctrl+C | store | No |
| F2 | Delete, Ctrl+Z, menu click, Delete | store (`objects` order, `selectedIds`, `undoStack.length`) | No |
| F3 flip | Ctrl+Shift+V, Ctrl+V | store | No |
| F3 label | Ctrl+K then query the row | **DOM** | **Yes, named** |
| F4.2 | `?`, `?`, Escape | **DOM** + store | **Yes, named** |
| F4.3 | Ctrl+K, Escape, Ctrl+K | **DOM** + store | **Yes, named** |
| F5 (x3) | Ctrl+K, then change/Enter on the input | **DOM** (the input must exist) | **Yes, named** |
| F6 | S, Shift+S, `]`, `[` | store | No |
| F7.1 | Delete on the dialog button; rerender; Delete on body | store; the guard reads DOM that `render`/`rerender` already committed | No |
| F7.2 | Arrow, then Ctrl+Z after `render` of the dialog | store | No |
| F7.3 | Tab on the button; unmount; Tab on body | `defaultPrevented` on the event; DOM committed by `render` | No |
| F7.5 | `?`, Escape, Escape | **DOM** (the guard) + store | **Yes, named** |
| F8, F9 | clicks, `fireEvent.change`, direct calls | — | No |
| dispatchOrder pin | Ctrl+Shift+V | store | No |

Five governed, five named. No omission.

**Probed.** `r4flush.probe.test.tsx`: real store (`openDialog`/`closeDialog`, `openDialogs.has`), a stand-in
overlay rendering `aria-modal` from `openDialogs.has("shortcuts")` with the plan's handler shape (reads
`getState()` inside the listener), and a stand-in global handler with the F7 guard first and the Escape
deselect branch. Selection `["p"]`, tool `rectangle`. Results, both listener orders (`guard-first`,
`overlay-first`):

- `fireEvent.keyDown(window, {key})` for `?`, Escape, Escape: sheet in DOM after `?`; gone after the first
  Escape with selection and tool unchanged; selection cleared and tool `select` after the second. **Pass.**
- `act(() => window.dispatchEvent(new KeyboardEvent(…)))`: identical. **Pass.**
- Raw dispatch, no act: `DOM stale after ?: true; first Esc deselected: true` in both orders — the exact false
  red round 3 described.
- F5-shaped: Ctrl+K via `fireEvent(window)` renders the input; `fireEvent.change` + `fireEvent.keyDown(input,
  Enter)` runs the command, closes the modal, and the window-level guard does not interfere. **Pass.**

Listener order does not matter because a store write inside one listener is not flushed to the DOM before the
next listener on the same event runs, so the guard sees the modal on the first Escape whichever listener fires
first. That holds in Chrome too (native listeners, automatic batching), which is why the browser step is
deterministic.

### Q2. Is the store reset complete for every field asserted from a starting value?

The reset the plan prescribes (F1, mirrored from `shortcutsWriters.test.tsx:58-70`) is `objects`,
`objectsById`, `selectedIds`, `selectedSet`, `undoStack`, `redoStack`, `clipboard`, `activeTool`,
`nodeEditState`, plus `openDialogs: new Set()` and `snapToGrid: false`. Fields the tests assert from a
starting value, per file:

- `editCommands.test.tsx`: `clipboard` (F1.3 "unchanged"), `objects`/`selectedIds` (F2), `undoStack.length`
  (F2, F6), `snapToGrid` (F6 false→true→false), `rotation` (seeded on the object). All covered.
- `commandSurfaces.test.tsx`: `openDialogs` membership (F4.2/4.3), `activeTool`/`nodeEditState` (F5). Covered.
- `shortcutsModal.test.tsx`: `objects`, `undoStack.length`, `selectedIds`, `activeTool` (F7.5 `rectangle`
  set in-test, `select` asserted). Covered.
- `importUndo.test.tsx`: `undoStack`, `objects`, `openDialogs`; `layers`/`activeLayerIndex` are read, not
  asserted, and default. Covered.
- `activeLayerStrip.test.tsx` (extended, not new): the two 999999 cases set `grblMaxFeedRateX/Y` to 6000/5000
  and nothing resets them; the existing 1500 case is unaffected in either order (1500 < 5000). Order-independent
  in fact, but the plan's own rule says reset — A5.

The `warnedModals` WeakSet in `shortcuts.ts` is module state that survives across tests, but it is only
written when `checkVisibility()` returns `false`, which jsdom 29.1.1 cannot do (verified: `typeof
el.checkVisibility === "undefined"` under the installed jsdom). No leak path.

### Q3. Is the `switchTool` import change correct under `noUnusedLocals`?

`tsconfig.json` has `"noUnusedLocals": true` and `"noUnusedParameters": true`. In `shortcuts.ts`,
`handleToolChange` is used at exactly two sites, `:294` (Escape) and `:314` (tool keys), both of which F5
rewrites to `switchTool`. The plan's replacement line, `import { handleViewportKeyDown, switchTool } from
"./tools/toolHandler"`, is right; `handleViewportKeyDown` stays used at `:26`. `handleToolChange` remains
exported from `toolHandler.ts` for `Toolbar.tsx`. `switchTool` placed above `handleToolChange` calls a hoisted
function declaration, so ordering is fine. F1's other removals are also exact: `generateId` in `shortcuts.ts`
is used only in the two paste bodies F1 deletes; `movePartial` in `MenuBar.tsx` is used only at `:467` inside
`clipboardOp`; `movePartial` in `shortcuts.ts` stays for the nudge at `:281`; `MIN_ZOOM`/`MAX_ZOOM` stay used
in both files.

### Q4. Is the Escape wording accurate against the code?

Yes. Today (`ShortcutOverlay.tsx:81-95`) the sheet's Escape sets local state and does not stop propagation;
the global handler then reaches its Escape branch (`shortcuts.ts:287-296`): `clearSelection`,
`setActiveTool("select")`, `handleToolChange`. So "today it also deselects and switches to the Select tool"
is exactly right for the sheet. `handleViewportKeyDown` (`toolHandler.ts:1890-1937`) consumes Escape only for
pen-while-drawing, node, and measure-while-active, so with `activeTool: "rectangle"` the F7.5 positive control
does reach the global branch. For the palette, `CommandPalette.tsx:438-443` focuses the input 50 ms after open
and the global input guard (`shortcuts.ts:29-36`) bails on `INPUT`, so "today's Escape in the palette does not
reach the canvas … the only exception is if the palette's input has lost focus" is accurate (one nuance, A4).
The Files section's "must not claim a palette Escape change" is consistent with that.

### Q5. Does the `console.warn` spy restore properly?

The property being pinned is sound: no `console.warn` sits on the NestingDialog render or Delete path (the
only sites are `keepAwake.ts:57,62`, `connection.ts:376`, `dxfImport.ts:428`, `fileOps/index.ts:674,735`), and
jsdom lacks `checkVisibility`, so `not.toHaveBeenCalled()` is a real check that a future jsdom breaks loudly.
The restore instruction has a wording defect: the plan declares `const warn = vi.spyOn(console, "warn")`
inside test 1 and says "Restore the spy in `afterEach`", but a test-local `const` is not reachable from
`afterEach`, and `vitest.config.ts` sets neither `restoreMocks` nor `setupFiles`. The implementer must either
hoist the spy or use `afterEach(() => vi.restoreAllMocks())`. Either is fine; the plan should say which — A1.

### Q6. Does every red-first claim still fail on the named assertion?

Checked each against today's code:

- **F1.1** duplicate child ids: all three paste paths re-ID only the root (`shortcuts.ts:96-127`,
  `MenuBar.tsx:466`); `movePartial` on a group returns transform only (`geometry/index.ts:284-297`, `isPointsBearing`
  false for groups). `applyPartialsDeep` writes every match. Red on "unique ids" and "exactly one object". **F1.2**
  Alt+V `{ ...o, id }` shares `points`: red on `not.toBe`. **F1.3** Ctrl+C with nothing selected sets `clipboard`
  to `[]`: red on "unchanged".
- **F2** hand-rolled undo re-appends: red on `["A","B","C"]`. Empty selection: keyboard `pushCommand` is
  unconditional; menu `withUndo` pushes because `removeObjects([])` (`index.ts:247-259`) returns a fresh `filter`
  array and `withUndo` (`:411-427`) compares by reference. MenuBar's Delete item has no disabled state
  (`MenuBar.tsx:178-186`), so the menu path fires today. Both red on `undoStack.length` unchanged.
- **F3** `ctrl && key === "v"` has no `!shift` guard: Ctrl+Shift+V pastes, red on "count unchanged". Label:
  `arr-flip-v` has no `shortcut` (`CommandPalette.tsx:305-309`); the palette lists every command when the query
  is empty (`:451-457`), so the row is visible without typing. Red on the label.
- **F4.1** `document.dispatchEvent` of a non-bubbling event never reaches the `window` listener; the sheet has
  `aria-labelledby` → "Keyboard Shortcuts" (`ShortcutOverlay.tsx:103-135`), so `getByRole("dialog", { name })`
  is the right query and throws today. **F4.2/4.3** `openDialogs` never gains "shortcuts"/"commandPalette"
  today: red on membership.
- **F5** palette tool commands call `setActiveTool` only (`:156-204`): `nodeEditState.pathId` stays null (red),
  stays set on leaving node (red), and no "Measure Tool" row (red).
- **F6** no S/`]`/`[` handler (confirmed on the post-cdb75aa file): red on `snapToGrid`, on `rotation`, on the
  two `undoStack` +1 assertions. The "S is not an undo step" line is green today and is a companion assertion,
  not the red proof; the plan does not claim otherwise.
- **F7.1** the input guard passes `BUTTON`: Delete deletes, red on "stay at 1". **F7.2** Ctrl+Z fires: red.
  **F7.3** the Tab branch `preventDefault`s and `handleViewportKeyDown` does not consume Tab: red on "not
  defaultPrevented". **F7.5** first Escape deselects and switches tool: red on both.
- **F8.1** `handleImport` (`ImageImportDialog.tsx:62-111`) calls `addObject` bare; the button is named "Import"
  (`:353`; the `:140` "Import Image" is the title, not a button); `onImported`/`onClose` are `vi.fn()` so the
  dialog stays mounted. Red on "rose by 1". **F8.2** `importImageData(data: Uint8Array, ext: string)` assigns
  `onload` before `src`, so a `src`-setter stub works; the captured `store` is fine because `withUndo` reads
  `get()`. Red. **F8.3** `onImportVector` loops bare `addObject` (`App.tsx:367-374`). Red.
- **F9** `Number("")` is 0 and passes through (`ActiveLayerStrip.tsx:120-124`): red on `speed: 1`.
  `effectiveMaxSpeed(6000, 5000)` = 5000 (min), `rasterMaxSpeed(6000, 5000)` = 6000 (X first)
  (`speedScale.ts:65-79`); `DEFAULT_LAYERS[0]` is Engrave/`fill`, `[1]` Score/`line` (`types.ts:282-306`);
  LayerPanel's predicate is `mode === "fill" || mode === "fillLine"` (`LayerPanel.tsx:546`). The 5000/6000
  assertions are right and red today.

Every red-first claim survives.

---

## Core dimensions

### 1. Problem-fit — PASS
Unchanged: Intent section with skip line; Summary matches the fixes; the Ctrl+Shift+V ruling is Lee's and
routed through `scripts/update-decisions.mjs` by the orchestrator; nothing in `.claude/DECISIONS.md` (all
streaming, abort, power-mode, file-version, geometry, hardware evidence) is touched.

### 2. Approach soundness — PASS
Unchanged. The fold added no design; the probe confirms the F7 guard and the F4 store-driven surfaces
compose as the plan says, in either listener order.

### 3. Completeness — PASS
The governed-test list is exhaustive (Q1 table). The reset list is complete for new files (Q2). One
extended-file hygiene line (A5).

### 4. Right-sizing & reuse — PASS
Unchanged. Waiver present; seven Parking Lot lines; Batch 2 independent.

### 5. Security — PASS
Unchanged.

### 6. Failure modes — PASS
Unchanged. The warn spy makes the jsdom assumption a checked property (Q5).

### 7. Change safety — PASS
Session branch, no migrations; behaviour changes named for the ROADMAP entry. One nuance to the palette
exclusion (A4).

### 8. Data integrity & compatibility — PASS
Unchanged.

### 9. Verifiability — PASS
Round 3's CONCERN is closed: the rule is stated, scoped, listed and probed. Red-first holds on every named
assertion (Q6). Two small harness ambiguities that could produce a false red rather than a false green (A1,
A2).

### 10. Maintainability — PASS
Unchanged. The rule lives in one paragraph and is echoed where it applies, which is the right shape for a
harness convention.

### X1 Physical & human safety — PASS
F9 only narrows what `layer.speed` can be; generation-side refusal of non-positive feed (PLAN batch 2.6) is the
other half and is untouched.

### X5 Concurrency — PASS (advisory)
Listener order is immaterial to F7 (probed both ways).

### X6 Operability — PASS (advisory)
Dev warning verified in three parts in the browser step; silent in tests by a checked property.

---

## Three stress tests

### Pre-mortem
1. **A test went red after the fix and the implementer "fixed" the guard.** Most likely cause now: A2 — F7.3
   unmounts the harness with the bare div and the positive control reads as the guard sticking. The plan's
   F7.1 wording ("rerender with `open={false}`") is explicit; F7.3's "after unmounting it" is not.
2. **The warn spy leaked and a later file's warning assertion went weird.** Only if the spy is never restored
   (A1). Cost is confusion, not a false green.
3. **The keyboard died on first launch.** Unchanged from round 3: onboarding is `aria-modal`
   (`OnboardingOverlay.tsx:56`), the plan names it in Key decisions, F7 Risk, Browser verification and the
   shipped entry. Type-specific worst case for this plan remains silent loss of Ctrl+S, not the beam.

### Load-bearing assumptions
- **`fireEvent`/`act` flushes the DOM before the next dispatch.** Verified here, both listener orders, 7/7.
- **A store write inside one window listener is not visible in the DOM to the next listener on the same
  event.** Verified (raw case: `DOM stale after ?: true` in both orders); this is what makes F7 order-proof.
- **jsdom 29.1.1 lacks `checkVisibility`.** Verified with node against the installed package.
- **The five surfaces render under jsdom.** Unchanged from round 3 (high confidence; A5 of round 3 handles a
  crash as a harness problem, and that fold is present at plan line 101).

### Inversion
- *Keep the raw helper everywhere* wins only if no test reads the DOM after a key. Five do; the rule is the
  minimal fix.
- *Wrap every key* (no carve-out) would also work and would silence React's act warnings in the files that
  mount store-subscribed components (A3). The plan permits it; it does not require it. Either is fine.
- *Store-based guard* still loses: onboarding, the recovery prompt (`App.tsx:389-404`) and PowerCurveEditor
  keep state outside `openDialogs`.

---

## Findings

### Blocking

None.

### Advisory (fold if cheap; none changes a decision)

**A1. Say how the warn spy is restored.** F7 test 1 declares `const warn` inside the test and asks for an
`afterEach` restore; those two cannot coexist. `vitest.config.ts` has no `restoreMocks`. Write either
"`let warn` at describe scope, `afterEach(() => warn.mockRestore())`" or "`afterEach(() => vi.restoreAllMocks())`".

**A2. F7.3: unmount only the bare div.** "After unmounting it" should say the harness stays mounted — a
separate `render` for the harness, or `rerender` without the div. Unmounting the whole tree makes the positive
control a false red that looks like the guard sticking.

**A3. Raw `key()` in files that mount store subscribers prints act warnings.** `MenuBar` selects `isDirty`,
which `addObject` flips; `NestingDialog` selects `objects`. A raw Ctrl+V or Ctrl+Z in those files logs "not
wrapped in act" on `console.error`. Harmless (vitest does not fail on it, and it is `error`, not `warn`, so the
A4 spy is unaffected), but one line saying "wrapping every key is also acceptable" would spare a reader the
noise. Optional.

**A4. One nuance to the palette exclusion.** `handleViewportKeyDown` runs before the input guard, so today an
Escape from the palette's focused input mid-pen-path still cancels the pen; after F7 it does not. The Key
decisions bullet already says pen Enter/Escape is dead behind a modal, so the plan is internally right; the
shipped entry should phrase the palette exclusion as "no change to deselect behaviour" rather than "no palette
Escape change", so nobody reads it as absolute.

**A5. `activeLayerStrip.test.tsx`: reset `grblMaxFeedRateX: 0, grblMaxFeedRateY: 0` in `seedLayers`.** The two
999999 cases set 6000/5000 and nothing resets them. Order-independent today (1500 < 5000), but the plan's own
rule says any set field gets reset.

**A6. Typo.** Plan line 82, "Then then".

---

## Overall

The round-3 fold did what it was asked and introduced nothing. The dispatch rule is stated once with a trigger,
two forms and a carve-out, echoed at each governed test, and the governed list matches an exhaustive
enumeration of every key the plan's tests press. A probe against the real store confirms both forms deliver the
hardest case (F7.5) green in both listener orders and that the raw form fails exactly as round 3 measured. The
reset covers every asserted field, the import swap survives `noUnusedLocals`, the Escape wording matches
`ShortcutOverlay`, `shortcuts.ts` and `toolHandler.ts`, the warn spy sits on a path with no `console.warn` and a
jsdom that lacks `checkVisibility`, and every red-first claim checked in Q6 still fails on the assertion named. What
remains is harness prose: how the spy is restored and what F7.3 unmounts. Ready for relay.

**Prioritized must-fix:** none blocking. Advisory in order: A1, A2, A5, A4, A3, A6.
