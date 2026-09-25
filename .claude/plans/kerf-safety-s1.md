# Kerf safety S1: one admission for all four powered doors, and a laser-mode flag that only readback can set

Lifted from `/home/leesalo/marvin/state/audits/gap-2026-09-24/kerf/PLAN-safety-gate-class.md` §S1 (critic `PLAN-safety-gate-class-critic.md`, CONCERN, folded). The parent descends from `.claude/plans/kerf-relay-plan.md` §A1 (TS half) and that plan's critic must-fix 1. The parent wins wherever this file is silent. Every citation below was re-read at `c9c30db` (session branch `marvin/kerf-gap`, which is master `caa0dcc` plus docs), 2026-09-25.

Relay id `kerf-safety-s1`, branch `relay/kerf-safety-s1`. Tier: Standard (8 files, one root `src/`, `.tsx` touched, so Jen runs a CONCERN pass with no spec).

## Intent (grilled)

Grill skipped. The intent comes from the parent plan's Intent, which cites CHARTER "Done looks like" (1), DECISIONS 2026-09-10 "START refuses to run until laser mode and power scale are written and read back matching", and DECISIONS 2026-09-10 "Variable power (M4) is the default ...". The Summary for this batch:

Every door that can put power into the laser or move the head for a job must pass the same admission: START, main FRAME, the material test grid and the material test FRAME. Today only START calls `canStartJob`. The laser-mode flag must mean "the controller reported `$32=1` when read back". Today it means "the controller answered `ok` once".

## Existing plans reviewed

Before writing this I checked the primary's `.claude/plans/`: 25 files plus `archive/` (3). I also checked the audit directory: the three `PLAN-*` files, their critics, `GAPS.md` and `PLANS-REVIEW.md`. No file there edits `canStartJob.ts`, `MaterialTestDialog.tsx`, `JobActionBar.tsx`, `Console.tsx` or `connection.ts`, apart from the parent's own later batches:
- S2 edits `MaterialTestDialog.tsx`, `JobActionBar.tsx` and `jobStream.ts`, and runs after this batch.
- S3 edits `connection.ts` (`jog`/`jogTo`) and `MaterialTestDialog.tsx`, and runs after S2.
- S4b and S4c consume the setter written here.

The relay running concurrently (`kerf-refresh-cut-vs-screen`) edits none of these files. The Stage 0 re-check repeats this inventory.

## Doors today (verified)

| Door | Where | What it checks now |
|---|---|---|
| START | `JobActionBar.tsx:66-73` `handleStartJob` | `canStartJob(useStore.getState())`: connected, `statusStale`, `grblLaserMode`, not alarm, idle, not running, `gcodeResult`, not `gcodeStale`, `workspaceVerified`, `originTop`-aware bounds (`canStartJob.ts:150-197`) |
| main FRAME | `JobActionBar.tsx:120-170` `handleFrame`; button gate `frameDisabled` `:189-197` | Handler: `workspaceVerified` and bounds only. Button: a hand-rolled copy of the gate with **no `statusStale` term** |
| material grid | `MaterialTestDialog.tsx:389-417` (the `else` send branch of `handleGenerate`) | Connected, `jobRunning`, bounds **without `originTop`** (`:401`). No `grblLaserMode`, idle, alarm, `statusStale` or `workspaceVerified` check |
| material FRAME | `MaterialTestDialog.tsx:420-449` `handleFrame` | Same as the material grid (`:433`) |

The laser-mode flag:
- `connection.ts:595-616` `enableLaserMode` calls `setGrblLaserMode(true)` whenever any response line is `ok` (`:601-603`).
- `queryGrblSettings` (`:621-`) sets the flag from a `$32=` line (`:668-673`). When the readback contains **no** `$32` line, it leaves the previous value untouched. It also calls `setMachineHomed(false)` on entry (`:624`), because it was written for connect.
- `Console.tsx:26-42` `handleSend` passes any command straight to `machineConnection.send` and never touches the flag.

## Change

### 1. `src/lib/machine/canStartJob.ts`
- Signature: `canStartJob(state: JobGateState, ext?: MovesExtents | null): JobGate`.
- With `ext` **omitted**, behaviour is byte-identical to today. START and main FRAME use this form.
- With `ext` **supplied**, the doors are the material grid and the material FRAME, whose G-code is generated locally and is not the design's `gcodeResult`:
  - skip the `gcodeResult` and `gcodeStale` checks (critic must-fix 1b: otherwise the material test refuses whenever the design is not generated);
  - use `ext` for bounds, with `originTop`;
  - `ext === null` refuses: "Nothing to send -- the generated program has no moves".
- Every other check applies to all four doors: connected, `statusStale`, `grblLaserMode`, alarm, idle, `jobRunning`, `workspaceVerified`. The ordering of reasons is unchanged.
- The material test inherits two new refusals: the machine must be idle, and the bed must be verified. The Ted report names both. So does the dialog, because it surfaces `reason` verbatim.

### 2. `src/components/panels/JobActionBar.tsx` (`handleFrame` and `frameDisabled` only)
- `handleFrame` replaces its `workspaceVerified` + `isWithinBounds` guard (`:127-152`) with `canStartJob(useStore.getState())`. **No `ext`:** main FRAME traces the design's `gcodeResult`, so the `gcodeResult`/`gcodeStale` checks must still apply. This refines the parent's "FRAME with `ext = movesExtents(moves)`", which would have skipped `gcodeStale` for FRAME and let it trace a stale design.
- Surface `reason` as `FRAME blocked: <reason>`. Keep the `frameTargets` null-check and the M5-bracketed program exactly as they are.
- `frameDisabled` becomes `!startGate.ok`. `startGate` is already computed at `:173-185` from individual scalars, so no selector is added. This removes the hand-rolled copy and with it the missing `statusStale` term.
- Keep `frameHint`, but it must not contradict the gate: when `!startGate.ok` and none of its existing branches match, show `startGate.reason`.

### 3. `src/components/panels/MaterialTestDialog.tsx` (the send branch of `handleGenerate`, and `handleFrame`, only)
- Replace the hand-rolled connected / `jobRunning` / bounds checks at `:391-407` and `:422-439` with `const gate = canStartJob(state, gcodeExtents(gcode))`. When it refuses, add `reason` to the console (prefixed `Material test blocked:` or `Frame blocked:`) and `return`, so the dialog stays open, as today.
- On an origin-top machine this now correctly refuses the positive-Y grid until S3 mirrors it. That is expected (parent Authority notes: S1 and S3 go into the same build).
- `showLaserWarning` (`:451`) stays as copy.

### 4. `src/components/bottom/Console.tsx` (`handleSend` only)
- Before `machineConnection.send(cmd)`, call `machineConnection.invalidateGrblSettings()` when `cmd` is a settings write: it matches `/^\$\d+\s*=/`, `/^\$N\d*\s*=/i` (a startup block, which runs after every reset, including Kerf's own 0x18 stop) or `/^\$RST\s*=/i`.
- `$X`, `$H`, `$$`, `$#`, `$I`, `$G`, `$C` and `$J=` are not writes and do not invalidate.
- The `$N` pattern goes beyond the parent: a startup line such as `$N0=$32=0` would take effect at the next reset without any later `$32` write.

### 5. `src/lib/machine/connection.ts` (`enableLaserMode`, new `invalidateGrblSettings`, the `$32` handling in `queryGrblSettings`, and a new private readback helper only)
- **A settings generation counter**, module-level (not store state, so no selector churn): `let settingsGeneration = 0`.
- **`invalidateGrblSettings()`:** increments `settingsGeneration`, sets `grblLaserMode = false`, and adds the console line "Settings changed -- re-verify with $$ before starting a job" (warning).
  - Per critic must-fix 1a, it does **not** touch `grblSValueMax`: there is no "unread" sentinel, and changing a number that feeds G-code is outside this batch. `$30` staleness is S4a/S4b's job.
- **One setter, one source (parent Inversion 3):**
  - Add a private `applyLaserModeReadback(responses: string[], genAtStart: number)`. It is the **only** code that sets `grblLaserMode` true.
  - It sets `grblLaserMode = (a $32=1 line is present) && genAtStart === settingsGeneration`.
  - With `$32=0`, or no `$32` line at all, it sets `false` and prints the warning.
  - A readback that began before an invalidation cannot set `true`.
  - S4b swaps what feeds this setter (the native snapshot). It does not add a second setter.
- **`queryGrblSettings` changes:**
  - Capture `const gen = settingsGeneration` before the `invoke`.
  - Route the `$32` decision through `applyLaserModeReadback(outcome.responses, gen)` instead of `:668-673`. Keep the `$32=` info console line.
  - A readback with no `$32` line now leaves the flag false instead of stale-true. That is fail-closed, and it is the critic's "`$32` absent" control.
  - Everything else in the function is unchanged.
- **`enableLaserMode`:**
  - After the `$32=1` send, if an `ok` came back, run a `$$` readback through the private helper.
  - Set the flag **only** through `applyLaserModeReadback`. A bare `ok` is not enough.
  - It must **not** call `queryGrblSettings` as it stands, because that calls `setMachineHomed(false)` (`:624`) and would silently un-home the machine. Either:
    - (a) move `setMachineHomed(false)` from `queryGrblSettings` into `connect()`, just before its `queryGrblSettings` call at `:181`, and have `enableLaserMode` call `queryGrblSettings`; or
    - (b) factor the `$$` send and parse into a helper that both call.
  - Ted picks one and names it. Either way, a connect must still reset `machineHomed`, and a test pins that.
  - The return value becomes "flag set by readback".
- Do not touch `emergencyStop`, `softReset`, `feedHold`, `jog`, `jogTo`, the `FS:` block, or anything in `send()`.

## Tests (each mutant goes through `~/marvin/scripts/mutation-battery.mjs`, spec `kerf-safety-s1`, ids exactly as below)

Drive the rendered dialog and bar through `serialTraceHarness.ts`, and `connection.ts` through its existing test mocks. A test-local copy of the gate is forbidden (relay-plan ground rule 8).

| Id | Test | Wrong variant (must turn it red) |
|---|---|---|
| S1-M1 | Material grid send with `grblLaserMode=false` refuses before any `serial_send`/`serial_stream_job` in the recorder; the dialog stays open; the console reason names `$32` | delete the `canStartJob` call in the send branch |
| S1-M2 | Material FRAME, same | delete the call in the material `handleFrame` |
| S1-M3 | Main FRAME with `grblLaserMode=false` and fresh G-code: `handleFrame` refuses with zero sends | delete the call in `JobActionBar.handleFrame` (restore the old guard) |
| S1-M4 | Main FRAME with `statusStale=true`: the button is disabled and the handler refuses | restore the hand-rolled `frameDisabled` (no `statusStale` term) |
| S1-M5 | Connected, `grblLaserMode=true`; the console sends `$32=0`; START (rendered `JobActionBar`) refuses | delete the invalidate call in `Console.tsx` |
| S1-C1 | (control) the console sends `$X`: `grblLaserMode` is unchanged | a hook that invalidates on every `$` goes red here |
| S1-M6 | `enableLaserMode()` with `ok`, then a `$$` readback showing `$32=0`: the flag stays false and the warning is printed | restore bare-`ok` acceptance |
| S1-M7 | Material grid whose extents fit the bed only in the wrong frame, with `originTop=true`: it refuses through the same reason as START | drop `originTop` from the material bounds path |
| S1-M8 | Readback with **no** `$32` line (flag previously true): the flag becomes false | "absent `$32` leaves the flag unchanged or sets it true" |
| S1-M9 | Stale readback: `queryGrblSettings` starts, `invalidateGrblSettings()` runs before its `invoke` resolves, and the readback then returns `$32=1`: the flag stays false | ignore the generation check |
| S1-C2 | (control) `enableLaserMode()` with `ok` and readback `$32=1`: the flag is true | a gate that never sets true goes red here |
| S1-C3 | (control) the material grid with a verified bed, laser mode on, idle, and **no design G-code generated** is admitted | the critic's false refusal (with `ext` supplied, the `gcodeResult` check is not skipped) goes red here |
| S1-C4 | (control) `enableLaserMode()` does not change `machineHomed`, and `connect()` still resets it | a readback that resets homing goes red here |
| S1-M10 | Main FRAME with `gcodeStale=true` refuses | pass `ext` in `handleFrame` (the parent's literal wording) |

## Verification

- `npx vitest run src/lib/machine/__tests__/canStartJob.test.ts src/lib/machine/__tests__/connection.test.ts src/components/panels/__tests__/machineJobLoop.test.tsx`
- `npx tsc --noEmit`
- `npm test`: the baseline measured at relay start plus the new tests, none weakened.
- `npm run lint`: no new warnings.
- `npm run format:check`
- Battery journal: every S1-M* red, every S1-C* green.
- Browser (`npm run dev` + Chrome DevTools MCP):
  - Store-driven. With laser mode off, open the material test dialog and click Send: the console shows the `$32` reason and the dialog stays open.
  - Toggle `statusStale` via the store: the main FRAME button disables.
  - The machine connection itself is not browser-reachable, so `enableLaserMode` is covered by unit tests only. Say so.
- Hardware-only (named, not skipped; it goes on the owner's next card via the evidence plan's E4): the Falcon's `$$` reply must contain a `$32=` line for the readback rule to ever pass. If it does not, every START refuses after this batch. Checked 2026-09-25: the committed capture `scripts/probe-20260914-153729.log` has `$32=1` in its `$$` block, between `$31=0.000` and `$100=80.000`, so the rule can pass on this controller. The owner check confirms a live `$$` still carries it. Do not copy the controller identity into any test.

## What S1 does not satisfy

It does not satisfy the power-scale half of the 2026-09-10 START ruling. Until S4b lands, admission still reads a `grblSValueMax` that may come from localStorage (`store/index.ts:544-549`). The relay report must say so and must not report the ruling as met.

## Stage 3.5 obligations (orchestrator)

- Append the parent's five Out-of-scope lines to ROADMAP `## Parking Lot`, in the existing `- **Title** — detail.` shape:
  1. WPos/MPos conversion and WCO-aware jog envelopes
  2. `$23` sign inference and automatic homing/unlock
  3. Astra 2.3 and 2.6 (2.3 waits on `kerf-d9`)
  4. Any change to the stop, reset, fence or submit lock
  5. `$31` / Min Pwr (`kerf-d11`)
- Add an ARCHITECTURE.md delta: one admission function for four doors, and the flag is readback-only.

## Risks and rollback

- **Readback too strict:** if the vendor `$$` omits `$32`, every job refuses. This is mitigated by the probe-log read above. If `$32=` is absent there, stop and report BLOCKED rather than weakening the rule.
- **Material-test copy changes:** new refusals, idle-required and bed-verified, which are intended.
- **Rollback:** revert the relay merge commit. It is independent of every other batch until S2.
- **Irreversible steps:** none. No controller setting is written by code in this batch beyond the existing operator-initiated `$32=1` button.
