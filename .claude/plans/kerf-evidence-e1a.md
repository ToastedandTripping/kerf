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

- Rectangles carry no points. `synthesizeFillContour` (`gcodeGen.ts:158-197`) has an ellipse arm and a rounded-rectangle arm (`:185-195`). For `cornerRadius 0` it returns `null` (`:197`).
- `buildCutLayer` copies `layer.mode` (`:85`).
- The maskFill remap only fires in two cases, so a sharp rectangle on `fillLine` keeps `effectiveMode === "fillLine"`:
  - for `isNonRectShape` (`:286`: ellipse, path, line), at `:403-405`;
  - for a *rounded* rectangle with paths, at `:407-414`.
- The emit at `:506` pushes one CutObject with `layer.mode = "fillLine"` and `paths = []`.
- The overlay block (`:510-523`) needs a closed path, and there is none, so no perimeter is emitted.
- Rust has no `fillLine` arm. It emits `; unknown layer mode … object skipped` (`gcode_gen.rs:1271-1279`). E1b makes that path an error. **E1b runs after this batch, so a still-unlowered `fillLine` then becomes a loud failure rather than a silent one.**
- Grouped sharp rectangles take the same path. The coalescing `groupBuf` is for non-rect shapes only (`:288-292`).

## Change (`src/lib/machine/gcodeGen.ts` only)

1. **A closed four-corner contour for a sharp rectangle headed to `fillLine`, and for no other mode.**
   - Immediately after the existing synthesis block (`:390-396`), add: when `paths.length === 0 && layer.mode === "fillLine" && obj.type === "rectangle" && !((obj.cornerRadius || 0) > 0)`, push `{ points: [(x,y), (x+w,y), (x+w,y+h), (x,y+h)], closed: true }` in object-local unrotated coordinates.
   - This is the same frame the rounded-rectangle arm uses. Rotation travels on `base.rotation` and Rust applies it, as for rounded rectangles.
   - **Why this does not go inside `synthesizeFillContour`:** that function also serves `fill` and `offsetFill`. Returning corners there would change the CutObjects of every sharp rectangle on those layers, and E1a has no mandate or golden coverage for that. The parent's mutant "restore `return null` for `cornerRadius 0`" becomes E1a-M1 below, named for where the change actually lives.
2. **Lower that CutObject to `fill`.**
   - Extend the effective-mode block (`:402-414`) so a sharp rectangle on `fillLine` gets `effectiveMode = "fill"`.
   - The Rust `fill` arm accepts no paths or a single closed 4-point path, and applies `obj.rotation` (`gcode_gen.rs:882-927`).
   - The overlay block then emits the `line` perimeter from the same closed contour.
3. **The invariant, enforced once, for every object type.**
   - Just before `generateGcode` hands the CutObject list to Rust (Ted names the exact line), add one pass: any CutObject whose `layer.mode === "fillLine"` makes generation throw `Error("internal: object '<id>' (<objType>) reached the engine as fillLine; it would be silently skipped")`.
   - This covers the per-object emit, the `groupBuf` drain and any future site.
   - A throw inside `generateGcode` must surface loudly in the UI. Before relying on it, Ted cites the call site that catches and displays a generation error (read `gcodeFailureLoud.test.tsx`'s header and the caller it tests). If a TS throw would instead be swallowed, stop and report NEEDS_CONTEXT.
4. **The perimeter is not kerf-offset.** The offset block (`:416-478`) is line-mode only. This is pre-existing and parked (parent Out of scope). No test asserts an offset.

## Tests (`src/lib/machine/__tests__/gcodeGen.test.ts`, new `describe` only; reuse `fillLineLayer` at `:298`)

**Reproduce first.** Before any edit, a test through `generateGcode`'s CutObject output for a sharp rectangle on a `fillLine` layer must show exactly one CutObject, with `layer.mode === "fillLine"` and empty `paths`, and no `_line_overlay`. Quote that output in the report. If it does not reproduce, stop and report NEEDS_CONTEXT.

Mutation battery spec `kerf-evidence-e1a`, with ids exactly as below:

| Id | Assertion | Wrong variant that must turn it red |
|---|---|---|
| E1a-M1 | sharp rectangle on `fillLine`, rotation 0: one `fill` CutObject whose single path is closed with 4 points at the rectangle's corners, plus one `line` overlay with the same closed path | remove the new sharp-rectangle contour branch |
| E1a-M2 | the overlay's path is `closed: true` and has 4 points | drop `closed: true` (or the fourth corner) |
| E1a-M3 | sharp rectangle on `fillLine` with rotation 30: the fill CutObject's mode is `fill` and `rotation === 30` | leave `effectiveMode` at `fillLine` for the sharp rectangle |
| E1a-M4 | across one fixture per object type the generator emits on a `fillLine` layer, no CutObject carries `mode: "fillLine"`. Fixtures: sharp rectangle, rounded rectangle, ellipse, closed path, open path, line, a group of two sharp rectangles, a group of two closed paths, and text if the file's existing text-conversion mocks (`describe` at `:1090`) make it reachable (say which) | delete the invariant pass. A synthetic CutObject list cannot reach it, so this mutant is proved by also reverting the lowering (E1a-M3's change) and showing the invariant test, not the Rust boundary, is what catches it |
| E1a-M5 | the invariant throws, with the object id in the message, when a `fillLine` CutObject is present | remove the throw (keep the pass as a no-op) |
| E1a-C1 | (control) rounded rectangle on `fillLine`: CutObjects unchanged from before this batch (`maskFill` + overlay) | — |
| E1a-C2 | (control) the existing fillLine tests at `:307-380` stay green unmodified | — |
| E1a-C3 | (control) sharp rectangle on a **`fill`** layer and on an **`offsetFill`** layer: CutObjects byte-identical to before this batch (`paths = []`) | — |

## Verification

- `npx vitest run src/lib/machine/__tests__/gcodeGen.test.ts`
- `npx tsc --noEmit`
- `npm test`: the baseline measured at relay start, plus the new tests, none weakened.
- `npm run lint`, with no new warnings.
- `npm run format:check`
- Battery journal: every E1a-M* is red and every E1a-C* is green.
- **Rust:** not touched. `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim engine::gcode_gen` is run once and recorded green, to show the fill arm's existing tests still hold. The end-to-end emitted-G-code proof belongs to E1b.
- **Browser** (`npm run dev` + Chrome DevTools MCP): set a layer to Fill+Line, draw a rectangle with the rectangle tool, and run `generateGcode`'s CutObject builder via `await import('/src/lib/machine/gcodeGen.ts')` in `evaluate_script`. The builder must return a `fill` and a `line` object. The Rust engine is not browser-reachable. State that.
- **Hardware-only (named):** a Fill+Line rectangle burned on scrap shows a filled interior and a cut outline. This check goes on the owner's card through E4.

## Stage 3.5 obligations (orchestrator)

- Append the parent's seven Out-of-scope lines to ROADMAP `## Parking Lot` (parent §Out of scope, verbatim substance), in the existing `- **Title** — detail.` shape.
- ARCHITECTURE.md delta: one line in the G-code generation section saying the TS generator never emits `fillLine` to Rust. It lowers to `fill`/`maskFill` plus a `line` overlay and throws otherwise.

## Risks and rollback

- **G-code changes for sharp Fill+Line rectangles, which now cut.** That is the intended fix. No existing golden covers a sharp rectangle on `fillLine`, so none move. E1b adds the rectangle fixture.
- **The invariant could fire on a project that generated "successfully" before.** That project was silently dropping objects, and the error names them. This is intended (charter: no silent G-code error).
- **Text on a `fillLine` layer:** R1's F5 may land in the same window. It changes text points only, not mode handling. If both are merged and the text fixture's expected CutObjects shift, rebase E1a's text fixture on R1. Never weaken it.
- **Rollback:** revert the relay merge commit. Safety S4c must be reverted first if it has landed on top.
- **Irreversible steps:** none.
