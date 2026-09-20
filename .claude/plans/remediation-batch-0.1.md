# Remediation Batch 0.1 — Native Command-Body Trace Harness

## Intent (grilled)

**Summary:** Extract injectable command bodies from the real serial connect/send/status/stream wrappers so later safety fixes can be tested against the production code path, not copies of it. Add a scripted port with controlled timing for deterministic replay of every serial failure mode the remediation program needs to exercise. This is the test infrastructure that makes the rest of the 20-batch program falsifiable.

**Skip note:** Intent derived from the four independent astra audit reports and the reconciled remediation plan at `~/marvin/state/audits/kerf-astra-2026-09-08/PLAN.md`. R14 (test names overclaim production coverage) is the addressed finding. No grill session — the audit IS the grounding.

## Context

The existing test suite mocks command dispatch at the Tauri IPC boundary, which means a deleted STOP handler or a missing pause guard passes every test. The GRBL simulator (`sim/grbl.rs`) is useful but models its own physics, not the production serial wrappers' lock/admission/teardown logic. Later batches (1.1–1.5) need to prove that STOP actually reaches the controller, that old producers can't resume after reset, and that status polling can't manufacture safety — all against the real code paths.

**What we're building:**
1. Extract the bodies of `serial_connect`, `serial_send`, `serial_get_status`, and `serial_stream_job` into testable inner functions that take an injected port factory, event sink, and sleeper
2. Create a `ScriptedPort` — a deterministic test double implementing `SerialPort` with barriers, controlled read ticks, and an ordered trace of all I/O
3. Supply fixtures for the failure modes the remediation program needs: all-acks-lost-until-reset, pending M5, queued acks before banner, Hold with unsent work (budget-sensitive), partial input and chatter
4. Wire the scripted port under the existing `sim` feature via a reserved port-name scheme in the port factory

**Target:** 4 files (Rust only), no hardware, no browser, no frontend changes.

Baseline: record from `cargo test --manifest-path src-tauri/Cargo.toml --features sim` at the starting commit. (The `#[test]` attribute count is 234; `cargo test` includes parameterized and sim-feature tests that differ from the attribute count.)

## Files

### 1. `src-tauri/src/commands/serial.rs`

Extract the bodies of three command wrappers plus the stream closure into testable inner functions. Follow the existing pattern: `disconnect_inner`, `send_byte_inner`, `drain_startup_banner` are already `pub(crate)` bodies over `&SerialInner`/`&mut CommandChannel`. The new extractions take the same shape — `pub(crate)` functions over `&SerialInner` plus injected parameters.

The `#[tauri::command]` wrappers become thin shells. Their signatures and serde shapes are unchanged.

**Key extractions (the four closures that are currently inline):**
- `serial_connect` → extract the connect-and-drain-banner logic. **Connect body sleeps 50 + 1500 + 500 ms** (lines ~248, ~250, ~268); inject `&dyn Fn(Duration)` as the sleeper, with the wrapper passing `std::thread::sleep`. This keeps fixtures under 100ms instead of 2.05s each.
- `serial_send` → extract the line-write-and-wait-for-terminal logic
- `serial_get_status` → extract the status-query-and-parse logic
- `serial_stream_job` (lines ~523–654) → extract the abort-flag reset, lock acquisition, `PumpFlight`, `$32=1` gate, G-code line filtering, and `Channel<JobEvent>` event mapping. The event sink at the body boundary is `&dyn Fn(JobEvent)`, with the wrapper adapting the Tauri `Channel`.

**NOT extracted (already done or doesn't exist as Rust):**
- "Stop/reset submission logic" — the only stop/reset writes (`send_byte_inner`, `disconnect_inner_with_job`) are already `pub(crate)` bodies with pin tests. The stop *volley* lives in TS (`connection.ts`). No new Rust-side stop path.

Preserve all existing lock/admission/lifecycle behavior exactly. The extraction is behavior-preserving — production paths must be byte-identical. Reviewer must verify this with `git diff --color-moved=dimmed-zebra`: every line of each closure appears in the extracted body unchanged except for the injected parameters, and the wrapper is a one-call shell.

**Four invariant pins (the physical-safety load-bearing lines, currently untested):**
1. Send body holds `PumpFlight` for its whole duration — test: disconnect-from-another-thread writes `0x18` on the realtime handle while the send body is parked on a read barrier; assert the reset byte appears in the trace.
2. Status body uses `try_lock`, not `lock` — test: hold `command`, call the body, expect the empty `StatusOutcome` sentinel, never a block. This is the exact property DECISIONS "0x9E is a toggle" documents.
3. Stream body writes `$32=1\n` as its first line and returns `Err` containing "$32=1" when no `ok` arrives — test: script a rejection; assert the body exits and the line is in the trace.
4. Connect body writes `0x18` exactly once between the two banner drains — test: count `0x18` bytes in the trace between the DTR-deassert and the first `$$` line.

### 2. `src-tauri/src/commands/serial_pump.rs`

**No extraction needed.** `run_pump` and `run_buffered_pump` are already pure over `BufRead + ProbeWriter` / `Write + ProbeWriter` (lines ~160, ~456) and are already driven by `ScriptReader` (line ~670) in `serial_pump::tests` and by `SimPort` in `serial::sim_integration`. This file changes only if the `ProbeWriter`/`PumpReader` traits need a method for the scripted port (e.g. if `ScriptedPort` needs to satisfy a trait bound used by the pump).

### 3. `src-tauri/src/sim/mod.rs`

Register the new `ScriptedPort` alongside the existing `SimPort` (note: the type is `SimPort`, not `GrblSimPort`). Both gated on `#[cfg(any(test, feature = "sim"))]`. The scripted port is absent in release builds.

**Port selection:** a reserved `port_name` scheme resolved inside the port factory under `#[cfg(feature = "sim")]`. Names like `sim://scripted` and `sim://grbl` select the double; any other name calls `serialport::new(..).open()`. The selector lives only in the factory function. `cargo check --manifest-path src-tauri/Cargo.toml` (without features) is the absence proof for both the module and the selector.

Update the `sim/mod.rs` header if it still says "not wired up" — that becomes false once the selector exists.

### 4. `src-tauri/src/sim/scripted_port.rs` (NEW)

A `ScriptedPort` implementing `serialport::SerialPort` with:
- **Scripted reads:** A queue of read responses (bytes, timeouts, errors) delivered in order. **One data step per `read()` return** (matching the `ScriptReader::available_now` rule from serial_pump.rs:714–723). Each read can block on a barrier until released by the test.
- **`bytes_to_read`:** Returns the byte count of queued data steps up to the first timeout/barrier. This is load-bearing: `drain_classified` calls `available_now()` which depends on `bytes_to_read()` to decide whether to pull. The existing `MockPort` returns 0 and makes every drain a no-op — the scripted port must not repeat this.
- **Controlled clock:** Logical ticks instead of wall-clock time, so tests are deterministic.
- **Ordered trace:** Records every read, line write, byte write, flush, and `write_data_terminal_ready` call in a single ordered log. Each entry carries a handle-role tag (writer/reader/realtime) so the "realtime 0x18 reaches the wire while command lock is held" invariant is assertable.
- **Barriers:** Test code can hold a read or write at a specific point, inspect the trace, then release. Barriers are released/poisoned on `Drop` of the test's harness handle, so a panicked assertion thread doesn't orphan workers.
- **try_clone:** Must work (production clones for read/write/realtime handles). All clones share the same script, trace, and barriers via `Arc<Mutex>`, matching the `SimPort` pattern.
- **Teardown:** Every wait uses `recv_timeout`/`wait_timeout` with a finite bound.
- **Deadline helper:** `run_with_deadline(Duration, FnOnce) -> Result` — structural, not per-test discipline. Every scenario goes through it.

**Fixtures to supply** (as test helper functions):
1. All-line-acks-lost-until-reset: send lines, no `ok` replies, then `0x18` → banner
2. Pending M5: `M5` sent, no `ok`, then reset
3. Queued acks before banner: `ok` arrives before the connect banner completes
4. Hold with unsent work *and budget-sensitive timing*: budget small enough that ≥1 line is unsent, `<Hold|…>` arrives, then `ok` arrives *while still in Hold*, then `<Run|…>`. Assert from the trace that no line write falls between the Hold read and the Run read. (The existing BP3 would NOT go red on a `!paused` removal because it has no `ok` during Hold.)
5. Partial input: incomplete `<Idle|...` frame cut mid-field
6. Chatter: `[MSG:...]` and other non-terminal lines interleaved with status

**Coexistence:** `ScriptedPort` coexists with `MockPort`/`EofPort` in serial.rs and `ScriptReader`/`ScriptWriter` in serial_pump.rs. They serve different purposes — the existing doubles are simpler and adequate for their current tests. Consolidation is a later housekeeping item, not this batch.

## Acceptance criteria

1. Wrapper and test invoke the same extracted body; no test-local copy of lock/admission logic.
2. Hold fixture has at least one unsent line when Hold arrives AND an `ok` arriving during Hold; trace records the suppressed write interval.
3. Write and flush can fail or remain pending independently; teardown can release test workers.
4. Every scenario names its assumptions, uses the structural `run_with_deadline` helper, and has a finite harness timeout. Each test owns its own `SerialInner`.

## Wrapper-dispatch proof

**Resolution: route to the Tauri test-port smoke (option ii).** Tauri's `test` feature (`mock_builder` + `get_ipc_response`) is not enabled in `Cargo.toml` and has never been tried in this repo. Enabling it and proving it works against managed `SerialState` is a task unto itself. This batch builds the body-level seam; the later Tauri smoke (source PLAN §0.2 / Phase 1 exit condition) joins the wrapper→body dispatch seam.

**What this means:** the batch's tests call the extracted bodies directly, which proves the bodies' behavior but does NOT prove the wrappers call them. That gap is tracked as unproven in the relay report. The pure-move diff review (Core 7) is the only wrapper-dispatch assurance in this batch. The `#[tauri::command]` signatures and serde shapes are unchanged.

## Required mutation tests

Each of these must go RED when the named mutation is applied:
- **PumpFlight invariant (pin 1):** remove `PumpFlight::begin` from the send body → disconnect test fails to see the pre-lock `0x18`
- **Status try_lock (pin 2):** change `try_lock` to `lock` in status body → test blocks forever (deadline fires)
- **$32=1 gate (pin 3):** remove the `$32=1` write from stream body → test fails on missing line in trace
- **Connect 0x18 (pin 4):** remove the `0x18` from connect body → test fails on missing reset byte
- **Pause suppression:** remove the buffered `!paused` guard → fixture 4's trace shows a line write between the Hold read and the Run read
- **RX budget guard:** remove the outstanding-byte check → test fails, asserting max outstanding bytes over the ordered trace (recomputed from the trace using one-data-step-per-read entries, not from pump internals)

**Wrapper-dispatch mutation: UNPROVEN in this batch** — routed to Tauri smoke. See above.

## Verification

```sh
source ~/.cargo/env
env -u KERF_UPDATE_GOLDEN cargo test --manifest-path src-tauri/Cargo.toml commands::serial
cargo check --manifest-path src-tauri/Cargo.toml --features sim
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features sim -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

All existing Rust tests must continue to pass. New tests add to the count.

## Out of scope

- `src-tauri/src/sim/grbl.rs` physics changes
- All generators and frontend files
- Any new belief about Falcon firmware physics
- Recovery UX or throughput work
- Production behavior changes of any kind
- Wrapper→body dispatch proof (routed to Tauri smoke)
- Consolidation of existing test doubles (`MockPort`, `ScriptReader`, etc.)

## Risk register

| Risk | Mitigation |
|---|---|
| Extraction changes production behavior | Pure-move diff review (`git diff --color-moved=dimmed-zebra`) + four invariant pins on the load-bearing lines. No existing test invokes these closures, so "existing suite catches it" is false — the pins and the review are the mechanism. |
| Worst-case extraction errors | Send loses `PumpFlight` → beam stays on 3–60s after disconnect (pin 1 catches). Stream loses `$32=1` gate → beam on during G0 rapids (pin 3 catches). Status `try_lock`→`lock` → DRO freezes mid-job (pin 2 catches). Connect reorders locks or drops `0x18` → unknown modal state on non-Arduino boards (pin 4 + review catches). |
| Scripted port doesn't model enough serial behavior | Start with the six fixture scenarios; `bytes_to_read` follows the `ScriptReader::available_now` rule; expand as later batches need them |
| try_clone semantics differ from real serial port | Test try_clone explicitly; share state via Arc<Mutex> matching the `SimPort` pattern |
| Test timeouts on CI | Logical ticks, not wall-clock; injected sleeper for connect's 2.05s; structural `run_with_deadline` on every scenario; barriers poison on Drop |
| Connect fixtures cost 2.05s each | Injected sleeper (`&dyn Fn(Duration)`) — wrapper passes `std::thread::sleep`, tests pass a no-op |

## Documentation

Update `ARCHITECTURE.md` with the body/wrapper split and `sim/scripted_port.rs` in the same commit. Update `sim/mod.rs` header if it describes the sim port as "not wired up".
