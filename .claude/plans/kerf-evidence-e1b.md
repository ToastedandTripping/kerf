# Kerf evidence E1b: an unknown mode is an error, the partition cannot drop an object, and goldens regenerate only on `=1`

This plan is lifted from `/home/leesalo/marvin/state/audits/gap-2026-09-24/kerf/PLAN-silent-drop-and-evidence.md` §E1b (critic `PLAN-silent-drop-and-evidence-critic.md`, CONCERN, folded). Its lineage is `.claude/plans/kerf-relay-plan.md` §A2 (Rust rows), with relay-critic must-fix 7 (header item 8) restored. Where this file and a relay-plan body differ, this file wins. On anything this file does not cover, the parent wins, except the parent claims listed under "Parent claims that no longer hold", which this file replaces. Every citation was re-read at `7140cab` (session branch `marvin/kerf-gap`, E1a, E2, E3, E5 and S1 merged) on 2026-09-25. HEAD then moved to `8c60666`, which changes only `.claude/handoff.md` (`git diff --stat 7140cab 8c60666`), so every code citation holds at `8c60666`.

- **Relay id:** `kerf-evidence-e1b`
- **Branch:** `relay/kerf-evidence-e1b`
- **Tier:** Standard. 5 files in one root (`src-tauri/`): three edited `.rs` files, one new golden fixture, one README row. No UI, no TS. (Unchanged by the critic fold.)

## Intent (grilled)

Grill skipped. The intent comes from the parent's Intent: CHARTER "Done looks like" (1), "no silent G-code error". The Summary for this batch:

> The Rust generator must never return a program that silently omits an object. An unknown layer mode becomes an error that names the mode and the object. The fill-before-line partition refuses an object it has no pass for, instead of dropping it with no trace. And the golden corpus is rewritten only when someone sets `KERF_UPDATE_GOLDEN=1`, never because the variable merely exists.

## Existing plans reviewed (standing instruction)

Checked 2026-09-25 with `ls -p`, so untracked files show:
- Session `.claude/plans/`: 34 files plus `archive/` (3 files). `git status --short --untracked-files=all .claude/plans` is empty. No `kerf-evidence-e1b*` existed before this file.
- Primary `/home/leesalo/Projects/kerf/.claude/plans/`: 31 files plus `archive/` (3). The only differences are the session's `kerf-evidence-e2-critic.md`, `-e3-critic.md` and `-e5-critic.md`.
- Audit directory: 9 files.

`grep -l` for `gcode_gen.rs`, `commands/gcode.rs`, `tests/golden`, `KERF_UPDATE_GOLDEN` and `serial.rs` over all of them. Hits that are shipped or archived (fence, remediation 0.1, refresh canvas-display, refresh cut-vs-screen, E1a, E3, E5) edit nothing E1b edits now. Open work that touches a neighbouring file:
- **Safety S1b and S4a** (`PLAN-safety-gate-class.md:68-69`, `:91-93`) edit `serial.rs` in the `serial_stream_job` region (`:747-818`, `:944`) and its inline tests. E1b's `serial.rs` edit is inside one test in `mod sim_integration` (`:3152-3235`), about 2,400 lines away, and touches no stop, fence or submit-lock code (DECISIONS 2026-09-24 pin). Textually disjoint.
- **Safety S4c** edits `gcodeGen.ts`/`gcodeGen.test.ts` and follows E1a, not E1b. E1b edits no TS.
- **S5** only cites `gcode_gen.rs:421-426` (the `fy` closure). E1b does not touch it.

## Diagnosis (verified by reading. The reproduce-first tests below execute it.)

**What E1a changed about the premise.** The parent's premise was that a sharp Fill+Line rectangle reached Rust as `fillLine` and hit the unknown-mode arm. It no longer can:
- `gcodeGen.ts:400-421` gives a sharp, point-less rectangle on `fillLine` a closed four-corner contour.
- `:444-446` lowers it to **`maskFill`**, not `fill` as the E1a plan first said. The fix ruling changed that, because the `fill` arm burns outside a rotated rectangle (E1a Ted fix report and Razor recheck, `~/marvin/state/relay/kerf-evidence-e1a-ted-fix-report-b1.md`).
- The overlay block (`:540-555`) emits `<id>_line_overlay` in mode `line`.
- `assertNoFillLine` (`:629-638`, called at `:623`) throws for any CutObject still in `fillLine` before `toCutObjects` returns.

So `fillLine` cannot reach Rust from the app.

**Who can still send an unknown mode, and to which arm.**
- The only production caller of the engine is `gcodeGen.ts:1182` (`invoke("generate_gcode")`). It reaches the Tauri command `commands/gcode.rs:32-178`, whose one engine call is `:174`.
- The modes TS sends are `buildCutLayer`'s copy of `layer.mode` (`gcodeGen.ts:85`), or `maskFill`.
- `layer.mode` is never validated on load:
  - `parseAndValidateProject` (`fileOps/index.ts:26`) checks only that `layers` is an array (`:40`).
  - `loadProjectWithMigrations` (`:174-248`) validates no mode.
  - The v3 sub-layer migration casts a stored string straight into `l.mode` (`:634`).
  - Grep of `src/lib/fileOps/` and `src/app/store/` found no other mode check.

  So a project file whose layer mode is any string outside `line | fill | offsetFill | fillLine` loads without complaint. It reaches Rust unchanged, because `assertNoFillLine` checks only `fillLine`. A newer-version file is refused at load (DECISIONS 2026-09-10), so the route is a same-version file edited by hand, corrupted, or written by a fork. A future TS path that forgets to lower is a second route.
- Such an object reaches one of two Rust places:
  1. **The engine's `other =>` arm** (`gcode_gen.rs:1271-1280`). It prints to stderr, pushes `; unknown layer mode '<m>' — object skipped` and continues, so the job succeeds without the object. This path is reachable from a loaded file today.
  2. **The partition's mixed branch** (`commands/gcode.rs:82-137`). It is worse, because there is no trace at all. `has_mixed` (`:84-85`) is true when a layer holds any fill-ish (`fill | maskFill | offsetFill`, `:82`) and any `line` object. Then only those two buckets are collected (`:88-97`), and an object in any third mode is in neither and is never pushed to `final_objects`. The engine never sees it, so not even the comment appears.

  From the app, a mixed layer only arises from `fillLine` lowering (`maskFill` + `line`), and every object on one layer shares that layer's mode, so no in-app route produces a mixed layer with a stray mode today. The check is structural: it guards a direct IPC caller and future lowering code. The homogeneous branch (`:138-171`) passes every object through, so there an unknown mode reaches arm 1.
- Every mode the engine has an arm for (`line`, `fill`, `offsetFill`, `maskFill`, `gcode_gen.rs:489`, `:882`, `:1035`, `:1152`) is in one of the two buckets. So an object in neither bucket is always one the engine would also reject.

**The golden gate.**
- `assert_golden` (`commands/gcode.rs:476-503`) writes instead of comparing when `std::env::var("KERF_UPDATE_GOLDEN").is_ok()` (`:478`). That is true for **any** set value: `=0`, empty, or `true`.
- `KERF_UPDATE_GOLDEN=0 cargo test` therefore rewrites all 15 existing goldens and passes. That is exactly the "regenerate-and-pass" failure the CI guard names (`.github/workflows/ci.yml:78-83`, which keeps CI safe by refusing any set value). The hazard is local runs.
- **A second reader has the same defect** (fix the class): `serial.rs:3216`, in `b2a_generate_native_status_fixture` (`:3158`), rewrites `src/lib/machine/__tests__/fixtures/nativeStatus.json` on `.is_ok()`. Its doc comment (`:3157`) and inline comment (`:3215`) say "set". The fixture's own `_comment` (`:3210`) already says `=1`.
- No other reader exists: `grep -rn KERF_UPDATE_GOLDEN src-tauri/src src .github scripts package.json`.

**The partition's tests test a copy.** The three A4b tests (`commands/gcode.rs:325-381`) call `sort_fill_before_line` (`:234-273`), a test-local mirror that "Mirrors the inlined logic in generate_gcode" (`:235`). The mirror already differs from production: it tracks position by bbox corner and always uses inner-first. A mutant in the real partition cannot turn them red.

**No existing test pins the old skip.** `grep -rn "unknown layer mode\|object skipped" src src-tauri/src` hits only the arm itself (`:1276`, `:1279`). The one other mention is prose in `docs/code-refresh-2026-08-05.md:73`.

**The goldens today.** `src-tauri/tests/golden/` holds 15 `.gcode` files (`01`-`15`, with `08a`/`08b`), `stop_result_fixture.json` and `README.md`. None covers a sharp rectangle lowered from Fill+Line. `04_fillline_mixed_layer` is a compound path. The README's Fixtures table lists every `.gcode` by name, and "Regenerating" gives `KERF_UPDATE_GOLDEN=1`.

## Parent claims that no longer hold (this file replaces them)

1. **"Files (2)".** Now five: `serial.rs` is the sibling env reader, the README table needs the new row, and the new fixture is a file.
2. **"`tests/golden/README.md` needs no edit".** It needs one Fixtures row, and one sentence saying that only the exact value `1` regenerates.
3. **Control E1b-C1** ("the same sharp rectangle through the `fill` arm with `paths = []` and with 4 corners emits identical G-code"). This was premised on E1a lowering to `fill`. E1a lowers to `maskFill`, so the `fill` arm is off-route, and the old C1 would pin an arm the Fill+Line rectangle no longer uses. C1 is re-specified below as a containment test on the route E1a actually ships. The parent's Risks line "E1b-C1 pins that the 4-corner contour and the empty-path AABB produce the same raster" lapses with it.
4. **The parent's clippy line** lacks `--features sim`. CI runs `cargo clippy --all-targets --features sim -- -D warnings` (`ci.yml:90`) and fails on it. CI also runs `cargo fmt --check` (`ci.yml:94`), but advisory only (`continue-on-error: true`, `:96`). This plan requires both, so on fmt it is stricter than CI.
5. **The Assignment's done condition** says "`git diff --stat -- src-tauri/tests/golden` showing only the new fixture". With claim 2 that diff also shows `README.md`. The intent (no existing fixture rewritten) is checked instead as: `git diff --stat <merge-base> -- 'src-tauri/tests/golden/*.gcode' 'src-tauri/tests/golden/*.json'` shows exactly one added file, `16_fillline_sharp_rect.gcode`.
6. **E1a's Parking Lot line** "Two more Rust comment-and-skip sites" (`ROADMAP.md:555`, `:700`) undercounts. Its line numbers are also slightly off (`:897-906` is `:893-909`). There are five. E1b takes the one that is a classifier miss (`object_to_path`'s unknown `obj_type`, change 1b) and parks the other four. See Stage 3.5.

## Change

### 1. `src-tauri/src/engine/gcode_gen.rs`: the `other =>` arm (`:1271-1280`), one guard at the top of the object loop (`:452`), the `generate_gcode` doc comment (`:409-413`), the doc comment of `p5_unknown_obj_type_produces_empty_path` (`:2614-2615`), and two tests in `mod tests` (`:1491`)

- Replace the arm body (the stderr line, the comment push, and the prose that calls them "not silent") with exactly:
  ```rust
  other => {
      let unknown_mode_err =
          format!("unknown layer mode '{}' on object '{}'", other, obj.id);
      return Err(unknown_mode_err);
  }
  ```
  `cargo fmt` decides the line breaks. The battery anchor `return Err(unknown_mode_err);` is a whole line under any formatting. The whole job fails: no partial program is returned.
- The doc comment (`:409-413`): "Returns `Err` if a resource limit is exceeded, if an object with no paths has a type this engine cannot draw, or if an object's layer mode has no arm here (the error names the mode and the object; a silently partial program is never returned). Degenerate geometry is still skipped per object with a `;` comment; which of those should refuse the job is parked with astra 2.6."
- **1b. An unknown object type with nothing to cut is an error too** (critic must-fix 1).
  - `object_to_path` (`:1344-1425`) knows `rectangle`, `ellipse` and `line`. For anything else it prints to stderr (`:1413-1422`) and returns an empty path.
  - Two engine arms call it when `obj.paths` is empty: `line` (`:496-497`, then the path is skipped at `:515-516`) and `offsetFill` (`:1049-1050`, skipped at `:1066-1067`). Both drop the object with no G-code trace.
  - `obj.type` is as unvalidated on load as `layer.mode`. The TS `ObjectType` union is `rectangle | ellipse | line | path | text | group | image` (`types.ts:47`). `toCutObjects` skips `text` and `image` and flattens groups, so the app sends only the first four.
  - As the first statement of `for obj in objects {` (`:452`), add:
    ```rust
    if obj.paths.is_empty()
        && !matches!(obj.obj_type.as_str(), "rectangle" | "ellipse" | "line" | "path")
    {
        let unknown_type_err = format!(
            "unknown object type '{}' on object '{}' (no paths to cut)",
            obj.obj_type, obj.id
        );
        return Err(unknown_type_err);
    }
    ```
    The battery anchor `return Err(unknown_type_err);` is a whole line under any formatting.
  - **`path` is deliberately in the known set.** A point-less `path` is a known type with degenerate geometry (E1a's M7 fixture is one), not a classifier miss. It keeps today's skip and stays parked with the degenerate-geometry sites. `object_to_path`'s stderr line calls it "unknown obj_type", which is misleading but untouched.
  - **`object_to_path` itself is not changed.** Its signature is shared with `optimizer.rs:304`, `:328`, where an empty path only affects ordering. The existing `p5_unknown_obj_type_produces_empty_path` (`:2616-2636`) keeps its assertion. Only its doc comment changes: the line "the object is silently skipped in the line arm" becomes "generate_gcode refuses such an object before any arm (E1b T11)".
- Nothing else in this file changes. In particular, not the `fill` arm's non-rectangular skip (`:893-909`) and not the three `maskFill` comments (`:1198-1203`, `:1206-1216`, `:1258-1265`). See Out of scope.

### 2. `src-tauri/src/commands/gcode.rs`

1. **Extract the ordering into a real function.** Move the body of `:49-171`, from the F7 comment through the end of the layer loop, into a module-level
   ```rust
   fn order_objects(objects: &[CutObject], start_x: f64, start_y: f64) -> Result<Vec<CutObject>, String>
   ```
   - Move the text verbatim: the F7 comment, `layer_order` with `layer_order.push(li);` (`:59`), the A4b comment, `is_fill_ish`, `has_mixed`, both branches, and the `object_end_point` tracking. It returns `Ok(final_objects)`.
   - Its doc comment states the three guarantees:
     - Layer groups follow arrival order.
     - Within a mixed layer, every fill-ish object precedes every line object.
     - Every input object appears exactly once, and a mixed layer holding an object in neither pass is an `Err`.
   - The command becomes `let final_objects = order_objects(&objects, start_x, start_y)?;` followed by the unchanged line `gcode_gen::generate_gcode(&final_objects, workspace_height, s_value_max, origin_top)` (`:174`). Keep that text exactly: it is a battery anchor.
   - The 15 existing goldens are the equivalence proof. They must stay byte-identical.
2. **The partition refuses a stray instead of dropping it.** As the first statement inside `if has_mixed {`:
   ```rust
   if let Some(stray) = layer_objs
       .iter()
       .find(|o| !is_fill_ish(&o.layer.mode) && o.layer.mode != "line")
   {
       return Err(format!(
           "layer {}: object '{}' has mode '{}', which is neither a fill pass nor a line pass; it would be dropped from the job",
           li, stray.id, stray.layer.mode
       ));
   }
   ```
   Buckets are disjoint, so "in a bucket" is "in exactly one bucket". No count check is added. The conservation test below proves no bucket filter drops an object.
3. **The golden gate goes through one pure function.** At module level, outside both test modules:
   ```rust
   /// True only for the exact value "1". `=0`, empty, or `true` compare instead of rewriting.
   /// Pure so it can be tested without touching the process environment.
   #[cfg(test)]
   pub(crate) fn golden_update_requested(v: Option<&str>) -> bool {
       v == Some("1")
   }

   /// The one place in the crate that reads KERF_UPDATE_GOLDEN (pinned by T12).
   #[cfg(test)]
   pub(crate) fn golden_update_env() -> bool {
       golden_update_requested(std::env::var("KERF_UPDATE_GOLDEN").ok().as_deref())
   }
   ```
   `assert_golden` (`:478`) becomes `if golden_update_env() {`. The reader stays a single line, about 80 columns at 4 spaces of indent, so `cargo fmt` keeps the variable name and `golden_update_requested(` on one line. T12 relies on that. **No test sets, unsets or reads the process environment.** Cargo runs tests on parallel threads, and a test that mutates the environment races every golden test.
4. **Delete the test-local mirror** `sort_fill_before_line` (`:234-273`) and `use crate::engine::optimizer;` (`:232`), which becomes unused and would fail clippy `-D warnings`. Repoint the three A4b tests (`:325-381`) to `super::order_objects(&objs, 0.0, 0.0).expect("ordering")`, with their assertions unchanged.
5. **New fixture builder and tests** (listed in Tests).

### 3. `src-tauri/src/commands/serial.rs`: inside `b2a_generate_native_status_fixture` only (`:3152-3235`)

- `:3216` becomes `if crate::commands::gcode::golden_update_env() {`. After this, `serial.rs` names the variable only in comments and in the fixture's `_comment` string.
- The two comments (`:3157`, `:3215`) say "is `1`" instead of "is set".
- Nothing else in `serial.rs` changes.

### 4. New `src-tauri/tests/golden/16_fillline_sharp_rect.gcode`

- This is the snapshot of the fixture below. Generate it **only** with `KERF_UPDATE_GOLDEN=1 ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim golden_16_fillline_sharp_rect`, whose name filter matches no other test, so no other golden can be rewritten.
- Then run the same command with the variable unset, and confirm it compares green.
- `git status --short src-tauri/tests/golden` must show only this file as untracked.
- Never hand-edit it.

### 5. `src-tauri/tests/golden/README.md`

- One Fixtures row: `16_fillline_sharp_rect.gcode` | "Sharp rectangle on a Fill+Line layer as the TS generator lowers it (E1a): a maskFill object carrying a closed 4-corner contour plus its `_line_overlay` line object on one `layer_index`".
- In "Regenerating", one sentence: "Only the exact value `1` regenerates; `KERF_UPDATE_GOLDEN=0`, an empty value or `true` compare as normal."

**The fixture** (in `golden_tests`, shared by golden 16 and the two tests after it) is `fn fillline_sharp_rect_pair(rotation: f64) -> Vec<CutObject>`. It mirrors what `toCutObjects` emits for a 30 × 10 sharp rectangle at (10, 20) on a `fillLine` layer (`gcodeGen.ts:517-555`):
- `r1`: `obj_type "rectangle"`, x 10, y 20, w 30, h 10, `paths = vec![rect_path(10.0, 20.0, 30.0, 10.0)]`, `rotation`, `layer_index Some(0)`, `corner_radius None`. Layer `base_layer("maskFill")`, which has interval 1.0 and scan angle 0.
- `r1_line_overlay`: the same geometry, with layer `base_layer("line")`.
- In that order, matching the TS push order.
- Workspace height 60, origin bottom, start corner default.

## Tests

**Reproduce first.** Before any production edit, add T9, T10 and T11 (below) and run them. Quote all three outputs in the report.
- T10 must fail because `generate_gcode` returned `Ok` and its program contains `; unknown layer mode 'bogus' — object skipped`.
- T9 must fail because the command returned `Ok`, and the program contains neither `'b'`'s id nor `unknown layer mode`: the object vanished without trace. `f` carries `rect_path(0.0, 0.0, 20.0, 20.0)`, so the baseline program holds a real `; Mask Fill: f` section and no `; maskFill skipped` noise. An `f` with no paths would make `fill_compound_mask` return "object has no paths" (`mask_fill.rs:906-907`), and that comment is not the repro. `b`'s absence is the only anomaly.
- T11 must fail because `generate_gcode` returned `Ok` with no `; Cut: tri` line and no G-code trace of `tri`.
- The env gate is shown by reading `:478` only.
- If T9, T10 or T11 does not reproduce, stop and report NEEDS_CONTEXT.

**Also before any production edit**, add T5 and T6 (they use only the new fixture) and run them green. If T5 is red at baseline, the preview moves and the emitted program already disagree. That is a real finding: stop, report NEEDS_CONTEXT with the first mismatching index, and do not loosen the test. If T6 is red at baseline, first check the test's inverse transform against `engine/coords.rs:17-41` (rotate about the centre by +rotation, then `y → H - y`). E1a's Razor recheck measured 0.000 mm outside at 0°, 30° and 90° on this route. Never widen T6's tolerance past 0.005 mm.

| Test | Where | Asserts |
|---|---|---|
| T1 | `commands::gcode::tests`, the 3 A4b tests repointed | Unchanged assertions, now on `order_objects` |
| T2 `partition_keeps_every_object_exactly_once` | `commands::gcode::tests` | Input: one mixed layer (`maskFill a`, `line l`, `maskFill b`, `fill c`, `offsetFill d`, all `layer_index 0`) plus `line e` on `layer_index 1`. `order_objects` gives `Ok`. The multiset of output ids equals the input's, and on layer 0 every fill-ish id precedes `l` |
| T3 `mixed_layer_stray_mode_is_err` | `commands::gcode::tests` | `maskFill f` (with `rect_path(0.0, 0.0, 20.0, 20.0)`), `line l`, `bogus b` on one layer gives an `Err` containing `'b'`, `'bogus'` and `neither` |
| T4 `golden_16_fillline_sharp_rect` | `golden_tests` (tokio) | `fillline_sharp_rect_pair(0.0)` through the command matches `16_fillline_sharp_rect.gcode`. The inline check: `; Mask Fill: r1` precedes `; Cut: r1_line_overlay` |
| T5 `fillline_sharp_rect_moves_match_program` | `golden_tests` (tokio) | For `fillline_sharp_rect_pair(0.0)` through the command, the parser reads every `G0`/`G1` line strictly between `; KERF:PREAMBLE_END` and `; KERF:FOOTER_BEGIN`, strips any `;` comment, and carries modal X and Y (maskFill omits an unchanged Y, `mask_fill.rs:301-307`). It pushes (x, y) per line. `result.moves.len()` equals the parsed count, and every pair agrees within `1e-3` |
| T6 `fillline_sharp_rect_burns_inside_rect` | `golden_tests` (tokio) | For rotation 0 and 30 (scan angle 0), take every laser-on `G1` segment (S > 0, S modal), map both endpoints back with y' = 60 − y, then rotate by −rotation about (25, 25). Both endpoints lie within x ∈ [10, 40] and y ∈ [20, 30] ± 0.005 mm. The maskFill section and the `; Cut: r1_line_overlay` section each have at least one laser-on segment, and the burned extents reach within 1.0 mm (one interval) of all four edges |
| T7 `golden_update_requested_only_for_exact_1` | `golden_tests` (plain `#[test]`) | `None`, `Some("0")`, `Some("")` and `Some("true")` give false. `Some("1")` gives true. No environment access |
| T8 `unknown_mode_is_err_at_command_boundary` | `golden_tests` (tokio) | A `line` rectangle on `layer_index 0` plus a `bogus` rectangle `rb` on `layer_index 1` (homogeneous, so it reaches the engine) gives an `Err` from the command containing `'bogus'` and `'rb'` |
| T9 `mixed_layer_stray_mode_is_err_at_command_boundary` | `golden_tests` (tokio) | T3's three objects through the command give an `Err` containing `'b'` and `neither` |
| T10 `unknown_mode_is_err_naming_mode_and_object` | `engine::gcode_gen::tests` | `[make_rect_obj("ok", …, make_layer_line()), <"r_bogus" with mode "bogus">]` through `generate_gcode` gives an `Err` equal to `unknown layer mode 'bogus' on object 'r_bogus'`. No partial `Ok` |
| T11 `unknown_obj_type_is_err_naming_type_and_object` | `engine::gcode_gen::tests` | `make_rect_obj("tri", …)` with `obj_type = "triangle"` and `paths` empty gives an `Err` equal to `unknown object type 'triangle' on object 'tri' (no paths to cut)`. The case runs twice: once on `make_layer_line()` and once with the layer mode set to `offsetFill` (both arms that call `object_to_path`). A third case, a `path` object with empty `paths` on a line layer, still gives `Ok`: degenerate geometry keeps today's skip |
| T12 `golden_env_has_exactly_one_reader` | `golden_tests` (plain `#[test]`) | Walk `concat!(env!("CARGO_MANIFEST_DIR"), "/src")` recursively with `std::fs` (no new crate), reading every `.rs` file and skipping lines whose trimmed text starts with `//`. Across the crate, the needle `"KERF_UPDATE_GOLDEN")` (the variable as a call argument) occurs on exactly **one** line, that line contains `golden_update_requested(`, and it is in `commands/gcode.rs`. Build the needle as `concat!("\"KERF_UPDATE", "_GOLDEN\")")` so the test cannot match itself. "Exactly one", not "at most one", so a scan that finds nothing is red: the check can fire. Limit: a reader through `option_env!` or `env::vars()` would evade it |

**Mutation battery spec `kerf-evidence-e1b`.**
- `test_command`: `["/home/leesalo/.cargo/bin/cargo","test","--manifest-path","src-tauri/Cargo.toml","--features","sim","--","commands::gcode","engine::gcode_gen"]`. Cargo is not on PATH in every shell, hence the absolute path. Ted confirms from the baseline output that both modules ran, and states the count.
- Run it as `env -u KERF_UPDATE_GOLDEN node ~/marvin/scripts/mutation-battery.mjs <spec>`. The battery passes its environment through, stripping only `GIT_*` (`mutation-battery.mjs:790-796`).
- Commit the golden file and all code before the run.

**Timing** (measured, not guessed):
- The battery copy does not carry `src-tauri/target`, so the baseline is a cold build. That took 218 s idle (`kerf-b1-admission-fence`). The E5 battery's first baseline timed out under a 660 s per-mutant bound with another battery live, about 14 minutes (`~/marvin/state/relay/kerf-evidence-e5-ted-report-b1.md` concern 1; journal `relay-kerf-evidence-e5-23115fee`, baseline `timed_out: true`).
- The baseline shares the per-mutant bound (`mutation-battery.mjs:1675`).
- The E5 journal also gives incremental rebuild plus test per id in the same crate: 14 ids in 1,474 s (20:46:20 to 21:10:54) and 1,321 s (21:24:42 to 21:46:43), so 94-105 s per id.
- Ten ids here make about 20-42 minutes. That covers 10 × 94-105 s plus a cold baseline anywhere from 218 s to E5's contended 1,463 s (its second baseline). Set `per_mutant_timeout_ms: 1500000` and `total_timeout_ms: 5400000`, which are both what E5's spec ended on (`kerf-evidence-e5-ted-report-b1.md:6`). The margin covers two Rust batteries overlapping.
- **Do not run cargo by hand to time or "check" the battery. Read the journal.** A timeout is `errored`, not a survivor (`:1882`). Re-run with the same spec. Never drop an id.

**Rules:**
- Each id is one contiguous find/replace whose `find` occurs exactly once in its file (`MUTANT_ANCHOR_AMBIGUOUS`, `mutation-battery.mjs:1772-1779`, raised for zero hits as well as several). No mutant is stacked. Controls are killed mutants like any other.
- **Uniqueness, as checked by `grep -cF` at `7140cab`:**
  - `width_mm: obj.width,` gives 1 in `gcode_gen.rs` (`:1222`, the maskFill arm).
  - In `commands/gcode.rs`: `layer_order.push(li);` gives 1 (`:59`), and `gcode_gen::generate_gcode(&final_objects, workspace_height, s_value_max, origin_top)` gives 1 (`:174`).
  - `.filter(|o| is_fill_ish(&o.layer.mode))` gives **2** today (`:91` production, `:247` the mirror). It becomes 1 when change 2.4 deletes the mirror.
  - `unknown_mode_err`, `unknown_type_err`, `v == Some("1")` and `!is_fill_ish(&o.layer.mode) && o.layer.mode != "line"` give 0 today, because they are new code that this plan introduces once each. `unknown_type_err` was re-grepped for the fold: 0 in `gcode_gen.rs`.
  - `crate::commands::gcode::golden_update_env()` gives 0 in `serial.rs` today. It is new, introduced once, at `:3216`.
  - For T12's needle, `"KERF_UPDATE_GOLDEN")` occurs on 2 lines across `src-tauri/src` today (`gcode.rs:478`, `serial.rs:3216`), and on exactly 1 after the change (inside `golden_update_env`).
  - **Ted's report quotes `grep -cF` = 1 for all ten anchors on the committed relay HEAD.** If one is not 1, the code has drifted from this plan: fix the code back, never rewrite a `find` without the orchestrator's sign-off recorded in the report.
- Every wrong variant below type-checks. No kill comes from a compile error.

| Id | File | `find` | `replace` | Killed by |
|---|---|---|---|---|
| E1b-M1 | `src-tauri/src/engine/gcode_gen.rs` | `return Err(unknown_mode_err);` | `lines.push(format!("; {} — object skipped", unknown_mode_err));` | T10, T8 |
| E1b-M2a | `src-tauri/src/commands/gcode.rs` | `v == Some("1")` | `v.is_some()` | T7 (`Some("0")`, `Some("")`, `Some("true")`) |
| E1b-M2b | `src-tauri/src/commands/gcode.rs` | `v == Some("1")` | `false` | T7 (`Some("1")`: the gate must still allow a deliberate regeneration) |
| E1b-M3 | `src-tauri/src/commands/gcode.rs` | `gcode_gen::generate_gcode(&final_objects, workspace_height, s_value_max, origin_top)` | the same text followed by `.map(\|mut r\| { for m in r.moves.iter_mut() { m.x = 0.0; } r })` (moves X zeroed at the command's return boundary, G-code unchanged) | T5 |
| E1b-M4 | `src-tauri/src/commands/gcode.rs` | `.filter(\|o\| is_fill_ish(&o.layer.mode))` | `.filter(\|o\| is_fill_ish(&o.layer.mode) && o.layer.mode != "fill")` (the partition drops the `fill` object) | T2, and T1's `len() == 4` |
| E1b-M5 | `src-tauri/src/commands/gcode.rs` | `!is_fill_ish(&o.layer.mode) && o.layer.mode != "line"` | `false` (the stray check never fires) | T3, T9 |
| E1b-M6 | `src-tauri/src/engine/gcode_gen.rs` | `return Err(unknown_type_err);` | `eprintln!("{}", unknown_type_err);` (falls through to the arm, which silently skips the empty path again) | T11 (line and offsetFill cases) |
| E1b-M7 | `src-tauri/src/commands/serial.rs` | `crate::commands::gcode::golden_update_env()` | `std::env::var("KERF_UPDATE_GOLDEN").is_ok()` (a second reader bypassing the predicate) | T12 (two needle lines) |
| E1b-C1 | `src-tauri/src/engine/gcode_gen.rs` | `width_mm: obj.width,` | `width_mm: obj.width * 2.0,` (the maskFill rotation centre moves +15 mm, displacing the 30° burn by about 7.8 mm) | T6 at 30° (control: green on the real code) |
| E1b-C2 | `src-tauri/src/commands/gcode.rs` | `layer_order.push(li);` | `layer_order.insert(0, li);` (layer arrival order reversed) | `golden_07_multilayer_priority_order` (inline check and snapshot). This is the control that the extraction preserved behaviour: goldens 01-15 green and byte-identical |

In the table, `\|` is a literal `|` in the spec JSON.

## Verification

All commands run from the relay worktree with the variable unset.
- `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim commands::gcode`
- `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim engine::gcode_gen`
- `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim`: the baseline count measured at relay start, plus the new tests. Nothing weakened, nothing ignored.
- `~/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features sim -- -D warnings`, which is CI's form (`ci.yml:90`), and CI fails on it.
- `~/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml --check`. This is **stricter than CI**: CI runs it (`ci.yml:94`) with `continue-on-error: true` (`:96`), so CI would not fail on it. It is required here because the anchor shapes in this plan (single-line `return Err(...)` lines, and T12's one-line reader) are stated for formatted code.
- `git diff --stat $(git merge-base HEAD marvin/kerf-gap) -- 'src-tauri/tests/golden/*.gcode' 'src-tauri/tests/golden/*.json'` shows exactly one added file, `16_fillline_sharp_rect.gcode`.
- `git status --short src/lib/machine/__tests__/fixtures/nativeStatus.json` is empty after the full suite.
- `npx vitest run src/lib/machine/__tests__/gcodeGen.test.ts src/components/panels/__tests__/gcodeFailureLoud.test.tsx` is green. No TS changed, but the second test is the TS catch that now receives both new errors (`MachinePanel.tsx:184-187`).
- **Battery journal:** all ten ids `killed`; `survived`, `errored` and `CONTROL_RED` all 0. The report quotes each id's `find`/`replace` verbatim.
- **Razor:**
  - Reads both call sites (`assert_golden`, and `serial.rs` b2a) and confirms each calls `golden_update_env()`, the only reader. T12 makes this permanent.
  - Confirms that no test calls `std::env::set_var`, `remove_var` or `var`. `grep -n 'env::' ` on the added lines shows only `golden_update_env`'s one read.
  - Reads `16_fillline_sharp_rect.gcode` and confirms the maskFill rows run X 10.000 to 40.000 at GRBL Y 30 to 40 (60 − 30 to 60 − 20), and that the `; Cut:` section visits the four corners.
- **Browser:** not applicable. The Vite dev server has no Tauri backend, so `invoke("generate_gcode")` cannot run there (E1a's plan says the same). The TS catch is covered by `gcodeFailureLoud.test.tsx`.
- **Owner check (release build, not hardware):** in the Tauri app, set a layer to Fill+Line, draw a rectangle, and press Generate. The console shows `G-code generated: …`, not a failure. This confirms that the new partition check and error arm leave the normal path alone in the real IPC build. It goes in ROADMAP `next` (Stage 3.5). Lee is not asked to hand-edit a project file to see the error path: T8 and T9 cover it at the IPC function itself.

## Stage 3.5 obligations (orchestrator)

**ROADMAP `## Parking Lot`:** a `### Deferred from kerf-evidence-e1b (2026-09-25)` section, and index lines in the existing `- **Title** — detail.` shape:
- **Rust comment-and-skip sites: five, not two** (replaces the scope of the E1a line at `:555`/`:700`, which stays verbatim):
  - the `fill` arm's non-rectangular-paths skip (`gcode_gen.rs:893-909`);
  - maskFill degenerate mask (`:1198-1203`);
  - maskFill all-background mask (`:1206-1216`);
  - maskFill scan error (`:1259-1265`);
  - `object_to_path`'s stderr-only fallback (`:1413-1422`). **E1b takes its unknown-type half** (change 1b). What stays parked is a **point-less `path`**, which becomes an empty path skipped with no G-code trace by the line arm (`:515-516`) and the offsetFill arm (`:1066-1067`).

  Why E1b does not take the four that remain:
  - E1a assigned these sites to astra 2.6 bounded generation.
  - The three maskFill sites and the point-less `path` handle an object that exists but yields nothing burnable or failed rasterisation, and `generate_gcode`'s contract skips degenerate geometry per object by design. Making an invisible sliver fail the whole job is a behaviour call, which is 2.6's to make.
  - The `fill`-arm skip is the closest to E1b's class (a real shape left uncut). It is reachable from a `fill`-layer rectangle carrying a non-4-point or open path. The arm's own comment says the fix is TS routing to maskFill, as E1a did for `fillLine`. A Rust error alone would refuse the job with no route to a cut.
- **`Layer.mode` is not validated when a project loads** (`fileOps/index.ts:40`, `:634`). After E1b an unknown mode fails at Generate with a named error. Validating at load would tell the operator earlier. A TS lead, not scheduled.
- **The scan-angle fill spill (Razor W1 on E1a)** stays parked as written (`ROADMAP.md:554`, `:699`). E1b fixes nothing there, and no E1b test asserts anything at a non-zero scan angle. T6 runs at scan angle 0. `f10_fill_scan_angle_covers_full_area` is untouched.

**ROADMAP `next`:** the owner check above.

**ARCHITECTURE.md delta:**
- `gcode_gen.rs` entry (`:193-203`): "an unknown mode, or an unknown object type with no paths, is an `Err` naming it and the object."
- `gcode.rs` entry (`:162-163`): "`order_objects`: layer arrival order and the fill-before-line partition; a mixed layer with an object in neither pass is an `Err`, never a drop."
- `optimizer.rs` entry (`:219`): drop "fill-before-line partition". It never lived there (`grep -n partition src-tauri/src/engine/optimizer.rs` is empty).
- `golden/*.gcode` entry (`:226-228`): "Regenerate with `KERF_UPDATE_GOLDEN=1` (only the exact value `1`; one reader, `golden_update_env`, pinned by a source-scan test; CI guards it unset)."

## Risks and rollback

- **A project that generated "successfully" can now fail.** A project whose layer mode string is not one the engine knows used to produce a job with that layer's objects missing. It now fails Generate with `unknown layer mode '<m>' on object '<id>'` in the console (`MachinePanel.tsx:184-187`). This is intended (charter: "no silent G-code error"). The message names the internal object id, because `CutObject` carries no display name.
- **An unknown object type is refused on every layer mode, not only where it was dropped.** The guard sits before the mode match. So an unknown type with no paths on a `fill` layer, which today is rasterised as its bounding box (a guess at an unknown shape), now fails Generate too, with `unknown object type '<t>' on object '<id>' (no paths to cut)`. The app sends only `rectangle`, `ellipse`, `line` and `path` (`types.ts:47`, `toCutObjects`), so only a hand-edited, corrupted or forked file reaches it. This is intended: a burn of the wrong shape is no better than a missing one.
- **The extraction could change ordering.** It is moved verbatim, and goldens 01-15 (byte-identical) and control C2 pin it. The only new behaviour is the stray `Err`, which no in-app layer can trigger today (see Diagnosis).
- **`=0` stops regenerating.** Anyone who relied on `KERF_UPDATE_GOLDEN=0` (or any value) to regenerate now gets comparisons. The README and the harness's own messages already say `=1`.
- **The new golden encodes current maskFill output.** It is a snapshot, not an oracle (README). T6 is the independent check that it burns inside the rectangle.
- **Rollback:** revert the relay merge commit on the session branch. Nothing depends on E1b: S4c follows E1a, not E1b.
- **Irreversible steps:** none. No tag, installer, settings write or serial port.

## Decisions this plan waits on

None. No finding turned on direction, scope, money, a client matter or look-and-feel.

## Critic fold (2026-09-25)

Critic `kerf-evidence-e1b-critic.md` (Fable): PASS, with 5 advisory must-fixes and nothing gating. It checked 27 citations against `8c60666`: 25 exact, 2 imprecise, none wrong. Every must-fix was re-checked against the tree before folding.

1. **`object_to_path`'s unknown `obj_type` is taken, not parked** (must-fix 1).
   - Verified:
     - `object_to_path` (`gcode_gen.rs:1344`) is called by the `line` arm (`:497`) and the `offsetFill` arm (`:1050`), and by `optimizer.rs:304`, `:328`.
     - The existing test `p5_unknown_obj_type_produces_empty_path` (`:2614-2636`) pins the helper's empty path and calls the line-arm skip "silent".
     - The TS `ObjectType` union is at `types.ts:47`.
   - What changed:
     - A guard at the top of the object loop (`:452`) refuses a path-less object whose type is not `rectangle | ellipse | line | path` (change 1b).
     - T11 tests the line and offsetFill arms, plus the `path` case that stays `Ok`.
     - E1b-M6 is on the anchor `return Err(unknown_type_err);`, re-grepped at 0 today.
   - One refinement over the critic's wording: a point-less `path` is a *known* type with degenerate geometry. It reaches the same stderr line, but it is not a classifier miss, so it stays parked with the degenerate sites.
   - The guard sits in the loop, not in `object_to_path`, so the helper's signature and its optimizer callers stay unchanged. The file count stays at 5.
   - Also recorded in Risks: an unknown type on a `fill` layer, which today burns its bounding box, is now refused too.
2. **`total_timeout_ms` is 5400000** (must-fix 2). Verified: `kerf-evidence-e5-ted-report-b1.md:6` says "total 3600000 -> 5400000". The timing line now covers ten ids and E5's contended 1,463 s baseline.
3. **T9's `f` carries a `rect_path`** (must-fix 3). Verified: `fill_compound_mask` returns `"maskFill: object has no paths"` for empty paths (`mask_fill.rs:906-907`), and the arm comments it (`:1198-1203`). T3's `f` gets the same path, so the two tests share one fixture shape.
4. **The source-scan class guard is added as T12, with no new file** (must-fix 4). It fits as one test in `golden_tests`, reading files with `std::fs`.
   - Doing it cleanly needed one design change. A one-line `golden_update_requested(std::env::var("KERF_UPDATE_GOLDEN").ok().as_deref())` at `serial.rs`'s 8-space indent exceeds 100 columns, so `cargo fmt` would split the variable name and the predicate onto different lines, and a line scan would go red on correct code.
   - So both call sites now call a single `golden_update_env()` in `commands/gcode.rs`. It is the crate's only reader, and it fits on one line. T12 asserts exactly one needle line crate-wide. `"KERF_UPDATE_GOLDEN")` is on 2 lines today (grep) and on 1 after the change.
   - E1b-M7 (a second reader in `serial.rs`) proves the scan can fire. The anchor `crate::commands::gcode::golden_update_env()` is 0 today, and new.
   - The scan's limit (`option_env!`, `env::vars()`) is stated in T12.
5. **Citations** (must-fix 5):
   - `cargo fmt --check` is advisory in CI (`ci.yml:96`, `continue-on-error: true`, verified). The plan now says it is stricter than CI, in parent-claim 4 and in Verification.
   - `assertNoFillLine` is at `:629-638`.
   - The fill-arm skip is at `:893-909`, in all three places.
   - The maskFill scan-error site is at `:1259-1265`.
   - The doc comment is at `:409-413`.

Rejected: none. The battery is now 10 ids (8 mutants, 2 controls).
