# Critic review (round 2): refresh-cut-vs-screen

**Plan:** `.claude/plans/refresh-cut-vs-screen.md` (revised after round 1, `refresh-cut-vs-screen-critic-r1.md`)
**Reviewed:** 2026-09-22, Fable, fresh critic, against the tree at `c08527d` (clean).
**Scope of this round:** round-1 findings are not re-confirmed. This pass hunts second-order and
new-content problems: F6 and its sibling class, the `drawnLeaves` rule, the F5 -> F4 ordering
and the dependency graph, and whether the F3 failure-path guards can be shown red.
**Method:** every store writer and reader of `layerIndex` opened (`grep -n layerIndex` across
`src/app`, `src/lib`, `src/components`); F6, the undo interaction and the empty-layers load were
run through the real store in a scratch vitest config (scratchpad `r2-probe/`, node_modules
symlinked, no repo writes). Values quoted below are from that run.

## Verdict: APPROVE WITH CHANGES

No gating dimension fails. F6's defect reproduces exactly as diagnosed, and it is the only
`layerIndex` *writer* in the store with the one-level assumption. Two second-order items need a
sentence or a line each before implementation, and one failure-mode guard needs a one-line change
in the `drawnLeaves` spec.

**Blocking findings:** none.

**Must-fix before implementation (advisory, in priority order):**

1. **`drawnLeaves` must not throw on a project whose `layers` array is empty.** The spec
   copies the cut's `(layers.find(l => l.index === o.layerIndex) || layers[0]).visible`. With
   `layers: []` that expression throws (probed: it does), and a throw inside the Viewport's
   render `useEffect` is the blank-canvas failure class this project already carries a rule
   for. Today's loop guards it (`objLayer && !objLayer.visible`, Viewport.tsx:310-311) and
   draws. `parseAndValidateProject` accepts `layers: []` (`Array.isArray` only,
   fileOps/index.ts:38) and `loadProject` stores it as-is (probed: loads). The cut throws on the
   same file, so there is no rule to match; the render must degrade, not crash. Fix: in
   `drawnLeaves`, `const ll = layers.find(...) ?? layers[0]; if (ll && !ll.visible) continue;`
   and say in the docblock that an absent layer draws (the cut has no defined behaviour there).
   Add fixture (i) to the `drawnLeaves` test: `layers = []`, expect every leaf drawn, no throw.
2. **Undo after a layer reorder puts every object back on the pre-reorder index, which now
   names a different layer.** `reorderLayers` is not `withUndo`-wrapped and remaps `objects`
   in place; every earlier undo entry holds an `objects` snapshot with the *old* indices, and
   `undo()` restores the snapshot wholesale against the reordered `layers`
   (store/index.ts:96-105). Probed: a rect on Engrave (index 1 after `reorderLayers(0, 1)`)
   reads index 0 = **Score** after one Ctrl+Z of an unrelated move. That is the exact symptom
   F6 closes ("silently picking up another layer's power and speed"), through a different door,
   and it hits top-level objects too. Pre-existing and out of this plan's scope, but F6's Risk
   line "Undo is unaffected" hides it. Fix: reword that line to state the hazard, and add a
   Deferrals line: "Undo across a layer reorder restores stale `layerIndex` values against the
   reordered layers (reorder is not undoable and object snapshots carry raw indices); every
   object, grouped or not, can silently change layer. Fix is either an undoable reorder that
   snapshots layers + objects together, or index remapping at restore."
3. **The F3 "deliberately wrong variant" is not literally constructible; name one that is.**
   The plan says the implementer proves the two failure guards can fire by "temporarily moving
   the `openImageImport` call inside the `try`". `openImageImport` is reached through
   `FileReader.onload -> Image.onload -> import("../app/App")` (fileDrop.ts:27-42), so it
   cannot be moved into a `try` around `await file.arrayBuffer()`. The variant that does fire
   both guards is `catch { return; }` (detection failure aborts the import). State that. With
   it, case 3 (rejected `arrayBuffer`) and case 4 (`detectImageDpi` throws once) both time out
   in `vi.waitFor(() => expect(openImageImport).toHaveBeenCalled())`, which is the red the plan
   wants.
4. **F6's store test must reset `layers` itself.** `store.test.ts`'s `beforeEach` resets
   `objects`, `selectedIds` and the undo stacks only (store.test.ts:24-31), and the existing
   `reorderLayers swaps layer positions` test (line 59) leaves the store's layers swapped for
   every later test in the file. The plan's assertions are index-only, so they still hold, but
   the fixture is order-dependent. One line: `useStore.setState({ layers: DEFAULT_LAYERS })` at
   the top of the new test (`DEFAULT_LAYERS` is already imported there).
5. **Index the read-side siblings of the F6 class, which F1 makes operator-visible.** No other
   *writer* of `layerIndex` has the one-level assumption (sweep below). Four *readers* do:
   `selectByLayer` (store/index.ts:697-706), the Layers panel's per-layer object list and count
   (LayerPanel.tsx:155-156), its selected-highlight (LayerPanel.tsx:172) and the Properties
   panel's layer indicator (PropertiesPanel.tsx:113). All filter top-level `objects`. After F1,
   hiding a layer removes grouped children that the Layers panel lists under *no* layer
   ("Cut: 0 objects", hide Cut, half a group disappears). Selection is top-level by design, so
   this is a Deferrals line, not a fix: "Layers panel counts, select-by-layer and the
   Properties layer badge read top-level objects only; grouped children on another layer are
   honoured by the cut and (after F1) the canvas but never listed. Noted 2026-09-22."

Everything else is PASS or a PASS with a note. Dimension detail follows.

---

## The F6 sibling sweep (requested)

Every site that writes or reads `layerIndex`, with what it assumes about depth:

| Site | Kind | Depth handling | Verdict |
|---|---|---|---|
| `reorderLayers` (store/index.ts:309-333) | writer | top-level `state.objects.map` only | **The defect.** Probed: depth-2 group all on layer 0, `reorderLayers(0, 1)` gives outer `1`, inner `0`, grandchildren `[0, 0]`, the depth-1 sibling rect `0`. Note the depth-1 child is stale too, not only depth 2; F6's recursive `remap` covers both. |
| `moveObjectsToLayer` (217-246) | writer | `collectDescendantIds` + `applyPartialsDeep` (unbounded) | fine; flattens a mixed group onto one layer, which is its intent |
| `updateObject` / `updateObjects` (185-215) | writer | `applyPartialsDeep`, any depth | fine |
| `loadProject` (465-470) | writer (layers) | takes `project.layers` as-is; no index remap of objects at load | no remap needed; no migration ever renumbers layers. No add/delete-layer action exists in the store (`grep deleteLayer\|addLayer`: none), and `DEFAULT_LAYERS` has been 6 since the initial commit, so there is no layer-count shrink path to remap through. `migrateSubLayersToFillLine` (fileOps/index.ts:607+) rewrites layer *fields*, never indices or count. |
| Paste Ctrl+V / Alt+V (shortcuts.ts:99-130) | copier | spreads the object, children included, with their own indices | consistent at every depth |
| `duplicateInPlace` (store/index.ts:731-745) | copier | `deepCloneObject` recurses | consistent |
| Variable Text (geometryActions.ts:862-940) | producer | clones the template, `textObjectToPaths` spreads `...obj` into every contour and passes `obj.layerIndex` to `buildGroupObject` | consistent |
| `groupSelected` (549-570), `ungroupSelected` | producer | group takes `selected[0].layerIndex`, children keep their own | consistent, and the plan states it |
| Importers (Svg/Trace/PDF/DXF/`multiPolygonToObjects`) | producer | one index for group and children | consistent |
| `undo` / `redo` (60-117) | writer (snapshot restore) | restores raw `objects` snapshots against whatever `layers` is now | **the undo hazard, must-fix 2** |
| `selectByLayer`, LayerPanel list/count/highlight, PropertiesPanel badge | readers | top-level only | must-fix 5 (Deferral) |
| gcodeGen (frozen), `flattenObjects` | reader | per leaf via `l.index` | the reference rule |
| Viewport (308-311) | reader | top-level via `layers[obj.layerIndex]` (position) | F1 replaces it |

`buildObjectsById` is top-level only by documented intent (store/index.ts:122-123), so
`objectsById.get(childId)` is never expected to work; nothing in F6 needs it.

Two properties the plan relies on, both verified: `reorderLayers` has renumbered
`index === position` since it was introduced (e9151ff, same body), so positional lookups
(`layers[obj.layerIndex]`, `state.layers[layerIndex]?.color`) and `l.index` lookups agree on
every file this app has written; and the `Layer` type carries `visible` and `output` with
defaults `true` (types.ts:240-243), so the hidden-layer and output-off fixtures in the
`drawnLeaves` test are valid `Layer`s.

## `drawnLeaves` versus the cut's filter (requested)

gcodeGen's vector loop (gcodeGen.ts:275-279): `!obj.visible -> skip`; `layer = find by
l.index || layers[0]`; `!layer.visible || layer.output === false -> skip`. The image loop
(624-630) is the same rule with `imageData` required. `flattenObjects` (203-219) never reads a
group's own `visible` or `layerIndex`; it only stamps `groupId`. So the cut's rule is exactly
per-leaf `visible` + leaf layer by `l.index` with the `layers[0]` fallback + `output`.

`drawnLeaves` as specified: `composedLeaves` (same recursion, same `composeGroupChild`), filtered
on `!leaf.visible` and leaf-layer hidden by `l.index` with the `layers[0]` fallback, and
deliberately **not** `output`. That matches the cut on `visible`, on the layer lookup, and on
the fallback. Three residual differences, all correct or already stated:

- `output === false` stays drawn. Right call. The toggle's own tooltip is "Disable output (won't
  cut)" (LayerPanel.tsx:325-326), which is the LightBurn-shaped mental model (Show hides, Output
  excludes from the job) and is what today's canvas does. Hiding output-off geometry would take
  away the one way to keep a reference outline on screen. Pinned by fixture (h).
- Text objects are drawn and not cut (the cut warns and skips, gcodeGen.ts:280-283). Standing
  exception, not visibility; the operator converts to path. Out of scope, correctly.
- The empty-`layers` case: the cut throws, the spec throws, today's render draws. Must-fix 1.

The Intent sentence is scoped correctly ("hidden or sit on a hidden layer"), so the plan never
promises output-off parity.

## F5 -> F4 ordering and the dependency graph (requested)

Holds. F4's text arm exports a mirrored `<text>`; the cut honours a text mirror only after F5
bakes it into `textObjectToPaths` (verified in round 1 and re-read: `textObjectToPaths` spreads
`...obj.transform` into each contour, geometryActions.ts:246-252, so `scaleX: -1` is carried
but never applied). The image arm is independent because the Rust image engine already flips.
So the arrow is F5 -> F4 (text arm only), and the plan's fallback (drop the `text` condition and
case (b)) is the correct severance.

The other five arrows: F1, F2, F3, F6 independent of each other and of F5/F4 in *source* (the
only shared file is `geometry/index.ts`, F1 and F2 adding exports in disjoint places, as
stated). Two soft couplings that are not source dependencies and are handled: F1's per-leaf
check makes F6's staleness visible on the canvas (the plan says so), and F6's browser step
"Hide Engrave: the whole group disappears, children included" only exercises F6 once F1 is in
(before F1 it passes for the wrong reason). The suggested order F1, F2, F3, F5, F4, F6 puts F1
before F6, so the browser step is meaningful. No cycle, no hidden arrow.

## The F3 failure-path guards (requested)

Cases 3 and 4 pass on today's code (nothing reads the bytes), so they are guards, not red-first
tests, and the plan says so. The "prove it can fire" step is the right instrument, but the
variant named is not constructible (must-fix 3). With `catch { return; }` as the variant: case 3
(`Object.defineProperty(file, "arrayBuffer", { value: () => Promise.reject(...) })`, own
property shadows the prototype, and jsdom's `FileReader.readAsDataURL` reads the impl buffer,
not that method, so the happy path still opens the dialog) and case 4 (`mockImplementationOnce`
throw on the `importOriginal`-wrapped `detectImageDpi`) both stop before `openImageImport`, and
`vi.waitFor` times out. Red for the stated reason. Module ids check out: the test at
`src/lib/__tests__/` mocks `"../../app/App"` and `"../fileOps/imageImport"`, which are the same
modules fileDrop reaches by `"../app/App"` and `"./fileOps/imageImport"`.
`imageImport.ts` imports only the store and a constant (imageImport.ts:1-3), so the new static
import into fileDrop adds no Tauri plugin load.

---

## Applicability

**Project type:** desktop CAD/CAM app (Tauri/React/Pixi/Rust) whose output is laser G-code. The
revised plan changes cut geometry (F2 density, F5 mirrored/rotated text), what the canvas draws
and hides (F1), the physical size of dropped images (F3), an export file (F4) and, new since
round 1, which layer's power and speed grouped parts cut with after a reorder (F6). No control
path, serial code or frozen file is touched.

| Dim | Fires? | Why | Tag |
|---|---|---|---|
| X1 Physical & human safety | **Yes** | F6 changes which layer's power/speed/passes a grouped part is cut with; F5 moves text geometry; F2 changes point density. | **GATING** |
| X2 Privacy & data | No | No personal, client or child data; dropped bytes are read for one PNG chunk. | N/A |
| X3 Evidence & source | No | Not research or public claims. | N/A |
| X4 Audience/brand/money | No | Nothing client- or public-facing. | N/A |
| X5 Concurrency | Yes | F3's extra async read on a multi-file drop; F1's per-frame loop. | ADVISORY |
| X6 Operability | Yes | Released desktop app; the DPI label is the field evidence. | ADVISORY |
| X7 Self-modification | No | No MARVIN gates, hooks or skills. | N/A |
| X8 Dependencies/perf/cost | Yes | No new packages; F1 draws every traced contour. | ADVISORY |

---

## Core dimensions

### 1. Problem-fit — PASS
`## Intent (grilled)` with a skip note; F5 and F6 are labelled as additions with their
provenance. F6 is squarely inside the Summary's last sentence. Checked against DECISIONS.md at
`c08527d`: no entry touches layer indexing, group composition, import tessellation or SVG
export; the 2026-06-21 drift ruling is respected (round 1). Nothing here contradicts the
2026-09-10 rulings on M4 defaults, feature envelope or the geometry program.

### 2. Approach soundness — PASS
F6's recursive `remap` through the same `indexMap` is the smallest correct change and matches
the depth model the rest of the store already uses (`applyPartialsDeep`, `collectDescendantIds`,
`markDescendantsDirty`). `drawnLeaves` as a pure function beside `composedLeaves` is the right
seam: the Viewport cannot drift from the rule because it no longer owns it. The rest was judged
sound in round 1 and nothing in the revision changes it.

### 3. Completeness — CONCERN
The F6 class is closed on the writer side (sweep above: one writer, fixed). Two named gaps:
the undo restore path reintroduces the same symptom for every object (must-fix 2, Deferral),
and the read-side siblings become visible after F1 (must-fix 5, Deferral). Both are one line
each.

### 4. Right-sizing & reuse — PASS
The dependency graph, batch order and file-count waiver requested in round 1 are present and
correct (12 source files, six commits, one real arrow). Out-of-scope items are named and the
Deferrals section now routes them to the Parking Lot heading that exists in the ROADMAP
(`## Parking Lot — every deferral, one index`, ROADMAP.md:414). F6 reuses nothing it should
not; a recursive local `remap` is the right size.

### 5. Security — PASS
Unchanged from round 1. F6 adds no surface.

### 6. Failure modes — CONCERN
- `drawnLeaves` on `layers: []` throws inside a render effect (must-fix 1). The plan inherited
  the cut's expression verbatim and with it the cut's undefined behaviour on a malformed file,
  on a path that today degrades gracefully.
- F6 on a child whose `layerIndex` is not in `indexMap` (an orphan index from a hand-edited
  file): `?? o.layerIndex` keeps it, same as top-level today. Fine.
- F3's read-failure paths are now guarded and tested (round 1's finding, folded in correctly).

### 7. Change safety — PASS
One commit per fix; F6 is a pure remap with no persisted-format change; reverting it restores
today's behaviour exactly. No migration, no file rewrite.

### 8. Data integrity & compatibility — PASS
F6 changes nothing on disk except that a file saved after a reorder now carries consistent
indices for children, which is what every reader already assumed. A file saved *before* F6
with stale child indices stays stale: the plan does not claim otherwise, and there is no way to
tell a stale index from a deliberate mixed-layer group, so no migration is possible. Worth one
sentence under F6 Risk so nobody looks for one later (advisory, folded into must-fix 2's
wording if convenient).

### 9. Verifiability (incl. testing the tests) — PASS
- F6: red today for the stated reason (probed: inner `0`, grandchildren `[0, 0]`); the "no
  `children` key on leaves" assertion pins the omit-when-undefined detail. Fixture order
  dependence noted (must-fix 4).
- `drawnLeaves`: the oracle is `flattenObjectsForTest` plus a copied filter, so the recursion
  half is a real parity pin and the filter half is the same expression twice; the specific
  assertions (e)-(h) are what make the filter half non-tautological, and (h) pins the one
  deliberate divergence. Add (i) per must-fix 1.
- F3 guards: constructible red once the variant is named (must-fix 3).
- F1 red-first via the faithful one-level extraction: unchanged from round 1 and still genuine.

### 10. Maintainability — PASS
`drawnLeaves` and `composedLeaves` carry docblocks that cite the rule they mirror. F6's remap is
local to `reorderLayers`. ARCHITECTURE.md:294 still states the nested-group gap and is routed
to the concurrent refresh's core-19 with a fallback at this relay's doc stage, as in round 1.

---

## Conditional dimensions

### X1. Physical & human safety — PASS [GATING]
F6 is the new safety-relevant piece: today a grouped or traced part cuts with the *swapped-in*
layer's power, speed and passes after any reorder, while the Layers panel and the group both
say otherwise. Worst physical case today is a Cut-layer power (100 %) applied to what the
operator believes is an Engrave part, or the reverse (a through-cut that never gets through and
is re-run). F6 makes the leaf index follow the group; the cut path itself is not touched. The
worst case *after* F6 is a mixed-layer group whose children were deliberately on different
layers: each child is remapped through the same map, so each keeps its own layer, which is what
a reorder means. The undo hazard (must-fix 2) is the same physical worst case through a
different door and is pre-existing; it is indexed, not fixed. Owner desktop test 4 (read S and F
in the G-code preview after a reorder) is named and routed to ROADMAP `next`.

### X5. Concurrency & re-entrancy — PASS [ADVISORY]
Unchanged from round 1. F6 is a synchronous `set`.

### X6. Operability & observability — PASS [ADVISORY]
F6 has no field signal other than the G-code preview's S/F values, which the owner test reads.
Acceptable: the fix is deterministic and the Layers panel already shows the group's layer.

### X8. Dependencies, performance & cost — PASS [ADVISORY]
F6 walks the tree once per reorder. `drawnLeaves` does a `layers.find` per leaf per render
(6 layers): negligible.

---

## Stress tests

### Pre-mortem — three months out, this failed
1. **A traced logo engraved at Cut power after the operator reordered layers and then hit
   Ctrl+Z.** Cause: must-fix 2. F6 shipped, the reorder went right, then an undo of an
   unrelated nudge restored a pre-reorder snapshot and every object silently changed layer. What
   we should have seen: the Deferral line, and a Layers-panel count that disagreed with the
   canvas. The owner test only checks the reorder, not reorder-then-undo.
2. **A blank canvas on opening an old or hand-repaired `.kerf`.** Cause: must-fix 1. The file
   had `layers: []` or a truncated layers array; the new per-leaf check threw where the old loop
   drew. What we should have seen: a `layers = []` fixture.
3. **"I hid the Cut layer and half my group vanished, but the panel says Cut is empty."**
   Cause: must-fix 5. Not a defect (the cut already skipped those children) but the first time
   the canvas told the truth the panel did not. What we should have seen: the Deferral, so the
   next Layers-panel change lists nested children.

### Load-bearing assumptions
1. **`index === position` on every layer array the app has written.** Verified back to the
   first `reorderLayers` (e9151ff) and no other writer of `layers[].index` exists. High
   confidence. If wrong (hand-edited file), F1's `l.index` lookup is *more* right than today's
   positional one, so the failure is benign.
2. **No store action adds or removes layers.** Verified by grep; `DEFAULT_LAYERS` is six since
   the initial commit. High confidence. If a delete-layer action is ever added, it needs the same
   recursive remap as F6, and this review is where that is written down.
3. **The cut reads no group-level `visible`/`layerIndex`.** Verified (`flattenObjects`, gcodeGen
   203-219). High confidence; already deferred by the plan.
4. **The `drawnLeaves` fixtures can construct a hidden layer.** Verified: `Layer.visible` and
   `output` are plain fields with defaults (types.ts:240-243).

### Inversion — what would have to be true for a rejected alternative to win?
- **Make `reorderLayers` undoable instead of (or as well as) remapping children.** Wins if the
  undo hazard were in scope; it is the same symptom class. Not true for this plan (the finding
  was closing F1's leaf visibility, and an undoable reorder needs a layers+objects snapshot
  shape the undo machinery does not have). Right to defer, wrong to leave unnamed.
- **Hide output-off geometry on the canvas for full cut parity.** Wins if the operator had
  another way to keep reference geometry visible. There is none, and the tooltip promises
  "won't cut", not "won't show". Not true today.
- **Remap child indices at load instead of at reorder.** Wins only if stale and deliberate
  mixed-layer children could be told apart on disk. They cannot. Not true.

---

## Overall verdict

Approve with the five changes folded in. The new content holds: F6's defect is real and
reproduced at both depths, its fix is the only writer in the class that needed one, and the
sweep found no second writer. `drawnLeaves` matches the cut's rule on everything it claims to
match and diverges only where the plan says it diverges, for a reason the UI already states.
The dependency graph has exactly the one arrow it should. The changes are: guard the
empty-layers case in `drawnLeaves` so a malformed file degrades instead of blanking the canvas;
name the undo-after-reorder hazard and index it; name a constructible wrong variant for the F3
guards; reset `layers` in the F6 test; and index the read-side siblings that F1 will make
visible.
