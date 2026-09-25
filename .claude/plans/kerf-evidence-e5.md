# Kerf evidence E5: the simulator can say `$32=0`, reject a setting, stop acking after a laser switch, and run the captured profile, including what that controller actually reports in `A:`

**Lifted from:** `/home/leesalo/marvin/state/audits/gap-2026-09-24/kerf/PLAN-silent-drop-and-evidence.md` §E5 (critic `PLAN-silent-drop-and-evidence-critic.md`, CONCERN, folded).

**Lineage:** `.claude/plans/kerf-relay-plan.md` §D1 (changes 1-5, tests 1-7); critic `kerf-relay-plan-critic.md` must-fix 10 (ARCHITECTURE delta); DECISIONS 2026-09-05 "The GRBL simulator models `0x9E` as unconditional off …" (evidence correction); astra PLAN "Simulator correction — captured profiles rather than stock certification".

Where this file and a relay-plan body differ, this file wins. On anything this file does not cover, the parent wins. **Two departures from the parent**, both read from the tree, are named under Diagnosis 6 and 7.

**Citations:** re-read at `a6ddc3a` on session branch `marvin/kerf-gap` (source = master `caa0dcc`; `git diff --stat caa0dcc HEAD -- src-tauri` is empty) on 2026-09-25.

- **Relay id:** `kerf-evidence-e5`
- **Branch:** `relay/kerf-evidence-e5`
- **Tier:** Standard. 3 files, two roots:
  - `src-tauri/src/sim/grbl.rs`
  - `src-tauri/src/commands/serial.rs` (the `sim_integration` test module only)
  - root `ARCHITECTURE.md` (the `sim/grbl.rs` entry only)

  **Waiver (two roots):** the architecture entry describes the contract this batch changes, so it is reviewed with it (relay-critic must-fix 10). The parent listed a fourth file, `serial_pump.rs`, which is dropped; see Diagnosis 7.
- **No production behaviour changes.** Everything edited compiles only under `#[cfg(any(test, feature = "sim"))]` (`lib.rs:3-4`) or `#[cfg(test)]` (`serial.rs:2276`).

## Intent (grilled)

Grill skipped. The intent is the parent's Intent, bound by:
- CHARTER "Done looks like" (2): the streaming and safety stack is verified in CI by the simulator.
- DECISIONS 2026-09-05, the two simulator/controller evidence entries.
- DECISIONS 2026-09-10 "Hardware evidence for this program is status-only".

Summary: CI's green means something for the laser-mode and wedge paths only if the simulator can represent them. After this batch the sim can:
- track and report `$32` truthfully, and gate its hold auto-off on it;
- refuse a named setting write;
- stop acknowledging lines after a laser switch until a reset, while `?` still answers;
- run a second, captured profile with the owner controller's planner and buffer sizes and what its `A:` field was observed to do.

None of this certifies the owner's controller. The doc comments and ARCHITECTURE say so.

## Existing plans reviewed

Checked 2026-09-25 with `ls`:
- Primary `.claude/plans/`: 23 files plus `archive/` (3).
- Session branch: 28 files plus `archive/`.
- Audit directory: 9 files.

**Relays in flight:**
- `kerf-refresh-cut-vs-screen` (R1): viewport, geometry, store, fileOps, `App`, `svgExport`, `geometryActions`. It touches `ARCHITECTURE.md` only to remove a nested-group line, if one survives (`refresh-cut-vs-screen.md:486`). That is a different section.
- `kerf-evidence-e1a`: `gcodeGen.ts` and its test. Its Stage 3.5 adds one G-code-generation line to `ARCHITECTURE.md`, in a different section.
- `kerf-safety-s1`: TS only. Its 3.5 adds an admission line to `ARCHITECTURE.md`, in a different section.

None edits `sim/`, `serial.rs` or `serial_pump.rs`.

**Not in flight, later:**
- Safety S1b edits `serial.rs` `serial_stream_job` and its body (`:747-818`) plus inline tests.
- Safety S4a edits `serial_session.rs`/`serial.rs` command bodies and adds its own `ARCHITECTURE.md` delta.
- Refresh R0 already edited `ARCHITECTURE.md:194` (in this branch).

All are region-disjoint from `sim_integration` (`serial.rs:2276-3437`) and the `sim/` entry (`ARCHITECTURE.md:154-160`). Rebase, never drop either side. The Stage 0 re-check repeats this inventory.

## Diagnosis (verified)

1. **`$$` is canned.** It prints `$0=10`, `$1=25`, `$32=1` whatever was written (`sim/grbl.rs:507-514`). Every `$N=V` write is answered `ok` and ignored (`:515-519`). There is no `$30`. The module docs still say "no line in this sim is ever rejected with `error:N`" (`:36-38`), which `set_error_at_line` (`:770-773`) already contradicts, and they say real `$$` semantics are out of scope (`:86-89`).
2. **The hold auto-off is unconditional.** `feed_hold` clears `spindle_on` on `!` (`:577-587`), and its comment says "The sim always models a laser-mode machine". The parent cites `:409-419` for this, but that is the `0x9E` toggle (`:409-424`). The toggle is correct and out of scope (relay-plan D1 "Out of scope"). Its test is `feed_hold_auto_stops_spindle_and_0x9e_toggles_it_back` (`:1231-1252`).
3. **The status line has no `A:` field.** It is always `<State|MPos:0.000,0.000,0.000|FS:0,0>` (`:573`).
4. **No wedge fault exists.** The faults are `drop_ok_at_line` (one line), `error_at_line`, `alarm_after_ticks`, `silent`, `eof` and `write_fail` (`:187-208`). `ok` is emitted from `accept_ok` (`:547-560`) and directly for `$`/empty lines (`:479`, `:505`, `:513`, `:518`).
5. **One profile.** `SimConfig::default()` is `rx_budget: 128`, `planner_depth: 15` (`:155-166`). Every other `SimConfig { … }` literal in `src-tauri/src` spreads `..SimConfig::default()` (grep: 11 of 11), so a new field with a default breaks no caller.
6. **Departure 1: the parent's `A:` model is contradicted by the only capture in the tree.** The parent (and relay D1 change 3) says "`|A:S` while spindle on, absent otherwise". In `scripts/probe-20260914-153729.log`:
   - **every** status report that carries `Ov:` (53 of 53) also carries `A:S`;
   - that includes Idle reports after an acknowledged `M5` (`:80-83`: `M5` → `ok` → `<Idle|…|FS:0,0|Ov:100,100,100|A:S>`) and before any `M3`/`M4` in the session (`:70`);
   - reports without `Ov:` carry no `A:` at all (69 of 69), including Run reports mid-cut (`:212`, `:214`). So absence tracks the override-refresh cycle, not the spindle.

   On this controller, then, `A:S` is present with the spindle commanded off, and its absence says nothing. A Stock-only "on iff spindle" model tested green would certify a protocol this controller does not run, which is the failure class of the 2026-09-05 evidence correction. **Resolution:**
   - the **Stock** profile keeps the parent's model, labelled as stock-source intent per DECISIONS 2026-09-05 ("A:S = spindle energized"), with omission semantics unverified on hardware;
   - the **Captured127** profile emits `|A:S` on every report, labelled as what the capture shows;
   - the refresh cycle is not modelled.

   Production already never infers beam state from `A:`: the Rust parser maps absence to `Unknown`, "never off" (`grbl_status.rs:17`, `:76`, `:189-190`), and TS stores the raw flags, "We NEVER infer 'beam off'" (`machineStatus.ts:226-229`). So this changes no production reading. It gives CI a fixture for the owner's actual reporting.
7. **Departure 2: `serial_pump.rs` is not needed.** Its test module (`:755-`) drives the pumps with scripted readers and never uses the sim (`grep -c 'sim::' serial_pump.rs` = 0). Every existing test that drives the **real** `run_pump`/`run_buffered_pump` over the sim lives in `serial.rs` `sim_integration`, for example `dropped_ok_triggers_idle_stall_disconnect` (`:2329-2365`) and `buffered_pump_full_job_20_lines_zero_overflow` (`:2971-3006`). The wedge tests go there, beside them.
8. **The outcomes the wedge must reach already exist.**
   - Per-line: `run_pump` returns `Disconnected("terminal lost: …")` after `idle_stall_ticks` consecutive Idle replies (`serial_pump.rs:200-211`).
   - Buffered: `run_buffered_pump` does the same when `in_flight` is non-empty (`:688-697`).
   - `send_byte_inner` (`serial.rs:596`) is the realtime path the existing wedge test uses (`:2624-2693`).

## Change

### 1. `src-tauri/src/sim/grbl.rs`

**Settings table (tracked `$32`, plus `$30`):**
- `const SEED_SETTINGS: [(u32, &str); 4] = [(0, "10"), (1, "25"), (30, "1000"), (32, "1")];`
- A `settings: Vec<(u32, String)>` field on `GrblBrain`, seeded from that constant in `new()`. It is **not** reset by `boot_or_reset`, because GRBL settings persist across `0x18`.
- The `$$` arm prints `self.settings` in order, then `ok`.
- A write `$N=V`, parsed by a small `parse_setting_write(rest) -> Option<(u32, String)>` in the catch-all arm, is applied through `fn apply_setting(&mut self, n: u32, v: String)` (update or append `N`), then answers `ok`. The reject check (below) sits inside the `if let Some((n, v))` before the `apply_setting` call.
- `pub fn laser_mode(&self) -> bool` is derived from the table: `$32` parses to `1`. There is **one source**, and no second writer: only a `$32=` line changes it, and there is no `$RST` model (stated in the doc comment).
- `SimPort::laser_mode()` delegates to it.

**The hold auto-off is gated:** in `feed_hold`, `self.spindle_on = false;` sits under `if self.laser_mode() {`. The comment changes to say that under `$32=0` the spindle stays on through the hold.

**Rejected write fixture:**
- `Faults.reject_setting: Option<u32>`, and `SimPort::set_reject_setting(n)`.
- A write whose `N` equals it answers `error:3` and is not applied. Other settings are unaffected.

**Profiles:**
- `#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)] pub enum SimProfile { #[default] Stock, Captured127 }`.
- A `profile: SimProfile` field on `SimConfig`, set to `Stock` in `Default`.
- `SimConfig::for_profile(p) -> SimConfig` sets `(rx_budget, planner_depth)` from `match p { SimProfile::Stock => (128, 15), SimProfile::Captured127 => (65536, 127) }`, plus `profile: p`.
- Doc comment:
  - planner and buffer sizes only;
  - "captured from the owner's controller status/option reports, 2026-09-14 (the public capture's `Bf:127,65535`); not a certification of that controller";
  - the A: behaviour of Diagnosis 6.
  - **No vendor or model name, no firmware string, no `[VER:`/`[OPT:` text.**

**`A:` field.** `status_probe` appends:

```
match self.config.profile {
    SimProfile::Stock => if self.spindle_on { "|A:S" } else { "" },
    SimProfile::Captured127 => "|A:S",
}
```

before the closing `>`. Doc comment: Stock follows stock-source intent (A:S = spindle energised) with absence meaning "not reported", omission semantics unverified on hardware. Captured127 reproduces the capture: A:S on every report that carries overrides, including after an acknowledged M5, so A:S is not a beam signal there. The override-refresh cycle is not modelled, and `S` versus `C` for M4 is not modelled.

**Wedge fault:**
- `Faults.wedge_after_spindle_cmd: bool`, set by `SimPort::set_wedge_after_spindle_cmd()`, and a brain field `wedged: bool`.
- **Arming:** in `complete_line`, after the spindle-tracking block (`:464-475`):
  ```
  if self.faults.wedge_after_spindle_cmd && contains_spindle_sync_mcode(&text) && !contains_spindle_off_mcode(&text) {
      self.wedged = true;
      self.faults.wedge_after_spindle_cmd = false;
  }
  ```
  This is one-shot, and the arming `M3`/`M4` line is itself unacknowledged. That matches the probe's wedge message shape ("Idle ×3 with no ok for: M4 …", `probe-grbl.py:178-180`). It is a modelling choice pending session A's capture, and the doc comment says so.
- **Suppression:** at the top of `accept_ok`, after the counter increments: `if self.wedged { return; // wedge: accepted into the planner, never acked }`. Lines are still accepted and executed, so `?` goes Run then Idle as the planner drains.
- **Clearing:** `boot_or_reset` adds `self.wedged = false;`, so `0x18` clears it.
- **Scope:** `$`-system and empty lines still ack during a wedge. That is not modelled, and is unknown on hardware. It is stated in the doc comment and parked.

**Module docs** (`:36-38`, `:86-89`) and the `feed_hold` comment are corrected to the above. `#![cfg_attr(not(test), allow(dead_code))]` (`:91`) stays.

**New brain-level tests go in the existing `mod tests`** (`:930-`), beside the spindle tests.

### 2. `src-tauri/src/commands/serial.rs`, `sim_integration` only (`:2276-3437`)

Three new tests that drive the **real** pumps over the sim:
- per-line `run_pump` into a wedge;
- a wedge then `send_byte_inner(0x18)`, then a line that acks;
- buffered `run_buffered_pump` into a wedge.

They are modelled on `dropped_ok_triggers_idle_stall_disconnect` (`:2329-2365`) and `wedged_pump_estop_then_disconnect_tears_down_cleanly` (`:2624-2693`). No other line in `serial.rs` changes.

### 3. `ARCHITECTURE.md`, the `grbl.rs` entry (`:155-158`) only

Append to the entry:
- `$$` is a settings table and `$32` is tracked: the hold auto-off applies only under `$32=1`;
- `set_reject_setting` (`error:3`, not applied);
- `set_wedge_after_spindle_cmd` (lines accepted, never acked, `?` answers, until `0x18`);
- `SimProfile::{Stock, Captured127}`;
- the `A:` field per profile, with the capture caveat;
- "host/model evidence only; never certifies the owner's controller".

## Tests and mutants

**Battery spec `kerf-evidence-e5`:**
- `test_command`: `["/home/leesalo/.cargo/bin/cargo","test","--manifest-path","src-tauri/Cargo.toml","--features","sim","--","sim::grbl","sim_integration"]`.
  - Cargo is not on PATH in every shell, hence the absolute path.
  - libtest accepts several name filters. Ted confirms from the baseline output that both modules' tests ran, and states the count.
- **Run the battery with `env -u KERF_UPDATE_GOLDEN node ~/marvin/scripts/mutation-battery.mjs <spec>`.** The battery passes its environment through (`scrubbedEnv` strips only `GIT_*`, `mutation-battery.mjs:790-796`). The filters also exclude the golden tests, and `b2a_generate_native_status_fixture` writes a TS fixture when that variable is set (`serial.rs:3212-3221`).
- **Timing (measured on prior kerf Rust batteries, not guessed):**
  - The battery copy does not carry `src-tauri/target`, so the baseline is a cold build: 218 s measured in `kerf-b1-admission-fence` (`~/marvin/state/relay/kerf-b1-admission-fence-ted-report-b1.md`).
  - Later mutants rebuild incrementally in the same copy, about 70-110 s each: `relay-kerf-fence-single-reset` ran 8 Rust mutants between baseline end 23:13:06 and 23:23:21, per its journal.
  - Twelve ids here make about 20-25 minutes, so set `per_mutant_timeout_ms: 660000` (as b1 did) and `total_timeout_ms: 3600000`. **Do not run cargo by hand to "check" the battery. Read the journal.**

**Rules:**
- Each id is one contiguous find/replace whose `find` occurs exactly once in its file (`mutation-battery.mjs:1773-1780`). No mutant is stacked.
- E5-M4 and E5-M5 share the anchor `if self.spindle_on { "|A:S" } else { "" }`. It must occur once in the base file. They are two separate single-edit mutants.
- `self.settings.iter()` may occur more than once (the `$$` arm, `laser_mode`, `apply_setting`), so E5-M1's `find` carries the `$$` arm's surrounding text. Likewise, `self.push_line("error:3");` must occur only in the reject branch.
- Controls are killed mutants like any other.

**How each goes red:** each is a test assertion on sim output or pump outcome. No mutant is caught only by a compile error: every wrong variant below type-checks.

| Id | Test | Wrong variant (one edit) |
|---|---|---|
| E5-M1 | Write `$32=0` (gets `ok`), then `$$`: the dump contains `$32=0` and not `$32=1`; `laser_mode()` is false | In the `$$` arm, replace `self.settings.iter()` with `SEED_SETTINGS.iter()` (the `format!` over `(n, v)` still compiles) |
| E5-M2 | `$32=0`, `M4 S500`, `G1 X10 F500`, `!`: `spindle_energized()` is still true. With `$32=1`: false | Replace `if self.laser_mode() {` in `feed_hold` with `if true {` |
| E5-M3 | `set_reject_setting(30)`; `$30=500` answers `error:3`; the next `$$` still shows `$30=1000` | Replace `self.push_line("error:3");` with `self.apply_setting(n, v); self.push_line("error:3");` |
| E5-M4 | Stock: `?` with the spindle off has no `A:`; after `M4 S500` it has `A:S` | Replace the Stock arm's `if self.spindle_on { "|A:S" } else { "" }` with `"|A:S"` |
| E5-M5 | Same test | Replace the same expression with `""` |
| E5-M6 | Per-line: `set_wedge_after_spindle_cmd()`; write `M4 S500\n`; real `run_pump` with `idle_stall_ticks` 3 returns `Err(Disconnected(msg))` with `msg` containing `terminal lost`, and `realtime_bytes_received()` holds ≥ 3 `?` | Replace `return; // wedge: accepted into the planner, never acked` with `self.wedged = false; // one ok escapes` |
| E5-M7 | Wedge as E5-M6, then `send_byte_inner(&inner, 0x18)` over a `SerialInner` whose realtime handle is a sim clone; drain the banner; write `G1 X1 F500\n`; `run_pump` returns `Ok` with terminal `Ok` | Delete `self.wedged = false;` from `boot_or_reset` |
| E5-M8 | `SimConfig::for_profile(Captured127)`: write 100 × `G1 X0.1 F500\n` with no reads: `planner_len() == 100`, `pending_len() == 0`, `overflow_count() == 0`. Stock: `planner_len() == 15`, `pending_len() == 85` | Replace `SimProfile::Captured127 => (65536, 127)` with `SimProfile::Captured127 => (128, 15)` |
| E5-M9 | Captured127: after `M5` is acked, `?` contains `A:S` (Diagnosis 6) | Replace `SimProfile::Captured127 => "|A:S",` with `SimProfile::Captured127 => if self.spindle_on { "|A:S" } else { "" },` |
| E5-M10 | Wedge armed; `M5\n` gets `ok`, and a following `G1 X1\n` gets `ok`; the wedge arms only on `M4 S500\n` after them | Delete `&& !contains_spindle_off_mcode(&text)` from the arming condition |
| E5-C1 | (control) Default config: `$$` shows `$32=1`, and the existing `feed_hold_auto_stops_spindle_and_0x9e_toggles_it_back` (`:1231-1252`) and `feed_hold_alone_clears_spindle_resume_keeps_it_off` (`:1268-1291`) stay green unmodified | Seed `(32, "0")` in `SEED_SETTINGS` |
| E5-C2 | (control) `set_reject_setting(30)` does not reject `$32=0`, which answers `ok` and applies | Replace `self.faults.reject_setting == Some(n)` with `self.faults.reject_setting.is_some()` |

**One extra test with no battery id:** the buffered wedge. A real `run_buffered_pump` over `["M4 S500", "G1 X1 F500", "G1 X2 F500"]` with the wedge armed returns `Disconnected` containing `terminal lost`.
- It has no id because the natural mutants are already owned: one escaped `ok` (E5-M6) still leaves lines in flight, so this test stays green under it.
- It pins the buffered outcome (`serial_pump.rs:688-697`) against the wedge, and it is stated as coverage, not as a kill.

## Verification

- `env -u KERF_UPDATE_GOLDEN ~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --features sim`: the full suite, with the baseline count recorded at relay start and the new count after.
- `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`: sim absent without the feature, and no warning.
- `~/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- `~/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- `git diff --stat -- src-tauri/tests/golden src/lib/machine/__tests__/fixtures`: empty.
- Battery journal: every E5-M* and E5-C* id `killed`; `survived`, `errored` and `CONTROL_RED` all 0.
- **Vendor-identity grep (Razor), on added lines only:** `git diff -U0 master...relay/kerf-evidence-e5 | grep '^+' | grep -niE 'falcon|creality|\[VER:|\[OPT:|CV master'`. Must be empty.
- No browser step: nothing here is reachable from the dev server.

**Hardware-only (named, not closable here):**
- What `A:` means on the owner's controller, and when it is omitted.
- Whether the wedge's arming line is itself unacknowledged, and whether `$` lines still ack during it (session A).
- Whether `$32=0` really keeps the spindle on through a hold on this controller.

## What E5 does not satisfy

- **Certification of the owner's controller.** A green sim is host/model evidence only (astra "Simulator correction"; DECISIONS 2026-09-05).
- **Production-body stop verification against the sim** (relay-plan D2). It is in the parent's Out of scope and waits on the next stop batch.
- **Any change to the `0x9E` toggle model** beyond v0.8.29 (relay-plan D1 "Out of scope").
- **The override-refresh cycle, `S` versus `C`, `$RST`, and `$` lines during a wedge.** None is modelled. Each is named in the doc comments and parked below.

## Stage 3.5 obligations (orchestrator)

- **ARCHITECTURE.md:** inside the batch (file 3). Razor reads it against the code.
- **ROADMAP Parking Lot**, appending index lines:
  - `- **Sim A: refresh cycle not modelled (E5)** — the captured controller reports A: only on override-refresh reports; the sim emits it on every report.`
  - `- **Sim wedge: $ lines still ack (E5)** — unknown on hardware; revisit when session A captures the wedge.`
- **Proposed DECISIONS amendment, for Lee, not written by the relay:**
  - The 2026-09-05 entry says "The correct signal is the `A:` accessory field of the status report (`A:S` = spindle energized)".
  - The 2026-09-14 capture shows `A:S` on Idle reports after an acknowledged `M5` on the owner's controller.
  - Proposed Evidence-corrections entry: "On the owner's controller `A:S` appears on every override-refresh report, including with the spindle commanded off; it is not a spindle-energised signal there." It would be written through `scripts/update-decisions.mjs` only on Lee's yes (skills-awareness rule: propose, never auto-write).

## Risks and rollback

- **Existing suite drift:**
  - The Stock default keeps `$32=1` (E5-C1) and 128/15, so every existing sim test keeps its numbers.
  - Status lines under Stock gain `|A:S` only while the spindle is on. The pump classifiers split on `|` and ignore unknown fields. Ted runs the full suite at baseline and after.
  - `grbl_status.rs` tests do not use the sim.
- **Merge:** disjoint regions from S1b and S4a (see inventory). Rebase, keep both sides.
- **Battery cost:** measured above. If a mutant times out, it is `errored`, not a survivor. Re-run it alone; never raise the count by removing ids.
- **Rollback:** revert the relay merge commit. Nothing depends on E5 until relay-plan D2.
- **Irreversible steps:** none. No port and no hardware.
