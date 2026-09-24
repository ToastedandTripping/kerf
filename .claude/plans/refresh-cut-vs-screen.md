# Refresh — Cut vs Screen

## Intent (grilled)

**Summary:** What you see on the canvas is what the laser cuts. Traced art and grouped imports stop hiding letters and parts with holes: today a traced "BOB" shows only part of the word but cuts all of it. Parts the cut will skip, because they are hidden or sit on a hidden layer, also disappear from the canvas. Round arcs in an imported SVG come in as smooth circles, not octagons, whatever units the SVG was saved in. A PNG you drag in lands at the same physical size as the same PNG opened from the menu. A mirrored image or text exports to SVG mirrored. Mirrored or rotated text is cut the way it looks, not un-mirrored with each letter spun in place. After you reorder layers, grouped parts keep the layer they were on rather than silently picking up another layer's power and speed. Ctrl+Z after a reorder undoes the reorder itself, instead of moving every object onto whichever layer now has its old number.

**Skip note:** Intent derived from the 2026-09-22 code-refresh findings (core-1, lib-1, lib-2, lib-10) and Lee's selection of this bug group the same day; no grill session. F5, F6 and F7 are additions that are not in the findings files. I found F5 while re-checking lib-10, F6 while closing the critic's leaf-visibility item, and F7 from the round-2 critic's probe; the coordinator ruled it in scope. **F6 and F7 are severable as a pair.** F7 reuses F6's helper, and F7 alone can be dropped. **F5 is severable only together with F4's text arm:** if F5 is dropped, the `obj.type === "text"` arm of F4's `elementTransform` goes with it. Otherwise the export would mirror text that the cut does not. See the Dependency Graph.

**Key decisions:**
- **lib-1: pass an effective tolerance into the arc tessellator. Do not emit arcs as cubic handles.** The defect is a units mismatch, so the smallest correct fix is to put the tolerance into the units the parser works in. Arcs stay polylines, so everything downstream keeps the input it has today:
  - *Import/golden tests:* the F25 tests (`svgImport.test.ts:227-242`) pin polyline output ("more segments than fixed 8"). A default parameter keeps them valid unchanged. Emitting cubics would mean re-specifying them.
  - *SVG export* writes `L` for plain points and `C` for handle pairs (`svgExport.ts:60-86`), so it handles either form. Polylines round-trip exactly as they do today.
  - *The G-code sampler* (`sampleBezierPath`, geometry/index.ts:624) passes polylines through and samples cubics in mm, so either form would cut fine.
  - *The deciding factor is the bounding box.* `pointsBBox` is anchors-only by design (geometry/index.ts:192-196). Every transform width/height, selection box, rotation centre, snap and align reads it. A cubic arc with an anchor every 90° under-reports the extent of any arc that is not axis-aligned, by up to r(1−cos45°) ≈ 29% of r. That would open a new gap between the box the operator sees and what gets cut, which is the class this group exists to close. A polyline's anchor bbox is exact to within the tolerance.
  - *Cost of being wrong:* an imported arc that the operator later scales up inside Kerf facets in proportion. DXF arcs and every other tessellated curve already behave this way. If it bites, cubic arcs become the right move once `pointsBBox` learns curve extrema.
- **lib-1, same class: use the larger ellipse radius for the segment count, not the smaller.** `approximateArc` uses `Math.min(rx, ry)` and calls that "conservative" (svgImport.ts:507-508). It is the opposite. The chord deviation of an ellipse at parameter step Δt is bounded by max(rx,ry)·(1−cos(Δt/2)). An rx=50 / ry=5 mm ellipse imports today as 25 points with a measured worst deviation of 0.261 mm, about 5× the tolerance (point-to-polyline distance; the critic's probe, 2026-09-22). It was introduced with F25 (8e5a747, 2026-06-14) with no reasoning beyond that word.
- **lib-1: the effective tolerance divides by the element matrix's largest stretch (its max singular value) times the SVG's global scale.** It does not use `getMatrixScale`'s column norms. A skewed matrix stretches more than either column (the finding assumed uniform scale). The exact 2×2 formula is five lines.
- **core-1: one pure recursive helper in `lib/geometry` that mirrors gcodeGen's `flattenObjects` recursion exactly, keyed by the full id path.** gcodeGen.ts is remediation-frozen, so it keeps its own recursion. A parity test pins the two together instead. Depth-1 keys stay `groupId/childId` (unchanged), so existing cache entries and the P3 dirty-skip path behave identically for today's depth-1 groups. **Selection, hit-testing and bounds are not changed.** They are top-level-only by design: a depth-2 child is selected through its top-level group exactly as a depth-1 child is (details in F1).
- **core-1: visibility is decided per leaf, using the cut's own rule, not per top-level object.**
  - The cut skips a leaf when `!leaf.visible`, or when the leaf's own layer (looked up by `l.index`, falling back to `layers[0]`) is hidden or has output off (gcodeGen.ts:276-279; images the same at 624-632).
  - The render adopts the `visible` and layer-`visible` half exactly. It does **not** adopt `output === false`. Output off means "won't cut" (the LayerPanel.tsx:325-326 tooltip), and those objects stay on the canvas today on purpose, as reference geometry.
  - The cut never reads a group's own `visible` or layer, so the render stops reading them too. No UI sets a group's `visible` (grep: LayerPanel's `visible` toggle is layers only), so this is latent. It is indexed in Deferrals.
- **F6 (layer reorder) is added because leaf-level visibility is only honest if the leaf's layer is right.** `reorderLayers` remaps top-level `layerIndex` only, so group children keep a stale index after any reorder. Probed: a group on Engrave, reorder Engrave↔Score, and the group reads 1 while its children still read 0, now Score. The cut uses the leaf's index, so those children are cut with Score's power and speed.
- **F7 (undo across a reorder): the reorder becomes its own undo command that applies a layer-index permutation to live state. It does not restore a layers+objects snapshot.** Layer edits are not undoable, so a snapshot would revert power and speed edits made after the reorder. It would also drop non-undoable imports. A permutation commutes with both, and LIFO order means earlier object snapshots always meet the numbering they were taken under.
- **lib-2: thread the detected DPI through the existing drop → dialog path using one shared detector.** The drop path is not rerouted through `importImageData`, because the dialog carries the layer picker and auto-trace, which the menu path lacks. The full Open/drop unification is triage bucket B4 (lib-14), a separate refactor. This fix is the physical-size defect only.
- **lib-10: export flip for image and text only, where both the screen and the cut honour it.** The cut honours a text flip only after F5, **so F4's text arm depends on F5**. F5 lands before F4. If F5 is dropped, F4 ships the image arm only. The finding also proposed negating the angle for rotated rectangles and ellipses. That part is dropped on purpose. A flip on a rectangle, ellipse or group is inert on the canvas (`renderObject` never reads scale; `composeGroupChild` does not composite it, geometry/index.ts:63) and inert in the cut (`CutObject` has no scale field, gcode_gen.rs:107-130). Exporting it would make the file disagree with both. The inertness is its own defect and is indexed under Deferrals.
- **Transform order for a flipped *and* rotated object is flip-then-rotate, both about the box centre (R·F).** This is what the Rust image engine does (pixel-buffer flip, then rotation: image_gcode_gen.rs:120-140) and what the Viewport intends (local scale, then rotation about the box centre). F4 and F5 both use it.

## Context

These seven defects share one symptom: the canvas, the cut and the exported file each compute geometry on their own, and the copies disagree. The codebase already has the right tool for this, `composeGroupChild` ("the ONE function shared with the Viewport renderer, so the cut can never disagree with the screen", gcodeGen.ts:196-202). Its single-level use in the Viewport (core-1), the Viewport's top-level-only visibility check (core-1), its non-use for text (F5) and the top-level-only layer remap on reorder (F6) and the non-undoable reorder under object-only undo snapshots (F7) are all gaps in that contract. lib-1 and lib-2 are unit/metadata mistakes that change the physical size or shape of what gets cut compared with what was drawn or saved.

Overlaps:
- **Viewport.tsx** (F1) is also owned by the D-canvas relay (core-2, core-3 and others per TRIAGE). F1 edits only the render-loop descent and texture eviction (Viewport.tsx:308-352). D-canvas edits `applyTextImageTransform`/`applyObjectRotation`/`renderTextObject`/`renderImageObject`. Those hunks are disjoint. Whichever lands second rebases.
- **fileOps/imageImport.ts, ImageImportDialog.tsx, App.tsx** are also touched by the editing-shortcuts plan's F8 (`withUndo` wrappers, `importPdfVectors`). F3 here adds one helper, changes line 63 of imageImport.ts, and touches `openImageImport` plus one JSX prop in App.tsx. Those are disjoint hunks.
- **SvgImportDialog.tsx** gets a concurrent `boundingBox → pointsBBox` edit from the refresh agent. F2 touches only the `case "path"` block (≈ lines 940-960). Triage B1 (lib-11) will later move the importer into lib/fileOps. F2's call-site change moves with it.
- **svgExport.ts** (F4): no other plan touches it.
- **store/index.ts** (F6): only `reorderLayers` is touched. No other plan in this refresh edits it.

## Dependency Graph

| Fix | Depends on | Files (source) | Severable? |
|---|---|---|---|
| F1 nested groups + per-leaf visibility | none | geometry/index.ts, Viewport.tsx | yes |
| F2 arc tolerance | none | svgImport.ts, geometry/index.ts, SvgImportDialog.tsx | yes |
| F3 dropped-PNG DPI | none | imageImport.ts, fileDrop.ts, App.tsx, storeTypes.ts | yes |
| F5 text flip/rotation baked | none | geometryActions.ts | only together with F4's text arm |
| F4 SVG export flips | **F5** (text arm only) | svgExport.ts | yes; the image arm stands alone |
| F6 layer reorder remaps children | none (makes F1's per-leaf check read a correct index) | store/index.ts | yes, but F7 goes with it |
| F7 layer reorder is undoable | **F6** (`remapLayerIndexDeep`) | store/index.ts | yes |

**Batch order:** F5 → F4, and F6 → F7. F1, F2 and F3 are independent and can land in any order. Suggested order: F1, F2, F3, F5, F4, F6, F7. There is one commit per fix, each touching at most four source files. F1 and F2 both add exports to `geometry/index.ts` in disjoint places, and F6 and F7 edit the same `reorderLayers` in sequence. Whichever lands second rebases trivially.

File-count waiver: 12 source files across viewport, geometry, fileOps and store in one relay. This is accepted because the seven commits are small and independent apart from the two declared pairs (F5→F4, F6→F7).

## Fixes

### F1. Nested groups render; the canvas composes groups to any depth, exactly as the cut does (core-1)

**Diagnosis (re-verified):**
- The render loop descends exactly one level. It runs `for (const child of obj.children) ensureDisplayObject(renderKey(child, obj.id), composeGroupChild(child, obj))` (Viewport.tsx:308-325). A child that is itself a group reaches `ensureDisplayObject` and then `renderObject` (Viewport.tsx:1260). That switch has cases only for `rectangle`/`ellipse`/`line`/`path` (1277-1310) and no `group`, so it draws an empty Graphics.
- The cut recurses. `flattenObjects` calls itself on each composed child (gcodeGen.ts:203-219).
- Texture eviction is also single-level (Viewport.tsx:337-352). A depth-2 image's texture is destroyed every render and recreated on the next.
- Depth-2 groups are routine now:
  - ImageTraceDialog groups every multi-contour shape (ImageTraceDialog.tsx:139-144) and then wraps all traced output in one outer group (146-151; fa04b5b, 2026-06-17). Any traced letter or part with a hole is depth 2.
  - Ctrl+G over a text-to-path glyph group (`textObjectToPaths` groups multi-contour glyphs, geometryActions.ts:255-259) or over a compound-path SVG import (SvgImportDialog.tsx:971) does the same.
- Chesterton: the in-code note "Do not add viewport recursion in this phase" (Viewport.tsx:317-319) came from d2d5b79/4a2a189 (2026-06-11). Its reason was that "the legacy population is near-nil". fa04b5b made that false six days later.
- Browser-confirmed by the refresh (scratchpad shot3.png): the depth-2 washer was absent and the depth-1 square rendered.

Selection, bounds and hit-testing for depth-2 children today, checked:
- `hitTest` iterates top-level `store.objects` only and tests each one's own transform AABB (src/lib/tools/toolHandler.ts:280-341). Children at any depth are selected through their top-level group. This is intended: toolHandler.ts:680-684 says groups select as a unit.
- The group's box includes nested content. `buildGroupObject` sizes a group from its children's transforms (geometry/index.ts:484-493), and a nested group's transform already spans its own children. So the selection box already covers depth-2 geometry.
- Drag re-render already reaches grandchildren. `markDescendantsDirty` is recursive (store/index.ts:31-38), so the P3 dirty-skip (`dirty.has(obj.id)`, Viewport.tsx:253) sees grandchild ids as dirty during a drag.
- None of these needs a change.

**Fix:**
1. In `src/lib/geometry/index.ts`, beside `composeGroupChild`, add:
   ```ts
   /** Every leaf of obj's group tree composed to world frame, with its render key
    *  (full id path: "outer/inner/leaf"; a top-level leaf's key is its id). The
    *  same recursion and the same composeGroupChild as gcodeGen's flattenObjects,
    *  so screen and cut agree at every depth. PURE. */
   export function composedLeaves(
     obj: DesignObject,
     key: string = obj.id
   ): Array<{ key: string; obj: DesignObject }>
   ```
   It works like this: if `obj.type === "group" && obj.children`, it returns `obj.children.flatMap(c => composedLeaves(composeGroupChild(c, obj), `${key}/${c.id}`))`. Otherwise it returns `[{ key, obj }]`. `composeGroupChild` keeps the child's id, so the key uses `c.id`.
2. In `src/lib/geometry/index.ts`, also add the render selection as one function, so the Viewport cannot drift from it:
   ```ts
   /** The leaves the canvas draws for one top-level object: composedLeaves,
    *  filtered by the cut's own per-leaf rule (gcodeGen.ts:276-279): skip
    *  !leaf.visible, and skip a leaf whose layer (by l.index, falling back to
    *  layers[0]) is hidden. Deliberately NOT the cut's `output === false` —
    *  output-off objects stay on the canvas as reference geometry. A leaf whose
    *  layer cannot be resolved at all (layers is empty) is DRAWN: the cut throws
    *  there, so there is no rule to match, and a throw inside the render effect
    *  is a blank canvas. PURE; never throws. */
   export function drawnLeaves(obj: DesignObject, layers: ReadonlyArray<Layer>): Array<{ key: string; obj: DesignObject }>
   ```
   The layer check is written as `const ll = layers.find(l => l.index === leaf.layerIndex) ?? layers[0]; if (ll && !ll.visible) continue;`. The `ll &&` guard is load-bearing. `parseAndValidateProject` accepts `layers: []` (it checks `Array.isArray` only, fileOps/index.ts:38), and `loadProject` stores it as-is. Without the guard, `layers[0].visible` throws on that file. Today's loop already guards it (`objLayer && !objLayer.visible`, Viewport.tsx:310-311).
   Import `Layer` as a type from `../../app/types`. `lib/geometry` already imports `DesignObject` from there.
3. Viewport render loop (Viewport.tsx:308-325). Replace the whole body, including today's top-level `visible` check and the `layers[obj.layerIndex]` check, with `for (const leaf of drawnLeaves(obj, layers)) ensureDisplayObject(leaf.key, leaf.obj);`.
   - What changes: the checks move from the top-level object to each leaf. The layer lookup changes from array position to `l.index` with the `layers[0]` fallback. `reorderLayers` keeps index equal to position, so that part only matters for an unknown index, which the cut assigns to `layers[0]` and the render today shows unconditionally.
   - A top-level non-group object behaves exactly as today.
   - Delete the "nested groups are not rendered … Do not add viewport recursion" note. Keep the W1b sentence about the shared composition. `renderKey` becomes unused: delete it.
4. Texture eviction (Viewport.tsx:337-346). Replace the one-level walk with a local recursive `collectImageIds(o, set)`: add `o.id` if `o.imageData`, recurse into `o.children`. Walk every object regardless of visibility, as today. Use a plain id walk, not `composedLeaves`, so eviction does not compose thousands of traced paths a second time.

**Test:** new `src/lib/geometry/__tests__/composedLeaves.test.ts` (create the `__tests__` dir if absent).
- Fixtures are built only with `buildGroupObject`:
  - (a) depth-2: outer group of [inner group of [square path, hole path], rect]
  - (b) the same, with outer rotation 30° and inner rotation 15°
  - (c) depth-3: a group inside (a)
  - (d) a plain rect, no group
- Assert `composedLeaves(fx).map(l => l.obj)` deep-equals `flattenObjectsForTest([fx]).map(({ groupId, ...o }) => o)`. Import `flattenObjectsForTest` from `src/lib/machine/gcodeGen.ts`: read-only use of a frozen file, no edit. That is the parity pin.
- Assert the keys: (a) gives `["outer/inner/sq", "outer/inner/hole", "outer/rect"]`, and (d) gives `[rect.id]`.
- Assert the depth-1 key format is unchanged: a one-level group gives `"g/c"`.
- Visibility parity for `drawnLeaves`:
  - Layers fixture: the default layers, with layer index 2 set `visible: false` and layer index 1 set `output: false`.
  - Fixtures:
    - (e) a depth-2 group whose inner child `hole` is on layer 2 (hidden layer)
    - (f) a depth-1 group with one child `visible: false`
    - (g) a group whose own `layerIndex` is the hidden layer 2 while its children are on layer 0 (the cut ignores the group's own layer)
    - (h) a top-level rect on the output-off layer 1
    - (i) fixture (e), with `layers = []`. This case sits outside the parity oracle, because the cut's rule throws on it. Assert that `drawnLeaves` does not throw and returns every leaf of `composedLeaves(fx)`. Red against a variant without the `ll &&` guard: it throws `Cannot read properties of undefined`.
  - Oracle: `flattenObjectsForTest([fx]).filter(o => o.visible && ((layers.find(l => l.index === o.layerIndex) || layers[0]).visible))`, with `groupId` stripped. It carries a comment citing gcodeGen.ts:276-279 as the rule it copies, minus `output`.
  - Assert `drawnLeaves(fx, layers).map(l => l.obj)` deep-equals the oracle for every fixture (a)-(h). Then assert specifically:
    - (e) omits `hole`
    - (f) omits the hidden child
    - (g) draws both children
    - (h) draws the rect, which pins the deliberate `output` difference

**Proving red first:** the helpers are new, so "import fails" is not a meaningful red. The implementer first writes `composedLeaves`/`drawnLeaves` as a *faithful extraction of today's loop* and wires the Viewport to it. That step is behavior-identical:
- top-level `visible` + `layers[obj.layerIndex]` check on the top-level object only;
- one level: group → `[{key: g/c, obj: composeGroupChild(c, g)}]`, non-group → itself.

Then run the test. It must fail as follows:
- (a)-(c): 2 leaves instead of 3 for (a), and the inner group appears as a leaf.
- (e) and (f): the hidden leaf is present.
- (g): no leaves at all.

Quote the failures in the report. Only then make it recursive and per-leaf.

**Risk:**
- Callers: only the Viewport. svgExport already recurses through `emitObject` (svgExport.ts:20-24). flattenForBoolean recurses (geometryActions.ts:1055-1060). Neither changes.
- Legacy files: 4a2a189 documents that pre-W1b files with depth≥2 paths under a *rotated* outer group migrated with an approximation. They will now render. They render as the cut already cuts them, which is the point: the screen shows the truth.
- Performance: traced images now render every contour (more Graphics). This is the geometry the operator is about to cut, so it has to be drawn. The P3 dirty-skip keeps drags cheap. Rotating a traced group by typing in Properties marks every descendant dirty on every keystroke. The browser step records the frame time for that case.
- Visibility: a child on a hidden layer inside a group on a visible layer disappears from the canvas where it shows today. That is the fix (the cut already skips it). Without F6, a stale child index after a layer reorder makes the render follow the stale layer. That is still exactly what the cut does, so the canvas stays honest, and F6 removes the staleness.
- Error 185: no `useStore` selector is added or changed.

### F2. SVG arcs tessellate to 0.05 mm in real millimetres, whatever the SVG's units (lib-1)

**Diagnosis (re-verified):**
- `approximateArc` (svgImport.ts:444) sizes segments from `CURVE_CHORD_TOLERANCE_MM` against the raw `d` radius (506-515). `parsePathD` (svgImport.ts:42) runs on user units.
- SvgImportDialog maps each point through the element matrix and then `* scale` afterwards (SvgImportDialog.tsx:948-960). `scale` comes from `computeGlobalScale` (544-564).
- Measured end-to-end through the real importer (`_testImportSvgWithLayers`, scratch vitest run 2026-09-22). The input was an 80 mm circle drawn as two `A` commands, `width="100mm"`:

  | viewBox | points | worst sagitta |
  |---|---|---|
  | 0 0 1 1 | 9 | **3.045 mm** |
  | 0 0 10 10 | 21 | **0.492 mm** |
  | 0 0 100 100 | 65 | 0.048 mm (correct) |

- The same class also appears as the min-radius choice explained under Key decisions.
- Not the ruled-out coordinate drift (DECISIONS, 2026-06-21, "SVG path-coordinate drift is not an import/transform defect"). Coordinates land correctly here. This is facet density, and it is reproduced from a synthetic file, not re-derived from theory.

**Fix:**
1. `svgImport.ts`: `parsePathD(d: string, chordTolerance: number = CURVE_CHORD_TOLERANCE_MM)`. Thread it into `approximateArc(..., chordTolerance)`. In `approximateArc`:
   - Replace `const effectiveR = Math.min(rx, ry)` with `Math.max(rx, ry)`.
   - Replace both uses of `CURVE_CHORD_TOLERANCE_MM` with `chordTolerance`.
   - Keep the 8-segment tiny-radius fallback, the `max(4, …)` floor and the 360 cap.
   - Fix the "conservative" comment to state the bound.
   - Update the `parsePathD` docblock: the tolerance is in the `d` string's own units.
2. `src/lib/geometry/index.ts`: add `export function matrixMaxStretch(m: ReadonlyArray<number>): number`, the largest singular value of `[[m0, m2],[m1, m3]]`: `S = a²+b²+c²+d²`, `D = ad−bc`, `σ = sqrt((S + sqrt(max(0, S² − 4D²))) / 2)`.
3. SvgImportDialog `case "path"`: compute `const stretch = matrixMaxStretch(matrix) * scale; const tol = stretch > 0 && Number.isFinite(stretch) ? CURVE_CHORD_TOLERANCE_MM / stretch : CURVE_CHORD_TOLERANCE_MM;` and call `parsePathD(d, tol)`.
4. ImageTraceDialog's `parsePathD(d)` call stays on the default. vtracer emits M/L/C/Z, and even if it emitted arcs the px-unit mismatch errs fine, never coarse (finding lib-1). That is from the vtracer writer as I remember it, not checked here. Either way nothing coarse can result.

**Test:** add to `src/components/panels/__tests__/svgImportRotated.test.ts`, which already drives the production importer through `_testImportSvgWithLayers`. Add a helper `maxDeviation(points, cx, cy, rx, ry)`: sample 4000 points on the true ellipse and return the largest distance from any of them to the imported closed polyline (point-to-segment distance, closing segment included).
- (i) The three viewBoxes above, each an 80 mm circle via two `A` commands. Assert `maxDeviation ≤ 0.05 + 1e-6` mm for each.
- (ii) viewBox 0 0 100 100, width 100mm, `d` = a full ellipse rx=50 ry=5 via two `A` commands. Same bound. This one is red only because of the min→max change.
- (iii) viewBox 0 0 100 100, width 100mm. **A `<path>` with `A` commands, not a `<circle>`.** A `<circle>` goes through `case "circle"` (SvgImportDialog.tsx:782-800), becomes an `ellipse` object with no points, and never reaches `parsePathD`. The element is `<path d="M 4 0 A 4 4 0 1 1 -4 0 A 4 4 0 1 1 4 0 Z" transform="translate(50 50) scale(1 5)"/>`, which makes a world ellipse centred at (50,50) with rx 4 and ry 20 mm. Same bound. This covers the matrix term.

Red today, measured with exactly this `maxDeviation` helper (the critic's probe, 2026-09-22):

| Case | Today |
|---|---|
| (i) viewBox 0 0 1 1 | 3.045 mm |
| (i) viewBox 0 0 10 10 | 0.492 mm |
| (i) viewBox 0 0 100 100 | 0.048 mm (already passes) |
| (ii) | **0.261 mm**, 25 points |
| (iii) | **0.195 mm**, 21 points |

After the fix the critic's worked margins are 0.048 / 0.0475 / 0.0467 mm. The implementer runs the new cases on the unmodified tree and quotes the failing values. The existing F25 tests in `svgImport.test.ts` must pass unchanged, which pins the default parameter.

**Risk:**
- Callers of `parsePathD`: SvgImportDialog, ImageTraceDialog (default arg, unchanged), svgImport tests.
- Point counts rise for coarse-unit SVGs, capped at 360 per arc, and fall for px-unit SVGs: 124 → about 60 for the same 80 mm circle. Both are now at the stated 0.05 mm.
- The min→max change adds segments only to eccentric arcs.
- Import-to-export round-trip tests (`svgExport.test.ts:295-360`) use `L`/`C` paths, not arcs: unaffected.
- **Arcs already imported are not migrated.** F2 changes import only. An SVG imported before this lands keeps its coarse polyline in the `.kerf` file, and nothing in the file shows it came from an arc. Re-import the SVG to repair it. That is the same wording and precedent as the F20 subpath fix (svgImport.ts:36-40, "RE-IMPORT to repair"). Add one sentence to the `parsePathD` docblock saying so.

### F3. A dropped PNG uses its embedded DPI, like File > Import Image (lib-2)

**Diagnosis (re-verified):**
- The menu path reads pHYs: `importImageData` → `parsePngPhysDpi` (imageImport.ts:63), sized at `detectedDpi ?? 300` (80-82).
- The drop path, `importDroppedImage` (fileDrop.ts:27-42), reads only a data URL and calls `openImageImport(base64, name, w, h)`.
- `openImageImport` (App.tsx:124-136) has no DPI parameter. `pendingImage` has no DPI field (storeTypes.ts:275-282). App renders `<ImageImportDialog>` without `detectedDpi` (App.tsx:321-334).
- The dialog already declares and fully consumes that prop (ImageImportDialog.tsx:18, 56, 172, 179). It is simply never supplied.
- `git log -S detectedDpi` → 1752231 (2026-06-17) added the prop and the "(from file)" label and never wired a caller: an oversight, not a choice.
- Result: a 1200 px, 600-DPI PNG is 50.8 mm from the menu and 101.6 mm when dropped, and the dialog says "300 (assumed)".
- Both paths fall back to 300 when there is no pHYs, so the fallbacks already agree.

**Fix:**
1. `imageImport.ts`: `export function detectImageDpi(data: Uint8Array, ext: string): number | null { return ext === "png" ? parsePngPhysDpi(data) : null; }`. `importImageData` line 63 calls it. This is the one detector both paths share.
2. `fileDrop.ts`: `handleFileDrop` passes `ext` into `importDroppedImage(file, ext)`.
   - **Detection can never cancel the import.** Only the metadata read is guarded:
     ```ts
     let dpi: number | undefined;
     try {
       dpi = detectImageDpi(new Uint8Array(await file.arrayBuffer()), ext) ?? undefined;
     } catch {
       dpi = undefined; // metadata is best-effort; the dialog falls back to "300 (assumed)"
     }
     ```
   - After that, `importDroppedImage` proceeds exactly as today, unguarded by the new try: data URL → `Image` → `openImageImport(..., undefined, undefined, dpi)`.
   - A rejected `arrayBuffer()`, or a throw inside the chunk walk on a hostile file, therefore still opens the dialog. The existing outer `.catch(console.error)` on the dynamic App import stays as it is.
   - Import `detectImageDpi` from `./fileOps/imageImport`, statically. It is store-free apart from its module's imports, which fileDrop already pulls in through `../app/store`.
3. `App.tsx` `openImageImport`: add a 7th optional param `detectedDpi?: number` and put it in `pendingImage`. JSX: `detectedDpi={dialogData.pendingImage?.detectedDpi}`.
4. `storeTypes.ts` `pendingImage`: add `detectedDpi?: number`.

The PDF raster caller is unchanged: it passes mm overrides, which win over DPI in the dialog (ImageImportDialog.tsx:57-58).

**Test:** new `src/lib/__tests__/fileDrop.test.ts`.
- `vi.mock("../../app/App", () => ({ openImageImport: vi.fn() }))`.
- Stub `Image` with `vi.stubGlobal` using a class whose `src` setter sets `width = 1200`, `height = 600` and calls `onload` on a microtask.
- Build a PNG with a 600-DPI pHYs chunk (23622 ppm, unit 1). Copy or lift `makePngWithPhys` from `src/lib/fileOps/__tests__/imageImport.test.ts:9`.
- Call `handleFileDrop([new File([bytes], "a.png", { type: "image/png" })] as unknown as FileList)`, then `await vi.waitFor(() => expect(openImageImport).toHaveBeenCalled())`.
- Assert `openImageImport.mock.calls[0][6]` is close to 600 (±0.5).
- Second case: a PNG with no pHYs, and a `.jpg` name with the same bytes. Assert arg 6 is `undefined`.
- Third case, read failure: the 600-DPI PNG `File`, with `Object.defineProperty(file, "arrayBuffer", { value: () => Promise.reject(new Error("read failed")) })`. Assert `openImageImport` **is still called**, with arg 6 `undefined` and args 2-3 = 1200/600.
- Fourth case, detector throws. Mock `"../fileOps/imageImport"` with `importOriginal`, making `detectImageDpi` a `vi.fn` that delegates to the original. `vi.spyOn` on an ESM namespace export is not reliable in vitest. In this case, make it throw once with `mockImplementationOnce`. Assert the same.

Both failure cases pass on today's code, which never reads the bytes. They are guards that go red only if the implementation lets detection gate the dialog.

The implementer proves they can fire with the wrong variant `catch { return; }`, where a detection failure aborts the import. `openImageImport` cannot be moved *into* the `try`: it is reached through `FileReader.onload → Image.onload → import("../app/App")` (fileDrop.ts:27-42). With `catch { return; }`, cases 3 and 4 both time out in `vi.waitFor(() => expect(openImageImport).toHaveBeenCalled())`. Quote that timeout, then restore `dpi = undefined`.

Red today: arg 6 is `undefined` for the 600-DPI file. jsdom 29 implements `Blob.arrayBuffer` (checked: `Blob-impl.js:75`).

**Risk:**
- Callers of `openImageImport`: fileDrop, App's PDF `onImport`. The new param is optional and trailing.
- The WebView gains a `Blob.arrayBuffer` dependency: Safari 14+ / every Chromium. The macOS 12 floor ships Safari 15+.
- A dropped file is read twice (data URL + bytes). That is acceptable for one-off imports.
- A metadata failure degrades to today's behaviour ("300 (assumed)") and never blocks the import. The failure tests pin this.
- The editing-shortcuts plan F8 wraps `addObject` in `withUndo` in the same two files, in disjoint hunks.

### F4. SVG export keeps image and text flips (lib-10)

**Diagnosis (re-verified):**
- `exportSvgContent` builds only `rotate(...)` (svgExport.ts:34-41). `grep -n scale svgExport.ts` finds no match.
- `flipObjects` stores image/text flips as a negative `scaleX`/`scaleY` (geometryActions.ts:447-453 single, 499-503/531-535 multi).
- The Viewport draws them mirrored within the box: `text.x += t.width` and `scale.x = -1` (Viewport.tsx:1413-1423, 1445-1455).
- The Rust image engine flips the pixel buffer before rotation (image_gcode_gen.rs:120-140).
- So a mirrored image or text exports un-mirrored.
- The finding's premise that "gcodeGen honours it" is true for images only. For text it is false: see F5.

**Depends on F5 for its text arm.** The cut honours a text flip only once F5 bakes it into the points. Land F5 first. If F5 is dropped, drop the `obj.type === "text"` condition below and test case (b) with it. The image arm stands alone.

**Fix:** in `emitObject`, replace the `rotTransform` construction with a local `elementTransform(obj)`:
- `rotate(r, cx, cy)` when |r| > 0.001, as today.
- Then, when `(obj.type === "image" || obj.type === "text")` and either scale is negative, append ` translate(cx, cy) scale(${sx<0?-1:1}, ${sy<0?-1:1}) translate(${-cx}, ${-cy})`.
- `cx, cy` is the AABB centre, as today. SVG applies the list right-to-left, giving flip then rotate (R·F), both about the centre.
- Emit ` transform="…"` only if non-empty.
- Rectangles, ellipses, paths, lines and groups are unchanged (see Key decisions).

**Test:** add to `src/lib/fileOps/__tests__/svgExport.test.ts`.
- Add a test-local `applySvgTransform(attr, x, y)` that parses `rotate(a, cx, cy)`, `translate(x, y)` and `scale(x, y)` and applies them right-to-left. That is about 20 lines.
- Cases:
  - (a) An image at x=10 y=20 w=40 h=30, `scaleX: -1`. Extract the `<image …>` transform. Assert it maps (10,20) → (50,20) and (50,50) → (10,50).
  - (b) Text with `scaleY: -1`: (x, y) maps to (x, y+h).
  - (c) An image with rotation 90 and `scaleX: -1`. Assert the mapping equals rotate-about-centre applied to mirror-about-centre for all four corners (R·F), not F·R.
  - (d) A rectangle with `scaleX: -1` and rotation 30 exports exactly as today: no `scale(`.
- Red today: (a)-(c) have no scale, so the mapping check fails. (d) passes before and after, as the guard on the dropped part.

**Risk:**
- Only `exportSvgContent` changes. Callers: `fileOps.exportSvg` and tests.
- The existing D6/P3-A rotate assertions still match: the rotate string is unchanged and still first.
- Kerf's own SVG import already parses `translate`/`scale` (SvgImportDialog `parseTransformAttr`, 34-74). A Kerf-exported flipped image re-imports as a skipped `<image>`, as today. Flipped text re-imports through the matrix path.
- Screen caveat for verification: core-3 (moving a flipped image un-flips it on the canvas) is a D-canvas defect. Verify F4 without moving the image after flipping.

### F5. Mirrored or rotated text is cut the way it looks (new, found re-verifying lib-10)

**Diagnosis (verified 2026-09-22 by running the real `textObjectToPaths` under the repo's synthetic-font mock, scratch config, no repo writes):**
- `generateGcode` converts text to paths with `textObjectToPaths` (gcodeGen.ts:869-876). That function bakes only the translation into the points. Every contour copies `...obj.transform` (geometryActions.ts:233-251), so it inherits `scaleX: -1` and `rotation: r` with its *own glyph bbox* as x/y/w/h.
- Measured, text "AB" in a 10×10 box: `scaleX: -1` produces **identical points** to `scaleX: 1`. `rotation: 90` produces identical points, with each glyph carrying `rotation: 90` about its own centre ((2.5,6.5) and (7.5,6.5)) instead of the box centre (5,5).
- Downstream:
  - Vector `CutObject` has no scale (gcode_gen.rs:107-130), so the flip is dropped.
  - Rust rotates each path about its own `x + width/2` (gcode_gen.rs:1330-1336).
- The cut therefore reads mirrored text forward (the reverse-engraving-on-acrylic case lib-10 names). Rotated text cuts as letters each spun in place along the original baseline, not as a rotated line.
- The same function backs Convert to Path (geometryActions.ts:694-721) and Variable Text generation (921). So converting flipped or rotated text on the canvas visibly un-mirrors it or scatters it the same way.
- The screen draws rotated text about the box centre (`applyObjectRotation`, Viewport.tsx:1185-1193). Its position is off by core-2, a D-canvas defect, but the intended centre is unambiguous and matches the selection box.

**Fix:**
- In `textObjectToPaths`, after all contours are built and *before* `buildGroupObject`, when `sx < 0 || sy < 0 || rotation !== 0`: map every point and both handles.
  - First mirror about the box centre `(t.x + t.width/2, t.y + t.height/2)` on each negative axis.
  - Then rotate about the same centre with the existing `rotatePathPoint`.
- Each contour's transform becomes `rotation: 0, scaleX: 1, scaleY: 1` with x/y/w/h from `pointsBBox` of the mapped points.
- Update the `textObjectToPaths` docblock to say the flip and rotation are baked in. Do not edit the comment at gcodeGen.ts:864-866, because that file is frozen. It stays true anyway: it says the transform is baked into the points, which is now fully the case.

**Test:** add a `describe` to `src/lib/__tests__/compoundPathSplit.test.ts`, which already mocks `opentype.js` with a synthetic font (lines 24-58).
- Text "AB" at `{x:0,y:0,w:10,h:10}`. Call once with identity and once with `scaleX: -1`. Assert every flipped point equals `(10 − x, y)` of the matching identity point, in the same order. Assert every contour transform has `scaleX === 1`.
- `rotation: 90`: assert every point equals the identity point rotated 90° about (5,5), and every contour has `rotation === 0`.
- One multi-contour glyph ("O") case with the flip: children are mirrored, the group is rebuilt from the mapped children, and `flattenObjectsForTest` of the result yields the mirrored world points.

Red today: the flipped points equal the identity points, and the rotation stays 90.

**Risk:**
- Callers: generateGcode, convertTextToPath, Variable Text, `textToGcode` (MaterialTestDialog, frozen, not edited: it passes rotation 0 and scale 1, so the mapping is the identity and the output is unchanged).
- Mirroring reverses contour winding. The fill paths use even-odd (maskFill), which ignores winding. The line mode ignores it too.
- Grouped text: `obj.transform` is group-local, so the bake is local and `composeGroupChild` adds the group's rotation afterwards, as for any child.
- maskFill coalescing bakes child rotation (gcodeGen.ts:310-320). With rotation now 0 that step is a no-op.
- No test pins the old per-glyph rotation (grep of `rotation: [1-9]|scaleX: -1` across the text tests: none).
- The mirror axis is the text box's `transform.width`, which is Pixi's measurement and the same axis the Viewport mirrors about (Viewport.tsx:1419-1421). The opentype layout width can differ by font metrics, so mirrored cut glyphs may sit up to that difference off from where Pixi draws them. This text-metric mismatch between Pixi and opentype is pre-existing: unflipped text already cuts at opentype's advances, not Pixi's. It is not introduced here, and it is indexed in Deferrals.
- Multi-select flip moves `x` before negating the scale (geometryActions.ts:499-503). The bake mirrors about the moved box, which is the same box the Viewport mirrors about, so the screen and the cut still agree. The browser step covers multi-select explicitly.

### F6. Reordering layers carries group children with their group (new, found closing the leaf-visibility item)

**Diagnosis (verified 2026-09-22):**
- `reorderLayers` (store/index.ts:309-333) renumbers every layer so that `index === position`. It then remaps `layerIndex` with `state.objects.map(o => ({ ...o, layerIndex: indexMap.get(o.layerIndex) ?? o.layerIndex }))`, which covers top-level objects only.
- Group children keep their old index, which now names a different layer.
- Probed through the real store (scratch config, no repo writes): a group of two rectangles on layer 0 (Engrave), `reorderLayers(0, 1)`. Result: layers `0:Score,1:Engrave`, group `layerIndex` 1, children `0,0`, meaning Score.
- The cut uses each leaf's index (gcodeGen.ts:278; image path 630). Every traced or grouped part therefore runs with the swapped-in layer's power, speed and passes after any layer reorder. The Layers panel and the group both still say Engrave.
- Before F1 the canvas showed nothing wrong, because visibility was read off the group. After F1 the canvas follows the stale child index honestly. F6 makes that index right.
- `moveObjectsToLayer` already recurses (store/index.ts:217-239, `collectDescendantIds`). Reorder is the one layer-index writer that does not.

**Fix:** in `store/index.ts`, add a module-level helper `remapLayerIndexDeep(objects: DesignObject[], map: ReadonlyMap<number, number>): DesignObject[]`. Each object becomes `{ ...o, layerIndex: map.get(o.layerIndex) ?? o.layerIndex }`, plus `children: remapLayerIndexDeep(o.children, map)` only when `o.children` is defined, so no `children: undefined` key appears on leaves. `reorderLayers` calls it in place of its top-level `state.objects.map`.

**Test:** extend `src/app/store/__tests__/store.test.ts`, which already covers `reorderLayers`.
- First line of the test: `useStore.setState({ layers: DEFAULT_LAYERS })`. `DEFAULT_LAYERS` is already imported there (store.test.ts:4). The file's `beforeEach` resets objects, selection and the undo stacks only (24-31), and the existing `reorderLayers swaps layer positions` test leaves the layers swapped, so without the reset the fixture depends on test order.
- A depth-2 group (outer on layer 0 → inner group → two rectangles, all on layer 0) and one top-level rectangle on layer 2. Call `reorderLayers(0, 1)`.
- Assert that the outer group, the inner group and both grandchildren all have `layerIndex === 1`, that the top-level rectangle is unchanged at 2, and that leaf objects gained no `children` key.
- Red today: the inner group and grandchildren read 0.

**Risk:**
- The only change is that children follow their group. `objectsById` is rebuilt from the remapped objects already (store/index.ts:330).
- **Undo is NOT safe across a reorder, and F6 alone does not fix it.**
  - `reorderLayers` pushes no undo entry. Every earlier undo entry holds an `objects` snapshot with pre-reorder indices, and `undo()` restores it wholesale against the reordered layers (store/index.ts:96-105).
  - So one Ctrl+Z of an unrelated edit made before the reorder moves every object, grouped or not, onto whichever layer now holds its old number.
  - F6 has to be written as a named, reusable recursive helper (`remapLayerIndexDeep`, below) because F7 reuses it.
  - F7 closes this.
- A group deliberately holding children on different layers (`groupSelected` keeps each child's own layer) keeps that mix. Each child is remapped through the same `indexMap`, so every child keeps its *own* layer, which is what a reorder means.
- Severable, except that F7 depends on F6's `remapLayerIndexDeep`. If F6 is dropped, F7 goes with it.

### F7. Layer reorder is undoable, so Ctrl+Z never moves objects onto another layer (critic round 2, same class as F6)

**Diagnosis (verified 2026-09-22):**
- The undo machinery is command-based. `pushCommand({ type, undo, redo })` (store/index.ts:381-390; `Command`, storeTypes.ts:19-23). `withUndo` and `commitPropertyEdit` snapshot **objects and selection only** (`pushObjectsUndo`, store/index.ts:60-117). Layers are never snapshotted, and layer edits (`updateLayer` power/speed/name/visibility) push no command.
- `reorderLayers` pushes no command and rewrites every object's `layerIndex` in place.
- The earlier `objects` snapshots on the stack therefore carry the old numbering, and `undo()` restores them against the new one.
- Probed through the real store (scratch config, no repo writes): rectangle on Engrave → `withUndo` move x+10 → `reorderLayers(0, 1)` → `undo()`. It prints `start Engrave@0`, `moved Engrave@10`, `reordered Engrave@10 undo depth 1`, `after undo Score@0`.
- One Ctrl+Z undid the move, as it should, and also silently put the rectangle on Score. That is Score's power and speed on the material, for every object, grouped or not.

**Fix: reorder becomes its own undo command that applies a layer-index permutation to live state. It does not restore a snapshot.**
- In `store/index.ts`, add a module-level `applyLayerIndexMap(state, map)` that returns the state patch:
  - `layers`: each `{ ...l, index: map.get(l.index) ?? l.index }`, sorted by the new index
  - `objects: remapLayerIndexDeep(state.objects, map)` (F6's helper) and a rebuilt `objectsById`
  - `activeLayerIndex` mapped
  - `isDirty: true`, and the usual `gcodeStale` ternary
- `reorderLayers` first calls `get().commitPropertyEdit()`. This is belt-and-braces: it is a no-op when no property-edit snapshot is open, and it closes any open snapshot under the pre-reorder numbering. So the store stays safe even if some future editor forgets to commit on blur.
- It then computes `indexMap` exactly as today, returning if the reorder is a no-op (no command is pushed). Then:
  - `set(s => applyLayerIndexMap(s, indexMap))`
  - it builds the inverse map
  - `get().pushCommand({ type: "reorder-layers", undo: () => set(s => applyLayerIndexMap(s, inverse)), redo: () => set(s => applyLayerIndexMap(s, indexMap)) })`
  - It moves from a `set(reducer)` to `get()` + `set` + `pushCommand`, because `pushCommand` itself calls `set`.
- Why the permutation, and not the smaller-looking `withUndo`-style snapshot of layers plus objects:
  - A **layers** snapshot restored on undo would revert every power, speed and name edit made after the reorder, because those edits are not commands. That is wrong-settings-on-the-material again, through the fix.
  - An **objects** snapshot would delete objects that arrived by non-undoable paths after the reorder. Image and PDF imports are that today, until the editing plan's F8 lands.
  - A permutation applied to *live* state commutes with every non-command edit. Stack order stays consistent because undo is LIFO: the reorder is undone before any earlier `objects` snapshot is restored, so each snapshot meets the layer numbering it was taken under.
- Selection is untouched: a reorder does not change it, today or after.

**Test:** extend `src/app/store/__tests__/store.test.ts`. Each test starts with `useStore.setState({ layers: DEFAULT_LAYERS })`. A helper `layerName(id)` looks the object's `layerIndex` up by `l.index`.
1. **The critic's sequence:** rectangle on layer 0 (Engrave) → `withUndo("move", …)` x+10 → `reorderLayers(0, 1)`. Assert `undoStack.length === 2`.
   - `undo()`: the name is **Engrave**, x is 10, and `layers[0].name === "Engrave"` (the order is restored).
   - `undo()`: Engrave, x is 0.
   - `redo()` twice: Engrave, x is 10, `layers[1].name === "Engrave"`, and the rectangle's `layerIndex === 1`.
   - Red today: after the first `undo()` the name is `Score`, as probed. The length assertion also fails (it is 1).
2. **Commutes with layer edits:** `reorderLayers(0, 1)`, then `updateLayer(<Engrave's new index>, { power: 42 })`, then `undo()`. Engrave is back at index 0 **with power 42**. This test has two halves, and each goes red for its own reason. The implementer quotes both failures:
   - *Index half:* red on today's tree and on the F6-only tree, because the reorder is never undone and Engrave stays at index 1. The `power === 42` half is trivially green there and proves nothing.
   - *Power half:* red against the named wrong variant, **a layers-snapshot undo**. This is a `withUndo`-style command that captures the pre-reorder `layers` array and restores it on undo. Engrave returns to index 0 with its *old* power, not 42. The implementer builds that variant temporarily, quotes the `power` failure, and then restores the permutation.
3. **Grouped child:** a group of two rectangles on Engrave, same sequence as (1). Both children read Engrave after every step. This depends on F6.
4. **`activeLayerIndex`:** `setActiveLayerIndex(0)` (Engrave), then `reorderLayers(0, 1)`. Assert `activeLayerIndex === 1`. After `undo()`, assert **`activeLayerIndex === 0`** and that it names Engrave. After `redo()`, assert **`activeLayerIndex === 1`** and that it names Engrave. Two reds, two reasons:
   - The concrete index goes red on today's tree and on the F6-only tree: it reads 1 after `undo()`, because nothing undoes the reorder. The name alone is green there (1 still names Engrave), which is why the index assertion is required.
   - The name goes red against the plausible wrong F7: an `applyLayerIndexMap` that forgets `activeLayerIndex`. Engrave returns to 0 while active stays 1, which is Score.
5. **No-op reorders push nothing:** record `undoStack.length`, then call `reorderLayers(0, 0)` (same index) and `reorderLayers(0, 99)` (unknown index). Assert the length is unchanged, the redo stack is untouched (seed one entry first by doing an edit and undoing it), and `layers` is the same array reference. Green today, because today pushes nothing ever. It goes red against a variant that pushes the command before the no-op check. Quote that.
6. **Open property edit across a reorder (store-level guard for the belt-and-braces call):** `beginPropertyEdit()` → `updateObject` x+10 on an Engrave rectangle → `reorderLayers(0, 1)` → `commitPropertyEdit()` → `undo()` twice. The rectangle reads Engrave after each step. This is red today, as probed by the critic: the rectangle ends on Score. It also goes red against F7 without the `commitPropertyEdit()` call.

**Risk:**
- Callers: LayerPanel's drop handler (LayerPanel.tsx:106-110). It fires once per drop, not on drag-over, so one reorder is one undo entry.
- `pushCommand` clears the redo stack, as every edit does.
- The `MAX_UNDO` 50 cap trims the oldest entries first. A trimmed reorder only ever has older entries below it, and those are trimmed first.
- Open property edits across a reorder: the store-level hazard is real (the critic probed it: `beginPropertyEdit` → edit → `reorderLayers` → `commitPropertyEdit` → `undo()` puts the object on Score). It is **unreachable through the UI**, verified by the critic in round 3:
  - Every PropertiesPanel field is `onFocus={beginEdit} onBlur={commitEdit}` (PropertiesPanel.tsx:171-617), and the Align buttons begin and commit synchronously (442-444).
  - The text-edit textarea commits on blur (Viewport.tsx:1099-1104).
  - The node drag commits on pointer-up (src/lib/tools/toolHandler.ts:1651).
  - A layer drag starts with a mousedown on a non-focusable `draggable` row in another panel (LayerPanel.tsx:88-116), which fires `blur` before `dragstart`.

  The `commitPropertyEdit()` call at the top of `reorderLayers` is belt-and-braces for a future editor that forgets to commit on blur. Test 6 pins it, and one browser step exercises the real UI path.
- No change to `pushObjectsUndo`, `withUndo` or the `Command` type.
- Severable: its own commit, after F6.

## Browser verification

`npm run dev`, Chrome DevTools MCP. The store and modules are reachable with `await import('/src/…')` in `evaluate_script`. The G-code generator, the tracer and Tauri file dialogs are not available in the browser.

- **F1:**
  - Text tool: type `BOB`, Convert to Path. Each B and O becomes a group. Select all, Ctrl+G. Screenshot. All three letters stay visible, holes included. Today the letters vanish on grouping.
  - Drag the group and confirm the letters follow with no ghosting. Rotate the group 30° and confirm the letters rotate with it.
  - Via the store, build `buildGroupObject([buildGroupObject([outer, hole]), square])` (the refresh's own repro) and confirm the washer renders.
  - Nest an image inside a depth-2 group. Move it 5 times. The image stays drawn, with no blank flashes (texture eviction).
  - Per-leaf visibility, via the store:
    - Put one child of a group on a layer, then hide that layer in the Layers panel. The child disappears and its siblings stay. Today it stays drawn.
    - Set a layer's Output off. Its objects stay drawn.
  - Performance: build a group of about 2,000 path contours via the store, a stand-in for a real trace. Rotate it by typing values into the Properties rotation field. Record the frame time from a DevTools performance trace in the relay log. Anything that visibly stalls typing is a finding for Razor.
- **F2:**
  - Build an SVG string with viewBox `0 0 1 1`, `width="100mm"` and a two-arc circle r=0.4. Dispatch a synthetic drop on the app root: `new DataTransfer()` + `items.add(new File([svg], 'c.svg', {type:'image/svg+xml'}))` + `DragEvent('drop', {dataTransfer, bubbles:true})`. Import.
  - Zoom to 800% on the edge. The circle is smooth, not an octagon. The store object has ≥ 60 points.
- **F3:**
  - Generate a 1200×600 PNG with a 600-DPI pHYs chunk in-page (bytes built as in the test) and drop it the same way.
  - The dialog reads "DPI: 600 (from file)" and the imported object is 50.8 × 25.4 mm (check in the Properties panel).
  - Drop a PNG without pHYs: "300 (assumed)".
  - Drop a truncated PNG (signature plus half a chunk): the dialog still opens, reading "300 (assumed)".
- **F4:**
  - Add an image and a text object. Flip each horizontally (Ctrl+Shift+H). Do not move them afterwards (core-3).
  - Run `(await import('/src/lib/fileOps/svgExport.ts')).exportSvgContent()`. Paste the output into a new tab as a data URL. The image and text render mirrored, matching the canvas.
  - Rotate the image 90° and flip it. Repeat: the export matches the canvas orientation.
- **F5:**
  - Type `KERF`, flip it horizontally, Convert to Path: the glyphs stay mirrored in place (today they un-mirror).
  - Type `KERF`, rotate it 90°, Convert to Path: the glyphs form a vertical line inside the rotated selection box (today they spin in place along a horizontal line).
  - Multi-select: select `KERF` text together with a rectangle, press Ctrl+Shift+H, then Convert to Path on the text. The glyphs stay mirrored, in the text's moved box.
- **F6:**
  - Put a grouped object (Ctrl+G two rectangles) on Engrave. Drag Engrave below Score in the Layers panel.
  - Via the store, read the group's and its children's `layerIndex`. They are equal, and they name Engrave.
  - Hide Engrave: the whole group disappears, children included.
- **F7:**
  - Draw a rectangle on Engrave and nudge it with an arrow key.
  - Drag Engrave below Score. Press Ctrl+Z: the layer order goes back and the rectangle keeps Engrave's colour. Its Properties layer shows Engrave, and it stays at the nudged position.
  - Ctrl+Z again undoes the nudge. Ctrl+Shift+Z twice re-applies both, and the rectangle still reads Engrave.
  - Then: reorder, change Engrave's power in the Layers panel, Ctrl+Z. The order is restored and the new power is kept.
  - Open property edit: select the rectangle, focus the Properties X field and type a new value without pressing Enter. Drag Engrave below Score, then Ctrl+Z twice. The rectangle keeps Engrave throughout.
- **Owner desktop-app test required (Tauri-only):**
  1. Trace an image of the word BOB and open the G-code preview: the canvas and the preview show the same letters, holes included (F1).
  2. File > Import Image and drag-drop of the same 600-DPI PNG produce the same size (F3).
  3. Flipped text engraved on scrap reads mirrored, and rotated text engraves as one rotated line (F5).
  4. After reordering layers, a traced group's G-code uses the group's layer power and speed (F6). Then make any edit, reorder, and Ctrl+Z. Regenerate: the S and F values still match each object's layer (F7). Read the S and F values in the G-code preview.

  Log these in ROADMAP `next`. They are desktop-app checks, not laser-hardware checks, except step 3's burn.

## Files

**In scope:**
- `src/lib/geometry/index.ts`: `composedLeaves`, `drawnLeaves`, `matrixMaxStretch`.
- `src/app/store/index.ts`: `reorderLayers` plus the new module-level `remapLayerIndexDeep` (F6) and `applyLayerIndexMap` (F7). Nothing else in the file.
- `src/components/viewport/Viewport.tsx`: render-loop descent and texture eviction only (≈308-352).
- `src/lib/fileOps/svgImport.ts`: `parsePathD` and `approximateArc`.
- `src/components/panels/SvgImportDialog.tsx`: `case "path"` call site only.
- `src/lib/fileOps/imageImport.ts`: `detectImageDpi`, and line 63.
- `src/lib/fileDrop.ts`.
- `src/app/App.tsx`: `openImageImport` and one JSX prop.
- `src/app/store/storeTypes.ts`: the `pendingImage` field.
- `src/lib/fileOps/svgExport.ts`.
- `src/app/store/geometryActions.ts`: `textObjectToPaths` only.
- Tests:
  - `src/lib/geometry/__tests__/composedLeaves.test.ts` (new)
  - `src/components/panels/__tests__/svgImportRotated.test.ts` (extend)
  - `src/lib/__tests__/fileDrop.test.ts` (new)
  - `src/lib/fileOps/__tests__/svgExport.test.ts` (extend)
  - `src/lib/__tests__/compoundPathSplit.test.ts` (extend)
  - `src/app/store/__tests__/store.test.ts` (extend, F6 and F7)
- ROADMAP via relay-design Stage 3.5 (shipped entry, the owner-test steps, and the Parking Lot lines in `## Deferrals`).

**Explicitly out of scope:**
- Every remediation-frozen file. None is needed. `gcodeGen.ts` is only *imported* by two tests (`flattenObjectsForTest`), never edited. MaterialTestDialog's `textToGcode` path is unaffected by F5 (identity transform).
- `src/lib/tools/toolHandler.ts` hit-testing and selection (top-level by design, see F1).
- The other Viewport defects (core-2 rotated text/image position, core-3 flipped image un-flips on move): D-canvas relay.
- Emitting arcs as cubic handles (Key decisions). DXF arc policies (lib-16, declined in triage).
- Rerouting drop through `importImageData` or unifying Open/drop dispatch (lib-14, bucket B4). JPEG JFIF density: neither path reads it today.
- `ARCHITECTURE.md`. The concurrent refresh is editing it (core-19 covers the nested-group note). If it still states a nested-group limit after this lands, the relay's ROADMAP/doc stage removes that line.

## Deferrals

Observed while planning, not fixed here. At Stage 3.5 the relay appends each line below, verbatim, to ROADMAP.md `## Parking Lot — every deferral, one index`, in the existing `- **Title** — detail.` shape:

- **Flip on a group, or on a rotated rect or ellipse, does nothing on screen or in the cut** — `flipObjects` stores a negative scaleX/scaleY on these (geometryActions.ts `flipObjects`, single-select rect/ellipse/group branch and the multi-select branches), but no renderer, cut path or composition reads it (`composeGroupChild` treats scale as a sign-only flag it does not composite; `CutObject` has no scale). Every trace is a group, so mirroring a traced logo for reverse engraving silently does nothing. Found by code reading 2026-09-22 (refresh-cut-vs-screen), not browser-confirmed.
- **`ungroupSelected` drops a rotated group's rotation** — children land unrotated at their stored offsets; documented in code as pre-existing (geometryActions.ts `ungroupSelected`), not indexed until now. Noted 2026-09-22 (refresh-cut-vs-screen).
- **A group's own `visible` flag is ignored by both the cut and (after refresh-cut-vs-screen F1) the canvas** — both decide visibility per leaf; no UI sets a group's `visible` today, so this is latent. If an object-visibility toggle is ever added, it must propagate to descendants or both consumers must learn ancestor visibility. Noted 2026-09-22.
- **Text layout width mismatch between Pixi and opentype** — the canvas draws text with Pixi's metrics while the cut (and Convert to Path) lays glyphs out with opentype's advances, so cut text can sit a font-metric off from the drawn text; mirrored text (F5) inherits the same offset about the box centre. Pre-existing; noted 2026-09-22 (refresh-cut-vs-screen).
- **SVG arcs as cubic handles instead of polylines** — rejected in refresh-cut-vs-screen F2 because `pointsBBox` is anchors-only; revisit once bounding boxes account for curve extrema, which would also stop tessellated arcs faceting when scaled up inside Kerf. Noted 2026-09-22.
- **Layers panel counts, select-by-layer and the Properties layer badge read top-level objects only** — `selectByLayer` (store/index.ts), the Layers panel's per-layer object list, count and selected-highlight (LayerPanel.tsx), and the Properties panel's layer indicator (PropertiesPanel.tsx) all filter top-level `objects`; grouped children on another layer are honoured by the cut and (after refresh-cut-vs-screen F1) the canvas but never listed, so hiding a layer can remove half a group that the panel shows under no layer. Selection is top-level by design, so this is a listing gap, not a cut defect. Noted 2026-09-22.
- **Already-imported SVG arcs keep their old coarse tessellation** — F2 fixes import only; affected objects are repaired by re-importing the source SVG, and nothing marks which objects came from arcs. Noted 2026-09-22 (refresh-cut-vs-screen).

## Done when

- [ ] Every new test was shown failing on the unmodified tree first. For F1, that means failing against the faithful one-level, top-level-visibility extraction. For F3's two failure-path guards, it means both timing out in `vi.waitFor` against the wrong variant `catch { return; }`. For `drawnLeaves` fixture (i), it means throwing against a variant without the `ll &&` guard. The failing assertion lines are quoted in the implementer report, and then pass.
- [ ] The existing F25 arc tests in `svgImport.test.ts` pass unmodified.
- [ ] `npm test` green: baseline **823 JS** + new tests, 0 unexpected failures. `cargo test` **310** green (no Rust changes).
- [ ] F5 landed before F4. If F5 was dropped, F4 shipped without its `text` arm and without test case (b).
- [ ] F6 landed before F7. If F6 was dropped, F7 was dropped too.
- [ ] `reorderLayers` pushes exactly one `"reorder-layers"` command per call, and none for a no-op reorder (F7 test 5). The named wrong variants for F7 tests 2, 4 and 5 were each shown red, with the failures quoted.
- [ ] The `## Deferrals` lines are appended verbatim to the ROADMAP Parking Lot.
- [ ] `npx tsc --noEmit` clean. TS strict, zero `@ts-ignore`/`@ts-expect-error`.
- [ ] `npm run lint`: no new warnings against baseline.
- [ ] `npm run format:check` and `cargo fmt --check` clean (the pre-commit hook enforces this).
- [ ] No `useStore` selector added or changed (Error-185 rule). If one is touched, it returns a scalar or a stable reference.
- [ ] `grep -n "Do not add viewport recursion" src` returns nothing.
- [ ] One commit per fix (F1-F7), in the Dependency Graph's batch order.
- [ ] Browser verification above done for F1-F7, with screenshots in the relay log. The owner desktop-app steps are logged in ROADMAP `next`.
