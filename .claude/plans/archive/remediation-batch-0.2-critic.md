# Critic review — Remediation Batch 0.2 (serial trace harness + STOP dispatch)

Plan: `.claude/plans/remediation-batch-0.2.md`
Spec: `~/marvin/state/audits/kerf-astra-2026-09-08/PLAN.md` lines 84–98
Rubric: `~/marvin/rules/plan-critic-rubric.md` (v2)
Reviewer: Fable (reviewer valve read `fable`; suspended-window fallback per rubric)
Date: 2026-09-20

Ground truth read before any verdict: the plan, the spec, `.claude/DECISIONS.md`, all three
target test files, `JobActionBar.tsx:60–120`, `connection.ts:535–600` (`emergencyStop`),
`jobStream.ts:120–330` (JobEvent mirror, buffered path, per-line loop), `serial.rs:505–545`
(Rust `JobEvent`), ROADMAP Parking Lot. Full JS suite run: **764 passed (764)**, 50 files.
Rust 260 not re-run (no Rust in scope; not load-bearing).

## Applicability

**Project type:** Laser CAD/CAM desktop app (Tauri/React). This batch: test-only, TS side,
four files, no production code. Standard tier. `## Intent (grilled)` present with a written
skip line — Problem-fit's FAIL trigger does not apply.

| Dim | Fires? | Tag | Why |
|---|---|---|---|
| X1 Physical safety | **Yes** | **GATING** | No production code moves, but the harness built here is what batches 1.1–1.5 will use to prove STOP reaches the controller. A harness that can fabricate a dispatch is a harness that certifies a STOP that never sent 0x18. The spec names this exact risk ("Tests fabricate the action that production forgot to dispatch"). |
| X2 Privacy | No | — | No personal, client or health data anywhere in scope. |
| X3 Evidence | No | — | Produces tests, not research or public claims. (The plan's own factual claims are checked under core dimensions.) |
| X4 Audience/brand/money | No | — | Nothing client- or public-facing. |
| X5 Concurrency | **Yes** | **GATING** (X1-class plan) | The whole point of the deferred-invoke seam is overlapping jobs and late callbacks against a module-global Zustand store. |
| X6 Operability | No | — | Nothing ships or runs unattended. |
| X7 Self-modification | No | — | Touches no MARVIN gate, hook, skill or automation. |
| X8 Deps/perf/cost | No | — | No new packages; vitest already present. |

## Core dimensions

### 1. Problem-fit — CONCERN
Solves the stated need (R14: names overclaim; seam for R1/R4/R11/R12) and contradicts no
DECISIONS entry. Two drifts from the spec, neither named as a deliberate cut:

- Spec: "Support deferred invokes, **timed-out versus busy status outcomes**, serialized native
  event fixtures, and callbacks arriving **after stop/reconnect**." The plan has deferred
  invokes, fixtures, and "callback after job B begins". Timed-out-vs-busy status is absent;
  after-stop and after-reconnect are absent. If cut, say so and park it (see Dim 4).
- Spec: "Drive START/PAUSE/STOP through rendered JobActionBar." The plan adds only STOP.
  START and PAUSE/RESUME are already driven through `JobActionBar` in the existing file
  (`fireEvent.click(getByText("START"))`, `"PAUSE"`, `"RESUME"`) — so this is fine, but the
  plan should state that START/PAUSE are already covered rather than leave the reader to
  discover the spec line was two-thirds done before the batch started.

**Fix:** add one line per spec item: covered / already covered by existing test X / cut and parked.

### 2. Approach soundness — CONCERN
Ordered recorder + controllable deferred promise per invoke is the right primitive, and it
matches what batch 0.1 did on the Rust side. Three things the design is silent on that decide
whether it works at all:

- **`vi.mock` is hoisted per test file.** The harness in `src/lib/machine/__tests__/` cannot own
  the `@tauri-apps/api/core` mock; each of the three test files declares its own (and
  `jobStream.test.ts` additionally mocks `Channel`, `machineJobLoop.test.tsx` does not). The
  harness must be a factory the test file installs into its own `mockInvoke`
  (`mockInvoke.mockImplementation(recorder.handler)`). Say so, or Ted will discover it at
  implementation time and improvise.
- **How a JobEvent fixture is delivered.** Fixtures are only consumable on the buffered path,
  through `channel.onmessage` (`jobStream.ts:146`). The harness must capture the `channel`
  argument off the recorded `serial_stream_job` invoke and expose `emit(index, fixture)` that
  calls `channel.onmessage(fixture)`. The plan lists fixtures as data and never says how they
  reach production code.
- **Timer strategy.** `emergencyStop` sleeps 100 ms + 200 ms and re-polls; every existing e-stop
  test uses `vi.useFakeTimers()` + `runAllTimersAsync()`. The STOP dispatch test clicks a
  rendered button and then must observe bytes across those sleeps. `waitUntilInvoked` must be
  promise-driven (microtask barrier), not timer-driven, or it deadlocks under fake timers.
  Name which timer mode the STOP test uses.

### 3. Completeness — FAIL
The plan's deferred-callback test (File 3) says: "Start job A (deferred invoke), start job B,
then resolve A's callback. **Assert B's state is not corrupted** by A's late resolution."

Against the current tree that assertion is false. Traced in `jobStream.ts:302–322`: job A
parks in `await machineConnection.send(lines[i])`. `handleStartJob` for B sets `jobRunning`
true and starts B's loop. Releasing A's send with `ok` runs A's `setJobProgress`, A re-checks
`jobRunning` (true, set by B), and A sends its next line — interleaved with B's. When A finishes
it sets `jobRunning` false and B's next iteration reports "Job cancelled". B's progress and
B's outcome are both corrupted. This is R4/R11 and is exactly why Phase 1 exists.

So the test as written goes RED on a batch that forbids touching production. The implementer
then has two moves, and both are the failure the spec names: weaken the assertion until it
passes (the harness "proves" corruption absent while present), or fix production (violates
out-of-scope). Acceptance criterion 3 — "current unsafe behavior is documented as pending
regression work, never as a passing safety requirement" — is the plan's own answer, but no
File section applies it and no mechanism is named.

**Fix:** state the mechanism. `it.fails("…", …)` with a comment naming the finding and the
batch that owns the fix (1.1/1.4 ownership pair). `it.fails` is the right shape because it
goes RED again the day the fix lands, forcing the flip to `it` — that IS "documented as
pending regression work". `it.todo`/`it.skip` do not run the harness and prove nothing about
the seam. Apply the same rule to any after-stop/after-reconnect case added under Dim 1.

Two smaller gaps, same dimension:
- "Rename any that claim 'safety' scope but only test store state" — not enumerated. From the
  file, the two that claim STOP behaviour without ever clicking STOP are
  `"skips the abort volley when the user pressed STOP (emergencyStop owns it)"` (the mock
  fakes `handleStop` via `useStore.setState({ jobRunning: false })`, line 192) and
  `"STOP while PAUSED sends NO further line (e-stop re-poll leaves hold)"` (line 221, same
  fake). List them by name so Razor can check the rename happened and nothing else moved.
- "Preserve narrowly useful per-line cancellation tests" echoes the spec without naming which
  tests those are. They are the two STOP-while-PAUSED hold-wait tests (lines 206–249) — the
  second is the only mutation guard on the `jobRunning` clause at `jobStream.ts:308`.

### 4. Right-sizing & reuse — CONCERN
Four files, one subsystem, under the batch cap; no dependency graph needed at this tier.
Issues:

- **"Replace" vs "coexist".** Summary and spec say the recorder *replaces* the separate
  `sentCommands`/`sentBytes` arrays. Risk register says "Existing tests keep their own mock;
  only new tests use the recorder." That leaves three recorders in the tree: the
  `sentCommands`/`sentBytes` pair (`machineJobLoop`), the ordered `calls[]` in `mockEStop`
  (`connection.test.ts:392–412` — which, note, **already preserves cross-channel order**; the
  "groups all bytes before all lines" defect is specific to `machineJobLoop`'s two filters),
  and the new one. Pick one. The clean version: the recorder defaults to immediate resolution
  through the same `onSend(command)` hook `mockSerial` uses today, deferral is opt-in per
  command, and `sentCommands()`/`sentBytes()` become derived views over the recorder's list.
  Existing assertions change by zero characters; there is one recorder; the risk-register
  mitigation becomes unnecessary.
- **Parking Lot.** Out-of-scope is listed but nothing is indexed in `ROADMAP.md → ## Parking
  Lot`. The production fixes are scheduled (batches 1.x), not deferred, so they need no
  entry. The spec items dropped under Dim 1 (timed-out vs busy status; after-reconnect
  callback) ARE deferrals and need an index line or a decision to include them.
- Harness self-tests (recorder order; deferred pending→released) are tests of test code
  placed inside `connection.test.ts` and `jobStream.test.ts`, which are production-module
  suites. They belong in `serialTraceHarness.test.ts`. That is a fifth file against a spec
  that names four; either take the one-line waiver or put both self-tests in a
  `describe("serialTraceHarness")` block in one file, not split across two.

### 5. Security — PASS
Test-only; no secrets, no auth surface, no blast radius beyond the test run.

### 6. Failure modes — CONCERN
A deferred promise that is never released hangs the test until vitest's 5 s default, and a
`waitUntilInvoked` for a command that never arrives does the same. Batch 0.1 required
"every scenario … has a finite harness timeout"; 0.2 should inherit it. More important:
**pending deferreds leak across tests.** The store is module-global. A job loop from test N
parked in a deferred `send` that a later test releases (or that fake-timer teardown wakes)
fires `setJobProgress`/`addConsoleLine` into test N+1. Nothing in the plan tears down.

**Fix:** `waitUntilInvoked(name, { timeoutMs })` rejects with the recorder's contents in the
message; an `afterEach` (or `recorder.dispose()`) rejects every still-pending deferred and
awaits any job promise the test started, so a leak fails the test that caused it rather than
the one after.

### 7. Change safety — PASS
Tests and one new test-support file; fully reversible; nothing irreversible is touched.

### 8. Data integrity & compatibility — CONCERN
The JobEvent shape now has a third copy. Rust `serial.rs:514–531` (`serde(tag="type",
rename_all="camelCase")` → `lineIndex`), the TS mirror `jobStream.ts:125–132` (matches, but
**not exported**), and the harness fixtures. The harness cannot import the production
interface without adding `export`, which the out-of-scope rule forbids. Drift is silent: a
fixture with `line_index` would type-check against a harness-local type and never reach the
`event.total` branch. Two of the plan's claims here are also loose: the fixtures "match the
Rust-serialized shape from batch 0.1's contract" — the enum is Phase 2A's and predates 0.1;
0.1 added the `on_event: &dyn Fn(JobEvent)` seam, not the shape.

**Fix (minimum):** harness fixture type declared locally with a comment naming both sources
and their line numbers, and one fixture-shape assertion that pushes each of the four
variants through `channel.onmessage` and observes the store effect (progress ratio, console
line, DRO position). That proves the fixture is the shape production reads, without the Rust
side. Exporting the interface is the right long-term fix and belongs in the first batch that
is allowed to touch `jobStream.ts`.

### 9. Verifiability (incl. testing the tests) — FAIL
This is the batch whose entire value is its mutation tests, and the headline one names code
that does not exist.

- **Mutant 1 is unfalsifiable as written.** Plan: "delete `handleStop`'s
  `invoke("emergency_stop")` call → test fails." There is no `invoke("emergency_stop")`
  anywhere in `src/`. `handleStop` (`JobActionBar.tsx:103–106`) is
  `setJobRunning(false); await machineConnection.emergencyStop();` and `emergencyStop`
  dispatches `invoke("serial_send_byte", { byte: 0x21 })` then `{ byte: 0x18 }`
  (`connection.ts:548, 560`). A Ted who greps for the named call finds nothing and either
  invents a pseudo-command in the harness (the spec's stated worst case) or asserts on bytes
  without ever running the mutant. Re-specify: **mutant = delete `JobActionBar.tsx:105`**;
  the test must observe `serial_send_byte 0x21` followed by `serial_send_byte 0x18` in the
  recorder after `fireEvent.click(getByText("STOP"))`, with `jobRunning: true` seeded so the
  button renders. Asserting the byte order, not just presence, is what makes the test also
  guard the DECISIONS pin "abort order … never an ack-awaited write in between".
- **Mutant 2 mutates test code.** "Make the recorder group all bytes before all lines" is a
  mutation of the harness, not of production. Legitimate as a harness self-test, but it
  proves the recorder, not the seam. Stronger and cheaper: run the self-test against a
  production path with a known cross-channel order — `emergencyStop` produces
  `byte(21), byte(18), status, send(M5)` and the existing test at `connection.test.ts:414–424`
  already pins it. Point the recorder at that sequence.
- **The mutation battery is not named.** `rules/architecture.md`: every relay worker
  mutation-verifies new tests through `scripts/mutation-battery.mjs`, never a hand-rolled
  script. The plan's "Required mutation tests" section reads as three prose sentences. It
  needs a spec the battery can consume: file, line/pattern, expected RED test name — and
  mutants 2 and 3 need the harness file as their target, which the battery must be told.
- **`it.fails` discipline** (Dim 3) is part of verifiability: without it, AC3 has no
  observable and Razor cannot check it.
- **Counts.** "The 13 existing `machineJobLoop` tests stay" — the file has **28** `it(`
  blocks. 764 JS baseline is correct (verified this session). Wrong counts in a plan that
  will be used to check "nothing was deleted" are not cosmetic; fix the number.

### 10. Maintainability — PASS (with a note)
A reusable harness is the right seam and the later batches need it. Note: the plan does not
say the harness is exported for `machineJobLoop.test.tsx` (a `components/` test importing
from `lib/machine/__tests__/`) — fine, but state it so nobody "tidies" it into a
`components/` copy.

## Conditional dimensions

### X1 Physical & human safety — CONCERN (GATING)
No control path changes; the interlock question is whether the proof infrastructure can lie.
Two ways it can, both above: mutant 1 as written targets nonexistent code (Dim 9), and the
A/B test as written must be weakened to pass (Dim 3). Both are fixed by re-specification, not
by new design. Hardware-only paths: correctly named as none — nothing here can be
hardware-tested and nothing needs to be. Worst-case physical outcome if this batch is done
wrong, stated per the rubric: a later batch's STOP test is green against a harness-side shim,
production never sends 0x18, the operator presses STOP on the bench and the beam stays on.
Passes to PASS once Dim 3 and Dim 9 must-fixes land.

### X5 Concurrency & re-entrancy — CONCERN (GATING)
The seam is for exactly this, and the plan's one overlap scenario (A then B) is the right
first one. Missing: overlap with STOP (A's send resolves after `handleStop`) and with
reconnect (spec names both); teardown of leaked pending work across tests (Dim 6). "What if
this runs twice" is not asked of `waitUntilInvoked` itself — two barriers waiting on the same
command name must both resolve, or the second waiter must be refused; say which.

X2, X3, X4, X6, X7, X8 — N/A (reasons in the applicability table).

## Stress tests

### Pre-mortem — three months out, this failed
1. **The laser stays on after STOP with a green suite.** Ted found no `emergency_stop`, added
   a `recorder.expectCommand("emergency_stop")` shim that the harness itself satisfied, the
   "mutation test" was run by deleting a line that did nothing, and batch 1.1 built on it.
   What we should have seen: a mutant spec naming `JobActionBar.tsx:105` and a battery
   journal showing that mutant RED.
2. **Corruption "proven absent" while present.** The A/B test went RED on the tree, the
   assertion was softened to `expect(jobRunning).toBe(true)` (true during corruption), green,
   merged. Batch 1.4 later has no red-to-green evidence that ownership fixed anything. What we
   should have seen: `it.fails` with the finding id in the name.
3. **The suite goes flaky and someone `skip`s it.** A deferred left pending in one test wakes
   in the next under fake timers; intermittent "Job cancelled" lines in unrelated tests; the
   fix is `it.skip` on the harness tests. What we should have seen: a `dispose()` that fails
   the leaking test.

### Load-bearing assumptions
- **Deleting `JobActionBar.tsx:105` turns a recorder-based STOP test RED.** High confidence:
  the remaining body is `setJobRunning(false)` only, no byte is sent. Consequence if wrong: the
  batch's headline test is decorative. Resolve at implementation by running the battery.
- **Job A's late `ok` corrupts job B on the current tree.** High confidence from the loop at
  `jobStream.ts:302–322`; not executed. Consequence if wrong: the `it.fails` test fails
  (vitest reports an `it.fails` that passes as a failure), which is the correct signal — flip
  it to `it` and record that the finding was already closed. Resolve before writing: run it.
- **Fake timers, deferred promises and `waitFor` coexist.** Medium confidence; the existing
  file mixes `vi.useFakeTimers()` in some blocks and `waitFor` (real timers) in others, never
  both in one test. The STOP test needs both a rendered click and three timer sleeps.
  Resolve-before-implementation: one spike test proving the combination.
- **764 JS baseline.** Verified this session.

### Inversion
- *Spy on `machineConnection.emergencyStop` instead of recording bytes.* Wins if the goal were
  only "the handler was called". Loses because Phase 1 has to prove the **byte order** (the
  DECISIONS abort-order pin), and a spy proves nothing about it. The condition under which it
  wins is not true.
- *No harness self-tests; let the mutation battery mutate the harness.* Wins if the battery
  is the only honest proof of test code — which is already true. The self-tests are cheap and
  fast, so keep them, but do not report them as proof of anything beyond the recorder.
- *Keep three recorders and skip the "replace".* Wins if migration risk to 28 existing tests
  is real. It is not: the derived-view design (Dim 4) changes zero assertions. The spec said
  replace; do it.

## Overall verdict — FAIL

The design is right and small — an ordered recorder with controllable promises is exactly the
seam batch 0.1 built on the Rust side and the later batches need on this side. The plan fails
on the two things that make this batch worth doing: its headline mutation test targets a call
that does not exist in the tree (`invoke("emergency_stop")` — the real dispatch is
`emergencyStop()` → `serial_send_byte` 0x21/0x18), and its cross-job test asserts an
invariant the current code violates, on a batch that forbids fixing it, with no `it.fails`
mechanism named to honour its own acceptance criterion 3. Either gap, left as written, makes
the harness capable of certifying a STOP that never reached the controller — the one outcome
this whole program exists to prevent. Both are one-paragraph re-specifications; the rest is
CONCERN-grade tightening.

## Must-fix (prioritized)

1. **Re-specify mutant 1** to "delete `JobActionBar.tsx:105` (`await
   machineConnection.emergencyStop()`)" and the STOP test's observable to "`serial_send_byte`
   0x21 then 0x18 in recorder order after clicking STOP with `jobRunning: true`". Remove every
   mention of `invoke("emergency_stop")`. (Dim 9, X1)
2. **Name the pending-work mechanism:** the A/B deferred-callback test is `it.fails`, named
   with the finding (R4/R11) and the owning batch; same for any after-stop/after-reconnect
   case. Run it before writing it to confirm it is RED today. (Dim 3, X1, X5)
3. **Write the mutation spec for the battery** (`scripts/mutation-battery.mjs`): three
   entries, each with file, target line/pattern, and the test expected RED. Mutants 2 and 3
   target the harness file. (Dim 9)
4. **Reconcile "replace" with the risk register:** one recorder; `sentCommands`/`sentBytes`
   become derived views; deferral opt-in per command; existing assertions untouched. Or state
   a waiver for coexistence. (Dim 4)
5. **Teardown and timeouts:** `waitUntilInvoked` takes a timeout and rejects with the recorder
   contents; `dispose()` in `afterEach` rejects pending deferreds and awaits started jobs.
   (Dim 6, X5)
6. **Enumerate the renames** by current test name (the two STOP-faking tests at
   `machineJobLoop.test.tsx:187` and `:206`) and the preserved cancellation tests (`:206–249`).
   Correct "13 existing tests" to 28. (Dim 3, Dim 9)
7. **Spec reconciliation line per item:** timed-out-vs-busy status outcomes and
   after-reconnect callbacks — include, or cut and index in the Parking Lot. Note that
   START/PAUSE via `JobActionBar` are already covered by existing tests. (Dim 1, Dim 4)
8. **Say how the harness installs and how fixtures are delivered:** factory into each file's
   own `mockInvoke`; `channel` captured off the `serial_stream_job` record; `emit()` calls
   `onmessage`. One fixture-shape test per variant against the store. Fix the "batch 0.1's
   contract" attribution. (Dim 2, Dim 8)
