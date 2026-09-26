# Kerf safety S1b: buffered START checks laser mode instead of writing it

**Lifted from:** `/home/leesalo/marvin/state/audits/gap-2026-09-24/kerf/PLAN-safety-gate-class.md` §S1b (critic `PLAN-safety-gate-class-critic.md`, CONCERN, folded).

**Lineage:**
- `.claude/plans/kerf-relay-plan.md` §A1, the `serial.rs` and `jobStream.ts` rows and test rows 7 and 8.
- That plan's critic, must-fix 3 (the Rust battery pilot).
- `kerf-relay-plan.md` §D2 item 2 (a `$32=0` sim fixture drives the real `serial_stream_job_inner` with `laser_mode_verified=false`). S1b delivers that item's Rust half; its TS half shipped in S1.
- Razor N8 on kerf-evidence-e5, and the ROADMAP Parking Lot line that names S1b as its candidate owner.

The parent plan wins wherever this file is silent.

**Citations:** re-read at `7140cab` (`7140cabaa444218ac751ca54141802cc3f6af989`) on session branch `marvin/kerf-gap`, on 2026-09-25. Re-checked at the critic fold against HEAD `8c60666`, which adds only `.claude/handoff.md` (`git diff --stat 7140cab..8c60666`: 1 file), so every code citation below stands. S1 (`df8883a`) and E5 (`7140cab`) are merged there. Local `master` is `4443ec5`, a merge of an earlier `marvin/kerf-gap`. `git diff HEAD...master` is empty, so master carries nothing this branch lacks.

- **Relay id:** `kerf-safety-s1b`
- **Branch:** `relay/kerf-safety-s1b`
- **Tier:** Standard. 5 files in two roots (`src-tauri/`, `src/`); waiver below. No `.tsx` is touched, so there is no Jen pass. There is no behavioral pass either: the change is an `invoke` argument and a Rust body, and the browser dev server cannot reach `invoke`.

## Intent (grilled)

Grill skipped. The intent comes from the parent's Intent, which cites:
- CHARTER "Done looks like" (1): no silent G-code error. And (2): the safety stack is verified in CI by the GRBL simulator.
- DECISIONS 2026-09-10, "START refuses to run until laser mode and power scale are written and read back matching". Its reasoning includes two sentences: "Automatically enabling on START was rejected because it makes pressing start mutate persistent machine configuration", and "a controller that acknowledges a settings write is not a controller that accepted it".
- DECISIONS 2026-07-05, "`$32=1` is hard-gated at job_start …", as amended 2026-09-10. The amendment ends: "Making the gate real is plan batches 2.1 and 2.2."
- DECISIONS 2026-09-24, "Job-line admission and its write are one critical section …". S1b leaves that structure alone.

Summary for this batch:
- Buffered START writes `$32=1` on the operator's behalf and trusts the first `ok`. Lee refused both halves of that.
- After S1, the TS flag `grblLaserMode` means "the controller reported `$32=1` in a readback that no later settings write has overtaken". Only one function sets it true: `applyLaserModeReadback` (`connection.ts:127-131`). Its other writers only clear it (`:118`, `:411`). The store starts it `false` and never persists it (`store/index.ts:586`).
- S1b forwards that flag to Rust as `laser_mode_verified`. Rust refuses before any read or write when the flag is false, and never writes `$32` itself.

## Existing plans reviewed

**Inventory, checked with `ls` on 2026-09-25:**
- **Session worktree `.claude/plans/`:** 34 `.md` files plus `archive/` (3 files) when this plan was lifted. That was the primary's 31 plus `kerf-evidence-e2-critic.md`, `-e3-critic.md` and `-e5-critic.md`. At the critic fold (`ls`, 8c60666 working tree) there are 39: this plan, its critic, and three newly lifted files, `kerf-safety-s2.md`, `kerf-evidence-e1b.md` and `kerf-evidence-e1b-critic.md`. Primary `/home/leesalo/Projects/kerf/.claude/plans/`: 31 `.md` plus `archive/` (3).
- **Audit directory `gap-2026-09-24/kerf/`:** 9 files.
- **This file:** new.

**Plans that name the files this batch edits** (a `grep` of every plan for `serial_stream_job`, `jobStream.ts`, `serial_session.rs` and `sim/grbl.rs`):
- **Merged, and they created the tests S1b changes:**
  - `remediation-batch-0.1.md` created PIN 3, `pin_stream_writes_dollar32_first`.
  - `fence-wiring-1.1-reopen.md` and `fence-single-reset.md` created R5, R6 and O1-O4.
  - `kerf-evidence-e5.md` created the ignore fault and the `sim/grbl.rs` comments that name the Rust gate as its consumer.
  - `kerf-evidence-e3.md:48` says "S1b … edit[s] other lines of `jobStream.ts`/`jobStream.test.ts`". E3 is merged (`1cdd930`), and its edits sit in other functions.
  - `kerf-safety-s1.md` (merged `df8883a`) owns the flag S1b forwards.
- **In flight:** `refresh-canvas-display.md` (relay at Stage 1). It lists `jobStream.ts` as untouched. Its branch diff against this HEAD touches none of S1b's five files (checked with `git diff --name-only HEAD...relay/kerf-refresh-canvas-display`). Both relays will edit `ROADMAP.md` at Stage 3.5, which is an ordinary text merge.
- **Lineage only:** `kerf-relay-plan.md` §A1 and §D2.
- **The parent's later batches:**
  - S4a edits `serial.rs` and `serial_session.rs`, after S1b, in the same region.
  - S2 and S4c edit other lines of `jobStream.ts`.
  - None runs before S1b.

**Lifted since, not dispatched (checked at the fold):**
- `kerf-safety-s2.md` edits `jobStream.ts` only in the `pauseJob`/`resumeJob` doc comments (`:34-69`), disjoint from S1b's `:150-217`. Its own inventory names S1b.
- `kerf-evidence-e1b.md` edits `serial.rs` only inside `b2a_generate_native_status_fixture` (`:3152-3235`, in `sim_integration`). S1b adds T5 and T6 to the same module but not to that function. Whichever merges second rebases; the regions do not overlap.

The Stage 0 re-check repeats this inventory.

## The buffered start today (verified)

**The write.** `serial_stream_job_inner` (`serial.rs:752-929`) does the following, in order:
1. `permit_precheck` (`:758`).
2. The `command` lock (`:760-764`).
3. `try_permit_begin` (`:768`).
4. `PumpFlight` (`:770`).
5. A drain (`:777-783`), under a comment that calls what follows "$32=1 hard gate (DECISIONS.md pin)" (`:775-776`).
6. It writes `$32=1` through `admit_and_write` and flushes it (`:785-794`).
7. It runs a per-line pump for the reply (`:796-803`), and publishes a reset banner if a stop is in flight (`:804-813`).
8. It accepts on `out.lines.iter().any(|l| l == "ok")` alone (`:814-823`), and only then parses and streams the G-code (`:825-`).

**What the text around it says.**
- The Tauri command's doc says "`$32=1` is hard-gated: the first line sent is `$32=1` … This is a DECISIONS.md pin" (`:938-939`). The command itself is at `:944`.
- The module doc lists "the `$32=1` bracket" among the `admit_and_write` sites (`:39-40`). The `_inner` doc mentions it twice (`:747-748`).
- `serial_session.rs:37` says `serial_stream_job` writes "for its `$32=1` bracket".

**The TS call.** `jobStream.ts:213-217` invokes `serial_stream_job` with `{ gcode, jobEpoch, channel }` and no laser-mode argument. Its doc says "The Rust side handles the $32=1 gate" (`:152-153`).

**Who reaches it.** All four doors (START, main FRAME, material grid, material FRAME) call `streamJob` (`JobActionBar.tsx:79`, `:148`; `MaterialTestDialog.tsx:436`, `:459`). `streamJob` dispatches to the buffered path only when localStorage `streamingMode` is `"buffered"` (`jobStream.ts:111-114`). No UI sets that value. After S1 every door refuses first unless `grblLaserMode` is true (`canStartJob.ts:171`). So the Rust check is defence in depth against two things: a flag that changes between the door and the `invoke`, and a future caller that skips the door.

**What a Rust `Err` does in TS.**
- It lands in the `catch` at `jobStream.ts:271-287`.
- It is treated as a refusal only when it starts with `refused:` (`PERMIT_REFUSED_PREFIX`, `connection.ts:67`).
- It is treated as a dead port only when it contains `disconnected` or `Not connected` (`:281`).
- Otherwise it prints `<label> failed: <msg>` and, because `jobRunning` is still true, routes one `emergencyStop` (`:289-306`). Today's `"$32=1 gate failed"` error takes that same path.

**Tests that assert the write:**
- **PIN 3,** `pin_stream_writes_dollar32_first` (`serial.rs:1908-1948`): the first bytes written are `$32=1\n`.
- **O3,** `rf15_o3_dollar32_write_in_progress_precedes_single_reset` (`:4122-4168`): it parks the `$32=1` write under `submit`, and asserts `$32=1\n` precedes the single `0x18` and the stream fails with `"$32=1 gate failed"`.
- **O2,** `rf15_o2_buffered_write_in_progress_precedes_single_reset` (`:4068-4120`). It scripts a read hold named `ack32` (`:4074`) on the `$32=1` reply. It arms the job-line write hold only once that read is reached (`:4085-4088`).
- **R6,** `rf15_buffered_mid_job_gate_independent_of_abort_flag` (`:4017-4066`). It scripts `ScriptStep::Data(b"ok\r\n"), // $32=1 ack` (`:4029`).
- **R5,** `rf15_buffered_stream_after_stop_refused_at_entry` (`:3988-4015`). Its message says "not even `$32=1`" (`:4005`).
- **Comment in `mod tests`** (`:2077-2080`): it explains a removed test by "$32=1 pump fails before the buffered pump callback ever fires".

**What E5 made representable.**
- `SimPort::set_ignore_setting(n)` answers `ok` to `$n=V` and does not apply it (`sim/grbl.rs:1013-1019`, `Faults.ignore_setting` at `:306-311`). The sim seeds `$32=1`.
- A `$32=0` write is applied and shows in `$$` (`sim/grbl.rs` test E5-M1).
- Three comments name the now-doomed Rust gate:
  - `:130` says the unmodelled-state bullet "matters because the buffered job writes `$32=1` as its first line".
  - `:309-310` and `:1015-1016` say "Consumer: the Rust `$32=1` gate …, which checks for `ok` only".
- No sim test drives `serial_stream_job_inner` at all (`sim_integration`, `serial.rs:2276-3570`).

**Razor N8 on E5** (`~/marvin/state/relay/kerf-evidence-e5-razor-review-b1.md:124-128`) says:
- "`serial.rs:812-818` accepts `$32=1` on `has_ok` alone and never reads back."
- "A test that drives `serial_stream_job_inner` after `$32=0` with `set_ignore_setting(32)` would pass the gate today. Whichever batch owns the read-back should add that test."

ROADMAP carries it twice:
- The Parking Lot index at `ROADMAP.md:592`: "Candidate owner: safety S1b … or relay-plan D2".
- The E5 detail section at `:762`.

**The ROADMAP owner-test bullet** (`ROADMAP.md:5`, inside `next:`) ends: "so Rust O1 (per-line), O2 (buffered), O3 (`$32=1`) and O4 (stop first) are its only evidence".

### Parent claims that no longer hold

1. **Line numbers have moved.**
   - The `$32` region is `:775-823`, no longer `:747-818`.
   - The invoke is `jobStream.ts:213`, no longer `:203`.
   - O3 is at `:4126`, no longer `:3993`. O2 is at `:4070`, no longer `:3937`.
   - The owner-test bullet is `ROADMAP.md:5`, no longer line 4.
   - `serial.rs:944` (the command) and `:1914` (PIN 3) still hold.
2. **"Confirm O1, O2 and O4 still cover the buffered admission-plus-write critical section."** Only O2 is buffered. O1 and O4 drive the per-line path (`serial_send_inner`), which S1b does not touch. They stay as per-line evidence, unchanged and green. Buffered coverage rests on O2 alone, and S1b proves it with a mutant (S1b-M7).
3. **O2 would not survive the deletion unchanged.** Its line-write hold is armed only after the `ack32` read. With no `$32=1` write, the first Writer write is the job line itself, and it goes out before any read. So O2 would never park its line; `wait_until("line write parked")` would time out. O2 must be re-scripted (Change §1). This is exactly the parent Risk's condition.
4. **"Files (3)."** The sweep for text that says the buffered start writes `$32=1` finds two more files: `serial_session.rs:37` and `sim/grbl.rs:130`, `:309-310`, `:1015-1016`. It also finds `ARCHITECTURE.md:270`, `:457` and `:468-469`, which are left to Stage 3.5. See Change §3 and §4.
5. **The parent names only PIN 3 and O3.** R6 (`:4029`, a scripted `$32=1` ack) and R5 (`:4005`, message text) also refer to the write and are handled in Change §1.

## Change

### 1. `src-tauri/src/commands/serial.rs`

**Refusal text.** Add a constant next to `serial_stream_job_inner`:

```rust
pub(crate) const LASER_MODE_UNVERIFIED: &str = "$32=1 not verified -- laser mode must be read back before a job starts (Enable Laser Mode, $$ in the console, or reconnect)";
```

- It must not start with `refused:`, and must not contain `disconnected` or `Not connected`. Otherwise `jobStream.ts` would misread it as an admission refusal or a dead port.
- The re-verify wording matches S1's invalidation line (`connection.ts:109`).

**`serial_stream_job_inner`:**
- **Signature:** gains `laser_mode_verified: bool` after `job_epoch` (5 parameters; clippy's limit is 7).
- **The check:** insert it immediately after `inner.session.try_permit_begin(Some(job_epoch))?;` (`:768`) and before `PumpFlight::begin` (`:770`), with exactly this shape, because it is a battery anchor:
  ```rust
      if !laser_mode_verified {
          return Err(LASER_MODE_UNVERIFIED.to_string());
      }
  ```
  Put one comment above it. The comment cites DECISIONS 2026-09-10 and says that the TS readback is the authority until S4a.
- **Why there:**
  - **Admission refusals win.** A stream that is not admitted still gets the `refused: not-admitted:` contract, so `jobStream.ts` skips the stop. The refusal path exists to stop a stale producer from resetting a job that is not its own (`jobStream.ts:289-294`).
  - **Nothing is touched.** The refusal reads nothing (it comes before the drain), writes nothing, and never raises `pump_in_flight`.
  - **`cmd_channel` is in scope,** so the N8 regression mutant (S1b-M4) type-checks.
- **Delete** `:785-823`: the `$32=1` write, its flush, its pump, its banner publication and its `ok` match.
- **Keep** the drain at `:777-783`, and replace its comment (`:775-776`) with one line: "Drain stale controller output before the job; ALARM/MSG lines reach the console." The second drain (`:839-843`) now follows it with only parsing in between. It is left as is; removing it is cosmetic.
- **Keep the parse line exactly:** `    // Parse G-code lines (same filtering as the TS per-line path).` (`:825`). It is the S1b-M1 anchor.

**`serial_stream_job` (`:944`):**
- Gains `laser_mode_verified: bool` (IPC key `laserModeVerified`) between `job_epoch` and `channel`, and passes it through. The wrapper performs no check of its own, so the check block stays unique in the file.
- Replace the doc lines `:938-939` with: the command refuses unless the caller verified laser mode by readback, and it never writes a setting. Next to the `jobEpoch` note (`:941-942`), add that `laserModeVerified` is required too: an omitted key is rejected by Tauri deserialization, so the command fails closed.

**Doc text:**
- Remove "the `$32=1` bracket," from the module doc's `admit_and_write` site list (`:39-40`).
- Rewrite the `_inner` doc (`:743-751`) to drop both `$32=1` mentions and to state where the check sits.
- Rewrite the `mod tests` comment at `:2077-2080` in the past tense ("at the time, the `$32=1` pump failed …").

**Tests edited (named, never deleted quietly):**
- **Delete `pin_stream_writes_dollar32_first` (`:1908-1948`).** It is replaced by S1b-T2 below; say so in a one-line comment where it stood.
- **Retire `rf15_o3_dollar32_write_in_progress_precedes_single_reset` (`:4122-4168`) by name.** Its subject, the `$32=1` write, no longer exists.
  - Its banner-publication assertion now belongs to the buffered pump's own publication (`:891-898`), which O2 asserts through `StopResult::Confirmed`.
  - The relay report names the retirement and its coverage: O1 and O4 are per-line, untouched; O2 is re-proved by S1b-M7.
- **Re-script O2 (`:4070`):**
  - The script becomes `[HoldUntilRelease { id: "banner" }, Data(BANNER)]`, O1's and O3's shape.
  - Call `base.hold_next_write(HandleRole::Writer, "line")` before spawning the pump, as O1 does. The first Writer write in a buffered stream is now the first job line: `run_buffered_pump` validates, then enters Phase A and writes before any read (`serial_pump.rs:550-597`), and both drains read only data that is already buffered (`bytes_to_read`, `scripted_port.rs:495-507`).
  - Delete the `ack32` comment, wait and release (`:4085-4086`, `:4088`); the arming line (`:4087`) moves above the spawn. Every assertion stays byte-identical.
- **R6 (`:4024`):** delete the `ScriptStep::Data(b"ok\r\n"), // $32=1 ack` step (`:4029`) so the script matches the wire. The outcome assertion `refused: not-admitted:` is unchanged and must still pass. If it does not, report it; do not re-add the step under a new label.
- **R5 (`:3991`):** pass `true`, and change "not even `$32=1`" (`:3989`, `:4005`) to "nothing".
- **Every other call of `serial_stream_job_inner`** gains the new argument (`true` unless the test says otherwise). At HEAD they are `:1934`, `:3998`, `:4039`, `:4083` and `:4138`; two of those go away with PIN 3 and O3.

**New tests.**
- In `mod rf15`, under a `// ── S1b ──` heading, using `rig`:
  - **S1b-T1 `s1b_unverified_stream_touches_nothing`.**
    - Setup: script `[Data(b"ok\r\n")]`, so that a drain, if reached, would record `ReadData`; this makes the negative falsifiable. Admit a job.
    - Call with `false`.
    - Assert:
      - The error equals `LASER_MODE_UNVERIFIED`.
      - The trace holds no `TraceEvent::Write` of any role and no `TraceEvent::ReadData`.
      - `pump_in_flight` and `job_abort` are false.
      - `admitted_job` is still `Some(e)` (the refusal changes no session state).
  - **S1b-T2 `s1b_stream_writes_no_dollar32_before_first_gcode_line`** (replaces PIN 3).
    - Setup: script `[Timeout, Data(b"ok\r\nok\r\n")]`. The leading `Timeout` keeps both drains off the acks. Gcode `"G0 X10\nG1 X20 F1000 S500\n"`, verified `true`.
    - Assert:
      - The outcome is `Ok("complete")`.
      - The first Writer write is `b"G0 X10\n"`.
      - No Writer write anywhere contains `$32`.
    - **Pad the script with trailing `ScriptStep::Timeout` steps** (at least three) after the acks. An exhausted `ScriptedPort` returns `Ok(0)` (`scripted_port.rs:348-350`), and the buffered pump maps `Ok(0)` to `PumpFailure::Disconnected("port closed (EOF)")` (`serial_pump.rs:185-186`). So one stray read after the last ack would turn the outcome into `Disconnected`, not `complete`. A `Timeout` costs a tick instead.
    - **Never weaken `Ok("complete")`.** The trace assertions alone would still kill S1b-M1 and hide the loss of the only ScriptedPort check that a verified buffered job completes. If the padded script still does not complete, stop and report; never drop the outcome assertion or the trace assertions.
  - **S1b-T3 `s1b_admission_refusal_wins_over_laser_refusal`.**
    - Setup: script `[Data(b"ok\r\n")]`, phase Idle, no `serial_job_begin_inner`. Call with epoch 1 and `false`.
    - Assert that the error starts with `refused: not-admitted:` and that there are no writes.
- In `mod sim_integration`:
  - **S1b-T5 `s1b_n8_acked_but_ignored_dollar32_cannot_start_a_buffered_job`.** This is the test N8 asked for.
    - Setup:
      - A `SimPort` whose command channel and realtime handle are all `try_clone`s of one brain, as `rf15::rig` does with its port.
      - Drain the banner, write `$32=0` through `run_pump` and get `ok`.
      - Then `sim.set_ignore_setting(32)`, and assert `!sim.laser_mode()` as a precondition.
      - Set epoch 1, phase Idle, and admit a job.
    - Call `serial_stream_job_inner(&inner, "M4 S500\nG1 X1 F500\nM5\n", e, false, …)`. `false` is what S1's readback yields for this controller; S1-M6 pins that on the TS side.
    - Assert:
      - The error equals `LASER_MODE_UNVERIFIED`.
      - `sim.outbound_len() == 0` and `sim.planner_len() == 0` (nothing was sent, so nothing was acknowledged or queued).
      - `!sim.spindle_energized()`.
      - A `$$` through `run_pump` reports `$32=0` and not `$32=1`.
  - **S1b-T6 `s1b_verified_buffered_job_completes_on_sim_without_writing_dollar32`.** This is the control for S1b-C1.
    - Setup: the default sim (`$32=1`), verified `true`, gcode `"M4 S500\nG1 X1 F500\nG1 X2 F500\nM5\n"`.
    - Assert `Ok("complete")`, and that a following `$$` reports exactly one `$32=` line, `$32=1`.
- **S1b-T4 `laser_mode_unverified_is_not_a_refusal_or_disconnect`** (coverage, no battery id). The constant:
  - starts with `$32=1 not verified`;
  - does not start with `REFUSED_PREFIX`;
  - contains neither `disconnected` nor `Not connected`.

**Out of bounds:**
- `serial_stop_inner` and `admit_and_write`.
- `JobPermit` (its code, as opposed to its S1b-M7 mutation).
- `close_admission`, the `submit` lock, `serial_send_inner` and `serial_job_begin_inner`.
- Every lock-order row. The DECISIONS 2026-09-24 pin stands untouched.

### 2. `src/lib/machine/jobStream.ts` (the `serial_stream_job` invoke and its function doc only)

- **The invoke** (`:213-217`) becomes exactly this. It is a battery anchor.
  ```ts
      const outcome = await invoke<string>("serial_stream_job", {
        gcode,
        jobEpoch: session.jobId,
        laserModeVerified: useStore.getState().grblLaserMode,
        channel,
      });
  ```
  The flag is read fresh at the `invoke`, not from `store`, which is captured at function entry (`:158`).
- **Doc** (`:150-156`): replace "The Rust side handles the $32=1 gate" with a line saying that Rust refuses unless `laserModeVerified` (the readback-set `grblLaserMode`) is true.
- **Departure from the parent:** the parent says "the invoke call only". The doc comment belongs to the same function. The lineage reason for the fence (that the abort sites were Lee's zone) is superseded.
- **Unchanged, and stated:** a Rust refusal lands in the `catch`, prints `<label> failed: $32=1 not verified …`, and routes one `emergencyStop`, exactly as `"$32=1 gate failed"` does today. It goes to the Parking Lot (Stage 3.5).

### 3. `src-tauri/src/commands/serial_session.rs` (doc comment `:35-38` only)

- "(`serial_send` with `job_epoch`, `serial_stream_job` for its `$32=1` bracket and per line in the buffered pump)" becomes "(`serial_send` with `job_epoch`, `serial_stream_job` per line in the buffered pump)".
- No code line in this file changes; Razor checks that `git diff` of this file is comment-only.

### 4. `src-tauri/src/sim/grbl.rs` (comments `:128-131`, `:309-310`, `:1015-1016` only)

- `:130-131`: delete "It matters because the buffered job writes `$32=1` as its first line, possibly while a previous job's planner is still draining." The not-modelled fact stays.
- `:309-310` and `:1015-1016`: the consumer becomes `sim_integration::s1b_n8_acked_but_ignored_dollar32_cannot_start_a_buffered_job`, with one clause saying that after kerf-safety-s1b no Kerf code writes `$32` for a job.
- No code changes; E5's tests are untouched.

### 5. `src/lib/machine/__tests__/jobStream.test.ts` (new tests only)

- **Inside `describe("RF-15 admission fence (jobStream)")`, after T7 (`:593-601`),** using `fenced()` and `recs()`:
  - **S1b-T7a:** buffered, and `useStore.setState({ grblLaserMode: true })` explicitly before `streamJob`. Do not rely on the suite's seed or the store default (which is `false`, `store/index.ts:586`), because `streamJob` bypasses the door. The `serial_stream_job` record's `args.laserModeVerified` is `toBe(true)`.
  - **S1b-T7b:** buffered, `useStore.setState({ grblLaserMode: false })` before `streamJob`. `args.laserModeVerified` is `toBe(false)`.
    - It must be `toBe(false)`, never `toBeFalsy()`: a dropped argument is `undefined`, and `toBeFalsy()` would let S1b-M3 survive.
- **Inside `describe("streamJobBuffered outcomes")`,** coverage with no id: **S1b-T8.**
  - Mock `serial_stream_job` to reject with the literal text of `LASER_MODE_UNVERIFIED`; a comment names the Rust constant, since the TS test cannot import it.
  - Assert `endState === "error"`, a console line containing `failed: $32=1 not verified`, and `machineConnected` still true (not read as a dead port).

**Waiver (two roots):** the Rust signature and the TS argument land in **one commit**, or every buffered job fails Tauri deserialization at runtime. The two comment-only files ride in the same commit. The TS change is one call site and its doc.

## Tests and mutants

Battery spec `kerf-safety-s1b`, one file for the batch. Run it from the relay worktree with `env -u KERF_UPDATE_GOLDEN node ~/marvin/scripts/mutation-battery.mjs <spec>`. Never hand-roll it, and never run cargo by hand to "check" it; read the journal.

- **`test_command`:** `["bash","-c","CARGO_TARGET_DIR=/home/leesalo/.cache/kerf-battery-target/kerf-safety-s1b /home/leesalo/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim commands::serial && npx vitest run --cache=false src/lib/machine/__tests__/jobStream.test.ts"]`.
  - The `commands::serial` filter selects `mod tests`, `sim_integration` and `rf15` (it also matches `serial_pump` and `serial_session`).
  - `--cache=false` follows S1's measured fix for vitest cache writes into the shared `node_modules` (`kerf-safety-s1-ted-report-b1.md:6`).
  - The baseline must be green; the battery refuses a red one.
- **One contiguous edit per id.** Each id is one contiguous find/replace (`mutation-battery.mjs:1553-1560`). Its `find` must occur exactly once in its file (`MUTANT_ANCHOR_AMBIGUOUS`, `:1772-1779`). No mutant is stacked.
- **Uniqueness, checked by grep at `7140cab`:**
  - `inner.session.permit_precheck(job_epoch)?;` occurs once in `serial.rs`.
  - `self.session.admit_and_write(self.epoch, write)` occurs once in `serial.rs`.
  - `// Parse G-code lines (same filtering as the TS per-line path).` occurs once in `serial.rs`.
  - `jobEpoch: session.jobId,` (with the comma) occurs once in `jobStream.ts`. Line `:365` has no comma.
  - The new-code anchors (`if !laser_mode_verified {`, `laserModeVerified: useStore.getState().grblLaserMode`) occur **0** times today. The shapes pinned in Change §1 and §2 add each exactly once.
  - After implementing, Ted re-counts every `find` with `python3 -c 'print(open(p).read().count(f))'` (the multi-line finds defeat `grep -c`) and reports the counts.
- **Every wrong variant type-checks.** A compile error would be a false kill, which the battery cannot tell apart from a real one. The reasoning is given per row, and Razor re-reads each.
- **Controls.** The battery has no "stays green" outcome. A control (C) is a test that is green at baseline and turns red under its named wrong variant, and it is journalled as a killed mutant.

| Id | Killed by | Wrong variant (one edit) | Why it type-checks |
|---|---|---|---|
| S1b-M1 | T2 (first Writer write is `$32=1\n`) | Replace the parse-comment anchor with the pre-S1b write (`inner.session.admit_and_write(job_epoch, \|\| cmd_channel.writer.write_all(b"$32=1\n"))?.map_err(\|e\| format!("Write error: {}", e))?;`) followed by the anchor | `cmd_channel` is in scope after the lock, exactly as at `7140cab:785-790` |
| S1b-M2 | T1 (writes appear), T5 (job completes) | Delete the three-line check block | `laser_mode_verified` becomes unused: a warning, not an error |
| S1b-M3 | T7a, T7b | Delete the line `      laserModeVerified: useStore.getState().grblLaserMode,` | TS: an object literal without the key |
| S1b-M4 (N8) | T5 (the ignored `$32=1` is acked, the old gate passes, the job runs on a `$32=0` controller: `Ok`, not `Err`) and T1 | Replace the three-line check block with `7140cab:785-823` verbatim (write, flush, pump, banner publication, accept on `ok`) | Every name it uses (`cmd_channel`, `job_epoch`, `serial_pump`, `DEFAULT_LIVENESS_TICKS`, `PumpFailure`) is in scope at the check's position |
| S1b-M5 | T3 (the laser refusal pre-empts the admission contract) | Replace `    inner.session.permit_precheck(job_epoch)?;` with the check block followed by that line | The constant and the parameter are in scope at function entry |
| S1b-M6 | T7b | Replace `laserModeVerified: useStore.getState().grblLaserMode` with `laserModeVerified: true` | TS: a literal |
| S1b-M7 | O2, re-scripted (`assert_stop_parked_behind_write`: the stop's `0x18` lands while the Phase A write is parked) | In `JobPermit::admit_write`, replace `self.session.admit_and_write(self.epoch, write)` with `self.session.permit_precheck(self.epoch).map(\|_\| write())` (admission checked, `submit` not held) | `Result<(), String>::map` yields `Result<io::Result<()>, String>`, and `write: &mut dyn FnMut` is callable in the closure |
| S1b-C1 | T6 (verified job refused) | Replace `if !laser_mode_verified {` with `if laser_mode_verified {` | Bool condition |

Eight ids: 6 Rust, 2 TS.

**What the ignore fault does and does not do.** T5 arms `set_ignore_setting(32)`, so its controller is the exact N8 controller. The fault is what makes S1b-M4 fail for the reason N8 named: an `ok` that did not apply `$32`. After S1b nothing in Rust writes `$32`, so under the real code the fault is inert. S1b-M4 is also killed by T1's zero-write assertion. That is stated so nobody reads T5 as the only barrier.

**O1, O2, O4.**
- O1 and O4 (per-line) are unchanged in code and test. They run green in the baseline.
- O2 is the buffered evidence, and S1b-M7 proves the re-scripted O2 still detects a Phase A write made outside `submit`.
- If S1b-M7 survives, O2 is insufficient. Stop and add a buffered job-line ordering test before merge (the parent's Risk mitigation). Do not merge on Razor's reading alone.

### Battery pilot, timing and `CARGO_TARGET_DIR` (relay-plan critic must-fix 3)

**`CARGO_TARGET_DIR`, answered by reading the battery:**
- **The environment passes through.** The battery gives the test command its own environment with `GIT_*` removed (`scrubbedEnv`, `mutation-battery.mjs:790-796`). It also deletes `NODE_TEST_CONTEXT` and adds its own `INSIDE_ENV` marker (`:1338-1342`). Nothing in the battery reads or refuses `CARGO_TARGET_DIR`.
- **The test command is not walled.** `RUN_TOUCHES` (`:238-254`) says the TEST COMMAND "is not walled and can reach the live tree". A change there is detected at teardown, and detection covers "TRACKED and UNTRACKED files, not ignored ones".
- **So a pre-warmed target directory is permitted,** with one prohibition this plan adds: never the live worktree's `src-tauri/target`. It is gitignored, so a write there would escape `LIVE_TREE_CHANGED`, and it would share cargo's build lock with any live build.
- **This batch uses a dedicated directory outside every worktree:** `/home/leesalo/.cache/kerf-battery-target/kerf-safety-s1b`. It is named inside `test_command` so the spec records it.
  - Ted confirms that the directory does not exist before the pilot (`test ! -e`), so the pilot's baseline is a true cold build.
  - The pilot's baseline warms it, so no cargo is run by hand.
  - The kerf crate itself still rebuilds once per battery copy (the copy path differs); what is shared is the dependency graph.
  - Disk: 35 GB free on `/` at planning time. Check that `df -h /` shows at least 15 GB free before the pilot, and remove the directory at relay close. S4a reuses the measurement, not the directory.
- The relay report records this answer.

**Pilot.**
- Spec: the same `test_command`, the one id `S1b-M2`, `per_mutant_timeout_ms: 1800000`, `total_timeout_ms: 3600000`. These are generous so that the pilot measures instead of timing out; E5's first cold run hit about 14 minutes with another battery live (`kerf-evidence-e5-ted-report-b1.md:6`).
- Before launch, record `T0=$(date -u +%FT%T.%3NZ)` and whether another battery is live (`pgrep -af mutation-battery`).

**Timing measurement rule.**
- Journal `mutant` rows carry no timestamp (verified in E5's journal). So measure from the pilot's own journal:
  - **Cold baseline** = the `baseline` row's `at` − `T0`.
  - **Per mutant** = the run's closing `live_tree_check` `at` − the `baseline` `at`.
- Prior figures, for sanity only:
  - 218 s cold, uncontended, in `kerf-b1-admission-fence`.
  - E5's full runs: 14 ids in 24.5 and 22.0 minutes after baseline, about 94-105 s each (baseline `at` 20:46:20 → close 21:10:54; 21:24:42 → 21:46:43).

**Full-run timeouts.**
- `per_mutant_timeout_ms` = max(2 × cold baseline, 2 × per-mutant, 660000). The per-mutant bound also caps the baseline (`:1675`).
- `total_timeout_ms` = 2 × cold baseline + 8 × 2 × per-mutant, rounded up to the minute.
- Record T0, both measurements, the contention note and the chosen figures in the relay report.

## Verification

- **Rust:**
  - `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim`, the whole crate.
  - `#[test]` attributes in `src-tauri/src` go from 328 to 332: −2 (PIN 3, O3) and +6 (T1-T6).
  - Report the runtime pass count against the relay-start baseline.
- `~/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
- `~/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`.
- **TS:**
  - `npx vitest run src/lib/machine/__tests__/jobStream.test.ts`: +3 tests.
  - `npx tsc --noEmit`.
  - `npm test`: the baseline measured at relay start plus the new tests, none weakened.
  - `npm run lint` (no new warnings); `npm run format:check`.
- **Battery journal:** every S1b-M* and S1b-C1 id **killed**; zero survived, errored or CONTROL_RED. Report the pilot journal and the final journal separately.
- **Diff checks for Razor:**
  - `serial_session.rs` and `sim/grbl.rs` are comment-only.
  - No change to `admit_and_write`, `close_admission`, `serial_stop_inner` or any lock-order row.
  - O2's assertions are byte-identical except the script and the hold arming.

**Browser (`npm run dev` + Chrome DevTools MCP):** not testable. The change is an `invoke` argument and a Rust body; the dev server cannot reach `invoke`, and buffered mode has no UI switch. Flag this explicitly in the report, per the Testing SOP.

**Hardware-only:** none is possible on a release build. Buffered mode is reachable only by setting localStorage `streamingMode` by hand, and release builds carry no devtools. `ROADMAP.md:5` already records buffered as not owner-tested (gate D1c). The Stage 3.5 shipped line says so. Do not copy controller identity into any test; T5 and T6 use the sim's seeded table.

## What S1b does not satisfy

- **The power-scale half of the 2026-09-10 START ruling.** Buffered admission still reads nothing about `$30`. That is S4b. Do not report the ruling as met.
- **A `0x18` never clears the flag.** STOP, `emergencyStop` and the sink-failure stop all send a soft reset, and none of them touches `grblLaserMode`. Its only writers are `connection.ts:118` and `:411` (false) and `:131` (the readback). So a buffered START after a reset trusts a `$32=1` read before the reset.
  - This is safe only on the assumption that `$32` survives a soft reset. Stock GRBL keeps it in EEPROM. The owner's controller is a vendor fork, and DECISIONS 2026-09-05 says stock source "is evidence about intent, never proof about this machine". Survival is unverified there.
  - **Worst case if the assumption is false:** the flag is true while the controller is at `$32=0`. GRBL then treats M4 as M3 and does not gate the beam on motion, so the beam runs at commanded power through every rapid.
  - S4a's native snapshot names reset as an invalidator and closes this. The relay report carries this paragraph verbatim.
- **Native authority (the X5 residual).** Rust trusts a flag TS computed. Invoke order is not wire order across concurrent Tauri commands. So a settings write whose `invoke` lands after the stream's can still take the `command` lock first and reach the controller before the job; that is S1's X5 residual, now also on this path. The stream is still admitted, because `try_permit_begin` checks phase and epoch, not settings.
  - **The doors that can race:** the settings dialog (`GrblSettingsDialog.tsx`, which has no `jobRunning` guard) and the MachinePanel soft-limit buttons (`MachinePanel.tsx:452`, `:518-520`; not `jobRunning`-guarded).
  - The console cannot race: its input is disabled while `jobRunning` (`Console.tsx:188`), which START sets at `JobActionBar.tsx:75`, before the stream's invoke.
  - The window is microseconds wide. S4a's native snapshot closes it, and S4a-M7's test should drive one of those two doors.
- **Per-line mode has no Rust-side laser check.** Its gate is `canStartJob` alone until S4a adds the native admission compare to `serial_job_begin`.
- **Razor N8, resolved as far as this batch can:**
  - The `ok`-only acceptance is deleted, not repaired: no Rust code writes `$32` or accepts an acknowledgement as proof of it.
  - The buffered start now depends on the readback-set flag.
  - The test N8 asked for exists (T5), and the N8 regression is a killed mutant (S1b-M4).
  - What N8's wider sentence ("half of the pin … is unmet for buffered jobs") still lacks is the power-scale readback (S4b) and a native readback (S4a).
- **`kerf-relay-plan.md` §D2 item 2** is delivered by T1 and T5. Items 1, 3 and 4 of D2 are untouched.

## Stage 3.5 obligations (orchestrator)

- **ROADMAP `shipped`:** the usual entry. It includes these points:
  - Say "buffered start now checks the readback flag; per-line mode (the default) still has no Rust gate until S4a". **Never write "pin met"** or "ruling met", for either DECISIONS entry.
  - NOT MET: power scale (S4b); a `0x18` does not clear the flag (S4a).
  - N8 closed as above.
  - PIN 3 replaced.
  - O3 retired, with O2 re-proved by S1b-M7.
  - OWNER HARDWARE TEST: none possible (buffered is unreachable without devtools); evidence is Rust and TS tests only.
- **`ROADMAP.md:5`:** replace "Rust O1 (per-line), O2 (buffered), O3 (`$32=1`) and O4 (stop first) are its only evidence" with "Rust O1 (per-line), O2 (buffered) and O4 (stop first) are its only evidence (O3, the `$32=1` bracket, was retired by kerf-safety-s1b: the buffered start no longer writes `$32=1`)". The rest of the bullet is unchanged. The edit sits inside the `next:` frontmatter string, so keep its quoting intact.
- **Parking Lot index:**
  - **Remove the N8 line** (`:592`). The deferral is scheduled and shipped. The detail section `### Deferred from kerf-evidence-e5 (2026-09-25)` (`:762`) stays verbatim.
  - **Amend the index line at `:590`:** delete its last sentence ("The buffered job writes $32=1 first, possibly while a previous job drains."), which is no longer true. Its detail twin at `:760` stays verbatim.
  - **Append one line:** "**A refused buffered START is followed by an emergency stop** — `jobStream.ts` routes any non-`refused:` `Err` through `emergencyStop` while `jobRunning` is true, so a laser-mode refusal that wrote nothing still sends `0x18`. Harmless and rare (the door refuses first), but noisy: the operator sees `<label> failed: $32=1 not verified …` followed by `STOP: 0x18 sent` for a job that never started, which a field report should not read as a fault. It is the same path the old `$32=1 gate failed` took."
  - **Append one line:** "**A settings write can race a buffered START to the wire (S1/S1b X5 residual)** — the settings dialog and the MachinePanel soft-limit buttons are not `jobRunning`-guarded, so a write whose invoke lands after the stream's can take the `command` lock first; the console is excluded (`Console.tsx:188`). Owner: S4a (native snapshot); its S4a-M7 test should drive one of these doors."
- **ARCHITECTURE.md delta:**
  - `:270`: "writes $32=1 and requires ok" becomes "refuses unless `laserModeVerified` (the readback-set flag); writes no setting".
  - `:457`: drop "the `$32=1` bracket" from the `admit_and_write` sites.
  - `:468-469`: replace the `$32=1` banner sentence with the buffered pump's own banner publication.
  - Add one sentence under "Laser-mode flag": the buffered command receives the flag and refuses before any I/O when it is false.
- **DECISIONS:** nothing is written. At relay close the report proposes, never writes, one amendment, in the structured-decisions shape. Nothing blocks on it: the critic found that no entry is contradicted, and that the amendment is a matter of record, not a precondition.
  1. **The question:** should the 2026-07-05 entry "`$32=1` is hard-gated at job_start …" be amended to record that the buffered start now checks the laser-mode readback instead of writing `$32=1`?
  2. **What exists today:**
     - The entry's 2026-09-10 amendment says: "The Rust buffered streaming path does gate on it (`serial.rs:552`)".
     - After S1b, the buffered start refuses unless the app has read `$32=1` back from the controller, and it never sends `$32=1` itself.
     - Per-line mode, which is what you use, has no gate on the machine side yet. Only the START button's own check stands in front of it until S4a.
  3. **The tension:** the entry is accurate about the decision but now wrong about the mechanism. A future session reading "the buffered path gates on it" would assume a write-and-acknowledge that no longer exists. Your 2026-09-10 ruling is what removed it: "a controller that acknowledges a settings write is not a controller that accepted it".
  4. **Options:**
     - *Amend now (append a dated line).* It costs one entry through the writer and a minute of your reading. There is no risk: the entry stays, only the mechanism line is corrected. It forecloses nothing.
     - *Wait for S4a and amend once.* It costs nothing now. The risk is that the entry mis-describes the code for a batch or two. It forecloses nothing.
     - *Leave it.* It costs nothing. The risk is that the entry drifts further from the code with each batch, and the 2026-09-10 amendment's own point (an entry asserting a completeness that does not exist) recurs.
  5. **Recommendation:** amend now. The strongest reason is that this entry has already misled one plan once (its own amendment says so). The cost of being wrong is one extra line that S4a later amends again.
  6. **Reversibility and urgency:** fully reversible (append-and-amend). If ignored for a month, nothing breaks; the entry is simply stale until S4a.

## Risks and rollback

- **O2 loses its buffered power in the re-script.** Mitigation: S1b-M7 must be killed by O2. If it survives, add a buffered ordering test before merge.
- **The two roots land apart.** Every buffered job then fails on a missing required key. Mitigation: one commit (waiver). Revert the relay merge as a unit.
- **A future caller forgets the flag.** Tauri rejects the missing key, so the command fails closed; S1b-M3 pins the one caller.
- **Operator-visible changes (intended):**
  - Buffered START no longer writes `$32=1`.
  - A controller at `$32=0` was already refused at the door since S1. Buffered now refuses in Rust too, instead of silently switching laser mode on.
- **Rollback:** `git revert -m 1 <merge>` on the session branch. The batch is independent of S2 and S3. S4a builds on it.
- **Irreversible steps:** none. No code writes any controller setting; S1b removes the last code path that did so on the job's behalf.

## Critic fold (2026-09-25)

Critic: `kerf-safety-s1b-critic.md` (Fable), verdict CONCERN with no gating FAIL (core 3 and 9 CONCERN; X1 and X5 CONCERN). The design, the mutant table and both re-scripts (O2, R6) were judged correct, and every mutant was re-derived as type-checking. Every must-fix below was checked against HEAD `8c60666` before folding.

1. **A `0x18` never clears the flag.** Verified: `setGrblLaserMode` has three writers in `src/` outside tests (`connection.ts:118` false, `:131` readback, `:411` false), and neither `emergencyStop` nor the stop path calls any of them. Added to "What S1b does not satisfy", with the unverified assumption that `$32` survives a soft reset on the vendor fork (DECISIONS 2026-09-05), the worst case, and S4a as the owner. The relay report carries it verbatim, and the shipped line lists it as NOT MET.
2. **X5 residual: name the doors.** Verified: `GrblSettingsDialog.tsx` has no `jobRunning` reference, the MachinePanel soft-limit buttons (`:452`, `:518-520`) send through `send()` unguarded, and the console input is `disabled={jobRunning}` (`Console.tsx:188`), with `jobRunning` set at `JobActionBar.tsx:75`. The residual now names both racing doors and excludes the console. A Parking Lot line owned by S4a names them, so S4a-M7's test drives a real door.
3. **T2 and scripted EOF.** Verified: an exhausted script returns `Ok(0)` (`scripted_port.rs:348-350`), and the pump maps it to `Disconnected("port closed (EOF)")` (`serial_pump.rs:185-186`). T2 now pads at least three trailing `Timeout` steps, and forbids weakening `Ok("complete")` or the trace assertions.
4. **T7a.** Verified: the store default is `false` (`store/index.ts:586`), and `streamJob` does not call `canStartJob`. T7a now sets `grblLaserMode: true` explicitly, symmetrical with T7b.
5. **DECISIONS proposal and shipped line.** The amendment proposal is now in the structured-decisions shape (question, today, tension, options with costs, recommendation, reversibility and urgency), quoting the 2026-09-10 amendment's wording. The shipped line must say that per-line mode still has no Rust gate until S4a, and must never say "pin met" or "ruling met".
6. **Nits.**
   - The HEAD is now stated: `8c60666`, docs-only over `7140cab`.
   - The battery sentence is corrected: it *deletes* `NODE_TEST_CONTEXT` and adds `INSIDE_ENV` (`mutation-battery.mjs:1338-1342`).
   - The plan inventory is recounted at 39, and the three newly lifted plans (`kerf-safety-s2.md`, `kerf-evidence-e1b.md` and its critic) are checked for overlap: disjoint regions.

Also folded from the advisory X6: the refusal-then-stop Parking Lot line now says what the operator sees (`STOP: 0x18 sent` after a job that never started).

Rejected: none. The critic's two inversions (a `refused:`-prefixed laser refusal to suppress the stop; keeping O3 as a first-line ordering test) both concluded in favour of the plan as written, and nothing in them asks for a change.
