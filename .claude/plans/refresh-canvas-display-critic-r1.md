# Critic review: refresh-canvas-display.md

Reviewer: separate critic subagent (Fable), 2026-09-22. Read against the tree at `bc87e45`
(worktree `session-8b2728`); Viewport.tsx and toolHandler.ts are unchanged since the plan's
base `67115ca` (`git diff 67115ca..HEAD --stat` touches only fileOps and geometry), so every
Viewport/toolHandler line number in the plan was checked as-is and holds. Baseline suite run
on this tree: **51 files, 823 tests, green** (90 s).

## Verdict: APPROVE WITH CHANGES

The seven diagnoses are correct against the code, every "red first" claim holds for the
reason stated, and the two formulas the plan hangs on (rotationPlacement, bakePathRotation)
check out algebraically and against Pixi 8.16 and gcode_gen.rs. What must change before the
relay starts is small and is listed under **Blocking** below; the rest is advisory.

---

## Applicability

**Project type:** desktop CAD/CAM app (Tauri/React/Pixi), UI rendering and hit-testing
layer. No file in the remediation-frozen set is edited.

| Dim | Fires? | Why | Tag |
|---|---|---|---|
| X1 Physical safety | **Yes** | F7 mutates stored path geometry (rotation folded into points), and stored geometry is what gcode_gen.rs cuts. Nothing else in the plan reaches G-code. | **GATING** |
| X2 Privacy | No | No personal, client or health data; project files are the operator's own designs. | N/A |
| X3 Evidence | No | Not research or public output. | N/A |
| X4 Audience/brand/money | No | Nothing client- or public-facing. | N/A |
| X5 Concurrency | Yes | Async Pixi init under StrictMode double-mount; async image decode with a module-level cache; module-level dirty set consumed by an effect that gains two new triggers. | ADVISORY |
| X6 Operability | Yes (weak) | Ships in the released app; failure evidence is console only. | ADVISORY |
| X7 Self-modification | No | Touches no MARVIN gate, hook or skill. | N/A |
| X8 Dependencies/perf | Yes | No new packages; but a new re-render trigger per decoded image and a per-frame text rebuild for template text. | ADVISORY |

---

## Core dimensions

### 1. Problem-fit — PASS
`## Intent (grilled)` present with a written skip line; the seven Summary outcomes map 1:1 to
F1–F7. No DECISIONS.md entry is contradicted: no G-code, serial, abort or power path is
touched; the "full feature set" ruling is unaffected. The one place the plan changes what an
operator sees beyond the bug (single-select rotate handle moves from ~75 px to 20 px) is
declared in Intent.

### 2. Approach soundness — PASS
- **F3 formula, checked.** Pixi maps local p to `position + R·S·(p − pivot)`. Recovering
  `x0 = x − pivotX·scaleX` is the unrotated origin whether the pivot is 0 (fresh object) or
  was set by an earlier placement (`c − c·1 = 0` for Graphics). For a Graphics/template
  Container (x = 0, scale 1) the result is `pivot = c, position = c` — the exact values
  Viewport.tsx:1189-1192 writes today, so those two types are byte-identical. For Text at
  `x = px` it yields `pivot = (pw/2, ph/2)`; for flipped Text at `x = px+pw, scale.x = −1` it
  yields `pivotX = pw/2` and local (0,0) lands on the rotated top-right — correct. For a
  Sprite with `scale = pw/texW` it yields `pivot = (texW/2, texH/2)` — the texture centre.
  Vector Graphics never carry a negative scale (flip on paths is baked into points,
  geometryActions.ts:440-448; rect/ellipse flip is stored but `renderObject` never reads
  scale), so the Graphics branch of the formula only ever sees scale 1.
- **Group children (focus item 2).** `composeGroupChild` (geometry/index.ts:410-457) hands
  the renderer a world-frame child: primitives get `x,y = rotated centre − w/2` and
  `rotation = r_g + r_c`; paths get rotated points, recomputed bbox and `rotation = r_c`.
  The renderer then applies that composed transform through `applyObjectRotation`, so the
  new formula fixes text/image children of rotated groups the same way it fixes top-level
  text/images, and leaves path/rect children (Graphics) byte-identical. Nothing in this plan
  changes composition itself.
- **F4, checked against Pixi.** `measureMixin._setWidth` is
  `scale.x = value/localWidth * (Math.sign(scale.x) || 1)` — sign-preserving, so the
  `*= -1` toggle on line 1144 un-flips a previously flipped sprite exactly as diagnosed.
- **F7 fold-at-first-edit** is the right choice among the three: fold-on-enter mutates the
  document without an edit and breaks under undo/redo while the tool is active; local-frame
  editing has no fixed point because every node move shifts the rotation centre.
- **F6** unit fix is correct; the ±6 px corner zones and 12 px rotate radius no longer
  overlap the edge-midpoint zones at 20 px offset (rotate zone spans 8–32 px above the edge,
  `n` zone ±6 px).

### 3. Completeness — CONCERN
- **F5 lifecycle gap.** `clearTextures()` "destroys everything and bumps a generation
  counter; a load that resolves under an old generation destroys its texture instead of
  caching it." If the stale resolution does not also *clear the pending mark* (or
  `clearTextures` does not forget pending/failed ids), `getReadyTexture(id)` returns null
  forever for that id — "returns null if a load for this id is pending". HMR is listed as a
  fixed case and is exactly the path that calls `clearTextures()` while loads are in flight
  (textureCache.ts keeps its module instance across a Viewport.tsx HMR). **Fix:** state
  that `clearTextures()` forgets pending and failed ids, and that a stale resolution also
  deletes its pending mark; add the test "start a load, `clearTextures()`, resolve, then
  `getReadyTexture` starts a *new* load (decode called twice)". Same for `evictTextures`: a
  load whose id was evicted while pending should destroy on resolve, not cache.
- **F7 writers: complete.** Every writer of `points` on the node-edit path is one of the
  four the plan names (toolHandler.ts:1546, 1646, 1682, 1761); the Delete/Backspace key
  routes through `deleteSelectedNode` (1913); no other file calls `pointsPartial` on a
  node-edit object. Node editing is top-level only (`store.objects.find`, and
  `handleNodeDown` enters only on `hitObj.type === "path"`, 1567), so a path *inside* a
  group cannot be node-edited and the rotated-path-in-rotated-group case does not arise.
- **F1 dependency claim: correct.** Only the camera effect (`[camera]`) reruns after init;
  grid/workspace/objects/drawing/overlay deps contain nothing init changes. Workspace size
  writers are the settings dialog, MachinePanel and connection.ts as stated.

### 4. Right-sizing & reuse — CONCERN
- Reuses `orientedHandlePoints`, `rotatePathPoint`, `pointsBBox`, `computeAABB`, the
  existing undo boundaries and the existing test harnesses. The two new modules are the
  right seams. Refusing the toolHandler split (core-18) is honoured.
- **No dependency graph, no batch waiver.** The relay touches 8 source files across four
  roots (`components/viewport`, `lib/tools`, `lib/geometry`, `lib/constants`) plus 8 test
  files, with an implicit order (F3 move-commit before F4/F5; F6 before F7 in toolHandler;
  F1/F2 independent). The rubric requires this stated. **Fix:** a five-line block: commit
  order F1, F2, F3(move), F3, F4, F5, F6, F7; independence: {F1, F2} free; F3→F4→F5
  sequential in renderHelpers.ts; F6→F7 sequential in toolHandler.ts; one waiver sentence
  ("one subsystem: DesignObject→Pixi translation; split would leave renderHelpers
  half-moved").
- **Parking Lot not named.** Out-of-scope items that are real deferrals (contentHash
  50-char sampling / image-replace-under-same-id refresh; JobPreview line widths; fileOps
  migration not switched to `bakePathRotation`; `getSelectionBBox`/`hitTest` rotation
  copies) should be indexed in `ROADMAP.md -> ## Parking Lot` (line 414) at relay-design
  3.5. Add the instruction.

### 5. Security — PASS
No secrets, auth, IPC or file-system surface. Data URLs decoded via `img.decode()` are the
same bytes already in the store.

### 6. Failure modes — PASS
Decode rejection → recorded failure → crossed-box placeholder wrapped in a Container, so the
`instanceof Graphics` vector path (Viewport.tsx:257) no longer wipes it. Pixi init failure →
`pixiReady` stays false, effects never run: same blank result as today, now with the guard
making it explicit. `scaleX === 0` guarded in `rotationPlacement`.

### 7. Change safety — PASS
Every fix is a separate commit; F3 and F5 open with a pure-move commit, which is the right
way to make the red-first proof meaningful. F7's bake sits inside the existing undo boundary
(`beginPropertyEdit` snapshots `objects` before the first `updateObject`, store/index.ts:431;
`withUndo` likewise, 411), so one Ctrl+Z restores rotation 30 and the original points — the
plan's claim holds.

### 8. Data integrity & compatibility — PASS (with one honest wording change, see X1)
- Saved files: a baked path is `rotation: 0` + synced bbox — the same shape
  `fileOps/index.ts:808-832` already writes for desynced rotated paths at load, and no
  `formatVersion` change, so old and new builds both load it.
- SVG export: `svgExport.ts:34-41` emits `rotate(r, cx, cy)` about the AABB centre — the
  same centre the bake uses — so a baked path exports the same geometry with no `transform`
  attribute.
- Single source of truth improves: one placement function, one px→mm conversion, one
  offset constant.

### 9. Verifiability — PASS
Every "fails today" claim was checked against the code (focus item 5):
- F1 case 1: workspace effect runs once at mount with `workspaceRef` null and its deps never
  change → zero `rect` calls today. Red.
- F2: `if (!gridVisible) return null` (Rulers.tsx:206) remounts both canvases; neither
  effect's deps change on toggle → new canvases never painted. Red.
- F3: text-like/flipped/sprite cases red because today's `pivot = position = c` puts local
  (0,0) at `c − R·c`; back-to-0 red because of the early return at 1187; Graphics case green
  today (regression guard). Correct.
- F4: moved-twice and flip-back red via the sign-preserving width setter; `toBe(false)`
  red because the function returns `undefined` today.
- F5: red because `getOrCreateTexture` returns synchronously.
- F6, each case recomputed: multi-select rotate at `bbox.y − 5.29 mm` is 14.7 mm from
  today's handle at `−20 mm` (radius 12) and 5.29 mm from the `n` edge (±6) → `"n"` today.
  5×5 rect centre (2.5, 2.5) → `"nw"` today (±6), null after (±1.587). Pen (14,10) is 4 mm
  from the start, under today's 8 mm and over the fixed 2.12 mm. Node (14,10) is 4 mm,
  under 6 today and over 1.59 after. All red for the stated reason.
- F7: visible0 for the 30° path is (19.51, 4.51), 10.98 mm from raw node 0 → null today.
  Red.
- **Existing tests (focus item 3):** the only two files that drive the pointer pipeline are
  `pathWriters.test.ts` and `src/lib/__tests__/creatorInvariants.test.ts`. Every press was
  checked: all are at exact handle positions or at body points ≥10 mm from any handle, so
  the smaller zones keep them green — except pathWriters:258, which the plan already
  names. `makePath("p1")` has bbox x 10–30, so top-centre is (20, 10) and the plan's
  replacement press `(20, 10 − screenPxToMm(20, 1))` is exactly on the new handle. The
  90°-rotated resize at :207 presses `ne` at (30, 30 + 6e-16) — still inside 1.587 mm.
- **F7 node hit at 30° rather than 90°** is the right choice; at 90° a rotated node lands on
  a different raw node and masks the defect.
- Fixtures are non-tautological (expected values from `rotatePathPoint`, not from the
  function under test; the Graphics regression case is a true guard).
- Minor: the plan cites the harness as `creatorInvariants.test.ts:846-930` without its
  directory; it lives at `src/lib/__tests__/`, not `src/lib/tools/__tests__/`.

### 10. Maintainability — PASS
Two named modules with one job each; `screenPxToMm` and `ROTATE_HANDLE_OFFSET_PX` remove the
duplicated magic; ARCHITECTURE.md delta deferred to `/save` J.2 because a concurrent agent is
editing it — acceptable, and stated.

---

## Conditional dimensions

### X1 Physical & human safety — CONCERN [GATING]
**Focus item 1, "G-code unchanged" — proven, with one precision caveat.** For a top-level
path, gcodeGen.ts:484-494 sends `points = sampleBezierPath(obj.points)` plus the transform's
`x, y, width, height, rotation`; gcode_gen.rs:1328-1338 rotates every sample about
`(x + width/2, y + height/2)` with the identical `cos/sin` convention as `rotatePathPoint`.
`bakePathRotation` rotates anchors *and handles* about the same centre and zeroes the field.
Rotation is an isometry and cubic Béziers are affine-invariant, and `flattenCubicInto`'s
flatness test (chord distance) is rotation-invariant, so sample-then-rotate and
rotate-then-sample produce the same polyline up to floating-point order of operations. The
maskFill coalescing branch (gcodeGen.ts:306-320) bakes about the same centre. Rust's
`rotate_segment` skips `|rotation| ≤ 0.001°` while the bake fires on `rotation !== 0`; the
difference is sub-micron. So: **the cut is unchanged to floating-point precision, and the
fixed-decimal G-code formatter absorbs that.** Say exactly that, not "unchanged".

**What is missing is the test that pins it.** The plan's bakePathRotation tests check the
geometry against `rotatePathPoint` and `computeAABB`; none checks the cut pipeline's own
sampler. **Fix (required):** in `bakePathRotation.test.ts`, for a path with bezier handles at
30°, assert `sampleBezierPath(bake(obj).points, closed)` equals
`sampleBezierPath(obj.points, closed).map(p => rotatePathPoint(p, cx, cy, 30))` within 1e-9,
point-for-point and same count. That is the one assertion that makes "what reaches the laser
does not change" a measured fact rather than an argument, and it is ten lines.

**Worst physical case named:** a bake about the wrong centre (e.g. a desynced legacy
transform) would cut a rotated part displaced from where the preview shows it. Both sides
use the transform centre, so a desynced file is displaced identically on screen and in the
cut — no new divergence — and `fileOps` already re-syncs desynced rotated paths at load.

**Hardware-only paths:** none; the plan says so explicitly and names the one owner desktop
check (F5 file-open). Correct.

### X5 Concurrency & re-entrancy — CONCERN [ADVISORY]
**Focus item 4, StrictMode.** Traced with the plan's design: mount#1 creates app#1 with its
own `disposed` closure; the simulated unmount sets it; mount#2 creates app#2 (`appRef` is
still null because it is assigned only in `.then`). When init#1 resolves, its `.then` returns
on `disposed`, so app#1 never appends a canvas or assigns a ref; its chained cleanup destroys
it and skips the `appRef` null-out. When init#2 resolves it assigns every ref, calls
`setCamera` then `setPixiReady(true)` (batched in React 18), and the six gated effects run
once against a live app. No effect can run against a destroyed app and the flag always
flips for the surviving mount; on a real unmount before init resolves the flag never flips
and nothing needs it. Both `init()` chains await the same dynamic-import promise and the same
microtask ladder, so init#1 resolves first in practice.

**The one soft spot:** the plan's cleanup clears `displayCacheRef`, `contentHashCache` and
(after F5) calls `clearTextures()` unconditionally. Under in-order resolution app#1's cleanup
runs before app#2 draws, so this is harmless — but it is only harmless by ordering. If the
order ever inverted (or a future `.then` is added before the guard), app#1's cleanup would
wipe app#2's caches and destroy its textures, and the next objects effect would append a
second copy of every display object. **Fix (advisory):** clear the caches only when
`appRef.current === app` (the app that owned them), i.e. inside the same guard that nulls the
ref. One line, and it removes the ordering dependence entirely.

**F6 zoom timing (focus item 3, second half):** `hitTestHandle` reads `store.camera.zoom` at
pointer-down (toolHandler.ts:506) and hover (Viewport.tsx:791); pen-close and node-hit read
it at click. During a pan the store camera is stale (P5 deferred write), but hover and
hit-testing are skipped while panning, and wheel-zoom writes the store immediately
(Viewport.tsx:698). Nothing reads zoom mid-drag. Correct.

**textureTick listener:** a single module-level listener set in a `[]` effect. It is set at
mount, before any objects effect can run (those wait on `pixiReady`), so no resolution is
lost; declare the listener effect above the objects effect anyway so the guarantee is
positional, not temporal.

### X6 Operability — PASS [ADVISORY]
Decode failure is visible (placeholder) and `console.error` on init failure is unchanged.
Nothing new is silent.

### X8 Dependencies, performance & cost — PASS [ADVISORY]
No new packages. One objects-effect rerun per decoded image (empty dirty set → every
Graphics re-rendered once) is acceptable at that frequency. Template text rebuilds per drag
frame — one Text rasterisation for a rare object type; the plan says so.

---

## Focus item 6 — sequencing against cut-vs-screen

Read `refresh-cut-vs-screen.md`. Its F1 replaces the group loop (Viewport 308-325) with
`composedLeaves`, deletes `renderKey`, and replaces the texture-id walk (337-346) with a
recursive `collectImageIds`; it does not touch the early-return guard, `ensureDisplayObject`'s
two branches, the eviction loop, or the dep list. This plan's four touch points in the same
effect are exactly the lines the other plan leaves alone, and `evictTextures(activeImageIds)`
still fits after `collectImageIds` produces the set. `applyObjectRotation` /
`applyTextImageTransform` / `renderImageObject` / `renderTextObject` are named disjoint by
both plans. The editing-shortcuts plan adds only a `switchTool` export to toolHandler.ts and
lists Viewport.tsx as out of scope. So the hunks are disjoint if the order is honoured.

**The instruction is not sufficient as written.** "Rebase onto the cut-vs-screen branch" names
no branch and has no check; the other plan says "whichever lands second rebases", which is a
different rule. If both relays start from master concurrently, the same effect is edited in
two worktrees and the second merge conflicts across lines 232-353. **Fix (required):** replace
the sentence with a precondition and a stop rule: "Before F1, confirm cut-vs-screen has
landed on the base you branch from: `grep -n composedLeaves src/lib/geometry/index.ts
src/components/viewport/Viewport.tsx` must hit both files. If it does not, stop and report;
do not start on a base without it." Then re-read line numbers, as the plan already says.

---

## Stress tests

### Pre-mortem — three months out, this failed
1. **The bake surprised someone (F7).** An operator rotated a traced part, nudged one node,
   saved, and later asked why the Rotation field reads 0 and the selection box changed shape.
   The cut was right the whole time. We should have seen it in the browser step ("Rotation in
   Properties now reads 0") and said it in the release note. Type-specific worst case (the
   laser cuts the wrong thing) does not occur: both the screen and the cut use the same
   centre; the equivalence test above is what makes that a fact.
2. **Images blank after HMR or a rapid file re-open (F5).** A load in flight when
   `clearTextures()` ran left its id marked pending forever; the operator saw an empty outline
   until restart. We should have seen it in the stale-generation test if it had asserted that
   a new load starts. That is the Completeness fix above.
3. **Merge conflict in the objects effect.** Both refresh relays started from master; the
   second `/save` conflicted across 232-353 and the resolver dropped the `pixiReady` guard.
   The bed was blank at launch again. The sequencing precondition above is the cure.

### Load-bearing assumptions
- **Pixi transform model `position + R·S·(p − pivot)`** — high confidence (verified by the
  plan's probe and consistent with `measureMixin`); consequence if wrong: every rotated
  text/image draws in the wrong place, caught by the renderHelpers tests on the first run.
- **`beginPropertyEdit` snapshots `objects` before the first `updateObject`** — verified
  (store/index.ts:431-434); the one-undo-step claim rests on it.
- **Both `app.init()` chains resolve in creation order** — high confidence, not guaranteed;
  the advisory cleanup guard removes the dependence.
- **The cut-vs-screen relay lands first** — an orchestration fact, not a code fact; the
  precondition check turns it into one.

### Inversion — what would make a rejected alternative win?
- *Fold on Node-tool entry* wins if the document already changes on tool entry elsewhere.
  It does not: `handleToolChange` only sets `nodeEditState`. Still rejected.
- *Per-type rotation branches* win if the types diverge in what "origin" means. They do not:
  the origin is always `position − S·pivot`, which is why one formula covers all four.
- *`Assets.load`* wins if URL-keyed caching were free. A data URL is megabytes and the
  comment at Viewport.tsx:32 says why that was refused. Still rejected.
- *Keep the 75 px single-select rotate handle* wins if operators have muscle memory for it.
  It has been at 75 px only because of the unit slip; the multi-select handle was always at
  20 px. The plan discloses the change. Acceptable.

---

## Blocking (fold into the plan before ExitPlanMode)

1. **Sequencing precondition.** Replace "rebase onto the cut-vs-screen branch" with the
   `composedLeaves` grep check on both files and a stop-and-report rule if it fails; note
   that the other plan's "whichever lands second rebases" is superseded for this pair.
2. **X1 equivalence test.** Add to `bakePathRotation.test.ts`: `sampleBezierPath` of the
   baked points equals the rotated `sampleBezierPath` of the originals (bezier path, 30°,
   closed) within 1e-9, same count. Reword the claim to "unchanged to floating-point
   precision".
3. **F5 pending-mark lifecycle.** Specify that `clearTextures()` forgets pending and failed
   ids and that a stale or evicted resolution deletes its pending mark; add the "new load
   starts after clearTextures" test (decode called twice).
4. **Dependency graph + batch waiver** (five lines, see dim 4), and the Parking Lot
   instruction for the named deferrals.

## Advisory

- F1: guard the cache clears (`displayCacheRef`, `contentHashCache`, `clearTextures()`) with
  `appRef.current === app` so a never-live app's cleanup touches nothing.
- F5: declare the `textureTick` listener effect above the objects effect.
- F2 test: build the fake 2D context as a Proxy that returns `vi.fn()` for any method
  (`scale`, `fillRect`, `beginPath`, `moveTo`, `lineTo`, `stroke`, `fillText`, …) rather than
  an enumerated list; the enumerated list is what breaks the next time Rulers gains a call.
- Done-when: "813 JS tests" is stale — this tree runs **823**. Replace with "the count
  measured at relay start, plus every new test"; a wrong number in a gate is worse than no
  number.
- F7 harness citation: `src/lib/__tests__/creatorInvariants.test.ts` (not under `tools/`).
- F7 UX note for the ROADMAP shipped entry: after the first node edit on a rotated path the
  object's hit box becomes the AABB of the rotated points (larger than the rotated frame).
  Not a defect; say it once.
- F6: the plan's "12/zoom" at toolHandler.ts:351 is literally `Math.max(12, 8) / zoom`;
  same value, but the implementer should replace the whole expression, not search for
  `12 / zoom`.
