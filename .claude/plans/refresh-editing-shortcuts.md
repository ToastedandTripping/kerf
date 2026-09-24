# Refresh — Editing and Shortcuts

## Intent (grilled)

**Summary:** Pasting a group gives you a real, independent copy instead of one that secretly shares its insides with the original. Delete then Undo puts objects back exactly where they were in the cut order, not at the end. Every menu label for a key tells the truth: Ctrl+Shift+V flips vertically, S toggles snap, ] and [ rotate, and Help > Keyboard Shortcuts actually opens the sheet. Keys pressed while a dialog is open stop reaching the canvas behind it. Importing an image or a PDF's vectors can be undone. The layer strip's Speed box can no longer write a speed of 0.

**Skip note:** Intent derived from the 2026-09-22 code-refresh findings (ui-1/lib-5, ui-2/lib-6, ui-3/lib-8, ui-4, ui-5, ui-6, ui-7, lib-7/core-5, lib-3/core-4, ui-10, ui-11) and Lee's selection of this bug group the same day; no grill session.

**Key decisions:**
- **One edit-command module, `src/lib/editCommands.ts`, made of plain functions and not new store actions.** Lee approved the module as part of this group. Plain functions that read `useStore.getState()` keep `AppState`/`storeTypes.ts` unchanged. MenuBar, CommandPalette and shortcuts.ts each make one call per command, so they can no longer drift. Duplicate and flip already exist as store actions (`duplicateInPlace`, `flipObjects`), so the module just forwards to them. Copy, cut, paste, paste-in-place and delete get their one real implementation here.
- **Ctrl+Shift+V = Flip Vertical, per Lee 2026-09-22 (LightBurn parity; Illustrator binds Paste in Place).** Alt+V stays Paste in Place. Flip Vertical is hard-bound; there is no switch. Plain paste gets a `!shift` guard. The implementer proposes a DECISIONS.md entry for this ruling in the relay log (see F3).
- **Unbound labels are fixed by binding the keys, not by deleting the labels,** because the handlers already exist: `setSnapToGrid` for S, and `rotate90("cw"|"ccw")` for ] and [.
- **The modal guard (ui-7) checks the DOM for `[aria-modal="true"]`. It does not check `openDialogs.size`.** 18 modal surfaces carry that attribute, and every one of them returns `null` when closed (checked in each component). Four of them keep their open state outside `openDialogs`: PowerCurveEditor, OnboardingOverlay, the recovery prompt in App.tsx, and (until F4) the palette and shortcut sheet. So a store check would miss them. MaterialTestDialog and GrblSettingsDialog are frozen files, and the DOM guard covers them without editing either. The guard goes *before* `handleViewportKeyDown`, so pen Enter/Escape and node Delete are also dead behind a modal. Cost: a future modal without `aria-modal` escapes the guard. ROADMAP Hardening Phase 5 (ModalShell) is where that attribute gets owned centrally, and this guard does not conflict with it.
- **All global shortcuts are suppressed while any modal is open, Ctrl+S/N/O included.** That is what modal means. Ctrl+N behind a dialog is exactly the kind of surprise ui-7 is about. Two visible consequences, both intended:
  - While the first-launch onboarding overlay or the "Recover unsaved work?" prompt is up, every shortcut is dead. On a first launch, shortcuts do nothing until the welcome guide is dismissed. That is by design, not a regression.
  - Escape with the `?` sheet open now only closes the sheet. Today it also deselects and switches to the Select tool. (The palette is not part of this change. It focuses its input on open (`CommandPalette.tsx:438-443`), and the global handler already ignores INPUT targets, so today's Escape in the palette does not reach the canvas either. The only exception is if the palette's input has lost focus.)

  `?` and Ctrl+K keep working over other modals. They are separate listeners, and that is deliberate.
- **Empty-selection guards in the module:** copy with nothing selected leaves the clipboard alone (today it empties it), and cut or delete with nothing selected pushes no undo entry. Today `removeObjects([])` always returns a new array, so `withUndo` records an empty step that makes the next Ctrl+Z look like it did nothing. Paste with an empty clipboard does nothing (today it clears the selection).
- **Paste keeps the source object names.** No " copy" suffix, unlike Duplicate. Unchanged behavior.
- **The 10 mm paste offset becomes `PASTE_OFFSET_MM` in `src/lib/constants.ts`,** next to `MIN_ZOOM`/`MAX_ZOOM`, so help text and ROADMAP can cite one number.
- **Tool switching gets one helper, `switchTool(tool)`, in `toolHandler.ts` next to `handleToolChange`.** The palette and shortcuts.ts call it. Toolbar.tsx already does the right thing and is left alone.
- **The layer strip clamps speed in the strip, using the same `clampSpeed` + max-speed selection that LayerPanel's SpeedInput uses.** Raster max for `fill`/`fillLine` layers and effective max otherwise, same predicate as LayerPanel.tsx:546. It does not clamp inside `updateLayer`. There is no ruling on speed, the machine max depends on layer mode and connection state, and the finding's minimal fix is the strip. SpeedInput was the strip's control until 39aa113 swapped it for a bare field and dropped the clamp with it. This restores the lost clamp and nothing more.
- **The shortcut sheet gains its missing true lines** (M Measure, H Pan, Alt+V Paste in place, S Toggle snap, Ctrl+Shift+V Flip vertical). The palette gains Measure Tool and Pan Tool (ui-5). No other palette additions.
- **ui-11 is dropped** (reason in F10).

## Context

All of these defects come from one root: each keyboard, menu and palette action was written separately in two or three places, and the copies have drifted apart. shortcuts.ts, MenuBar.tsx and CommandPalette.tsx each re-implement copy/paste/delete/flip, and each advertises shortcuts on its own. The known divergences today:

- MenuBar's paste mints ids with an inline `obj_${Date.now()}_${random}` scheme, while shortcuts.ts uses `generateId()`.
- Alt+V skips `movePartial`, so the pasted copy shares the original's points array. The menu's Paste in Place does go through it.
- Keyboard Delete hand-builds an undo command that re-appends objects. The menu, palette and context-menu versions use `withUndo`, which restores the original array.
- No paste path re-IDs group children, even though `deepCloneObject` was written for exactly that (1b462f8) and is already used by Duplicate.

The shortcut-label bugs (ui-3, ui-4, ui-6) are the same drift between what the labels promise and what the keys do. ui-5 (the palette skips `handleToolChange`) and ui-7 (shortcuts live behind modals) are both defects in the keyboard/command dispatch layer these files share. lib-3/core-4 (imports with no undo) and ui-10 (strip speed) touch other files, but share the undo-model and write-door theme and are small enough to ride along.

**File overlap:** shortcuts.ts is touched by F1, F2, F3, F5, F6 and F7. MenuBar.tsx by F1, F3, F4 and F6. CommandPalette.tsx by F1, F3, F4, F5 and F6. ShortcutOverlay.tsx by F3, F4 and F6. App.tsx by F4 and F8. Implement in the order listed. F1 lands the module that the rest call.

**Concurrent edits:**
- Already on the branch: cdb75aa removed the empty `if (key === "s" ...) {}` branch in shortcuts.ts. Every shortcuts.ts line cited in this plan was re-read after that commit. Lines up to :318 are unchanged, and the zoom block now starts at :325. F6 adds a new S branch.
- Also on the branch: bc87e45 narrowed exports in four files, none of them in scope.
- Still pending: the ARCHITECTURE.md refresh. Rebase onto it before adding F1's one line.

## Dependency Graph

| Fix | Depends on | Why | Files it touches | Batch |
|---|---|---|---|---|
| F1 shared module + paste | — | creates `editCommands.ts` that F2, F3 and F6 call | editCommands.ts (new), constants.ts, shortcuts.ts, MenuBar.tsx, CommandPalette.tsx | 1 |
| F2 delete undo | F1 | `deleteSelection` lives in the module | editCommands.ts, shortcuts.ts, MenuBar.tsx, CommandPalette.tsx | 1 |
| F3 Ctrl+Shift+V | F1 | calls `flipSelection` from the module | editCommands.ts, shortcuts.ts, MenuBar.tsx, CommandPalette.tsx, ShortcutOverlay.tsx | 1 |
| F4 palette/sheet into `openDialogs` | F3 | same three surfaces; sequential to avoid overlapping edits | MenuBar.tsx, CommandPalette.tsx, ShortcutOverlay.tsx, App.tsx | 1 |
| F5 palette tool switching | F4 | palette file; `switchTool` also used by shortcuts.ts | toolHandler.ts, CommandPalette.tsx, shortcuts.ts | 1 |
| F6 bind S, ], [ | F3, F4 | labels land in the sheet F4 rewired | shortcuts.ts, MenuBar.tsx, CommandPalette.tsx, ShortcutOverlay.tsx, ImageTraceDialog.tsx (comment) | 1 |
| F7 modal guard | F4 | its tests exercise the store-driven sheet/palette | shortcuts.ts | 1 |
| F8 import undo | — | independent rider | imageImport.ts, ImageImportDialog.tsx, App.tsx | 2 |
| F9 strip speed clamp | — | independent rider | ActiveLayerStrip.tsx | 2 |

**Batch boundaries.**
- **Batch 1** is F1→F7, strictly in that order. It is one subsystem: keyboard, menu and palette command dispatch. **Waiver:** it touches nine production files, over the eight-file line: `editCommands.ts` (new), `constants.ts`, `shortcuts.ts`, `MenuBar.tsx`, `CommandPalette.tsx`, `ShortcutOverlay.tsx`, `App.tsx`, `toolHandler.ts`, and `ImageTraceDialog.tsx` (comment only). It also touches five test files. That is accepted because it is one subsystem, and splitting a single dispatch layer across batches would leave the three surfaces diverged halfway through, the defect this batch exists to close. Two of the nine are one-line or one-export touches (`constants.ts`, the ImageTraceDialog comment). Razor reviews Batch 1 as one diff.
- **Batch 2** is F8 and F9, independent of Batch 1 and of each other.
  - It runs after Batch 1 in the same relay, so it can be reviewed separately.
  - F8's only shared file is App.tsx. Its edit there is the `importPdfVectors` extraction, which does not overlap F4's `openKeyboardShortcuts` helper.
  - Batch 2 can be cut from the relay without touching Batch 1.

## Fixes

### F1. One edit-command module; paste deep-clones with fresh ids at every depth (ui-1/lib-5, ui-2/lib-6)

**Diagnosis (re-verified):**
- `src/lib/shortcuts.ts:96-111` (Ctrl+V): `{ ...o, id: generateId(), ...movePartial(...) }` re-IDs only the root.
- `src/lib/shortcuts.ts:115-127` (Alt+V): re-IDs only the root and never calls `movePartial`, so the copy shares `points` with the original.
- `src/components/topbar/MenuBar.tsx:448-473` (`clipboardOp`): re-IDs only the root, with a private id scheme at :466.
- `movePartial` on a group returns only a transform (`src/lib/geometry/index.ts:284-297`), so children keep the source children's ids.
- `applyPartialsDeep` (`src/app/store/index.ts:124-137`) applies a partial to *any* id at *any* depth, so `updateObject(childId)` writes into every copy.
- Re-ran the ui reader's probe (`scratchpad/refresh/probe/paste.probe.test.tsx`) on the current tree. A group with children a,b, after menu Paste + Ctrl+V + Alt+V, has 12 ids with duplicates `["a","b","a","b","a","b"]`. `updateObject("a")` touched 4 objects. Alt+V shares the points array: `true`.
- `deepCloneObject` (`src/app/store/storeTypes.ts:300-311`) re-IDs every level and copies `points`. It is used by `duplicateInPlace` (`src/app/store/index.ts:731-745`).

**Fix:** Create `src/lib/editCommands.ts`:
- `copySelection()`: return if nothing is selected. Otherwise `setClipboard(objects.filter(o => selectedSet.has(o.id)))`.
- `cutSelection()`: return if nothing is selected. Otherwise copy, then `withUndo("cut", () => removeObjects(ids))`.
- `pasteClipboard(inPlace: boolean)`: return if the clipboard is empty. Otherwise `withUndo("paste", …)`: for each clipboard object, `const c = deepCloneObject(o)`. Import it as `import { deepCloneObject } from "../app/store/storeTypes"`. `app/store/index.ts` re-exports only `generateId` and `AppState` (`:21-22`), the same reason `App.tsx:37` imports `generateId` from storeTypes. Then `{ ...c, ...movePartial(c, c.transform.x + d, c.transform.y + d) }` with `d = inPlace ? 0 : PASTE_OFFSET_MM` (new `export const PASTE_OFFSET_MM = 10` in `src/lib/constants.ts`); `addObject` each one, then `setSelectedIds(newIds)`. Paste-in-place also goes through `movePartial` (offset 0). That matches today's menu path and its existing test.
- `duplicateSelection()`: forwards to `duplicateInPlace()`.
- `deleteSelection()`: F2.
- `flipSelection(axis)`: forwards to `flipObjects(axis)`.

Then replace the inline bodies:
- shortcuts.ts: Ctrl+C, Ctrl+X, Ctrl+V, Alt+V, Ctrl+D, Delete/Backspace, Ctrl+Shift+H, plus the new Ctrl+Shift+V (F3).
- MenuBar.tsx: Cut, Copy, Paste, Paste in Place, Duplicate, Delete, Flip H/V. Delete `clipboardOp` and its `_testClipboardOp` export.
- CommandPalette.tsx: Duplicate, Delete Selected, Flip H/V.

Remove the now-unused imports: `movePartial` from MenuBar.tsx, and `generateId` from shortcuts.ts. Keep `movePartial` in shortcuts.ts, because the arrow-nudge branch (`:281`) still uses it.

**Test:** New `src/lib/__tests__/editCommands.test.tsx`. Its `beforeEach` resets the store the way `shortcutsWriters.test.tsx:58-70` does, **plus `openDialogs: new Set()`**. The store is a module singleton that testing-library cleanup does not touch, and after F4 a test that leaves the palette or sheet open would poison the next one. The reset also includes **`snapToGrid: false`**. General rule for the new files: any store field a test asserts from a known starting value gets reset in `beforeEach`, so the result never depends on test order. For example, the F6 Shift+S test leaves snap `true`. The same reset applies to every new test file in this plan.

**Keyboard dispatch rule (applies to the whole plan):**
- If a key is followed by a DOM assertion, or by a second key whose handling depends on DOM the first key produced, dispatch it through `act(() => …)` or `fireEvent.keyDown(window, …)` (testing-library, already act-wrapped). A raw `window.dispatchEvent` leaves React's DOM one microtask stale on this repo's React 18.3 + zustand 5 + jsdom (measured by the round-3 critic), so those tests could never reach green.
- The raw `key()` helper stays for tests that assert store state only. In files that mount store subscribers (MenuBar selects `isDirty`, NestingDialog selects `objects`), a raw key prints "not wrapped in act(...)" on `console.error`. That is harmless: vitest does not fail on it, and it is `error`, not `warn`, so the F7 warn spy is unaffected. Wrapping every key in `act()` is also acceptable if you want quiet output.
- Tests this governs: F4.2, F4.3, F5 (all three cases), the F3 palette-label check, and F7.5 (the `?` and both Escapes).

**Red first means the named assertion fails.** These new files are the first to render MenuBar, CommandPalette, ShortcutOverlay, NestingDialog and ImageImportDialog under jsdom. A red-first run must fail *on the assertion the plan names*. A throw during render, or a missing mock, is a harness problem: report it as that, fix the harness, and re-run. It is not red proof.

Drive the real surfaces: the `useKeyboardShortcuts` harness with window KeyboardEvents, as in `shortcutsWriters.test.tsx`, plus a rendered `<MenuBar />` whose Edit menu is opened and its items clicked. That way the same test runs against today's code and after the change.
1. Group two paths a,b (`groupSelected`), select the group, Ctrl+C, then Ctrl+V, Alt+V, and menu Edit > Paste and Paste in Place. Assert every id in the flattened tree is unique. Assert that `updateObject(<original child id>, { name: "EDITED" })` changes exactly one object. Assert each pasted child's `points` is not `===` the original child's.
2. Alt+V on a single path: pasted `points` is not `===` the original's, and pasted `transform` equals the original's.
3. With nothing selected, Ctrl+C leaves a non-empty clipboard unchanged. Positive control in the same test: select one object, Ctrl+C, and assert the clipboard now holds exactly that object, so a dead Ctrl+C handler cannot pass the empty case.

Migrate `src/lib/__tests__/shortcutsWriters.test.tsx` "MenuBar clipboardOp paste" off `_testClipboardOp` onto `pasteClipboard(false|true)`, keeping every assertion.

**Red first:** write tests 1-3 before touching production code and run `npx vitest run src/lib/__tests__/editCommands.test.tsx`. Tests 1 and 2 must fail (duplicate ids, shared points), and test 3 fails because the clipboard gets emptied. Paste the failing assertion lines into the implementer report. Any unit tests that import `editCommands` directly are extra and are not the red proof.

**Risk:**
- Callers of the replaced code: only the three surfaces, plus the `_testClipboardOp` test consumer, which is migrated.
- Context-menu Delete in `Viewport.tsx:1549-1553` already uses `withUndo` correctly. It is left alone because the D-canvas relay owns Viewport.tsx (see Files).
- Chesterton: `git log -S` puts the MenuBar id scheme and the hand-rolled delete in 36aed44 and 01d0772 (initial build). No later commit chose them. df2eea1 moved shortcuts.ts to `generateId` and missed MenuBar.
- `deepCloneObject` copies `points` element-wise, but `handleIn`/`handleOut` objects are copied shallowly. That is safe because every writer replaces handles rather than mutating them (`movePartial` rebuilds them anyway).
- Clipboard entries stay live references to immutable store objects, as today.
- Divergences the module resolves that are not otherwise named, all benign (critic, 2026-09-22):
  - Keyboard Alt+V now recomputes the transform from points through `movePartial`, as the menu path already did. This is only visible on an object whose transform had drifted from its points.
  - Ctrl+Alt+V still reaches the offset paste, because the Ctrl branch wins. Unchanged.
  - Ctrl+Shift+X still cuts. There is no shift guard on X, and none is needed.

### F2. Keyboard Delete undo restores original array positions (lib-7/core-5)

**Diagnosis (re-verified):** `src/lib/shortcuts.ts:242-259` removes the objects and then pushes a hand-built command whose undo is `deletedObjects.forEach(addObject)`. `addObject` appends (`src/app/store/index.ts:174-184`), so [A,B,C] → delete A → undo gives [B,C,A]. Selection is not restored either. Array order feeds the within-layer cut order (store comment F15 at `index.ts:142-144`, "reordering changes the cut"), so undo silently reorders the job. `withUndo` (`index.ts:411-427`) snapshots the whole array and restores it exactly, including selection.

**Fix:** `deleteSelection()` in `editCommands.ts`: return if nothing is selected; otherwise `const ids = selectedIds.slice(); withUndo("delete", () => removeObjects(ids))`. The Delete/Backspace branch of shortcuts.ts, MenuBar Delete and palette Delete Selected all call it. The node-tool Delete stays in `handleViewportKeyDown` and is unchanged.

**Test:** In `editCommands.test.tsx`, add three rectangles A,B,C on layer 0, select A, press Delete, then Ctrl+Z. Assert the objects' ids are `["A","B","C"]` and `selectedIds` is `["A"]`. The test must carry this comment: `// Array order within a layer is cut order (toCutObjects stable sort; store F15): undo must restore original positions, or Delete+Undo silently re-sequences the job.` Second case: with nothing selected, Delete (key) and menu Edit > Delete each leave `undoStack.length` unchanged. Each path gets its own positive control in the same test:
- keyboard: select B, press Delete, and assert `undoStack.length` rose by exactly 1 and B is gone;
- menu: select C, click Edit > Delete, and assert `undoStack.length` rose by exactly 1 and C is gone.

That way neither a dead key handler nor a dead or mislabelled menu item can pass the "unchanged" assertions. Red today: order `["B","C","A"]`, and the empty-selection cases each push an entry.

**Risk:** `pushCommand` stays public and is still used by toolHandler's shape/text creation (`toolHandler.ts:1307-1314`, `1797-1803`). core-5's second half, those delta "add" commands, is out of scope: their undo is a removal and their redo re-appends an object that was last anyway.

### F3. Ctrl+Shift+V flips vertically, per Lee 2026-09-22 (ui-3/lib-8)

**Diagnosis (re-verified after cdb75aa):** The Ctrl+V branch at `shortcuts.ts:96` has no `!shift` guard, and no Ctrl+Shift+V branch exists. The comment at :184-185 is wrong. MenuBar.tsx:292-296 labels Flip Vertical "Ctrl+Shift+V". The palette (`CommandPalette.tsx:305-310`) and ShortcutOverlay list no key for it. Probe: Ctrl+Shift+V with one object selected took the object count from 4 to 5.

**Ruling:** Lee, 2026-09-22: Ctrl+Shift+V = Flip Vertical (LightBurn parity; Illustrator binds Paste in Place), and Alt+V stays Paste in Place. This resolves round-2 critic finding B1 by deletion. The earlier three-way `CTRL_SHIFT_V` switch, its `CtrlShiftVBinding` type, `runCtrlShiftV`'s other arms and the derived label constants are all gone, so no untested branch ships.

**Fix:** Hard-bind it.
- shortcuts.ts:
  - Change the paste branch to `if (ctrl && !shift && key === "v")`.
  - Add `if (ctrl && shift && key === "v") { e.preventDefault(); flipSelection("vertical"); return; }` beside the Ctrl+Shift+H branch.
  - Delete the stale comment at :184-185.
- MenuBar: Flip Vertical keeps its existing "Ctrl+Shift+V" label, and Paste in Place keeps "Alt+V". No label change.
- Palette `arr-flip-v`: add `shortcut: "Ctrl+Shift+V"`.
- ShortcutOverlay Transform group: add `{ keys: "Ctrl+Shift+V", action: "Flip vertical" }`.

**Test:** In `editCommands.test.tsx`, select one path with a non-empty clipboard and press Ctrl+Shift+V (`key: "V", shiftKey: true, ctrlKey: true`). Assert the object count is unchanged and every point's y maps to `2*cy - y`. Positive control in the same test: plain Ctrl+V then still offset-pastes (count +1). Red today: the count grows and no flip happens.

Label check, in the F4 palette test file: the "Flip Vertical" row shows "Ctrl+Shift+V". The palette is opened with `act()`/`fireEvent.keyDown(window, …)` before the row is queried (F1 dispatch rule). Red today: no shortcut is shown.

**Implementer note:** record the ruling in the relay log. Also hand the orchestrator a proposed DECISIONS.md entry, for it to write through `scripts/update-decisions.mjs` (the implementer never writes that file):
- Heading: `Ctrl+Shift+V is Flip Vertical and Alt+V is Paste in Place (LightBurn parity).`
- Date line: `*2026-09-22, Lee*`
- Reason paragraph: Illustrator binds Ctrl+Shift+V to Paste in Place and LightBurn to Flip Vertical; Kerf's labels had always been LightBurn's, and the key had silently pasted instead.

**Risk:** Only shortcuts.ts dispatches the key. `shortcutDispatchOrder.test.tsx` pins the shift guards on C and A, so add the Ctrl+Shift+V pin there too (flips, does not paste), keeping all the guard pins in one file.

### F4. Help > Keyboard Shortcuts opens the sheet; palette and sheet open state moves into `openDialogs` (ui-4)

**Diagnosis (re-verified):** `MenuBar.tsx:413-417` does `document.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }))`. That event has `bubbles: false` by default and is dispatched at `document`, so ShortcutOverlay's `window` listener (`ShortcutOverlay.tsx:81-95`) never sees it. The root cause is that `ShortcutOverlay` (`useState` at :79) and `CommandPalette` (`useState` at :416) keep their open state locally. ARCHITECTURE.md:172 says dialog state lives in `openDialogs`/`openDialog`/`closeDialog` (`storeTypes.ts:269-271`, `index.ts:856-868`), so the menu has no way in except faking a keypress.

**Fix:**
- ShortcutOverlay: `const visible = useStore((s) => s.openDialogs.has("shortcuts"))` (a boolean, safe under the selector rule). Keep its window listener, but have `?` / Shift+/ toggle via `openDialog("shortcuts")`/`closeDialog("shortcuts")` and Escape call `closeDialog`. Read the current state with `useStore.getState()` inside the handler so the effect has no `visible` dependency. The backdrop click calls `closeDialog`.
- CommandPalette: the same, with `"commandPalette"`. Ctrl+K calls `openDialog`, Escape and backdrop call `closeDialog`, and `handleSelect` calls `closeDialog` before running the command. Keep the `setQuery("")` / `setSelectedIndex(0)` resets where they are today, in the Ctrl+K handler (`:425-427`), next to the new `openDialog` call. Do not move them into the on-open focus effect (`:438-443`): setting state in an effect trips the `react-hooks/set-state-in-effect` lint warning, and Done-when forbids new warnings.
- App.tsx: add `openKeyboardShortcuts()` beside the other `open*` helpers.
- MenuBar Help > Keyboard Shortcuts: `action: () => openKeyboardShortcuts()`.

**Test:** New `src/components/topbar/__tests__/commandSurfaces.test.tsx`. Its `beforeEach` resets the store including `openDialogs: new Set()` (see F1).
1. Render `<MenuBar />` and `<ShortcutOverlay />`. Assert no "Keyboard Shortcuts" dialog is present. Click Help, then Keyboard Shortcuts, and assert `getByRole("dialog", { name: "Keyboard Shortcuts" })` exists. Red today.
2. Assert `"shortcuts"` is absent from `openDialogs`. The `?` key opens the sheet and `?` again closes it. Dispatch every key here with `act()`/`fireEvent.keyDown(window, …)`, per the F1 dispatch rule. Escape closes it. The `openDialogs` membership tracks both.
3. Render `<CommandPalette />`. Assert `"commandPalette"` is absent from `openDialogs` and no palette dialog is rendered **before** the keypress. Then Ctrl+K puts `"commandPalette"` in `openDialogs` and shows the dialog, and Escape removes it. Also assert the search input is empty after a close/reopen cycle, which proves the Ctrl+K handler's reset. Ctrl+K and Escape go through `act()`/`fireEvent.keyDown(window, …)` (F1 dispatch rule).

**Risk:** CommandPalette and ShortcutOverlay are each mounted once, in App.tsx:303 and :383. No other code opens them. Adding two names to `openDialogs` has no side effects: nothing iterates the set.

### F5. Palette tool commands go through `handleToolChange` (ui-5)

**Diagnosis (re-verified):** `CommandPalette.tsx:156-204` calls `setActiveTool` only. Toolbar.tsx:41-45 and shortcuts.ts:308-315 call `setActiveTool` and then `handleToolChange(new, previous)`. `handleToolChange` (`toolHandler.ts:1862-1887`) cancels an in-progress pen, clears node-edit state on leaving node, resets measure, and auto-enters node editing when exactly one path is selected. The palette also lacks Measure and Pan.

**Fix:** Add `export function switchTool(newTool: ToolType)` in `toolHandler.ts` directly above `handleToolChange`. It reads `previousTool = getState().activeTool`, calls `setActiveTool(newTool)`, then `handleToolChange(newTool, previousTool)`. The palette's tool commands call `switchTool`. Add `tool-measure` ("Measure Tool", "M") and `tool-pan` ("Pan Tool", "H"). The shortcuts.ts tool branch (:308-315) and Escape branch (:287-296) call `switchTool`: same behavior, one less copy. In shortcuts.ts, change the import at `:4` to `import { handleViewportKeyDown, switchTool } from "./tools/toolHandler"`. `handleToolChange` becomes unused there, and `noUnusedLocals` would fail tsc otherwise.

**Test:** In `commandSurfaces.test.tsx`, select a single path, open the palette with Ctrl+K, change the search input to "Node Edit", press Enter. Assert `activeTool === "node"` and `nodeEditState.pathId === <path id>`. Second case: with `activeTool: "node"` and `nodeEditState.pathId` set, choose "Select Tool" and assert `pathId === null`. Third: searching "Measure" finds a "Measure Tool" row. Red today on all three. Ctrl+K here opens DOM that the following input change and Enter depend on, so dispatch it through `act()`/`fireEvent.keyDown(window, …)` (F1 dispatch rule). The Enter goes to the input via `fireEvent.keyDown(input, …)`.

**Risk:** toolHandler.ts is 1,944 lines with thin tests (core-18 declined its split). The change is a new 6-line export and touches no existing function.

### F6. Labelled-but-unbound keys get bound: S, ], [ (ui-6)

**Diagnosis (re-verified after cdb75aa):**
- MenuBar.tsx:204-211 shows "S" for Toggle Snap, but no S handler exists. The empty `if (key === "s" …) {}` block was deleted by cdb75aa, whose message says no snap toggle is advertised. That is wrong: the View menu label is still there.
- ShortcutOverlay.tsx:56 lists "] / [" Rotate 90. `grep` finds no `"]"`/`"["` handler in src.
- `rotate90` exists (`geometryActions.ts:724-738`) and `setSnapToGrid` exists (`index.ts:374`).
- The ImageTraceDialog.tsx:151 code comment says "Ungroup (Ctrl+Shift+G)". The binding is Ctrl+U (shortcuts.ts:135).

**Fix:** In shortcuts.ts, before the tool-shortcut branch (key `s` is not a tool key, `[`/`]` are not tool keys):
- `if (!ctrl && !shift && !alt && key === "s") { setSnapToGrid(!snapToGrid); return; }`, a new branch with the same modifier guard as the tool keys, so Shift+S does nothing.
- `if (!ctrl && !alt && e.key === "]") { rotate90("cw"); return; }`
- `if (!ctrl && !alt && e.key === "[") { rotate90("ccw"); return; }`

Then fix the labels:
- MenuBar Arrange: add `shortcut: "]"` / `"["` to Rotate 90 CW/CCW.
- Palette: add `"S"` to view-snap and `"]"`/`"["` to arr-rot90cw/ccw.
- ShortcutOverlay: add S (Toggle snap) under View, M/H under Tools, and Alt+V (Paste in place) under Edit.
- ImageTraceDialog.tsx:151 comment: Ctrl+Shift+G → Ctrl+U.

**Test:** In `editCommands.test.tsx` (a keyboard group):
- S toggles `snapToGrid` false→true→false. Shift+S leaves it unchanged, right after a plain S that did toggle it (the positive control).
- With one rect at rotation 0 selected, `]` gives rotation 90 and `[` then gives 0. `[` from 0 gives 270.
- `]` and `[` are each one undo step (`undoStack.length` +1), because `rotate90` goes through `withUndo`.
- S is **not** an undo step. `setSnapToGrid` is a plain `set` (`index.ts:374`), a view setting rather than a document edit, so assert `undoStack.length` is unchanged after S.

Red today on all of them.

**Risk:** On-canvas text editing uses a `<textarea>` (Viewport.tsx:1016), so the input guard keeps S, [ and ] from firing while typing. Chesterton: the removed empty S block and the "] / [" label both come from the initial commit / Phase-4 overlay (5f04a3c). Neither was ever wired, and no reason is recorded for leaving them unbound. cdb75aa removed dead code. It did not decide that S should be unbound.

### F7. Global shortcuts are inert while a modal is open (ui-7)

**Diagnosis (re-verified):** `useKeyboardShortcuts` (`shortcuts.ts:23-36`) bails only for INPUT/TEXTAREA/SELECT/contentEditable targets. `useFocusTrap` (`useFocusTrap.ts:53-76`) handles Tab only and usually focuses a button first. The probe (`probe/modal.probe.test.tsx`) was re-run on the current tree: with NestingDialog open and its first button focused, a bubbling Delete took the objects from 1 to 0. The same path lets Ctrl+Z/Y, arrow nudges, 1-6 layer moves, G, Escape and Tab (which `preventDefault`s and breaks tabbing inside the dialog) reach the hidden canvas. `handleViewportKeyDown` runs even before the input check, so node Delete and pen Enter are live behind modals too.

**Fix:** Make this the first statement of `handleKeyDown`, above `handleViewportKeyDown`:

```ts
// A modal owns the keyboard: the canvas behind it is not the user's target.
// Contract: every modal root carries aria-modal="true" and UNMOUNTS when closed
// (hidden-by-CSS would kill every shortcut). ROADMAP Phase 5 ModalShell owns this.
// `?` (ShortcutOverlay) and Ctrl+K (CommandPalette) deliberately still work over
// other modals — they are separate listeners, not this handler. Do not "fix" that.
const modal = document.querySelector('[aria-modal="true"]');
if (modal) {
  // Dev-only stuck-modal detector: warn only when the modal root is mounted but
  // NOT visible (the contract breach above). A normal open dialog stays silent.
  if (import.meta.env.DEV && modal.checkVisibility?.() === false && !warnedModals.has(modal)) {
    warnedModals.add(modal);
    console.warn("[shortcuts] all shortcuts suppressed by a hidden aria-modal root:", modal);
  }
  return;
}
```

Also add `const warnedModals = new WeakSet<Element>();` at module scope. **What the warning means:** it fires only in dev builds, only for an `aria-modal` root that is mounted but invisible (the one case that silently kills the keyboard), and once per element identity. An ordinary open dialog never triggers it. jsdom does not implement `checkVisibility`, so under vitest the optional call returns `undefined` and the warning never prints. Test runs stay quiet, and the check is exercised in the browser step instead. `Element.checkVisibility` is declared in the repo's TS DOM lib (checked in `node_modules/typescript/lib/lib.dom.d.ts`; tsconfig `lib` includes `DOM`). The optional call (`?.()`) is there for jsdom, which lacks it at runtime.

Each dialog's own listeners (Escape via `useEscapeClose`, the palette and sheet listeners, focus traps) are separate listeners and keep working.

**Test:** New `src/lib/__tests__/shortcutsModal.test.tsx`. Its `beforeEach` resets the store including `openDialogs: new Set()` (see F1).
1. **One test, suppressed → unmount → fires.** Render the harness plus `<NestingDialog open onClose={noop} />`. Focus its first button, dispatch a bubbling Delete, and assert objects stay at 1. Then unmount the dialog (rerender with `open={false}`), dispatch Delete on `document.body`, and assert objects drop to 0. The second half proves the handler was live and the guard does not stick, so the first half cannot pass vacuously. Also spy on the warning: declare `let warn: MockInstance` at describe scope, set `warn = vi.spyOn(console, "warn")` in the test, and assert `expect(warn).not.toHaveBeenCalled()` after the suppressed Delete. That pins the rule that an ordinary open dialog never warns, as a checked property rather than a jsdom accident; a future jsdom that implements `checkVisibility` fails here clearly instead of logging noise. Restore it with `afterEach(() => vi.restoreAllMocks())`. `vitest.config.ts` sets no `restoreMocks`, so this must be explicit. Red today: the first objects assertion fails.
2. Nudge an object with an arrow key *before* rendering the dialog, and assert `undoStack.length` is 1. That is the positive control: the harness is live. Then render the dialog, focus its button, press Ctrl+Z: `undoStack.length` is still 1 and the object is still nudged. Red today, because the undo fires.
3. With a bare `<div role="dialog" aria-modal="true"><button/></div>`, Tab is not `defaultPrevented`. Positive control: after removing **only the bare div**, Tab on `document.body` *is* `defaultPrevented`. The harness must stay mounted: render the harness and the div with separate `render` calls and unmount only the div's, or `rerender` without the div. Unmounting the whole tree removes the handler and turns the control into a false red that looks like a stuck guard. The prevented Tab comes from the global object-cycling handler. This pins the contract independently of any one dialog.
4. (Folded into test 1.)
5. Select an object, set `activeTool: "rectangle"`, and open the sheet with `?`. Press Escape: the sheet closes, and the selection and `activeTool` are unchanged. That is the named Escape change below. Positive control in the same test: press Escape again, now with no modal mounted, and assert the selection clears and `activeTool === "select"`. This proves the global Escape branch was reachable and it was the guard that held it back. Render `<ShortcutOverlay />` with the harness. Dispatch the `?` and both Escapes through `act()`/`fireEvent.keyDown(window, …)` (F1 dispatch rule), because the guard reads the DOM the previous key produced. Red today: the first Escape also deselects.

**Risk:**
- Every modal that currently exists sets `aria-modal="true"` and renders `null` when closed. The critic opened all 18 sites; PowerCurveEditor unmounts at :319, and Onboarding is conditionally mounted.
- A future modal that forgets the attribute is not covered. A non-modal that adds it would kill every shortcut. The dev warning surfaces only the hidden-but-mounted case; a visible stray `aria-modal` element is visible on screen, so it can be seen without the warning.
- **Named behavior changes, to be repeated in the ROADMAP shipped entry:**
  - Escape with the `?` sheet open (and the palette, only when its input is not focused) now only closes that surface. Today it also deselects and switches to the Select tool. The palette normally holds focus in its input, where the global handler already bails, so for the palette this is not a user-visible change.
  - While the first-launch onboarding overlay or the recovery prompt is up, every global shortcut is inert. On a first launch that is by design: shortcuts start working once the welcome guide is dismissed.
- Tests that render a dialog and then expect a shortcut to fire must unmount the dialog first. Testing-library auto-cleanup (`globals: true`) handles cross-test leakage.
- The Viewport Space-to-pan listener (Viewport.tsx:648-668) is separate and only changes the cursor. Out of scope.

### F8. Image and PDF-vector imports record one undo step (lib-3/core-4)

**Diagnosis (re-verified):** Raw `addObject` with no `withUndo` happens at:
- `src/lib/fileOps/imageImport.ts:107` (File > Import Image / Open image, Tauri path)
- `src/components/panels/ImageImportDialog.tsx:89` (drag-dropped images, and PDF-as-raster)
- `src/app/App.tsx:367-374` (PDF `onImportVector`)

`addObject` pushes no undo entry. The siblings wrap: `svg-import` (SvgImportDialog.tsx:520), `dxf-import` (dxfImport.ts:414), `trace` (ImageTraceDialog.tsx:575), `qr-code` (QrCodeDialog.tsx:60). The effect: Ctrl+Z after an image import undoes the *previous* action, and restoring that action's before-snapshot silently deletes the image. Redo's after-snapshot lacks it too, so the image is gone from history.

**Fix:**
- imageImport.ts: wrap `addObject` + `setSelectedIds` in `store.withUndo("image-import", …)`.
- ImageImportDialog.tsx: the same, in `handleImport`.
- App.tsx: extract the `onImportVector` body into `export function importPdfVectors(objects: DesignObject[])` beside `openPdfImport`. It does `closeDialog`/`setDialogData`, then `withUndo("pdf-import", () => objects.forEach(addObject))`. The prop becomes `onImportVector={importPdfVectors}`. Selection behavior is unchanged: no selection today, none after.

`pushObjectsUndo` already strips and restores `imageData` (`index.ts:62-116`), so image undo/redo round-trips. `withUndo` snapshots `objects` and the selection only: not layers, `activeLayerIndex`, dialog data or the pending-image payload. That is enough here, because these three imports change only `objects` and selection. There are no double entries: the auto-trace that ImageImportDialog opens afterwards is a separate user action with its own `withUndo("trace")`. `isDirty` and auto-save do not read the undo stacks.

**Test:** New `src/lib/fileOps/__tests__/importUndo.test.tsx`. Its `beforeEach` resets objects, selection, undo/redo stacks and `openDialogs: new Set()` (see F1).
1. Render `<ImageImportDialog open imageData="data:image/png;base64,AAAA" fileName="a.png" imageWidth={100} imageHeight={100} onClose={vi.fn()} onImported={vi.fn()} />`, after first seeding one unrelated undoable action (a nudge via `withUndo`). Click the "Import" button (role button, exact name "Import"). Assert `undoStack.length` rose by 1. `undo()` removes the image and leaves the nudged object nudged. `redo()` restores the image with its original `imageData` string.
2. `importImageData(new Uint8Array([…]), "png")` with `globalThis.Image` stubbed by a class whose `src` setter calls `onload` with `width/height = 100`. Same three assertions.
3. `importPdfVectors([pathA, pathB])` gives one undo entry. Undo removes both.

Red today: the undo stack does not grow, and in case 1 undo also reverts the nudge.

**Risk:** lib-2 (drag-dropped PNG ignores DPI, bucket B4) will touch fileDrop.ts/imageImport.ts in a different relay. This change is one wrapper, so it merges trivially. `importImageData` captures `store` before `onload`. `withUndo` reads live state through `get()`, so the stale capture does not matter.

### F9. Layer strip speed goes through `clampSpeed` (ui-10)

**Diagnosis (re-verified):** `ActiveLayerStrip.tsx:120-124` passes `Number(e.target.value)` raw into `updateLayer` (`:34-36`). An emptied field writes `speed: 0`, and `min="1"` does not constrain typed input. LayerPanel's SpeedInput clamps to `[1, max]` (`SpeedInput.tsx:54-57`), choosing `rasterMaxSpeed` when `layer.mode` is `fill`/`fillLine` (LayerPanel.tsx:546) and `effectiveMaxSpeed` otherwise. `updateLayer` (`index.ts:301-308`) clamps power but not speed. Chesterton: the strip used SpeedInput until 39aa113 ("speed bare input", a width-driven design fix), which dropped the clamp as a side effect. The existing strip test's comment still assumes `clampSpeed`.

**Fix:** Two scalar selectors, `grblMaxFeedRateX` and `grblMaxFeedRateY` (never one object selector). Compute `max = active.mode === "fill" || active.mode === "fillLine" ? rasterMaxSpeed(mx, my) : effectiveMaxSpeed(mx, my)` outside the selectors, and `handleSpeedChange(clampSpeed(Number(e.target.value), max))`. Set `max={max}` on the input.

**Test:** Extend `src/components/panels/__tests__/activeLayerStrip.test.tsx` with the `updateLayer` spy:
- The field set to `""` calls updateLayer with `speed: 1`. `"0"` gives `speed: 1`.
- With `grblMaxFeedRateX: 6000, grblMaxFeedRateY: 5000`: `"999999"` on active layer 1 (Score, line) gives `speed: 5000`, and on active layer 0 (Engrave, fill) gives `speed: 6000`.
- Add `grblMaxFeedRateX: 0, grblMaxFeedRateY: 0` to the file's `seedLayers()` reset, so the 6000/5000 cases cannot leak into later tests. This follows the plan's reset rule.

Red today: 0 and 999999 pass through. The existing 1500 case stays green. While in that file, correct the existing comment "first layer (Cut — index 0)". Index 0 is Engrave (`types.ts:282-306`).

**Risk:** Same typing feel as LayerPanel's field: clearing the box shows 1 immediately, and the next digit appends to it ("1" then "600" gives "1600"). That is parity with LayerPanel, not a new behavior, and it is the same path as today (today a cleared box writes 0 and the next digit appends to that). Commit-on-blur for both speed fields is a real UX item and is routed to `## Deferrals`, not left as a footnote. PLAN batch 2.6 already refuses non-positive feed at generation, so this is the write-door half.

### F10. ui-11 formatTime variants — dropped

This is not a one-function swap. The only candidate for a single replacement is DitherPreviewDialog's private `formatTime` (DitherPreviewDialog.tsx:342-347). Swapping it for `constants.formatTime` (constants.ts:17-24) would import a defect: that helper uses `Math.ceil` on the seconds remainder, so 119.5 s renders "1m 60s" and 3599.2 s renders "59m 60s" (checked with node). JobPreview's `m:ss` (JobPreview.tsx:591-596) is a playback-clock format, deliberately different, and unifying it means a style argument and changed on-screen text. JobActionBar (the 4th variant) is frozen. The shared helper's rounding bug is a new finding and is routed in `## Deferrals`.

## Browser verification

Run `npm run dev`, open the Vite URL in Chrome, and drive it with Chrome DevTools MCP. Where a check needs store state, `evaluate_script` with `const { useStore } = await import("/src/app/store/index.ts")`. It is the same module instance the app uses.

**First launch:** a fresh Chrome profile shows the onboarding overlay. It is `aria-modal`, so after F7 every shortcut is inert until it is dismissed. That is by design. Dismiss the welcome guide before starting F1, or every keyboard check below will look broken.

- **F1:** Draw two rectangles, select both, Ctrl+G. Ctrl+C, Ctrl+V, Alt+V, Edit > Paste, Edit > Paste in Place. `evaluate_script`: flatten `objects` with children and confirm there are no duplicate ids. Visually, the pastes appear at +10 mm (Ctrl+V, menu Paste) and in place (Alt+V, Paste in Place). Drag one pasted group and confirm the original does not move.
- **F2:** Draw A, B, C with overlapping fill so the stacking is visible (or read the order via `evaluate_script`). Select A, press Delete, then Ctrl+Z. A comes back underneath B and C, the order reads A,B,C, and A is selected. Delete with nothing selected, then Ctrl+Z: the previous action is undone, not a blank step.
- **F3:** select an asymmetric path and press Ctrl+Shift+V. It mirrors top-to-bottom, no copy appears, and Ctrl+Z restores it. Check the Arrange menu, the palette row and the `?` sheet: all three show Ctrl+Shift+V for Flip Vertical, and Alt+V for Paste in Place. Plain Ctrl+V still pastes at +10 mm.
- **F4:** Help > Keyboard Shortcuts opens the sheet. Escape closes it. `?` toggles it. Ctrl+K opens the palette and Escape closes it.
- **F5:** Select one path, Ctrl+K, "Node Edit" + Enter: the path's nodes appear. Start a pen path (two clicks), then Ctrl+K "Select Tool": the half-drawn pen path is discarded, with no dangling preview. "Measure" and "Pan" appear in the palette.
- **F6:** S toggles snap (check the View menu state or drag behavior). Snap is a view setting, so Ctrl+Z does not undo it. ] and [ rotate the selected object by ±90°, and each rotation undoes with Ctrl+Z. The labels are present in the menu, palette and sheet.
- **F7:** Select an object, open Tools > Auto-Nest, click a dialog button, then press Delete, Ctrl+Z, arrow keys, 1 and G. The canvas is unchanged. Tab cycles within the dialog. Close it, press Delete, and the object deletes. Repeat once with Preferences and once with the `?` sheet open. With the sheet open and an object selected, Escape closes the sheet and the object stays selected (the named behavior change). A second Escape, with no modal open, deselects it.

Dev-warning check, in three parts:
1. The console shows **no** `[shortcuts]` line while an ordinary dialog is open and keys are suppressed.
2. Open Preferences, then run `document.querySelector('[aria-modal="true"]').style.display = "none"` in `evaluate_script` and press Delete. The console shows exactly one `[shortcuts] all shortcuts suppressed by a hidden aria-modal root` line.
3. A second keypress adds none.

Close Preferences afterwards (reload if needed).
- **F8:** Drag a PNG in. Chrome MCP cannot fake an OS drop, so `evaluate_script` builds a `DataTransfer` with a `File` from a small inline PNG and dispatches `dragover` + `drop` on the app root. Click Import. Ctrl+Z removes only the image, and Ctrl+Y brings it back rendered. The PDF vector path: `evaluate_script` calls `(await import("/src/app/App.tsx")).importPdfVectors([...two path objects...])`, then Ctrl+Z removes both.
- **F9:** In the right-hand strip, clear Speed: it shows 1, not 0. Type 999999: it shows 30000 (the fallback max, since nothing is connected). Switch the active layer between Engrave and Score with a stubbed `grblMaxFeedRateX/Y` via `evaluate_script` and confirm the two different caps.
- **Owner test required:** File > Import Image... and File > Open on an image use the Tauri file dialog and cannot run in the browser. Steps: in the desktop build, File > Import Image..., pick any PNG, press Ctrl+Z (the image disappears), then Ctrl+Y (it returns, same size and position). Log this under the ROADMAP `next` owner-test steps.

## Files

**In scope:**
- `src/lib/editCommands.ts` (new)
- `src/lib/shortcuts.ts`
- `src/components/topbar/MenuBar.tsx`
- `src/components/topbar/CommandPalette.tsx`
- `src/components/panels/ShortcutOverlay.tsx`
- `src/app/App.tsx` (`openKeyboardShortcuts`, `importPdfVectors`)
- `src/lib/tools/toolHandler.ts` (new `switchTool` export only)
- `src/lib/fileOps/imageImport.ts`
- `src/components/panels/ImageImportDialog.tsx`
- `src/components/panels/ActiveLayerStrip.tsx`
- `src/components/panels/ImageTraceDialog.tsx` (one comment only)
- `src/lib/constants.ts` (adds `PASTE_OFFSET_MM` only; `formatTime` untouched)
- Tests:
  - `src/lib/__tests__/editCommands.test.tsx` (new)
  - `src/lib/__tests__/shortcutsModal.test.tsx` (new)
  - `src/components/topbar/__tests__/commandSurfaces.test.tsx` (new)
  - `src/lib/fileOps/__tests__/importUndo.test.tsx` (new)
  - `src/lib/__tests__/shortcutsWriters.test.tsx` (migrate off `_testClipboardOp`)
  - `src/lib/__tests__/shortcutDispatchOrder.test.tsx` (add the Ctrl+Shift+V pin)
  - `src/components/panels/__tests__/activeLayerStrip.test.tsx` (extend)
- `ARCHITECTURE.md`: one line under `lib/` for `editCommands.ts`, added after rebasing onto the concurrent ARCHITECTURE refresh.
- ROADMAP via relay-design Stage 3.5:
  - the shipped entry, which must name F7's two behavior changes (Escape over the `?` sheet no longer also deselects; shortcuts inert behind onboarding and the recovery prompt). For the palette it should say "no change to deselect behaviour", not "no palette Escape change". Escape from the palette's focused input mid-pen-path used to cancel the pen through `handleViewportKeyDown` and now does not, because pen Enter/Escape are inert behind any modal (Key decisions). and Lee's 2026-09-22 Ctrl+Shift+V = Flip Vertical ruling;
  - the owner-test step above;
  - the seven Parking Lot lines in `## Deferrals`.

**Explicitly out of scope:**
- `src/components/viewport/Viewport.tsx`. Its context-menu Delete already uses `withUndo`, and the D-canvas relay owns this file.
- `src/components/toolbar/Toolbar.tsx`. It already calls `handleToolChange`.
- `src/app/store/index.ts` / `storeTypes.ts`. No new actions.
- The rest of ui-2's duplication: Select All, Convert to Path, z-order, zoom (see Deferrals).
- toolHandler's hand-rolled shape/text "add" commands (the second half of core-5; see Deferrals).
- `constants.formatTime`, JobPreview, DitherPreviewDialog (F10; see Deferrals).
- All remediation-frozen files. None is needed. MaterialTestDialog and GrblSettingsDialog are covered by F7 without being edited.

## Deferrals

Each line below is the exact entry the implementer appends to `ROADMAP.md -> ## Parking Lot — every deferral, one index` during the relay's ROADMAP stage (relay-design 3.5). Append them after the last existing bullet, verbatim; do not edit existing entries.

- **Node-tool keys fire from side-panel fields** — `handleViewportKeyDown` runs before the input/textarea guard in `useKeyboardShortcuts` (`src/lib/shortcuts.ts`), so with the Node tool active and a node selected, Backspace in a panel number field deletes the node; fix is moving the input guard above that call. Found 2026-09-22 (refresh-editing-shortcuts plan), not in that group's findings.
- **`formatTime` shows "1m 60s"** — `constants.formatTime` applies `Math.ceil` to the seconds remainder, so 119.5 s renders "1m 60s" and 3599.2 s "59m 60s"; shown in MachinePanel's time estimate and JobActionBar's completion message (JobActionBar is remediation-frozen). Found 2026-09-22 while scoping ui-11.
- **Alt+V (Paste in Place) on macOS — unverified** — Option+V yields `e.key === "√"` on macOS, so the `key === "v"` match may never fire there; `e.code === "KeyV"` would fix it. Needs a Mac to confirm before changing. Raised 2026-09-22 (refresh-editing-shortcuts plan).
- **Remaining triplicated commands (rest of ui-2)** — Select All, Convert to Path, z-order and zoom are still hand-written in MenuBar, CommandPalette and `shortcuts.ts` (and Viewport's context-menu Delete bypasses `editCommands.ts`, correctly but separately); fold them into `src/lib/editCommands.ts` when next touched. Deferred 2026-09-22, refresh-editing-shortcuts scope.
- **Shape/text creation uses hand-built undo (second half of core-5)** — `toolHandler.ts` shape and text creation push delta `add` commands via `pushCommand` while every other object mutation uses `withUndo`; harmless today (undo removes, redo re-appends a last-positioned object) but a second undo model. Deferred 2026-09-22, refresh-editing-shortcuts scope.
- **Three duration formatters (ui-11, dropped)** — `constants.formatTime`, JobPreview's `m:ss` playback clock and DitherPreviewDialog's private `formatTime` render the same estimate differently; not a one-function swap (the shared helper carries the "1m 60s" bug above, JobPreview's clock format is deliberate, JobActionBar's 4th variant is frozen). DitherPreviewDialog also redeclares `ZOOM_STEPS` and re-inlines `computeFitZoomIndex`. Dropped from refresh-editing-shortcuts 2026-09-22.
- **Speed fields commit on every keystroke** — clearing the Speed box in the layer strip or LayerPanel shows 1 at once and the next digits append ("1600" when "600" was meant); commit-on-blur for both speed fields is the UX fix. Parity was kept deliberately in refresh-editing-shortcuts F9, 2026-09-22.

## Done when

- [ ] Every new test was shown failing on the unmodified tree first, **on the assertion the plan names** (not on a render throw or a missing mock, which are harness problems to fix first). The failing assertion lines are quoted in the implementer report, then the tests pass.
- [ ] DOM-dependent keyboard tests (F4.2, F4.3, F5, the F3 palette-label check, F7.5) dispatch through `act()` or `fireEvent.keyDown(window, …)`. The raw `key()` helper appears only in store-only assertions.
- [ ] New-file `beforeEach` resets include `snapToGrid: false`.
- [ ] shortcuts.ts imports `switchTool`, not `handleToolChange` (tsc `noUnusedLocals`).
- [ ] `npm test` green: baseline 823 JS (measured at cdb75aa) + the new tests, 0 unexpected failures. `cargo test` 310 green (measured at 0a0e689 with `~/.cargo/bin/cargo`, which is not on the default PATH; no Rust changes expected).
- [ ] Every new test file's `beforeEach` resets `openDialogs: new Set()` along with objects, selection, undo/redo and clipboard.
- [ ] `npx tsc --noEmit` clean. TS strict, zero `@ts-ignore`/`@ts-expect-error` added.
- [ ] `npm run lint`: no new warnings against the baseline count.
- [ ] `npm run format:check` and `cargo fmt --check` clean (the pre-commit hook enforces this).
- [ ] Every `useStore` call added or touched returns a scalar, a boolean or a stable reference (Error-185 rule). Specifically the `openDialogs.has(...)` selectors and the strip's two feed-rate selectors.
- [ ] `grep -n "clipboardOp\|obj_\${Date.now()}" src` returns nothing. `grep -n "pushCommand" src/lib/shortcuts.ts` returns nothing.
- [ ] Browser verification above done for F1-F9, with screenshots in the relay log. The Tauri-only import step is logged in ROADMAP `next` as an owner test.
- [ ] Ctrl+Shift+V is hard-bound to Flip Vertical (no switch, no `CTRL_SHIFT_V`). The proposed DECISIONS.md entry from F3 is in the relay log for the orchestrator.
- [ ] All seven `## Deferrals` lines appended to the ROADMAP Parking Lot.
- [ ] F7's dev-only warning verified in the browser:
  - an ordinary open dialog logs nothing;
  - a hidden-but-mounted `aria-modal` root logs exactly one `[shortcuts] all shortcuts suppressed by a hidden aria-modal root` line;
  - further keys log nothing more.
