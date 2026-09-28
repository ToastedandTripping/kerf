# Kerf safety S3c: motion trust. A jog needs a position earned by a full `$H` this session, and nothing jogs while any motion command is unsettled

- **Relay id:** `kerf-safety-s3c`
- **Branch:** `relay/kerf-safety-s3c`
- **Tier:** Standard. 9 files under one root (`src/`): 6 production (`jogBounds.ts`, `connection.ts`, `machineStatus.ts`, `store/index.ts`, `store/storeTypes.ts`, `MachinePanel.tsx`) and 3 tests (`jogBounds.test.ts`, `connection.test.ts`, `machineJobLoop.test.tsx`). There is UI (reason titles only; no new control), so Jen reviews at Stage 3. Web app: the panel renders in the Vite dev server with `invoke` mocked, so the behavioural evaluator applies.
- **Base:** `marvin/kerf-gap` at `aa06a3f` or later. S3 (377a63f) is merged. Every citation below was read at `72540d0`/`aa06a3f` (no `src/` change between them) on 2026-09-27.
- **Revision 2** folds the round-1 critic (`kerf-safety-s3c-critic.md`, astra, FAIL). What changed is listed under "Critic fold, round 1" at the end.

## Dependency graph

| Step | Files | Depends on | Independent of |
|---|---|---|---|
| b1 | all 9 above | S3 (merged, 377a63f) | E1b (Rust only, disjoint files) |

**Batch waiver (9 files, one root, over the 8-file cap).** The lease, its trust revocations and the gate are one contract. `machineStatus.ts` is in the batch only to call the same revocation from the status-event ALARM path (critic trace B). Splitting it out would merge a gate that trusts a position one alarm path can no longer revoke.

## Intent (grilled)

There was no separate grill. The intent comes from rulings already on file:
- **Lee, 2026-09-26 (kerf-9), relayed by session-d32473:** "always press home." He always homes after connecting, and "refusing jogs until the machine has homed matches how he works."
- **Coordinator, 2026-09-26, option (a):** a motion-in-flight hold set by Home and by console motion, cleared by the first post-acknowledgement Idle report (Razor W2 on S3), plus a jog that requires `$H` since connect when `$22=1` (Razor W1). The owner's settings are `$20=0 $21=1 $22=1 $23=1` (capture 2026-09-14, lines 25-28).
- **`$22=0` (kerf-9's open half):** fail closed. A machine that does not home cannot earn a trusted position, so the jog buttons refuse on it. The operator-attestation design is parked with the critic's requirements (see Out of scope). This is the critic's inversion result and the conservative reading of kerf-9. It is flagged for Lee at close.

**Summary for this relay.**
- A jog (the arrows, jog-to, Position Laser) is refused unless the machine completed a plain `$H` with `ok` in this connection, and no alarm, reset, stop, re-home start or new connection has happened since.
- A jog is also refused while any non-job motion command, whether a button jog, `$H` or a console move including a raw `$J=`, is unsettled. It stays refused until every one of them has settled and a status poll begun after the last settle reports Idle.
- On a machine with `$22=0`, the jog buttons are off, with a reason.

## Existing plans reviewed

- `.claude/plans/kerf-safety-s3.md` and its critic: S3's gate, `jogPending`/`jogTick`, bed memory, Position Laser. S3c replaces `jogPending`/`jogTick` with the lease below, which is a superset, and keeps every S3 refusal text, the clip geometry and the bed-memory keys.
- `PLAN-safety-gate-class.md` (`~/marvin/state/audits/gap-2026-09-24/kerf/`): S4a, S4b and S4c edit `connection.ts` in `send()`'s settings-write hook (`:604-607`, `:612-618`), `queryGrblSettings` and `canStartJob`. S3c's `send()` edit wraps the `invoke` (`:614-619`) and the response loop (`:623-642`), without changing the settings lines. Whichever of S3c and S4b merges second rebases.
- `pause-resume-future.md` (parked) touches `pause`/`resume` only.

## Diagnosis (read at `72540d0`)

1. **The envelope trusts MPos, and nothing requires that trust to be earned** (Razor W1 on S3). `clipJog` clips `store.machinePosition` against `[0, bed]`, or `[-bed, 0]` for Y on origin-top (`jogBounds.ts:42-47`, `:61-73`). `jogBlockReason` (`:50-59`) never reads `machineHomed`. `serial_connect` resets the board, and GRBL then reports MPos 0 wherever the head is.
2. **"Homed" is recorded on two of the four `$H` routes.** `home()` (`connection.ts:809-816`) sets it on `ok`, and is used by the jog pad (`MachinePanel.tsx:1016`) and the Home action (`:1087`). The alarm banner's Home button (`MachinePanel.tsx:477`) and a console `$H` (`Console.tsx:36`) call `send("$H")` directly and set nothing.
3. **Only one of four alarm paths reaches a setter, and nothing revokes "homed" on alarm anyway.**
   - Snapshot state: `machineStatus.ts:183-184`, through `setMachineState`.
   - Status events: `machineStatus.ts:131-144`, logged only.
   - Drained or unsolicited lines: `surfaceUnsolicited`, `connection.ts:51-68`, logged only.
   - Command responses: the `send()` loop at `connection.ts:623-642`, logged only.
   - `setMachineState` (`store/index.ts:597`) itself never touches `machineHomed`.
   - `machineHomed` resets only in `queryGrblSettings` (`connection.ts:1014-1019`), which runs on connect and on the soft-limit enable paths.
   - `softReset()` (`:843-852`) and `emergencyStop()` (`:874` onward) revoke nothing.
4. **A jog right after Home, or right after any console motion, is admitted** (Razor W2, N8 on S3). `jogPending` (`connection.ts:274-289`) is set only by `sendJogLine`. A console `G0` or a raw `$J=` (`Console.tsx:36` → `send`) sets nothing. The single boolean also cannot represent two outstanding commands, and it clears the moment a jog returns without `ok` (`:288`), which is not proof that motion ended.
5. **Command and status serialisation.** `serial_send` takes the command mutex with a blocking `lock()` (`src-tauri/src/commands/serial.rs:485`), and the status poll uses `try_lock` and answers busy while it is held (`connection.ts:709-712`). That orders polls against commands that hold the lock. It does not make "submitted in TS" and "lock acquired in Rust" atomic, so the lease must not infer ordering from it (critic trace C).
6. **Tests exist to extend.** `connection.test.ts`'s `describe("S3 — jog frame")` has the `jogReady(patch)` fixture (`:1051-1066`) and asserts literal `serial_send` strings. `jogBounds.test.ts` covers the pure gate. `machineJobLoop.test.tsx` renders MachinePanel.

## Design

### The lifecycle contract (this table goes, verbatim, into a comment above the lease in `connection.ts`)

State is module-level in `connection.ts`:
- `motionOutstanding: number`: non-job motion sends submitted in this session and not yet settled.
- `motionHeld: boolean`: true from any motion submission until a qualifying Idle.
- `motionTick: number`: bumps at every motion submit and every motion settle.
- `sessionGen: number`: bumps on connect and on disconnect.
- `trustGen: number`: bumps on every revocation of position trust.

Position trust is the existing store field `machineHomed`.

| Event | Lease | Trust |
|---|---|---|
| Non-job `send` of a motion command (`isMotionCommand`), before `invoke` | `motionOutstanding++`, `motionHeld = true`, `motionTick++`, store `motionInFlight = true` | If it is a homing command (`/^\$H/i`): revoke |
| That send settles (resolve, reject or throw), same `sessionGen` | `motionOutstanding--` (floor 0), `motionTick++`. **Not** released, whatever the response: a missing `ok` is not proof that motion ended | Plain `$H` only (see Grant) |
| That send settles, different `sessionGen` | Ignored | Ignored |
| Status poll completes with `accepted`, a real report, Idle from the snapshot, `motionOutstanding === 0`, and `tickAtInvoke === motionTick` | `motionHeld = false`, store `motionInFlight = false` | none |
| Any other poll (busy, no response, non-Idle, overlap) | none | none |
| ALARM seen on any path (snapshot state, status event, drained or unsolicited line, command response) | none | revoke |
| `softReset()` or `emergencyStop()` invoked (any outcome) | none | revoke |
| Connect | `sessionGen++`, `motionOutstanding = 0`, `motionHeld = false`, `motionTick++`, store `motionInFlight = false` | revoke (already done in `queryGrblSettings`; kept) |
| Disconnect | Same as connect | revoke |

**Revoke** means `trustGen++` and `setMachineHomed(false)`, through one function, `revokePositionTrust()`.

**Grant.** At a plain `$H` settle, trust is set to `setMachineHomed(true)` only when all of these hold:
- the command trimmed and upper-cased is exactly `$H`;
- the responses include `ok`;
- no response starts with `ALARM` or `error:`;
- `sessionGen` is unchanged;
- `trustGen` equals the value captured straight after this `$H`'s own submission-time revoke. Any alarm, reset or stop that arrived during the homing pump, including a drained ALARM processed before the response loop, has therefore bumped it and blocks the grant.

`$HX`, `$HY` and any other `$H…` revoke at submission and never grant. A partial home earns nothing (critic D).

**Invariants** (they go in the same code comment):
1. `motionHeld` is false only if no motion send is unsettled and a report taken after the last settle said Idle.
2. A settle from an earlier session changes nothing.
3. Trust is true only if a plain `$H` completed cleanly, in this session, with no revocation during it.

### 1. `jogBounds.ts` (pure)

- `JogGateState` gains `grblHoming: boolean`, `machineHomed: boolean` and `motionInFlight: boolean`, all store scalars satisfied structurally by `useStore.getState()`.
- New texts:
  ```ts
  export const JOG_REASON_HOME =
    "Home the machine ($H) before jogging. Kerf only knows where the bed edge is after homing";
  export const JOG_REASON_NO_HOMING =
    "Jogging is off: this machine doesn't home ($22=0), so Kerf can't tell where the bed edge is. Move the head from the console instead";
  export const JOG_REASON_MOTION =
    "The machine is still carrying out the last command. Jogging resumes once it reports Idle; if it never does, check the connection or press STOP";
  ```
- The order: not connected, alarm, job, motion, bed, trust, stale, busy, offset.
  ```ts
  if (s.motionInFlight) return JOG_REASON_MOTION;
  ```
  ```ts
  if (!s.grblHoming) return JOG_REASON_NO_HOMING;
  if (!s.machineHomed) return JOG_REASON_HOME;
  ```
  An unconfirmed bed still reports `JOG_REASON_BED` first, which is the S3 order.
- `JOG_REASON_PENDING` stays, for the S3 "one jog in flight" message: `sendJogLine` checks the lease before sending (below).
- `export function isMotionCommand(command: string): boolean`:
  - true for `$J=…` and any `$H…`;
  - false for every other `$` line and for `?`, `!` and `~`;
  - for G-code, strip `(…)` and `;…` comments first. Then it is true if the line has an axis word (`/[XYZABC]\s*[-+]?[.\d]/i`) or a `G28`, `G30` or `G38.x` (`/G\s*0*(28|30|38)(\.\d)?(?!\d)/i`), which move without axis words; otherwise false.
  - It leans toward "moves": a false positive costs one poll, and a false negative reopens W2.

### 2. `connection.ts`

- Replace `jogPending`/`jogTick` with the lease state and the comment table.
- In `send()`, when `opts?.jobEpoch === undefined && isMotionCommand(command)`: the pre-invoke row, and a `try/finally` around the existing `invoke` so the settle row runs on resolve and on throw. The existing settings-write lines stay as they are.
- In the response loop, an `ALARM…` response calls `revokePositionTrust()` as well as being logged. After the loop comes the plain-`$H` grant check.
- `surfaceUnsolicited`: `ALARM` also calls `revokePositionTrust()`.
- `sendJogLine`: if `motionHeld`, log `JOG_REASON_PENDING` and return. Otherwise `send(line)`. The lease is taken inside `send`, so there is one owner and no double count.
- `jog()`/`jogTo()` pass `{ ...store, motionInFlight: motionHeld }` to `jogBlockReason`. The module value is authoritative and the store copy is for the panel.
- `home()` becomes `await this.send("$H")`. The grant lives in `send`.
- `softReset()` and `emergencyStop()`: call `revokePositionTrust()` first, before their sends.
- Connect and disconnect: the table rows.
- `_testResetJogAndBedState` resets the lease and both generations.

### 3. `machineStatus.ts`

- In the events loop (`:131-144`), an `ALARM` event also calls `useStore.getState().setMachineHomed(false)`, the store half of the revocation. `trustGen` is module state in `connection.ts`. To keep `machineStatus.ts` free of a circular import, `connection.ts` exports `revokePositionTrust`, and `machineStatus.ts` takes it as an optional callback: `consumeStatusOutcome(outcome, onAlarm?)`, which the poll passes. The Ted report states which of the two it used, and the tests cover the route.

### 4. The store

- `storeTypes.ts`: `motionInFlight: boolean` ("a non-job motion command is unsettled, or no Idle has been seen since") and `setMotionInFlight`.
- `store/index.ts`: the field and setter. `setMachineState` (`:597`) also clears `machineHomed` and `softLimitsActive` when the state is `"alarm"`, belt and braces for the snapshot path, which goes through it:
  ```ts
  setMachineState: (state) =>
    set(state === "alarm" ? { machineState: state, machineHomed: false, softLimitsActive: false } : { machineState: state }),
  ```
  `softLimitsActive` is false whenever `machineHomed` is (`:625-637`).
  - The store setter cannot bump `trustGen`. The snapshot path therefore also calls the connection's revocation, through the same callback as §3. The setter's clear is the fallback, so that an alarm written by any other caller still drops the flag.

### 5. `MachinePanel.tsx`

- Both `jogBlockReason` calls (`:128-137`, `:142-151`) add `grblHoming`, `machineHomed` and `motionInFlight` from three separate scalar `useStore` selectors (CLAUDE.md, React error 185). The arrows and POSITION disable with the new reasons as their titles, which is S3's existing mechanism.
- No new control.

## Tests

**Reproduce first.** Before any production edit, add R1-R4 to `connection.test.ts` and run them red. Quote the failures.
- **R1 (W1):** `jogReady({ machineHomed: false, grblHoming: true })`, then `jog("X", 10)`. Today it sends `$J=G21 G91 X10.000 F1000`.
- **R2 (W2):** homed. Hold a `send("$H")` invoke pending, and meanwhile `jog("X", -10)`. Today the jog's `serial_send` is issued.
- **R3 (trace A):** homed. Hold a console `send("$J=G21 G91 X20 F300")` pending, and meanwhile `jog("X", 10)`. Today the jog is issued.
- **R4 (trace B):** homed. `send("$H")` resolves `["ALARM:9"]`, then `send("$X")` resolves `["ok"]`, then a fresh Idle poll arrives, then `jog("X", 10)`. Today it sends.

`jogReady` gains `grblHoming: true, machineHomed: true, motionInFlight: false` in its defaults. S3's tests all model a homed machine, which the owner's is, so their assertions are unchanged. The exception is S3's `jogPending` tests where a jog returned without `ok` and a second jog was then allowed at once. Those now need one Idle poll before the second jog, because a missing `ok` is not proof that motion ended (critic dimension 6). They are updated in place to add that poll, keeping their assertion, and each edit is listed in the Ted report.

| Test | File | Asserts |
|---|---|---|
| T1 | `jogBounds.test.ts` | `JOG_REASON_NO_HOMING` when `!grblHoming`, `JOG_REASON_HOME` when `grblHoming && !machineHomed`, and null when homed and otherwise ready. `motionInFlight` gives `JOG_REASON_MOTION` ahead of bed, trust, stale and busy. An unconfirmed bed on an unhomed machine gives `JOG_REASON_BED` |
| T2 | `jogBounds.test.ts` | `isMotionCommand`. True: `$H`, `$h`, `$HX`, `$J=G91 X1`, `G0 X10`, `g1y5 f100`, `X5`, `x-.5`, `G28`, `G30`, `G38.2 Z-5`, `G1 X1 (c)`. False: `$$`, `$#`, `$G`, `$I`, `$X`, `$C`, `$RST=$`, `$32=1`, `$22=0`, `?`, `!`, `~`, `M3 S0`, `M5`, `G4 P0.5`, `G21`, `G90`, `G92.1`, `G1 F100`, `; X10`, `(X10) M5`, `G280` |
| T3 (R1) | `connection.test.ts` | Unhomed `$22=1`: `jog` and `jogTo` make zero `serial_send` calls and log `JOG_REASON_HOME`. `$22=0` homed-false: zero sends, `JOG_REASON_NO_HOMING` |
| T4 (R2) | `connection.test.ts` | While `$H` is pending, a jog makes no `$J=` send and logs `JOG_REASON_MOTION`. After `ok`: a busy poll does not release; a poll begun before the ack that returns Idle after it does not release (tick); a poll begun after the ack that returns Idle releases, and the next jog sends |
| T5 (R3) | `connection.test.ts` | A raw console `$J=` or `G1 X20 F300` pending blocks the jog buttons. `$$` and `M5` never do. A job-epoch `send(line, { jobEpoch })` never takes the lease |
| T6 | `connection.test.ts` | **Overlap:** motion A pending and motion B settling with `error:15`: still held. A poll that completes Idle while A is outstanding does not release. After A settles, a poll begun after it that returns Idle releases |
| T7 | `connection.test.ts` | **Thrown invoke:** a motion `send` whose invoke rejects stays held until a post-settle Idle poll. It is never released by the rejection itself |
| T8 (R4) | `connection.test.ts` | Starting **homed**, each of these leaves `machineHomed` false and jogs refused with `JOG_REASON_HOME` until a clean `$H`: (a) `$H` resolving `ALARM:9`; (b) a drained `ALARM:1` in a send's `drained`; (c) a status event `ALARM:3` on a poll; (d) an Alarm snapshot; (e) `softReset()`; (f) `emergencyStop()`; (g) the start of a new `$H` that is still pending; (h) a non-homing console command (`G1 X10 F300`) whose response carries `ALARM:2`, which only the response-loop revocation can catch |
| T9 | `connection.test.ts` | **Grant:** a plain `$H` with `ok` grants. `$HX` with `ok` revokes and does not grant. `$H` with `ok` whose `drained` carried an `ALARM` does not grant (`trustGen`). `$H` responding `["ok","error:9"]` does not grant |
| T10 | `connection.test.ts` | **Session fence:** a `$H` pending, then disconnect, then connect, then the old `$H` resolving `ok`: not homed, and the new session's lease is unaffected (outstanding 0, not held once a fresh Idle arrives). The same with a pending console jog |
| T11 | `connection.test.ts` | The alarm banner route: `send("$H")` resolving `ok` (the banner calls it directly) grants, and `home()` grants through the same path |
| T12 | `machineJobLoop.test.tsx` | Panel: with `$22=1` unhomed, the arrows and POSITION are disabled with `JOG_REASON_HOME` as their title. With `$22=0`, `JOG_REASON_NO_HOMING`. With `motionInFlight` true, `JOG_REASON_MOTION`. When homed, idle and fresh, they are enabled |

**Mutation battery `kerf-safety-s3c`.** `test_command`: `["npx","vitest","run","--cache=false","src/lib/machine/__tests__/jogBounds.test.ts","src/lib/machine/__tests__/connection.test.ts","src/components/panels/__tests__/machineJobLoop.test.tsx"]`. Ted confirms from the baseline that all three files ran, and states the count.
- For the ids whose `find` is marked *(Ted writes)*, Ted writes the exact `find` from the committed code before the run and records it in the report. Each `find` is unique (`grep -cF` = 1 on the committed relay HEAD, quoted), and every replacement type-checks. A `find` that differs from the shape below needs the orchestrator's sign-off in the report.

| Id | Mutates | Killed by |
|---|---|---|
| S3c-M1 | `if (!s.machineHomed) return JOG_REASON_HOME;` becomes `if (false) return JOG_REASON_HOME;` | T1, T3 |
| S3c-M2 | `if (!s.grblHoming) return JOG_REASON_NO_HOMING;` becomes `if (false) return JOG_REASON_NO_HOMING;` | T1, T3 |
| S3c-M3 | `if (s.motionInFlight) return JOG_REASON_MOTION;` becomes `if (false) return JOG_REASON_MOTION;` | T1, T12 |
| S3c-M4 | the `send()` motion condition *(Ted writes)*: `isMotionCommand(command)` becomes `command.startsWith("$H")` | T5 |
| S3c-M5 | the poll release *(Ted writes)*: `motionOutstanding === 0` becomes `true` | T6 |
| S3c-M6 | the poll release *(Ted writes)*: `tickAtInvoke === motionTick` becomes `true` | T4 (overlap poll) |
| S3c-M7 | the settle *(Ted writes)*: release `motionHeld` on a non-`ok` settle (insert `if (!responses.includes("ok")) motionHeld = false;`) | T6, T7 |
| S3c-M8 | the grant *(Ted writes)*: the `trustGen` equality becomes `true` | T9 (drained ALARM) |
| S3c-M9 | the grant *(Ted writes)*: the exact `=== "$H"` becomes `.startsWith("$H")` | T9 (`$HX`) |
| S3c-M10 | the settle *(Ted writes)*: the `sessionGen` check becomes `true` | T10 |
| S3c-M11 | `surfaceUnsolicited`'s `revokePositionTrust()` removed | T8(b) |
| S3c-M12 | the status-event revocation removed | T8(c) |
| S3c-M13 | `softReset()`'s `revokePositionTrust()` removed | T8(e) |
| S3c-M14 | the response-loop ALARM revocation removed | T8(h) (T8(a) cannot kill it: `$H`'s own submission revoke already cleared trust) |
| S3c-M15 | the submission-time homing revoke removed | T8(g) |
| S3c-C1 | Control: the axis-word regex matches everything (`/./`) | T2's false cases go red |

`softReset`, `emergencyStop` and connect/disconnect are otherwise pinned by T8(f) and T10. Ted adds the ids for them (M16 onward) if their revocation lines are separate anchors.

## Verification

- `npx vitest run --cache=false` over the whole suite: the baseline count plus the new tests, with nothing skipped.
- `npx tsc --noEmit`, `npm run -s format:check`, and `npm run -s lint` with no new warnings in the touched files.
- The battery journal shows all ids `killed`, and `survived`, `errored` and `CONTROL_RED` are all 0.
- **Browser (dev server, `invoke` mocked as in S3's behavioural evaluation):** check the panel states in T12 and take screenshots. This is UI evidence only, not physical qualification.
- **Owner hardware card (ROADMAP `next`).** Laser power isolated (key off or PSU off), head mid-bed, hand clear of the gantry. Every step is watch-it-move:
  1. Connect. Before homing, the arrows are disabled with "Home the machine ($H)…".
  2. Press Home. While it homes, press an arrow: refused with "still carrying out the last command". Nothing moves after homing ends.
  3. After Home, one 10 mm jog moves 10 mm. Press Home again: the arrows go disabled during it and come back after.
  4. From the console, send `G1 X` (current + 20) `F300`, then press an arrow at once: refused until the head stops.
  5. **The safe alarm stimulus:** send a slow console move (`G1 X` current + 30 `F200`) and press STOP mid-move. Record what the controller reports (stock GRBL gives `ALARM:3`; the vendor fork is unqualified). Unlock (`$X`) without homing: the arrows stay disabled with the Home reason until Home.
- **Unqualified and disclosed:** the vendor fork's response to `$HX`, and whether its `$H` homes both X and Y (Kerf grants trust on `$H`'s `ok` alone). Step 3's measured jog is the acceptance check for the frame. `$22=0` has no hardware here. It fails closed, so nothing on it needs qualifying beyond "the buttons refuse".

## Out of scope (Stage 3.5 adds these under `## Parking Lot` as `### Deferred from kerf-safety-s3c (2026-09-27)`, each with an index line)

1. **Operator origin attestation for `$22=0` machines.** Parked with the round-1 critic's requirements:
   - a current-session, motion-free window;
   - an unambiguous physical corner and direction;
   - the hazard shown before confirming;
   - hardware qualification.

   Until then `$22=0` refuses jogs.
2. **Jobs, FRAME and the material test do not require homing.** They go through `canStartJob`, not the jog gate. S4c territory.
3. **Alarm codes are not distinguished.** Trust survives no alarm, including soft-limit alarm 2, where GRBL keeps position.
4. **A `$22` change from the console** reaches the gate only at the next full settings parse (the same drift as S3's Parking Lot line 1).
5. **Console motion is sent unclipped, by policy.** S3c counts it in the lease. It does not bound it.

## Risks and rollback

- **Every connection of a `$22=1` machine needs Home before jogging.** That is the ruling. The refusal names the fix.
- **`$22=0` machines lose jogging from the buttons.** This is stricter than S3 and is flagged for Lee.
- **A second jog after a rejected jog waits one poll (about 250 ms).**
- **Rollback:** revert the merge on the session branch. Nothing is persisted (no localStorage key, no settings write), so a revert is clean. It restores S3 with W1 and W2 open. If it happens, the ROADMAP owner card reverts to S3's "run jog steps after `$H`" instruction.
- **Hardware boundary:** S3c closes W1 and W2 in software. The safety gap is recorded as closed only after Lee runs card steps 1-5. Until then the ROADMAP says "software-closed, hardware-unqualified".
- **Irreversible steps:** none.

## Decisions

- **Resolved (kerf-9, Lee 2026-09-26):** jogs refuse until homed.
- **Applied under the critic's inversion, reversible, flagged at close:** `$22=0` fails closed (option c). If Lee wants jogging back on such machines, the parked attestation design is the route.

## Critic fold, round 1 (astra, FAIL)

Every trace was re-read in the tree before folding.

1. **P0, raw console `$J=` escaped the bookkeeping (trace A).** Verified: `jogPending` is set only in `sendJogLine` (`:279-289`). Now every non-job motion send takes the lease inside `send()`, `$J=` included. `sendJogLine` only checks it. T5 and M4.
2. **P0, alarms that are only logged (trace B).** Verified at `send()` `:623-642`, `surfaceUnsolicited` `:51-68` and `machineStatus.ts:131-144`. Now all four ALARM paths, reset, stop, re-home start, connect and disconnect revoke. T8(a-g), M11-M15.
3. **P0, attestation overclaimed (trace D, X1).** Removed. `$22=0` fails closed, and the design is parked with the critic's requirements.
4. **P0/X5, a single boolean for overlapping commands, and a missing `ok` treated as the end of motion (trace C, dim 6).** Now there are an outstanding count, a settle that never releases, a release only after all have settled plus a post-settle Idle, and a `sessionGen` fence against stale completions. T6, T7, T10, M5-M7, M10.
5. **`$HX` granting whole-machine trust (D, dim 8).** Now only an exact `$H` grants, and all `$H…` revoke. T9, M9.
6. **Also found while folding:** an ALARM drained during `$H`'s own pump is processed before the response loop and was then overwritten by the `ok` grant. Now there is a `trustGen` check. T9, M8.
7. **P1:** a dependency graph with a waiver, concrete Parking Lot destinations, a rollback operation, a hardware acceptance boundary, a safe alarm stimulus (STOP during a slow move, laser isolated), a lifecycle table with invariants in code, and the recovery guidance in `JOG_REASON_MOTION`.
8. **X4:** the `$22=0` copy says "doesn't home ($22=0)", not "has no limit switches".
