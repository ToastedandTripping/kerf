# Critic: `kerf-safety-motion-trust.md` revision 3 (round 3)

Reviewer: Fable, separate session, read-only. Plan read at `5e39f3f`. Job for this round: verify each round-2 must-fix is closed, and hunt for what the fold introduced. Settled points are not re-litigated. Every citation below was opened in this worktree: `serial.rs` (lock table `:1-40`, connect `:276-352`, disconnect `:430-462`, `send_byte_inner` `:591-605`, busy path `:629-644`, stop `:993-1011`, stop read `:1070-1095`, job begin `:1154-1174`, `wait_stop_entered` / `assert_stop_parked_behind_write` `:3706-3728`), `serial_pump.rs` (`:184`, `:307-330`, `:356-390`, `:638`), `serial_session.rs` (struct `:155-182`, `close_admission` `:280`), `grbl_status.rs:96-118`, `connection.ts` (`:99-108`, `:433-560`, `:590-680`, `:920-975`), `jobStream.ts:339-363`, `DECISIONS.md` (2026-09-24 fence pin, 2026-09-10 full-feature ruling), `ROADMAP.md:667-668,1042-1054`, the S3c plan's `isMotionCommand` rule (`kerf-safety-s3c.md:171-174`), and the r1/r2 critics. No test was run and no hardware was touched.

## Applicability

Project type: safety-critical laser-controller desktop app; Rust serial transport with a shared submission critical section, realtime STOP, connect/disconnect lifecycle, a 250 ms status poller, and a TypeScript operator UI. Tier Architectural.

Core 1-10 active, all GATING.

- **X1 Physical & human safety: FIRES [GATING].** The plan decides when a `$J=` reaches the controller and prescribes powered motion on the owner's machine.
- **X2 Privacy: does not fire.** Controller coordinates and settings only; no personal, client or child record.
- **X3 Evidence & source integrity: FIRES [GATING].** The barrier's timing argument and the lock-placement claims are load-bearing facts about the transport.
- **X4 Audience accuracy: FIRES [ADVISORY].** Operator-facing refusal texts; no money or signature.
- **X5 Concurrency & re-entrancy: FIRES [GATING]** (X1-class plan).
- **X6 Operability: FIRES [ADVISORY].** A released app's field behaviour changes.
- **X7 Self-modification: does not fire.** Kerf's controls, not MARVIN's gates or hooks.
- **X8 Dependencies, performance & cost: FIRES [ADVISORY].** The barrier holds `command` for up to Q + 500 ms and now re-runs on every poll while the head is not Idle.

## Round-2 must-fix verification

| r2 | Claimed closed by (rev 3) | Verified in the plan text and the tree? |
|---|---|---|
| 1. P0 F4 (dim 8): observed/basis contract | `observedSeq` / `observedPos` on the snapshot (line 184); TS derives `trustObserved`, `basisSeq`, `basisPosition` (196-200); T-C2 second-snapshot assertion (297) | **Closed for the contract.** Any frame published while an observation is current carries the barrier's seq, so reading A (one-poll arrows) and reading B (basis drift) are both gone. **One hole the fold opened:** `Observation` (line 84) has no position field, so there is nothing to copy `observedPos` from (F1 below). |
| 2. P0 F3 (dim 3): re-run predicate | Stale includes `!o.idle_mpos`; re-runs every poll until Idle (143) | **Closed.** Traced the card step 5 case: `<Jog…>` observation → stale on the next poll → barrier again → Idle → `observedSeq` set. Cost per re-run is a drain plus one round trip, as stated. Side effect worth knowing, not a defect: while the controller sits in Alarm, every poll's `<Alarm…>` frame bumps the epoch (line 123), so the barrier re-runs every 250 ms until the operator homes. That is one drain plus one `?` per poll, which is what a poll costs today. |
| 3. P1 F5: grammar normalisation, `$N` | Bytes ≤ 0x20 and `/` deleted, upper-cased (97); `$N<n>=` a settings write (101); N9 cases (275) | **Half closed.** Spaces and `/` are handled. `normalizeGrblLine` (`connection.ts:99-108`) and GRBL's line reader also strip `(…)` and `;…` comments before anything else, and the plan's own `Motion` rule (ported from S3c, `kerf-safety-s3c.md:174`) strips them too, but the `Jog` class does not (F2 below). |
| 4. P1 F6: disconnect citation; `send_byte` atomicity; `motion_pending` placement | Scoped `command` guard around the `None` store (127); `conn_id` read under `realtime`, `realtime → trust` in the order (179); increment after classify, before the `command` wait (134) | **Closed.** All three checked against `:443-452`, `:596-605` and the lock table. The new edges do not cycle: nothing holds `trust` and waits on `realtime`, `submit` or `command`; `send_byte(0x18)` takes `submit → trust` and releases before `realtime → trust`. One wording nit: line 88's chain lists `admitted_job` below `snapshot`; both are leaves under `trust`, which is what matters and what line 88 also says. |
| 5. P1 F7: N8 and N4 runnable | N8 two schedules (271-274); N4 hook waits on the parked STOP via the `:3716` pattern (257) | **N4 closed; N8 half closed.** The uncontended schedule is right. The "in flight" schedule (line 273) cannot run: reconnect needs `command` (`serial_connect_inner`, `:342-345`, and `disconnect_inner_with_job`, `:444-447`), and the scripted pump the send is parked behind holds `command` until its terminal, so "the reconnect completes before that pump's terminal is delivered" is impossible. This is my own round-2 suggestion, and it was wrong (F3 below). |
| 6. P1 F2 (X3): busy path; partial line | Restated as post-quiesce (156); partial line "covered by the same assumption" (157) | **Busy-path closed. Partial-line argument is wrong.** A line partially in `pending` when the drain begins was, by definition, generated *before* the drain began, not after (F4 below). The conclusion survives with a smaller margin; the sentence does not. |
| 7. P1 F8 (X1): card step 4 clearance | ≥ 60 mm on +X, ≥ 20 mm on −X, before the first press (362) | **Closed.** Arithmetic as asked. |
| 8. P2 F9: pin (b) wording; `send_byte` doc invariant; fixture grammar golden | — | **Not folded and not acknowledged.** Pin (b) still reads "TS clipping is advisory" (line 410); the `serial.rs:593-595` invariant comment is not mentioned; no golden runs the job fixtures through `classify_outbound`; the round-2 fold table (428-440) has no F9 row (F5 below). |

## Dimension verdicts

| # | Dimension | Verdict | One line |
|---|---|---|---|
| 1 | Problem-fit | **PASS** | Unchanged from r2: intent traced, extends the 2026-09-24 fence pin by proposed amendment, W1/W2 scoped, frame to S3e. |
| 2 | Approach soundness | **PASS** | The submit-shared jog write, the native barrier and the native identity are unchanged mechanisms; the fold changed only the basis contract, the stale predicate and lock placements, all of which now hold. |
| 3 | Completeness | **CONCERN** | `Observation` carries no position, yet the snapshot's `observedPos` and TS's `basisPosition` are copied from it (F1). `settled: false` (line 147) names a snapshot field that does not exist (`grbl_status.rs:99-118`) and is not in the snapshot field list at line 184. |
| 4 | Right-sizing & reuse | **PASS** | Waiver and Parking Lot unchanged and re-verified at `5e39f3f` (`ROADMAP.md:667-668`, `:1042-1054`). Advisory: which batch carries `classify_outbound`'s refusal is unstated; B1's "adds no refusal" is true only if the grammar ships in B2+B3. Moot under the merge rule, but say it. |
| 5 | Security | **CONCERN** | The IPC boundary is enforced. The `Jog` class is still syntax-sensitive: `(a)$J=G91 X50 F3000` is a jog to GRBL and `Motion` to Kerf, so it is written from the console with no jog admission (F2). Not a FAIL: the only actor is the operator at the console, who may already type `G0 X50` by policy (Out of scope 5). But it falsifies line 32 and pin (b) as worded, so it must be fixed before that pin is written. |
| 6 | Failure modes | **PASS** | Unchanged from r2; every failure path still ends refused. |
| 7 | Change safety | **PASS** | Unchanged. |
| 8 | Data integrity & compatibility | **PASS** | The r2 FAIL is closed: the basis travels on every frame as `observedSeq`/`observedPos`; cleared observations show on the next frame; T-C2 pins the second-snapshot case. |
| 9 | Verifiability | **CONCERN** | N4 is now deterministic for STOP (`wait_stop_entered` + `assert_stop_parked_behind_write` exist at `:3706-3728`), but the raw-reset and job-begin variants have no equivalent "entered" flag to wait on (F3). N8's in-flight schedule cannot run (F3). |
| 10 | Maintainability | **CONCERN** | The P2 doc debts were dropped without a note (F5). Lock-order chain wording (line 88) lists two leaves in sequence. N13's rank tracker names `submit`, `trust`, `snapshot` only; the new `realtime → trust` and `command → … → trust` edges are outside it. |
| X1 | Physical & human safety | **PASS** | Every path ends refused; card bounded; step 4 arithmetic fixed. The F2 console input moves the head only by the same means the console already permits. |
| X3 | Evidence & source integrity | **CONCERN** | The busy-path claim is now true. The partial-line sentence ("it was generated after the drain began, since the drain consumed every complete line") is false as reasoning (F4). The disconnect citation is now accurate. The `Bf:127` and capture claims stand from r2. |
| X4 | Audience accuracy | **PASS** | Unchanged. Advisory: the UNITS text should tell the operator that a `$$` restores the arrows after any settings write, because a console `$32=0` clears units natively and nothing re-reads until a `$$` (`connection.ts:604-621` invalidates TS settings but sends no readback). |
| X5 | Concurrency & re-entrancy | **PASS** | The two r2 gaps (`send_byte` atomicity, `motion_pending` placement) are closed. Re-traced: double arrow press (A holds `command`, B parked, `motion_pending == 2`) refuses A `motion-pending` and admits B against the still-current observation; conservative and correct. STOP during a barrier: `submit` and `realtime` are free, the stop's banner read `try_lock`s `command` and skips; the barrier's next frame is a banner or `<Alarm…>`, bumping the epoch. |
| X6 | Operability | **PASS** | Unchanged. |
| X8 | Performance & cost | **PASS** | Re-run cost bounded and stated. During a long console `G1`, each poll now holds `command` for a drain plus one round trip (~50 ms on the capture) rather than the busy path's zero; a console command typed mid-move waits that long. Stated at line 390. |

## Findings

### F1 — `Observation` has no position, so `observedPos` has no source (dim 3)

Line 84: `Observation { conn_id, trust_epoch, after_writes, seq, idle_mpos }`. Line 149 builds it from the frame and records four scalars and `idle_mpos`. Line 184: `observedPos: Option<[f64;3]>` is "copied from the current native observation". Line 200: the clip reads `basisPosition` only. There is nothing to copy. Ted will discover it at the first compile, but the plan is the spec and the r2 fix depended on it. Fix: add `mpos: [f64; 3]` to `Observation`, set from the barrier frame's `position` at step 5 (only when `idle_mpos`), and copy it to `observedPos`. While there: `settled` (line 147) is not a `GrblSnapshot` field; either add it to the line-184 list or drop the word and say the drained statuses are published as ordinary snapshots.

### F2 — the `Jog` class is comment-sensitive; pin (b) is false on one console input (dim 5, must fix before the pin is written)

GRBL 1.1's `protocol_main_loop` sets a comment flag on `(` (cleared on `)`) and on `;` (to end of line), and drops those bytes before the line is executed, for `$` lines as much as G-code; `normalizeGrblLine` (`connection.ts:99-108`) mirrors that, and S3c's `isMotionCommand` rule the plan ports for `Motion` "strip[s] `(…)` and `;…` comments first" (`kerf-safety-s3c.md:174`). Line 97 deletes only bytes ≤ 0x20 and `/` before classifying `Jog`. Input: `(a)$J=G91 X50 F3000` from the console. To GRBL it is `$J=G91X50F3000`, a jog. To Kerf it is `(A)$J=G91X50F3000`, which is not `$J=…`, falls to `Motion` by the axis-word rule, is counted and clears `observed`, and is written with no home, no units, no observation and no basis check. Line 32 ("A `$J=` jog is written only when all of these hold") and proposed pin (b) are both false for it.

Why not FAIL: the actor is the operator at the console, and Out of scope 5 already lets the console move the head unclipped and unhomed with `G0 X50`. No new capability, no new path for the TS jog buttons, STOP ordering unaffected. But a DECISIONS pin that is false on day one is worse than no pin. Fix: normalise exactly as `normalizeGrblLine` does, comments included, before classifying; add `(a)$J=G91X1` and `$J=G91X1;(b)` to N9's Jog set and `;$J=G91X1` to the Other set. Alternative: refuse `(` and `;` in any `$`-line as `malformed` (GRBL accepts them, but nothing Kerf sends needs them).

### F3 — N8's in-flight schedule cannot run; N4's two non-STOP variants have nothing to wait on (dim 9)

- **N8 in flight** (line 273): the send is "parked behind a scripted pump. The reconnect completes before that pump's terminal is delivered." A pump holds `command` until its terminal (`run_pump` is called under the `serial_send_inner` guard). Disconnect takes `command` at `:444-447` and connect at `:342-345`. Neither can complete while the pump holds it, so the schedule is a contradiction. This was the round-2 suggestion, and it was wrong. The runnable form: park the send at a `#[cfg(test)]` hook placed after `classify_outbound` and the `motion_pending` increment and **before** the `command.lock()` call; with `command` free, run disconnect and reconnect to completion; release the hook; the send acquires `command`, sees `conn_id != conn`, is refused, and the new port's trace has none of its bytes. Same hook for `serial_get_status(old)`; for `send_byte(0x21, old)` the hook sits before `realtime.lock()`. Also assert the stale send's `motion_pending` guard decremented (the RAII guard must run on the refusal path, or the next real jog is refused `motion-pending` for ever).
- **N4 variants** (lines 262-263): the STOP variant waits on `stop_in_flight` (`StopGuard::begin`, `:3706-3712`). `send_byte(0x18)` and `serial_job_begin_inner` set no such flag, so "observed parked on `submit`" has no positive signal for them; the hook would sleep and hope. Fix: a `#[cfg(test)]` `AtomicBool` set by each of those two paths immediately before its `submit` acquisition, waited on the same way, then the 50 ms negative window.

### F4 — the partial-line sentence argues the wrong direction (X3)

Line 157: a frame whose first bytes were in `pending` at the drain "was generated after the drain began, since the drain consumed every complete line". A partial line in `pending` at time D started arriving before D, so it was generated before D. What the assumption actually buys: the drain begins at ≥ Q after the terminal was read; a report generated before cycle start was generated at < Q after `ok` (assumption) and needs one frame-time to arrive (~5 ms for 60 bytes at 115200); so a pre-motion report can be partial at D only if it was generated in the last ~5 ms before Q, i.e. the effective margin is Q minus one frame-time. Card step 4 qualifies Q as a whole, so the barrier is still qualified empirically, but the stated reasoning is false and Ted should not build on it. Cheaper and exact: after the drain, if `pending` is non-empty, complete it with one bounded `read_until` (one tick), note the line through `on_line`, publish it as a drained snapshot, and only then write the probe. Then every frame the probe read can return started arriving after the drain ended, which is the property line 152 already claims. Add the case to N5: a stale `<Idle|MPos:10,…>` split across the drain boundary is completed and discarded, and the barrier's observation is the post-probe frame.

### F5 — the round-2 P2 items were dropped silently (dim 10)

Round 2's must-fix 8 (F9) had three parts; none appears in revision 3 and the round-2 fold table has no row for it. A fold table that omits a finding reads as closure. Restate each:
- Pin (b), line 410: replace "TS clipping is advisory" with "the clip is computed in TS from the basis native names; native verifies the basis, the home, the units and the observation, not the geometry."
- `serial.rs:593-595`: the `send_byte_inner` doc invariant ("touches ONLY the realtime lock") and its pin test `realtime_write_completes_while_command_lock_held` become false for `0x18`/`0x85` (they take `submit` for the bump). Amend the comment: still true for `!`, `~`, `?`; for reset and cancel, bounded by one `write()` under `submit`, the fence's own bound. Say whether the pin test is split or re-scoped.
- A golden that every committed job fixture passes `classify_outbound` line by line, so a generator change that emits a tab, a `\r` or a non-ASCII byte turns a test red rather than refusing a job at the bench. `jobStream.ts:339` splits on `\n` and does not trim; the generator emits `\n` today, and this is the test that keeps it so.

### F6 (advisory, non-blocking) — smaller items the fold left

- Line 88's chain `… → trust → snapshot → admitted_job` lists two leaves in sequence. Write "`trust` → {`snapshot`, `admitted_job`} (both leaves)".
- N13 (line 287) should rank `command`, `submit`, `realtime`, `trust`, `snapshot`, `admitted_job`, so the new `realtime → trust` edge and the connect exception are inside the tracker, not beside it.
- Which batch carries `classify_outbound`'s `malformed` refusal (line 91 says it runs first in `serial_send_inner`; B1 claims "no refusal"). Name the batch.
- Console `$32=0` (or any settings write from the console) clears units natively and TS sends no readback (`connection.ts:604-621`); the UNITS text should say "send `$$`". Existing S1 behaviour, but it is now the arrows' reason too.
- Line 179: `serial_get_status(conn)` on the busy path calls `send_byte(conn, b'?')`, which refuses on a stale `conn`; say that the refusal is swallowed as today (`let _ =` at `:634`) and returns Busy with the last snapshot, so a stale poll during a pump never surfaces as an error.

## Stress test 1 — Pre-mortem

Three months out, the type-specific worst case is a head moving when the operator believed Kerf would not let it.

1. **Ted implements `observedPos` from the latest frame** because the plan gives no other source (F1). The clip then reads the pre-motion position on the one frame where it matters, which is r2 F4 reading B by another door. The plan should have named the field.
2. **N8's in-flight test is rewritten in the relay to "hold `command` in the test"** because the plan's schedule cannot run (F3), and the check-under-lock property is then tested only uncontended. Passes; the parked-send path is unexercised; a later refactor moves the `conn` check before the `command` wait and nothing goes red.
3. **The console user learns that `(...)` in front of a command "skips the home check"** (F2). Nothing moves that could not already be moved from the console, but the DECISIONS pin says otherwise, and the next session reads the pin as true.

## Stress test 2 — Load-bearing assumptions

- **The fork starts a cycle within Q = 150 ms of `ok` and answers `?` within 500 ms.** Unchanged from r2; medium-high; qualified by card step 4; fallback indexed. The partial-line case narrows the margin by one frame-time (F4), which the F4 fix removes.
- **`observedPos` is the barrier frame's MPos.** Assumed by TS's clip; not stated by the plan (F1). Resolve before implementation.
- **The console is the only sender of comment syntax.** True today (the generator emits none; `jobStream.ts:339` filters `;` lines). Consequence if a future path sends `(…)`-prefixed `$J=`: a jog bypasses admission (F2).
- **Both handles are one tty output queue.** Unchanged; inherited from the fence pin.

## Stress test 3 — Inversion

The r2 inversions stand. New: a "refuse comments in `$`-lines" grammar wins over "strip comments like GRBL" only if some Kerf path legitimately sends `$J=…(comment)`; none does, so either fix is acceptable and the stricter one is smaller. A "hold `command` in the test" N8 wins only if disconnect and connect could run without `command`; they cannot (`:342`, `:444`), so the hook-before-the-wait form is the only deterministic in-flight schedule.

## Overall verdict

**CONCERN. No gating FAIL.** Both round-2 P0s are closed as asked, and I re-traced them: the basis rides on every frame, the barrier re-runs until Idle, and the arrows come back after a motion. The lock placements, the card arithmetic and the busy-path statement are correct in the tree. What the fold introduced is three precision defects, none of which yields a schedule that writes a `$J=` after `0x18`, from a stale basis, or across a reconnect: the observation struct lacks the position the snapshot promises to copy (F1); the N8 in-flight schedule is a contradiction that I proposed in round 2 and the fold transcribed (F3); the partial-line sentence argues backwards (F4). One round-2 item was done by half (F2: the `Jog` class still ignores GRBL's comment stripping, so pin (b) is false for one console input that can already move the head by policy), and the P2 debts were dropped without a note (F5). All five are paragraphs, not redesigns. Fold them and this plan can go to relay.

## Prioritised must-fix

1. **P1 (F1, dim 3):** `Observation` gains `mpos: [f64;3]` from the barrier frame; `observedPos` copies it; drop or define `settled`.
2. **P1 (F2, dim 5):** normalise comments (`(…)`, `;…`) before classifying, exactly as `normalizeGrblLine`, or refuse `(`/`;` in `$`-lines; add the N9 cases. Required before pin (b) is written.
3. **P1 (F3, dim 9):** N8 in-flight becomes a hook-before-the-`command`-wait schedule (and before `realtime` for `send_byte`); assert the RAII decrement on refusal. N4's raw-reset and job-begin variants get a test-only "entered" flag to wait on.
4. **P1 (F4, X3):** replace the partial-line argument with the complete-note-then-probe step; add the split-frame case to N5.
5. **P2 (F5, dim 10):** fold the three round-2 P2 items (pin (b) wording, `send_byte` doc invariant and its pin test, fixture grammar golden) and give them a fold-table row.
6. **Advisory (F6):** lock-chain wording, N13 scope, grammar's batch, UNITS text, busy-path stale-`conn` swallow. Non-blocking.
