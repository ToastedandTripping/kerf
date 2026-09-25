## Critic Findings Folded

**Date:** 2026-09-21
**Critic model:** Fable
**Verdict:** CONCERN
**Companion file:** kerf-relay-plan-critic.md

### Key fixes applied to this plan

1. A1: drop grblSValueMax sentinel (invalidate grblLaserMode only); make canStartJob skip gcodeResult when ext supplied
2. A1: add settings-generation counter for racing readback protection
3. A1: name pin_stream_writes_dollar32_first (serial.rs:1209) and serial_stream_job (:663-666)
4. Dispatch: commit plan+critic pairs on relay branch; branch day-1 relays from it
5. Battery: pilot one Rust mutant before day 1; set per_mutant_timeout_ms from measurement
6. Worker policy: Ted Opus medium, Razor Opus high pinned (DECISIONS 2026-09-19)
7. C1/X1: refuse M3/M4 cases without recorded $32=1 readback
8. A2 test: pure golden_update_requested; no in-process env mutation
9. Zone table: STOP test is :278-301, not :278-289
10. Store files (store/index.ts, storeTypes.ts) added to collision map

### NOT FOLDED -- requires Lee's decision

- L1: patch scope/timing (recommendation flipped to (b) unless Lee confirms a diff exists)
- L2: pause becomes stop
- L5: air assist wire-or-remove
- L6: owner session A on hardware

---

# Kerf — Relay Implementation Plan (week of 2026-09-20)

**Source audit:** `kerf-audit-plan.md` (same directory), 2026-09-20 evening.
**Target repo:** `/home/leesalo/Projects/kerf` (Tauri v2 + Rust backend, React 18 + Pixi.js 8, Zustand, vitest, cargo).
**Base commit for every relay branch:** `origin/master` = `335d598` ("decisions: abort policy — 0x18 immediately, no M5, no hold, no ack wait"). **Never branch from the primary's `master` (`27ffc9c`, 17 behind).** Batch A0 fast-forwards the primary; until A0 lands, every relay does `git fetch origin && git checkout -b relay/<name> origin/master`.
**Line citations** below were spot-checked at `335d598` in the `session-1b2844` worktree on 2026-09-20. Agents re-verify before editing; a moved line is a lead, not a finding.

## Intent (grilled)

**Summary:** Close the safety-gate class and the silent-drop defects that sit *outside* Lee's abort-path patch, rebuild the diagnostic tooling and simulator so the next owner hardware session produces evidence instead of a story, and hold Phase B (stop spine) until Lee's patch has merged. Nothing here clears the release block; that needs owner session A on hardware. Phase A is the dispatch starting point because it shares no file with Lee's zone.

**Skip note:** Intent derived from the 2026-09-20 charter-gap audit and the astra remediation `PLAN.md` (`~/marvin/state/audits/kerf-astra-2026-09-08/PLAN.md`). No grill; the audit is the grounding. Every batch lifts its acceptance criteria and required red mutations from a named PLAN batch where one exists.

## Lee's zone — agents do not touch

Lee is patching the abort policy by hand (ruling `335d598`; code still violates it at tip). The following are **off limits to every agent in this plan until Lee says the zone is free**, and Stage 0 (`relay-load`) must refuse a batch whose file list intersects them:

| File | Region | Why |
|---|---|---|
| `src/lib/machine/jobStream.ts` | both abort sites (`:254-266` buffered, `:392-405` per-line: `await send("M5")` then `softReset()`), the teardown at `:413-414`, and `pauseJob`/`resumeJob` (`:35-105`) | the two M5-before-reset violations and the pause volley |
| `src/lib/machine/connection.ts` | `emergencyStop` (`:522-641`: `0x21` at `:548`, `0x18` at `:560`, retry `:581`), `softReset` (`:489`), `feedHold` (`:501`) | the shared stop body |
| `src-tauri/src/commands/serial.rs` / `serial_pump.rs` | `send_byte_inner`, the reset/abort submission path, `job_abort` flag handling | native stop submission |
| `src/components/panels/JobActionBar.tsx` | `handleStop` (`:105`) | the STOP click |
| `src/components/panels/__tests__/machineJobLoop.test.tsx` | the batch 0.2 STOP-dispatch test (`:278-289`, asserts `0x21` then `0x18`) | will go red when Lee's patch lands; **his patch owns the flip**, agents must not pre-empt it |

`connection.ts` is shared by A1, A3 and C2. Those batches edit **only** the named functions (`enableLaserMode`, `jog`, `jogTo`, the `FS:` detector block, and the console-write hook). If Lee's patch touches `connection.ts` first, rebase; if a relay lands first, Lee's patch rebases on a diff that never touches his functions. Either order merges cleanly because the edited regions are disjoint.

**Phase B is the only phase that enters the zone.** It is specified below so it is ready the hour Lee's patch merges, but Stage 0 for any B batch is gated on L1 (Lee-gate, §Decisions).

## Ground rules (inject into every Ted brief via known-constraints)

1. Branch from `origin/master`. Relay branch not pushed; Lee merges.
2. **Read `.claude/DECISIONS.md` at `origin/master`** (the primary's copy lacks the 2026-09-20 ruling until A0). Rulings that bind: abort = `0x18` immediately, no hold, no M5, no ack wait (2026-09-20); one shared stop (2026-09-10); START refuses until `$32`/`$30` written **and read back** (2026-09-10); `$32=1` gate + `perLine` default (2026-07-05/09-10); pause hold-only→stop (2026-09-10); status-only evidence (2026-09-10); full feature set (2026-09-10); Gate D2 unmade; `powerMin ≤ power` double enforcement (2026-09-10); vendor fork (2026-09-05); sim-green unproven until TS exercises the real lock (2026-09-05).
3. **Mutation battery, never hand-rolled.** Every new safety test goes through `~/marvin/scripts/mutation-battery.mjs` with the batch's mutant table as the spec. Apply the wrong change, see red, restore, see green. A test that cannot be made red by its named mutant is not a test.
4. `KERF_UPDATE_GOLDEN` unset in every verification command (`env -u KERF_UPDATE_GOLDEN cargo test …`). Never regenerate goldens to pass a safety test.
5. Zustand: derived array/object selectors use `useShallow`; never return a fresh object from `useStore(s => …)`.
6. No tag, no installer, no version bump. RELEASE BLOCKED stands.
7. Verification contract (PLAN §Relay verification contract): `npm ci --ignore-scripts` once; focused tests per batch; `npx tsc --noEmit` for TS, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` for Rust; at an integration boundary `npm test`, `npm run build`, `npm run lint`, `npm run format:check`, `env -u KERF_UPDATE_GOLDEN cargo test --manifest-path src-tauri/Cargo.toml --features sim`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`. Pre-existing failures are recorded, never counted PASS. Baseline at tip: 768 JS (767 pass + 1 `it.fails`), 260 Rust with `--features sim`.
8. Tests inject into the **same body the Tauri command uses** (`serial_*_inner`, batch 0.1) or drive the **rendered component** through the batch 0.2 recorder (`serialTraceHarness.ts`). A test-local copy of gate logic is forbidden. A TS invoke mock proves UI dispatch only.
9. Every Ted report names the commands run, the counts before and after, and the red/green per mutant. Absent report = failed stage.
10. Worker model: Opus low-effort (Ted; the `haiku`/Codex valves are OFF for this project's safety batches — Lee's 2026-09-10 ruling). Razor inherits the session model. Jen only where a `.tsx` render changes (A1, A3 change dialog copy and gating, not layout — Jen review is a CONCERN pass, not a spec).

## Dependency Graph

| Step | Phase | Depends on | Parallel group | Tier | Lee gate |
|---|---|---|---|---|---|
| A0 | A | — | P0 (run first, alone, 30 min) | Simple (docs + state, no code) | — |
| A1 | A | A0 | P1 | Standard (7 files) | — |
| A2 | A | A0 | P1 | Standard (4 files) | — |
| A3 | A | A1 (shares `MaterialTestDialog.tsx`, `canStartJob.ts`) | P2 | Standard (6 files) | — |
| C1 | C | — | P1 | Standard (3 files, Python + docs) | — |
| C2 | C | — | P1 | Simple (2 files) | — |
| C3 | C | — | P1 | Simple (2 files) | L4 for history rewrite only |
| D1 | D | — | P1 | Standard (3 files, Rust) | — |
| B1 | B | A0, **L1** | P3 | Complex (5 files, concurrency) — needs Razor + second cold read | L1 |
| B2 | B | B1 | P4 (two relays, merge as a pair) | Standard + Standard | — |
| B3 | B | B1, B2 | P5 | Standard (6 files) | — |
| B4 | B | B1–B3, **L1**, **L2** | P6 | Standard (5 files) | L1, L2 |
| D2 | D | B1, B4, D1 | P7 | Standard (4 files) | — |
| E1 | E | **L3** | any idle slot | Simple | L3 |
| E2 | E | B4 | idle slot | Simple | — |
| E3 | E | — | idle slot | Standard | — |
| E4 | E | **L5** for air assist; Min Pwr half is free | idle slot | Simple | L5 |
| E5 | E | E1 | idle slot | Simple | — |

Parallel-safe from hour one: **A1, A2, C1, C2, C3, D1** (six relays, disjoint files, none in Lee's zone). A3 follows A1. B waits on L1. D2 waits on B4.

**File-collision map (the reason for the grouping):**
- `MaterialTestDialog.tsx`: A1 then A3 (sequential). B3 later.
- `canStartJob.ts`: A1 then A3.
- `connection.ts`: A1 (`enableLaserMode`, console hook), A3 (`jog`, `jogTo`), C2 (`FS:` block) — disjoint functions, may run in parallel but **merge order is A1 → C2 → A3** to keep conflicts trivial. Lee's `emergencyStop` region is untouched by all three.
- `serial.rs`: A1 (`serial_stream_job_inner` gate lines `:550-565` only), D1 (sim_integration tests only). B1 later, heavily.
- `gcodeGen.ts`: A2 only this week (E4 later).
- `sim/grbl.rs`: D1 only.

---

## Phase A — Close the gate class and the silent drop

**Goal.** Every powered entry point passes the same admission; the one known silent generator drop becomes a correct lowering or a hard error; jog and material-test geometry respect the machine's frame. Host-only, no hardware, none of it in Lee's zone.

**Phase exit.** Four entry points (START, FRAME, material grid, material FRAME) share one gate; `$32=0` cannot start from any door; a sharp Fill+Line rectangle either cuts (fill + perimeter) or the generation fails loudly; a −1 mm jog cannot become a 248 mm move.

### A0. State reconciliation (no code)

**Tier:** Simple, but it is not a relay — the orchestrator runs it directly with the two writer scripts. Nothing here needs Ted.
**Depends on:** nothing. Run first; everything else reads the state it fixes.

**Steps.**
1. `git -C /home/leesalo/Projects/kerf fetch origin && git -C /home/leesalo/Projects/kerf merge --ff-only origin/master` (primary is on `master`, clean per audit; if `--ff-only` refuses, stop and report — do not merge).
2. `decisions_amend` via `node ~/marvin/scripts/update-decisions.mjs --repo-root /home/leesalo/Projects/kerf --content <ops.json>`, two entries, **strike-through + reason, never delete, headings untouched**:
   - "The Phase 2 abort order is safety-critical and must never contain an ack-awaited write" (2026-07-05): amend — the `!` → settle → `0x18` → conditional M5 sequence is superseded by the 2026-09-20 ruling (`0x18` immediately, no hold, no M5, no ack wait). The "never an ack-awaited write" half stands and is strengthened.
   - "Every abort routes through one shared stop operation, whose feed hold is conditional on verified laser-off behaviour" (2026-09-10): amend — the "conditional feed hold" clause is superseded 2026-09-20 (no hold at all); the "one shared stop operation" half stands.
3. `ROADMAP.md` line 3 `current:` — replace the stale "NEXT: Phase 2 streaming rework" body with the true current state (Phase 0 complete 2026-09-20; Phase 1 unblocked by the abort ruling and in Lee's hands for the two abort sites; this plan's Phase A in flight). Keep `next:` as is except: strike "awaiting the owner's trace log" — it was delivered as `scripts/probe-20260914-153729.log` (and is being moved private in C3).
4. `handoff.md` via `node ~/marvin/scripts/update-handoff.mjs --repo-root /home/leesalo/Projects/kerf --content <ops.json>`: `owed_add` "Lee's abort patch (0x18-immediate) in flight — jobStream.ts abort sites, connection.ts emergencyStop, JobActionBar STOP test are his; agents rebase on it"; `log_entry` for the audit and this plan; `owed_remove` the "awaiting the owner's trace log" clause of the release-blocked bullet is NOT removed (it is inside a larger bullet) — instead `log_entry` records the delivery.
5. Annotate `~/marvin/state/audits/kerf-astra-2026-09-08/PLAN.md` (private register, plain edit): under each `BLOCKED ON DECISION` label on 1.1, 1.5, 2.1, 2.3, 3.1, 4.1, add one line `> Resolved by DECISIONS.md entry "<heading>" (<date>)` or `> Still open` for 2.3 (needs re-spec, envelope ruling says full feature set) and 4.1 (hold cannot be qualified under status-only evidence).
6. Commit on the primary's `master`? **No.** Commit on a `relay/a0-state` branch from `origin/master`; Lee merges. The ff in step 1 is the only write to `master`.

**Acceptance.** `scripts/decisions-check.sh --repo-root /home/leesalo/Projects/kerf` reports the same entry count (amendments add no headings) and no SHRANK; `git log --oneline -1` on the primary equals `335d598`; the ROADMAP `current:` line no longer names Phase 2 streaming as next.

### A1. `$32` gate — caller coverage and staleness

**PLAN lineage:** batch 2.2's caller half (all four doors through one admission), brought forward of 2.1 (readback transaction). 2.1 itself waits for B1's session type; this batch does the part that needs no backend session.
**Findings:** G4 (audit), R6/R7/R12 (astra).
**Tier:** Standard. 7 files. UI: `.tsx` touched (gating + console copy only) → Jen review CONCERN pass, no spec.
**Depends on:** A0.

**Files.**

| File | Change |
|---|---|
| `src/lib/machine/canStartJob.ts` | Export one admission function used by all four doors. Today `canStartJob(state)` (`:144-`) already checks connected / `grblLaserMode` / alarm / idle. Add the `originTop`-aware bounds check as part of the same call (signature: `canStartJob(state, ext?: MovesExtents)`), so a caller cannot pass admission and skip bounds. `isWithinBounds` (`:67-`) already takes `originTop`; the fix is that callers must pass it. |
| `src/components/panels/MaterialTestDialog.tsx` | `handleSend` (`:389-412`) and `handleFrame` (`:415-441`): replace the hand-rolled `machineConnected` / `jobRunning` / `isWithinBounds(ext, w, h)` checks with `canStartJob(state, ext)` and surface its `reason`. Pass `state.originTop` (this half of the frame defect belongs to A3's generation fix; A1 only makes the **check** honest — with `originTop` passed, an origin-top machine will now refuse the positive-Y grid A3 then fixes. That refusal is correct and is the reason A3 must follow A1, not precede it). Keep `showLaserWarning` (`:443`) but it is now redundant with the gate; leave it as copy. |
| `src/components/bottom/Console.tsx` | `handleSend` (`:26-41`): before `machineConnection.send(cmd)`, if `cmd` matches `/^\$\d+\s*=/` (a settings write) or `^\$RST`, call `machineConnection.invalidateGrblSettings()` (new, below). `$X`, `$H`, `$$`, `$I`, `$G`, `$J=` are **not** writes and must not invalidate. |
| `src/lib/machine/connection.ts` | (a) New `invalidateGrblSettings()`: sets `grblLaserMode=false`, `grblSValueMax` to the unverified sentinel the store already uses for "not read" (read `storeTypes.ts:114-115` and the connect path `:194-200` to find it — do not invent one), and adds a console line "Settings changed — re-verify with $$ before starting a job". (b) `enableLaserMode()` (`:646-670`): after the `$32=1` `ok`, call the existing `queryGrblSettings()` (`:672-`) and set `grblLaserMode=true` **only if the readback contains `$32=1`**; an `ok` with no readback, or a readback showing `$32=0`, leaves the flag false and prints the warning. **Do not touch** `emergencyStop`, `softReset`, `feedHold`, `jog`, `jogTo`, the `FS:` block. |
| `src-tauri/src/commands/serial.rs` | `serial_stream_job_inner` (`:535-`): delete the unconditional `$32=1` write (`:550-565`, the drain + `write_all(b"$32=1\n")` + its terminal wait). Replace with a **check**: the command takes a `laser_mode_verified: bool` argument from TS (the TS gate is the authority this week; B1/2.1 moves authority into the backend session). If false, return `Err("$32=1 not verified — enable laser mode and re-read settings")` before touching the port. The comment at `:551` cites the DECISIONS pin as if the write were the pin; the pin says *gate*, and the 2026-09-10 ruling explicitly rejected write-on-START. |
| `src/lib/machine/jobStream.ts` | **Only** the `invoke<string>("serial_stream_job", { gcode, channel })` call at `:186` inside `streamJobBuffered`: add `laserModeVerified: useStore.getState().grblLaserMode` to the args. One line. **Nothing else in this file** — the abort sites (`:254-266`, `:392-405`) and pause are Lee's. If the call site cannot be changed without touching those ranges, stop and report BLOCKED. |
| Tests: `src/lib/machine/__tests__/canStartJob.test.ts`, `src/components/panels/__tests__/machineJobLoop.test.tsx` (new `describe` only; do not edit the batch 0.2 STOP test), `src/lib/machine/__tests__/connection.test.ts`, `src-tauri/src/commands/serial.rs` `sim_integration` | see below |

**Tests required (each is a battery mutant).**

| # | Test | Mutant → RED |
|---|---|---|
| 1 | Material test grid on `grblLaserMode=false` → refuses before any `serial_send`/`serial_stream_job` in the recorder; dialog stays open; reason names `$32` | Delete the `canStartJob` call in `handleSend` |
| 2 | Material FRAME on `grblLaserMode=false` → same | Delete the call in `handleFrame` |
| 3 | Connected, `grblLaserMode=true`; console sends `$32=0`; START (rendered `JobActionBar`) → refuses | Delete the invalidate hook in `Console.tsx` |
| 4 | Console sends `$X` → `grblLaserMode` unchanged | (control — must stay green; a hook that invalidates on every `$` is wrong) |
| 5 | `enableLaserMode()` with a mocked `ok` and a `$$` readback containing `$32=0` → flag stays false, warning printed | Restore `accepted = responses.some(ok)` as the sole condition |
| 6 | `enableLaserMode()` with `ok` + readback `$32=1` → flag true | (control) |
| 7 | Rust: `serial_stream_job_inner` with `laser_mode_verified=false` on a `ScriptedPort` → `Err` and the ordered trace contains **zero writes** | Restore the `$32=1` write / remove the check |
| 8 | Rust: `laser_mode_verified=true` → trace contains no `$32=1` line before the first G-code line | Restore the write |
| 9 | Bounds: material grid whose extents exceed the bed with `originTop=true` → refuses via the same reason path as START | Drop `originTop` from the call |

**Verification.** `npx vitest run src/lib/machine/__tests__/canStartJob.test.ts src/components/panels/__tests__/machineJobLoop.test.tsx src/lib/machine/__tests__/connection.test.ts`; `npx tsc --noEmit`; `env -u KERF_UPDATE_GOLDEN cargo test --manifest-path src-tauri/Cargo.toml --features sim commands::serial`; `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`. Then the full contract. No hardware.

**Out of scope.** The readback *transaction* with backend revision (PLAN 2.1 — needs B1). Generation identity stamping (PLAN 2.2's other half). `GrblSettingsDialog.tsx`. Anything in Lee's zone.

**Risk if wrong.** A gate that only START honours; a stale `$32` flag passing a job that GRBL will run at constant power through every hold.

### A2. Fill+Line rectangle lowering + golden env fix

**PLAN lineage:** batch 2.4 verbatim, prerequisite 2.3 waived (2.3 is being re-specified; 2.4 does not depend on its content).
**Findings:** G6 (audit), R16 + R14 golden gap (astra).
**Tier:** Standard. 4 files. No UI.
**Depends on:** A0.

**Reproduce first (Stage 1 step 1, before any edit).** Through the real `generate_gcode` command path (`src-tauri/src/commands/gcode.rs`), a sharp rectangle (`cornerRadius: 0`) on a layer with mode `fillLine`. Expected at tip: TS `synthesizeFillContour` (`gcodeGen.ts:156-194`) returns `null` for a rectangle with `cornerRadius 0`, and Rust `gcode_gen.rs` has arms for `"line"` (`:420`), `"fill"` (`:701`), `"offsetFill"` (`:807`) and **no `"fillLine"` arm** — the `other =>` fallback (`:987-993`) emits `; unknown layer mode 'fillLine' — object skipped` and drops it. **If the repro does not show the drop, stop, record the result, and report NEEDS_CONTEXT** — the PLAN treats R16 as a lead and the fix must not land against a phantom.

**Files.**

| File | Change |
|---|---|
| `src/lib/machine/gcodeGen.ts` | Lower `fillLine` on a sharp rectangle to a fill contour (four corners, closed) through the same contour path rounded rectangles use, **plus** an explicit closed perimeter as a `line` cut in fill-before-line order. Read the call sites at `:329` and `:395` (audit citations) before deciding whether the lowering happens at synthesis or at dispatch; the invariant is that a `fillLine` object never reaches Rust as a mode Rust lacks. |
| `src/lib/machine/__tests__/gcodeGen.test.ts` | Tests 1–3 below. |
| `src-tauri/src/engine/gcode_gen.rs` | The `other =>` arm (`:987-993`): return `Err(format!("unknown layer mode '{}' on object '{}'", …))` instead of a comment + skip. Callers already propagate `Result` (verify at `commands/gcode.rs`). A comment in the G-code is not an error. |
| `src-tauri/src/commands/gcode.rs` | (a) Golden update mode (`:426`): `std::env::var("KERF_UPDATE_GOLDEN").is_ok()` → `.map(|v| v == "1").unwrap_or(false)`. Update the three message strings (`:421`, `:435`, `:445`) if they say otherwise. (b) At the command return boundary, assert `moves` metadata against independently parsed `X`/`Y` words of the emitted G-code (a small parser in the test module, not production). |

**Tests required.**

| # | Test | Mutant → RED |
|---|---|---|
| 1 | TS: sharp rectangle on `fillLine` → emitted program has a fill pass then a closed 4-segment perimeter, in that order | Restore `return null` for `cornerRadius 0` |
| 2 | TS: the perimeter closes (last point == first) | Drop the closing segment |
| 3 | Rust (`commands::gcode`): a `CutObject` with mode `"bogus"` → `generate_gcode` returns `Err` naming the mode; **no** `; unknown layer mode` comment anywhere in any output | Restore the comment + skip |
| 4 | Rust: `KERF_UPDATE_GOLDEN=0` (set, but not `1`) → golden compared, not rewritten (assert file mtime/contents unchanged after a deliberately mismatched fixture in a temp dir) | Restore `is_ok()` |
| 5 | Rust: moves metadata X/Y for the rectangle fixture equal parsed emitted XY within `1e-3` | Zero move X at the return boundary while leaving G-code untouched |

**Verification.** `npx vitest run src/lib/machine/__tests__/gcodeGen.test.ts`; `env -u KERF_UPDATE_GOLDEN cargo test --manifest-path src-tauri/Cargo.toml commands::gcode`; `env -u KERF_UPDATE_GOLDEN cargo test --manifest-path src-tauri/Cargo.toml engine::gcode_gen`; `npx tsc --noEmit`; `git diff --stat -- src-tauri/tests/golden` must be **empty** (the rectangle fixture is a new golden added deliberately, or none; existing goldens do not move). Optionally `npm run tauri -- dev` and eyeball the preview of a square — not a claim about cut quality.

**Out of scope.** Numeric input policy (PLAN 2.6), optimizer, offset engine, bulk golden regeneration, the `maskFill` skip path's own semantics (it is a *different* skip, referenced in the comment at `:989` — record it as a lead for 2.6, do not fix here).

**Risk if wrong.** An ordinary rectangle disappears from the cut with a comment nobody reads.

### A3. Jog frame + material-test frame

**PLAN lineage:** batch 2.5 bounded (the part that does not need 1.3's status snapshots), plus the unrecorded material-test frame defect (audit G7, second half).
**Findings:** G7 (audit), R5 (astra).
**Tier:** Standard. 6 files. UI: `.tsx` (generation only) → Jen CONCERN pass.
**Depends on:** A1 merged (shares `MaterialTestDialog.tsx` and `canStartJob.ts`).

**Files.**

| File | Change |
|---|---|
| new `src/lib/machine/jogBounds.ts` | Pure function `clipJog({ axis, distance, position, bed, originTop, verified }) → { kind: "send", distance } \| { kind: "refuse", reason }`. Rules: unverified frame → `refuse` (today `connection.ts:434-437` skips the clamp and sends raw — that is the "let $20 be the backstop" path; keep it **only** as the explicit unverified-refusal, because a clamp against an unknown frame is what produced +248.9). Verified: the envelope is `[0, bed]` when `!originTop` and `[-bed, 0]` when `originTop`. If `position` is outside the envelope → `refuse` ("position outside verified envelope — home first"), **never** clamp toward it. If inside: clip magnitude toward zero only; result has the same sign as the request or is zero; `|result| ≤ |request|`. Zero → `refuse("already at bed edge")`. |
| new `src/lib/machine/__tests__/jogBounds.test.ts` | Property tests below. |
| `src/lib/machine/connection.ts` | `jog` (`:408-439`) and `jogTo` (`:441-451`) **only**: call `clipJog`; add explicit `G21` to both `$J=` strings (`$J=G21 G91 …`, `$J=G21 G90 …`); `jogTo` must refuse when unverified or when the target is outside the `originTop`-aware envelope, not clamp. Nothing else in this file. |
| `src/lib/machine/__tests__/connection.test.ts` | New `describe("jog frame")` using the recorder: assert the actual `serial_send` argument string. |
| `src/components/panels/MaterialTestDialog.tsx` | `generateMaterialTestGcode` (`:100-` — `startX/startY = 10 + labelMargin`, positive Y) and `generateFrameGcode` (`:261-273`, positive Y literals): take `originTop` and generate negative Y when true (mirror through `y → -y`), including label placement. Both `isWithinBounds` calls already receive `originTop` after A1; confirm. |
| `.claude/DECISIONS.md` (via `update-decisions.mjs`, **Evidence corrections** bucket) | `decisions_add`: "The material-test grid and frame were generated in a positive-Y frame regardless of `originTop`, so on an origin-top machine every Y was beyond home." with the reason and the fix commit. This defect is in no register today; the audit found it and the ruling on recording is that a finding a future session could re-lose belongs here. |

**Tests required.**

| # | Test | Mutant → RED |
|---|---|---|
| 1 | `clipJog`: `originTop=true`, position `y=-248.913`, bed 250, request `-1` → `send` with `-1` (inside envelope, no clip needed) | Invert the envelope for `originTop` |
| 2 | `clipJog`: same, request `-2` → `send` with `-1.087` (clipped toward zero) or `refuse`; **never** positive | Restore `Math.max(0, Math.min(bed, dest)) - pos` |
| 3 | `clipJog` property (fast-check if present in devDeps; else a 200-case table): `sign(result) ∈ {sign(request), 0}` and `|result| ≤ |request|` over positive/negative bounds, edge, outside | Any reversal |
| 4 | `clipJog`: `verified=false` → `refuse`; **no send** | Restore the raw-send fallback |
| 5 | `connection.jog` through the recorder: the sent string starts `$J=G21 G91` | Remove `G21` |
| 6 | `connection.jogTo` with a target outside the envelope → `refuse`, no send | Restore the clamp |
| 7 | Material test G-code with `originTop=true`: every `Y` word `≤ 0` and `≥ -bed`; with `originTop=false` every `Y ≥ 0` | Drop the mirror |
| 8 | Frame G-code, same two assertions | Same |

**Verification.** `npx vitest run src/lib/machine/__tests__/jogBounds.test.ts src/lib/machine/__tests__/connection.test.ts src/components/panels/__tests__/machineJobLoop.test.tsx`; `npx tsc --noEmit`; full contract. No hardware; the owner's actual axis signs remain session A's job — this batch makes the software never *amplify* a request, it does not claim to know the frame.

**Out of scope.** `$23` sign inference, homing, WPos/MPos conversion (needs B2's snapshots — PLAN 2.5 proper), stored workspace defaults, `MachinePanel.tsx`.

**Risk if wrong.** A 1 mm nudge becomes a full-bed traverse into the frame.

---

## Phase C — Make the two live hardware defects measurable (parallel with A; no laser to build)

**Goal.** The diagnostic Lee holds stops repeating the unsafe behaviour it measures; the "laser stops firing" detector is proven to fire; the public repo stops carrying the controller's identity.

**Phase exit.** Owner session A (PLAN 3.2) is runnable by Lee with a reviewed, dry-run-printed command matrix. No agent captures the wedge trigger; this phase makes the capture possible.

### C1. Probe repair + qualification card

**PLAN lineage:** batch 3.1 verbatim, with the abort case simplified by the 2026-09-20 ruling (cleanup is `0x18` first, no awaited M5, no hold). Prerequisites 1.5/2.5 waived: the probe is a standalone Python tool that does not import the app, and the ruling that 3.1 was blocked on (hardware evidence standard) is recorded.
**Findings:** G2 (audit), R1/R2 acquisition, R4/R5/R9 containment (astra).
**Tier:** Standard. 3 files. Python + Markdown. No UI, no Rust, no TS.
**Depends on:** nothing.

**Files.**

| File | Change |
|---|---|
| `scripts/probe-grbl.py` | Per PLAN 3.1: remove `0x9E` from the pause case (`:394`); `--pause` refuses or maps to hold-only with a deprecation notice; remove `$23` sign guessing (`:467`) in favour of `--origin-x/--origin-y/--x-dir ±1/--y-dir ±1/--box-mm 60`; `--stop-on-fault` (no next variant after a wedge, `:349`); `--case wedge\|hold-m4\|stop-m4\|completion-m4\|settings`; `--dry-run` prints the exact command matrix and opens no port; `--log-file`; retain `--port --baud --reps --smax --feed`; `$I $$ $G ?` recorded raw, unsupported `$G` recorded not ignored; **no default `$30`** — missing readback fails before motion; positive S capped against complete `$30` readback and the operator's ceiling. Cleanup on fault/KeyboardInterrupt: realtime `0x18` **first**, then bounded status capture; **no awaited M5 before reset**, no `$X`, no `$H`, no replay. Keep all eight switch sequences with their names. |
| new `scripts/test_probe_grbl.py` | `unittest`, scripted-peer (a fake serial object with a scripted reply table). Tests below. |
| new `docs/qualification-card.md` | Part 0 procedure for session A: prerequisites (beam-disabled verification of `--x-dir/--y-dir` with 5 mm steps, `$30` read, low-power ceiling chosen), the dry-run command to print and have reviewed, the five cases in order, what to record per case (monotonic timestamp, TX/RX, status, motion cessation observed y/n), and the evidence pointer to the private register. **Public: procedure only.** No firmware string, no incident narrative (DECISIONS "Public repo" rule). |

**Tests required (Python `unittest`, run through the battery with `python3 -m unittest` as the runner).**

| # | Test | Mutant → RED |
|---|---|---|
| 1 | Fault mid-case → the first byte written after the fault is `0x18`; no `M5` line is written before it | Reorder cleanup to send M5 first |
| 2 | Fault with `--stop-on-fault` → no further variant runs; process exits non-zero with "fault: stopped" | Continue to next variant |
| 3 | `--pause` → refuses (exit non-zero) or emits `!` only; `0x9E` never appears in the write log | Restore the toggle |
| 4 | Missing `$30` in readback → exits before any motion line; no `G0`/`G1` written | Restore the default 1000 |
| 5 | `--x-dir -1` with a `$23` fixture that says otherwise → the direction used is `-1` | Let `$23` override |
| 6 | `--dry-run` → no serial constructor called (patch `serial.Serial`); printed matrix snapshot for each case equals the builder's output | Open the port in dry-run |
| 7 | Box exceeding `--box-mm` or origin+box outside bed → refuse before motion | Drop the bounds check |

**Verification.** `python3 -m unittest discover -s scripts -p 'test_probe_grbl.py'`; `python3 scripts/probe-grbl.py --help`; `python3 scripts/probe-grbl.py --case wedge --dry-run --origin-x 20 --origin-y 20 --x-dir 1 --y-dir 1 --smax 100` prints a matrix. No hardware. Razor signs the printed matrix in the review; that signature is what Lee runs.

**Out of scope.** Production code, firmware behaviour, `$30` defaults, dependency bumps.

**Risk if wrong.** The diagnostic re-arms the beam or continues into a second wedge while measuring the first.

### C2. Spindle-drop detector test + correlation hook

**Findings:** G3 (audit). No astra batch; this is the only handle on "laser stops firing".
**Tier:** Simple. 2 files. Editing `connection.ts` is **the `FS:` block only** (`:367-391`).
**Depends on:** nothing. Merge order on `connection.ts`: after A1, before A3.

**Files.**

| File | Change |
|---|---|
| `src/lib/machine/connection.ts` | In the `FS:` block: when the drop fires, include the last-sent G-code line index and the last-sent line text in the console warning (read them from the store's job progress — `jobProgress` and whatever field holds the current line; if no field holds the line text, add one setter on the store, not a new subscription). Fire **once per drop** (already true via `prevSpindleSpeed`; keep it). No interlock, no stop, no behaviour change beyond the message. |
| `src/lib/machine/__tests__/connection.test.ts` | Tests below, through the recorder's status fixture path (`emit({type:"status", …})` or the polling path — whichever the production detector actually consumes; the test must reach `:371`). |

**Tests required.**

| # | Test | Mutant → RED |
|---|---|---|
| 1 | `<Run\|…\|FS:1000,500>` then `<Run\|…\|FS:1000,0>` → exactly one warning line containing "Spindle speed dropped" and the line index | Delete the `currentSpindle === 0` branch |
| 2 | `<Idle\|…\|FS:0,500>` then `<Idle\|…\|FS:0,0>` → no warning | Drop the `startsWith("run")` guard |
| 3 | Two consecutive `FS:x,0` reports after the drop → still exactly one warning | Stop updating `prevSpindleSpeed` |
| 4 | Warning names the last-sent line index and text | Remove the index from the message |

**Verification.** `npx vitest run src/lib/machine/__tests__/connection.test.ts`; `npx tsc --noEmit`.

**Out of scope.** Root cause. Any stop or interlock on the drop (that is a policy decision for after the next occurrence correlates it).

**Risk if wrong.** The next "laser stopped" report again arrives with no data.

### C3. Public-repo privacy slip

**Findings:** G2/F10 (audit): `scripts/probe-20260914-153729.log` names the vendor firmware in a public repo, against the DECISIONS "Public repo" rule.
**Tier:** Simple. 2 files. Orchestrator can run this directly, no Ted.
**Depends on:** nothing. History rewrite is **L4**; this batch is option (a) only.

**Steps.** `git mv`-equivalent: copy `scripts/probe-20260914-153729.log` to `~/marvin/state/audits/kerf-astra-2026-09-08/evidence/probe-20260914-153729.log` (private register; create `evidence/`), `git rm` it from the tree, add `scripts/probe-*.log` to `.gitignore` under the existing `# Python bytecode (scripts/probe-grbl.py)` block (`:38`). `handoff.md` `log_entry` naming the new location. Do **not** rewrite history.

**Acceptance.** `git ls-files scripts/ | grep -c probe-.*\.log` = 0; the file exists at the private path; `.gitignore` carries the pattern.

---

## Phase D — Make CI verify the machine we have

**Goal.** Charter condition (2): the simulator represents the cases the gates exist for, and the e-stop test calls the production body. D1 (the model) is parallel-safe from hour one; D2 (production-body verification of the stop) waits on B4.

### D1. Sim fidelity

**PLAN lineage:** the "Simulator correction — captured profiles rather than stock certification" amendment and the 2026-09-05 evidence entry.
**Findings:** G8 (audit), R14 (astra).
**Tier:** Standard. 3 Rust files (`sim/grbl.rs`, `serial.rs` sim_integration module, `serial_pump.rs` tests). No UI, no TS, no production behaviour outside `#[cfg(any(test, feature = "sim"))]`.
**Depends on:** nothing. **Shares `serial.rs` with A1** but A1 edits `serial_stream_job_inner` (`:535-565`) and D1 edits only the `sim_integration` test module (`:1592-` region). Merge A1 first.

**Files / changes (`src-tauri/src/sim/grbl.rs`).**
1. **Tracked `$32`:** a `laser_mode: bool` field, default `true` (preserve the current green suite), settable via `$32=0`/`$32=1` writes (`:516-519` today accepts any `$N=V` with `ok` — keep accepting, but *apply* `$32`), dumped truthfully in `$$` (`:510` currently hardcodes `$32=1`). The hold auto-off (v0.8.29) gates on it: `$32=0` → spindle stays on through hold-complete.
2. **Rejected-write fixture:** `set_reject_setting(n: u32)` → that `$N=V` answers `error:3` and does not apply.
3. **`A:` accessory field:** status line (`:571`) carries `|A:S` while `spindle_on`, absent otherwise. Label the absent case "omission semantics unverified on hardware" in a doc comment.
4. **Sustained drop-all-acks fault** (the wedge shape): `set_wedge_after_spindle_cmd()` → after the next `M3`/`M4`, every line is accepted into the planner but **no `ok` is ever emitted**, `?` still answers `<Idle…>`, until `0x18` clears it. Distinct from `drop_ok_at_line` (`:554`), which drops one.
5. **Captured profile:** `SimProfile::{Stock (15/128), Captured127 (127/65536)}` constructor parameter; default Stock so existing tests keep their numbers; doc comment says "captured profile from the owner's controller, not a vendor certification".

**Tests required (in `serial.rs` sim_integration and `serial_pump.rs`).**

| # | Test | Mutant → RED |
|---|---|---|
| 1 | Sim with `$32=0` written then `$$` → dump shows `$32=0` | Restore the hardcoded `$32=1` |
| 2 | `$32=0`, `M4 S500`, `G1`, `!` → hold-complete leaves `spindle_on == true`; with `$32=1` → `false` | Drop the gate on `laser_mode` |
| 3 | `set_reject_setting(30)`; write `$30=1000` → `error:3`, later `$$` still shows the old value | Apply on error |
| 4 | Status while `spindle_on` contains `A:S`; while off it does not | Always emit / never emit |
| 5 | Wedge fault: run the **real** `run_pump` (per-line) through the sim → returns `Disconnected("terminal lost…")` after the 3 Idle probes (`serial_pump.rs:186-196`), and the trace shows `?` answered throughout | Emit one `ok` inside the wedge |
| 6 | Wedge fault, then `send_byte_inner(0x18)` → subsequent lines ack again | Don't clear on `0x18` |
| 7 | `Captured127`: 100 short lines fit the planner without `pending_lines` growth; `Stock` parks line 16 | Swap the two profiles' numbers |

**Verification.** `env -u KERF_UPDATE_GOLDEN cargo test --manifest-path src-tauri/Cargo.toml --features sim`; `cargo check --manifest-path src-tauri/Cargo.toml` (sim must be absent without the feature); `cargo clippy --all-targets -- -D warnings`. No hardware. **Do not label any of this "Falcon certified".**

**Out of scope.** The e-stop production-body test (D2, needs Lee's stop body), the pause-volley tests' assertions (they were already corrected in v0.8.29 — do not re-derive), any model of `0x9E` beyond what v0.8.29 shipped.

**Risk if wrong.** CI stays green against a controller model the hardware has contradicted twice.

### D2. Production-body verification of the stop and the gate

**PLAN lineage:** batches 0.1/0.2's stated purpose, applied. **Waits on B1 + B4** (the stop body must be the one Lee and B4 produced) and D1.
**Tier:** Standard. 4 test files.

**Changes.**
1. E-stop sim tests (`serial.rs` `mod sim_integration` from `:1285`; `wedged_pump_estop_then_disconnect_tears_down_cleanly` at `:1594`, `estop_volley_resets_and_clears_spindle` at `:1790`) invokes the extracted stop body from `serial_session.rs` (post-B1), **not** raw `send_byte_inner(0x18)`. Assert on the ordered trace: `0x18` is the first byte after the stop request; no `0x21` precedes it; no `M5` line precedes it.
2. `$32=0` sim fixture (D1) drives the **real** `serial_stream_job_inner` with `laser_mode_verified=false` (A1) and, on the TS side, the real `canStartJob` through the recorder → both refuse; the trace holds zero writes.
3. Wedge fixture (D1): real per-line pump returns "terminal lost"; the real TS error path (Lee's / B4's) submits `0x18` before anything else — assert on the recorder.
4. Relabel remaining store-only tests in `machineJobLoop.test.tsx` to their actual scope (PLAN 0.2 rule) — names only.

**Mutants → RED:** delete the `$32` check (A1) → test 2 red; delete the stop dispatch → test 1 red; reorder to M5-before-reset → test 1 and 3 red. **This is the phase exit for D: the charter sentence becomes a CI property.**

---

## Phase B — Ownership and the stop spine (PLAN Phase 1; **gated on L1**)

**Goal.** One owner per job, one stop operation with no ack-awaited write, truthful status, pause contained. This is the phase the 2026-09-20 ruling unblocked and the phase Lee is patching into by hand. Specified here so it is ready; **Stage 0 for any B batch refuses until L1 is answered and Lee's patch is on `origin/master`.** Each B batch's brief is then **rebased on his diff**: read his commit first, and where his patch already did a thing the spec asks for, the spec item is "verify, do not redo".

**Landing rule (PLAN):** B1 + B3 are the ownership pair; B2a + B2b the status pair. Review each diff separately; merge each pair only when both halves and their compatibility tests pass. B4 integrates last and is the phase's final safety review.

**Phase exit.** Tauri scripted-port smoke (`npm run tauri -- dev --features sim`, select the test-only scripted port from batch 0.1): START/PAUSE/STOP/disconnect/reconnect with scripted replies held; old acks cannot grant a cancelled producer writes; STOP requests reset without awaiting any line. Physical beam-off remains **unqualified** (status-only ruling); every message string must say so.

### B1. Backend admission fence + reset submission

**PLAN lineage:** batch 1.1 verbatim, stop body simplified by the 2026-09-20 ruling.
**Tier:** Complex (5 files, concurrency). **Razor plus one independent cold read** (PLAN's "one focused independent concurrency review"): dispatch the cross-reviewer at Stage 2.6 even though the tier is not Architectural — record the waiver reason in the pack.
**Files:** `src-tauri/src/commands/serial.rs`, `serial_pump.rs`, new `serial_session.rs`, `commands/mod.rs`, `lib.rs`. Tests via `ScriptedPort` (batch 0.1).
**The change** (PLAN 1.1, unchanged): connection epoch; admitted job id + phase (`idle/active/stopping/unknown/disconnected`); stale tokens rejected at lock acquisition; STOP/reset/disconnect close admission before scheduling reset; never clear `job_abort` (`serial.rs:541`) before taking ownership; lifecycle guard for handle install/teardown; every line write obtains a generation-checked submission permit (250 ms host budget); realtime submission with **no blocking drain**; native stop command returning `submission_failed | submitted_unconfirmed | confirmed`. **Under the ruling the stop body is:** realtime `0x18`, bounded banner wait (reset within 500 ms of request on the healthy scripted transport, unconfirmed result within 3 s), retain the write-failure retry. No hold, no M5. Host budgets are test constants, not beam claims.
**Tests required (PLAN 1.1, verbatim):** RED if cancellation moves after reset; if a second job clears cancellation; if generation validation is removed before a queued send; if connect installs between the two teardown halves; if a realtime flush is restored; if event-send failure merely logs. Barrier test: a writer that passes its check, pauses, and writes after reset → RED. Use an already-queued ack followed by a delayed banner.
**Verification:** `env -u KERF_UPDATE_GOLDEN cargo test --manifest-path src-tauri/Cargo.toml --features sim commands::serial`; clippy. Tauri smoke with B3.
**Out of scope:** generators, store/UI, replacing the serial library, moving reset behind the command mutex, recovery UX, throughput.
**Risk if wrong:** old M3/M4 or motion reaches the controller after STOP.

### B2a. Native status contract (PLAN 1.2) / B2b. TS status consumer (PLAN 1.3)

Two Standard relays, merged as one pair. Specs are PLAN 1.2 and 1.3 verbatim; this plan adds one item to B2a: **fix the `line_index`/`lineIndex` serde mismatch** (`serial.rs:515` `#[serde(tag = "type", rename_all = "camelCase")]` on `enum JobEvent` renames the *variants*, not the field `line_index` at `:520`; TS reads `event.lineIndex!` at `jobStream.ts:151` and computes `NaN`) with a **real serialized fixture** `src/lib/machine/__tests__/fixtures/nativeStatus.json` produced by the production serializer in a Rust test and consumed by the TS consumer test (never a hand-typed JSON).
**B2a files:** `serial.rs`, `serial_pump.rs`, new `grbl_status.rs`, `commands/mod.rs`, the fixture. **B2b files:** `connection.ts` (status path only — not `emergencyStop`), new `machineStatus.ts`, `store/index.ts`, `storeTypes.ts`, `connection.test.ts`, new `machineStatus.test.ts`.
**Mutants (PLAN):** busy refreshes age; no-response becomes busy; malformed `<Idle…` becomes valid; Door clears suspended sending; `[MSG]` resets a deadline; byte cap ignored; serialization emits `line_index`; connect seeds Idle; late old-epoch poll updates state; WPos relabelled MPos; missing accessory becomes "off".

### B3. Job lifetime through draining (PLAN 1.4)

**Depends on:** B1, B2; the batch 0.2 harness. Files: `jobStream.ts` (**lifecycle plumbing only — coordinate with Lee's abort sites; if his patch restructured the function, rebase**), new `jobSession.ts`, `JobActionBar.tsx`, `MaterialTestDialog.tsx`, `machineJobLoop.test.tsx`, `jobStream.test.ts`. Spec PLAN 1.4 verbatim: backend job id before first line; one session owns progress/pause/cleanup across per-line, buffered and draining; all four callers observe the returned outcome; transmit-finished → *draining*; 30 s drain timeout → `unknown` + STOP offered, never `complete`; keep-awake held through draining. The batch 0.2 `it.fails("R4/R11 …")` cross-job test **flips to `it`** here — that flip is the acceptance signal.

### B4. Shared abort/disconnect + pause containment (PLAN 1.5 under the 2026-09-20 ruling)

**Depends on:** B1–B3, **L1 (Lee's patch merged), L2 (pause → stop)**. Files: `connection.ts` (`emergencyStop`), `jobStream.ts` (both abort sites, `pauseJob`), `serial_session.rs`, `connection.test.ts`, `machineJobLoop.test.tsx`.
**The change:** error, cancel, STOP, unsafe disconnect → one idempotent `emergencyStop({reason, jobId})` backed by B1's native stop admission. **No hold branch. No M5 before reset.** Post-reset M5 optional, bounded, only after a fresh complete Idle/Run. Delete the "STOP probably handled it" boolean guard. Delete the `Hold:0` poll (`jobStream.ts:35-80`; its Rust side is `serial_get_status_inner`'s `try_lock` at `serial.rs:459-`, which returns the empty sentinel for as long as the pump holds the command lock) that can never succeed. Do not change `serial_get_status_inner` itself — B2a replaces it with the lock-free snapshot. **Pause → stop** with the explicit message "Paused jobs cannot resume until a dark hold is qualified on hardware; the job has been stopped." (L2). Update the batch 0.2 STOP test to assert `0x18` with **no `0x21` and no `M5` before it** — **unless Lee's patch already flipped it**, in which case verify and leave it.
**Mutants (PLAN 1.5 + ruling):** M5 precedes reset; a post-reset unresolved M5 blocks the bounded unconfirmed result; unconditional M5 restored; `0x21` restored before `0x18`; duplicate stop requests run duplicate volleys; a late pause emits `0x9E`; pause resumes a job. Replace old `toContain("M5")` assertions with the conditional matrix; tuning every status mock to Idle is prohibited.

---

## Phase E — Fill-in track (idle capacity only; not on the release path)

| Batch | Gate | Spec |
|---|---|---|
| **E1. Charter amendment** | **L3** | One line in `.claude/CHARTER.md` "What we're NOT building" and the ROADMAP mirror: "built-in text from bundled fonts is in; font management and text-on-path stay out." Open and close gate D3 explicitly in the ROADMAP. Orchestrator edits on Lee's yes; **never** an agent, the charter rule says only Lee approves a rewrite. |
| **E2. Test card rewrite** | B4 | `docs/test-card.md` → Part 0 + superseded-steps structure from the 2026-09-05 artifact; pause step rewritten for pause-as-stop. Or retire it in favour of C1's `qualification-card.md` and leave a pointer. Simple. |
| **E3. SVG silent losses** | — | `SvgImportDialog.tsx:634-682`, `:596-614`, `svgImport.ts`: skip `display:none`/`visibility:hidden` subtrees; resolve `<use href>` or count it as skipped in the import summary; inherit `<g>` presentation attributes (`fill`, `stroke`, `display`). Fixtures from Inkscape and Illustrator exports. Mutants: un-skip hidden; drop `<use>` silently; stop inheriting. Standard. |
| **E4. Honest controls** | **L5** for air assist; Min Pwr half free | Air Assist: emit `M8` before the layer's first cut and `M9` after (per layer, in `assembleGcode`) **or** remove the toggle (`LayerPanel.tsx:511-539`) — L5. Min Pwr: hide or relabel on vector layers (DECISIONS 2026-09-10 evidence: reaches no G-code; `$31` is the real control). `MachinePanel.tsx:617` wording. Simple. |
| **E5. Text baseline parity** | E1 | `Viewport.tsx:1355-1362` (Pixi ascent) vs `geometryActions.ts:81,145` / `gcodeGen.ts:849-893` (`y + fontSize`, 1.3× pitch): make the canvas use the opentype metrics so preview and burn agree. Pointless if L3 removes text. Simple. |

## What is deliberately not in this plan

- Phase 2B recovery UX and any buffered-streaming work (2A is opt-in; D1c unmeasured on a 127-block planner; PLAN rejects a buffered-default flip).
- Geometry corrections G9 (R13/R17/R18/R19) and Gate D2: Lee + architect call; PLAN 2.3 must be re-specified from refusals into corrections first. **Schedule the re-spec as a Plan-agent task after Phase B lands**, not as a relay.
- "Compare position and resend" recovery (parked; PLAN rejects it).
- A faithful Falcon simulator (captured profiles only, D1).
- Cross-object scan merging (Parking Lot).
- PLAN 2.6 (numeric bounds) — real, host-only, but not on the two live defects; queue it behind Phase A if capacity appears, as a seventh parallel relay.

---

## Lee-gated decisions (batch into one message; structured-decisions rule)

**L1 — Which files is your abort patch touching, and when does it land?**
*What exists today:* your 17:31 ruling is in the tree; the code it describes is not. Both job-abort sites in the streamer and the emergency-stop routine still send an M5 and wait for its answer before the reset, and emergency-stop still opens with a feed hold. *Tension:* Phase B rebuilds exactly those files; a relay dispatched now collides with your edits. *Options:* (a) you name the files and a landing time, agents stay out until then; (b) you hand the patch to a relay and review it; (c) agents start B1 (Rust admission fence, which your patch probably does not reach) and rebase on your change. *Recommendation:* (a). A half-merged stop path is worse than a late one. *Reversible:* fully. *If nothing for a month:* Phase B does not start; D2 and every later phase queue behind it. Phase A, C and D1 proceed regardless.

**L2 — Does Pause become Stop in the next build?**
*What exists:* Pause sends a feed hold and resumes on `~`; every pause prints a warning that is always false. *Tension:* your 2026-09-10 rulings say pause is hold-only "and becomes stop wherever a dark hold has not been observed on hardware", and that evidence is status-only, so by your own words a dark hold "cannot be qualified". The rulings already decide it; the change is user-visible, so you should see it before it ships. *Options:* (a) pause = stop, button relabelled, message says the job cannot resume; (b) keep the resumable hold and record that you are overriding your evidence ruling for this feature; (c) keep the hold only under M4 with `$32=1` verified, labelled "unqualified". *Recommendation:* (a). Cost of being wrong: an operator restarts a job, against a beam that relights on a parked head. *Reversible:* yes, in PLAN 4.1 once a hold is observed dark. *If nothing:* the false warning keeps training you to ignore warnings.

**L3 — Amend the charter for the text tool?** *Options:* (a) one-line amendment; (b) remove the text tool; (c) leave the contradiction. *Recommendation:* (a). *Reversible:* yes. *If nothing:* every drift review flags it.

**L4 — The public probe log with the firmware string.** *Options:* (a) delete going forward + gitignore (C3 does this; history keeps it); (b) `git filter-repo` + force-push, breaking every clone and worktree (11 exist). *Recommendation:* (a). A firmware version string is not a credential. *Reversible:* (b) can follow (a). *If nothing:* it stays public either way.

**L5 — Air Assist: wire it or remove it?** Only you know whether the Falcon's air pump is on the controller's coolant output. (a) emit `M8`/`M9` per layer; (b) remove the control. *Recommendation:* (b) unless the pump is controller-driven. *If nothing:* a control keeps lying.

**L6 — Owner session A (hardware), after C1.** The repaired probe, dry-run reviewed, with the qualification card. Only you can run it; no agent captures the wedge trigger. Also still owed from 2026-09-10: the scrap comparison cut validating the M4 default (`$32=1` confirmed first).

**L7 — Standing, not new:** Gate D2 open; D1c stays `perLine`; v0.9 camera/rotary parked; the SVG drift repro file is still owed.

---

## Dispatch mechanics (for the orchestrator)

1. **Per-batch plan files.** `relay-load` finds a plan by the presence of a companion `{name}-critic.md`. Lift each batch section above **verbatim** into `/home/leesalo/Projects/kerf/.claude/plans/kerf-{phase}{n}-{slug}.md` (e.g. `kerf-a1-laser-gate-class.md`), prepend the `## Intent (grilled)` block and the **Lee's zone** table, and run the plan critic (`scripts/reviewer-tier.sh` reads `astra`; Fable fallback) to produce the critic file. **Batch sections carry `### A1. …` headings so `plan_section` extraction works** if a multi-batch plan file is used instead; either shape is valid, the per-batch file is cheaper for the worker.
2. **Stage 0 guard for Lee's zone.** Before confirming the tier, diff the batch's file list against the zone table. Any intersection other than the named disjoint functions → BLOCK, not Proceed. The B batches intersect by design and are gated on L1.
3. **Branch base.** `git -C /home/leesalo/Projects/kerf fetch origin` then `git checkout -b relay/kerf-{batch} origin/master` (or `master` after A0's fast-forward — verify `git rev-parse master` equals `origin/master` first).
4. **Six relays in parallel on day 1:** A1, A2, C1, C2, C3 (orchestrator-direct), D1. Spawn each in its own kerf worktree under `~/.local/share/marvin/worktrees/kerf/` (workers spawn where the code is; `npm ci --ignore-scripts` and a `cargo build --features sim` warm-up per worktree — record the time, the audit says a cold boot is measurable).
5. **Merge order into `origin/master`:** A0 → A1 → C2 → A3 → A2 → D1 → C1 → C3. A2 and D1 have no shared files with anything and can go anywhere in the sequence; the order above just keeps `connection.ts` conflicts trivial.
6. **Battery.** Every batch's mutant table is the battery spec. `node ~/marvin/scripts/mutation-battery.mjs <spec.json>` (it copies the working tree into a disposable worktree and never writes the live tree); journal at `~/.local/state/marvin/mutation-battery/`. A batch whose journal shows a mutant that stayed green is returned to Ted with that mutant named; it is not a Razor finding, it is a missing test.
7. **Stage 4.5 for every batch reports `READY|NEEDS_ATTENTION` but never triggers a tag.** RELEASE BLOCKED is a DECISIONS ruling; the production gate reads it and says so.
8. **After Phase A + C + D1 land:** hand C1's dry-run matrix to Lee (L6), and rebase this document's Phase B on his patch before dispatching B1.

## Sequencing (one week, Opus-tier workers)

```
Day 1   A0 (orchestrator, 30 min)
        ├─► A1 ($32 gate class)        C1 (probe repair)        D1 (sim fidelity)
        ├─► A2 (rectangle lowering)    C2 (FS detector test)
        └─► C3 (privacy slip, direct)
Day 2   A3 (jog + material frame)      Razor passes + battery journals for day-1 relays
        ── L1 answered; Lee's patch on origin/master ──
Day 3   B1 (admission fence)  [Complex: Razor + cold read]
Day 4   B2a (native status) ─► B2b (TS status)
Day 5   B3 (job lifetime) ─► B4 (shared stop, pause-as-stop) [L2]
Day 6   D2 (production-body verification)     E1/E4 if L3/L5 answered
Day 7   Tauri scripted-port smoke; C1 matrix to Lee for session A (L6)
```

Nothing here clears the release block. That needs session A (trigger captured), the correction batch it produces (PLAN 4.2), and session B on the pinned candidate. The status-only evidence ruling means that even after all of it, "the beam went dark" is a claim the project cannot make, and every message string in Phase B must say so.

## Files an agent reads before touching anything

- `/home/leesalo/Projects/kerf/.claude/CHARTER.md`
- `/home/leesalo/Projects/kerf/.claude/DECISIONS.md` **at `origin/master`** until A0 lands
- `/home/leesalo/Projects/kerf/ARCHITECTURE.md` (stale on `sim/` contents and the `_inner` extraction; otherwise accurate)
- `~/marvin/state/audits/kerf-astra-2026-09-08/PLAN.md` — the batch this plan lifts from, for acceptance criteria and out-of-scope lists
- `~/.local/share/marvin/worktrees/kerf/session-1b2844/.claude/plans/remediation-batch-0.1.md` and `-0.2.md` — what the harness seams are (`serial_*_inner`, `ScriptedPort`, `serialTraceHarness.ts`)
- `~/marvin/research/grbl-abort-policy-laser-20260920/report.md` — the evidence behind the abort ruling
- This plan's **Lee's zone** table
