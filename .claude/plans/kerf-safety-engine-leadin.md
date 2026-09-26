# Kerf safety engine-leadin: every cut starts with a G0 and a mode line, and no burning G1 stands still

> STATUS: written 2026-09-25; critic folded 2026-09-26. The Fable critic (`kerf-safety-engine-leadin-critic.md`) returned CONCERN, with no gating FAIL and X1 PASS.

## Fold notes (critic `kerf-safety-engine-leadin-critic.md`, Fable: CONCERN, no gating FAIL, X1 PASS)

All 7 must-fixes are folded as the coordinator specified. None changes a line of the engine edit (2a-2e), the anchors or the 21-id battery.

1. **P2's tolerance now excludes the lead-in.** Where `lead_in` is `Some(l)`, P2 subtracts the lead-in `G1`'s own written length before comparing, so the 0.1 mm slack is real on all six lead-in fixtures. KL-C5 was already killed by `rounded_plain_2pass`; it is now also killed by the pills. (2f, Invariants.)
2. **T-L4's seal formula counts the footer.** The expected `seal` is the number of section markers **or `; KERF:FOOTER_BEGIN` markers** that the before program reaches while `b_st.sealable()`, matching `is_boundary`. A maskFill-only job (a mask fill as the last object) is then counted correctly. (T-L4 expectations.)
3. **P3 is defined before the fix.** A `; Cut:` section with a `lead_in` expectation but no mode line, or no positive `G1` after its first mode line, is itself a P3 violation. So the reproduce-first table's P3 entries are well-defined. (2f.)
4. **The time-estimate mechanism is corrected.** `estimate_time` (`gcode_gen.rs:1456`) is computed from `moves`, not from the distance accumulators, and it already skips moves under 0.001 mm. A refused zero-length `G1` therefore changes nothing, and a refused sub-step one changes the estimate by milliseconds. (2c, Risk 3.)
5. **Deferral 2 is re-scoped.**
   - Lead-in (by the outward normal) and lead-out (by straight extension) do not know which side is waste. On a hole, both mark the part, with or without an overcut; the overcut only turns the lead-out scar into a diagonal chord.
   - It is routed to the geometry program under DECISIONS 2026-09-10 ("which side is waste"), with the material outcome named in its Parking Lot line.
   - An owner workaround line is added to the owner card and the Stage 3.5 obligations: lead-in and lead-out on outer cuts only.
6. **The A4b dependency is stated.** `pill_after_maskfill` depends on the A4b partition (`commands/gcode.rs:82-110`) emitting the mask fill first. A future ordering change reads as a fixture break, not an engine defect. (Fixture table.)
7. **The empty-`Ok` mask-fill seal is declared, not guarded.** The seal's `M5` is unconditional in the `Ok` branch, on purpose. An `Ok` scan with no rows writes an `M5` with the laser already off, which is a no-op on the controller. No corpus program has an empty mask fill. If one is ever added, the classifier returns `Err` (`may_seal` requires `sealable()`), which surfaces it for a decision. The engine edit is unchanged. (2d, Risks.)

**Also folded (not must-fixes):**
- **Risk 2** gets the critic's clause: on another machine the reversal is "read `$100/$101`", not "change the number".
- **Engine-arm has merged.** `83e02e5` is an ancestor of `marvin/kerf-gap` (merged `021f45b`), and `git diff 83e02e5 HEAD -- src-tauri` is empty (critic), so every citation holds on the session branch. The engine-arm worktree has been removed.
- **The DECISIONS item** at Stage 3.5 is now an **amendment** of Lee's 2026-09-26 entry, "Every mode line Kerf emits carries S0; positive S rides only on G1 words that carry X or Y." That entry says: "tighten it then by amendment".

**Lifted from:** Razor's review of `kerf-safety-engine-arm` batch 1, findings **W2** (physical safety) and **W1**: `~/marvin/state/relay/kerf-safety-engine-arm-razor-review-b1.md`, under "Findings". Both defects are pre-existing. Razor routed them to "its own fix relay promptly", and the hand-off at `519931f` queues the work as "lead-in burn fix queued next".

- **Relay id:** `kerf-safety-engine-leadin`
- **Branch:** `relay/kerf-safety-engine-leadin`, cut from `marvin/kerf-gap` **after** `relay/kerf-safety-engine-arm` merges.
- **Hard dependency:** `relay/kerf-safety-engine-arm` (HEAD `83e02e5`).
  - It must be an ancestor of this branch's base. If it is not merged when the relay loads, stop and report NEEDS_CONTEXT.
  - Every source citation below was read at `83e02e5`, in the read-only worktree `/home/leesalo/.local/share/marvin/worktrees/kerf/relay-kerf-safety-engine-arm`.
  - This batch reuses that batch's test machinery in `commands/gcode.rs` `mod golden_tests`: `words`, `s_word`, `is_mode_line`, `has_word`, `has_xy`, `gcode_files`, `arm_layer`, `arm_line_obj`, `arm_vector`, `arm_matrix`, `assert_never_arms` and `Program`.
  - That batch's mode lines are already `S0`, and this batch keeps them so.
- **Tier:** Simple by file count (3 files). It runs as **Standard** on purpose, because this is a physical-safety fix: Ted, then Razor, then Fix, then Report, then Archive. There is no UI, so there is no Jen stage and no behavioural stage. No waiver is needed: 3 files, one root (`src-tauri/`).

## Intent (grilled)

Grill skipped. The intent is fixed by sources that are already written, and none of them is open:
- **CHARTER, "Done looks like" (1):** "no cut dying mid-job and no silent G-code error". Quoted as the engine-arm plan quotes it (`kerf-safety-engine-arm.md`, "Intent").
- **Razor W2**, verbatim: "a degenerate first segment with lead-in emits no rapid and no mode line ... Recommend its own fix relay promptly. It is the more dangerous of the two." (review-b1, "W2").
- **Razor W1**, verbatim, for the route: "skip zero-length G1 in the plain path and in `object_to_path`, and add a displacement-level invariant." (review-b1, "W1").
- **DECISIONS 2026-09-10 (Lee):** "Variable power (M4) is the default for every new layer; constant power (M3) exists for the stationary beam, not for cutting." M3 stays selectable, and "Projects already on disk keep their stored mode". So W1, which fires only under M3, is live on real projects.

**Summary.** Every path the vector engine cuts begins the same way, whatever `lead_in` is and however short the first segment is: a `G0` to the entry point, then the mode line. No burning `G1` is written unless it moves the head at least one motor step (0.0125 mm on some axis, measured on the coordinates as written). A mask fill ends with `M5`, so the next object never inherits an enabled laser. Nothing else in the emitted program changes.

**Fix the class, not the instance.** The instance is a rounded rectangle. The class is "a burn that depends on state it did not set up itself".
- The start block now sets up its own position and arming on every path, instead of relying on two branches that together missed a case.
- Every burning `G1` in the vector arms goes through one writer that refuses a move the controller would turn into a stationary block.
- The mask-fill seam is sealed at the producer, so a future consumer that forgets to arm fails dark, not lit.

## Existing plans reviewed

- **`kerf-safety-engine-arm.md` (dependency, at Stage 2.5).** It edits the same two `.rs` files. This batch is written against its HEAD.
  - It replaces the comment that batch added at `gcode_gen.rs:460-464`, whose "Known gap ... (zero-length G1, Razor W1)" this batch closes.
  - It removes the text that engine-arm's mutants KE-M2 and KE-M3 anchor on. Engine-arm's battery is finished (16/16 killed at `51aa544`), so nothing needs to re-run it.
  - Engine-arm's T1, T2 and I1-I4 must stay green, and they will: every mode line stays `S0`.
- **`kerf-evidence-e1b.md` (QUEUED, not started; no `relay/kerf-evidence-e1b` branch).** It edits `gcode_gen.rs` at the fill-arm guard (`:893-909` at its base), the `other =>` arm, the `object_to_path` comment and `assert_golden`'s reader. It adds golden `16` (a fillLine sharp rectangle: a mask fill plus a line overlay).
  - This batch does not touch any of those lines. It does not edit `object_to_path` at all (Deferral 3).
  - E1b's anchor `width_mm: obj.width,` stays unique: this batch adds no such text.
  - **If E1b lands first:** golden 16 has a mask-fill seam, so it gains one `M5` and regenerates too. The classifier's golden rule is self-computing (it expects one `M5` per open seam), so no count in this plan changes. Only the file list grows to 4.
  - **If this batch lands first:** E1b's golden 16 is born sealed.
  - E1b's T12 (exactly one `KERF_UPDATE_GOLDEN` reader crate-wide) is respected. **This batch adds no reader of `KERF_UPDATE_GOLDEN`, and none may be added.** It uses only compile-time `env!("CARGO_MANIFEST_DIR")`.
- **`kerf-safety-s3.md` (in flight):** its branch touches no `src-tauri` file (`git diff --name-only marvin/kerf-gap...relay/kerf-safety-s3 -- src-tauri` is empty).
- **The other relay branches** under `relay/*` are merged into `marvin/kerf-gap`, except engine-arm and S3 (checked with `git merge-base --is-ancestor`).

## Context (verified at `83e02e5`)

### W2: the start block has a hole

`gcode_gen.rs`, `"line"` arm, per path:
- `:527`: a closed path gets its closing duplicate, `gpts.push(gpts[0])`.
- `:539-618`: the lead-in block. It runs only when `lead_in > 0.0` (`:541`) **and** `seg_len > 0.001` (`:545`), where `seg_len` is `gpts[1] - gpts[0]`. That branch emits a `G0` to the lead-in point (`:586-597`), the mode line (`:599`) and the lead-in `G1` (`:604-607`).
- `:620-637`: the fallback. It runs only when `lead_in <= 0.0` (`:620`), and emits a `G0` to `gpts[0]` and the mode line (`:636`).
- **The hole.** With `lead_in > 0` and a first segment of 0.001 mm or less, neither block runs. The loop at `:658` then writes the path's `G1`s with no `G0` and no mode line in front of them.

**Consequence.** GRBL 1.1h stock source (`gnea/grbl` master `bfb67f0`, read 2026-09-25):
- **After an `M5`** (the preamble's, or the previous path's at `:883`): the spindle is disabled. The `G1 … S600` lines move the head at cut feed and burn nothing. The object is silently not cut. That violates the CHARTER's "no silent G-code error".
- **After a mask fill** (which emits no `M5`, `mask_fill.rs:384-389` and `:420-427`, "The mode stays active until the final M5 emitted by assembly"): the spindle is still enabled. The first `G1` burns a straight line from wherever the fill ended to the path, at cut power. Razor's `probe2.log` shows `G1` from (0,62.5) to (55,90) at 60%.
- **Both apply under M3 and M4.** Under M4 the stray line is still lit, because the head is moving.

**The trigger, and who can reach it.**
- `object_to_path` (`:1348`) builds a rounded rectangle as follows: `r = corner_radius.min(w / 2.0).min(h / 2.0)` (`:1358`), then `(x + r, y)` (`:1360`), then `(x + w - r, y)`.
- When `r == w / 2` (a corner radius of at least half the width, with `w <= h`), those two points coincide. The first segment is then zero.
- **Production, not-cut variant (reachable):** a line layer with kerf offset 0 sends a rounded rectangle as a primitive with empty `paths` (Razor W1; `gcodeGen.ts:448-517`, where both kerf-offset branches run only when `kerfOffset !== 0`). So `object_to_path` is used. A square with corner radius equal to half its side (a circle drawn as a rounded square), or a vertical pill, on a line layer with a lead-in, is silently not cut.
- **Production, burn variant (narrow):** it needs a degenerate first segment in an object cut right after a mask fill in the same fragment. That means a fillLine layer's line overlay (A4b partition, `commands/gcode.rs:77-110`). Overlays get TS contours:
  - `synthesizeFillContour` for rounded rectangles starts at angle π on corner 1, so its first segment is never zero (`gcodeGen.ts:156-190`).
  - A path object gets `sampleBezierPath` output, which drops only consecutive points within 1e-6 mm (`geometry/index.ts:733-735`, `POINTS_EPSILON`). So a first segment between 1e-6 and 0.001 mm reaches it.
  - The Rust fixture reproduces the burn directly (Razor `probe2.log`). This plan fixes it at the class level whether or not a UI path reaches it today.
- `lead_in` is not validated anywhere (`commands/gcode.rs` production code has no check). NaN cannot arrive over JSON. The new start block is safe for any value by construction: `NaN > 0.0` is false, which gives a plain start.

### W1: burning G1s that do not move

- **The plain-path endpoint `G1`** (`:786-801`) has no length guard. The other sites are guarded: perforation (`:669`), tabs (`:724`), overcut (`:826`), lead-out (`:858`) and the offsetFill ring close (`:1134`, `d > 0.001`). The offsetFill ring body (`:1116-1126`) and the fill scan line (`:312-322`) are not.
- **Sources of zero-length segments:**
  - `object_to_path` rounded rectangles. Every `arc_points` call (`:1434-1452`, `for i in 0..=segments`) starts on the point pushed before it (`:1362`, `:1367`, `:1369`, `:1371`). The last arc ends on `points[0]`, and the line arm then adds the closing duplicate (`:527`). Razor measured 5 zero-length `G1`s per path per pass (30×20, r 3).
  - **Perforation and tab toggles** landing exactly on a vertex. A toggle at `next_toggle_dist == seg_end_dist` is deferred (`>=`, `:673`, `:755`) to the next segment with `t = 0` (`:677`, `:758`), so the cut-end `G1` (`:686-689`, `:766-769`) goes to the current point. Example: a 30 mm edge with a 30 mm perforation cut or tab spacing.
  - **offsetFill ring 0** is the input polygon itself (`offset.rs:103-104`). So a polygon with duplicate points gives zero-length ring `G1`s. The inward offset keeps a duplicated vertex un-offset (`offset.rs:40-43`), so the duplicates persist into every inner ring (Deferral 4).
  - **A zero-width `fill` rectangle** gives a zero-length scan `G1` per line (Razor W1; probably not reachable from the UI).
- **Sub-step moves are the same physics.** Stock GRBL converts each target to steps with `lround(target * steps_per_mm)` (`planner.c:369`). A block with `step_event_count == 0` returns `PLAN_EMPTY_BLOCK` (`planner.c:381`).
  - The owner's controller reports `$100=80.000` and `$101=80.000` (`scripts/probe-20260914-153729.log:36-37`), so one step is 0.0125 mm.
  - A `G1` that moves less than that on both axes, measured from the last planned target, can be empty even when its text coordinates differ.
  - **Reachable:** Kerf's TS kerf-offset path for a rounded rectangle with `r` equal to half a side duplicates the collapsed-edge junction, and `offsetRingByDistance` (`geometry/index.ts:822-870`) offsets the two copies along different normals. That gives two points about kerf × 0.1 mm apart, which is below one step at any kerf under about 0.13 mm. Imported paths are deduplicated only at 1e-6 mm.
- **Consequence.** `motion_control.c:68-76` (stock, verified 2026-09-25): when `plan_buffer_line` returns `PLAN_EMPTY_BLOCK` in laser mode with `PL_COND_FLAG_SPINDLE_CW` (M3), it calls `spindle_sync(CW, pl_data->spindle_speed)`. `spindle_sync` drains the planner (`protocol_buffer_synchronize`, `spindle_control.c:277-282`) and sets PWM at the `G1`'s S with the head stopped. The effect is a full stop at cut power at every rounded-rectangle tangent point and at the seam. **Under M4 no sync happens** (the CW branch only), so W1 is an M3 hazard.
- **The fork is unqualified.** DECISIONS 2026-09-05: "stock GRBL source is evidence about intent, never proof about this machine". Both fixes are monotone-safe whatever the fork does: one removes text that commands nothing useful, the other adds a start that every other path already has.

### The mask-fill seam

- The raster scanner emits the mode line once (`mask_fill.rs:420-427`) and never emits `M5` (by design; `:384-389`).
- `gcode_gen.rs`'s maskFill arm copies its lines in (`:1250-1262`) and emits no `M5` either.
- Golden `04_fillline_mixed_layer.gcode` shows it: the mask fill ends on `G1 X0.000 S1000` (line 29), and the line section begins at line 31 with the laser still enabled.
- Engine-arm's Deferral 6 already names this ("maskFill hands the next object an enabled spindle ... safe only because `$32=1` suppresses `G0` output").
- A measured scan of all 16 goldens at `83e02e5` finds:
  - 0 zero-displacement `G1`s;
  - 0 positive `G1`s without an in-section `G0` and mode line;
  - exactly 1 section handed an enabled laser: golden 04's mask fill.
  - The smallest vector `G1` in any golden is 2.0 mm per axis (image: 1.0 mm).
  - So the fix below is expected to leave **15 goldens byte-identical** and change golden 04 by **one added `M5` line**.

### Mask fill `M5`, or path-start logic? Both, for different reasons

- **The path-start restructure is the fix.** The defect is a consumer that burns on state it did not set. Fixing it at the start block closes it for every predecessor: the preamble, a previous path's `M5`, a mask fill, and any future arm.
- **The `M5` at the end of a mask fill is the seal.** It makes "every vector section ends laser-off" true for the engine, so a future regression in any start block fails dark (not cut) instead of lit (a stray burn).
  - It costs one line in one golden, and one planner stop at the end of the last mask scan line. That is the same stop every `fill` scan line and every path end already take.
  - It is placed in `gcode_gen.rs`'s maskFill arm, **not** in `mask_fill.rs`, so image engraving (its own fragment, closed by the footer `M5`) and the scanner's own tests (`mask_fill.rs:2097`, `:2250` assert zero `M5` from `scan_mask_to_gcode` directly) are untouched.
- Either fix alone would pass the invariants on today's arms. Each has its own mutant in the battery (KL-M1/M2 against KL-M14), so neither can quietly rot behind the other.

### Other paths into the same emitter (searched)

| Path | Can it start a burn with no G0 and mode line? | Zero or sub-step `G1`? |
|---|---|---|
| Line start (lead-in / fallback, `:539-637`) | **Yes (W2).** Fixed by the start block | Lead-in `G1` shorter than a step: guarded |
| Plain segment endpoint (`:786-801`) | No | **Yes (W1).** Guarded |
| Perforation (`:661-715`) | No: each dash restarts with `G0` (`:704`) then a mode line (`:712`) | **Yes**, at the `t = 0` cut end. Guarded |
| Tabs (`:716-785`) | No: `G0` (`:741`) then a mode line (`:751`) | **Yes**, at the `t = 0` cut end. Guarded |
| Overcut (`:819-849`) | No: it follows the path, re-arms with a mode line if `!laser_on` (`:831`), and is positioned by the path's own `G0`s | A tiny overcut: guarded. A degenerate first segment means the overcut is silently skipped, which is dark (Deferral 1) |
| Lead-out (`:851-880`) | No, same reason | A tiny lead-out: guarded. A degenerate last segment means it is silently skipped, which is dark (Deferral 1). **On a hole, the lead-out (like the lead-in) marks the part; after an overcut the scar becomes a diagonal chord** (Deferral 2) |
| Kerf-offset path (TS, `gcodeGen.ts:448-517`) | Arrives as `paths` and enters the same line-arm start block, so the restructure covers it | **Yes**: sub-step collapsed-edge junctions. Guarded |
| offsetFill ring (`:1085-1150`) | No: `M5`, `G0`, then the mode line per ring | **Yes**: duplicates in ring 0 and the inner rings. Guarded |
| fill scan (`emit_scan_segments`, from `:236`) | No: `G0`, then the mode line per scan line | **Yes**: zero-width scan. Guarded |
| maskFill / image raster (`mask_fill.rs`) | No: hoisted mode line, then a `G0 … S0` per row | Pixel runs are at least one interval, and `MIN_SCAN_INTERVAL_MM = 0.01` (`limits.rs:18`) is **below one step** (Deferral 5) |

### Test and golden machinery (reused from engine-arm)

- `assert_golden` (`commands/gcode.rs:476-501`) **writes** instead of comparing whenever `KERF_UPDATE_GOLDEN` is set (`:478`, `is_ok()`). Every compare run below unsets it.
- The engine-arm helpers are listed under the dependency above. `arm_vector` generates with workspace height 100 and `s_value_max` 1000, so a layer at power 60 gives `S600` (`:1329-1334`).
- `object_to_path` is `pub(crate)` (`:1348`), so `commands::gcode::golden_tests` can call it to compute perimeters.
- `src-tauri/target/` is gitignored. The snapshot directories below live there.

## Tier and files

**Three files, one root (`src-tauri/`):**

| # | File | Kind |
|---|---|---|
| 1 | `src-tauri/src/engine/gcode_gen.rs` | Engine edit: one constant, `g1_moves`, `CutPen`, `lead_in_point`, the start block, 9 `G1` sites, 5 position updates, the mask-fill seal, and one comment |
| 2 | `src-tauri/src/commands/gcode.rs` | Tests only (`mod golden_tests`); no production line changes |
| 3 | `src-tauri/tests/golden/04_fillline_mixed_layer.gcode` | Regenerated once (one added `M5`), never hand-edited |

- **Not edited:** `mask_fill.rs`, `image_gcode_gen.rs`, `offset.rs`, `optimizer.rs`, `object_to_path`, `tests/golden/README.md` (its 04 row still describes the file), every other golden, and every TS file.
- **If E1b merged first:** 4 files (golden 16 as well). Same tier.

## Change

Two commits, each green, mirroring engine-arm.

### Commit 1: `src-tauri/src/commands/gcode.rs`, test machinery only (no engine change)

All of this goes in `mod golden_tests`, after engine-arm's code.

**1a. The tracker.** `#[derive(Clone, Debug)] struct LeadinState { pos: (f64, f64), positioned: bool, armed: bool, spindle_on: bool, section: &'static str }`. Its `Default` has `pos (0.0, 0.0)`, all flags false and `section ""`. It has `fn step(&mut self, line: &str)` and `fn sealable(&self) -> bool` (`self.section == "; Mask Fill:" && self.spindle_on`).
- `const SECTION_MARKERS: [&str; 5] = ["; Cut:", "; Engrave:", "; Offset Fill:", "; Mask Fill:", "; Pass "];` and `fn starts_section(line: &str) -> Option<&'static str>`, which returns the marker the line starts with.
- `step`, in this order:
  - if `starts_section(line)` is `Some(m)`, set `section = m`;
  - then this verbatim line (KL-C6 anchors on it):
    `let resets = starts_section(line).is_some() || has_word(line, 'M', 5.0);`
  - if `resets`, set `positioned = false` and `armed = false`;
  - if `has_word(line, 'M', 5.0)`, set `spindle_on = false`;
  - if `is_mode_line(line)`, set `armed = true` and `spindle_on = true`;
  - if the line has a `G0` or `G1` word and `has_xy(line)`, update `pos` modally (a missing `X` or `Y` keeps the old value), and if it is `G0`, set `positioned = true`.
  - A section marker never clears `spindle_on`. That is exactly what I-SEAM measures.
- `fn g1_target(line: &str, pos: (f64, f64)) -> (f64, f64)` gives the modal X/Y target.
- `const STEP_MM: f64 = 0.0125;` is a **literal, never the engine's `MIN_G1_AXIS_MM`**, so a mutant of the engine constant cannot move the test's yardstick.
- `fn g1_moves_text(from: (f64, f64), to: (f64, f64)) -> bool` means some axis differs by `>= STEP_MM`. Parsed text coordinates are already 3-decimal.
- Small predicates: `is_g1_xy`, `is_positive_g1` (a `G1` with X/Y and `S > 0`), `is_g0_xy`, `is_mode_s0` (a mode line with `S` equal to 0), `same_f_and_s(b, a)` (equal `F` and `S` words, including absent), and `is_boundary(line)` (empty, `starts_section(line).is_some()`, or `starts_with("; KERF:FOOTER_BEGIN")`).

**1b. The invariant checker.** `fn leadin_violations(label: &str, gcode: &str) -> Vec<String>`. It walks lines with a `LeadinState`, checking **before** it steps each line. Every message begins with the invariant id, the label and the 1-based line number.
- **I-SEAM:** a line that `starts_section` while `state.spindle_on`.
- **I-ARM:** an `is_positive_g1` line while `!(state.positioned && state.armed)`.
- **I-DISP:** an `is_g1_xy` line whose `g1_target` equals `state.pos` on both axes (`abs < 1e-9`).
- **I-STEP:** an `is_positive_g1` line in a `"; Cut:"`, `"; Engrave:"` or `"; Offset Fill:"` section with `!g1_moves_text(state.pos, target)`. The raster sections are deliberately excluded (Deferral 5).

**1c. The classifier.** See "Golden-change classifier" below, which specifies it in full, with its four verbatim predicate lines.

**1d. Classifier and checker self-tests**, specified under "Golden-change classifier":
- **T-L3** `leadin_diff_accepts_only_known_classes`
- **T-L3b** `leadin_diff_rejects_everything_else`
- **T-L3c** `leadin_checker_flags_known_bad_programs`

All three are plain `#[test]`.

**1e. `async fn leadin_matrix() -> Vec<(String, LeadinFixture)>`.** It holds 17 fixtures. Each is built for `power_mode` ∈ {`constant`, `variable`}, so there are 34 programs, labelled `<label>_<mode>`.
- `struct LeadinFixture { gcode: String, perimeter: Option<f64>, lead_in: Option<f64>, expect_burn: bool }`.
- Every vector layer is `arm_layer(mode, pm)` (power 60, so `S600`), and every program comes from `arm_vector(...)` (workspace height 100).
- `perimeter` is the sum of consecutive point distances plus the closing segment, from `object_to_path(&obj)` for rectangle primitives or from the given points otherwise. It is `Some` only where P2 applies.
- `lead_in` is `Some(3.0)` only where P3 applies.

| Label | Object | Layer settings | Reaches |
|---|---|---|---|
| `pill_leadin` | `rect_obj` at (10,10), 10×20, `corner_radius Some(5.0)` (so `r = w/2`) | line, `lead_in 3` | W2 after the preamble `M5` (the not-cut variant) |
| `pill_after_maskfill` | engine-arm's `maskfill_then_line` mask object (40×40 outer plus hole, interval 5, `layer_index 0`), plus the pill from row 1 moved to (50,10), `layer_index 0` | mask: maskFill; pill: line, `lead_in 3` | W2 after a mask fill (the burn variant), and the seam. **Depends on the A4b partition** (`commands/gcode.rs:82-110`) emitting every fill-ish object before any line object in a shared `layer_index`. If that ordering ever changes, this fixture stops reproducing, and that is a fixture break, not an engine defect. |
| `pill_radius_clamp` | like row 1, `corner_radius Some(8.0)` (clamped to 5) | line, `lead_in 3` | the clamp at `:1358` |
| `pill_wide` | (10,10), 20×10, `corner_radius Some(5.0)` (so `r = h/2`) | line, `lead_in 3`, `lead_out 2` | collapsed side edges (W1), with a healthy first segment |
| `rounded_plain_2pass` | (10,10), 30×20, `corner_radius Some(3.0)` | line, `passes 2` | W1, Razor's probe shape |
| `rounded_perf` | as above | line, `lead_in 2`, `perforation 3/2` | control: expected unchanged |
| `rounded_tabs` | as above | line, `tab 8/2` | control: expected unchanged |
| `path_dup_first` | path, closed: (10,10), (10,10), (30,10), (30,30), (10,30) | line, `lead_in 3` | W2 through `paths` (not rect-specific) |
| `path_near_dup_first` | path, closed: (10,10), (10.0008,10), (30,10), (30,30), (10,30) | line, `lead_in 3` | W2 with a text-distinct first point |
| `path_all_coincide` | path, closed: (20,20) ×4 | line, `lead_in 3` | no segment at all: `expect_burn: false` |
| `substep_junction` | path, closed: (10,10), (30,10), (30.0098,10), (30.0098,30), (10,30) | line | a sub-step `G1` (the kerf-offset junction shape) |
| `boundary_rounding` | path, closed: (10.0006,10), (10.0133,10), (30,10), (30,30), (10,30) | line | raw 0.0127 mm, but 0.012 as written |
| `rect_perf_on_corner` | `arm_line_obj` (30×20 rect path) | line, `perforation 30/5` | the `t = 0` perforation cut end |
| `rect_tab_on_corner` | `arm_line_obj` | line, `tab 30/2` | the `t = 0` tab cut end |
| `tiny_extensions` | `arm_line_obj` | line, `lead_in 0.005`, `overcut 0.005`, `lead_out 0.005` | sub-step lead-in, overcut and lead-out |
| `zero_width_fill` | `rect_obj` at (10,10), 0×10, primitive | fill, `interval 2`, `overscan 0` | a zero-width scan line: `expect_burn: false` |
| `offset_fill_rounded` | `rect_obj` at (10,10), 20×20, `corner_radius Some(3.0)`, primitive | offsetFill, `interval 2` | duplicates in ring 0 and the inner rings |

- `perimeter` is `Some` for `pill_leadin`, `pill_after_maskfill`, `pill_radius_clamp`, `pill_wide`, `rounded_plain_2pass` (×2 for the two passes), `path_dup_first`, `path_near_dup_first`, `substep_junction` and `boundary_rounding`.
- `lead_in` is `Some(3.0)` for `pill_leadin`, `pill_after_maskfill`, `pill_radius_clamp`, `pill_wide`, `path_dup_first` and `path_near_dup_first`. It is `None` for `path_all_coincide`, which has `lead_in 3` but no segment to lead into.
- Labels and parameters must not change between the before-snapshot and the after-snapshot.

**1f. T-L5** `leadin_matrix_snapshot` (`#[tokio::test] #[ignore]`). It clears and recreates `concat!(env!("CARGO_MANIFEST_DIR"), "/target/leadin-matrix-out")`, then writes:
- every `leadin_matrix()` program as `leadin__<label>_<mode>.gcode`;
- every `arm_matrix()` program as `arm__<label>_<mode>.gcode`.

It asserts exactly **58** distinct files (34 + 24).

It also asserts the matrix's shape, which reads every `LeadinFixture` field. That keeps Commit 1 clippy-clean: engine-arm's N1 was a dead-code field in its Commit 1.
- `expect_burn == false` for exactly 4 programs (`path_all_coincide_*`, `zero_width_fill_*`).
- `perimeter.is_some()` for exactly 18.
- `lead_in.is_some()` for exactly 12: `pill_leadin`, `pill_after_maskfill`, `pill_radius_clamp`, `pill_wide`, `path_dup_first` and `path_near_dup_first`, in both modes.

**1g. T-L4** `leadin_regeneration_is_classified` (`#[test] #[ignore]`). It reads `concat!(env!("CARGO_MANIFEST_DIR"), "/target/leadin-before")` (the goldens) and `/target/leadin-before/matrix` (58 files), against `tests/golden` and `target/leadin-matrix-out`.
- It panics if either before set is missing or short: at least 16 goldens, and exactly 58 matrix files.
- It asserts identical file sets and zero `Err`.
- It asserts the expectations in the classifier section, and prints per-file counts with `--nocapture`.

### Commit 2: the engine change, the durable invariants, and the regeneration

**2a. `gcode_gen.rs`: new items, inserted immediately before `/// Emit G-code from a list of scan segments (possibly reordered).` (`:234`), verbatim.**

The whole edit below was applied to a scratch copy of `gcode_gen.rs` at `83e02e5`. `rustfmt --edition 2021 --check` then reports no change, so every anchor survives `cargo fmt`. **The simulation was not compiled.** Ted compiles.

```rust
/// Safety leadin (Razor W1): the smallest per-axis move, in the coordinates as
/// written (`{:.3}`), that a burning G1 may make. A shorter G1 can round to zero
/// motor steps. Stock GRBL then plans an empty block, and under M3 in laser mode
/// it syncs the spindle at that G1's S with the head stopped (grbl
/// motion_control.c mc_line, planner.c plan_buffer_line). 0.0125 mm is one step
/// at the owner's $100/$101 = 80 steps/mm.
pub(crate) const MIN_G1_AXIS_MM: f64 = 0.0125;

/// True when a G1 from `from` to `to` moves at least MIN_G1_AXIS_MM on some axis,
/// measured on the coordinates exactly as they are written to the program.
pub(crate) fn g1_moves(from: (f64, f64), to: (f64, f64)) -> bool {
    let q = |v: f64| format!("{:.3}", v).parse::<f64>().unwrap_or(v);
    (q(to.0) - q(from.0)).abs() >= MIN_G1_AXIS_MM || (q(to.1) - q(from.1)).abs() >= MIN_G1_AXIS_MM
}

/// Writes the burning G1s of one path, ring or scan line (safety leadin). It
/// remembers the last position written to the program and writes nothing for a
/// G1 that would not move the head (see MIN_G1_AXIS_MM).
struct CutPen {
    last: (f64, f64),
    speed: f64,
    s: f64,
    move_type: &'static str,
}

impl CutPen {
    /// A non-burning move (G0, or a G1 at S0) put the head at (x, y).
    fn moved_to(&mut self, x: f64, y: f64) {
        self.last = (x, y);
    }

    /// `G1 X Y F S` to (x, y), or nothing when it would not move the head.
    fn cut(&mut self, lines: &mut Vec<String>, moves: &mut Vec<GcodeMove>, x: f64, y: f64) {
        if !g1_moves(self.last, (x, y)) {
            return;
        }
        lines.push(format!(
            "G1 X{:.3} Y{:.3} F{:.0} S{}",
            x, y, self.speed, self.s
        ));
        moves.push(GcodeMove {
            x,
            y,
            move_type: self.move_type.to_string(),
            speed: self.speed,
            power: self.s,
        });
        self.last = (x, y);
    }
}

/// The lead-in entry point of a path (safety leadin, Razor W2): `lead_in` away
/// from gpts[0], set by the first point more than 0.001 mm from gpts[0]
/// (perpendicular and outward for a closed path, straight back for an open
/// one). None when every point is within 0.001 mm of gpts[0].
fn lead_in_point(gpts: &[(f64, f64)], closed: bool, lead_in: f64) -> Option<(f64, f64)> {
    let (dx, dy, seg_len) = gpts[1..].iter().find_map(|p| {
        let (dx, dy) = (p.0 - gpts[0].0, p.1 - gpts[0].1);
        let len = (dx * dx + dy * dy).sqrt();
        (len > 0.001).then_some((dx, dy, len))
    })?;
    if closed {
        // (the P2-A Fix #4 winding comment block from :547-555, moved verbatim)
        let nx = -dy / seg_len;
        let ny = dx / seg_len;
        // (signed-area block from :560-572, moved verbatim, over &gpts[..gpts.len() - 1])
        let sign = if signed_area > 0.0 { -1.0 } else { 1.0 };
        Some((
            gpts[0].0 + sign * nx * lead_in,
            gpts[0].1 + sign * ny * lead_in,
        ))
    } else {
        Some((
            gpts[0].0 - dx / seg_len * lead_in,
            gpts[0].1 - dy / seg_len * lead_in,
        ))
    }
}
```

- The two parenthesised comments in `lead_in_point` stand for code **moved verbatim** from the current lead-in block (`:546-579`): the winding comment, the `signed_area` computation over `gcode_pts = &gpts[..gpts.len() - 1]`, and its "Flip for CCW" comment. The arithmetic is unchanged.
- **Why "first point more than 0.001 mm away".** For every path whose first segment is longer than 0.001 mm, that point is `gpts[1]`, and the result is bit-identical to today's `:542-584`. Only the W2 case now looks further along the path. So no path that works today changes its lead-in. (`g1_moves` is deliberately not used here, because it would move the lead-in on a path whose first segment is between 0.001 and 0.0125 mm.)
- **Why the text-quantised comparison.** `q` compares what the controller will read. The `boundary_rounding` fixture and KL-M15 pin it: raw 0.0127 mm, but 0.012 as written.

**2b. The start block.** Replace `:539-637` (from `// Lead-in: approach from perpendicular/linear offset` through the fallback's closing `}`) with this, verbatim, at the arm's 24-space indent:

```rust
// Path start (safety leadin, Razor W2). Every path starts the same way,
// whatever lead_in or the first segment's length: a G0 to its entry point,
// then the mode line. With a lead-in, the entry point is off the path and
// a burning G1 runs from it to gpts[0].
let lead_in = layer.lead_in;
let entry = if lead_in > 0.0 {
    lead_in_point(&gpts, path.closed, lead_in)
} else {
    None
};
let (sx, sy) = entry.unwrap_or(gpts[0]);
let dist = ((sx - cur_x).powi(2) + (sy - cur_y).powi(2)).sqrt();
travel_distance += dist;
total_distance += dist;
lines.push(format!("G0 X{:.3} Y{:.3}", sx, sy));
moves.push(GcodeMove {
    x: sx,
    y: sy,
    move_type: "rapid".to_string(),
    speed: RAPID_SPEED_MM_MIN,
    power: 0.0,
});
cur_x = sx;
cur_y = sy;
lines.push(format!("{} S0", power_cmd)); // safety leadin: path start
let mut pen = CutPen {
    last: (sx, sy),
    speed: speed_mm_min,
    s: effective_s_max,
    move_type: "cut",
};
if entry.is_some() {
    // Lead-in: burn from the entry point to the path's first point
    let d = ((gpts[0].0 - sx).powi(2) + (gpts[0].1 - sy).powi(2)).sqrt();
    cut_distance += d;
    total_distance += d;
    pen.cut(&mut lines, &mut moves, gpts[0].0, gpts[0].1);
    cur_x = gpts[0].0;
    cur_y = gpts[0].1;
}
```

- For every non-W2 path this emits the same lines as today, in the same order: `G0`, mode line, and the lead-in `G1` when there is a lead-in. It also pushes the same moves and accumulates the same distances.
- The W2 path now gets `G0` (to the lead-in point, found from the first real segment), the mode line and its lead-in.
- A path with no point more than 0.001 mm from its start gets `G0`, the mode line, no burning `G1` (the loop's are all refused), and `M5`.

**2c. The nine burning `G1` sites.** Each `lines.push(format!("G1 … S{}", …)); moves.push(GcodeMove { … "cut"/"engrave" … });` pair becomes one call, verbatim. The distance accumulators before each site are **left exactly as they are**, so `cut_distance` and `total_distance` count geometry, not emitted lines. The `moves` list (the preview) drops a refused point. **The time estimate is computed from `moves`** (`estimate_time`, `gcode_gen.rs:1456`), which already skips moves under 0.001 mm, so a refused zero-length `G1` changes nothing and a refused sub-step one changes it by milliseconds (fold 4).

| Site | Today | Becomes |
|---|---|---|
| Lead-in | `:604-614` | `pen.cut(&mut lines, &mut moves, gpts[0].0, gpts[0].1);` (in 2b) |
| Perforation cut end | `:686-696` | `pen.cut(&mut lines, &mut moves, tx, ty);`, with the existing next line `lines.push("M5".to_string());` kept |
| Tab cut end | `:766-776` | `pen.cut(&mut lines, &mut moves, tx, ty);`, with the existing next line `cur_x = tx;` kept |
| Plain endpoint | `:791-801` | `pen.cut(&mut lines, &mut moves, px, py);` |
| Overcut | `:835-845` | `pen.cut(&mut lines, &mut moves, ox, oy);` |
| Lead-out | `:866-876` | `pen.cut(&mut lines, &mut moves, lox, loy);` |
| offsetFill ring body | `:1116-1126` | `oring.cut(&mut lines, &mut moves, px, py);` |
| offsetFill ring close | `:1137-1147` (inside the existing `if d > 0.001`) | `oring.cut(&mut lines, &mut moves, cfx, cfy);` |
| fill scan line | `:312-322` | `scan_pen.cut(lines, moves, esx, esy);` |

**Pen construction and position updates, verbatim:**
- **Line arm:** `pen` is built in 2b. Add `pen.moved_to(tx, ty);` right after the perforation skip-end `G0`'s `moves.push(…);` (before its mode line, `:711-712`). Add `pen.moved_to(tx, ty);` right after the tab-end `G0`'s `moves.push(…);` (before `cur_x = tx;`, `:749`). Add `pen.moved_to(px, py);` right after the laser-off endpoint `G0`'s `moves.push(…);` (`:807-813`).
- **offsetFill:** directly after `cur_y = rsy;` at the ring start (`:1104`), add
  `let mut oring = CutPen { last: (rsx, rsy), speed: speed_mm_min, s: effective_s_max, move_type: "cut" };`, formatted by rustfmt as a multi-line struct literal.
  - The name is `oring`, not `ring_pen`, so the text `pen.cut(&mut lines, &mut moves, px, py);` stays unique to the line arm.
- **fill scan (`emit_scan_segments`):** directly after the rapid's `moves.push(…);` (`:271-277`), add
  `let mut scan_pen = CutPen { last: (rsx, rsy), speed: params.speed_mm_min, s: params.s_max, move_type: "engrave" };`.
  - Inside `if params.overscan > 0.0 { … }`, after the accel `G1 S0`'s `moves.push(…);`, add `scan_pen.moved_to(bsx, bsy);`.
- **Nothing else in these arms changes.** `cur_x`/`cur_y` keep their geometric meaning, so perforation and tab interpolation (`seg_dx = px - cur_x`, `:666`, `:721`) is unchanged. The existing `seg_len < 0.001` / `> 0.001` guards stay. `pen.last` is the only new state, and it tracks what was written.

**2d. The mask-fill seal.** In the maskFill arm's `Ok(scan_result)` branch, after `moves.extend(scan_result.moves);` (`:1261`), add verbatim:

```rust
// The raster scanner leaves the laser enabled (no M5, by
// design); the next object must not inherit it.
lines.push("M5".to_string()); // seal the mask fill
```

- **The seal is unconditional in the `Ok` branch, on purpose (fold 7).** An `Ok` result with no rows (an all-empty mask that the `has_content` check at `:1211` did not catch) writes an `M5` with the laser already off. That is a no-op on the controller.
- No corpus program has an empty mask fill. If one is ever added, T-L4's classifier returns `Err` for it, because `may_seal` requires `sealable()`. That surfaces the case for a decision instead of hiding it.
- A guard on a non-empty `scan_result.gcode` was considered and rejected: it adds a branch and a mutant to protect against a harmless extra `M5`.

**2e. The comment at `:460-464`.** Replace its last two sentences ("Known gap, tracked separately: a G1 whose X/Y equal the current position (zero-length G1, Razor W1) still carries positive S.") so that the block reads, verbatim:

```
        // Power mode command. Every mode line below is `{power_cmd} S0`; positive S
        // rides only on G1 words that carry X or Y, so no mode line arms a
        // stationary beam (DECISIONS 2026-09-10; safety engine-arm). Every burning
        // G1 of the vector arms goes through CutPen, which refuses one that would
        // not move the head (safety leadin, Razor W1).
```

**2f. `commands/gcode.rs`, the durable tests (written before the engine edit, committed in Commit 2):**
- **T-L1** `leadin_invariants_every_fixture` (`#[tokio::test]`). For all 34 `leadin_matrix()` programs and all 24 `arm_matrix()` programs, it collects every violation into one list and asserts the list is empty. The panic message prints the whole list, grouped by label.
  - Checks `leadin_violations`: I-SEAM, I-ARM, I-DISP and I-STEP.
  - Checks `assert_never_arms` (engine-arm's I1/I2), called only after `leadin_violations`, so its panic cannot hide the list.
  - **P1:** at least one positive `G1` when `expect_burn`. **Exactly zero** positive `G1`s for `path_all_coincide` and `zero_width_fill`, whose sections must still contain a `G0`, a mode line and an `M5`.
  - **P2:** where `perimeter` is `Some(p)`, take the summed text-coordinate length of the positive `G1`s in the `; Cut:` sections, **minus the written length of each section's lead-in `G1`** where `lead_in` is `Some` (that is, the first positive `G1` after the section's first mode line). The result must be `>= p - 0.1`. So the 0.1 mm slack is real on the lead-in fixtures too, rather than hidden under a 3 mm lead-in (fold 1).
  - **P3:** where `lead_in` is `Some(l)`, the first positive `G1` after the first mode line of the `; Cut:` section has text length `l ± 0.002`. **These are P3 violations too:** a `; Cut:` section with no mode line at all, and a mode line followed by no positive `G1`. That is what the pre-fix W2 output looks like, so the reproduce-first table's P3 entries are defined (fold 3).
- **T-L2** `committed_goldens_hold_leadin_invariants` (`#[test]`). It runs `leadin_violations` on every committed golden and asserts none.
  - Anti-vacuity: at least 16 files, and at least 1 positive `G1` checked.
  - It guards a future regeneration. It kills no code mutant.

**2g. Regeneration and classification, in this order.** Ted quotes each step's output in his report. Every cargo command runs with `CARGO_TARGET_DIR=/home/leesalo/.cache/kerf-engine-arm-target` exported and `env -u KERF_UPDATE_GOLDEN` in front, except the one write in step 5.

0. **Preconditions.**
   - Run `df -BG --output=avail /home`. It must show at least 25 GB free: 34 GB at plan time.
   - `git merge-base --is-ancestor relay/kerf-safety-engine-arm HEAD` must succeed.
   - Below 25 GB, or not merged: stop and report NEEDS_CONTEXT. Delete nothing; the coordinator owns worktree removal.
1. **Commit 1, then reproduce first.**
   - Commit 1 must be green: T-L3, T-L3b and T-L3c pass; T-L4 and T-L5 are ignored.
   - Then add T-L1 and T-L2 to the working tree, with no engine edit, and run them:
     `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim -- leadin_invariants_every_fixture committed_goldens_hold_leadin_invariants`
   - Both must fail.
   - T-L2's list must be exactly one I-SEAM, in `04_fillline_mixed_layer.gcode`.
   - T-L1's list must contain **at least** the entries in the table below, in both power modes. Anything more is quoted in the report and triaged by the orchestrator before step 2.

     | Fixture | Violations expected before the fix |
     |---|---|
     | `pill_leadin`, `pill_radius_clamp` | I-ARM, I-DISP, P3 |
     | `pill_after_maskfill` | I-ARM, I-SEAM, I-DISP, P3 |
     | `pill_wide`, `rounded_plain_2pass` | I-DISP |
     | `path_dup_first`, `path_near_dup_first` | I-ARM, P3 |
     | `path_all_coincide` | I-ARM, I-DISP, P1 (it burns when it must not) |
     | `substep_junction`, `boundary_rounding`, `tiny_extensions` | I-STEP |
     | `rect_perf_on_corner`, `rect_tab_on_corner`, `offset_fill_rounded` | I-DISP |
     | `zero_width_fill` | I-DISP, P1 (it burns when it must not) |
     | `arm__maskfill_then_line` (from `arm_matrix`) | I-SEAM |
     | `rounded_perf`, `rounded_tabs`, and the other 22 `arm_matrix` programs | none |

   - If either test passes, or a listed fixture lacks a listed kind, stop: the fixture does not reproduce. Report NEEDS_CONTEXT.
2. **Snapshot the before state, at Commit 1.**
   - `git diff --quiet -- src-tauri/tests/golden` must succeed.
   - Then `mkdir -p src-tauri/target/leadin-before && cp src-tauri/tests/golden/*.gcode src-tauri/target/leadin-before/`.
   - Then run T-L5: `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim leadin_matrix_snapshot -- --ignored`.
   - Then `mv src-tauri/target/leadin-matrix-out src-tauri/target/leadin-before/matrix`.
   - `ls src-tauri/target/leadin-before/matrix/*.gcode | wc -l` must print 58.
3. **Make the engine edits** in 2a-2e.
4. **See only the expected reds.** Run `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim -- commands::gcode engine::gcode_gen engine::mask_fill`.
   - The only red tests are `golden_04_fillline_mixed_layer` and T-L2.
   - T-L1, engine-arm's T1 and T2, and every `engine::` test must be green. Any other red is a defect: stop.
5. **Regenerate golden 04 only:**
   `KERF_UPDATE_GOLDEN=1 ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim -- commands::gcode::golden_tests::golden_04_fillline_mixed_layer --exact`
   - Its pass or fail is not consulted. Never re-run it "to be sure".
   - Then `git status --short src-tauri src` must list exactly `gcode_gen.rs`, `commands/gcode.rs` and golden 04.
   - `git diff -U0 -- src-tauri/tests/golden/04_fillline_mixed_layer.gcode` must show exactly one `+M5` line, no `-` line, and the `+M5` directly before the blank line that precedes `; Cut: fillline_perimeter`.
   - If E1b merged first, also run golden 16's test by its full name; it gets the same check.
6. **Classify.** Run T-L5 again (after-snapshot), then
   `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim leadin_regeneration_is_classified -- --ignored --nocapture`.
   It must pass with the counts in the classifier section.
7. **Compare green:** the full suite passes with the variable unset (Verification).
8. **Commit** the engine, the tests and golden 04 together, so the tree is never red.

## Invariants (what "done" asserts about engine output)

A **section** runs from a section marker (`; Cut:`, `; Engrave:`, `; Offset Fill:`, `; Mask Fill:`, `; Pass `) to the next one. Positions are tracked through `G0`/`G1` X/Y words, modally, in `G90` (every program starts `G90`). "Written" coordinates are the 3-decimal text.

| Id | Statement | Enforced by |
|---|---|---|
| **I-ARM** | No `G1` carries positive `S` unless it is preceded, **in its section and since the last `M5`**, by a `G0` with X/Y **and** a mode line. That makes "every cut section begins with a `G0` to its start and a mode line" true, and covers each re-start after an `M5` within a section (perforation, tabs, multi-path objects). | T-L1 (34 + 24 programs), T-L2 (goldens) |
| **I-SEAM** | No section marker is reached with the laser enabled: every section that armed has sent `M5` before the next section begins. The footer is exempt, because its first line is `M5` and image programs rely on it. | T-L1, T-L2 |
| **I-DISP** | No `G1` (any `S`, any section) has zero written displacement. | T-L1, T-L2 |
| **I-STEP** | In the vector sections (`Cut`, `Engrave`, `Offset Fill`), no positive-`S` `G1` moves less than 0.0125 mm on both axes as written. The test uses its own literal, not the engine's constant. | T-L1, T-L2 |
| I1-I4 | engine-arm's: every mode line is `S0`; positive `S` only on `G1` with X/Y; mode letter follows the layer; every `G1` carries `S` | engine-arm T1 and T2 (unchanged), plus `assert_never_arms` inside T-L1 |
| **P1** | Each fixture that should burn does. `path_all_coincide` and `zero_width_fill` burn nothing, and each of their sections still opens with `G0` and a mode line and closes with `M5`. | T-L1 |
| **P2** | No cut is lost to the guard: the burned length, excluding the lead-in `G1`, is at least the path perimeter minus 0.1 mm. | T-L1 |
| **P3** | A requested lead-in is honoured, including on the W2 shapes. A section with no mode line, or no burn after it, fails P3. | T-L1 |
| **I5** | Apart from the classified changes, the program is byte-identical. | T-L4 (one-shot, over 16 goldens and 58 matrix programs), then the byte-for-byte goldens |

**The matrix test requested** is T-L1 over `leadin_matrix()`:
- **lead-in with degenerate first segments:** `pill_leadin`, `pill_after_maskfill`, `path_dup_first`, `path_near_dup_first` and `path_all_coincide`;
- **the rounded-rect radius clamp:** `pill_radius_clamp`, where `corner_radius 8` is clamped to 5, and `pill_wide`, clamped by height;
- **mask fill followed by a line layer:** `pill_after_maskfill`, plus engine-arm's `maskfill_then_line`.

Each fixture runs under M3 and under M4.

**Why I-STEP is scoped to the vector sections.** The raster scanner is not edited here, and its minimum interval (0.01 mm, `limits.rs:18`) is below one step (Deferral 5). I-DISP still covers raster output. T-L3c's K7 proves that the scoping is deliberate.

## Golden-change classifier

`fn classify_leadin_diff(before: &str, after: &str) -> Result<LeadinDiff, String>`, with `#[derive(Debug, Default, PartialEq)] struct LeadinDiff { start: usize, retarget: usize, delete: usize, seal: usize }`.

It walks both programs with two cursors (`i` over `before`, `j` over `after`), and a `LeadinState` for each (`b_st`, `a_st`), stepped only over lines each side has consumed. It also keeps a `just_started: bool` flag. At each step, with `b = before[i]` and `a = after[j]`:

1. **Equal:** `b == a`. Step both states and advance both cursors. `just_started = false`.
2. Otherwise compute, **verbatim** (the controls anchor on these four lines):
   ```rust
   let (bt, at) = (g1_target(b, b_st.pos), g1_target(a, a_st.pos));
   let may_delete = is_g1_xy(b) && !g1_moves_text(a_st.pos, bt);
   let may_start = is_positive_g1(b) && !(b_st.positioned && b_st.armed);
   let may_seal = a == "M5" && b_st.sealable() && is_boundary(b);
   let may_retarget = just_started && same_f_and_s(b, a) && !g1_moves_text(bt, at);
   ```
   and try, in this order:
   - **S (start inserted):** if `may_start && is_g0_xy(a) && j + 1 < after.len() && is_mode_s0(after[j + 1])`, consume the two `after` lines, stepping `a_st`, with no `before` line. Then `start += 1` and `just_started = true`.
   - **R (first burn retargeted):** if `may_retarget && is_positive_g1(b) && is_positive_g1(a)`, step both and advance both. Then `retarget += 1` and `just_started = false`. This is the W2 path's first `G1`: before, it ran to `gpts[1]`; now the lead-in runs to `gpts[0]`, within one step of it.
   - **M (mask fill sealed):** if `may_seal`, consume the `after` line, stepping `a_st`. Then `seal += 1`.
   - **D (null `G1` removed):** if `may_delete`, consume the `before` line, stepping `b_st` only. Then `delete += 1`.
   - Otherwise `Err(format!("before line {} / after line {}: {:?} -> {:?} is not a leadin change", i + 1, j + 1, b, a))`.
3. When `after` runs out first, only D may consume the rest of `before`. When `before` runs out first, the rest of `after` is an `Err`.

D is judged against **`a_st.pos`**, meaning where the fixed program's head actually is. That is the same thing the engine's guard judges against.

**T-L3** (accept), each returning `Ok` with the stated counts:
- **A1:** a duplicate `G1` removed after `G0 X0.000 Y0.000` and `M3 S0`: `delete 1`.
- **A2:** `; Cut: a` followed by `G1 X10.000 Y90.000 F1200 S600` becomes `; Cut: a`, `G0 X7.000 Y90.000`, `M3 S0`, then the same `G1`: `start 1`.
- **A3:** as A2, but the before `G1` is `X10.001`: `start 1, retarget 1`.
- **A4:** a `; Mask Fill:` section (with `M3 S0`, `G0 … S0`, `G1 X40.000 F1200 S1000`), a blank line, then `; Cut:`; after, `M5` is inserted before the blank: `seal 1`.
- **A5:** the `path_all_coincide` shape: two `G1 X20.000 Y80.000` lines after `; Cut: z`, with no `G0`, become `G0 X20.000 Y80.000`, `M3 S0`, `M5`: `start 1, delete 2`.
- **A6:** identical programs: all zero.

**T-L3b** (reject), each returning `Err` that names the right before or after line:
- **R1:** a `G1` that moves 5 mm is removed.
- **R2:** a `G0` and mode line are inserted before a `G1` that was already positioned and armed.
- **R3:** an `M5` is inserted at the boundary after a **`; Cut:`** section that lacks one.
- **R4:** an armed `G1`'s X moves by 0.001 with no start inserted before it.
- **R5:** a retarget with a changed `S` (600 to 500).
- **R6:** a positive `G1` is inserted before an `M5` (an overcut appearing).
- **R7:** a mode line is inserted alone, with no `G0`.
- **R8:** an `M5` is inserted after a `; Mask Fill:` section whose laser is already off.
- **R9:** a `G0` is removed.

**T-L3c** (the checker):
- **K1:** a clean program gives no violations.
- **K2:** a positive `G1` straight after `; Cut:` gives I-ARM.
- **K3:** within one `; Cut:` section, `G0`, `M3 S0`, `G1`, `M5`, then `G0` and a positive `G1` with no mode line, gives I-ARM on the second burn. This proves the `M5` reset.
- **K4:** a repeated `G1` gives I-DISP.
- **K5:** a 0.010 mm positive `G1` in a `; Cut:` section gives I-STEP.
- **K6:** `; Mask Fill:` with `M3 S0` and no `M5`, then `; Cut:`, gives I-SEAM.
- **K7:** a 0.010 mm positive `G1` in a `; Mask Fill:` section gives **no** I-STEP. The scope is deliberate.

**T-L4 expectations** (one-shot, over the before and after sets from 2g steps 2 and 6):
- **Every golden and every `arm__*` program:** `start == retarget == delete == 0`, and `seal ==` the number of section markers **or `; KERF:FOOTER_BEGIN` markers** that the before program reaches while `b_st.sealable()`. That matches `is_boundary`, so a program whose last object is a mask fill (the ordinary maskFill-only job) is counted, not rejected (fold 2). That count is computed by the test from the before text, so it holds whichever of E1b or this batch lands first.
  - Expected result at `83e02e5`: golden 04 is `seal 1`, `arm__maskfill_then_line_{constant,variable}` are `seal 1` each, and everything else is unchanged.
- **Every `leadin__*` program, identical under both modes:**

  | Fixture | start | retarget | delete | seal |
  |---|---|---|---|---|
  | `pill_leadin` | 1 | 0 | 6 | 0 |
  | `pill_after_maskfill` | 1 | 0 | 6 | 1 |
  | `pill_radius_clamp` | 1 | 0 | 6 | 0 |
  | `pill_wide` | 0 | 0 | 7 | 0 |
  | `rounded_plain_2pass` | 0 | 0 | 10 | 0 |
  | `rounded_perf` | 0 | 0 | 0 | 0 |
  | `rounded_tabs` | 0 | 0 | 0 | 0 |
  | `path_dup_first` | 1 | 0 | 0 | 0 |
  | `path_near_dup_first` | 1 | 1 | 0 | 0 |
  | `path_all_coincide` | 1 | 0 | 4 | 0 |
  | `substep_junction` | 0 | 0 | 1 | 0 |
  | `boundary_rounding` | 0 | 0 | 1 | 0 |
  | `rect_perf_on_corner` | 0 | 0 | 1 | 0 |
  | `rect_tab_on_corner` | 0 | 0 | 1 | 0 |
  | `tiny_extensions` | 0 | 0 | 3 | 0 |
  | `zero_width_fill` | 0 | 0 | ≥ 1 | 0 |
  | `offset_fill_rounded` | 0 | 0 | ≥ 4 | 0 |

- **Where the exact counts come from** (by reading `object_to_path`, `arc_points` and the toggle loops at `83e02e5`, not by running):
  - A vertical pill has 7 zero-length segments per path. W2 turns the first into the stray `G1` that the start's lead-in `G1` matches exactly, which leaves 6 deletions.
  - The horizontal pill has 7.
  - Razor measured 5 per path per pass for the 30×20 r3 rectangle.
  - The perforation and tab loops already skip sub-0.001 segments (`:669`, `:724`), so the rounded controls stay unchanged.
  - If a count differs, T-L4 prints the per-file table. Ted quotes it, and the orchestrator decides whether the plan's arithmetic or the code is wrong. **Neither the test nor the table is edited to make them agree without that recorded decision.**

## Mutation battery

**Spec `kerf-safety-engine-leadin`:**
- `test_command`: `["env","-u","KERF_UPDATE_GOLDEN","/home/leesalo/.cargo/bin/cargo","test","--manifest-path","src-tauri/Cargo.toml","--features","sim","--","commands::gcode","engine::gcode_gen","engine::mask_fill"]`
- **Launch:** `env -u KERF_UPDATE_GOLDEN CARGO_TARGET_DIR=/home/leesalo/.cache/kerf-engine-arm-target node ~/marvin/scripts/mutation-battery.mjs <spec>`.
  - The battery strips only `GIT_*` from the environment (engine-arm critic, `mutation-battery.mjs:789-793`), so the shared warm target is reused and no new target directory is created.
  - With `KERF_UPDATE_GOLDEN` set, the goldens would rewrite instead of compare: kills would be lost and stray writes would appear.
- **Free space:** at least 25 GB (`df -BG --output=avail /home`) before launch. Below that, do not launch; report NEEDS_CONTEXT.
- **Timeouts:** `per_mutant_timeout_ms: 1500000`, `total_timeout_ms: 5400000` (engine-arm's values). 21 ids at about 100 s each, with the warm target, is about 35-40 minutes plus the baseline.
  - A timeout is `errored`: re-run the same spec. Never drop an id.
  - Only one Rust battery runs at a time.
- **Baseline:** Ted confirms from the baseline output that all three modules ran, and states the count: the relay-start baseline plus 5 passing tests (T-L1, T-L2, T-L3, T-L3b, T-L3c). T-L4 and T-L5 are ignored, and do not run in the battery.
- Every mutant is one contiguous find/replace. `⏎` is a newline and `·N` is N spaces. Every variant type-checks.
  - The "unguard" variant used by M6-M13 inserts `<pen>.last = (f64::MAX, f64::MAX);⏎<same indent>` before the call. `g1_moves` from `f64::MAX` is always true, so that site writes its `G1` whatever its length. Private fields are visible within the module.

| Id | File | find | replace | Killed by |
|---|---|---|---|---|
| KL-M1 | `gcode_gen.rs` | `lines.push(format!("G0 X{:.3} Y{:.3}", sx, sy));` | `if lead_in <= 0.0 { lines.push(format!("G0 X{:.3} Y{:.3}", sx, sy)); }` (the start `G0` is lost whenever there is a lead-in) | T-L1 I-ARM (every lead-in fixture), golden 12 |
| KL-M2 | `gcode_gen.rs` | `lines.push(format!("{} S0", power_cmd)); // safety leadin: path start` | `if lead_in <= 0.0 { lines.push(format!("{} S0", power_cmd)); }` (the start mode line is lost: W2's "not cut") | T-L1 I-ARM, golden 12 |
| KL-M3 | `gcode_gen.rs` | `let (dx, dy, seg_len) = gpts[1..].iter().find_map(\|p\| {` | the same, with `gpts[1..2]` (the old first-segment-only rule: a W2 path loses its lead-in) | T-L1 P3 (`pill_*`, `path_dup_first`, `path_near_dup_first`) |
| KL-M4 | `gcode_gen.rs` | `pub(crate) const MIN_G1_AXIS_MM: f64 = 0.0125;` | the same, with `0.0` (the guard is off) | T-L1 I-DISP (`rounded_plain_2pass`, pills, corner fixtures) |
| KL-M5 | `gcode_gen.rs` | KL-M4's find | the same, with `0.001` (the text-zero guard only; sub-step moves pass) | T-L1 I-STEP (`substep_junction`, `boundary_rounding`, `tiny_extensions`) |
| KL-M6 | `gcode_gen.rs` | `pen.cut(&mut lines, &mut moves, px, py);` | unguard (plain endpoint) | T-L1 I-DISP (`rounded_plain_2pass`, pills) |
| KL-M7 | `gcode_gen.rs` | `pen.cut(&mut lines, &mut moves, tx, ty);⏎·40lines.push("M5".to_string());` | unguard the first line; keep the second | T-L1 I-DISP (`rect_perf_on_corner`) |
| KL-M8 | `gcode_gen.rs` | `pen.cut(&mut lines, &mut moves, tx, ty);⏎·40cur_x = tx;` | unguard the first line; keep the second | T-L1 I-DISP (`rect_tab_on_corner`) |
| KL-M9 | `gcode_gen.rs` | `scan_pen.cut(lines, moves, esx, esy);` | unguard (`scan_pen`) | T-L1 I-DISP (`zero_width_fill`) |
| KL-M10 | `gcode_gen.rs` | `oring.cut(&mut lines, &mut moves, px, py);` | unguard (`oring`) | T-L1 I-DISP (`offset_fill_rounded`) |
| KL-M11 | `gcode_gen.rs` | `pen.cut(&mut lines, &mut moves, gpts[0].0, gpts[0].1);` | unguard (lead-in) | T-L1 I-STEP (`tiny_extensions`) |
| KL-M12 | `gcode_gen.rs` | `pen.cut(&mut lines, &mut moves, ox, oy);` | unguard (overcut) | T-L1 I-STEP (`tiny_extensions`) |
| KL-M13 | `gcode_gen.rs` | `pen.cut(&mut lines, &mut moves, lox, loy);` | unguard (lead-out) | T-L1 I-STEP (`tiny_extensions`) |
| KL-M14 | `gcode_gen.rs` | `lines.push("M5".to_string()); // seal the mask fill` | `// mutant: the mask fill is not sealed` | T-L1 I-SEAM (`pill_after_maskfill`, `arm__maskfill_then_line`), golden 04 |
| KL-M15 | `gcode_gen.rs` | `let q = \|v: f64\| format!("{:.3}", v).parse::<f64>().unwrap_or(v);` | `let q = \|v: f64\| v;` (the guard measures raw values, not written ones) | T-L1 I-STEP (`boundary_rounding`) |
| KL-C1 | `commands/gcode.rs` | `let may_delete = is_g1_xy(b) && !g1_moves_text(a_st.pos, bt);` | `let may_delete = is_g1_xy(b);` | T-L3b R1 |
| KL-C2 | `commands/gcode.rs` | `let may_start = is_positive_g1(b) && !(b_st.positioned && b_st.armed);` | `let may_start = is_positive_g1(b);` | T-L3b R2 |
| KL-C3 | `commands/gcode.rs` | `let may_seal = a == "M5" && b_st.sealable() && is_boundary(b);` | `let may_seal = a == "M5";` | T-L3b R3, R8 |
| KL-C4 | `commands/gcode.rs` | `let may_retarget = just_started && same_f_and_s(b, a) && !g1_moves_text(bt, at);` | `let may_retarget = same_f_and_s(b, a);` | T-L3b R4 |
| KL-C5 | `gcode_gen.rs` | KL-M4's find | the same, with `3.0` (the guard is far too eager: arc points are merged away) | T-L1 P2 (pills, `rounded_plain_2pass`) |
| KL-C6 | `commands/gcode.rs` | `let resets = starts_section(line).is_some() \|\| has_word(line, 'M', 5.0);` | `let resets = starts_section(line).is_some();` | T-L3c K3 |

**21 ids:** KL-M1 to M15 and KL-C1 to C6. (In the table, `\|` stands for a literal `|`.)

**T-L2 kills nothing, by design.** It reads committed goldens, which a code mutant cannot change. Nor does T-L4, which is ignored. Golden compares are credited only where a golden reaches the mutated site:
- golden 12 (lead-in 3) for M1 and M2;
- golden 04 for M14.

The other 15 goldens have no degenerate or sub-step geometry, as measured above.

**Anchor uniqueness.** Engine anchors were counted with `python3 str.count` on the whole file, so multi-line finds are counted as the battery counts them.
- "Before" means `gcode_gen.rs` at `83e02e5`.
- "After" means the scratch copy with 2a-2e applied verbatim and passed through `rustfmt --edition 2021` (no change resulted).

| Id | Before | After |
|---|---|---|
| KL-M1 to M15, C5 (KL-M4, M5 and C5 share one find) | 0 each (new text) | 1 each |
| KL-C1 to C4, C6 | 0 in `commands/gcode.rs` at `83e02e5` | 1 each, new in Commit 1 (the lines were checked to be `rustfmt`-stable at their nesting) |

- **Substring hazards checked:**
  - `pen.cut(` occurs 7 times in the after-file: 6 on the line arm's `pen`, plus once inside `scan_pen.cut(`. Every find includes the argument list, so each is unique.
  - `oring.cut(` and `scan_pen.cut(` do not contain `pen.cut(&mut lines`.
- **After `cargo fmt`,** Ted re-counts every find on the committed relay HEAD and quotes the counts. If any count is not 1, the code has drifted from this plan: fix the code back. Never rewrite a find without the orchestrator's sign-off, recorded in the report.
- `cargo fmt --check` is required because the anchors assume formatted code.

## Test command and preconditions

- **Rust test command (Verification):**
  `env -u KERF_UPDATE_GOLDEN CARGO_TARGET_DIR=/home/leesalo/.cache/kerf-engine-arm-target ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim`
  - The full suite must be green.
  - The count must be the relay-start baseline plus 5, with none weakened. The ignored count grows by 2 (T-L4, T-L5).
  - `--features sim` is used because CI builds that way (`ci.yml:85`). No new test uses the simulator, and none may treat sim output as beam evidence (DECISIONS 2026-09-05).
- `~/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features sim -- -D warnings`, with the same `CARGO_TARGET_DIR`. It must be clean at **both** commits (engine-arm's N1: a dead-code field in Commit 1 is a clippy error).
- `~/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml --check`.
- `test -z "${KERF_UPDATE_GOLDEN:-}"` in the shell that runs all of the above.
- **Disk:** at least 25 GB free before the first build (2g step 0) and before the battery. Reuse `CARGO_TARGET_DIR=/home/leesalo/.cache/kerf-engine-arm-target` (6.6 GB, warm) for every cargo invocation, including the battery. Never create a second target directory.
- `git diff --stat <base>..HEAD` lists exactly the 3 paths (4 if E1b merged first).
- The battery journal must show all 21 ids **killed**: 0 survived, 0 errored, 0 CONTROL_RED.
- **Razor re-runs T-L4 himself,** from a fresh `target/leadin-before`:
  - the goldens from `git show <base>:src-tauri/tests/golden/<f>`;
  - the 58 matrix files from T-L5 run on a checkout of **Commit 1**, because `leadin_matrix()` does not exist at the base.
  - His counts must match Ted's.
- **Razor also checks by reading** that the distance accumulators at the nine sites are untouched. He also checks that no line of the start block's output differs from `83e02e5` for a path whose first segment is longer than 0.001 mm.
- **Browser:** not applicable. The Vite dev server has no Tauri backend, so `invoke("generate_gcode")` cannot run there. The CLAUDE.md testing SOP's "hardware-only" rule applies instead: see the owner card.
- **TS:** no TS file changes, so `npm test` is not required. No TS code parses engine `G1` lines or the number of `M5`s (the assembler only strips framing and inserts its seam `M5`, `gcodeGen.ts:869`).

## Owner card (named, never claimed)

These steps go on the owner hardware card in ROADMAP `next` at Stage 3.5. The relay claims none of them.
- Under DECISIONS 2026-09-10, as amended 2026-09-25, evidence is a witness burn on scrap card with a control burn beside it. It qualifies only emission above the card's marking threshold, at the power, dwell, mode and controller tested.
- Lee runs every step at the machine, with fire precautions in place.

1. **In the app, no laser.** Draw a 10×20 mm rectangle with corner radius 5 on a line layer set to Constant (M3), with Lead-in 3. Generate, and view or export the G-code. Its cut section starts with a `G0` line, then `M3 S0`, then `G1` lines. Repeat with Variable (M4); it starts `G0`, then `M4 S0`.
2. **Control (proves the card can show a dot).** On scrap card, at the power used below, send from the console: `G1 F1000 S0`, `M3 S100`, `G4 P0.3`, `M5`. A dot must appear. If none does, raise the power one step and repeat. Stop if it never marks.
3. **The not-cut case (W2), M3.** Use the 10×20 r5 rectangle from step 1, 10% power, a speed that marks without cutting, and Lead-in 3.
   - **Pass:** the whole rounded outline marks, plus a short 3 mm lead-in stub.
   - On v0.8.30 this shape would be skipped (the head traverses without marking).
4. **The corner dwell case (W1), M3.** A 30×20 mm rectangle with corner radius 3, same settings, no lead-in.
   - Look at the four points where each straight edge meets its arc, and at the start point.
   - **Pass:** no darker dot at any of them beyond the line's own marking.
   - Those points are where the old program stopped the head with the beam at cut power.
5. **Fill+Line, M3 then M4.** The rectangle from step 4 on a Fill+Line layer with Lead-in 3.
   - **Pass:** no mark runs from the end of the fill to the start of the outline.
   - A brief stop before the outline starts is expected (engine-arm's plain-words sentence already covers it).
6. **Repeat steps 3-5 on Variable (M4),** the default. Pass criteria are the same.
7. **Optional, Lee's call:** repeat steps 3-4 on v0.8.30, for a before/after pair on one card. That runs the old behaviour deliberately, at 10% on card, under the same precautions.

**Workaround line for the card (not a test, fold 5):** "Use lead-in and lead-out on outer cuts only. On a hole (an inner cut), both currently burn into the finished part: a straight stub, or a diagonal chord when overcut is also set. This holds until the geometry program fixes which side is waste."

## done_condition

- `relay/kerf-safety-engine-arm` is an ancestor of `relay/kerf-safety-engine-leadin`, which is an ancestor of `marvin/kerf-gap`.
- `/home/leesalo/marvin/state/relay/kerf-safety-engine-leadin-razor-review-b1.md` (or its latest recheck) reports PASS with 0 CRITICAL, and quotes his own T-L4 counts.
- The `kerf-safety-engine-leadin` battery journal under `~/.local/state/marvin/mutation-battery/` records all 21 ids killed.
- Ted's report quotes 2g steps 1, 4, 5 and 6: the reproduce-first violation lists, the red list, `git status` and the golden-04 diff, and the T-L4 table with 0 `Err`.
- The Stage 3.5 obligations below are in the merged tree.
- **The owner-card steps are not part of done.** They are listed as owed on the card. Nothing in the close report says the beam was verified dark, or that a shape was verified cut.

### Stage 3.5 obligations (orchestrator)

- **ROADMAP:**
  - a `shipped` entry;
  - the Parking Lot line or hand-off item for this fix marked shipped in the section's own convention;
  - owner-card steps 1-7 added to `next`, **plus the workaround line** (lead-in and lead-out on outer cuts only; on a hole both burn into the part);
  - Parking Lot lines for Deferrals 1-7. Deferral 2's line is worded as the material outcome given in Deferral 2 and is indexed under the geometry program (DECISIONS 2026-09-10).
  - Engine-arm's Deferral 6 (the maskFill seam) is marked **closed for vector fragments**; it remains open for image output, which relies on the footer `M5`.
- **ARCHITECTURE.md delta** (`:194-203`, `gcode_gen.rs`): "every line path starts `G0` then `{M3|M4} S0`; every burning vector `G1` goes through `CutPen`, which refuses a move under one motor step (0.0125 mm per axis, as written); a mask fill ends `M5`."
- **DECISIONS amendment** (via `update-decisions.mjs decisions_amend`, never hand-edited; the orchestrator records it under the coordinator's delegation with provenance, or puts it to Lee). It amends Lee's 2026-09-26 entry, "Every mode line Kerf emits carries S0; positive S rides only on G1 words that carry X or Y.", which says "tighten it then by amendment". The added sentence:
  > "Every path the engine cuts starts with a G0 to its entry point and a mode line, and no burning G1 moves the head less than 0.0125 mm on some axis as written."
  - **The reason:** a stationary positive-S block under M3 burns (GRBL `motion_control.c:68-76`), and a burn that depends on a predecessor's state has already both skipped a cut and drawn a stray line.
  - **Enforced by** `leadin_invariants_every_fixture` and `committed_goldens_hold_leadin_invariants`.
  - Displacement is now asserted, so the entry's "carry X or Y" can be tightened to "with motion". The heading is never reworded (`project-docs.md`), so the tightening goes in the amendment text.

## Risks

1. **The fork is unqualified.** The stop-at-empty-block physics is stock source (`motion_control.c:68-76`, `planner.c:369-381`). Whether the vendor fork does the same is unknown (DECISIONS 2026-09-05). Both changes are monotone-safe: fewer stationary blocks, and a start every other path already has. Owner-card steps 3-4 are the instrument.
2. **The threshold is the owner's step size.**
   - `MIN_G1_AXIS_MM = 0.0125` is one step at `$100/$101 = 80` (`probe-20260914-153729.log:36-37`).
   - On a machine with fewer steps per mm (coarser steps), a sub-step `G1` can still plan empty.
   - On a finer machine, the guard merges moves under 0.0125 mm. That is a chord error of at most 0.0125 mm, far below the kerf. It is invisible, and it loses no cut (P2 is the check).
   - START reads back `$30`/`$32`, not `$100`/`$101` (Deferral 6). On another machine the reversal is "read `$100/$101` and derive the step", not "change the number".
3. **The preview and the time estimate drop refused points.**
   - `moves` loses a point only where no `G1` is written. The distance totals are unchanged, because the accumulators stay where they are.
   - `estimate_time` reads `moves` and already skips moves under 0.001 mm (`gcode_gen.rs:1456`). So a refused zero-length `G1` changes the estimate by nothing, and a refused sub-step one by milliseconds (fold 4).
4. **One more planner stop per mask-fill seam.** The sealing `M5` syncs at the end of the last mask scan line. Under M3 that end sees a full stop at power, the same as every `fill` scan end and every path end already do (constant-power acceleration burn, the 2026-09-10 ruling's territory). Under M4 it is dark. The perimeter start after it already stops (engine-arm Risk 2a).
5. **A lead-in on a W2 path now points along the first real segment,** where before there was no lead-in and no cut. That is the lead-in the operator asked for (P3). A 3 mm stub appears where nothing was cut before: owner card step 3.
6. **E1b merge order:** see "Existing plans reviewed". Only one Rust batch builds at a time.
7. **Golden-regeneration hazards** (as engine-arm):
   - A stray `KERF_UPDATE_GOLDEN` turns kills into passes; `env -u` is on every run.
   - Step 5 regenerates one named test with `--exact`, so `nativeStatus.json`'s writer (`serial.rs:3216`) cannot run.
   - A hand-edited golden is forbidden.
8. **The expected-count table is arithmetic, not a run.** A wrong count stops the relay at T-L4 for a recorded decision. It does not let a defect through, because the classifier's zero-`Err` rule is independent of the counts.

**Rollback:** revert the relay merge commit. The engine, the tests and golden 04 are in one commit. Nothing is persisted: no project-file format change and no controller setting written. **Irreversible steps:** none.

## Deferrals (each goes to `ROADMAP.md -> ## Parking Lot` at Stage 3.5)

1. **A lead-out on a rounded rectangle is silently dropped, and so is an overcut on a pill.**
   - The closing duplicate makes the last segment zero (`:527`, `:1371`), and the lead-out guard skips it (`:858`). So no `object_to_path` rounded rectangle ever gets its lead-out.
   - A pill's zero first segment skips the overcut the same way (`:826`).
   - Both are dark, so this is feature loss, not a hazard. The fix is to take the direction from the first and last real segments. It changes output for every rounded rectangle with a lead-out, so it needs its own batch and a regeneration.
2. **Lead-in and lead-out do not know which side is waste. On a hole, both mark the part** (re-scoped per fold 5).
   - **Lead-in:** the entry point uses the **outward** normal (`:546-579`, moved verbatim into `lead_in_point`). On a hole, outward is into the part, so the lead-in `G1` burns `lead_in` mm into the part.
   - **Lead-out:** the target is a straight extension of the last edge past the end (`:859-860`), which is outside the polygon on any convex closed path. On a hole, that is `lead_out` mm into the part.
   - **Overcut:** after an overcut the head is at the overcut end (`:846-847`), so the lead-out `G1` becomes a diagonal chord from there to the extension point. The overcut changes the scar's shape, not whether it exists.
   - **Route:** the geometry program, under DECISIONS 2026-09-10 ("Kerf compensation expands holes without accounting for which side is waste"). This is the same blindness. It is not this batch's class, and fixing it changes output for every program with a lead-in or lead-out (golden 12, `line_perf_overcut_leadout`).
   - **Parking Lot line, with the material outcome named:** "Lead-in and lead-out on a hole (an inner cut) burn into the finished part, a straight stub of the lead length, or a diagonal chord when overcut is also set. Workaround until the geometry program lands: use lead-in and lead-out on outer cuts only."
   - Found by reading, and confirmed by the critic's trace. No golden or fixture checks this geometry, and it needs an owner check when it is fixed.
3. **`object_to_path` emits duplicate points** (each arc's first point, `:1434-1452`, and the last arc's end). This batch neutralises them at the emitter. Making the source duplicate-free would change offsetFill rings and the optimizer's containment geometry (`optimizer.rs:304`, `:328`), so it belongs with the deferred geometry program (DECISIONS 2026-09-10) and E1b's `object_to_path` work.
4. **Inward offsetting keeps duplicated vertices un-offset** (`offset.rs:40-43`). Every inner ring of a shape with duplicates (a pill's TS contour on an offsetFill layer, `gcodeGen.ts:395`) keeps points on the outer outline, which burns spikes from the inner rings back to the edge. This batch removes only the zero-length `G1`s. Geometry program.
5. **Raster sub-step pixels.** `MIN_SCAN_INTERVAL_MM = 0.01` (`limits.rs:18`) is below one step at 80 steps/mm. A one-pixel run at that interval is an empty block, which under M3 is a stationary sync. The fix is in `mask_fill.rs` (merge the run, or clamp the interval to a step), and it touches image output.
6. **The step size is hard-coded** to the owner's controller. Reading `$100`/`$101` at START, beside the existing `$30`/`$32` readback, and passing it to generation would generalise it.
7. **The TS-side emitters are not audited for this class:** the material test and text labels (`materialTestGcode.ts`, `textGcode.ts`), and FRAME. Their W2/W1 exposure is unmeasured.

## Decisions needed

**None to ship this batch.** Everything here is engineering plumbing under Lee's 2026-09-25 technical delegation, and no product ruling is touched. The M3/M4 ruling is unchanged, and M3 stays selectable.

One choice was made under delegation, recorded so it can be reversed: **the guard threshold is one motor step (0.0125 mm), not just "zero".**
- The narrower choice (refuse only text-identical moves) would leave the kerf-offset pill junction, and any dense imported path, able to stop the head at cut power under M3.
- The cost of the wider choice is a sub-0.0125 mm chord error on finer machines.
- It is reversible by changing one constant plus a golden-neutral regeneration (no golden has a vector `G1` under 2 mm).
