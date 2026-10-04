# Kerf: the S-Curve and Posterize power-curve presets burn a raster as a negative; fix the presets and the blank editor (UI polish TB3)

Revision 1, 2026-10-04. Correctness bug. Follow-on plan TB3 from `.claude/plans/kerf-ui-polish.md`, revision 3, critic PASS. Its "Requirements" and "Acceptance evidence" lines are binding here and are quoted where they apply.

## Intent (grilled)

Grill: skipped, with this reason. The defect is unambiguous, and no choice in it depends on Lee's preference. Lee ruled the order on 2026-10-02 ("All recs", then "Kick off the relay"). The coordinator relayed his go on 2026-10-04 ("get him working on the active projects"). Everything below is technical, decided under Lee's 2026-09-29 delegation ("I defer to your judgement and research").

**Summary / key decisions.**
- **The bug.** Two of the three presets in the Power Curve editor, S-Curve and Posterize, map black (shade 0) to 0% power and white to 100%. A photo engraved with either burns as its negative, and nothing warns.
- **The fix.** Give both presets the same direction as Linear: shade 0 at 100% power, falling to 0% at shade 255.
- **The blank editor.** The editor draws nothing when it first opens. Make it draw on open.
- **Saved projects are left untouched.** A layer that already stores the old points keeps them, so its output does not change behind the owner's back. The release note tells him how to repair it.

## Diagnosis (verified on marvin/kerf-gap at 8e7dfcc)

- **The point convention.** `CurvePoint` is `x` = input shade 0-255, `y` = output power 0-100% (`src/components/panels/PowerCurveEditor.tsx:4-7`). The engine builds a LUT from these points with monotone cubic interpolation, then maps power back to shade: power 100% = shade 0 (full burn), power 0% = shade 255 (no burn) (`src-tauri/src/engine/image_gcode_gen.rs:225-230` doc, `build_power_curve_lut` from :230). It applies the LUT to every pixel before dithering (`:141-149`).
- **What the engine treats as identity.** The test `power_curve_linear_is_identity` (`image_gcode_gen.rs:534-552`) confirms that Linear, `[{0,100},{255,0}]`, is the identity.
- **The inverted presets.** `PowerCurveEditor.tsx:9-31` defines:
  - S-Curve: `[{0,0},{64,10},{128,50},{192,90},{255,100}]`;
  - Posterize: `[{0,0},{84,0},{85,33},{169,33},{170,66},{254,66},{255,100}]`.

  Both rise with shade, so black gets 0% and burns nothing. That is a negative.
- **How a preset reaches a layer.** A preset button copies its points into the editor (`:481`, `setPoints([...pts])`). Apply writes them to the layer as `layer.powerCurve` (`LayerPanel.tsx:831-839`, `onManualUpdate({ powerCurve: pts })`). The points then travel unchanged to Rust (`gcodeGen.ts:108`, `:145`, `:729`, `:1244`, mapped to `[x, y]` pairs). A project file stores raw points, not a preset name.
- **The selected-preset highlight.** It is computed by matching the current points against `PRESETS` (`:310`). After the fix, a layer saved with the old S-Curve points will match no preset, and the editor will show no highlight. That is accurate: those points are no longer a preset.
- **Why the editor opens blank.** The draw effect is `useEffect(() => { draw(); }, [draw])` (`:221-223`). `draw` changes only when `points`, `dragIndex` or `hoverIndex` change. The canvas mounts only after `if (!open) return null` (`:324`). Opening with the same `initialPoints` reference triggers no `draw` change after the canvas exists, so it stays blank until the first hover or drag.

## Design

1. **New preset points** (from the UI polish plan's P21; each is monotone non-increasing and maps shade 0 to its maximum power):
   - S-Curve: `[{0,100},{64,90},{128,50},{192,10},{255,0}]`. This is the old curve mirrored about 50% power, so its shape (gentle at both ends, steep in the mid-tones) is kept and only the direction is fixed.
   - Posterize: `[{0,100},{84,100},{85,67},{169,67},{170,34},{254,34},{255,0}]`. These are the old four bands with their order reversed, so the darkest band gets the most power.
   - Linear is unchanged.
2. **The editor draws when it opens.** The draw effect becomes `useEffect(() => { if (open) draw(); }, [open, draw])`. Nothing else in the editor changes: not its handlers, `onApply` or `onClose`, the focus trap, nor the Escape listener.
3. **No migration.** Saved `layer.powerCurve` points are never rewritten. A project that used the old S-Curve or Posterize keeps exactly the output it had. This is deliberate. Silently changing what a saved job burns is the failure class this program exists to prevent, even when the change is a repair.
4. **Release-note line** (owed by the release session, recorded in the ROADMAP shipped entry): "Fixed: the S-Curve and Posterize power-curve presets were inverted, so they burned an image as its negative. Layers that already used them keep their old curve. Open the layer's power curve and pick the preset again."

## Files

| file | change |
|---|---|
| `src/components/panels/PowerCurveEditor.tsx` | the S-Curve and Posterize points; the draw effect's dependencies and its `open` guard |
| `src/components/panels/__tests__/powerCurveEditor.test.tsx` (new) | preset direction, the source-sync pin, draw on open, saved points pass through |
| `src-tauri/src/engine/image_gcode_gen.rs` | new tests in the existing `mod tests` only; no production change |
| `ROADMAP.md` (Stage 3.5) | shipped entry with the release-note line; the owner hardware step in `next` |

Three code files, with no store change, no IPC change, no native production change and no generator change.

## Tests

### TS (`powerCurveEditor.test.tsx`)

- **T1, direction.** For every preset in `PRESETS` (export it for the test, or read it from a test-only accessor):
  - the point with `x` 0 has `y` equal to the preset's maximum `y`;
  - `y` never rises as `x` increases;
  - the point with `x` 255 has `y` 0.

  Red today on S-Curve and Posterize.
- **T2, source sync with the Rust fixture.** Read `src-tauri/src/engine/image_gcode_gen.rs` as text. Extract the two literal arrays `TB3_S_CURVE` and `TB3_POSTERIZE` (below), and assert that each equals the TS preset point for point. A preset changed in one place without the other turns this red. This is the source-scan pin pattern from E1b T12.
- **T3, draw on open.** Stub `HTMLCanvasElement.prototype.getContext` to return a recording context (jsdom has no canvas). Render the editor with `open={false}`, then rerender with `open={true}` and the same `points` reference. Assert that the recording context drew the curve path (at least one `stroke` call after open).

  Red today. Mutation: removing `open` from the dependencies must fail it.
- **T4, saved points pass through.** A layer whose `powerCurve` is the OLD S-Curve array is fed through the project load path (`parseAndValidateProject`, or the function the save/open round trip uses). Assert that `layer.powerCurve` comes out deep-equal to the input.

  Also call the generation request builder that reads `layer.powerCurve` (`buildCutLayer`, `gcodeGen.ts:80`, which maps it at `:108`). Assert the outgoing `powerCurve` is the same pairs, in the same order.

  This pins "saved projects unchanged" and the no-migration decision.
- **T5, the highlight.** Opening the editor with the old S-Curve points highlights no preset. Opening it with the new S-Curve points highlights S-Curve.

### Native (`image_gcode_gen.rs`, `mod tests` only)

Add `const TB3_S_CURVE: [(f64, f64); 5]` and `const TB3_POSTERIZE: [(f64, f64); 7]`. They are literal copies of the new presets, with a comment naming `PowerCurveEditor.tsx` and T2. Add `const TB3_OLD_S_CURVE` as well, for the delta.

- **N1, LUT direction.** For each new preset LUT:
  - `lut[0] == 0`: black stays full burn;
  - `lut[255] == 255`: white stays no burn;
  - `lut` is non-decreasing in its input: a darker input never gets a lighter, lower-power output.

  For `TB3_OLD_S_CURVE`, `lut[0] == 255`, which documents the defect.
- **N2, the before/after generation fixture.** Build a 256x1 grayscale ramp (pixel i = shade i). Run it through `image_gcode_gen::generate(&ImageEngraveRequest)`, the engine function the `generate_image_gcode` command wraps (`commands/gcode.rs:220-224`): dither `grayscale`, bidirectional off, and a fixed power range (s_min 0, s_max 1000). Extract the S word per burned pixel in X order.
  - With `TB3_S_CURVE`, the shade-0 end is at the maximum S, the shade-255 end is at S0 or not burned, and S never rises with shade.
  - With `TB3_OLD_S_CURVE`, the shade-0 end gets S0 and the shade-255 end the maximum. That is the delta the fix intends.
  - With Linear or no curve, the program is byte-identical before and after this change. This test runs the same call at the base and at HEAD; no production line in Rust changes, so the existing goldens also stand.

  - **The existing tests stand unchanged:** `power_curve_linear_is_identity`, `power_curve_step_produces_binary` and `power_curve_lut_serialization_roundtrip`.

### Mutation battery (`scripts/mutation-battery.mjs`)

Every `find` must have `grep -cF` equal to 1. The mutants:
- revert S-Curve's first point to `{ x: 0, y: 0 }` (kills T1, T2);
- revert Posterize's first point (kills T1, T2);
- drop `open` from the draw effect's dependencies (kills T3);
- a load-path mutant that rewrites `powerCurve` (for example, maps old S-Curve points to new ones) (kills T4);
- in Rust, flip one `TB3_S_CURVE` literal (kills T2, which reads the source; N1 still documents the direction).

Control: Linear stays the identity under N2. The controls must stay green.

## Verification

- **Gates:**
  - `npx vitest run --cache=false` (full);
  - `npx tsc --noEmit`;
  - `npm run -s lint`;
  - `npm run -s format:check`;
  - `cargo test --manifest-path src-tauri/Cargo.toml --features sim` with `CARGO_TARGET_DIR=$HOME/.cache/kerf-engine-arm-target` and `env -u KERF_UPDATE_GOLDEN`;
  - clippy `--all-targets --features sim -- -D warnings`;
  - `cargo fmt --check`.

  The goldens must not change (no generator production code changes).
- **Browser (dev server, puppeteer; no Chrome DevTools MCP).** Open a layer's power curve editor and confirm the curve is drawn on first open, with no hover needed. Pick S-Curve and Posterize, and confirm each curve falls from the top left to the bottom right, as Linear does. Screenshots go in the relay log.
- **Owner hardware (fire precautions; status-only evidence).** In the release build, import a black-to-white gradient image, set its layer's curve to the new S-Curve, and engrave it on scrap. The black end burns darkest and the white end lightest. Repeat once with Posterize: four bands, darkest band darkest. A layer saved before the fix with the old S-Curve still burns as before (negative) until the preset is picked again. This goes to the ROADMAP `next` owner steps.

## Risks and rollback

- **The risk:** someone has come to rely on the inverted look. If so, they can draw it as a custom curve. Saved layers keep it anyway (no migration).
- **Rollback:** revert one commit. Projects are unaffected either way, because no stored data changes.

## Deferrals

None new. The polish plan's A4 later restyles this same editor (presentation only, ModalShell). Its plot background token comes from A1. TB3 runs first, because the dependency table puts TB3 before A4 on `PowerCurveEditor.tsx`.

## Decisions

None for Lee: everything here is technical. The release-note wording is plain and true, and Lee sees it in the release notes.
