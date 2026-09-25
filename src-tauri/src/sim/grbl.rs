//! Virtual GRBL 1.1 controller — `SimPort` plugs into the exact
//! `Box<dyn SerialPort>` seam `CommandChannel` uses for a real port
//! (serial.rs:72-76), so the streaming stack becomes testable without
//! hardware. Modeled after the existing test `MockPort` (serial.rs:468-574):
//! a `SerialPort` impl backed by shared state behind `Arc<Mutex<_>>`, with
//! `try_clone()` handing out new handles wired to the SAME state.
//!
//! ## Two-stage buffer model (the whole point)
//!
//! Incoming bytes -> an RX budget (`GrblBrain::rx_used`, config
//! `rx_budget`: 128 bytes under the `Stock` profile, 65535 under
//! `Captured127`) -> line parser -> planner queue (config `planner_depth`:
//! 15 under `Stock`, 127 under `Captured127`) -> executor (each accepted entry counts down `line_ticks`
//! before "finishing").
//!
//! `ok` is emitted the instant a line is **accepted into the planner**, not
//! when it finishes executing (see `dispatch_motion_line`). When the planner
//! is full, an arriving line is parked in `pending_lines` instead: its bytes
//! stay charged against the RX budget and no `ok` is sent until a planner
//! slot frees up and the line is promoted (`try_promote_pending`). This is
//! exactly the backpressure character-counting flow control (Phase 2) is
//! designed to exploit — the RX buffer should stay near-full under a dense
//! stream of short lines, never idle waiting on a round trip.
//!
//! If accounting more incoming bytes would exceed `rx_budget`, that is a
//! protocol violation a real GRBL handles by dropping the offending
//! character (silent RX overflow / data corruption). This sim does not
//! reproduce the corruption — it would make the harness un-debuggable for
//! no benefit — it instead counts the event (`overflow_count`) so a test can
//! assert it never happens under correct flow control.
//!
//! ## Line protocol
//!
//! - Startup banner (`Grbl 1.1f ['$' for help]`) is queued the moment a
//!   `GrblBrain`/`SimPort` is constructed (modeling "power-on") and again on
//!   a `0x18` soft reset.
//! - `ok` / `error:N` — acceptance semantics above. A line is rejected with
//!   `error:N` only by a scripted fault: `set_error_at_line` (the Nth
//!   accepted line) or `set_reject_setting` (`error:3` for one setting
//!   write). Nothing is rejected on its own merits.
//! - `ALARM:n` is reachable only via `initial_state`/reset (config surface),
//!   cleared by `$X`.
//! - `?` (single realtime byte) -> `<State|MPos:x,y,z|FS:f,s>`, plus an
//!   `|A:S` accessory field per profile (see `status_probe`): `Stock` emits
//!   it while the spindle is on, `Captured127` on every report. Muted while
//!   `$H` homing is in flight, mirroring the muted-`?` window real GRBL
//!   exhibits (serial_pump's liveness probing tolerates stretches of
//!   silence for exactly this reason).
//! - `!` -> Hold, `~` -> resume (Run if the planner/pending queues are
//!   non-empty, else Idle).
//! - `$H` -> Home state; the `ok` for the `$H` line itself is deferred until
//!   the configured `homing_ticks` elapse (see `GrblBrain::tick`).
//! - Realtime bytes `?` `!` `~` `0x18` and (reserved) `0x9E` are single bytes
//!   that bypass the RX line buffer entirely and act immediately — they are
//!   never subject to the RX budget or the planner.
//!
//! ## The strict-hold invariant (load-bearing)
//!
//! This sim cannot faithfully model GRBL's spindle-sync semantics (real
//! GRBL sync-blocks an M3/M5 *line* while in Feed Hold — the documented F13
//! deadlock, connection.ts:404-419). Modeling that hang would make the sim
//! itself hang. Instead the sim enforces a precisely-scoped **invariant**: a
//! violation = an M3/M4/M5 (spindle/laser) line completing while the
//! machine is in Hold — the F13 spindle-sync deadlock the Phase-2 abort
//! volley must avoid by using realtime `0x18`, never a line-based M5. A
//! benign G-code line (motion, a `$`-system command, an empty line)
//! completing in Hold is harmless on real hardware and is NOT flagged
//! (`contains_spindle_sync_mcode`, matched case-insensitively, tolerant of
//! leading zeros — `M5`/`M05`/`M3 S0` all count; a coordinate word or an
//! `M` inside a `(...)` comment never does). Violations are recorded in
//! `hold_invariant_violations` when `strict_hold_invariant` is enabled
//! (default on). Realtime bytes sent during Hold — including a resume `~`,
//! which exits Hold — never trip it. This is what pins Phase 2's abort
//! volley (`!` -> settle -> realtime `0x18` -> conditional M5) in CI: a
//! line-based M5 sent instead of the realtime `0x18` shows up as a recorded
//! violation the moment it lands on the wire.
//!
//! ## Fault injection (Relay 1B)
//!
//! `SimPort`'s `set_*` methods (`set_drop_ok_at_line`, `set_error_at_line`,
//! `set_alarm_after_ticks`, `set_silent`, `set_eof`, `set_write_fail`,
//! `set_reject_setting`, `set_ignore_setting`, `set_wedge_after_spindle_cmd`)
//! script
//! misbehavior that composes with the model above rather than bypassing it
//! — a dropped `ok` still lets its line execute; an unsolicited alarm still
//! runs through the normal tick clock. Each maps 1:1 to a `run_pump`
//! outcome (`PumpFailure`/`PumpTerminal`) — see the integration tests in
//! `commands::serial`'s `sim_integration` test module, which drive the REAL
//! `run_pump`/`drain_startup_banner`/`disconnect_inner`/`send_byte_inner`
//! against a faulted sim.
//!
//! ## Explicitly out of scope
//!
//! Acceleration/junction planning, G2/G3 arcs, and laser-power simulation.
//! `$$` IS modelled as a settings table (see `SEED_SETTINGS` and its
//! "Not modelled" list). A green run of this sim is host/model evidence
//! only; it never certifies the owner's controller.

#![cfg_attr(not(test), allow(dead_code))]
// No production consumer exists yet in this relay — Phase 2 wires a demo
// connectable port into this module. Under `--features sim` without the
// `test` cfg (i.e. a plain build with the feature on, not `cargo test`),
// nothing in the crate calls these types yet, which would otherwise warn.
// Under `cargo test` the allow is OFF, so an orphaned/unused helper still
// warns — this module's own `#[cfg(test)]` suite exercises the full
// surface, so nothing should ever need the allow while testing.

use serialport::{self, SerialPort};
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The GRBL startup/reset banner, verbatim.
const BANNER: &str = "Grbl 1.1f ['$' for help]";

/// Seed values for the `$$` settings table (`GrblBrain::settings`). `$30` is
/// max spindle speed (stock default 1000); `$32` is laser mode.
///
/// Settings persist across `0x18` (as in GRBL, which keeps them in EEPROM),
/// so `boot_or_reset` never touches the table. `$32` follows stock
/// `settings.c`: a value whose integer part is non-zero means laser mode,
/// and it is stored normalised to `1`/`0`. The only writer is a `$N=V` line;
/// there is no `$RST` model.
///
/// Not modelled (each named, parked, and unknown or different on hardware):
/// - Setting writes outside Idle/Alarm. Stock refuses `$N=V` with `error:8`
///   there; this sim accepts a write in every state. It matters because the
///   buffered job writes `$32=1` as its first line, possibly while a previous
///   job's planner is still draining.
/// - Bad-number writes. Stock answers `error:2`; here a non-numeric value
///   falls through to the catch-all `ok` and is not applied.
/// - `$RST`, the override-refresh cycle of the `A:` field, `S` versus `C`
///   for M4, and whether `$` lines still ack during a wedge.
/// - `0x18` always resets and always clears the spindle. DECISIONS
///   2026-09-05 records a `0x18` on the owner's controller that failed to
///   stop the beam (2026-09-02); there is no fixture for that.
const SEED_SETTINGS: [(u32, &str); 4] = [(0, "10"), (1, "25"), (30, "1000"), (32, "1")];

/// Parses the body of a `$N=V` setting write (`rest` is the line after `$`).
/// `Some` only when `N` is an integer and `V` parses as a number.
fn parse_setting_write(rest: &str) -> Option<(u32, String)> {
    let (n, v) = rest.split_once('=')?;
    let n: u32 = n.trim().parse().ok()?;
    let v = v.trim();
    v.parse::<f64>().ok()?;
    Some((n, v.to_string()))
}

/// Stock `$32` semantics: the integer part of the value, non-zero means
/// laser mode. Returns the normalised stored value, `"1"` or `"0"`.
fn normalise_laser_flag(v: &str) -> String {
    let n = v.parse::<f64>().map(|f| f.trunc()).unwrap_or(0.0);
    if n != 0.0 {
        "1".to_string()
    } else {
        "0".to_string()
    }
}

/// Which controller the sim's sizes and `A:` reporting follow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SimProfile {
    /// Stock GRBL 1.1: 128-byte RX buffer, 15-block planner, and `A:S`
    /// reported while the spindle is on (stock-source intent: A:S = spindle
    /// energised; absence means "not reported"; omission semantics are
    /// unverified on hardware).
    #[default]
    Stock,
    /// Planner and buffer sizes only, captured from the owner's controller
    /// status/option reports, 2026-09-14 (the public capture's
    /// `Bf:127,65535`); not a certification of that controller.
    ///
    /// The option report in the capture says 65536; every status report that
    /// carries `Bf:` says 65535 bytes available. `rx_budget` is the
    /// receiver's usable capacity, so it takes the observed usable figure,
    /// the stricter of the two: a host that fills to 65536 overflows the sim
    /// instead of passing.
    ///
    /// `A:` field: in the capture, `A:S` was present on every status report
    /// that carried overrides (53 of 53), including Idle reports after an
    /// acknowledged `M5` and before any `M3`/`M4`, and absent on every report
    /// without overrides (69 of 69), including Run reports mid-cut with
    /// spindle speed non-zero. On that controller it cannot be read as
    /// beam-on or beam-off. This profile emits `A:S` on every report; the
    /// override-refresh cycle is not modelled.
    Captured127,
}

/// GRBL machine state, as reported in `<State|...>` status lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MachineState {
    Idle,
    Run,
    Hold,
    Alarm,
    Home,
}

impl MachineState {
    fn as_str(self) -> &'static str {
        match self {
            MachineState::Idle => "Idle",
            MachineState::Run => "Run",
            MachineState::Hold => "Hold",
            MachineState::Alarm => "Alarm",
            MachineState::Home => "Home",
        }
    }
}

/// Config surface — plain struct, sensible defaults, everything a test (or
/// Phase 2's demo port) needs to shape without touching the internals.
#[derive(Debug, Clone)]
pub struct SimConfig {
    /// GRBL's serial RX ring buffer size in bytes. Stock GRBL 1.1 = 128;
    /// some variants report 255 (program Assumption 1). The sender side
    /// stays conservative regardless — this is the RECEIVER's budget.
    pub rx_budget: usize,
    /// Planner block buffer depth. Stock GRBL default = 15.
    pub planner_depth: usize,
    /// Ticks a planner entry takes to "execute" once it reaches the front
    /// of the queue. A tick is one `Read::read` call that found no data
    /// already queued — see `SimPort::read`.
    pub line_ticks: u32,
    /// Ticks `$H` homing takes before its deferred `ok` and the return to
    /// Idle.
    pub homing_ticks: u32,
    /// State immediately after construction and after every `0x18` soft
    /// reset. `Alarm` models a `$22=1` (homing-required) machine.
    pub initial_state: MachineState,
    /// Enforce the F13 abort-volley invariant (see module docs). Default on.
    pub strict_hold_invariant: bool,
    /// Which controller's sizes and `A:` reporting to follow. Default `Stock`.
    pub profile: SimProfile,
}

impl SimConfig {
    /// Default config with `rx_budget`/`planner_depth` set from the profile.
    pub fn for_profile(p: SimProfile) -> SimConfig {
        let (rx_budget, planner_depth) = match p {
            SimProfile::Stock => (128, 15),
            SimProfile::Captured127 => (65535, 127),
        };
        SimConfig {
            rx_budget,
            planner_depth,
            profile: p,
            ..SimConfig::default()
        }
    }
}

impl Default for SimConfig {
    fn default() -> Self {
        Self {
            rx_budget: 128,
            planner_depth: 15,
            line_ticks: 2,
            homing_ticks: 3,
            initial_state: MachineState::Idle,
            strict_hold_invariant: true,
            profile: SimProfile::Stock,
        }
    }
}

/// A complete line that arrived while the planner had no room. Only ever a
/// motion/M-code line — `$`-system commands are handled synchronously and
/// never queue here (see `complete_line`).
#[derive(Debug, Clone, Copy)]
struct PendingLine {
    len: usize,
}

/// An accepted-into-planner entry counting down its execution duration.
#[derive(Debug, Clone, Copy)]
struct PlannerEntry {
    remaining_ticks: u32,
}

/// Fault-injection scripting (Relay 1B). Every fault composes with the
/// existing planner/tick model rather than bypassing it — a dropped `ok`
/// still lets the line execute; an unsolicited alarm still runs through the
/// normal tick clock. Set via `SimPort`'s `set_*` methods, which lock the
/// shared brain, so any clone can arm a fault the others observe.
#[derive(Debug, Default, Clone, Copy)]
struct Faults {
    /// Suppress the `ok` for the Nth line accepted into the planner
    /// (1-indexed, counting both immediate accepts and later promotions —
    /// see `GrblBrain::accept_ok`). Models a firmware ack glitch: the line
    /// still executes, but the host never hears back.
    drop_ok_at_line: Option<u32>,
    /// Answer `error:3` to a `$N=V` write whose `N` equals this, and do not
    /// apply it. Other settings are unaffected. Wins over `ignore_setting`.
    reject_setting: Option<u32>,
    /// Answer `ok` to a `$N=V` write whose `N` equals this, and do NOT apply
    /// it. DECISIONS 2026-09-10: "a controller that acknowledges a settings
    /// write is not a controller that accepted it". Consumer: the Rust
    /// `$32=1` gate in `serial_stream_job`, which checks for `ok` only.
    ignore_setting: Option<u32>,
    /// One-shot laser-switch wedge: the next M3/M4 line (not M5) arms
    /// `GrblBrain::wedged`, after which lines are accepted and executed but
    /// never acknowledged until `0x18`; `?` still answers. The arming line
    /// is itself unacknowledged, matching the probe's wedge message shape
    /// ("Idle x3 with no ok for: M4 ..."): a modelling choice pending a
    /// hardware capture. `$`-system and empty lines still ack during a wedge;
    /// that is not modelled and is unknown on hardware.
    wedge_after_spindle_cmd: bool,
    /// Reply `error:{1}` instead of `ok` for the Nth accepted line (`.0`).
    error_at_line: Option<(u32, u32)>,
    /// Raise an unsolicited `ALARM:1` after N more ticks elapse (e.g. a
    /// simulated hard-limit trip while otherwise idle or mid-job).
    alarm_after_ticks: Option<u32>,
    /// The link is dead: `Read::read` always returns `TimedOut`, regardless
    /// of anything queued in `outbound` — models liveness expiry.
    silent: bool,
    /// The port vanished: `Read::read` always returns `Ok(0)` — models the
    /// pump's EOF branch (serial_pump.rs's `Ok(0) => Disconnected`).
    eof: bool,
    /// The port vanished the OTHER direction: `Write::write` always
    /// returns `Err` — models `PumpFailure::Io` at the write site.
    write_fail: bool,
}

/// True if `text` contains a stand-alone M3, M4, or M5 command word — the
/// spindle/laser control codes real GRBL sync-blocks while in Feed Hold
/// (the F13 hazard the strict-hold invariant pins). Case-insensitive and
/// tolerant of leading zeros (`M05`, `M3 S0`, `M3S1000` all count), but
/// requires the digits immediately after `M`/`m` to reduce to exactly 3, 4,
/// or 5 — `M30` (program end) and `M8` (coolant) never match, nor does any
/// non-`M` word (a coordinate like `X5`). Content inside `(...)` comments and
/// after `;` (semicolon end-of-line comments, used by Kerf's own G-code
/// annotations like `; Cut: M5 bracket`) is skipped.
fn contains_spindle_sync_mcode(text: &str) -> bool {
    // Truncate at `;` before scanning — semicolon comments are end-of-line.
    let text = text.split(';').next().unwrap_or("");
    let mut chars = text.chars().peekable();
    let mut in_comment = false;
    while let Some(c) = chars.next() {
        match c {
            '(' => in_comment = true,
            ')' => in_comment = false,
            _ if in_comment => {}
            'M' | 'm' => {
                let mut digits = String::new();
                while let Some(&d) = chars.peek() {
                    if d.is_ascii_digit() {
                        digits.push(d);
                        chars.next();
                    } else {
                        break;
                    }
                }
                let code = digits.trim_start_matches('0');
                if code == "3" || code == "4" || code == "5" {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// True if `text` contains a stand-alone M5 command word — the spindle-off
/// code. Same parsing rules as `contains_spindle_sync_mcode` (case-insensitive,
/// leading-zero-tolerant, comment-aware including `;` truncation) but matches
/// only M5.
fn contains_spindle_off_mcode(text: &str) -> bool {
    // Truncate at `;` before scanning — matches contains_spindle_sync_mcode.
    let text = text.split(';').next().unwrap_or("");
    let mut chars = text.chars().peekable();
    let mut in_comment = false;
    while let Some(c) = chars.next() {
        match c {
            '(' => in_comment = true,
            ')' => in_comment = false,
            _ if in_comment => {}
            'M' | 'm' => {
                let mut digits = String::new();
                while let Some(&d) = chars.peek() {
                    if d.is_ascii_digit() {
                        digits.push(d);
                        chars.next();
                    } else {
                        break;
                    }
                }
                let code = digits.trim_start_matches('0');
                if code == "5" {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// The shared GRBL brain. Every `try_clone()`'d `SimPort` drives/observes
/// this SAME state via `Arc<Mutex<_>>` — mirroring how `CommandChannel`'s
/// three clones (command writer, persistent reader, realtime writer) are
/// all handles to one physical controller.
pub struct GrblBrain {
    config: SimConfig,

    // Stage 1: incoming bytes not yet a complete line.
    line_in_progress: Vec<u8>,
    /// Bytes currently charged against `config.rx_budget`: the partial
    /// `line_in_progress` plus every complete line parked in
    /// `pending_lines`.
    rx_used: usize,

    // Stage 2 -> 3: complete lines waiting for planner room, and accepted
    // planner entries executing in FIFO order.
    pending_lines: VecDeque<PendingLine>,
    planner: VecDeque<PlannerEntry>,

    /// `Some(n)` while `$H` homing is in flight; `?` is muted and the
    /// deferred `ok` fires when this reaches 0 (see `tick`).
    homing_remaining: Option<u32>,

    state: MachineState,

    /// Spindle modal flag — set by M3/M4 lines, cleared by M5 lines and
    /// by the 0x9E spindle-stop-override realtime byte (Hold-only).
    /// Models whether the laser/spindle is energized; Phase 2A's pause
    /// volley asserts `spindle_energized() == false` after `[!, 0x9E]`.
    spindle_on: bool,

    /// Bytes queued for the host to read: banner/ok/error/alarm/status/msg.
    outbound: VecDeque<u8>,

    overflow_count: usize,
    hold_invariant_violations: Vec<String>,

    /// Counts every line accepted into the planner (immediate accept or
    /// promotion), 1-indexed — what `Faults::drop_ok_at_line`/
    /// `error_at_line` key off of. Not reset by `boot_or_reset` (a fault
    /// script spans the whole test, resets included).
    accepted_count: u32,
    faults: Faults,
    /// Every realtime byte (`?`/`!`/`~`/`0x18`/`0x9E`) this brain has ever
    /// received, in arrival order — lets a test assert "this byte reached
    /// the wire" the way `MockPort`'s shared `written` buffer does for
    /// plain writes (serial.rs:469).
    realtime_log: Vec<u8>,
    /// The `$$` settings table, seeded from `SEED_SETTINGS`. Persists across
    /// `0x18`.
    settings: Vec<(u32, String)>,
    /// Laser-switch wedge in effect (see `Faults::wedge_after_spindle_cmd`).
    /// Cleared by `0x18`.
    wedged: bool,
}

impl GrblBrain {
    pub fn new(config: SimConfig) -> Self {
        let mut brain = Self {
            config,
            line_in_progress: Vec::new(),
            rx_used: 0,
            pending_lines: VecDeque::new(),
            planner: VecDeque::new(),
            homing_remaining: None,
            state: MachineState::Idle,
            spindle_on: false,
            outbound: VecDeque::new(),
            overflow_count: 0,
            hold_invariant_violations: Vec::new(),
            accepted_count: 0,
            faults: Faults::default(),
            realtime_log: Vec::new(),
            settings: SEED_SETTINGS
                .iter()
                .map(|(n, v)| (*n, v.to_string()))
                .collect(),
            wedged: false,
        };
        brain.boot_or_reset();
        brain
    }

    /// Shared by construction ("power-on") and `0x18` soft reset: clears
    /// every in-flight buffer/queue, returns to `config.initial_state`, and
    /// queues the startup banner. Diagnostics (`overflow_count`,
    /// `hold_invariant_violations`) are cumulative test-inspection logs and
    /// deliberately survive a reset.
    fn boot_or_reset(&mut self) {
        self.line_in_progress.clear();
        self.rx_used = 0;
        self.pending_lines.clear();
        self.planner.clear();
        self.homing_remaining = None;
        self.state = self.config.initial_state;
        self.spindle_on = false;
        self.wedged = false;
        self.push_line(BANNER);
    }

    fn push_line(&mut self, text: &str) {
        self.outbound.extend(text.as_bytes().iter().copied());
        self.outbound.push_back(b'\r');
        self.outbound.push_back(b'\n');
    }

    fn outbound_len(&self) -> usize {
        self.outbound.len()
    }

    fn pop_outbound(&mut self) -> Option<u8> {
        self.outbound.pop_front()
    }

    /// Entry point for `Write::write`: dispatches every byte either as a
    /// realtime action (bypassing the RX buffer entirely) or as RX-buffered
    /// line content.
    fn handle_bytes(&mut self, buf: &[u8]) {
        for &b in buf {
            match b {
                0x18 => {
                    self.realtime_log.push(b);
                    self.soft_reset();
                }
                b'?' => {
                    self.realtime_log.push(b);
                    self.status_probe();
                }
                b'!' => {
                    self.realtime_log.push(b);
                    self.feed_hold();
                }
                b'~' => {
                    self.realtime_log.push(b);
                    self.resume();
                }
                0x9E => {
                    // GRBL 1.1's realtime Toggle Spindle-Stop override.
                    // Like every realtime byte it bypasses the RX line buffer.
                    // Only effective during Hold — TOGGLES `spindle_on`.
                    // Outside Hold the byte is silently ignored (matches
                    // real GRBL behavior: override toggles are no-ops
                    // unless the corresponding override state is active).
                    //
                    // Critical: this is a TOGGLE, not unconditional off.
                    // Probe 2026-09-14 confirmed: firmware stops the spindle
                    // at hold-complete ($32=1), so sending 0x9E RE-ARMS it.
                    self.realtime_log.push(b);
                    if self.state == MachineState::Hold {
                        self.spindle_on = !self.spindle_on;
                    }
                }
                b'\n' => self.complete_line(),
                other => self.push_rx_byte(other),
            }
        }
    }

    fn push_rx_byte(&mut self, byte: u8) {
        self.account_rx_byte();
        self.line_in_progress.push(byte);
    }

    /// Charges one byte against the RX budget, or records an overflow if
    /// the budget is already exhausted.
    fn account_rx_byte(&mut self) {
        if self.rx_used >= self.config.rx_budget {
            self.overflow_count += 1;
        } else {
            self.rx_used += 1;
        }
    }

    /// A `\n` completed `line_in_progress` into a full line. Runs the
    /// hold-invariant check, then dispatches to system-command handling
    /// (`$...`) or the motion-line planner path.
    fn complete_line(&mut self) {
        // The newline itself also occupies RX space.
        self.account_rx_byte();

        let raw = std::mem::take(&mut self.line_in_progress);
        let len = raw.len() + 1; // content bytes + the newline just accounted
        let text = String::from_utf8_lossy(&raw).trim().to_string();

        if self.config.strict_hold_invariant
            && self.state == MachineState::Hold
            && contains_spindle_sync_mcode(&text)
        {
            self.hold_invariant_violations.push(text.clone());
        }

        // Track spindle modal state from M3/M4/M5 line commands.
        // Uses the same `contains_spindle_sync_mcode` parser to detect
        // spindle codes, then checks specifically which one: M3/M4 set
        // spindle_on, M5 clears it.
        if contains_spindle_sync_mcode(&text) {
            if contains_spindle_off_mcode(&text) {
                self.spindle_on = false;
            } else {
                // M3 or M4 (spindle on)
                self.spindle_on = true;
            }
        }

        if self.faults.wedge_after_spindle_cmd
            && contains_spindle_sync_mcode(&text)
            && !contains_spindle_off_mcode(&text)
        {
            self.wedged = true;
            self.faults.wedge_after_spindle_cmd = false;
        }

        if text.is_empty() {
            self.rx_used = self.rx_used.saturating_sub(len);
            self.push_line("ok");
            return;
        }

        if let Some(rest) = text.strip_prefix('$') {
            // System commands never queue on the planner — GRBL handles
            // them synchronously in its main loop, so their RX bytes free
            // immediately regardless of planner occupancy.
            self.rx_used = self.rx_used.saturating_sub(len);
            self.dispatch_system_command(rest);
        } else {
            self.dispatch_motion_line(len);
        }
    }

    fn dispatch_system_command(&mut self, rest: &str) {
        match rest {
            "H" => {
                self.state = MachineState::Home;
                self.homing_remaining = Some(self.config.homing_ticks);
                // `ok` deferred until homing completes — see `tick`.
            }
            "X" => {
                if self.state == MachineState::Alarm {
                    self.state = MachineState::Idle;
                }
                self.push_line("ok");
            }
            "$" => {
                // The settings table, in order (see `SEED_SETTINGS`).
                // Kept on one line: it is a mutation-battery anchor (E5-M1).
                #[rustfmt::skip]
                let dump: Vec<String> = self.settings.iter().map(|(n, v)| format!("${n}={v}")).collect();
                for line in dump {
                    self.push_line(&line);
                }
                self.push_line("ok");
            }
            _ => {
                // A numeric setting write `$N=V` is applied (subject to the
                // reject/ignore faults); anything else unrecognized is
                // accepted harmlessly (see "Not modelled" on SEED_SETTINGS).
                if let Some((n, v)) = parse_setting_write(rest) {
                    if self.faults.reject_setting == Some(n) {
                        self.push_line("error:3");
                    } else {
                        if self.faults.ignore_setting != Some(n) {
                            self.apply_setting(n, v);
                        }
                        self.push_line("ok");
                    }
                } else {
                    self.push_line("ok");
                }
            }
        }
    }

    /// Update or append setting `n`. `$32` is normalised to `1`/`0`.
    fn apply_setting(&mut self, n: u32, v: String) {
        let v = if n == 32 { normalise_laser_flag(&v) } else { v };
        if let Some(slot) = self.settings.iter_mut().find(|(k, _)| *k == n) {
            slot.1 = v;
        } else {
            self.settings.push((n, v));
        }
    }

    /// Laser mode, derived from the one source: the stored `$32` value
    /// (normalised on write, so it equals `"1"` in laser mode).
    pub fn laser_mode(&self) -> bool {
        self.settings.iter().any(|(k, v)| *k == 32 && v == "1")
    }

    /// Motion/M-code line: accept into the planner if there's room (free
    /// its RX bytes, start its execution countdown, `ok` now), else park it
    /// in `pending_lines` where its bytes keep occupying the RX budget
    /// until a slot frees (`try_promote_pending`).
    fn dispatch_motion_line(&mut self, len: usize) {
        if self.planner.len() < self.config.planner_depth {
            self.rx_used = self.rx_used.saturating_sub(len);
            self.planner.push_back(PlannerEntry {
                remaining_ticks: self.config.line_ticks,
            });
            self.accept_ok();
            if self.state == MachineState::Idle {
                self.state = MachineState::Run;
            }
        } else {
            self.pending_lines.push_back(PendingLine { len });
        }
    }

    /// Called exactly once per line accepted into the planner — immediate
    /// accept in `dispatch_motion_line`, or promotion in
    /// `try_promote_pending` — normally to emit its `ok`. Applies the
    /// drop-ok / error-at-line fault scripts, keyed to this ordinal
    /// (`accepted_count`, 1-indexed): "the Nth accepted line."
    fn accept_ok(&mut self) {
        self.accepted_count += 1;
        let n = self.accepted_count;
        if self.wedged {
            return; // wedge: accepted into the planner, never acked
        }
        if let Some((target, code)) = self.faults.error_at_line {
            if target == n {
                self.push_line(&format!("error:{code}"));
                return;
            }
        }
        if self.faults.drop_ok_at_line == Some(n) {
            return; // ok deliberately withheld — the line still executes
        }
        self.push_line("ok");
    }

    fn soft_reset(&mut self) {
        self.boot_or_reset();
    }

    fn status_probe(&mut self) {
        // Muted during the $H homing window — the muted-`?` window real
        // GRBL exhibits, which serial_pump's 60-tick liveness probing
        // tolerates.
        if self.homing_remaining.is_some() {
            return;
        }
        // `A:` accessory field, per profile (see `SimProfile`). Stock follows
        // stock-source intent (A:S = spindle energised; absence = "not
        // reported"; omission semantics unverified on hardware). Captured127
        // reproduces the capture: A:S on every report, which on that
        // controller cannot be read as beam-on or beam-off. The
        // override-refresh cycle and `S` versus `C` are not modelled.
        // Both arms inline, one line each: mutation-battery anchors
        // (E5-M4/M5, E5-M9).
        #[rustfmt::skip]
        let accessory = match self.config.profile {
            SimProfile::Stock => if self.spindle_on { "|A:S" } else { "" },
            SimProfile::Captured127 => "|A:S",
        };
        let line = format!(
            "<{}|MPos:0.000,0.000,0.000|FS:0,0{}>",
            self.state.as_str(),
            accessory
        );
        self.push_line(&line);
    }

    fn feed_hold(&mut self) {
        if self.state != MachineState::Alarm {
            self.state = MachineState::Hold;
            // Model firmware automatic laser-off at hold-complete, gated on
            // laser mode ($32=1, the seeded default). This matches the
            // hardware behavior confirmed by probe 2026-09-14: FS:0,0
            // appears after Hold:0, BEFORE any 0x9E is sent. Under $32=0 the
            // spindle stays on through the hold.
            if self.laser_mode() {
                self.spindle_on = false;
            }
        }
    }

    fn resume(&mut self) {
        if self.state == MachineState::Hold {
            self.state = if self.planner.is_empty() && self.pending_lines.is_empty() {
                MachineState::Idle
            } else {
                MachineState::Run
            };
        }
    }

    /// Advance simulated time by one unit. Called from `SimPort::read` only
    /// when there is no response data already queued — a tick models one
    /// elapsed real port-timeout interval.
    fn tick(&mut self) {
        // Unsolicited alarm (e.g. a hard-limit trip): can fire regardless of
        // whatever else is going on, so it's checked first.
        if let Some(remaining) = self.faults.alarm_after_ticks.as_mut() {
            if *remaining > 0 {
                *remaining -= 1;
            }
            if *remaining == 0 {
                self.faults.alarm_after_ticks = None;
                self.state = MachineState::Alarm;
                self.push_line("ALARM:1");
                return;
            }
        }

        if let Some(remaining) = self.homing_remaining.as_mut() {
            if *remaining > 0 {
                *remaining -= 1;
            }
            if *remaining == 0 {
                self.homing_remaining = None;
                self.state = MachineState::Idle;
                self.push_line("ok");
            }
            return;
        }

        // Execution is suspended in Hold and Alarm — motion stops.
        if self.state == MachineState::Hold || self.state == MachineState::Alarm {
            return;
        }

        let mut drained = false;
        if let Some(front) = self.planner.front_mut() {
            if front.remaining_ticks > 0 {
                front.remaining_ticks -= 1;
            }
            if front.remaining_ticks == 0 {
                self.planner.pop_front();
                self.try_promote_pending();
                if self.planner.is_empty() && self.pending_lines.is_empty() {
                    drained = true;
                }
            }
        }
        if drained && self.state == MachineState::Run {
            self.state = MachineState::Idle;
        }
    }

    /// Promote as many pending lines as fit into newly-freed planner slots,
    /// freeing their RX bytes and emitting each one's `ok` as it is
    /// promoted.
    fn try_promote_pending(&mut self) {
        while self.planner.len() < self.config.planner_depth {
            let Some(pending) = self.pending_lines.pop_front() else {
                break;
            };
            self.rx_used = self.rx_used.saturating_sub(pending.len);
            self.planner.push_back(PlannerEntry {
                remaining_ticks: self.config.line_ticks,
            });
            self.accept_ok();
            if self.state == MachineState::Idle {
                self.state = MachineState::Run;
            }
        }
    }

    // -- Test/diagnostic accessors -----------------------------------------

    pub fn overflow_count(&self) -> usize {
        self.overflow_count
    }

    pub fn hold_invariant_violations(&self) -> &[String] {
        &self.hold_invariant_violations
    }

    pub fn rx_used(&self) -> usize {
        self.rx_used
    }

    pub fn planner_len(&self) -> usize {
        self.planner.len()
    }

    pub fn pending_len(&self) -> usize {
        self.pending_lines.len()
    }

    pub fn state(&self) -> MachineState {
        self.state
    }

    /// Whether the spindle/laser is currently energized. Set by M3/M4 lines,
    /// cleared by M5 lines, by the 0x9E spindle-stop-override realtime byte
    /// (Hold-only), and by soft reset.
    pub fn spindle_energized(&self) -> bool {
        self.spindle_on
    }
}

/// `SerialPort` implementation whose `Read`/`Write` drive a shared
/// `GrblBrain`. `try_clone()` hands out a new handle wired to the SAME
/// `Arc<Mutex<_>>` — the seam `CommandChannel` depends on: the command
/// writer, the persistent reader, and the realtime writer are three
/// independent `Box<dyn SerialPort>` clones that must all observe one
/// controller (serial.rs connect, three `try_clone()`s of one opened port).
pub struct SimPort {
    brain: Arc<Mutex<GrblBrain>>,
}

impl SimPort {
    pub fn new(config: SimConfig) -> Self {
        Self {
            brain: Arc::new(Mutex::new(GrblBrain::new(config))),
        }
    }

    pub fn overflow_count(&self) -> usize {
        self.brain.lock().unwrap().overflow_count()
    }

    pub fn hold_invariant_violations(&self) -> Vec<String> {
        self.brain
            .lock()
            .unwrap()
            .hold_invariant_violations()
            .to_vec()
    }

    pub fn rx_used(&self) -> usize {
        self.brain.lock().unwrap().rx_used()
    }

    pub fn planner_len(&self) -> usize {
        self.brain.lock().unwrap().planner_len()
    }

    pub fn pending_len(&self) -> usize {
        self.brain.lock().unwrap().pending_len()
    }

    pub fn machine_state(&self) -> MachineState {
        self.brain.lock().unwrap().state()
    }

    pub fn outbound_len(&self) -> usize {
        self.brain.lock().unwrap().outbound_len()
    }

    /// Whether the spindle/laser is currently energized (delegated to GrblBrain).
    pub fn spindle_energized(&self) -> bool {
        self.brain.lock().unwrap().spindle_energized()
    }

    /// Laser mode from the `$32` setting (delegated to GrblBrain).
    pub fn laser_mode(&self) -> bool {
        self.brain.lock().unwrap().laser_mode()
    }

    // -- Fault injection (Relay 1B) -----------------------------------------
    // Every setter locks the shared brain, so a fault armed via ANY
    // `try_clone()`'d handle is observed by all of them — the same handle
    // sharing the rest of the sim depends on.

    /// Suppress the `ok` for the Nth line accepted into the planner
    /// (1-indexed). The line still executes; only its ack is withheld.
    pub fn set_drop_ok_at_line(&self, n: u32) {
        self.brain.lock().unwrap().faults.drop_ok_at_line = Some(n);
    }

    /// Reply `error:{code}` instead of `ok` for the Nth accepted line.
    pub fn set_error_at_line(&self, n: u32, code: u32) {
        self.brain.lock().unwrap().faults.error_at_line = Some((n, code));
    }

    /// Raise an unsolicited `ALARM:1` after `ticks` more ticks elapse.
    pub fn set_alarm_after_ticks(&self, ticks: u32) {
        self.brain.lock().unwrap().faults.alarm_after_ticks = Some(ticks);
    }

    /// The link goes dead: reads never again produce data, regardless of
    /// what's already queued in `outbound`.
    pub fn set_silent(&self, silent: bool) {
        self.brain.lock().unwrap().faults.silent = silent;
    }

    /// The port vanished (read side): every read returns `Ok(0)`.
    pub fn set_eof(&self, eof: bool) {
        self.brain.lock().unwrap().faults.eof = eof;
    }

    /// The port vanished (write side): every write returns `Err`.
    pub fn set_write_fail(&self, fail: bool) {
        self.brain.lock().unwrap().faults.write_fail = fail;
    }

    /// Answer `error:3` to a `$n=V` write and do not apply it.
    pub fn set_reject_setting(&self, n: u32) {
        self.brain.lock().unwrap().faults.reject_setting = Some(n);
    }

    /// Answer `ok` to a `$n=V` write and do NOT apply it: the START ruling's
    /// named failure (DECISIONS 2026-09-10, "a controller that acknowledges
    /// a settings write is not a controller that accepted it"). Consumer:
    /// the Rust `$32=1` gate, which checks for `ok` only and never reads back.
    pub fn set_ignore_setting(&self, n: u32) {
        self.brain.lock().unwrap().faults.ignore_setting = Some(n);
    }

    /// Arm the one-shot laser-switch wedge (see `Faults`): after the next
    /// M3/M4 line, lines are accepted but never acked until `0x18`.
    pub fn set_wedge_after_spindle_cmd(&self) {
        self.brain.lock().unwrap().faults.wedge_after_spindle_cmd = true;
    }

    /// Every realtime byte this brain has received, in arrival order — the
    /// fault-injection-era analogue of `MockPort`'s shared `written` log,
    /// scoped to just the realtime bypass path.
    pub fn realtime_bytes_received(&self) -> Vec<u8> {
        self.brain.lock().unwrap().realtime_log.clone()
    }
}

impl Read for SimPort {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut brain = self.brain.lock().unwrap();
        // Fault injection (Relay 1B): `eof`/`silent` model the link dying,
        // checked before anything else — genuinely dead, nothing queued in
        // `outbound` is ever delivered once either engages.
        if brain.faults.eof {
            return Ok(0);
        }
        if brain.faults.silent {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "sim: silent fault"));
        }
        if brain.outbound_len() == 0 {
            brain.tick();
        }
        if brain.outbound_len() == 0 {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "sim: no data"));
        }
        let n = buf.len().min(brain.outbound_len());
        for slot in buf.iter_mut().take(n) {
            *slot = brain.pop_outbound().expect("checked non-empty above");
        }
        Ok(n)
    }
}

impl Write for SimPort {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut brain = self.brain.lock().unwrap();
        // Fault injection (Relay 1B): the port vanished — writes fail
        // outright, modeling `PumpFailure::Io` at the write site.
        if brain.faults.write_fail {
            return Err(io::Error::other("sim: write_fail fault"));
        }
        brain.handle_bytes(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl SerialPort for SimPort {
    fn name(&self) -> Option<String> {
        Some("sim".to_string())
    }
    fn baud_rate(&self) -> serialport::Result<u32> {
        Ok(115200)
    }
    fn data_bits(&self) -> serialport::Result<serialport::DataBits> {
        Ok(serialport::DataBits::Eight)
    }
    fn flow_control(&self) -> serialport::Result<serialport::FlowControl> {
        Ok(serialport::FlowControl::None)
    }
    fn parity(&self) -> serialport::Result<serialport::Parity> {
        Ok(serialport::Parity::None)
    }
    fn stop_bits(&self) -> serialport::Result<serialport::StopBits> {
        Ok(serialport::StopBits::One)
    }
    fn timeout(&self) -> Duration {
        Duration::from_millis(1000)
    }
    fn set_baud_rate(&mut self, _: u32) -> serialport::Result<()> {
        Ok(())
    }
    fn set_data_bits(&mut self, _: serialport::DataBits) -> serialport::Result<()> {
        Ok(())
    }
    fn set_flow_control(&mut self, _: serialport::FlowControl) -> serialport::Result<()> {
        Ok(())
    }
    fn set_parity(&mut self, _: serialport::Parity) -> serialport::Result<()> {
        Ok(())
    }
    fn set_stop_bits(&mut self, _: serialport::StopBits) -> serialport::Result<()> {
        Ok(())
    }
    fn set_timeout(&mut self, _: Duration) -> serialport::Result<()> {
        Ok(())
    }
    fn write_request_to_send(&mut self, _: bool) -> serialport::Result<()> {
        Ok(())
    }
    fn write_data_terminal_ready(&mut self, _: bool) -> serialport::Result<()> {
        Ok(())
    }
    fn read_clear_to_send(&mut self) -> serialport::Result<bool> {
        Ok(false)
    }
    fn read_data_set_ready(&mut self) -> serialport::Result<bool> {
        Ok(false)
    }
    fn read_ring_indicator(&mut self) -> serialport::Result<bool> {
        Ok(false)
    }
    fn read_carrier_detect(&mut self) -> serialport::Result<bool> {
        Ok(false)
    }
    fn bytes_to_read(&self) -> serialport::Result<u32> {
        Ok(self.brain.lock().unwrap().outbound_len() as u32)
    }
    fn bytes_to_write(&self) -> serialport::Result<u32> {
        Ok(0)
    }
    fn clear(&self, _: serialport::ClearBuffer) -> serialport::Result<()> {
        Ok(())
    }
    fn try_clone(&self) -> serialport::Result<Box<dyn SerialPort>> {
        Ok(Box::new(SimPort {
            brain: self.brain.clone(),
        }))
    }
    fn set_break(&self) -> serialport::Result<()> {
        Ok(())
    }
    fn clear_break(&self) -> serialport::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    /// Reads until a `\n`-terminated line has accumulated, retrying on
    /// `TimedOut` (each retry is one tick) up to `max_ticks` calls. Mirrors
    /// the retry-on-timeout pattern `drain_startup_banner`/`run_pump` use
    /// against a real port.
    fn read_line_blocking(port: &mut SimPort, max_ticks: u32) -> Option<String> {
        read_line_from_dyn(port, max_ticks)
    }

    fn read_line_from_dyn(port: &mut dyn SerialPort, max_ticks: u32) -> Option<String> {
        let mut acc = Vec::new();
        let mut buf = [0u8; 128];
        for _ in 0..max_ticks {
            match port.read(&mut buf) {
                Ok(n) => {
                    acc.extend_from_slice(&buf[..n]);
                    if acc.contains(&b'\n') {
                        return Some(String::from_utf8_lossy(&acc).trim().to_string());
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::TimedOut => continue,
                Err(e) => panic!("unexpected read error: {e}"),
            }
        }
        None
    }

    fn send_line(port: &mut SimPort, cmd: &str) {
        let mut line = cmd.to_string();
        line.push('\n');
        port.write_all(line.as_bytes()).unwrap();
    }

    #[test]
    fn banner_emitted_on_connect_and_on_soft_reset() {
        let mut port = SimPort::new(SimConfig::default());
        let banner = read_line_blocking(&mut port, 5).expect("banner on connect");
        assert!(banner.contains("Grbl"), "got: {banner}");

        // A normal line gets accepted+ok'd first, to prove the subsequent
        // reset ABORTS in-flight work rather than acking it (PumpTerminal
        // ::Banner semantics on the real pump).
        send_line(&mut port, "G0 X1");
        let ok = read_line_blocking(&mut port, 5).expect("ok for accepted line");
        assert_eq!(ok, "ok");

        port.write_all(&[0x18]).unwrap();
        let reset_banner = read_line_blocking(&mut port, 5).expect("banner on 0x18");
        assert!(reset_banner.contains("Grbl"), "got: {reset_banner}");
    }

    #[test]
    fn line_gets_ok_on_planner_accept_not_on_execution_completion() {
        let config = SimConfig {
            planner_depth: 15,
            line_ticks: 50,
            ..SimConfig::default()
        };
        let mut port = SimPort::new(config);
        let _ = read_line_blocking(&mut port, 5); // discard banner

        send_line(&mut port, "G1 X10 F500");
        // If `ok` waited on execution (50 ticks), this bounded read would
        // time out and return None.
        let ok = read_line_blocking(&mut port, 3).expect("ok must arrive on planner-accept");
        assert_eq!(ok, "ok");
        assert_eq!(port.planner_len(), 1, "line is executing, not yet complete");
    }

    #[test]
    fn rx_buffer_fills_when_planner_full_and_drains_as_it_executes() {
        let config = SimConfig {
            planner_depth: 1,
            line_ticks: 2,
            ..SimConfig::default()
        };
        let mut port = SimPort::new(config);
        let _ = read_line_blocking(&mut port, 5); // banner

        send_line(&mut port, "G1 X1"); // fills the only planner slot
        let ok1 = read_line_blocking(&mut port, 3).unwrap();
        assert_eq!(ok1, "ok");
        assert_eq!(port.planner_len(), 1);

        let second = "G1 X2\n";
        port.write_all(second.as_bytes()).unwrap();
        // Planner is full: no `ok` yet, and the line's bytes occupy the RX
        // buffer — this IS the backpressure the two-stage model exists to
        // produce.
        assert_eq!(port.pending_len(), 1, "second line waits for planner room");
        assert_eq!(
            port.rx_used(),
            second.len(),
            "its bytes occupy the RX buffer"
        );

        // Advance ticks until the first entry finishes executing and the
        // second line is promoted.
        let ok2 = read_line_blocking(&mut port, 10).expect("ok for the promoted line");
        assert_eq!(ok2, "ok");
        assert_eq!(port.pending_len(), 0);
        assert_eq!(
            port.rx_used(),
            0,
            "RX buffer drains once the line is promoted"
        );
    }

    #[test]
    fn rx_overflow_is_flagged_when_budget_exceeded() {
        let config = SimConfig {
            rx_budget: 8,
            planner_depth: 1,
            line_ticks: 1000, // never frees during this test — no read() is
            // called after the first `ok`, so no ticks occur regardless.
            ..SimConfig::default()
        };
        let mut port = SimPort::new(config);
        let _ = read_line_blocking(&mut port, 5); // banner

        send_line(&mut port, "G1"); // fills the only planner slot
        let _ = read_line_blocking(&mut port, 3).unwrap();

        // The planner now stays full. Every further line queues in
        // `pending_lines`, consuming the tiny 8-byte budget.
        port.write_all(b"G1X1Y1\n").unwrap(); // 7 bytes — fits the budget
        assert_eq!(port.overflow_count(), 0);
        port.write_all(b"G1X2Y2\n").unwrap(); // pushes well past the budget
        assert!(
            port.overflow_count() > 0,
            "must overflow the tiny RX budget"
        );
    }

    #[test]
    fn status_probe_returns_well_formed_report() {
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5); // banner

        port.write_all(b"?").unwrap();
        let status = read_line_blocking(&mut port, 5).expect("status report");
        assert!(
            status.starts_with('<') && status.ends_with('>'),
            "got: {status}"
        );
        assert!(
            status.contains("Idle"),
            "expected Idle state, got: {status}"
        );
        assert!(status.contains("MPos:"), "got: {status}");
    }

    #[test]
    fn feed_hold_then_resume_transitions() {
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5);

        port.write_all(b"!").unwrap();
        assert_eq!(port.machine_state(), MachineState::Hold);

        port.write_all(b"~").unwrap();
        assert_eq!(port.machine_state(), MachineState::Idle);
    }

    #[test]
    fn dollar_x_clears_alarm() {
        let config = SimConfig {
            initial_state: MachineState::Alarm,
            ..SimConfig::default()
        };
        let mut port = SimPort::new(config);
        let _ = read_line_blocking(&mut port, 5); // banner fires even booting into Alarm
        assert_eq!(port.machine_state(), MachineState::Alarm);

        send_line(&mut port, "$X");
        let ok = read_line_blocking(&mut port, 5).expect("$X acks");
        assert_eq!(ok, "ok");
        assert_eq!(port.machine_state(), MachineState::Idle);
    }

    #[test]
    fn homing_mutes_status_probe_then_completes_with_deferred_ok() {
        let config = SimConfig {
            homing_ticks: 3,
            ..SimConfig::default()
        };
        let mut port = SimPort::new(config);
        let _ = read_line_blocking(&mut port, 5); // banner

        send_line(&mut port, "$H");
        assert_eq!(port.machine_state(), MachineState::Home);

        // `?` during the muted window must produce nothing.
        port.write_all(b"?").unwrap();
        assert_eq!(
            port.outbound_len(),
            0,
            "status probe must be muted during homing"
        );

        let ok = read_line_blocking(&mut port, 10).expect("deferred ok after homing completes");
        assert_eq!(ok, "ok");
        assert_eq!(port.machine_state(), MachineState::Idle);
    }

    #[test]
    fn strict_hold_invariant_fires_on_line_write_between_hold_and_reset() {
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5);

        port.write_all(b"!").unwrap(); // feed hold
        assert_eq!(port.machine_state(), MachineState::Hold);

        // The exact bug this pins: a line-based M5 sent while in Hold,
        // instead of the realtime `0x18` volley.
        send_line(&mut port, "M5");
        assert_eq!(
            port.hold_invariant_violations(),
            vec!["M5".to_string()],
            "an ack-awaited line between ! and 0x18 must be flagged"
        );

        port.write_all(&[0x18]).unwrap(); // the correct volley's actual next step
        let banner = read_line_blocking(&mut port, 5)
            .expect("the sim must continue cleanly after a flagged violation");
        assert!(banner.contains("Grbl"));
    }

    // Regression: the invariant is scoped to the actual F13 spindle-sync
    // hazard (M3/M4/M5), not any ack-awaited line. A benign motion line
    // completing in Hold is harmless on real hardware and must NOT be
    // recorded — this locks the narrowed semantic and fails against the
    // old broad "any line in Hold" implementation.
    #[test]
    fn strict_hold_invariant_does_not_fire_on_plain_motion_line_in_hold() {
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5);

        port.write_all(b"!").unwrap(); // feed hold
        assert_eq!(port.machine_state(), MachineState::Hold);

        send_line(&mut port, "G1 X10");
        assert!(
            port.hold_invariant_violations().is_empty(),
            "a benign motion line completing in Hold must not be flagged"
        );
    }

    #[test]
    fn strict_hold_invariant_does_not_fire_on_realtime_bytes_between_hold_and_reset() {
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5);

        port.write_all(b"!").unwrap();
        assert_eq!(port.machine_state(), MachineState::Hold);

        // The correct F13 abort volley: only realtime bytes between ! and 0x18.
        port.write_all(b"?").unwrap();
        port.write_all(&[0x9E]).unwrap();
        port.write_all(&[0x18]).unwrap();

        assert!(
            port.hold_invariant_violations().is_empty(),
            "realtime bytes must never trip the invariant"
        );
    }

    // -- Spindle tracking and 0x9E spindle-stop-override (Phase 2A) --

    #[test]
    fn spindle_on_set_by_m3_cleared_by_m5() {
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5); // banner
        assert!(!port.spindle_energized(), "spindle off at startup");

        send_line(&mut port, "M3 S1000");
        let _ = read_line_blocking(&mut port, 5); // ok
        assert!(port.spindle_energized(), "M3 sets spindle on");

        send_line(&mut port, "M5");
        let _ = read_line_blocking(&mut port, 5); // ok
        assert!(!port.spindle_energized(), "M5 clears spindle");
    }

    #[test]
    fn spindle_on_set_by_m4_cleared_by_soft_reset() {
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5); // banner

        send_line(&mut port, "M4 S500");
        let _ = read_line_blocking(&mut port, 5); // ok
        assert!(port.spindle_energized(), "M4 sets spindle on");

        port.write_all(&[0x18]).unwrap();
        let _ = read_line_blocking(&mut port, 5); // banner
        assert!(!port.spindle_energized(), "soft reset clears spindle");
    }

    #[test]
    fn feed_hold_auto_stops_spindle_and_0x9e_toggles_it_back() {
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5); // banner

        send_line(&mut port, "M3 S1000");
        let _ = read_line_blocking(&mut port, 5); // ok
        assert!(port.spindle_energized());

        port.write_all(b"!").unwrap(); // feed hold
        assert_eq!(port.machine_state(), MachineState::Hold);
        // $32=1: firmware auto-stops spindle at hold-complete
        assert!(!port.spindle_energized(), "hold auto-stops spindle ($32=1)");

        // 0x9E is a TOGGLE — after auto-off, it RE-ARMS the beam (the bug)
        port.write_all(&[0x9E]).unwrap();
        assert!(port.spindle_energized(), "0x9E toggles spindle back ON");

        // Second 0x9E turns it off again
        port.write_all(&[0x9E]).unwrap();
        assert!(!port.spindle_energized(), "second 0x9E toggles it off");
    }

    #[test]
    fn spindle_stop_override_0x9e_ignored_outside_hold() {
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5); // banner

        send_line(&mut port, "M3 S1000");
        let _ = read_line_blocking(&mut port, 5); // ok
        assert!(port.spindle_energized());

        // 0x9E while Idle: no effect
        port.write_all(&[0x9E]).unwrap();
        assert!(port.spindle_energized(), "0x9E outside Hold is a no-op");
    }

    #[test]
    fn feed_hold_alone_clears_spindle_resume_keeps_it_off() {
        // Correct pause: [!] alone — no 0x9E. Feed hold auto-stops spindle
        // ($32=1). Resume with [~] should NOT re-energize the spindle.
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5); // banner

        send_line(&mut port, "M3 S1000");
        let _ = read_line_blocking(&mut port, 5); // ok
        assert!(port.spindle_energized());

        // Feed hold — spindle auto-off
        port.write_all(b"!").unwrap();
        assert!(!port.spindle_energized(), "hold auto-stops spindle");
        assert_eq!(port.machine_state(), MachineState::Hold);

        // Resume
        port.write_all(b"~").unwrap();
        // spindle_on stays false -- resume doesn't re-enable the spindle
        assert!(
            !port.spindle_energized(),
            "resume does not re-energize spindle"
        );
    }

    // P5 Finding 7: semicolon comments must be stripped before M-code scanning.
    // Kerf's own G-code comments like `; Cut: M5 bracket` would false-trigger
    // the hold-invariant if `;` comments aren't stripped.
    #[test]
    fn semicolon_comment_with_m5_does_not_trip_hold_invariant() {
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5); // banner

        port.write_all(b"!").unwrap(); // feed hold
        assert_eq!(port.machine_state(), MachineState::Hold);

        // A line with M5 only in a semicolon comment — must NOT trip the invariant.
        send_line(&mut port, "G1 X10 ; Cut: M5 bracket");
        assert!(
            port.hold_invariant_violations().is_empty(),
            "M5 in a semicolon comment must not trip the hold invariant; got: {:?}",
            port.hold_invariant_violations()
        );
    }

    #[test]
    fn semicolon_comment_with_m3_does_not_trip_hold_invariant() {
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5); // banner

        port.write_all(b"!").unwrap(); // feed hold

        // M3 in a comment: must not trip.
        send_line(&mut port, "G0 X0 ; M3 S1000 not real");
        assert!(
            port.hold_invariant_violations().is_empty(),
            "M3 in a semicolon comment must not trip the hold invariant"
        );
    }

    // P5 Finding 7: real M5 before semicolon comment must still trip.
    #[test]
    fn real_m5_before_semicolon_comment_trips_invariant() {
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5); // banner

        port.write_all(b"!").unwrap(); // feed hold

        send_line(&mut port, "M5 ; laser off");
        assert_eq!(
            port.hold_invariant_violations().len(),
            1,
            "Real M5 before semicolon comment must trip the invariant"
        );
    }

    #[test]
    fn shared_brain_write_on_one_clone_observed_by_read_on_another() {
        let mut a: Box<dyn SerialPort> = Box::new(SimPort::new(SimConfig::default()));
        let _ = read_line_from_dyn(&mut *a, 5); // drain the startup banner

        let mut b = a.try_clone().expect("try_clone must succeed");

        // A writes a command; B — a SEPARATE try_clone()'d handle — must
        // observe its `ok`, exactly as CommandChannel's writer/reader/
        // realtime clones must all drive/observe one physical controller.
        a.write_all(b"G0 X1\n").unwrap();
        let ok = read_line_from_dyn(&mut *b, 5).expect("clone B must observe A's write");
        assert_eq!(ok, "ok");

        // And the reverse direction: B writes, A observes.
        b.write_all(b"?").unwrap();
        let status = read_line_from_dyn(&mut *a, 5).expect("clone A must observe B's write");
        assert!(status.starts_with('<'), "got: {status}");
    }

    // -- E5: settings table, reject/ignore faults, profiles, A:, wedge -------

    /// Reads every line the sim answers with until a line that is `ok` or
    /// starts with `error:` (inclusive), retrying on timeout up to
    /// `max_ticks` reads. Returns the lines in order.
    fn read_reply(port: &mut SimPort, max_ticks: u32) -> Vec<String> {
        let mut acc = Vec::new();
        let mut buf = [0u8; 256];
        for _ in 0..max_ticks {
            match port.read(&mut buf) {
                Ok(n) => {
                    acc.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&acc).to_string();
                    let lines: Vec<String> = text
                        .split('\n')
                        .map(|l| l.trim().to_string())
                        .filter(|l| !l.is_empty())
                        .collect();
                    if text.ends_with('\n')
                        && lines
                            .last()
                            .is_some_and(|l| l == "ok" || l.starts_with("error:"))
                    {
                        return lines;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::TimedOut => continue,
                Err(e) => panic!("unexpected read error: {e}"),
            }
        }
        panic!(
            "no ok/error reply within {max_ticks} reads; got {:?}",
            String::from_utf8_lossy(&acc)
        );
    }

    fn dump_settings(port: &mut SimPort) -> Vec<String> {
        send_line(port, "$$");
        read_reply(port, 5)
    }

    fn fresh(config: SimConfig) -> SimPort {
        let mut port = SimPort::new(config);
        let _ = read_line_blocking(&mut port, 5); // banner
        port
    }

    // E5-M1: a `$32=0` write is applied, and `$$` reports the table.
    #[test]
    fn setting_write_32_0_is_applied_and_reported_by_dump() {
        let mut port = fresh(SimConfig::default());
        send_line(&mut port, "$32=0");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        let dump = dump_settings(&mut port);
        assert!(dump.contains(&"$32=0".to_string()), "got: {dump:?}");
        assert!(!dump.contains(&"$32=1".to_string()), "got: {dump:?}");
        assert!(!port.laser_mode());
    }

    // E5-C1 (control): the default table says `$32=1`, in seed order.
    #[test]
    fn default_dump_is_the_seeded_table_with_laser_mode_on() {
        let mut port = fresh(SimConfig::default());
        let dump = dump_settings(&mut port);
        assert_eq!(dump, vec!["$0=10", "$1=25", "$30=1000", "$32=1", "ok"]);
        assert!(port.laser_mode());
    }

    // E5-M2: under `$32=0` the hold does not auto-stop the spindle; under
    // the default `$32=1` it does.
    #[test]
    fn hold_auto_off_is_gated_on_laser_mode() {
        let mut port = fresh(SimConfig::default());
        send_line(&mut port, "$32=0");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        send_line(&mut port, "M4 S500");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        send_line(&mut port, "G1 X10 F500");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        port.write_all(b"!").unwrap();
        assert_eq!(port.machine_state(), MachineState::Hold);
        assert!(
            port.spindle_energized(),
            "$32=0: the spindle stays on through the hold"
        );

        let mut laser = fresh(SimConfig::default());
        send_line(&mut laser, "M4 S500");
        assert_eq!(read_reply(&mut laser, 5), vec!["ok"]);
        send_line(&mut laser, "G1 X10 F500");
        assert_eq!(read_reply(&mut laser, 5), vec!["ok"]);
        laser.write_all(b"!").unwrap();
        assert!(!laser.spindle_energized(), "$32=1: hold auto-stops");
    }

    // E5-M3: a rejected write answers `error:3` and is not applied.
    #[test]
    fn rejected_setting_write_answers_error_3_and_is_not_applied() {
        let mut port = fresh(SimConfig::default());
        port.set_reject_setting(30);
        send_line(&mut port, "$30=500");
        assert_eq!(read_reply(&mut port, 5), vec!["error:3"]);
        let dump = dump_settings(&mut port);
        assert!(dump.contains(&"$30=1000".to_string()), "got: {dump:?}");
        assert!(!dump.contains(&"$30=500".to_string()), "got: {dump:?}");
    }

    // E5-C2 (control): the reject fault names one setting only.
    #[test]
    fn reject_fault_leaves_other_settings_writable() {
        let mut port = fresh(SimConfig::default());
        port.set_reject_setting(30);
        send_line(&mut port, "$32=0");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        assert!(!port.laser_mode(), "$32=0 applied under a $30 reject");
    }

    // E5-M11: the START ruling's named failure — acked, not applied.
    #[test]
    fn ignored_setting_write_is_acked_and_not_applied() {
        let mut port = fresh(SimConfig::default());
        port.set_ignore_setting(32);
        send_line(&mut port, "$32=0");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        let dump = dump_settings(&mut port);
        assert!(dump.contains(&"$32=1".to_string()), "got: {dump:?}");
        assert!(!dump.contains(&"$32=0".to_string()), "got: {dump:?}");
        assert!(port.laser_mode(), "ignored write leaves laser mode on");

        // Other settings are unaffected by the fault.
        send_line(&mut port, "$30=500");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        let dump = dump_settings(&mut port);
        assert!(dump.contains(&"$30=500".to_string()), "got: {dump:?}");
    }

    // E5-M12: `$32` follows stock semantics — integer part, normalised.
    #[test]
    fn laser_flag_is_normalised_on_write() {
        let mut port = fresh(SimConfig::default());
        send_line(&mut port, "$32=0");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        send_line(&mut port, "$32=2");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        let dump = dump_settings(&mut port);
        assert!(dump.contains(&"$32=1".to_string()), "got: {dump:?}");
        assert!(!dump.contains(&"$32=2".to_string()), "got: {dump:?}");
        assert!(port.laser_mode());

        send_line(&mut port, "$32=0.5");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        let dump = dump_settings(&mut port);
        assert!(dump.contains(&"$32=0".to_string()), "got: {dump:?}");
        assert!(!dump.contains(&"$32=0.5".to_string()), "got: {dump:?}");
        assert!(!port.laser_mode());
    }

    // E5-M4/M5: Stock reports `A:S` only while the spindle is on.
    #[test]
    fn stock_status_reports_a_s_only_while_spindle_on() {
        let mut port = fresh(SimConfig::default());
        port.write_all(b"?").unwrap();
        let off = read_line_blocking(&mut port, 5).unwrap();
        assert!(off.starts_with("<Idle|"), "got: {off}");
        assert!(!off.contains("A:"), "spindle off: no A: field, got {off}");

        send_line(&mut port, "M4 S500");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        port.write_all(b"?").unwrap();
        let on = read_line_blocking(&mut port, 5).unwrap();
        assert!(on.ends_with("|A:S>"), "spindle on: A:S, got {on}");
    }

    // E5-M9: Captured127 reports `A:S` even after an acknowledged M5.
    #[test]
    fn captured_profile_reports_a_s_after_acknowledged_m5() {
        let mut port = fresh(SimConfig::for_profile(SimProfile::Captured127));
        send_line(&mut port, "M4 S500");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        send_line(&mut port, "M5");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        assert!(!port.spindle_energized());
        port.write_all(b"?").unwrap();
        let status = read_line_blocking(&mut port, 5).unwrap();
        assert!(status.ends_with("|A:S>"), "got: {status}");
    }

    // E5-M8: profile sizes. 100 x 13-byte lines, no reads (so no ticks).
    #[test]
    fn profiles_set_planner_and_rx_sizes() {
        let captured = SimPort::new(SimConfig::for_profile(SimProfile::Captured127));
        let mut w = captured.try_clone().unwrap();
        for _ in 0..100 {
            w.write_all(b"G1 X0.1 F500\n").unwrap();
        }
        assert_eq!(captured.planner_len(), 100);
        assert_eq!(captured.pending_len(), 0);
        assert_eq!(captured.overflow_count(), 0);

        // The Stock branch overflows the 128-byte budget by design (85
        // parked lines x 13 bytes) and asserts only planner and pending
        // counts; do not "fix" it by adding an overflow assertion or
        // shrinking the write.
        let stock = SimPort::new(SimConfig::for_profile(SimProfile::Stock));
        let mut w = stock.try_clone().unwrap();
        for _ in 0..100 {
            w.write_all(b"G1 X0.1 F500\n").unwrap();
        }
        assert_eq!(stock.planner_len(), 15);
        assert_eq!(stock.pending_len(), 85);
    }

    // E5-M10: the wedge arms on M3/M4 only, never on M5.
    #[test]
    fn wedge_arms_on_spindle_on_not_on_m5() {
        let mut port = fresh(SimConfig::default());
        port.set_wedge_after_spindle_cmd();
        send_line(&mut port, "M5");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
        send_line(&mut port, "G1 X1");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);

        send_line(&mut port, "M4 S500");
        // The arming line itself is never acked; `?` still answers.
        assert_eq!(read_line_blocking(&mut port, 10), None, "M4 must not ack");
        port.write_all(b"?").unwrap();
        let status = read_line_blocking(&mut port, 5).unwrap();
        assert!(status.starts_with('<'), "got: {status}");
        send_line(&mut port, "G1 X2");
        assert_eq!(read_line_blocking(&mut port, 10), None, "wedged: no ok");

        // 0x18 clears it.
        port.write_all(&[0x18]).unwrap();
        let banner = read_line_blocking(&mut port, 5).unwrap();
        assert!(banner.contains("Grbl"), "got: {banner}");
        send_line(&mut port, "G1 X3");
        assert_eq!(read_reply(&mut port, 5), vec!["ok"]);
    }
}
