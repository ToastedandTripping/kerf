# Kerf safety engine-arm: the Rust engine never arms a stationary beam

**Lifted from:** S2 Deferral 1 (`.claude/plans/kerf-safety-s2.md`, "Deferrals" 1; S2 critic must-fix 3), indexed at `ROADMAP.md:596` and detailed at `ROADMAP.md:790-794`. The coordinator queued it as the batch after S3 (2026-09-25, under Lee's technical delegation, `ROADMAP.md:596`).

**Citations** were read at `49fa7c4` on session branch `marvin/kerf-gap` (2026-09-25). `git diff e78e7fe..49fa7c4 -- src src-tauri` is empty, so every source line below holds at both. The only uncommitted change in the tree is `.marvin-worktree.json`.

## Fold notes (critic `kerf-safety-engine-arm-critic.md`, Fable: CONCERN, no gating FAIL)

The critic changed no line of the engine edit. All 9 must-fixes are folded as the coordinator specified:

1. **Killed-by column corrected.** T2 is removed from KE-M1 to M10. T2 reads the committed goldens, so a code mutant cannot turn it red. It is a regeneration guard, not a mutant killer. Every kill still stands via T1 and the byte-for-byte golden compares.
2. **Matrix file names.** T5 writes `target/arm-matrix-out/<label>_<mode>.gcode`, where `<mode>` is `constant` or `variable`, so there are 24 files and none overwrites another. T4 pairs files by that name and requires exactly 24 on each side.
3. **Where the before-matrix comes from.** It is built with T5 at **Commit 1**, not at the relay base, because `arm_matrix()` does not exist at the base. This applies to Ted's step 2 and to Razor's re-run.
4. **The perimeter-start change goes to Lee in plain words.** The owner card and the close report both carry this sentence: "After a fill, the perimeter cut on the same layer now starts from a brief stop; under constant power (M3) its start corner will show more burn than before." Card step 5 now runs in M4 and in M3. The M3 half is an observation, not a pass/fail, because corner energy under M3 is the 2026-09-10 ruling's territory.
5. **Step 5.** The filter is `golden_tests::golden_` with `--test-threads=1`, so T1 and T2 never read a corpus while it is being rewritten. Step 5's pass or fail is not consulted; steps 6 and 7 are.
6. **Disk.** It is now 90-91% (coordinator, 2026-09-25; `df` at fold time read 93% with 34 GB free, before the coordinator's worktree removal). New precondition: at least 25 GB free before every cold build, meaning before step 1 and before the battery. Below that, stop and report.
7. **Stepper cited** beside the parser: `stepper.c:845` and `:958-972`.
8. **No new reader.** This batch adds no reader of `KERF_UPDATE_GOLDEN`, and none may be added.
9. **The `$31 < $30` risk** is added to Risks as one line.

- **Relay id:** `kerf-safety-engine-arm`
- **Branch:** `relay/kerf-safety-engine-arm`
- **Tier:** **Complex by the file-count rule** (17 files). The authored change is two files. The other 15 are golden fixtures written by one regeneration command, and a classifier test proves every changed line in them. It runs as **one batch under a written waiver** (see "Tier and files"). There is no UI, so there is no Jen spec, no Jen review and no behavioural stage.

## Intent (grilled)

Grill skipped. The intent is fixed by sources already written, and none of them is open:
- CHARTER "Done looks like" (1): "no cut dying mid-job and no silent G-code error".
- DECISIONS 2026-09-10 (Lee): "Variable power (M4) is the default for every new layer; constant power (M3) exists for the stationary beam, not for cutting."
- S2 Deferral 1 and the coordinator's queue line (`ROADMAP.md:596`): "A stationary beam at every path start on any layer set to M3 ... plan `.claude/plans/kerf-safety-engine-arm.md`, with golden-regeneration discipline."

**Summary for this batch.** Every `M3`/`M4` line the Rust engine emits carries `S0`. Positive power appears only as the `S` word of a `G1` with motion. Nothing else in the emitted program changes: the same lines in the same order, with the same coordinates, feeds and `G1` powers. That is the same rule S2 applied to the material test, applied to the engine that generates every real job.

## Existing plans reviewed

**Inventory:** `.claude/plans/` holds 44 `.md` files plus `archive/`. A `grep -l` for `gcode_gen.rs`, `tests/golden`, `commands/gcode.rs` and `KERF_UPDATE_GOLDEN` hits 25 of them. The ones that matter:
- **`kerf-evidence-e1b.md` (QUEUED, not started; no `relay/kerf-evidence-e1b` branch).** It edits the same two `.rs` files and adds golden `16_fillline_sharp_rect.gcode`. Its changes are elsewhere in both files: the `other =>` arm, `object_to_path`, `assert_golden`'s reader and new tests. It touches none of the eight mode lines or the anchors below. **Order:** only one Rust batch runs at a time. The disk was at 92% when the hand-off was written (`:51`) and is at 90-91% now (Fold note 6); the free-space precondition is in Tests. Whichever batch lands second rebases:
  - **If E1b lands first:** golden 16 carries a positive `M3` line at site C (its line overlay), so this batch regenerates 16 files, not 15. Every count in this plan is computed by the tests, not hard-coded, and the report states the recount.
  - **If this batch lands first:** E1b's golden 16 is generated with `S0` from the start, and `committed_goldens_never_arm` (T2) covers it with no edit.
  - E1b changes `assert_golden` to regenerate only on `KERF_UPDATE_GOLDEN=1`. The regeneration command below sets exactly `1`, so it works under either reader.
- **`kerf-safety-s1b.md` (in flight):** edits `serial.rs`, `serial_session.rs` and `sim/grbl.rs` (`git diff --name-only HEAD...relay/kerf-safety-s1b`). It shares no file with this batch.
- **`kerf-safety-s3.md` (in flight):** its branch touches no `src-tauri` file. It cites `gcode_gen.rs:421-427` (the `fy` closure) but does not edit it. This batch does not touch `fy`.
- **`kerf-safety-s2.md` (merged):** the TS half of this class. Its Deferral 1 is this batch.
- **`kerf-relay-plan.md`, `remediation-batch-0.1.md`, the fence and refresh plans:** either merged or they cite these files without editing the mode lines.

## Context (verified at `49fa7c4`)

### The eight emitters, re-verified, plus every other source of `M3`/`M4`

`grep -n 'power_cmd\|"M3\|"M4' src-tauri/src/**/*.rs` finds every Rust site that emits a mode line. Each of the eight sites the S2 plan cites is a standalone positive mode line, as cited. **The S2 list misses no Rust emitter:**

| Site | `gcode_gen.rs` | Emits today | The line before it | The `G1` after it |
|---|---|---|---|---|
| A (fill scan line) | `:303` | `{power_cmd} S{s_max}` | `G1 … S0` accel overscan (`:289-292`) when `overscan > 0`; otherwise `G0` (`:270`) | `:312-315`, `S{s_max}` |
| B (line lead-in) | `:595` | `{power_cmd} S{effective_s_max}` | `G0` (`:586`) | `:600-603`, explicit `S` |
| C (line path start) | `:632` | same | `G0` (`:622`) | `:682-685`, `:762-765` or `:787-790`, explicit `S` |
| D (perforation re-arm) | `:708` | same | `G0` (`:700`) | `:682-685` / `:787-790`, explicit `S` |
| E (tab re-arm) | `:747` | same | `G0` (`:737`) | `:762-765` / `:787-790`, explicit `S` |
| F (overcut re-arm, `!laser_on`) | `:827` | same | `G0` (`:802`), because the path ended in a skip or tab | `:831-834`, explicit `S` |
| G (lead-out re-arm, `!laser_on`) | `:858` | same | the overcut `G1` (`:831`) if F ran, otherwise `G0` | `:862-865`, explicit `S` |
| H (offsetFill ring) | `:1104` | same | `M5` (`:1084`), then `G0` (`:1091`) | `:1112-1115`, explicit `S` |

**Already compliant, and not edited here:**
- **The shared raster scanner** emits `{power_cmd} S0` once per invocation (`mask_fill.rs:424-427`, the F4 hoist). Every row's `G0` carries `S0` (`:456`), and every `G1` goes through `emit_g1`, which always writes `S` (`:285-308`). It serves maskFill (`gcode_gen.rs:1219-1245`) and image engrave (`image_gcode_gen.rs:389-438`), which has no other mode line. Golden `05_image_engrave.gcode` already reads `M3 S0`. It gets mutant KE-M9 (existing code) so the tests prove they cover it.
- **TS:** the material test and its labels were fixed by S2 (`materialTestGcode.ts:114, :137, :173`; `textGcode.ts:104`). FRAME emits no `S` word (`JobActionBar.tsx:133`). The assembler inserts only `M5 ; laser off at layer seam` (`gcodeGen.ts:869`) and adds no mode line or `S` word (checked by grep).
- **Deliberately stationary, per the ruling:** the Fire button (`MachinePanel.tsx:902`, `M3 S${sVal}`, then `G4 P0.5` and `M5`). It is out of scope. See Deferral 3, which is a separate finding about it.

**No `G1` depends on modal `S`.** Every `G1` template in the engine carries its own `S` word:
- `gcode_gen.rs:290, 313, 336, 601, 683, 763, 788, 832, 863, 1113, 1134`;
- `mask_fill.rs:307` (`emit_g1`).

So the power on the mode line reaches the machine only while the head is stationary, before the next `G1`. It never reaches a burning move. That is why the mode line can go to `S0` with no `G1` changed. Class B of the classifier below ("a `G1` gaining `S`") is therefore expected to be **empty** in this batch, and the corpus test asserts that it is.

**The corpus** (counted at `49fa7c4` with a line parser over `src-tauri/tests/golden/*.gcode`, `;` comments stripped):
- 63 positive mode lines across 15 files: `01`:1, `02`:2, `03`:5, `04`:1, `06`:1, `07`:3, `08a`:1, `08b`:1, `09`:5, `10`:20, `11`:10, `12`:1, `13`:1, `14`:10, `15`:1.
- `05` has none. Its one mode line is already `M3 S0`.
- No golden has a positive `S` on anything but a `G1` or a mode line.
- No golden has a positive-`S` `G1` with zero displacement.
- **Sites F and G occur in no golden.** Golden 13 has an overcut but no perforation, so `laser_on` is true and F never fires. The matrix fixture `line_perf_overcut_leadout` (T1) exists for that reason.

### What the firmware does with these lines (a correction to the premise)

The premise says stock GRBL 1.1 lights the laser at a standalone `M3 S{s}` "while the head is stationary, until the next G1 moves". Against stock source, that is **true for one of the eight sites and not the other seven**. Source: gnea/grbl master `bfb67f0`, GRBL 1.1h, read 2026-09-25.

- **Every `M5` → `M3`/`M4` change is a planner sync.** The head stops before the mode line takes effect (`gcode.c:944-947`, `spindle_sync`, `spindle_control.c:277-282`). This is true before and after this batch.
- **In laser mode (`$32=1`), when the parser's modal motion at the mode line is not `G1`/`G2`/`G3`**, the parser sets `GC_PARSER_LASER_DISABLE` (`gcode.c:869-873`). The mode line then syncs at `pl_data->spindle_speed = 0` (`:932-934`, `:946`), so it is **dark on stock**. That applies to sites B, C, D, E, F and H, and to G when the overcut did not run, because each follows a `G0`.
- **When the modal motion is `G1`**, the positive `S` is passed through (`:932-933`), and `spindle_set_state` drives PWM at that power with the head stopped (`spindle_control.c:252-255`). That is **site A whenever `overscan > 0`**. New layers default to overscan 0.5 mm (`types.ts:260`), and `gcodeGen.ts:100` passes the value straight through. So on stock firmware, **every M3 `fill` layer with overscan burns a stationary dot at the start of every scan line.** Under M4 the same line is dark (`spindle_control.c:253`, CCW gives `rpm = 0`).
- **With `$32=0`, every site lights, including under M4.** START refuses `$32=0` (`canStartJob.ts:167-175`).
- **The owner's controller is a vendor fork.** Stock source is intent evidence, not proof (DECISIONS 2026-09-05). Whether the fork applies the `G0`-dark rule is unknown. The owner's settings, captured 2026-09-14, are `$30=1000`, `$31=0`, `$32=1` (`scripts/probe-20260914-153729.log:33-35`, settings lines only).
- **After this batch, stock is dark at all eight sites under either modal motion.** `S0` makes `pl_data->spindle_speed` zero in both branches, and `rpm == 0` with `$31=0 < $30` maps to `SPINDLE_PWM_OFF_VALUE` (`spindle_control.c:197-204`). So the fix stops depending on a subtle firmware rule the fork may not share.
- **The burn still happens on the next `G1 S<n>`.** In laser mode the stepper forces a PWM recompute on every new planner block (`stepper.c:845`, "Force update whenever updating block"). That flag is consumed at `:958-972`, which computes PWM from that block's `pl_block->spindle_speed` and reloads it into each segment. So `M3 S0` followed by `G1 … S600` fires at 600 from the start of that move. The raster hoist (`mask_fill.rs:424-427`) has relied on the same mechanism since F4.

The hazard label stands: this is X1-class on every M3 layer. The engine commands positive power on a line with no motion, and on stock firmware one arm already fires it on every scan line. The fork is unqualified at all eight sites.

### Test and golden machinery

- `assert_golden` (`commands/gcode.rs:474-501`) **writes** the fixture instead of comparing whenever `KERF_UPDATE_GOLDEN` is set to anything (`:478`, `is_ok()`). A stray variable turns every golden test into a pass. CI guards this (`ci.yml:78-83`) and runs `cargo test --features sim` (`:85`).
- `b2a_generate_native_status_fixture` (`serial.rs:3216`) is a second writer, keyed on the same variable. The regeneration filter below never matches it.
- Golden builders are `base_layer` (`commands/gcode.rs:505`), `rect_obj` (`:539`), `rect_path` (`:557`) and `make_rgba_png_base64` (`:569`), all inside `mod golden_tests` (`:459`), which is plain `#[cfg(test)]`.
- W4's evidence rides on the mode line today, so two tests pin it there:
  - `gcode_gen.rs:2516` `w4_line_clamps_power_min_to_power` asserts `contains("M4 S400")` (`:2526`);
  - `commands/gcode.rs:954` `golden_15_line_variable_power_min` asserts the same (`:969`).
  - Both move the evidence to the `G1` words (Change §3). The `!contains("S600")` half stays as it is.
- **This batch adds no reader of `KERF_UPDATE_GOLDEN`, and none may be added.** It uses only compile-time `env!("CARGO_MANIFEST_DIR")`. E1b's T12 requires exactly one reader across the crate.
- The simulator is not used. It treats any `M3`/`M4` as spindle-on whatever the `S` (`sim/grbl.rs:563-614`), and DECISIONS 2026-09-05 says sim-green on spindle paths is unproven.

## Tier and files

**One root (`src-tauri/`), 17 files:**

| # | File | Kind |
|---|---|---|
| 1 | `src-tauri/src/engine/gcode_gen.rs` | edit: 8 mode lines, 2 comments, 1 test re-point |
| 2 | `src-tauri/src/commands/gcode.rs` | edit: tests only (`mod golden_tests`); no production line changes |
| 3-17 | `src-tauri/tests/golden/{01,02,03,04,06,07,08a,08b,09,10,11,12,13,14,15}_*.gcode` | regenerated once, never hand-edited |

- **Not edited:** `mask_fill.rs` and `image_gcode_gen.rs` (KE-M9 mutates `mask_fill.rs` inside the battery's copy only), `05_image_engrave.gcode`, `tests/golden/README.md`, every TS file.
- **Waiver** (the relay pack's `batches[0].waiver`): "15 of 17 files are golden fixtures produced by one `KERF_UPDATE_GOLDEN=1` command. Every changed line in them is proven to be a mode line going to S0 by `golden_corpus_regeneration_is_arm_only`. Splitting them across batches would leave the corpus red between batches. The authored change is 2 files in one root."
- **If E1b merged first:** 18 files (golden 16 as well). Same waiver.

## Change

Two commits. Both are green.

### Commit 1: `src-tauri/src/commands/gcode.rs`, test machinery only (no engine change)

All of this goes in `mod golden_tests`.

- **Parser helper** `fn words(line: &str) -> Vec<(char, f64)>`:
  - strip everything from the first `;`;
  - read `([A-Z])\s*(-?\d*\.?\d+)` with a hand-written scanner. `src-tauri/Cargo.toml` has no `regex` crate, and none is added.
  - "Mode line" means a line with `('M', 3.0)` or `('M', 4.0)`.
  - Also `fn s_word(line: &str) -> Option<f64>` and `fn strip_s_word(line: &str) -> String`. The second removes the ` S<number>` token from the code part and keeps any `;` comment byte-for-byte.
- **Classifier** `fn classify_arm_diff(before: &str, after: &str) -> Result<ArmDiff, String>`, with `#[derive(Debug, Default, PartialEq)] struct ArmDiff { mode_s0: usize, g1_gained_s: usize }`.
  - Line counts must be equal. Otherwise `Err("line count changed …")`.
  - An unchanged line is skipped.
  - **Class A (a mode line goes to `S0`):** `before` is a mode line with `S > 0`, `after_is_s0`, and `same_apart_from_s`. That adds 1 to `mode_s0`.
  - **Class B (a `G1` gains `S`):** `before` is a `G1` with an `X` or `Y` word and no `S`, `after` has `S > 0`, and `same_apart_from_s`. That adds 1 to `g1_gained_s`.
  - Anything else is `Err(format!("line {}: {:?} -> {:?} is neither a mode-line S0 nor a G1 gaining S", i + 1, b, a))`.
  - These two lines must appear **verbatim**. KE-C4 and KE-C5 anchor on them, and each gives 0 hits in the tree today:
    - `let same_apart_from_s = strip_s_word(b) == strip_s_word(a);`
    - `let after_is_s0 = s_word(a) == Some(0.0);`
- **T3** `arm_diff_accepts_only_mode_s0_and_g1_gaining_s` (plain `#[test]`). The accept cases each return `Ok` with the stated counts:
  - `M3 S1000` → `M3 S0`;
  - `M4 S400` → `M4 S0`;
  - `G1 X1.000 Y2.000 F1200` → `G1 X1.000 Y2.000 F1200 S600`;
  - a multi-line pair mixing both with unchanged lines, giving `mode_s0: 2, g1_gained_s: 1`.
- **T3b** `arm_diff_rejects_everything_else` (plain `#[test]`). Each case returns `Err`, and the error names the right line number:
  - R1 `M3 S500` → `M4 S0` (the mode letter flips);
  - R2 `M3 S500` → `M3 S700` (still armed);
  - R3 `G1 X1.000 Y2.000 F1200 S600` → `G1 X1.000 Y2.500 F1200 S600` (a coordinate moves);
  - R4 `G1 X1.000 Y2.000 F1200 S600` → `G1 X1.000 Y2.000 F1200 S0` (a `G1` loses its power);
  - R5 a line inserted;
  - R6 `G0 X1.000 Y2.000` → `G0 X1.000 Y2.000 S600` (a `G0` gains power);
  - R7 `M3 S500` → `M3` (the `S` is dropped);
  - R8 `M3 S500 ; a` → `M3 S0 ; b` (the comment changes).
- **`async fn arm_matrix()`**, the fixture builder specified in 2.3. It lands in Commit 1 because the snapshot has to run on the unedited engine. T1 uses it in Commit 2.
- **T5** `arm_matrix_snapshot` (`#[tokio::test] #[ignore]`). It builds `arm_matrix()` and writes each of the 24 programs to `concat!(env!("CARGO_MANIFEST_DIR"), "/target/arm-matrix-out/<label>_<mode>.gcode")`, where `<mode>` is `constant` or `variable`, the layer's `power_mode` for that run (Fold note 2). It clears the directory first, and asserts that it wrote exactly 24 distinct files. It is compile-time `env!`: no test reads the process environment, which respects E1b's rule.
- **T4** `golden_corpus_regeneration_is_arm_only` (`#[test] #[ignore]`). Before dir: `concat!(env!("CARGO_MANIFEST_DIR"), "/target/golden-before")`.
  - It panics if that dir is missing or holds fewer `.gcode` files than `tests/golden` (so it cannot pass vacuously).
  - It classifies each before/after pair: every `before/*.gcode` against `tests/golden/*.gcode` by file name, and every `before/matrix/<label>_<mode>.gcode` against `target/arm-matrix-out/<label>_<mode>.gcode` by that same name.
  - It asserts: the same file sets, with exactly 24 matrix files on each side; zero `Err`; total `mode_s0` equal to the number of positive mode lines in the before set, counted by the same parser, which must be ≥ 1; `g1_gained_s == 0`; and zero positive mode lines left in any after file.
  - It prints per-file counts with `--nocapture`.
  - `target/` is gitignored (`.gitignore:23`), so nothing in the tree changes.

### Commit 2: the arming change, the durable invariants, and the regeneration

#### 2.1 `src-tauri/src/engine/gcode_gen.rs`: eight mode lines

- **Site A (`:303`):** `lines.push(format!("{} S{}", params.power_cmd, params.s_max));` becomes `lines.push(format!("{} S0", params.power_cmd));`.
- **Sites B–H (`:595, :632, :708, :747, :827, :858, :1104`):** each `lines.push(format!("{} S{}", power_cmd, effective_s_max));` becomes `lines.push(format!("{} S0", power_cmd));`. All 7 are identical today, and the replacement is identical at all 7.
- **Comments.** Only these two change, and each replacement is exact, because the mutant anchors use them:
  - `:460` `        // Power mode command` becomes three lines:
    `        // Power mode command. Every mode line below is `{power_cmd} S0`; positive S`
    `        // rides only on G1 words with motion, so no mode line arms a stationary`
    `        // beam (DECISIONS 2026-09-10; safety engine-arm).`
  - `:1103` `// P2-A Fix #5: use effective_s_max (floored at s_min for M4 mode)` becomes `// Mode at S0; power rides on the G1 words below (safety engine-arm)`, at the same indent (28 spaces). The old text would be false once the line stops using `effective_s_max`.
  - Every other comment stays, including `:594` `// Laser on, cut to first point`, which KE-M2 anchors on.
- **Nothing else changes.** No `G1` line, no `moves.push`, no distance counter and no line order. None of the eight sites pushes a `GcodeMove` (read at each site), so `moves`, `line_count`, the distances and `estimated_time_secs` are unchanged. `effective_s_max` stays: every `G1` uses it.
- **The anchors were simulated.** The edit above was applied to a scratch copy of `gcode_gen.rs` at `49fa7c4`. After the edit, `{} S0", power_cmd` gives 7 hits, `{} S0", params.power_cmd` gives 1, and no positive mode template is left (`"{} S{}", power_cmd` gives 0 and `"{} S{}", params.power_cmd` gives 0). The mutation table gives the per-anchor counts.

#### 2.2 `src-tauri/src/engine/gcode_gen.rs:2516-2535` (re-point W4, not weakened)

- `result.gcode.contains("M4 S400")` becomes two assertions:
  - `result.gcode.contains("M4 S0")`;
  - every line starting `"G1 "` ends with `" S400"`, and there is at least one.
- The `!contains("S600")` assertion is unchanged.
- The failure messages say that W4's evidence now lives on the `G1` words.

#### 2.3 `src-tauri/src/commands/gcode.rs`

- **`golden_15_line_variable_power_min` (`:954-983`):** the same re-point as 2.2 on `:969-973`. The doc comment `:950-952` becomes "the expected S value is **S400** on every `G1`, with the **M4** mode line at `S0`. If a `G1` reads S600, W4 has regressed; if the mode line reads M3, the variable default has regressed."
- **`async fn arm_matrix() -> Vec<(String, Program)>`** (it lands in Commit 1; specified here). `Program` holds the G-code, the expected mode letter and the expected positive `S` (`None` for raster). It is shared by T1 and T5. Each fixture is built for both `power_mode` ∈ {`constant`, `variable`}, through the real commands (`generate_gcode(vec![…], H, Some(1000.0), None, None, None)` / `generate_image_gcode`). Every vector fixture is `base_layer(mode)` with `power: 60.0` and `power_min: 0.0`; each row names only what differs:

  | Label | Layer | Sites it reaches |
  |---|---|---|
  | `line_plain_2pass` | `line`, power 60, 30×20 rect path, `passes: 2` | C |
  | `line_lead_in_out` | `line`, `lead_in 3`, `lead_out 2` | B (G not reached: `laser_on` stays true) |
  | `line_perforation` | `line`, `perforation 3/2` | C, D |
  | `line_tabs` | `line`, `tab 8/2` | C, E |
  | `line_perf_overcut_leadout` | `line`, `perforation 3/2`, `overcut 2.5`, `lead_out 2`, 30×20 (the path ends in a skip, as golden 10 does) | C, D, F, G |
  | `fill_overscan0` | `fill`, 20×20, interval 5, overscan 0 | A after `G0` |
  | `fill_overscan2` | `fill`, as above, overscan 2, bidirectional | A after `G1 … S0` (the stock-lit case) |
  | `fill_hatch_flood_30` | `fill`, `cross_hatch`, `fill_order "flood"`, `scan_angle 30`, overscan 1 | A |
  | `offset_fill` | `offsetFill`, 20×20, interval 2 | H |
  | `maskfill_then_line` | golden 04's maskFill (outer + hole) plus line overlay, one `layer_index` | hoist, C after maskFill |
  | `image_threshold` | golden 05's 4×1 request, power 100 | hoist |
  | `image_grayscale` | 4×1 with grey pixels (0, 128, 200, 255), `dither "grayscale"` | hoist; M4 forced (`image_gcode_gen.rs:389-393`) |

  Expected mode: `constant` → `M3` and `variable` → `M4`, except `image_grayscale`, which is `M4` in both runs. Expected positive `S` for every vector fixture: `round(60 / 100 × 1000) = 600`. With `power_min 0`, `effective_s_max == s_max` in both modes (`gcode_gen.rs:477-481`).
- **T1** `arm_invariants_every_layer_type` (`#[tokio::test]`). For every program in the matrix (24 programs):
  - **I1:** every mode line has an `S` word, and it equals 0.
  - **I2:** every line with `S > 0` has a `G1` word and an `X` or `Y` word. This catches a bare `S` line, a `G0` with power, and a positive mode line.
  - **I3:** every `M3`/`M4` word equals the expected mode, and the program has at least one mode line (anti-vacuity).
  - **I4:** every `G1` line has an explicit `S` word. That is the property that makes `S0` on the mode line burn-neutral: no burning move inherits the mode line's power.
  - **P1 (control):** at least one `G1` has `S > 0`.
    - In `; Cut:` and `; Offset Fill:` sections, every `G1` has `S ==` the expected positive S.
    - In `; Engrave:` sections, every `G1` is `S0` (overscan) or the expected S.
    - In raster output, every positive `S` is ≤ 1000.
  - The failure message names the fixture, the power mode, the line number and the line.
- **T2** `committed_goldens_never_arm` (plain `#[test]`). It reads every `*.gcode` in `golden_dir()` and asserts I1 and I2 on each.
  - Anti-vacuity: at least 16 files, and at least 1 mode line across them.
  - It stops a future regeneration from silently pinning a re-armed program as the new truth.
- **Matrix file names are stable.** T4 pairs before and after matrix files by `<label>_<mode>`, so no label or fixture parameter may change between the snapshot in 2.4 step 2 (taken at Commit 1) and step 6.

#### 2.4 Regenerated goldens (15 files; 16 if E1b landed first)

This is a procedure, in this order. Ted quotes each step's output in his report.

0. **Free-space precondition (Fold note 6).** Run `df -BG --output=avail /home`. At least 25 GB must be free before this relay's first cold build (step 1) and again before the battery, which cold-builds its own copy. Below 25 GB, stop and report NEEDS_CONTEXT. Do not delete anything to make room: the coordinator owns worktree removal.
1. **Before any engine edit** (Commit 1 committed), add T1 and T2 and run them: `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim -- arm_invariants_every_layer_type committed_goldens_never_arm`. Cargo takes more than one name filter only after `--`.
   - **Reproduce:** T1 must fail on I1, first in `line_plain_2pass` under `constant`.
   - T2 must fail on I1 in `01_simple_rect_cut.gcode`.
   - If either passes, stop and report NEEDS_CONTEXT.
2. **Snapshot the before state, at Commit 1** (Fold note 3: `arm_matrix()` exists from Commit 1 on, never at the relay base).
   - `git diff --quiet -- src-tauri/tests/golden` must succeed.
   - `mkdir -p src-tauri/target/golden-before && cp src-tauri/tests/golden/*.gcode src-tauri/target/golden-before/`.
   - Then `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim arm_matrix_snapshot -- --ignored`, then `mv src-tauri/target/arm-matrix-out src-tauri/target/golden-before/matrix`, and confirm that `ls src-tauri/target/golden-before/matrix/*.gcode | wc -l` prints 24.
3. **Make the edits** in 2.1-2.3.
4. **See only the expected reds.** Run `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim -- commands::gcode engine::gcode_gen engine::mask_fill`.
   - The only red tests are the `golden_NN_*` tests of the 15 files listed and T2.
   - Any other red test (T1 included) is a defect: stop.
5. **Regenerate once:** `KERF_UPDATE_GOLDEN=1 ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim -- golden_tests::golden_ --test-threads=1`.
   - The filter matches only the `golden_NN_*` writers and `golden_determinism_two_runs_identical`, which is pure. T4 is also matched but is `#[ignore]` and does not run. The filter does not match T1, T2, T3, T5, or `b2a_generate_native_status_fixture`, so no test reads the corpus while it is being rewritten. `--test-threads=1` serialises the writers as well.
   - **Step 5's pass or fail is not consulted.** It is a write step. Its only checked outcome is the `git status` below. Steps 6 and 7 are the verdict. Never re-run step 5 "to be sure": if steps 6 and 7 are not clean, stop and report.
   - Then `git status --short src-tauri src` must list exactly the two edited `.rs` files and the 15 goldens, and nothing else. In particular it must not list `05_image_engrave.gcode` or `src/lib/machine/__tests__/fixtures/nativeStatus.json`.
6. **Classify:**
   - `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim arm_matrix_snapshot -- --ignored`
   - then `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim golden_corpus_regeneration_is_arm_only -- --ignored --nocapture`.
   - Expected: 0 rejects, `g1_gained_s == 0`, and a golden-corpus `mode_s0 == 63` over 15 files, or the recount if E1b landed.
   - `grep -cE '^M[34] S[1-9]' src-tauri/tests/golden/*.gcode` gives 0 for every file.
7. **Compare green:** the full suite, with the variable unset, is green (Verification).
8. **Commit** the code and the goldens together, so the tree is never red.

## Invariants (what "done" asserts about engine output)

| Id | Statement | Where it is enforced |
|---|---|---|
| I1 | Every `M3`/`M4` line carries `S0`, and nothing else | T1 (all layer types, M3 and M4), T2 (committed corpus) |
| I2 | Positive `S` appears only on `G1` words with an `X` or `Y` word | T1, T2 |
| I3 | The mode letter follows the layer: constant → M3, variable → M4, grayscale image → M4 | T1 |
| I4 | Every `G1` carries its own `S`, so no burning move depends on the mode line's power | T1 |
| I5 | Apart from those mode lines, the emitted program is byte-identical: same line count, same lines, same order | T4 (one-shot, golden corpus and matrix, including sites F/G that no golden reaches), plus the byte-for-byte goldens thereafter |
| P1 | Burning `G1`s keep their power (the zero-everything control) | T1 |

**On "displacement".** I2 is word-level (`G1` plus an `X` or `Y` word). Real displacement was measured at `49fa7c4` instead of assumed: no golden has a positive-`S` `G1` with zero displacement (position tracked through `G0`/`G1`, `G90`). A zero-length `G1` in the engine is guarded by `seg_len < 0.001` skips (`:665`, `:720`, `:822`, `:854`, `:1130`). A word-level rule is stable against those guards. A displacement-level rule would make I2 depend on geometry that this batch does not own.

## Tests and mutation battery

**Rust test command (Verification):**
- `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim`. The count must be the baseline measured at relay start plus the new tests, with none weakened. T4 and T5 are `#[ignore]` by design and are run explicitly as in 2.4.
- `--features sim` is not needed by any new test. It is used because CI builds that way (`ci.yml:85`), so the engine is compiled once in one configuration.

**Battery spec `kerf-safety-engine-arm`:**
- `test_command`: `["env","-u","KERF_UPDATE_GOLDEN","/home/leesalo/.cargo/bin/cargo","test","--manifest-path","src-tauri/Cargo.toml","--features","sim","--","commands::gcode","engine::gcode_gen","engine::mask_fill"]`.
  - It is also launched as `env -u KERF_UPDATE_GOLDEN node ~/marvin/scripts/mutation-battery.mjs <spec>`. The battery strips only `GIT_*` from the environment. With the variable set, the goldens would rewrite instead of compare: kills would be lost and the writes would show as stray paths.
  - Ted confirms from the baseline output that all three modules ran, and states the count. The ignored T4 and T5 do not run in the battery.
- **Free-space precondition:** at least 25 GB free (`df -BG --output=avail /home`) before launching the battery. Its copy cold-builds the crate. Below 25 GB, do not launch: report NEEDS_CONTEXT to the coordinator, who owns worktree removal.
- `per_mutant_timeout_ms: 1500000`, `total_timeout_ms: 5400000`. These are E1b's measured values (`kerf-evidence-e1b.md:214`): a cold baseline of 218-1,463 s, then about 94-105 s per id.
  - 16 ids come to about 25-28 minutes plus the baseline.
  - Do not run cargo by hand to time the battery. Read the journal. A timeout is `errored`: re-run with the same spec, and never drop an id.
- Every mutant is one contiguous find/replace. The battery refuses zero or multiple hits (`MUTANT_ANCHOR_AMBIGUOUS`). Every wrong variant type-checks. Controls (C) are killed mutants like any other: green at baseline, red under the named wrong variant.
- In the finds, `⏎` is a newline and `·N` is N spaces of indentation (exact).

| Id | File | find | replace | Killed by |
|---|---|---|---|---|
| KE-M1 | `gcode_gen.rs` | `lines.push(format!("{} S0", params.power_cmd));` | `lines.push(format!("{} S{}", params.power_cmd, params.s_max));` | T1 I1 (fill ×3), goldens 03, 14 |
| KE-M2 | `gcode_gen.rs` | `// Laser on, cut to first point⏎·32lines.push(format!("{} S0", power_cmd));` | same, with `"{} S{}", power_cmd, effective_s_max` | T1 I1 (`line_lead_in_out`), golden 12 |
| KE-M3 | `gcode_gen.rs` | `cur_y = gpts[0].1;⏎·28lines.push(format!("{} S0", power_cmd));` | same, positive | T1 I1 (most line fixtures), goldens 01, 02, 04, 06-08, 10, 11, 13, 15 |
| KE-M4 | `gcode_gen.rs` | `lines.push(format!("{} S0", power_cmd));⏎·40laser_on = true;⏎·40next_toggle_dist += perf_cut;` | first line positive, the rest the same | T1 I1 (perforation fixtures), golden 10 |
| KE-M5 | `gcode_gen.rs` | `lines.push(format!("{} S0", power_cmd));⏎·40laser_on = true;⏎·40next_toggle_dist = tab_end_dist + tab_spacing;` | first line positive | T1 I1 (`line_tabs`), golden 11 |
| KE-M6 | `gcode_gen.rs` | `let oy = gpts[0].1 + dy / seg_len * ext;⏎·32if !laser_on {⏎·36lines.push(format!("{} S0", power_cmd));` | last line positive | T1 I1 (`line_perf_overcut_leadout`) **only**: no golden reaches F |
| KE-M7 | `gcode_gen.rs` | `let loy = gpts[n - 1].1 + dy / seg_len * lead_out;⏎·32if !laser_on {⏎·36lines.push(format!("{} S0", power_cmd));` | last line positive | T1 I1 (`line_perf_overcut_leadout`) **only** |
| KE-M8 | `gcode_gen.rs` | `// Mode at S0; power rides on the G1 words below (safety engine-arm)⏎·28lines.push(format!("{} S0", power_cmd));` | second line positive | T1 I1 (`offset_fill`), golden 09 |
| KE-M9 | `mask_fill.rs` (existing code) | `lines.push(format!("{} S0", params.power_cmd));` | `lines.push(format!("{} S{}", params.power_cmd, params.s_max));` | T1 I1 (`maskfill_then_line`, image ×2), goldens 04, 05, `mask_fill` tests at `:2087-2091`, `:2159` |
| KE-M10 | `gcode_gen.rs` | KE-M3's find | KE-M3's find, then `⏎·28lines.push(format!("S{}", effective_s_max));` (a bare `S` line, which re-arms a stationary M3 on a `G1`-modal parser) | T1 I2, goldens 01, 02, 04, 06-08, 10, 11, 13, 15 (an extra line) |
| KE-M11 | `gcode_gen.rs` | `"G1 X{:.3} Y{:.3} F{:.0} S{}",⏎·36lox, loy, speed_mm_min, effective_s_max` | `"G1 X{:.3} Y{:.3} F{:.0}",⏎·36lox, loy, speed_mm_min` (the lead-out inherits modal `S`, which after site G is `S0`: a burning move silently loses power) | T1 I4 and P1 (`line_lead_in_out`, `line_perf_overcut_leadout`), golden 12 |
| KE-C1 | `gcode_gen.rs` | `let power_cmd = if layer.power_mode == "variable" {⏎·12"M4"` | `…{⏎·12"M3"` | T1 I3 (variable runs), golden 15 |
| KE-C2 | `gcode_gen.rs` | `esx, esy, params.speed_mm_min, params.s_max` | `esx, esy, params.speed_mm_min, 0.0` | T1 P1 (fill: no positive `G1` left), goldens 03, 14 |
| KE-C3 | `gcode_gen.rs` | `gpts[0].0, gpts[0].1, speed_mm_min, effective_s_max` | `gpts[0].0, gpts[0].1, speed_mm_min, 0.0` | T1 P1 (`line_lead_in_out`: a `; Cut:` `G1` at `S0`), golden 12 |
| KE-C4 | `commands/gcode.rs` | `let same_apart_from_s = strip_s_word(b) == strip_s_word(a);` | `let same_apart_from_s = true;` | T3b R1, R8 |
| KE-C5 | `commands/gcode.rs` | `let after_is_s0 = s_word(a) == Some(0.0);` | `let after_is_s0 = true;` | T3b R2 |

**16 ids:** KE-M1 to M11 and KE-C1 to C5.

**T2 kills nothing in the battery, by design (Fold note 1).** It reads the committed goldens, which a code mutant cannot change. It guards the corpus against a future regeneration pinning a re-armed program as the truth. It is not a mutant killer, and the "Killed by" column does not credit it.

**Anchor uniqueness.** "Before" is the count at `49fa7c4`. "After" is the count in a scratch copy of `gcode_gen.rs` with 2.1 applied verbatim (`python3 str.count` on the whole file, so multi-line finds are counted as the battery counts them):

| Id | Before | After |
|---|---|---|
| KE-M1 to M8, M10 | 0 (new text) | 1 each |
| KE-M9 | 1 in `mask_fill.rs` | 1 (file not edited) |
| KE-C1, C2, C3 | 1 each | 1 each (lines not edited) |
| KE-M11 | 1 (`lox, loy` is unique; the format line above it is shared, so the find must include both lines) | 1 |
| KE-C4, C5 | 0 in `commands/gcode.rs` (`grep -cF`) | 1 each, new in Commit 1 |

- Ted re-counts every find on the committed relay HEAD, after `cargo fmt`, and quotes the counts. If any count is not 1, the code has drifted from this plan: fix the code back. Never rewrite a find without the orchestrator's sign-off recorded in the report.
- `cargo fmt --check` is required here even though CI tolerates it (`ci.yml:94-96`), because the anchors assume formatted code.

## Verification

- The Rust test command above: full suite green with the variable unset.
- `~/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features sim -- -D warnings`.
- `~/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml --check`.
- `test -z "${KERF_UPDATE_GOLDEN:-}"` in the shell that runs all of the above.
- 2.4's steps 1, 4, 5 and 6 are quoted in Ted's report: the reproduce-first failures, the red list, `git status` after regeneration, and the T4 counts.
- `git diff --stat <base>..HEAD` lists exactly the 17 paths (18 if E1b merged first).
- The battery journal: all 16 ids **killed**, with 0 survived, 0 errored and 0 CONTROL_RED.
- **Razor re-runs T4** himself, from a fresh `target/golden-before`: the goldens from `git show <base>:src-tauri/tests/golden/<f>`, and the 24 matrix files from T5 run on a checkout of **Commit 1** (Fold note 3), because `arm_matrix()` does not exist at the base. He checks the counts match Ted's. He also checks by reading that none of the eight sites pushes a `GcodeMove`.
- **Browser:** not applicable. The Vite dev server has no Tauri backend, so `invoke("generate_gcode")` cannot run there (the same holds in E1a and E1b).
- **TS:** no TS file changes. `npm test` is not required. The Rust output shape TS consumes changes only in mode-line `S` values, and no TS code parses a mode line (grep of `src/` for `M3`/`M4` parsers: none).

## Hardware (owner card; named, never claimed)

These steps go on the owner hardware card in ROADMAP `next` at Stage 3.5. Nothing here is claimed by the relay. Under DECISIONS 2026-09-10, as amended 2026-09-25, evidence is a witness burn on scrap card with a control burn beside it. It qualifies only emission above the card's marking threshold, at the power, dwell, mode and controller tested. Lee runs every step at the machine, with fire precautions in place.

1. **Release build, not hardware:** in the Tauri app, set a layer to Constant (M3), draw a rectangle, Generate, and export or view the G-code. Every `M3` line reads `S0`. Repeat with Variable (M4).
2. **Control (proves the card can show a dot).** On scrap card, at the power used below, send from the console: `G1 F1000 S0` at the current position (this sets `G1` modal), `M3 S100`, `G4 P0.3`, `M5`.
   - A dot must appear. That is the stationary beam the engine used to command on the `fill` arm.
   - If no dot appears, the card cannot show the defect at this power: raise the power one step and repeat. Stop if it never marks.
3. **M3 piece** (new build). One layer set to Constant (M3), line mode, 10% power, a speed that marks without cutting: a 20 mm square plus a 40 mm perforated line (cut 3 / skip 2). A second layer set to Constant (M3), Fill, on a 10 × 10 mm rectangle, interval 1 mm, overscan 2 mm. Look for dots at:
   - the square's start corner;
   - the start of every perforation dash;
   - both ends of every fill scan line, just inside the overscan.
   Pass: no dot at any of them, beyond the marking the line itself makes.
4. **M4 piece:** the same design with both layers set to Variable (M4). Pass: same as step 3. This is the default path, and on stock firmware it was already dark.
5. **Fill+Line, what changed (the card and the close report both carry this sentence, Fold note 4):** "After a fill, the perimeter cut on the same layer now starts from a brief stop; under constant power (M3) its start corner will show more burn than before."
   - **5a, M4 (the default):** a rectangle on a Fill+Line layer set to Variable (M4). The perimeter should start cleanly after the fill. A brief pause at its start corner is expected. Pass: no extra mark at the start corner.
   - **5b, M3:** the same rectangle with the layer set to Constant (M3). Expect a heavier start corner than on a v0.8.30 burn of the same design. This is an **observation, not a pass/fail**. Extra energy at an M3 start is constant power's acceleration burn, which the 2026-09-10 ruling already covers ("constant power (M3) exists for the stationary beam, not for cutting"). It is the same effect every other M3 path start already has. Lee notes what he sees. A mark he judges unacceptable is a question for the ruling, not a defect in this batch.
6. **Optional, Lee's call:** repeat step 3 on the current release (v0.8.30), for a before/after pair on one card. It runs the old behaviour deliberately, at 10% on card, under the same precautions.
7. **Only if Lee through-cuts on M3:** one M3 through-cut, checking that the start and close point is still cut through. If the fork had been lighting the old mode line, it was adding an accidental pierce at the start.

## done_condition

- `relay/kerf-safety-engine-arm` is an ancestor of `marvin/kerf-gap`.
- `/home/leesalo/marvin/state/relay/kerf-safety-engine-arm-razor-review-b1.md` (or its latest recheck) reports PASS with 0 CRITICAL, and quotes his own T4 counts.
- The `kerf-safety-engine-arm` battery journal under `~/.local/state/marvin/mutation-battery/` records all 16 ids killed.
- Ted's report quotes 2.4's steps 1, 4, 5 and 6, with 0 rejects and `g1_gained_s == 0`.
- The Stage 3.5 obligations below are in the merged tree.
- The hardware card steps are **not** part of done. They are listed as owed on the owner card. Nothing in the close report says the beam was verified dark.
- The close report quotes card step 5's plain-words sentence verbatim (Fold note 4).

## Stage 3.5 obligations (orchestrator)

- **ROADMAP:**
  - a `shipped` entry, which carries the plain-words sentence from card step 5;
  - the Parking Lot line at `:596` is marked shipped in the section's own convention, and the "Deferred from kerf-safety-s2" section is left verbatim;
  - Hardware steps 1-7 added to the owner card bullets in `next`;
  - the Parking Lot lines for Deferrals 1-6 below.
- **ARCHITECTURE.md delta:**
  - `:194-203` (`gcode_gen.rs`): add "every mode line is `{M3|M4} S0`; power rides on `G1` words".
  - `:311-315`: replace "and the engine's own standalone mode lines still carry positive S (ROADMAP Parking Lot, S2 Deferral 1)" with "the Rust engine's mode lines carry `S0` as well (safety engine-arm, 2026-09-2x)".
- **DECISIONS proposal** (never auto-written; the orchestrator puts it to Lee or records it under the coordinator's delegation with provenance). Engineering pin: "Every mode line Kerf emits carries S0; positive S rides only on G1 words with motion." The reason: a stationary `M3` at positive S fires on stock GRBL whenever the parser is `G1`-modal (`gcode.c:932-946`), and on the vendor fork its behaviour is unqualified. Enforced by `arm_invariants_every_layer_type` and `committed_goldens_never_arm`.

## Risks

1. **The fork and `M3 S0`.** On stock firmware, `S0` maps to PWM-off with `$31=0 < $30=1000` (`spindle_control.c:197-204`; owner values `probe-20260914-153729.log:33-34`). If the fork lights a minimum PWM on an enabled spindle at `S0`, a dot survives at M3 starts. That is no worse than today, and card steps 2-3 are the instrument that would show it. The remedy would be a product call (see "Decisions needed").
1b. **`S0` is PWM-off only while `$31 < $30`** (`spindle_control.c:197`). The owner has `$31=0 < $30=1000` (`probe-20260914-153729.log:33-34`). START's readback covers `$30`, not `$31`.
2. **Two transitions gain a planner stop (motion timing changes, G-code bytes do not).**
   - When the spindle is **already on** in the same mode with the same `S`, the old positive mode line was a no-op. `S0` changes the modal speed, so GRBL now syncs (`gcode.c:917-923`): the head stops, dark, and the next `G1` starts from standstill.
   - (a) **maskFill → the next object in the same fragment.** maskFill ends without `M5`, by design (`mask_fill.rs:384-389`). An example is golden 04, line 33: the Fill+Line perimeter.
   - (b) **Site G right after site F.** `laser_on` is not set true after the overcut re-arm (`:826-845`), so G re-emits a mode line with the spindle already on.
   - Under M4 the stop is dark and the start ramps from zero power. Under M3 the new start behaves like every other M3 path start, which already stops at the `M5` → `M3` sync. `moves` and the time estimate do not model syncs, so the preview does not change.
   - Card step 5 checks (a). (b) needs perforation or tabs plus overcut plus lead-out on one layer.
3. **Under M3, the beam still lights as the first `G1` accelerates from the sync stop.** That is constant-power acceleration burn, not a stationary beam, and it is the 2026-09-10 ruling's territory. This batch does not claim to remove it.
4. **W4's evidence moves from the mode line to the `G1` words.** Both tests are re-pointed, and neither is weakened: the `S600` absence check stays, and "every `G1` is S400" is stronger than "the mode line is S400".
5. **Golden-regeneration hazards:**
   - A stray `KERF_UPDATE_GOLDEN` turns kills into passes. `env -u` is used on every run, and the battery errors on the stray write.
   - The filter never reaches `nativeStatus.json`: step 5's `git status` check.
   - A hand-edited golden is forbidden. T4 would still accept an edit that happened to be a mode-line S0, but that would still be correct.
6. **E1b merge order:** see "Existing plans reviewed". Only one Rust battery runs at a time.
7. **E3's spindle tally** (`lastSentLine.ts:115-147`) counts Run reports showing spindle 0. On M3 layers, the window between a mode line and the first `G1` now reports 0 where the stock-lit case reported S. The tally is status-only by its own wording. A shift is not a regression and must not be read as beam evidence.

**Rollback:** revert the relay merge commit. The code and the goldens are in the same commit, so the corpus reverts with the engine. Nothing is persisted: no project-file format change, no controller setting written. **Irreversible steps:** none.

## Deferrals (each goes to `ROADMAP.md -> ## Parking Lot` at Stage 3.5)

1. **The `fill` arm stops the head at every scan line.** Every scan line is `M5` then `{mode}`, a state change that forces a planner sync (`gcode.c:944-947`). So the head decelerates to zero at each scan boundary, and overscan buys nothing on the `fill` arm (`gcode_gen.rs:302-323`). The raster scanner already solved this: one hoisted mode line with no mid-row `M5` (`mask_fill.rs:384-427`). Fixing it changes motion and burn output, so it needs its own batch and a golden regeneration.
2. **Perforation and tab restarts stop the head at every dash** (`M5` at `:693` and `:775`, then the mode line at D and E). Under M3, each dash start gets an acceleration burn. This is a quality item of the same class as 1.
3. **The Fire button is dark on stock GRBL after any job.** `MachinePanel.tsx:902` sends `M3 S${sVal}`, then `G4 P0.5`. Every job ends `G0 X0 Y0 ; return home` (`gcode_gen.rs:1293`, `gcodeGen.ts:859`), which leaves the parser `G0`-modal. In laser mode that makes `M3 S…` sync at zero power (`gcode.c:869-873`, `:932-934`). Fire is a legitimate stationary use under the 2026-09-10 ruling. Owner check first: does Fire mark after a completed job, and before any job? The likely fix is a `G1`-modal set before the `M3`. Not changed here.
4. **G re-arms after F.** `laser_on` stays false after the overcut re-arm (`:826-828`), so a redundant mode line follows, and after this batch it forces the stop in Risks 2(b). The fix is one line (`laser_on = true;` after the F push), but it removes a line from output, so it belongs with 1.
5. **The TS mocks of engine output still show positive mode lines** (`gcodeGen.test.ts:548`, `:580`, "Mirrors the real engine output shape"). No assertion depends on it. Refresh them when that file is next edited.
6. **maskFill hands the next object an enabled spindle** (no `M5` at the end of the scanner, `mask_fill.rs:384-389`; golden 04 lines 9-33). This is safe only because `$32=1` suppresses `G0` output and START enforces `$32=1` (`canStartJob.ts:167-175`). Record it, so a future path that runs with `$32=0` (a material test, FRAME, a console-sent file) is checked against it.

## Decisions needed

**None to ship this batch.** The candidate question, whether constant-power (M3) layers should exist at all, is already answered. Lee, 2026-09-10: "Constant power remains selectable and is still correct where the beam must fire with the head stationary." This batch needs no product change. It removes a stationary arm that nobody selected, and it leaves the mode, the power and every burning move as the operator set them.

**One conditional question is pre-registered.** It is asked only if card steps 2-3 show a dot at M3 starts after this batch, which would mean the fork lights on `M3 S0`. It will then be put to Lee in the structured shape. The options it will carry:
- (a) run M3 layers as `M5` until the first `G1` and set the mode on that `G1` line (`M3 G1 X… S…`), which changes every M3 program's structure;
- (b) emit M3 layers under M4 mode lines, which reopens the 2026-09-10 ruling;
- (c) leave it and document it.

It is not asked now, because stock source says `S0` is dark and only the card can say otherwise.
