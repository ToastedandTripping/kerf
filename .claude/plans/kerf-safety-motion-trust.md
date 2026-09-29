# Kerf safety: motion trust owned natively. A jog is admitted at the serial write boundary only from a clean home, a settled machine, a fresh millimetre MPos, and the current connection

- **Relay id:** `kerf-safety-motion-trust`
- **Branch:** `relay/kerf-safety-motion-trust`
- **Tier:** Architectural. It adds new native primitives: a connection identity, a position-trust epoch, a motion ledger, a units state and jog admission. Four batches:
  - B1 native line and trust state;
  - B2 native connection identity and jog admission;
  - B3 the TS consumer;
  - B4 the panel.
- **Base:** `marvin/kerf-gap` at `3e9b850` or later.
- **Supersedes** `.claude/plans/kerf-safety-s3c.md` (revision 5, held). Per Lee, 2026-09-29, it combines S3c (jog safety) with S3d (connection lifetime) and the native transport fixes, "reviewed until it passes".
- **Facts:** `.claude/plans/kerf-safety-motion-connection-facts.md`, the native transport map at `a6b5d65`. Every native claim below cites it, and Ted re-verifies each one before editing.
- **Critic history carried in:** S3c rounds 1-5 (`kerf-safety-s3c-critic-r1.md` … `-r5.md`). Every finding from them is either addressed below or explicitly out of scope, and the fold table at the end maps them.

## Intent (grilled)

There was no separate grill. The intent comes from rulings on file:
- **Lee, 2026-09-26 (kerf-9):** "always press home". Refusing jogs until homed "matches how he works."
- **Lee, 2026-09-29:** hold S3c for the full fix. Redo it together with connection lifetime and the native serial-layer fixes, reviewed until it passes.
- **Coordinator, 2026-09-26, option (a):** a motion-in-flight hold covering Home and console motion (Razor W2 on S3), plus Home since connect when `$22=1` (Razor W1).
- **`$22=0`:** fail closed (the S3c critic's inversion; flagged for Lee at close).

**Summary.** The Rust serial layer sees every byte in both directions, so it is the only place that can know the answers. It becomes the owner of jog trust.
- It keeps a **position-trust epoch** that any event able to invalidate the machine position advances:
  - a controller banner or ALARM line seen on any read path;
  - a reset or stop byte;
  - the start of a homing cycle;
  - a connect or disconnect.
- It records **homed** only for a plain `$H` that completed with `ok` and no advance during it.
- It keeps a **motion ledger**: pending motion sends, plus a motion write counter.
- It keeps a **units state**, read from `$13` in `$$` replies.
- It keeps a **connection identity**, which every command must carry.
- It admits a `$J=` jog **at the write boundary**, under the command lock, only when all of these hold:
  - the connection matches;
  - trust is homed and unchanged since the snapshot the jog was computed from;
  - no motion is pending or unobserved since the last motion write;
  - units are mm;
  - the machine's latest snapshot is literal Idle with a finite MPos.

TypeScript computes the clipped distance from that same snapshot and names it (`basisSeq`). Native refuses the write if anything moved since. A refusal writes nothing.

## Existing plans reviewed

- `kerf-safety-s3c.md` (revision 5, held): its TS gate, its reason texts and its test ideas are carried over. Its TS-owned trust and lease are replaced by native ownership.
- S3 (`kerf-safety-s3.md`, merged): its bed memory, clip geometry, refusal texts and `targetInEnvelope` are unchanged. The TS gate stays as the display gate; native becomes the enforcing gate.
- `PLAN-safety-gate-class.md` S4a (native verified-settings snapshot and admission compare) edits `serial_session.rs` and `serial.rs` near the job admission. This plan adds new fields and a new admission function, and changes neither `admit_and_write`, `check_admission` nor the submit lock (DECISIONS 2026-09-24 pin). S4a rebases on this plan and reuses its units state.
- Fence single-reset (DECISIONS 2026-09-24): "Job-line admission and its write are one critical section shared with the stop's admission close; one stop sends one reset and nothing re-sends it." This plan adds no reset and no re-send, and it touches no job path.

## Diagnosis

### TS side (S3c revision 5 diagnosis 1-9)

These still hold at `3e9b850`:
- the envelope trusts an unearned MPos (W1);
- "homed" is recorded on 2 of 4 `$H` routes;
- only `queryGrblSettings` revokes it;
- a jog is admitted right after Home or console motion (W2);
- an accepted Idle carries a stale position;
- `send()`'s in-pump `[MW]Pos` writer takes WPos with no kind;
- units are unknown;
- there is no ordering from a command lock.

### Native side (facts file)

1. Banners are dropped on three paths:
   - `drain_classified`: Banner goes to `dropped` and then to `eprintln` (`serial_pump.rs:320-323`, `serial.rs:509-511`);
   - `read_status_bounded` (`serial_pump.rs:379-386`, `serial.rs:658-668`);
   - the buffered pump, where a Banner becomes a text-less `Aborted` (`:676-677`).
2. The stop's banner read (`serial.rs:1077-1091`) reads into a throwaway buffer and discards every non-banner line, including `ALARM:3`, without a log.
3. The connect drain (`serial.rs:256-280`) stops at `contains("Grbl")`. Its second result is discarded if the first was non-empty (`:332-336`).
4. `run_pump` and `read_status_bounded` drop everything they collected when they return `Err` (`serial_pump.rs:186, 206, 255, 271, 291, 372, 401`).
5. There is no native connection identity. `session.epoch` changes on connect, disconnect and stop, but is never returned by `serial_connect` or `serial_send`, and only job lines are checked against it.
   - Non-job writes are unguarded: `serial.rs:523` (send), `:602` (send_byte), `:326` (connect `0x18`), `:1028`/`:1035` (stop `0x18`) and `:187` (`?`).
   - `std::sync::Mutex` is not FIFO, so a non-job send waiting on `command` across a disconnect and reconnect can write to the new controller.
6. `units` is always `Unknown` (`grbl_status.rs:219`). `seq` is global and has gaps (`serial_session.rs:315`). A `report` can carry an older snapshot, because on a parse failure it returns `read_snapshot()` (`serial.rs:672-675`).
7. `settingsGeneration` is not bumped on disconnect (`connection.ts:573`).

### The five native read sites

Every controller line is extracted at one of these five sites: `serial_pump.rs:184` (run_pump), `:315-318` (drain_classified's line split), `:371` (read_status_bounded), `:638` (buffered pump), `serial.rs:259` (connect drain), and `:1081` (stop read). Ted re-greps `read_until(` and `pending.drain(` across `src-tauri/src/commands` at relay start, and the list here is updated to match. That grep is test N12's input.

## Design

### The native state (new, in `serial_session.rs`)

```rust
/// Motion trust. The ONLY writer of these fields is this impl; readers use the snapshot accessors.
pub(crate) struct MotionTrust {
    conn_id: u64,            // current connection; 0 = disconnected
    trust_epoch: u64,        // advances on every position-invalidating event
    homed_at: Option<u64>,   // trust_epoch value at which a clean $H completed
    motion_pending: u32,     // non-job motion sends entered and not yet returned
    motion_writes: u64,      // count of non-job motion writes (bumped at write, under command lock)
    observed_after: u64,     // motion_writes value that the latest settled Idle snapshot was read after
    units_mm: Option<u64>,   // conn_id at which `$13=0` was read in a `$$` reply, with no `$13=` write since
}
```

`SerialSession` gains `trust: Mutex<MotionTrust>`. It is a leaf lock, taken after `command` and never held across I/O. It joins the lock-order table as a leaf, next to `snapshot`.

**Every transition:**

| Event (native) | Where | Effect |
|---|---|---|
| Any extracted line classified as `Banner` or `Alarm`, at any of the five read sites, including pump error paths (the line is noted **before** any early return) | the `on_line` hook, below | `trust_epoch += 1` |
| `0x18` or `0x85` written (connect, stop, `send_byte`) | each write site | `trust_epoch += 1` (reset or jog cancel: position and the in-flight jog are unknown) |
| A non-job command whose trimmed, upper-cased text starts with `$H` is written | `serial_send_inner`, under the command lock, before `write_all` | `trust_epoch += 1`; remember `h = trust_epoch` for this call |
| That command's pump returns `Ok`, the terminal is `ok`, the text is exactly `$H`, no `Banner`/`Alarm`/`error:` line was noted during the call, and `trust_epoch == h` | the same call, still under the command lock | `homed_at = Some(trust_epoch)` |
| `serial_send` enters with a motion command (`is_motion_command`, ported from S3c's TS classifier, which covers `$J=`, `$H…`, axis words, `G28`/`G30`/`G38`) | entry, before the lock | `motion_pending += 1` |
| Such a command is written | under the command lock, before `write_all` | `motion_writes += 1` |
| That `serial_send` returns (Ok or Err, any path; an RAII guard) | exit | `motion_pending -= 1` |
| A status frame parses with literal `Idle`, a finite `MPos` and `units_mm == Some(conn_id)`, read when `motion_pending == 0` | `publish_snapshot`, under the command lock (status reads hold it via `try_lock`) | `observed_after = motion_writes`. The snapshot is stamped `settled: true` |
| Any other status frame | `publish_snapshot` | the snapshot is stamped `settled: false` |
| A `$$` reply contains `$13=0` | `serial_send_inner`, after the pump, only for the command `$$`, for the current `conn_id` | `units_mm = Some(conn_id)` |
| A `$$` reply contains `$13=` with any other value, a `$$` reply lacks `$13`, or the pump errs | same | `units_mm = None` |
| A command matching `$13=` is written | before `write_all` | `units_mm = None` |
| Connect installs the channel | under `command` + `realtime`, in the same block (`serial.rs:341-352`) | `conn_id = next`, `trust_epoch += 1`, `homed_at = None`, `motion_pending` kept (RAII-owned), `observed_after = motion_writes`, `units_mm = None` |
| Disconnect teardown | under `command` (`serial.rs:443-452`) | `conn_id = 0`, `trust_epoch += 1`, `homed_at = None`, `units_mm = None` |

The `on_line` hook is a `&mut dyn FnMut(&str, LineClass)` passed into each read function, as `run_pump` already takes `on_status`. Each call site passes a closure that calls `session.trust_note_line(class)`. The pump functions stay free of `SerialSession`, which keeps them testable with `ScriptedPort`.

**Snapshot fields (new, serialised to TS):** `connId`, `trustEpoch`, `homed` (`homed_at == Some(trust_epoch)`), `settled`, `unitsMm` (`units_mm == Some(conn_id)`), and `motionPending` (a boolean). They are written at publish from `MotionTrust` under the same critical section, so they are never torn.

**`UnitsValidity` becomes real:** `Mm` when `units_mm == Some(conn_id)`, otherwise `Unknown`. `Inches` is never set, because Kerf refuses rather than converts.

### Native jog admission (new, the enforcing gate)

`serial_send` gains two optional arguments, `conn: Option<u64>` and `jog_basis: Option<u64>`. Old callers pass `None`, and TS migrates in B3.

1. **Connection check.** Under the command lock, if `conn` is `Some(c)` and `c != conn_id`, return `Err("refused: stale-connection")` with **no write**. From B3 on, every TS non-job send passes `conn`. A `send` without `conn` is still written, for compatibility during B1 and B2 only. B3's T-C3 then pins that the TS always passes it.
2. **Jog check.** If the command starts with `$J=`, the write happens only when all of the following hold under the command lock, and otherwise the call returns `Err("refused: jog-not-admitted: <reason>")` with no write:
   - `conn == Some(conn_id)`;
   - `homed_at == Some(trust_epoch)`;
   - `units_mm == Some(conn_id)`;
   - `motion_pending == 1`. That 1 is this call itself: there is no other pending motion;
   - `observed_after == motion_writes`. A settled Idle has been seen since the last motion write;
   - the latest snapshot has `seq == jog_basis`, is `settled`, has `trustEpoch == trust_epoch`, and has a finite MPos;
   - the latest snapshot is at most 3 s old. That is the existing eligibility rule, now enforced natively from `received_at`;
   - `admitted_job` is `None`. No jog is written while a job holds admission.

   **The order within the call is fixed:** the admission check runs, then `motion_writes += 1`, then `write_all`, all in one `command` guard scope. The check therefore compares against the count before this jog's own write.

   The `<reason>` is one of `stale-connection`, `not-homed`, `units`, `motion-pending`, `not-observed`, `stale-basis`, `stale-snapshot` or `job-active`.
3. **Stale connection on the realtime path.** `send_byte` and `serial_get_status` take `conn: Option<u64>` too. `send_byte` with a stale `conn` is refused, with **one exception: `0x18`**. Reset is a stop, and stopping must never be refused.
4. **The job path is unchanged:** `permit`, `admit_and_write` and the submit lock.

The admission check reads `MotionTrust` and the snapshot under the command lock. The command lock is held until the write, so no event can come between the check and the write:
- every other write needs the command lock;
- every read that notes lines runs under it or under `try_lock`;
- the stop `0x18` bumps `trust_epoch` from the realtime path, but a jog written just before a stop is then cancelled by that stop, which is the stop's job.

### TS consumer (B3)

- **The connection id.** `serial_connect` returns `{ banner, connId }`. `connection.ts` stores `connId` and passes `conn` on every `serial_send`, `serial_send_byte` and `serial_get_status`.
- **Stale results.** A result whose echoed `connId` (added to `SendOutcome` and `StatusOutcome`) differs from the current one is discarded before any processing. So are the replies, the poll failure counter (`connection.ts:736-749`), the settings `finally` and `getStatusReport` events. A rejection that arrives while the invoke's `conn` differs from the current one is also dropped, so it cannot count toward the three-failure disconnect.
- **The gate inputs.** The store gains scalars that `consumeStatusOutcome` writes from each accepted snapshot of the current connection: `trustHomed`, `trustSettled`, `trustUnitsMm`, `motionPending` and `basisSeq` (the snapshot's `seq`).
  - `machineHomed` becomes a derived alias of `trustHomed`, and its writers are removed, so native is the only source.
  - `softLimitsActive` keeps deriving from it.
- **The TS gate.** `jogBlockReason` (display, and the first check before sending) refuses on:
  - `motionPending || !trustSettled`: `JOG_REASON_MOTION`;
  - `!trustUnitsMm`: `JOG_REASON_UNITS`;
  - `!grblHoming`: `JOG_REASON_NO_HOMING`;
  - `!trustHomed`: `JOG_REASON_HOME`;
  - `positionKind !== "machine"`: `JOG_REASON_STALE`.

  The texts are S3c revision 5's, and the order is not connected, alarm, job, motion, bed, units, trust, stale, busy, offset.
- **The coordinate.** The only coordinate `clipJog` uses is the position from the snapshot whose `seq` is `basisSeq`. `send()`'s in-pump `<…>` lines no longer write `machinePosition`. The DRO updates only from snapshots, and native publishes in-pump status frames as snapshots already (`run_pump` → `on_status` → `publish_snapshot`), so the DRO keeps updating during a pump.
- **The jog send.** `jog()` and `jogTo()` send `$J=…` with `{ conn, jogBasis: basisSeq }`. A native `refused: jog-not-admitted: <reason>` prints the matching plain-words reason and sends nothing more. There is no retry loop.
- **`$H` routes.** All four go through `send()`. Homed now comes from native, so the alarm-banner button and a console `$H` count with no TS-side logic.
- **Hold note** (§5 of S3c revision 5). The cause comes from the snapshot fields (`motionPending`: command; not settled with Idle: position; not Idle: state). It is read reactively from the store scalars. The command-cause text says: `Still waiting on the machine. If nothing is moving, press STOP, then quit and reopen Kerf and Home again.` With the connection identity in place, a reconnect is also safe, so the text offers both: `…press STOP, then reconnect (or quit and reopen Kerf) and Home again.`
- **`settingsGeneration`** is bumped on disconnect as well (fact 7).

### Panel (B4)

- MachinePanel's two `jogBlockReason` calls read the new scalars, one selector each (CLAUDE.md, React error 185).
- The hold note uses the reactive cause.
- There is no new control. Jen reviews at Stage 3 and writes the visual spec at 0.7, as a fidelity-only spec, as for R3.

## Batches and dependency graph

| Batch | Files | Depends on | Notes |
|---|---|---|---|
| B1 native line and trust state | `serial_session.rs`, `serial_pump.rs`, `serial.rs`, `grbl_status.rs` (+ inline `#[cfg(test)]` modules) | none | The `MotionTrust` struct, the `on_line` hook at all five read sites (including error paths), `trust_epoch`/`homed_at`/motion ledger/units, and the snapshot fields. **No new refusal yet**: behaviour is unchanged for TS |
| B2 native connection identity and jog admission | `serial.rs`, `serial_session.rs` (+ tests) | B1 | `conn_id`; the `serial_connect` return shape; `conn`/`jog_basis` args; the stale-connection and jog admission refusals; the `send_byte` `0x18` exception |
| B3 TS consumer | `connection.ts`, `machineStatus.ts`, `jogBounds.ts`, `store/index.ts`, `store/storeTypes.ts`, `connection.test.ts`, `jogBounds.test.ts` | B2 | 7 files, one root |
| B4 panel | `MachinePanel.tsx`, `machineJobLoop.test.tsx` | B3 | UI |
| 3.5 (orchestrator) | ROADMAP, ARCHITECTURE, Parking Lot | B4 merged | |

B1 and B2 are one root (`src-tauri`) and 4 files, with no waiver needed. Razor reviews between batches (Complex/Architectural rule). The `serial_connect` return-shape change in B2 is additive: TS reads `connId` from B3 on. Until then, TS treats the return value as the banner string. To avoid that change breaking B2 and B3 separately, B2 returns `{ banner, connId }` and B2's commit also changes the single TS consumer line (`connection.ts:450`) to read `.banner`. That line is a one-line cross-root touch, waived for that reason.

## Tests

### Native (B1, B2)

These tests are in-module and use `ScriptedPort` with real byte streams.

- **N1: a banner on each read site advances `trust_epoch` and clears `homed`.** Starting homed (a scripted `$H` → `ok`), one test per read site delivers `Grbl 1.1f ['$' for help]\r\n`: the `run_pump` reply, the pre-send drain, the status read, the buffered pump, the connect drain and the stop read. Assert `homed == false` on the next snapshot and that the next `$J=` is refused `not-homed`. For the stop read, the ALARM line before the banner is noted too (fact 2).
- **N2: a pump or status read that errs after reading an ALARM line still advances the epoch** (fact 4). The scripted port yields `ALARM:1\r\n`, then an I/O error.
- **N3: the grant.**
  - A plain `$H` → `ok` gives `homed`.
  - `$HX` → `ok` does not give `homed`, and revokes.
  - `$H` → `ok` with an ALARM line during the pump gives no grant.
  - `$H` → `ok` with a banner drained in the same call gives no grant.
  - `$H` → `error:9` gives no grant.
- **N4: revocation during a pending `$H`.** A `0x18` sent from another thread via `send_byte` while the `$H` pump is waiting, followed by `ok`, gives no grant, because `trust_epoch` moved.
- **N5: the motion ledger.**
  - Two concurrent motion sends: `motion_pending` reaches 2, and the `$J=` check refuses `motion-pending`.
  - A settled Idle while one is outstanding does not set `observed_after`.
  - After both return, the next Idle MPos snapshot sets it, and a `$J=` whose basis is that snapshot is written.
- **N6: literal Idle.** `Check` and `Sleep` frames are never `settled`. A frame with `WPos`, or with no position, is never `settled`.
- **N7: units.**
  - `$$` → `$13=0` gives `unitsMm`.
  - A later `$13=1` write gives `units` refused.
  - `$$` without `$13` gives refused.
  - A `$$` pump error gives refused.
  - A reconnect clears it.
  - A `$$` reply read under an old `conn_id` cannot set it for the new one.
- **N8: stale connection.**
  - A `serial_send(conn = old)` issued, then disconnect and connect, then the send reaches the lock: refused, and **no byte is written to the new port**. The new port's written-bytes trace is empty of it.
  - The same schedule for `send_byte(0x21, old)`: refused.
  - For `send_byte(0x18, old)`: written, which is the exception.

  This is the native overlap test the S3c round-4 critic asked for (E).
- **N9: jog admission refusals.** Each refusal reason, with the written-bytes trace showing zero bytes. One admitted case shows the exact `$J=` bytes.
- **N10: basis race.** Snapshot seq 10 is settled. A motion console send is then written and returns, and snapshot 11 is not yet read. A `$J=` with `jog_basis = 10` is refused `not-observed`.
- **N11: check and write are one critical section.**
  - Structural: `jog_admit` is called from `serial_send_inner` inside the same `inner.command.lock()` guard as the `write_all`, with no `drop(guard)` or early unlock between them. Razor verifies this by reading, and N12's scan also asserts that `jog_admit(` occurs exactly once, in that function.
  - Behavioural: with a job admitted, a `$J=` is refused `job-active` and the written-bytes trace is empty.
- **N12: source scan** (the E1b T12 pattern). Every `read_until(` and `pending.drain(` site under `src/commands` has an `on_line`/`trust_note_line` call within its extraction block. The test walks the files and counts the sites against a pinned list, so a new read site without the hook turns it red.
- **N13: `settled` needs `units_mm`.** This locks the relationship between the units state and admission.
- The existing tests all pass unchanged: the fence tests, the stop tests, the golden tests, `mod sim_integration`, and the full suite. Pin: `machineJobLoop.test.tsx:468` stays unweakened (Razor, S1/S3 note).

### TS (B3, B4)

- **T-C1: stale results.**
  - A late `serial_send` result with an old `connId` writes nothing: no position, no console `received` beyond one discard line, and no lease effect.
  - The same for a late poll result.
  - Three late poll rejections from the old connection do not disconnect the new one.
  - A late settings `finally` does not invalidate the new connection's laser mode.
- **T-C2: the gate from snapshot fields,** edge-sensitive: bed 205, snapshot X=200, request +10, sends `X5.000` with `jogBasis` equal to that snapshot's `seq`. Every refusal reason renders its text, with zero `serial_send` calls.
- **T-C3: every `serial_send`, `serial_send_byte` and `serial_get_status` invoke carries `conn`** (a spy over all calls in the suite's jog and console tests).
- **T-C4: a native refusal is surfaced.** An `invoke` rejecting with `refused: jog-not-admitted: stale-basis` prints the plain-words reason, with no retry.
- **T-C5: in-pump lines no longer write position.** A reply carrying `<Idle|WPos:10,0,0>` leaves `machinePosition` as it was.
- **T-C6: `machineHomed` comes only from snapshots.** `grep -rn "setMachineHomed(" src` returns only the consumer. `home()` and the alarm-banner route both lead to `homed` once a snapshot says so.
- **T-C7:** `settingsGeneration` bumps on disconnect.
- **T-P1: the panel.** Titles for each reason. The hold note has three causes, reacting to store changes without a remount (fake timers).
- **Reproduce first.** For B1, write N1 (drain and status sites), N3 and N8 before the production edits. Run them red on the existing code (for B1's fields, a compile-red is not red proof; write them against the existing observable behaviour where possible, e.g. N8's written-bytes trace today shows the stale write). For B3, T-C1 and T-C5 go red before the production edits.

### Mutation batteries (one per batch)

Ted writes each `find` from committed code, `grep -cF` = 1, and every kill must come from an observable behaviour: a byte written, a refusal, or a flag.
- **B1:**
  - remove the `trust_epoch` bump in the `on_line` hook for Banner, then Alarm (N1, N2);
  - remove the pump-error `on_line` call (N2);
  - make the `$H` grant ignore the epoch equality (N3, N4);
  - accept `$HX` (N3);
  - `motion_pending` decrement on entry instead of the RAII guard (N5);
  - drop the `motion_pending == 0` condition in `settled` (N5);
  - literal Idle becomes any idle-like state (N6);
  - drop the MPos requirement (N6);
  - units: drop the pump-error clear (N7) and the `$13=` write clear (N7);
  - the stop read no longer notes non-banner lines (N1, stop site).
- **B2:**
  - remove the conn check (N8);
  - allow `0x21` with a stale conn (N8);
  - refuse `0x18` with a stale conn (N8, the exception must still write);
  - each jog admission condition is replaced by `true` (N9, N10);
  - move the admission check outside the lock scope (N11's grep assertion plus N10).
- **B3:**
  - the stale-result discard off (T-C1);
  - the poll-rejection conn check off (T-C1);
  - the in-pump position write restored (T-C5);
  - the gate's `trustSettled` check off (T-C2);
  - `jogBasis` omitted (T-C2 asserts the args).
- **B4:** the panel reason-title selectors (T-P1).
- **Controls:** B1 makes `is_motion_command` match everything (a positive control on the classifier's false cases); B3 makes the gate refuse everything (T-C2's admitted case goes red).

## Verification

- `cargo test --features sim` (full), `clippy --all-targets --features sim -D warnings`, `fmt --check`, full vitest, tsc, format and lint. Every batch battery all killed, 0 survived, 0 errored, 0 CONTROL_RED.
- Browser (dev server, `invoke` mocked with the new result shapes): the panel states. This is UI evidence only.
- **Owner hardware card: behaviour only.** This card makes no frame claims; those are S3e. Laser power isolated, hands clear, power switch within reach, and the head mid-bed with at least 20 mm measured on both sides of each axis before any step. Step 1 mm unless stated; no Position Laser.
  1. Connect. The arrows are disabled with the Home reason.
  2. Home, and during it press an arrow: refused, and nothing moves afterwards.
  3. After Home, move back to mid-bed with the console `G21 G90 G1 X… Y… F300` at the measured centre. Then: one 1 mm jog each way on X and on Y moves 1 mm each.
  4. Console `G1 X` (current + 10) `F300`, then press an arrow at once: refused until it stops.
  5. Console `G1 X` (current + 10) `F200`, and press STOP mid-move. The arrows show the Home reason. Unlock with `$X`: still the Home reason, until Home.
  6. Unplug USB, reconnect: the Home reason is shown until Home.
  - **Outcomes:** PASSED (all six), which closes W1/W2 as this plan scopes them on this controller; or FAILED, which goes to a fix relay. The frame (home corner, direction, extent) is S3e's card.

## Out of scope (Parking Lot at 3.5)

1. **S3e frame qualification.** A per-machine frame-qualified state keyed by the S3 bed key; jogs refuse until the frame card passes. Its card carries S3c revision 5's frame steps, with the round-5 containment concerns: an independently verified physical stop, and scale and travel qualified before the test.
2. **Attestation for `$22=0`.**
3. **Jobs, FRAME and material test homing** (`canStartJob`, S4c).
4. **Alarm-code discrimination.**
5. **Console motion stays unclipped.** It is counted in the ledger and refused if the connection is stale, but it is not bounded.
6. **`$10` WPos-only controllers lose jogging** (fail closed; disclosed).
7. The **job path** (buffered pump, per-line stream) keeps its own fence and **does not consult `MotionTrust`**. Whether a job should require homed is item 3.

## Risks and rollback

- **It touches the native serial layer next to the safety-critical stop and fence.** Mitigations:
  - no change to `admit_and_write`, `check_admission`, the submit lock or the stop sequence;
  - the new lock is a leaf;
  - the stop `0x18` is never refused;
  - the full existing Rust suite, the sim and the fence tests run unchanged.
- **The `serial_connect` return shape changes.** It is additive, and the one consumer changes in the same commit.
- **Stricter than today:** Home is needed per connection; `$22=0` loses the arrows; WPos-only controllers lose the arrows; a jog after any motion waits one settled poll.
- **Rollback:** revert the merge. Nothing is persisted. The operating restriction until then is: do not use the jog buttons or Position Laser; Home first; move from the console only after the previous move has visibly stopped.

## Decisions

- **Resolved:** kerf-9 (jogs refuse until homed); Lee 2026-09-29 (combined job, reviewed until it passes).
- **Applied, flagged at close:** `$22=0` fails closed; admission narrows to mm MPos.
- **Proposed DECISIONS entry at close** (Engineering pin, for Lee's yes): "A `$J=` jog is written only if the native session admits it under the command lock: current connection, clean home at the current trust epoch, mm units, no pending or unobserved motion, and a settled basis snapshot; TS clipping is advisory." The reason: TS cannot see every byte, native can.

## Fold map from the S3c rounds

| S3c finding | Where it is handled here |
|---|---|
| r1 raw `$J=` escapes; 4 alarm paths; one boolean; `$HX`; grant regen | Native ledger counts every non-job motion; `on_line` at every read site; `motion_pending` count; exact `$H`; `trust_epoch` equality |
| r2 reset banner; session fence; T8 reachable; literal Idle; one trust owner | Banner is noted on every path, including stop and errors (N1, N2); `conn_id` checked at the write (N8); native literal Idle (N6); `MotionTrust` is the sole owner |
| r3 stale-position Idle; fence incomplete; oracle; card; native lifetime (E) | `settled` needs MPos + Idle + units; whole-result discard by `connId` (T-C1); edge oracles; behaviour-only card; native conn check with a written-bytes trace (N8) |
| r4 second position writer; reconnect advice; units; card containment | In-pump TS writer removed (T-C5); reconnect is safe now (conn check) and advised alongside quit; native `$13` (N7); frame containment moved to S3e |
| r5 banners dropped natively; units generation; post-motion sample order; hardware containment; frame vs release ruling | `drain_classified`/`read_status_bounded`/stop/buffered/connect all note (N1); `units_mm` keyed by `conn_id` and cleared on write/error/absence (N7); `observed_after`/`motion_writes` gives native ordering (N5, N10); the card is behaviour-only with ±20 mm measured clearance; the frame and its enforcement are S3e |
