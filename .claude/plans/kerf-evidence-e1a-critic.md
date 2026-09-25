# Critic — Kerf evidence E1a (`kerf-evidence-e1a.md`)

**Date:** 2026-09-25. **Critic:** Fable, separate subagent (the author cannot self-certify). **Rubric:** `~/marvin/rules/plan-critic-rubric.md` v2, read in full. **Tree read:** worktree `kerf-gap` at `3a0d735` (`git diff --stat 4e9c1e2 HEAD -- src src-tauri` is empty, so every code citation below is against the same tree the plan cites). Read-only: no build, test, install or git state change. **Also read:** parent `PLAN-silent-drop-and-evidence.md` (§E1a, §E1b, Verification, Risks, Critic fold) and its critic; `kerf-relay-plan.md` §A2; `.claude/DECISIONS.md` in full (24 entries); `~/marvin/scripts/mutation-battery.mjs` spec validation (`:1549-1575`).

## Applicability block

**Project type:** desktop laser-cutter controller; this batch is the TS half of the G-code generator (`src/lib/machine/gcodeGen.ts`) and its vitest file. Simple tier, 2 files, one root. Public repository.

| Dim | Fires? | Tag | Why |
|---|---|---|---|
| X1 Physical & human safety | **Yes** | **GATING** | The batch changes what an ordinary rectangle burns: today nothing, after this a raster fill at layer power plus a perimeter cut. It also adds a generation-time throw that decides whether a job reaches the machine at all. |
| X2 Privacy & data stewardship | No | — | No personal, health, child or client data anywhere in the batch. |
| X3 Evidence & source integrity | No | — | The batch produces code and tests, not research or a public factual claim. The "quote the repro output in the report" discipline is core-9 verifiability, not X3. |
| X4 Audience, brand & money | No | — | No client-facing output. |
| X5 Concurrency & re-entrancy | Yes | ADVISORY | `generateGcode` is async and re-triggerable from the panel; the batch adds a synchronous pass inside it. |
| X6 Operability & observability | Yes | ADVISORY | The new throw is the only field evidence of a mode the engine lacks, and its message is what Lee will read. |
| X7 Self-modification safety | No | — | No MARVIN gate, hook, skill or automation is changed; the battery is used as it stands. |
| X8 Dependencies, performance & cost | No | — | No package, service, hot path or polling loop is added; one O(n) pass over a list of CutObjects. |

## Citations verified against the tree

| # | Plan claim | Tree | Verdict |
|---|---|---|---|
| 1 | `synthesizeFillContour` at `gcodeGen.ts:158-197`, rounded arm `:185-195`, `return null` at `:197` | function `:156-191`; ellipse arm `:158-170`; rounded-rectangle arm `:171-189`; `return null` `:190` | **✗ all three off by 2-7 lines.** The parent plan and its critic had `:171,190` right; the lift regressed them. Not the edit site, so not load-bearing for the change, but a Ted who greps `:197` for the `return null` finds the closing brace of `synthesizeFillContourForTest`'s export instead. |
| 2 | `buildCutLayer` copies `layer.mode` (`:85`) | `:85` | ✓ |
| 3 | `isNonRectShape` (`:286`: ellipse, path, line) | `:286` | ✓ |
| 4 | maskFill remap only at `:403-405` (non-rect) and `:407-414` (rounded rect with paths) | `:403-405`, `:407-414` | ✓ |
| 5 | Emit at `:506` with `layer.mode = "fillLine"` and `paths = []` | `:506-507` applies `effectiveMode`, which for a sharp rect equals `layer.mode`; `paths` is the empty array from `:375` | ✓ |
| 6 | Overlay block `:510-523` needs a closed path | `:509-523`; `hasClosed = paths.some(p => p.closed)` at `:512` | ✓ |
| 7 | Rust `other =>` comments and skips (`gcode_gen.rs:1271-1279`) | `:1271-1280` | ✓ |
| 8 | Grouped sharp rectangles take the same path; `groupBuf` is for non-rect only (`:288-292`) | comment `:288-292`, condition `:293-297` requires `isNonRectShape` | ✓ (pointer is at the comment, condition is five lines lower) |
| 9 | Synthesis block at `:390-396` | `:388-397` (`if` at `:391`) | ✓ |
| 10 | Effective-mode block `:402-414` | `:402-414` | ✓ |
| 11 | Rust `fill` arm accepts no paths or a single closed 4-point path and applies `obj.rotation` (`:882-927`) | acceptance `:893-909` (`paths.len()==1 && closed && points.len()==4`); `obj_rot` `:920-924`; the arm then computes scan bounds from **`obj.x/y/width/height` only** (`:936-975`) and never reads the path points again | ✓ — and stronger than the plan says: the 4-point path is validated and then ignored, so rotation is applied exactly once (`rotation_rad = obj_rot + layer_angle`, `:927`) whether `paths` is empty or the 4 corners. |
| 12 | Overlay perimeter rotation "travels on `base.rotation` and Rust applies it, as for rounded rectangles" | line arm `:496-504`: non-empty paths are cloned and `rotate_segment(path, obj)` (`:1328-1339`) rotates about the object centre by `obj.rotation`, once; empty paths go through `object_to_path` (`:1344-1382`), which synthesises the 4 corners itself | ✓ |
| 13 | Offset block `:416-478` is line-mode only | `:416-483`, both guards `layer.mode === "line"` (`:417`, `:428`) | ✓ |
| 14 | Partition `commands/gcode.rs:82-137` | `is_fill_ish` `:82` (`fill \| maskFill \| offsetFill`), `has_mixed` `:84-85`, two buckets `:89-98` | ✓ — a `fill` object plus a `line` overlay on one layer is `has_mixed`, so both land in a bucket. |
| 15 | `fillLineLayer` at `gcodeGen.test.ts:298` | `:298-305` | ✓ |
| 16 | Existing fillLine tests at `:307-380` | `describe` `:307-378` | ✓ |
| 17 | Text-conversion mocks, `describe` at `:1090` | `:1090`; the spy is `:16` (`mockResolvedValue([])` by default, re-mocked per test) | ✓. Note for E1a-M4's "say which": text is reachable **only through `generateGcode`** (`:868-901` converts it to path objects); through `toCutObjectsForTest` a text object is skipped with a warning at `:280-283` and asserts nothing. |
| 18 | A TS throw in `generateGcode` surfaces loudly | single production caller `MachinePanel.tsx:161` inside `try … catch (e)` `:160-187`: console error `G-code generation failed: …` + status line, `gcodeResult` untouched, returns `false` so the preview does not open. `gcodeFailureLoud.test.tsx` drives this exact handler with `invoke` rejecting; a synchronous throw inside the async `generateGcode` is the same rejection. `grep -rn "generateGcode(" src` (non-test) hits only that line. | ✓ — the plan's "Ted cites the call site" is answerable now: `MachinePanel.tsx:157-190`. |
| 19 | Battery mutant ids as listed | `mutation-battery.mjs:1555`: every mutant is exactly one `{id, path, find, replace}` — **one contiguous `find` in one file** | relevant to E1a-M4, below |

Nineteen claims: 17 exact or stronger, 1 imprecise (8), 1 wrong (1, three line numbers).

## Universal core (all gating)

### 1. Problem-fit — **PASS**
`## Intent (grilled)` present with a written skip line and a Summary that matches the parent's. Solves the stated need (charter "no silent G-code error"; the sharp Fill+Line rectangle). No DECISIONS entry contradicted: the perimeter is deliberately **not** kerf-offset, which is exactly what the "Gate D2 … kerf-offset-on-fillLine-perimeter design … Lee + architect call, an implementer does not settle it in passing" constraint requires. One improvement: the Parking Lot line for the kerf gap should name Gate D2 as the owner, not only "astra 2.3", so a later reader sees it is a ruled-open call.

### 2. Approach soundness — **PASS**
Verified against the Rust arms, not the comments. Lowering to `fill` is right: the fill arm rasterises the AABB rotated by `obj.rotation` and ignores the 4-point path after validating it (claim 11), so the sharp rectangle burns the same raster whether `paths` is `[]` or the corners; the line arm rotates the supplied contour once (claim 12), so the overlay lands on the same rectangle. Keeping the contour out of `synthesizeFillContour` is correct: that function also feeds `fill` and `offsetFill` at `:395`, and a sharp rectangle on `fill` with `paths=[4]` would pass the Rust `is_rect` check today, but the batch has no mandate to change those CutObjects; E1a-C3 pins it. Grouped sharp rectangles: `flattenObjects` composes the group transform onto the child (`:203-221`), the child is a rectangle so it skips `groupBuf` (`:293-297`) and takes the ordinary emit with the new lowering, one fill plus one overlay per child, `groupId` stamped. The plan's claim holds.

One wording hazard: step 1 says the corners are pushed "in object-local unrotated coordinates" and then lists `(x,y), (x+w,y), …` with `x, y` from `obj.transform`. Those are **world-frame, pre-rotation** coordinates, the same frame the rounded-rectangle arm and `object_to_path` use, and the frame `rotate_segment` expects (it rotates about `obj.x + width/2`). "Object-local" invites a Ted to subtract `x, y` and emit a rectangle at the origin. Say "world coordinates before rotation".

### 3. Completeness — **CONCERN**
(a) **The lowering predicate is not stated, and one reading opens a new silent-drop route.** Step 1 gates the contour on `paths.length === 0 && … rectangle && !rounded`. Step 2 says "a sharp rectangle on `fillLine` gets `effectiveMode = "fill"`" with no predicate. The `DesignObject` type allows a rectangle to carry `points` (`types.ts:47` plus the optional `points`); no producer in the tree makes one today (`SvgImportDialog.tsx:747-770` turns a rotated `<rect>` into a `path` and an unrotated one into a rectangle without points; `QrCodeDialog.tsx:76` and the tool make none), but a saved file can. If the lowering fires on type alone, such an object goes to Rust as `fill` with an arbitrary path, and the fill arm's `; fill skipped: non-rectangular paths` comment-and-skip (`gcode_gen.rs:897-908`) drops it silently — a route E1b does **not** convert (parent Out of scope, line 1). If the lowering fires only when the new contour branch fired, the object stays `fillLine` and the invariant throws, which is the loud outcome the charter wants. **Fix:** state the predicate as "lowering applies iff the contour branch fired" (one boolean set in step 1, consumed in step 2), and add the rectangle-with-points fixture (see dimension 9, where it also rescues E1a-M4). (b) Text on `fillLine`: the plan hedges correctly; the answer is in claim 17 — reachable via `generateGcode` only. Say so. (c) The overlay's rotation is asserted nowhere: E1a-M3 checks the fill object's `rotation === 30`; the overlay spreads `...base` (`:517-521`) so it carries it too, but a one-line assertion pins it. (d) Nothing else missing: `groupBuf` drain always emits `maskFill` (`:537`), locked/hidden/output-off paths are unchanged, orphan layers unchanged.

### 4. Right-sizing & reuse — **PASS**
Two files, one root, Simple tier (exempt from the dependency graph). Reuses `fillLineLayer`, the existing overlay block, the existing effective-mode block, and the `*ForTest` export convention (`:194`, `:222`, `:595`). Out-of-scope items are named and routed to the Parking Lot via Stage 3.5 with the parent's seven lines. Nothing gold-plated.

### 5. Security — **PASS**
No secrets, auth, network or file writes. Public repo: the batch adds no hardware identity. Blast radius is a generation error in the operator's console.

### 6. Failure modes — **PASS**
The invariant throw propagates as a rejection to the single caller and is caught, logged, and blocks START/FRAME/preview (claim 18). A degenerate rectangle (zero width or height) produces a 4-point closed contour with zero area; the fill arm emits no scan lines and the line arm cuts a zero-length or collinear perimeter — harmless, and identical to what a line-mode rectangle does today via `object_to_path`. Text conversion failure is a warning, pre-existing.

### 7. Change safety — **PASS**
No irreversible step. Rollback is the merge commit, with the S4c ordering named. Goldens untouched by construction (Rust not edited; the cargo run is `env -u KERF_UPDATE_GOLDEN`).

### 8. Data integrity & compatibility — **PASS**
`Layer.mode` on disk stays `fillLine`; `fill` is assigned on the CutObject only, like `maskFill` today (`:536`). Saved projects with a sharp Fill+Line rectangle change from "silently dropped" to "cut", which is the fix. Saved projects with a rectangle-with-points on `fillLine` change from "silently dropped" to "generation refuses, naming the object" under the predicate in 3(a); the plan's Risks line already accepts that class.

### 9. Verifiability (incl. testing the tests) — **FAIL**
The design is verifiable; the mutant table is not, in three places, and the plan's own done-condition ("every E1a-M* is red in the battery journal") cannot be met as written.

(a) **E1a-M4's stated kill cannot run in the battery and would be red for the wrong reason.** The battery accepts one contiguous `find`/`replace` per mutant (`mutation-battery.mjs:1555`). "Delete the invariant pass **and** revert the lowering" is two edits ~700 lines apart (the lowering in `toCutObjects` at `:402-414`; the invariant "just before `generateGcode` hands the list to Rust", i.e. near `:1101-1134`). It cannot be one mutant, and a hand-rolled harness is forbidden (`rules/architecture.md`, Layer 3). Worse, if it were stacked, the M4 test ("no CutObject carries `fillLine`", asserted on `toCutObjectsForTest` output) turns red because the lowering was reverted — that is E1a-M3's kill, already counted. It says nothing about whether the invariant exists. The plan's sentence "showing the invariant test, not the Rust boundary, is what catches it" describes an observation the test as specified cannot make: a test on `toCutObjectsForTest` output never reaches an invariant that lives in `generateGcode`.

(b) **E1a-M5 presupposes a seam the plan denies.** M5 needs "a `fillLine` CutObject present" at the invariant. M4's text says "a synthetic CutObject list cannot reach it". Both cannot be true. The invariant must be an exported pure function (`assertNoFillLineForTest(objects: CutObject[])`, matching the file's convention) so M5 can feed it a synthetic list; then M5 is a single, honest mutant (remove the throw, keep the loop).

(c) **The wiring — that the call actually sits on the production path — needs its own falsifiable kill, and one exists.** With the lowering predicate from 3(a), a sharp rectangle **with** `points` on a `fillLine` layer is a real input that reaches the emit as `fillLine` and must throw. That fixture, run through `toCutObjectsForTest`, is the M4 test: mutant "delete the invariant call" → no throw → red, one `find`/`replace`. It also proves the invariant is placed where every E1a test can see it, which forces the placement decision the plan leaves to Ted: put the call at `toCutObjects`'s return (`:591`), not in `generateGcode`, so `toCutObjectsForTest` and `generateGcode` both pass through it. (The parent said "at the emit point"; the return of `toCutObjects` is the emit point for both the per-object loop and the `groupBuf` drain.) If the author rejects the rectangle-with-points route, the honest alternative is to drop M4 from the battery spec and record the wiring as Razor-read (`grep -c "assertNoFillLine(" gcodeGen.ts` = 2), labelled "not mutant-killable", rather than a phantom kill.

(d) E1a-M1, M2, M3 are sound single mutants against the contour branch and the lowering; M2's "drop `closed: true`" and "drop the fourth corner" are two mutants, not one — give them ids (M2a/M2b) or pick one. C1-C3 are real controls; C3 is the scoping proof and is correct as specified (the contour branch is gated on `layer.mode === "fillLine"`, so `fill`/`offsetFill` rectangles keep `paths = []`).

(e) The reproduce-first step is executable at this stage (`toCutObjectsForTest` with `makeRect` on `fillLineLayer(0)`; `makeRect` at `:63` sets no `cornerRadius`, so `(obj.cornerRadius || 0) > 0` is false), and its expected output is stated precisely. Good.

(f) Browser check: `toCutObjectsForTest` is exported, so `await import('/src/lib/machine/gcodeGen.ts')` plus the store module (`/src/app/store/index.ts`) can run it in the dev server; the plan correctly says Rust is unreachable there. Name the store import so the step is copy-runnable.

### 10. Maintainability — **PASS**
Clean seams: one contour branch beside the synthesis block, one predicate in the effective-mode block, one exported invariant. ARCHITECTURE delta named for Stage 3.5 (the `gcodeGen.ts` entry at `ARCHITECTURE.md:99-102` or the `gcode_gen.rs` entry at `:162-168`; say which). Citation drift in claim 1 should be corrected so the next lift does not inherit it.

## Conditional dimensions

### X1. Physical & human safety — **PASS** [GATING]
The question this batch has to answer is whether the rectangle burns where the screen shows it, once. Verified: the Rust fill arm rotates the AABB by `obj.rotation + scan_angle` exactly once and does not consume the 4-point path (claims 11, 12); the line arm rotates the supplied contour once about the same centre; fill-before-line is enforced by the partition (claim 14) because `fill` + `line` on one layer is `has_mixed`. No double rotation, no double burn, no perimeter before fill. The perimeter is not kerf-offset, which is pre-existing for every fillLine perimeter and ruled open (Gate D2). Every failure path ends safe: a `fillLine` object that escapes lowering throws before any IPC, and the caller leaves `gcodeResult` untouched so START stays blocked (claim 18). Hardware-only check named (owner card via E4), not skipped. **Worst case per failure path, named:** lowering fires on a rectangle-with-points → the object reaches the fill arm's comment-and-skip and vanishes silently (a *missing* burn, not a wrong one) — closed by the predicate in 3(a); contour built in a wrong frame → the perimeter cuts at the origin while the fill burns at the rectangle (a wrong burn) — closed by E1a-M1's corner assertion and the wording fix in dimension 2. Nothing in the batch can energise the beam outside a commanded move.

### X5. Concurrency & re-entrancy — **PASS** [ADVISORY]
The invariant is a synchronous pass over a local array inside one `generateGcode` call; no shared state, no timer. Two overlapping generations were already possible and unchanged.

### X6. Operability & observability — **PASS** [ADVISORY]
The throw names the object id and type and says what would have happened; it lands in the console as `G-code generation failed: Error: internal: object '<id>' (<type>) reached the engine as fillLine …`. That is enough for Lee to find the object. Suggest dropping the `internal:` prefix or keeping it — either way the message is the field evidence and should be asserted verbatim in E1a-M5.

## Stress tests

### Pre-mortem — three months out, this failed
1. **A rectangle on a Fill+Line layer burned the fill and no outline, or vanished.** The lowering predicate was written on `obj.type` alone; a project saved by an older SVG import carried a rectangle with `points`; it went to Rust as `fill` with a non-rectangular path and the fill arm wrote `; fill skipped` — the exact comment-and-skip E1b did not convert. What we should have seen: the plan named the mode to lower to but not the condition under which to lower.
2. **The battery journal shows E1a-M4 "red" and nobody noticed it was red for E1a-M3's reason** — or the spec refused the two-site mutant, Ted wrote a script to stack it, and the harness rule was broken to record a kill that proved nothing. What we should have seen: `mutation-battery.mjs:1555` allows one `find` per mutant.
3. **E1b landed, the invariant lived only in `generateGcode`, and a later `toCutObjects` refactor emitted `fillLine` from a new site; every E1a test still passed** because they all run through `toCutObjectsForTest`, which never reached the invariant. What we should have seen: the parent said "enforced at the emit point".

### Load-bearing assumptions
1. **The Rust fill arm ignores the path after validating it** — verified (`:936-975` reads `obj.x/y/width/height` only). Consequence if wrong: double rotation of the fill. Not wrong.
2. **The Rust line arm rotates supplied paths once about the object centre** — verified (`:496-504`, `:1328-1339`). Consequence if wrong: perimeter misplaced. Not wrong.
3. **No shipped producer emits a sharp rectangle with `points`** — medium confidence: SVG import, QR and the tool checked; `fileOps/index.ts` load/migration path (`:872` area) not read. Consequence if wrong: with the predicate in 3(a) the object throws loudly (intended); without it, silent drop. Resolve by the predicate, not by auditing every producer.
4. **A battery mutant is one contiguous edit** — verified. Consequence: E1a-M4 must be re-specified before the spec is written.

### Inversion — when would a rejected alternative win?
- **Contour inside `synthesizeFillContour`** wins if `fill`/`offsetFill` sharp rectangles also need a contour. They do not: the fill arm rasterises the AABB from `paths=[]`, and the batch has no evidence about the `offsetFill` arm's empty-path behaviour. Condition not true; scoping to `fillLine` is right.
- **A Rust `fillLine` arm** wins if the TS side cannot express fill-before-line for a rectangle. It already does for paths and rounded rectangles (`:509-523`). Not true.
- **Invariant in `generateGcode` rather than at `toCutObjects`'s return** wins if there were a producer of CutObjects other than `toCutObjects`. There is none (`:922` is the only call). Not true; the return of `toCutObjects` is the stronger placement.
- **Skipping the invariant entirely because E1b's `Err` will catch it** wins if E1b were merged first. The parent sequences E1a first precisely so the silent drop is fixed before it becomes a loud failure, so between the two merges the TS invariant is the only guard. Not true.

## Overall verdict

**FAIL, narrowly, on verifiability alone.** The change itself is right and I checked it against the Rust arms rather than the comments: the sharp rectangle will fill once, rotated once, and be outlined once, in the order the partition already enforces, with nothing kerf-offset that a standing ruling says an implementer may not settle. The scoping to `fillLine` is correct and E1a-C3 proves it. What blocks the gate is the evidence plan: E1a-M4 cannot be expressed as one battery mutant and, if stacked by hand, would be red for M3's reason; E1a-M5 needs a seam (an exported invariant) that M4's own text says does not exist; and the lowering predicate is unstated, which is both a completeness gap (one reading opens a fill-arm comment-and-skip that E1b leaves alone) and the missing ingredient that would make the invariant's wiring falsifiable. All three are resolved by the same two decisions — lower iff the contour branch fired, and put the exported invariant at `toCutObjects`'s return — plus one rectangle-with-points fixture. Fold those, correct the three `synthesizeFillContour` line numbers, and this passes.

## Must-fix, prioritised

1. **Core 9 / E1a-M4:** re-specify as a single-site mutant. Export the invariant as `assertNoFillLineForTest`, call it at `toCutObjects`'s return (`:591`), and kill "delete the call" with a sharp rectangle carrying `points` on a `fillLine` layer, which under fix 2 stays `fillLine` and must throw. If that route is rejected, remove M4 from the battery spec and record the wiring as Razor-read, labelled not mutant-killable — never a stacked mutant.
2. **Core 3(a) / X1:** state the lowering predicate: `effectiveMode = "fill"` **iff** the new contour branch fired (one boolean), never on `obj.type` alone. Add the rectangle-with-points fixture to E1a-M4's table and name the fill arm's `; fill skipped` (`gcode_gen.rs:897-908`) as the route the predicate closes.
3. **Core 9 / E1a-M5:** make M5's fixture a synthetic CutObject list fed to the exported invariant; assert the message names the id and type verbatim; mutant = remove the throw. Delete the sentence "a synthetic CutObject list cannot reach it".
4. **Core 2 wording:** replace "object-local unrotated coordinates" with "world coordinates before rotation (`obj.transform.x/y`, the frame `rotate_segment` and `object_to_path` use)".
5. **Citations:** `synthesizeFillContour` is `:156-191`, rounded arm `:171-189`, `return null` `:190`. `groupBuf` condition is `:293-297` (comment `:288-292`).
6. **E1a-M2:** split into M2a (drop `closed: true`) and M2b (drop the fourth corner), or pick one; the battery needs one edit per id.
7. **Completeness (small):** state that text on `fillLine` is reachable only via `generateGcode` (`:868-901`; skipped at `:280-283` through `toCutObjectsForTest`); assert the overlay's `rotation === 30` in M3; cite `MachinePanel.tsx:157-190` as the catching caller instead of asking Ted to find it; name the store import for the browser step; the kerf-offset Parking Lot line points at Gate D2.
