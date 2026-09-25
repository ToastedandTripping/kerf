# Kerf evidence E1a: a sharp rectangle on a Fill+Line layer is filled and outlined, and nothing leaves the TS generator as `fillLine`

This plan is lifted from `/home/leesalo/marvin/state/audits/gap-2026-09-24/kerf/PLAN-silent-drop-and-evidence.md` §E1a (critic `PLAN-silent-drop-and-evidence-critic.md`, CONCERN, folded). Its lineage is `.claude/plans/kerf-relay-plan.md` §A2 (TS half) and astra PLAN §2.4. Where this file and a relay-plan body differ, this file wins. On anything this file does not cover, the parent wins. Every citation was re-read at `4e9c1e2` (session branch `marvin/kerf-gap` = master `caa0dcc` plus docs) on 2026-09-25.

- **Relay id:** `kerf-evidence-e1a`
- **Branch:** `relay/kerf-evidence-e1a`
- **Tier:** Simple. 2 files in one root (`src/`). No UI.

## Intent (grilled)

Grill skipped. The intent comes from the parent's Intent: CHARTER "Done looks like" (1), "no silent G-code error". The Summary for this batch:

> A rectangle drawn with Kerf's own tool on a Fill+Line layer must be filled and have its outline cut. Today it produces neither pass: the Rust engine writes `; unknown layer mode` as a comment and skips the object. After this batch no CutObject leaves the TS generator in a mode the Rust engine has no arm for.

## Existing plans reviewed (standing instruction)

Checked 2026-09-25 with `ls`, so untracked files show:
- The primary's `.claude/plans/`: 25 files, plus `archive/` (3 files from `259fa20`).
- The session branch adds three lifted files: `kerf-relay-plan.md` and its critic, restored by R0, and `kerf-safety-s1.md`.
- The audit directory: 9 files.

Only the parent's own safety S4c edits `gcodeGen.ts` or `gcodeGen.test.ts`, and S4c is sequenced after this batch. Three things touch nearby code without editing these files:
- **`refresh-cut-vs-screen` (running now):** only imports `flattenObjectsForTest` from `gcodeGen.ts`, in its own tests. It does not edit the file.
- **Safety S1 (lifted, not yet dispatched):** does not touch either file.
- **The F5 text bake in R1** (`geometryActions.ts` `textObjectToPaths`) changes the points `generateGcode` receives for flipped or rotated text. It does not change the text's mode handling. See Risks.

## Diagnosis (verified, read, not executed. The reproduce-first test below executes it.)

- Rectangles carry no points. `synthesizeFillContour` (`gcodeGen.ts:156-190`) has an ellipse arm and a rounded-rectangle arm (`:171-189`). For `cornerRadius 0` it returns `null` (`:190`).
- `buildCutLayer` copies `layer.mode` (`:85`).
- The maskFill remap only fires in two cases, so a sharp rectangle on `fillLine` keeps `effectiveMode === "fillLine"`:
  - for `isNonRectShape` (`:286`: ellipse, path, line), at `:403-405`;
  - for a *rounded* rectangle with paths, at `:407-414`.
- The emit at `:506` pushes one CutObject with `layer.mode = "fillLine"` and `paths = []`.
- The overlay block (`:510-523`) needs a closed path, and there is none, so no perimeter is emitted.
- Rust has no `fillLine` arm. It emits `; unknown layer mode … object skipped` (`gcode_gen.rs:1271-1279`). E1b makes that path an error.
- Grouped sharp rectangles take the same path. The coalescing `groupBuf` condition is for non-rect shapes only (`:293-297`).
- **What Rust does with the result (critic-verified, read from the arms):**
  - The `fill` arm validates that `paths` is empty or a single closed 4-point path (`gcode_gen.rs:893-908`), then rasterises the object's AABB rotated once by `obj.rotation + scan_angle` (`:936-975`). The contour is only a shape check.
  - The `line` arm rotates the supplied contour once via `rotate_segment` (`:496-504`, `:1328-1339`).
  - A `fill` + `line` pair on one layer is `has_mixed` in the partition (`commands/gcode.rs:82-98`), so the fill runs before the perimeter.
- `generateGcode`'s one production caller catches and displays a thrown error (`MachinePanel.tsx:157-190`, the catch `gcodeFailureLoud.test.tsx` exercises).

## Change (`src/lib/machine/gcodeGen.ts` only)

1. **A closed four-corner contour for a sharp, point-less rectangle headed to `fillLine`, and for no other mode.**
   - Immediately after the existing synthesis block (`:390-396`), add a branch. Its condition is `paths.length === 0 && layer.mode === "fillLine" && obj.type === "rectangle" && !((obj.cornerRadius || 0) > 0)`.
   - When the condition holds, push `{ points: [(x,y), (x+w,y), (x+w,y+h), (x,y+h)], closed: true }` from `obj.transform.x/y/width/height`. These are **world coordinates before rotation**, the same frame `object_to_path`/`rotate_segment` and the rounded-rectangle arm use. Rotation travels on `base.rotation`, and each Rust arm applies it once. Do not subtract x/y.
   - Declare `let sharpRectContour = false;` before the branch and set it to `true` inside it, so deleting the branch (E1a-M1) still compiles and the kill is semantic, not a `tsc` failure.
   - **Why this does not go inside `synthesizeFillContour`:** that function also serves `fill` and `offsetFill`. Returning corners there would change every sharp rectangle on those layers, which E1a has no mandate or golden coverage for.
2. **Lower to `fill` if and only if that branch fired.**
   - In the effective-mode block (`:402-414`), set `effectiveMode = "fill"` when `sharpRectContour` is true, never on `obj.type` alone.
   - A rectangle that already carries `points` (paths non-empty from `:374-385`) does **not** lower. Lowering it would route an arbitrary contour into the `fill` arm's own comment-and-skip (`gcode_gen.rs:897-908`, `; fill skipped: non-rectangular paths`), which E1b does not convert. It stays `fillLine`, and step 3 makes it a loud error instead of a silent drop.
   - The overlay block then emits the `line` perimeter from the closed contour.
3. **The invariant, enforced once, for every object type.**
   - Add a module-level `function assertNoFillLine(objects: CutObject[]): void`. It throws `Error("internal: object '<id>' (<objType>) reached the engine as fillLine; it would be silently skipped")` for the first CutObject whose `layer.mode === "fillLine"`.
   - Call it on `result` immediately before `toCutObjects` returns (`:591`). That covers the per-object emit, the `groupBuf` drain and any future site.
   - Export it for tests as `assertNoFillLineForTest`, beside the existing `toCutObjectsForTest` export (`:595`).
   - The throw surfaces at `MachinePanel.tsx:157-190`.
4. **The perimeter is not kerf-offset.** The offset block (`:416-478`) is line-mode only. This is pre-existing and parked under Gate D2 (DECISIONS: "Gate D2 (Phase 4 entry) is explicitly a 'Lee + architect call'"). No test asserts an offset.

## Tests (`src/lib/machine/__tests__/gcodeGen.test.ts`, new `describe` only; reuse `fillLineLayer` at `:298`)

**Reproduce first.** Before any edit, run a test through `toCutObjectsForTest` for a sharp rectangle on a `fillLine` layer. It must show exactly one CutObject, with `layer.mode === "fillLine"`, empty `paths` and no `_line_overlay`. Quote that output in the report. If it does not reproduce, stop and report NEEDS_CONTEXT.

Text is converted before `toCutObjects` (`generateGcode` `:868-901`; `toCutObjects` skips raw text at `:280-283`). The text fixture below therefore goes through `generateGcode` with the file's existing text-conversion mocks (`describe` at `:1090`), or it is omitted with the reason stated.

Mutation battery spec `kerf-evidence-e1a`. Each id is **one** contiguous find/replace (`mutation-battery.mjs:1555`), and no mutant is stacked. Every `find` string must be unique in its file (`MUTANT_ANCHOR_AMBIGUOUS`, `:1773-1779`). `closed: true` and `effectiveMode = "maskFill"` occur several times in `gcodeGen.ts`, so their anchors carry surrounding context.

| Id | Assertion | Wrong variant (one edit) |
|---|---|---|
| E1a-M1 | Sharp rectangle on `fillLine`, rotation 0, gives one `fill` CutObject whose single path is closed with 4 points at `(x,y) (x+w,y) (x+w,y+h) (x,y+h)`, plus one `line` overlay with the same closed path | Delete the new sharp-rectangle contour branch |
| E1a-M2a | The overlay's path has `closed: true` | Change the pushed contour's `closed: true` to `false` |
| E1a-M2b | The overlay's path has 4 points | Drop the fourth corner from the pushed contour |
| E1a-M3 | Sharp rectangle on `fillLine` at rotation 30: the fill CutObject has mode `fill` and `rotation === 30`, and the overlay has `rotation === 30` | Remove the `effectiveMode = "fill"` assignment for the sharp-rectangle case |
| E1a-M4 | A rectangle **carrying `points`** (a closed 5-point contour) on a `fillLine` layer makes `toCutObjectsForTest` throw, with its id in the message | Delete the `assertNoFillLine(result)` call at the return |
| E1a-M5 | `assertNoFillLineForTest` fed a synthetic list containing one `fillLine` CutObject `{ id: "r1", objType: "rectangle" }` throws a message containing `'r1' (rectangle)` verbatim, and does not throw for a list with none | Remove the `throw` inside `assertNoFillLine` |
| E1a-C1 | (control) Rounded rectangle on `fillLine`: CutObjects unchanged (`maskFill` + overlay) | Widen the lowering to rounded rectangles (routes them to `fill`) |
| E1a-C2 | (control) The existing fillLine tests at `:307-380` stay green unmodified | Change the overlay block's `layer.mode === "fillLine"` to `"fill"` |
| E1a-C3 | (control) Sharp rectangle on a **`fill`** layer and on an **`offsetFill`** layer: CutObjects identical to before this batch (`paths = []`) | Drop `layer.mode === "fillLine"` from the new branch's condition |
| E1a-C4 | (control) Across one fixture per object type on a `fillLine` layer, `toCutObjectsForTest` does **not** throw and no output CutObject has `mode: "fillLine"`. Fixtures: sharp rectangle, rounded rectangle, ellipse, closed path, open path, line, a group of two sharp rectangles, a group of two closed paths, and text via `generateGcode` (see above). This proves the invariant makes no type that cut before throw. | Make `assertNoFillLine` also throw on `maskFill` |

## Verification

- `npx vitest run src/lib/machine/__tests__/gcodeGen.test.ts`
- `npx tsc --noEmit`
- `npm test`: the baseline measured at relay start, plus the new tests, none weakened.
- `npm run lint`, with no new warnings.
- `npm run format:check`
- The vitest run shows every E1a-C* test green at baseline. The battery journal shows every E1a-M* **and** E1a-C* wrong variant `killed`, with `survived`, `errored` and `CONTROL_RED` all 0. Each C-id carries a wrong variant (below) so that it appears in the journal.
- **Rust:** not touched. `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim engine::gcode_gen` is run once and recorded green, to show the fill arm's existing tests still hold. The end-to-end emitted-G-code proof belongs to E1b.
- **Browser** (`npm run dev` + Chrome DevTools MCP): in `evaluate_script`, `const { useStore } = await import('/src/app/store/index.ts')` and `const g = await import('/src/lib/machine/gcodeGen.ts')`. Set layer 0's mode to `fillLine`, draw a rectangle with the rectangle tool, then run `g.toCutObjectsForTest(...)` over `useStore.getState().objects`/`layers` (Ted reads its signature at `:225`). It must return a `fill` and a `line` object. The Rust engine is not browser-reachable. State that.
- **Hardware-only (named):** a Fill+Line rectangle burned on scrap shows a filled interior and a cut outline. This check goes on the owner's card through E4.

## Stage 3.5 obligations (orchestrator)

- Append the parent's seven Out-of-scope lines (the kerf-offset line cites Gate D2, "Lee + architect call", not astra 2.3 alone) to ROADMAP `## Parking Lot` (parent §Out of scope, verbatim substance), in the existing `- **Title** — detail.` shape.
- ARCHITECTURE.md delta: one line in the G-code generation section saying the TS generator never emits `fillLine` to Rust. It lowers to `fill`/`maskFill` plus a `line` overlay and throws otherwise.

## Risks and rollback

- **G-code changes for sharp Fill+Line rectangles, which now cut.** That is the intended fix. No existing golden covers a sharp rectangle on `fillLine`, so none move. E1b adds the rectangle fixture.
- **The invariant could fire on a project that generated "successfully" before.** That project was silently dropping objects, and the error names them. This is intended (charter: no silent G-code error).
- **Text on a `fillLine` layer:** R1's F5 may land in the same window. It changes text points only, not mode handling. If both are merged and the text fixture's expected CutObjects shift, rebase E1a's text fixture on R1. Never weaken it.
- **Rollback:** revert the relay merge commit. Safety S4c must be reverted first if it has landed on top.
- **Irreversible steps:** none.

## Critic fold (2026-09-25)

Critic `kerf-evidence-e1a-critic.md` (Fable): FAIL, narrowly, on verifiability. X1 PASS: the change is right against the Rust arms. Every must-fix was re-checked against the tree before folding.

1. **E1a-M4 could not be one battery mutant.** The invariant is now an exported `assertNoFillLine`, called at `toCutObjects`'s return (`:591`, verified). M4 kills the call site using a rectangle that carries points, which stays `fillLine` under fix 2 and must throw. No mutant is stacked.
2. **Lowering predicate.** It fires only when the new contour branch fired, never on type. The rectangle-with-points case is added, and the fill arm's comment-and-skip (`gcode_gen.rs:897-908`, verified) is named as the route this avoids.
3. **E1a-M5** now feeds a synthetic list to the exported function and asserts the message verbatim. The false sentence "a synthetic CutObject list cannot reach it" is deleted.
4. **Coordinate frame.** The wording is now "world coordinates before rotation (`obj.transform.x/y`)".
5. **Citations fixed:** `:156-190`, `:171-189`, `:190` (verified by grep), and `:293-297`.
6. **E1a-M2** is split into M2a (closed) and M2b (fourth corner).
7. **Small items:**
   - The text route goes through `generateGcode`.
   - M3 now asserts the overlay's rotation too.
   - The loud-error caller is cited (`MachinePanel.tsx:157-190`, verified).
   - The browser step names its imports.
   - The kerf-offset Parking Lot line cites Gate D2.
   - The per-type sweep is now control E1a-C4 (no type that cut before is made to throw).

Rejected: none.

**Round 2 (recheck PASS).** Residuals A-C folded: the anchor-uniqueness note, the journal wording (each C-id now has a wrong variant), and `let sharpRectContour = false` declared before the branch.
