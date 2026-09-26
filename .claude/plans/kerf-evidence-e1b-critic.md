# Critic — Kerf evidence E1b (`kerf-evidence-e1b.md`)

**Date:** 2026-09-25. **Critic:** Fable, separate subagent (the author cannot self-certify; an earlier attempt was cut off by a rate limit and this one started fresh). **Rubric:** `~/marvin/rules/plan-critic-rubric.md` v2, read in full. **Tree read:** worktree `kerf-gap` at `8c60666` (`git diff --stat 7140cab 8c60666` is `.claude/handoff.md` only, so the plan's `7140cab` citations are checked against the same code). Read-only: no build, test, install or git state change. **Also read:** parent `PLAN-silent-drop-and-evidence.md` (§E1b, Verification, Risks, Assignment, Critic fold) and its critic (must-fixes 2, 4, 8 and the V9a finding); `.claude/DECISIONS.md` in full (26 entries); `CHARTER.md`; sibling `kerf-evidence-e1a.md` critic (both rounds); `~/marvin/scripts/mutation-battery.mjs` (`:790-796`, `:1543-1590`, `:1670-1680`, `:1765-1785`, `:1875-1890`); the E5 battery journal `relay-kerf-evidence-e5-23115fee/journal.jsonl` and `kerf-evidence-e5-ted-report-b1.md`; the E1a Razor review's geometry tables.

## Applicability block

**Project type:** desktop laser-cutter controller; this batch is the Rust half of the G-code generator (`src-tauri/src/engine/gcode_gen.rs`, `src-tauri/src/commands/gcode.rs`), one env-gated fixture writer in `serial.rs`, one new golden and its README row. Standard tier, 5 files, one root, one batch. Public repository.

| Dim | Fires? | Tag | Why |
|---|---|---|---|
| X1 Physical & human safety | **Yes** | **GATING** | The batch decides whether a program with a missing object reaches the machine at all, and changes the gate that protects the golden corpus (the only mechanical proof that generator geometry did not move). A silent omission is a missing burn; a broken golden gate is how a wrong burn ships unseen. |
| X2 Privacy & data stewardship | No | — | No personal, health, child or client data. |
| X3 Evidence & source integrity | No | — | Code and tests, not research or a public claim. "Quote the repro output" is core-9. |
| X4 Audience, brand & money | No | — | Nothing client-facing. |
| X5 Concurrency & re-entrancy | Yes | ADVISORY | Cargo runs tests on parallel threads; the golden gate reads the process environment. The parent's critic (V9a) named the race this plan must not reintroduce. |
| X6 Operability & observability | Yes | ADVISORY | The new `Err` strings are the only field evidence of a mode the engine lacks. |
| X7 Self-modification safety | No | — | No MARVIN gate, hook, skill or automation changes; the battery is used as it stands. |
| X8 Dependencies, performance & cost | Yes | ADVISORY | No package; but a Rust battery run costs a cold build plus eight incremental builds (about 30 minutes), and a wrong timeout turns it into `errored` reruns. |

## Citations verified against the tree

| # | Plan claim | Tree | Verdict |
|---|---|---|---|
| 1 | `other =>` arm `gcode_gen.rs:1271-1280`: stderr, `; unknown layer mode '<m>' — object skipped`, continue | `:1271-1280`; `eprintln!` `:1275-1278`; push `:1279` | ✓ |
| 2 | `generate_gcode` doc comment `:409-414` | `:409-413` ("Geometry errors … skipped with a warning comment, but the job continues") | ✓ |
| 3 | Engine arms `line :489`, `fill :882`, `offsetFill :1035`, `maskFill :1152` | exact | ✓ — and `is_fill_ish` (`gcode.rs:82`) plus `"line"` covers all four, so "an object in neither bucket is one the engine would also reject" holds. |
| 4 | Partition `gcode.rs:82-137`; `has_mixed :84-85`; buckets `:88-97`; homogeneous `:138-171`; engine call `:174`; command `:32-178` | `:82`, `:84-85`, `:89-98`, `:138-171`, `:174`, `:32-178` | ✓ — a third mode in a mixed layer lands in neither `Vec` and is never pushed to `final_objects`; no comment, no stderr. The drop is real. |
| 5 | `assert_golden :476-503`, `.is_ok()` at `:478` | `:476-503`, `:478` `if std::env::var("KERF_UPDATE_GOLDEN").is_ok()` | ✓ — `=0`, empty and `true` all rewrite. |
| 6 | Second reader `serial.rs:3216` in `b2a_generate_native_status_fixture` (`:3158`), comments `:3157`, `:3215`, fixture `_comment :3210` says `=1` | all exact; module is `#[cfg(test)] mod sim_integration` (`:2276-2277`), not feature-gated, so it runs on every `cargo test` | ✓ |
| 7 | No other reader (`grep -rn KERF_UPDATE_GOLDEN src-tauri/src src .github scripts package.json`) | hits: `gcode.rs` `:451,:473,:478,:486,:497` (one reader, four prose), `serial.rs` `:3157,:3210,:3215,:3216,:3227` (one reader), `ci.yml:78,:83`, `nativeStatus.json:2`. `stop_result_fixture.json` has no env-gated writer (`serial.rs:2145` round-trips it). | ✓ two readers, both in the plan |
| 8 | CI guard `ci.yml:78-83`; clippy `:90` with `--features sim`; `cargo fmt --check :94` | `:78-83` ✓; `:90` ✓; `:94` ✓ **but `:96` is `continue-on-error: true`** — CI does not fail on fmt. The plan's "required here" is stricter than CI, which is fine, but "CI's form" overstates it. | ~ |
| 9 | Test-local mirror `sort_fill_before_line :234-273`, "Mirrors the inlined logic" `:235`, bbox-corner tracking and always-inner-first | `:233-272`; `:234` doc; `cur_x = obj.x + obj.width` `:262-263`; `order_inner_first_nn` unconditionally `:268` | ✓ — the mirror already diverges from production (`object_end_point`, `cut_inner_first` toggle), so the three A4b tests prove nothing about `generate_gcode`. |
| 10 | `use crate::engine::optimizer;` at `:232` becomes unused when the mirror goes | `optimizer::` inside `mod tests` occurs only at `:260` and `:268`, both in the mirror | ✓ |
| 11 | Three A4b tests `:325-381` | `:327-381` (`fill_before_line_fillline_layer`, `homogeneous_line_layer_unchanged`, `homogeneous_fill_layer_unchanged`); the first asserts `len() == 4` with `fill_c` in mode `fill` | ✓ (E1b-M4's kill traced) |
| 12 | Anchor counts at `7140cab`: `width_mm: obj.width,` 1; `layer_order.push(li);` 1; engine call 1; `.filter(\|o\| is_fill_ish(&o.layer.mode))` 2; the three new anchors 0 | `grep -cF`: 1 (`gcode_gen.rs:1222`); 1 (`:59`); 1 (`:174`); 2 (`:91`, `:247`); 0/0/0 | ✓ |
| 13 | E1b-C1 mechanics: `width_mm` moves the maskFill rotation centre by +15 mm, displacing a 30° burn by about 7.8 mm | `MaskScanParams.width_mm` (`mask_fill.rs:53`) is read once: `cx = params.origin_x + params.width_mm / 2.0` (`:238`), the rotation pivot. `has_rotation` (`:240`) is false at 0°, so the doubled width changes nothing at 0° and only T6 at 30° can see it. Displacement `2·sin(15°)·15 = 7.76 mm`. | ✓ — a real, single-test kill; the plan is right that 0° cannot catch it. |
| 14 | E1b-C2: `layer_order.insert(0, li)` reverses arrival order; killed by `golden_07` | `golden_07_multilayer_priority_order` (`gcode.rs:760-810`): input A(5), B(1), C(5); asserts `pos_a < pos_b` and `pos_c < pos_b` inline before the snapshot. Reversed order emits B first → red on the inline assert, and the snapshot differs. | ✓ |
| 15 | E1b-M3: `.map(\|mut r\| { for m in r.moves.iter_mut() { m.x = 0.0; } r })` type-checks | `GcodeResult.moves: Vec<GcodeMove>` (`gcode_gen.rs:146`), `GcodeMove.x: f64` pub (`:134-135`); the engine call is the tail expression of the `spawn_blocking` closure, returning `Result<GcodeResult, String>` | ✓ |
| 16 | T5's premise: one `moves` entry per emitted `G0`/`G1` between the markers | `mask_fill.rs`: 11 emission sites (`emit_g1` at `:471,:574,:616,:639,:662,:746,:766,:797,:840`; `G0` at `:456,:598`) and 11 `moves.push(GcodeMove` (`:459,:480,:583,:602,:625,:648,:671,:755,:775,:806,:849`), each directly after its line. Line arm: `G0 :586→moves :587`, `G1 :601→:604`, `G0 :622→:623`, `G1 :683→:686`, `G0 :700→:701` (lead-in, plain, tabs). Preamble `G0 X0 Y0` (`:445`) and footer (`:1292`) sit outside the markers. `emit_g1` always writes `S` (`:307`), and the line arm's `G1` carries `F` and `S` (`:601`). | ✓ — T5 should be green at baseline; if it is not, the plan's NEEDS_CONTEXT stop is the right reaction. |
| 17 | T5/T6 frame: rotate about the centre then `y → H − y` (`coords.rs:17-41`) | `to_grbl_coords :17-41`: rotate by `+rotation_rad` about `(cx, cy)`, then `workspace_height − ry` | ✓ — T6's inverse (unflip, then rotate by −rotation about (25, 25)) is the correct order. |
| 18 | E1a's Razor recheck measured 0.000 mm outside at 0°, 30°, 90° on the maskFill route | `kerf-evidence-e1a-razor-review-b1.md:25-26` (30°, 90°: 0.000 mm) and the recheck table `:89-91` (0°: 0.0000 mm) | ✓ (Razor's rect was 30×15; the plan's is 30×10 — T6's bounds match the plan's own fixture) |
| 19 | E1a premise change: contour `gcodeGen.ts:400-421`, lowering to `maskFill :444-446`, overlay `:540-555`, `assertNoFillLine :630-639` called at `:623`, `buildCutLayer` copies `layer.mode :85`, single `invoke("generate_gcode") :1182` | contour `:403-421` ✓; `:444-446` `if (sharpRectContour) { effectiveMode = "maskFill"; }` ✓; overlay `:541-555` ✓; call `:623` ✓, fn `:629-638` (off by one); `:85` ✓; `:1182` ✓. **The fragment loop (`:1170-1195`) has no `try`/`catch`**, so a Rust `Err` on any fragment rejects the whole `generateGcode` — the plan's claim that the TS catch (`MachinePanel.tsx:184-187`, ✓) receives both new errors holds. | ✓ (one line number off by one) |
| 20 | `Layer.mode` unvalidated on load: `fileOps/index.ts:26`, `:40`, `:174-248`, `:634` | `parseAndValidateProject :26`, `Array.isArray` check `:40`, `loadProjectWithMigrations :174`, `l.mode = sub.mode as CutMode :634` | ✓ — `obj.type` is equally unvalidated (only migration code reads it, `:779,:848,:852,:872`). See dimension 3. |
| 21 | `mask_fill.rs:301-307` omits an unchanged Y | `:300-307` | ✓ |
| 22 | Five comment-and-skip sites: `:893-907`, `:1198-1203`, `:1206-1216`, `:1258-1265`, `:1413-1422` (+ `:515-516`) | `:893-909`, `:1198-1203`, `:1206-1216`, `:1259-1265`, `:1413-1422`; the empty path is skipped at `:515-516` | ✓ |
| 23 | Battery: env passed through minus `GIT_*` (`:790-796`); baseline shares the per-mutant bound (`:1675`); `MUTANT_ANCHOR_AMBIGUOUS` on ≠1 hits (`:1772-1779`); timeout is `errored` (`:1882`) | `scrubbedEnv :790-796`; `baseTimeout = Math.min(per_mutant …) :1675`; `hits.length !== 1` refuses `:1773-1779`; `run.timedOut → 'errored' :1881-1883` | ✓ |
| 24 | E5 timing: 14 ids in 1,474 s (20:46:20→21:10:54) and 1,321 s (21:24:42→21:46:43); first baseline `timed_out: true` | journal: `baseline timed_out:true` at 20:21:56; `baseline` 20:46:20 → `live_tree_check` 21:10:54 = 1,474.3 s; 21:24:42 → 21:46:43 = 1,321.8 s; the M13-only run took 131 s | ✓ exact. **But** the E5 spec ended on `total_timeout_ms: 5400000`, not 3,600,000 (`kerf-evidence-e5-ted-report-b1.md:6`); the plan's "what E5 ended on" is true of the per-mutant bound only. |
| 25 | Safety S1b/S4a edit `serial.rs` `:747-818`, `:944`; E1b's edit is one test at `:3152-3235`, no stop/fence/submit code | `PLAN-safety-gate-class.md:68-69`, `:91-93` ✓; `serial_stream_job_inner :752`; the b2a test touches no lock | ✓ disjoint |
| 26 | ROADMAP `:555`/`:700` say "two more" sites at `:897-906`; ARCHITECTURE `gcode.rs :162-163`, `gcode_gen.rs :193-203`, `optimizer.rs :219` claims a partition it never had, golden `:226-228` | all exact; `grep -n partition src-tauri/src/engine/optimizer.rs` is empty | ✓ |
| 27 | `docs/code-refresh-2026-08-05.md:73` is the only other mention of the skip | `:73` "(unknown layer mode handler) correctly identified as a deliberate fix" | ✓ |

Twenty-seven claims: 25 exact or stronger, 2 imprecise (8: fmt is `continue-on-error` in CI; 24: E5's total timeout). Nothing wrong.

## Universal core (all gating)

### 1. Problem-fit — **PASS**
`## Intent (grilled)` present with a written skip line and a Summary that matches the parent's §E1b and the charter's "no silent G-code error". No DECISIONS entry is touched: the `serial.rs` edit is one test body inside `sim_integration`, nowhere near the 2026-09-24 admission/submit pin; nothing reads `A:S`; no settings write, no stop path. The plan also corrects the parent where E1a changed the premise (lowered mode is `maskFill`, not `fill`), and says so rather than carrying the stale control.

### 2. Approach soundness — **PASS**
Three mechanisms, each at the right seam. (a) `Err` from the `other =>` arm fails the whole job; the engine returns `Result` already and the one production caller propagates it (claim 19), so no new plumbing. (b) The partition refusal is at the only place a third mode can vanish without trace, and it names layer, object and mode. (c) The pure `golden_update_requested(Option<&str>)` is the parent critic's must-fix 2 restored, and both readers go through it. The extraction of `order_objects` goes beyond the parent's "the partition at `:82-137`", and it is the right call: the existing A4b tests exercise a mirror that already disagrees with production (claim 9), so without the extraction no test in the tree can turn a partition mutant red, and the plan's own M4/M5 would be unkillable. The 15 byte-identical goldens plus C2 are the equivalence proof that the move changed nothing.

### 3. Completeness — **CONCERN**
(a) **One silent-omission route of the same class stays open, and the reason given for parking it belongs to a different class.** `object_to_path`'s `other =>` (`gcode_gen.rs:1413-1422`) turns an unknown `obj_type` into an empty `PathSegment`; the line arm skips it at `:515-516`. stderr only, no in-band comment, no `Err` — strictly less visible than the arm E1b converts. `obj.type` is exactly as unvalidated on load as `layer.mode` (claim 20), so the route is the same hand-edited, corrupted or forked file. The plan's Parking Lot justification ("three of them handle an object that exists but yields nothing burnable … a behaviour call for 2.6") is right for the maskFill degenerate-mask sites and the fill-arm shape rejection; it does not describe a stringly-typed classifier miss, which is E1b's own class ("an unknown X is an error"). Taking it costs one `Err` before `object_to_path` in the line arm (or a `Result` return from `object_to_path`), one test, one mutant — same file, same shape as M1/T10. **Fix:** take it as change 1b with test T11 (`unknown_obj_type_is_err_naming_type_and_object`) and mutant E1b-M6, or state in "Out of scope" why a bad `obj_type` is different in kind from a bad `mode` and keep the Parking Lot line. The first is one arm; the second is one sentence; the current text is neither.
(b) T9's baseline: `f` is a `rect_obj` on `base_layer("maskFill")` with `paths: vec![]`, so `fill_compound_mask` returns `Err("maskFill: object has no paths")` (`mask_fill.rs:906-907`) and the arm writes `; maskFill skipped: …` (`:1198-1203`). The baseline program will therefore carry a skip comment that is **not** the repro. Either give `f` a `rect_path` so the only anomaly at baseline is `b`'s absence, or say in the repro step that the maskFill comment is expected noise. Otherwise a careful Ted reports the wrong finding.
(c) Nothing else missing: homogeneous unknown layers reach the engine and `Err` there (T8); mixed strays `Err` at the partition (T3/T9); `fillLine` from a direct IPC caller takes one of those two paths; the fragment loop cannot swallow an `Err` (claim 19); images take a separate command with no mode.

### 4. Right-sizing & reuse — **PASS**
Five files, one root, one batch, Standard. Reuses `golden_tests`' builders, the existing `assert_golden`, the A4b tests (repointed, assertions unchanged) and the battery. The extraction is the minimum that makes the partition testable. Out-of-scope items are named and indexed for Stage 3.5, and the plan corrects the E1a Parking Lot undercount (two → five) rather than inheriting it.

### 5. Security — **PASS**
No secrets, no network, no port. Public repo: no controller identity string is added anywhere; the new error strings carry a layer index, an object id and a mode string, all of which are the operator's own data. Blast radius is a console error.

### 6. Failure modes — **PASS**
Every new path ends in `Err` → TS rejection → `MachinePanel` catch (console line, status line, `return false`), and `gcodeResult` is left untouched, which the panel's own comment says the null/stale gates handle (`MachinePanel.tsx:153-158`). Pre-existing, not E1b's: a stale successful program from an earlier Generate remains in the store after a failed one; the stale gate is what keeps START honest, and nothing here changes it. The golden gate on a missing fixture still panics with the `=1` instruction (`:484-489`). Battery timeouts are `errored`, never survivors, and the plan says so.

### 7. Change safety — **PASS**
No irreversible step. Golden 16 is generated by a name filter that matches exactly one test, then compared with the variable unset. The 15 existing goldens are diff-checked against the merge base with a glob that also catches the `.json`. Rollback is the merge commit; nothing downstream depends on E1b (S4c follows E1a).

### 8. Data integrity & compatibility — **PASS**
Project files on disk are untouched. A file whose layer mode the engine lacks moves from "generates, minus that layer" to "refuses, naming the object", which is the fix; the plan's Risks line says so. README and ARCHITECTURE deltas keep the `=1` rule in one story; the ARCHITECTURE correction for `optimizer.rs` removes a claim the tree never supported.

### 9. Verifiability (incl. testing the tests) — **PASS**
The evidence plan is the strongest part of this file, and I checked it against the tree rather than the prose:
- **Reproduce first is real.** T10 at baseline: `Ok` with `; unknown layer mode 'bogus' — object skipped` (`:1279`). T9 at baseline: `Ok`, `b` absent from the program, no `unknown layer mode` string, because `b` never reaches the engine (claim 4). Both are executable before any production edit. (See 3(b) for T9's expected noise.)
- **Every mutant is one contiguous edit with a unique anchor** (claim 12), each type-checks (M2b and M5 leave an unused binding, which is a warning under `cargo test`, not an error — the battery does not run clippy), and each kill is traced: M1 → T10 expects `Err`, gets `Ok`; M2a → `Some("0")` true; M2b → `Some("1")` false; M3 → T5's X mismatch; M4 → `fill_c`/`c` vanish (`len() == 4`, multiset); M5 → T3/T9 get `Ok`; C1 → 7.76 mm at 30° (claim 13); C2 → golden 07's inline assert (claim 14).
- **T5's exact-count premise holds** (claim 16) and **T6's inverse transform is in the right order** (claim 17), with Razor's measurement as the prior (claim 18).
- **No test touches the environment**; T7 is pure; Razor's grep for `env::` on added lines is the right check.
- **Timing is measured, not guessed**, and matches the journal to the second (claim 24). One number is off: E5 ended on `total_timeout_ms: 5400000`. With another battery live, E5's second cold baseline took 1,463 s; add eight ids at ~105 s and a 3,600 s total still fits (about 38 min), but two concurrent Rust batteries would not. Use 5,400,000, which is what E5 actually ended on.
- One class-guard is missing, advisory: Razor's confirmation that both readers go through `golden_update_requested` is a one-shot grep. A `#[test]` that scans `src-tauri/src/**/*.rs` for `KERF_UPDATE_GOLDEN` and asserts every non-comment hit sits on a line containing `golden_update_requested(` would make "goldens update only on `=1`" hold for the next reader too, not just these two.

### 10. Maintainability — **PASS**
Clean seams: one arm, one function, one pure predicate, one deleted mirror. The doc comment on `order_objects` states the three guarantees a future editor would otherwise re-derive. ARCHITECTURE and README deltas named. Two citation nits for the next lift: `assertNoFillLine` is `:629-638`; the fill-arm skip is `:893-909`.

## Conditional dimensions

### X1. Physical & human safety — **PASS** [GATING]
The question is whether any path still hands the machine a program with an object missing and no one told. Traced after the change: an unknown mode on a homogeneous layer → `order_objects` passes it → engine `other =>` → `Err`, no program (T8, T10). An unknown mode on a mixed layer → the stray find → `Err` before the engine (T3, T9). `fillLine` from a direct IPC caller → one of those two. The TS fragment loop has no catch (claim 19), so one bad fragment fails the whole Generate; the panel's catch leaves the previous result alone and returns false. Nothing in the batch can energise the beam or move the head; the worst case of every new failure path is a console error and no job. **Worst case per failure path, named:** (a) the `Err` path → nothing reaches the machine; safe. (b) The one silent route left, `obj_type` (dimension 3a) → a *missing* burn, not a wrong one: the preview shows the object, the machine skips it, stderr knows. Same hazard class as E1b's target, smaller surface. (c) The golden gate: with `=0` now comparing, a local `KERF_UPDATE_GOLDEN=0 cargo test` can no longer regenerate-and-pass and mask a geometry regression; the `serial.rs` fixture writer is closed the same way. (d) The extraction: goldens 01-15 byte-identical plus C2 pin the order; the only new behaviour is an `Err`. Hardware-only paths: none needed; the owner check is a release-build IPC smoke, correctly routed to ROADMAP `next` and not asked of Lee as a file edit.

### X5. Concurrency & re-entrancy — **PASS** [ADVISORY]
The parent critic's V9a race is closed by construction: the predicate is pure, T7 calls it with literals, and the two readers call `std::env::var` once each on the test thread that needs it. `order_objects` is a pure function of its inputs. No timer, no shared state.

### X6. Operability & observability — **PASS** [ADVISORY]
`unknown layer mode '<m>' on object '<id>'` and `layer <i>: object '<id>' has mode '<m>', which is neither a fill pass nor a line pass; it would be dropped from the job` both land in the console via the existing catch. The id is internal, as the plan admits; it is still enough to find the object in a saved file. The Parking Lot lead (validate `mode` at load) is the right place for the earlier, friendlier message.

### X8. Dependencies, performance & cost — **PASS** [ADVISORY]
No dependency. Battery cost is about 30 minutes of CPU and is bounded by the timeouts; the one correction is the total (dimension 9).

## Stress tests

### Pre-mortem — three months out, this failed
1. **A project from a fork carried `type: "rect"` and the part came off the bed with one shape uncut.** E1b shipped "the generator never silently omits an object"; the `obj_type` arm was parked under a justification written for degenerate geometry, and nobody re-read it. What we should have seen: the plan's own Parking Lot line already says "with no G-code trace at all".
2. **The battery run came back `errored` on the baseline twice and Ted "checked" it with a hand `cargo test`.** Two Rust batteries overlapped; the cold baseline took 24 minutes as E5's did; 3,600 s total was not enough; the plan says never run cargo by hand, and the pressure to did the rest. What we should have seen: E5's report line 6 says 5,400,000.
3. **Six months on, a third `KERF_UPDATE_GOLDEN` reader used `.is_ok()`.** Razor's grep was a one-shot review step; nothing in the tree asserts the rule. What we should have seen: a source-scan test is ten lines.

### Load-bearing assumptions
1. **`width_mm` feeds only the maskFill rotation pivot** — verified (`mask_fill.rs:238`, the sole read). Consequence if wrong: C1 would also fire at 0° and the plan's "T6 at 30°" line would understate the kill, harmless.
2. **One `moves` entry per emitted `G0`/`G1` in the maskFill scanner and the plain line arm** — verified at every site (claim 16) for `lead_in = overcut = tabs = perforation = 0`, which is the fixture. Consequence if wrong: T5 red at baseline → the plan's NEEDS_CONTEXT stop, not a false green.
3. **E1a lowers the sharp rectangle to `maskFill`, unconditionally, on the flag** — verified (`gcodeGen.ts:444-446`). Consequence if wrong: golden 16 would snapshot the wrong arm; T6 would still measure the burn.
4. **`order_objects` moved verbatim preserves order** — not verifiable until the diff exists; the goldens and C2 are the instrument, and they are in the plan. Confidence high; the one edit the move forces (`for obj in &objects` → `for obj in objects` on a slice) is mechanical.

### Inversion — when would a rejected alternative win?
- **Leave the partition inline and test it only through the command** wins if the extraction risked changing order. The goldens make that risk measurable at zero cost, and the alternative keeps a mirror that already disagrees with production (claim 9). Not true.
- **A count check (`fill_group.len() + line_group.len() == layer_objs.len()`) instead of the stray find** wins if buckets could overlap. `is_fill_ish` excludes `"line"`, so they cannot; the find names the object, which the count cannot. Not true; the plan's choice is stronger.
- **Validate `mode` at load in TS instead of in Rust** wins if files were the only route. Direct IPC and future lowering code exist, and the parent's charter reading puts the guarantee at the generator. Not true; the load-time check is correctly a lead.
- **Convert `obj_type` in this batch** wins if it is the same class, same file, same shape. It is — which is dimension 3(a).

## Overall verdict

**PASS.** The diagnosis is accurate and I checked it against the arms, the partition and both env readers rather than the comments: the mixed-layer drop is real and traceless, the engine arm's comment-and-skip is real, and `=0` regenerates today in two places. The three fixes sit at the right seams, the extraction is what makes the partition testable at all, and the evidence plan is unusually honest — every mutant is single-site with a verified-unique anchor, every kill traces to a specific assertion, the control that could only fire at 30° is labelled as such, and the timing numbers match the E5 journal to the second. Nothing gating fails. The one concern worth the author's attention is scope, not mechanism: `object_to_path`'s unknown `obj_type` is the same class of silent omission this batch exists to close, reachable by the same route, less visible than the arm being fixed, and parked under a reason written for a different class. Take it or say why not; either is a few lines.

## Must-fix, prioritised

1. **Core 3(a) / X1:** convert `object_to_path`'s unknown `obj_type` (`gcode_gen.rs:1413-1422`, skipped at `:515-516`) to an `Err` naming the type and the object — one arm, test T11, mutant E1b-M6 — **or** add one sentence to "Out of scope" saying why a stringly-typed `obj_type` differs in kind from a stringly-typed `mode`. The current justification describes the geometry sites, not this one.
2. **Core 9 / X8:** `total_timeout_ms: 5400000`, which is what E5 actually ended on (`kerf-evidence-e5-ted-report-b1.md:6`); keep `per_mutant_timeout_ms: 1500000`.
3. **Core 3(b):** give T9's `f` a `rect_path` (or state that `; maskFill skipped: maskFill: object has no paths` is expected baseline noise), so the repro's only anomaly is `b`'s absence.
4. **Core 9 (class guard, advisory):** a `#[test]` that scans `src-tauri/src` for `KERF_UPDATE_GOLDEN` and asserts every code hit is on a line containing `golden_update_requested(`; makes Razor's grep permanent.
5. **Citations:** `cargo fmt --check` is `continue-on-error: true` in CI (`ci.yml:96`) — keep it required here, but say the plan is stricter than CI rather than "CI's form"; `assertNoFillLine` is `:629-638`; the fill-arm skip is `:893-909`.
