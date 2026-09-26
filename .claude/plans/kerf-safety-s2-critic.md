# Critic — Kerf safety S2 (`kerf-safety-s2.md`)

**Plan:** `/home/leesalo/.local/share/marvin/worktrees/kerf/kerf-gap/.claude/plans/kerf-safety-s2.md`
**Rubric:** `~/marvin/rules/plan-critic-rubric.md` (v2), applied in full.
**Critic:** Fable, separate subagent (the plan author cannot self-certify).
**Date:** 2026-09-25 (clock read: `2026-09-25T17:08:18-07:00`).
**Tree verified against:** worktree `marvin/kerf-gap` at `8c60666` (`git rev-parse` confirmed; S1 merge `df8883a` is in its history; `git status` shows only `.marvin-worktree.json` modified). Read-only pass: no build, test, install or git state change.
**Context read in full:** parent `PLAN-safety-gate-class.md` (§S2, §kerf-f2, Verification, Authority notes) and `PLAN-safety-gate-class-critic.md`; `.claude/DECISIONS.md` (all entries, including the 2026-09-10 M4/M3 ruling, the 2026-09-10 pause ruling, the 2026-09-20 abort ruling, the 2026-09-24 single-reset pin, and the 2026-09-05/2026-09-25 `0x9E` and `A:S` evidence corrections); `.claude/CHARTER.md`; `.claude/handoff.md` (the `kerf-f2` row is open); sibling `kerf-safety-s1.md` and `kerf-safety-s1-critic.md` (both rounds); `kerf-safety-s1b.md` §Existing plans. Source: `MaterialTestDialog.tsx` (types, presets, generator, frame, handlers, display gate), `textGcode.ts` and `textGcode.test.ts` in full, `JobActionBar.tsx` in full, `jobStream.ts` (`pauseJob`, `resumeJob`, the per-line loop and post-loop), `jobSession.ts` in full, `connection.ts` (`feedHold`, `cycleResume`, `emergencyStop`, `getStatusReport`, `pollStatus`, the job-polling suspension, `disconnect`), `machineStatus.ts` (state mapping and the single `setMachineState` writer), `canStartJob.ts` (idle requirement), `machineJobLoop.test.tsx:690-830` and its mock helpers, `creatorInvariants.test.ts:20-90`, `geometryActions.ts` (`loadFont`, `textObjectToPaths`), `src-tauri/src/engine/gcode_gen.rs` at every cited line, `~/marvin/scripts/mutation-battery.mjs` (spec validation, `MUTANT_ANCHOR_AMBIGUOUS`, `CONTROL_RED`), root `ARCHITECTURE.md` at every cited line, `docs/test-card.md:55-65`, ROADMAP `## Parking Lot` heading, `scripts/probe-20260914-153729.log` lines 25-27 only (`$20/$21/$22`; no identity string read or copied).

---

## Applicability block

**Project type:** desktop laser-cutter controller (Tauri v2 / React / Zustand; Rust untouched in this batch). The batch changes the G-code the material test emits (arming lines), the label emitter shared with it, and the label and handler of an operator stop control. Standard tier, 8 files in `src/`, `.tsx` touched (Jen CONCERN pass, no spec) — agreed.

| Dimension | Fires? | Why | Tag |
|---|---|---|---|
| Core 1-10 | always | — | **GATING** |
| X1 Physical & human safety | **Yes** | Every `M3`/`M4` line the material test sends is changed; the button is a laser stop control. | **GATING** |
| X2 Privacy & data stewardship | No | No personal, health, child or client data. Controller identity is `kerf-d12`; the plan quotes none and this review copies none. | N/A |
| X3 Evidence & source integrity | No | Code, not research or public claims; citations checked below. | N/A |
| X4 Audience, brand & money | No | Operator UI copy only; no money, no signature. | N/A |
| X5 Concurrency & re-entrancy | **Yes** | A stop pressed while a job session is draining; a stop pressed twice. | **GATING** (X1-class plan) |
| X6 Operability & observability | Yes | The console line and status message after the relabelled stop are the only field evidence of what it did. | ADVISORY |
| X7 Self-modification safety | No | No MARVIN gate, hook, skill or automation is changed. | N/A |
| X8 Dependencies, performance & cost | No | No packages; a three-file vitest battery; no hot path. | N/A |

---

## Verified claims (against `8c60666`)

**Exact, as cited:** `MaterialTestDialog.tsx:16` `PowerMode`, `:18-32` options, `:34-95` presets with `powerMode: "M3"` at `:46` and `:76`, `:97-260` generator (not exported), `:102-106` preamble, `:127-129` `startX/startY`, `:133` `labelS`, `:141-149` and `:158-166` `textToGcode` calls with `opts.powerMode`, `:188-189` cut-cell `G0` then `${opts.powerMode} S${sValue}`, `:210-211` fill lead-in, `:242` `borderS = sValueMax`, `:245-246` `G0` then `M3 S${borderS}`, `:262-275` `generateFrameGcode` (`M5`, no `S`, literal `X10 Y10`), `:386-403` `handleGenerate`, `:443` and `:482` frame calls, `:322` `originTop` selector, `:422`/`:445` `canStartJob`; `textGcode.ts:53-120` signature, `:103-104` `G0` then `${powerMode} S${sValue}`, `:108` and `:113` `G1 … S${sValue}`, `:116` `M5`, `:45` "laser on" doc, `:100` `py + wy + y`; `textGcode.test.ts:4-9` header, `:88` `"M4 S800"`, `:89-90` positive S on `G1`, `:113` `"M3 S500"`; `textToGcode` has one caller (`MaterialTestDialog.tsx:9,141,158`); `JobActionBar.tsx:2` header, `:16-17` `useStore`/`machineConnection` imports, `:19` the `jobStream` import, `:64` START gate, `:90-103` `handlePauseResume` with the stale feed-hold/override comments, `:105-113` `handleStop`, `:122` FRAME gate, `:152` gate, `:220` row comment, `:260-276` the button, `:262` disabled rule, `:275` `{machineState === "hold" ? "RESUME" : "PAUSE"}`; `jobStream.ts:47-57` `pauseJob` (message, `setJobRunning(false)`, `emergencyStop()`), `:59-69` `resumeJob` doc with the `0x9E` paragraph, `:67-69` sends only `cycleResume`, `:213` the `serial_stream_job` invoke; `jobStream.test.ts` has no pause/resume reference; `machineJobLoop.test.tsx:701-811` the B4 describe, `:745-760` records `serial_send_byte` args, `:777-786` pins `[0x7e]`, `:788-810` clicks `getByText("PAUSE")`; `gcode_gen.rs:303, 595, 632, 708, 747, 827, 858, 1104` each push `{power_cmd} S{s}` standalone, `:290` and `:336` `G1 … S0`; `creatorInvariants.test.ts:24-26` tauri mock, `:59-85` opentype mock; `loadFont` (`geometryActions.ts:68-76`) goes through `opentype.load`, so that mock feeds the real glyph→points path, and `"sans-serif"` is the default key; `mutation-battery.mjs:1773-1779` refuses an ambiguous anchor before writing; ARCHITECTURE `:43`, `:98`, `:117`, `:306-310`, `:439-442` say what the plan says; `docs/test-card.md:57-63` is step 6 "Pause / resume"; ROADMAP `## Parking Lot — every deferral, one index` at `:431`; anchor counts: every M1/M2/M3/M5/C1/C2 `find` first line occurs once, `onClick={handleStop}` once; `relay/kerf-refresh-canvas-display` touches none of the 8 files and its `geometry/index.ts` hunk (from `:391`) does not touch `sampleBezierPath`; no `relay/kerf-safety-s1b` branch exists. Every line-number correction in "Parent claims that no longer hold" is right.

**Wrong or overclaimed (each is used below):**

1. **"That makes it exactly what STOP does" (`:75`) — false, and the plan writes it into the tooltip and the handler comment.** `handleStop` (`JobActionBar.tsx:105-113`) calls `stopActiveSession()` first (fire-and-forget), then `setJobRunning(false)`, then `emergencyStop()`. `pauseJob` (`jobStream.ts:47-57`) skips `stopActiveSession()`. `stopActiveSession` (`jobSession.ts:243-260`) is what cancels the session (`session.cancel()` → `_cancelled`), which is the only thing that makes a drain return `"cancelled"` (`jobSession.ts:124, 145, 157, 171`). Consequence, traced: after the last line acks, `streamJob` enters `session.drain()` (`jobStream.ts:413`) and polls `getStatusReport()` for up to 30 s (5 s for FRAME/material test) while the planner (127 blocks on this controller) is still cutting and `jobRunning` is still true, so the button is enabled. Press STOP: drain returns `"cancelled"`, console "Job cancelled". Press "STOP (no resume)": `0x18` fires, the beam stops, the drain's next poll reads the post-reset state and returns it — on the owner's controller `$22=1` (probe log line 27) so that is `<Alarm` → `"alarm"` → "Job stopped -- machine alarm (laser already off; unlock to continue)"; on a `$22=0` controller it is `<Idle` → `"complete"` → "Job complete" and `handleStartJob` sets the "Job complete -- …" status message (`JobActionBar.tsx:85-87`). A stop that Kerf then reports as a completed job is the honesty defect the batch exists to remove, moved one window to the right.
2. **"How RESUME is reached today … `machineState` reads `"hold"` whenever the controller reports Hold for any other reason" (`:77`) — not while the button is enabled.** `machineState` is written from a status report in exactly one place, `consumeStatusOutcome` → `machineStatus.ts:184`, called only at connect (`connection.ts:335`) and from `pollStatus` (`:549`), which returns before invoking while `jobPollingSuspended` (`:535`), and that flag *is* `jobRunning` (`:318`). In-pump reports refresh position only (`:467-470`); `getStatusReport` (the drain) writes no state (`:518-523`); `feedHold()` (`:671-679`, the only other `"hold"` writer) has no caller. START requires `machineState === "idle"` (`canStartJob.ts:180`). So while `jobRunning` is true the store cannot read `"hold"`, and RESUME is dead today. Two things follow: the relabel removes nothing reachable, which strengthens the case for both options of `kerf-f2`; and the "hold Kerf did not cause" paragraph in "What S2 does not satisfy" describes a state Kerf cannot observe mid-job — the true behaviour on a controller-initiated hold is that the stream keeps sending until the planner fills and then blocks in `send()`; the recovery is STOP either way. The jobStream `:348-354` hold-wait is therefore dead code with a stale comment ("emergencyStop's re-poll" — B4 removed the re-poll); name it, do not fix it here.
3. **String rule vs. comments.** §4 says the exact string `STOP (no resume)` "occurs once in the file (the JSX child)" and that comments "do not contain it", then instructs the header (`:2`) and row comment (`:220`) to read "START / FRAME / STOP (no resume) / STOP". The S2-M4 anchor (`"          STOP (no resume)\n"`, ten spaces plus newline) stays unique, so the battery will not refuse; the plan's own rule is what is violated. Word the comments "STOP-no-resume", or restate the rule as "the anchor with its indentation and newline occurs once".
4. **"`git show -M --color-moved` must show commit 1 as moved lines with no edits."** Four moved declarations gain `export`, the `textToGcode` import moves, and the dialog gains an import line. Those lines will show as edits, not moves. Razor's check should name exactly that residue and nothing else.
5. **Inventory:** `.claude/plans/` holds 39 `.md` files, not 36 (the count predates this plan, `kerf-safety-s1b.md` and its critic). Not load-bearing.

---

## Core dimensions (all gating)

### 1. Problem-fit — **PASS**
Standard tier with a written grill-skip line sourced to the parent's Intent (CHARTER "Done looks like" 1; DECISIONS 2026-09-10 M4/M3; 2026-09-10 pause-becomes-stop with its "effectively permanent for now" reasoning). The goal matches the Summary. No DECISIONS entry is contradicted: the `S0` mode line plus power on `G1` words is the mechanical form of "constant power exists for the stationary beam, not for cutting"; removing the resume branch is the pause ruling's fallback; the 2026-09-24 fence pin is untouched (no `send()`, no stop-path change); the `0x9E`/`A:S` corrections are respected (the paragraph is deleted, nothing keys on `A:S`). The M3 presets are correctly parked as a product call. `kerf-f2` is handled per the coordinator's standing rule (default ships if unanswered, re-read at Stage 0), and the hand-off row is still open.

### 2. Approach soundness — **PASS**
Right on both halves. Generator: `M3 S0` / `M4 S0` on the mode line and positive `S` only on `G1` words with motion is exactly what the ruling asks for, and the border following the chosen mode removes the one hard-coded `M3`. Moving the generator into a pure module beside `textGcode.ts` is the right seam (S3 and S4c edit it next; the test imports no store). Button: a state-independent label with no resume branch, and `resumeJob` kept but unwired under a doc that says so.

### 3. Completeness — **FAIL**
The plan claims to cover "every job state" and misses the one where the two controls diverge (Verified 1): the drain window, which on a 127-block planner can be the last many seconds of cutting. The relabelled button stops the beam there but the job is reported as alarm-stopped (owner's controller) or complete (a `$22=0` controller) instead of cancelled, and the plan writes "the same as STOP" into the tooltip, the handler comment, ARCHITECTURE `:439-442` and `pauseJob`'s doc. Fix (one line, no new file): `pauseJob` calls `stopActiveSession()` fire-and-forget before `store.setJobRunning(false)`, mirroring `handleStop`'s B3 order and comment (`JobActionBar.tsx:106-111`) — or `handlePauseStop` does `stopActiveSession(); await pauseJob();`. Then the claim is true. Add **S2-M8**: delete that call → red on a test that seeds a session through `beginJobSession` (mock `serial_job_begin` → `1`), clicks "STOP (no resume)", and asserts `getActiveSession()?.cancelled === true` (a real object, no module mock). The existing `:716-775` `pauseJob` tests stay green: with no active session `stopActiveSession` returns at once and invokes nothing. Also missing: the correct description of what a controller-initiated hold looks like to Kerf (Verified 2), which the close report will otherwise relay wrongly to Lee.

### 4. Right-sizing & reuse — **PASS**
Eight files, one root, honest; the §3 fix adds no file (either location is already in the batch). Reuse is good: the opentype mock from `creatorInvariants`, the recorder helpers from `machineJobLoop.test.tsx`, the existing Parking Lot shape. Out-of-scope items are named and routed through Stage 3.5. S1b disjointness (`jobStream.ts:47-69` vs `:213`) holds even if the §3 fix lands in `pauseJob`.

### 5. Security — **PASS**
No secrets, no network, no controller setting written. The public-repo rule is respected: the plan quotes no identity string, and the new test's fixture is synthetic. The probe-log read in this review was three settings lines.

### 6. Failure modes — **PASS**
The generator is pure and has no dependency that can time out. A font that fails to load makes `textToGcode` return `[]` (`:82, :85`), so labels are silently absent from the burn — pre-existing, not a hazard, worth one Parking Lot line. Clipboard denial is swallowed with the dialog closing (pre-existing). Button: `emergencyStop` failure sets `alarm` and prints the "use the machine's physical stop" line (`connection.ts:727-734`); the relabelled path inherits it.

### 7. Change safety — **PASS**
No irreversible step; three commits so the move is reviewable apart from the arming change; revert of the merge commit; S3 ordering stated. Verified 4 is a wording fix to the Razor check, not a safety gap.

### 8. Data integrity & compatibility — **PASS**
No saved file format changes; the generator's inputs are unchanged; `generateFrameGcode` is byte-identical, so the render-time display gate (`:482`) is unaffected. The two `textGcode.test.ts` expectations change deliberately, with the header note the file itself asks for. No new `useStore` selector (Error-185 clean by inspection: the label no longer reads `machineState`, and the existing scalar selectors stay).

### 9. Verifiability (incl. testing the tests) — **CONCERN**
Strong: seven invariants with two anti-vacuity controls, four programs (mode × powerMode), a parser that never asserts a coordinate, S2-C1/C2 to catch a zero-everything fix, and every mutant a single contiguous unique anchor (checked). Each mutant does die through the real code: S2-M1/M2/M3/M5/C1 through `generateMaterialTestGcode` with real `textToGcode` under the opentype mock (the square glyph is a closed four-point contour, so P2's "at least one `G1`" is satisfiable and reds the baseline rather than passing vacuously if labels come back empty); S2-M6/C2 through both suites; S2-M4 through `queryByText("RESUME")`; S2-M7 through either "no `0x7e`" or "no `serial_stop`" (if the mocked `serial_send_byte` makes `sendByte` throw, `cycleResume` swallows it and returns before `pauseJob`, so `serial_stop` is never invoked — killed either way). Gaps: (a) S2-M8 is missing (core 3). (b) Commit-1 "pure move" as phrased will not hold (Verified 4); state the expected residue. (c) The hold test is valid as a label test but its narrative ("in hold") should not be read as reproducing a controller hold (Verified 2). (d) Browser step 3's `hold` screenshot is set by `setState`, which is fine; say that it is synthetic.

### 10. Maintainability — **CONCERN**
ARCHITECTURE deltas are named with verified lines; test-card step 6 is rewritten; `resumeJob`'s doc says the right things. Two seams: (i) the `:439-442` ARCHITECTURE sentence and the tooltip must not say "the same as STOP" until core 3 is folded; (ii) the stale hold-wait comment at `jobStream.ts:348-354` is in the file the batch documents and will contradict the new `pauseJob` doc ("emergencyStop's re-poll" no longer exists). Add it to the doc-only pass or park it with the dead-code note.

---

## Conditional dimensions

### X1. Physical & human safety — **CONCERN** [GATING]
**Question 1 — can any emitted line still energise a stationary beam? No.** After S2 every `M3`/`M4` line from the grid, the labels and the border carries `S0`; I1 and I3 pin that for all four programs, and I2 pins that positive `S` appears only on a `G1` with an `X` or `Y` word. `generateFrameGcode` opens with `M5` and has no `S` (F1). In stock GRBL 1.1 an `M3 S0` resolves `rpm == 0` to the PWM-off value regardless of laser mode, and `M4` at zero velocity emits nothing (the ruling's own reasoning); on the vendor fork that is intent evidence, not proof (DECISIONS 2026-09-05), and the plan correctly routes the on-material check ("no dot or pit at any cell or label start") to the owner card — a burn mark is the one evidence status-only cannot give. Worst case per failure, named: the fork lights a minimum PWM on `M3 S0` → a dot at each M3 start, no worse than today; the card catches it; the remedy would be an `M4`-only mode line for the test, which is a follow-up ruling. Under M3 the beam still comes on with the first `G1` block during acceleration — that is constant-power corner burn, not a stationary beam, and the presets are parked as a product call. **Question 2 — the label.** "STOP (no resume)" is true in every state the button is enabled in: the beam is stopped by `0x18` in run, in the drain window, and in any hold. What is untrue is the "same as STOP" claim (core 3) — an honesty defect on a stop control, not a fire path. **The engine parking.** `gcode_gen.rs` arms every real job with a standalone `{power_cmd} S{s}`: dark under M4, a stationary dot at every path start on any layer the operator set to M3. That is the same class, pre-existing, and outside the parent's S2 scope; parking is acceptable *only* with the Parking Lot line stating it as X1-class on every M3 layer of every real job, naming the batch it needs (its own, with `env -u KERF_UPDATE_GOLDEN` regeneration discipline, since the engine is remediation-frozen per the refresh plans) and the close report raising it to the coordinator as a gap in the parent — which the plan already commits to. Hardware-only steps are named, not skipped.

### X5. Concurrency & re-entrancy — **CONCERN** [GATING]
The drain race is the finding (Verified 1): a stop arriving while `session.drain()` is mid-poll must land as `cancelled`, and only `session.cancel()` makes that true; the relabelled path does not call it. Double-press: after the first press `jobRunning` is false and the button disables; a second `emergencyStop` before the re-render is coalesced by the native `serial_stop` (single-flight, per its doc), and the 2026-09-24 pin governs the reset count. Two presses of STOP behave identically today. The `resumeJob` byte path has no caller, so no resume can interleave with a stop.

### X6. Operability & observability — **CONCERN** [ADVISORY]
After the relabel, the console still prints "Paused jobs cannot resume …" for a button that no longer says Pause; two assertions pin the string (`:740`, `:807`). Reword deliberately ("Stopped (no resume): Kerf cannot pause until a dark hold is qualified on hardware") and update both expectations, or say why the old string stays. With core 3 folded, a stop in the drain window prints "Job cancelled" as STOP does; without it a field report reads "machine alarm" or "complete" for an operator stop.

**N/A with attestation:** X2 — no personal or client data; no identity string quoted or copied. X3 — code, not research or public claims. X7 — no MARVIN gate, hook, skill or automation is changed. X8 — no dependency, no hot path, JS-only battery.

---

## Stress tests

### Pre-mortem — three months out, this failed
1. **Lee pressed "STOP (no resume)" while the planner was still cutting the tail of a job; Kerf said "Job stopped -- machine alarm" (or, on another controller, "Job complete").** The relay report had said the button was identical to STOP; the tooltip said so; ARCHITECTURE said so. Should have seen: `handleStop:110` calls a function `pauseJob` does not.
2. **The battery ran clean and the burn card still showed a dot at every cell start.** The vendor fork drives a minimum PWM when the spindle is "on" at `S0`. Should have seen: the card check the plan names — it is the only instrument, so the card must be burned before S2 is described as closing the stationary-beam hazard.
3. **The close report told Lee that after S2 a controller hold "offers only STOP and a console `~`".** Kerf cannot see a controller hold mid-job; the console `~` claim was never verified; the real behaviour is a stream that blocks. Should have seen: `pollStatus:535` and `:318`.
Type-specific worst case: a stationary beam at a cell start on the owner's material (the card catches it); a stop reported as a completed job (core 3 fixes it).

### Load-bearing assumptions
1. **`M3 S0` is dark on the owner's controller.** Stock-source confidence high; fork unqualifiable by status; the card burn is the resolution. Consequence if wrong: a dot persists, no worse than today.
2. **The opentype mock yields at least one contour per glyph through the real `textObjectToPaths`.** `creatorInvariants` already relies on it; high. Consequence if wrong: P2 reds the baseline (by design) and the battery refuses to run rather than passing vacuously.
3. **`machineState` never reads `"hold"` while `jobRunning` is true.** Verified (Verified 2); RESUME is dead today, so the relabel loses nothing. High.
4. **`pauseJob` ≡ STOP.** False in the drain window (Verified 1). Resolve before implementation.

### Inversion — when would a rejected alternative win?
- **Remove the button (`kerf-f2` = remove).** Wins if the two controls are not identical and keeping them identical is a standing obligation (they are not, and it is: S2-M8 exists only to hold the equivalence), and if no qualified dark hold is coming (status-only ruling: "effectively permanent for now"). Both true. The parent critic already leaned this way; the drain-window finding belongs in the structured question to Lee as the strongest reason for removal. The relabel remains an honest default once core 3 is folded.
- **Export in place instead of moving the generator.** Wins if S3 and S4c did not need the module and the test could import the dialog cheaply; neither is true. Keep the move.
- **Fix the engine's mode lines in this batch.** Wins if the golden fixtures could be regenerated with discipline inside an 8-file TS batch; they cannot (Rust root, frozen engine, fixtures). Park it, loudly, as the plan does.

---

## Overall verdict

**FAIL** — on core 3 (Completeness), with X1 and X5 at CONCERN. The generator half is right and is proved the right way: every mode line `S0`, positive `S` only on motion, four programs through the real emitter under a font mock that cannot pass vacuously, and a burn-card check for the one thing status-only evidence cannot say. The button half is one line short of true. The plan asserts, and would write into the tooltip, the handler comment and ARCHITECTURE, that the relabelled button does "exactly what STOP does"; the tree says STOP cancels the job session and `pauseJob` does not, so a stop pressed during the drain — the last seconds of cutting on a 127-block planner — is reported as an alarm stop on the owner's controller or as a completed job on another. The beam stops either way; the report about it is wrong, and that is the defect this batch exists to remove. The fold is one call and one mutant. Separately, the plan's account of how RESUME is reached today is wrong (it is unreachable while the button is enabled), which is good news for both `kerf-f2` options and must be stated correctly before Lee is asked. The engine parking is safe as a scope call, provided the Parking Lot line says what it is.

## Must-fix, prioritised

1. **Make "same as STOP" true (core 3 / X5).** `pauseJob` (or `handlePauseStop`) calls `stopActiveSession()` fire-and-forget before `setJobRunning(false)`, in `handleStop`'s B3 order with its comment. Add **S2-M8** (delete the call → red) with a test that seeds a real session via `beginJobSession` and asserts `getActiveSession()?.cancelled === true` after the click. If the fix lands in `jobStream.ts`, amend "No code line in `jobStream.ts` changes" and keep the S1b disjointness note.
2. **Correct the RESUME narrative (Verified 2).** Replace "How RESUME is reached today" and the "hold Kerf did not cause" paragraph with the verified facts: state is not written from status reports while a job runs, RESUME is unreachable today, a controller hold mid-job blocks the stream and STOP is the recovery. Drop the unverified "console `~`" recovery. Park the dead hold-wait at `jobStream.ts:348-354` with its stale comment. Carry the corrected account into the `kerf-f2` structured question.
3. **Parking Lot line for the engine (X1).** State it as an X1-class hazard on every M3 layer of every real job, name its own batch and the golden-regeneration discipline it needs, and keep the close-report escalation.
4. **Commit-1 check (core 9 b).** Razor expects exactly: four `export` prefixes, the moved `textToGcode` import, one new dialog import; everything else a pure move under `--color-moved=dimmed-zebra`.
5. **String rule (Verified 3).** Word the header and row comments so they do not contain `STOP (no resume)`, or restate the rule as "the anchor with its indentation and newline occurs once".
6. **Console wording (X6).** Reword "Paused jobs cannot resume …" for a button that no longer says Pause and update the two pinned assertions deliberately, or state why the string stays.
7. **Docs.** Do not write "the same as STOP" into ARCHITECTURE `:439-442`, the tooltip or the handler comment until 1 is folded; add the `jobStream.ts:348-354` comment to the doc-only pass; one Parking Lot line for silent label loss on font-load failure.
8. **Nits.** 39 plan files, not 36; the hold screenshot and hold test are synthetic state, say so.

---

## Re-check after fold (2026-09-25)

**Scope:** bounded re-check of the folded `kerf-safety-s2.md` at `4c08470` (plans-only commits since `8c60666`; `git diff 8c60666..HEAD -- src src-tauri` is empty, so every source citation above still holds). Read: Fold notes, Intent, Existing plans, What exists today, Change, Tests and mutants, Verification, Deferrals, Stage 3.5, Risks; `pause-resume-future.md` header and its hold/drain mentions; `.claude/handoff.md` (`kerf-f2` row and log). Ruling applied: Lee, 2026-09-25, "Leave the pause button for now but ensure we have a plan to make it function in the future."

### (a) Gating items

| Round-1 item | Status | Basis |
|---|---|---|
| Core 3 FAIL / X5 (Pause ≠ STOP in the drain window) | **Removed with the scope**, defect parked | S2 no longer touches `JobActionBar.tsx` or `jobStream.ts`; the defect is today's behaviour of the unchanged button and is recorded as Deferral 2 with the one-line fix and the S2-M8-style mutant. S2 ships no new false claim about the button. |
| Must-fix 2 (RESUME narrative) | **Closed** | "The Pause button today" states the verified facts only: state is written from status reports only via `machineStatus.ts:184`, reached from `pollStatus` which returns while `jobPollingSuspended` (`connection.ts:535`, mirrors `jobRunning` at `:318`); RESUME unreachable; controller hold invisible mid-job; console `~` claim dropped. Re-checked at HEAD: all true. |
| Must-fix 3 (engine Parking Lot line) | **Closed** | Deferral 1 names it X1-class on every M3 layer of every real job, its own batch, `env -u KERF_UPDATE_GOLDEN` discipline, and the close-report escalation. |
| Must-fix 4 (commit-1 residue) | **Closed** | Change §1 lists exactly four `export` prefixes, the moved `textToGcode` import, one new dialog import; Verification and Razor's check name that residue and nothing else. |
| Must-fix 5, 6 (string rule, console wording) | **Fall away** | No button change; the string stays by the ruling. |
| Must-fix 7 (docs) | **Closed** | No "same as STOP" anywhere; no pause ARCHITECTURE delta; hold-wait comment parked (Deferral 3); font-load label loss parked (Deferral 6). |
| X1 CONCERN | **Closed** | Generator half unchanged from round 1 (PASS-quality); the vendor-fork `M3 S0` worst case is now stated in Risks with the card burn as the instrument; the engine hazard is parked as required. |

Nothing gating remains open against S2.

### (b) Internal consistency

- **File count:** `materialTestGcode.ts` (new), `MaterialTestDialog.tsx`, `textGcode.ts`, `textGcode.test.ts`, `materialTestGcode.test.ts` (new) = 5, one root. Matches the Tier line. Two commits (Change) matches "The move is reviewed apart from the arming change".
- **Mutants:** the table's live ids are S2-M1, M2, M3, M5, M6, C1, C2 = seven; the spec sentence, the battery-journal line in Verification and the done condition all say the same seven. S2-M4 and S2-M7 are marked dropped with the ruling; S2-M8 is not in the spec and lives in Deferral 2. The spec strings section carries exactly the seven. Every `find` is unchanged from round 1 and still unique at HEAD.
- **`test_command`:** two files (`materialTestGcode.test.ts`, `textGcode.test.ts`); Verification calls it "the two-file `test_command`"; `machineJobLoop.test.tsx` is run separately as "unchanged and green", which is right since it imports the dialog and so exercises the moved generator.
- **Dropped-scope references:** every remaining mention of `JobActionBar.tsx`, `jobStream.ts`, `pauseJob`, `resumeJob`, `handlePauseResume`, `machineJobLoop.test.tsx:716-775` and `kerf-f2` is in a facts-only, deferral or hand-off context; none instructs a change to the button. Deferrals 1-6 match "Parking Lot lines 1-6" in Stage 3.5. The Intent's fourth bullet and "What S2 does not satisfy" both name the button as out of scope by the ruling. Consistent.

### (c) Anything new that is wrong?

Spot-checked at HEAD: `geometry/index.ts:669` `sampleBezierPath` (the canvas-display hunk starts at `:391`) — exact; `JobActionBar.tsx:106-111` and `:110` — exact; `jobSession.ts:243-248` — exact; `jobStream.ts:413` drain call and `:348-354` hold-wait — exact; `connection.ts:535`, `:318` — exact; `machineStatus.ts:184` — exact; `docs/test-card.md:57-63` — exact; `creatorInvariants.test.ts:24-26`, `:59-85` — exact. The "no visual change" claim for the `.tsx` touch is true (imports and a deletion only). Nothing new is wrong in the plan.

**One residual, not in S2's gate:** the plan and the hand-off say Deferrals 2, 3 and 4 are "owned by `pause-resume-future.md`", but that file does not mention `stopActiveSession`, the drain window, or the dead hold-wait; its only hold-wait sentence (`:112`, "the per-line hold-wait already exits on `jobRunning = false`") leans on the dead code Deferral 3 names. Ownership is currently a pointer to nothing. Owed before that plan's own critic runs: carry Deferrals 2-4 into `pause-resume-future.md` verbatim, and re-read its `:112` against the fact that the hold-wait can never enter. S2's Stage 3.5 Parking Lot lines still index all six, so S2 itself is not blocked.

**Nits:** `.claude/plans/` holds 43 `.md` files now (the fold counted 42; the S3 critic landed since). The hand-off's `kerf-f2` row reads "resolved 2026-09-26" while its log entry and the ruling are dated 2026-09-25; one of the two is off by a day (UTC, probably) and should say which.

### Overall verdict (after fold)

**PASS** — S2 is dispatchable as the generator half only. The FAIL was carried entirely by the relabel, which Lee's ruling removes; what remains is the half that was already sound in round 1, with the engine hazard, the drain-window defect and the dead hold-wait parked in the plan's own Deferrals and indexed at Stage 3.5. The only open item is that the forward plan named as owner of Deferrals 2-4 does not yet contain them; that is owed to `pause-resume-future.md`, not to this gate.
