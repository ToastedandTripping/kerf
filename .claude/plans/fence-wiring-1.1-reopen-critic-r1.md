# Critic review — Fence Wiring, Batch 1.1 Reopen (RF-15)

Plan: `.claude/plans/fence-wiring-1.1-reopen.md`
Rubric: `~/marvin/rules/plan-critic-rubric.md` (v2)
Reviewer: separate critic subagent (Fable), read-only against the tree at HEAD `229398f`
Read for this review: the plan; `CLAUDE.md`; `.claude/DECISIONS.md` (abort ruling 2026-09-20, the 2026-07-05 pin as amended 2026-09-22, the `$32`/perLine pin); `ARCHITECTURE.md` "Serial Lock Order", "Machine Communication", "Admission fence"; PLAN.md "Relay verification contract" and batch 1.1; `serial.rs`, `serial_session.rs`, `serial_pump.rs`, `scripted_port.rs`, `sim/mod.rs`, `lib.rs`, `Cargo.toml`/`Cargo.lock`; `connection.ts`, `jobStream.ts`, `jobSession.ts`, `JobActionBar.tsx`, `MaterialTestDialog.tsx` call sites, `serialTraceHarness.ts`, `jobStream.test.ts`, `machineJobLoop.test.tsx`; and, for R1, the vendored `tauri-2.10.2` sources (`Cargo.toml`, `src/test/mod.rs`, `src/ipc/command.rs`, `src/webview/mod.rs`, `src/ipc/authority.rs`) plus `tauri-macros-2.5.4/src/command/wrapper.rs`.

## Verdict: APPROVE WITH CHANGES

One blocking finding (B1), the rest advisory. B1 is a failure path that ends in an unsafe state by construction, not by bad luck; it is a small change to the plan text and no change to its architecture.

---

## Applicability block

**Project type:** desktop CAD/CAM controlling a laser cutter; this batch is the serial abort/admission path. Rust (Tauri command bodies) plus the TS transport and job loop.

| Dimension | Fires? | Tag | Why |
|---|---|---|---|
| Core 1–10 | always | GATING | — |
| X1 Physical & human safety | **yes** | **GATING** | Decides whether stale G-code (including standalone `M3 S…`, RF-1) reaches a controller after STOP. Worst case is the beam firing on a freshly reset controller. |
| X2 Privacy | no | N/A | No personal, health, child or client data is touched. Attested. |
| X3 Evidence & source integrity | no | N/A | No research or public claims; all claims are code citations, checked below. Attested. |
| X4 Audience/brand/money | no | N/A | Console strings only; not client- or public-facing output. |
| X5 Concurrency & re-entrancy | yes | **GATING** (X1-class plan) | Two threads (writer, stop), a pump holding a lock for minutes, a queued IPC that can execute after STOP. |
| X6 Operability | yes | ADVISORY | Ships in a released app; operator sees console lines and must act on them. |
| X7 Self-modification | no | N/A | No MARVIN gates, hooks or skills change. Attested. |
| X8 Dependencies/perf/cost | yes | ADVISORY | Adds a `tauri` `test` feature as a dev-dependency; two atomic loads plus a leaf mutex per line. |

---

## Direct answers to the six probes

**(1) The extra realtime `0x18`, and the check-under-lock.**
Consistent with the 2026-09-20 ruling and does **not** need Lee before implementation, for three reasons. The ruling governs the stop's own sequence ("0x18 immediately — no feed hold, no M5, no ack wait … retain the write-failure retry"): the stop path is untouched (plan: "`serial_stop_inner`'s stop sequence" is out of scope). The re-send is the same realtime byte, on the realtime handle, with no ack wait and no line-protocol write, so it does not touch the standing prohibition on ack-awaited writes in the abort path. And it is not new policy: PLAN.md batch 1.1 already required it — "Retain at most one already-started write in the documented race window; report it, fence subsequent work, and **ensure reset is ordered after it** or mark submission unconfirmed." Batch 1.1 as merged did neither (`in_flight_write` is hard-coded `false` at `serial.rs:925` and `:1055`; verified). The plan's routing — implementer proposes a DECISIONS pin, Lee approves — is right; see A1 for what that pin should say.

Deadlock: none. Verified against `serial.rs:1–33` and the code. The new check takes `session.admitted_job` (leaf, microseconds) while holding `command` (3); the table forbids only the reverse. The stop takes `admitted_job` then `realtime` and only ever `try_lock`s `command` (`serial.rs:1017`), so a writer sitting on `command` cannot block the stop's `0x18`, and the stop's banner read simply skips while the writer holds the lock. The buffered pump holds `command` for the whole job and its per-line gate takes only the leaf, which the stop holds for microseconds. The re-send takes `realtime` after `command` is dropped, which is the safe direction even under connect's nesting exception. The one thing that changes operationally: a stale per-line send now blocks on `command` until the current line's pump finishes (one ack, per-line mode) before being refused, where today it is refused before waiting. That is correct (it must not read bytes) and cheap; see A4 for keeping the fast path too.

**(2) `serial_stream_job` clearing `job_abort` at entry.**
Verified: `serial.rs:699` `inner.job_abort.store(false, Ordering::SeqCst)` runs before the `command` lock at `:701` and before any check. `serial_job_begin_inner` also clears it (`:1099`) under `admitted_job`; those are the only two clearers in the tree (grep `job_abort.store(false`). With `:699` deleted and the entry permit under the lock, a queued second buffered invoke after STOP is refused before it can write or read: after a confirmed stop the phase is Idle (≠ Active) → `not-admitted`; after an unconfirmed one it is Unknown → `not-admitted`; if TS has begun a new session (phase Active, `admitted_job = E_new`), the old invoke carries `E_old` → epoch mismatch. In every branch `job_abort` is left as the stop set it. R5's "`job_abort` is still `true`" assertion pins the deletion. The remaining clearer, `serial_job_begin_inner`, can run while an old pump still holds `command` only if a stop *confirmed* while the pump was alive, and a stop can confirm only when some reader publishes the banner — which for a running pump is the pump itself, and that ends it (`Aborted`). So the R6 class is closed by the deletion plus the pump's per-line gate, which is defence in depth. R6 modelling it by clearing the flag by hand is acceptable for a mechanism test; say so in its comment (A6).

**(3) The refusal contract and every string-matching site.**
Catch and classification sites that could misread a refusal today, all verified:
- `connection.ts:305–308`: every rejection → `Send failed: …` plus `["error:disconnected"]`. Per-line `jobStream.ts:350–358` then reads `error:disconnected` → `portDisconnected`, `setMachineConnected(false)`, and `disconnect()` at `:447`. The plan's prefix branch before that mapping closes it (T1 mutant 2 pins it).
- `jobStream.ts:336`: a `refused:` response would today fall through every branch and the loop would **continue to the next line** (it is not empty, not `Grbl `, not `ALARM`, not `error:`). The plan's "first classification after the call" ordering closes it; T2 pins it.
- `jobStream.ts:247–255` (buffered catch): `msg.includes("disconnected")` — the Rust text `phase=disconnected` trips it. Plan orders the prefix check first; T3 pins it.
- `jobStream.ts:168` / `:174–246` (RF-8): `Ok("refused: …")` would end as `complete`. Plan fixes the default and adds a final `else`; T4/T5 pin it.
- No other site string-matches a send result. `enableLaserMode`, `queryGrblSettings`, `home`, jog, Console, Test Fire pass no epoch, so they can never receive a refusal.
- `machineConnection.send()` never throws, so the per-line loop has no catch to audit.

What the operator sees is right in the table, with two gaps: the post-loop `else` at `jobStream.ts:431` still logs `"<label> aborted"` after the plan's own message unless the refused branch skips it (A5); and the `in-flight-unreset` row clears `jobRunning` via `"cancelled"`, which disables the STOP button (`JobActionBar.tsx:296`) — that is B1.

**(4) `tauri::test` in the pinned version.**
Available without new crates: `Cargo.lock` pins `tauri 2.10.2`; its `Cargo.toml:120` declares `test = []` (no dependencies); `lib.rs:1100` gates `pub mod test` on `any(test, feature = "test")`. `mock_builder`, `mock_context(noop_assets())`, `WebviewWindowBuilder::new(&app, "main", …)` and `get_ipc_response` exist (`test/mod.rs:109–305`). Three properties the plan relies on, each verified in source:
- **Argument construction is the production path.** `get_ipc_response` → `Webview::on_message` (`webview/mod.rs:1724`) → the `generate_handler!` wrapper, whose `CommandItem` deserializer reads the JSON body by key (`ipc/command.rs:92–103`). The macro always converts `job_epoch` → `jobEpoch` (`tauri-macros/src/command/wrapper.rs:441`).
- **A missing key on an `Option` arg deserializes to `None`**: `ipc/command.rs:134–145`, `None => visitor.visit_none()`. So the "rename the parameter" mutant really does silently unfence — the fail-open the plan names — and R1(b) goes red for exactly the stated reason. For the required `job_epoch: u64` on `serial_stream_job`, a missing key is a rejection (`:100`), which is fail-closed as the plan says.
- **The ACL does not block app commands under `mock_context`**: `on_message` checks ACL only for `plugin:` commands or when the app has an ACL manifest (`webview/mod.rs:1809`); `mock_context` builds `runtime_authority!(Default::default(), Resolved::default())`, so `has_app_manifest()` is false. The app's `capabilities/default.json` is not loaded by the mock context. Async commands run on `tauri::async_runtime` (`ipc/mod.rs:329`), which is a tokio runtime, so the body's `spawn_blocking` works as in production.
Feature unification: edition 2021 → resolver 2, so `tauri/test` is enabled for `cargo test` and `--all-targets` (clippy) and not for `cargo build`/`--features sim`, which is what the plan wants.

**(5) Can every "fails today" test be shown red for the stated reason?**
- R1(b): yes — the wrapper passes `None` (`serial.rs:545`), the line is written. (c) is green today, correctly, as a control.
- R2: red today, but on the **prefix assertion** (today's text is `session not active (phase=…)`, no prefix), not on the write — today's pre-lock check already refuses. State that in the relay log; the mutants are what test the mechanism. The "no `ReadData`" assertion must be scoped to trace events after the stale send began, since the stop's own `try_lock` read produced `ReadData` for the banner (A7).
- R3: red today — the check at `:458` passes while the test holds `command`; after release the sender writes, then `:498` reports "permit expired" with the line already after the `0x18`.
- R4/R7: red today — no re-send exists; the last Writer write is not followed by a Realtime `0x18`. Requires the new write hold.
- R5: red today — `$32=1` is written after the stop and `job_abort` is cleared.
- R6: red today — Phase A has no gate; after `ok` the next line goes out.
- T1/T2/T6/T7: red today — no `jobEpoch` key. T3: red today via the `includes("disconnected")` teardown. T4/T5: red today via the `complete` default.
- F7: green today by construction (the test copies the guard); its value is the mutant. Fine.
- One pre-existing cost to know: `serial_stop_inner`'s banner wait is a real 3 s `Instant` deadline; a `&|_| {}` sleeper busy-spins it. Any new test whose stop cannot read a scripted banner pays 3 s (A8).

**(6) Lock-order compliance.**
Compliant with the ARCHITECTURE.md table and the `serial.rs` invariants. New: `command` (3) → `admitted_job` (leaf) for the permit; `command` (3) → `observer` (leaf) for `permit_granted`, and the plan releases `admitted_job` before emitting, so no leaf-under-leaf; re-send takes `realtime` (2) with `command` dropped. The pump's `SubmissionGate` takes only the leaf under `command`. The stop is untouched. `disconnect_inner_with_job` (stop, then `command` then `realtime` for teardown) is unchanged. F6's table edit ("`resend_reset_after_in_flight`, after dropping `command`") is the right entry.

---

## Core dimensions

1. **Problem-fit — PASS.** `## Intent (grilled)` present with a written skip line naming RF-15 and Lee's 2026-09-22 ruling. The goal matches the Summary. No DECISIONS contradiction: no ack-awaited write enters the abort path; `$32=1` stays gated; `perLine` stays the default; the 2026-09-20 sequence is untouched.
2. **Approach soundness — PASS.** Check under the lock (prevention) plus post-write generation check (detection) plus ordered re-send is the standard linearisation for a check/write race when the stop may not wait. The ordering argument in F1 is correct given one unstated assumption (LB-1 below). Per-line granularity in the pump is right for the reasons given.
3. **Completeness — CONCERN.** (a) The `resend` double-failure path stores `PHASE_UNKNOWN` from the writer thread while the stop, on observing the banner, stores Idle via `set_idle()` (`serial.rs:1036`); the two stores are unordered, so a *confirmed* stop can overwrite Unknown with Idle after a known stale line reached the reset controller and the re-send failed — see **B1**. (b) The refused branch must also suppress the `"<label> aborted"` line at `jobStream.ts:431` (A5). (c) "every `sim_integration` test calling `serial_stream_job_inner`" is an empty set (the only callers are the wrapper at `:867` and `pin_stream_writes_dollar32_first` at `:1828`); the relay log should say "none" rather than list nothing (A9).
4. **Right-sizing & reuse — CONCERN.** Thirteen files across two subsystem roots (Rust serial, TS machine). The plan gives the reason (a Rust-only merge makes every job line refusable while TS maps refusals to `error:disconnected`) but does not call it a waiver. Add one sentence: "Waiver: exceeds eight files because the contract string is produced in Rust and consumed in TS; splitting would ship a fail-open intermediate." Deferrals are named for the Parking Lot; ROADMAP `## Parking Lot — every deferral, one index` exists at `ROADMAP.md:414`. Reuse is good: no new IPC type, `ScriptedPort` extended rather than replaced, `SubmissionGate` keeps the pump session-agnostic.
5. **Security — PASS.** No secrets, no new attack surface; IPC stays local. Fail-closed on a missing required key for the buffered command.
6. **Failure modes — CONCERN.** Covered: write failure on the re-send (retry once, Unknown, physical-stop message), sink failure (unchanged), EOF/timeout (unchanged), stop unconfirmed. Not covered: B1 (Unknown overwritten by Idle). Also name the disconnect race in the doc: `disconnect_inner_with_job` calls the stop, then tears down `realtime`; a writer detecting in-flight after teardown gets "not connected" on the re-send and reports `in-flight-unreset`, which is honest (the port is gone, the physical stop is the only recourse) but should be recognised as expected rather than filed as a bug (A10).
7. **Change safety — PASS.** One integration unit, no tag between halves, every step is a revert. Owner steps are status-only and named; the buffered-mode owner gap is recorded behind D1c.
8. **Data integrity & compatibility — PASS.** No saved artifacts. IPC key naming follows the existing `jobId` precedent (macro camelCases `job_epoch` → `jobEpoch`; verified). `StreamJobOptions.session` required: all four production callers pass one (`JobActionBar.tsx:84,169`, `MaterialTestDialog.tsx:415,447`; verified).
9. **Verifiability — CONCERN.** Strong overall: R1 drives the real command; mutants are named per test; contract strings pinned on both sides. Two fidelity gaps. (a) The TS harness: Tauri rejects an `Err(String)` command with the **raw string**, which is why `String(e)` works in production; `SerialTraceRecorder.reject` is typed `(error: Error)`. If the fence model rejects with `new Error("refused: …")`, `String(e)` is `"Error: refused: …"` and the prefix check fails against correct production code — the temptation is then to loosen `startsWith` to `includes`. Pin the harness to reject with the raw string and add a one-line self-test (A2). (b) R3's green path waits the full 500 ms for an event that must never arrive; assert its absence from the trace after the sender has acquired the lock instead, and keep the bounded wait only for the mutant direction (A8).
10. **Maintainability — PASS.** Contract strings as constants, one prefix, doc corrections (module doc's false single-flight claim; the false comment in `b1_send_after_stop_refused`), ARCHITECTURE "Admission fence" rewritten to describe what exists.

## Conditional dimensions

- **X1 Physical & human safety — CONCERN (gating).** Every control path ends safe except one: `in-flight-unreset`. The plan maps it to `endState = "cancelled"` + `setMachineState("alarm")`. `session.end("cancelled")` clears `jobRunning` (`jobSession.ts:208–215`), and the STOP button is disabled when `!jobRunning` (`JobActionBar.tsx:296`). So at the one moment a stale line may have executed on a reset controller and the software's reset re-send failed, the operator's only in-app path to another `0x18` is removed, and — per B1 — the backend phase may read Idle, so a new job can be admitted on top of it. Fix in B1. Hardware-only paths are named (owner steps 1–4) and the buffered gap is recorded; the status-only evidence limit is stated. Worst case named per failure: the plan does this for the race (rejected alternative 2 names `M3 S…` on a reset controller).
- **X5 Concurrency — PASS (gating).** Every entry point asked "what if this runs twice / mid-flight": stale per-line send (R2/R3), in-flight write (R4/R7), queued second buffered invoke (R5), flag reset mid-job (R6), joiner branch (documented, never used for the re-send). Lock order verified above. One residual: a second banner from the re-send after a confirmed stop is drained as junk by the next send (`drain_classified`, `serial_pump.rs:320–322`) and by `read_status_bounded`'s `dropped` list (`serial.rs:606–615`), and `banner_observed` is only set while `stop_in_flight` — so a stray banner cannot confirm a *later* stop. Confirmed harmless.
- **X6 Operability — PASS (advisory).** Console lines per case; `in_flight_write` becomes real on the stop result; the relay log records owner steps in ROADMAP `next`.
- **X8 Dependencies — PASS (advisory).** `tauri/test` is dep-free at 2.10.2 and dev-only under resolver 2; per-line cost is two SeqCst loads and a leaf lock against ~2.6 ms of wire time per line.

---

## Blocking findings

**B1. The re-send's double-failure state can be overwritten by the stop's own confirm, and the TS mapping removes the operator's STOP at the same moment.**
Mechanism: writer detects in-flight → `resend_reset_after_in_flight` fails twice → stores `PHASE_UNKNOWN`. Concurrently the stop's banner loop observes the first banner → `increment_epoch(); set_idle()` (`serial.rs:1033–1036`). The stores race; if Idle lands last, admission is open after a failed re-send, which contradicts ARCHITECTURE's stated invariant ("after an unconfirmed or failed stop no job can begin until reconnect"). On the TS side the plan maps `in-flight-unreset` to `"cancelled"`, which clears `jobRunning` and disables STOP (`JobActionBar.tsx:296`), so the operator cannot re-issue the shared stop from the app.
Fix (plan text only, small):
1. Add `resend_failed: AtomicBool` (or reuse a tri-state on `in_flight_write_detected`) set by `resend_reset_after_in_flight` on double failure; `serial_stop_inner` clears it in Step 2 and, at result construction, if it is set, does **not** call `set_idle()` and returns `SubmittedUnconfirmed { in_flight_write: true, … }` with the physical-stop message even when the banner was observed. Also make `set_idle` a CAS from `Stopping` → `Idle` so a later Idle store cannot clobber Unknown from either side.
2. Map `refused: in-flight-unreset` to `endState = "unknown"` (retaining `jobRunning`, so STOP stays live for a retry through the shared stop) plus `setMachineState("alarm")`, instead of `"cancelled"`. `refused = true` still suppresses the automatic post-loop stop (the plan's reason stands: the backend owns that decision), but the operator keeps the button.
3. Add a Rust test: stop confirms while the re-send fails (ScriptedPort realtime writes failing after the stop's `0x18`) → phase is not Idle, `serial_job_begin_inner` refuses; and a TS test: `Ok("refused: in-flight-unreset: …")` → `endState === "unknown"`, `jobRunning === true`, `machineState === "alarm"`. Mutants: drop the flag check in the stop's confirm path → RED; restore `"cancelled"` → RED.

## Advisory findings

**A1. Word the proposed DECISIONS pin so a future reader cannot "deduplicate" the re-send.** Suggested: "A refused job line never maps to complete and never triggers a stop from TS. The backend alone re-sends `0x18` once, on the realtime handle, after a detected in-flight line — so one stop may put up to two `0x18` on the wire and produce two banners; that is by design and is not a retry to remove. The re-send never routes through the stop's single-flight joiner, which sends nothing." Present it to Lee in the structured-decisions shape at relay close.

**A2. Harness rejection fidelity.** Reject with the raw string in `enableFenceModel()` (loosen the `reject` type to `unknown`), and add a recorder self-test that `String(rejection) === "refused: …"`. Do not let `startsWith` in `connection.ts` become `includes`.

**A3. State the ordering argument's platform assumption in the module doc.** "Writes from the writer and realtime clones share one tty output queue and land in syscall order (Linux and macOS tty layer)." That is what makes "reaches the port after the `0x18`" imply "write completed after the bump". Note also that because `serialport`'s `flush()` is `tcdrain` (`posix/tty.rs:486`), a line enqueued *before* the `0x18` whose drain returns after the bump is also reported in-flight; the second `0x18` is harmless, but the console text "reset re-sent after it" should read "reset re-sent after it (the line may have preceded the stop's reset)". Cosmetic honesty, not safety.

**A4. Keep a cheap pre-lock fast-fail.** Nothing forbids checking the permit before *and* after acquiring `command`. The pre-lock check refuses an obviously stale send without parking a blocking-pool thread behind a minutes-long buffered pump. The under-lock check remains the one that counts; R3's mutant must be "delete the under-lock check", not "move it".

**A5. Suppress the trailing `"<label> aborted"` line** (`jobStream.ts:431`) on the refused branch, and have T1 assert its absence along with the absence of "Disconnected" and "complete". The table promises what the operator does *not* see; make the test say it.

**A6. R6's by-hand flag clear.** Fine as a mechanism test; its comment should say the production clearer is `serial_job_begin_inner` and why a confirmed stop cannot coincide with a live pump (the pump is the only reader that can observe the banner while it holds `command`).

**A7. Scope R2's "no `ReadData`" assertion** to trace events after the stale send began; the stop's `try_lock` read of the banner precedes it in the same trace.

**A8. Test wall-clock.** `serial_stop_inner`'s banner wait is a real `Instant` deadline (`serial.rs:1005`); a no-op sleeper spins 3 s if no banner is readable. Script a banner for every R-test stop, and in R3 assert the *absence* of `permit_granted` once the sender holds the lock instead of waiting 500 ms on the green path.

**A9. Declare the empty sweep.** "Every `sim_integration` test calling `serial_stream_job_inner`" is none; the seven `run_buffered_pump(` call sites (1 production, 4 in `serial.rs` sim tests, 2 in `serial_pump.rs`) are the real update list — that count is correct.

**A10. Document the disconnect-with-job race** as expected: stop → teardown → late in-flight detection → re-send hits "not connected" → `in-flight-unreset`. The message is honest; it is not a bug to chase.

**A11. Right-sizing waiver line** (dimension 4): one sentence naming why this batch exceeds eight files and two roots.

**A12. Pre-existing, out of scope, but say it in the relay log:** the stop's Step 5 `flush()` on the realtime handle is a `tcdrain`, i.e. the "blocking output drain from realtime submission" PLAN 1.1 asked to remove. It is not this plan's regression and the plan correctly copies existing behaviour; the next batch that touches the stop should look at it.

---

## Pre-mortem — "three months out, this failed"

1. **The beam fired after STOP, once, on the Falcon.** A held write landed after the reset, the re-send's first attempt hit a transient USB write error, the retry failed, the stop confirmed on the first banner and set Idle; TS said "cancelled", STOP went grey, the operator pressed FRAME and a new job began on a controller that had just executed a standalone `M3 S…`. What we should have seen: B1. The test that would have caught it is the one B1 asks for.
2. **A real job died at line 40 with "no longer accepting this job's lines".** Not a stop at all: `session.jobId` and the admitted epoch diverged because a reconnect (epoch++) happened between `beginJobSession` and the first line, or because the buffered `$32=1` bracket's end-check tripped on a stop that had been *joined* rather than issued. Owner step 3 and R1(a)/R2's accepted first line are the controls; add the reconnect-between-begin-and-send case to T7 as a negative control if cheap.
3. **Everything green, nothing proven end to end.** The TS harness models Rust; R1 drives Rust; nothing drives Tauri IPC ordering with real `spawn_blocking` queues. The plan says so (no in-app scripted-port smoke) and parks it. The honest risk is a queue-ordering behaviour on macOS that neither half sees. Mitigation stays owner step 1 (STOP mid-frame). Keep that smoke high in the Parking Lot.

## Load-bearing assumptions

- **LB-1 (unstated, medium confidence):** the OS tty layer serialises writes from cloned fds in syscall order, on both release targets. If false, a line can precede the `0x18` on the wire yet be detected as in-flight (harmless) — or, the dangerous direction, follow it undetected. Linux and macOS both funnel to one tty write path; state it (A3). Consequence if wrong: the ordering argument is decorative.
- **LB-2 (verified):** only `serial_stop_inner` bumps `permit_generation` in production (`serial.rs:944`; the other writer is a unit test at `serial_session.rs:393`). This is what makes "the re-send can never reset an idle controller" true.
- **LB-3 (verified):** Tauri deserialises a missing `Option` key to `None` (`ipc/command.rs:142`) and a missing required key to a rejection (`:100`). R1's fail-open mutant depends on the first; `serial_stream_job`'s fail-closed claim on the second.
- **LB-4 (verified):** all four `streamJob` production callers pass a session, so requiring it deletes only dead branches.
- **LB-5 (unverified, resolve before implementation):** the baseline counts 823 JS / 310 Rust are caller-stated; the plan already says re-count from the actual run. Keep that.

## Inversion

*For rejected alternative 1 (a bounded submission mutex the stop waits on, ≤250 ms) to win,* the in-flight window would have to be long enough that "reset after the line" is materially worse than "reset before the line" for beam exposure — e.g. a line's `tcdrain` taking hundreds of ms on a slow adapter, during which `M3 S1000` executes. That condition is partly true (the flush is a drain), but the ruling forbids the stop waiting on anything, and 250 ms of stop delay is worse than a 2.6 ms line followed by a reset. Rejection stands.

*For rejected alternative 2 (mark Unknown only, no re-send) to win,* the controller would have to reject line input after a reset until the host acknowledges — it does not; GRBL accepts lines immediately after the banner. Rejection stands, and RF-1's standalone `M3` is the case that makes it matter.

*For a typed IPC result instead of the string prefix to win,* more than one caller would have to consume refusals. Only `jobStream` can; the prefix is right for now, and the constants make a later type change mechanical.

## Overall verdict

APPROVE WITH CHANGES. The plan solves the stated gap the right way — the permit under the lock is prevention, the generation check is detection, and the ordered re-send is what PLAN 1.1 asked for and 1.1 never delivered — and its citations are accurate against the tree (every line reference I checked matched). The extra `0x18` sits inside the 2026-09-20 ruling and needs a DECISIONS pin, not a fresh ruling. The one thing that must change before implementation is B1: the failure path where the re-send itself fails must end with admission closed and STOP still live, and today's plan text lets a confirmed stop reopen admission and lets TS grey out the only in-app recovery. Everything else is wording, test fidelity and cost.

## Must-fix, prioritised

1. **B1** — re-send failure keeps phase Unknown (stop confirm must not overwrite it; CAS `Stopping→Idle`), and `in-flight-unreset` maps to `"unknown"` so STOP remains available. Add the two named tests and mutants.
2. **A2** — harness rejects with raw strings; pin it.
3. **A5** — suppress the trailing "aborted" line on refusal; assert it in T1.
4. **A1** — DECISIONS pin wording that records "up to two `0x18`, never via the joiner".
5. **A3 / A11 / A9** — state the tty-ordering assumption, the batch-size waiver, and the empty `sim_integration` sweep.
6. **A4, A6, A7, A8, A10, A12** — as written; none blocks.
