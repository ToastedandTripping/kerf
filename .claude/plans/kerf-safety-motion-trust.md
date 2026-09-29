# Kerf safety: motion trust owned natively. A jog is admitted and written inside the stop-shared critical section, only from a clean home, a post-motion observation, mm units, and the current connection

- **Relay id:** `kerf-safety-motion-trust`
- **Branch:** `relay/kerf-safety-motion-trust`
- **Tier:** Architectural. It adds new native primitives:
  - a connection identity;
  - a position-trust epoch;
  - a motion ledger;
  - an observation barrier;
  - a units state;
  - jog admission.
- **Batches:**
  - B1, native line/trust state;
  - B2+B3 (one releasable unit), native identity and jog admission plus the TS consumer;
  - B4, panel.
- **Base:** `marvin/kerf-gap` at `97a72f9` or later.
- **Revision 2.** Folds astra round 1 (`-critic-r1.md`, FAIL). See the fold table at the end.
- **Supersedes** `.claude/plans/kerf-safety-s3c.md` (revision 5, held). Per Lee, 2026-09-29, it merges S3c with S3d and the native transport fixes, "reviewed until it passes".
- **Facts:** `.claude/plans/kerf-safety-motion-connection-facts.md` (native transport map at `a6b5d65`). Ted re-verifies every cited line before editing.
- **Owner capture:** `scripts/probe-20260914-153729.log`.

## Intent (grilled)

There was no separate grill. The intent comes from rulings on file:
- **Lee, 2026-09-26 (kerf-9):** "always press home". Refusing jogs until homed "matches how he works."
- **Lee, 2026-09-29:** hold S3c for the full fix, redone with connection lifetime and the native serial-layer fixes, reviewed until it passes.
- **Coordinator, 2026-09-26, option (a):** the motion hold (W2) and Home since connect (W1).
- **`$22=0`:** fail closed (the S3c critic's inversion; flagged for Lee at close).

**Summary.**

The Rust serial layer sees every byte in both directions, so it owns jog trust. A `$J=` jog is written only when all of these hold, and all of them are checked and the write made inside the **same `submit` critical section that STOP's admission close already uses** (DECISIONS 2026-09-24 pin):
- **Current connection.**
- **A clean home.** A plain `$H` completed with `ok`, and no position-invalidating event since. The events are:
  - a banner;
  - an ALARM line or an `<Alarm…>` status frame on any read path, including error paths;
  - a reset or jog-cancel byte;
  - a STOP;
  - a re-home start;
  - a frame-affecting settings write;
  - an I/O error after a motion write;
  - a connect or disconnect.
- **A post-motion observation.** A status frame taken by the **native observation barrier** after the last motion write (job lines included). It must be literal Idle with a finite MPos.
- **mm units.** `$13=0` read in this connection, with no settings write or reset since.
- **No job admitted, and no stop in progress.**
- **Unchanged basis.** The jog's distance was clipped by TS from that exact observation (`jogBasis`), and nothing has moved since.

A refusal writes nothing.

**What this plan closes:** W1 and W2 as scoped here, on the owner's controller, once the behaviour card passes. **It does not close physical frame correctness** (home corner, direction, extents). That is S3e, whose enforced refusal is a named dependency for claiming frame safety (see Out of scope 1).

## Existing plans reviewed

- **`kerf-safety-s3c.md` (rev 5, held).** The TS gate, the reason texts and the test ideas carry over. The TS-owned trust is replaced.
- **S3 (merged).** Bed memory, clip geometry, the S3 refusal texts and `targetInEnvelope` are unchanged. The TS gate becomes display plus first check. Native enforces.
- **`PLAN-safety-gate-class.md` S4a** (native verified-settings snapshot) edits `serial_session.rs`/`serial.rs` near job admission. S4a rebases on this plan and reuses its units and settings generation.
- **DECISIONS 2026-09-24:** "Job-line admission and its write are one critical section shared with the stop's admission close; one stop sends one reset and nothing re-sends it." This plan **extends that same critical section to jog lines and to the raw reset byte**. It adds no reset and no re-send. The extension is proposed as an amendment to that pin at close (Decisions below).

## Diagnosis

- **TS side.** S3c rev 5 diagnosis 1-9 still hold at `97a72f9`.
- **Native side.** The facts file, items as cited there.
- **New, from critic round 1:**
  1. **STOP and raw reset bypass `command`.** `send_byte_inner` takes only the realtime lock (`serial.rs:591-605`). `serial_stop_inner` takes `submit`, calls `close_admission`, and then writes `0x18` without `command` (`serial.rs:1002-1011` and the Step 5 write). A jog that passed a check under `command` alone can therefore be written after a reset.
  2. **A read Idle is not a fresh observation.** `read_status_bounded` sends `?` and returns the first status in the reader (`serial_pump.rs:356-382`). A report buffered before, or generated in the gap between a motion's `ok` and its cycle start, can be read afterwards. In stock GRBL 1.1, `protocol_exec_rt_system` runs the status report before cycle start in the same pass, so an Idle with the pre-motion position can follow the `ok`.
     - **`Bf:` does not rescue this on the owner's controller.** The capture's first report is `<Run|MPos:1.275,-1.237,…|Bf:127,65535…>`: 127 planner blocks free while Running.
  3. **Jobs are outside any jog ledger.** Admission (`serial_job_begin_inner`, `serial.rs:1154`) and the job writes do not touch any state a jog consults.
  4. **Payload grammar.** `serial_send_inner` writes the supplied string plus a newline. A payload with an embedded `\n` or a realtime byte is two commands to GRBL but one to any prefix check.

## Design

### Native state (`serial_session.rs`)

```rust
pub(crate) struct MotionTrust {
    conn_id: u64,              // current connection; 0 = disconnected
    trust_epoch: u64,          // advances on every position-invalidating event
    homed_at: Option<u64>,     // trust_epoch at which a clean `$H` completed
    motion_pending: u32,       // motion sends (jog, $H, console, job lines) entered and not returned
    motion_writes: u64,        // motion writes made (bumped at write)
    observed: Option<Observation>, // the latest barrier observation
    units_mm: Option<u64>,     // conn_id at which `$13=0` was read; cleared by writes/resets/errors
}
pub(crate) struct Observation { conn_id: u64, trust_epoch: u64, after_writes: u64, seq: u64, idle_mpos: bool }
```

- **Where it lives.** `SerialSession` gains `trust: Mutex<MotionTrust>`.
- **Lock order.** The order is `command` → `submit` → `trust` → `snapshot` → `admitted_job`. The existing table lists `submit` as 2.5 under `command` and `admitted_job` as a leaf. This plan inserts `trust` between `submit` and `snapshot`, and makes `snapshot` a leaf below `trust`. Ted amends the table at `serial.rs:5-13` and each lock's doc comment. Every holder of `trust` releases it before any I/O.
- **Poison.** Poison is recovered with `unwrap_or_else(|e| e.into_inner())`, as `submit` already is, so a panic in a holder can never block STOP.

**One outbound command grammar** (`fn classify_outbound(cmd: &str) -> Result<Outbound, String>`) runs first in `serial_send_inner`. It refuses, with no write:
- any payload containing `\r` or `\n`;
- a byte `< 0x20`;
- a byte `>= 0x7f`;
- any of `?`, `!`, `~`, which are realtime characters to GRBL.

Classification works on the trimmed, upper-cased text:
- `Jog` for `$J=…`;
- `Home` for exactly `$H`;
- `HomeAxis` for `$H…`;
- `SettingsWrite(key)` for `$<n>=…`;
- `SettingsRead` for `$$`;
- `Reset` for `$RST=…`;
- `Motion` for the axis-word, `G28`, `G30` or `G38` rules ported from S3c's `isMotionCommand`;
- `Other`.

The raw realtime path (`send_byte`) is separate: the only realtime bytes are those, sent through `send_byte`.

**The `on_line` hook** is passed into every native read function as `&mut dyn FnMut(&str, LineClass)`, as `run_pump` already takes `on_status`. Each call site's closure calls `session.trust_note_line(line, class)`. The sites, re-grepped by Ted at start:
- `run_pump` (`serial_pump.rs:184`);
- `drain_classified`'s line split (`:315-318`);
- `read_status_bounded` (`:371`);
- the buffered pump (`:638`);
- the connect drain (`serial.rs:259`);
- the stop read (`:1081`).

A line is noted as soon as it is extracted, before any classification-based return or early `Err`.

**Transitions** (all under `trust`, none across I/O):

| Event | Effect |
|---|---|
| A noted line of class `Banner` or `Alarm`, or a `Status` line whose state field is `Alarm` (`<Alarm…>`) | `trust_epoch += 1` |
| STOP's `close_admission` (under `submit`), before its `0x18` | `trust_epoch += 1` |
| `send_byte` with `0x18` or `0x85` (raw reset, jog cancel): takes `submit`, bumps, releases, then writes | `trust_epoch += 1`. The byte is always written; see Admission |
| Connect install (under `command` + `realtime`, `serial.rs:341-352`) | `conn_id = next`, `trust_epoch += 1`, `homed_at = None`, `observed = None`, `units_mm = None` |
| Disconnect teardown (under `command`, `serial.rs:443-452`) | `conn_id = 0`, `trust_epoch += 1`, `homed_at = None`, `observed = None`, `units_mm = None` |
| `Home` or `HomeAxis` written | `trust_epoch += 1`, remembered as `h`. `observed = None` |
| `Home` pump returns `Ok` with terminal `ok` and `trust_epoch == h` (no line during the call was Banner, Alarm, `<Alarm…>` or `error:`: those would have bumped the epoch or failed the terminal test) | `homed_at = Some(trust_epoch)` |
| `SettingsWrite(k)` written, for `k` in {3, 13, 20-27, 100-102, 110-112, 120-122, 130-132} (direction, report units, limits/homing, steps/mm, max rate, accel, travel) | `trust_epoch += 1`, `units_mm = None` |
| `SettingsWrite` of any other key, or `Reset`, written | `units_mm = None`. For `Reset`, also `trust_epoch += 1` |
| A `SettingsRead` pump returns `Ok`, with a reply line `$13=0` and no `$13=` line with another value, for the current `conn_id` | `units_mm = Some(conn_id)` |
| A `SettingsRead` pump returns without that (missing, other value, `Err`) | `units_mm = None` |
| Any motion-class send enters (`Jog`, `Home`, `HomeAxis`, `Motion`, job lines) | `motion_pending += 1` (an RAII guard decrements it on return) |
| A motion write | `motion_writes += 1`, `observed = None` |
| A motion send's pump returns `Err` after its write (I/O error, flush error, missing terminal) | `trust_epoch += 1` (position unknown). No stale-terminal reuse: each pump's terminal belongs to its own call, and a later call starts with a drain whose lines are noted, not reused |
| `serial_job_begin_inner` admits a job | `observed = None` (under `submit`) |

### The observation barrier (`fn observe(inner) -> Result<Observation, String>`)

This is new and native. It runs **inside `serial_get_status_inner`** when the command lock is free and `observed` is `None` or stale.

1. **Hold `command`** for the whole barrier. The status poller already runs under `try_lock`, so a pump in flight means busy and no barrier.
2. **Quiesce.** Wait `Q` ms since the last motion terminal was read. `Q` is the constant `OBSERVE_QUIESCE_MS`, default 150. Its value is a hardware-qualified parameter (see Verification, card step 4).
3. **Drain** everything buffered: `pending`, the reader and the OS queue, through `drain_classified` with `on_line`. Every drained line is noted, and statuses are published as ordinary snapshots with `settled: false`.
4. **Probe.** Write `?`, then read the first status frame after it, bounded at 500 ms.
5. **Build the observation** from that frame: `idle_mpos` is `state == Idle` (literal) with a finite MPos. Record `after_writes = motion_writes`, the current `conn_id`, the current `trust_epoch`, and the frame's `seq`.

**Why this is a real post-motion observation**, with the assumption stated:
- Every byte in the reader when the probe is written was drained, so the frame read after the probe was generated after the drain began, which is at least `Q` ms after the last motion `ok`.
- In stock GRBL, cycle start follows a motion `ok` within one main-loop pass (much less than 1 ms). A report generated `Q` ms later reflects a started cycle: Run or Jog, or Idle only if the motion has finished (or was rejected, which gives `error:` and bumps nothing, and Idle is then true).
- **The assumption: the owner's vendor fork starts cycles within `Q` of `ok`, and transmits a report within 500 ms of `?`.** This is not assumed silently. Card step 4 qualifies it: 20 back-to-back 1 mm jogs, each checked against the observed position. Until the card passes, the ROADMAP records "software-closed, hardware-unqualified".
- A buffered frame from an earlier busy-path `?` is either drained (it arrived within `Q`) or generated after the drain began, and so also post-`Q`.
- **The busy-path `?`** (`serial.rs:629-644`) cannot run during the barrier, because the barrier holds `command` and the busy path is the `try_lock`-failed branch of the same poller. A second poller does not exist.

The barrier's cost is at most `Q` + 500 ms per motion, on the next poll after the motion. During a pump the poller is busy as today.

### Jog admission (the enforcing gate)

`serial_send` takes `conn: u64` (required from B2+B3 on; a missing `conn` is refused) and `jog_basis: Option<u64>`.

1. `classify_outbound` runs first. A malformed command is refused.
2. Take `command`. If `conn != conn_id`: `refused: stale-connection`.
3. For `Jog`: take `submit`, then `trust`, and check all of the following:
   - `admitted_job.is_none()`;
   - the session phase is not stopping (`close_admission` not active);
   - `homed_at == Some(trust_epoch)`;
   - `units_mm == Some(conn_id)`;
   - `motion_pending == 1`, counting this call;
   - `observed` is `Some(o)`, where `o.conn_id == conn_id`, `o.trust_epoch == trust_epoch`, `o.after_writes == motion_writes`, `o.idle_mpos`, and `o.seq == jog_basis`.

   Then `motion_writes += 1` and `observed = None`. Release `trust`. Write the jog line **while still holding `submit`**. Release `submit`.

   The order is fixed: check, then count, then write, all under `submit`. **STOP's `close_admission` needs `submit`**, so a STOP either runs entirely before the check, in which case the check sees the phase and `trust_epoch` and refuses, or waits for this one `write()` and then sends its `0x18` after the jog's bytes. That is the existing fence's ordering, extended to jogs. **Raw `0x18`/`0x85` via `send_byte` take `submit` the same way** (held only across the bump). The realtime write itself happens after `submit` is released, exactly as STOP's `0x18` does. No reset is ever refused or delayed beyond one in-progress `write()`.
4. For non-jog commands: the stale-connection check; the transitions above; and the write under `command` as today.
5. **`send_byte(conn, b)`:** refused on a stale `conn`, except `0x18`. **`serial_get_status(conn)`:** refused on a stale `conn`.
6. **Refusal reasons:** `stale-connection`, `malformed`, `job-active`, `stopping`, `not-homed`, `units`, `motion-pending`, `not-observed` or `stale-basis`.

### Snapshot and result fields (serialised to TS)

- **`GrblSnapshot`** gains `connId`, `trustEpoch`, `homed` (`homed_at == Some(trust_epoch)`), `unitsMm`, `motionPending` (bool), and `observed`, which is true only on the frame the barrier produced and while `observed` is still current.
- **`SendOutcome`** and **`StatusOutcome`** gain `connId`.
- **`serial_connect`** returns `{ banner, connId }`. This is a breaking change, delivered together with B3 (see Batches).
- **`UnitsValidity`** is `Mm` when `unitsMm`. `Inches` is never set: Kerf refuses rather than converts.

### TS consumer

- `connection.ts` stores `connId` and passes `conn` on every `serial_send`, `serial_send_byte` and `serial_get_status`. Every result whose `connId` differs from the current one is discarded before any processing. So is every rejection from an invoke made under an old `connId`: it neither counts toward the three-failure disconnect nor touches the settings `finally`. `settingsGeneration` bumps on disconnect.
- The store gains scalars written by `consumeStatusOutcome` from accepted current-connection snapshots:
  - `trustHomed`;
  - `trustUnitsMm`;
  - `motionPending`;
  - `trustObserved` (the latest snapshot has `observed: true`);
  - `basisSeq` (that snapshot's `seq`);
  - `basisPosition` (that snapshot's MPos).

  `machineHomed` becomes a read-only alias of `trustHomed`, and its setters are removed.
- **Provisional display invalidation (TS, display only):**
  - at entry to any motion send, set `motionPending = true` and `trustObserved = false`;
  - at `emergencyStop()`, `softReset()`, a native `refused:` or a send rejection, set `trustHomed = false` and `trustObserved = false`.

  The next snapshot overwrites them. Native stays authoritative. The UI can only be more conservative than native, never less.
- **The gate** (`jogBlockReason`) uses the S3c rev 5 texts, and refuses on:
  - `motionPending || !trustObserved` (MOTION);
  - `!trustUnitsMm` (UNITS);
  - `!grblHoming` (NO_HOMING);
  - `!trustHomed` (HOME).

  The order is: not connected, alarm, job, **trust (HOME / NO_HOMING)**, units, motion, bed, stale, busy, offset.
  - HOME now precedes MOTION. After a STOP or on connect, the operator reads "Home the machine" rather than "waiting", which matches the card (critic X4).
  - The clipped distance comes from `basisPosition`. `jog()`/`jogTo()` send with `{ conn, jogBasis: basisSeq }`, and a native refusal prints its plain reason. There is no retry.
- **Reply lines no longer write position.** `send()`'s in-pump `<…>` lines no longer write `machinePosition`. The DRO updates from snapshots only, and native already publishes in-pump status frames as snapshots.
- **Hold-note causes,** read reactively from store scalars: `motionPending` means command; `!trustObserved` with the latest state Idle means position; a non-Idle state means state. The command text is: "Still waiting on the machine. If nothing is moving, press STOP, then reconnect and Home again." With the connection identity enforced natively, a reconnect is safe (N8), so quit-and-reopen is no longer needed as advice.

### Panel

- MachinePanel's two `jogBlockReason` calls read the new scalars through one selector each (React error 185 rule).
- The hold note reads its cause reactively.
- There is no new control. Jen writes a fidelity-only spec at Stage 0.7 and reviews at Stage 3.

## Batches and dependency graph

| Batch | Files | Depends on | Releasable alone |
|---|---|---|---|
| B1 native line/trust state and observation barrier | `serial_session.rs`, `serial_pump.rs`, `serial.rs`, `grbl_status.rs` | none | Yes. It adds state, hooks, the barrier and snapshot fields. No refusal and no ABI break. TS ignores the new fields |
| B2+B3 native identity and jog admission, plus the TS consumer | `serial.rs`, `serial_session.rs`, `connection.ts`, `machineStatus.ts`, `jogBounds.ts`, `store/index.ts`, `store/storeTypes.ts`, and tests | B1 | **Only together.** The ABI break (`serial_connect` shape, required `conn`/`jog_basis`) and its callers ship in one batch. **Waiver:** 7 production files over two roots, because splitting them yields an undeployable intermediate (critic F7) |
| B4 panel | `MachinePanel.tsx`, `machineJobLoop.test.tsx` | B2+B3 | Yes |
| 3.5 | ROADMAP, ARCHITECTURE | B4 | none |

- **Merge rule.** The relay branch merges into the session branch only after B4 passes review. No intermediate batch is merged or built.
- **Razor** reviews each batch (Architectural rule).
- **Deferrals.** The seven items are indexed in the ROADMAP Parking Lot **now**, at plan time, in the commit that carries this revision. They are not left for Stage 3.5.

## Tests

### Native

These are in-module tests using `ScriptedPort`, which records the written-bytes trace. Each mutation's kill must be observable in that trace or in a refusal. Ted confirms that each mutated line is reached, using a debug counter or a failing assertion.

- **N1: every read site.** Starting homed:
  - deliver `Grbl 1.1f ['$' for help]\r\n` at each of the six sites;
  - also deliver `ALARM:1`, and `<Alarm|MPos:0,0,0|…>`, through the status read and the pump.

  After each, the next `$J=` is refused `not-homed`, and the trace shows zero jog bytes. For the stop read, a non-banner ALARM line is noted as well.
- **N2: reachable error path.** `run_pump` reads `<Alarm|MPos:…>` (Status, which is not terminal), then the port returns an I/O error. The epoch has advanced and the next jog is refused. Second case: `read_status_bounded` surfaces `ALARM:2`, then errs. The epoch has advanced.
- **N3: grant.**
  - A plain `$H` → `ok` grants.
  - `$HX` → `ok`: no grant, and trust is revoked.
  - `$H` → `ok` with an ALARM line during the pump: no grant.
  - A banner drained at the start of the `$H` call (before the write), then `ok`, **does** grant. The drain precedes the `$H` write and its epoch bump, so the policy is "prior history is revoked; the new home re-earns it". This is stated in the transition table and pinned here.
  - `$H` → `error:9`: no grant.
- **N4: STOP ordering (a deterministic barrier).** A `#[cfg(test)]` hook in the jog path fires after the check and before the write, and from another thread calls `serial_stop_inner`.
  - Assert STOP blocks on `submit` until the jog write finishes.
  - The trace order must be: jog bytes, then `0x18`.
  - STOP completes.
  - A second jog after STOP is refused (`stopping` or `not-homed`).
  - The same test with a raw `send_byte(0x18)` in place of STOP.
  - The same test with `serial_job_begin_inner` in place of STOP: job admission waits on `submit` and the jog is written first; a jog after it is refused `job-active`.
- **N5: the barrier.** A scripted stream in which a stale `<Idle|MPos:10,…>` is already buffered after a jog's `ok`, and the real post-motion `<Idle|MPos:11,…>` is the reply to the barrier's `?`. The barrier drains the first, which does not become `observed`, and observes the second. A `$J=` with `jog_basis` equal to the stale frame's seq is refused `stale-basis`. With the barrier's seq, it is admitted.
- **N6: the ledger.**
  - Two concurrent motion sends: the jog is refused `motion-pending`.
  - After both return, before the barrier runs: refused `not-observed`.
  - After the barrier: admitted.
  - A short job (admit, write two lines, end) after an observation: the next jog is refused `not-observed` until a new barrier.
- **N7: literal Idle.** `Check`, `Sleep`, `Hold`, a WPos frame, and a frame with no position all give `idle_mpos == false`.
- **N8: stale connection.** A `serial_send(conn = old)` is parked on `command` (the test holds the lock), then disconnect and reconnect run, then the lock is released. The send is refused, and the **new port's trace contains none of its bytes**. The same holds for `send_byte(0x21, old)`, which is refused. `send_byte(0x18, old)` is written: that is the exception. `serial_get_status(old)` is refused.
- **N9: grammar.** `$J=G91 X1\n$J=G91 X50` is refused `malformed` with zero bytes. So are `$J=G91 X1\r`, `G0 X1\x18`, `$J=G91 X1?`, and a non-ASCII byte. `  $j=g91 x1 f100 ` is normalised and classified as Jog.
- **N10: units.**
  - `$$` → `$13=0` makes the units mm.
  - After that, a `$13=1` write refuses on `units`.
  - A `$100=80` write refuses on `units` and revokes homed.
  - `$$` without `$13` refuses.
  - `$$` → `Err` refuses.
  - `$RST=$` refuses and revokes homed.
  - A reconnect clears it.
  - A banner does not clear units by itself, but it revokes homed. Units live with the connection plus writes. A controller reset also resets the controller's `$13` to its EEPROM value, which is the value `$$` read, so the units stay truthful. This is stated as an assumption and flagged for the card.
- **N11: motion I/O error.** A motion send whose write succeeds and whose pump then errs: the epoch advances, and the next jog is refused `not-homed`.
- **N12: source scan** (the E1b T12 pattern). Every `read_until(` and `pending.drain(` site under `src/commands` is in the pinned list of six, and each passes an `on_line` closure. The count is exact, so a new read site turns the test red. Behaviourally, N1 exercises each site's callback effect.
- **N13: lock order.** A `#[cfg(test)]` debug assertion (a thread-local lock-rank tracker around `submit`, `trust` and `snapshot`) runs across N4-N8 and panics on an inversion.
- **Unchanged:** the existing suites (the fence, stop, golden, `mod sim_integration` and the full suite) pass unchanged. The existing `send_byte` tests are updated only for the new `conn` argument, and each change is listed.

### TS

- **T-C1: stale results.**
  - A late send result with an old `connId` writes nothing.
  - A late poll result writes nothing.
  - Three late poll rejections do not disconnect the new connection.
  - A late settings `finally` does not touch the new connection's laser mode.
- **T-C2: the gate from snapshot scalars.** This is edge-sensitive: `basisPosition` X=200, bed 205, +10 sends `X5.000` with `jogBasis` equal to the basis seq. Each reason renders its text, with zero invokes.
- **T-C3: every invoke carries `conn`.** This is a single interception of `invoke` for the whole suite (in `setupTests`), not only in the jog tests. Any `serial_*` call without `conn` fails the suite.
- **T-C4: a native refusal is surfaced verbatim as a plain reason,** with no retry.
- **T-C5: reply `<…>` lines never write position.**
- **T-C6: `setMachineHomed(` does not exist** (grep). Homed comes only from snapshots.
- **T-C7: provisional invalidation.**
  - At `emergencyStop()` the arrows disable at once (HOME) with no snapshot. A later snapshot with `homed: false` keeps them disabled.
  - At a motion send's entry they show MOTION at once.
- **T-C8: `settingsGeneration`** bumps on disconnect.
- **T-P1: the panel.** Titles for each reason. The three hold-note causes react to store changes (fake timers) without a remount.

**Reproduce first.** For B1, write N1 (drain and status sites), N5 and N8 against the current behaviour first. N8's trace shows today's stale write, and N5 shows today's stale Idle accepted as the latest snapshot. For B2+B3, write T-C1 and T-C5 first.

### Mutation batteries (one per batch)

Ted writes each `find` from the committed code, and `grep -cF` must be 1 for each. The kills are observable: a byte in the trace, a refusal, or a flag.
- **B1:**
  - the `on_line` bump for Banner, then for Alarm, then for `<Alarm…>` (N1);
  - the pump-error `on_line` (N2);
  - the grant epoch equality (N3);
  - `HomeAxis` grants (N3);
  - the RAII decrement (N6);
  - the barrier drain skipped (N5);
  - the barrier probe replaced by "latest snapshot" (N5);
  - literal Idle becomes idle-like (N7);
  - the MPos requirement (N7);
  - units cleared on a pump error, on a `$13=` write, and on a frame-key write (N10);
  - the motion I/O-error bump (N11);
  - the job-admission `observed = None` (N6).
- **B2+B3:**
  - the conn check (N8);
  - `0x21` stale allowed (N8);
  - `0x18` stale refused (N8, the exception still writes);
  - each admission condition in turn becomes `true` (N4 to N6);
  - the jog written after releasing `submit` (N4: trace order, or the jog written after a STOP);
  - `send_byte` reset not taking `submit` (N4 raw-reset variant);
  - the grammar's newline refusal (N9);
  - the TS stale discard (T-C1);
  - the poll-rejection conn check (T-C1);
  - the in-pump position write restored (T-C5);
  - the gate's `trustObserved` check (T-C2);
  - `jogBasis` omitted (T-C2);
  - the provisional invalidation at `emergencyStop` removed (T-C7).
- **B4:** the reason-title selectors (T-P1).
- **Controls:** B1, `classify_outbound` classifies everything as `Motion` (a positive control on N9's normalisation cases). B2+B3, the gate refuses everything (T-C2's admitted case goes red).

## Verification

- **The full native suite:** `cargo test --features sim`, clippy `--all-targets --features sim -D warnings`, `fmt --check`.
- **The full TS suite:** vitest, tsc, format, lint.
- **Batteries:** every batch battery shows all ids killed, and 0 survived, 0 errored, 0 CONTROL_RED.
- **Browser:** the dev server with `invoke` mocked in the new shapes, exercising the panel states. This is UI evidence only.
- **Owner hardware card: behaviour and barrier qualification.** It makes no frame claims; those are S3e.
  - **Prerequisites:**
    - The panel shows `$21=1` (hard limits) and `$13=0`. Otherwise the card is not run and is recorded INCONCLUSIVE.
    - Laser power isolated.
    - The controller's power switch tested once before the card: switching it off stops a slow console-free Home within 1 s. This is recorded.
  - **Motion rules:**
    - **Every motion on this card is Home, or a relative 1 mm move at F100.** Home is the owner's routine, bounded by the hard-limit switches (`$21=1`). A 1 mm relative move at F100 lasts 0.6 s and travels 1 mm.
    - Before any relative move, measure at least 10 mm of clearance **on both sides** of that axis with a ruler.
    - There are no absolute moves and no Position Laser.
  - **Steps:**
    1. Connect. The arrows are disabled with the Home reason.
    2. Home. While homing, press an arrow: it is refused, and nothing moves afterwards.
    3. After Home, jog +X 1 mm and −X 1 mm, then +Y 1 mm and −Y 1 mm. Each moves 1 mm, and the panel position changes by 1.000 each time.
    4. **Barrier qualification.** Twenty +X 1 mm jogs back-to-back, as fast as the arrows allow. Kerf admits each only after its observation. Afterwards the panel X equals the start + 20.000 within 0.01. Twenty −X then return it. An arrow press that Kerf refused shows the MOTION reason; it does not queue a move.
    5. From the console, `$J=G21 G91 X1 F100`, then press an arrow at once. It is refused until the head stops and the barrier observes.
    6. From the console, `$J=G21 G91 X1 F20` (a 3 s move), then press STOP mid-move. The arrows show the Home reason. Unlock (`$X`): still the Home reason until Home.
    7. Unplug USB and reconnect. The Home reason shows until Home.
  - **Outcomes:**
    - **PASSED:** all seven steps pass. W1/W2 are closed as scoped, and `OBSERVE_QUIESCE_MS` is qualified at its value on this controller.
    - **FAILED:** a fix relay. Step 4 failing means the barrier's assumption is false on this controller. Admission then stays enforced but the barrier is disqualified. The ROADMAP records it, and a follow-up plan raises `Q` or adds a protocol barrier.
    - Frame correctness is S3e.

## Out of scope (indexed in the ROADMAP Parking Lot in this revision's commit, `### Deferred from kerf-safety-motion-trust (2026-09-29)`)

1. **S3e frame qualification.** This is a per-machine frame-qualified state keyed by the S3 bed key. Jogs refuse until its card passes. It is the enforced containment for frame correctness and carries S3c rev 5's frame steps.
   - **Dependency statement:** this plan makes no claim that a jog cannot reach the frame on a mis-framed machine. It claims only what it enforces. Until S3e ships, a frame mismatch is contained by an operating restriction, stated as such.
   - Whether jogs should be refused on every unqualified machine in the meantime conflicts with Lee's 2026-09-10 full-feature ruling. That goes to Lee as a decision at close. It is not made here.
2. **Attestation for `$22=0`.**
3. **Jobs, FRAME and the material test do not require homing** (`canStartJob`, S4c). Jobs are in the ledger only for observation.
4. **Alarm-code discrimination.**
5. **Console motion stays unclipped.** It is counted, and it is refused on a stale connection or a malformed payload. It is not bounded.
6. **`$10` WPos-only controllers lose jogging.**
7. **A protocol-level barrier** (for example `G4 P0` sync), if card step 4 disqualifies the timing barrier on this controller.

## Risks and rollback

- **It touches the native serial layer next to STOP and the fence.**
  - `admit_and_write`, `check_admission` and the stop sequence are unchanged.
  - `submit` is extended to jog writes and to the raw reset bump. It is still held only across one `write()`, or across a counter bump.
  - STOP is never refused, and is delayed at most by one in-progress `write()`, the same bound the fence already accepts.
  - The existing fence and stop tests run unchanged, and N4 adds the new orderings.
- **The observation barrier adds up to about 650 ms per motion before the next jog is admitted.** It also holds `command` for that time, so a console command typed during a barrier waits, as it does during any pump.
- **It is stricter than today:**
  - Home is needed per connection.
  - `$22=0` loses the arrows.
  - WPos-only controllers lose the arrows.
  - A frame-affecting settings write revokes homed.
- **Rollback.** Revert the relay merge on the session branch. Nothing is persisted. B1 alone is safe to keep (it adds no refusal). The operating restriction until corrected code returns: do not use the jog buttons or Position Laser; Home first; move from the console only after the previous move has visibly stopped. That restriction goes on the card and into ROADMAP `next`.
- **Delivery.** No intermediate batch is built or released, and the relay merges once as a whole.

## Decisions

- **Resolved:**
  - kerf-9: jogs refuse until homed.
  - Lee, 2026-09-29: this is one combined job, reviewed until it passes.
- **Applied, flagged at close:**
  - `$22=0` fails closed.
  - Admission is narrowed to mm MPos.
  - A frame-affecting settings write revokes homed.
- **Proposed at close, for Lee's yes (Engineering pins):**
  - (a) Amend the 2026-09-24 fence pin: "…and jog lines and the raw reset/cancel byte share the same critical section."
  - (b) New pin: "A `$J=` jog is written only if the native session admits it inside `submit`: the current connection, a clean home at the current trust epoch, mm units, no pending motion, and a barrier observation since the last motion write, matching the jog's basis. TS clipping is advisory."
- **For Lee at close:** whether jogs refuse on machines whose frame is unqualified until S3e ships. See Out of scope 1.

## Fold table: critic round 1 (astra, FAIL)

| Finding | Verified | Change |
|---|---|---|
| F1: STOP bypasses the jog check | Yes. `send_byte_inner` is realtime-only (`serial.rs:591-605`). STOP takes `submit` and `close_admission`, then writes `0x18` with no `command` | Jog check, count and write happen inside `submit`. The raw reset bumps under `submit`. The lock order is amended. N4 uses deterministic hooks for STOP, raw reset and job begin |
| F2: a read Idle is not an observation | Yes. `read_status_bounded` returns the first frame. In the capture, `Bf:127` shows during Run | The native observation barrier: hold `command`, quiesce `Q`, drain, probe, first frame. The assumption is stated and qualified by card step 4. N5 uses a buffered stale Idle |
| F3: jobs outside the ledger | Yes | Job lines count as motion. Job admission clears `observed` under `submit`. N4 covers job begin during a jog, and N6 covers a short job followed by a jog |
| F4: incomplete invalidation | Yes | `<Alarm…>` status frames, frame-affecting settings keys, `$RST`, a motion I/O error, and units cleared on all writes, errors and absence. N1, N2, N10, N11 |
| F5: identity and grammar not enforced | Yes (`serial_send_inner` writes the string plus `\n`) | `conn` required from B2+B3, refused when missing. `classify_outbound` refuses delimiters and realtime and control bytes, and normalises. N8, N9. T-C3 is a suite-wide interception |
| F6: the card moves through unqualified frames | Yes | Home (switch-bounded, `$21=1` precondition) and relative 1 mm moves at F100 only, with ±10 mm measured clearance. No absolute moves. The power-switch stop is tested before the card. Frame is S3e, with the dependency stated |
| F7: ABI break across batches; deferrals indexed late | Yes | B2+B3 are one releasable batch, with the merge only after B4. The Parking Lot is indexed in this revision's commit |
| F8: tests that pass on false invariants | Yes (N2 was unreachable; N11 was structural) | N2 now uses a Status-then-error path. N4 uses deterministic hooks and asserts byte order. N12 counts six sites exactly. N13 is a lock-rank tracker. Reach is confirmed per mutation |
| F9: UI lags trust changes | Yes | Provisional TS invalidation at motion entry, STOP, reset and refusal (display only). Reason order puts HOME before MOTION. T-C7 |
| X3: "every other write needs command" | Yes, it was false | Removed. The ordering argument now rests on `submit` |
