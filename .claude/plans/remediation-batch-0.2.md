# Remediation Batch 0.2 — Test the Actual Buttons and Asynchronous Continuations

## Intent (grilled)

**Summary:** Build a unified ordered recorder with controllable deferred promises for the TS test harness. Drive START/PAUSE/STOP through rendered JobActionBar and prove that STOP dispatches the real `emergencyStop()` byte sequence. Document current unsafe cross-job corruption as `it.fails` pending regression work. This gives later safety batches (1.1–1.5) the ability to prove that STOP reaches the controller and that old job callbacks can't corrupt a new job.

**Skip note:** Intent derived from the reconciled remediation plan at `~/marvin/state/audits/kerf-astra-2026-09-08/PLAN.md` batch 0.2. R14 (test names overclaim production coverage) is the addressed finding. No grill — the audit IS the grounding.

## Context

The existing TS tests mock `invoke` at the Tauri IPC boundary with immediate resolution. This means:
- A test "clicking STOP" may assert the store changed but can't prove `emergencyStop()`'s bytes (`serial_send_byte` 0x21 then 0x18) were dispatched
- Callbacks from job A that arrive after job B starts aren't exercised
- `machineJobLoop.test.tsx`'s `sentCommands()`/`sentBytes()` helpers group by type, losing cross-channel order

**Spec reconciliation (what is covered, what is cut):**
- START/PAUSE via rendered JobActionBar: **already covered** by existing tests (`fireEvent.click(getByText("START"))`, `"PAUSE"`, `"RESUME"`)
- Deferred invokes, serialized native event fixtures: **this batch**
- Timed-out versus busy status outcomes: **cut** — belongs with batch 1.2's status contract
- After-stop/after-reconnect callbacks: **cut** — belongs with batch 1.4/1.5's ownership pair

**Target:** 4 TS test files (3 existing + 1 new harness), no production files, no Rust changes.

Baseline: 764 JS tests (28 in machineJobLoop, 30 in connection, 11 in jobStream), 260 Rust tests.

## Files

### 1. `src/lib/machine/__tests__/serialTraceHarness.ts` (NEW)

A reusable test harness for serial command testing. **One recorder replaces the separate assertion patterns** — `sentCommands()`/`sentBytes()` become derived views over the recorder's list, so existing assertions change by zero characters.

- **Ordered recorder:** Captures every `invoke()` call in order with its command name, arguments, and a controllable promise. Default: immediate resolution through the same `onSend(command)` callback that `mockSerial` uses today. Deferral is opt-in per command name.
- **Installation:** The harness is a **factory** the test file installs into its own hoisted `mockInvoke` (`mockInvoke.mockImplementation(recorder.handler)`). Each test file declares its own `vi.mock("@tauri-apps/api/core")` — the harness cannot own it.
- **Deferred invokes:** Each deferred invoke returns a promise the test controls. `waitUntilInvoked(commandName, { timeoutMs })` — returns when the named command appears; rejects with recorder contents on timeout. `releaseInvoke(index, result)` — resolves the deferred at the given index.
- **Channel capture and event delivery:** When the recorder sees `serial_stream_job`, it captures the `channel` argument. `emit(fixture)` calls `channel.onmessage(fixture)` to deliver events into production code.
- **Derived views:** `sentCommands()` and `sentBytes()` filter the ordered list, preserving backward compatibility with existing assertions.
- **Teardown:** `recorder.dispose()` rejects every still-pending deferred and awaits any job promise the test started, so a leak fails the test that caused it. Called in `afterEach`.
- **Native event fixtures:** Typed locally with a comment naming both sources (`serial.rs:514-531` Rust enum, `jobStream.ts:125-132` TS mirror — neither exported). Four variants: Progress (`{ type: "progress", lineIndex, total }`), Console (`{ type: "console", text }`), Status (`{ type: "status", status }`), Finished (`{ type: "finished", result }`). One fixture-shape test per variant pushes through `channel.onmessage` and asserts the store effect (progress ratio, console line content).

### 2. `src/components/panels/__tests__/machineJobLoop.test.tsx`

Migrate to the unified recorder. Existing 28 tests stay; their assertions change by zero characters (derived views).

**STOP dispatch test (NEW):** Render `JobActionBar` with `jobRunning: true` seeded. Click STOP (`fireEvent.click(getByText("STOP"))`). Assert that `serial_send_byte` with byte 0x21 appears in the recorder, followed by `serial_send_byte` with byte 0x18. The byte ORDER matters — it guards the DECISIONS pin "abort order … never an ack-awaited write in between". Uses fake timers + `runAllTimersAsync()` to advance through `emergencyStop()`'s 100ms + 200ms sleeps.

**Mutation:** deleting `JobActionBar.tsx:105` (`await machineConnection.emergencyStop()`) → only `setJobRunning(false)` remains → no bytes dispatched → assertion on `serial_send_byte` 0x21 fails.

**Renames (honest scope):**
- `"skips the abort volley when the user pressed STOP (emergencyStop owns it)"` (line ~187) → rename to clarify this is store-only, not a dispatch test
- `"STOP while PAUSED sends NO further line (e-stop re-poll leaves hold)"` (line ~206) → rename similarly

**Preserved:** The two STOP-while-PAUSED hold-wait tests (lines ~206-249) — the only mutation guard on the `jobRunning` clause at `jobStream.ts:308`. Keep them.

### 3. `src/lib/machine/__tests__/connection.test.ts`

Migrate to the unified recorder. Existing ~30 tests stay; assertions unchanged (derived views).

**Recorder self-test (NEW):** Point the recorder at `emergencyStop()`'s known sequence: `serial_send_byte(0x21)`, `serial_send_byte(0x18)`, `serial_get_status`, `serial_send("M5\n")`. Assert the recorder preserves cross-channel order. Must go RED if the recorder groups all bytes before all lines.

### 4. `src/lib/machine/__tests__/jobStream.test.ts`

Migrate to the unified recorder. Existing 11 tests stay.

**Deferred-callback harness test (NEW):** Create a deferred invoke, verify it's pending, release it at a barrier, verify it resolved. Must go RED if callbacks are delivered immediately.

**Cross-job corruption test (NEW, `it.fails`):** Start job A (deferred send), start job B, release A's send with `ok`. **Current tree corrupts B** (A re-reads `jobRunning` which B set true, A keeps sending, A's completion cancels B). This test is `it.fails("R4/R11: job A late callback corrupts job B — owned by batch 1.4", ...)`. It goes RED today (which `it.fails` expects), and goes RED again when batch 1.4 fixes it (forcing the flip to `it`).

## Acceptance criteria

1. A test clicking STOP observes `serial_send_byte` 0x21 then 0x18 in the recorder; deleting `JobActionBar.tsx:105` fails it.
2. Harness can leave a line promise pending while a realtime invoke is recorded, and can deliver job A's callback after job B begins.
3. Current unsafe behavior is documented as `it.fails` with finding ID and owning batch, never as a passing safety requirement.

## Required mutation tests (battery spec)

| Mutant | File | Target | Expected RED test |
|---|---|---|---|
| 1. STOP dispatch | `src/components/panels/JobActionBar.tsx` | Delete line 105 (`await machineConnection.emergencyStop()`) | `STOP click dispatches emergencyStop byte sequence` in machineJobLoop |
| 2. Recorder order | `src/lib/machine/__tests__/serialTraceHarness.ts` | Make `sentCommands()` return commands before bytes regardless of invoke order | recorder self-test in connection.test |
| 3. Deferred immediacy | `src/lib/machine/__tests__/serialTraceHarness.ts` | Make all deferred promises resolve immediately in the constructor | deferred-callback test in jobStream.test |

## Verification

```sh
npx vitest run src/components/panels/__tests__/machineJobLoop.test.tsx src/lib/machine/__tests__/connection.test.ts src/lib/machine/__tests__/jobStream.test.ts
npx tsc --noEmit
npx vitest run
```

All existing 764 JS tests must continue to pass. New tests add to the count.

## Out of scope

- All production files — no changes to connection.ts, jobStream.ts, JobActionBar.tsx
- Rust files
- Fixing cross-job corruption (batch 1.4)
- Timed-out vs busy status outcomes (batch 1.2)
- After-stop/after-reconnect callbacks (batch 1.4/1.5)

## Risk register

| Risk | Mitigation |
|---|---|
| STOP test passes by asserting store state, not byte dispatch | Test must assert on `serial_send_byte` 0x21 then 0x18 in recorder order |
| Cross-job test asserts a false invariant | `it.fails` — goes RED today (expected), goes RED again when fixed (forces flip) |
| Pending deferreds leak across tests | `recorder.dispose()` in `afterEach`; rejects pending + awaits started jobs |
| Fake timers + deferred promises + rendered click conflict | STOP test uses `vi.useFakeTimers()` + `runAllTimersAsync()` per existing pattern |
| Three recorders coexist | One recorder; derived views replace `sentCommands`/`sentBytes`; zero assertion changes |
