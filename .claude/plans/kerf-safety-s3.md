# Kerf safety S3: a jog never overshoots the bed or reverses, the material test lands in the machine's frame, and a stale status never looks safe

**Lifted from:** `/home/leesalo/marvin/state/audits/gap-2026-09-24/kerf/PLAN-safety-gate-class.md` §S3 and its decision `kerf-f1` (critic `PLAN-safety-gate-class-critic.md`, CONCERN, folded).

**Lineage:** `.claude/plans/kerf-relay-plan.md` §A3, tests 1-8, and astra 2.5 bounded ("Unknown frame blocks rather than assuming positive coordinates"). The parent plan wins wherever this file is silent. Where this file departs from A3 or the parent, the departure is named under "Departures".

**Citations:** re-read at `8c60666` on session branch `marvin/kerf-gap` (2026-09-25). The critic re-read at `def80c0`; `git diff 8c60666 HEAD --stat -- src` is empty, so every code citation stands. S1 is merged (`df8883a`). S2 is not merged: its folded plan is `.claude/plans/kerf-safety-s2.md` (fold commit `4c08470`, now being implemented).

- **Relay id:** `kerf-safety-s3`
- **Branch:** `relay/kerf-safety-s3`
- **Tier:** Standard. 14 files in one root (`src/`), over the 8-file cap; waiver below. `.tsx` is touched, so Jen does a CONCERN pass with no spec.

## Fold notes (2026-09-25)

**Critic:** `.claude/plans/kerf-safety-s3-critic.md` (Fable, rubric v2). Verdict CONCERN with no gating FAIL: seven must-fixes, all in the plan's own files. Every must-fix was checked against the tree before folding. The coordinator's instruction was to fold 1, 2, 3, 4, 6 and 7 as stated, and to answer 5 separately.

1. **A busy poll no longer clears the pending jog.** Verified: `consumeStatusOutcome` returns `true` for `kind === "busy"` without writing state (`machineStatus.ts:152-154`), so the old clear read a stale `"idle"`. The clear now needs `outcome.kind === "report"` and reads Idle from that snapshot (`machineStateToStore`), never from the store. §2; **S3-M26**.
2. **No jog while a job runs.** Verified: `pollStatus` returns early while `jobPollingSuspended` (`connection.ts:536`) and `setStatusStale` is called only there (`:554`), so during a job the store reads idle and fresh. `jogBlockReason` now refuses on `jobRunning` before the bed and stale checks, and MachinePanel passes `jobRunning`. §1, §6; **S3-M27**.
3. **Reconnect starts stale.** Verified: `disconnect` resets neither `statusStale` nor `positionKind` (`:381-424`), and the connect-time status query never calls `setStatusStale`. One helper, `markStatusUnknown()`, sets `statusStale: true` and `positionKind: null`. `disconnect` and `connect` (right after `setMachineConnected(true)`) both call it. The test: after a reconnect, the store reads stale until the first accepted poll, and a jog refuses with `JOG_REASON_STALE`. §2; **S3-M28**.
4. **Only key-setting writes forget the bed key.** Verified: `invalidateGrblSettingsSilently` fires on `enableLaserMode`'s `$32=1` too (`:745`, `:752`), which would quietly fail `kerf-f1`(b) on the S1 flow (enable laser mode, then confirm bed). The key is now forgotten only by a write whose normalized form matches `$3/$23/$100/$101/$130/$131=`, `$N…=` or `$RST=`. It is detected in `send()` and never in `invalidateGrblSettingsSilently`, which S3 no longer edits. §2; S3-M20 re-anchored; **S3-C4** is the `$32=1` control.
5. **Position Laser between S3 and S5: answered (c)** by the coordinator under Lee's 2026-09-25 technical delegation. There is no build freeze.
   - S3 absorbs the parent S5's one-line Y mapping in `handlePositionLaserDown`: `originTop ? -worldY : workspaceHeight - worldY`, the rule `gcode_gen.rs:421-427` uses.
   - It carries a test that drives the tool with `originTop` true and false and asserts the `$J=` argument. Its mutant is **S3-M31, moved from parent S5-M1**. §9.
   - **Parent S5 loses it.** There is no S5 plan file yet: **S5's lift must not re-count the mapping or S5-M1.** What remains for S5 is whatever its lift finds beyond this line.
   - **Consequence folded here:** with Position Laser now reaching `jogTo` in S3, the Parking Lot's old "Set Origin writes a zero work offset" item stops being an S5 precondition and becomes S3's. `setOrigin` writes the exact offset (after `G92 X0 Y0`, WCO = the machine position) on an `ok`. §2; **S3-M32**.
   - Every freeze statement is removed. The close report must say the origin-top mapping is unverified on hardware (Verification).
6. **Residuals stated.** The remembered-bed residual now says it is unqualified on a `$21=0` controller. Parking Lot line 1 now also names a console `$130=`/`$131=` write (the bed stays verified at the old size until reconnect, by S1 W3) and the per-project `originTop` (`store/index.ts:507`, `?? false`) against a per-machine bed.
7. **An unknown axis refuses**, with nothing sent (`JOG_REASON_AXIS`); **S3-M30**. The `positionKind === null` half of the stale check gets its own mutant, **S3-M29**.

**Not folded (advisory, recorded):**
- **A START within one poll of a jog acknowledgement is not refused.** `jogPending` survives a job start, and `canStartJob` cannot see it (critic core 6). The beam stays off on every path; the worst case is an `error:9` abort mid-jog. This goes to Risks and the Parking Lot.
- **Wording mismatch in the parent's `done_condition`.** It says "every control id green", but the battery records a control as killed (critic core 9). This file's Done condition uses the battery's terms. The coordinator is told.
- **Inventory:** `.claude/plans/` now holds 43 `.md` files. Stage 0 re-counts.

**S2's fold, re-checked against S3.** Commit `4c08470` dropped all Pause work from S2 (Lee, 2026-09-25) and left the generator half: 5 files. They are:
- `src/lib/machine/materialTestGcode.ts` (new)
- `MaterialTestDialog.tsx` (imports and removal of the moved generator)
- `textGcode.ts`
- `textGcode.test.ts`
- `src/lib/machine/__tests__/materialTestGcode.test.ts` (new)

S3's paths match: the generator is edited at `src/lib/machine/materialTestGcode.ts` and tested at `src/lib/machine/__tests__/materialTestGcode.test.ts`. S3 depended on none of S2's Pause work (critic Verified). S2 no longer edits `machineJobLoop.test.tsx`, so S3's edits there overlap nothing of S2's. S3 does not edit `textGcode.ts`. S2 says its own lift of S3 would be 7-8 files; this file's count of 14 supersedes that.

## Intent (grilled)

Grill skipped. The intent is taken from the parent's Intent and three rulings made this session:
- CHARTER "Done looks like" (1): "no cut dying mid-job and no silent G-code error".
- Parent Intent: "A jog is a nudge; it must never become larger than asked or reverse direction."
- `kerf-f1`, answered 2026-09-25 by the coordinator under Lee's technical delegation of that date (hand-off log, 2026-09-25): **refuse** jog until the bed size is confirmed, with the message "Confirm bed size before jogging". Two conditions: (a) the refusal and the confirm step are in plain words; (b) the bed confirmation survives a reload, "so it is one click per machine, not per session".
- Jen C3 on S1 (`/home/leesalo/marvin/state/relay/kerf-safety-s1-jen-review.md`), assigned to S3 by the coordinator 2026-09-25 (hand-off Owed list; ROADMAP Parking Lot "Stale status still shows green Idle/Ready"): while status is stale, MachinePanel and StatusBar show a green "Idle"/"Ready" while START's title says stale. "The screen says safe when Kerf does not know."

Summary for this batch:
- A jog moves only when Kerf knows where the head is and where the bed ends. A running job, unknown bed, stale status, a moving head, a work offset it cannot account for, a jog still in flight, or an axis other than X/Y all refuse, in plain words, with nothing sent.
- Position Laser uses the machine's frame (`originTop ? -y : h - y`), so on an origin-top machine it moves inside the bed instead of past home. This line is absorbed from parent S5.
- When it moves, a jog is clipped toward zero. It never reverses and never grows. `jogTo` refuses a target outside the bed instead of clamping it.
- On an origin-top machine the material-test grid, its labels and its frame are generated in negative Y, so S1's gate admits them.
- A bed size the operator confirmed is remembered for that machine and re-applied on the next connect. What "that machine" means, and what invalidates the memory, is designed below.
- A stale status reads "Stale", never a green "Ready".

## What S3 assumes S2 did

S3 lands after S2 (same generator). `.claude/plans/kerf-safety-s2.md` states S2's shape; S3 builds on these points, and Stage 0 confirms each against S2's merged diff before anything is written:
1. **The generators moved.** `generateMaterialTestGcode`, `generateFrameGcode`, `MaterialTestOptions` and `PowerMode` now live in `src/lib/machine/materialTestGcode.ts`, all exported (S2 §1). The dialog imports them.
2. **Its test moved too.** `src/lib/machine/__tests__/materialTestGcode.test.ts` imports the real generators and mocks only the font file load (`vi.mock("opentype.js", …)` with a synthetic square-glyph font), so real `textToGcode` runs with labels on (S2 §7).
3. **The generator stays pure** and takes every input as an argument. S2 reserved a trailing `originTop` argument for S3 (S2 "Compatibility with S3 and S4c").
4. **Every mode line is `M3 S0`/`M4 S0`**, positive `S` only on `G1` words, and the border uses the chosen mode. S3 changes coordinates only and touches no mode line.
5. **S2's invariants never assert a Y sign.** S3 parametrises them over `originTop ∈ {false, true}` rather than writing a second set (S2's own recommendation).
6. **S2's mutant anchors are spent.** They include `G0` lines S3's mirror changes the output of. S3's spec writes its own anchors (all new code, below) and reuses none of S2's.

If S2 did not move the generators (it chose to export in place), S3 edits `MaterialTestDialog.tsx` for both the mirror and the call sites, the file count drops to 13, and the materialTestGcode anchors below move to that file. If S2 has not merged when S3 is due, S3 does not dispatch.

## Existing plans reviewed

**Inventory, checked with `ls` on 2026-09-25:** `.claude/plans/` holds 39 `.md` files plus `archive/` (3 files). At the critic's read it held 43. The audit directory holds 9 files.

**Plans that name S3's files** (grep of every plan for `connection.ts`, `MachinePanel`, `StatusBar`, `machineStateDisplay`, `MaterialTestDialog`, `materialTestGcode`, `machineSafety.test`, `jogBounds`):
- Merged (`fence-*`, `remediation-batch-0.1`, `kerf-evidence-e2`/`-e3`, `kerf-safety-s1`): their edits are in the tree these citations were read from.
- `kerf-safety-s2.md` (folded at `4c08470`; Pause work dropped): 5 files, the generator and its test, as above. S3 follows it.
- `kerf-safety-s1b.md` (branch `relay/kerf-safety-s1b` exists, 0 commits ahead): edits `serial.rs`, `serial_session.rs`, `sim/grbl.rs`, `jobStream.ts` and `jobStream.test.ts`. None of S3's files.
- `kerf-evidence-e1b.md`: Rust only.
- `refresh-canvas-display.md` (branch 9 commits ahead): lists `connection.ts` and `MachinePanel` as untouched. `git diff --name-only` of that branch against its merge base touches none of S3's 14 files.
- `refresh-editing-shortcuts.md` edits `toolHandler.ts` only to add `switchTool` (`refresh-editing-shortcuts.md:184,340`, critic Verified), not `handlePositionLaserDown`. S3's one-line edit there cannot conflict. Whichever lands second rebases.
- Parent S5: its mapping moves into S3 (Fold notes 5). There is no S5 plan file yet.
- `charter-gap-analysis.md` and `kerf-relay-plan.md` cite the files; they are not implementation plans for them.

The Stage 0 re-check repeats this inventory.

## Parent and A3 claims, re-read against the tree

`connection.ts` grew about 146 lines in S1 and E3, so every line number the parent and A3 cite for it is stale. The behaviour they describe mostly still holds. Claim by claim:

| Claim | Status at `8c60666` |
|---|---|
| Parent: `jog` at `connection.ts:434-465`; A3: `:408-439` | **Moved** to `:580-611`. Behaviour holds: when verified it clamps the destination to `[0, bed]` and sends the difference (`:594-603`); when unverified it sends the raw request (`:609`). At Y = -248.913, bed 250, a -1 jog still becomes +248.913. |
| Parent: `jogTo` at `:466-477`; A3: `:441-451` | **Moved** to `:613-624`. Behaviour holds: clamps to `[0,W]×[0,H]`, ignores `originTop`, checks only alarm. |
| "Neither `$J=` string carries `G21`" | Holds (`:609`, `:623`). |
| A3: "Both `isWithinBounds` calls already receive `originTop` after A1; confirm." | **Holds in substance, not form.** After S1 the dialog has no `isWithinBounds` call. Both handlers call `canStartJob(state, gcodeExtents(gcode))`, which passes `state.originTop` (`canStartJob.ts:210`). |
| Parent: generator `MaterialTestDialog.tsx:106-128` (`startX/startY`); frame `:261-273` | **Moved** by S1 to `:124-129` and `:262-275`, and S2 then moves both functions to `src/lib/machine/materialTestGcode.ts`. |
| A3: "mirror through `y → -y`, including label placement" | **Holds, and must include glyph geometry, not only anchors.** `textToGcode` adds opentype's y-down glyph coordinates straight to machine Y (`textGcode.ts:100`; `geometryActions.ts:193-197` builds them y-down). A full reflection is therefore what makes the labels read upright on an origin-top machine. Reflecting only the label anchors would leave the glyphs mirrored. |
| A3 Out of scope: "`MachinePanel.tsx`" | **No longer holds.** `kerf-f1`(b) and Jen C3 both need it. |
| Parent S3 file list (6 files) | **No longer holds.** 14 files (see Waiver). |
| Parent test path `src/components/panels/__tests__/materialTestGcode.test.ts` | **No longer holds.** S2 moved it to `src/lib/machine/__tests__/`. |
| Parent: owner's controller `$20=0`, `$21=1` | Holds: `scripts/probe-20260914-153729.log:25-26`. |
| Parent (S1 section): "the owner's `$130/$131` are set in the probe capture" | Holds: `$130=400.000`, `$131=415.000` (`:42-43`). The owner's bed is verified by the controller at every connect, so on his machine the confirm step appears only when a connect's `$$` fails. |
| Owner's frame | The capture's 122 status reports are all `MPos` (0 `WPos`), for example `MPos:1.275,-1.237` with `WCO:0.000,0.000,0.000`: X positive, Y negative, consistent with origin-top. |
| `gcode_gen.rs:421-426`: `origin_top ? -y : workspace_height - y` | Holds (`src-tauri/src/engine/gcode_gen.rs:421-427`). Only Y is mapped, so the X envelope is `[0, W]` in both frames. A3 is silent on X; this file states it. |
| `toolHandler.ts:1807-1812` sends `workspaceHeight - worldY` | Holds (`:1807-1813`; the line is `:1811`). S3 now fixes it (Fold notes 5). |

**Not named by A3 or the parent, found on re-read:**
1. **An existing test pins the raw send A3 test 4 removes.** `machineSafety.test.ts:593-610` ("skips clamp and sends full distance when workspace is unverified") asserts `X50` is sent on an unverified bed. S3 retires it by name (§5).
2. **An S1 test pins the refusal S3 removes.** `machineJobLoop.test.tsx:966-980` (S1-M7, "a grid that fits only in the wrong frame refuses on an origin-top machine") goes red by design when the grid is mirrored. S3 rewrites it and re-pins S1-M7's mutant (S3-M15).
3. **The existing jog tests seed no status.** `machineSafety.test.ts:344-380` and `:612-624` set no `statusStale` or `positionKind`. The store starts `statusStale: true` and `positionKind: null`, so S3's precheck would refuse them. S3 adds the two fields to those tests' `setState`; this is a fixture change, not a weakening, and Razor checks it.
4. **`workspaceVerified` survives disconnect.** Nothing sets it false after connect (`index.ts:657-658`; the only writers are `connection.ts:220` and `MachinePanel.tsx:740`, both `true`). A bed verified on one controller is still "verified" when a different one is plugged in. S3 clears it on disconnect (§3).
5. **S1's console `$$` does not re-parse the bed.** S1's plan said the `send()` hook would call `parseSettingsResponses`. The tree applies only the `$32` readback there (`connection.ts:482-484`, S1 W3), and `enableLaserMode` reads back with `laserModeOnly: true` (`:754`). A full settings parse, and so any re-derivation of the bed, runs only in `queryGrblSettings` (connect and the soft-limit buttons).
6. **S1's settings classifier leaves jogs alone.** `isGrblSettingsWrite` normalizes `$J=G21 G91 Y-1.000 F1000` to `$J=G21G91Y-1.000F1000`, which matches none of `^\$\d+=`, `^\$N\d*=`, `^\$RST=` (`connection.ts:90-101`). Adding `G21` to the jog strings does not invalidate laser mode.
7. **Queued jogs overshoot a clipped envelope.** See Departures, D1.

## Departures from A3 and the parent (stated, with reasons)

- **D1. One jog in flight at a time.** A3's clip is computed from `machinePosition`, which updates every 250 ms (`connection.ts:309`). `$J=G91` is relative to the *planned* position, not the reported one. Two quick clicks toward an edge are each clipped against the same stale position, and together they drive past the edge. For example, at Y = -405 on a 415 mm bed, two -10 clicks 100 ms apart are each clipped to -10 and end at -425. With `$20=0` nothing on the controller stops that short of the limit switch. S3 refuses a jog while the previous one has not been seen to finish (§3, S3-M13, S3-M14). Absolute jogs were considered and rejected: a lagging position turns a queued absolute jog into a reversal.
- **D2. Fresh, idle, machine-frame position required.** The clip is only as good as the position fed to it. A stale status, a non-idle state, and a work-coordinate position with a non-zero offset all refuse. The owner reports MPos with `WCO:0`, so D2 costs him nothing, and astra 2.5 bounded is "unknown frame blocks". The WCO-aware envelope itself stays parked (S1's Parking Lot line 1).
- **D3. A3 test 4 moves to the connection level.** A3 puts `verified` into `clipJog`. Here `clipJog` is the pure geometry and `jogBlockReason` holds every precondition, the bed among them, so each refusal has exactly one line that can be mutated. Test 4 then asserts "zero sends" through the real `jog()`, which is the stronger form.
- **D4. `MachinePanel.tsx` is in scope** (A3 excluded it), for `kerf-f1`(a)/(b) and C3.
- **D5. No jog during a job** (critic must-fix 2). During a job the store's state and freshness fields are frozen at idle and fresh, so they cannot stand in for "the head is still".
- **D6. Position Laser's frame mapping and Set Origin's offset write move from parent S5 into S3** (coordinator, option (c)). This follows from S3's `jogTo` refusing the old positive-Y target.

## Bed confirmation that survives a reload (`kerf-f1` condition b)

**Today:** `workspaceVerified` is session-only and in memory (`index.ts:657`). It becomes true when a `$$` parse sees both `$130` and `$131` > 0 (`connection.ts:218-225`), or when the operator types W/H in MachinePanel's "Bed size unconfirmed" box and presses Confirm (`MachinePanel.tsx:659-765`, `setWorkspaceSize` + `setWorkspaceVerified(true)` at `:738-741`). Its copy reads "Machine did not report $130/$131", which is not plain words. localStorage holds only `kerf-last-port`, `kerf-last-baud` and `kerf-s-value-max`.

**Options weighed:**
1. *Key by port name alone.* Cheap. But Linux reuses `/dev/ttyUSB0` for whatever is plugged in, so a different machine on the same port inherits the bed. Rejected.
2. *Key by the controller's reported `$130/$131`.* This is the coordinator's suggestion. But the confirm step exists precisely when those values are missing or zero, so every such machine would share one key. Rejected as the whole key; kept as part of it.
3. *Key by the port plus the controller-reported settings that define the frame.* **Chosen.**
4. *No auto-apply, one "Use 400 × 415 mm again?" click per session.* The safest, but it fails "one click per machine, not per session". Rejected.

**The design:**
- **Key:** the port name plus the reported values of `$3` (direction invert), `$23` (homing direction), `$100`/`$101` (steps per mm) and `$130`/`$131` (reported travel, `-` when absent). These six say how the controller's millimetres and directions map onto the frame. Laser mode (`$32`), power scale (`$30`) and the limit flags (`$20-22`) are left out, so Enable Laser Mode and the soft-limit buttons do not force a re-confirm.
- **No key, no memory.** When the readback failed, or lacked `$100` or `$101`, there is no key. A confirm is then for this session only, and the copy says so.
- **Storage:** localStorage `kerf-bed-confirmations`, a JSON array of `{ key, w, h }`, newest first, capped at 8 entries. Every read and write is wrapped in try/catch. Malformed data, or a bad `w`/`h` (not finite, or ≤ 0), reads as absent. It is read on every lookup, never cached in module state, so a reload behaves exactly like a reconnect.
- **Written only by the operator.** `machineConnection.confirmBedSize(w, h)` is the only writer, and the MachinePanel Confirm button calls it. It sets the size, sets `workspaceVerified`, and writes the entry when a key exists.
- **Applied only on a full parse.** In `parseSettingsResponses`, if both `$130/$131` > 0 the controller wins, as today. Otherwise, if a key exists and an entry matches, the size is applied, `workspaceVerified` is set, and the console says so. A parse never sets `workspaceVerified` false.
- **Visible and fixable.** When the bed came from the operator, MachinePanel shows the size and who set it, with a Change button that reopens the same inputs. Its source ("machine", "remembered", "confirmed", "session") is module state in `connection.ts`, read through `useSyncExternalStore`. No store field is added.

**What invalidates a remembered bed** (it is not applied, and the operator is asked again):
1. A different port name. This includes the same machine moved to a different USB socket where the OS names ports by location. That costs one extra confirm and is the safe direction.
2. Any of the six key settings reported differently, including one appearing or disappearing.
3. A readback that failed or lacked `$100`/`$101`.
4. A write to one of the six key settings, or a `$N…=`/`$RST=` write, since the last full parse. It is detected in `send()`. A confirm made before the next full parse is then session-only. A `$32` (Enable Laser Mode) or `$20-22` write does **not** forget the key (critic must-fix 4).
5. The controller reporting both `$130/$131` > 0. The controller wins and the entry is ignored, but not deleted.
6. Change in the Machine panel, which overwrites the entry.
7. Disconnect. `workspaceVerified` goes false and the source clears. The bed is re-derived at the next connect.

**What it cannot detect (the honest residual):** a physical bed change with no settings change on the same port, such as an extension kit or two identically configured machines swapped on one port. Kerf then applies the old size. The remedy is loud rather than silent: the connect line names the size, and the panel shows "you confirmed this size earlier · Change". The hard limit switches (`$21=1` on the owner's controller) still stop an overshoot at the frame. **On a `$21=0` controller that backstop does not exist, and the residual is unqualified there:** a too-large remembered bed can end in a head-to-frame collision, beam off. A too-small one is caught by the OUTSIDE refusal. That residual is no worse than today's in-session confirm; persistence stretches it across sessions for machines that do not report travel, which excludes the owner's.

## Change

### 1. `src/lib/machine/jogBounds.ts` (new, pure)

Reason constants (plain words; `kerf-f1`(a)):
- `JOG_REASON_BED = "Confirm bed size before jogging — Machine panel, Set bed size"`
- `JOG_REASON_ALARM = "Jog blocked: machine in alarm state — unlock ($X) first"` (today's string; `machineSafety.test.ts:341` matches "Jog blocked")
- `JOG_REASON_STALE = "Waiting for the machine to report its position — try again in a moment"`
- `JOG_REASON_BUSY = "Wait for the machine to stop before jogging"`
- `JOG_REASON_OFFSET = "Jogging is off while a work offset is set — Kerf can't tell where the bed edge is. Clear the offset first."`
- `JOG_REASON_PENDING = "The last jog is still moving — try again when it stops"`
- `JOG_REASON_JOB = "A job is running — jogging is off until it finishes"`
- `JOG_REASON_AXIS = "Kerf can only jog X and Y"`
- `JOG_REASON_OUTSIDE = "The head is outside the bed Kerf knows about — home the machine first"`
- `JOG_REASON_EDGE = "Already at the edge of the bed"`
- `JOG_REASON_TARGET = "That spot is outside the bed"`

Functions. Anchor lines are prescribed text; each must be one line after Prettier (print width 100):
- `jogEnvelope(axis: "X" | "Y", bed: number, originTop: boolean): [number, number]`. First statement: `if (axis === "Y" && originTop) return [-bed, 0];`, then `return [0, bed];`.
- `jogBlockReason(s: JogGateState, mode: "by" | "to"): string | null`. `JogGateState` holds the scalars `machineConnected`, `machineState`, `jobRunning`, `statusStale`, `workspaceVerified`, `positionKind`, `workCoordOffset`, so `useStore.getState()` satisfies it structurally. Checks, in order:
  1. Not connected: "Machine not connected".
  2. `if (s.machineState === "alarm") return JOG_REASON_ALARM;`
  3. `if (s.jobRunning) return JOG_REASON_JOB;` This comes before the stale and idle checks, which read idle and fresh for the whole of a job (Fold notes 2).
  4. `if (!s.workspaceVerified) return JOG_REASON_BED;`
  5. `if (s.statusStale || s.positionKind === null) return JOG_REASON_STALE;`
  6. `if (s.machineState !== "idle") return JOG_REASON_BUSY;`
  7. `const offsetSet = s.workCoordOffset.x !== 0 || s.workCoordOffset.y !== 0;`, then `if (offsetSet && (mode === "to" || s.positionKind === "work")) return JOG_REASON_OFFSET;`. A relative jog on an MPos report is exact whatever the offset. An absolute `$J=G90` target is in work coordinates, so any offset refuses it.
  8. `return null;`.
- `clipJog(req: { axis: "X" | "Y"; distance: number; position: number; bed: number; originTop: boolean }): JogResult`, where `JogResult = { kind: "send"; distance: number } | { kind: "refuse"; reason: string }`, with the module helper `const refuse = (reason: string): JogResult => ({ kind: "refuse", reason });`:
  - `const [lo, hi] = jogEnvelope(req.axis, req.bed, req.originTop);`
  - `if (req.position < lo || req.position > hi) return refuse(JOG_REASON_OUTSIDE);`
  - `const room = req.distance < 0 ? req.position - lo : hi - req.position;`
  - `const magnitude = Math.min(Math.abs(req.distance), room);`
  - `if (magnitude <= 0) return refuse(JOG_REASON_EDGE);`
  - `return { kind: "send", distance: Math.sign(req.distance) * magnitude };`
- `targetInEnvelope(x, y, w, h, originTop): boolean`, built from `jogEnvelope`.

### 2. `src/lib/machine/connection.ts`

These are the only edits: `jog`, `jogTo`, a new module helper `sendJogLine`, one hook in `pollStatus`, a new `markStatusUnknown` helper, one hook in `send()`, `setOrigin`'s offset write, the bed-memory helpers and their call sites in `parseSettingsResponses`, `connect` (two lines), `disconnect`, a new `confirmBedSize`, and a verbatim extraction of `normalizeGrblLine` out of `isGrblSettingsWrite`.

**Jog:**
- Module state `let jogPending = false; let jogTick = 0;`.
- `sendJogLine(line)`:
  - `if (jogPending) {`, then an info line with `JOG_REASON_PENDING`, then `return;`.
  - Otherwise: `jogPending = true; jogTick++;`, then `const responses = await machineConnection.send(line);`, then `jogTick++;`.
  - `if (!responses.includes("ok")) jogPending = false;`.
  - `jogTick` moves once when the jog is submitted and once when it is acknowledged, so a poll in flight across either edge cannot count as "after the jog".
- `jog(axis, distance, feedRate = 1000)`:
  - `const blocked = jogBlockReason(store, "by");` A refusal prints a warning line and returns. This replaces the alarm-only check at `:582-586`.
  - `const ax = axis.toUpperCase();`, then `if (ax !== "X" && ax !== "Y") {`, a warning with `JOG_REASON_AXIS`, and `return;`. Nothing is sent; today an unknown axis goes out raw (Fold notes 7). Then call `clipJog` with `machinePosition.x`/`.y`, `workspaceWidth`/`workspaceHeight` and `originTop`. A refusal prints its reason and returns.
  - Otherwise `await sendJogLine(`$J=G21 G91 ${ax}${clip.distance.toFixed(3)} F${feedRate}`)`. The `WARNING-1` comment (`:588-593`) is deleted; it describes the raw-send fallback that no longer exists.
- `jogTo(x, y, feedRate = 3000)`:
  - `const blocked = jogBlockReason(store, "to");`, then the refusal.
  - `if (!targetInEnvelope(x, y, store.workspaceWidth, store.workspaceHeight, store.originTop)) {`, then a warning with `JOG_REASON_TARGET`, then `return;`. **No clamp.**
  - Then `await sendJogLine(`$J=G21 G90 X${x.toFixed(3)} Y${y.toFixed(3)} F${feedRate}`)`.
- `pollStatus`, beside E3's spindle-drop block:
  - `const tickAtInvoke = jogTick;` is captured before the `serial_get_status` invoke.
  - After `consumeStatusOutcome`:
    - `const noJogOverlap = tickAtInvoke === jogTick;`
    - `const realReport = outcome.kind === "report" && outcome.snapshot !== null;`
    - `const reportedIdle = realReport && machineStateToStore(outcome.snapshot!.state) === "idle";`
    - `if (accepted && jogPending && noJogOverlap && reportedIdle) jogPending = false;`
  - Only a real report taken after the acknowledgement that itself says Idle proves the jog finished (or never moved). A busy or no-response outcome is `accepted` but writes no state, so the store's `machineState` is never consulted here (Fold notes 1).
- `markStatusUnknown()` (new): `const st = useStore.getState();`, then `st.setStatusStale(true);`, then `st.setPositionKind(null);`. It is one helper, so one mutant covers both callers (Fold notes 3).
- `send()`, one line right after S1's `if (isWrite) invalidateGrblSettings();`: `if (isWrite && touchesBedKey(command)) forgetBedKeyAfterWrite();`.
  - `touchesBedKey(cmd)` is `BED_WRITE_RE.test(normalizeGrblLine(cmd))`, with `const BED_WRITE_RE = /^\$(3|23|100|101|130|131)=|^\$N\d*=|^\$RST=/;`.
  - `normalizeGrblLine` is S1's four normalization steps moved verbatim out of `isGrblSettingsWrite`, which then calls it. `isGrblSettingsWrite`'s behaviour is unchanged, and S1's tests pin it.
  - `forgetBedKeyAfterWrite()` clears the bed key.
- `setOrigin` (Fold notes 5):
  - Keep `await this.send("G92 X0 Y0")`, but take its responses.
  - On an `ok`, compute the machine position: `machinePosition` itself when `positionKind === "machine"`, else `machinePosition + workCoordOffset`. Write it as the offset: `store.setWorkCoordOffset({ x: mpos.x, y: mpos.y }); // S3: G92 X0 Y0 makes WCO equal to MPos`. After `G92 X0 Y0`, WPos is 0, so WCO = MPos exactly, whatever G54 holds.
  - On no `ok`, the offset is left alone.
  - This replaces the local `{ x: 0, y: 0 }` write (`connection.ts:656`), which let `jogTo` accept a work-coordinate target as if no offset existed until the next `WCO:` report.

**Bed memory:**
- Module state:
  - `let connectedPort: string | null = null;`
  - `let bedKey: string | null = null;`
  - `let bedSource: "machine" | "remembered" | "confirmed" | "session" | null = null;`, plus a listener set.
  - `markBed(s)` sets the source and notifies listeners.
  - `export function subscribeBedSource(cb)` and `export function getBedSource()` serve `useSyncExternalStore`.
- `const BED_KEY_SETTINGS = [3, 23, 100, 101, 130, 131] as const;`
- `bedKeyFrom(port, geo: Map<number, number>)`:
  - Returns null when `port` is null or `geo` lacks 100 or 101.
  - Otherwise `const portPart = `port=${port}`;` and returns `[portPart, ...BED_KEY_SETTINGS.map((k) => `$${k}=${geo.get(k) ?? "-"}`)].join("|")`.
- `readRememberedBed(key)` and `writeRememberedBed(key, w, h)` implement the storage rules above.
- `parseSettingsResponses`:
  - The existing loop also records every `$N=V` into a `geo` map.
  - After the loop: `bedKey = parsedAny ? bedKeyFrom(connectedPort, geo) : null;`.
  - The existing `$130/$131` branch (`:218-225`) gains `markBed("machine");`.
  - A new `else if (bedKey)` branch runs `const remembered = readRememberedBed(bedKey);`. On a hit it sets the size, sets `workspaceVerified`, calls `markBed("remembered");`, and prints the info line "Using the bed size you confirmed for this machine before: W × H mm. Change it in the Machine panel if that's wrong."
  - Nothing in the parse sets `workspaceVerified` false.
- `connect`: two lines after `store.setMachineConnected(true)` (`:277`): `connectedPort = portName;` and `markStatusUnknown();`.
- `disconnect`, beside S1's laser-mode clear (`:411`): `store.setWorkspaceVerified(false);`, `markStatusUnknown();`, `connectedPort = null`, the bed key cleared (`forgetConnectionBed()`), `markBed(null)` and `jogPending = false`.
- `invalidateGrblSettingsSilently` is **not** edited (Fold notes 4).
- `confirmBedSize(w, h)` on `machineConnection`:
  - Rejects non-finite or ≤ 0 values with an error line.
  - Sets the size, `workspaceVerified(true)` and `markBed(bedKey ? "confirmed" : "session")`.
  - With a key: writes the entry and prints "Bed size W × H mm confirmed. Kerf will remember it for this machine."
  - With no key: prints "Bed size W × H mm confirmed for this session. Kerf couldn't read this machine's settings, so it will ask again next time you connect."

**Out of bounds for this batch:**
- `send()`, except the one line above.
- `isGrblSettingsWrite`, except the verbatim extraction.
- `emergencyStop`, `softReset`, `feedHold`, `home`, `enableLaserMode`, `readbackGrblSettings`, `invalidateGrblSettings*`, `applyLaserModeReadback` and the `FS:` block.

### 3. `src/lib/machine/materialTestGcode.ts` (S2's module; mirror only)

- Add the trailing `originTop: boolean` argument S2 reserved to `generateMaterialTestGcode(opts, sValueMax, originTop)` and `generateFrameGcode(w, h, originTop)`.
- Add `export function mirrorProgramY(gcode: string): string`. On every line that is not a comment, it negates each `Y<number>` word as text: `0`/`-0` stays `0` in the original's format, a leading `-` is dropped, and otherwise `-` is prefixed. Formatting, X, S, F and M words and comments are untouched. It covers cells, fill sweeps, labels (glyph geometry included; see the re-read table), the border, the frame and the `G0 X0 Y0` home moves, which stay at 0.
- The generator ends `const program = lines.join("\n");`, then `return originTop ? mirrorProgramY(program) : program;`.
- The frame ends `const frame = lines.join("\n");`, then `return originTop ? mirrorProgramY(frame) : frame;`.
- No mode line, S word or X coordinate changes. S2's invariants must hold unchanged under both values.

### 4. `src/components/panels/MaterialTestDialog.tsx` (call sites only)

- `handleGenerate`: read `const genOriginTop = useStore.getState().originTop;` at entry and pass it to the generator. This covers both Copy and Send. If the frame is flipped mid-generation, the click-time gate reads the new value and refuses the old-frame program. That is fail-closed, and it is intended.
- `handleFrame`: pass `state.originTop` from the same `getState()` snapshot the gate reads.
- `displayGate`: pass the existing `originTop` selector (`:322`).
- Nothing else. The C1/C2 refusal UI from S1 is unchanged.

### 5. `src/lib/machine/__tests__/machineSafety.test.ts` (deliberate changes, named)

- **Retire** `"skips clamp and sends full distance when workspace is unverified"` (`:593-610`). It pins the raw send `kerf-f1` ruled out. It is replaced in place by `"refuses and sends nothing when the bed is unverified (kerf-f1)"`, which asserts zero `serial_send` calls and a console line equal to `JOG_REASON_BED`. The describe title and its WARNING-1 comment are updated to say so.
- **Fixture additions** to the `setState` of the four tests at `:344-380` and the one at `:612-624`: `statusStale: false, positionKind: "machine"`. Their assertions (`X10`, `X-5`, no send at the edge) are unchanged, and they still pass with the `toFixed(3)` distances (`X10.000` contains `X10`).
- Nothing else in the file changes. S1's frozen strings at `:125` and `:452` are untouched.

### 6. `src/components/panels/MachinePanel.tsx`

- **Bed box, plain words (`kerf-f1`(a)):**
  - The title stays "Bed size unconfirmed". The body becomes "Kerf couldn't read the bed size from the machine. Confirm it before jogging or cutting."
  - The inputs get one hint line: "The width and height the laser head can reach, in mm."
  - The button label stays exactly "Set bed size", because `canStartJob`'s reason and `JOG_REASON_BED` both point at it.
  - Confirm calls `machineConnection.confirmBedSize(w, h);` (replacing `:738-741`). The now-unused `setWorkspaceSize`/`setWorkspaceVerified` selectors are removed.
- **Operator-set bed line (`kerf-f1`(b)).** When connected, verified, and `bedSource` is not `"machine"` or null, show one muted line with a Change button that reopens the inputs pre-filled:
  - remembered: "Bed W × H mm — you confirmed this size earlier."
  - confirmed: "Bed W × H mm — confirmed."
  - session: "Bed W × H mm — confirmed for this session."
  - `bedSource` comes from `useSyncExternalStore(subscribeBedSource, getBedSource)`.
- **Jog buttons:**
  - Add scalar selectors for `statusStale` and `positionKind` (never an object selector). `jobRunning` is already selected (`:56`).
  - `const jogBlocked = jogBlockReason(` with `{ machineConnected, machineState, jobRunning, statusStale, workspaceVerified, positionKind, workCoordOffset }` and `"by"`.
  - Each of the four jog buttons gets `disabled={jogBlocked !== null}` and `title={jogBlocked ?? "<axis>"}`.
  - Inside the Positioning section, above the grid, render `jogBlocked` as a one-line note, so the reason is visible and not only a tooltip (the silent-press class in Jen C1). The Home button's own gating is unchanged.
- **Header state (C3):**
  - `const shownState = displayMachineState(machineState, machineConnected, statusStale);`
  - The dot and label use `shownState`. The dot gets `opacity: 0.4` when `shownState === "stale"`.

### 7. `src/components/bottom/StatusBar.tsx` (C3)

- Add scalar selectors for `machineConnected` and `statusStale`.
- `const shownState = displayMachineState(machineState, machineConnected, statusStale);`
- The dot and label use `shownState`, with the same dot opacity rule.

### 8. `src/lib/machine/machineStateDisplay.ts` (C3)

- Add `stale: "var(--text-muted)"` to `MACHINE_STATE_COLORS` and `stale: "Stale"` to `MACHINE_STATE_LABELS` (Jen C3's copy and colour).
- Add `export function displayMachineState(machineState: string, machineConnected: boolean, statusStale: boolean): string` whose body is `return machineConnected && statusStale ? "stale" : machineState;`. While disconnected, "Disconnected" still shows; `statusStale` starts true and is not reset on disconnect.

### 9. `src/lib/tools/toolHandler.ts` (`handlePositionLaserDown` only; moved from parent S5)

- `:1811` `const machineY = store.workspaceHeight - worldY;` becomes `const machineY = store.originTop ? -worldY : store.workspaceHeight - worldY;`. This is the rule `gcode_gen.rs:421-427` uses for every cut.
- The comment at `:1810` ("Convert canvas Y (top-down) to GRBL Y (bottom-up)") becomes "Canvas Y to machine Y, by the same rule the generator uses (origin-top: -y)".
- Nothing else changes. The tool still calls `machineConnection.jogTo`, which now refuses a target outside the bed, a work offset, a running job and the rest (§2).
- **Unverified on hardware.** The mapping matches the generator's, and the owner's capture shows origin-top MPos (Y negative), but no Position Laser has run on his machine with it. See Verification.

### 10-14. Tests

- `src/lib/tools/__tests__/toolHandler.test.ts`: new `describe("S3 — Position Laser frame (moved from parent S5)")`.
  - Set `activeTool: "positionLaser"` and a jog-ready store: connected, idle, fresh, verified, `positionKind: "machine"`, WCO `{0,0}`, 500 × 300.
  - Override the file's rejecting `invoke` mock to record `serial_send`.
  - Drive `handleViewportPointerDown(120, 100, event)`. With `originTop: true` the sent line is `$J=G21 G90 X120.000 Y-100.000 F3000`. With `false` it is `… Y200.000 …`.
  - Kills S3-M31.
- `src/lib/machine/__tests__/jogBounds.test.ts` (new): A3 tests 1-3, the outside and edge refusals, and `jogBlockReason` ordering.
- `src/lib/machine/__tests__/connection.test.ts`: new `describe("S3 — jog frame")` and `describe("S3 — remembered bed")`, driving the real `machineConnection` through the existing `mockInvoke`/`mockMachine` pattern (`:327-352`) and asserting the actual `serial_send` argument strings.
- `src/lib/machine/__tests__/materialTestGcode.test.ts` (S2's): parametrise S2's invariants over `originTop`, and add A3 tests 7-8.
- `src/components/panels/__tests__/machineJobLoop.test.tsx`: rewrite S1-M7 (below), and add `describe("S3 — MachinePanel and StatusBar")`. `MachinePanel` is already rendered in this file (`:525`).

A test-local copy of `clipJog`, `jogBlockReason`, the key function or the mirror is forbidden. Every test drives the production function.

## Tests and mutants

Battery spec `kerf-safety-s3`.

- `test_command` is `["npx","vitest","run","--cache=false","src/lib/machine/__tests__/jogBounds.test.ts","src/lib/machine/__tests__/connection.test.ts","src/lib/machine/__tests__/machineSafety.test.ts","src/lib/machine/__tests__/materialTestGcode.test.ts","src/components/panels/__tests__/machineJobLoop.test.tsx","src/lib/tools/__tests__/toolHandler.test.ts"]`. The `--cache=false` is carried from S1, whose plan-exact command errored 18/18 on a vitest cache write (S1 pack). The baseline must be green.
- Every id below must be **killed**. A control (C) is a test that is green at baseline and goes red under its named wrong variant. The battery has no "stays green" outcome, so a control appears in the journal as a killed mutant.
- **Anchor uniqueness.** Each mutant is one contiguous find/replace (`mutation-battery.mjs:1553-1560`). Every `find` except S3-M15's is new text this batch writes. The 35 new-code ids use 31 distinct `find` texts. Four pairs share a `find`: S3-M19/S3-C2, S3-M6/S3-C1 and S3-M11/S3-M29 in the same file, and S3-M24/S3-M25, which are the same text in different files. `grep -rF` of each of the 31 against `src/` returns **0**: the original 24 at `8c60666` (re-run by the critic at `def80c0`), and the 7 fold anchors at `def80c0`. So nothing pre-existing collides. S3-M31's pre-image (`const machineY = store.workspaceHeight - worldY;`) returns **1** in `toolHandler.ts`; it is the line S3 replaces. `\|` in the table is Markdown escaping for a literal `|`. S3-M15's `find` is existing text, and `grep -cF` in `canStartJob.ts` returns **1**. Prettier-sensitive anchors are written as single statements under 100 columns, or as a fragment that begins a statement. Ted re-runs `grep -cF` per file on the finished tree (each must be 1) and records the counts before the battery runs.
- **Handler technique.** For S3-M23, mutate the render-time `jogBlocked`, and assert on `disabled`/`title` plus the visible note. The handler refusal itself is tested at the `connection.jog` level, where no button is involved.

| Id | File | Killed by | find → replace |
|---|---|---|---|
| S3-M1 | `jogBounds.ts` | A3-1: `clipJog` origin-top, Y = -248.913, bed 250, request -1 → send -1 | `if (axis === "Y" && originTop) return [-bed, 0];` → `if (axis === "Y" && !originTop) return [-bed, 0];` |
| S3-M2 | `jogBounds.ts` | A3-1, A3-2: request -2 → send -1.087, never positive | `return { kind: "send", distance: Math.sign(req.distance) * magnitude };` → `return { kind: "send", distance: Math.max(0, Math.min(req.bed, req.position + req.distance)) - req.position };` (astra R5 restored: +248.913) |
| S3-M8 | `jogBounds.ts` | A3-3 property table (≥ 200 cases: both frames, X and Y, inside, edge, outside, ± requests). Each result refuses or has `sign(d) = sign(req)`, `\|d\| ≤ \|req\|`, and `position + d` inside the envelope. | `const magnitude = Math.min(Math.abs(req.distance), room);` → `const magnitude = Math.max(Math.abs(req.distance), room);` |
| S3-M9 | `jogBounds.ts` | Origin-top, position Y = +5 (outside `[-250, 0]`), request -1 → refuse with `JOG_REASON_OUTSIDE` | `if (req.position < lo \|\| req.position > hi) return refuse(JOG_REASON_OUTSIDE);` → `` (deleted) |
| S3-M4 | `jogBounds.ts` | A3-4 at the connection level: `jog("Y", -1)` with `workspaceVerified: false` makes zero `serial_send` calls, and the console holds `JOG_REASON_BED` | `if (!s.workspaceVerified) return JOG_REASON_BED;` → `` |
| S3-M11 | `jogBounds.ts` | `jog` with `statusStale: true` (otherwise ready) makes zero sends | `if (s.statusStale \|\| s.positionKind === null) return JOG_REASON_STALE;` → `` |
| S3-M12 | `jogBounds.ts` | `jog` with `positionKind: "work"` and WCO (100, -100) makes zero sends; `jogTo` with `positionKind: "machine"` and the same WCO makes zero sends | `if (offsetSet && (mode === "to" \|\| s.positionKind === "work")) return JOG_REASON_OFFSET;` → `` |
| S3-M5 | `connection.ts` | A3-5: `jog` sends a string starting `$J=G21 G91` | `` `$J=G21 G91 `` → `` `$J=G91 `` |
| S3-M10 | `connection.ts` | `jogTo` in-envelope sends a string starting `$J=G21 G90` | `` `$J=G21 G90 `` → `` `$J=G90 `` |
| S3-M3 | `connection.ts` | A3-6: origin-top, `jogTo(10, 150)` (the positive Y today's Position Laser sends) makes zero sends, with `JOG_REASON_TARGET` | `if (!targetInEnvelope(` → `if (false && !targetInEnvelope(` |
| S3-M13 | `connection.ts` | Two `jog` calls with no poll between them make exactly one `serial_send` | `if (jogPending) {` → `if (false) {` |
| S3-M14 | `connection.ts` | A `pollStatus` whose invoke is deferred starts; a `jog` is sent and acknowledged; the poll then resolves with a real Idle report; a second `jog` still makes no second send. A poll begun after the acknowledgement that returns a real Idle report does clear it (positive half). | `const noJogOverlap = tickAtInvoke === jogTick;` → `const noJogOverlap = true;` |
| S3-M26 | `connection.ts` | A `jog` is acknowledged. A poll begun afterwards returns `kind: "busy"`, snapshot null, while the store still reads `"idle"`. A second `jog` makes no second send. A later real Idle report then clears it. | `const reportedIdle = realReport && machineStateToStore(outcome.snapshot!.state) === "idle";` → `const reportedIdle = useStore.getState().machineState === "idle";` |
| S3-M16 | `connection.ts` | Connect machine A (`$130=400`, `$131=415`); disconnect; connect machine B (no travel, different port, nothing remembered): `workspaceVerified` is false | `store.setWorkspaceVerified(false);` → `` |
| S3-M17 | `connection.ts` | `kerf-f1`(b), positive: connect `/dev/ttyUSB0` with `$100=80`, `$101=80`, no travel; `confirmBedSize(300, 200)`; localStorage holds the entry; disconnect; connect again with the same port and settings. The bed is verified at 300 × 200 with no click, and the console carries the "Using the bed size you confirmed" line. | `const remembered = readRememberedBed(bedKey);` → `const remembered = null;` |
| S3-M18 | `connection.ts` | Same, but the reconnect is on `/dev/ttyUSB1`: not verified | `` const portPart = `port=${port}`; `` → `const portPart = "port=any";` |
| S3-M19 | `connection.ts` | Same, but the reconnect reports `$100=160`: not verified | `const BED_KEY_SETTINGS = [3, 23, 100, 101, 130, 131] as const;` → `const BED_KEY_SETTINGS = [3, 23, 101, 130, 131] as const;` |
| S3-C2 | `connection.ts` | Control: same, but the reconnect reports `$32` flipped (`0` → `1`): **still** verified from memory | same find → `const BED_KEY_SETTINGS = [3, 23, 32, 100, 101, 130, 131] as const;` |
| S3-M20 | `connection.ts` | Connect (key F); console `send("$100=80")` (a key-setting write, same value); `confirmBedSize(300, 200)`; disconnect; reconnect with F: **not** verified (the confirm was session-only) | `if (isWrite && touchesBedKey(command)) forgetBedKeyAfterWrite();` → `` |
| S3-C4 | `connection.ts` | Control: connect (key F); console `send("$32=1")`; `confirmBedSize(300, 200)`; disconnect; reconnect with F: **still** verified from memory | `const BED_WRITE_RE = /^\$(3\|23\|100\|101\|130\|131)=\|^\$N\d*=\|^\$RST=/;` → `const BED_WRITE_RE = /^\$\d+=\|^\$N\d*=\|^\$RST=/;` |
| S3-M27 | `jogBounds.ts` | `jog` with `jobRunning: true` (and otherwise idle, fresh, verified) makes zero sends, with `JOG_REASON_JOB` | `if (s.jobRunning) return JOG_REASON_JOB;` → `` |
| S3-M28 | `connection.ts` | Connect, one poll (fresh), disconnect, reconnect with fake timers, so no poll runs. The init status query returns an MPos report, so `positionKind` is set. `statusStale` is true, and a `jog` makes zero sends with `JOG_REASON_STALE`. | `st.setStatusStale(true);` → `` |
| S3-M29 | `jogBounds.ts` | `jog` with `statusStale: false, positionKind: null` makes zero sends | `if (s.statusStale \|\| s.positionKind === null) return JOG_REASON_STALE;` → `if (s.statusStale) return JOG_REASON_STALE;` |
| S3-M30 | `connection.ts` | `jog("Z", 1)` on a jog-ready store makes zero sends, with `JOG_REASON_AXIS` | `if (ax !== "X" && ax !== "Y") {` → `if (false) {` |
| S3-M32 | `connection.ts` | `positionKind: "machine"`, position (120, -80), WCO `{0,0}`; `setOrigin()` gets `ok`. `workCoordOffset` is (120, -80), and a following `jogTo(10, -10)` makes zero sends with `JOG_REASON_OFFSET`. | `store.setWorkCoordOffset({ x: mpos.x, y: mpos.y });` → `store.setWorkCoordOffset({ x: 0, y: 0 });` |
| S3-M31 | `toolHandler.ts` | **Moved from parent S5-M1.** Position Laser with `originTop: true` sends `Y-100.000` for canvas Y 100 on a 300 mm bed. The `false` case sends `Y200.000`. | `const machineY = store.originTop ? -worldY : store.workspaceHeight - worldY;` → `const machineY = store.workspaceHeight - worldY;` |
| S3-M6 | `materialTestGcode.ts` | A3-7, labels and border on (S2's synthetic font): with `originTop` true every Y word is ≤ 0 and ≥ -bed, and the program equals the `false` program with every Y word negated and nothing else changed | `return originTop ? mirrorProgramY(program) : program;` → `return program;` |
| S3-C1 | `materialTestGcode.ts` | Control: with `originTop` false every Y word is ≥ 0 and the program is byte-identical to S2's output for the same inputs | same find → `return mirrorProgramY(program);` |
| S3-M7 | `materialTestGcode.ts` | A3-8: frame, same two assertions | `return originTop ? mirrorProgramY(frame) : frame;` → `return frame;` |
| S3-M15 | `canStartJob.ts` (S1 code, not edited) | Re-pin of S1-M7 through its rewritten test: origin-top, labels off, Send is admitted (`serial_job_begin` once) and every `Y` word in the recorded `serial_send` lines is ≤ 0 | `if (!isWithinBounds(bounds, state.workspaceWidth, state.workspaceHeight, state.originTop)) {` → `if (!isWithinBounds(bounds, state.workspaceWidth, state.workspaceHeight)) {` |
| S3-M21 | `MachinePanel.tsx` | Render after a mocked connect (port, `$100/$101`, no travel); click "Set bed size", type 300/200, click Confirm; disconnect; reconnect: verified at 300 × 200 | `machineConnection.confirmBedSize(w, h);` → `useStore.getState().setWorkspaceSize(w, h); useStore.getState().setWorkspaceVerified(true);` |
| S3-M22 | `connection.ts` | After a remembered apply, MachinePanel shows "you confirmed this size earlier" and a Change button that opens the inputs | `markBed("remembered");` → `markBed("machine");` |
| S3-M23 | `MachinePanel.tsx` | Connected, idle, fresh, unverified bed, Positioning opened: all four jog buttons are disabled, their title and the visible note equal `JOG_REASON_BED` | `const jogBlocked = jogBlockReason(` → `const jogBlocked = ((..._ignored: unknown[]) => (machineState === "alarm" ? "alarm" : null))(` |
| S3-M24 | `StatusBar.tsx` | Connected, `machineState: "idle"`, `statusStale: true`: the StatusBar shows "Stale" and no "Ready" | `const shownState = displayMachineState(machineState, machineConnected, statusStale);` → `const shownState = machineState;` |
| S3-M25 | `MachinePanel.tsx` | Same state: the Machine header label reads "stale", not "idle" | same find, in this file → `const shownState = machineState;` |
| S3-C3 | `machineStateDisplay.ts` | Control: disconnected with `statusStale: true`: the StatusBar shows "Disconnected", not "Stale" | `return machineConnected && statusStale ? "stale" : machineState;` → `return statusStale ? "stale" : machineState;` |

That is 36 ids: 32 mutants (S3-M1…S3-M32) and 4 controls (S3-C1…S3-C4). The existing jog tests in `machineSafety.test.ts` (alarm refusal, `X10`/`X-5` clips, no send at the edge, verified clip) stay in the command as regressions, and so do S2's invariants over both frames.

## Verification

- The five-file `test_command` above.
- `npx tsc --noEmit`.
- `npm test`: the baseline measured at relay start plus the new tests, with none weakened. The two named changes (§5 and the S1-M7 rewrite) are listed in the Ted report with before/after text.
- `npm run lint`: no new warnings.
- `npm run format:check`.
- Battery journal: every S3-M* and S3-C* id **killed**; zero survived, errored or CONTROL_RED.

**Close report (required text).** The S3 close report states plainly: "The origin-top Y mapping for Position Laser (`-y`) is unverified on hardware." It flags to Lee that **the first real Position Laser on an origin-top machine is a watch-it-move test, laser isolated, before any burn.** The same goes on the owner card (hardware step 6).

**Browser (`npm run dev` + Chrome DevTools MCP), store-driven:**
- With `machineConnected: true, workspaceVerified: false`, open Positioning: the jog buttons are dimmed, and the note reads "Confirm bed size before jogging — Machine panel, Set bed size". The bed box reads in plain words.
- Set `statusStale: true`: the header and status bar read "Stale" in muted grey. Set `machineConnected: false`: they read "Disconnected".
- With `originTop: true`, open Material Test and click Copy G-code: every Y is ≤ 0.
- The remembered-bed path needs a serial connect, which the browser cannot reach. It is covered by unit tests only; say so.

**Hardware-only (named, not skipped; goes on the owner's next card via evidence E4; laser isolated for every motion check):**
1. Near each edge, 1 mm jogs in X and Y move 1 mm the pressed way, and a jog at the edge is refused.
2. Five fast clicks toward an edge move at most to the edge.
3. The material test and its frame land near home in the back-left, inside the bed.
4. The engraved labels read upright, not mirrored.
5. A reconnect does not ask for the bed size (the controller reports `$130/$131`).
6. **Position Laser, watch-it-move before any burn.** Laser isolated. Click a point well inside the drawn bed: the head moves to that point on the bed and not past home. Then click near each drawn edge. Then press Set Origin somewhere else and click again: the click is refused with the work-offset reason.

## What S3 does not satisfy

- **A verified bed can still be resized by other writers.** `loadProject` (`index.ts:501-502`) and SettingsDialog (`SettingsDialog.tsx:41`) write `workspaceWidth/Height` while `workspaceVerified` stays true. The jog envelope, like START's bounds, then uses a size nobody verified: opening a project saved at 500 wide on the owner's 400 mm bed widens the X envelope by 100 mm. This is pre-existing and store-side. It is parked below, and S4b is recommended to take it, since it already edits both store files.
- **WCO-aware envelopes.** S3 refuses instead (D2). The parked line stands. `workCoordOffset` is only as fresh as the last `WCO:` field (GRBL sends one every 10-30 reports); before the first one Kerf assumes zero.
- **The remembered-bed residual** (physical change, same port, same settings), as stated in the design.
- **G21/G90 on the material frames** is S4c's (parent S4c-M5). S3 adds `G21` to the two jog strings only.

## Stage 3.5 obligations (orchestrator)

**ROADMAP `## Parking Lot`:** add these lines in the existing `- **Title** — detail.` shape:
1. **A verified bed can drift from what was verified.** Four ways, and in each the jog envelope and START bounds use a size or frame nobody verified:
   - `loadProject` and SettingsDialog write the workspace size while `workspaceVerified` stays true.
   - A console `$130=`/`$131=` write leaves the bed verified at the pre-write size until reconnect, because S1 W3 does no full parse on a console `$$`.
   - `originTop` is a per-project field (`store/index.ts:507`, `?? false`) while the remembered bed is per machine, so opening a pre-`originTop` project on an origin-top machine flips the envelope to `[0, H]`.

   Recommend S4b, which already edits both store files.
2. **Material-test FRAME traces a box 3 mm off the card's border.** The frame spans `[10, 10 + total]`, the border `[7, 7 + total]`, on both axes when the border is on. Pre-existing; mirrored consistently by S3.
3. **On a bottom-left-origin machine the material-test labels engrave mirror-image.** `textToGcode` adds y-down glyph geometry to a y-up program. This is read from the code, not seen on a burn. Origin-top machines are correct after S3.
4. **A START within one poll of a jog acknowledgement is admitted.** `jogPending` is invisible to `canStartJob`, so the first job line can meet the controller mid-jog (`error:9` on stock GRBL), and the stream aborts with `0x18`. The beam is off throughout. This is critic advisory (core 6), not folded.

**Resolved:** the "Stale status still shows green Idle/Ready" index line (ROADMAP `:569`) moves to `shipped` with this relay. Its detail section (`:719`) is kept verbatim with a one-line "Shipped in kerf-safety-s3" note appended. The S1 item's "MUST SHIP WITH S3" clause (`:27`) is annotated as met.

**ROADMAP `next`:** the five hardware steps above.

**ARCHITECTURE.md delta:**
- Jog admission is `jogBlockReason` plus `clipJog` (pure, in `jogBounds.ts`), with one jog in flight.
- Bed verification has three sources (controller, remembered operator confirmation keyed by port plus six settings, this-session confirmation). It is cleared on disconnect.
- The material-test program is mirrored in Y on origin-top machines.
- A stale status is displayed as "Stale". A new connection starts stale.
- Position Laser maps canvas Y to machine Y by the generator's rule. `setOrigin` records WCO = MPos after `G92 X0 Y0`.

**DECISIONS proposals, written only on Lee's yes at relay close** (via `scripts/update-decisions.mjs`):
1. *Evidence corrections* (the parent's, per relay-plan A3): "The material-test grid and frame were generated in a positive-Y frame regardless of `originTop`, so on an origin-top machine every Y was beyond home." Reason: found by the audit (G7), in no register; fixed by this relay's merge commit.
2. *Product rulings* (added here): "Jogging refuses until the bed size is confirmed, and a confirmation is remembered per machine (port plus the controller's frame settings)." Recorded per coordinator (delegated), 2026-09-25. Reason: the owner's controller runs `$20=0`, so the bed confirmation is the only thing that knows where the edge is. Without the entry, a future session could restore raw send.

## Waiver: 14 files, one root

The cap is 8. All 14 files are under `src/`:
- **Production (8):**
  - `jogBounds.ts` (new)
  - `connection.ts`
  - `materialTestGcode.ts` (S2's module)
  - `MaterialTestDialog.tsx` (three call sites)
  - `MachinePanel.tsx`
  - `StatusBar.tsx`
  - `machineStateDisplay.ts`
  - `toolHandler.ts` (one line, moved from parent S5)
- **Tests (6):**
  - `jogBounds.test.ts` (new)
  - `connection.test.ts`
  - `machineSafety.test.ts` (forced: it pins the removed raw send)
  - `materialTestGcode.test.ts` (S2's)
  - `machineJobLoop.test.tsx` (forced: S1-M7 pins the removed refusal)
  - `toolHandler.test.ts`

Reasons:
- The three ruled additions each have their own surface.
- `kerf-f1`(b) and C3 both land in `MachinePanel.tsx` and `machineJobLoop.test.tsx`, next to the jog gate, so one relay gives one Jen pass over one panel.
- S1 needs the mirror in the same build.
- The coordinator's option (c) puts the Position Laser mapping in S3's diff so Razor sees it with the `jogTo` it now reaches. That adds 2 files, with a 1-line production change.

**The rejected alternative** is a split:
- S3a: jog, bed memory, C3 and Position Laser (11 files).
- S3b: the mirror (4 files, sharing `machineJobLoop.test.tsx`).

Both would have to merge before any build. The critic did not prefer it (core 4). Nothing in the design changes if it is split.

## Risks and rollback

**Operator-visible changes (intended):**
- Jogs refuse on an unconfirmed bed (`kerf-f1`), during a job, on a stale status (including right after a reconnect), while moving, with an offset on a WPos report, and while the previous jog is in flight. Each shows a plain reason in the panel or console.
- Rapid clicks drop instead of queuing.
- Position Laser moves within the bed on origin-top machines (it drove past home before). After Set Origin it refuses until the offset is cleared.
- The material test burns near home at the back-left on origin-top machines, where it was refused before.
- The header and status bar read "Stale" while status is stale.

**Risks:**
- **D1 may feel sticky.** A jog is released by the first Idle poll after its acknowledgement (≤ 250 ms after it stops). If Jen or the owner finds it obstructive, the fallback is to clip against the planned position. That is a design change and goes back to the critic; it is not a Ted call.
- **A collision on the remembered bed** (same port, same six settings, different frame) applies a wrong size. The mitigations are the connect line, the Change button, and the hard limits.
- **Position Laser's new mapping is unverified on hardware** (Fold notes 5). A wrong sign would move the head to the mirror-image point, still inside the bed, because the envelope refusal bounds it. Hardware step 6 is the check, and the close report says so.
- **A START right after a jog** (Parking Lot line 4): nuisance-class, beam off.
- **`disconnect()` gains four lines.** The Parking Lot holds a reported disconnect/reconnect hang (ROADMAP `next:`). The additions are synchronous state clears placed before the existing `invoke`, and they add no await.

**Rollback:** revert the relay merge commit. S3 depends on S2's module path; S4c and S5 depend on S3. Revert those first if they have merged.

## Done condition

- `relay/kerf-safety-s3` is an ancestor of `marvin/kerf-gap`.
- `/home/leesalo/marvin/state/relay/kerf-safety-s3-razor-review-b1.md` (or its latest recheck) reports PASS with 0 CRITICAL.
- The battery journal records all 36 ids (S3-M1…S3-M32, S3-C1…S3-C4) as **killed**. In the battery's terms a control is killed; the parent's "control green" wording means the same thing.
- The close report carries the hardware-unverified sentence (Verification).
- The Stage 3.5 obligations are done.

No build freeze is part of this condition.

## Escalation note (resolved)

The lift's Risks first said "no build is cut between S3 and S5". The critic (must-fix 5) judged a freeze disproportionate, because S5 waits on `refresh-editing-shortcuts`, which has not started. It offered three options:
- (a) freeze;
- (b) allow builds with an honest refusal;
- (c) S3 takes the mapping.

The coordinator answered **(c)** on 2026-09-25 under Lee's technical delegation. The freeze statement is removed everywhere, and S5's lift must not re-count the mapping or S5-M1.

**Irreversible steps:** none. The only new persistent write is the localStorage `kerf-bed-confirmations` key, which an older build ignores.
