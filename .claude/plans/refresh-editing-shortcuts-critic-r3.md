# Critic Review (round 3, final before escalation) — Refresh: Editing and Shortcuts

**Plan:** `.claude/plans/refresh-editing-shortcuts.md` (revised after round 2; Ctrl+Shift+V ruled by Lee
2026-09-22, switch removed)
**Earlier rounds:** `-critic-r1.md`, `-critic-r2.md`. Settled points are not re-litigated. This round hunts
what the round-2 folds introduced and what neither earlier round reached.
**Reviewed against:** worktree `session-8b2728` at `c08527d` (only `.claude/DECISIONS.md` changed since
`0a0e689`, where round 2 measured). Baselines re-measured here, not copied: `npx vitest run` = 51 files,
**823 passed**. Rust 310 is round 2's measurement at `0a0e689`; no Rust file has changed since.
**Reviewer:** separate Fable critic, read-only except this file. Every citation below was opened in the
tree; two claims were probed by running code (see dimension 9).

## Verdict: APPROVE WITH CHANGES

The round-2 folds are correct: the switch is gone with no dangling reference, `openDialogs` is reset in
every new file, the F6 undo-step split is right, the merged F7.1/F7.4 test is falsifiable, and every
Batch 1 fix still has a red-first test. One thing must be folded before relay, and it is procedural,
not design: the plan prescribes the raw `window.dispatchEvent` helper for every keyboard test, and I
measured that a raw dispatch which updates the store does **not** re-render the DOM synchronously. Five
of the new tests assert DOM state or chain a second key on the DOM the first key produced, so as written
they can go red but never green. The fix is one sentence. Everything else is advisory.

---

## Applicability

**Project type:** desktop CAD/CAM app (Tauri/React), keyboard/menu/palette dispatch and undo layer. No
Rust, serial or G-code generation touched.

| Dim | Fires? | Tag | Why |
|---|---|---|---|
| X1 Physical safety | **Fires, narrowly (F9)** | GATING | F9 writes `layer.speed`; nothing else reaches the machine. Unchanged since round 1. |
| X2 Privacy | Does not fire | N/A | No personal, client or health data in scope. |
| X3 Evidence | Does not fire | N/A | No research or public claims; the LightBurn/Illustrator sources were verified in round 1 and the point is now ruled. |
| X4 Audience/brand | Does not fire | N/A | Nothing client- or public-facing. |
| X5 Concurrency | Fires | ADVISORY | Several `window` keydown listeners on one event; F7 decides which one acts. |
| X6 Operability | Fires | ADVISORY | Released app; F7's guard has a dev warning whose silence in tests rests on one runtime fact. |
| X7 Self-modification | Does not fire | N/A | No MARVIN gates, hooks or skills. |
| X8 Deps/perf/cost | Does not fire | N/A | No packages; one `querySelector` per keydown. |

---

## Core dimensions

### 1. Problem-fit — PASS
`## Intent (grilled)` present with a written skip line; Summary matches the fixes. Lee's 2026-09-22
ruling is stated in Key decisions and F3, and the proposed DECISIONS.md entry goes through the
orchestrator and `scripts/update-decisions.mjs`, never the implementer. Nothing in
`.claude/DECISIONS.md` (all streaming, abort, power-mode, file-version, geometry) is touched;
`updateLayer`'s write door is left as it is.

**De-switching left nothing dangling.** Grepped the plan for `CTRL_SHIFT_V`, `CtrlShiftV`,
`runCtrlShiftV`, `_LABEL`, `Decision pending`, `option A/B`, `switch`, `three-way`, `binding`: the only
hits are F3's one historical sentence naming what was removed, and the Done-when's negative check. The
labels are consistent everywhere they are named (Key decisions bullet: M, H, Alt+V, S, Ctrl+Shift+V; F3
adds Ctrl+Shift+V to the Transform group; F6 adds S, M/H, Alt+V). `] / [` is already in the sheet
(`ShortcutOverlay.tsx:56`), so F6 correctly adds nothing for it there. Seven Deferrals lines counted,
seven claimed.

### 2. Approach soundness — PASS
Unchanged from rounds 1 and 2. Re-checked the two round-2 additions against the tree:
- **`checkVisibility` gate.** `Element.checkVisibility(options?): boolean` is declared on `interface
  Element` in the repo's `lib.dom.d.ts` (TS 5.9.3), `tsconfig` lib includes `DOM`, so
  `modal.checkVisibility?.()` type-checks. ESLint here is not type-aware (`tseslint.configs.recommended`,
  no `parserOptions.project`), so no `no-unnecessary-condition` warning on the optional call.
  `import.meta.env` is typed via `src/vite-env.d.ts` (`vite/client`). In Chrome a `display:none` root
  returns `false`; an ordinary open dialog returns `true`, so the browser check's three parts are right.
- **F6 split.** `rotate90` (`geometryActions.ts:724-738`) goes through `get().withUndo("rotate", …)` and
  normalises `(((r + angle) % 360) + 360) % 360`, so `[` from 0 gives 270 as the test expects.
  `setSnapToGrid` is `set({ snapToGrid: v })` (`index.ts:374`), no undo. The plan's assertions match.

### 3. Completeness — PASS
No new gap. One import the plan does not name: after F5 rewrites the tool and Escape branches to
`switchTool`, `handleToolChange` in `shortcuts.ts:4` has no remaining use (`:294`, `:314` are the only
two), and `noUnusedLocals: true` makes that a tsc error. A2.

### 4. Right-sizing & reuse — PASS
Waiver present with reason; Batch 2 independent; Parking Lot lines verbatim. Unchanged.

### 5. Security — PASS
Unchanged.

### 6. Failure modes — PASS
Unchanged. The dev warning now fires only for the mounted-but-hidden case, which is the one that
silently kills the keyboard; a visible stray `aria-modal` is visible on screen.

### 7. Change safety — PASS
Session branch, no migrations. F7's behaviour changes are named for the ROADMAP entry (one wording
defect, A3).

### 8. Data integrity & compatibility — PASS
`openDialogs: Set<string>` (`storeTypes.ts:269`); two new names need no type edit. Unchanged.

### 9. Verifiability — CONCERN

**(a) Raw `window.dispatchEvent` does not flush the DOM. Five tests cannot go green as written. B1.**
The plan says (F1 Test): drive "the `useKeyboardShortcuts` harness with window KeyboardEvents, as in
`shortcutsWriters.test.tsx`". That file's `key()` helper is a bare `window.dispatchEvent(new
KeyboardEvent(…))` (`shortcutsWriters.test.tsx:52-54`), not RTL's `fireEvent`, and no existing test that
uses it asserts DOM state — they read the store, which zustand updates synchronously. After F4 the sheet
and palette render from the store, so a keypress that opens or closes one changes the DOM only when
React re-renders. I measured when that is, with this repo's `react-dom` 18.3.1, `zustand` 5.0.11 and
`jsdom` 29.1.1, `IS_REACT_ACT_ENVIRONMENT = true`, a component selecting `openDialogs`-style state and a
`window` keydown listener flipping it:

```
DOM has aria-modal synchronously after raw dispatch:        false
DOM has aria-modal after one microtask:                     true
DOM has aria-modal synchronously after act-wrapped dispatch: false  (closed, as expected)
```

So a raw dispatch leaves the DOM one microtask stale; an `act()`-wrapped one (which is what
`fireEvent` does) flushes before returning. The tests this breaks, all introduced or reshaped in the
round-2 fold:
- **F7.5 (the second Escape).** `?` raw → sheet not yet in the DOM → first Escape raw → guard finds no
  modal → global Escape deselects → "selection unchanged" **fails after the fix**. Wrap only the `?` and
  the failure moves: first Escape correctly suppressed (the DOM still has the root at event time, which
  is also why this is deterministic in Chrome), but the close has not flushed when the second Escape is
  dispatched, so it is suppressed too and the positive control fails. Every step must flush.
- **F4 tests 2 and 3.** `?`/Ctrl+K/Escape then `getByRole("dialog")` or its absence: stale DOM, false red.
  The `openDialogs` membership halves are fine.
- **F5.** Ctrl+K raw, then `fireEvent.change` on the palette input: the input does not exist yet.
- **F3 label check** (in the palette test file): same as F4.3.

Not affected: F1/F2/F3/F6 keyboard cases (store assertions), F1/F2/F4.1 menu paths (`fireEvent.click` is
act-wrapped), F7.1 merged test (`render`/`rerender` are act-wrapped, and the Delete's guard check reads a
DOM that `render` already committed), F7.2, F7.3, F8, F9.

**No false-green mode.** In every case above the wrong result is a red after the fix, so nothing
unproven can slip through. It is blocking because the plan prescribes a method that cannot deliver the
green half of "red then green" for five tests, and the most likely mid-relay reaction to F7.5's false red
is to doubt the guard rather than the harness. The fold is one sentence in the F1 Test paragraph: *any
dispatch followed by a DOM assertion, or by a second key whose handling depends on the DOM the first key
produced, is wrapped in `act()` (or uses `fireEvent.keyDown(window, …)`); store-only assertions may keep
the raw helper.*

**(b) Merged F7.1/F7.4 — sound.** `NestingDialog` takes exactly `{ open, onClose }` (`NestingDialog.tsx:5-8`),
returns `null` when closed (`:50`), has `role="dialog" aria-modal="true"` (`:83-84`), touches no
selection, and its only side listener is Escape. A bubbling Delete on its focused button passes today's
input guard (BUTTON is not INPUT/TEXTAREA/SELECT) and deletes, so the first half is red today; after
`rerender({open:false})` the root is gone and Delete on `document.body` deletes, so the second half proves
the handler is live and the guard does not stick. Correctly falsifiable in one `it`.

**(c) F7.5 after B1 — sound.** Today's Escape branch (`shortcuts.ts:287-296`) unconditionally clears the
selection (when non-empty) and switches to `select`, so the second Escape's positive control is exactly
the branch the guard held back. Red today for the stated reason: the first Escape also deselects.

**(d) F7.3 — sound.** The Tab branch (`:232-240`) `preventDefault`s unconditionally and `selectNext`
returns early on zero objects (`index.ts:707-710`), so the positive control needs no fixture.

**(e) `openDialogs` reset and the singleton.** The reset is named for every new file (F1 Test, F4, F7,
F8 Test paragraphs, and Done-when). `useStore.setState({...})` is a shallow merge, so `openDialogs: new
Set()` alone is right. One field the same argument reaches and the plan does not: `snapToGrid`. F6's S
tests assert from `false`, and the Shift+S test ends with snap `true` (S toggled it, Shift+S left it).
File order saves it today; a reordered or added test does not. A1.

**(f) Batch 1 red-first chain, re-traced fix by fix.** F1: three tests red (duplicate child ids, shared
`points`, clipboard emptied). F2: `["B","C","A"]` today, and both empty-selection paths push an entry —
MenuBar's Delete item is never disabled (no `disabled` anywhere in `MenuBar.tsx`) and goes through
`withUndo` with `removeObjects([])` returning a fresh array (`index.ts:247-259`), so the menu case is a
real red. F3: no `!shift` on the paste branch (`:96`), so Ctrl+Shift+V pastes today; palette `arr-flip-v`
has no `shortcut` (`CommandPalette.tsx:305-310`). F4: `document.dispatchEvent` of a non-bubbling `?`
never reaches a `window` listener (`MenuBar.tsx:416`); `openDialogs` never holds either name. F5: palette
calls `setActiveTool` only (`:156-204`); `handleToolChange` is what sets `nodeEditState`
(`toolHandler.ts:1875-1884`). F6: no `s`, `[`, `]` branch exists. F7: 1, 2, 3, 5 all red for the stated
reasons. The only green-today assertion is "S is not an undo step", which rides in the same test as the
red toggle assertion. The pin in `shortcutDispatchOrder.test.tsx` fits that file's shape exactly (a
shifted key must not reach the plain handler; it uses the same `beforeEach` and `key()` helper, and its
assertions are store-only, so B1 does not touch it).

**(g) `flipObjects("vertical")` on one path** maps every anchor and handle to `2*cy - y` with `cy` the
object's own bbox centre and resets `scaleX/scaleY` to 1 (`geometryActions.ts:417-447`); the F3
assertion matches.

**(h) Existing suite under F7.** Still only two files dispatch keys and neither renders a dialog; 823
stays green.

### 10. Maintainability — PASS
Round 2's A1 (resets stay in the Ctrl+K handler) is folded. The F7 comment names the contract and the
deliberate `?`/Ctrl+K exception. `_testClipboardOp` dies with its consumer migrated; every assertion in
that migrated test (`shortcutsWriters.test.tsx:118-140`) survives `copySelection()` +
`pasteClipboard(false|true)` because in-place paste through `movePartial(c, x+0, y+0)` recomputes the
bbox to the same `(10,10)`.

---

## Conditional dimensions

### X1 Physical & human safety — PASS
F9 is unchanged since round 1: `clampSpeed(speed, max)`, `rasterMaxSpeed(mx, my)`,
`effectiveMaxSpeed(mx, my)` (`speedScale.ts:57-74`) exist with those signatures, and the strip today
passes `Number(e.target.value)` raw (`ActiveLayerStrip.tsx:120`). Worst physical case remains speed 1
mm/min committed from a cleared box, parity with LayerPanel, visible in the box, undoable. Nothing else
in the plan reaches the beam.

### X5 Concurrency & re-entrancy — PASS
Listener order on one keydown does not matter to F7: a store update inside any `window` listener does
not re-render until after the dispatch completes (the same fact as B1, here working in the plan's
favour), so the guard reads the DOM as it was when the key went down, in Chrome and in jsdom alike.

### X6 Operability — PASS (advisory note)
The test-time silence of the dev warning rests entirely on jsdom 29.1.1 not implementing
`checkVisibility` — verified: `typeof document.body.checkVisibility === "undefined"` in this repo's
jsdom, and `import.meta.env.DEV` is `true` under vitest. If a future jsdom implements it (it would
return `false`, having no layout), every dialog-rendering test starts printing the warning. Not a
failure; pin the silence rather than assume it (A4).

---

## Stress tests

### Pre-mortem — three months out
1. **The relay stalled on F7.5 and the guard got weakened.** Ted saw the second Escape's positive
   control fail after the fix, read it as the guard sticking, and added a "one Escape passes through"
   special case. Should have seen: the harness note in B1, and RTL's "not wrapped in act(...)" warning
   in the run log.
2. **Ctrl+Z after an image import undid the previous action.** F8 was cut from the relay ("Batch 2 can be
   cut") and never rescheduled. Should have seen: the ROADMAP `next` line the plan already requires if
   Batch 2 is cut. No change needed; named so the cut is not silent.
3. **The keyboard died on first launch and nobody could say why.** Type-specific worst case for this
   plan is silent loss of Ctrl+S, not the beam. The onboarding overlay is `aria-modal`
   (`OnboardingOverlay.tsx:55-56`) so the plan's "by design" line is right, but the shipped-entry wording
   is what a future reader will find; the plan already requires it there.

### Load-bearing assumptions
- **A raw `window.dispatchEvent` flushes the DOM before the next line runs.** *False*, measured. B1.
- **jsdom lacks `checkVisibility`.** True for 29.1.1, verified. Medium confidence over time; A4 pins it.
- **MenuBar, CommandPalette, ShortcutOverlay, NestingDialog and ImageImportDialog render under jsdom.**
  No existing test renders any of the five (grep across `__tests__`: zero). MenuBar's render reads two
  store scalars and `localStorage` via `getRecentFiles()` (`MenuBar.tsx:20`, `recentFiles.ts:6`), menus
  render items only when open, and `shortcutsWriters` already imports MenuBar (and through it App) green.
  High confidence, but a render crash is not a red assertion — A5.
- **Nothing reads `openDialogs` by size or iteration.** Verified in round 2; unchanged.

### Inversion
- *Keep the raw helper everywhere* wins if every new assertion is store-only. Five are not; B1.
- *Store-based guard* still loses: PowerCurveEditor, onboarding and the recovery prompt
  (`App.tsx:389-404`, `aria-modal` confirmed) keep state outside the store after F4.
- *Drop the dev warning* wins if Phase 5 ModalShell lands before any hidden-root bug. It has not; the
  warning costs three lines and is silent in normal use.

---

## Findings

### Blocking (fold before relay)

**B1. Flush the DOM in DOM-dependent keyboard tests.** In the F1 Test paragraph (where the harness method
is prescribed for the whole plan) add: any dispatch that is followed by a DOM assertion, or by a second
key whose handling depends on the DOM the first key produced, is wrapped in `act()` or uses
`fireEvent.keyDown(window, …)`; store-only assertions may keep the raw `key()` helper. Name the tests it
governs: F4.2, F4.3, F5, the F3 label check, and F7.5 (both Escapes and the `?`). Measured on this repo's
React 18.3.1 + zustand 5.0.11 + jsdom 29.1.1: a raw dispatch leaves the DOM one microtask stale; an
act-wrapped one does not. No false-green mode exists, but as written five tests cannot reach green.

### Advisory (should fold)

**A1. Add `snapToGrid: false` to the store reset**, and, as a rule for the new files, any field a test
asserts from a starting value. The Shift+S test leaves snap `true`; only file order protects the next
test.

**A2. Swap the `shortcuts.ts` import.** After F5, `handleToolChange` (`shortcuts.ts:4`) is unused and
`noUnusedLocals` fails tsc; import `switchTool` in its place. F1 names its import removals precisely;
F5 should too.

**A3. Scope the Escape behaviour change to the sheet.** Key decisions line 16 and F7's risk line say
Escape over the palette "today also deselects". The palette focuses its input on open
(`CommandPalette.tsx:438-443`), and `useKeyboardShortcuts` already bails on INPUT targets, so today's
palette Escape does not reach the canvas. Reword to "the `?` sheet (and the palette when its input is
not focused)" so the ROADMAP shipped entry does not claim a change that does not exist.

**A4. Pin the warning's silence.** In `shortcutsModal.test.tsx` test 1, `vi.spyOn(console, "warn")` and
assert it was not called while the dialog was open and keys were suppressed. That turns "jsdom happens
not to implement `checkVisibility`" into a checked property, and gives a future jsdom upgrade a clear
failure instead of noisy logs.

**A5. Render crash is not a red assertion.** The new files are the first to render MenuBar,
CommandPalette, ShortcutOverlay, NestingDialog and ImageImportDialog under jsdom. The Done-when's "failing
assertion lines quoted" already implies it; say explicitly that a red-first run must fail *on the named
assertion*, not on render, and that a render failure is reported as a harness problem, not as red proof.

---

## Overall

Round 2's folds hold under inspection: the switch left no residue, the singleton is reset, the F6
undo-step split matches `rotate90` and `setSnapToGrid` exactly, the merged F7 test cannot pass
vacuously, and every Batch 1 fix still fails today for the reason the plan gives. What both earlier
rounds and the plan missed is the harness itself: the raw `window.dispatchEvent` helper that every
existing keyboard test uses is safe only because those tests read the store, and this plan is the first
to render surfaces from the store and assert on the DOM after a key. Measured, a raw dispatch leaves
the DOM one microtask behind, so five tests — including the very positive control round 2 asked for —
would sit red after the fix. One sentence in the plan closes it. Fold B1, then A1–A3, and this is ready
for relay.

**Prioritized must-fix:** B1, then A1, A2, A3, A4, A5.
