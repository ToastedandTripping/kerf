# Critic: kerf-safety-engine-arm

**Verdict: CONCERN.** No gating FAIL. Ten core dimensions PASS or CONCERN; X1 PASS; X5 PASS; X8 CONCERN (advisory). Nine must-fix items, none of which change the design.

- **Plan:** `.claude/plans/kerf-safety-engine-arm.md`, read at `4deaa42` (the orchestrator named `3249604`; `4deaa42` is one ROADMAP-only commit on top, `git show --stat 4deaa42`, and `git diff 3249604 4deaa42 -- src src-tauri` is empty, so every code citation below holds at both).
- **Reviewer:** Fable, separate subagent, rubric v2 in full.
- **Read for this review:** `.claude/DECISIONS.md` in full; `kerf-safety-s2.md` (merged `9ec08e0`); `kerf-evidence-e1b.md` (queued; no `relay/kerf-evidence-e1b` branch exists yet); `gcode_gen.rs` sites A–H and the templates around them; `mask_fill.rs:275-470`; `image_gcode_gen.rs:380-440`; `commands/gcode.rs:455-600, :940-990`; all 16 goldens (a parser, not by eye); `ci.yml:70-100`; `.gitignore`; `canStartJob.ts:160-180`; `types.ts:260`; `mutation-battery.mjs` env handling; and stock GRBL `gcode.c`, `spindle_control.c`, `stepper.c` fetched from gnea/grbl master on 2026-09-25.

## Applicability

**Project type:** desktop CAD/CAM for a laser cutter; this batch is G-code generation in the Rust engine plus its golden corpus. No UI, no network, no personal data.

| Dim | Fires? | Why | Tag |
|---|---|---|---|
| X1 Physical safety | **Yes** | Every line changed is a laser power command. The hazard the batch removes is a stationary beam. | **GATING** |
| X2 Privacy | No | No personal, health, child or client data is touched. Goldens are synthetic geometry. | N/A |
| X3 Evidence integrity | No | The plan makes firmware claims, but they inform an engineering fix, not a decision or public output; they are checked under X1 and Specific check 1 instead. | N/A |
| X4 Audience/brand/money | No | Nothing client- or public-facing. | N/A |
| X5 Concurrency | Yes | Parallel `cargo test` threads write goldens in step 5; two Rust batches (this and E1b) share files; the battery runs a copy. | GATING (X1-class plan) |
| X6 Operability | Yes | The emitted program of every real job changes; the app is released to an owner with a vendor-fork controller. | ADVISORY |
| X7 Self-modification | No | Touches no MARVIN gate, hook or skill. The regeneration guard is Kerf's own test harness. | N/A |
| X8 Dependencies/cost | Yes | No new crate (checked: `regex` absent from `Cargo.toml`, none added). Fires on cost: a cold Tauri build per battery on a disk at 94%. | ADVISORY |

## Core dimensions (all gating)

### 1. Problem-fit: PASS
`## Intent (grilled)` is present with a written skip line and three sources. The Summary ("every mode line carries S0; positive S only on G1 with motion; nothing else changes") is exactly S2 Deferral 1 as indexed at `ROADMAP.md:596` and detailed at `:790-794`. No DECISIONS contradiction: the 2026-09-10 M4/M3 ruling keeps M3 selectable and this batch keeps it; the status-only evidence entry as amended 2026-09-25 is respected (the hardware card uses the witness-card shape with a control burn, is run by Lee, and is excluded from done); "A:S is not a beam signal" is not relied on anywhere; the vendor-fork entry is quoted correctly ("intent evidence, not proof"). The W4 powerMin pin is preserved (clamp untouched, tests re-pointed, `!contains("S600")` kept).

### 2. Approach soundness: PASS
Correct and minimal: `S0` on the mode line, power stays on the `G1` words the engine already writes. This is the same shape the raster scanner has shipped since F4 (`mask_fill.rs:424-427`) and S2 applied to the material test. On stock GRBL it is sound at both ends: a mode line at `S0` syncs the spindle to PWM-off in either modal motion (`gcode.c:917-934`, `:944-947`; `spindle_control.c` `rpm == 0.0` branch), and the following `G1 S<n>` re-arms on motion because the stepper forces a PWM update on every new planner block (`stepper.c:845`, `:958-970`). Under `$32=0` every site lights regardless; START refuses `$32=0` (`canStartJob.ts:170-176`, verified).

### 3. Completeness: PASS
All eight emitters are the only positive mode lines in `src-tauri/src` (grep of `power_cmd|"M3|"M4` across the crate; the only other producer, `mask_fill.rs:425`, is already `S0`; `image_gcode_gen.rs` has no mode line of its own). Sites F and G reach no golden (verified: golden 13 has one mode line; golden 12 has one); the matrix fixture `line_perf_overcut_leadout` exists for that, and KE-M6/M7 are the falsifiable proof that it actually reaches them (if the fixture ends in a cut rather than a skip, those two mutants survive and the battery says so). Both E1b merge orders are handled (see Specific check on E1b below).

### 4. Right-sizing & reuse: PASS
Two authored files; the other 15 are one regeneration command's output. The waiver states why they cannot be split (a red corpus between batches). Six deferrals are named and routed to the Parking Lot at Stage 3.5. Nothing is gold-plated; the classifier's Class B, which the plan itself expects to be empty, is the one arguable extra, and it costs a dozen lines while making a silent `G1`-gains-`S` visible as a count rather than an `Err`. Acceptable.

### 5. Security: PASS
No secrets, no network, no IPC change, no file-format change. Blast radius is the emitted program, which is the point.

### 6. Failure modes: PASS
Reproduce-first with NEEDS_CONTEXT on a non-failure; step 4's "any other red is a defect: stop"; battery timeouts are `errored`, never survivors; T4 panics on a missing or short before-set. Generation is a pure function, so there is no runtime failure path.

### 7. Change safety: PASS
Code and goldens in one commit; revert the merge commit and the corpus reverts with the engine; no controller setting written; no irreversible step. The snapshot in step 2 gates on `git diff --quiet -- src-tauri/tests/golden`.

### 8. Data integrity & compatibility: PASS
Project files are untouched. The only consumer-visible change is mode-line `S`; no TS code parses a mode line (grep of `src/` for `startsWith("M`, `/^M[34]`, `S(\d`: none outside tests; `assembleGcode` inserts only `M5 ; laser off at layer seam`, `gcodeGen.ts:869`, verified). The preview comes from `moves`, which no site pushes to (read at all eight). E3's spindle tally shift is correctly labelled status-only (Risk 7).

### 9. Verifiability incl. testing the tests: CONCERN
Strong overall: reproduce-first, four anti-vacuity clauses, controls C1–C5, the classifier tested both ways (T3/T3b), and Razor re-runs T4 from a fresh before-set. Three defects in the wiring, none of which lets a bad change through, all of which would make Ted's report say something false:
- **The "Killed by" column lists T2 for KE-M1 to M10.** T2 reads the *committed* goldens and asserts on them; a code mutant cannot change a committed file, so T2 can kill nothing in the battery. T2 is a regeneration guard, not a mutant killer. Every listed mutant is still killed by T1 and by the byte-for-byte golden compares, so no survivor results, but the column overclaims and must be corrected (must-fix 1).
- **T5 writes `target/arm-matrix-out/<label>.gcode`, and there are 24 programs for 12 labels.** Unless the label already carries the mode, the second run overwrites the first and T4 pairs 12 files, not 24. The plan says "Matrix labels are stable" but never says the file name includes the power mode (must-fix 2).
- **Razor's instruction "T5 at the base commit"** cannot run: `arm_matrix()` lands in Commit 1, so the before-matrix must be built at Commit 1, not at the relay base (must-fix 3).

### 10. Maintainability: PASS
Two comments updated and the stale P2-A comment replaced; ARCHITECTURE delta named at two line ranges (both verified to exist and to say what the plan says they say, `:194-203`, `:311-315`); DECISIONS pin proposed, never auto-written; T1/T2 are durable and T4/T5 are correctly one-shot. Note for the writer: E1b's T12 will scan the crate for a second `KERF_UPDATE_GOLDEN` reader; this plan adds none (compile-time `env!` only), and the plan should say so in one line so the next editor does not add one (must-fix 8).

## Conditional dimensions

### X1 Physical & human safety: PASS (GATING)
- **Every control path ends in a safe state.** The only runtime effect is the emitted program. Every mode line goes to `S0`, which is PWM-off on stock for either modal motion; every positive `S` sits on a `G1` with motion, as it already does today. Nothing here can make a program that was dark light up: the change only removes commanded power from lines that have no motion.
- **Worst case per failure is named.** Fork lights a minimum PWM at `S0` on an enabled spindle: a dot survives at M3 starts, no worse than today, and card steps 2–3 are the instrument. `$31 ≥ $30` would map every `S` including `S0` to PWM-max (`spindle_control.c`, first branch of `spindle_compute_pwm_value`), but that misconfiguration already makes today's `G1 S0` overscans and `G0 … S0` rapids fire, so it is pre-existing and not widened; the owner's `$30=1000, $31=0` is cited from the 2026-09-14 probe (`probe-20260914-153729.log:33-35`, verified).
- **Hardware-only paths are named and never claimed.** done_condition excludes the card; the close report is forbidden from saying the beam was verified dark. The card follows the 2026-09-25 amendment: low power, scrap card, a deliberate control burn beside the test, run by Lee with fire precautions. Step 2's control (`G1 F1000 S0` to set `G1` modal, then `M3 S100`) is valid stock G-code: `G1` without axis words is accepted when `F` is defined (`gcode.c:875-878` comment, the motion-mode checks) and does exactly what the plan says.
- **Residual named honestly:** I2 is word-level; a zero-displacement `G1` with positive `S` would be a stationary burn that I2 passes. Measured absent in every golden (my own parser agrees: zero zero-displacement powered `G1`s across 16 files) and guarded by `seg_len < 0.001` skips at the sites the plan lists. Not this batch's to own.
- **The two new planner stops (Risk 2)** are dark stops (`S0` before the sync) followed by a `G1` from standstill; under M3 that is an acceleration burn at the perimeter start, which is the 2026-09-10 ruling's territory and is now consistent with every other M3 path start. Not a new hazard class. It is, however, a visible change Lee should hear in plain words (must-fix 4).

### X5 Concurrency & re-entrancy: PASS (GATING for this plan)
- Golden writers run on parallel threads to distinct files: safe.
- **Step 5's filter `golden_tests` also runs T2 and T1 in the same process as the writers.** T2 reads the corpus while it is being rewritten and can go red or pass depending on scheduling. It cannot corrupt anything (T2 only reads), but the plan never says what step 5's test verdict means, so a red T2 there will either be reported as a defect or, worse, prompt a second regeneration run "to be sure". Tighten the filter to `golden_tests::golden_` or run step 5 with `--test-threads=1`, and state that step 5's pass/fail is not consulted; steps 6 and 7 are (must-fix 5).
- Two Rust batches: the plan correctly serialises them and handles either E1b order.
- The battery runs in its own copy with T4/T5 `#[ignore]`, so no battery run can touch `target/golden-before`.

### X6 Operability & observability: PASS (ADVISORY)
Operator-visible change is the brief pause in Risk 2(a) and nothing else; the owner card covers the check. What the operator would see if the fork misbehaves (a dot) is exactly what card steps 2–3 look for. Deferral 3 (Fire dark after a job on stock) is a real product finding correctly parked and correctly labelled "owner check first".

### X8 Dependencies, performance & cost: CONCERN (ADVISORY)
No new crate. The cost item: the disk is at **94%** now (`df`, 30 GB free), not the 92% the plan cites from the hand-off; the kerf worktrees alone hold 33 GB and there are 16 of them. The battery copies the tree and cold-builds the crate (E1b measured 218–1,463 s), several GB per copy. A full disk mid-battery is `errored` ids and a re-run, or a half-written target dir. State a free-space precondition before the battery (and before step 5), or remove the six finished relay worktrees the hand-off already names (must-fix 6). The timeouts (25 min per id, 90 min total; 16 ids × ~100 s + cold baseline ≈ 30–50 min) are adequate with margin.

## Specific checks requested by the orchestrator

### 1. Stock GRBL 1.1h: does a standalone `M3 S` light a stationary beam only after a `G1`? Is the claim right, and does the plan depend on it?
**Right, verified against source, and the plan does not depend on it.** Traced in `gcode.c` (gnea/grbl master, 2026-09-25):
- A standalone `M3 S1000` has no G word, so `gc_block.modal.motion` inherits the parser's modal motion. With `$32=1`, if that motion is not G1/G2/G3, `GC_PARSER_LASER_DISABLE` is set (`:869-873`). Then `pl_data->spindle_speed` stays 0 (`:932-934`), and the M5→M3 state change syncs at that value (`:944-947` → `spindle_sync` → `spindle_set_state(CW, 0.0)` → `rpm == 0.0` → `SPINDLE_PWM_OFF_VALUE`). **Dark.** That is sites B, C, D, E, F, H and G-without-F, each preceded by a `G0` (verified at each site in `gcode_gen.rs`).
- If the modal motion is G1 (site A after the `G1 … S0` overscan ramp when `overscan > 0`; new layers default to 0.5 mm, `types.ts:260`, passed through at `gcodeGen.ts:100`), DISABLE is not set, `pl_data->spindle_speed = 1000`, and the M5→M3 sync drives PWM at 1000 with the planner drained. **Lit, stationary.** Under M4 the same line is dark because `spindle_set_state` zeroes rpm for CCW in laser mode (`spindle_control.c`, the `SPINDLE_ENABLE_CCW` branch). So on stock, the shipped hazard is exactly "every M3 fill layer with overscan dots the start of every scan line", as the plan and the ROADMAP line at `4deaa42` now say.
- **After the fix**, `S0` gives `pl_data->spindle_speed = 0` in both branches, so all eight sites are dark on stock under either modal motion, and the fix no longer rests on the G0-dark rule the fork may not share. The plan edits all eight regardless, which is the right call: the fork is unqualified at all eight (DECISIONS 2026-09-05).
- **One thing the plan should add as evidence, because it is load-bearing for "burns still happen":** the re-arm on the next `G1 S<n>` works in M3 laser mode because the stepper forces a spindle-PWM recompute on every new planner block (`stepper.c:845` "Force update whenever updating block", consumed at `:958-970`). The plan cites the parser but not the stepper. The shipped raster hoist already relies on this, so it is not a new bet, but the citation belongs in the plan (must-fix 7).

### 2. "Byte-identical except mode lines": is the classifier sound, and does every G1 carry its own S?
**Sound, and yes at every site.** Templates that write `G1` in the engine: `gcode_gen.rs:290` (accel overscan), `:313` (scan line), `:336` (decel overscan), `:601` (lead-in), `:683` (perforation cut end), `:763` (tab cut end), `:788` (segment endpoint), `:832` (overcut), `:863` (lead-out), `:1113` and `:1134` (offsetFill ring and close), and `mask_fill.rs:307` (`emit_g1`, "S is always explicit"); grayscale goes through the same `emit_g1`. Every one carries `S{}`. My parser over all 16 goldens: **zero** `G1` lines without an `S` word, zero zero-displacement powered `G1`s, and the only positive-`S` lines that are not `G1` are the 63 mode lines the plan counts (per-file counts match the plan's list exactly). So no `G1` inherits modal `S`, Class B is genuinely expected empty, and asserting `g1_gained_s == 0` is a real check, not decoration. The classifier's reject set (R1–R8) covers the ways a regeneration could smuggle a change: mode letter flip, still armed, coordinate moved, `G1` losing power, line inserted, `G0` gaining power, `S` dropped, comment changed. KE-C4/C5 prove the two predicates can fire. The one gap, that the classifier runs once and never again, is by design (I5 is one-shot; T2 plus the goldens are the durable guard).

### 3. Golden regeneration discipline: concrete and safe?
**Concrete, and safe against a silent rewrite; two procedural nits.** `env -u KERF_UPDATE_GOLDEN` on every compare run, `test -z` in the verification shell, the battery's `test_command` opening with `env -u` (the battery passes the environment through minus `GIT_*`, `mutation-battery.mjs:789-793`, verified), and `git status --short` after the one `=1` run that must show exactly 17 paths. `target/` is gitignored (`.gitignore`, both `target/` and `src-tauri/target/`). The `=1` value works under today's `is_ok()` reader and under E1b's `== "1"` reader. The b2a fixture writer (`serial.rs:3216`, in `mod tests` of serial, not `golden_tests`) is not matched by the `golden_tests` filter, verified. A silent rewrite would need the variable set during a compare run, and every compare run in the plan strips it; a wrong rewrite would need a non-mode-line change, and T4 rejects any such line. The nits: the step-5 filter also runs T2 concurrently with the writers (X5 above, must-fix 5), and the Razor re-run needs Commit 1 for the before-matrix (must-fix 3).

### 4. Motion-timing change: a burn-quality regression Lee should hear about? Correctly routed?
**Lee should hear it, in plain words, and the routing is half done.** Verified in `gcode.c:917-928`: with the spindle already on, an `S` change on a non-motion line forces `spindle_sync`, which drains the planner. Today `M3 S1000` after a maskFill (spindle on at modal `S1000`, golden 04 lines 29–33) is a no-op; after this batch `M3 S0` stops the head. Under M4 (the default) that is a brief dark pause and a ramp from zero: no burn change. Under M3 the perimeter's start corner takes more energy than today, exactly as every other M3 path start already does. The plan names it (Risk 2, Deferral 4, card step 5) but card step 5 is M4-only and the owner card wording is a test instruction, not a description. Add one sentence to the owner card and the close report: "After a fill, the perimeter cut on the same layer now starts from a brief stop; under constant power its start corner will show more burn than before." Either run card step 5 in both modes or state that the M3 case is covered by the 2026-09-10 ruling and not tested (must-fix 4). Deferral 4's one-line fix for the F→G redundant line is correctly deferred: it removes a line and would break I5's line-count rule in this batch.

### 5. Tier and waiver: 17 files, Complex, one batch. Justified?
**Yes.** The file-count rule fires on regenerated fixtures, and the waiver says the only true thing: splitting them leaves the corpus red between batches. The authored change is two files in one root. Over-classifying to Complex is the safe direction (it adds gates, removes none). If E1b lands first the count is 18 and the waiver still holds; the plan says so.

### 6. Mutant anchors unique; controls meaningful?
**Verified by simulation, all unique.** I applied the 2.1 edit (both replacements and both comment changes, exact indentation) to a scratch copy of `gcode_gen.rs` and counted every find with `str.count`: KE-M1 to M8 and M10 are 0 before and 1 after; KE-M11, C1, C2, C3 are 1 before and 1 after; the positive templates are 0 after (`"{} S{}", power_cmd` and `"{} S{}", params.power_cmd` both 0); `{} S0", power_cmd` is 7 and `{} S0", params.power_cmd` is 1. KE-M9's find is 1 in `mask_fill.rs` (`:425`). KE-C4/C5 are 0 in `commands/gcode.rs` today. `cur_y = gpts[0].1;` occurs twice in the file, which is why KE-M3's find includes the following `lines.push` line; with it the find is unique. Controls: C1 flips the mode letter (I3, golden 15); C2 zeroes the fill `G1` (P1, goldens 03/14); C3 zeroes the lead-in `G1` (P1's "every `; Cut:` G1 at the expected S", golden 12); C4/C5 turn the classifier permissive (T3b). Each is green at baseline and red under its variant, so each is a real control. The `cargo fmt --check` requirement is right: KE-C3 and KE-M11 depend on the current one-line argument layout.

### 7. No hardware claims; nothing opens a serial port?
**Clean.** `commands/gcode.rs` has zero references to `serialport`, `SerialPort` or `serial::`; the new tests call `generate_gcode` / `generate_image_gcode`, which are pure. `--features sim` compiles the simulator but no new test uses it, and the plan explicitly does not use the sim as evidence (its `M3/M4`-means-on model is the reason). The plan's language is disciplined: "named, never claimed", done excludes the card, and the close report may not say the beam was verified dark.

### E1b merge order (context item)
Handled in both directions. E1b edits the `other =>` arm, the object-loop guard at `:452`, `object_to_path` comments, `assert_golden`'s reader, adds golden 16 and README rows; this batch edits the eight mode lines, two comments (`:460`, `:1103`) and adds to `mod golden_tests`. No shared line, though `:452` and `:460` are adjacent and both plans append to `golden_tests`, so a textual rebase conflict of the trivial kind is likely whichever lands second. No function-name collision (E1b: `golden_update_*`, `fillline_sharp_rect_*`, `partition_*`; this: `arm_*`, `committed_goldens_never_arm`, `golden_corpus_regeneration_is_arm_only`). E1b-first: golden 16 carries one positive `M3` at site C and joins the regeneration, counts recomputed by T4. This-first: golden 16 is born at `S0` and T2 covers it. E1b's T12 (exactly one `KERF_UPDATE_GOLDEN` reader crate-wide) is respected because this plan reads no environment.

## Stress tests

### Pre-mortem: three months out, this failed
1. **The laser fires: the fork lights a floor PWM at `S0`.** Lee runs card step 3 and sees dots at the square's corner and at every perforation dash start on the M3 piece, the same as before the batch. Nothing got worse, but the batch bought nothing on this machine, and the pre-registered question (M5-until-first-G1 / M4-for-everything / document it) is asked late. What we should have seen: card step 2's control burn already tells us whether the card can show a dot, and steps 2–3 are on the owner card. The plan handles this; the risk is that the card is not run for weeks because nothing forces it.
2. **A silent re-arm comes back through a regeneration.** Someone regenerates for an unrelated geometry change with a stray variable set, and a re-introduced positive mode line is pinned as truth. T2 goes red on the committed corpus at the next `cargo test`, and after E1b only the exact value `1` regenerates. Covered; this is what T2 is for. What would defeat it: hand-editing a golden to make T2 green, which the README and the plan forbid.
3. **The regeneration step misleads the relay.** Step 5's `golden_tests` run shows T2 red (it read the corpus mid-rewrite), Ted reads it as a defect or re-runs with `=1` "to be sure", and the report quotes a confusing pass/fail history. No safety consequence, but the report gets muddier exactly where Razor has to trust it. Must-fix 5 removes it.

### Load-bearing assumptions
- **A1. Every `G1` the engine emits carries its own `S`.** Confidence: high, verified at 12 templates and across all 16 goldens. If wrong, a burning move would inherit `S0` and go dark (a cut fails, not a fire); T1 I4 and KE-M11 are the falsifiers.
- **A2. `$31 < $30` on the owner's controller.** Confidence: high (probe log 2026-09-14). If wrong, every `S` maps to PWM-max, which is a pre-existing catastrophe this batch neither causes nor cures; START's power-scale readback pin covers `$30` but not `$31`. Worth one line in the plan's Risks.
- **A3. The fork treats `S0` on an enabled spindle as off.** Confidence: medium; stock says yes, the fork is unqualified, and the raster hoist has shipped this shape since F4 without a reported dot (absence of a report, not evidence). Card steps 2–3 are the resolution; it cannot be resolved before implementation and does not need to be, since the change is monotone-safer.
- **A4. Stock re-arms the laser at the next `G1 S<n>` in M3 laser mode.** Confidence: high, verified in `stepper.c` (per-block PWM update). Not cited in the plan; must-fix 7.

### Inversion: what would have to be true for a rejected alternative to win?
- **Fix only site A (the one stock lights).** Wins if the controller were stock GRBL. It is not: DECISIONS 2026-09-05 records behaviour stock says is impossible. Not true; the eight-site fix is right.
- **Emit M3 layers as `M5` until the first `G1` and put the mode on the `G1` line** (pre-registered option a). Wins if the fork lights at `S0`. Unknown until the card; the plan correctly defers it and pre-registers the question.
- **Leave the engine alone and rely on M4 being the default.** Wins if no operator ever selects M3 for a cut. The 2026-09-10 ruling keeps M3 selectable and projects on disk keep their stored mode, so M3 cuts exist today. Not true.
- **Fix Deferral 4 (`laser_on = true` after site F) now.** Wins if the redundant-line removal were cheaper than the sync it causes. It costs I5's line-count rule and a second classifier class for one rare combination that no golden reaches. Correctly deferred.

## Overall verdict

**CONCERN.** The design is right and the evidence is unusually good: the firmware claim is traced correctly, the eight sites are the complete set, every `G1` demonstrably carries its own `S`, the classifier is sound and tested both ways, the anchors are unique by simulation, the controls are real, and the hardware card is named without being claimed. What needs fixing is wiring and wording in the verification and the owner card: a "Killed by" column that credits a test which cannot kill, a matrix file name that collides across power modes, a Razor step that cannot run as written, a regeneration filter that runs a reader against files being rewritten, a disk figure that is already stale, and a visible behaviour change Lee will notice before anyone tells him. None of it changes a line of the engine edit.

## Must-fix (prioritised; 1–5 before ExitPlanMode, 6–9 fold as text)

1. **Correct the "Killed by" column:** remove T2 from KE-M1 to KE-M10. T2 asserts on committed goldens and cannot be turned red by a code mutant. Kills stand via T1 and the golden compares.
2. **T5 file naming:** write `target/arm-matrix-out/<label>_<constant|variable>.gcode` (24 files) and pair by that name in T4; add the 24-file count to T4's "same file sets" check.
3. **Razor's re-run:** the before-matrix is built with T5 at **Commit 1**, not at the relay base (`arm_matrix()` does not exist at the base).
4. **Owner card and close report, plain words:** "After a fill, the perimeter cut on the same layer now starts from a brief stop; under constant power its start corner will show more burn than before." Run card step 5 in M3 as well, or state that the M3 case is the 2026-09-10 ruling's territory and untested.
5. **Step 5:** filter `golden_tests::golden_` (or `--test-threads=1`) so T1/T2 do not run against a corpus mid-rewrite, and state that step 5's pass/fail is not consulted; steps 6 and 7 are.
6. **Disk:** the plan cites 92%; it is 94% with 30 GB free and 33 GB in kerf worktrees. Add a free-space precondition before step 5 and before the battery, or remove the six finished relay worktrees first (hand-off names them).
7. **Cite the stepper:** `stepper.c:845` and `:958-970` (per-block PWM update in laser mode) are the reason `M3 S0` then `G1 S<n>` still burns; add beside the parser citations.
8. **One line for E1b's T12:** this batch adds no reader of `KERF_UPDATE_GOLDEN` (compile-time `env!` only) and none may be added.
9. **Risks, one line:** `S0` is PWM-off only while `$31 < $30`; the owner has `0 < 1000`; START's readback covers `$30`, not `$31`.
