# Critic review: refresh-cut-vs-screen

**Plan:** `.claude/plans/refresh-cut-vs-screen.md`
**Reviewed:** 2026-09-22, Fable, against the tree at `00d24f0` (clean working copy).
**Method:** every load-bearing citation opened; F5 and F2 re-measured with an independent
probe (scratchpad `critic-probe/`, config-aliased fake font, production `textObjectToPaths`
and `_testImportSvgWithLayers`, no repo writes); full JS suite run once for the baseline.

## Verdict: APPROVE WITH CHANGES

No gating dimension fails. Every diagnosis in the plan reproduced on today's code, the two
transform-order claims (R·F) hold against the Viewport, the Rust image engine and SVG's
right-to-left transform list, and none of the five fixes double-applies on any path I could
find. The changes below are plan amendments and test-spec corrections, not design changes.

**Blocking findings:** none.

**Must-fix before implementation (advisory, in priority order):**

1. **F4's text half depends on F5, and the plan says the opposite.** The Skip note says F5
   "can be dropped without touching F1-F4". If F5 is dropped, F4 still exports mirrored text
   mirrored while the cut still un-mirrors it, which breaks the plan's own rule for F4
   ("export flip ... only where both the screen and the cut honour it"). Fix: state the
   coupling. Either F5 lands before F4, or dropping F5 also drops the `obj.type === "text"`
   arm of `elementTransform`. One sentence in Key decisions and in Done-when.
2. **F3 must not let a metadata failure kill the import.** The plan reads
   `file.arrayBuffer()` before the FileReader and `.catch(console.error)`s the whole chain.
   Today a dropped PNG always opens the dialog; after F3 a rejected `arrayBuffer()` (or a
   throw inside `parsePngPhysDpi` on a hostile file) silently drops the import with only a
   console line. Fix: wrap only the detection (`let dpi: number | null = null; try { dpi =
   detectImageDpi(...) } catch {}`) and proceed to the dialog with `undefined` DPI. Add the
   test case: `arrayBuffer` rejects, `openImageImport` is still called with arg 6
   `undefined`.
3. **F2 test (iii) must be a `<path>` with `A` commands carrying `transform="scale(1 5)"`.**
   The plan says "a circle r=4 with transform". A `<circle>` element never reaches
   `parsePathD` (it goes through `case "circle"` at SvgImportDialog.tsx:782-800 and becomes
   an `ellipse` object with no `points`), so the test would throw on `o.points` rather than
   go red for the stated reason. My probe with a two-arc `<path>` under `scale(1 5)` imports
   as a path, 21 points, max deviation 0.195 mm.
4. **Correct the "red today" numbers for (ii) and (iii) so the implementer's quote is not
   read as a mismatch.** The plan's 0.43 and 0.25 are the parametric-step bound
   `max(rx,ry)(1 - cos(dt/2))`, not the point-to-segment distance the specified
   `maxDeviation` helper measures. Measured with that helper on today's code: (i) 3.045 /
   0.492 / 0.048 mm (exactly as the plan says), (ii) rx=50 ry=5: **0.261 mm**, 25 points,
   (iii) **0.195 mm**, 21 points. All still red against 0.05 by a wide margin.
5. **Baseline is 823 JS tests, not 813.** `npx vitest run` on this tree: 51 files, 823
   passed, 0 failed, 79 s. Done-when should read 823 + new.
6. **Index the "Observed, not fixed" items in the ROADMAP Parking Lot** at the Stage 3.5
   ROADMAP step (rubric: out-of-scope named *and* indexed). Two lines: flip is inert on
   groups, rotated rectangles and ellipses (screen and cut both ignore the negative scale);
   `ungroupSelected` drops a rotated group's rotation (already documented in code, not in the
   lot).
7. **Name the leaf-level visibility gap that `composedLeaves` will carry forward, and decide
   it.** The render loop checks `visible` and layer visibility on the *top-level* object
   only; the cut checks them on every *leaf* (gcodeGen.ts:276-279). `groupSelected` keeps
   each child's own `layerIndex` (geometryActions.ts:555-560), so a group holding a child on
   a hidden layer draws that child and does not cut it. This is pre-existing at depth 1 and
   outside the four findings, but it is this plan's exact theme and the loop being rewritten
   is the one place to close it: `for (const leaf of composedLeaves(obj)) { if
   (!leaf.obj.visible) continue; const ll = layers[leaf.obj.layerIndex]; if (ll &&
   !ll.visible) continue; ... }`. Either fold it into F1 (two lines, no new test file: one
   fixture with a hidden-layer child in the browser step) or add it to Observed. Do not leave
   it unnamed.
8. **State that already-imported arcs are not migrated.** F2 changes import; an SVG imported
   before it keeps its coarse polyline. `svgImport.ts:36-40` already has the precedent
   wording ("RE-IMPORT to repair"). One line under F2 Risk.

Everything else is PASS. Dimension detail follows.

---

## Applicability

**Project type:** desktop CAD/CAM app (Tauri/React/Pixi/Rust) whose output is laser G-code.
This plan changes the geometry that reaches the G-code generator (F2 point density, F5
mirrored/rotated text), what the canvas draws (F1), the physical size of imported images
(F3) and an export file (F4). It touches no control path, no serial code, no power or feed
value, and no frozen file.

| Dim | Fires? | Why | Tag |
|---|---|---|---|
| X1 Physical & human safety | **Yes** | Vector geometry that becomes G-code moves (F5) and densifies (F2). No interlock or stop path is touched. | **GATING** |
| X2 Privacy & data | No | No personal, client or child data. Dropped image bytes are read for a 9-byte pHYs chunk only. | N/A |
| X3 Evidence & source | No | Not research or public claims. (Load-bearing code claims are checked below anyway.) | N/A |
| X4 Audience/brand/money | No | Nothing client- or public-facing. | N/A |
| X5 Concurrency | Yes | F3 adds an async read before the existing async read on a drop path that can fire for several files at once; F1 changes a per-frame render loop. | ADVISORY |
| X6 Operability | Yes | Ships in a released desktop app; the DPI label and the console line are the field evidence. | ADVISORY |
| X7 Self-modification | No | No MARVIN gates, hooks or skills. | N/A |
| X8 Dependencies/perf/cost | Yes | No new packages. F1 draws every traced contour; F2 raises point counts for coarse-unit SVGs (capped 360/arc). | ADVISORY |

---

## Core dimensions

### 1. Problem-fit — PASS
`## Intent (grilled)` exists with a written skip line; each fix maps to a named finding
(core-1, lib-1, lib-2, lib-10) plus F5, which is labelled as new and severable. Checked
against DECISIONS.md: the 2026-06-21 ruling ("SVG path-coordinate drift is not an
import/transform defect ... do not re-derive an import/transform theory without a
reproducing file") is respected. F2 is facet density, not coordinate drift (my probe: bbox
80.00 x 80.00 mm in all three viewBoxes, centre correct; only the sagitta is wrong), and it
is reproduced from a synthetic file that the plan and I both ran. The 2026-09-10 rulings
(full feature set, geometry program deferred, region-offset open) are untouched: nothing
here offsets, unions or changes kerf behaviour.

### 2. Approach soundness — PASS
- **F1.** `composedLeaves` mirrors `flattenObjects` (gcodeGen.ts:203-219) exactly:
  `composeGroupChild` on a group child takes the non-path branch
  (geometry/index.ts:441-457), composes x/y/rotation and leaves `children` group-local; the
  recursion then composes grandchildren against that expanded group. Same shape, same
  function, so parity is by construction and the geometry is the one the cut already uses.
- **F2.** The effective tolerance is correct and conservative. `applyMatrix2x3` uses
  x' = a·x + c·y, y' = b·x + d·y, so the linear part is [[a, c],[b, d]] and the plan's
  S = a²+b²+c²+d², D = ad − bc, σ_max = sqrt((S + sqrt(S² − 4D²))/2) is its largest singular
  value. Any deviation vector of length δ in user units maps to at most σ_max·scale·δ mm,
  so tol_u = 0.05/(σ_max·scale) guarantees ≤ 0.05 mm under skew and non-uniform scale (the
  column norms `getMatrixScale` returns are smaller than σ_max under skew, which is why the
  plan is right not to use them). The min→max radius change is right: the ellipse is the
  unit circle under diag(rx, ry), the circle's chord-deviation vector has length
  1 − cos(Δt/2), and its image has length ≤ max(rx, ry)·(1 − cos(Δt/2)). Using min(rx, ry)
  bounds nothing; the "conservative" comment (svgImport.ts:507) is backwards, as the plan
  says. Worked check of the post-fix margins: (i) 0.048, (ii) 0.0475, (iii) 0.0467 mm — all
  under 0.05, (iii) by 7 %, which is fine for a bound but worth knowing.
- **F3.** One detector shared by both paths; drop path keeps the dialog. Correct minimal
  route.
- **F4.** `rotate(r,cx,cy) translate(cx,cy) scale(sx,sy) translate(-cx,-cy)` applied
  right-to-left is flip about the centre, then rotate about the centre: R·F. The Viewport
  sets the object's own `scale.x = -1` and then `applyObjectRotation` sets pivot = position
  = centre and rotation on the same display object; Pixi's local matrix is
  T(position)·R·S·T(−pivot), so the screen is also R·F (its *centre* is wrong for text and
  images, which is core-2, but the order is not). The Rust image engine flips the pixel
  buffer in image-local space (image_gcode_gen.rs:120-140) and rotates image-local
  coordinates about the centre afterwards (`to_grbl_coords`, image_gcode_gen.rs:335-356,
  394-412): R·F. All three agree.
- **F5.** Mirror about the box centre on each negative axis, then `rotatePathPoint` about
  the same centre: R·F again, matching F4 and the Viewport's text branch
  (`text.x += t.width; scale.x *= -1`, Viewport.tsx:1413-1423, which is a mirror about
  x = t.x + t.width/2). Baking into the points and zeroing the contour transform is the
  right place, because every consumer of `textObjectToPaths` afterwards treats the output as
  ordinary paths: the cut (Rust rotates by `CutObject.rotation` about the path's own box,
  gcode_gen.rs:1327-1336, now 0; `CutObject` has no scale field, gcode_gen.rs:107-130), the
  maskFill coalescer (bakes child rotation, gcodeGen.ts:310-323, now a no-op), Convert to
  Path and Variable Text (store paths rendered by `renderObject` + `applyObjectRotation`,
  now rotation 0), and `textToGcode` (identity transform, mapping skipped). Grouped text:
  `obj.transform` is group-local, the bake is local, `composeGroupChild` adds the group
  rotation to the points afterwards and keeps `rotation: t.rotation || 0` = 0. No path
  double-applies.

### 3. Completeness — CONCERN
All five defects are covered end to end. Two gaps, both fixable by a sentence: the F4/F5
coupling (must-fix 1) and the leaf-level visibility gap `composedLeaves` inherits (must-fix
7). The F3 failure path (must-fix 2) is a completeness gap too: the plan covers "no pHYs"
and "not a PNG" but not "bytes could not be read".

### 4. Right-sizing & reuse — CONCERN
Reuse is good: `composeGroupChild`, `rotatePathPoint`, `pointsBBox`, `buildGroupObject`,
`parsePngPhysDpi`, `flattenObjectsForTest` as the parity oracle, existing test files
extended rather than new harnesses. Cubic-arc emission was rejected for the right reason
(`pointsBBox` is anchors-only, geometry/index.ts:192-214, so cubic arcs would open a new
box-vs-cut gap). The concern: the plan has no tier and no dependency graph. It is one relay
over 10 source files across four subsystems (viewport, geometry, fileOps, store) plus five
test files, with "one commit per fix" as the only batch statement. Fix: add a five-line
dependency block — F1, F2, F3 independent; F5 independent; F4 depends on F5 for its text arm
— and a one-line waiver for the file count ("five independent commits, each under four
source files"). Out-of-scope items are named but not indexed (must-fix 6).

### 5. Security — PASS
No secrets, no auth, no network. F3 parses a dropped file's bytes for a PNG chunk;
`parsePngPhysDpi` already guards corrupt chunk lengths (imageImport.ts:26) and stops at
IDAT/IEND. F4 emits transform attributes built from numbers only. No new attack surface.

### 6. Failure modes — CONCERN
- F2: `stretch` NaN/0 falls back to the default tolerance — good. A singular matrix
  (`scale(1 0)`) gives σ_max = 1, fine.
- F3: a rejected `arrayBuffer()` kills the import (must-fix 2). Everything else in the drop
  path already swallows errors the same way, but F3 adds a *new* way to fail before the
  dialog opens, on a path that has never failed before the dialog.
- F5: font load failure is already caught by every caller. Mirroring reverses contour
  winding: I checked that this is harmless, and for a stronger reason than the plan gives.
  `offsetRingByDistance` (geometry/index.ts:736-737) and Rust `offset_polygon_inward`
  (offset.rs:13-22) both normalise by signed area, and the lead-in side selection
  (gcode_gen.rs:551-571) does too, so kerf offset and lead-ins are orientation-agnostic;
  maskFill is even-odd (gcode_gen.rs:1155). Note also that `flipObjects` has always reversed
  winding for path/line objects, so mirrored text after F5 joins an existing class.
- F1: a leaf whose type has no `renderObject` case (a childless "group") draws an empty
  Graphics, exactly as today.

### 7. Change safety — PASS
Every step is a plain code change under one commit per fix; nothing irreversible, no data
rewritten on disk, no migration. Reverting any one commit restores today's behaviour for
that fix alone (with must-fix 1 applied, reverting F5 also reverts F4's text arm).

### 8. Data integrity & compatibility — PASS (with must-fix 8)
- Saved `.kerf` files: unchanged format. `pendingImage.detectedDpi` is dialog state, never
  persisted. Text objects saved with flips/rotations now convert and cut as the screen has
  always shown them — that is the fix, not a migration. Paths converted *before* F5 keep
  their per-glyph rotation and are unchanged (screen and cut already agreed on them).
- Legacy pre-W1b files with depth ≥ 2 paths under a rotated ancestor (4a2a189) now render as
  the cut already cuts them. Correct.
- Previously imported coarse arcs stay coarse until re-imported (must-fix 8: say so).
- Existing tests: every arc test in `svgImport.test.ts` (lines 72, 231, 238, 250) uses
  rx = ry and inequality assertions, and the default parameter keeps the tolerance
  identical, so no golden or import test changes output. The svgExport round-trip tests
  (295-360) use `H`/`V`/`L`/`C`, no arcs. Rust goldens: no Rust change. `cargo test` count
  in the plan (305) was not re-run here.

### 9. Verifiability (incl. testing the tests) — PASS
Red-first is real for every fix. Independently confirmed on today's code:
- **F5:** `textObjectToPaths` never reads `scaleX`, `scaleY` or `rotation` (grep of lines
  88-266: no hits); the contour transform spreads `...obj.transform` (line 246). Probe
  output for "AB" in a 10 x 10 box with the synthetic font: `scaleX: -1` gives points
  identical to identity with every contour carrying `scaleX: -1`; `rotation: 90` gives
  identical points with each contour carrying `rotation: 90` and its own box
  (x 0 / 5, y 3, 5 x 7 — centres (2.5, 6.5) and (7.5, 6.5), as the plan states). The plan's
  assertions (`(10 − x, y)`, rotation about (5,5), `scaleX === 1`, `rotation === 0`) fail
  today and are non-tautological because A and B occupy different halves of the box, so
  same-index points differ after mirroring.
- **F2:** measured values above; the `maxDeviation` helper (4000 samples, point-to-segment,
  closing segment included) is the right instrument. Spec correction in must-fix 3 and 4.
- **F1:** the "faithful one-level extraction first" step is contrived but genuine: fixtures
  (a)-(c) give 2 leaves instead of 3 with the inner group appearing as a leaf. The parity
  assertion strips `groupId` from `flattenObjectsForTest` output and deep-equals; both sides
  call the same `composeGroupChild`, so this pins the recursion shape, which is the thing
  that was wrong. Geometric correctness of the composition itself is already covered by
  `flattenObjects.test.ts`. Key assertions cover depth-1 unchanged (`g/c`), which protects
  the P3 dirty-skip and cache behaviour.
- **F3:** `vi.mock("../../app/App")` intercepts fileDrop's dynamic `import("../app/App")`
  (same module id from `src/lib/`); jsdom 29 has `Blob.arrayBuffer` (Blob-impl.js:75);
  `makePngWithPhys` exists at imageImport.test.ts:9. Arg 6 is `undefined` today because
  `openImageImport` is called with four args (fileDrop.ts:36). Red for the stated reason.
- **F4:** the D6/P3-A assertions match `transform="rotate\(45[,\s]+35[,\s]+35\)"` without a
  closing quote anchor except the negative cases, which are non-flipped objects. The rotate
  string stays first and unchanged. Cases (a)-(c) are red because no `scale(` is emitted
  today (`grep -n scale svgExport.ts`: none). Case (d) is the guard on the dropped
  rectangle part.
- Browser verification steps are concrete and per-fix; the Tauri-only steps are named for
  the owner and routed to ROADMAP `next`.

### 10. Maintainability — PASS
`composedLeaves` and `matrixMaxStretch` sit beside the helpers they extend, with docblocks
that say why. The stale "Do not add viewport recursion" note is deleted and its removal is
asserted in Done-when. The frozen `gcodeGen.ts` comment at 864-866 stays true. The
ARCHITECTURE.md "Known gap: nested groups" line (ARCHITECTURE.md:294) is routed to the
concurrent refresh's core-19 with a fallback to this relay's doc stage — acceptable, but the
relay's ROADMAP/doc stage should check it rather than assume. Line citations spot-checked
and correct throughout (one path note: `hitTest` lives at
`src/lib/tools/toolHandler.ts:280`, the plan cites `toolHandler.ts` without the directory).

---

## Conditional dimensions

### X1. Physical & human safety — PASS [GATING]
No control path, interlock, power, feed, stop or streaming code changes. Worst physical
case per fix: F5 moves text geometry within its own bounding box (mirror and rotation about
the centre), so a bug in the centre arithmetic would cut glyphs in the wrong place inside
the framed box, never outside it; F2 only adds points (never removes) and is capped at 360
per arc; F1 changes nothing the laser receives (the cut already recursed); F3 changes the
size of an *image object* the operator still sees and confirms in the dialog before any
cut; F4 is a file. The hardware-only check ("flipped text engraved on scrap reads mirrored,
rotated text engraves as one rotated line") is named and routed to ROADMAP `next`, not
skipped. `$32`, M3/M4, abort and pause paths untouched.

### X5. Concurrency & re-entrancy — PASS [ADVISORY]
Multiple dropped files each get their own closure; the extra `arrayBuffer()` read adds one
more async hop per file but no shared state. The render loop is synchronous per frame; the
composite keys are stable across renders (id paths), so no cache or texture thrash — the
texture cache stays keyed by object id and the recursive `collectImageIds` covers every
depth, which fixes today's per-frame destroy/recreate of a depth-2 image texture.

### X6. Operability & observability — PASS [ADVISORY]
The dialog's "DPI: 600 (from file)" label and the existing console line are the field
evidence for F3. F2 has no field signal (an octagon is the evidence), which is fine because
the fix is deterministic. Nothing runs unattended.

### X8. Dependencies, performance & cost — PASS [ADVISORY]
No new packages. F1 will draw every contour of a traced image (hundreds to low thousands of
Graphics); the P3 dirty-skip keeps drags cheap and this is the geometry that will be cut,
so drawing it is the requirement, not a cost. F2 raises point counts only for coarse-unit
SVGs (65 points for an 80 mm circle where today's px-unit files give ~124) and is capped.
Reading a dropped file twice is negligible for one-off imports.

---

## Stress tests

### Pre-mortem — three months out, this failed
1. **The laser cut mirrored text in the wrong place.** Cause: the mirror centre used
   `obj.transform` after the multi-select `flipObjects` branch had already moved `x` to the
   mirrored position (geometryActions.ts:499-503); combined with a Viewport that mirrors
   about the same moved box, screen and cut still agree, so nobody noticed until a part came
   out with the label offset by one box width. What we should have seen: the browser step
   "flip it horizontally, Convert to Path" only tests single-select. Add the multi-select
   flip (text + a rect selected, Ctrl+Shift+H) to the F5 browser step.
2. **A dropped PNG stopped opening the dialog.** Cause: must-fix 2 — a WebView where
   `File.arrayBuffer()` rejected (or a truncated PNG that threw inside the chunk walk) and
   the `.catch(console.error)` ate it. What we should have seen: no test for the read-failure
   path.
3. **Traced logos crawl on drag.** Cause: F1 now draws 3,000 contours and the P3 dirty-skip
   does not cover the case where the *outer* group is rotated via the Properties panel
   (every descendant dirty every keystroke). What we should have seen: the browser step
   rotates a three-letter group, not a real trace. Add "trace a 300 dpi logo, rotate by
   typing in Properties" to the F1 step and record the frame time.

### Load-bearing assumptions
1. **`composeGroupChild` composes a nested group correctly when called on a group child.**
   Verified (geometry/index.ts:441-457 takes the transform branch, leaves children
   group-local). High confidence. If wrong, the parity test would still pass (both sides
   share the bug) and the screen would match a wrong cut — but that is the cut we already
   produce today, and `flattenObjects.test.ts` covers it.
2. **The frozen-file set excludes `geometryActions.ts`, `Viewport.tsx`, `svgImport.ts`,
   `svgExport.ts`, `fileDrop.ts`, `imageImport.ts`.** Verified against the code-refresh
   TRIAGE (scratchpad `refresh/TRIAGE.md`, bucket D-machine: machine-*, rust-engine-*,
   core-12..15 only). The list is not in the tree; the orchestrator should confirm it once
   before Stage 1.
3. **The text box `transform.width` is the axis the Viewport mirrors about.** Verified
   (Viewport.tsx:1419-1421 and applyTextImageTransform 1156-1158). Medium confidence that
   it also equals the opentype layout width — it is a Pixi measurement, so mirrored glyphs
   may sit a font-metric's width off from where Pixi shows them. Pre-existing text-metric
   mismatch, not introduced here; worth a note in F5 Risk.
4. **`Blob.arrayBuffer` exists in the shipped WebView.** Safari 14+/Chromium; the macOS 12
   floor ships Safari 15. High confidence.

### Inversion — what would have to be true for a rejected alternative to win?
- **Cubic arcs instead of polylines** win if `pointsBBox` learned curve extrema. It has not
  (geometry/index.ts:192-214 is anchors-only and every box consumer reads it). Not true today.
- **Rerouting drop through `importImageData`** wins if the drop path did not need the
  layer picker and auto-trace. It does (ImageImportDialog is the only place they live).
  Not true today.
- **Negating the angle for flipped rectangles/ellipses in export** wins if the canvas or
  the cut honoured the flip. Neither does (`renderObject` never reads scale; `CutObject` has
  no scale). Not true today; the plan is right to drop it and list the inertness.
- **Fixing flip at the consumers (Rust/Viewport) instead of baking in `textObjectToPaths`**
  wins only if text reached the Rust engine as text. It never does — every path converts
  first — so the producer is the one place. Not true today.

---

## Overall verdict

Approve with the eight changes above folded in. The plan's diagnoses are correct and I
reproduced the two that matter most (mirrored/rotated text un-mirrors and spins per glyph;
arc sagitta of 3.045 mm in a normalised-viewBox SVG). The transform order is consistent
across the three engines that have an opinion, the effective-tolerance derivation is sound
under skew and non-uniform scale, the min→max radius change is the correct bound, and the
bake-into-points placement for text has no double-apply path. The must-fixes are: make the
F4→F5 coupling explicit so the "F5 is severable" claim stops being false for F4's text arm;
stop F3's new pre-dialog read from being able to cancel an import; correct the F2 test spec
(a `<path>`, and the measured red values 0.261 / 0.195); fix the baseline count (823); index
the Observed items in the Parking Lot; name or close the leaf-level visibility gap in the
loop being rewritten; and say that already-imported arcs are not migrated.
