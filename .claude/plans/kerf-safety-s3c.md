# Kerf safety S3c: motion trust within a connection. A jog needs a clean `$H` and one authoritative, fresh, millimetre MPos taken after every motion command has settled

- **Relay id:** `kerf-safety-s3c`
- **Branch:** `relay/kerf-safety-s3c`
- **Tier:** Standard. 9 files under one root (`src/`):
  - 6 production: `jogBounds.ts`, `connection.ts`, `machineStatus.ts`, `store/storeTypes.ts`, `store/index.ts` (two scalars), `MachinePanel.tsx`.
  - 3 tests: `jogBounds.test.ts`, `connection.test.ts`, `machineJobLoop.test.tsx`.
- **UI:** reason titles and one note line. There is no new control. Jen reviews at Stage 3. It is a web app: the panel renders in the Vite dev server with `invoke` mocked, so the behavioural evaluator applies.
- **Base:** `marvin/kerf-gap` at `d2dfd24` or later. S3 (377a63f) and E1b (d2dfd24, Rust only) are merged. Citations were read at `aa06a3f`; E1b changed no `src/` file.
- **Revision 5.** It folds astra critic rounds 1-4 (all FAIL; files `-critic-r1.md` … `-critic-r4.md`). The orchestrator caps this plan at this revision. If round 5 does not pass, the remaining findings go to Lee as a decision, not a sixth rewrite.

## Dependency graph

| Step | Work | Depends on | Independent of |
|---|---|---|---|
| b1 (Ted) | the 9 files | S3 (merged) | S3d, S3e (separate plans; see Split) |
| 3.5 (orchestrator) | ROADMAP Parking Lot section `### Deferred from kerf-safety-s3c (2026-09-27)` with 7 index lines; owner card in `next`; ARCHITECTURE.md delta for the lease, the trust owner and the position contract | b1 merged | none |

**Batch waiver (9 files, one root, over the 8-file cap).** The lease, the trust owner, the position contract and the gate form one contract. `machineStatus.ts` holds the trust owner and the poll half of the position contract. `connection.ts` holds the command half.

## Split: what S3c does not claim

Two pre-existing defect classes are larger than motion trust. Each gets its own plan and its own critic.

- **S3d, connection lifetime.** A send queued on the native command mutex can take it after a disconnect and reconnect, and write its bytes to the new controller. `serial_send_inner` locks `inner.command` (`serial.rs:486-490`) and writes non-job commands with no epoch. Disconnect and connect take the same lock. On the TS side there are four more paths: late replies, late poll rejections (`connection.ts:736-749`), the settings-write `finally` (`:617-619`), and `getStatusReport()` events. The fix is a connection token checked at the native write boundary.
  - **S3c's recovery advice does not depend on S3d.** It tells the operator to *restart Kerf*, not to reconnect. That ends the process, so no queued native write survives. See §5.
- **S3e, frame qualification.** A clean `$H` establishes that homing finished. It does not establish that the physical home corner, the axis directions and the bed extents match the envelope Kerf clips against. Enforcing a per-machine "frame qualified" state, so that jogs refuse until the owner card passes for that machine configuration, is S3e.
  - The owner card in this plan produces the evidence S3e needs.
  - **S3c does not claim closure of W1 on the physical frame. It claims only what it enforces:** no jog without a clean home in this connection, a settled lease, and a fresh millimetre MPos.

**What S3c claims, within one connection:**
- no jog from an unhomed or de-homed machine;
- no jog while any non-job motion command is unsettled;
- no jog from a position that did not come from a fresh, valid, millimetre MPos report after the last motion settled, with nothing written over it since.

Across a reconnect, trust is revoked and the lease is reset. The next connection must earn trust with its own `$H`.

## Intent (grilled)

There was no separate grill. The intent comes from rulings on file:
- **Lee, 2026-09-26 (kerf-9), relayed by session-d32473:** "always press home". Refusing jogs until homed "matches how he works."
- **Coordinator, 2026-09-26, option (a):** a motion-in-flight hold covering Home and console motion, cleared by the first Idle report after acknowledgement (Razor W2 on S3), plus a `$H` since connect when `$22=1` (Razor W1).
- **Owner controller settings:** `$20=0 $21=1 $22=1 $23=1` (capture 2026-09-14, lines 25-28).
- **`$22=0`:** fail closed. Attestation is parked. This is flagged for Lee at close.

**Summary.** Within one connection, a jog (arrows, jog-to, Position Laser) is refused unless all of the following hold.
- **Trust.** A plain `$H` completed with a clean `ok` in this connection, and since then none of these has happened: an alarm (line, event, snapshot, or in-pump `<Alarm…>`), a controller reset (Kerf-sent or banner), STOP, a re-home start, or a reconnect.
- **Settled.** Every non-job motion command (button jog, `$H`, console move, raw `$J=` included) has settled, and a status poll begun after the last settle returned literal Idle.
- **Position.** The store's position came from an accepted report carrying a finite MPos, and no later report or reply has invalidated it. Any accepted report without a valid MPos, and any in-pump reply sample that is not a valid MPos, makes the position unknown.
- **Units.** The controller's `$13` was read back as `0` (positions reported in mm) in this connection, and no settings write has happened since.

## Diagnosis (read at `aa06a3f`)

1. **The envelope trusts MPos, and nothing requires that trust to be earned** (Razor W1 on S3). `clipJog` clips `store.machinePosition` against `[0, bed]`, or `[-bed, 0]` for Y on origin-top machines (`jogBounds.ts:42-47`, `:61-73`). `jogBlockReason` (`:50-59`) never reads `machineHomed`.
2. **"Homed" is recorded on two of the four `$H` routes.** `home()` (`connection.ts:809-816`) records it, and is used at `MachinePanel.tsx:1016` and `:1087`. The alarm banner's Home button (`MachinePanel.tsx:477`) and a console `$H` (`Console.tsx:36`) do not.
3. **Only `queryGrblSettings` revokes it** (`connection.ts:1014-1019`).
   - ALARM arrives by five paths: snapshot state (`machineStatus.ts:183-184`); status events (`:131-144`, logged only); drained lines (`surfaceUnsolicited`, `connection.ts:51-68`, logged only); command responses (`send()`, `:623-642`, logged only); and an in-pump `<Alarm|…>` report, which is taken as a status sample (`:625-630`) and never inspected for state.
   - A reset banner arrives on the line paths (the native `PumpTerminal::Banner` lines are returned in `responses`).
   - `softReset()` (`:843-852`) and `emergencyStop()` (`:874` onward) revoke nothing.
4. **A jog right after Home or console motion is admitted** (Razor W2, N8). `jogPending` (`:274-289`) is set only by `sendJogLine`. One boolean cannot represent two outstanding commands, and it clears on a reply without `ok` (`:288`).
5. **An accepted report is not a fresh position.** `consumeStatusOutcome` writes state and advances `lastValidStatusTime` before it validates position. A null or non-finite position keeps the old `machinePosition` and `positionKind` (`machineStatus.ts:175-197`). `machineStateToStore` maps `check` and `sleep` to `idle` (`:88-89`).
6. **A second position writer bypasses the consumer.** `send()` parses any `[MW]Pos` from an in-pump report in its replies and writes `machinePosition` without updating `positionKind` or age (`connection.ts:643-653`). So one reply to a non-motion command carrying `<Idle|WPos:10,0,0>` replaces an MPos X=200 with a WPos 10 that is still labelled machine.
7. **Units are unknown.** The native parser constructs the snapshot's `units` as `UnitsValidity::Unknown` (`grbl_status.rs`, snapshot construction). The consumer writes coordinates unchanged. The settings parser (`connection.ts:300-341`) never reads `$13`, which is GRBL's report-in-inches setting. Clipping, the bed and the `$J=G21` distances are all in mm.
8. **Serialisation.** `serial_send` blocks on the command mutex (`serial.rs:486-490`). Polls `try_lock` and answer busy (`connection.ts:709-712`). Submission and lock acquisition are not atomic, so the lease never infers order from them.
9. **Existing tools.**
   - `markStatusUnknown()` (`connection.ts:267-272`) sets `statusStale` and `positionKind: null`, and the gate already refuses with `JOG_REASON_STALE`.
   - Tests: `connection.test.ts` has `describe("S3 — jog frame")` with the `jogReady(patch)` fixture (`:1051-1066`); `jogBounds.test.ts`; `machineJobLoop.test.tsx`.

## Design

### The lifecycle contract

This table goes verbatim into a comment above the lease in `connection.ts`. The trust and position half goes above the owner in `machineStatus.ts`.

**Trust owner, in `machineStatus.ts`** (`connection.ts` already imports from it):
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
export function isAlarmStatusLine(line: string): boolean {
  return /^<\s*Alarm\b/i.test(line.trim());
}
```

- Every production write of `machineHomed` goes through these.
- The existing clear in `queryGrblSettings` becomes `revokePositionTrust()`.
- The Ted report quotes `grep -rn "setMachineHomed(" src`: only these two functions, plus the test resets.

**Position contract (the one rule for the coordinate the gate clips against).**
- **Poll path** (`consumeStatusOutcome`). An accepted report whose position is finite and `MPos` writes position and `positionKind: "machine"` as today, and records `lastReportPositionValid = true`. An accepted report with a null or non-finite position, or with `WPos`, writes **no** coordinate. It records `lastReportPositionValid = false` and sets `positionKind: null` (`markStatusUnknown`'s effect, reimplemented as one line in the consumer, since that helper is private to `connection.ts`).
  - The WPos case is an S3 regression risk: S3 accepted `positionKind: "work"` for relative jogs without an offset (`jogBounds.ts:57-58`). S3c narrows admission to MPos, which is what the owner's controller reports (capture 2026-09-14: every report carries `MPos`). This is disclosed in Risks.
  - Export `lastReportHadValidMachinePosition(): boolean`.
- **Command path** (`send()`'s in-pump report, `connection.ts:643-653`). An in-pump sample is written only if it is `MPos` with all three components finite. It then writes `positionKind: "machine"` too. Anything else in that slot (`WPos`, non-finite, unparseable) writes no coordinate and calls `markStatusUnknown()`, so the gate refuses until the next valid poll.
- There is no third writer. Ted's report quotes `grep -rn "setMachinePosition(" src`: only the two paths above, plus the test fixtures.

**Units contract.**
- The settings parser reads `$13`: `store.setGrblReportMm(value === 0)`.
- `invalidateGrblSettingsSilently()` (which runs on every settings write, `:604-619`) and connect both set it to `false`.
- The gate refuses while it is false. A controller whose `$13` could not be read is refused. That is fail-closed, and it is disclosed.

**The lease, in `connection.ts`:**
- `motionOutstanding: number`
- `motionHeld: boolean`
- `motionTick: number` (bumps at every motion submit and settle)
- `leaseGen: number` (bumps on connect and disconnect; it fences the lease and the grant only)

| Event | Lease | Trust / position |
|---|---|---|
| Non-job `send` of a motion command (`isMotionCommand`), before `invoke`: capture `g = leaseGen` | `motionOutstanding++`, `motionHeld = true`, `motionTick++`, store `motionInFlight = true` | For a homing command (`/^\$H/i`): `revokePositionTrust()`, then capture `hgen = positionTrustGen()` |
| That send settles (resolve or throw) with `g === leaseGen` | `motionOutstanding--` (floor 0), `motionTick++`. Never released here | Plain `$H` only: see Grant |
| That send settles with `g !== leaseGen` | No lease change | No grant |
| Any line in a command's `responses` or `drained` that is `ALARM…`, a reset banner, or `<Alarm…>` | none | `revokePositionTrust()` |
| An in-pump `<…>` sample in any command's reply | none | Position contract, command path |
| A poll begins: capture `tickAtInvoke = motionTick` | none | none |
| `consumeStatusOutcome`: an event with ALARM or a banner, or a snapshot whose state is alarm | none | `revokePositionTrust()` |
| `consumeStatusOutcome`: an accepted report | none | Position contract, poll path |
| A poll completes with: `accepted`; a real report; `snapshot.state === "idle"` (literal); `lastReportHadValidMachinePosition()`; `motionOutstanding === 0`; `tickAtInvoke === motionTick` | `motionHeld = false`, store `motionInFlight = false` | none |
| Any other poll | none | (the position contract still applies to it) |
| `softReset()` or `emergencyStop()` is invoked (any outcome) | none | `revokePositionTrust()` first |
| Connect or disconnect | `leaseGen++`, `motionOutstanding = 0`, `motionHeld = false`, `motionTick++`, store `motionInFlight = false` | `revokePositionTrust()`; `grblReportMm = false` |

**Grant.** `grantPositionTrust(hgen)` runs only when all of the following hold:
- `g === leaseGen`;
- the command, trimmed and upper-cased, is exactly `$H`;
- `responses` includes `ok`;
- no line in `responses` or `drained` is `ALARM…`, `error:…`, a reset banner, or `<Alarm…>`.

`$HX`, `$HY` and other `$H…` variants revoke and never grant.

**Invariants** (in the comments):
1. Within a connection, `motionHeld` is false only when no motion send is unsettled and a literal-Idle report with a valid MPos, taken after the last settle, has arrived. At connect the lease starts released, but trust starts revoked and `grblReportMm` false, so nothing is admitted before a `$H` settles, a valid Idle arrives, and `$13=0` has been read.
2. `machineHomed` is true only if a plain `$H` completed cleanly in this connection, with no revocation since its submission.
3. Every revocation advances `trustGen`.
4. The gate's `positionKind === "machine"` means the stored coordinate came from a valid MPos (poll or in-pump) and nothing has invalidated it since.
5. Not claimed: anything across a connection boundary (S3d), and the physical frame (S3e).

### 1. `jogBounds.ts` (pure)

- `JogGateState` gains `grblHoming`, `machineHomed`, `motionInFlight` and `grblReportMm`, all store scalars.
- New texts:
  ```ts
  export const JOG_REASON_HOME =
    "Home the machine ($H) before jogging. Kerf only knows where the bed edge is after homing";
  export const JOG_REASON_NO_HOMING =
    "Jogging is off: this machine doesn't home ($22=0), so Kerf can't tell where the bed edge is";
  export const JOG_REASON_MOTION =
    "Waiting for the machine to finish the last command and report its position";
  export const JOG_REASON_UNITS =
    "Jogging is off until Kerf reads $13=0 (positions in mm) from the machine. Reconnect, or send $$";
  ```
- Order: not connected, alarm, job, motion, bed, units, trust, stale, busy, offset.
  - `if (s.motionInFlight) return JOG_REASON_MOTION;`
  - `if (!s.grblReportMm) return JOG_REASON_UNITS;`
  - `if (!s.grblHoming) return JOG_REASON_NO_HOMING;`
  - `if (!s.machineHomed) return JOG_REASON_HOME;`
- The existing stale check (`statusStale || positionKind === null`) now also refuses a WPos-only position for `"by"` jogs: `if (s.positionKind !== "machine") return JOG_REASON_STALE;` replaces the null test. The offset rule after it is unchanged.
- `JOG_REASON_PENDING` stays, for `sendJogLine`.
- `export function isMotionCommand(command: string): boolean`.
  - True for `$J=…` and any `$H…`.
  - False for any other `$` line, and for `?`, `!` and `~`.
  - For G-code, strip `(…)` and `;…` comments first. Then it is true for an axis word (`/[XYZABC]\s*[-+]?[.\d]/i`) or for `G28`, `G30` or `G38.x` (`/G\s*0*(28|30|38)(\.\d)?(?!\d)/i`).

### 2. `connection.ts`

- Replace `jogPending`/`jogTick` with the lease, and add the comment table.
- `send()`:
  1. Take the lease and the `$H` revoke.
  2. Wrap the `invoke` in `try/finally`.
  3. Revoke on ALARM, banner or `<Alarm…>` in `drained` (via `surfaceUnsolicited`) and in `responses`. The `<…>` branch checks `isAlarmStatusLine` before its `continue`.
  4. The in-pump position write follows the position contract.
  5. Run the grant check.

  The settings-write lines are otherwise unchanged. `invalidateGrblSettingsSilently()` gains `setGrblReportMm(false)`.
- The settings parser (`:300-341`) gains `$13`.
- `surfaceUnsolicited`: revoke on ALARM and on a banner.
- `sendJogLine`: if `motionHeld`, log `JOG_REASON_PENDING` and return. Otherwise `send(line)`.
- `jog()` and `jogTo()` pass `{ ...store, motionInFlight: motionHeld }` to the gate.
- `home()` becomes `await this.send("$H")`.
- `softReset()` and `emergencyStop()` call `revokePositionTrust()` first.
- Poll: capture `tickAtInvoke`. The release reads literal `"idle"`, `lastReportHadValidMachinePosition()` and the lease conditions.
- Connect and disconnect follow the table row.
- The test resets: `_testResetJogAndBedState` resets the lease, and `machineStatus.ts` gains `_testResetPositionTrust()`.

### 3. `machineStatus.ts`

- The trust owner, `isResetBanner`, `isAlarmStatusLine`, and the poll half of the position contract.
- The event loop (`:131-144`) revokes on ALARM and on a banner. After the snapshot state write (`:183-184`), an `"alarm"` state revokes.
- No callback. No optional path.

### 4. The store (two scalars)

- `storeTypes.ts` gains `motionInFlight: boolean` / `setMotionInFlight`, and `grblReportMm: boolean` ("`$13=0` read back in this connection, with no settings write since") / `setGrblReportMm`.
- `store/index.ts`: both fields, with defaults `false` and `false`.
- `setMachineState` is unchanged.

### 5. `MachinePanel.tsx`

- Both `jogBlockReason` calls (`:128-137`, `:142-151`) add `grblHoming`, `machineHomed`, `motionInFlight` and `grblReportMm`, each from its own scalar `useStore` selector (CLAUDE.md, React error 185).
- **Hold note.** When the arrows have been disabled for `JOG_REASON_MOTION` for more than 5 s, the existing jog note slot shows one of three texts, chosen by the cause the connection exports (`motionHoldCause(): "command" | "position" | "idle"`):
  - `command` (a motion invoke is still unsettled): `Still waiting on the machine. If nothing is moving, press STOP, then quit and reopen Kerf and Home again. Quitting cancels anything Kerf had queued.`
  - `position` (Idle came but without a valid MPos): `The machine isn't reporting its machine position (MPos). Kerf can't jog until it does. Check $10 in the machine settings.`
  - `idle` (the reports are not literal Idle, e.g. Check or Sleep): `The machine isn't reporting Idle. Kerf jogs only from Idle.`
- The quit advice is the one recovery that crosses no unfenced path (Split, S3d).
- The timer is a `useEffect` keyed on the reason plus the cause, and is cleared on unmount.
- There is no new control.

## Tests

**Reproduce first.** Before any production edit, add R1-R8 to `connection.test.ts`, run them red, and quote the failures.
- **R1 (W1):** `jogReady({ machineHomed: false, grblHoming: true })`, then `jog("X", 10)` sends.
- **R2 (W2):** homed. Hold `send("$H")` pending, then jog: it sends.
- **R3:** homed. Hold a console `send("$J=G21 G91 X20 F300")` pending, then jog: it sends.
- **R4:** homed. `$H` returns `["ALARM:9"]`, then `$X` returns `ok`, then an Idle poll arrives, then jog: it sends.
- **R5:** homed. A `drained` line carries `Grbl 1.1f ['$' for help]`, then Idle, then jog: it sends.
- **R6 (A, poll path):** homed, bed 205, MPos X=200, released. An accepted Idle arrives with position `null`, then `jog("X", 10)`: today the retained X=200 is used. After the fix it must be refused. Then an Idle with WPos arrives: today admitted by S3's work rule. After the fix it must be refused.
- **R7 (A, command path):** homed, bed 205, MPos X=200, released. `send("$G")` returns `["<Idle|WPos:10.000,0.000,0.000|FS:0,0>", "[GC:…]", "ok"]`, then `jog("X", 10)`. Today it sends `X10.000`, because the WPos sample overwrote X as a machine coordinate.
- **R8 (C):** homed, released, and the settings readback included `$13=1`. Today `jog` sends.

**Fixture.** `jogReady` gains `grblHoming: true`, `machineHomed: true`, `motionInFlight: false`, `grblReportMm: true` and `positionKind: "machine"`. The trust owner is reset in `beforeEach`.
- S3 assertions are unchanged, with two exceptions, and each edit is listed in the Ted report.
  - S3 tests where a jog returned without `ok` and a second jog was then allowed at once now need one valid Idle first.
  - S3 tests that admitted a relative jog on `positionKind: "work"` now assert `JOG_REASON_STALE`. That is the narrowing disclosed in Risks.

**Oracle rule.** Every "admitted" assertion checks the literal `$J=` string in an edge-sensitive setup. Example: bed 205, correct X=200, stale X=10, request +10. The correct send is `X5.000`; the stale one would be `X10.000`.

| Test | File | Asserts |
|---|---|---|
| T1 | `jogBounds.test.ts` | Precedence: MOTION, then BED, then UNITS, then NO_HOMING, then HOME, then STALE. `positionKind: "work"` gives STALE for `"by"` |
| T2 | `jogBounds.test.ts` | `isMotionCommand` true: `$H`, `$h`, `$HX`, `$J=G91 X1`, `G0 X10`, `g1y5 f100`, `X5`, `x-.5`, `G28`, `G30`, `G38.2 Z-5`, `G1 X1 (c)`. False: `$$`, `$#`, `$G`, `$I`, `$X`, `$C`, `$RST=$`, `$32=1`, `$22=0`, `?`, `!`, `~`, `M3 S0`, `M5`, `G4 P0.5`, `G21`, `G90`, `G92.1`, `G1 F100`, `; X10`, `(X10) M5`, `G280`. `isResetBanner` and `isAlarmStatusLine` true/false sets as in revision 4 |
| T3 (R1) | `connection.test.ts` | Unhomed `$22=1`: zero sends from `jog`/`jogTo`, `JOG_REASON_HOME`. `$22=0`: `JOG_REASON_NO_HOMING` |
| T4 (R2) | `connection.test.ts` | `$H` pending: no `$J=`, and `JOG_REASON_MOTION`. After `ok`, none of these release: a busy poll; a poll begun before the ack that returns Idle; an Idle with no position. A later valid Idle at X=200 releases, and +10 sends `X5.000` |
| T5 (R3) | `connection.test.ts` | A pending raw `$J=` or `G1 X20 F300` holds. `$$` and `M5` never do. A job-epoch send never takes the lease |
| T6 | `connection.test.ts` | Overlap: A pending and B settled `error:15` still holds. A while outstanding still holds. After A settles plus a valid Idle, it releases |
| T7 | `connection.test.ts` | A thrown invoke holds until a later valid Idle |
| T8 (R4) | `connection.test.ts` | Starting homed, each route in real transitions: first the immediate refusal; then recovery (`$X` → `ok` and/or settle, then a valid Idle); then `JOG_REASON_HOME`; then a clean `$H` and valid Idle; then `X5.000`. The routes are (a) `$H` → `ALARM:9`; (b) drained `ALARM:1`; (c) event `ALARM:3`; (d) Alarm snapshot; (e) `softReset()`; (f) `emergencyStop()`; (g) a new `$H` while homed; (h) console `G1 X10 F300` → `ALARM:2`; (i) console `G1 X10 F300` whose responses hold `<Alarm:1\|MPos:…>` and `ok` |
| T9 (R5) | `connection.test.ts` | A reset banner on the response, drained and event paths revokes. Recovery as in T8 |
| T10 | `connection.test.ts` | Grant. A plain `$H` `ok` grants. `$HX` `ok` revokes and does not grant. `$H` `ok` with an ALARM, a banner or `<Alarm…>` in `drained`/`responses` does not grant. `["ok","error:9"]` does not grant |
| T11 | `connection.test.ts` | Revocation during a pending `$H`, then a delayed clean `ok`: for an event ALARM, an event banner, an Alarm snapshot, `softReset` and `emergencyStop`, the flag stays false |
| T12 (R6) | `connection.test.ts` | Poll path. **After release**, an accepted Idle with `null`, non-finite, or WPos position makes `positionKind` null and refuses with `JOG_REASON_STALE`, with zero sends. A later valid MPos Idle at X=200 recovers, and +10 sends `X5.000`. The same setup **during** a hold does not release |
| T13 (R7) | `connection.test.ts` | Command path. After release (X=200), a non-motion `$G` whose reply carries `<Idle\|WPos:10…>` writes no coordinate, sets `positionKind` null, and gives zero sends plus STALE. A reply carrying `<Idle\|MPos:150…>` writes 150 with kind machine, and +10 then sends `X10.000` (edge 205, from 150). A reply carrying `<Idle\|MPos:NaN…>` behaves like the WPos case |
| T14 (R8) | `connection.test.ts` | Units. A readback with `$13=1`, or without `$13`, refuses with `JOG_REASON_UNITS`. `$13=0` admits. After admission, a console `$13=1` write (a settings write) refuses again until a `$$` reads `$13=0`. Connect resets it |
| T15 | `connection.test.ts` | Literal Idle: `check`/`sleep` with a valid position never release |
| T16 | `connection.test.ts` | Reconnect. A `$H` pending, then disconnect and connect, then the old `$H` resolves `ok`: not homed. The new connection's lease is not decremented by the old settle. The alarm-banner route `send("$H")` → `ok` grants, and `home()` grants the same way |
| T17 | `machineJobLoop.test.tsx` | The panel's titles for HOME, NO_HOMING, UNITS and MOTION, and enabled when ready. After 5 s (fake timers), the note shows the text matching `motionHoldCause()` for each of the three causes, and clears on a reason change |

**Mutation battery `kerf-safety-s3c`.** `test_command`: `["npx","vitest","run","--cache=false","src/lib/machine/__tests__/jogBounds.test.ts","src/lib/machine/__tests__/connection.test.ts","src/components/panels/__tests__/machineJobLoop.test.tsx"]`.
- The baseline must confirm that all three files ran, with the count.
- Ted writes each `find` from committed code and records it with `grep -cF` = 1 on HEAD.
- Every replacement must type-check.
- Every kill must come from an observable wrong send, coordinate or flag.

| Id | Mutates | Killed by |
|---|---|---|
| M1 | `if (!s.machineHomed) return JOG_REASON_HOME;` → `if (false)` | T1, T3 |
| M2 | `if (!s.grblHoming) return JOG_REASON_NO_HOMING;` → `if (false)` | T1, T3 |
| M3 | `if (s.motionInFlight) return JOG_REASON_MOTION;` → `if (false)` | T1, T17 |
| M4 | the send motion condition: `isMotionCommand(command)` → `command.startsWith("$H")` | T5 |
| M5 | release: `motionOutstanding === 0` → `true` | T6 |
| M6 | release: `tickAtInvoke === motionTick` → `true` | T4 |
| M7 | settle: insert a release on a non-`ok` settle | T6, T7 |
| M8 | `grantPositionTrust`: `gen === trustGen` → `true` | T10, T11 |
| M9 | grant: `=== "$H"` → `.startsWith("$H")` | T10 |
| M10 | grant/settle: `g === leaseGen` → `true` | T16 |
| M11 | release: `lastReportHadValidMachinePosition()` → `true` | T4, T12 |
| M12 | `surfaceUnsolicited` revoke removed | T8(b), T9 |
| M13 | event-loop revoke removed | T8(c), T9, T11 |
| M14 | response-loop ALARM revoke removed | T8(h) |
| M15 | `$H` submission revoke removed | T8(g) |
| M16 | `isResetBanner` returns `false` | T2, T9 |
| M17 | release: `=== "idle"` → `machineStateToStore(outcome.snapshot!.state) === "idle"` | T15 |
| M18 | `revokePositionTrust`: `trustGen++` removed | T11 |
| M19 | `softReset()` revoke removed | T8(e) |
| M20 | `emergencyStop()` revoke removed | T8(f) |
| M21 | snapshot-alarm revoke removed | T8(d) |
| M22 | the `<…>` branch's `isAlarmStatusLine` revoke removed | T8(i) |
| M23 | poll path: the `MPos` kind requirement → `true` | T12 (WPos case) |
| M24 | poll path: the invalid-report `positionKind` null write removed | T12 (after release: `X10.000`/stale admitted) |
| M25 | command path: the in-pump write accepts `[MW]Pos` again (restore today's regex) | T13 (`X10.000` instead of refusal) |
| M26 | command path: the invalid-sample `markStatusUnknown()` removed | T13 |
| M27 | `if (!s.grblReportMm) return JOG_REASON_UNITS;` → `if (false)` | T1, T14 |
| M28 | `invalidateGrblSettingsSilently`: `setGrblReportMm(false)` removed | T14 (console `$13=1`) |
| M29 | gate: `s.positionKind !== "machine"` → `s.positionKind === null` | T1 (work), T12 (WPos after release) |
| C1 | control: the axis-word regex matches everything | T2 false cases go red |

## Verification

- `npx vitest run --cache=false` over the full suite: baseline plus the new tests, nothing skipped.
- tsc, `format:check`, and lint (no new warnings in the touched files).
- The battery journal shows every id killed: 0 survived, 0 errored, 0 CONTROL_RED.
- `grep -rn "setMachineHomed(\|setMachinePosition(" src` shows only the contract's writers and the test fixtures.
- Browser (dev server, `invoke` mocked): the T17 states and the three notes, with screenshots. This is UI evidence only.
- **Owner hardware card: S3c behaviour and S3e frame evidence (ROADMAP `next`).**
  - **Preconditions.** The card runs only if both hold; otherwise it is INCONCLUSIVE and not run:
    - the panel shows `$21=1` (hard limits on), and `$13=0`.
    - The owner's capture has `$21=1`. On this machine, a move that runs outward into the home side ends on a limit switch with an ALARM, not on the frame. That is the bound that makes the direction test safe.
  - **Setup.**
    - Laser power isolated (key off, or laser PSU off).
    - Controller power switch within reach.
    - Hands clear.
    - A ruler.
    - Jog step 1 mm unless stated. The arrows move at 1000 mm/min.
    - Position Laser is not used on this card (3000 mm/min).
    - Console moves in `G21 G90`, no work offset (`G92.1`, then confirm the panel shows none), `F300` or slower.
  - **Steps.**
    1. Connect. Before Home, the arrows are disabled with "Home the machine ($H)…".
    2. Home. While homing, press an arrow: it is refused, and nothing moves afterwards. Record:
       - whether both X and Y moved during homing;
       - the physical corner where it stopped;
       - the MPos after pull-off;
       - the measured distance from the head to the switch on each axis (the pull-off).
    3. **Direction, 1 mm at a time.** Press X+ once. Record whether the head moved 1 mm away from the home corner. Repeat for Y (Y+ on origin-bottom, Y− on origin-top).
       - If the head moved toward the switch instead, it is bounded by that switch (`$21=1`: ALARM). That result is **FAILED (frame direction)**.
    4. **Extent.**
       - Step 10 mm toward the far X side. Before each press, measure the remaining physical travel, and press only if it is at least 20 mm.
       - When Kerf refuses with "Already at the edge", record the remaining physical travel **R_X**.
       - Repeat for Y (**R_Y**).
       - If the 20 mm reserve is reached before Kerf refuses, stop. That is **INCONCLUSIVE (extent)**, not a failure: the reserve cannot tell a correct bed from an oversized one.
    5. **Console-motion hold.** From the far side, send `G1 X` with a value 20 mm back toward home, `F300`, then press an arrow at once. It is refused until the head stops and reports.
    6. **Safe alarm stimulus.** Send `G1 X` with a value 30 mm toward home, `F200`, and press STOP mid-move. Record the report (stock GRBL: `ALARM:3`). Unlock with `$X` without homing. The arrows stay disabled with the Home reason until Home.
  - **Outcomes (distinct ROADMAP labels).**
    - **S3c-behaviour PASSED**: steps 1, 2, 5 and 6 pass. This closes W2, and W1 as S3c scopes it: no jog without a clean home, a settled lease and fresh MPos, on this controller.
    - **S3c-behaviour FAILED**: any of steps 1, 2, 5 or 6 fails. That is a software defect, and it goes to a fix relay.
    - **Frame PASSED**: both axes homed, both directions correct, and R_X and R_Y are each ≥ 3 mm. The 3 mm is the ruler reading tolerance (±1 mm) plus a 2 mm stopping margin. This is the evidence S3e records to mark the machine qualified.
    - **Frame FAILED**: a direction was wrong, or R < 3 mm.
    - **Frame INCONCLUSIVE**: the extent test was stopped at the reserve.
    - **Containment until S3e ships.** This is an operating restriction, not an interlock, and it is stated as such in the ROADMAP and in the release notes. For frame FAILED or INCONCLUSIVE: on that machine, do not use the jog arrows or Position Laser. S3e's enforced per-machine refusal is the interlock. Only Lee clears the label, and only on a rerun.

## Out of scope (Stage 3.5: an index line under `## Parking Lot`, detail in `### Deferred from kerf-safety-s3c (2026-09-27)`)

1. **S3d, connection lifetime**: a native connection token at the non-job write boundary, plus a TS fence for late replies, poll rejections, the settings `finally` and `getStatusReport()` events.
2. **S3e, frame qualification**: a per-machine "frame qualified" state, keyed by the S3 bed key (port plus `$3/$23/$100/$101/$130/$131`). Jogs refuse until the owner card's frame PASSED is recorded for that key, which is the enforced containment for a FAILED or INCONCLUSIVE frame. It may also read `$23` into the envelope.
3. **Operator origin attestation for `$22=0`**: a motion-free window, a physical corner and direction, the hazard shown first, and hardware qualification. Until then, it refuses.
4. **Jobs, FRAME and the material test do not require homing** (`canStartJob`, S4c).
5. **Alarm codes are not distinguished.** Every alarm revokes.
6. **A console `$22` change** reaches the gate only at the next full settings parse (`$13` does, through the write invalidation).
7. **Console motion is unclipped by policy.** S3c counts it; it does not bound it.

## Risks and rollback

- **Every connection of a `$22=1` machine needs Home before jogging.** That is the ruling.
- **`$22=0` machines lose the jog buttons.** Flagged for Lee.
- **A controller that reports only WPos (`$10` without MPos), or whose `$13` cannot be read, loses the jog buttons.** This is narrower than S3, which admitted relative jogs from WPos with no offset. It is fail-closed, and the note says why. The owner's controller reports MPos.
- **A jog after any motion waits one valid Idle poll** (about 250 ms).
- **Rollback.** Revert the merge on the session branch. Nothing is persisted. The revert restores S3 with W1 and W2 open. Until corrected code returns, the operating restriction is: do not use the jog buttons or Position Laser; Home first; move from the console only after the previous move has visibly stopped. It goes on the owner card and into the ROADMAP `next` if a revert happens.
- **Irreversible steps:** none in software. The card's motion is bounded by 1 mm first moves, measured reserves, and the hard-limit precondition.

## Decisions

- **Resolved (kerf-9):** jogs refuse until homed.
- **Applied under the critic's inversion, reversible, flagged at close:** `$22=0` fails closed.
- **Orchestrator scope calls (delegated technical):**
  - S3d (connection lifetime) and S3e (frame qualification) are split out.
  - Recovery advice routes through quitting Kerf, not reconnecting.
  - Admission narrows to mm MPos.

## Critic folds

**Rounds 1-3** (carried from revision 4):
- Round 1: raw `$J=` takes the lease; all alarm paths revoke; attestation removed; an outstanding count with no release on a non-`ok` reply; exact `$H` only; `trustGen`.
- Round 2: reset banners revoke; T8 made reachable; literal Idle; one trust owner.
- Round 3: the release needs a valid MPos; `<Alarm…>` in replies revokes; edge-sensitive oracles; a bounded card; S3d split.

**Round 4 (astra, FAIL):**
- **A (P0), a second position writer and invalid reports after release.** Verified: `send()` writes `[MW]Pos` from an in-pump sample without its kind (`connection.ts:643-653`), and the consumer keeps old coordinates on an invalid report (`machineStatus.ts:175-197`). Now there is one position contract with two writers: MPos only, and any other sample makes the position unknown. The gate requires `positionKind === "machine"`. (R6, R7, T12, T13, M23-M26, M29.)
- **B (P0), reconnect advice through an unfenced native path.** Now the advice is to quit and reopen Kerf, which ends the process, so no queued write survives. S3c no longer depends on S3d.
- **C (P0), units.** Verified: the native snapshot constructs `units` as Unknown, and the settings parser ignores `$13`. Now `$13=0` must be read back in this connection, and a settings write clears it. (R8, T14, M27, M28.)
- **D (P0), the card.**
  - The direction test is now bounded by the `$21=1` hard-limit precondition (the owner's setting); without it the card is INCONCLUSIVE and not run.
  - The extent test has a 20 mm reserve with an INCONCLUSIVE outcome, and a 3 mm pass margin with stated tolerance.
  - The outcomes are split into S3c behaviour and frame. W1 closure is scoped to what S3c enforces.
  - The enforced frame interlock is S3e, with an interim operating restriction stated as such.
- **X4/X6:** there are three cause-specific hold notes, including the WPos-only (`$10`) case.
- **Dimension 10:** the lease transitions and the report validity are one table and two owners, with the grep audits in Verification.
