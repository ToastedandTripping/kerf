# Critic review, round 3 (final): refresh-canvas-display.md

Reviewer: separate critic subagent (Fable), 2026-09-24, fresh eyes. Rounds 1 and 2 are at
`refresh-canvas-display-critic-r1.md` and `-r2.md`. Settled points are not re-litigated. This
round checks the F7 display-only redesign (the recentring translation t), whether the two
new F7 tests constrain the implementation, and whether the three round-2 blocking items
(B1 precondition symbol, F1 Case 3, F5 decode handling) landed.

Tree read: `229398f` on `marvin/session-8b2728`, clean. cut-vs-screen has still not merged
(no `drawnLeaves` in either file), which is the state the plan's precondition expects before
it starts. All line numbers cited by the plan were spot-checked against this tree and hold.

One measurement was made (scratchpad, no repo writes): the t formula was run numerically on
a 30° fixture carrying a Bézier handle that overshoots the anchor bbox, world drag (25, −7)
on node 2. Untouched anchors and the handle moved by at most 7.1e-15 mm in world space; the
dragged node landed at old-world + Δ to 0 error. The same script computed the variant that
uses a handle-inclusive bbox for c′: node 0 then jumps 4.7 mm in world space, and the plan's
handle-free fixture cannot tell the two apart (anchors-only and handle-inclusive bboxes are
identical for it). That is the one advisory worth acting on; see dimension 9.

## Verdict: APPROVE

No blocking findings. The t formula is right against every rotation centre in the pipeline,
the "stored = U + t" test is falsifiable against the four plausible wrong implementations,
the payload test compares the correct object, and all three round-2 blockers landed as
specified. Three advisories, none of which change the design.

---

## Applicability

**Project type:** desktop CAD/CAM app (Tauri/React/Pixi), UI rendering and hit-testing
layer. No remediation-frozen file is edited.

| Dim | Fires? | Why | Tag |
|---|---|---|---|
| X1 Physical safety | **Yes** | F7 still writes stored path geometry (a uniform translation t plus the operator's edit); that geometry is what gcode_gen.rs cuts and fills. | **GATING** |
| X2 Privacy | No | Operator's own designs; no personal, client or health data. | N/A |
| X3 Evidence | No | Not research or public output. | N/A |
| X4 Audience/brand/money | No | Nothing client- or public-facing. | N/A |
| X5 Concurrency | Yes | StrictMode double-mount with async init; async decode with a module cache and generation counter. Traced in round 2; only the new Case 3 is re-checked here. | ADVISORY |
| X6 Operability | Yes (weak) | Ships in the released app. | ADVISORY |
| X7 Self-modification | No | Touches no MARVIN gate, hook or skill. | N/A |
| X8 Dependencies/perf | Yes | No new packages; one extra objects-effect run per decoded image (unchanged from round 2). | ADVISORY |

---

## Core dimensions

### 1. Problem-fit — PASS
Intent present with a skip line; the Summary now states F7's contract precisely (rotation
never written, no-op selection byte-identical to the generator, a real edit moves only the
dragged node in world space). No DECISIONS.md entry is touched: the W1b invariant is a code
comment and a test helper, not a ruling, and the plan keeps it anyway.

### 2. Approach soundness — PASS
**The t formula, derived and checked against every rotation centre.** Stored local points P
rotate about the transform centre c: world = c + R(P − c). After an edit produces P′ with
anchor-bbox centre c′, the plan writes Q = P′ + t. Because translating every point by t
moves the bbox centre by exactly t, an untouched node's world position becomes
c′ + t + R(P − c′). Setting that equal to c + R(P − c) gives t = (c − c′) − R(c − c′) =
(I − R)(c − c′), which is what the plan writes. The dragged node then lands at
old-world + R·L = old-world + Δ, since L = R⁻¹Δ. Verified numerically (header).

The centre is the same object everywhere that matters:
- **Renderer** (`applyObjectRotation`, Viewport.tsx:1187-1190): `t.x + t.width/2`.
- **Rust line arm** (`rotate_segment`, gcode_gen.rs:1328-1338): `obj.x + obj.width/2`.
- **Rust fill arm** (gcode_gen.rs:929-930): `center_x = obj.x + obj.width/2`.
- **Rust maskFill** (mask_fill.rs:918-930): rasterises in local coordinates over
  `obj.x/y/width/height` and rotates each output coordinate about that bbox centre.

`obj.x/width` in the payload is `transform.x/width` (gcodeGen.ts:487-494), and by W1b the
transform is the **anchors-only** bbox (`pointsBBox`, geometry/index.ts:196-215, explicitly
"Anchors-only AABB"). The plan computes c′ from `pointsBBox(points)`, so its centre is the
same anchors-only centre. **Bezier handles** ride along with t and do not enter the centre
computation on either side, which is exactly right: a handle that overshoots the bbox never
changes the rotation centre today, and does not after this plan.

**Handle drags**: anchors unchanged, so c′ = c and t = (0, 0) exactly, and the write reduces
to today's `pointsPartial` with an inverse-rotated delta. The in-frame mirror
(handleIn = 2·anchor − handleOut) is an affine reflection through the anchor, and rotation
commutes with it, so mirroring in the local frame is correct.

**Delete**: the remaining points get one t computed from the pre-delete centre; the
remaining nodes hold their world positions. For the fixture, deleting node 2 leaves a
0-height bbox at y = 10; the centre is still well-defined and the formula is unaffected.

**Insert**: there is no node-insert writer in toolHandler.ts (no `splice`, no
`insertNode`/`addNode`; the four writers the plan lists are the only `points` writers on the
node path). Nothing to cover.

**Paths inside groups**: node editing is top-level only. `handleNodeDown` enters on
`hitTest`, which iterates `store.objects` (toolHandler.ts:280-283, top-level array, no
recursion) and requires `type === "path"`; `handleToolChange` (1878-1885) does the same via
`store.objects.find`. A group child is never `nodeEditState.pathId`, so the group-local
frame never meets these writers.

**Undo/redo**: a drag runs inside `beginPropertyEdit`/`commitPropertyEdit`, which snapshot
the whole `objects` array before and after (store/index.ts:431-450, `pushObjectsUndo`
59-118); delete and toggle-smooth are inside `withUndo`. Undo restores the complete
pre-edit object, rotation included; redo restores the complete post-edit object. Since no
writer touches `transform.rotation`, there is no path to a mixed state where points are in
one frame and rotation in another. The drag test's "one `undo()` restores the original
object deep-equal" is the right assertion and will hold.

### 3. Completeness — PASS
The four writers are enumerated and all route through `pointsPartialKeepingPlacement`. The
overlay (Viewport.tsx:528) and `hitTestNodeHandles` (toolHandler.ts:1509-1526) are the only
readers of raw node positions for display, and both switch to `pathPointsToWorld`. Delete
via the Delete key routes through `deleteSelectedNode` (1913-1916). The ≤2-points branch
removes the whole object and is untouched.

### 4. Right-sizing & reuse — PASS
Three pure helpers beside `rotatePathPoint`, reusing `rotatePathPoint`, `pointsBBox` and
`pointsPartial`; nothing new in toolHandler beyond two snapshot fields on `nodeDrag`.
Dependency graph and batch waiver unchanged from round 2. The four Parking Lot lines are
present with sources.

### 5. Security — PASS
No secrets, auth, IPC or file-system surface.

### 6. Failure modes — PASS
At rotation 0 every helper is the identity (reference-equal points, t = (0, 0) exactly, so
the existing unrotated node tests are unaffected). A degenerate bbox (collinear remainder
after delete) is a valid centre. `scaleX === 0` guard in F3 unchanged.

### 7. Change safety — PASS
One commit per step with its own red proof; the F7 red run stubs the three helpers with
today's behaviour so the tests can be written first. Every write stays inside its existing
undo boundary.

### 8. Data integrity & compatibility — PASS
W1b holds by construction (`pointsPartial` recomputes the bbox from the translated
points). The load migration (fileOps/index.ts:812-831) is untouched and only fires on a
desynced transform, which these writers never produce. No `formatVersion` change.

### 9. Verifiability (incl. testing the tests) — PASS
**Does "stored = U + t" constrain the implementation?** Yes, against each plausible wrong
build:
- *Forgot t* (local delta, plain `pointsPartial`): result − U = (0, 0), but the test pins
  the difference to (I − R)(c₀ − c(U)), which is non-zero at 30° when the bbox moves. Fails.
- *Applied the world delta without inverse rotation*: result[2] − U[2] ≠ result[0] − U[0].
  The uniformity assertion fails.
- *Folded the rotation into the points* (round-1 design): non-uniform difference. Fails.
- *Wrong sign, (R − I)(c₀ − c′)*: the exact-value assertion fails.
The world-placement test is the independent cross-check: it asserts the observable
(untouched nodes stationary in world space) rather than the mechanism, so the two tests
cannot both pass on a wrong formula. Δ = (25, −7) on node 2 does move the bbox (node 2 goes
to about (58.2, 21.4) in the local frame), so t is non-zero in the fixture.

**One gap, advisory.** The pointsGeometry fixture has no handles, so "the same vector for
every anchor **and handle**" is vacuous, and, as measured in the header, an implementation
that computed c′ from a handle-inclusive bbox would pass every F7 test in the plan while
displacing untouched nodes by millimetres on any real curved path. The plan says
`pointsBBox`, which is anchors-only, so the risk is Ted rolling his own bbox rather than
following the plan; low, but the fixture should be able to see it. **Fix:** give node 1 of
the pointsGeometry fixture a `handleOut` that overshoots the anchor bbox (for example
(60, −20)); the assertions do not change and both the "and handle" clause and the
anchors-only centre become load-bearing.

**Does the G-code JSON-identical test compare the right payload?** Yes. `generate_gcode`
receives `{objects, workspaceHeight, sValueMax, startCorner, workspaceWidth, originTop}`
(gcodeGen.ts:1134-1141); `objects` carries the sampled contour, `x/y/width/height`,
`rotation`, `layer` and power (487-506). Nothing in gcodeGen.ts reads a clock or a random
source (grep for `Date`, `random`, `performance.now`, `crypto`: no hits), so two calls on the
same store state serialise identically. The 30° fixture is closed and ungrouped, so on a
fill layer it emits through the ordinary branch with `rotation: obj.transform.rotation`
(gcodeGen.ts:373-494), never through the coalesced `rotation: 0` group path (534-553). A
no-op drag writes points equal by value, so the stringified payload is identical; the plan
correctly notes this test is green before the fix and guards a regression, not the fix.
The second assertion (`rotation: 30` still in the payload after a real drag) is the one
that pins the round-2 hatch concern shut.

**F1 Case 3, traced.** With the guard removed, app#1's late cleanup nulls `appRef`, clears
`displayCacheRef` and `contentHashCache`, but does not null `objectsContainerRef` (today's
cleanup at Viewport.tsx:160-174 never does, and the plan adds nothing that would). The next
`updateObject` therefore passes the objects effect's `!objectsContainerRef.current` guard,
finds an empty display cache, and `ensureDisplayObject` adds a second Graphics for the same
key. The red proof goes red with a duplicate child, as the plan says. With the guard, none
of that happens. Case 3 is falsifiable and sees exactly the thing Case 2 cannot.

### 10. Maintainability — PASS
Three named helpers, one writer path for all four node writers, comments required at the
overlay and hit test ("display and hit-testing only; never written back").

---

## Conditional dimensions

### X1 Physical & human safety — PASS [GATING]
The round-2 finding (hatch turning machine-relative after a fold) is resolved by design,
not by disclosure: `transform.rotation` is never written, so the fill and maskFill arms
keep adding `obj.rotation` to the scan angle and the hatch stays part-relative. The line
arm rotates the sampled contour about the (moved) transform centre; since the stored points
and the centre both moved by t, every untouched sample lands where it did, to the 1e-14 mm
measured. The maskFill raster grid is anchored at the bbox origin and moves with it, so the
mask is unchanged relative to the part; scan-line phase relative to the part can shift by
less than one interval when the bbox changes, which is what a node edit on an unrotated
path already does today. Worst physical case: none, and the plan names it as none for the
right reasons. Hardware-only paths: none new; the one owner-run step (F5 desktop file-open)
is named and logged to the ROADMAP.

### X5 Concurrency & re-entrancy — PASS [ADVISORY]
Case 3 is the out-of-order path and is now tested (dimension 9). `nodeDrag.centreBefore`
and `nodeDrag.rotation` are captured at pointer-down and the drag recomputes every frame from
`originalPoints`, so nothing accumulates and no mid-drag store change can desync them.

### X6 Operability — PASS [ADVISORY]
Unchanged from round 2.

### X8 Dependencies, performance & cost — PASS [ADVISORY]
`pathPointsToWorld` allocates a mapped array per overlay redraw on rotated paths only;
trivial at node counts a human edits by hand.

---

## Round-2 blockers: did they land?

| Round-2 item | Landed? | Where |
|---|---|---|
| B1: precondition greps `drawnLeaves` in Viewport.tsx and `composedLeaves\|drawnLeaves` in geometry/index.ts; Context corrected; "no hunk touches the `drawnLeaves` loop" sentence | Yes | Context, cut-vs-screen bullets (the merged-symbol substitution rule and the "stop and report" rule are both there) |
| B2: fill-mode G-code claim | Superseded: the redesign removes the behaviour the disclosure was for | Intent, F7 Design, Hardware paragraph |
| B3: F1 Case 3 out-of-order with red proof | Yes | F1 Test, Case 3 + Red first |
| Adv: F5 move commit ships `evictTextures`/`clearTextures` | Yes | F5 Fix step 1 |
| Adv: `decode()` rejection on a decodable image | Yes | F5 Fix step 2 (`img.complete && img.naturalWidth > 0`), "Rejected but displayable" test |
| Adv: no timeout on pending, disclosed | Yes | F5 Risk |
| Adv: F1 Pixi fake as a Proxy | Yes | F1 Test |
| Adv: `assertPointsInvariant` shared-helper exemption | Yes | F7 Test |

---

## Stress tests

### Pre-mortem — three months out, this failed
1. **An operator dragged a Bézier handle on a rotated traced outline and a neighbouring
   anchor drifted a few millimetres; the cut was off the drawing.** Cause: c′ computed from
   a bbox that included handles. The plan's tests were all green because no fixture had a
   handle that overshot the bbox. We should have seen it in this review, and did: the
   advisory fixture change makes it red.
2. **A relay-time line-number re-read pasted the pre-cut-vs-screen loop back into the
   objects effect and per-leaf visibility vanished for nested groups.** The B1 sentence
   now exists to stop this; the precondition greps make the base unambiguous. Residual
   risk is human, and it is named.
3. **A hung `decode()` left one imported image blank for a whole session and the operator
   engraved a job with the image's outline but no raster.** Disclosed as accepted
   behaviour in F5 Risk; the image G-code path reads `imageData` directly, not the
   texture, so the cut is unaffected. Type-specific worst case (laser cuts the wrong
   thing) does not occur in any of the three.

### Load-bearing assumptions
- **`pointsBBox` is anchors-only and `transform.x/width` equals it (W1b)** — verified in
  code (geometry/index.ts:6-11, 196-215) and asserted by `assertPointsInvariant` in every
  F7 test. If wrong, the centre argument collapses; it is not wrong.
- **Every Rust arm rotates about `obj.x + obj.width/2`** — verified at gcode_gen.rs:1330,
  929-930 and mask_fill.rs:923-930. Consequence if a future arm picks another centre:
  screen and cut diverge for every rotated path, not only node-edited ones; outside this
  plan.
- **`objectsContainerRef` is not nulled by the init cleanup** — this is what makes Case 3
  red without the guard. Verified against today's cleanup (Viewport.tsx:160-174); if Ted
  adds a null of that ref inside the guarded block, Case 3 still passes with the guard and
  still fails without it (the emptied-container branch of the assertion), so the test
  remains falsifiable either way.
- **`generate_gcode` args are deterministic across calls** — verified by grep; consequence
  if wrong is a flaky test, not a wrong cut.

### Inversion — what would make a rejected alternative win?
- *Fold the rotation into the points* wins if part-relative hatch were not required and
  the W1b invariant could be kept without t. Both conditions are false: the fill arms add
  `obj.rotation` today, and t exists. Still rejected.
- *Edit in the local frame without t* wins only if the rotation centre did not move with
  the bbox. It does, by W1b. Still rejected.
- *Pin the bbox to the old centre* wins if W1b were negotiable. It is asserted by the test
  helper every writer test runs. Still rejected.

---

## Blocking

None.

## Advisory

1. **Give the pointsGeometry F7 fixture a handle that overshoots the anchor bbox** (for
   example `handleOut: (60, −20)` on node 1). Without it, the "same vector for every anchor
   and handle" clause is vacuous, and a c′ computed from a handle-inclusive bbox passes
   every test in the plan while displacing untouched nodes by millimetres on real curves.
   Assertions unchanged.
2. **Add a handle-drag case to `nodeEditRotation.test.ts`.** After toggle-smooth on node 1,
   press on its world-space `handleOut`, move by world (5, 3), release; assert the handle's
   world position moved by (5, 3), `handleIn` is the reflection of `handleOut` through the
   anchor in world space, and all three anchors are unchanged. It is the only writer path
   (inverse-rotated delta plus in-frame mirror, t = 0) that the plan covers by browser step
   alone, and the harness for it is already in the file.
3. **Name the pointsGeometry test's tolerance provenance in a comment.** The plan states
   7.1e-15 mm at plan time; the test uses 1e-12 and 1e-9. That is fine, but a future reader
   should know the margin is three to six orders, not a guess.

## Overall verdict

The display-only redesign is correct and the plan proves it the right way: the closed-form
t is derived from the same anchors-only centre the renderer and all three Rust arms use,
handles ride along without entering the centre, node editing cannot reach a group child,
and every writer stays inside its existing undo boundary with `transform.rotation`
untouched. The two F7 tests are falsifiable against the four wrong builds a reasonable
implementer might produce, the payload test compares the actual `generate_gcode` argument
and is deterministic, and all three round-2 blockers landed as written. The one thing
worth doing before Ted starts is a fixture with a handle, so the anchors-only centre is
something a test can see. APPROVE.
