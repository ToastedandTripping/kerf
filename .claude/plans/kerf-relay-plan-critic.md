# Critic — Kerf Relay Implementation Plan (week of 2026-09-20)

**Plan:** `kerf-relay-plan.md` (same directory)
**Rubric:** `~/marvin/rules/plan-critic-rubric.md` (v2)
**Critic:** Fable (separate subagent). `scripts/reviewer-tier.sh status` reads `fable`, so no Codex run was attempted — this is the valve's answer, not an inference from the rubric text.
**Date:** 2026-09-21
**Tree verified against:** `origin/master` = `335d598`, checked out at `~/.local/share/marvin/worktrees/kerf/session-1b2844` (clean; the same worktree the plan's citations were spot-checked in). The primary `/home/leesalo/Projects/kerf` is on `master` at `27ffc9c`, 17 commits behind, clean, with 11 worktrees registered — all three facts match the plan. No project file was modified by this review.

---

## Applicability block

**Project type:** desktop laser-cutter control app (Tauri v2 / Rust + React + Zustand), public OSS repo, owner's hardware is a vendor-forked GRBL controller. The plan is a multi-phase relay program: host-only code batches (A, C2, D1), a Python diagnostic the owner runs on hardware (C1), state reconciliation (A0, C3), and a hardware-adjacent stop-path rebuild (B) gated on Lee.

| Dimension | Fires? | Why | Tag |
|---|---|---|---|
| Core 1–10 | always | — | **GATING** |
| X1 Physical & human safety | **Yes** | Every batch touches G-code generation, the `$32` laser-mode gate, jog motion, the abort/stop path, or a script that energises the beam on the owner's machine (C1, L6). | **GATING** |
| X2 Privacy & data stewardship | No | No personal, health, child, or client data anywhere in scope. The firmware identity string is *hardware* identity under the project's own "Public repo" rule; that is reviewed under core 5 (Security), not X2. | N/A |
| X3 Evidence & source integrity | No | The plan consumes the abort-policy research and the astra audit; it produces code and a procedure, not research, civic analysis, or public factual claims. Load-bearing citations are checked below under Verified claims instead. | N/A |
| X4 Audience, brand & money | No | Nothing client-facing, no money, no signature. `docs/qualification-card.md` is public-repo documentation, covered by core 5 and core 10. | N/A |
| X5 Concurrency & re-entrancy | **Yes** | Streaming pump, shared command lock, connection epoch (B1), status polling racing console writes (A1), six relays editing `connection.ts` in parallel. | **GATING** (X1-class plan) |
| X6 Operability & observability | Yes | The app is released to the owner; console messages are the only field evidence; C2 exists to add evidence. | ADVISORY |
| X7 Self-modification safety | No | The plan changes no MARVIN hook, gate, skill, or automation. Its "Stage 0 guard for Lee's zone" is orchestrator prose, not a hook — noted under core 7 as unenforced, but it is not a self-modification. | N/A |
| X8 Dependencies, performance & cost | Yes | Six parallel Opus relays on day 1, Razor pinned to Opus high, mutation batteries that rebuild Rust per mutant; no new packages (fast-check is absent from devDeps and the plan does not add it). | ADVISORY |

---

## Verified claims (against `335d598`)

Legend: ✓ exact; ~ true, line drifted (a lead, per the plan's own caveat); ✗ wrong or absent.

| # | Plan claim | Result | Evidence |
|---|---|---|---|
| 1 | `origin/master` = `335d598`; primary `master` = `27ffc9c`, 17 behind; 11 worktrees | ✓ | `git rev-parse`, `git rev-list --count master..origin/master` = 17, `git worktree list \| wc -l` = 11 |
| 2 | DECISIONS at `origin/master` carries the 2026-09-20 abort ruling; the primary's copy lacks it | ✓ | `git diff --stat master origin/master -- .claude/DECISIONS.md` = +5 lines; heading "Abort sends 0x18 immediately — no feed hold, no M5, no ack wait" at line 95 of the origin copy. Body says "then clear host state and wait for the reset banner with a bounded timeout" and "Retain the 0x18 write-failure retry" — B1's "bounded banner wait" and retained retry are consistent with the ruling, not an addition to it. |
| 3 | `jobStream.ts` abort sites `:254-266` / `:392-405`: `await send("M5")` then `softReset()` | ✓ | `:257` M5 / `:262` softReset; `:396` / `:401`. `pauseJob` `:35`, `resumeJob` `:78`. `Hold:0` poll at `:46-47`. |
| 4 | `jobStream.ts:186` is the single `invoke("serial_stream_job", { gcode, channel })` call | ✓ | `:186` exactly; `:151` reads `event.lineIndex!` |
| 5 | `connection.ts`: `emergencyStop` `0x21` at `:548`, `0x18` at `:560`, retry `:581`; `softReset` `:489`; `feedHold` `:501`; `enableLaserMode` `:646-670` with `accepted = responses.some(ok)`; `queryGrblSettings` `:672` | ✓ | All exact. `emergencyStop` body opens `:535` (doc comment from `:522`). `accepted` at `:652`. |
| 6 | `connection.ts` `jog` `:408-439` clamps with `Math.max(0, Math.min(bed, dest)) - pos`, no `originTop`, unverified path sends raw; `jogTo` `:441-451` clamps absolute, no `originTop`; neither emits `G21` | ✓ | `:424-431` clamp; `:436-438` raw send when unverified; `:448-451` jogTo; strings are `$J=G91 …` / `$J=G90 …` |
| 7 | `FS:` detector block `:367-391`, fires once via `prevSpindleSpeed`, guarded by `startsWith("run")` | ✓ | `:371` regex, `:376` run guard, `:390` prev update |
| 8 | `canStartJob.ts:144` gate; `isWithinBounds` `:67` takes `originTop` | ✓ but incomplete | `canStartJob` **already** calls `isWithinBounds(…, state.originTop)` at `:176` on `state.gcodeResult.moves`. The plan's "add the originTop-aware bounds check as part of the same call" is already true for START/FRAME; what is missing is a way to pass *material-test* extents, and `canStartJob` also requires `gcodeResult` non-null and `!gcodeStale` (`:170-171`) — see core 2. |
| 9 | `MaterialTestDialog.tsx` `handleSend` `:389-412`, `handleFrame` `:415-441`, both call `isWithinBounds(ext, w, h)` without `originTop`, then `streamJob()` | ✓ | `:400` and `:429` omit `originTop`; `:411` / `:440` `streamJob`. `showLaserWarning` at `:444` (plan `:443`). `generateMaterialTestGcode` `:96` (plan `:100`), `startX/startY = 10 + labelMargin` `:127-128`; `generateFrameGcode` `:261`. |
| 10 | `Console.tsx` `handleSend` `:26-41` just sends | ✓ | `:36` `machineConnection.send(cmd)` |
| 11 | `storeTypes.ts:114-115` = `grblSValueMax`, `grblLaserMode`; the store "already uses an unverified sentinel for not-read" `grblSValueMax` | ✗ on the sentinel | File is `src/app/store/storeTypes.ts` (plan gives no path). `grblSValueMax` is hydrated from localStorage with a **1000 fallback** (`store/index.ts:547-556`), and `setGrblSValueMax` flips `gcodeStale` on change (`:581`). There is **no** unverified sentinel; the Ted brief ("find it — do not invent one") dead-ends. |
| 12 | `serial.rs`: `serial_stream_job_inner` `:535`; `job_abort` cleared `:541`; unconditional `$32=1` write `:550-565` with a comment citing the DECISIONS pin | ✓ | `:550` comment, `:563` `write_all(b"$32=1\n")` |
| 13 | A1 edits `serial.rs` "`:550-565` only" | ✗ | The Tauri wrapper `serial_stream_job` at `:666` must gain the `laser_mode_verified` argument, its doc comment at `:663` asserts the write, and **`pin_stream_writes_dollar32_first` at `:1209-1239` asserts `written_str.starts_with("$32=1\n")`** — it goes red the moment the write is deleted. The plan names none of the three. |
| 14 | `serial_get_status_inner` `:459` uses `try_lock` | ✓ | `:460`; PIN 2 test at `:1083` pins the try_lock |
| 15 | `#[serde(tag="type", rename_all="camelCase")]` on `enum JobEvent` (`:515`) renames variants, not `line_index` (`:520`); TS reads `lineIndex` | ✓ | Correct serde semantics (field renaming needs `rename_all_fields` or per-variant attributes). |
| 16 | `sim_integration` from `:1285`; `wedged_pump_estop_then_disconnect_tears_down_cleanly` `:1594`; `estop_volley_resets_and_clears_spindle` `:1790` | ✓ | exact |
| 17 | `serial_pump.rs:186-196` three consecutive Idle probes → `Disconnected("terminal lost…")` | ✓ | `:186-193` |
| 18 | `sim/grbl.rs`: `$$` hardcodes `$32=1` (`:510`); any `$N=V` accepted with `ok` (`:516-519`); `drop_ok_at_line` (`:554`); status line (`:571`) has no `A:` | ✓ | `:510`, `:514-518`, `:554`, `:571` (`<{}|MPos:…|FS:0,0>`). Stock 128 / 15 at `:158-159`. |
| 19 | A2 "expected at tip": `synthesizeFillContour` (`:156-194`) returns `null` for `cornerRadius 0`; Rust has `"line"` `:420`, `"fill"` `:701`, `"offsetFill"` `:807`, **no `"fillLine"` arm**, `other =>` `:987-993` emits a comment and skips | ✓ | All exact. Traced the TS dispatch too: `paths` stays empty for a sharp rect, `effectiveMode` stays `fillLine` (`:402-414`), `buildCutLayer` passes `mode: layer.mode` through (`:85`), and the line overlay is skipped because `hasClosed` is false (`:511-513`). The whole object is dropped, not just the fill. Golden `04_fillline_mixed_layer` uses maskFill + overlay, so no existing golden encodes the drop — A2's "existing goldens do not move" holds. |
| 20 | `commands/gcode.rs:426` `KERF_UPDATE_GOLDEN` `.is_ok()`; messages `:421`, `:435`, `:445`; `generate_gcode` returns `Result` | ✓ | exact; `generate_gcode -> Result<GcodeResult, String>` at `:33-40`; engine `generate_gcode -> Result` at `gcode_gen.rs:361` |
| 21 | `scripts/probe-grbl.py`: `0x9E` in the pause case `:394`; `$23` sign guessing `:467`; no `--dry-run`/`--stop-on-fault`/`--case`/`--origin-*`; default `$30` of 1000 | ~ / ✗ | `0x9E` at `:404`; `$23` at `:293`, `:480-493`. The new flags are indeed absent. **There is no `$30` read and no explicit 1000 default** — `--smax` defaults to 10 with a comment assuming a 1000-scale (`:19`, `:438`). C1 test #4's mutant "restore the default 1000" targets an assumption, not a line; the brief should say so. The probe also never reads `$32` before its `M3`/`M4` cases — see X1. |
| 22 | `scripts/probe-20260914-153729.log` is tracked; `.gitignore:38` is the Python-bytecode block | ✓ | `git ls-files scripts/` lists it; `.gitignore:38` |
| 23 | `machineJobLoop.test.tsx:278-289` is the STOP test asserting `0x21` then `0x18` | ~ | Test opens `:278` and closes at **`:301`**; the zone table's range is 12 lines short. |
| 24 | The batch 0.2 `it.fails("R4/R11 …")` cross-job test lives where B3 says | ✓ | `src/lib/machine/__tests__/jobStream.test.ts:191`; B3 lists `jobStream.test.ts`. |
| 25 | Baseline 768 JS (767 + 1 `it.fails`), 260 Rust with `--features sim` | ✓ / ~ | 767 `it(`/`test(` + 1 `it.fails(` = 768. 243 `#[test]` attributes by grep; the 260 figure is the handoff's `cargo test` count with sim, not re-measured here — Ted's first report must state its own baseline. |
| 26 | `fast-check` absent from devDeps | ✓ | not in `package.json` |
| 27 | No `M7/M8/M9` in `gcodeGen.ts`; `MachinePanel.tsx:617` wording | ✓ | `:617` "Laser mode ($32=1) — M4 dynamic power active". **`LayerPanel.tsx:511-539` for Air Assist is wrong** — the toggle is at `:787-789`. E-track, harmless. |
| 28 | `relay-load` finds a plan by its companion `{name}-critic.md`; `plan_section` extraction from `### ` batch headings | ✓ | `relay-load/SKILL.md:21`, `:109-119` |
| 29 | Battery spec = `test_command` argv + `mutants`; any runner (Python `unittest`) works | ✓ | `mutation-battery.mjs:1543-1553`. **But** the copy is a `git worktree add` + untracked files with `node_modules` symlinked (`:171-191`); the gitignored `src-tauri/target` (7.8 GB here) is *not* carried, so every Rust mutant runs a cold `cargo test --features sim` build under a 300 s per-mutant / 30 min total default (`:125-128`). See core 9. |
| 30 | "Worker model: Opus low-effort (Ted); Razor inherits the session model" | ✗ | Marvin `.claude/DECISIONS.md:150`, amended 2026-09-19 by Lee: Ted → Opus **medium**; Razor → Opus **high, pinned**. `state/current.md:89` agrees. The plan's ground rule 10 is two days stale. |
| 31 | `.claude/plans/` is tracked in kerf | ✓ (and it matters) | `git ls-files .claude/plans` lists the 0.1/0.2 plan + critic pairs. The plan's dispatch step 1 writes per-batch plan files into the *primary's* `.claude/plans/`, but every relay spawns in a fresh worktree from `origin/master`, where those files do not exist. |
| 32 | Parking Lot indexes the plan's "deliberately not in" items | partial | Indexed: Gate D2, Phase 2 streaming / 2B (WS6 line), cross-object scan merging, Min Pwr, laser-stops-firing root cause, "resend" recovery (`ROADMAP.md:537`). **Not indexed:** PLAN 2.6 numeric bounds; the PLAN 2.3 re-specification (G9 corrections). |
| 33 | `ARCHITECTURE.md`, `docs/test-card.md`, the abort research report, `CHARTER.md` exist | ✓ | all present. Test card step 6 (`:57-62`) describes a resumable pause ("picks back up cleanly on Resume") — E2's premise holds. |
| 34 | E5 cites `Viewport.tsx:1355-1362` (Pixi ascent) | ✗ (lead) | File is `src/components/viewport/Viewport.tsx`; no `ascent` token in it. E-track; re-derive before dispatch. |

Thirty-four checked; 24 exact, 5 drifted-but-true, 5 wrong or absent. The five wrong ones are all fixable in the plan text and none invalidates a batch's purpose; two of them (11, 13) would stall A1 at Stage 1 if left as written.

---

## Core dimensions (all gating)

### 1. Problem-fit — **CONCERN**
`## Intent (grilled)` is present with a written skip line, and every batch names its audit finding and PLAN lineage. Kerf's DECISIONS are respected on every point I could test: A1 replaces write-on-START with a check (the 2026-09-10 START ruling rejected auto-enable); B1's bounded banner wait and retained retry are inside the 2026-09-20 ruling's own text; B4's pause-as-stop is the 2026-09-10 pause ruling's stated fallback; A0's amendments are strike-through, headings untouched. The concern is a *marvin* ruling: ground rule 10 states the worker/gate models as "Opus low-effort / Razor inherits", which Lee amended on 2026-09-19 to Ted Opus medium and Razor Opus high pinned (marvin DECISIONS:150). A relay briefed from this plan would spawn Razor weaker than ruled. **Fix:** rewrite ground rule 10 and the "Opus-tier workers" sequencing header to the 2026-09-19 policy; the Codex/haiku valves being OFF for this project is unchanged and correct.

### 2. Approach soundness — **CONCERN**
The architecture is right: one admission function for four doors, fail-closed jog envelope, a check-not-write in the buffered path, the sim gaining the fixtures the gates exist for, and repro-before-fix on A2. Three specifics are wrong as written:
- **A1, `grblSValueMax` invalidation:** there is no sentinel to set (claim 11). Setting it to anything would also flip `gcodeStale` and change the power scale used by generation — a side effect outside A1's stated scope (`$30` readback is PLAN 2.1). **Fix:** A1 invalidates `grblLaserMode` only and prints the warning; record `$30` staleness as PLAN 2.1's job. If the orchestrator wants a settings-verified flag, add a new boolean (`grblSettingsVerified`), not a sentinel on a number that feeds G-code.
- **A1, `canStartJob(state, ext?)`:** the function also requires `gcodeResult` non-null and `!gcodeStale` (`canStartJob.ts:170-171`). Routed unchanged, the material grid refuses whenever no design G-code is generated or it is stale — a false refusal that will read as a regression. **Fix:** when `ext` is supplied, the bounds check uses `ext` and the `gcodeResult`/`gcodeStale` checks are skipped; the `workspaceVerified`, idle-state and `grblLaserMode` checks apply to all four doors. Name the two behaviour changes the material test inherits (idle required; bed must be verified) in the brief and in the dialog copy.
- **A2 test #4** sets `KERF_UPDATE_GOLDEN=0` in-process; cargo runs tests in parallel threads sharing one environment, so the test can race every other golden test (harmless with the fix, noisy under the mutant). **Fix:** extract `fn golden_update_requested(v: Option<&str>) -> bool` and test that pure function; the env-var read stays one line.

### 3. Completeness — **CONCERN**
- A1 must name `pin_stream_writes_dollar32_first` (serial.rs:1209) as the test it **retires and replaces** with tests 7/8, and must include the `serial_stream_job` Tauri wrapper (`:666`) and its doc comment (`:663`) in its file list. As written ("`:550-565` only") the batch cannot compile.
- Lee's-zone table: the STOP test spans `:278-301`, not `:278-289`.
- A0 step 5 annotates PLAN's `BLOCKED ON DECISION` labels on 1.1/1.5/2.1/2.3/3.1/4.1 but PLAN also carries them on 3.2 (`:337`), 4.2 (`:392`) and 4.3 (`:408`). Annotate all nine or say why three are skipped.
- A1's file count is nine (six source + three test files, `serial.rs` counted once), not seven.
- C1 test #4's "default 1000" mutant targets an assumption, not a line (claim 21) — say so, or the battery journal will show a mutant that cannot be applied.

### 4. Right-sizing & reuse — **CONCERN**
Reuses `canStartJob`, `isWithinBounds`, the 0.1/0.2 harnesses, the battery, the two writer scripts — nothing rebuilt. Two rubric misses: (a) A1 is nine files across three subsystem roots (`src/components`, `src/lib/machine`, `src-tauri`) with no waiver line; the rubric requires one above eight. Either split the Rust half (`serial_stream_job_inner` check + tests 7/8) into A1b, or write the waiver ("the four doors and the buffered path must flip in one merge so no window exists where one door writes and another checks"). (b) Out-of-scope items must be indexed in the Parking Lot: PLAN 2.6 and the PLAN 2.3 re-spec are not (claim 32). Add both index lines in A0, which already edits the ROADMAP.

### 5. Security — **CONCERN**
No secrets, no auth, no network. The exposure is the repo being public under the DECISIONS "Public repo" rule. C3 removes the log; the plan then creates two new public files that could reintroduce the same string: `scripts/test_probe_grbl.py`'s scripted reply table (a realistic `$I` fixture is the vendor string) and `docs/qualification-card.md`. D1's "captured profile" doc comment names numbers already in the public DECISIONS entry, so it adds nothing new. **Fix:** one ground rule — no `$I`/`[VER:…]`/vendor string in any tracked file, fixtures included; C1 fixtures use a synthetic identity, and Razor's C1 review greps for it.

### 6. Failure modes — **PASS**
Good discipline throughout: `--ff-only` refuses rather than merges; A2 reports `NEEDS_CONTEXT` on a non-repro; A1 reports `BLOCKED` if the call site cannot be changed outside Lee's ranges; jog refuses on an unverified frame; a missing Tauri argument is a rejected invoke, so the Rust check cannot fail open on an old caller; the sim `error:3` fixture and the wedge fixture cover the two junk-reply shapes the hardware has produced. One note for the brief: a `$$` readback that parses no `$32` line at all (vendor firmware omitting it) must leave the flag false — A1 test #5 covers `$32=0`, not "absent"; add the absent case as a control.

### 7. Change safety — **CONCERN**
Every code change lands on an unpushed relay branch from `origin/master`; DECISIONS goes through the writer; C3 copies before it deletes; A0's fast-forward is the only write to `master` and is a reset away from undone. Three gaps:
- **"Relay branch not pushed; Lee merges."** Lee's standing feedback is that he is never asked to run git or review diffs, and an in-conversation yes is the authorization for the agent to run the push with backup and log. The merge order the plan specifies (A0 → A1 → C2 → A3 → A2 → D1 → C1 → C3) should be executed by the orchestrator on Lee's yes, per branch, and the plan should say so.
- **Plan files never reach the worktrees** (claim 31). `relay-load` searches `.claude/plans/` in the worktree it runs in. **Fix:** A0's `relay/a0-state` branch commits every per-batch plan + critic pair, and day-1 relays branch from *that* (or the orchestrator copies the pair into each worktree before Stage 0). Otherwise `relay-load` silently picks the most recent plan with a critic file — the 0.2 remediation plan.
- A0 step 1 fast-forwards the primary. Check for a live session in `/home/leesalo/Projects/kerf` first (`pgrep -af 'claude.*Projects/kerf'`); a session mid-edit at `27ffc9c` would have its tree moved under it.
The "Stage 0 guard for Lee's zone" is prose with no hook behind it — acceptable for one week, but say it is manual so nobody reports it as enforced.

### 8. Data integrity & compatibility — **PASS**
`.kerf` files are untouched; forward-version refusal already holds; goldens only change by deliberate addition; the `line_index` fixture is produced by the real serializer, never hand-typed. A2's `Err` on an unknown mode is the intended behaviour change and is loud by design. Removing the `grblSValueMax` sentinel idea (core 2) is what keeps generation's power scale single-sourced.

### 9. Verifiability (incl. testing the tests) — **CONCERN**
The strongest part of the plan: every batch has a mutant table, every test drives the production body or the rendered component, controls are marked as controls, and the battery journal is the acceptance artefact. Two operational holes will produce false "battery failed" journals on day 1:
- **Rust mutants are cold builds.** The battery's copy is a worktree plus untracked files; `src-tauri/target` (7.8 GB) is gitignored and not carried, so each Rust mutant rebuilds from nothing under the 300 s default. A1 has two Rust mutants, A2 three, D1 seven — D1 alone likely exceeds the 30 min total. **Fix:** before day 1, run one Rust mutant through the battery and time it; set `per_mutant_timeout_ms`/`total_timeout_ms` in every Rust spec from that measurement; if a cold `cargo test --features sim` exceeds the ceiling, establish whether the battery permits `CARGO_TARGET_DIR` pointing at a pre-warmed directory (read its write rules; do not assume) and record the answer in the dispatch mechanics.
- A2 test #4 as discussed under core 2.
Minor: A1 test #3 needs a rendered `Console` and a rendered `JobActionBar` in one test with the recorder; feasible (both are components) but the brief should say the test renders both rather than calling `handleSend` directly, or it proves nothing about the hook's placement.

### 10. Maintainability — **CONCERN**
A0 refreshes ROADMAP, handoff and DECISIONS; the record-the-material-test-defect entry (A3) is the right bucket. Missing: `ARCHITECTURE.md` is named as stale on `sim/` and the `_inner` extraction, and D1 (five sim additions), B1 (new `serial_session.rs`) and B2 (new `grbl_status.rs`, `machineStatus.ts`) make it staler. Add a one-paragraph ARCHITECTURE delta to D1's and B1's file lists (the project-docs rule asks for additions *and* removals). Also add the retired `pin_stream_writes_dollar32_first` to A1's report so the next reader knows why the pin moved.

---

## Conditional dimensions

### X1. Physical & human safety — **CONCERN** [GATING]
Every code path in Phases A–D ends fail-closed: `$32=0` refuses at four doors (A1); an unverified or mismatched frame refuses rather than clamps (A3 — and I checked both mismatch directions: `originTop` wrong in either sense puts the position outside the envelope, so nothing sends); an unknown layer mode errors rather than skips (A2); nothing energises a beam on a host. Hardware-only paths are named (L6, session A) and not silently skipped. The one powered entry point the plan builds without the gate it spends Phase A installing is **the probe itself**: C1 sends `M3`/`M4 S{smax}` in every variant (`probe-grbl.py:299-309`) and never reads `$32`. Under `$32=0` GRBL keeps the spindle energised through `G0` rapids, so the box traverses at S10 with the beam on — 1 % power on scrap, operator-run, dry-run reviewed, so not a FAIL, but it contradicts the plan's own thesis that every powered door shares one admission. **Fix:** C1 refuses any `M3`/`M4` case unless the `$$` readback contains `$32=1` (recorded, not assumed), with a `--allow-constant-power` override that prints what it means; add it as C1 test #8 (mutant: drop the check). Also state in the qualification card *how* "beam-disabled verification of `--x-dir/--y-dir`" is achieved (M5 + S0 moves, or a physical interlock) — "beam-disabled" is currently a phrase, not a mechanism. Worst-case named per failure: probe fault → `0x18` first, bounded capture, no replay ✓; wedge during a case → `--stop-on-fault` ✓; KeyboardInterrupt → same cleanup ✓.

### X5. Concurrency & re-entrancy — **CONCERN** [GATING]
B1 is PLAN 1.1 verbatim with the barrier test and the second cold read — correct treatment. Two smaller races are not addressed:
- **A1 invalidate vs. readback ordering.** Console `$32=0` invalidates the flag; a `queryGrblSettings()` already in flight (connect path, or `enableLaserMode`'s new readback) parses a `$$` captured *before* the write and sets the flag true after the invalidate. **Fix:** a monotonically increasing settings-generation counter — invalidate bumps it, a readback only applies if it started at the current generation. One integer, one test (mutant: drop the generation check).
- **Six relays on `connection.ts`.** Disjoint functions, merge order given — fine — but A1 and C2 both add store fields/setters (`invalidateGrblSettings`, a current-line setter) in `store/index.ts`/`storeTypes.ts`, which the collision map does not list. Add the store files to the map with the same A1 → C2 order.

### X6. Operability & observability — **PASS** [ADVISORY]
C2 adds the missing correlation datum; A1's invalidate prints a console line; every refusal carries a reason string; the battery journal and Ted's counted report are the operational evidence. The worker-tier valve is currently unreadable (`scripts/worker-tier.sh status` errors: launcher config not found), so the orchestrator cannot confirm which tier Ted spawns on — resolve before day 1 or state the tier by hand in each spawn.

### X8. Dependencies, performance & cost — **CONCERN** [ADVISORY]
No new packages; fast-check correctly avoided. Cost is the concern: six relays on day 1, each Ted (Opus medium) + Razor (Opus high) + a battery that cold-builds Rust per mutant, plus per-worktree `npm ci` and `cargo build --features sim` warm-ups. The plan asks for the warm-up time to be recorded, which is right; it should also stage day 1 as A1 + C1 + D1 first (the three that matter) and start A2/C2 when a slot frees, unless quota is known to be ample. Timeouts per core 9.

---

## Stress tests

### Pre-mortem — three months out, this failed
1. **Phase B never started because L1 was a phantom.** The audit found no uncommitted source in any of eleven worktrees; Lee's standing profile is that he does not run git. The plan takes "Lee is patching by hand" from the brief, freezes the only files that fix the M5-before-reset violation, and waits. What we would have seen: L1 answered with "what patch?" — or not answered, because the question presumes the patch. Type-specific worst case: the wedge fires mid-job, the abort path awaits an unacked M5, and the head sits parked with the beam commanded on for a second stall. **Fix now:** L1's recommendation becomes (b) — hand the patch to B4 as a relay Lee reviews — *unless* Lee says a diff exists; the zone freeze holds only while his answer is pending, not for a month.
2. **A1 shipped a material test that never runs.** `canStartJob` refuses without generated design G-code; the operator with an empty canvas gets "Generate G-code first" on the material grid, reports it as broken, and the gate is reverted wholesale to restore the feature. Worst case: the four-door gate is gone again and `$32=0` starts from the material dialog. Fix under core 2.
3. **Day 1 produced eight battery journals and no green ones.** Rust mutants timed out at 300 s in cold copies; `relay-load` loaded the 0.2 plan because the batch plans were not in the worktrees; the orchestrator improvised the tier and skipped a gate to keep the day moving. Worst case is procedural, not physical, but it is how the v0.8.28 pause "fix" got in: tests that could not be made red. Fixes under core 7 and 9.

### Load-bearing assumptions
| Assumption | Confidence | If wrong | Resolve before |
|---|---|---|---|
| Lee has an abort patch in progress in a checkout the audit cannot see | **Low** (no evidence in any worktree; contradicts his profile) | Phase B is gated on nothing; a week lost on the highest-risk defect | L1, day 1 — and flip the recommendation to (b) |
| `origin/master` stays at `335d598` until A0 lands | Medium | Every citation moves; the plan already says re-verify, so cost is time, not correctness | A0, hour one |
| The TS `grblLaserMode` flag is a trustworthy authority for the Rust check this week | Medium-high after A1 (readback + invalidation), **provided the generation counter lands** | A `$$` racing a console write leaves the flag stale-true; the Rust check passes a job GRBL runs with the beam on through rapids | X5 fix, in A1 |
| The battery can run `cargo test --features sim` per mutant inside its defaults | **Low** (7.8 GB target not copied; 300 s default) | Every Rust batch is returned to Ted for "a mutant that stayed green" that actually timed out | Pilot one mutant before day 1 |

### Inversion — when would a rejected alternative win?
- **Restricted envelope instead of full feature set** (rejected by Lee 2026-09-10): would win if G9's corrections turn out to need Gate D2's engine, which is unmade — then "full feature set" means shipping known-wrong geometry. That condition is *partly true today* (the plan itself says 2.3 must be re-specified and D2 is open). Not this week's call, but the re-spec task the plan schedules "after Phase B" should be the one that re-asks it with numbers.
- **One combined A1+A3 relay** (audit offered it): would win if the material-test refusal introduced by A1-before-A3 is unacceptable for the day between them. On an origin-top machine A1 alone makes the material grid refuse *correctly* until A3 lands — that is the plan's stated reason for the order, and it is sound; the alternative only wins if Lee needs a material test that day.
- **Agents start B1 now and rebase** (L1 option c): wins if L1's patch does not exist. Given the assumption table, this is likelier than the plan admits; the plan's structure (A/C/D1 first) is robust either way, which is its best property.
- **Hand-rolled mutation loop instead of the battery** for Rust: would win only if the battery cannot be made to fit a cold Rust build in its ceilings. That is exactly the unmeasured condition above — measure it rather than argue it.

---

## Overall verdict

**CONCERN — not a blocking FAIL on any gating dimension, but not dispatchable as written.** The plan's design is sound and unusually well-grounded: 24 of 34 citations are exact, the fail-closed logic in A1/A3 survives both mismatch directions, repro-before-fix and battery-as-acceptance are the right discipline, and keeping Phase A/C/D1 outside Lee's zone means the week produces value whatever L1 says. What stops it are five text-level defects that would stall A1 at Stage 1 (a sentinel that does not exist, a gate that would refuse the material test, a pin test that goes red unnamed, a Tauri wrapper outside the "only" range), two operational holes that would turn day 1 into failed journals (plan files not in the worktrees; cold Rust builds under a 300 s ceiling), a stale model policy that would spawn Razor below Lee's 2026-09-19 ruling, and an L1 recommendation built on an assumption the plan's own audit could not find evidence for. All are hours of editing, none is a redesign.

## Must-fix, prioritised

1. **A1:** drop the `grblSValueMax` sentinel (invalidate `grblLaserMode` only; `$30` staleness → PLAN 2.1); make `canStartJob(state, ext)` skip `gcodeResult`/`gcodeStale` when `ext` is supplied; add the settings-generation counter so a racing readback cannot re-arm the flag; name `pin_stream_writes_dollar32_first` (serial.rs:1209) as retired/replaced, and add `serial_stream_job` (`:663-666`) to the file list; add the "`$32` absent from readback" control; count the batch honestly (nine files) and write the over-eight waiver or split the Rust half.
2. **Dispatch:** commit every per-batch plan + critic pair on `relay/a0-state` and branch day-1 relays from it (or copy pairs into each worktree before Stage 0); the orchestrator merges in the stated order on Lee's yes — never "Lee merges".
3. **Battery:** pilot one Rust mutant before day 1; set `per_mutant_timeout_ms`/`total_timeout_ms` per Rust spec from the measurement; establish (by reading the battery's write rules) whether a pre-warmed `CARGO_TARGET_DIR` is permitted, and record the answer.
4. **Ground rule 10:** Ted Opus medium, Razor Opus high pinned (marvin DECISIONS, 2026-09-19); confirm the worker-tier valve is readable before spawning.
5. **L1:** recommendation → (b) unless Lee confirms a diff exists; state the assumption plainly in the question ("the audit found no patch in any checkout").
6. **C1 / X1:** refuse `M3`/`M4` cases without a recorded `$32=1` readback (test #8); state the beam-disabled mechanism in the card; ban the vendor identity string from fixtures and docs, with Razor grepping for it.
7. **A2 test #4:** pure `golden_update_requested(Option<&str>)`; no in-process env mutation.
8. **A0:** Parking Lot index lines for PLAN 2.6 and the 2.3 re-spec; annotate all nine `BLOCKED ON DECISION` labels; `pgrep` for a live session in the primary before the fast-forward.
9. **Zone table:** STOP test is `:278-301`.
10. **Docs:** ARCHITECTURE delta in D1 and B1; collision map gains `store/index.ts`/`storeTypes.ts` (A1 → C2); fix the E-track line citations (`LayerPanel.tsx:787`, `Viewport.tsx` ascent unfound) before any E batch is lifted.
