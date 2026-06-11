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
pub fn run_pump<R: BufRead, P: ProbeWriter>(
    reader: &mut R,
    probe: &mut P,
    pending: &mut Vec<u8>,
    liveness_ticks: u32,
) -> Result<PumpOutput, PumpFailure> {
    let mut lines: Vec<String> = Vec::new();
    let mut silent_ticks: u32 = 0;

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
                    LineClass::Status | LineClass::Msg | LineClass::Other => continue,
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
        let mut reader = ScriptReader::new(steps);
        let mut probe = CountingProbe::new();
        let mut pending = Vec::new();
        let result = run_pump(&mut reader, &mut probe, &mut pending, ticks);
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
        let out = run_pump(&mut reader, &mut probe, &mut pending, 5).unwrap();
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
        let out = run_pump(&mut reader, &mut probe, &mut pending, 60).unwrap();
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
        let out = run_pump(&mut reader, &mut probe, &mut pending, 60).unwrap();
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
        let out = run_pump(&mut reader, &mut probe, &mut pending, 60).unwrap();
        assert_eq!(out.terminal, PumpTerminal::Banner, "reset banner = aborted, never acked");

        // Line 4: the drain consumes the leftover debris before the next write …
        let outcome = drain_classified(&mut reader, &mut pending);
        assert_eq!(outcome.surfaced, vec!["[MSG:'$H'|'$X' to unlock]"]);
        assert_eq!(outcome.dropped, vec!["ok"], "stale ack drained, not attributed");

        // … so the fresh command attributes only its own ack.
        let mut reader = ScriptReader::new(vec![Step::Data(b"ok\n")]);
        let out = run_pump(&mut reader, &mut probe, &mut pending, 60).unwrap();
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
}
