# Critic: `kerf-safety-motion-trust.md` revision 2 (round 2)

Reviewer: Fable, separate session, read-only. Plan read at `fe947e9`. Every citation below was opened in this worktree: `serial.rs`, `serial_pump.rs`, `serial_session.rs`, `grbl_status.rs`, `connection.ts`, `machineStatus.ts`, `jogBounds.ts`, `jobStream.ts`, `MachinePanel.tsx`, `ROADMAP.md`, `DECISIONS.md`, the facts file, the S3c plan and its five critics, the r1 critic, and `scripts/probe-20260914-153729.log`. No test was run and no hardware was touched.

## Applicability

Project type: safety-critical laser-controller desktop app; Rust serial transport with a shared submission critical section, realtime STOP, connect/disconnect lifecycle, a 250 ms status poller, and a TypeScript operator UI. Tier Architectural.

Core 1-10 active, all GATING.

- **X1 Physical & human safety: FIRES [GATING].** The plan decides when a `$J=` reaches the controller and prescribes powered motion on the owner's machine.
- **X2 Privacy: does not fire.** Controller coordinates and settings only; no personal, client or child record is touched.
- **X3 Evidence & source integrity: FIRES [GATING].** The ordering argument, the barrier's timing claim and the card's outcomes are load-bearing factual claims about the transport and the vendor fork.
- **X4 Audience accuracy: FIRES [ADVISORY].** Operator-facing refusal texts and recovery advice; no money or signature.
- **X5 Concurrency: FIRES [GATING]** (X1-class plan). STOP, raw realtime bytes, job admission, connect/disconnect and the poller all share the new state.
- **X6 Operability: FIRES [ADVISORY].** A released app's field behaviour changes.
- **X7 Self-modification: does not fire.** Kerf's controls, not MARVIN's gates or hooks.
- **X8 Dependencies, performance & cost: FIRES [ADVISORY].** The barrier holds `command` for up to Q + 500 ms and the poller stacks.

## Dimension verdicts

| # | Dimension | Verdict | One line |
|---|---|---|---|
| 1 | Problem-fit | **PASS** | Intent present and traced to kerf-9, Lee 2026-09-29 and the coordinator's option (a). Extends the 2026-09-24 fence pin by proposed amendment, does not contradict it. W1/W2 closure is scoped; frame is S3e with the dependency stated. |
| 2 | Approach soundness | **PASS** | The submit-shared check-count-write is the same mechanism the fence already proves for job lines, and it is correct for jogs (F1 below). The native barrier is a real post-motion observation under one stated, card-qualified assumption (F2). |
| 3 | Completeness | **CONCERN** | The barrier's re-run predicate is undefined ("None or stale"; a non-Idle observation is neither), so a motion longer than Q leaves the arrows locked (F3). Grammar does not normalise inner whitespace as GRBL does (F5). Disconnect's `conn_id = 0` is described as "under `command`" but the teardown at `serial.rs:443-452` holds no lock across it (F6). |
| 4 | Right-sizing & reuse | **PASS** | B2+B3 waiver stated with the reason; the seven deferrals are in `ROADMAP.md:667-668` and `:1042-1054` at `fe947e9`, verified. Reuses `submit`, `ScriptedPort`, the S3 clip and texts. |
| 5 | Security | **CONCERN** | The IPC boundary is now enforced (required `conn`, refused delimiters and realtime bytes). The `Jog` class is decided on trimmed text only; GRBL deletes every byte ≤ 0x20 before parsing, so `$ J=…` is a jog to the controller and `Motion`/`Other` to Kerf (F5). |
| 6 | Failure modes | **PASS** | Pump `Err` after a motion write bumps the epoch; STOP's `SubmissionFailed` still closes admission and bumps; poison recovered; a `$$` that errs clears units. Every failure path ends refused. |
| 7 | Change safety | **PASS** | B1 alone adds no refusal; no intermediate batch is built; rollback is a merge revert plus a stated operating restriction on the card and in `next`. |
| 8 | Data integrity & compatibility | **FAIL** | The observation/basis contract between native and TS is incoherent: under the plan's own definition of the snapshot's `observed` flag, either the arrows are live for one poll only, or `jog_basis` drifts and every jog is refused `stale-basis` (F4, trace given). |
| 9 | Verifiability | **CONCERN** | N12's six sites are exactly the six in the tree (`serial_pump.rs:184,315,371,638`, `serial.rs:259,1081`), verified. N4's hooks are deterministic if the hook waits (stated below). N8 as written cannot run: disconnect needs the very `command` lock the test is holding (F7). |
| 10 | Maintainability | **CONCERN** | The lock-order amendment omits `realtime → trust` (needed if `send_byte`'s conn check is to be atomic with the handle) and the `send_byte` doc invariant ("touches ONLY the realtime lock", `serial.rs:593-595`) becomes false for `0x18`/`0x85`. "TS clipping is advisory" (pin b) misdescribes the only clip there is. |
| X1 | Physical & human safety | **CONCERN** | Every control path, including STOP failure, unconfirmed stop, I/O error and reconnect, ends in refusal. The card is bounded (Home, 1 mm at F100, ±10 mm measured, power-switch test first). One arithmetic gap: step 4 commits 20 mm cumulative on +X under a 10 mm clearance rule (F8). |
| X3 | Evidence & source integrity | **CONCERN** | The statement "the busy-path `?` cannot run during the barrier" is false: the poller is `setInterval` without await (`connection.ts:474`), so the next tick `try_lock`s while the barrier holds `command` and takes the busy branch (`serial.rs:629-644`). Benign for the observation, but the ordering argument must not lean on it (F2). "Disconnect teardown (under `command`)" is not what the code does (F6). Everything else cited checks out, including `Bf:127` during Run at capture line 68. |
| X4 | Audience accuracy | **PASS** | HOME precedes MOTION; the hold-note texts are the S3c rev 5 texts with the quit advice correctly replaced by reconnect now that N8 enforces identity. |
| X5 | Concurrency & re-entrancy | **CONCERN** | STOP, raw reset, job begin and connect/disconnect are all linearised against the jog write by `submit` or `command`: sound. Two gaps: `send_byte`'s conn check is not stated atomic with the realtime handle it writes (TOCTOU across a reconnect; consequence limited to `!`, `~`, `?` reaching a freshly reset controller), and the point at which `motion_pending` increments (before or after the `command` wait) is unstated, though N6 only means something if it is before (F6). |
| X6 | Operability | **PASS** | Refusal reasons are named and surfaced verbatim; the hold note names its cause; `observed` and `homed` are visible on the snapshot. |
| X8 | Performance & cost | **PASS** | Q + 500 ms bound is stated; with the probe read returning on the first frame the real cost is ~Q + one round trip (≈50 ms on the capture). Stacked polls add harmless extra `?` bytes. |

## Load-bearing mechanisms, judged

**The `submit`-shared jog check-and-write. Sound.** Jog: `command` → `submit` → `trust` (check, count, `observed = None`) → release `trust` → `write_all` under `submit` → release. STOP: `submit` → `close_admission` + epoch bump → release → `0x18` under `realtime`. Raw `send_byte(0x18|0x85)`: `submit` → bump → release → write. Job begin: `submit` → `observed = None` → `admitted_job`. Every schedule either finishes the jog's single `write()` before the invalidating side takes `submit` (jog bytes precede `0x18` on the one tty queue, the fence's own premise), or the invalidating side runs first and the jog sees `stopping`, `homed_at != trust_epoch` or `job-active`. STOP is delayed by at most one `write()`, as today. Connect and disconnect need `command`, which the jog holds, so the stale-`conn` check is stable. This closes r1 F1.

**The native observation barrier and its timing assumption. Sound, with one false supporting claim and one undefined predicate.** The argument that actually holds: any status frame arriving after the drain was generated after the quiesce began, which is ≥ Q after the motion's terminal was read; under the assumption (fork starts the cycle within Q of `ok`, reply within 500 ms), that frame reflects a started or finished cycle. The capture supports Q = 150: `G0` `ok` at 6156.4 ms, `?` at 6157.6, `<Run|MPos:1.275…>` at 6207.9, so the cycle was under way within ~50 ms of `ok` on this fork. The claim that the busy path cannot fire during the barrier is wrong (X3 above), but any busy `?` sent during the barrier was sent after the quiesce began, so its reply is also post-quiesce; the conclusion survives, the premise does not. The undefined part is what happens when the barrier observes Run/Jog: see F3.

**Trust invalidation completeness. Sound.** Banner, ALARM line, `<Alarm…>` on every read path (six sites, exact), STOP, raw reset/cancel, home start, frame keys, `$RST`, motion I/O error, connect, disconnect, and units cleared on every settings write, error and absence. I looked for a missing event and found none that moves the head without an entry: `$X` does not move; door parking and dwell keep MPos; a `$N` startup block after `$H` runs inside the `$H` command and is caught by the post-`$H` barrier; the wedge (Idle-stall `Err`) bumps. `0x85` bumping the epoch (forcing a re-home after a jog cancel) is stricter than GRBL requires, but no TS path sends `0x85` (grep: none outside the sim), so it costs nothing today.

**Enforced connection identity. Sound at the line boundary; under-specified at the realtime boundary.** `conn` required on `serial_send` and `serial_get_status`, checked under `command`, which is the lock connect and disconnect also need. The parked-send hazard from the facts file is closed. `send_byte(conn, b)`'s check has no stated lock relationship to the `realtime` handle it writes (F6).

**Outbound grammar. Sound for what it refuses; incomplete for what it classifies.** Refusing `\r`, `\n`, control bytes, ≥ 0x7f and `?`/`!`/`~` closes the two-commands-in-one-payload hole. Classification on trimmed text misses GRBL's whitespace deletion (F5). Note also that this grammar now runs on job lines: `jobStream.ts:339` filters `;` lines but does not trim, and any ≥ 0x7f byte in a code line would refuse the job mid-stream (fail-closed, but a regression surface to check against the generator's goldens).

**B2+B3 atomic delivery. Sound.** One releasable unit, merge only after B4, ABI break and callers together. Verified that all `serial_send` callers are in `connection.ts` (`:616`, `:932`, `:963`) and per-line job lines route through `machineConnection.send()` (`jobStream.ts:363`), so the file list covers every caller of the changed shapes.

**The hardware card's containment. Sound, with one arithmetic gap.** The power-switch test before any motion, laser isolation, Home only as the owner already homes, 1 mm at F100 (0.6 s, 10× scale margin against ±10 mm measured), no absolute moves, and the STOP step at F20. Step 4's cumulative travel exceeds the clearance rule as written (F8). Frame correctness is deferred with an honest dependency statement; nothing in this plan claims it.

## Findings

### F1 (closed from r1) — STOP, raw reset and job begin now share the jog's critical section

Verified against `serial.rs:1001-1004` (STOP takes `submit` for `close_admission`), `:596-605` (`send_byte_inner` realtime-only today), `:1154-1174` (job begin takes `admitted_job` only today). The plan's design puts all three behind `submit` for their state change and keeps every write outside it except the jog's one `write_all`. Sound. N4's three variants are the right tests; the hook must **wait** for the other thread's operation to complete or time out before returning, otherwise the "jog written after releasing `submit`" mutant is only killed by luck (see F7).

### F2 (mostly closed from r1) — the barrier is real; correct its supporting claim

Plan lines 149-154. Replace "The busy-path `?` cannot run during the barrier" with the true statement: the poller's next tick will take the busy branch while the barrier holds `command`, and that is harmless because its `?` is sent after the quiesce began, so its reply is post-quiesce like every other frame the barrier can read. Keep the assumption and card step 4 as the qualifier. Also state that a frame whose first bytes were in `pending` at the drain (partial line) is discarded rather than completed and used, or show it is covered by the same assumption (it is, if the fork emits its post-`ok` report within Q).

### F3 — the barrier's re-run predicate is undefined, and the plausible reading locks the arrows

Plan line 141: the barrier runs "when the command lock is free and `observed` is `None` or stale." Line 147 builds an observation from whatever frame arrives, `idle_mpos` true or false. Trace: console `$J=G21 G91 X1 F100` (card step 5, 0.6 s) or any `G1` longer than Q. The pump returns `ok` at T. Poll at T+~200 runs the barrier: quiesce satisfied, probe, frame `<Jog|MPos:…>` → `observed = Some{idle_mpos: false, after_writes == motion_writes, epoch current}`. That observation is not `None`, and it is not stale by any test the plan names (`conn_id`, `trust_epoch`, `after_writes` all match). No later poll re-runs the barrier; ordinary polls report Idle but never produce a barrier observation; every jog is refused `not-observed` until the next motion write clears `observed`, which only a jog could make, which is refused. Card step 5 says "refused until the head stops and the barrier observes"; as specified it is refused for ever. Fix: define stale as `o.conn_id != conn_id || o.trust_epoch != trust_epoch || o.after_writes != motion_writes || !o.idle_mpos`, and say the barrier re-runs on every poll while the observation is not Idle (cost ≈ drain + one round trip per poll, since the quiesce is already satisfied).

### F4 — the observation/basis contract between native and TS does not work under either reading (dimension 8 FAIL)

Plan lines 181 and 189-195: the snapshot's `observed` "is true only on the frame the barrier produced and while `observed` is still current"; TS sets `trustObserved` when "the latest snapshot has `observed: true`" and `basisSeq` to "that snapshot's `seq`"; native requires `o.seq == jog_basis`.

Reading A (flag belongs to the frame): the barrier frame at poll k carries `observed: true`, seq s. Poll k+1, 250 ms later, is an ordinary read (`observed` is current, so no barrier); `serial_get_status_inner` returns `read_snapshot()`, the latest frame, seq s+1, `observed: false`. TS: `trustObserved = false`, the gate shows MOTION. The arrows are enabled for one 250 ms window after every motion. Card steps 3 and 4 fail deterministically.

Reading B (flag belongs to the session state, true on every frame while the observation is current): poll k+1's frame has `observed: true`, seq s+1; TS sets `basisSeq = s+1`; the jog sends `jog_basis = s+1`; native has `o.seq == s` → refused `stale-basis`. Every jog not pressed inside the first poll window is refused.

Fix (one paragraph): the snapshot carries `observedSeq: Option<u64>` and `observedPos: Option<[f64;3]>` copied from the current native observation (None when `observed` is None); TS derives `trustObserved = observedSeq !== null`, `basisSeq = observedSeq`, `basisPosition = observedPos`, and clips from `basisPosition` only. Then any frame while the observation is current carries the same basis, and a cleared observation is visible on the next frame. T-C2 should then assert that a second ordinary snapshot after the barrier frame leaves the arrows enabled and the sent `jogBasis` equal to the barrier's seq.

### F5 — the grammar must normalise as GRBL does before classifying

Plan lines 91-107. GRBL 1.1's line reader discards every byte ≤ 0x20 (and `/`) before `protocol_execute_line`, which is why `normalizeGrblLine` in `connection.ts:99-108` does the same. `classify_outbound` works on "trimmed, upper-cased text", so `$ J=G91 X200 F3000` is not `Jog`. It does fall to `Motion` by the axis-word rule, so it is counted and clears `observed` (no basis hole), but it is written with no jog admission: no home, no units, no clip, from the console. That is inside the console-motion policy (Out of scope 5), so it is not a broken invariant, but a "Jog" class that depends on spacing is a gate that depends on spacing. Fix: delete every byte ≤ 0x20 (already refused below 0x20; so delete spaces) and `/` before classification, exactly as `normalizeGrblLine`; add `$ J=G91 X1` and `$J =G91X1` to N9's Jog set. Also add `$N<n>=` to the settings-write class (it is EEPROM and runs after every reset), clearing units like any other write.

### F6 — three lock-placement statements are wrong or missing

1. Plan line 127: "Disconnect teardown (under `command`, `serial.rs:443-452`)". The teardown is two statements whose guards are temporaries; nothing is held across them, and the epoch bump at `:460` is after both. The plan's `conn_id = 0` must be written while `command` is held (a scoped guard around the `None` store), or state that it need not be because a send that acquires `command` between disconnect and connect sees `None` and a send after connect sees the new `conn_id`. Either is fine; the citation as written is not.
2. `send_byte(conn, b)`: state where `conn_id` is read relative to `realtime`. To be atomic with the handle it must be read while holding `realtime`, which is `realtime → trust`, absent from the amended order. It does not cycle (nothing holds `trust` and waits on `realtime` or `submit`), so add it to the table. Consequence if left as a pre-check: `!`, `~` or `?` from the old connection can reach the new controller after a reconnect, which connect has just reset. Low, but the table should say what is and is not atomic.
3. `motion_pending += 1` "on entry": say explicitly that it happens after `classify_outbound` and before the `command` wait, under `trust`, with the RAII guard living for the whole call. Otherwise N6's "two concurrent motion sends" case is unreachable (sends serialise on `command`, so `motion_pending` would never exceed 1).

### F7 — two tests as written cannot run the schedule they describe

- **N8**: "parked on `command` (the test holds the lock), then disconnect and reconnect run, then the lock is released." `disconnect_inner_with_job` takes `command` (`:444-447`) and `serial_connect_inner` takes it (`:342-345`); neither can run while the test holds it. The property that matters is check-under-lock, which is order-independent: run disconnect + reconnect uncontended, then `serial_send(conn = old)`, assert refusal and zero bytes on the new port's trace; and separately `serial_send(conn = old)` parked behind a scripted pump, with the reconnect completing before the pump's terminal is delivered. Same for `send_byte(0x21, old)` and `serial_get_status(old)`.
- **N4**: the `#[cfg(test)]` hook must block until the spawned STOP / raw reset / job begin has either completed or been observed parked on `submit` for a bounded time (the `assert_stop_parked_behind_write` pattern at `serial.rs:3716` exists for this). Without that, the mutant that writes after releasing `submit` survives whenever the jog thread wins the race.

### F8 — card step 4's clearance arithmetic

Plan lines 347-348 and 354. The motion rule requires ≥ 10 mm measured clearance on both sides before any relative move; step 4 commits twenty +X 1 mm moves, 20 mm cumulative, and step 3's ruler check cannot distinguish a 1 mm move from a 2 mm one. State the step 4 prerequisite explicitly: ≥ 60 mm measured clearance on +X before the first press (20 mm × 2 scale margin + 20 mm), which is trivially true at the home corner on a 400 mm bed but must be written and measured, and the same for the twenty −X returns (which end at the start point, so the −X side needs ≥ 20 mm beyond it). Everything else on the card is bounded as stated.

### F9 (minor) — wording and doc debts

- Pin (b): "TS clipping is advisory" reads as if native also clips. It does not. Say: "the clip is computed in TS from the basis native names; native verifies the basis, the home, the units and the observation, not the geometry."
- `serial.rs:593-595` doc invariant and the `realtime_write_completes_while_command_lock_held` pin: still true for `!`, `~`, `?`; amend the comment for `0x18`/`0x85` (bounded by one `write()` under `submit`, the fence's own bound).
- The grammar on job lines: add a golden that every committed job fixture passes `classify_outbound` line by line, so a generator change that emits a tab or a non-ASCII byte turns a test red rather than refusing a job at the bench.

## Verification of the r1 fold

| r1 | Claimed closed by | Verified? |
|---|---|---|
| F1 STOP bypasses the check | `submit`-shared check/count/write; raw reset bumps under `submit`; N4 | **Yes.** Mechanism sound (F1 above). N4 hook needs to wait (F7). |
| F2 read Idle is not an observation | native barrier; N5 | **Mostly.** Barrier sound under the stated assumption; false supporting claim (F2); re-run predicate undefined (F3); basis contract to TS broken (F4). |
| F3 jobs outside the ledger | job lines count; job begin clears `observed` under `submit`; N4/N6 | **Yes.** Per-line and buffered lines both pass `admit_and_write`; job begin serialised behind the jog write. |
| F4 incomplete invalidation | `<Alarm…>`, frame keys, `$RST`, motion I/O error, units cleared everywhere | **Yes.** No missing head-moving event found. |
| F5 identity and grammar | required `conn`; `classify_outbound`; N8/N9; T-C3 | **Partly.** Line boundary enforced; realtime boundary lock placement unstated (F6); whitespace normalisation missing (F5). |
| F6 card through unqualified frames | Home + 1 mm F100 + measured ±10 mm + switch test; frame to S3e | **Yes**, with the step 4 arithmetic to state (F8). |
| F7 ABI across batches; late deferrals | B2+B3 one unit; Parking Lot at `fe947e9` | **Yes.** Both verified in the tree. |
| F8 tests on false invariants | N2 Status-then-error; N4 hooks; N12 six exact; N13 rank tracker | **Mostly.** N2 reachable; N12 count matches the tree; N8 unschedulable as written (F7). |
| F9 UI lags trust | provisional invalidation; HOME before MOTION; T-C7 | **Yes.** |
| X3 "every other write needs command" | removed | **Yes**, and a new false premise took its place (F2), benign this time. |

## Stress test 1 — Pre-mortem

Three months out, the type-specific worst case is a head moving when the operator believed Kerf would not let it.

1. **The arrows are inert, so the owner moves from the console.** F3 and F4 land as specified: after every motion the panel shows MOTION for ever (F3) or for all but one poll (F4). The owner learns that the arrows never work and types `$J=` and `G1` into the console, which is unclipped by policy. The safety gate is technically intact and practically bypassed by design. We should have seen it at card step 3.
2. **A reconnect after a wedge and a `~` from the dead connection.** The old connection's `cycleResume` invoke is parked; the reconnect resets the controller; the `~` reaches it. Nothing is queued, so nothing moves, but the trace has a byte on the new port that the plan's N8 said could not be there. The tests pass because the realtime check is a pre-check (F6.2).
3. **Card step 4 on a machine whose `$100` is half what the panel says.** Step 3's 1 mm moves look like 1 mm to a ruler; step 4's twenty moves travel 40 mm. At the home corner that is fine; on any other start point the card did not say to measure 60 mm (F8).

## Stress test 2 — Load-bearing assumptions

- **The fork starts a cycle within Q = 150 ms of `ok` and answers `?` within 500 ms.** Confidence: medium-high; the capture shows motion under way within ~50 ms of `ok` (lines 65-68) and every `?` answered in ~50 ms. Consequence if wrong: a stale Idle becomes the basis and a clip is computed from a pre-motion position. Named, qualified by card step 4, with the fallback (Parking Lot 7) indexed. Acceptable.
- **Both handles are one tty output queue, so `write()` order is wire order.** Confidence: high, inherited from the fence pin and its evidence. Consequence if wrong: jog bytes after `0x18`. Not new to this plan.
- **All `serial_send` callers pass through `connection.ts`.** Confidence: high, verified by grep (`connection.ts:616,932,963`; job lines via `send()` at `jobStream.ts:363`). Consequence if wrong: a caller refused for a missing `conn`; T-C3 catches it.
- **The snapshot's `observed` fields as specified let TS build a stable basis.** Confidence: contradicted by the plan's own text (F4). Resolve before implementation.

## Stress test 3 — Inversion

A TS-owned trust model wins only if TS sees every invalidating byte and owns every write boundary; the facts file and r5 already showed it does not, so the native owner stands. A protocol barrier (`G4 P0` sync) wins over the timing barrier only if step 4 fails; that is indexed and not yet true. Refusing jogs on every unqualified frame until S3e wins only if Lee reverses the 2026-09-10 full-feature ruling; the plan routes that to him correctly. Holding `trust` across the jog write (rejected implicitly) wins only if `submit` were not available; it is, and it already carries the fence's latency bound, so the rejection is right.

## Overall verdict

**FAIL, on one core dimension, with the safety mechanisms sound.** Revision 2 does what round 1 asked: the jog's check, count and write sit inside the fence's own critical section, STOP and the raw reset are serialised behind it, jobs are in the ledger, the observation is taken natively after a quiesce and a drain, identity is enforced at the line boundary, the grammar refuses split payloads, the batches are honest and the deferrals are indexed. I found no schedule that lands a `$J=` after `0x18`, admits one from a stale basis, or grants trust across a reset or reconnect. What fails is the contract that carries the observation to the operator: as written, `observed`/`basisSeq` cannot both keep the arrows live and match native's basis (F4), and a motion longer than Q leaves the barrier never re-run (F3). Both make the shipped feature inert rather than dangerous, both are one paragraph each to fix, and the card's steps 3-5 would show them on the first press. The rest is P1 precision: normalise the grammar as GRBL does, pin the two lock placements, make N8 and N4 schedulable, and write step 4's clearance down.

## Prioritised must-fix

1. **P0 (F4, dim 8):** put `observedSeq`/`observedPos` on the snapshot from the native observation; TS derives `trustObserved`, `basisSeq`, `basisPosition` from them; T-C2 asserts a second ordinary snapshot keeps the arrows enabled and the sent basis equal to the barrier's seq.
2. **P0 (F3, dim 3):** define "stale" to include `!o.idle_mpos`; the barrier re-runs on every poll while the observation is not Idle.
3. **P1 (F5):** `classify_outbound` deletes every byte ≤ 0x20 and `/` before classifying, like `normalizeGrblLine`; `$N<n>=` is a settings write; N9 gains the spaced `$ J=` cases.
4. **P1 (F6):** fix the disconnect citation and hold `command` across `conn_id = 0`; state `send_byte`'s conn check as `realtime → trust` and add it to the order table; pin `motion_pending`'s increment before the `command` wait.
5. **P1 (F7):** rewrite N8 as an uncontended reconnect followed by the stale send, plus the parked-behind-a-pump variant; make N4's hook wait on the parked operation.
6. **P1 (F2, X3):** replace the "busy path cannot run" sentence with the post-quiesce argument; say what happens to a partial line left in `pending` at the drain.
7. **P1 (F8, X1):** card step 4 states and measures ≥ 60 mm on +X before the first press and ≥ 20 mm on −X beyond the start.
8. **P2 (F9):** pin (b) wording; `send_byte` doc invariant; a golden that job fixtures pass the grammar.
