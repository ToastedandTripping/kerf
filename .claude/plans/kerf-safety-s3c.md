# Kerf safety S3c: motion trust within a connection. A jog needs a position earned by a full `$H`, and a fresh valid position after every motion command has settled

- **Relay id:** `kerf-safety-s3c`
- **Branch:** `relay/kerf-safety-s3c`
- **Tier:** Standard. 9 files under one root (`src/`):
  - 6 production: `jogBounds.ts`, `connection.ts`, `machineStatus.ts`, `store/storeTypes.ts`, `store/index.ts` (one scalar), `MachinePanel.tsx`.
  - 3 tests: `jogBounds.test.ts`, `connection.test.ts`, `machineJobLoop.test.tsx`.
  - UI changes are reason titles only, with no new control, so Jen reviews at Stage 3. The panel renders in the Vite dev server with `invoke` mocked, so the behavioural evaluator applies.
- **Base:** `marvin/kerf-gap` at `aa06a3f` or later. S3 (377a63f) is merged. Every citation was read at `aa06a3f` on 2026-09-27.
- **Revision 4.** It folds critic rounds 1-3 (astra, all FAIL; files `-critic-r1.md` to `-critic-r3.md`).
- **Scope decision (orchestrator, under Lee's standing delegation on technical scope):** everything that crosses a connection boundary moves to a new plan, **S3d**, which is outside this relay (see "Split" below).

## Dependency graph

| Step | Work | Depends on | Independent of |
|---|---|---|---|
| b1 (Ted) | the 9 files above | S3 (merged, 377a63f) | E1b (Rust only, disjoint files) |
| 3.5 (orchestrator) | ROADMAP: Parking Lot section `### Deferred from kerf-safety-s3c (2026-09-27)` with the 6 index lines below; the owner card in `next`; an ARCHITECTURE.md delta for the lease and the trust owner | b1 merged | none |

**Batch waiver (9 files, one root, over the 8-file cap).** The lease, the trust owner and the gate form one contract. `machineStatus.ts` owns trust, because both the poll path and the command path must revoke through the same generation.

## Split: what S3c does not claim, and why

Round 3 showed a pre-existing defect class: **connection lifetime**.
- A send queued on the native command mutex can acquire it after a disconnect and reconnect, and write its bytes to the new controller. `serial_send_inner` locks `inner.command` (`serial.rs:486-490`) and writes non-job commands with no epoch check. Disconnect and connect take the same lock (`serial.rs:342-351`, `disconnect_inner`).
- On the TS side, a late reply, a late poll rejection (the failure counter at `connection.ts:736-749`), a settings-write `finally` (`:617-619`) and `getStatusReport()`'s event surfacing can all act on the new connection.
- This affects every command, not only motion, and its fix needs a connection token checked at the native write boundary.

That is **S3d**, planned after this relay, with its own critic.

S3c's claims hold **within one connection**. Across a reconnect, S3c guarantees only this: trust is revoked, and the lease is reset, at connect and at disconnect. The new connection must therefore earn trust with its own `$H` before any jog is admitted. The residual window is a late reply from the old connection landing after the new connection's `$H`. It is named in the ROADMAP Parking Lot as the S3d work item, and in the release notes of whatever build first carries S3c.

## Intent (grilled)

There was no separate grill. The intent comes from rulings already on file:
- **Lee, 2026-09-26 (kerf-9), relayed by session-d32473:** "always press home". He always homes after connecting, and "refusing jogs until the machine has homed matches how he works."
- **Coordinator, 2026-09-26, option (a):** a motion-in-flight hold set by Home and by console motion, cleared by the first post-acknowledgement Idle report (Razor W2 on S3). A jog requires `$H` since connect when `$22=1` (Razor W1). The owner's controller reports `$20=0 $21=1 $22=1 $23=1` (capture 2026-09-14, lines 25-28).
- **`$22=0`:** fail closed. Attestation is parked. Flagged for Lee at close.

**Summary for this relay.** Within one connection, a jog (arrows, jog-to, Position Laser) is refused unless all three of these hold:
- **Trust.** A plain `$H` completed with a clean `ok` in this connection. Since then there has been no alarm (a line, an event, a snapshot, or an in-pump `<Alarm…>` report), no controller reset (Kerf-sent or a banner), no STOP, no re-home start and no reconnect.
- **Settled.** Every non-job motion command (a button jog, `$H`, or a console move, raw `$J=` included) has settled.
- **Fresh position.** A status poll begun after the last settle has returned a literal-Idle report carrying a valid, finite MPos.

## Diagnosis (read at `aa06a3f`)

1. **The envelope trusts MPos, and nothing makes it earn that trust** (Razor W1 on S3). `clipJog` clips `store.machinePosition` against `[0, bed]`, or `[-bed, 0]` for Y on origin-top (`jogBounds.ts:42-47`, `:61-73`). `jogBlockReason` (`:50-59`) never reads `machineHomed`.
2. **"Homed" is recorded on only two of the four `$H` routes.** `home()` (`connection.ts:809-816`) records it, and is used at `MachinePanel.tsx:1016` and `:1087`. The alarm banner's Home button (`MachinePanel.tsx:477`) and a console `$H` (`Console.tsx:36`) record nothing.
3. **Only `queryGrblSettings` revokes it** (`connection.ts:1014-1019`).
   - The ALARM paths are: snapshot state (`machineStatus.ts:183-184`); status events (`:131-144`, logged only); drained lines (`surfaceUnsolicited`, `connection.ts:51-68`, logged only); command responses (`send()`, `:623-642`, logged only); and an in-pump `<Alarm|…>` report inside a command's responses. That last one is consumed as a status sample (`:625-630`) and never inspected for state.
   - A controller reset's startup banner arrives on the same line paths. The native pump returns `PumpTerminal::Banner` lines in `responses`.
   - `softReset()` (`:843-852`) and `emergencyStop()` (`:874` onward) revoke nothing.
4. **A jog is admitted right after Home or any console motion** (Razor W2 and N8 on S3). `jogPending` (`:274-289`) is set only by `sendJogLine`. One boolean cannot represent two outstanding commands. A reply without `ok` clears it (`:288`), which is not proof that the motion ended.
5. **An accepted Idle does not mean a fresh position.** `consumeStatusOutcome` writes state and advances `lastValidStatusTime` before it validates the position. A null or non-finite position skips the position write and still returns accepted (`machineStatus.ts:175-197`), so the old `machinePosition` is kept. `machineStateToStore` also maps `check` and `sleep` to `idle` (`:88-89`).
6. **Serialisation.** `serial_send` blocks on the command mutex (`serial.rs:486-490`). The poll uses `try_lock` and answers busy while the mutex is held (`connection.ts:709-712`). That orders polls against commands already holding the lock. It does not make TS submission and Rust lock acquisition atomic, so the lease never infers order from it.
7. **The tests to extend.** `connection.test.ts`'s `describe("S3 — jog frame")` with `jogReady(patch)` (`:1051-1066`). `jogBounds.test.ts`. `machineJobLoop.test.tsx`.

## Design

### The lifecycle contract

This table goes verbatim into a comment above the lease in `connection.ts`. The trust half goes above the trust owner in `machineStatus.ts`.

**The trust owner, in `machineStatus.ts`** (`connection.ts` already imports from it):
```ts
let trustGen = 0;
/** The ONLY way to revoke. Advances the generation, then clears, so a pending grant can never restore it. */
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
/** A status line (`<Alarm…>`, `<Alarm:3|…>`) whose state field is Alarm. */
export function isAlarmStatusLine(line: string): boolean {
  return /^<\s*Alarm\b/i.test(line.trim());
}
```
Every production write of `machineHomed` goes through these. The existing `queryGrblSettings` clear becomes `revokePositionTrust()`. Ted's report quotes `grep -rn "setMachineHomed(" src`: only these two functions and the test resets.

**Freshness, also in `machineStatus.ts`.** `consumeStatusOutcome` records, per accepted report, whether that report carried a valid machine position: `lastReportPositionValid = fx, fy and fz all finite && snap.positionKind === "MPos"`. Export `lastReportHadValidMachinePosition(): boolean`. Nothing else in the consumer changes.

**The lease, in `connection.ts`:**
- `motionOutstanding: number` counts non-job motion sends that have not settled.
- `motionHeld: boolean`.
- `motionTick: number` bumps at every motion submit and settle.
- `leaseGen: number` bumps on connect and on disconnect. It fences only the lease and the grant. Everything else across connections is S3d.

| Event | Lease | Trust |
|---|---|---|
| A non-job `send` of a motion command (`isMotionCommand`), before `invoke`: capture `g = leaseGen` | `motionOutstanding++`, `motionHeld = true`, `motionTick++`, store `motionInFlight = true` | A homing command (`/^\$H/i`): `revokePositionTrust()`, then capture `hgen = positionTrustGen()` |
| That send settles (resolve or throw) and `g === leaseGen` | `motionOutstanding--` (floor 0), `motionTick++`. Never released here, whatever the reply | Plain `$H` only (see Grant) |
| That send settles and `g !== leaseGen` | No lease change | No grant |
| Any line in a command's `responses` or `drained` that starts with `ALARM`, passes `isResetBanner`, or passes `isAlarmStatusLine` | none | `revokePositionTrust()` |
| A poll begins | Capture `tickAtInvoke = motionTick` | none |
| `consumeStatusOutcome`: an event with ALARM or a reset banner, or a snapshot whose state is alarm | none | `revokePositionTrust()` (same owner) |
| A poll completes with `accepted`, a real report, `snapshot.state === "idle"` (**literal**), `lastReportHadValidMachinePosition()`, `motionOutstanding === 0`, and `tickAtInvoke === motionTick` | `motionHeld = false`, store `motionInFlight = false` | none |
| Any other poll, including an accepted Idle with no valid machine position | none (the hold stays) | none |
| `softReset()` or `emergencyStop()` invoked (any outcome) | none | `revokePositionTrust()`, first |
| Connect or disconnect | `leaseGen++`, `motionOutstanding = 0`, `motionHeld = false`, `motionTick++`, store `motionInFlight = false` | `revokePositionTrust()` |

**Grant.** `grantPositionTrust(hgen)` runs at a plain-`$H` settle only when all of these hold:
- `g === leaseGen`.
- The command, trimmed and upper-cased, is exactly `$H`.
- `responses` includes `ok`.
- No line in `responses` or `drained` starts with `ALARM` or `error:`, or passes `isResetBanner` or `isAlarmStatusLine`.

`$HX`, `$HY` and every other `$H…` revoke and never grant.

**Invariants** (in the comments):
1. **Within a connection,** `motionHeld` is false only when no motion send is unsettled and a literal-Idle report with a valid MPos, taken after the last settle, has arrived. At connect the lease starts released, but trust starts revoked, so no jog is admitted until a `$H` (itself a motion send) settles and such a report arrives.
2. `machineHomed` is true only if a plain `$H` completed cleanly in this connection, with no revocation since its own submission.
3. Every revocation advances `trustGen`.
4. **Not claimed:** anything about replies or bytes that cross a connection boundary (S3d).

### 1. `jogBounds.ts` (pure)

- `JogGateState` gains `grblHoming`, `machineHomed` and `motionInFlight`, all store scalars.
- The new reason texts:
  ```ts
  export const JOG_REASON_HOME =
    "Home the machine ($H) before jogging. Kerf only knows where the bed edge is after homing";
  export const JOG_REASON_NO_HOMING =
    "Jogging is off: this machine doesn't home ($22=0), so Kerf can't tell where the bed edge is";
  export const JOG_REASON_MOTION =
    "Waiting for the machine to finish the last command and report its position";
  ```
  Recovery advice is in the refusal note, not in the reason: see §5.
- Order: not connected, alarm, job, motion, bed, trust, stale, busy, offset.
  - `if (s.motionInFlight) return JOG_REASON_MOTION;`
  - `if (!s.grblHoming) return JOG_REASON_NO_HOMING;`
  - `if (!s.machineHomed) return JOG_REASON_HOME;`
- `JOG_REASON_PENDING` stays, for `sendJogLine`.
- `export function isMotionCommand(command: string): boolean`.
  - True for `$J=…` and any `$H…`.
  - False for every other `$` line, and for `?`, `!` and `~`.
  - For G-code, strip `(…)` and `;…` comments first. It is then true if there is an axis word (`/[XYZABC]\s*[-+]?[.\d]/i`), or a `G28`, `G30` or `G38.x` (`/G\s*0*(28|30|38)(\.\d)?(?!\d)/i`).

### 2. `connection.ts`

- Replace `jogPending`/`jogTick` with the lease and the comment table.
- `send()`:
  1. Take the lease and the `$H` revoke, as in the table.
  2. Wrap the existing `invoke` in `try/finally` so the settle runs on throw too.
  3. Revoke on ALARM, banner or alarm-status in `drained` and `responses`. `drained` goes through `surfaceUnsolicited`. The `<…>` branch of the response loop checks `isAlarmStatusLine` before it `continue`s.
  4. Run the grant check.

  The existing settings-write lines, the drained loop order and the position write are unchanged.
- `surfaceUnsolicited`: revoke on ALARM and on a reset banner.
- `sendJogLine`: if `motionHeld`, log `JOG_REASON_PENDING` and return; otherwise `send(line)`.
- `jog()`/`jogTo()` pass `{ ...store, motionInFlight: motionHeld }` to the gate.
- `home()` becomes `await this.send("$H")`.
- `softReset()` and `emergencyStop()` call `revokePositionTrust()` first.
- Poll:
  1. Capture `tickAtInvoke`.
  2. The release predicate reads `outcome.snapshot!.state === "idle"`, `lastReportHadValidMachinePosition()`, and the lease conditions.
- Connect and disconnect: the table row.
- `_testResetJogAndBedState` resets the lease. `machineStatus.ts` gains `_testResetPositionTrust()`.

### 3. `machineStatus.ts`

- The trust owner and the freshness flag, as above.
- Event loop (`:131-144`): revoke on ALARM or a reset banner.
- After the snapshot state write (`:183-184`): if `storeState === "alarm"`, revoke.
- No callback and no optional path.

### 4. The store (one scalar)

- `storeTypes.ts` gets `motionInFlight: boolean` and `setMotionInFlight`.
- `store/index.ts` gets the field and the setter.
- `setMachineState` is unchanged. A store-side clear without the generation is the half-revocation that round 2 flagged.

### 5. `MachinePanel.tsx`

- Both `jogBlockReason` calls (`:128-137`, `:142-151`) add `grblHoming`, `machineHomed` and `motionInFlight` from three separate scalar `useStore` selectors (CLAUDE.md, React error 185).
- When the arrows are disabled for `JOG_REASON_MOTION` for more than 5 s, the existing jog note slot shows: `Still waiting on the machine. If it has stopped moving, reconnect and Home again.` It uses the S3 note styling.
  - The advice is reconnect, not STOP. A reconnect is the one action that resets the lease (table row), and it revokes trust, so Home is required anyway. STOP revokes trust but does not settle an outstanding invoke (round 3, X4).
  - The 5 s timer is a `useEffect` keyed on the reason string, and is cleared on unmount.
- There is no new control.

## Tests

**Reproduce first.** Before any production edit, add R1-R6 to `connection.test.ts`. Run them red and quote the failures.
- **R1 (W1):** `jogReady({ machineHomed: false, grblHoming: true })`, then `jog("X", 10)`. Today it sends.
- **R2 (W2):** homed. Hold `send("$H")` pending, then `jog("X", -10)`. Today it sends.
- **R3:** homed. Hold a console `send("$J=G21 G91 X20 F300")` pending, then jog. Today it sends.
- **R4:** homed. `send("$H")` returns `["ALARM:9"]`. Then `$X` returns `ok`, a fresh Idle poll arrives, then jog. Today it sends.
- **R5:** homed. A command's `drained` carries `Grbl 1.1f ['$' for help]`, then Idle, then jog. Today it sends.
- **R6 (A):** homed, bed 205 × 300, MPos (100, 100). A console `G1 X200 F300` settles `ok`. The next poll is Idle with position `null`. Then `jog("X", 10)`. Today it sends `X10.000`, clipped against the retained X=100.

`jogReady` gains `grblHoming: true, machineHomed: true, motionInFlight: false`, with the trust owner reset in `beforeEach`. The S3 assertions are unchanged, except S3 tests where a jog returned without `ok` and a second jog was allowed at once. Those now need one valid-position Idle poll first. Each such edit is listed in the Ted report.

**Oracle rule.** Every "admitted" assertion checks the literal `$J=` string, using an **edge-sensitive** setup where the correct and the stale position produce different distances. Example: bed width 205, current X = 200, stale X = 10, request +10. The correct send is `X5.000`; the stale one would be `X10.000`.

| Test | File | Asserts |
|---|---|---|
| T1 | `jogBounds.test.ts` | Reason precedence: `NO_HOMING`, `HOME`, `MOTION` before bed/trust/stale/busy, and `BED` before trust |
| T2 | `jogBounds.test.ts` | `isMotionCommand` true: `$H`, `$h`, `$HX`, `$J=G91 X1`, `G0 X10`, `g1y5 f100`, `X5`, `x-.5`, `G28`, `G30`, `G38.2 Z-5`, `G1 X1 (c)`. False: `$$`, `$#`, `$G`, `$I`, `$X`, `$C`, `$RST=$`, `$32=1`, `$22=0`, `?`, `!`, `~`, `M3 S0`, `M5`, `G4 P0.5`, `G21`, `G90`, `G92.1`, `G1 F100`, `; X10`, `(X10) M5`, `G280`. Also `isResetBanner` (true: `Grbl 1.1f ['$' for help]`, `grbl 1.1h`; false: `[MSG:Reset to continue]`, `ok`) and `isAlarmStatusLine` (true: `<Alarm|MPos:0,0,0>`, `<Alarm:3|…>`; false: `<Idle|…>`, `ALARM:1`) |
| T3 (R1) | `connection.test.ts` | Unhomed `$22=1`: zero `serial_send` calls from `jog` and `jogTo`, and `JOG_REASON_HOME`. `$22=0`: zero sends, and `JOG_REASON_NO_HOMING` |
| T4 (R2) | `connection.test.ts` | `$H` pending: no `$J=`, and `JOG_REASON_MOTION`. After `ok`, none of these release: a busy poll; a poll begun before the ack that returns Idle; a poll begun after it whose Idle has no position. A later valid Idle at X = 200 releases, and the next +10 sends `X5.000` |
| T5 (R3) | `connection.test.ts` | A pending raw `$J=` or `G1 X20 F300` blocks the arrows. `$$` and `M5` never do. A job-epoch send never takes the lease |
| T6 | `connection.test.ts` | Overlap. Hold A pending; B settles `error:15`: still held. An Idle poll while A is outstanding does not release. After A settles, a later valid Idle releases |
| T7 | `connection.test.ts` | A thrown invoke stays held until a later valid Idle |
| T8 (R4) | `connection.test.ts` | Starting homed, each route is walked through its real transitions: the immediate refusal the gate gives in that state; then recovery (`$X` → `ok` and/or settle, then a valid Idle); then `JOG_REASON_HOME`; then a clean `$H` and a valid Idle; then the edge-sensitive literal send. Routes: (a) `$H` → `ALARM:9`; (b) drained `ALARM:1`; (c) status event `ALARM:3`; (d) Alarm snapshot; (e) `softReset()`; (f) `emergencyStop()`; (g) a new `$H` while homed; (h) console `G1 X10 F300` → `ALARM:2`; (i) console `G1 X10 F300` whose responses hold only `<Alarm:1\|MPos:…>` and `ok` |
| T9 (R5) | `connection.test.ts` | A reset banner on each line path (response, drained, status event) revokes. The recovery is the same as T8 |
| T10 | `connection.test.ts` | Grant. Plain `$H` `ok` grants. `$HX` `ok` revokes and does not grant. `$H` `ok` with an ALARM, a banner or `<Alarm…>` in `drained`/`responses` does not grant. `["ok","error:9"]` does not grant |
| T11 | `connection.test.ts` | Revocation during a pending `$H`, followed by a delayed clean `ok`: for a status-event ALARM, a status-event banner, an Alarm snapshot, `softReset` and `emergencyStop`, the flag stays false. The generation blocks it, as proven by M18 |
| T12 (R6) | `connection.test.ts` | Freshness. After a motion settle, an accepted literal-Idle report with a `null` position, a non-finite X, or `positionKind` WPos does not release, and the arrows stay refused with `JOG_REASON_MOTION`. A later valid MPos Idle at X = 200 releases, and +10 sends `X5.000` |
| T13 | `connection.test.ts` | Literal Idle. A `check` or `sleep` snapshot with a valid position never releases; `idle` does |
| T14 | `connection.test.ts` | Reconnect. A `$H` pending, then disconnect, connect, and the old `$H` resolves `ok`: not homed (both `leaseGen` and the connect-time revoke block it). The new connection's lease is not decremented by the old settle: a new `$H` pending plus the old settle leaves `motionOutstanding` 1. The alarm-banner route: `send("$H")` → `ok` grants, and `home()` grants the same way |
| T15 | `machineJobLoop.test.tsx` | The panel's reason titles for HOME, NO_HOMING and MOTION, and enabled when ready. After 5 s of MOTION the note shows the reconnect advice (fake timers). The note clears when the reason changes |

**Mutation battery `kerf-safety-s3c`.** The `test_command` is `["npx","vitest","run","--cache=false","src/lib/machine/__tests__/jogBounds.test.ts","src/lib/machine/__tests__/connection.test.ts","src/components/panels/__tests__/machineJobLoop.test.tsx"]`.
- The baseline confirms all three files ran, with the count stated.
- Ted writes every `find` from the committed code before the run and records it with `grep -cF` = 1 on HEAD.
- Every replacement type-checks. Kills come from an observable wrong send, a wrong coordinate or a wrong flag.

| Id | Mutates | Killed by |
|---|---|---|
| M1 | `if (!s.machineHomed) return JOG_REASON_HOME;` becomes `if (false)` | T1, T3 |
| M2 | `if (!s.grblHoming) return JOG_REASON_NO_HOMING;` becomes `if (false)` | T1, T3 |
| M3 | `if (s.motionInFlight) return JOG_REASON_MOTION;` becomes `if (false)` | T1, T15 |
| M4 | The send motion condition: `isMotionCommand(command)` becomes `command.startsWith("$H")` | T5 |
| M5 | Release: `motionOutstanding === 0` becomes `true` | T6 |
| M6 | Release: `tickAtInvoke === motionTick` becomes `true` | T4 |
| M7 | Settle: insert a release on a non-`ok` settle | T6, T7 |
| M8 | `grantPositionTrust`: `gen === trustGen` becomes `true` | T10, T11 |
| M9 | Grant: exact `=== "$H"` becomes `.startsWith("$H")` | T10 |
| M10 | Grant/settle: `g === leaseGen` becomes `true` | T14 |
| M11 | Release: `lastReportHadValidMachinePosition()` becomes `true` | T4, T12 (`X10.000` vs `X5.000`) |
| M12 | `surfaceUnsolicited` revoke removed | T8(b), T9 |
| M13 | Status-event revoke removed | T8(c), T9, T11 |
| M14 | Response-loop ALARM revoke removed | T8(h) |
| M15 | `$H` submission revoke removed | T8(g) |
| M16 | `isResetBanner` returns `false` | T2, T9 |
| M17 | Release: `=== "idle"` becomes `machineStateToStore(outcome.snapshot!.state) === "idle"` | T13 |
| M18 | `revokePositionTrust`: `trustGen++` removed | T11 |
| M19 | `softReset()` revoke removed | T8(e) |
| M20 | `emergencyStop()` revoke removed | T8(f) |
| M21 | Snapshot-alarm revoke removed | T8(d) |
| M22 | The `<…>` branch's `isAlarmStatusLine` revoke removed | T8(i) |
| M23 | Freshness: `snap.positionKind === "MPos"` becomes `true` | T12 (WPos case) |
| C1 | Control: the axis-word regex matches everything (`/./`) | T2 false cases red |

## Verification

- `npx vitest run --cache=false` over the full suite: the baseline plus the new tests, with nothing skipped.
- `tsc`, `format:check`, and `lint` with no new warnings in the touched files.
- The battery journal shows every id killed, and 0 survived, 0 errored, 0 CONTROL_RED.
- `grep -rn "setMachineHomed(" src`: only the trust owner and the test resets.
- **Browser** (dev server, `invoke` mocked as in S3's behavioural evaluation): the T15 states and the 5 s note, with screenshots. This is UI evidence only.
- **Owner hardware card: frame qualification** (ROADMAP `next`). Nothing on this card is irreversible for the software, but a mistake can hit the frame, so each step bounds its own motion.
  - **Before you start:**
    - Laser power isolated (key off or laser PSU off).
    - The controller's power switch within reach.
    - Hands clear.
    - A ruler at hand.
    - Jog step set to **1 mm** unless a step says otherwise. The arrows move at a fixed 1000 mm/min; a 1 mm step lasts well under a second.
    - Do not use Position Laser on this card: it moves at 3000 mm/min.
    - Every console move runs in `G21 G90` with no work offset (`G92.1`, then check that the panel shows no offset), at `F300` or slower.
  1. Connect. Before homing, the arrows are disabled with "Home the machine ($H)…".
  2. Press Home.
     - While it homes, press an arrow. It is refused, and nothing moves after homing ends.
     - Record whether both X and Y moved during homing, which physical corner the head stopped at, and the MPos shown after pull-off.
  3. **Direction, 1 mm at a time.**
     - Measure with the ruler that at least 5 mm of physical travel remains on the side Kerf's envelope calls "into the bed". That side is away from the home corner, if the home corner is Kerf's (0, 0) corner.
     - Press X+ once (1 mm). Record whether the head moved 1 mm away from the home corner.
     - Repeat for Y (Y+ on origin-bottom, Y− on origin-top).
     - **If either axis moved outward or not at all, stop the card here: the frame fails.**
  4. **Extent, bounded.**
     - Set the step to 10 mm. Before each press toward the far X side, measure the remaining physical travel and press only if it is at least 15 mm.
     - Continue until Kerf refuses with "Already at the edge of the bed", then switch to 1 mm and press once more (it must refuse).
     - Record the remaining physical travel at Kerf's edge. It must be at least 0 mm, meaning Kerf's edge lies inside the physical frame.
     - Repeat for Y.
     - **If you reach 15 mm remaining before Kerf refuses, stop: the frame fails** (Kerf's bed is larger than the machine).
  5. **Console-motion hold.** From the far side, send `G1 X` followed by a value 20 mm back toward home, with `F300`. Immediately press an arrow. It is refused until the head stops and reports its position.
  6. **Safe alarm stimulus.**
     - Send `G1 X` followed by a value 30 mm toward home, with `F200`, and press STOP mid-move. Record what the controller reports (stock GRBL gives `ALARM:3`; the vendor fork is unqualified).
     - Unlock with `$X` and do not home. The arrows stay disabled with the Home reason until you Home.
  - **Outcomes (three distinct ROADMAP labels):**
    - **PASSED:** steps 1-6 as described, and both axes homed in step 2. W1/W2 are recorded as closed.
    - **FAILED (frame):** step 3 or 4 failed. The containment is an operating restriction, not an interlock, and it is stated as such in the ROADMAP and in the next release notes: **on that machine, do not use the jog arrows or Position Laser. Move only from the console, in small steps, until a frame-model plan ships.** That plan is Parking Lot line 6. Only Lee clears the label, and only on a PASSED rerun of steps 2-4.
    - **FAILED (lease or trust):** step 1, 2, 5 or 6 failed. It is a software defect. It goes back to a fix relay, under the same operating restriction.
    - **Until the card runs:** "software-closed within a connection, hardware-unqualified".

## Out of scope (Stage 3.5 writes each as an index line under `## Parking Lot`, with detail in `### Deferred from kerf-safety-s3c (2026-09-27)`)

1. **S3d, connection lifetime.** A native connection token at the non-job write boundary (`serial_send_inner`), plus a TS fence for late replies, late poll rejections, the settings-write `finally`, and `getStatusReport()` events across a reconnect. Evidence: critic round 3, findings B and E.
2. **Operator origin attestation for `$22=0` machines.** It needs a motion-free current-session window, an unambiguous physical corner and direction, the hazard shown before confirming, and hardware qualification. Until then, `$22=0` refuses.
3. **Jobs, FRAME and the material test do not require homing** (`canStartJob`). This is S4c territory.
4. **Alarm codes are not distinguished.** Every alarm revokes, including soft-limit alarm 2.
5. **A console `$22` change** reaches the gate only at the next full settings parse.
6. **The frame model.** If the owner card's step 3 or 4 fails, a per-machine frame model or `$23`-aware envelope is needed. Console motion stays unclipped by policy; S3c counts it but does not bound it.

## Risks and rollback

- **Homing is required on every connection** of a `$22=1` machine. That is the ruling.
- **`$22=0` machines lose the jog buttons.** This is flagged for Lee.
- **A jog after any motion waits for one valid Idle poll** (about 250 ms). A controller that reports no MPos (`$10` set to WPos-only) will never release. This is disclosed. The note in §5 appears after 5 s, and the owner's controller reports MPos (capture 2026-09-14).
- **Rollback:** revert the merge on the session branch. Nothing is persisted. The revert restores S3 with W1 and W2 open. The operating restriction until corrected code returns is: **do not use the jog buttons or Position Laser; Home first; move from the console only after the previous move has visibly stopped.** It goes on the owner card and into the ROADMAP `next` if a revert happens.
- **Irreversible steps:** none in software. The hardware card's physical risk is bounded step by step, as above.

## Decisions

- **Resolved (kerf-9, Lee 2026-09-26):** jogs refuse until homed.
- **Applied under the critic's inversion, reversible, flagged at close:** `$22=0` fails closed.
- **Orchestrator scope call (delegated technical):** connection-lifetime fencing is split out to S3d, because it is a pre-existing, all-command class whose fix is native.

## Critic fold, rounds 1-2

This is carried from revision 3.
- Round 1: raw `$J=` took the lease; all alarm paths revoked; attestation was removed; an outstanding count with no release on a non-`ok` reply; exact `$H` only; the `trustGen` check; the P1 items.
- Round 2: reset banners revoked; the frame card; T8 made reachable; literal Idle; one trust owner; the X4 and X6 copy.
- Round 2's cross-connection fence is **superseded by the split**. Revision 3's "whole result discarded" claim is withdrawn rather than half-implemented.

## Critic fold, round 3 (astra, FAIL)

- **A (P0): an accepted Idle is not a fresh position.** Verified: `consumeStatusOutcome` accepts a report whose position fails validation and keeps the old coordinates (`machineStatus.ts:186-197`). Release now needs `lastReportHadValidMachinePosition()` (MPos, all finite) from the releasing report. (R6, T12, M11, M23.)
- **B (P0): alarm status in a command reply, and the incomplete fence.** The in-pump `<Alarm…>` report now revokes (T8(i), M22). The fence half (settings `finally`, the poll catch, `getStatusReport`) moves to S3d, along with E. S3c no longer claims it.
- **C (P1): the non-discriminating oracle.** All admitted-jog assertions are now edge-sensitive (`X5.000` versus `X10.000`).
- **D (P0): an unbounded card and no containment.** The card now uses 1 mm first moves after a measured clearance, and 10 mm extent steps only with 15 mm of measured remaining travel. The actual arrow feed is stated. Position Laser is excluded. There are three distinct outcome labels, and an operating-restriction containment is stated honestly as not an interlock. Only Lee clears the label, on a rerun.
- **E (P1): native submission lifetime.** Verified: disconnect and connect take the same command mutex that a queued send waits on, and non-job writes carry no epoch. This goes to S3d.
- **Dimension 10:** invariant 1 now states the connect-time exception.
- **X4:** the advice is now "reconnect and Home again", not STOP, with the reason given.
- **Dimension 4:** the dependency graph includes the Stage 3.5 documentation work and the six Parking Lot index lines.
