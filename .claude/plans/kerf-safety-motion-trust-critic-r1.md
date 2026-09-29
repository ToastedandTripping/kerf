## Applicability

Project type: Architectural safety-critical desktop laser/CNC control software; Rust serial transport, concurrent command admission, TypeScript state and operator UI. This is an independent review of the supplied plan, checked against the local transport code, its cited facts file, `.claude/DECISIONS.md`, the S3c classifier specification and ROADMAP. No implementation or hardware tests were run.

Active universal dimensions: 1 Problem-fit [GATING]; 2 Approach soundness [GATING]; 3 Completeness [GATING]; 4 Right-sizing & reuse [GATING]; 5 Security [GATING]; 6 Failure modes [GATING]; 7 Change safety [GATING]; 8 Data integrity & compatibility [GATING]; 9 Verifiability [GATING]; 10 Maintainability [GATING].

- X1 Physical & human safety [GATING] fires: the plan changes admission of physical motion and prescribes live hardware testing.
- X2 Privacy & data stewardship: N/A — does not fire; this change introduces no personal/client record collection, retention or access path.
- X3 Evidence & source integrity [GATING] fires: load-bearing claims about transport ordering and hardware qualification are used to justify safety decisions and closure of W1/W2.
- X4 Audience, brand & money accuracy [ADVISORY] fires: operator-facing refusal and recovery instructions change; no financial or legal output is involved.
- X5 Concurrency & re-entrancy [GATING] fires: command pumps, realtime STOP, reconnect, polling and job admission share state; X1 makes this gating.
- X6 Operability & observability [ADVISORY] fires: this changes a released application's field failure and recovery behavior.
- X7 Self-modification safety: N/A — does not fire; this changes Kerf's machine controls, not MARVIN's own hooks, gates, skills or automation.
- X8 Dependencies, performance & cost [ADVISORY] fires: trust locking and callbacks enter the serial/status hot paths, including buffered streaming and polling.

## Dimension verdicts

FAIL — 1 Problem-fit [GATING]: The Intent section is present, but “a fresh millimetre MPos” and “no motion is pending or unobserved” are not established by the proposed ledger; resolve F1–F3 before claiming the combined W1/W2 fix.
FAIL — 2 Approach soundness [GATING]: “no event can come between the check and the write” is false for realtime reset, and read-time counters do not establish sample causality; replace both claimed controls with explicit enforceable ordering (F1–F2).
FAIL — 3 Completeness [GATING]: The transition table excludes job motion from the ledger and omits alarm-status and settings/reset invalidation cases; enumerate every trust-affecting path and cover job-to-jog handoff (F3–F4).
CONCERN — 4 Right-sizing & reuse [GATING]: The dependency chain and cross-root waiver are stated, but “Parking Lot at 3.5” defers indexing until after merging; index every deferral now, explicitly state batches are dependent, and make B2/B3 an atomic delivery unit (F7).
FAIL — 5 Security [GATING]: A prefix test and optional connection argument leave the enforcing IPC boundary underspecified; reject absent identities after migration and reject or canonically validate multi-line/control-byte command payloads (F5).
FAIL — 6 Failure modes [GATING]: RAII removes pending state on every error, without an explicit uncertain-execution/quarantined-response state after partial writes or lost terminals; define recovery before a later status or `ok` can restore trust (F4).
CONCERN — 7 Change safety [GATING]: “revert the merge” restores the unsafe jog implementation and the interim B2 state refuses existing jog callers; define deployable checkpoints, hardware acceptance gating and a safe rollback operating state (F6–F7).
FAIL — 8 Data integrity & compatibility [GATING]: A connection-keyed units flag can outlive controller/configuration changes, while B2 changes String to object and enables admission before callers carry its required fields; add configuration invalidation and atomic ABI migration (F4, F7).
FAIL — 9 Verifiability [GATING]: N11's job-active test and occurrence scan cannot detect a reset between jog check and write; N5/N10 do not test buffered stale Idle, and N2's pump error is unreachable as specified; replace these with forced production-path schedules (F8).
CONCERN — 10 Maintainability [GATING]: “leaf, next to snapshot” does not define the nested ordering needed to publish/read both locks atomically; specify one lock hierarchy, poison behavior and one normalized outbound-command classification seam (F1, F5).
FAIL — X1 Physical & human safety [GATING]: The card's unqualified absolute console move and Home operation are not bounded by mid-bed clearance, and STOP can precede an already-admitted jog; provide physical containment and close write ordering before live testing (F1, F6).
FAIL — X3 Evidence & source integrity [GATING]: “every other write needs the command lock” contradicts both the cited facts and `send_byte_inner`; the fold map calls sampling and hardware containment handled when they remain open; correct the claims and closure mapping after proving the controls (F1–F2, F6).
CONCERN — X4 Audience, brand & money accuracy [ADVISORY]: The card promises “Home reason” while the stated precedence chooses motion before home for an unsettled snapshot; specify and test actual connect, post-stop and recovery text (F9).
FAIL — X5 Concurrency & re-entrancy [GATING]: STOP, job admission and pre-lock pending registration can change state outside `command`; connection checks also lack a specified atomic relationship to realtime handle replacement; define and force-test each linearization boundary (F1, F3, F5).
CONCERN — X6 Operability & observability [ADVISORY]: Refusals are visible, but “reconnect is also safe” overclaims the unresolved lifetime contract, and the pending cause is published only on status frames; add immediate invalidation visibility and recoverable field evidence (F5, F9).
CONCERN — X8 Dependencies, performance & cost [ADVISORY]: There are no new packages, but “never held across I/O” alone does not bound contention or prove STOP remains independent; verify reset progress with command/trust activity and document lock acquisition bounds (F1).

### F1 — The proposed critical section does not exclude STOP

Plan lines 147–150 say “every other write needs the command lock” and only consider “a jog written just before a stop.” The opposite schedule is legal: jog passes all checks; its trust/snapshot guards are released; STOP writes reset through `realtime` and bumps the trust epoch; jog resumes and writes its previously admitted bytes. `command` never changed hands. Native source `serial.rs:591–605` deliberately gives `send_byte_inner` only the realtime lock; `serial_stop_inner` similarly sends reset without `command`. A later epoch bump cannot retract bytes. Whether firmware refuses the post-reset jog is not a host-side interlock and is not established for this controller.

Use a bounded shared admission/write barrier with stop/cancel invalidation, preserving immediate realtime STOP and the single-reset pin. Do not fix this by holding the command lock through STOP or waiting on a pump. Specify ordering for both stop and raw reset/cancel paths, including failures, and whether an amendment to the plan's “submit lock unchanged” scope is needed. Holding the trust lock across I/O would contradict the design and needs its own latency analysis, not an implicit implementation choice.

The related statement that trust is a “leaf lock ... next to snapshot” is incomplete: atomically checking both requires an order or a combined representation. Concurrent pending registration also occurs before `command`; either serialize admission-relevant state changes with the write or state the narrower guarantee actually provided.

### F2 — A newly read status is not necessarily a new observation

Line 112 stamps `observed_after = motion_writes` when an Idle is **read** with zero pending commands. `read_status_bounded` (`serial_pump.rs:356–382`) sends `?` and returns the first status in the reader; it does not correlate that frame with the probe. The command pump returns at the first terminal. A delayed/pre-existing Idle can remain in the serial/reader buffers and be consumed after the command returns. It then receives a new sequence and `received_at`, and the current counter, although its coordinates precede the motion. All listed predicates can accept it.

Define a controller/protocol-supported freshness barrier accounting for partial frames, queued probes, buffered responses and terminal ordering. A host counter alone cannot supply that guarantee, nor can blindly accepting the next frame after sending `?`. Until the barrier is proved, keep admission closed. Test a stale Idle left behind a terminal or delivered late, followed by the actual post-motion status; the first must not qualify. This is precisely the stale-position case the fold map claims closed.

### F3 — Job exclusion is not job-to-jog synchronization

The ledger explicitly counts “non-job motion writes,” while line 299 leaves jobs outside MotionTrust. `admitted_job == None` only excludes a job at the instant it is checked. The current `serial_job_begin`/`serial_job_end` manipulate admission separately from the command lock. A job can be admitted between the check and write; a short job can also write and end without changing the proposed motion counter, leaving an earlier settled snapshot within its three-second age limit. No rule requires the first subsequent jog to use a sample causally after the final job motion.

This is not a demand that jobs require Home. Invalidate jog observation at job admission and track completion-to-fresh-status handoff for both streaming modes; serialize admission races. Add tests for job beginning during jog admission and job ending before the next status poll, including a short job whose last acknowledgment precedes physical settling.

### F4 — Trust invalidation and ambiguous I/O are incomplete

“Every transition” only revokes on classified Banner/Alarm, certain bytes, Home and connection changes. A `<Alarm|MPos:...>` line is classified Status; the old S3c specification explicitly covered alarm status frames. Making that snapshot unsettled does not clear `homed_at`: a subsequent Idle after unlock can restore jog eligibility without Home if no separate ALARM line was observed. Add an explicit status-alarm invalidation test.

Units are cleared on `$13=` but not by a reset/banner in the table, settings restore, or ambiguous settings transmission. Configuration writes affecting direction, scale or homing likewise have no native position-trust rule. Enumerate supported settings-changing commands and configuration generations; revoke conservatively before uncertain changes, require successful readback, and distinguish persistence assumptions from tested controller behavior.

The “returns (Ok or Err, any path)” decrement does not resolve a partial write, flush error or missing terminal. Specify when trust becomes unknown and how stale terminals are quarantined so an earlier `ok` cannot qualify a later `$H` or incomplete `$$`. Failure recovery must not be “pending returned to zero, then any Idle.”

### F5 — Connection identity and payload validation must be enforced, not inferred from spies

Line 130 permits missing `conn` “for compatibility during B1 and B2 only,” but no final native rejection is specified; T-C3 observes only calls reached by jog/console tests. Require an identity for every non-emergency write/status request in the final backend, and name the exceptions. Bind realtime identity validation to the handle actually written under one defined lock order. Cover the busy status probe, overlapping connect/disconnect completions and stale lifecycle operations, not just late command replies.

Line 131 checks whether “the command starts with `$J=`”; Home alone explicitly uses trimmed uppercase text. The current serial writer sends the supplied string and appends a newline. Define one accepted command grammar: reject embedded line delimiters and realtime control bytes, normalize supported whitespace/case before classification, and reject unsupported representations. Otherwise a payload beginning with another command can carry a second `$J=` outside the gate. Test malformed/multi-line IPC input and all accepted normalization variants with a zero-byte oracle. This is an enforcement completeness problem even without a hostile network attacker.

### F6 — The hardware card relocates its own prerequisites

Line 282 requires mid-bed clearance “before any step,” but step 2 homes to an edge, and step 3 moves to the measured centre using `G21 G90 G1 X… Y… F300`. An absolute G-code work coordinate is not established by measuring a physical centre; the card does not establish offsets, direction, scale or the home frame. Those are explicitly deferred to S3e. The ±20 mm starting clearance does not bound a homing cycle, a mistaken absolute target or excessive scale. A power switch “within reach” is not a verified stop or a bound on distance before collision.

Make independent physical stop verification and a qualified safe positioning procedure prerequisites to this card. Name maximum travel, safe abort criteria and who qualifies the procedure before powered motion. Keep laser isolation, but recognize that it prevents beam exposure, not carriage injury or collision. S3e may remain separate; the current plan must name an enforceable test/release dependency or an accepted restriction while the frame remains unqualified. A six-step behavior card cannot close physical containment by renaming it “behaviour only.”

### F7 — Batch compatibility and deferral accounting are overstated

“return-shape change ... is additive” is incorrect: String to `{ banner, connId }` is a breaking ABI change. Updating `.banner` fixes one consumer, but B2 also refuses every legacy jog lacking `conn` and `jogBasis`; B3 supplies these later. Explicitly prohibit intermediate deployment or combine the enforcement and caller migration in one releasable unit. Verify actual Tauri argument casing and serialization across that boundary.

The existing ROADMAP indexes older S3 deferrals, but the plan's new seven-item list says indexing happens at 3.5, after merge. Give these entries stable Parking Lot references before gate closure. State which acceptance requirements stay open after code merge and what rollback means operationally; reverting safety logic is not itself a safe recovery mode.

### F8 — The proposed tests can pass while the invariant is false

N11's behavior test checks an already-admitted job, not check/write atomicity. An occurrence count for `jog_admit(` also cannot prove its lock scope. N10 is sequential and cannot kill moving the check outside the lock reliably. Add deterministic barriers immediately after admission and before the actual write, then interleave reset, job admission and handle replacement through production functions; assert exact byte order and forbidden-byte absence.

N2 says “ALARM:1 ... then an I/O error,” but `run_pump` returns immediately on Alarm. That pump invocation never sees the error. Separate terminal invalidation from a genuinely reachable error-path test, and show each mutation is reached before declaring it killed. N3's pre-drained-banner case also conflicts with capturing `h` after the drain: define whether that banner is prior history or a call-wide disqualifier, and implement/test one policy.

Add F2's queued-status test and F4's alarm-status/configuration/error tests. N12 must count the actual six listed extraction sites rather than repeating “five,” and must exercise callback effects, not merely nearby text.

### F9 — UI recovery claims are not synchronized with trust changes

Snapshot publication is the only stated source of `motionPending` and homed scalars. On a silent pump or reset without a new status, the UI can retain its previous cause and enabled appearance until another mechanism expires it. Publish revocation/pending changes independently or explicitly specify conservative UI invalidation at command/stop entry, with native still authoritative. Test silence, failed STOP and missing-banner cases. Align reason precedence with the hardware card; do not promise a Home message where the implemented precedence produces a motion hold. Retain bounded diagnostic evidence of refusal reason, connection and trust/basis generation without committing raw captures contrary to DECISIONS.

## Stress test 1 — Pre-mortem

Three months after release, a jog lands after STOP: admission passed, realtime reset overtook it, and the supposedly protected write followed. The type-specific worst case is unexpected carriage motion that crushes a finger or hits the frame/material; the code has no valid host ordering proof, regardless of what one firmware run happened to do. The warning was the false “every other write” premise and a test that never forced this schedule.

A second incident clips a jog from a pre-motion Idle newly stamped as settled. Buffered serial data, or a short job absent from the ledger, makes the old coordinate look current. Near the travel boundary this causes a collision. The warning was that counters tracked host consumption, not the controller observation.

The owner hits a limit or frame while trying to return to mid-bed for the hardware card. Laser isolation worked, but the absolute console target used an unqualified frame or offset. The warning was that the card deferred the qualification required to execute its own setup move.

## Stress test 2 — Load-bearing assumptions

- **All invalidating events serialize with jog admission/write — confidence: contradicted by local code.** Realtime reset and job admission do not share `command`. Consequence: post-reset or concurrently admitted motion. Resolve before implementation by specifying the actual shared barrier.
- **Reading Idle after the counter advances proves post-motion coordinates — confidence: low/unverified.** Buffers and outstanding probes defeat that implication. Consequence: false settled basis and incorrect clipping. Resolve before implementation with a protocol-level freshness argument and adversarial byte traces.
- **The invalidation list covers every loss of position/units trust — confidence: low.** Status-only alarm, configuration changes and ambiguous I/O are absent. Consequence: Home or mm trust survives evidence that should revoke it. Resolve before implementation with a complete transition inventory.
- **Measured clearance plus laser isolation contains this card — confidence: low.** Neither qualifies an absolute target nor bounds homing travel. Consequence: mechanical injury or damage during qualification. Resolve before hardware execution; write the enforceable prerequisite into the plan now.

## Stress test 3 — Inversion

The rejected TS-owned trust model would win only if TS observed every invalidation and owned every write boundary; the cited facts already disprove that, so returning authority to TS is not the fix. A narrower interim alternative—keeping jogs unavailable until native ordering and frame prerequisites are qualified—wins when a usable button cannot yet be backed by a safe basis. Those conditions are already present here. This does not authorize changing Lee's standing full-feature release ruling: make the dependency and unresolved decision explicit rather than silently disabling released features or silently asserting safety. Similarly, an atomic B2/B3 delivery wins over independently releasable batches because the new enforcing ABI requires both halves at once; that condition is already true.

## Overall verdict

FAIL — gate blocked. Native ownership is a suitable location for enforcement, but the plan does not yet establish its advertised safety invariant: realtime reset can overtake admission, a buffered old status can be certified fresh, and job motion can escape the observation ledger. The hardware card also depends on qualification it explicitly defers. These are defects in the proposed controls, not requests for more reassuring test volume; revise the ordering, freshness and containment contracts and then retest the plan against the concrete schedules above.

Prioritized must-fix list:

1. **P0:** Specify shared jog/reset/job admission ordering and prove it with forced interleavings, preserving immediate single-reset STOP.
2. **P0:** Establish a real post-motion sample barrier, including buffered replies and job-to-jog handoff; keep uncertain observations inadmissible.
3. **P0:** Complete trust invalidation and uncertain-I/O recovery, including alarm status, configuration changes and stale terminals.
4. **P0:** Supply independently qualified hardware containment and positioning prerequisites; name the frame qualification dependency without claiming the behavior card closes it.
5. **P1:** Enforce final IPC connection/payload contracts and cover realtime, busy-probe and overlapping lifecycle paths.
6. **P1:** Replace unreachable or structural-only proof tests, make B2/B3 delivery atomic, index deferrals now, and align recovery/UI claims with the actual state machine.
