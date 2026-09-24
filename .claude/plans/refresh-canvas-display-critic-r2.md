# Critic review, round 2: refresh-canvas-display.md

Reviewer: separate critic subagent (Fable), 2026-09-22, fresh eyes. Round 1 is at
`refresh-canvas-display-critic-r1.md`; its findings are not re-confirmed here. This round
hunts what the round-1 fixes introduced and what the sibling relay (cut-vs-screen) will do
to the same file.

Tree read: `c08527d` on `marvin/session-8b2728`. `git diff bc87e45..HEAD --stat` touches
only `.claude/DECISIONS.md`, `SvgImportDialog.tsx` and `keepAwake.ts`, so every Viewport,
toolHandler, geometry and gcodeGen line number in the plan still holds on this tree. The
plan's own precondition was run: `grep -n composedLeaves` hits neither file (exit 1), so
cut-vs-screen has **not** landed on this branch yet, which is the state the plan expects
before it starts.

One measurement was made (scratchpad only, no repo writes): the F7 sampler-equivalence
assertion, run against the real `sampleBezierPath`/`rotatePathPoint` with the
`makePath` fixture (two cubic segments, two straight, closed) at 30°, 17.3°, 45°, 90°,
123.456° and 0.0005°. Point counts equal and max deviation < 1e-9 at every angle. The
line-mode test the plan specifies is sound and will pass.

## Verdict: APPROVE WITH CHANGES

Three blocking items. None is a code redesign: one is a wrong symbol in the ordering gate,
one is a load-bearing claim about G-code that is false for fill modes, one is a test that
cannot fail. Everything else is advisory.

---

## Applicability

**Project type:** desktop CAD/CAM app (Tauri/React/Pixi), UI rendering and hit-testing
layer. No remediation-frozen file is edited.

| Dim | Fires? | Why | Tag |
|---|---|---|---|
| X1 Physical safety | **Yes** | F7 rewrites stored path geometry, which is what gcode_gen.rs cuts and fills. | **GATING** |
| X2 Privacy | No | Operator's own designs; no personal, client or health data. | N/A |
| X3 Evidence | No | Not research or public output. | N/A |
| X4 Audience/brand/money | No | Nothing client- or public-facing. | N/A |
| X5 Concurrency | Yes | StrictMode double-mount with async init; async decode with a module-level cache, generation counter and single listener slot; an effect that gains two new triggers. | ADVISORY |
| X6 Operability | Yes (weak) | Ships in the released app; evidence is console-only. | ADVISORY |
| X7 Self-modification | No | Touches no MARVIN gate, hook or skill. | N/A |
| X8 Dependencies/perf | Yes | No new packages (`@testing-library/react` 16.3.2 and `jsdom` 29 are already in package.json); one extra objects-effect run per decoded image. | ADVISORY |

---

## Core dimensions

### 1. Problem-fit — PASS
Intent present with a skip line; F1–F7 map to the Summary. No DECISIONS.md entry is
contradicted. The Intent's statement "What reaches the laser does not change" is
overclaimed for fill modes; that is filed under X1, where the fix is wording plus a
disclosure, not a change of approach.

### 2. Approach soundness — PASS
- **`appRef.current === app` guard, traced.** Mount#1 creates app#1 with its own
  `disposed` closure; StrictMode's simulated unmount sets it and chains cleanup on
  `initPromise#1`. Mount#2 sees `appRef.current` still null (it is assigned only in
  `.then`) and creates app#2. Whichever init resolves first: app#1's `.then` returns on
  `disposed` and never assigns a ref; app#1's cleanup destroys app#1 and skips the
  cache clears because `appRef.current` is null or app#2. App#2's `.then` assigns
  every ref, `setCamera`, then `setPixiReady(true)`. The real unmount's cleanup owns
  the ref and clears. Correct in both resolution orders. On init rejection, `pixiReady`
  stays false and the six gated effects never run: today's blank, now explicit.
- **F5 pending-mark lifecycle, traced against the plan's rules.** Generation captured at
  load start; `clearTextures()` empties pending and failed and bumps the generation;
  eviction forgets pending ids not in the active set; a resolution writes only if it is
  current-generation *and* still pending, deleting its own mark first. Every path I could
  construct ends either in a cached texture plus a listener call, a recorded failure plus
  a listener call, or a forgotten id whose next `getReadyTexture` starts a fresh load:
  HMR (clear with loads in flight), remount, undo-delete (evict then re-add), duplicate
  render before resolve (pending dedup), and resolve-after-evict. No permanent blank
  from the cache's own state machine. Texture ownership: a stale or evicted resolution
  is told to destroy rather than cache; a cached texture is destroyed by eviction or
  `clearTextures()`; the F1 guard means only the owning app's cleanup calls
  `clearTextures()`, so a never-live StrictMode app cannot destroy the live app's
  textures. No leak found. Two residual blank paths are external to the cache and are
  advisory below (a `decode()` that rejects on a decodable image; a `decode()` that
  never settles).
- **Listener effect above the objects effect** is a positional guarantee; the objects
  effect cannot start a load before `pixiReady`, and `pixiReady` flips after mount. Under
  StrictMode the `[]` listener effect is set, nulled and set again before any load. Fine.
- **F3/F4 idempotence re-checked with the new `placeSprite`.** `placeSprite` resets pivot
  and rotation before writing width/height/sign/x, so the recovery formula
  `x0 = x − pivot·scale` is exercised only on the Graphics re-render path, where it
  yields 0 as required. For a flipped sprite, `pivotX = (cx − (px+pw))/(−pw/texW) =
  texW/2`: the texture centre, which is what a flipped-and-rotated image needs.
- **F7 fold-at-first-edit**: `pointsPartial(bakePathRotation(obj), newPoints)` spreads the
  baked transform, so rotation 0 is written together with the rotated points on the
  first frame; without the bake as the base, `pointsPartial` would spread rotation 30
  onto rotated points and double-rotate. The plan has it right; the note here is so the
  implementer does not "simplify" it to `pointsPartial(obj, …)`.

### 3. Completeness — PASS
The four node writers are still the only `points` writers on the node path; the
Delete key routes through `deleteSelectedNode`; `handleToolChange` (1878-1885) enters
node edit only on `type === "path"`, so the bake never meets a line or a group child.
F5's `renderImageObject` covers ready / pending / failed, and the fast path returns
`false` for the failed placeholder Container so it is rebuilt at the new position on a
drag rather than wiped.

### 4. Right-sizing & reuse — PASS
Dependency graph and batch waiver present: nine commits, two move commits, independence
stated per pair, one-subsystem waiver with a reason (a split would leave
`renderHelpers.ts` half-moved and make two relays edit the same effect). Five Parking Lot
lines named with sources. 8 source files across four roots is over the eight-file line
only with tests counted, and the waiver covers it. One sequencing detail is advisory (F5
move commit and the two `textureCache` loops that stay behind in Viewport).

### 5. Security — PASS
No secrets, auth, IPC or file-system surface.

### 6. Failure modes — PASS
Decode rejection → placeholder; init rejection → explicit never-ready; `scaleX === 0`
guarded; pending returns null and draws nothing rather than an empty texture.

### 7. Change safety — PASS
One commit per step with its own red proof; both moves are pure-move commits; the F7 fold
sits inside the writers' existing undo boundaries (`beginPropertyEdit` is called in
`handleNodeDown` before any update, `withUndo` wraps delete and toggle), so one Ctrl+Z
restores the rotated path.

### 8. Data integrity & compatibility — PASS
A baked path is `rotation: 0` plus a synced bbox, the exact shape the load migration
(`fileOps/index.ts:812-831`) already writes with the same centre and the same
`rotatePathPoint`; no `formatVersion` change; old and new builds load either form.

### 9. Verifiability (incl. testing the tests) — CONCERN
- **The `appRef.current === app` guard has no test that can fail.** F1 Case 2 says
  "resolve both inits in order" and then asserts the live app's caches were not cleared.
  In-order, app#1's cleanup runs the moment init#1 resolves, which is before init#2 has
  assigned any ref or drawn anything: the caches it would clear are already empty. A
  build with the guard and a build without it both pass Case 2. The guard exists for the
  out-of-order case, so the test must construct it. **Fix:** add Case 3: resolve init#2
  first, `act` an `addObject` so app#2 has one display object and a populated
  `displayCacheRef`, then resolve init#1 and flush its cleanup; assert `appRef` (via
  behaviour: the next `objects` update adds no second display object for the same key,
  and the live app's `destroy` spy was not called). Red proof: temporarily drop the guard
  and show the duplicate.
- Everything else re-checked holds: the F6 positions (radii 12 px / 6 px at zoom 1 →
  5.29 mm rotate offset, 1.587 mm half-zone; the 4 mm probes fall between today's and the
  fixed thresholds), the F7 visible0 (19.51, 4.51) at 30° being 10.98 mm from raw node 0
  and 21.2 mm from raw node 1 so `null` today is unambiguous, and the sampler
  equivalence measured above. The workspace default is 500×300
  (`store/index.ts:357-358`), so Case 1's `rect` assertion is right. `hitTestNodeHandles`,
  `deleteSelectedNode`, `handleViewportDoubleClick` and `hitTestHandle` are all exported
  (toolHandler.ts:347, 1494, 1659, 1687), so the tests can call them.
- Minor: the F1 Pixi fake. Viewport calls `rect`, `fill`, `setStrokeStyle`, `moveTo`,
  `lineTo`, `stroke`, `circle`, `closePath`, `clear`, `removeChildren`, `addChild`,
  `addChildAt`, `removeChild`, `destroy` on Graphics/Container. Build the fake the way F2
  builds its 2D context (a Proxy returning cached chainable spies) for the same reason
  the plan gives there: an enumerated list breaks on the next call Viewport gains.

### 10. Maintainability — PASS
Two named modules, one conversion, one constant; ARCHITECTURE.md delta deferred to `/save`
J.2 and stated.

---

## Conditional dimensions

### X1 Physical & human safety — CONCERN [GATING]
**The G-code claim is false for fill modes, and the plan does not know it.** The sampler
test proves the *line-mode outline* is unchanged to floating-point precision, and the
measurement above confirms it. But the maskFill arm (gcode_gen.rs:1152-1190) and the fill
arm (882-975) compute the hatch angle as `obj.rotation + layer.scan_angle + pass·increment`,
rasterise `obj.paths` **un-rotated** inside `obj.x/y/width/height`, and rotate each output
coordinate about the bbox centre (mask_fill.rs:186-249, 899-928). For a top-level rotated
path this means:

- before the bake: the hatch runs at the layer's scan angle *relative to the part* (it
  rotates with the object), on a raster grid aligned to the unrotated bbox;
- after the bake: rotation is 0, so the hatch runs at the layer's scan angle *in the
  machine frame*, on a world-aligned grid over the AABB of the rotated points.

Same region (to the raster interval), same power and speed, different hatch direction and
line phase. Not a hazard: nothing is cut outside the part and nothing gains energy. But
"what reaches the laser does not change" and "G-code unchanged to floating-point
precision" are not true of a fill or fillLine layer, and the plan's X1 argument leans on
them. There is precedent for exactly this behaviour: a rotated path *inside a group*
already fills at the machine-frame angle, because gcodeGen.ts:306-320 bakes child rotation
into the samples and emits rotation 0, and the load migration bakes desynced rotated paths
the same way. So the bake makes a top-level path behave like every grouped path already
does.

**Fix (required, wording and disclosure, not code):** in Intent, F7 and the ROADMAP shipped
note, state: "the cut outline is unchanged to floating-point precision (pinned by the
sampler test); on fill, fillLine and maskFill layers the hatch direction changes from
part-relative to machine-relative after the first node edit on a rotated path, which is
what a grouped or load-migrated path already does; the filled region, power and speed are
unchanged." Name the worst physical case as it is: none, the same area at the same power
with a different hatch angle. Do not add a test asserting fill equality; it would be
asserting a falsehood.

**Worst physical case for the outline** (a bake about the wrong centre on a desynced
legacy file) is correctly analysed: screen and cut both use the transform centre, so no new
divergence, and fileOps already re-syncs at load. Hardware-only paths: none; the one
owner step (F5 desktop file-open) is named.

### X5 Concurrency & re-entrancy — PASS [ADVISORY]
Both resolution orders traced above. Texture-tick reruns during a drag: the pending image
has no cache entry so the dirty-skip (which gates only existing entries) cannot hide it;
`markDirty` and `updateObject` are synchronous in the same handler, so a tick render
cannot slip between them and eat the dirty set. A single listener slot is enough: there
is one Viewport.

### X6 Operability — PASS [ADVISORY]
Placeholder is visible; init failure logs as today.

### X8 Dependencies, performance & cost — PASS [ADVISORY]
No new packages. One objects-effect run per decoded image; template text rebuilds per drag
frame, disclosed.

---

## The ordering precondition against cut-vs-screen

The sibling plan's F1 was re-read as it stands now (with its round-1 fixes). Its Viewport
loop is not `composedLeaves`: step 3 replaces the loop body, **including today's top-level
`visible` and `layers[obj.layerIndex]` checks**, with
`for (const leaf of drawnLeaves(obj, layers)) ensureDisplayObject(leaf.key, leaf.obj);`,
deletes `renderKey`, and (step 4) replaces the texture-id walk with a recursive
`collectImageIds`. `composedLeaves` and `drawnLeaves` both land in `geometry/index.ts`;
only `drawnLeaves` is called from Viewport.tsx. Its F6 changes `reorderLayers` in
`store/index.ts`, which this plan never touches.

**Consequences for this plan:**

1. **The precondition grep names the wrong symbol for Viewport.tsx.** On the intended
   base, `grep -n composedLeaves src/components/viewport/Viewport.tsx` will not hit
   (unless a comment happens to mention it), so the stop rule fires on the very base it
   was written to accept. A stop rule that always fires is one an implementer learns to
   override, and the override is the merge-conflict scenario the rule exists to prevent.
   **Fix (required):** grep `composedLeaves\|drawnLeaves` in `geometry/index.ts` and
   `drawnLeaves` in `Viewport.tsx`; both must hit. Correct the Context paragraph that
   says the sibling "replaces the group loop with `composedLeaves`".

2. **Per-leaf visibility survives this plan as written.** The plan's four touch points in
   the objects effect (the guard at the top, the two branches inside
   `ensureDisplayObject`, the final eviction loop) and its dependency-list edit are all
   outside the loop body that `drawnLeaves` occupies. `evictTextures(activeImageIds)`
   consumes whatever set `collectImageIds` builds, which walks every object regardless of
   visibility, as today; a hidden pending image is therefore never evicted and never
   loaded, and loads the moment its layer is shown. Nothing here re-introduces a
   top-level visibility check. **Say so in the plan** (one sentence under Context): "no
   hunk in this plan touches the `drawnLeaves` loop; the per-leaf visibility rule and
   the `l.index` layer lookup are the sibling's and stay". That sentence is what stops a
   Ted who is re-reading moved line numbers from pasting the old loop back.

3. **Layer remapping (sibling F6)** is in `store/index.ts` and is disjoint. The overlay's
   `layers[sel.layerIndex]?.color` read (Viewport.tsx:383) is untouched by both plans.

4. **Text and image children of groups** come out of `drawnLeaves` through
   `composeGroupChild` with a composed transform, and this plan's `rotationPlacement`
   then places them; the two fixes compose rather than collide.

---

## Stress tests

### Pre-mortem — three months out, this failed
1. **An operator engraved a rotated traced part after nudging one node and the hatch came
   out at a different angle than the last run.** Nothing was wrong with the part; the
   hatch followed the machine frame instead of the object. We would have seen it in the
   X1 finding above if the fill arms had been read; the plan only read the line arm. Fix
   is disclosure. Type-specific worst case (the laser cuts the wrong thing) does not occur.
2. **The precondition stopped the relay on the correct base, Ted overrode it, and the
   relay started before cut-vs-screen had merged.** The two edits to the objects effect
   conflicted at `/save` and the resolver dropped the `pixiReady` guard: bed blank at
   launch again. Cure: grep the symbol that will actually be in Viewport.tsx.
3. **A later refactor moved the cache clears out of the ownership guard and nothing went
   red.** The in-order StrictMode test cannot see the guard. Cure: the out-of-order case.

### Load-bearing assumptions
- **Pixi transform model `position + R·S·(p − pivot)`** — high confidence (measureMixin,
  plan probe); the renderHelpers tests catch it on first run if wrong.
- **`drawnLeaves(obj, layers)` is what the sibling puts in Viewport.tsx** — verified
  against the sibling plan text as it stands; if the sibling's implementer renames it,
  the grep must follow. Resolve at relay start by reading the merged Viewport.tsx, which
  the plan already requires.
- **maskFill's hatch angle includes `obj.rotation`** — verified in gcode_gen.rs:1171-1178
  and mask_fill.rs:76-78; consequence if wrong is only that the disclosure is
  over-cautious.
- **In-order init resolution in StrictMode** — no longer load-bearing once the guard is
  in; the missing test is what would let it become load-bearing again unnoticed.

### Inversion — what would make a rejected alternative win?
- *Keep the rotation and edit in a local frame* (F7) wins if fill hatch must stay
  part-relative after a node edit. It does not today for any grouped path, and no ruling
  asks for it; the disclosure is the right cost. Still rejected.
- *Fold on Node-tool entry* wins only if the document already mutates on tool entry. It
  does not (`handleToolChange` sets `nodeEditState` only). Still rejected.
- *`Assets.load`* wins if URL-keyed caching of megabyte data URLs were free. It is not
  (Viewport.tsx:32). Still rejected.
- *A separate relay per module* wins if the two relays could be kept off the same effect.
  They cannot: F1 and F5 both edit the objects effect. The waiver stands.

---

## Blocking (fold into the plan before ExitPlanMode)

1. **Precondition symbol.** Grep `drawnLeaves` in `Viewport.tsx` (and
   `composedLeaves\|drawnLeaves` in `geometry/index.ts`); correct the Context paragraph
   that names `composedLeaves` as the Viewport loop; add the one-sentence statement that
   no hunk in this plan touches the `drawnLeaves` loop or its visibility rule.
2. **Fill-mode G-code claim.** Reword Intent, F7 and the ROADMAP shipped note: outline
   unchanged to floating-point precision (pinned); on fill/fillLine/maskFill layers the
   hatch direction becomes machine-relative after the first node edit on a rotated path,
   as it already is for grouped and load-migrated paths; region, power and speed
   unchanged. Name the worst physical case honestly (none).
3. **Falsifiable guard test.** Add F1 Case 3 with out-of-order resolution (init#2 first,
   draw an object, then init#1 and its cleanup) and assert no duplicate display object
   and no destroy of the live app; record the red proof with the guard removed.

## Advisory

- **F5 move commit is not pure as described.** `textureCache` is iterated directly by the
  eviction loop (Viewport.tsx:347-352) and by the F1 cleanup (which commit 1 keeps "as the
  existing texture-cache clear"). The move commit must either export the Map or ship
  `evictTextures`/`clearTextures` at that step and switch both call sites. Say which, so
  the red-first proof for F5 is against a compiling tree.
- **`decode()` rejection on a decodable image.** Chromium's `HTMLImageElement.decode()`
  can reject for images it will still display (very large sources). Before recording an
  id as failed, check `img.complete && img.naturalWidth > 0`; if true, treat it as
  loaded. Otherwise a valid large image shows the crossed box.
- **No timeout on pending.** A `decode()` that never settles leaves that id blank for the
  session. Acceptable at this frequency; state it in F5 Risk so it is a known behaviour
  rather than a surprise.
- **F1 Pixi fake as a Proxy** (see dim 9), for the same reason the plan gives for the F2
  context fake.
- **F7 test harness.** `assertPointsInvariant` lives in
  `src/lib/geometry/__tests__/pointsInvariant.ts` and creatorInvariants imports it from
  there; "do not import across directories" should exempt that shared helper rather than
  have the new test copy it.
- **Evidence for the ledger, not a finding:** sampler equivalence measured green at six
  angles including a sub-threshold 0.0005° and an exact 90°; the F7 line-mode test as
  specified will pass first time.
