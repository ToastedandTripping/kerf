//! GRBL line-protocol pump — the pure, injectable core of the F13 streaming fix.
//!
//! Design (Fortification W1a):
//! - `run_pump` waits for a TERMINAL line (`ok`, `error:N`, `ALARM…`, `Grbl ` reset
//!   banner) instead of treating a 1s read timeout as success. On each timeout tick
//!   it writes a real-time `?` probe; a healthy GRBL answers within milliseconds even
//!   while executing motion, so the only honest disconnect signals are (a) a failed
//!   write or (b) `LIVENESS_TICKS` consecutive zero-byte ticks (covers GRBL builds
//!   that mute `?` during `$H` — ~60 ticks ≈ 60s at the 1s port timeout).
//! - Bytes accumulate via `read_until` into a PERSISTENT `Vec<u8>` that survives
//!   timeout ticks: std's `read_line` truncates its String on `Err`, which would
//!   silently drop partial-line bytes whenever a timeout splits a response.
//! - `drain_classified` is the pre-write drain rule: any `0x18` issued with no pump
//!   in flight (e-stop between lines, manual soft reset, disconnect) leaves an unread
//!   banner that would terminal-abort the NEXT command. Before writing a command
//!   line, everything already buffered is drained and CLASSIFIED — never
//!   blind-discarded: `ALARM:n` and `[MSG:…]` are surfaced to the caller (the
//!   frontend console must see an unsolicited hard-limit alarm); banners, status
//!   reports and stale acks are dropped (debug-logged by the caller).
//! - `read_status_bounded` reads until a `<…>` status report, BOUNDED at
//!   `STATUS_MAX_TICKS` timeout ticks (a `?` swallowed during GRBL's post-reset
//!   reboot window must not hang the caller); on expiry it returns `status: None`,
//!   which the command layer maps to the Ok-typed busy/none sentinel.
//!
//! Everything here is pure over `BufRead` + `ProbeWriter` so the pump state machine
//! is unit-testable with scripted readers (a real port's `TimedOut` errors are
//! injected as script steps).

use std::io::BufRead;

/// Default liveness window: 60 consecutive zero-byte timeout ticks (~60s at the
/// production 1s port timeout). Injectable so tests can run with a short window.
pub const DEFAULT_LIVENESS_TICKS: u32 = 60;

/// Bound on the status read: ~2 timeout ticks (~2s). After the first tick the
/// probe is rewritten once (covers a `?` eaten during the post-reset boot window).
pub const STATUS_MAX_TICKS: u32 = 2;

/// Total-line ceiling: if the pump collects more than this many non-terminal lines
/// without finding an ok/error/ALARM/banner, something is badly wrong (a chatty
/// hardware fault spewing junk that's none of the terminal classes). Return
/// `PumpFailure::Disconnected` so the streaming stack doesn't wedge forever.
pub const MAX_PUMP_LINES: usize = 1000;

/// Consecutive Idle status replies (with no terminal in between) before concluding
/// the terminal was lost on the wire and returning a recoverable stall.
///
/// At the production probe rate of ~1 Hz this is ~3 seconds of "machine reports
/// Idle but no `ok` arrived." A legitimately-slow line reports `Run` while moving,
/// so it is never affected. This value may need owner hardware tuning (ROADMAP WS6).
pub const DEFAULT_IDLE_STALL_TICKS: u32 = 3;

/// Extract the GRBL machine state token from a `<…>` status line.
/// Returns `Some("Idle")`, `Some("Run")`, etc., or `None` if the line is not a
/// well-formed status report.
///
/// GRBL status format: `<State|...>` where State is the first field.
fn parse_machine_state(status_line: &str) -> Option<&str> {
    // Strip the leading `<` and trailing `>`
    let inner = status_line.strip_prefix('<')?.strip_suffix('>')?;
    // The first field before `|` (or the whole inner string) is the state token.
    let state = inner.split('|').next()?;
    Some(state)
}

/// Writes the single-byte real-time `?` status probe.
pub trait ProbeWriter {
    fn write_probe(&mut self) -> std::io::Result<()>;
}

/// `BufRead` plus a non-blocking "how many bytes could I read right now" query
/// (internal buffer + OS RX queue). Needed only by the drain, which must never block.
pub trait PumpReader: BufRead {
    fn available_now(&self) -> usize;
}

/// Classification of a single complete line from GRBL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineClass {
    /// `ok` — command acknowledged.
    Ok,
    /// `error:N` — command rejected.
    Error,
    /// `ALARM…` — controller locked; laser already de-energized by firmware.
    Alarm,
    /// `Grbl …` reset banner — a soft-reset/e-stop interrupted this line.
    Banner,
    /// `<…>` real-time status report — never a terminal.
    Status,
    /// `[MSG:…]` — user-meaningful feedback (door/reset guidance).
    Msg,
    /// Anything else (e.g. `$N=V` setting lines, `[GC:…]`).
    Other,
}

pub fn classify_line(line: &str) -> LineClass {
    if line == "ok" {
        LineClass::Ok
    } else if line.starts_with("error:") {
        LineClass::Error
    } else if line.starts_with("ALARM") {
        LineClass::Alarm
    } else if line.starts_with("Grbl ") {
        LineClass::Banner
    } else if line.starts_with('<') {
        LineClass::Status
    } else if line.starts_with("[MSG:") {
        LineClass::Msg
    } else {
        LineClass::Other
    }
}

/// Why the pump stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PumpTerminal {
    Ok,
    Error,
    Alarm,
    /// Reset banner: the in-flight line was ABORTED, not acked.
    Banner,
}

#[derive(Debug)]
pub struct PumpOutput {
    /// All collected lines, in arrival order, terminal line included.
    /// `<…>` status reports collected during the wait are included (the frontend
    /// uses the most recent one to refresh POSITION ONLY — never machineState).
    pub lines: Vec<String>,
    /// Why the pump stopped. The IPC layer ships `lines` only (the frontend
    /// classifies from line text); `terminal` pins the pump's semantics in tests.
    #[allow(dead_code)]
    pub terminal: PumpTerminal,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PumpFailure {
    /// Liveness expiry, failed write, or vanished port — `error:disconnected`
    /// semantics at the frontend boundary.
    Disconnected(String),
    Io(String),
}

/// Wait-for-terminal read pump with `?` liveness probing.
///
/// Non-terminal lines (`<…>`, `[MSG:…]`, settings echo) are collected and the read
/// continues. On each timeout tick a `?` probe is written; `liveness_ticks`
/// consecutive ticks with ZERO bytes received (partial bytes count as life) declare
/// the port dead. Partial lines survive ticks in `pending`.
///
/// **Idle-wedge detector:** if GRBL answers probes with `<Idle|…>` status reports
/// but the expected `ok`/`error` terminal never arrives, the terminal was lost on the
/// wire. After `idle_stall_ticks` *consecutive* Idle-state replies (with no terminal
/// and no non-Idle status in between) the pump concludes the command completed but
/// the ack was silently dropped, and returns a recoverable `Disconnected` stall
/// (same caller-visible outcome as the silence-based liveness timeout).
/// A legitimately-slow line reports `Run` while the head is moving, which resets the
/// counter — so slow engraving jobs are never incorrectly aborted.
/// Use `DEFAULT_IDLE_STALL_TICKS` (3) for production; tests may inject smaller values.
pub fn run_pump<R: BufRead, P: ProbeWriter>(
    reader: &mut R,
    probe: &mut P,
    pending: &mut Vec<u8>,
    liveness_ticks: u32,
    idle_stall_ticks: u32,
) -> Result<PumpOutput, PumpFailure> {
    let mut lines: Vec<String> = Vec::new();
    let mut silent_ticks: u32 = 0;
    // Consecutive Idle-state status replies with no terminal in between.
    let mut consecutive_idle: u32 = 0;

    loop {
        let len_before = pending.len();
        match reader.read_until(b'\n', pending) {
            Ok(0) => {
                return Err(PumpFailure::Disconnected("port closed (EOF)".to_string()));
            }
            Ok(_) => {
                silent_ticks = 0;
                let line = String::from_utf8_lossy(pending).trim().to_string();
                pending.clear();
                if line.is_empty() {
                    continue;
                }
                let class = classify_line(&line);
                // Idle-wedge detector: track consecutive Idle status replies.
                // Any non-Idle status, any non-status byte, or a terminal resets the counter.
                if class == LineClass::Status {
                    if parse_machine_state(&line) == Some("Idle") {
                        consecutive_idle += 1;
                        if consecutive_idle >= idle_stall_ticks {
                            return Err(PumpFailure::Disconnected(format!(
                                "terminal lost: GRBL reported Idle {} consecutive times with no ok",
                                consecutive_idle
                            )));
                        }
                    } else {
                        // Non-Idle status (Run, Hold, Jog, …): head is moving, reset counter.
                        consecutive_idle = 0;
                    }
                } else {
                    // Any non-status line (including terminals) resets the counter.
                    consecutive_idle = 0;
                }
                lines.push(line);
                match class {
                    LineClass::Ok => return Ok(PumpOutput { lines, terminal: PumpTerminal::Ok }),
                    LineClass::Error => {
                        return Ok(PumpOutput { lines, terminal: PumpTerminal::Error })
                    }
                    LineClass::Alarm => {
                        return Ok(PumpOutput { lines, terminal: PumpTerminal::Alarm })
                    }
                    LineClass::Banner => {
                        return Ok(PumpOutput { lines, terminal: PumpTerminal::Banner })
                    }
                    // Status reports, [MSG:] and unrecognized lines are not terminals.
                    LineClass::Status | LineClass::Msg | LineClass::Other => {
                        if lines.len() >= MAX_PUMP_LINES {
                            return Err(PumpFailure::Disconnected(format!(
                                "pump ceiling reached: {} non-terminal lines without ok/error/ALARM/banner",
                                MAX_PUMP_LINES
                            )));
                        }
                        continue;
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                if pending.len() > len_before {
                    // Partial bytes arrived mid-line: the link is alive.
                    silent_ticks = 0;
                } else {
                    silent_ticks += 1;
                    if silent_ticks >= liveness_ticks {
                        return Err(PumpFailure::Disconnected(format!(
                            "no response from GRBL after {} probe ticks",
                            silent_ticks
                        )));
                    }
                }
                probe
                    .write_probe()
                    .map_err(|e| PumpFailure::Disconnected(format!("probe write failed: {}", e)))?;
            }
            Err(e) => return Err(PumpFailure::Io(format!("read error: {}", e))),
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct DrainOutcome {
    /// Lines that must reach the user's console: `ALARM:n` (styled error — an
    /// unsolicited hard-limit alarm while idle must hit the alarm panel) and
    /// `[MSG:…]` (info).
    pub surfaced: Vec<String>,
    /// Classified-and-dropped lines (banners, stale acks, status reports) — the
    /// caller debug-logs these; they are never attributed to the next command.
    pub dropped: Vec<String>,
}

/// Pre-write drain rule: non-blockingly consume every complete line already
/// buffered (persistent `pending` + reader internals + OS RX queue) and classify
/// it. A trailing partial line (no `\n` yet) stays in `pending` untouched.
pub fn drain_classified<R: PumpReader>(reader: &mut R, pending: &mut Vec<u8>) -> DrainOutcome {
    let mut outcome = DrainOutcome::default();
    loop {
        // Extract complete lines already sitting in the persistent buffer.
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = pending.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&raw).trim().to_string();
            if line.is_empty() {
                continue;
            }
            match classify_line(&line) {
                LineClass::Alarm | LineClass::Msg => outcome.surfaced.push(line),
                _ => outcome.dropped.push(line),
            }
        }
        // Pull in whatever can be read without blocking.
        if reader.available_now() == 0 {
            break;
        }
        match reader.fill_buf() {
            Ok(chunk) if !chunk.is_empty() => {
                let n = chunk.len();
                pending.extend_from_slice(chunk);
                reader.consume(n);
            }
            _ => break,
        }
    }
    outcome
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct StatusRead {
    /// The `<…>` report, or `None` when the bound expired without one (the command
    /// layer maps `None` to the Ok-typed busy/none sentinel — never an `Err`).
    pub status: Option<String>,
    /// `ALARM:n` / `[MSG:…]` junk encountered while skipping — surfaced, not swallowed.
    pub surfaced: Vec<String>,
    /// Other junk skipped (banners, stale acks) — caller debug-logs.
    pub dropped: Vec<String>,
}

/// Write a `?` probe, then read until a `<…>` status report arrives — bounded at
/// `max_ticks` timeout ticks. After the first tick the probe is rewritten once
/// (a `?` can be eaten during GRBL's post-reset boot window). Junk lines are
/// classified per the drain rule, never blind-skipped.
pub fn read_status_bounded<R: BufRead, P: ProbeWriter>(
    reader: &mut R,
    probe: &mut P,
    pending: &mut Vec<u8>,
    max_ticks: u32,
) -> Result<StatusRead, String> {
    probe
        .write_probe()
        .map_err(|e| format!("Write error: {}", e))?;

    let mut read = StatusRead::default();
    let mut ticks: u32 = 0;
    let mut reprobed = false;

    loop {
        match reader.read_until(b'\n', pending) {
            Ok(0) => return Err("port closed (EOF)".to_string()),
            Ok(_) => {
                let line = String::from_utf8_lossy(pending).trim().to_string();
                pending.clear();
                if line.is_empty() {
                    continue;
                }
                match classify_line(&line) {
                    LineClass::Status => {
                        read.status = Some(line);
                        return Ok(read);
                    }
                    LineClass::Alarm | LineClass::Msg => read.surfaced.push(line),
                    _ => read.dropped.push(line),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                ticks += 1;
                if ticks >= max_ticks {
                    // Bound expired: Ok-typed none sentinel, never a hang or an Err.
                    return Ok(read);
                }
                if !reprobed {
                    probe
                        .write_probe()
                        .map_err(|e| format!("Write error: {}", e))?;
                    reprobed = true;
                }
            }
            Err(e) => return Err(format!("Read error: {}", e)),
        }
    }
}

// ---------------------------------------------------------------------------
// Buffered pump — Phase 2A character-counting streaming.
// ---------------------------------------------------------------------------

use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

/// One line accepted into the GRBL RX buffer but not yet acked.
#[derive(Debug)]
struct InFlightLine {
    /// Bytes this line occupies in the RX buffer (content + newline).
    rx_bytes: usize,
}

/// Tuning knobs for the buffered pump. Production defaults match GRBL 1.1
/// stock values; tests inject smaller windows for speed.
#[derive(Debug, Clone)]
pub struct BufferedPumpConfig {
    /// Maximum RX bytes to keep in flight. GRBL 1.1 stock = 128; we budget
    /// 127 to leave 1 byte of headroom (the newline that completes a line
    /// occupies a slot too — accounting must be exact, not optimistic).
    pub rx_budget_max: usize,
    /// Consecutive zero-byte timeout ticks before declaring the port dead.
    pub liveness_ticks: u32,
    /// Consecutive Idle-state status replies (with no `ok`) before declaring
    /// the terminal was lost on the wire.
    pub idle_stall_ticks: u32,
    /// Minimum interval between `LineSent` progress events (ms). Prevents
    /// flooding the frontend channel on dense short-line streams.
    pub progress_throttle_ms: u64,
}

impl Default for BufferedPumpConfig {
    fn default() -> Self {
        Self {
            rx_budget_max: 127,
            liveness_ticks: DEFAULT_LIVENESS_TICKS,
            idle_stall_ticks: DEFAULT_IDLE_STALL_TICKS,
            progress_throttle_ms: 50,
        }
    }
}

/// Events fired during the buffered pump, delivered to the caller via the
/// `on_event` callback.
#[derive(Debug, Clone)]
pub enum BufferedPumpEvent {
    /// A line was written to the wire. `line_index` is 0-based, `total` is
    /// the total number of lines in the job.
    LineSent { line_index: usize, total: usize },
    /// A console-meaningful line from GRBL (status report, [MSG:], etc.).
    ConsoleMessage(String),
    /// A `<…>` status report — the frontend uses the most recent one to
    /// refresh the DRO position.
    StatusReport(String),
}

/// Why the buffered pump stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BufferedPumpOutcome {
    /// All lines sent and all acks received.
    Complete,
    /// The abort flag was set (cooperative cancel, NOT e-stop).
    Cancelled,
    /// A GRBL `error:N` response was received.
    Error { line_index: usize, error_text: String },
    /// A GRBL `ALARM:N` was received.
    Alarm { alarm_text: String },
    /// A reset banner was received (the job was aborted externally, e.g.
    /// by e-stop's realtime `0x18`).
    Aborted,
    /// The port is dead (liveness expiry, EOF, or idle stall).
    Disconnected(String),
}

/// A writer that also supports the `?` probe byte. In production this is
/// `Box<dyn SerialPort>` (which already implements `ProbeWriter`). In unit
/// tests it's the `ScriptWriter` stub.
/// The buffered (character-counting) pump: sends as many lines as fit in
/// the GRBL RX budget, then reads acks to free budget and send more.
///
/// This is the core of Phase 2A. The algorithm keeps the GRBL planner
/// pipeline full by tracking how many bytes are in-flight in the RX buffer,
/// rather than waiting for each line's `ok` before sending the next.
///
/// # Safety properties
///
/// 1. No G-code writes while `paused` (Phase A gated on `!paused`).
/// 2. Write failures surface as `PumpFailure::Disconnected`.
/// 3. Liveness probing continues during buffer-full waits.
/// 4. `ok` attribution is strictly FIFO.
/// 5. RX budget is never exceeded (each line's byte count is checked before
///    sending).
pub fn run_buffered_pump<R: BufRead, W: Write + ProbeWriter>(
    lines: &[String],
    reader: &mut R,
    writer: &mut W,
    pending: &mut Vec<u8>,
    config: &BufferedPumpConfig,
    abort: &AtomicBool,
    on_event: &dyn Fn(BufferedPumpEvent),
) -> Result<BufferedPumpOutcome, PumpFailure> {
    // Pre-validation: reject any line that would exceed the RX budget.
    for (i, line) in lines.iter().enumerate() {
        let wire_bytes = line.len() + 1; // content + newline
        if wire_bytes > config.rx_budget_max {
            return Ok(BufferedPumpOutcome::Error {
                line_index: i,
                error_text: format!(
                    "line exceeds RX budget ({}B > {}B max)",
                    wire_bytes, config.rx_budget_max
                ),
            });
        }
    }

    let mut send_cursor: usize = 0;
    let mut rx_budget_used: usize = 0;
    let mut in_flight: VecDeque<InFlightLine> = VecDeque::new();
    let mut paused = false;
    let mut silent_ticks: u32 = 0;
    let mut consecutive_idle: u32 = 0;
    let mut last_progress = Instant::now();

    loop {
        // Check abort flag
        if abort.load(Ordering::SeqCst) {
            return Ok(BufferedPumpOutcome::Cancelled);
        }

        // -- Phase A: SEND as many lines as fit in the RX budget --
        while !paused && send_cursor < lines.len() {
            if abort.load(Ordering::SeqCst) {
                return Ok(BufferedPumpOutcome::Cancelled);
            }

            let line = &lines[send_cursor];
            let wire_bytes = line.len() + 1;

            // Check if this line fits in the remaining RX budget
            if rx_budget_used + wire_bytes > config.rx_budget_max {
                break; // buffer full, wait for acks
            }

            // Write line + newline
            let mut cmd = line.clone();
            cmd.push('\n');
            writer
                .write_all(cmd.as_bytes())
                .map_err(|e| PumpFailure::Disconnected(format!("write failed: {}", e)))?;
            writer
                .flush()
                .map_err(|e| PumpFailure::Disconnected(format!("flush failed: {}", e)))?;

            rx_budget_used += wire_bytes;
            in_flight.push_back(InFlightLine { rx_bytes: wire_bytes });

            // Throttled progress event
            let now = Instant::now();
            if now.duration_since(last_progress).as_millis() as u64 >= config.progress_throttle_ms
                || send_cursor == lines.len() - 1
            {
                on_event(BufferedPumpEvent::LineSent {
                    line_index: send_cursor,
                    total: lines.len(),
                });
                last_progress = now;
            }

            send_cursor += 1;
        }

        // -- Completion check -- MUTATED: disabled for mutation test
        // if in_flight.is_empty() && send_cursor == lines.len() {
        //     return Ok(BufferedPumpOutcome::Complete);
        // }

        // -- Phase B: READ responses --
        let len_before = pending.len();
        match reader.read_until(b'\n', pending) {
            Ok(0) => {
                return Ok(BufferedPumpOutcome::Disconnected(
                    "port closed (EOF)".to_string(),
                ));
            }
            Ok(_) => {
                silent_ticks = 0;
                let line = String::from_utf8_lossy(pending).trim().to_string();
                pending.clear();
                if line.is_empty() {
                    continue;
                }

                let class = classify_line(&line);

                match class {
                    LineClass::Ok => {
                        consecutive_idle = 0;
                        if let Some(oldest) = in_flight.pop_front() {
                            rx_budget_used = rx_budget_used.saturating_sub(oldest.rx_bytes);
                        }
                        // After freeing budget, loop back to Phase A
                    }
                    LineClass::Error => {
                        let line_index = if in_flight.is_empty() {
                            send_cursor.saturating_sub(1)
                        } else {
                            send_cursor - in_flight.len()
                        };
                        return Ok(BufferedPumpOutcome::Error {
                            line_index,
                            error_text: line,
                        });
                    }
                    LineClass::Alarm => {
                        return Ok(BufferedPumpOutcome::Alarm { alarm_text: line });
                    }
                    LineClass::Banner => {
                        return Ok(BufferedPumpOutcome::Aborted);
                    }
                    LineClass::Status => {
                        // Detect Hold → pause sending; detect Run/Idle → resume
                        if let Some(state) = parse_machine_state_from_status(&line) {
                            if state == "Hold" || state.starts_with("Hold:") {
                                paused = true;
                                consecutive_idle = 0;
                            } else {
                                if paused {
                                    paused = false;
                                }
                                if state == "Idle" {
                                    consecutive_idle += 1;
                                    if !in_flight.is_empty()
                                        && consecutive_idle >= config.idle_stall_ticks
                                    {
                                        return Ok(BufferedPumpOutcome::Disconnected(format!(
                                            "terminal lost: GRBL reported Idle {} consecutive times with no ok",
                                            consecutive_idle
                                        )));
                                    }
                                } else {
                                    consecutive_idle = 0;
                                }
                            }
                        }
                        on_event(BufferedPumpEvent::StatusReport(line));
                    }
                    LineClass::Msg => {
                        consecutive_idle = 0;
                        on_event(BufferedPumpEvent::ConsoleMessage(line));
                    }
                    LineClass::Other => {
                        consecutive_idle = 0;
                        on_event(BufferedPumpEvent::ConsoleMessage(line));
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                // Check abort on every timeout tick — this is the pump's
                // main opportunity to notice a cooperative cancel during
                // buffer-full waits.
                if abort.load(Ordering::SeqCst) {
                    return Ok(BufferedPumpOutcome::Cancelled);
                }
                if pending.len() > len_before {
                    silent_ticks = 0;
                } else {
                    silent_ticks += 1;
                    if silent_ticks >= config.liveness_ticks {
                        return Ok(BufferedPumpOutcome::Disconnected(format!(
                            "no response from GRBL after {} probe ticks",
                            silent_ticks
                        )));
                    }
                }
                writer
                    .write_probe()
                    .map_err(|e| PumpFailure::Disconnected(format!("probe write failed: {}", e)))?;
            }
            Err(e) => return Err(PumpFailure::Io(format!("read error: {}", e))),
        }
    }
}

/// Extract the machine state token from a `<State|...>` status line.
/// Similar to `parse_machine_state` but accepts the full `<…>` format
/// including optional substates like `Hold:0`.
fn parse_machine_state_from_status(status_line: &str) -> Option<&str> {
    let inner = status_line.strip_prefix('<')?.strip_suffix('>')?;
    let state = inner.split('|').next()?;
    Some(state)
}

// ---------------------------------------------------------------------------
// Tests — scripted reader injects data chunks and TimedOut ticks explicitly.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io::{Error, ErrorKind, Read};

    enum Step {
        Data(&'static [u8]),
        Timeout,
    }

    struct ScriptReader {
        steps: VecDeque<Step>,
        current: Vec<u8>,
        pos: usize,
    }

    impl ScriptReader {
        fn new(steps: Vec<Step>) -> Self {
            Self { steps: steps.into(), current: Vec::new(), pos: 0 }
        }
    }

    impl Read for ScriptReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let chunk = self.fill_buf()?;
            let n = chunk.len().min(buf.len());
            buf[..n].copy_from_slice(&chunk[..n]);
            self.consume(n);
            Ok(n)
        }
    }

    impl BufRead for ScriptReader {
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            if self.pos >= self.current.len() {
                match self.steps.pop_front() {
                    Some(Step::Data(d)) => {
                        self.current = d.to_vec();
                        self.pos = 0;
                    }
                    Some(Step::Timeout) => return Err(Error::new(ErrorKind::TimedOut, "tick")),
                    None => return Ok(&[]), // EOF
                }
            }
            Ok(&self.current[self.pos..])
        }
        fn consume(&mut self, amt: usize) {
            self.pos += amt;
        }
    }

    impl PumpReader for ScriptReader {
        /// Bytes available without blocking: rest of current chunk plus following
        /// Data steps up to the first Timeout/end of script.
        fn available_now(&self) -> usize {
            let mut n = self.current.len() - self.pos;
            for step in &self.steps {
                match step {
                    Step::Data(d) => n += d.len(),
                    Step::Timeout => break,
                }
            }
            n
        }
    }

    struct CountingProbe {
        probes: u32,
    }
    impl CountingProbe {
        fn new() -> Self {
            Self { probes: 0 }
        }
    }
    impl ProbeWriter for CountingProbe {
        fn write_probe(&mut self) -> std::io::Result<()> {
            self.probes += 1;
            Ok(())
        }
    }

    fn pump(steps: Vec<Step>, ticks: u32) -> (Result<PumpOutput, PumpFailure>, u32, Vec<u8>) {
        pump_with_idle(steps, ticks, DEFAULT_IDLE_STALL_TICKS)
    }

    fn pump_with_idle(
        steps: Vec<Step>,
        ticks: u32,
        idle_stall_ticks: u32,
    ) -> (Result<PumpOutput, PumpFailure>, u32, Vec<u8>) {
        let mut reader = ScriptReader::new(steps);
        let mut probe = CountingProbe::new();
        let mut pending = Vec::new();
        let result = run_pump(&mut reader, &mut probe, &mut pending, ticks, idle_stall_ticks);
        (result, probe.probes, pending)
    }

    // Pump test 1: delayed ok after 3 empty timeout ticks → ok, no premature exit.
    #[test]
    fn delayed_ok_after_timeout_ticks() {
        let (result, probes, _) = pump(
            vec![Step::Timeout, Step::Timeout, Step::Timeout, Step::Data(b"ok\n")],
            DEFAULT_LIVENESS_TICKS,
        );
        let out = result.unwrap();
        assert_eq!(out.terminal, PumpTerminal::Ok);
        assert_eq!(out.lines, vec!["ok"]);
        assert_eq!(probes, 3, "one ? probe per timeout tick");
    }

    // Pump test 2: interleaved status reports then ok → reports collected, ok terminal.
    #[test]
    fn status_reports_are_collected_not_terminal() {
        let (result, _, _) = pump(
            vec![
                Step::Data(b"<Run|MPos:1.000,2.000,0.000|FS:500,800>\n"),
                Step::Timeout,
                Step::Data(b"<Idle|MPos:5.000,6.000,0.000|FS:0,0>\n"),
                Step::Data(b"ok\n"),
            ],
            DEFAULT_LIVENESS_TICKS,
        );
        let out = result.unwrap();
        assert_eq!(out.terminal, PumpTerminal::Ok);
        assert_eq!(
            out.lines,
            vec![
                "<Run|MPos:1.000,2.000,0.000|FS:500,800>",
                "<Idle|MPos:5.000,6.000,0.000|FS:0,0>",
                "ok"
            ]
        );
    }

    // Pump test 3: ALARM is terminal and classified.
    #[test]
    fn alarm_is_terminal() {
        let (result, _, _) = pump(vec![Step::Data(b"ALARM:1\n")], DEFAULT_LIVENESS_TICKS);
        let out = result.unwrap();
        assert_eq!(out.terminal, PumpTerminal::Alarm);
        assert_eq!(out.lines, vec!["ALARM:1"]);
    }

    // Pump test 4: reset banner is a terminal-abort, not an ack.
    #[test]
    fn reset_banner_is_terminal_abort() {
        let (result, _, _) = pump(
            vec![Step::Data(b"Grbl 1.1h ['$' for help]\n")],
            DEFAULT_LIVENESS_TICKS,
        );
        let out = result.unwrap();
        assert_eq!(out.terminal, PumpTerminal::Banner);
        assert_eq!(out.lines, vec!["Grbl 1.1h ['$' for help]"]);
    }

    // Pump test 5: total silence → liveness expiry with a short injected window.
    #[test]
    fn liveness_expiry_on_total_silence() {
        let (result, probes, _) = pump(
            vec![Step::Timeout, Step::Timeout, Step::Timeout, Step::Timeout, Step::Timeout],
            3,
        );
        match result {
            Err(PumpFailure::Disconnected(_)) => {}
            other => panic!("expected Disconnected, got {:?}", other),
        }
        // Ticks 1 and 2 probe; tick 3 hits the window and returns without probing.
        assert_eq!(probes, 2);
    }

    // Pump test 6: error:N is terminal.
    #[test]
    fn error_line_is_terminal() {
        let (result, _, _) = pump(vec![Step::Data(b"error:9\n")], DEFAULT_LIVENESS_TICKS);
        let out = result.unwrap();
        assert_eq!(out.terminal, PumpTerminal::Error);
        assert_eq!(out.lines, vec!["error:9"]);
    }

    // Pump test 7: a response SPLIT across a timeout tick loses no bytes
    // (the read_until persistent-buffer case — read_line would truncate).
    #[test]
    fn split_response_across_timeout_tick_loses_no_bytes() {
        let (result, _, _) = pump(
            vec![
                Step::Data(b"<Idle|MPos:1.000,2.0"),
                Step::Timeout,
                Step::Data(b"00,0.000|FS:0,0>\n"),
                Step::Data(b"o"),
                Step::Timeout,
                Step::Data(b"k\n"),
            ],
            DEFAULT_LIVENESS_TICKS,
        );
        let out = result.unwrap();
        assert_eq!(out.terminal, PumpTerminal::Ok);
        assert_eq!(out.lines, vec!["<Idle|MPos:1.000,2.000,0.000|FS:0,0>", "ok"]);
    }

    // Partial bytes mid-line reset the liveness counter (the link is alive).
    #[test]
    fn partial_bytes_reset_liveness() {
        // Window of 2: two truly-silent ticks would disconnect, but a byte arrives
        // between them, so the pump survives to the terminal.
        let (result, _, _) = pump(
            vec![
                Step::Timeout,
                Step::Data(b"o"), // partial — no newline
                Step::Timeout,
                Step::Timeout, // would be tick 2 if "o" hadn't reset the counter
                Step::Data(b"k\n"),
            ],
            3,
        );
        let out = result.unwrap();
        assert_eq!(out.terminal, PumpTerminal::Ok);
        assert_eq!(out.lines, vec!["ok"]);
    }

    // Pump test 8: pre-write drain — stale banner/acks dropped (not attributed),
    // buffered ALARM SURFACES rather than vanishing (R3 blocking #2).
    #[test]
    fn drain_classifies_stale_lines() {
        let mut reader = ScriptReader::new(vec![
            Step::Data(b"Grbl 1.1h ['$' for help]\nok\nALARM:2\n[MSG:Reset to continue]\n<Idle|MPos:0,0,0>\n"),
            Step::Timeout, // everything after this is NOT available now
            Step::Data(b"ok\n"),
        ]);
        let mut pending = Vec::new();
        let outcome = drain_classified(&mut reader, &mut pending);
        assert_eq!(outcome.surfaced, vec!["ALARM:2", "[MSG:Reset to continue]"]);
        assert_eq!(
            outcome.dropped,
            vec!["Grbl 1.1h ['$' for help]", "ok", "<Idle|MPos:0,0,0>"]
        );
        assert!(pending.is_empty());

        // The NEXT command's pump sees only its own fresh ack — zero misattribution.
        let mut probe = CountingProbe::new();
        let out = run_pump(&mut reader, &mut probe, &mut pending, 5, DEFAULT_IDLE_STALL_TICKS).unwrap();
        assert_eq!(out.terminal, PumpTerminal::Ok);
        assert_eq!(out.lines, vec!["ok"]);
    }

    // Drain leaves a trailing partial line in pending for the pump to complete.
    #[test]
    fn drain_keeps_partial_line_in_pending() {
        let mut reader = ScriptReader::new(vec![
            Step::Data(b"ok\n<Idle|MP"), // stale ack + partial status
            Step::Timeout,
        ]);
        let mut pending = Vec::new();
        let outcome = drain_classified(&mut reader, &mut pending);
        assert_eq!(outcome.dropped, vec!["ok"]);
        assert!(outcome.surfaced.is_empty());
        assert_eq!(pending, b"<Idle|MP".to_vec());
    }

    // Pump test 9a: get_status skips junk and returns the first <…> line.
    #[test]
    fn status_read_skips_junk_until_report() {
        let mut reader = ScriptReader::new(vec![Step::Data(
            b"Grbl 1.1h ['$' for help]\nALARM:3\n<Alarm|MPos:0.000,0.000,0.000>\n",
        )]);
        let mut probe = CountingProbe::new();
        let mut pending = Vec::new();
        let read = read_status_bounded(&mut reader, &mut probe, &mut pending, STATUS_MAX_TICKS)
            .unwrap();
        assert_eq!(read.status.as_deref(), Some("<Alarm|MPos:0.000,0.000,0.000>"));
        assert_eq!(read.surfaced, vec!["ALARM:3"]); // alarm surfaces, never swallowed
        assert_eq!(read.dropped, vec!["Grbl 1.1h ['$' for help]"]);
        assert_eq!(probe.probes, 1);
    }

    // Pump test 9b: junk then NO <…> within the bound → none sentinel, no hang.
    #[test]
    fn status_read_bounded_returns_none_sentinel() {
        let mut reader = ScriptReader::new(vec![
            Step::Data(b"[MSG:Check Door]\n"),
            Step::Timeout,
            Step::Timeout,
            Step::Timeout, // never reached: bound is 2 ticks
            Step::Data(b"<Idle|MPos:0,0,0>\n"),
        ]);
        let mut probe = CountingProbe::new();
        let mut pending = Vec::new();
        let read = read_status_bounded(&mut reader, &mut probe, &mut pending, STATUS_MAX_TICKS)
            .unwrap();
        assert_eq!(read.status, None);
        assert_eq!(read.surfaced, vec!["[MSG:Check Door]"]);
        // Initial probe + one rewrite after the first tick.
        assert_eq!(probe.probes, 2);
    }

    // Acceptance criterion 1: a scripted 20s-per-line job — zero empty-ack advances,
    // zero byte loss, zero stale-line misattribution after a reset.
    #[test]
    fn scripted_slow_job_streams_without_desync() {
        // Line 1: instant ack. Line 2: "20s" of timeout ticks (planner backpressure)
        // with split bytes. Line 3: aborted by a reset banner. Line 4 (post-reset):
        // drain removes the stale debris; fresh ack attributes correctly.
        let mut steps: Vec<Step> = vec![Step::Data(b"ok\n")];
        let mut reader = ScriptReader::new(std::mem::take(&mut steps));
        let mut probe = CountingProbe::new();
        let mut pending = Vec::new();

        // Line 1
        let out = run_pump(&mut reader, &mut probe, &mut pending, 60, DEFAULT_IDLE_STALL_TICKS).unwrap();
        assert_eq!(out.terminal, PumpTerminal::Ok);
        assert_eq!(out.lines.len(), 1, "no empty-ack advance");

        // Line 2: 20 ticks, status traffic, split terminal
        let mut steps: Vec<Step> = Vec::new();
        for i in 0..20 {
            steps.push(Step::Timeout);
            if i % 5 == 4 {
                steps.push(Step::Data(b"<Run|MPos:10.000,20.000,0.000|FS:500,900>\n"));
            }
        }
        steps.push(Step::Data(b"o"));
        steps.push(Step::Timeout);
        steps.push(Step::Data(b"k\n"));
        let mut reader = ScriptReader::new(steps);
        let out = run_pump(&mut reader, &mut probe, &mut pending, 60, DEFAULT_IDLE_STALL_TICKS).unwrap();
        assert_eq!(out.terminal, PumpTerminal::Ok);
        assert_eq!(out.lines.last().map(String::as_str), Some("ok"));
        assert_eq!(
            out.lines.iter().filter(|l| l.starts_with('<')).count(),
            4,
            "all in-pump status reports collected"
        );

        // Line 3: e-stop mid-line — banner aborts, not acks
        let mut reader = ScriptReader::new(vec![
            Step::Timeout,
            Step::Data(b"Grbl 1.1h ['$' for help]\n"),
            // Stale debris that lands AFTER the banner (post-reset MSG + delayed junk)
            Step::Data(b"[MSG:'$H'|'$X' to unlock]\nok\n"),
        ]);
        let out = run_pump(&mut reader, &mut probe, &mut pending, 60, DEFAULT_IDLE_STALL_TICKS).unwrap();
        assert_eq!(out.terminal, PumpTerminal::Banner, "reset banner = aborted, never acked");

        // Line 4: the drain consumes the leftover debris before the next write …
        let outcome = drain_classified(&mut reader, &mut pending);
        assert_eq!(outcome.surfaced, vec!["[MSG:'$H'|'$X' to unlock]"]);
        assert_eq!(outcome.dropped, vec!["ok"], "stale ack drained, not attributed");

        // … so the fresh command attributes only its own ack.
        let mut reader = ScriptReader::new(vec![Step::Data(b"ok\n")]);
        let out = run_pump(&mut reader, &mut probe, &mut pending, 60, DEFAULT_IDLE_STALL_TICKS).unwrap();
        assert_eq!(out.terminal, PumpTerminal::Ok);
        assert_eq!(out.lines, vec!["ok"]);
    }

    #[test]
    fn classify_line_covers_protocol_vocabulary() {
        assert_eq!(classify_line("ok"), LineClass::Ok);
        assert_eq!(classify_line("error:20"), LineClass::Error);
        assert_eq!(classify_line("ALARM:1"), LineClass::Alarm);
        assert_eq!(classify_line("Grbl 1.1h ['$' for help]"), LineClass::Banner);
        assert_eq!(classify_line("<Idle|MPos:0,0,0>"), LineClass::Status);
        assert_eq!(classify_line("[MSG:Check Door]"), LineClass::Msg);
        assert_eq!(classify_line("$32=1"), LineClass::Other);
        assert_eq!(classify_line("[GC:G0 G54]"), LineClass::Other);
    }

    // Idle-wedge test 1: pump receives only <Idle|…> status replies and no ok.
    // After DEFAULT_IDLE_STALL_TICKS (3) consecutive Idle reports it must return a
    // Disconnected stall — never Ok, never an infinite loop.
    #[test]
    fn run_pump_stalls_on_idle_status_without_ok() {
        // Inject 5 Idle status replies and no terminal; stall threshold is 3.
        // The pump must stop at 3 and return Disconnected without consuming the rest.
        let (result, _, _) = pump_with_idle(
            vec![
                Step::Data(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\n"),
                Step::Data(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\n"),
                Step::Data(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\n"),
                // These would only be reached if the stall detector failed:
                Step::Data(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\n"),
                Step::Data(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\n"),
            ],
            DEFAULT_LIVENESS_TICKS,
            3, // stall threshold
        );
        match result {
            Err(PumpFailure::Disconnected(msg)) => {
                assert!(
                    msg.contains("Idle") || msg.contains("terminal lost"),
                    "error message should mention Idle wedge: {msg}"
                );
            }
            Ok(out) => panic!("expected Disconnected stall, got Ok with terminal {:?}", out.terminal),
            Err(PumpFailure::Io(e)) => panic!("expected Disconnected stall, got Io error: {e}"),
        }
    }

    // Pump ceiling test: more than MAX_PUMP_LINES non-terminal lines triggers
    // PumpFailure::Disconnected — a chatty hardware fault can't wedge the pump.
    #[test]
    fn pump_ceiling_triggers_on_non_terminal_flood() {
        // Pin the constant value so changing MAX_PUMP_LINES requires updating
        // this test — the ceiling is a safety parameter, not a tunable.
        assert_eq!(MAX_PUMP_LINES, 1000, "MAX_PUMP_LINES value changed — update this test");

        // Build 1005 [MSG:junk] lines (hardcoded, not derived from the constant).
        // This breaks if MAX_PUMP_LINES is raised above 1005.
        let mut steps: Vec<Step> = Vec::new();
        for _ in 0..1005 {
            steps.push(Step::Data(b"[MSG:junk]\n"));
        }
        let (result, _, _) = pump(steps, DEFAULT_LIVENESS_TICKS);
        match result {
            Err(PumpFailure::Disconnected(msg)) => {
                assert!(
                    msg.contains("pump ceiling") || msg.contains("non-terminal"),
                    "expected pump ceiling message, got: {msg}"
                );
            }
            other => panic!("expected pump ceiling Disconnected, got {other:?}"),
        }
    }

    // Idle-wedge test 2: pump receives <Run|…> replies while the head moves, then ok.
    // The Run state must NOT trigger the stall — a legitimately-slow line completes
    // normally and the pump must return Ok.
    #[test]
    fn run_pump_waits_through_run_status() {
        // 5 Run replies (head moving), then ok. Stall threshold is 3, but Run is NOT
        // Idle so the consecutive_idle counter stays at 0 throughout.
        let (result, _, _) = pump_with_idle(
            vec![
                Step::Data(b"<Run|MPos:1.000,0.000,0.000|FS:500,0>\n"),
                Step::Data(b"<Run|MPos:2.000,0.000,0.000|FS:500,0>\n"),
                Step::Data(b"<Run|MPos:3.000,0.000,0.000|FS:500,0>\n"),
                Step::Data(b"<Run|MPos:4.000,0.000,0.000|FS:500,0>\n"),
                Step::Data(b"<Run|MPos:5.000,0.000,0.000|FS:500,0>\n"),
                Step::Data(b"ok\n"),
            ],
            DEFAULT_LIVENESS_TICKS,
            3, // stall threshold — must NOT fire on Run state
        );
        let out = result.expect("pump should complete Ok after Run replies");
        assert_eq!(out.terminal, PumpTerminal::Ok, "Run replies must not trigger stall");
        assert_eq!(out.lines.last().map(String::as_str), Some("ok"));
        assert_eq!(
            out.lines.iter().filter(|l| l.starts_with("<Run")).count(),
            5,
            "all Run status reports should be collected"
        );
    }

    // -----------------------------------------------------------------------
    // Buffered pump tests (Phase 2A)
    // -----------------------------------------------------------------------

    /// ScriptWriter: records all writes and supports ProbeWriter. Optionally
    /// fails writes to test the Disconnected path.
    struct ScriptWriter {
        written: Vec<u8>,
        fail: bool,
    }

    impl ScriptWriter {
        fn new() -> Self {
            Self { written: Vec::new(), fail: false }
        }
        fn new_failing() -> Self {
            Self { written: Vec::new(), fail: true }
        }
    }

    impl std::io::Write for ScriptWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.fail {
                return Err(std::io::Error::other("sim: write_fail"));
            }
            self.written.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            if self.fail {
                return Err(std::io::Error::other("sim: flush_fail"));
            }
            Ok(())
        }
    }

    impl ProbeWriter for ScriptWriter {
        fn write_probe(&mut self) -> std::io::Result<()> {
            if self.fail {
                return Err(std::io::Error::other("sim: probe_fail"));
            }
            self.written.push(b'?');
            Ok(())
        }
    }

    fn buffered_pump_helper(
        lines: &[&str],
        steps: Vec<Step>,
        config: &BufferedPumpConfig,
        abort: &AtomicBool,
    ) -> (Result<BufferedPumpOutcome, PumpFailure>, Vec<BufferedPumpEvent>, ScriptWriter) {
        let mut reader = ScriptReader::new(steps);
        let mut writer = ScriptWriter::new();
        let mut pending = Vec::new();
        let events = std::sync::Mutex::new(Vec::new());
        let string_lines: Vec<String> = lines.iter().map(|s| s.to_string()).collect();

        let result = run_buffered_pump(
            &string_lines,
            &mut reader,
            &mut writer,
            &mut pending,
            config,
            abort,
            &|e| events.lock().unwrap().push(e),
        );
        (result, events.into_inner().unwrap(), writer)
    }

    // BP1: Basic flow — 3 lines → 3 oks → Complete
    #[test]
    fn buffered_pump_basic_flow_3_lines() {
        let abort = AtomicBool::new(false);
        let config = BufferedPumpConfig {
            rx_budget_max: 127,
            liveness_ticks: 10,
            idle_stall_ticks: 5,
            progress_throttle_ms: 0,
        };
        let (result, events, _) = buffered_pump_helper(
            &["G1 X10 F500", "G1 X20 F500", "G1 X30 F500"],
            vec![
                Step::Data(b"ok\n"),
                Step::Data(b"ok\n"),
                Step::Data(b"ok\n"),
            ],
            &config,
            &abort,
        );
        assert_eq!(result.unwrap(), BufferedPumpOutcome::Complete);
        let sent_count = events.iter().filter(|e| matches!(e, BufferedPumpEvent::LineSent { .. })).count();
        assert!(sent_count >= 3, "expected at least 3 LineSent events, got {sent_count}");
    }

    // BP2: RX budget tracking — lines wait when budget full, resume after ok
    #[test]
    fn buffered_pump_rx_budget_tracking() {
        let abort = AtomicBool::new(false);
        // Tiny budget: only 20 bytes. "G1 X10 F500" = 11 chars + \n = 12B.
        // Second line won't fit until first acks.
        let config = BufferedPumpConfig {
            rx_budget_max: 20,
            liveness_ticks: 10,
            idle_stall_ticks: 5,
            progress_throttle_ms: 0,
        };
        let (result, _, writer) = buffered_pump_helper(
            &["G1 X10 F500", "G1 X20 F500"],
            vec![
                // First ok frees budget for second line
                Step::Data(b"ok\n"),
                Step::Data(b"ok\n"),
            ],
            &config,
            &abort,
        );
        assert_eq!(result.unwrap(), BufferedPumpOutcome::Complete);
        // Verify both lines were actually written
        let written = String::from_utf8_lossy(&writer.written);
        assert!(written.contains("G1 X10 F500\n"), "first line written");
        assert!(written.contains("G1 X20 F500\n"), "second line written");
    }

    // BP3: Pause detection — Hold → stops sending; Run → resumes
    #[test]
    fn buffered_pump_pause_detection() {
        let abort = AtomicBool::new(false);
        let config = BufferedPumpConfig {
            rx_budget_max: 127,
            liveness_ticks: 10,
            idle_stall_ticks: 5,
            progress_throttle_ms: 0,
        };
        let (result, events, _) = buffered_pump_helper(
            &["G1 X10 F500", "G1 X20 F500"],
            vec![
                Step::Data(b"ok\n"),
                // Hold during second line
                Step::Data(b"<Hold|MPos:0.000,0.000,0.000|FS:0,0>\n"),
                // Resume
                Step::Data(b"<Run|MPos:0.000,0.000,0.000|FS:500,0>\n"),
                Step::Data(b"ok\n"),
            ],
            &config,
            &abort,
        );
        assert_eq!(result.unwrap(), BufferedPumpOutcome::Complete);
        // Verify we got status reports
        let status_count = events.iter().filter(|e| matches!(e, BufferedPumpEvent::StatusReport(_))).count();
        assert!(status_count >= 2, "expected at least 2 status reports, got {status_count}");
    }

    // BP4: Abort — AtomicBool set → Cancelled
    #[test]
    fn buffered_pump_abort_flag() {
        let abort = AtomicBool::new(true); // pre-set
        let config = BufferedPumpConfig::default();
        let (result, _, _) = buffered_pump_helper(
            &["G1 X10 F500"],
            vec![Step::Timeout],
            &config,
            &abort,
        );
        assert_eq!(result.unwrap(), BufferedPumpOutcome::Cancelled);
    }

    // BP5: Error terminal
    #[test]
    fn buffered_pump_error_terminal() {
        let abort = AtomicBool::new(false);
        let config = BufferedPumpConfig {
            rx_budget_max: 127,
            liveness_ticks: 10,
            idle_stall_ticks: 5,
            progress_throttle_ms: 0,
        };
        let (result, _, _) = buffered_pump_helper(
            &["G1 X10 F500"],
            vec![Step::Data(b"error:9\n")],
            &config,
            &abort,
        );
        match result.unwrap() {
            BufferedPumpOutcome::Error { error_text, .. } => {
                assert_eq!(error_text, "error:9");
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    // BP5b: ALARM terminal
    #[test]
    fn buffered_pump_alarm_terminal() {
        let abort = AtomicBool::new(false);
        let config = BufferedPumpConfig {
            rx_budget_max: 127,
            liveness_ticks: 10,
            idle_stall_ticks: 5,
            progress_throttle_ms: 0,
        };
        let (result, _, _) = buffered_pump_helper(
            &["G1 X10 F500"],
            vec![Step::Data(b"ALARM:1\n")],
            &config,
            &abort,
        );
        match result.unwrap() {
            BufferedPumpOutcome::Alarm { alarm_text } => {
                assert_eq!(alarm_text, "ALARM:1");
            }
            other => panic!("expected Alarm, got {other:?}"),
        }
    }

    // BP5c: Banner terminal → Aborted
    #[test]
    fn buffered_pump_banner_terminal() {
        let abort = AtomicBool::new(false);
        let config = BufferedPumpConfig {
            rx_budget_max: 127,
            liveness_ticks: 10,
            idle_stall_ticks: 5,
            progress_throttle_ms: 0,
        };
        let (result, _, _) = buffered_pump_helper(
            &["G1 X10 F500"],
            vec![Step::Data(b"Grbl 1.1h ['$' for help]\n")],
            &config,
            &abort,
        );
        assert_eq!(result.unwrap(), BufferedPumpOutcome::Aborted);
    }

    // BP6: Liveness probing — silence → Disconnected
    #[test]
    fn buffered_pump_liveness_probing() {
        let abort = AtomicBool::new(false);
        let config = BufferedPumpConfig {
            rx_budget_max: 127,
            liveness_ticks: 3,
            idle_stall_ticks: 5,
            progress_throttle_ms: 0,
        };
        let (result, _, _) = buffered_pump_helper(
            &["G1 X10 F500"],
            vec![Step::Timeout, Step::Timeout, Step::Timeout, Step::Timeout],
            &config,
            &abort,
        );
        match result.unwrap() {
            BufferedPumpOutcome::Disconnected(msg) => {
                assert!(msg.contains("probe ticks"), "got: {msg}");
            }
            other => panic!("expected Disconnected, got {other:?}"),
        }
    }

    // BP7: Write failure → Disconnected
    #[test]
    fn buffered_pump_write_failure() {
        let abort = AtomicBool::new(false);
        let config = BufferedPumpConfig {
            rx_budget_max: 127,
            liveness_ticks: 10,
            idle_stall_ticks: 5,
            progress_throttle_ms: 0,
        };
        let mut reader = ScriptReader::new(vec![Step::Timeout]);
        let mut writer = ScriptWriter::new_failing();
        let mut pending = Vec::new();
        let lines = vec!["G1 X10 F500".to_string()];

        let result = run_buffered_pump(
            &lines,
            &mut reader,
            &mut writer,
            &mut pending,
            &config,
            &abort,
            &|_| {},
        );
        match result {
            Err(PumpFailure::Disconnected(msg)) => {
                assert!(msg.contains("write failed") || msg.contains("flush"), "got: {msg}");
            }
            other => panic!("expected Disconnected from write failure, got {other:?}"),
        }
    }

    // BP8: Planner backpressure — rx_budget never exceeded
    #[test]
    fn buffered_pump_rx_budget_never_exceeded() {
        let abort = AtomicBool::new(false);
        // Budget of 30. Lines are ~12B each. Only 2 can be in flight at once.
        let config = BufferedPumpConfig {
            rx_budget_max: 30,
            liveness_ticks: 10,
            idle_stall_ticks: 5,
            progress_throttle_ms: 0,
        };
        // 5 lines, but only 2 fit at a time. Acks must interleave.
        let (result, _, writer) = buffered_pump_helper(
            &["G1 X1 F500", "G1 X2 F500", "G1 X3 F500", "G1 X4 F500", "G1 X5 F500"],
            vec![
                // After 2 lines sent, need acks before more
                Step::Data(b"ok\n"),
                Step::Data(b"ok\n"),
                Step::Data(b"ok\n"),
                Step::Data(b"ok\n"),
                Step::Data(b"ok\n"),
            ],
            &config,
            &abort,
        );
        assert_eq!(result.unwrap(), BufferedPumpOutcome::Complete);
        // All 5 lines written
        let written = String::from_utf8_lossy(&writer.written);
        for i in 1..=5 {
            assert!(written.contains(&format!("G1 X{i} F500\n")), "line {i} written");
        }
    }

    // BP9: Pre-validation rejects oversized lines
    #[test]
    fn buffered_pump_rejects_oversized_line() {
        let abort = AtomicBool::new(false);
        let config = BufferedPumpConfig {
            rx_budget_max: 10,
            liveness_ticks: 10,
            idle_stall_ticks: 5,
            progress_throttle_ms: 0,
        };
        let (result, _, _) = buffered_pump_helper(
            &["G1 X10000000 F500"], // 18 chars + \n = 19B > 10B budget
            vec![],
            &config,
            &abort,
        );
        match result.unwrap() {
            BufferedPumpOutcome::Error { line_index, error_text } => {
                assert_eq!(line_index, 0);
                assert!(error_text.contains("RX budget"), "got: {error_text}");
            }
            other => panic!("expected Error for oversized line, got {other:?}"),
        }
    }
}
