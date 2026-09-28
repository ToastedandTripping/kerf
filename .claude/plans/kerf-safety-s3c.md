# Kerf safety S3c: motion trust. A jog needs a position earned by a full `$H` in this controller lifetime, and nothing jogs while any motion command is unsettled

- **Relay id:** `kerf-safety-s3c`
- **Branch:** `relay/kerf-safety-s3c`
- **Tier:** Standard. 9 files under one root (`src/`): 6 production (`jogBounds.ts`, `connection.ts`, `machineStatus.ts`, `store/storeTypes.ts`, `store/index.ts` for one scalar, `MachinePanel.tsx`) and 3 tests (`jogBounds.test.ts`, `connection.test.ts`, `machineJobLoop.test.tsx`). UI (reason titles only; no new control), so Jen at Stage 3. Web app: the panel renders in the Vite dev server with `invoke` mocked, so the behavioural evaluator applies.
- **Base:** `marvin/kerf-gap` at `aa06a3f` or later. S3 (377a63f) is merged. Every citation was read at `aa06a3f` (no `src/` change since `72540d0`) on 2026-09-27.
- **Revision 3.** It folds the round-1 critic (`-critic-r1.md`, astra, FAIL) and the round-2 critic (`-critic-r2.md`, astra, FAIL). Both folds are listed at the end.

## Dependency graph

| Step | Files | Depends on | Independent of |
|---|---|---|---|
| b1 | the 9 above | S3 (merged, 377a63f) | E1b (Rust only, disjoint files) |

**Batch waiver (9 files, one root, over the 8-file cap).** The lease, the trust owner, the session fence and the gate are one contract. `machineStatus.ts` owns trust, because both the poll path and the command path must revoke through the same generation. Splitting the files would merge a gate that trusts a position one alarm or reset path can no longer revoke.

## Intent (grilled)

There was no separate grill. The intent comes from rulings already on file:
- **Lee, 2026-09-26 (kerf-9), relayed by session-d32473:** "always press home." He always homes after connecting, and "refusing jogs until the machine has homed matches how he works."
- **Coordinator, 2026-09-26, option (a):** a motion-in-flight hold set by Home and by console motion, cleared by the first post-acknowledgement Idle report (Razor W2 on S3), and a jog that requires `$H` since connect when `$22=1` (Razor W1). The owner's controller reports `$20=0 $21=1 $22=1 $23=1` (capture 2026-09-14, lines 25-28).
- **`$22=0`:** fail closed. A machine that does not home cannot earn trust, so the jog buttons refuse on it. Operator attestation is parked (Out of scope 1). This is flagged for Lee at close.

**Summary for this relay.** A jog (the arrows, jog-to, Position Laser) is refused unless both of these hold:
- **Trust.** The machine completed a plain `$H` with a clean `ok` in this connection, and since then no alarm, controller reset (whether Kerf sent it or the controller announced it), STOP, re-home start or reconnect has happened.
- **Settled.** Every non-job motion command (a button jog, `$H`, or a console move including a raw `$J=`) has settled, and a status poll begun after the last settle has reported literal Idle.

A result or poll from an earlier connection changes nothing in the current one. The software gap is recorded as closed only when Lee's frame qualification on hardware passes.

## Existing plans reviewed

- `.claude/plans/kerf-safety-s3.md` and its critic. S3c replaces `jogPending`/`jogTick` with the lease below, which is a superset. It keeps every S3 refusal text, the clip geometry and the bed-memory keys.
- `PLAN-safety-gate-class.md` (`~/marvin/state/audits/gap-2026-09-24/kerf/`). S4a, S4b and S4c edit `connection.ts` in `send()`'s settings-write hook (`:604-607`, `:612-618`), `queryGrblSettings` and `canStartJob`. S3c wraps the `invoke` and the response handling in `send()` without changing the settings lines. Whichever merges second rebases.
- `pause-resume-future.md` is parked, and touches `pause` and `resume` only.

## Diagnosis (read at `aa06a3f`)

1. **The envelope trusts MPos, and nothing makes that trust be earned** (Razor W1 on S3). `clipJog` clips `store.machinePosition` inside `[0, bed]`, or `[-bed, 0]` for Y on origin-top (`jogBounds.ts:42-47`, `:61-73`). `jogBlockReason` (`:50-59`) never reads `machineHomed`. A board reset leaves GRBL reporting MPos 0 wherever the head is.
2. **"Homed" is recorded on two of the four `$H` routes.** `home()` (`connection.ts:809-816`) records it, and is used at `MachinePanel.tsx:1016` and `:1087`. The alarm banner's Home button (`MachinePanel.tsx:477`) and a console `$H` (`Console.tsx:36`) call `send("$H")` directly and record nothing.
3. **Nothing revokes "homed" except `queryGrblSettings`** (`connection.ts:1014-1019`: connect and the soft-limit enable paths). There are four ALARM delivery paths:
   - the snapshot state (`machineStatus.ts:183-184`);
   - status events (`:131-144`), logged only;
   - drained lines (`surfaceUnsolicited`, `connection.ts:51-68`), logged only;
   - command responses (`send()`, `:623-642`), logged only.

   A controller reset announces itself with its startup banner on the same three line paths. The native pump recognises `PumpTerminal::Banner` and returns its lines in `SendOutcome.responses` (`src-tauri/src/commands/serial.rs`, `serial_send_inner`). Kerf only logs it. `softReset()` (`:843-852`) and `emergencyStop()` (`:874` onward) revoke nothing.
4. **A jog right after Home or any console motion is admitted** (Razor W2 and N8 on S3). `jogPending` (`connection.ts:274-289`) is set only by `sendJogLine`, so a console `G0` or a raw `$J=` sets nothing. One boolean cannot represent two outstanding commands. It also clears when a jog returns without `ok` (`:288`), which is not proof that motion ended.
5. **Results are not fenced by connection.** `send()` writes `setMachinePosition` from an in-pump status report (`:643-653`) regardless of which connection issued it. The poll calls `consumeStatusOutcome` (`:721`), which writes state and position. `resetStatusConsumer()` (`:445`, `:587`) resets the epoch/sequence watermarks on reconnect, so a late old-connection report can be accepted against them.
6. **"Idle" is broader than Idle.** `machineStateToStore` maps `check` and `sleep` to `"idle"` (`machineStatus.ts:88-89`). S3's jog release reads it (`connection.ts:731`).
7. **Command and status serialisation.** `serial_send` takes the command mutex with a blocking `lock()` (`serial.rs:485`), and polls use `try_lock` and answer busy while it is held (`connection.ts:709-712`). That orders polls against commands already holding the lock. It does not make TS submission and the Rust lock acquisition atomic, so the lease never infers order from it.
8. **Tests exist to extend.** `connection.test.ts` has `describe("S3 — jog frame")` with `jogReady(patch)` (`:1051-1066`) and asserts literal `serial_send` strings. `jogBounds.test.ts` covers the pure gate. `machineJobLoop.test.tsx` renders MachinePanel.

## Design

### The lifecycle contract

This table goes verbatim into a comment above the lease in `connection.ts`, and the trust half goes into a comment above the trust owner in `machineStatus.ts`.

**Trust owner, in `machineStatus.ts`** (`connection.ts` already imports from it, so there is no new file and no cycle):
```ts
let trustGen = 0;
/** The ONLY way to revoke. Advances the generation, then clears the flag, so a pending grant can never restore it. */
export function revokePositionTrust(): void {
  trustGen++;
  useStore.getState().setMachineHomed(false);
}
export function positionTrustGen(): number {
  return trustGen;
}
/** Grants only if nothing revoked since `gen` was read. */
export function grantPositionTrust(gen: number): void {
  if (gen === trustGen) useStore.getState().setMachineHomed(true);
}
export function isResetBanner(line: string): boolean {
  return /^Grbl\s+\S/i.test(line.trim());
}
```
Every production write of `machineHomed` goes through these. Ted's report greps `setMachineHomed(` and lists every hit: only these two functions, plus the test resets. The existing `queryGrblSettings` clear becomes `revokePositionTrust()`.

**Lease, in `connection.ts`:**
- `motionOutstanding: number`: non-job motion sends that are unsettled.
- `motionHeld: boolean`.
- `motionTick: number`: bumps at every motion submit and settle.
- `sessionGen: number`: bumps on connect and on disconnect, before `resetStatusConsumer()`.

| Event | Lease | Trust |
|---|---|---|
| Any `send()` call begins | Capture `gen = sessionGen` | none |
| Non-job `send` of a motion command (`isMotionCommand`), before `invoke` | `motionOutstanding++`, `motionHeld = true`, `motionTick++`, store `motionInFlight = true` | A homing command (`/^\$H/i`) calls `revokePositionTrust()` and then captures `hgen = positionTrustGen()` |
| `send()` result arrives (resolve or throw), `gen !== sessionGen` | Ignored. The **whole result is discarded**: no position write, no revocation, no grant, no lease change. One console line: `Discarded a reply from a previous connection` | none |
| `send()` result arrives, same session, motion command | `motionOutstanding--` (floor 0), `motionTick++`. Never released here, whatever the response | Plain `$H` only: see Grant |
| Any line in a same-session result (response or drained) that starts with `ALARM` or passes `isResetBanner` | none | `revokePositionTrust()` |
| A poll begins | Capture `pgen = sessionGen` and `tickAtInvoke = motionTick` | none |
| A poll result arrives, `pgen !== sessionGen` | **Discarded before `consumeStatusOutcome`**: no store write | none |
| `consumeStatusOutcome`: an event line with ALARM or a reset banner, or a snapshot whose state is alarm | none | `revokePositionTrust()` (inside `machineStatus.ts`, same owner) |
| A poll completes: `accepted`, a real report, snapshot `state === "idle"` (**literal**; not check, sleep or anything `machineStateToStore` maps to idle), `motionOutstanding === 0`, `tickAtInvoke === motionTick` | `motionHeld = false`, store `motionInFlight = false` | none |
| Any other poll | none | none |
| `softReset()` or `emergencyStop()` invoked (any outcome) | none | `revokePositionTrust()` first, before its send |
| Connect or disconnect | `sessionGen++`, `motionOutstanding = 0`, `motionHeld = false`, `motionTick++`, store `motionInFlight = false` | `revokePositionTrust()` |

**Grant** (same session, plain `$H` settle). `grantPositionTrust(hgen)` runs only when all of these hold:
- the command trimmed and upper-cased is exactly `$H`;
- the responses include `ok`;
- no line in the result (response or drained) starts with `ALARM` or `error:`, or passes `isResetBanner`.

Any revocation during the pump advanced `trustGen`, so the grant is a no-op. `$HX`, `$HY` and other `$H…` forms revoke and never grant.

**Invariants** (in the comments):
1. `motionHeld` is false only if no motion send is unsettled and a literal-Idle report taken after the last settle arrived.
2. No result or poll from an earlier connection writes anything in the current one.
3. `machineHomed` is true only if a plain `$H` completed cleanly in this connection, with no revocation since its own submission.
4. Every revocation advances `trustGen`.

### 1. `jogBounds.ts` (pure)

- `JogGateState` gains `grblHoming`, `machineHomed` and `motionInFlight` (store scalars).
- New texts:
  ```ts
  export const JOG_REASON_HOME =
    "Home the machine ($H) before jogging. Kerf only knows where the bed edge is after homing";
  export const JOG_REASON_NO_HOMING =
    "Jogging is off: this machine doesn't home ($22=0), so Kerf can't tell where the bed edge is";
  export const JOG_REASON_MOTION =
    "The machine is still carrying out the last command. Jogging resumes when it reports Idle. If it never does, press STOP or reconnect, then Home again (both clear homing)";
  ```
- Order: not connected, alarm, job, motion, bed, trust, stale, busy, offset. Written as:
  ```ts
  if (s.motionInFlight) return JOG_REASON_MOTION;
  ```
  ```ts
  if (!s.grblHoming) return JOG_REASON_NO_HOMING;
  if (!s.machineHomed) return JOG_REASON_HOME;
  ```
- `JOG_REASON_PENDING` stays, for S3's "one jog at a time" message in `sendJogLine`.
- `export function isMotionCommand(command: string): boolean`:
  - true for `$J=…` and any `$H…`;
  - false for every other `$` line and for `?`, `!` and `~`;
  - for G-code, first strip `(…)` and `;…` comments; then true if there is an axis word (`/[XYZABC]\s*[-+]?[.\d]/i`) or a `G28`/`G30`/`G38.x` (`/G\s*0*(28|30|38)(\.\d)?(?!\d)/i`), otherwise false.

  It leans toward "moves".

### 2. `connection.ts`

- Replace `jogPending`/`jogTick` with the lease and the comment table.
- **`send()`**:
  1. Capture `gen`.
  2. Take the lease for non-job motion, and for `$H…` revoke and capture `hgen`.
  3. `try/finally` around the existing `invoke`.
  4. On arrival, **if `gen !== sessionGen`, return the discard path before any other processing** (the drained loop, the response loop and the position write all come after this check).
  5. Otherwise settle the lease, revoke on ALARM or banner in the drained and response lines, run the plain-`$H` grant, and continue as today.

  The settings-write lines are unchanged.
- `surfaceUnsolicited`: revoke on ALARM and on a reset banner.
- `sendJogLine`: if `motionHeld`, log `JOG_REASON_PENDING` and return. Otherwise `send(line)`. The lease lives only inside `send`.
- `jog()` and `jogTo()` pass `{ ...store, motionInFlight: motionHeld }` to the gate. The module value is authoritative for sends.
- `home()` becomes `await this.send("$H")`.
- `softReset()` and `emergencyStop()` call `revokePositionTrust()` first.
- **Poll**:
  1. Capture `pgen` and `tickAtInvoke`.
  2. After the `invoke` and before `consumeStatusOutcome`, if `pgen !== sessionGen`, return.
  3. The release predicate reads `outcome.snapshot!.state === "idle"`.
- Connect and disconnect: the table rows. `sessionGen++` happens before `resetStatusConsumer()`.
- `_testResetJogAndBedState` resets the lease and `sessionGen`. `machineStatus.ts` gains `_testResetPositionTrust()`.

### 3. `machineStatus.ts`

- The trust owner above.
- In the event loop (`:131-144`), an ALARM or a reset banner calls `revokePositionTrust()`.
- After the snapshot's state write (`:183-184`), if `storeState === "alarm"`, it calls `revokePositionTrust()`.
- No callback parameter and no optional path.

### 4. The store (one scalar)

- `storeTypes.ts` gains `motionInFlight: boolean` (a non-job motion command is unsettled, or no literal Idle has been seen since) and `setMotionInFlight`.
- `store/index.ts` gains the field and the setter. `setMachineState` is **unchanged**. A store-side clear of `machineHomed` without the generation is exactly the half-revocation the round-2 critic flagged (E).

### 5. `MachinePanel.tsx`

- Both `jogBlockReason` calls (`:128-137`, `:142-151`) add `grblHoming`, `machineHomed` and `motionInFlight` from three separate scalar `useStore` selectors (CLAUDE.md, React error 185). The disabled arrows and POSITION show the reasons as titles, which is S3's mechanism.
- There is no new control.

## Tests

**Reproduce first.** Before any production edit, add R1-R5 to `connection.test.ts`, run them red, and quote the failures:
- **R1 (W1):** `jogReady({ machineHomed: false, grblHoming: true })`, then `jog("X", 10)`. Today it sends.
- **R2 (W2):** homed. Hold `send("$H")` pending, then `jog("X", -10)`. Today it sends.
- **R3:** homed. Hold a console `send("$J=G21 G91 X20 F300")` pending, then `jog("X", 10)`. Today it sends.
- **R4:** homed. `send("$H")` resolves `["ALARM:9"]`, `send("$X")` resolves `["ok"]`, a fresh Idle poll comes in, then `jog("X", 10)`. Today it sends.
- **R5:** homed. A command's `drained` carries `Grbl 1.1f ['$' for help]`, a fresh Idle poll comes in, then `jog`. Today it sends.

`jogReady` gains `grblHoming: true, machineHomed: true, motionInFlight: false` in its defaults, with the trust owner's generation reset in `beforeEach`. S3's assertions are unchanged, with one exception. The S3 tests where a jog returned without `ok` and a second jog was then allowed at once now need one Idle poll first, because a missing `ok` is not proof that motion ended. Each such edit is listed in the Ted report.

**Oracle rule:** wherever a test asserts that a jog is admitted after recovery, it asserts the literal `$J=` string, distance included, computed from the current connection's position.

| Test | File | Asserts |
|---|---|---|
| T1 | `jogBounds.test.ts` | `JOG_REASON_NO_HOMING` when `!grblHoming`, `JOG_REASON_HOME` when unhomed, null when ready. `motionInFlight` gives `JOG_REASON_MOTION` ahead of bed, trust, stale and busy. An unconfirmed bed on an unhomed machine gives `JOG_REASON_BED` |
| T2 | `jogBounds.test.ts` | `isMotionCommand`. True: `$H`, `$h`, `$HX`, `$J=G91 X1`, `G0 X10`, `g1y5 f100`, `X5`, `x-.5`, `G28`, `G30`, `G38.2 Z-5`, `G1 X1 (c)`. False: `$$`, `$#`, `$G`, `$I`, `$X`, `$C`, `$RST=$`, `$32=1`, `$22=0`, `?`, `!`, `~`, `M3 S0`, `M5`, `G4 P0.5`, `G21`, `G90`, `G92.1`, `G1 F100`, `; X10`, `(X10) M5`, `G280`. Plus `isResetBanner` (in `connection.test.ts` or a `machineStatus` block): true for `Grbl 1.1f ['$' for help]` and `grbl 1.1h`, false for `[MSG:Reset to continue]` and `ok` |
| T3 (R1) | `connection.test.ts` | Unhomed `$22=1`: `jog` and `jogTo` make zero `serial_send` calls and log `JOG_REASON_HOME`. `$22=0`: zero sends and `JOG_REASON_NO_HOMING` |
| T4 (R2) | `connection.test.ts` | `$H` pending: no `$J=` send, and `JOG_REASON_MOTION` is logged. After `ok`: a busy poll does not release; a poll begun before the ack that returns Idle does not release; a poll begun after it that returns Idle releases, and the next jog sends the literal expected `$J=` |
| T5 (R3) | `connection.test.ts` | A pending raw `$J=` or `G1 X20 F300` blocks the buttons. `$$` and `M5` never do. A job-epoch send never takes the lease |
| T6 | `connection.test.ts` | Overlap: A is pending and B settles `error:15`, and the lease is still held. A poll that completes Idle while A is outstanding does not release. After A settles, a later Idle poll releases |
| T7 | `connection.test.ts` | Thrown invoke: held until a post-settle Idle poll, never released by the rejection |
| T8 (R4) | `connection.test.ts` | Starting homed, each route is taken through its real transition. First the immediate refusal the gate gives in that state (alarm, motion or stale, as applicable). Then recovery: unlock with `$X` → `ok` and/or the command settles, then a fresh literal-Idle poll. Then the assertion that the jog is refused with `JOG_REASON_HOME`, then a clean `$H` and Idle, and then the literal `$J=` sends. The routes: (a) `$H` → `ALARM:9`; (b) a drained `ALARM:1`; (c) a status event `ALARM:3`; (d) an Alarm snapshot; (e) `softReset()`; (f) `emergencyStop()`; (g) a new `$H` begun while homed; (h) a console `G1 X10 F300` → `ALARM:2` (the response-loop path alone) |
| T9 (R5) | `connection.test.ts` | Reset banner, starting homed, on each of the three line paths: a command response, drained, and a status event. It revokes. The recovery is the same as T8 |
| T10 | `connection.test.ts` | Grant: a plain `$H` `ok` grants. `$HX` `ok` revokes and does not grant. `$H` `ok` with an `ALARM` or a banner in `drained` does not grant. `["ok","error:9"]` does not grant |
| T11 | `connection.test.ts` | **Revocation during a pending `$H`, then a delayed clean `ok`:** for each route (a status-event ALARM, a status-event banner, an Alarm snapshot, `softReset`, `emergencyStop`), the delayed `ok` leaves `machineHomed` false. The generation, not the boolean, is what blocks it |
| T12 | `connection.test.ts` | **Session fence, position oracle:** start a command whose invoke is held, disconnect, connect, home (clean), and take a fresh Idle poll at MPos (200, 150). The old invoke now resolves with an in-pump report `<Idle\|MPos:10.000,10.000,0.000\|…>` and `ok`: `machinePosition` stays (200, 150), homed stays true, the lease is unchanged, and the next `jog("X", 10)` sends exactly `$J=G21 G91 X10.000 F1000`, clipped against 200, not 10. The same for a held poll whose late result carries MPos (10, 10) and an ALARM event: no write, no revoke. One more case: the late result arrives before the new session's first fresh poll |
| T13 | `connection.test.ts` | **Literal Idle:** snapshots in state `check` or `sleep` after a settle never release the lease. `idle` does |
| T14 | `connection.test.ts` | The alarm banner route: `send("$H")` → `ok` grants, and `home()` grants through the same path |
| T15 | `machineJobLoop.test.tsx` | Panel: `$22=1` unhomed disables the arrows and POSITION with `JOG_REASON_HOME` as the title. `$22=0` gives `JOG_REASON_NO_HOMING`. `motionInFlight` gives `JOG_REASON_MOTION`. Homed, idle and fresh: enabled |

**Mutation battery `kerf-safety-s3c`.** `test_command`: `["npx","vitest","run","--cache=false","src/lib/machine/__tests__/jogBounds.test.ts","src/lib/machine/__tests__/connection.test.ts","src/components/panels/__tests__/machineJobLoop.test.tsx"]`. Ted confirms from the baseline that all three files ran, and states the count.
- Ted writes each *(Ted writes)* `find` from the committed code before the run, and records it in the report with `grep -cF` = 1 on HEAD.
- Every replacement type-checks. A `find` that differs from the stated shape needs the orchestrator's sign-off in the report.
- Kills must come from an observable unsafe send, a wrong coordinate, or a wrong flag, as the Killed-by test asserts.

| Id | Mutates | Killed by |
|---|---|---|
| M1 | `if (!s.machineHomed) return JOG_REASON_HOME;` becomes `if (false) …` | T1, T3 |
| M2 | `if (!s.grblHoming) return JOG_REASON_NO_HOMING;` becomes `if (false) …` | T1, T3 |
| M3 | `if (s.motionInFlight) return JOG_REASON_MOTION;` becomes `if (false) …` | T1, T15 |
| M4 | the send motion condition *(Ted writes)*: `isMotionCommand(command)` becomes `command.startsWith("$H")` | T5 |
| M5 | release: `motionOutstanding === 0` becomes `true` | T6 |
| M6 | release: `tickAtInvoke === motionTick` becomes `true` | T4 |
| M7 | settle: insert a release on a non-`ok` settle | T6, T7 |
| M8 | `grantPositionTrust`: `gen === trustGen` becomes `true` | T10 (drained ALARM), T11 |
| M9 | grant: exact `=== "$H"` becomes `.startsWith("$H")` | T10 (`$HX`) |
| M10 | send fence *(Ted writes)*: `gen !== sessionGen` becomes `false` | T12 (position 10, not 200) |
| M11 | poll fence *(Ted writes)*: `pgen !== sessionGen` becomes `false` | T12 (poll case) |
| M12 | `surfaceUnsolicited`: the revoke removed | T8(b), T9 (drained) |
| M13 | machineStatus event loop: the revoke removed | T8(c), T9 (event), T11 |
| M14 | the send response loop: the revoke removed | T8(h), T9 (response) |
| M15 | the `$H` submission revoke removed | T8(g) |
| M16 | `isResetBanner` returns `false` | T2, T9 |
| M17 | release: `=== "idle"` becomes `machineStateToStore(outcome.snapshot!.state) === "idle"` | T13 |
| M18 | `revokePositionTrust`: `trustGen++` removed | T11 |
| M19 | `softReset()`'s revoke removed | T8(e) |
| M20 | `emergencyStop()`'s revoke removed | T8(f) |
| M21 | machineStatus snapshot-alarm revoke removed | T8(d) |
| C1 | Control: the axis-word regex matches everything (`/./`) | T2's false cases go red |

## Verification

- `npx vitest run --cache=false` over the full suite: baseline plus the new tests, with nothing skipped.
- `npx tsc --noEmit`, `npm run -s format:check`, and `npm run -s lint` with no new warnings in the touched files.
- Battery journal: every id `killed`; `survived`, `errored` and `CONTROL_RED` all 0.
- `grep -rn "setMachineHomed(" src --include='*.ts' --include='*.tsx'` lists only the trust owner and the test resets, and the Ted report quotes it.
- **Browser (dev server, `invoke` mocked as in S3's behavioural evaluation):** the T15 states, with screenshots. This is UI evidence only.
- **Owner hardware card: frame qualification (ROADMAP `next`).**
  - **Safety for every step:**
    - Laser power isolated (key off, or laser PSU off).
    - The controller's own power switch within reach, as the stop that does not depend on Kerf.
    - Hands clear of the gantry.
    - Feed 300 mm/min or less for every console move.
    - Every console move runs in `G21 G90` (mm, absolute), with no work offset: `G92.1` first, then confirm the panel shows no offset.
  - **Steps:**
    1. Connect. Before homing, the arrows are disabled with "Home the machine ($H)…".
    2. Press Home.
       - While it homes, press an arrow: refused with "still carrying out the last command".
       - **Record:** did both X and Y move during homing? Which physical corner did the head stop at? What MPos does the panel show after pull-off?
    3. **Frame check.** Kerf's envelope assumes the physical home corner is its (0, 0) corner. X runs `[0, bed width]`; Y runs `[0, bed height]`, or `[-bed height, 0]` on origin-top. Press X+ once (10 mm step) and **record** whether the head moved away from the home corner, into the bed, by 10 mm. Then do the same for Y (Y+ on origin-bottom, Y− on origin-top).
       - **If the direction is outward, or the head does not move, stop:** the frame does not match. Record it; the gap stays open.
    4. **Extent check.** With Position Laser, click a point about 20 mm inside the far corner diagonal from home. **Record** where the head physically stops relative to the bed edges.
       - It must stop inside the bed with room to spare. Stop the machine at the controller if it approaches the frame.
    5. **Console-motion hold.** From the far point, send `G1 X` (a value 20 mm back toward home) ` F300`, then press an arrow at once. It is refused until the head stops.
    6. **Safe alarm stimulus.** Send a slow inward move (`G1 X` value 30 mm toward home, `F200`) and press STOP mid-move.
       - **Record** what the controller reports (stock GRBL gives `ALARM:3`; the vendor fork is unqualified).
       - Unlock (`$X`) without homing. The arrows stay disabled with the Home reason until Home.
  - **Acceptance:**
    - The gap is recorded as closed only when steps 1-6 pass, both axes homed in step 2, and steps 3-4 match the envelope.
    - If any of these does not hold, the ROADMAP records "software-closed, hardware-unqualified", along with the recorded mismatch, and admission stays as shipped until a frame fix is planned.

## Out of scope (Stage 3.5: `## Parking Lot`, `### Deferred from kerf-safety-s3c (2026-09-27)`, each with an index line)

1. **Operator origin attestation for `$22=0` machines.** Parked with the round-1 critic's requirements: a motion-free current-session window; an unambiguous physical corner and direction; the hazard shown before confirming; hardware qualification. Until then, `$22=0` refuses.
2. **Jobs, FRAME and the material test do not require homing.** They go through `canStartJob`, not the jog gate. S4c territory.
3. **Alarm codes are not distinguished.** Every alarm revokes, including soft-limit alarm 2, where GRBL keeps position.
4. **A console `$22` change** reaches the gate only at the next full settings parse, the same drift as S3's Parking Lot line 1.
5. **Console motion is sent unclipped, by policy.** S3c counts it in the lease. It does not bound it.
6. **A frame mismatch found by the owner card** (if step 3 or 4 fails) needs its own plan: a per-machine frame model, or reading `$23` into the envelope.

## Risks and rollback

- **Every connection of a `$22=1` machine needs Home before jogging.** That is the ruling (kerf-9).
- **`$22=0` machines lose jogging from the buttons.** This is flagged for Lee.
- **A second jog after a rejected jog waits one poll (about 250 ms).**
- **Rollback.** Revert the merge on the session branch. Nothing is persisted, so the revert is clean. It restores S3 with W1 and W2 open. The operating restriction until corrected code returns: **do not use the jog buttons or Position Laser; move the head only after Home, from the console, and only after the previous move has visibly stopped.** It goes on the owner card and in the ROADMAP `next` line if a revert happens.
- **Hardware boundary.** See Acceptance above.
- **Irreversible steps:** none.

## Decisions

- **Resolved (kerf-9, Lee 2026-09-26):** jogs refuse until homed.
- **Applied under the critic's inversion, reversible, flagged at close:** `$22=0` fails closed.

## Critic fold, round 1 (astra, FAIL)

1. **P0: a raw console `$J=` escaped the check.** Every non-job motion send now takes the lease inside `send()`. (T5, M4.)
2. **P0: three alarm paths only logged.** All four paths now revoke, as do reset, stop, re-home and connect/disconnect. (T8, M12-M15, M19-M21.)
3. **P0: attestation overclaimed.** Removed. `$22=0` fails closed, and attestation is parked.
4. **P0/X5: one boolean, and a missing `ok` treated as the end of motion.** There is now an outstanding count; a settle never releases the hold; release needs a post-settle Idle; and there is a session fence. (T6, T7, T12, M5-M7, M10-M11.)
5. **`$HX` granted trust.** Only an exact `$H` grants now. (T10, M9.)
6. **Found while folding:** an ALARM drained during `$H`'s own pump could be overwritten by its `ok`. The generation check now blocks that. (T10, T11, M8.)
7. **P1:** the dependency graph and waiver, the Parking Lot destinations, rollback, the hardware boundary, the lifecycle table and the recovery copy.

## Critic fold, round 2 (astra, FAIL)

- **A (P0): an unsolicited controller reset was not a revocation.** Verified: the native pump returns banner lines in `responses`, and Kerf only logs them. `isResetBanner` now revokes on responses, drained lines and status events. A reset during `$H` blocks the grant through the generation. (T9, T11, M16.)
- **B (P0): the session fence stopped at bookkeeping.** Verified: `send()` writes position from an in-pump report (`:643-653`), and the poll feeds `consumeStatusOutcome` without a session check. Whole results are now discarded on a session mismatch before any write, for both paths. (T12, with a position and literal-distance oracle, M10-M11.)
- **C (P0): the 10 mm oracle could not prove the frame.** The card now records both-axis homing, the home corner, MPos after pull-off, the direction per axis and the far extent. It runs in `G21 G90` with no offset, at 300 mm/min or less, with an independent stop, and closure is blocked on acceptance.
- **D (P1): T8 was unreachable as worded.** Each route now asserts its immediate refusal, then the recovery, then the Home refusal. The release reads literal `idle`, verified: `machineStateToStore` maps check and sleep to idle (`machineStatus.ts:88-89`). (T13, M17.)
- **E (P1): revocation was optional, and the store fallback was only half of one.** There is now one owner in `machineStatus.ts`: `revokePositionTrust` always advances the generation, `setMachineState` is unchanged, and every `setMachineHomed(` call is grep-audited. (T11, M18.)
- **X4 and X6:** the console suggestion is removed; stuck-command recovery is in `JOG_REASON_MOTION`; the rollback operating restriction covers both W1 and W2.
