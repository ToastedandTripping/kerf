# R3 editing-shortcuts: citation audit against HEAD

Plan: `.claude/plans/refresh-editing-shortcuts.md` (F1-F10; F10 is a drop, no code).
Critic commit: 6e3378b. Audited at: d2dfd24 (marvin/kerf-gap). Read-only; no tests run.
The plan text itself changed only cosmetically since 6e3378b (a typo, the act() note, the F7 spy/Tab wording, the F9 reset line, the ROADMAP palette wording).

## Summary counts

| Class | Count |
|---|---|
| HOLDS | 41 |
| MOVED (drift since 6e3378b) | 24 |
| MOVED (already off at 6e3378b; the file has not changed since) | 4 |
| CHANGED | 5 (4 claim/premise items + 1 Done-when gate defect) |
| GONE | 0 |
| Fix premises that no longer reproduce | 0 of F1-F9 (F10 drop rationale also still holds) |
| Mutation-battery anchors in the plan | 0 (none written; find anchors counted instead, see below) |

Files cited by the plan that changed since 6e3378b: store/index.ts (+34 lines inserted at :41, reorderLayers -5 net at ~:306), storeTypes.ts (+1 at :282), App.tsx (+3), Viewport.tsx (-126 net), toolHandler.ts (+29), geometry/index.ts (+100, none inside movePartial), constants.ts (+12 at the top), imageImport.ts (+6 at the top), SvgImportDialog.tsx (+2), store/geometryActions.ts (+38), ARCHITECTURE.md. shortcuts.ts, MenuBar.tsx, CommandPalette.tsx, ShortcutOverlay.tsx, ImageImportDialog.tsx, ActiveLayerStrip.tsx, SpeedInput.tsx, LayerPanel.tsx, useFocusTrap.ts, Toolbar.tsx and every cited test file are byte-identical to 6e3378b.

## CHANGED / GONE

| # | Plan cite / claim | Old | HEAD | Does the fix or diagnosis still apply? |
|---|---|---|---|---|
| C1 | F5 Risk: "toolHandler.ts is 1,944 lines" | 1,944 lines | 1,973 lines | Yes. `handleToolChange` and `handleViewportKeyDown` are byte-identical (old 1862-1944 = HEAD 1891-1973). `switchTool` is still a new export that touches no existing function. |
| C2 | F8 Risk: "lib-2 (drag-dropped PNG ignores DPI) will touch fileDrop.ts/imageImport.ts in a different relay" | future | Already landed: e65b10d "dropped PNG uses its embedded DPI". It added `detectImageDpi()` at imageImport.ts:7-9, a `detectedDpi` prop on ImageImportDialog (:18, :31, :56), and threaded `detectedDpi` through App.tsx `openImageImport` (:124-137, :332) | Yes. The raw `addObject` sites are untouched (imageImport.ts:113, ImageImportDialog.tsx:89). The merge-risk note is obsolete: there is nothing left to merge against. |
| C3 | Concurrent edits: "Still pending: the ARCHITECTURE.md refresh. Rebase onto it before adding F1's one line." | pending | ARCHITECTURE.md is +182/-35 since 6e3378b, across 20+ delta commits. The `lib/` Directory Structure entry for `shortcuts.ts` is at ARCHITECTURE.md:148 | Yes. The rebase precondition is moot on HEAD. Add the `editCommands.ts` line next to :148. |
| C4 | Done-when: "baseline 823 JS (measured at cdb75aa)"; "`cargo test` 310 green (measured at 0a0e689)" | 823 / 310 | Stale. Many tests have landed since then: store.test.ts +163, connection.test.ts +755, jobStream.test.ts +485, viewportInit.test.tsx +507, gcode.rs +2579, and others | Re-measure both baselines at HEAD before the relay starts. As written, the numbers would read as regressions or false greens. |
| C5 (pre-existing gate defect, not drift) | Done-when: `grep -n "clipboardOp\|obj_\${Date.now()}" src` "returns nothing" | same at 6e3378b | Also matches `src/app/store/storeTypes.ts:298`, which is `generateId` itself: `` return `obj_${Date.now()}_${++idCounter}`; `` (checked by running the grep under bash) | The gate can never pass, so it is falsely red forever. Scope it to the private scheme instead, e.g. `grep -rn "clipboardOp\|Math.random().toString(36)" src/components/topbar`, or exclude storeTypes.ts. |

GONE: none. Every cited function, handler, label, comment and test still exists.

## MOVED

Drift since 6e3378b. Content is the same; only the line numbers changed.

| Plan cite | HEAD lines | Content |
|---|---|---|
| store/index.ts:124-137 (`applyPartialsDeep`) | 158-171 | same (any id at any depth) |
| store/index.ts:731-745 (`duplicateInPlace`) | 760-774 | same (deepCloneObject, " copy") |
| store/index.ts:174-184 (`addObject` appends) | 208-217 | same |
| store/index.ts:142-144 (F15 "reordering changes the cut") | 176-178 | same |
| store/index.ts:411-427 (`withUndo`) | 440-458 | same (identity check `beforeObjects !== afterObjects`) |
| store/index.ts:856-868 (`openDialog`/`closeDialog`) | 885-897 | same |
| store/index.ts:374 (`setSnapToGrid` plain set), cited in F6 twice | 403 | same |
| store/index.ts:62-116 (`pushObjectsUndo` strips/restores imageData) | 95-151 (strip/restore at 105-125) | same |
| store/index.ts:301-308 (`updateLayer` clamps power, not speed) | 335-342 | same (`clampLayerPower` only) |
| storeTypes.ts:300-311 (`deepCloneObject`) | 301-313 | same |
| App.tsx:303 (`<CommandPalette />`) | 306 | same |
| App.tsx:383 (`<ShortcutOverlay />`) | 387 | same |
| App.tsx:367-374 (`onImportVector` raw addObject) | 371-378 | same |
| Viewport.tsx:1549-1553 (context-menu Delete via withUndo) | 1424-1427 | same |
| Viewport.tsx:1016 (`<textarea>`) | 1009 | same |
| Viewport.tsx:648-668 (Space-to-pan listener) | 640-661 | same (cursor only) |
| toolHandler.ts:1307-1314 (shape `pushCommand` add) | 1313-1320 | same |
| toolHandler.ts:1797-1803 (text `pushCommand` add) | 1826-1832 | same |
| toolHandler.ts:1862-1887 (`handleToolChange`) | 1891-1916 | byte-identical |
| geometryActions.ts:724-738 (`rotate90`, withUndo, mod-360) | store/geometryActions.ts:762-777 | same (`[` from 0 gives 270) |
| fileOps/imageImport.ts:107 (raw `addObject`) | 113 | same |
| SvgImportDialog.tsx:520 (`withUndo("svg-import")`) | 522 | same |
| constants.ts:17-24 (`formatTime`, Math.ceil) | 29-36 | same; the "1m 60s" bug is still present |
| ARCHITECTURE.md:172 (dialog state in `openDialogs`) | 380 | same text. It was already wrong at 6e3378b, where it sat at :279 |

Already imprecise at 6e3378b. These files are unchanged since, so this is not drift:

| Plan cite | Actual | Note |
|---|---|---|
| shortcuts.ts:281 (nudge still uses movePartial) | 279 | :281 is a closing brace |
| ImageTraceDialog.tsx:151 ("Ungroup (Ctrl+Shift+G)") | 152 | :151 is the line before it |
| shortcutsWriters.test.tsx:58-70 (beforeEach reset) | 54-67 | |
| CommandPalette.tsx:425-427 (setQuery/setSelectedIndex resets) | 427-428 (handler 424-429) | 425 is preventDefault, 426 setOpen |

## HOLDS

- shortcuts.ts: :4 (import), :23-36 (handleKeyDown and input guard), :96 and :96-111 (Ctrl+V, no shift guard, root-only re-ID), :115-127 (Alt+V, no movePartial), :135 (Ctrl+U), :184-185 (stale comment), :242-259 (hand-built delete undo), :287-296 (Escape), :308-315 (tool branch; cited twice), :318/:325 (zoom block).
- MenuBar.tsx: :204-211 (Toggle Snap "S"), :292-296 (Flip Vertical "Ctrl+Shift+V"), :413-417 (dispatchEvent "?" on document), :448-473 (`clipboardOp`), :466 (private id scheme).
- CommandPalette.tsx: :156-204 (7 tool rows, `setActiveTool` only), :305-310 (arr-flip-v, no shortcut), :416 (`useState` open), :438-443 (focus effect; cited twice).
- ShortcutOverlay.tsx: :56 ("] / ["), :79 (`useState`), :81-95 (window listener).
- store/index.ts:21-22 (re-exports only AppState and generateId; still true, the other exports are cursor/dirty helpers and `useStore`). storeTypes.ts:269-271 (`openDialogs`). App.tsx:37 (`generateId` from storeTypes).
- geometry/index.ts:284-297 (`movePartial`): the function starts at 284 and ends at 299, byte-identical to 6e3378b. Groups are still not points-bearing (:188-190), so a group gets only a transform.
- Toolbar.tsx:41-45; useFocusTrap.ts:53-76 (Tab only); PowerCurveEditor.tsx:319 (`if (!open) return null`).
- ImageImportDialog.tsx:89; dxfImport.ts:414; ImageTraceDialog.tsx:575; QrCodeDialog.tsx:60.
- ActiveLayerStrip.tsx:34-36 and :120-124; SpeedInput.tsx:54-57; LayerPanel.tsx:546 (cited twice); types.ts:282-306 (index 0 Engrave/fill, 1 Score/line).
- DitherPreviewDialog.tsx:342-347; JobPreview.tsx:591-596 (the path is `src/components/bottom/JobPreview.tsx`; the plan gives no directory).
- "18 modal surfaces carry aria-modal": 18 `aria-modal="true"` sites across 17 non-test .tsx files at HEAD.
- "These new files are the first to render MenuBar, CommandPalette, ShortcutOverlay, NestingDialog and ImageImportDialog under jsdom": still true. No test file renders any of them, and `src/components/topbar/__tests__/` does not exist.
- "No `]`/`[` handler in src": still none. "Nothing iterates openDialogs": still none (no forEach, size, spread or Array.from).

## Per-fix premise verdicts

- **F1: holds.** Both paste branches still re-ID only the root. Alt+V still skips movePartial, so its copy shares `points`. MenuBar still mints `obj_${Date.now()}_${random}`. `updateObject` still goes through `applyPartialsDeep` (index.ts:224), so a shared child id writes into every copy. `deepCloneObject` is unchanged. Side note: the new `composedLeaves` (geometry/index.ts) keys canvas leaves by full path (`outer/inner/leaf`), so duplicate child ids no longer collide at render. The write aliasing F1 fixes is untouched by that.
- **F2: holds.** Keyboard Delete still calls `removeObjects` then `pushCommand` with an `addObject` undo. `addObject` still appends. `removeObjects([])` still returns a new array (index.ts:281-293), so `withUndo` still records an empty step. MenuBar Delete (:181-188) and palette Delete (:126-135) still call `withUndo` with no empty guard.
- **F3: holds.** There is no `!shift` on Ctrl+V and no Ctrl+Shift+V branch. `flipObjects` vertical still maps `y → 2*cy - y` for a single path (geometryActions.ts:455-480).
- **F4: holds.** The fake `?` is still dispatched on `document`. Both surfaces still keep their open state in local `useState`.
- **F5: holds.** The palette still calls `setActiveTool` only and has no Measure or Pan row. `handleToolChange` is unchanged.
- **F6: holds.** There is still no S, `]` or `[` handler. The labels, `rotate90` and `setSnapToGrid` are unchanged apart from line moves. The ImageTraceDialog comment still says Ctrl+Shift+G.
- **F7: holds.** `handleKeyDown` still runs `handleViewportKeyDown` first and then only the input guard. No new global keydown listener was added: Viewport's only listener is Space-to-pan, and the rest are the per-dialog ones.
- **F8: holds.** All three raw `addObject` sites are still unwrapped. The siblings still wrap. See C2 for the obsolete merge-risk note.
- **F9: holds.** The strip still passes `Number(e.target.value)` raw. `clampSpeed`, `effectiveMaxSpeed` and `rasterMaxSpeed` are in `src/lib/speedScale.ts:57-78`, unchanged, with the fallback max still `SPEED_FALLBACK_MAX` (the existing test comment says 30000). `grblMaxFeedRateX/Y` are still store fields (storeTypes.ts:118-119).
- **F10 (drop): holds.** `constants.formatTime` still uses `Math.ceil` on the remainder.

## Anchors

The plan contains no mutation-battery anchors: "mutation", "anchor" and "battery" do not appear in the plan or in `refresh-editing-shortcuts-critic.md`. Its find/replace targets were counted instead, with `grep -cF` at HEAD.

**Count = 1 (existing find targets):**
- shortcuts.ts: `if (ctrl && key === "v") {`, `if (alt && key === "v") {`, `// Note: Ctrl+Shift+V conflicts with "paste in place" in some apps`, `import { handleViewportKeyDown, handleToolChange } from "./tools/toolHandler";`, `import { useStore, generateId } from "../app/store";`, `if (handleViewportKeyDown(e)) return;`, `if (ctrl && shift && key === "h") {`, `if (key === "delete" || key === "backspace") {`, `s.pushCommand({`, `if (!ctrl && !shift && !alt && toolShortcuts[key]) {`, `if (key === "escape") {`
- MenuBar.tsx: `document.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }))`, `export { clipboardOp as _testClipboardOp };`, `function clipboardOp(`, `import { movePartial } from "../../lib/geometry";`, `obj_${Date.now()}`, `shortcut: "Ctrl+Shift+V",`, `shortcut: "Alt+V"`, `shortcut: "S",`, the two `{ label: "Rotate 90 CW/CCW", ... }` rows, `label: "Keyboard Shortcuts",`
- CommandPalette.tsx: `id: "arr-flip-v",`, `id: "view-snap",`, `id: "arr-rot90cw",`, `id: "arr-rot90ccw",`, `const [open, setOpen] = useState(false);`
- ShortcutOverlay.tsx: `const [visible, setVisible] = useState(false);`, `{ keys: "] / [", action: "Rotate 90 CW/CCW" },`
- ImageTraceDialog.tsx: `Ungroup (Ctrl+Shift+G)`. imageImport.ts: `store.addObject(obj);`. ImageImportDialog.tsx: `store.addObject(obj);`, `function handleImport() {`. App.tsx: `onImportVector={(objects) => {`
- ActiveLayerStrip.tsx: `onChange={(e) => handleSpeedChange(Number(e.target.value))}`, `function handleSpeedChange(v: number) {`
- toolHandler.ts: `export function handleToolChange(`. storeTypes.ts: `export function deepCloneObject(`
- activeLayerStrip.test.tsx: `first layer (Cut — index 0)`, `function seedLayers()`. shortcutsWriters.test.tsx: `describe("MenuBar clipboardOp paste`

**Count ≠ 1, existing code. Each is expected; flagged only because it is not 1:**
- shortcuts.ts `handleToolChange(` = **2**: the Escape branch (:294) and the tool branch (:314). F5 replaces both.
- shortcuts.ts `movePartial(` = **2**: Ctrl+V (:106) and the nudge (:279). F1 removes the first and keeps the second.
- CommandPalette.tsx `s().setActiveTool(` = **7**: all seven tool rows. F5 swaps each for `switchTool`.
- shortcutsWriters.test.tsx `_testClipboardOp` = **4**: the import plus three calls, all migrated in F1.

**Count = 0, new code the plan introduces (expected):**
- shortcuts.ts `flipSelection(`, `warnedModals`
- CommandPalette.tsx `id: "tool-measure"`, `id: "tool-pan"`
- ShortcutOverlay.tsx `{ keys: "Ctrl+Shift+V", action: "Flip vertical" }`
- App.tsx `export function importPdfVectors`, `export function openKeyboardShortcuts`
- constants.ts `PASTE_OFFSET_MM`
- toolHandler.ts `export function switchTool`
- shortcutDispatchOrder.test.tsx `Ctrl+Shift+V` (the new pin)
- New files, all absent: `src/lib/editCommands.ts`, `src/lib/__tests__/editCommands.test.tsx`, `src/lib/__tests__/shortcutsModal.test.tsx`, `src/components/topbar/__tests__/commandSurfaces.test.tsx`, `src/lib/fileOps/__tests__/importUndo.test.tsx`

No unexpected 0, and no unexpected count above 1.
