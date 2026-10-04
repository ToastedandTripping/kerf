# Kerf: the S-Curve and Posterize power-curve presets burn a raster as a negative; fix the presets and the blank editor (UI polish TB3)

Revision 3, 2026-10-04. Revision 1 FAILED astra round 1 (`-critic-r1.md`); revision 2 FAILED astra round 2, on X5 and X1 only (`-critic-r2.md`). This revision folds both; the fold tables are at the end. This is a correctness bug. It is follow-on plan TB3 from `.claude/plans/kerf-ui-polish.md` (revision 3, critic PASS), and that entry's "Requirements" and "Acceptance evidence" are binding here.

## Intent (grilled)

Grill: skipped, with this reason. The defect is unambiguous and no choice in it depends on Lee's preference. Lee ruled the order on 2026-10-02 ("All recs", then "Kick off the relay"), and the coordinator relayed his go on 2026-10-04 ("get him working on the active projects"). Everything below is technical, decided under Lee's 2026-09-29 delegation ("I defer to your judgement and research").

**Summary / key decisions.**
- **The bug.** Two of the three presets in the Power Curve editor (S-Curve, Posterize) map black (shade 0) to 0% power and white to 100%. A photo engraved with either burns as its negative, and nothing warns.
- **The fix.** Give both presets the direction Linear already has: shade 0 at 100%, falling to 0% at shade 255.
- **The editor.** It draws its curve when it opens, instead of staying blank until first hovered.
- **Saved projects.** Stored curves are never rewritten. A layer saved with the old points keeps generating exactly what it generated before; the release note tells the owner how to re-pick.

## Diagnosis (verified on marvin/kerf-gap at 70cdfa1)

- **The point convention.** `CurvePoint` is `x` = input shade 0-255, `y` = output power 0-100% (`src/components/panels/PowerCurveEditor.tsx:4-7`). The engine builds a 256-entry LUT from the points with monotone cubic (Fritsch-Carlson) interpolation, then maps power back to shade: power 100% = shade 0 (full burn), power 0% = shade 255 (no burn) (`src-tauri/src/engine/image_gcode_gen.rs:225-230`, `build_power_curve_lut` at :230). The LUT is applied to every pixel before dithering (`:141-149`). `power_curve_linear_is_identity` (`:534-552`) confirms that Linear `[{0,100},{255,0}]` is the identity.
- **The inverted presets** (`PowerCurveEditor.tsx:9-31`). Both rise with shade, so black gets 0%:
  - S-Curve: `[{0,0},{64,10},{128,50},{192,90},{255,100}]`.
  - Posterize: `[{0,0},{84,0},{85,33},{169,33},{170,66},{254,66},{255,100}]`.
- **How a preset reaches the laser.**
  - A preset button copies its points into the editor (`:481`, `setPoints([...pts])`).
  - Apply writes them to the layer (`LayerPanel.tsx:831-839`, `onManualUpdate({ powerCurve: pts })`).
  - Saving serialises the store with `useStore.getState().toProject()` and `JSON.stringify` (`src/lib/fileOps/index.ts:507-508`).
  - Opening parses with `parseAndValidateProject` (`:26`) and loads with `loadProjectWithMigrations` (`:174`).
  - At Generate, `generateGcode()` (`src/lib/machine/gcodeGen.ts:905`, exported) reads the store once and builds each image request. The raster request carries `powerCurve: layer.powerCurve?.map(p => [p.x, p.y])` into `invoke("generate_image_gcode", …)` (`:697-729`).
  - The command wraps `image_gcode_gen::generate(&ImageEngraveRequest)` (`src-tauri/src/commands/gcode.rs:220-224`, engine `:166`).
  - A project stores raw points, never a preset name.
- **The highlight.** The selected-preset highlight matches the current points against `PRESETS` (`:310`). After the fix, a layer holding the old S-Curve points matches no preset, which is accurate.
- **The blank editor.**
  - The draw effect is `useEffect(() => { draw(); }, [draw])` (`:221-223`). `draw` changes only when `points`, `dragIndex` or `hoverIndex` change, and the canvas mounts only after `if (!open) return null` (`:324`). So opening the editor with the same points reference draws nothing.
  - `draw` returns early when there is no canvas (`:142`) or no 2D context (`:144`). It draws the grid lines and a dashed diagonal first, then the curve, then one `arc` per control point (`:197`). Only the control-point arcs are specific to the curve.
- **The generation snapshot, and a pre-existing race that TB3 does not own.**
  - `generateGcode()` reads the store once, at call time. A single generation never mixes curve state.
  - `updateLayer` marks an EXISTING result stale (`store/index.ts:345-351`).
  - **However, completion clears the flag unconditionally:** `setGcodeResult: (result) => set({ gcodeResult: result, gcodeStale: false })` (`store/index.ts:692`), called from the Generate handler (`MachinePanel.tsx:386`). So when an Apply (or any edit) lands while a generation is in flight, the older generation's result is published as current. When no result existed at the start, the edit does not set the flag at all.
  - This is pre-existing and not specific to curves: any layer or design edit during a generation hits it. TB3 neither introduces it nor relies on it. It belongs to UI polish follow-on **TB6** ("Preview regeneration ... revision identity, stale-result handling, edit-during-generation"), and gets a new Parking Lot line (Deferrals).
  - **The explicit prerequisite for TB3's owner card:** press Generate only after Apply, and make no edit while a generation runs (the card's steps say so).

## Design

1. **New preset points.** Each is monotone non-increasing and maps shade 0 to its maximum:
   - S-Curve `[{0,100},{64,90},{128,50},{192,10},{255,0}]`. This is the old curve mirrored about 50% power: the same gentle ends and steep mid-tones, in the right direction.
   - Posterize `[{0,100},{84,100},{85,67},{169,67},{170,34},{254,34},{255,0}]`. That is three power bands of 100%, 67% and 34%, over shades 0-84, 85-169 and 170-254, plus pure white (shade 255) at 0%. Monotone cubic interpolation keeps each band flat, because both tangents inside a flat segment are 0.
   - Linear is unchanged.
2. **Draw on open.** The draw effect becomes `useEffect(() => { if (open) draw(); }, [open, draw])`.
   - The early returns at `:142` and `:144` stay as they are: with no context, the editor shows no plot.
   - Apply, Cancel, Escape and the focus trap are unchanged. Nothing is applied or generated as a side effect of drawing or of a failed draw.
3. **No migration.** Saved `layer.powerCurve` points are never rewritten. The file holds raw points, which cannot be told apart from a deliberate custom curve, so a migration would change a saved job's output without the owner's choice.
4. **The release-note line.** The release session owes it, and the ROADMAP shipped entry carries the text: "Fixed: the S-Curve and Posterize power-curve presets were inverted, so they burned an image as its negative. Layers that already used them keep their old curve until you change it: open the layer's power curve, pick the preset, press Apply, then save the project."

## Batch, tier and dependencies

One batch, `tb3`, Standard tier.

| file | root | change |
|---|---|---|
| `src/components/panels/PowerCurveEditor.tsx` | `src` | the two preset arrays; the draw effect's dependencies and its `open` guard |
| `src/components/panels/__tests__/powerCurveEditor.test.tsx` (new) | `src` | T1-T6 |
| `src-tauri/src/engine/image_gcode_gen.rs` | `src-tauri` | tests only, inside the existing `mod tests`; no production line changes |
| `src-tauri/tests/golden/tb3_legacy_s_curve.gcode`, `tb3_legacy_posterize.gcode`, `tb3_linear.gcode` (new) | `src-tauri` | N3's pinned-base goldens, captured at the base commit |
| `docs/owner-cards/tb3-legacy-s-curve.kerf` (new) | `docs` | the bounded legacy project for owner card step 3 |
| `ROADMAP.md` (Stage 3.5) | root | shipped entry with the release note; the owner card in `next` |

**Waiver for the multi-root rule** (8 files over `src`, `src-tauri` and `docs`, all exclusive to this batch). This is one defect: a value table in TS whose meaning lives in the Rust LUT. The Rust edits are tests that pin that meaning, with no production change. Splitting the batch would ship a preset fix with nothing pinning what its numbers do.

**Dependencies.**
- `tb3` depends on nothing.
- `tb3` must merge before UI polish batch A4, which restyles `PowerCurveEditor.tsx` (the polish plan's collision table: "TB3 first").
- `tb3` does not touch `src/index.css`, so it can run beside polish A1, which is in flight.

## Tests

### TS (`powerCurveEditor.test.tsx`)

- **T1, direction.** `PRESETS` is exported for the test (a named export; the component's behaviour is unchanged). For every preset:
  - the point at `x` 0 has the preset's maximum `y`;
  - `y` never rises as `x` increases;
  - the point at `x` 255 has `y` 0.

  This is red today for S-Curve and Posterize.
- **T2, source sync with the Rust fixtures.** Read `src-tauri/src/engine/image_gcode_gen.rs` as text and extract the literal arrays `TB3_S_CURVE` and `TB3_POSTERIZE`. The extraction must fail the test if either is missing or appears more than once. Assert each equals its TS preset, point for point.
- **T3, draw on open, curve-specific.**
  - Stub `HTMLCanvasElement.prototype.getContext` to return a recording context. jsdom has no canvas.
  - Render with `open={false}`, then rerender with `open={true}` and the same `points` reference.
  - Assert the curve stroke itself: after open, the recording contains the curve path, a `moveTo` at the first point's canvas coordinates (`shadeToCanvasX(x)`, `powerToCanvasY(y)`, exported or recomputed from the component's constants), followed by the curve's segments and a `stroke` in the curve's own `strokeStyle`. Assert the control-point `arc` calls too. Grid strokes and the dashed diagonal alone do not pass.
  - Clear the recording, Cancel, reopen with different incoming points, and assert the curve path now starts at the new first point.
  - This is red today. Mutation: removing `open` from the dependencies must fail it.
- **T4, Apply writes once.**
  - Pick S-Curve, press Apply, and assert `onApply` is called exactly once with the new S-Curve points.
  - Cancel after picking a preset: `onApply` is not called.
  - With `getContext` returning null, Apply still works and no plot is drawn. No crash, and nothing applied implicitly.
  - **Failed regeneration after Apply** (in the MachinePanel generate path, with `invoke` mocked). Start with an existing result, then Apply a new curve (the result goes stale), then make `generate_image_gcode` reject. The old result stays flagged stale, the existing failure message shows, and no job is dispatched. This pins today's behaviour; it does not cover the in-flight race, which is TB6's.
- **T5, the saved-project round trip, both legacy arrays.**
  - Put one image object on a raster layer whose `powerCurve` is the OLD S-Curve, and a second layer with the OLD Posterize.
  - Serialise with `toProject()` and `JSON.stringify`, as `saveToPath` does (`fileOps/index.ts:507-508`).
  - Parse with `parseAndValidateProject`, load with `loadProjectWithMigrations`, then call `generateGcode()` with `invoke` mocked.
  - Assert the captured `generate_image_gcode` payloads carry `powerCurve` deep-equal to the legacy pairs, in order. Both new presets get the same through Apply, then save/reopen, then generate.
  - This pins no-migration on the real save, open and raster-request path.
- **T6, the highlight.** Opening with the old S-Curve points highlights no preset; opening with the new ones highlights S-Curve.

### Native (`image_gcode_gen.rs`, `mod tests` only)

Constants:
- `TB3_S_CURVE` and `TB3_POSTERIZE`: literal copies of the new presets, with a comment naming `PowerCurveEditor.tsx` and T2;
- `TB3_OLD_S_CURVE` and `TB3_OLD_POSTERIZE`: the legacy arrays, for the delta and the legacy golden.

The ramp request, used by N2 and N3:
- `image_data`: a 256x1 8-bit grayscale PNG with pixel i = shade i, built in the test;
- `width` 25.6 and `height` 0.1, with `interval` 0.1, so one pixel is 0.1 mm;
- `power` 100, `power_min` 0, `s_value_max` 1000, `power_mode` "variable", `dither` "grayscale";
- `bidirectional` false, `overscan` 0, `scanning_offset` 0;
- `brightness` 0, `contrast` 0, `gamma` 1.0, `invert` false, `rotation` 0, `scale_x` and `scale_y` 1.0, `origin_top` true, `remove_background` false;
- `x` and `y` 0, `speed` 1000, `passes` 1.

The tests:
- **N1, LUT direction.**
  - For each new preset: `lut[0] == 0` (black stays full burn), `lut[255] == 255` (white stays no burn), and `lut` non-decreasing in its input.
  - For each OLD preset: `lut[0] == 255`, which documents the defect.
  - Posterize's three bands come out as exact levels: `lut` over shades 0-84 equals `255 - round(255 × 1.00)`; over 85-169, `255 - round(255 × 0.67)`; over 170-254, `255 - round(255 × 0.34)`; and shade 255 maps to 255. Compute these with the LUT's own rounding rule, read from `build_power_curve_lut`.
- **N2, the spatial before/after.**
  - Decode the G-code from `generate(&req)` into a power map over the 256 pixel columns. Walk the moves in order, tracking X and the modal S. Each `G1` with a positive S from X0 to X1 assigns that S to every column whose centre lies in [X0, X1). A column no burning move covers (a `G0` travel, an `S0` span, or no move at all) gets S0. This handles the scanner merging equal S values into one move (`mask_fill.rs:684-718`) and white pixels emitting nothing.
  - The independent oracle is the LUT, not the G-code: the expected S per column is `round(s_value_max × (255 - lut[i]) / 255)` under the grayscale scanner's mapping. Read the exact mapping from the scanner and cite it in the test; allow ±1 count only for its rounding.
  - With `TB3_S_CURVE`: column 0 at the maximum S, column 255 at S0, never rising. With `TB3_OLD_S_CURVE`: the reverse. Posterize: three flat plateaus and S0 at column 255.
- **N3, the pinned-base legacy golden.**
  - Before any production edit, the implementer runs the ramp through `generate` with `TB3_OLD_S_CURVE`, `TB3_OLD_POSTERIZE` and Linear on the base commit. They write the three full G-code strings under `src-tauri/tests/golden/` (for example `tb3_legacy_s_curve.gcode`, `tb3_legacy_posterize.gcode`, `tb3_linear.gcode`), following the existing golden convention and the `env -u KERF_UPDATE_GOLDEN` discipline.
  - N3 asserts byte equality at HEAD. Since no Rust production line changes, this pins that legacy and Linear output is untouched now, and that a later engine change cannot alter it silently.
  - The report quotes the base commit sha and the command used to capture.
- **The existing tests stand unchanged:** `power_curve_linear_is_identity`, `power_curve_step_produces_binary` and `power_curve_lut_serialization_roundtrip`.

### Mutation battery (`~/marvin/scripts/mutation-battery.mjs`)

Every `find` must have `grep -cF` equal to 1, the journal is at the standard path, and the battery restores by construction (a disposable copy).
- **m1:** S-Curve's first point back to `{ x: 0, y: 0 }`. Kills T1 and T2.
- **m2:** Posterize's first point back to `{ x: 0, y: 0 }`. Kills T1 and T2.
- **m3:** `[open, draw]` back to `[draw]`. Kills T3.
- **m4:** the `arc` loop removed from `draw`. Kills T3.
- **m7:** only the curve-rendering block removed from `draw`, with the grid, the diagonal and the arcs kept. Kills T3 and proves it checks the curve stroke, not just the handles.
- **m5:** a `loadProjectWithMigrations` mutant that rewrites `powerCurve`, for example replacing the old S-Curve with the new one. Kills T5.
- **m6:** `TB3_S_CURVE`'s first literal flipped in Rust. Kills T2.

The control: Linear stays byte-identical under N3, and the controls must stay green.

## Verification

- **Gates:**
  - `npx vitest run --cache=false` (full);
  - `npx tsc --noEmit`;
  - `npm run -s lint`;
  - `npm run -s format:check`;
  - `cargo test --manifest-path src-tauri/Cargo.toml --features sim` with `CARGO_TARGET_DIR=$HOME/.cache/kerf-engine-arm-target` and `env -u KERF_UPDATE_GOLDEN`;
  - clippy `--all-targets --features sim -- -D warnings`;
  - `cargo fmt --check`.

  Every existing golden is unchanged; the only new goldens are N3's.
- **Browser** (dev server, puppeteer; the Chrome DevTools MCP is disconnected):
  - open a raster layer's power curve editor; the curve and its points are drawn on first open, with no hover;
  - pick each preset; S-Curve and Posterize fall from top left to bottom right, as Linear does;
  - Cancel, reopen: still drawn.

  Screenshots go in the relay log.
- **Recorded status.** The ROADMAP shipped entry says "implementation merged to the session branch; owner card pending; not physically qualified". It flips to qualified only when the owner card passes. It is not a release gate: the release rulings in DECISIONS (2026-09-27) are unchanged.
- **Owner card** (`next`; Lee runs it, owner only, in the release build). Evidence is the visible mark on the material, and nothing about the beam beyond it (status-only ruling, DECISIONS 2026-09-10 as amended):
  - **Setup:**
    - scrap card or a 3 mm plywood offcut, on the bed with nothing under it that can burn;
    - the extraction or air assist the owner normally uses;
    - the machine's physical power switch or E-stop within reach;
    - the owner stays at the machine for the whole run.
  - **Design** (steps 1 and 2): import a 40 × 10 mm black-to-white horizontal gradient image. Kerf's own material-test grid is not used for this. Set the layer and image to the full recipe below, and confirm each value on screen before the job:
    - power mode: Variable (M4);
    - Max power: no more than 20%; Min power: 0;
    - dither: Grayscale;
    - interval: 0.1 mm;
    - image adjustments neutral: brightness 0, contrast 0, gamma 1.0, invert off, background removal off;
    - passes: 1;
    - speed: the speed the owner already uses for photo engraving on this material. If he has none for this material, run Kerf's material test on it first, and use the lightest cell that marks clearly;
    - only this layer enabled for output.
  - **Frame first:** press FRAME and watch the head trace the bounding box.
  - **Before every burn:** press Generate after the last Apply, and make no edit while it generates. That is the prerequisite in the Diagnosis: until TB6 lands, an edit during generation can publish an older result as current. Then press FRAME and watch the head trace the bounding box.
  - **Worst cases this card guards against:** a flame on the material; marking outside the framed box; marking that continues after the job ends; Kerf not responding to STOP.
  - **Abort procedure:** on any of these, press STOP, then switch the controller off at its power switch. That isolates the laser physically, which a status report cannot. Note what happened, and do not re-run until it is understood.
  - **Steps:**
    1. Select the new S-Curve, then press Apply. Engrave. Pass: the black end is darkest, the white end unmarked, and darkness falls smoothly between them.
    2. The same, with Posterize. Pass: three distinct bands from dark to light, and the white end unmarked.
    3. **Legacy check, bounded.** Open `docs/owner-cards/tb3-legacy-s-curve.kerf`, which the relay commits. It holds one 40 × 10 mm gradient on one raster layer with the old S-Curve points and the recipe above. Do not open an arbitrary older project for this step. Before generating, re-check every recipe value on screen against the list above; if any differs, stop and do not run. Do not re-pick the preset. Generate, frame, engrave. Pass: it burns the old way (the white end darkest). That confirms nothing was migrated.
  - **Outcome:** PASSED, FAILED (a fix relay), or INCONCLUSIVE (any abort).

## Risks and rollback

- **Someone may rely on the inverted look.** They can draw it as a custom curve, and saved layers keep it anyway.
- **Rollback.** Reverting the commit restores the old preset definitions. Projects whose owner re-picked a corrected preset and saved still hold the corrected raw points (stored data is never rewritten in either direction). After a revert those layers simply match no preset, so the highlight is absent. Revert is one commit and touches no stored data.

## Deferrals

One new Parking Lot index line, added in this revision's commit:

- **A generation that finishes after an edit publishes an outdated result as current** — `setGcodeResult` clears `gcodeStale` unconditionally (`store/index.ts:692`; called from `MachinePanel.tsx:386`), so an edit made during an in-flight generation leaves the older G-code looking current, and with no prior result the edit does not mark staleness at all. Pre-existing, not curve-specific; owned by UI polish TB6 (revision identity, stale-result handling, edit-during-generation). Found by astra on the TB3 plan, 2026-10-04. See `.claude/plans/kerf-power-curve-presets.md` → Diagnosis.

UI polish A4 later restyles this editor (presentation only).

## Decisions

None for Lee. Everything here is technical, and the release-note wording is plain and true.

## Fold table: critic round 1 (astra, FAIL)

| finding | verdict | where addressed |
|---|---|---|
| 3 Completeness: Posterize and the Apply-to-raster path untested | FAIL | T4 Apply; T5 both legacy arrays plus both new presets through save/reopen/generate; N1/N2 Posterize levels |
| 4 Right-sizing: tier, graph and waiver | CONCERN | "Batch, tier and dependencies" (Standard, one batch, a written waiver, TB3 before A4, beside A1) |
| 6 Failure modes: null context, failed generation | CONCERN | Design 2 and T4 (null context: no plot, nothing applied); the generation snapshot is cited in the Diagnosis |
| 7 Change safety: rollback wording | CONCERN | Risks and rollback, rewritten |
| 8 Data integrity: parse-only check, private helper | FAIL | T5 on the real seams (`toProject` + JSON, `parseAndValidateProject`, `loadProjectWithMigrations`, exported `generateGcode`, the mocked invoke payload); N3 pinned-base goldens |
| 9 Verifiability: a grid-only stroke passes; the S-per-pixel oracle ignores compression | FAIL | T3 asserts arcs at the control points (m4 proves it); N2 spatial decoding with the LUT as an independent oracle; N3 captured at base and committed |
| 10 Maintainability: a non-exported helper, unspecified mutation targets | CONCERN | exported seams only; T2 fails on a missing or duplicate array; m1-m6 specified |
| X1 Physical safety: an unbounded owner burn | FAIL | the owner card: setup, ≤20% power, frame first, abort procedure, evidence limits, PASSED/FAILED/INCONCLUSIVE |
| X4 Copy: "four bands"; "pick again" omitted Apply | CONCERN | Design 1 (three bands plus white); the release note says pick, Apply, save |
| X5 Reopen, Cancel, Apply, generation snapshot | CONCERN | T3 reopen with changed points; T4 Cancel and Apply-once; the snapshot and `gcodeStale` cited in the Diagnosis |
| X6 Status: shipped vs pending vs qualified | CONCERN | Verification, "Recorded status" |

## Fold table: critic round 2 (astra, FAIL on X5 and X1)

| finding | verdict | where addressed |
|---|---|---|
| X5: a false claim that an older result is never published as current | FAIL | Diagnosis: the claim is corrected, and the `setGcodeResult` race is cited (store/index.ts:692, MachinePanel.tsx:386) as pre-existing; owned by TB6, with a new Parking Lot line. The owner card's prerequisite is Generate after Apply, with no edits during generation. TB3 adds no publication path. |
| X1: the legacy step could inherit arbitrary saved settings | FAIL | Owner card step 3 uses a dedicated bounded fixture (`docs/owner-cards/tb3-legacy-s-curve.kerf`) and re-checks every value on screen; the worst cases and physical isolation (the controller power switch) are named. |
| 3: the owner recipe was not reproducible | CONCERN | The Design bullet gives the full recipe (mode, max and min power, grayscale, interval, neutral adjustments, passes, speed source, one layer enabled) and regeneration before each burn. |
| 4: the file table omitted the goldens | CONCERN | The table lists all 8 files; the waiver covers the actual roots. |
| 6: the failed-regeneration path was untested | CONCERN | T4: an existing result, then Apply, then a rejected generate; it stays stale, shows the failure and dispatches nothing. |
| 9: arcs prove the handles, not the curve | CONCERN | T3 asserts the curve path and stroke and clears between opens; m7 removes only the curve block. |
