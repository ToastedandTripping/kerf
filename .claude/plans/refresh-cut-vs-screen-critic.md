# Critic review (round 3, final): refresh-cut-vs-screen

**Plan:** `.claude/plans/refresh-cut-vs-screen.md` (revised after round 2, `refresh-cut-vs-screen-critic-r2.md`)
**Reviewed:** 2026-09-24, Fable, fresh critic, against the tree at `229398f` (clean).
**Scope of this round:** new material only. F7 (undoable reorder as a live permutation), the
`drawnLeaves` empty-layers guard, and the F3 `catch { return; }` wrong variant. Rounds 1 and 2
are not re-litigated; where a round-2 must-fix was folded in, I checked only that the fold is
faithful.
**Method:** every store writer and reader on the undo path opened (`pushObjectsUndo`, `withUndo`,
`beginPropertyEdit`/`commitPropertyEdit`, `pushCommand`/`undo`/`redo`, `reorderLayers`,
`loadProject`); every `beginPropertyEdit` producer traced to its commit; LayerPanel's drag
handlers read; the Viewport render loop and texture eviction read; `flattenObjects` and the
per-leaf cut rule read. Three claims were run through the real store in a scratch vitest config
(scratchpad `r3-probe/`, `node_modules` and `src` symlinked, no repo writes). Values quoted
below are from that run.

## Applicability

**Project type:** desktop CAD/CAM for a laser cutter. The plan changes what the machine cuts
(layer power and speed follow `layerIndex`; F6 and F7 both rewrite it) and what the operator
sees on the canvas.

| Dimension | Fires? | Tag | Why |
|---|---|---|---|
| X1 Physical & human safety | yes | **GATING** | A wrong `layerIndex` is a wrong S/F on the material. F7 adds a new writer of `layerIndex` (the undo/redo closures). |
| X2 Privacy | no | N/A | No personal, client or child data anywhere in the plan. Stated explicitly. |
| X3 Evidence & source integrity | no | N/A | Nothing here informs a decision or public output; it is code. Stated explicitly. |
| X4 Audience, brand & money | no | N/A | No client- or public-facing output. |
| X5 Concurrency & re-entrancy | yes | ADVISORY | The undo stack is shared mutable state that a reorder now writes to; interleaving with non-command edits is the whole design question of F7. Kept advisory: every path is a synchronous `set`. |
| X6 Operability & observability | yes | ADVISORY | Released desktop app; when undo goes wrong the only evidence is the G-code preview's S/F. |
| X7 Self-modification safety | no | N/A | Touches no MARVIN gate, hook or skill. Stated explicitly. |
| X8 Dependencies, performance & cost | yes | ADVISORY | No new packages; F6/F7 walk the whole object tree per reorder and per undo. |

## Verdict: APPROVE WITH CHANGES

No gating dimension fails. F7's mechanism is right: a permutation applied to live state is the
only shape that commutes with the non-command edits the store has (layer power/speed/name,
image and PDF imports, `setActiveLayerIndex`), and LIFO ordering is what makes every earlier
`objects` snapshot meet the numbering it was taken under. The changes are two test-spec
corrections and one plan-text update that closes the residual the author flagged, plus one
optional one-liner.

**Blocking findings:** none.

**Must-fix before implementation (advisory, in priority order):**

1. **F7 test 4, as specified, is green on the unmodified tree.** "`activeLayerIndex` follows
   the active layer through reorder, undo and redo" passes today: `reorderLayers` already maps
   the active index, and `undo()` and `redo()` are no-ops with nothing on the stack, so the
   active layer's *name* is unchanged at every step. Probed: after `reorderLayers(0, 1)` and
   `undo()`, `activeLayerIndex` reads 1 and still names Engrave. The test must also assert the
   concrete index: 0 after `undo()`, 1 after `redo()`. That makes it red on the F6-only tree
   (reads 1 after undo). Keep the name assertion as well, because it is the one that goes red
   against the plausible wrong F7 (an `applyLayerIndexMap` that forgets `activeLayerIndex`:
   Engrave returns to 0, active stays 1 = Score). Two reds, two reasons, both stated.
2. **F7 test 2's stated purpose ("guards against a snapshot implementation") needs a named wrong
   variant, the way F3 has one.** On the unmodified tree the test is red only because the
   reorder is never undone (probed: Engrave stays at index 1, power 42), so the `power === 42`
   half is trivially green there and proves nothing about snapshots. The variant that fires it
   is a `withUndo`-style undo that restores the pre-reorder `layers` array: Engrave returns to
   index 0 with its *old* power. State that variant and have the implementer quote both
   failures: the index failure on the F6-only tree, and the power failure against the layers
   snapshot variant. Same discipline as F3's `catch { return; }`.
3. **Replace the "Residual, not verified" line in F7's Risk with the verified reading.** Every
   `beginPropertyEdit` producer commits before a layer drag can begin:
   - PropertiesPanel: every field is `onFocus={beginEdit} onBlur={commitEdit}`
     (PropertiesPanel.tsx:171-617); the Align buttons begin and commit synchronously
     (442-444).
   - The text-edit textarea commits `onBlur` (Viewport.tsx:1099-1104, `handleCommit`).
   - The node drag commits on pointer-up (toolHandler.ts:1651), and one pointer cannot also be
     dragging a layer row.
   A layer drag starts with a mousedown on a non-focusable `draggable` div in another panel
   (LayerPanel.tsx:88-116; no `onMouseDown`, no `preventDefault` on it), which moves focus and
   fires `blur` before `dragstart`. The store-level hazard is real (probed:
   `beginPropertyEdit` → edit → `reorderLayers` → `commitPropertyEdit` → `undo()` puts the
   rectangle on Score), but it is unreachable through the UI. Keep one browser step that
   exercises it end to end: focus a Properties field, type a value, drag a layer without
   pressing Enter, Ctrl+Z twice; the object keeps its layer.
   *Optional one-liner, if Razor wants belt and braces:* `reorderLayers` calls
   `get().commitPropertyEdit()` before the permutation. It is a no-op when no snapshot is open,
   and it makes the store safe regardless of any future producer that forgets to commit on
   blur. Not required; the plan's "confirm blur commits" is answered above.
4. **Pin the no-op path with one assertion.** Done-when says "none for a no-op reorder" but no
   test lists it. Add to F7 test 1: `reorderLayers(0, 0)` and `reorderLayers(0, 99)` push
   nothing (`undoStack.length` unchanged). Cheap, and it is the case that stops a stray
   command entry from clearing the redo stack for nothing.

---

## Universal core

### 1. Problem-fit — PASS
The Intent summary now carries F7's sentence ("Ctrl+Z after a reorder undoes the reorder
itself"), and the plan's goal matches it. F7 does not contradict any DECISIONS entry; the
2026-06-21 drift ruling is about coordinates and is untouched. The skip note names the
coordinator's in-scope ruling for F7.

### 2. Approach soundness — PASS
The permutation-on-live-state design is correct, and the plan's three reasons for rejecting a
snapshot are all true against the code:
- `updateLayer` and `updateLineOverlay` push no command (store/index.ts:301-345), so a layers
  snapshot would revert power/speed edits made after the reorder.
- `importImageData` (imageImport.ts:107, `store.addObject`) and the DXF/QR/PDF importers add
  objects with no `withUndo`, so an objects snapshot restored on undo would delete them.
- `pushCommand` clears `redoStack` (store/index.ts:388), so "redo the reorder after a further
  edit" cannot happen; the redo closure only ever runs directly above the state it was pushed
  from, or above a chain of its own successors' undos.
LIFO argument, checked against the real machinery: stack `[A(pre), R, B(post)]`. Undo B restores
a post-reorder snapshot against post-reorder layers; undo R permutes live state back; undo A
restores a pre-reorder snapshot against pre-reorder layers. Redo in the same order. Each
snapshot meets its own numbering. `undo()` reads the stack before calling `cmd.undo()` and the
reorder closure calls `set`, not `pushCommand`, so the bookkeeping is unaffected.
The inverse map is a full permutation over all six layers (`indexMap` is built from every
layer), so `inverse.get` never misses; `?? l.index` is dead but harmless.

### 3. Completeness — PASS
Every layer-index holder in the store is mapped: `layers[].index`, every object at every depth
(F6's helper), `activeLayerIndex`, and `objectsById` rebuilt. `setActiveLayerIndex` is not a
command, and the plan's design handles it correctly by construction: undo of R maps whatever is
active *now* through the inverse, so the operator stays on the same layer. `loadProject` clears
both stacks (store/index.ts:481-482), so a reorder closure can never fire against another
project's layers. `MAX_UNDO` trims oldest-first (store/index.ts:383-387); a trimmed R only ever
has older entries below it. Layer indices held outside the store (`ImageTraceDialog`'s local
`targetLayerIndex`, ImageTraceDialog.tsx:332) are dialog-local and pre-existing; a reorder
cannot happen behind a modal.

### 4. Right-sizing & reuse — PASS
F7 reuses F6's `remapLayerIndexDeep` and the existing `Command` shape; no new undo primitive.
`applyLayerIndexMap` is the one new module-level helper. Batch waiver stands; F7 is its own
commit after F6. Deferrals are indexed.

### 5. Security — PASS
No secrets, auth or attack surface. Unchanged from rounds 1 and 2.

### 6. Failure modes — PASS
`applyLayerIndexMap` cannot throw: `map.get ?? l.index` on layers and objects, a sort, and a
rebuilt map. With `layers: []` (the file `drawnLeaves` now guards against) the map is empty and
both closures are identity. The `drawnLeaves` `ll &&` guard is a faithful copy of today's
`objLayer && !objLayer.visible` (Viewport.tsx:310-311); fixture (i) pins it and the stated red
(`Cannot read properties of undefined`) is what `layers[0].visible` throws on `[]`.

### 7. Change safety — PASS
F7 is exactly the reversibility fix. Undo of the reorder is now a real undo. Severable as its
own commit; dropping it leaves F6's stated hazard, which the plan names.

### 8. Data integrity & compatibility — PASS
Saved files are untouched by F7: the undo stack is in-memory only and `toProject` writes
`layers` and `objects` as they stand. `index === position` is preserved by the sort in
`applyLayerIndexMap`, so a file saved after an undo has the same shape as one saved after a
reorder today.

### 9. Verifiability — CONCERN
Two tests cannot be shown red for the stated reason as written (must-fix 1 and 2, both
probed). The others can: F6's test (inner group and grandchildren read 0 today), F7 test 1
(after `undo()` the name is Score and the stack is length 1, both probed in round 2 and
consistent with my run), F7 test 3 (red on the F6-only tree: the group snapshot restores
pre-reorder numbering), `drawnLeaves` (i) (throws without the guard), and the F3 guards
(`catch { return; }` makes both `vi.waitFor` calls time out, since `openImageImport` sits
behind `FileReader.onload → Image.onload → import()`). Fix: fold must-fix 1, 2 and 4.

### 10. Maintainability — PASS
Two named helpers beside the action that uses them, a docblock stating why a permutation and
not a snapshot, and the frozen-file boundary respected (gcodeGen.ts is only imported by tests).
One note for the docblock: say that any future layer add/delete action must push a command
of the same shape, because a layer-count change is not a permutation and would break the
inverse. Round 2's assumption 2 already records that no such action exists.

---

## Conditional dimensions

### X1. Physical & human safety — PASS [GATING]
The type-specific worst case for F7 is the one it fixes: one Ctrl+Z after a reorder silently
moving every object, grouped or not, onto whichever layer now holds its old number — Cut power
on an Engrave part or the reverse. After F7, the only sequence I could construct that still
does this is the spanning property edit (must-fix 3), and it is unreachable through the UI
because every producer commits on blur or pointer-up before a drag can start. Every failure
path in `applyLayerIndexMap` is identity, never a partial remap. `gcodeStale` is set on undo
and redo (F15 class), so a green START gate cannot cut a pre-undo design. Owner test 4 reads
the S and F values after reorder → edit → Ctrl+Z → regenerate, which is the right instrument.
For F6 + F7 on depth-2 groups and traced output: `remapLayerIndexDeep` recurses on
`o.children` at any depth, and traced output (ImageTraceDialog.tsx:126-156) stamps the same
`layerIndex` on the outer group, each multi-contour inner group and every leaf, so all of them
move together and the inverse moves them back together. The cut reads the leaf
(gcodeGen.ts:278), the canvas after F1 reads the leaf, and both are remapped by the same map.

### X5. Concurrency & re-entrancy — PASS [ADVISORY]
Every path is a synchronous `set`. Drag-reorder in LayerPanel fires `onDrop` once on the target
row's wrapper (LayerPanel.tsx:106-112); `onDragOver` only sets React state; `dragSourceRef`
is nulled on drop and on `dragend`; the `!== layer.index` guard plus `reorderLayers`' own
no-op return mean a same-row drop pushes nothing. One drop, one command. The async
`loadFont().then(updateObject)` refinement in text editing can land after a commit
(Viewport.tsx:1062-1075) — pre-existing, outside any snapshot, and not layer-related.

### X6. Operability & observability — PASS [ADVISORY]
The command type `"reorder-layers"` is visible in the stack for anyone debugging; the Layers
panel order and each object's Properties layer badge are the operator-visible signals, and the
browser step reads both. Acceptable.

### X8. Dependencies, performance & cost — PASS [ADVISORY]
`remapLayerIndexDeep` allocates a new object for every node on every reorder, undo and redo,
including nodes whose index did not change. The Viewport does not compare references: with an
empty dirty set it clears and re-renders every cached display object anyway
(Viewport.tsx:248-253), which is what today's top-level remap already triggers. So the churn
has no render cost beyond today's. If it ever matters, return `o` unchanged when neither the
index nor any child changed; not needed now.

---

## Stress tests

### Pre-mortem — three months out, this failed
1. **"I undid a layer move and my traced logo cut at Cut power."** Cause: a future
   add-layer/delete-layer action shipped without a command, or with a snapshot command, and
   the reorder's stored inverse was applied across a layer-count change. What we should have
   seen: the docblock line in must-fix 10 and round 2's assumption 2. Not reachable today.
2. **Test 4 shipped green without ever being red, and a later refactor dropped
   `activeLayerIndex` from `applyLayerIndexMap`.** Cause: must-fix 1. What we should have seen:
   a concrete index assertion and the name assertion side by side.
3. **A property edit spanned a drag on some platform where mousedown on a draggable row does
   not blur the field.** Cause: the residual in must-fix 3, reachable only if a browser breaks
   the focus-on-mousedown default. What we should have seen: the browser step in must-fix 3,
   or the optional `commitPropertyEdit()` call at the top of `reorderLayers`.

### Load-bearing assumptions
1. **No action adds or removes layers.** Verified again (grep of `layers:` writers in
   store/index.ts: `updateLayer`, `updateLineOverlay`, `reorderLayers`, `loadProject`). High
   confidence. If wrong, the permutation design needs a companion command for the count
   change; this review and the docblock are where that is written down.
2. **`pushCommand` clears the redo stack.** Verified (store/index.ts:388). High confidence; it
   is what makes "redo after further edits" impossible rather than merely unlikely.
3. **Every `beginPropertyEdit` producer commits before a layer drag.** Verified by reading all
   three producers (must-fix 3). High confidence for the code; the browser step covers the
   focus behaviour, which is the one part reading cannot settle.
4. **LIFO is the only order in which commands are undone.** Verified (`undo`/`redo`,
   store/index.ts:391-411); there is no "undo command N" UI. High confidence.

### Inversion — what would have to be true for a rejected alternative to win?
- **A layers + objects snapshot command.** Wins only if layer edits and imports were also
  commands, so nothing non-undoable could sit above the reorder. Neither is true today; the
  editing-shortcuts plan's F8 would make imports commands, but layer edits stay outside undo
  by design (the plan's own reason for the permutation). Not true.
- **Remap indices at restore time inside `pushObjectsUndo`** (translate every snapshot through
  the layer permutations that happened since it was taken). Wins if reorders were frequent and
  the stack were deep, since it needs no command at all. It requires a permutation log keyed to
  stack depth, which is the same information F7 stores in a simpler place. Not true.
- **Make reorder non-remapping (indices stop equalling positions).** Wins if nothing depended on
  `index === position`. Round 2 verified the positional readers; `layers[obj.layerIndex]` in
  today's Viewport is one. Not true, and F1 moves the render to `l.index` anyway.

---

## Overall verdict

Approve with the four changes folded in. F7's mechanism is the right one for this store, and
each of the plan's reasons for it is true against the code rather than argued from taste. The
interleavings the caller asked about all resolve cleanly: redo after further edits is
structurally impossible, non-command layer edits and imports commute with the permutation,
`activeLayerIndex` follows by construction, and no existing command's snapshot can carry stale
numbering across the reorder except the spanning property edit, which every UI producer closes
on blur or pointer-up before a drag can start. F6 and F7 together are correct at depth 2 and for
traced output because one recursive helper writes every level and the same map moves them all.
What needs changing is test discipline, not design: test 4 is green as written, test 2's
snapshot guard needs its wrong variant named, the no-op path needs one assertion, and the
"not verified" residual should be replaced by the reading above.

**Must-fix list (priority order):**
1. F7 test 4: assert `activeLayerIndex === 0` after undo and `=== 1` after redo, alongside the
   name check.
2. F7 test 2: name the layers-snapshot wrong variant and quote its failure as well as the
   F6-only tree's.
3. F7 Risk: replace "Residual, not verified" with the producer-by-producer reading; keep one
   browser step for the focus behaviour; optionally `commitPropertyEdit()` at the top of
   `reorderLayers`.
4. F7 test 1: assert that `reorderLayers(0, 0)` and an unknown index push nothing.
