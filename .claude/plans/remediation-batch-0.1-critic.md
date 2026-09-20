# Critic Review — Remediation Batch 0.1 (Native Command-Body Trace Harness)

**Plan:** `.claude/plans/remediation-batch-0.1.md`
**Source batch:** `~/marvin/state/audits/kerf-astra-2026-09-08/PLAN.md` §Batch 0.1 (lines 67–82)
**Rubric:** `~/marvin/rules/plan-critic-rubric.md` (v2)
**Critic:** separate subagent, Fable (reviewer valve read `fable` at spawn per the orchestrator; not re-checked here).
**Ground-truthed against:** `src-tauri/src/commands/serial.rs` (1869 lines), `src-tauri/src/commands/serial_pump.rs` (1459), `src-tauri/src/sim/mod.rs` (11), `src-tauri/src/sim/grbl.rs` (type names only), `src-tauri/src/lib.rs` (sim gating), `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (tauri 2.10.2), `.github/workflows/ci.yml`, `ARCHITECTURE.md`, `.claude/DECISIONS.md`.

---

## Applicability block

**Project type:** desktop CAD/CAM controlling a 40 W laser via GRBL serial (Tauri v2 / Rust). This batch is **test infrastructure**: it moves the bodies of the four serial command wrappers into injectable functions and adds a scripted `SerialPort` double. No intended production behaviour change.

| Dim | Fires? | Why | Tag |
|---|---|---|---|
| Core 1–10 | always | — | GATING |
| X1 Physical & human safety | **YES** | The bodies being moved are the ones that write `0x18` on connect, hold `PumpFlight` so disconnect fires the pre-lock reset mid-line, and gate `$32=1` before any buffered G-code. A wrong extraction changes what reaches the wire. | **GATING** |
| X2 Privacy | no | No personal, client or child data touched; test fixtures are protocol bytes. | — |
| X3 Evidence integrity | no | Produces code, not research or public claims. (The plan's test-count claim is handled under Core 9.) | — |
| X4 Audience/brand/money | no | Nothing client- or public-facing. | — |
| X5 Concurrency | **YES** | Barriers, worker threads, two mutexes and an RAII flag interact; the harness exists precisely to hold the command lock for a long time. | **GATING** (X1-class plan) |
| X6 Operability | marginal | Nothing ships to a user; the `--features sim` selector never reaches a release build. Treated as N/A with one line under Core 5. | — |
| X7 Self-modification | no | Touches no MARVIN gate, hook or skill. | — |
| X8 Dependencies/perf/cost | **YES, lightly** | The fix for Core 9 most likely adds Tauri's `test` feature as a dev-dependency; test wall-clock is a cost. | ADVISORY |

---

## Universal core

### 1. Problem-fit — **CONCERN**
The `## Intent (grilled)` section exists with a written skip line; the Summary matches the source batch's "The change" paragraph and acceptance criteria are copied faithfully. No DECISIONS.md entry is contradicted. Two mis-aims against the tree:

- **The plan aims part of its extraction at code that is already extracted.** File 2 says "Extract the pump body (`run_pump` / `run_buffered_pump`) so tests can drive it with an injected port." Both functions are already pure over `BufRead + ProbeWriter` / `Write + ProbeWriter` (serial_pump.rs:160, :456) and are already driven by a scripted reader in `serial_pump::tests` (`ScriptReader`, :670) and by `SimPort` in `serial::sim_integration`. There is nothing left to extract in `serial_pump.rs`. The closure that actually needs extraction for the stream path is `serial_stream_job` in **serial.rs** (:523–654): abort-flag reset, lock acquisition, `PumpFlight`, the `$32=1` gate, G-code line filtering, the `Channel<JobEvent>` event mapping. The plan's file 1 list names connect/send/status and "Stop/reset submission logic" but **never names `serial_stream_job`**.
- **"Stop/reset submission logic" does not exist as un-extracted Rust.** The only stop/reset writes in this layer are `send_byte_inner` (:430) and `disconnect_inner_with_job` (:338), both already `pub(crate)` bodies with pin tests. The stop *volley* lives in TS (`connection.ts`). Listing it as a fourth extraction target will either produce a no-op or invite a Rust-side stop path that the DECISIONS pin ("every abort routes through one shared stop operation") says must not be duplicated.

**Fix:** rewrite the extraction list to the four closures that are actually inline: `serial_connect`, `serial_send`, `serial_get_status`, `serial_stream_job`. Strike "Stop/reset submission logic". Rewrite file 2's entry to "no extraction; the pump is already pure — this file changes only if the `ProbeWriter`/`PumpReader` traits need a method for the scripted port".

### 2. Approach soundness — **CONCERN**
Injected port factory + event sink + `&SerialInner` is the right seam and has in-file precedent (`disconnect_inner`, `send_byte_inner`, `drain_startup_banner` — all `pub(crate)` bodies over `&SerialInner`/`&mut CommandChannel`). The plan should name that precedent and follow it rather than leaving "trait-object or generic parameters" open. Three things the approach does not decide:

- **Connect body wall-clock.** `serial_connect` sleeps 50 ms + 1500 ms + 500 ms (:248, :250, :268) — 2.05 s of `std::thread::sleep` inside the body being extracted. "Logical ticks instead of wall-clock" is claimed for the port, but every connect fixture (queued-acks-before-banner at minimum) will cost 2 s of real time unless the body takes an injected sleeper, which is a parameterisation of the body — allowed, but it must be stated, and it must be the *same* body the wrapper calls with `std::thread::sleep` injected.
- **Event sink shape for the stream body.** `serial_stream_job` takes `tauri::ipc::Channel<JobEvent>`. Tauri 2.10.2 does expose `Channel::new(|body| ...)` (checked in the registry source), so a test *can* build one, but the sink should be a plain `&dyn Fn(JobEvent)` at the body boundary with the wrapper adapting the `Channel` — otherwise the body is still tied to Tauri types and "injected event sink" is nominal.
- **Named type does not exist.** File 3 says "The existing `GrblSimPort` remains available". The type is `SimPort` (grbl.rs:705). Cosmetic, but a plan that cites a type that is not in the tree is a plan written from memory of the tree.

### 3. Completeness — **CONCERN**
Silent gaps that will bite during implementation:

- **`bytes_to_read` semantics are unstated and load-bearing.** `drain_classified` never blocks; it pulls from the reader only while `PumpReader::available_now() > 0`, and for the production reader type that is `BufReader::buffer().len() + port.bytes_to_read()` (serial.rs:132–141). The existing `MockPort` returns `bytes_to_read() == 0`, which makes every drain a no-op — fine for lock-structure tests, fatal for the "queued acks before banner" and "pending M5 then reset" fixtures, which depend on the pre-write drain classifying stale lines. `ScriptedPort::bytes_to_read` must return the byte count of the queued data steps up to the first timeout/barrier — the same rule `ScriptReader::available_now` already encodes (serial_pump.rs:714–723). Name it.
- **Trace entries need handle identity.** Production makes three handles: the writer (original), a reader clone, a realtime clone (:252–258). The invariant the harness is for — "the realtime `0x18` reaches the wire while the command lock is held" — is only assertable if the trace records *which handle* wrote each byte. "All clones share the same trace" is necessary but not sufficient; each entry needs a handle id or role tag.
- **DTR is not in the trace vocabulary.** Connect's DTR deassert/assert edge (:247–249) is part of the wire behaviour being preserved. The trace lists reads, line writes, byte writes, flushes. Add `write_data_terminal_ready` (and, for completeness, `clear`) so behaviour-preservation of connect is assertable rather than assumed.
- **"Selectable" is undefined.** The source batch says "a test-only selectable scripted port under the existing `sim` feature for the later Tauri smoke; it must be absent without that feature." The plan repeats "selectable" without saying what selects it. The natural answer is the port factory: under `#[cfg(feature = "sim")]` a reserved `port_name` scheme (e.g. `sim://scripted`, `sim://grbl`) returns the double instead of `serialport::new(..).open()`. State the scheme, state that it lives *only* in the factory, and state that the non-feature `cargo check` compiles it out.
- **`cargo fmt --check` is missing from Verification.** CI runs it (ci.yml:94) and the last two commits on this branch are CI clippy repairs. The source batch's global verification also requires fmt for Rust changes.

### 4. Right-sizing & reuse — **PASS** (with a note)
Four files, one subsystem, no waiver needed; no dependency graph required for a single batch. The out-of-scope list mirrors the source batch and is batch scoping rather than deferral, so no Parking Lot index is owed. Note for the implementer: this adds a sixth serial test double (`MockPort`, `EofPort`, `JunkReader` in serial.rs; `ScriptReader`, `ScriptWriter` in serial_pump.rs; `SimPort` in sim). The plan should say whether `ScriptedPort` retires `MockPort`/`EofPort` in a follow-up or coexists — either is acceptable; silence is not.

### 5. Security — **PASS**
No secrets, no network, no new attack surface. The scripted port is gated `#[cfg(any(test, feature = "sim"))]` via `lib.rs:3`, and the `sim` feature is not in `default` (Cargo.toml:15). The plan's `cargo check` without features is the right absence proof for the module; the factory selector (Core 3) must sit under the same cfg so the absence proof covers it too. X6 note: `npm run tauri dev` passes no cargo features, so a dev build cannot accidentally expose the selector.

### 6. Failure modes — **CONCERN**
The plan names the right hazards (barrier deadlock, CI timeouts, worker release) but gives no mechanism for any of them:

- A worker thread blocked on a scripted-read barrier while holding `SerialInner.command` — if the *test* thread then panics on an assertion, the worker is orphaned, the barrier is never released, and the test binary hangs rather than fails. "Teardown can release test workers" needs a concrete shape: barriers are released/poisoned on `Drop` of the test's harness handle, and every wait is `recv_timeout`/`wait_timeout` with a finite bound.
- A worker that *panics* while holding `command` poisons the mutex; every later `lock()` in that `SerialInner` returns `Err` → `"Lock failed"`. Each test must own its own `SerialInner` (the existing tests already do); say so, so nobody builds a shared fixture.
- "Every scenario ... has a finite harness timeout" is per-test discipline as written. Make it structural: one helper (`run_with_deadline(Duration, FnOnce) -> Result`) that every scenario goes through, so the property cannot be forgotten in a later batch's tests.

### 7. Change safety — **CONCERN**
"Byte-identical" is asserted three times and is unfalsifiable as written, and the stated mitigation — "existing test suite catches regressions" — is **false for the code being moved**. No test in the tree invokes any of the four wrappers or their closure bodies (grep for `serial_connect(`, `serial_send(`, `serial_get_status(`, `serial_stream_job(` outside their definitions: zero hits). `sim_integration` calls `run_pump`/`drain_classified`/`disconnect_inner` directly. An extraction that drops `PumpFlight::begin` from the send body, or moves `job_abort.store(false)` after the lock, or swaps `try_lock` for `lock` in status, passes all 234 existing tests. Two mechanisms make this falsifiable:

1. **Review as a pure move.** The reviewer reads `git diff --color-moved=dimmed-zebra` and must be able to state that every line of each closure appears in the extracted body unchanged except for the injected parameters, and that the wrapper is a one-call shell. Put that sentence in the reviewer's checklist, not in the implementer's report.
2. **Pin the four invariants through the extracted bodies in this batch** (they are the physical-safety load-bearing lines and are currently unpinned): (a) send body holds `PumpFlight` for its whole duration — observable as disconnect-from-another-thread writing `0x18` on the realtime handle while the send body is parked on a read barrier; (b) status body uses `try_lock` — hold `command`, call the body, expect the empty `StatusOutcome` sentinel, never a block (this is the exact property DECISIONS "0x9E is a toggle" documents as the reason the Hold:0 poll can never succeed); (c) stream body writes `$32=1\n` as its first line and returns `Err` containing "$32=1 gate" when no `ok` arrives; (d) connect body stores the channel under command-then-realtime lock order and writes `0x18` exactly once between the two banner drains. (d)'s lock order is a review item; the rest are tests.

Reversibility is fine: a pure move is a `git revert`.

### 8. Data integrity & compatibility — **PASS**
No persisted formats. The IPC contract (`SendOutcome`, `StatusOutcome`, `JobEvent`, return strings) must be unchanged — the wrappers keep the same signatures and return types; the plan implies this and the frontend is out of scope. One sentence stating "the `#[tauri::command]` signatures and serde shapes are unchanged" closes it.

### 9. Verifiability (incl. testing the tests) — **FAIL**
This is the batch whose whole purpose is to make the next safety claim falsifiable (source PLAN §Phase 0), and its headline mutation test has no mechanism.

- **"Command-body dispatch: delete a wrapper's call to the extracted body → test fails."** The wrappers are `#[tauri::command] async fn` taking `State<'_, SerialState>` and, for stream, a `Channel<JobEvent>`. A Rust unit test cannot call them: no test in the tree does, and Tauri's `test` feature (which provides `tauri::test::mock_builder` + `get_ipc_response` to invoke registered commands against a managed state) is **not enabled** anywhere in `Cargo.toml`. As the plan stands, the implementer's only way to write a "dispatch test" is to call the extracted body directly — which stays green when the wrapper bypasses it. That is not a hypothetical: it is R14, the finding this batch addresses, reproduced by the plan itself. Two honest resolutions, and the plan must pick one: **(i)** add `tauri = { version = "2", features = ["test"] }` under `[dev-dependencies]` and invoke the real wrapper through `mock_builder().manage(SerialState(..))` + `get_ipc_response` with the scripted factory injected via the managed state; or **(ii)** state that wrapper→body dispatch cannot be made red in this batch and route that mutation to the Tauri test-port smoke the source PLAN mentions, so it is *tracked as unproven* rather than *reported as proven*. (ii) is acceptable to the source plan's rule ("Rust tests establish native behavior; a Tauri test-port smoke joins those seams"); silently doing neither is not.
- **Pause-suppression mutation is under-specified.** The pump learns of Hold only from a `<Hold|…>` status line, and with the `!paused` guard intact Phase A is simply skipped. Removing the guard changes behaviour **only if budget frees while paused** — i.e. an `ok` arrives *during* Hold so a queued line would fit. The existing BP3 (`buffered_pump_pause_detection`) has exactly this shape and would NOT go red: it asserts only `Complete` and `status_count >= 2`. Fixture 4 must therefore be: budget small enough that ≥1 line is unsent, `<Hold|…>` arrives, then `ok` arrives *while still in Hold*, then `<Run|…>`; assert from the trace that no line write falls between the Hold read and the Run read. Say so in the fixture, or the implementer will copy BP3 and the mutation will stay green.
- **RX-budget mutation needs per-step read delivery.** "Assert max outstanding bytes over the ordered trace" only works if each ack is a separate trace entry interleaved with writes. `BufReader` calls `read()` once per buffer refill; if the script hands back five `ok\n` in one step, the trace shows one read then three writes and the running-budget computation is wrong in the direction that hides the mutation. Require one data step per `read()` return (the existing `ScriptReader` rule) and state that the assertion recomputes the budget from the trace, not from pump internals.
- **The 251-test baseline has no provenance.** `grep -rc '#\[test\]' src-tauri/src` sums to **234** in this tree; `cargo test` counts differ from attribute counts (doc tests, ignored tests), so the discrepancy may be benign, but "251 passing on v0.8.30" is asserted without saying which command produced it. Record the baseline from an actual `cargo test --features sim` run at the batch's starting commit, with the command, in the report.
- Mutation discipline is otherwise correctly inherited from the source plan (isolated checkout, red saved, restore, green). Goldens: `env -u KERF_UPDATE_GOLDEN` is present; no golden regeneration is in scope. Good.

### 10. Maintainability — **CONCERN**
Clean seam, right direction. Two doc obligations the plan omits: root `ARCHITECTURE.md` exists and describes `serial.rs`/`serial_pump.rs` (lines 90–92, 149) — the new body/wrapper split and `sim/scripted_port.rs` belong there in the same commit; and the `sim/mod.rs` header still says the sim port is "not wired up in this relay" — if a selector is added, that sentence becomes false and must be updated.

---

## Conditional dimensions

### X1. Physical & human safety — **CONCERN** [GATING]
The plan is right that this batch intends no production change, and right that no hardware test is owed (none is silently skipped; "no browser or hardware" is stated). What is missing is the type-specific worst case per extraction error, and the pins that would catch each:

| Extraction error | Worst physical outcome | Caught today by | Must be caught by |
|---|---|---|---|
| Send body loses `PumpFlight::begin` | Mid-line Disconnect skips the pre-lock `0x18`; beam stays on until the wedged line's own liveness/idle-stall expiry (3–60 s) | nothing | pin (a) in Core 7 |
| Stream body loses or reorders the `$32=1` gate | Buffered job runs with laser mode off: with `$32=0` GRBL does not blank the beam during G0 rapids — beam on across rapids, fire risk on the material | nothing | pin (c) |
| Status body `try_lock` → `lock` | Poll blocks behind the pump for minutes; frontend status goes stale mid-job, operator's DRO and machine-state display freeze while the beam runs | nothing | pin (b) |
| Connect body reorders the two lock stores or drops the `0x18` | Cross-wired handles on a racing reconnect, or a non-Arduino board that never resets on connect and starts a job in an unknown modal state | nothing | review item (d) |

Add this table (or its content) to the risk register in place of "existing test suite catches regressions". Failure paths in the harness itself (barrier orphaned, worker panics) end in a hung test, not a fired laser — safe.

### X5. Concurrency & re-entrancy — **CONCERN** [GATING]
The harness deliberately reproduces the production hazard (a worker holding `command` for a long time). "What if this runs twice / mid-flight" answers: two connects racing is already serialised by the single-critical-section store (:281–292) and must stay so after extraction; two `serial_send` bodies on one `SerialInner` serialise on `command`; a test that spawns a second worker against the same `SerialInner` while the first is barrier-parked must use `recv_timeout`. Mutex poisoning on worker panic (Core 6) is the specific re-entrancy trap. The plan's Arc<Mutex> sharing for clones "matching the real pattern" is right — `SimPort` already does it (grbl.rs:705 + `try_clone`), reuse its shape.

### X8. Dependencies, performance & cost — **CONCERN** [ADVISORY]
If resolution (i) under Core 9 is taken, `tauri`'s `test` feature is enabled for dev only — pin it under `[dev-dependencies]`, never under `[dependencies]`, so the release binary is unchanged. Wall-clock: without an injected sleeper, every connect fixture costs ≥2.05 s; with barriers and `recv_timeout(500 ms)` patterns the new suite could add 10–20 s to CI. Acceptable, but say it, and prefer the injected sleeper.

**N/A (not verdicted):** X2, X3, X4, X6, X7 — reasons in the applicability block.

---

## Three stress tests

### Pre-mortem — "It's 3 months out; this failed."
1. **The harness certified a copy.** The implementer, unable to invoke a `#[tauri::command]` from a test, wrote `serial_send_body_test` that calls the body directly, ticked the "dispatch mutation" box because *the body's* tests go red when *the body* is mutated, and the wrapper→body call was never under test. Batch 1.3 later "proved STOP reaches the controller" through the same body while a refactor left the wrapper calling something else. Should have seen: no test in the diff constructs a Tauri app or invokes a wrapper; the report's mutation log names the body, not the wrapper. **Worst case:** the laser fires on a path the tests never exercised — exactly the source PLAN's "a copied harness certifies a different stop path".
2. **Pause mutation stayed green and nobody noticed.** Fixture 4 was copied from BP3; `!paused` removed; test still `Complete`. The mutation log says "RED" because the implementer ran the wrong test or read the wrong line. Should have seen: the fixture has no `ok` during Hold, so removing the guard cannot change any observable.
3. **The extraction moved `job_abort.store(false)` inside the lock and nobody noticed for a month.** All 234 tests green. A STOP pressed during a slow `$32=1` handshake is cleared by the next job's reset instead of honoured — a job the operator thinks they cancelled starts cutting. Should have seen: a reviewer reading the diff as a pure move would have flagged the moved line; a reviewer reading it as "does it compile and pass" would not.

### Load-bearing assumptions
| Assumption | Confidence | If wrong |
|---|---|---|
| The wrapper→body dispatch mutation can be made red inside this batch | **Low as written** — no mechanism in the tree; medium if Tauri `test` feature + `mock_builder` is adopted (that path is documented for Tauri 2 but untried in this repo) | The batch's central acceptance criterion is reported as proven while it is only asserted. **Resolve before implementation** — pick (i) or (ii). |
| `ScriptedPort` behind `BufReader<Box<dyn SerialPort>>` reproduces the production drain path | Medium — only if `bytes_to_read` is implemented per the `ScriptReader` rule; the existing `MockPort` shows the failure mode (returns 0, drain is a no-op) | Fixtures 2 and 3 pass vacuously: the drain never runs, stale acks are never classified, the test asserts on an empty `drained`. |
| The existing suite would catch an extraction regression | **False** — zero tests invoke the closures | Behaviour-preservation is unverified unless Core 7's pins and pure-move review are added. |
| 251 Rust tests is the current baseline | Unverified — 234 `#[test]` attributes counted | "New tests add to the count" becomes unmeasurable; a lost test could hide behind a wrong baseline. |

### Inversion — what would make a rejected alternative win?
- **Alternative: skip the body extraction and go straight to a Tauri-level smoke** (invoke real commands via `mock_builder` against a `SimPort`). It wins if the smoke can drive the closures with the same determinism the scripted port offers. It cannot: the closures' port is opened by `serialport::new(..).open()` inside the body, so without a factory seam no double can be substituted at all. The extraction is necessary. Not already true.
- **Alternative: extend `SimPort` with barriers/trace instead of a new `ScriptedPort`.** Wins if the six fixtures are expressible as GRBL physics faults. Three are (acks lost, pending M5, chatter); three are not naturally (queued acks *before* banner, partial-frame cut mid-field, hold with a specific ack timing) — they are wire-level scripts, not machine states. DECISIONS also says sim-green on hold/spindle paths is unproven until the sim models the toggle; leaning on `SimPort` as the oracle is the thing the source plan explicitly refuses ("existing simulator remains one optional peer, not the oracle"). Not already true.
- **Alternative: leave the wrapper-dispatch proof to the later Tauri smoke** (resolution (ii)). This one is *already partially true*: the source PLAN says a Tauri test-port smoke "joins those seams". If the plan chooses (ii), it is not a rejected alternative but the honest scoping — provided the batch report says "wrapper dispatch: unproven, routed to smoke" in those words.

---

## Overall verdict

**FAIL — one core dimension fails (9, Verifiability); the rest is CONCERN with concrete fixes.** The seam design is right and the fixtures are the right six, but the plan as written would let a Ted satisfy its headline mutation test with a body-direct test that stays green when the wrapper is bypassed, which is R14 re-created inside the batch that exists to kill R14. The plan also aims one of its four extraction items at code that is already pure, cites a type that does not exist, leaves `bytes_to_read` (the thing that makes the drain run) unspecified, and leans on "existing tests catch regressions" for four closure bodies that no existing test invokes. Every one of those is a paragraph to fix, not a redesign. With the must-fixes folded, this is a PASS-grade harness plan.

## Must-fix list (prioritised)

1. **Core 9 / X1 — choose the wrapper-dispatch mechanism.** Either (i) enable Tauri's `test` feature in `[dev-dependencies]` and invoke the real `#[tauri::command]` wrappers via `mock_builder` + managed `SerialState` with the scripted factory, or (ii) state in the plan and the report that wrapper→body dispatch is unproven in this batch and route it to the Tauri test-port smoke. No third option.
2. **Core 7 / X1 — replace "existing test suite catches regressions" with the four invariant pins** (send holds `PumpFlight`; status `try_lock` sentinel; stream `$32=1` first-line + gate refusal; connect lock order + single `0x18`) and add the pure-move diff check (`--color-moved`) to the reviewer's checklist.
3. **Core 9 — specify fixture 4 with an `ok` arriving during Hold** and ≥1 unsent line, asserting from the trace that no line write sits between the Hold read and the Run read; state that BP3 as it stands does not go red.
4. **Core 3 — specify `ScriptedPort::bytes_to_read`** = bytes in queued data steps up to the first timeout/barrier (the `ScriptReader::available_now` rule), one data step per `read()` return, and add handle-role and DTR entries to the trace vocabulary.
5. **Core 1 — fix the extraction list:** name `serial_stream_job` as the fourth closure; strike "Stop/reset submission logic" and the `serial_pump.rs` "extract the pump body" item (already pure); rename `GrblSimPort` → `SimPort`.
6. **Core 2 / X8 — decide the connect sleeper:** inject `&dyn Fn(Duration)` (wrapper passes `std::thread::sleep`) or accept 2.05 s per connect fixture and say so.
7. **Core 3 — define "selectable":** a reserved `port_name` scheme resolved inside the port factory under `#[cfg(feature = "sim")]`; state that `cargo check` without features is the absence proof for the selector as well as the module.
8. **Core 6 / X5 — make the harness timeout structural** (one deadline helper every scenario uses; barriers released on `Drop`; one `SerialInner` per test).
9. **Core 9 — record the Rust baseline from an actual run** (command + count) at the starting commit; the 251 figure is unprovenanced and 234 `#[test]` attributes are in the tree.
10. **Core 3 / 10 — add `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` to Verification**, update `ARCHITECTURE.md` and the `sim/mod.rs` header ("not wired up") in the same commit.
