# Kerf safety S1: one admission for all four powered doors, and a laser-mode flag that only a readback can set

**Lifted from:** `/home/leesalo/marvin/state/audits/gap-2026-09-24/kerf/PLAN-safety-gate-class.md` §S1 (critic `PLAN-safety-gate-class-critic.md`, CONCERN, folded).

**Lineage:** `.claude/plans/kerf-relay-plan.md` §A1 (TS half) and that plan's critic must-fix 1. The parent plan wins wherever this file is silent.

**Citations:** re-read at `3a0d735`, on session branch `marvin/kerf-gap`, whose ancestor is master `caa0dcc` (2026-09-25).

- **Relay id:** `kerf-safety-s1`
- **Branch:** `relay/kerf-safety-s1`
- **Tier:** Standard. 8 files in one root (`src/`). `.tsx` is touched, so Jen does a CONCERN pass with no spec.

## Intent (grilled)

Grill skipped. The intent is taken from the parent's Intent, which cites:
- CHARTER "Done looks like" (1)
- DECISIONS 2026-09-10: "START refuses to run until laser mode and power scale are written and read back matching"
- DECISIONS 2026-09-10: "Variable power (M4) is the default ..."

Summary for this batch:
- Every door that can put power into the laser or move the head for a job must pass the same admission. The four doors are START, main FRAME, the material-test grid, and the material-test FRAME. Today only START calls `canStartJob`.
- The laser-mode flag must mean "the controller reported `$32=1` when read back". Today it means one of two things: "the controller answered `ok` once" (the Enable Laser Mode button), or "the operator asked for `$32=1`" (the settings dialog, which never looks at the reply).

## Existing plans reviewed

**Inventory, checked with `ls` on 2026-09-25:**
- Primary `.claude/plans/`: 23 `.md` files plus `archive/` (3 files).
- Session branch: also carries the lifted `kerf-relay-plan.md` and its critic, `kerf-evidence-e1a.md` and its critic, and this file.
- Audit directory: 9 files.

**Other plans that touch the files this batch edits:**
- No other plan edits `canStartJob.ts`, `MaterialTestDialog.tsx`, `JobActionBar.tsx`, `GrblSettingsDialog.tsx`, or the `send`/`enableLaserMode`/settings-readback region of `connection.ts`.
- The parent's own later batches do:
  - S2: `MaterialTestDialog.tsx` generator, the `JobActionBar.tsx` Pause label.
  - S3: `connection.ts` `jog`/`jogTo`, `MaterialTestDialog.tsx` mirroring.
  - S4b: `GrblSettingsDialog.tsx`, `connection.ts`, consuming the setter written here.
  - All of them run after this batch.

**Relays running now:**
- `kerf-refresh-cut-vs-screen` edits none of these files.
- Evidence E1a (lifted) edits only `gcodeGen.ts` and its test.

The Stage 0 re-check repeats this inventory.

## The doors today (verified)

| Door | Where | What it checks today |
|---|---|---|
| START | `JobActionBar.tsx:66-93` `handleStartJob` | `canStartJob(useStore.getState())`, which checks: connected, `statusStale`, `grblLaserMode`, not alarm, idle, not running, `gcodeResult`, not `gcodeStale`, `workspaceVerified`, and `originTop`-aware bounds (`canStartJob.ts:150-197`). On refusal it prints `gate.reason` verbatim (`:71`). |
| Main FRAME | `JobActionBar.tsx:120-170` `handleFrame`; button gate `frameDisabled` at `:189-197` | The handler checks only `workspaceVerified` and bounds. The button uses a hand-rolled copy that has no `statusStale` term. |
| Material grid | `MaterialTestDialog.tsx:389-417` (the send branch of `handleGenerate`) | Connected, `jobRunning`, and bounds **without `originTop`** (`:401`). The dialog's Send button `disabled` omits `grblLaserMode`, `statusStale` and `workspaceVerified`. |
| Material FRAME | `MaterialTestDialog.tsx:420-449` `handleFrame` | Same as the material grid (`:433`). |

**Setters of `grblLaserMode` today:** there are three, and none of them requires a readback.
1. `enableLaserMode` sets it on any `ok` (`connection.ts:601-603`).
2. `queryGrblSettings` sets it from a `$32=` line (`:668-673`). With no `$32` line it leaves the flag as it was, and its `catch` (`:706-709`) also leaves it untouched.
3. `GrblSettingsDialog.saveSetting` sends `$32=<v>` with a bare `machineConnection.send` (`:110`). It then sets the flag from the **requested** value (`:116`), with no `ok` check and no readback.

**Settings writes that change the controller without touching the flag:**
- `Console.tsx:26-42`
- `GrblSettingsDialog.tsx:110`
- The soft-limit buttons in `MachinePanel.tsx:452` and `:518-520`, which follow up with `queryGrblSettings`.

All of them go through `machineConnection.send()` (`connection.ts:286-340`). That function parses nothing, so a `$$` typed in the console re-reads nothing, even though the connect warning at `:217` tells the operator to "Run $$ in the console to retry".

**`queryGrblSettings` resets homing on purpose.** It calls `setMachineHomed(false)` on entry (`:624`). `machineSafety.test.ts:201` pins that reset. The soft-limit buttons rely on it: `softLimitsActive` derives from `machineHomed` (`store/index.ts:596`), and the button copy is "Run Home ($H) to activate".

## Change

### 1. `src/lib/machine/canStartJob.ts`

- **Signature:** `canStartJob(state: JobGateState, ext?: MovesExtents | null): JobGate`.
- **With `ext` omitted:** behaviour is byte-identical to today. START and main FRAME use this form.
- **With `ext` supplied:** this is the material grid and material FRAME, whose G-code is generated locally.
  - Skip the `gcodeResult`/`gcodeStale` checks (critic must-fix 1b).
  - Bounds use `ext` with `originTop`.
  - `ext === null` refuses with "Nothing to send -- the generated program has no moves".
- **All other checks apply to all four doors:** connected, `statusStale`, `grblLaserMode`, alarm, idle, `jobRunning`, `workspaceVerified`. The reason ordering is unchanged.
- **New refusals the material test inherits:** idle is required, and the bed must be verified. The Ted report names both. They are plumbing under the parent Intent, not a scope call: the owner's `$130/$131` are set in the probe capture, so the bed refusal will not bite on this controller.

### 2. `src/components/panels/JobActionBar.tsx` (`handleFrame` and `frameDisabled` only)

- **`handleFrame` gate:** its first act becomes `const gate = canStartJob(useStore.getState()); if (!gate.ok) { addConsoleLine(gate.reason!, "error"); return; }`. The reason is printed **verbatim with no prefix**, exactly as `handleStartJob:71` does.
  - `machineJobLoop.test.tsx:468` asserts the gate's own "Nothing to cut -- no moves in the generated G-code" string as an array element. A prefix would red the baseline.
  - The call passes **no `ext`**. Main FRAME traces the design's `gcodeResult`, so `gcodeStale` must still apply (already pinned at `machineJobLoop.test.tsx:425`). This refines the parent's "FRAME with `ext = movesExtents(moves)`".
- **Guards removed:** the handler's old `workspaceVerified` and bounds guards (`:127-152`) are deleted, because the gate now covers them.
- **Kept exactly as it is:** the `frameTargets` null-check and the M5-bracketed program.
- **`frameDisabled`** becomes `!startGate.ok`. `startGate` is already computed at `:173-185` from individual scalars, so no selector is added.
- **`frameHint`** stays, but falls back to `startGate.reason` when none of its branches match.

### 3. `src/components/panels/MaterialTestDialog.tsx` (the `handleGenerate` send branch and `handleFrame` only)

- Replace the hand-rolled checks at `:391-407` and `:422-439` with `const gate = canStartJob(state, gcodeExtents(gcode))`.
- On refusal, print `gate.reason` verbatim (error) and `return`. The dialog stays open.
- The Send/Frame buttons' own `disabled` props are left as they are. The handler is the gate.
- On an origin-top machine this now refuses the positive-Y grid until S3 mirrors it. This is expected (parent Authority notes: S1 and S3 ship in the same build).
- `exceedsWorkspace` (`:335`) is a third bounds copy. It stays as a live UI hint only, is not a gate, and is noted under Stage 3.5.

### 4. `src/components/panels/GrblSettingsDialog.tsx` (`saveSetting` only)

- Delete the `key === 32` branch at `:115-116`. It is the second setter.
- In its place, after the `send`, call `await machineConnection.readbackGrblSettings()` when `key === 32`, so the dialog's result is what the controller reports.
- The `key === 30` branch (`:113-114`, which sets S-max from the requested value) is S4b's to fix ("generator mirrors update only from the readback"). It is left alone here and named in the report.

### 5. `src/lib/machine/connection.ts`

These are the only edits: `send`, `enableLaserMode`, `queryGrblSettings`, a new `readbackGrblSettings`, and module-level helpers.

- **Generation counter:** module-level `let settingsGeneration = 0`. It is not store state, so it causes no selector churn.
- **`export function isGrblSettingsWrite(cmd: string): boolean`:** true for `/^\$\d+\s*=/`, `/^\$N\d*\s*=/i` and `/^\$RST\s*=/i`, after trimming.
  - A startup block runs after every reset, including Kerf's own 0x18 stop, so `$N0=$32=0` would take effect with no later `$32` write.
  - `$X`, `$H`, `$$`, `$#`, `$I`, `$G`, `$C`, `$J=` and G-code are not writes.
- **One chokepoint, in `send()`:**
  - Before the `invoke`, if `isGrblSettingsWrite(command)`, call `invalidateGrblSettings()`. That covers the console, the settings dialog and the soft-limit buttons with no caller edits. `Console.tsx` is not edited.
  - After the `invoke`, if `command.trim() === "$$"`, feed the responses to the readback parser (below). A console `$$` then re-verifies, which makes the existing "Run $$ in the console to retry" copy (`:217`) true.
  - Per-line job lines never match the classifier, so the cost there is one regex test.
- **`invalidateGrblSettings()`:**
  - Increments `settingsGeneration`.
  - Sets `grblLaserMode = false`.
  - Prints one warning line: "Settings changed -- laser mode must be re-verified (Enable Laser Mode, $$ in the console, or reconnect) before starting a job".
  - Does **not** touch `grblSValueMax`. There is no "unread" sentinel, and `$30` staleness belongs to S4a/S4b.
- **One setter:** private `applyLaserModeReadback(responses: string[], genAtStart: number)` is the **only** code that sets `grblLaserMode` true.
  - It sets `grblLaserMode = responses.some(l => /^\$32=1(\.0+)?\s*$/.test(l.trim())) && genAtStart === settingsGeneration`.
  - It prints only the existing `$32=<v> (laser mode ...)` info line, when a `$32` line is present. It prints no warning of its own.
  - The connect warning at `:205-214` stays where it is. So does the assertion at `connection.test.ts:383` that the warning is absent on a failed parse.
  - S4b swaps what feeds this setter (the native snapshot). It does not add a second setter.
- **`readbackGrblSettings()`:** the existing `$$` send and parse body of `queryGrblSettings` (`:625-709`) moves here unchanged, applying `$20-22`, `$30`, `$110/111`, `$120/121` and `$130/131` as today, with two differences:
  - The `$32` branch (`:668-673`) routes through `applyLaserModeReadback(outcome.responses, gen)`, with `gen` captured before the `invoke`.
  - The `catch` calls `applyLaserModeReadback([], gen)`, so a readback that never returned leaves the flag **false**. Today it leaves the flag as it was, so a reconnect whose `$$` rejects would keep a stale `true`.
  - It returns `parsedAny` as today.
- **`queryGrblSettings()`** becomes `setMachineHomed(false)` followed by `return this.readbackGrblSettings()`. The pinned homing reset stays inside it, so `machineSafety.test.ts:201` and the soft-limit buttons are unchanged.
- **`enableLaserMode()`:**
  - After the `$32=1` send (which itself invalidates through `send()`'s classifier), call `readbackGrblSettings()`. It does **not** call `queryGrblSettings`, so homing is not reset.
  - It returns the flag afterwards. If the flag is false, it prints the existing "may not have been accepted" warning, naming what the readback showed.
- **Out of bounds for this batch:** do not touch `emergencyStop`, `softReset`, `feedHold`, `jog`, `jogTo`, the `FS:` block, the `connect()` body, or any part of `send()` except the two hooks above.
- **X5 residual (stated, not fixed):** `invalidateGrblSettings` runs before the `invoke`, but invoke order is not a guaranteed wire order across concurrent Tauri commands. The native snapshot (S4a) closes that gap.

## Tests and mutants

Battery spec `kerf-safety-s1`.

- `test_command` is `["npx","vitest","run","src/lib/machine/__tests__/canStartJob.test.ts","src/lib/machine/__tests__/connection.test.ts","src/components/panels/__tests__/machineJobLoop.test.tsx"]`. The baseline must be green (the battery refuses a red one).
- Every id below is one contiguous find/replace (`mutation-battery.mjs:1553-1560`) and must be **killed**.
- The battery has no "stays green" outcome. A *control* (C) is therefore a test that is green at baseline and whose named wrong variant turns it red. Its id appears in the journal as a killed mutant, like any other.
- Drive the rendered bar and dialog through `serialTraceHarness.ts`, and `connection.ts` through its existing mocks. A test-local copy of the gate is forbidden.

**Technique for handler mutants (S1-M3, S1-M10, S1-M1, S1-M2):**
1. Render with the gate open.
2. `useStore.setState` the refusing field.
3. `fireEvent.click` synchronously, with no intervening `await`, so React has not re-rendered the button disabled.
4. Assert zero sends in the recorder.

An assertion on `disabled` alone leaves these mutants alive, because after this batch `frameDisabled` is the same predicate. S1-M4 is the one test that asserts `disabled`.

| Id | Test | Wrong variant (one edit) |
|---|---|---|
| S1-M1 | The material grid send with `grblLaserMode=false` makes zero `serial_send`/`serial_stream_job` calls; the dialog stays open; the reason names `$32` | Delete the `canStartJob` refusal in the send branch |
| S1-M2 | Same for the material FRAME | Delete it in the material `handleFrame` |
| S1-M3 | Main FRAME handler with `grblLaserMode=false` and fresh G-code makes zero sends | Delete the gate call in `JobActionBar.handleFrame` |
| S1-M4 | Main FRAME button is disabled when `statusStale=true` | `frameDisabled` without the gate (restore the hand-rolled expression) |
| S1-M5 | Connected with `grblLaserMode=true`, the console sends `$32=0`, and START (rendered) then refuses | Make `send()` skip the invalidate call |
| S1-C1 | The console sends `$X` and `grblLaserMode` is unchanged | Make `isGrblSettingsWrite` return true for any `$`-prefixed command |
| S1-M6 | `enableLaserMode()`: `ok`, then a `$$` readback showing `$32=0`, leaves the flag false | Set the flag on the `ok` (restore `:602-603`) |
| S1-M7 | A material grid that fits only in the wrong frame, with `originTop=true`, refuses | Drop `originTop` from the material bounds path |
| S1-M8 | A readback with **no** `$32` line, after the flag was true, leaves the flag false | Make `applyLaserModeReadback` return early (flag untouched) when no `$32` line is present |
| S1-M9 | A stale readback (invalidation lands before the `invoke` resolves, then `$32=1` comes back) leaves the flag false | Drop the `genAtStart === settingsGeneration` term |
| S1-C2 | `enableLaserMode()` with `ok` and a `$32=1` readback leaves the flag true | Make `applyLaserModeReadback` always set false |
| S1-C3 | The material grid is admitted with bed verified, laser on, idle and **no design G-code generated** | Skip-list without the `ext` branch (with `ext` supplied, the `gcodeResult` check still applies) |
| S1-C4 | `enableLaserMode()` leaves `machineHomed` unchanged (`machineSafety.test.ts:201` keeps pinning the connect reset) | Make `enableLaserMode` call `queryGrblSettings` |
| S1-M10 | Main FRAME handler with `gcodeStale=true` makes zero sends | Pass `movesExtents(moves)` as `ext` in `handleFrame` |
| S1-M11 | The settings dialog saves `$32=1`, the controller answers `error:3`, the readback shows `$32=0`, and the flag stays false | Restore the `:116` requested-value setter |
| S1-M12 | The settings dialog saves `$N0=G21` and the flag becomes false (invalidated) | Remove the `$N` alternative from `isGrblSettingsWrite` |
| S1-M13 | A readback whose `invoke` rejects, after the flag was true, leaves the flag false | Remove `applyLaserModeReadback([], gen)` from the `catch` |
| S1-M14 | A console `$$` whose responses contain `$32=1`, after an invalidation, leaves the flag true | Remove the `$$` hook from `send()` |

`GrblSettingsDialog`'s tests live wherever that dialog is tested today. Ted names the file. If no test file exists, S1-M11 and S1-M12 go in `machineJobLoop.test.tsx` through the rendered dialog, and the report says so. A ninth file is not added without a waiver.

## Verification

- The three-file `test_command` above.
- `npx vitest run src/lib/machine/__tests__/machineSafety.test.ts`: unchanged and green.
- `npx tsc --noEmit`.
- `npm test`: the baseline measured at relay start plus the new tests, none weakened.
- `npm run lint`: no new warnings.
- `npm run format:check`.
- Battery journal: every S1-M* and S1-C* id **killed**; zero survived, errored or CONTROL_RED.

**Browser (`npm run dev` + Chrome DevTools MCP):**
- Store-driven. With laser mode off, open the material test and click Send: the console shows the `$32` reason and the dialog stays open.
- Toggle `statusStale` via the store: the main FRAME button disables.
- The serial connection itself is not browser-reachable. The readback paths are covered by unit tests only; say so.

**Hardware-only (named, not skipped; goes on the owner's next card via evidence E4):**
- The committed capture `scripts/probe-20260914-153729.log` carries `$32=1` in its `$$` block (between `$31=0.000` and `$100=80.000`), so the rule can pass on this controller.
- The owner check is to confirm a live `$$` still carries it, and that Enable Laser Mode now shows enabled only after its readback.
- Do not copy the controller identity into any test.

## What S1 does not satisfy

- **The power-scale half of the 2026-09-10 START ruling.** Until S4b, admission reads a `grblSValueMax` that may come from localStorage (`store/index.ts:544-549`), and the settings dialog's `$30` branch still sets it from the requested value. The relay report must say so and must not report the ruling as met.
- **Wire-order races (X5 residual above):** S4a.

## Stage 3.5 obligations (orchestrator)

**ROADMAP `## Parking Lot`:** append the parent's five Out-of-scope lines, in the existing `- **Title** — detail.` shape:
1. WPos/MPos conversion and WCO-aware jog envelopes
2. `$23` sign inference and automatic homing/unlock
3. Astra 2.3 and 2.6 (2.3 waits on `kerf-d9`)
4. Any change to the stop, reset, fence or submit lock
5. `$31` / Min Pwr (`kerf-d11`)

Plus two new lines:
- **Fire button is a powered door outside the admission.** `MachinePanel.tsx:895-905` fires the beam stationary for focus/test by design (M3 is for the stationary beam, DECISIONS 2026-09-10). Its gating is not unified with the four job doors; it needs its own review.
- **Material test `exceedsWorkspace` is a third bounds copy.** `MaterialTestDialog.tsx:335` is a UI hint that can disagree with the gate, which now decides.

**ARCHITECTURE.md delta:** one admission function for four doors; the laser-mode flag is set only by `applyLaserModeReadback`; settings writes are detected in `send()`.

## Risks and rollback

- **The readback could be too strict.** If a live `$$` omits `$32`, every job refuses. The committed capture has it. If a Ted fixture or the owner check shows otherwise, stop and report BLOCKED rather than weaken the rule.
- **Operator-visible changes (intended):**
  - The material test gains idle-required and bed-verified refusals.
  - Any settings write clears laser mode until it is re-read. The soft-limit buttons re-read immediately, so they are unaffected.
  - The settings dialog shows laser mode on only after the controller confirms it.
- **Rollback:** revert the relay merge commit. It is independent of every other batch until S2.
- **Irreversible steps:** none. No code writes any controller setting except the existing operator-initiated `$32=1` button.

## Critic fold (2026-09-25)

Critic: `kerf-safety-s1-critic.md` (Fable), verdict FAIL on core 3, with X1 and X5 CONCERN. The design and both departures from the parent were judged correct. Every must-fix below was checked against the tree before folding.

1. **Second setter and bypassing write paths.** Verified: `GrblSettingsDialog.tsx:110,116`, `MachinePanel.tsx:452,518-520`. The classifier now lives in `send()` as the one chokepoint. The dialog's requested-value setter is deleted, and the dialog reads back instead. `Console.tsx` drops out of the file list and `GrblSettingsDialog.tsx` comes in, so it stays at 8 files. Adds S1-M11 and S1-M12.
2. **Rejected readback leaves the flag stale.** Verified at `:706-709`. The `catch` now clears the flag. Adds S1-M13.
3. **Handler mutants unreachable through a disabled button.** The technique is named, and `disabled`-only assertions are ruled out for them.
4. **Prefix would red the baseline.** Verified at `machineJobLoop.test.tsx:468`. The prefix is dropped and reasons are printed verbatim.
5. **Option (a) moved the pinned homing reset.** Verified at `machineSafety.test.ts:201`. Option (a) is struck. `readbackGrblSettings` is defined, with what it applies stated.
6. **Console output defined.** The setter prints no warning. The connect warning and `connection.test.ts:383` are untouched.
7. **Battery semantics.** Verified: the battery has no control outcome and `CONTROL_RED` is a failure. Controls are defined as killed mutants, and `test_command` is named.
8. **The invalidation copy was untrue.** Console `$$` now re-verifies (S1-M14), and the copy names all three ways to re-verify. The X5 residual is stated.
9. **Named what stays.** The Fire button and `exceedsWorkspace` go to the Parking Lot.
10. **Nits.** 23 files; `:66-93`; read at `3a0d735`.

Rejected: the critic's alternative for 1 (keep the Console hook, add a ninth file with a waiver). The `send()` chokepoint covers every write path with fewer edits, and the critic offered it as the primary fix.
