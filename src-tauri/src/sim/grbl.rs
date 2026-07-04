//! Virtual GRBL 1.1 controller — `SimPort` plugs into the exact
//! `Box<dyn SerialPort>` seam `CommandChannel` uses for a real port
//! (serial.rs:72-76), so the streaming stack becomes testable without
//! hardware. Modeled after the existing test `MockPort` (serial.rs:468-574):
//! a `SerialPort` impl backed by shared state behind `Arc<Mutex<_>>`, with
//! `try_clone()` handing out new handles wired to the SAME state.
//!
//! ## Two-stage buffer model (the whole point)
//!
//! Incoming bytes -> a 128-byte RX budget (`GrblBrain::rx_used`, config
//! `rx_budget`) -> line parser -> planner queue (config `planner_depth`,
//! default 15) -> executor (each accepted entry counts down `line_ticks`
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
//! - `ok` / `error:N` — not modeled beyond acceptance semantics above; no
//!   line in this sim is ever rejected with `error:N` (out of scope: the
//!   generator only ever emits well-formed G0/G1, see program non-goals).
//! - `ALARM:n` is reachable only via `initial_state`/reset (config surface),
//!   cleared by `$X`.
//! - `?` (single realtime byte) -> `<State|MPos:x,y,z|FS:f,s>`. Muted while
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
//! ## Explicitly out of scope
//!
//! Acceleration/junction planning, G2/G3 arcs, laser-power simulation, real
//! `$$` settings semantics (a canned dump is enough), fault injection
//! (Relay 1B), and any frontend/TS wiring.

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

/// True if `text` contains a stand-alone M3, M4, or M5 command word — the
/// spindle/laser control codes real GRBL sync-blocks while in Feed Hold
/// (the F13 hazard the strict-hold invariant pins). Case-insensitive and
/// tolerant of leading zeros (`M05`, `M3 S0`, `M3S1000` all count), but
/// requires the digits immediately after `M`/`m` to reduce to exactly 3, 4,
/// or 5 — `M30` (program end) and `M8` (coolant) never match, nor does any
/// non-`M` word (a coordinate like `X5`). Content inside `(...)` comments is
/// skipped, so a remark that merely mentions "M5" never trips it.
fn contains_spindle_sync_mcode(text: &str) -> bool {
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

    /// Bytes queued for the host to read: banner/ok/error/alarm/status/msg.
    outbound: VecDeque<u8>,

    overflow_count: usize,
    hold_invariant_violations: Vec<String>,
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
            outbound: VecDeque::new(),
            overflow_count: 0,
            hold_invariant_violations: Vec::new(),
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
                0x18 => self.soft_reset(),
                b'?' => self.status_probe(),
                b'!' => self.feed_hold(),
                b'~' => self.resume(),
                0x9E => {
                    // Reserved: GRBL 1.1's realtime Toggle Spindle-Stop
                    // override, needed by Phase 2A's pause re-plumb. Like
                    // every realtime byte it bypasses the RX line buffer;
                    // it has no simulated effect until 2A gives it one.
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
                // Canned settings dump. Real `$$` semantics are explicitly
                // out of scope for this program (see program non-goals).
                for line in ["$0=10", "$1=25", "$32=1"] {
                    self.push_line(line);
                }
                self.push_line("ok");
            }
            _ => {
                // Setting writes ($N=V) and anything else unrecognized:
                // accept harmlessly. Real `$$` semantics out of scope.
                self.push_line("ok");
            }
        }
    }

    /// Motion/M-code line: accept into the planner if there's room (free
    /// its RX bytes, start its execution countdown, `ok` now), else park it
    /// in `pending_lines` where its bytes keep occupying the RX budget
    /// until a slot frees (`try_promote_pending`).
    fn dispatch_motion_line(&mut self, len: usize) {
        if self.planner.len() < self.config.planner_depth {
            self.rx_used = self.rx_used.saturating_sub(len);
            self.planner.push_back(PlannerEntry { remaining_ticks: self.config.line_ticks });
            self.push_line("ok");
            if self.state == MachineState::Idle {
                self.state = MachineState::Run;
            }
        } else {
            self.pending_lines.push_back(PendingLine { len });
        }
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
        let line = format!("<{}|MPos:0.000,0.000,0.000|FS:0,0>", self.state.as_str());
        self.push_line(&line);
    }

    fn feed_hold(&mut self) {
        if self.state != MachineState::Alarm {
            self.state = MachineState::Hold;
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
            let Some(pending) = self.pending_lines.pop_front() else { break };
            self.rx_used = self.rx_used.saturating_sub(pending.len);
            self.planner.push_back(PlannerEntry { remaining_ticks: self.config.line_ticks });
            self.push_line("ok");
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
        Self { brain: Arc::new(Mutex::new(GrblBrain::new(config))) }
    }

    pub fn overflow_count(&self) -> usize {
        self.brain.lock().unwrap().overflow_count()
    }

    pub fn hold_invariant_violations(&self) -> Vec<String> {
        self.brain.lock().unwrap().hold_invariant_violations().to_vec()
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
}

impl Read for SimPort {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut brain = self.brain.lock().unwrap();
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
        self.brain.lock().unwrap().handle_bytes(buf);
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
        Ok(Box::new(SimPort { brain: self.brain.clone() }))
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
        let config = SimConfig { planner_depth: 15, line_ticks: 50, ..SimConfig::default() };
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
        let config = SimConfig { planner_depth: 1, line_ticks: 2, ..SimConfig::default() };
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
        assert_eq!(port.rx_used(), second.len(), "its bytes occupy the RX buffer");

        // Advance ticks until the first entry finishes executing and the
        // second line is promoted.
        let ok2 = read_line_blocking(&mut port, 10).expect("ok for the promoted line");
        assert_eq!(ok2, "ok");
        assert_eq!(port.pending_len(), 0);
        assert_eq!(port.rx_used(), 0, "RX buffer drains once the line is promoted");
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
        assert!(port.overflow_count() > 0, "must overflow the tiny RX budget");
    }

    #[test]
    fn status_probe_returns_well_formed_report() {
        let mut port = SimPort::new(SimConfig::default());
        let _ = read_line_blocking(&mut port, 5); // banner

        port.write_all(b"?").unwrap();
        let status = read_line_blocking(&mut port, 5).expect("status report");
        assert!(status.starts_with('<') && status.ends_with('>'), "got: {status}");
        assert!(status.contains("Idle"), "expected Idle state, got: {status}");
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
        let config = SimConfig { initial_state: MachineState::Alarm, ..SimConfig::default() };
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
        let config = SimConfig { homing_ticks: 3, ..SimConfig::default() };
        let mut port = SimPort::new(config);
        let _ = read_line_blocking(&mut port, 5); // banner

        send_line(&mut port, "$H");
        assert_eq!(port.machine_state(), MachineState::Home);

        // `?` during the muted window must produce nothing.
        port.write_all(b"?").unwrap();
        assert_eq!(port.outbound_len(), 0, "status probe must be muted during homing");

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
}
