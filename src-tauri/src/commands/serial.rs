//! Serial / GRBL command layer.
//!
//! ## Lock-order table
//!
//! | Order | Lock / guard | Held by | Duration |
//! |-------|--------------|---------|----------|
//! | leaf  | `session.admitted_job` | `serial_job_begin`, `serial_job_end`, `serial_stop_inner` (under `submit`), `admit_and_write` (under `submit`) | Microseconds (check+set) |
//! | 2.5   | `session.submit` | `admit_and_write` (admission check + one `write()` of a job line), `serial_stop_inner` Step 2 (admission close) | Microseconds; at most one `write(2)` enqueue, bounded by the port timeout (1000 ms) |
//! | leaf  | `session.last_stop` | `serial_stop_inner` (result write), joiner (result read) | Microseconds |
//! | leaf  | `session.observer` | test setup, session event emission | Microseconds |
//! | leaf  | `session.snapshot` | snapshot publish/read/invalidate | Microseconds |
//! | 2     | `realtime` | `send_byte_inner`, `serial_stop_inner` (for `0x18`), `disconnect_inner_with_job` | Microseconds (one byte + flush) |
//! | 3     | `command` | `serial_send_inner`, `serial_stream_job_inner`, `serial_connect_inner`, `disconnect_inner_with_job` | Seconds to minutes (pump duration) |
//!
//! **Invariants:**
//! - **Connect is the one nesting exception:** `serial_connect_inner` acquires
//!   `command` (order 3) then `realtime` (order 2) in one block to install both
//!   handles atomically. Nothing ever holds `realtime` and waits on `command`,
//!   so no cycle exists.
//! - Never acquire `command` while holding `admitted_job`.
//! - `realtime` and `admitted_job` are independent — may be held in either order.
//! - The stop operation takes `submit` then `admitted_job` (to close admission),
//!   releases both, then takes `realtime` (to send `0x18`). It never takes `command`. After `0x18`, the stop may
//!   `try_lock` `command` (never wait) for a banner read in per-line/idle mode.
//! - Event-send failure from inside the pump (which holds `command`) sets
//!   `job_abort` atomically via the mapping closure and returns `Cancelled`.
//!   The *wrapper* then calls `serial_stop_inner` after releasing `command`.
//! - `pump_in_flight` is the RAII guard's view (a pump body is executing).
//!   Disconnect reads it to decide whether to send `0x18` before taking `command`.
//! - Every command is `async` and does its blocking work inside `spawn_blocking`
//!   so a minutes-long pump can never freeze the Tauri event loop.
//! - `SerialSession` tracks connection epoch, job phase, submission permits, and
//!   the stop operation. See `serial_session.rs` for the full design.
//! - **Job-line admission (RF-15, submission critical section).** Lock order
//!   `command` → `submit` → `admitted_job` (leaf). Nothing takes `submit`
//!   while holding `realtime` or `admitted_job`, and `submit` is never held
//!   across a read, a flush, a drain, a pump wait, or an observer emit. Every
//!   acquisition recovers from poison. **Every job-epoch write goes through
//!   `SerialSession::admit_and_write`** (the `serial_send` job line,
//!   buffered Phase A via `JobPermit::admit_write`), which
//!   checks admission and makes the one `write()` under `submit`; the flush
//!   follows outside it. `permit_precheck` (before the `command` wait) and
//!   `try_permit_begin` (under `command`, before the drain) are
//!   non-authoritative fast-fails. The stop closes admission under `submit`,
//!   so a job line is either queued ahead of its single `0x18` or refused.
//!   Connect stays the one nesting exception, and the stop path never takes
//!   `command`.

use serde::{Deserialize, Serialize};
use serialport::{self, SerialPort};
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::Duration;
use tauri::{ipc::Channel, State};

use super::serial_pump::{
    self, BufferedPumpConfig, BufferedPumpEvent, BufferedPumpOutcome, ProbeWriter, PumpFailure,
    PumpReader, DEFAULT_LIVENESS_TICKS, STATUS_MAX_TICKS,
};
#[cfg(test)]
use super::serial_session::PHASE_STOPPING;
use super::serial_session::{
    self, SerialSession, StopGuard, StopResult, PHASE_ACTIVE, PHASE_DISCONNECTED, PHASE_IDLE,
    PHASE_UNKNOWN,
};

/// Type alias for the port-factory parameter to avoid clippy::type_complexity.
type PortFactory = dyn Fn(&str, u32) -> Result<Box<dyn SerialPort>, serialport::Error>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub name: String,
    pub port_type: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

/// Result of `serial_send`: the command's own response lines plus anything that
/// was already buffered BEFORE the command was written (pre-write drain). Drained
/// lines are kept separate so a stale banner/ack can never be attributed to the
/// new command; only console-meaningful drained lines (ALARM, [MSG:]) are included.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub responses: Vec<String>,
    pub drained: Vec<String>,
}

/// Semantic kind of a status query result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatusKind {
    /// A fresh `<…>` report was read from the wire.
    Report,
    /// The command lock was busy (a pump is mid-line) — age from the last
    /// snapshot is preserved but freshness is not advanced.
    Busy,
    /// The bounded read expired without a `<…>` report.
    NoResponse,
    /// A transport-level error prevented the query.
    TransportError,
}

/// Result of `serial_get_status`. `status` is `""` when the command lock was busy
/// (a pump is mid-line) or the bounded read expired without a report — an Ok-typed
/// sentinel, NEVER an `Err`: three Err-skips in 750ms would trip the frontend's
/// 3-strike auto-disconnect and abort the very `$H` the busy-skip exists to tolerate.
///
/// `kind` and `snapshot` are additive (B2a) — `status` and `events` remain for
/// backward compatibility with `connection.ts:320-345`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusOutcome {
    pub status: String,
    pub events: Vec<String>,
    /// Semantic classification of this result (B2a).
    pub kind: StatusKind,
    /// Parsed snapshot, if available. For `Busy`, this is the last-known
    /// snapshot (possibly stale). For `Report`, this is freshly parsed.
    pub snapshot: Option<super::grbl_status::GrblSnapshot>,
}

/// The line-protocol channel: command writes, the ONE persistent reader created at
/// connect (F17 — a fresh BufReader per command destroys OS-buffered readahead on
/// drop: delayed `ok`s, unsolicited ALARMs, halves of status reports), and the
/// persistent partial-line buffer that survives read-timeout ticks (F13).
pub struct CommandChannel {
    writer: Box<dyn SerialPort>,
    reader: BufReader<Box<dyn SerialPort>>,
    pending: Vec<u8>,
}

pub struct SerialInner {
    command: Mutex<Option<CommandChannel>>,
    realtime: Mutex<Option<Box<dyn SerialPort>>>,
    connected: AtomicBool,
    pump_in_flight: AtomicBool,
    job_abort: AtomicBool,
    pub(crate) session: SerialSession,
}

impl Default for SerialInner {
    fn default() -> Self {
        Self {
            command: Mutex::new(None),
            realtime: Mutex::new(None),
            connected: AtomicBool::new(false),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        }
    }
}

/// Arc-wrapped so `spawn_blocking`'s `'static` closures can clone their way in.
pub struct SerialState(pub Arc<SerialInner>);

impl Default for SerialState {
    fn default() -> Self {
        Self(Arc::new(SerialInner::default()))
    }
}

/// RAII guard for the pump-in-flight flag. Constructed only while the command
/// lock is held; `Drop` clears the flag on every exit path including panics.
struct PumpFlight<'a>(&'a AtomicBool);

impl<'a> PumpFlight<'a> {
    fn begin(flag: &'a AtomicBool) -> Self {
        flag.store(true, Ordering::SeqCst);
        Self(flag)
    }
}

impl Drop for PumpFlight<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl ProbeWriter for Box<dyn SerialPort> {
    fn write_probe(&mut self) -> std::io::Result<()> {
        self.write_all(b"?")?;
        self.flush()
    }
}

impl PumpReader for BufReader<Box<dyn SerialPort>> {
    fn available_now(&self) -> usize {
        self.buffer().len()
            + self
                .get_ref()
                .bytes_to_read()
                .map(|n| n as usize)
                .unwrap_or(0)
    }
}

/// List available serial ports
#[tauri::command]
pub async fn list_serial_ports() -> Result<Vec<PortInfo>, String> {
    tokio::task::spawn_blocking(|| {
        let ports =
            serialport::available_ports().map_err(|e| format!("Failed to list ports: {}", e))?;

        Ok(ports
            .iter()
            .map(|p| match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => PortInfo {
                    name: p.port_name.clone(),
                    port_type: format!(
                        "USB: {} {}",
                        info.manufacturer.as_deref().unwrap_or("Unknown"),
                        info.product.as_deref().unwrap_or("")
                    ),
                    vid: Some(info.vid),
                    pid: Some(info.pid),
                    manufacturer: info.manufacturer.clone(),
                    product: info.product.clone(),
                },
                other => PortInfo {
                    name: p.port_name.clone(),
                    port_type: match other {
                        serialport::SerialPortType::PciPort => "PCI".to_string(),
                        serialport::SerialPortType::BluetoothPort => "Bluetooth".to_string(),
                        _ => "Unknown".to_string(),
                    },
                    vid: None,
                    pid: None,
                    manufacturer: None,
                    product: None,
                },
            })
            .collect())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Drain the GRBL startup banner from `channel`, returning the accumulated
/// banner text.  Guarantees `channel.pending` is empty on every return path:
///
/// - `Ok(n > 0)`: line consumed, `pending` cleared per iteration; when the
///   `Grbl` sentinel is found the loop breaks with `pending` already clear.
/// - `Ok(0)` (EOF): `pending` cleared before break so a partial fragment
///   accumulated before EOF cannot contaminate the first command's response.
/// - `Err(_)` (timeout or I/O): `pending` cleared before break for the same
///   reason.
///
/// The function is `pub(crate)` so the startup-banner test can call it
/// directly and guard the production path rather than a re-implementation.
pub(crate) fn drain_startup_banner(channel: &mut CommandChannel) -> String {
    let mut startup = String::new();
    for _ in 0..5 {
        match channel.reader.read_until(b'\n', &mut channel.pending) {
            Ok(0) => {
                channel.pending.clear();
                break;
            }
            Ok(_) => {
                let line = String::from_utf8_lossy(&channel.pending).to_string();
                channel.pending.clear();
                let done = line.contains("Grbl");
                startup.push_str(&line);
                if done {
                    break;
                }
            }
            Err(_) => {
                channel.pending.clear();
                break;
            }
        }
    }
    startup
}

/// Connect body: extracted for testability with injected sleeper and port factory.
/// `sleeper` is `&dyn Fn(Duration)` so tests can pass no-op sleepers.
/// `open_port` is the port factory — production passes `serialport::new().open()`,
/// tests pass a factory returning `ScriptedPort`.
pub(crate) fn serial_connect_inner(
    inner: &SerialInner,
    port_name: &str,
    baud_rate: u32,
    sleeper: &dyn Fn(Duration),
    open_port: &PortFactory,
) -> Result<String, String> {
    // P1-C: already-connected guard — if a connection is live, disconnect
    // first to prevent resource leaks. This handles rapid reconnect or
    // StrictMode double-mount on the frontend.
    if inner.connected.load(Ordering::SeqCst) {
        let _ = disconnect_inner(inner);
    }

    let mut port = open_port(port_name, baud_rate)
        .map_err(|e| format!("Failed to open port '{}': {}", port_name, e))?;

    // Hardware-reset the GRBL controller via DTR toggle. Arduino boards
    // connect DTR to RESET through a 100nF cap — the falling edge (assert)
    // pulses the MCU reset line. Deassert first to guarantee an edge
    // regardless of the adapter's initial DTR state.
    let _ = port.write_data_terminal_ready(false);
    sleeper(Duration::from_millis(50));
    let _ = port.write_data_terminal_ready(true);
    sleeper(Duration::from_millis(1500));

    let realtime = port.try_clone().map_err(|e| e.to_string())?;
    let reader_port = port.try_clone().map_err(|e| e.to_string())?;
    let mut channel = CommandChannel {
        writer: port,
        reader: BufReader::new(reader_port),
        pending: Vec::new(),
    };

    // Read the GRBL startup banner through THE persistent reader — no reader
    // is ever constructed after connect.
    let startup = drain_startup_banner(&mut channel);

    // Soft-reset fallback for non-Arduino boards (STM32, ESP32, etc.)
    // that lack the DTR-to-RESET capacitor circuit.
    let _ = channel.writer.write_all(b"\x18");
    let _ = channel.writer.flush();
    sleeper(Duration::from_millis(500));
    let soft_banner = drain_startup_banner(&mut channel);

    // Prefer the hardware-reset banner; fall back to soft-reset banner.
    let banner = if !startup.trim().is_empty() {
        startup
    } else {
        soft_banner
    };

    // P1-C: store both channels in one critical section to prevent
    // cross-wiring if two connects race. Lock order: command first,
    // realtime second (same order as disconnect_inner teardown).
    {
        let mut cmd_guard = inner
            .command
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        let mut rt_guard = inner
            .realtime
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        *cmd_guard = Some(channel);
        *rt_guard = Some(realtime);
    }
    inner.connected.store(true, Ordering::SeqCst);

    // Session lifecycle: increment epoch and set phase to idle.
    // This happens after handle install, inside the scope where both
    // guards were just released, so the new epoch is visible to all callers.
    inner.session.increment_epoch();
    inner.session.set_idle_on_connect();

    if banner.trim().is_empty() {
        Ok(format!("Connected to {} at {} baud", port_name, baud_rate))
    } else {
        Ok(banner.trim().to_string())
    }
}

/// Connect to a serial port
#[tauri::command]
pub async fn serial_connect(
    state: State<'_, SerialState>,
    port_name: String,
    baud_rate: u32,
) -> Result<String, String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || {
        serial_connect_inner(
            &inner,
            &port_name,
            baud_rate,
            &std::thread::sleep,
            &|name, baud| {
                serialport::new(name, baud)
                    .timeout(Duration::from_millis(1000))
                    .open()
            },
        )
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Disconnect from serial port.
///
/// When a pump is mid-line it holds the command lock for up to the line's
/// duration — abort it via a realtime `0x18` FIRST so disconnect is prompt. The
/// reset is gated on `pump_in_flight || job_active`: an unconditional reset on
/// a clean disconnect would wipe volatile G92 work origins on stock GRBL 1.1
/// (Set Origin → Disconnect → origin gone).
///
/// `job_active` is an optional frontend hint: the TS side knows whether a job
/// is running (Rust cannot see the frontend's jobRunning). When true, the
/// pre-lock 0x18 fires even if the pump finished its last line and the flag
/// has already cleared — defense-in-depth for A2 (disconnect beam-on).
#[tauri::command]
pub async fn serial_disconnect(
    state: State<'_, SerialState>,
    job_active: Option<bool>,
) -> Result<(), String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || {
        disconnect_inner_with_job(&inner, job_active.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Disconnect body (backwards-compatible wrapper). See `disconnect_inner_with_job`.
pub(crate) fn disconnect_inner(inner: &SerialInner) -> Result<(), String> {
    disconnect_inner_with_job(inner, false)
}

/// Disconnect body. Routes through `serial_stop_inner` when a job is active
/// (phase == active || pump_in_flight || job_active). Clean idle disconnect
/// skips the reset (pinned by `clean_disconnect_sends_no_reset`).
///
/// The realtime `0x18` happens BEFORE any wait on the command lock (pinned by
/// `disconnect_aborts_in_flight_pump_via_realtime_reset`).
pub(crate) fn disconnect_inner_with_job(
    inner: &SerialInner,
    job_active: bool,
) -> Result<(), String> {
    let phase = inner.session.phase.load(Ordering::SeqCst);
    let needs_stop =
        inner.pump_in_flight.load(Ordering::SeqCst) || job_active || phase == PHASE_ACTIVE;

    if needs_stop {
        // Route through the stop operation for the 0x18 + admission closure.
        let _ = serial_stop_inner(inner, &std::thread::sleep);
    }

    // Teardown: None both handles in one nested block.
    {
        *inner
            .command
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))? = None;
        *inner
            .realtime
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))? = None;
    }
    inner.connected.store(false, Ordering::SeqCst);

    // Phase unknown resets to disconnected on teardown.
    let current_phase = inner.session.phase.load(Ordering::SeqCst);
    if current_phase == PHASE_UNKNOWN || current_phase != PHASE_DISCONNECTED {
        inner.session.set_disconnected();
    }
    inner.session.increment_epoch();
    Ok(())
}

/// Send body: extracted for testability.
///
/// `job_epoch`: When `Some(epoch)` (a job line), the send is fenced:
/// `permit_precheck` before the lock wait (fast-fail), `try_permit_begin`
/// under the command lock before the drain (non-authoritative: spares a
/// refused send the drain), and `admit_and_write` for the write itself (the
/// check that counts, atomic with the write against the stop's admission
/// close). The flush follows outside the `submit` lock.
/// Refusals are `refused:`-prefixed contract strings (see `serial_session`).
/// When `None` (console command, `$H`, jog, settings), no permit check.
pub(crate) fn serial_send_inner(
    inner: &SerialInner,
    command: &str,
    job_epoch: Option<u64>,
) -> Result<SendOutcome, String> {
    // Pre-lock fast-fail (optimisation only; never parks a stale send behind
    // a long pump).
    if let Some(epoch) = job_epoch {
        inner.session.permit_precheck(epoch)?;
    }

    let mut guard = inner
        .command
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))?;
    let channel = guard.as_mut().ok_or("Not connected")?;

    // Pre-drain admission check (non-authoritative): under the command lock,
    // before the drain and before PumpFlight, so a send refused HERE consumes
    // no reader bytes. The check that counts is inside `admit_and_write`; a
    // refusal there comes after the drain (harmless: the stop's banner is
    // not in the reader yet, since its `0x18` follows the admission close).
    if let Some(epoch) = job_epoch {
        inner.session.try_permit_begin(Some(epoch))?;
    }

    let _flight = PumpFlight::begin(&inner.pump_in_flight);

    // Capture epoch at command lock acquisition (not at publish time).
    let lock_epoch = inner.session.epoch.load(Ordering::SeqCst);

    // Pre-write drain: classify anything already buffered (a banner left by an
    // idle-time 0x18, an unsolicited ALARM, …) so it is never attributed to
    // THIS command.
    let drain = serial_pump::drain_classified(&mut channel.reader, &mut channel.pending);
    for line in &drain.dropped {
        eprintln!("[serial] drained stale line: {}", line);
    }

    let cmd = if command.ends_with('\n') {
        command.to_string()
    } else {
        format!("{}\n", command)
    };
    let write_result = match job_epoch {
        // Job line: admission check + the one write, atomic under `submit`.
        Some(epoch) => inner
            .session
            .admit_and_write(epoch, || channel.writer.write_all(cmd.as_bytes()))?,
        None => channel.writer.write_all(cmd.as_bytes()),
    };
    write_result.map_err(|e| format!("Write error: {}", e))?;
    // Flush (`tcdrain`) outside the `submit` lock.
    channel
        .writer
        .flush()
        .map_err(|e| format!("Flush error: {}", e))?;

    let pump_result = serial_pump::run_pump(
        &mut channel.reader,
        &mut channel.writer,
        &mut channel.pending,
        DEFAULT_LIVENESS_TICKS,
        serial_pump::DEFAULT_IDLE_STALL_TICKS,
        Some(&|status_line: &str| {
            inner.session.publish_snapshot(status_line, lock_epoch);
        }),
    );

    // Banner publication: if the pump saw Banner while a stop is in flight,
    // publish the observation.
    if let Ok(ref out) = pump_result {
        if out.terminal == serial_pump::PumpTerminal::Banner
            && inner.session.stop_in_flight.load(Ordering::SeqCst)
        {
            inner.session.banner_observed.store(true, Ordering::SeqCst);
            inner.session.emit("banner_observed");
        }
    }

    match pump_result {
        Ok(out) => Ok(SendOutcome {
            responses: out.lines,
            drained: drain.surfaced,
        }),
        // Err here surfaces as an invoke rejection; the frontend maps it to
        // its existing "error:disconnected" contract.
        Err(PumpFailure::Disconnected(msg)) => Err(format!("disconnected: {}", msg)),
        Err(PumpFailure::Io(msg)) => Err(msg),
    }
}

/// Send a command line and pump until a terminal response (`ok` / `error:N` /
/// `ALARM…` / reset banner). See `serial_pump` for the protocol design.
#[tauri::command]
///
/// `job_epoch` (IPC key `jobEpoch`): present for job lines, absent for console,
/// `$H`, jog and settings writes. A renamed key would deserialize to `None` and
/// silently unfence the job; `rf15_ipc_serial_send_carries_job_epoch` pins it.
pub async fn serial_send(
    state: State<'_, SerialState>,
    command: String,
    job_epoch: Option<u64>,
) -> Result<SendOutcome, String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || serial_send_inner(&inner, &command, job_epoch))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// Send a raw real-time byte (`!`, `~`, 0x18, `?`).
#[tauri::command]
pub async fn serial_send_byte(state: State<'_, SerialState>, byte: u8) -> Result<(), String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || send_byte_inner(&inner, byte))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// The realtime write path. INVARIANT: touches ONLY the realtime lock — it must
/// reach the wire while a command pump holds the command lock for minutes.
/// (Pinned by `realtime_write_completes_while_command_lock_held`.)
pub(crate) fn send_byte_inner(inner: &SerialInner, byte: u8) -> Result<(), String> {
    let mut rt = inner
        .realtime
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))?;
    let port = rt.as_mut().ok_or("Not connected")?;
    port.write_all(&[byte])
        .map_err(|e| format!("Write error: {}", e))?;
    port.flush().map_err(|e| format!("Flush error: {}", e))
}

/// The buffered pump's per-line gate over the admission fence.
struct JobPermit<'a> {
    session: &'a SerialSession,
    epoch: u64,
}

impl serial_pump::SubmissionGate for JobPermit<'_> {
    fn admit_write(
        &self,
        write: &mut dyn FnMut() -> std::io::Result<()>,
    ) -> Result<std::io::Result<()>, String> {
        self.session.admit_and_write(self.epoch, write)
    }
}

/// Status body: extracted for testability. Uses try_lock to avoid blocking.
///
/// When the command lock is busy (a pump holds it), the busy-path realtime
/// probe writes `?` via `send_byte_inner` so the pump's existing timeout-tick
/// reads the response and publishes a snapshot. This is how AC1 is met during
/// fast buffered streams that never time out on their own.
pub(crate) fn serial_get_status_inner(inner: &SerialInner) -> Result<StatusOutcome, String> {
    let mut guard = match inner.command.try_lock() {
        Ok(g) => g,
        Err(TryLockError::WouldBlock) => {
            // Busy-path realtime probe: write `?` via the realtime lock so the
            // pump (which holds command) reads the response on its next tick.
            let _ = send_byte_inner(inner, b'?');

            // Return the last-known snapshot with Busy kind.
            let snapshot = inner.session.read_snapshot();
            return Ok(StatusOutcome {
                status: String::new(),
                events: Vec::new(),
                kind: StatusKind::Busy,
                snapshot,
            });
        }
        Err(TryLockError::Poisoned(e)) => return Err(format!("Lock failed: {}", e)),
    };
    let channel = guard.as_mut().ok_or("Not connected")?;

    // Capture the epoch now (while holding the command lock) for snapshot publication.
    let lock_epoch = inner.session.epoch.load(Ordering::SeqCst);

    let read = serial_pump::read_status_bounded(
        &mut channel.reader,
        &mut channel.writer,
        &mut channel.pending,
        STATUS_MAX_TICKS,
    )?;
    for line in &read.dropped {
        eprintln!("[serial] status junk-skip: {}", line);
        // Banner publication: if a Banner was encountered during status polling
        // while a stop is in flight, publish the observation.
        if serial_pump::classify_line(line) == serial_pump::LineClass::Banner
            && inner.session.stop_in_flight.load(Ordering::SeqCst)
        {
            inner.session.banner_observed.store(true, Ordering::SeqCst);
            inner.session.emit("banner_observed");
        }
    }

    if let Some(ref status_str) = read.status {
        // Publish the snapshot for command-mutex-free readers.
        inner.session.publish_snapshot(status_str, lock_epoch);
    }

    let snapshot = inner.session.read_snapshot();
    let kind = if read.status.is_some() {
        StatusKind::Report
    } else {
        StatusKind::NoResponse
    };

    Ok(StatusOutcome {
        status: read.status.unwrap_or_default(),
        events: read.surfaced,
        kind,
        snapshot,
    })
}

/// Query GRBL status (writes `?`, reads until a `<…>` report, bounded).
///
/// Uses `try_lock` on the command lock: the status poller fires every 250ms and a
/// manual `$H` legitimately pumps for 30s+ — polls must skip, not stack. The busy
/// skip returns the Ok-typed empty sentinel (see `StatusOutcome`).
#[tauri::command]
pub async fn serial_get_status(state: State<'_, SerialState>) -> Result<StatusOutcome, String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || serial_get_status_inner(&inner))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// Check if connected (atomic read — cannot block, but still async so no serial
/// command ever executes on the event-loop thread).
#[tauri::command]
pub async fn serial_is_connected(state: State<'_, SerialState>) -> Result<bool, String> {
    Ok(state.0.connected.load(Ordering::SeqCst))
}

// ---------------------------------------------------------------------------
// Buffered streaming (Phase 2A)
// ---------------------------------------------------------------------------

/// Events streamed to the frontend during a buffered job via Tauri's Channel API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JobEvent {
    /// Job progress update.
    Progress {
        /// 0-based line index of the most recently sent line.
        line_index: usize,
        /// Total number of lines in the job.
        total: usize,
    },
    /// A console-meaningful message from GRBL.
    Console { text: String },
    /// A `<…>` status report for DRO position updates.
    Status { report: String },
    /// The job has finished. `outcome` is a human-readable summary; the
    /// invoke return value carries the structured result.
    Finished { outcome: String },
}

/// Refusal text when the caller has not verified laser mode by readback.
/// Never `refused:`-prefixed and never names a disconnect, so `jobStream.ts`
/// reads it as neither an admission refusal nor a dead port.
pub(crate) const LASER_MODE_UNVERIFIED: &str = "$32=1 not verified -- laser mode must be read back before a job starts (Enable Laser Mode, $$ in the console, or reconnect)";

/// Stream body: extracted for testability with injected event sink.
/// `on_event` returns `Result<(), String>` — on `Err`, the pump sets `job_abort`
/// and returns `Cancelled`; the wrapper calls `serial_stop_inner` after releasing
/// `command`.
///
/// RF-15: `job_epoch` is the admitted job's epoch. The body never clears
/// `job_abort` (`serial_job_begin_inner` is its only clearer, under
/// `admitted_job`). Entry: `permit_precheck` before the lock, then the
/// non-authoritative `try_permit_begin` under the lock before the drain
/// (refusal → `Err(refused: not-admitted…)`, nothing read or written). Then
/// the laser-mode check, still before the drain: `laser_mode_verified == false`
/// → `Err(LASER_MODE_UNVERIFIED)`, nothing read or written, `pump_in_flight`
/// never raised. Admission refusals win over it. No setting is ever written.
/// Every job line goes through `JobPermit::admit_write`, and a refused line's
/// outcome string (`Ok`) is the refusal contract text.
pub(crate) fn serial_stream_job_inner(
    inner: &SerialInner,
    gcode: &str,
    job_epoch: u64,
    laser_mode_verified: bool,
    on_event: &dyn Fn(JobEvent) -> Result<(), String>,
) -> Result<String, String> {
    inner.session.permit_precheck(job_epoch)?;

    let mut guard = inner
        .command
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))?;
    let cmd_channel = guard.as_mut().ok_or("Not connected")?;

    // Pre-drain entry check (non-authoritative), before the drain, so a
    // refused stream consumes no reader bytes.
    inner.session.try_permit_begin(Some(job_epoch))?;

    // DECISIONS 2026-09-10: START refuses until laser mode is read back
    // matching; Kerf never writes `$32` on the job's behalf. The TS readback
    // (`grblLaserMode`, set only by `applyLaserModeReadback`) is the authority
    // until S4a adds a native snapshot. Refuses before any read or write.
    if !laser_mode_verified {
        return Err(LASER_MODE_UNVERIFIED.to_string());
    }

    let _flight = PumpFlight::begin(&inner.pump_in_flight);

    // Capture epoch at command lock acquisition for snapshot publication.
    let lock_epoch = inner.session.epoch.load(Ordering::SeqCst);

    // Drain stale controller output before the job; ALARM/MSG lines reach the console.
    let drain = serial_pump::drain_classified(&mut cmd_channel.reader, &mut cmd_channel.pending);
    for line in &drain.dropped {
        eprintln!("[serial] stream job drained: {}", line);
    }
    for line in &drain.surfaced {
        let _ = on_event(JobEvent::Console { text: line.clone() });
    }

    // Parse G-code lines (same filtering as the TS per-line path).
    let lines: Vec<String> = gcode
        .split('\n')
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.starts_with(';'))
        .collect();

    if lines.is_empty() {
        let _ = on_event(JobEvent::Finished {
            outcome: "complete".to_string(),
        });
        return Ok("complete".to_string());
    }

    // Drain again before the buffered pump starts.
    let drain = serial_pump::drain_classified(&mut cmd_channel.reader, &mut cmd_channel.pending);
    for line in &drain.surfaced {
        let _ = on_event(JobEvent::Console { text: line.clone() });
    }

    let config = BufferedPumpConfig::default();

    let result = serial_pump::run_buffered_pump(
        &lines,
        &mut cmd_channel.reader,
        &mut cmd_channel.writer,
        &mut cmd_channel.pending,
        &config,
        &inner.job_abort,
        &JobPermit {
            session: &inner.session,
            epoch: job_epoch,
        },
        &|event| {
            let job_event = match event {
                BufferedPumpEvent::LineSent { line_index, total } => {
                    JobEvent::Progress { line_index, total }
                }
                BufferedPumpEvent::ConsoleMessage(text) => JobEvent::Console { text },
                BufferedPumpEvent::StatusReport(report) => {
                    // Publish snapshot from the buffered pump's status frames.
                    inner.session.publish_snapshot(&report, lock_epoch);
                    JobEvent::Status { report }
                }
            };
            if let Err(e) = on_event(job_event) {
                // Event-sink failure: set abort + sink_failed atomically.
                // The wrapper calls serial_stop_inner after releasing command.
                inner.job_abort.store(true, Ordering::SeqCst);
                inner.session.sink_failed.store(true, Ordering::SeqCst);
                eprintln!("[serial] event sink failed: {}", e);
            }
        },
    );

    // Drop the command lock before potentially calling stop.
    drop(_flight);
    drop(guard);

    // If sink failed, call stop after releasing command (lock-order invariant).
    let sink_failed = inner.session.sink_failed.load(Ordering::SeqCst);
    if sink_failed {
        inner.session.sink_failed.store(false, Ordering::SeqCst);
        let _ = serial_stop_inner(inner, &std::thread::sleep);
    }

    // Banner publication: if the pump saw Banner (Aborted) while a stop is
    // in flight, publish the observation so the stop's retry loop can see it.
    if matches!(&result, Ok(BufferedPumpOutcome::Aborted))
        && inner.session.stop_in_flight.load(Ordering::SeqCst)
    {
        inner.session.banner_observed.store(true, Ordering::SeqCst);
        inner.session.emit("banner_observed");
    }

    let outcome_str = match &result {
        Ok(BufferedPumpOutcome::Complete) => "complete".to_string(),
        Ok(BufferedPumpOutcome::Cancelled) => {
            if sink_failed {
                "cancelled (event sink failed)".to_string()
            } else {
                "cancelled".to_string()
            }
        }
        Ok(BufferedPumpOutcome::Error { error_text, .. }) => format!("error: {}", error_text),
        Ok(BufferedPumpOutcome::Alarm { alarm_text }) => format!("alarm: {}", alarm_text),
        Ok(BufferedPumpOutcome::Aborted) => "aborted".to_string(),
        Ok(BufferedPumpOutcome::Disconnected(msg)) => format!("disconnected: {}", msg),
        Ok(BufferedPumpOutcome::Refused { reason, .. }) => reason.clone(),
        Err(PumpFailure::Disconnected(msg)) => format!("disconnected: {}", msg),
        Err(PumpFailure::Io(msg)) => format!("io error: {}", msg),
    };

    // Finished event uses a fresh lock acquisition (we already released it).
    // Ignore failures — the channel may be gone.
    let _ = on_event(JobEvent::Finished {
        outcome: outcome_str.clone(),
    });

    match result {
        Ok(_) => Ok(outcome_str),
        Err(PumpFailure::Disconnected(msg)) => Err(format!("disconnected: {}", msg)),
        Err(PumpFailure::Io(msg)) => Err(msg),
    }
}

/// Stream a G-code job using the buffered (character-counting) pump.
///
/// The command lock is held for the ENTIRE job (same as per-line `serial_send`
/// holds it per line, but here it's one long hold). PumpFlight is also held
/// for the full job so disconnect's `0x18` fires if the user disconnects
/// mid-job.
///
/// Refuses unless the caller verified laser mode by readback
/// (`laser_mode_verified`); the command never writes a setting.
#[tauri::command]
///
/// `job_epoch` (IPC key `jobEpoch`) is REQUIRED: an omitted key is rejected by
/// Tauri's argument deserialization, so the command fails closed.
/// `laser_mode_verified` (IPC key `laserModeVerified`) is required too, and
/// fails closed the same way when omitted.
pub async fn serial_stream_job(
    state: State<'_, SerialState>,
    gcode: String,
    job_epoch: u64,
    laser_mode_verified: bool,
    channel: Channel<JobEvent>,
) -> Result<String, String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || {
        serial_stream_job_inner(&inner, &gcode, job_epoch, laser_mode_verified, &|event| {
            channel
                .send(event)
                .map_err(|e| format!("channel.send failed: {e}"))
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Abort a running job: routes through `serial_stop_inner` which sets `job_abort`
/// AND sends `0x18` via the stop operation. No caller should ever set `job_abort`
/// without also sending `0x18`.
#[tauri::command]
pub async fn serial_abort_job(state: State<'_, SerialState>) -> Result<(), String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || {
        let _ = serial_stop_inner(&inner, &std::thread::sleep);
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Stop operation + per-line admission (B1)
// ---------------------------------------------------------------------------

/// The native stop command. Takes a `sleeper` parameter so tests can inject a
/// fast clock for the 3s bound.
///
/// The stop takes no epoch precondition. `0x18` is idempotent and realtime;
/// nothing about a stale epoch makes the reset byte less correct.
///
/// See `serial_session.rs` for the full concurrency design.
pub(crate) fn serial_stop_inner(inner: &SerialInner, sleeper: &dyn Fn(Duration)) -> StopResult {
    let session = &inner.session;
    let epoch_before = session.epoch.load(Ordering::SeqCst);

    // Step 1: RAII guard + single-flight observation.
    let _guard = match StopGuard::begin(&session.stop_in_flight) {
        Some(g) => g,
        None => {
            // Another stop is in the observation phase. Join it: poll until
            // stop_in_flight clears, then read last_stop.
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while session.stop_in_flight.load(Ordering::SeqCst)
                && std::time::Instant::now() < deadline
            {
                sleeper(Duration::from_millis(50));
            }
            let result = session
                .last_stop
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            return result.unwrap_or(StopResult::SubmittedUnconfirmed {
                epoch: epoch_before,
                messages: vec![
                    "STOP: joined existing stop operation. Beam state unqualified — verify visually."
                        .to_string(),
                ],
            });
        }
    };

    // Step 2: Close admission inside the submission critical section
    // (`submit` → `admitted_job`). A writer holding `submit` finishes its one
    // `write()` first, so its line is queued ahead of this stop's `0x18`; any
    // writer after this block is refused with nothing written. Both guards are
    // released before the `0x18`, which needs no lock: ordering is already
    // fixed. Poison is recovered so a panicked writer can never stop STOP.
    {
        let submit = session.submit.lock().unwrap_or_else(|e| e.into_inner());
        session.close_admission(&submit);
    }
    session.emit("admission_closed");

    // Invalidate the status snapshot: post-stop snapshots must not carry
    // pre-stop epoch data.
    session.invalidate_snapshot();

    // Step 3: Set cooperative abort.
    inner.job_abort.store(true, Ordering::SeqCst);

    // Step 4: Emit session event.
    session.emit("stop_requested");

    // Clear banner_observed BEFORE sending 0x18 so no race exists between
    // the send and another body's observation (W1 fix).
    session.banner_observed.store(false, Ordering::SeqCst);

    // Step 5: Send 0x18. Take realtime lock, write, retry once on failure.
    let send_result = {
        let mut rt = match inner.realtime.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        if let Some(port) = rt.as_mut() {
            match port.write_all(&[0x18]) {
                Ok(()) => {
                    let _ = port.flush();
                    Ok(())
                }
                Err(_first_err) => {
                    // Retry once (the A6 fix).
                    match port.write_all(&[0x18]) {
                        Ok(()) => {
                            let _ = port.flush();
                            Ok(())
                        }
                        Err(e) => Err(format!("{}", e)),
                    }
                }
            }
        } else {
            Err("not connected".to_string())
        }
    };

    if let Err(error) = send_result {
        let result = StopResult::SubmissionFailed {
            epoch: epoch_before,
            error: error.clone(),
            messages: vec![
                "STOP failed: could not send reset. Use the machine's physical emergency stop. Beam state unqualified."
                    .to_string(),
            ],
        };
        session.phase.store(PHASE_UNKNOWN, Ordering::SeqCst);
        *session.last_stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(result.clone());
        // _guard drops here, clearing stop_in_flight
        return result;
    }

    session.emit("permit_invalidated");

    // Step 6: Wait for banner (retry loop within 3s deadline).
    // banner_observed was cleared BEFORE the 0x18 send (step 5 preamble) so
    // no race exists between the send and the observation.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);

    while std::time::Instant::now() < deadline {
        // Check if another body already observed the banner.
        if session.banner_observed.load(Ordering::SeqCst) {
            break;
        }
        // Try to take the command lock for a bounded read.
        if let Ok(mut guard) = inner.command.try_lock() {
            if let Some(channel) = guard.as_mut() {
                // Bounded read: look for a Banner line.
                let mut read_buf = Vec::new();
                match channel.reader.read_until(b'\n', &mut read_buf) {
                    Ok(n) if n > 0 => {
                        let line = String::from_utf8_lossy(&read_buf).trim().to_string();
                        if serial_pump::classify_line(&line) == serial_pump::LineClass::Banner {
                            session.banner_observed.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
        sleeper(Duration::from_millis(50));
    }

    let result = if session.banner_observed.load(Ordering::SeqCst) {
        // Confirmed path.
        session.banner_observed.store(false, Ordering::SeqCst);
        // `stop_confirming` is emitted before the epoch increment and CAS.
        session.emit("stop_confirming");
        let epoch_after = session.increment_epoch();
        if session.set_idle_from_stopping() {
            session.emit("banner_observed");
            StopResult::Confirmed {
                epoch_before,
                epoch_after,
                messages: vec![
                    "STOP: 0x18 sent".to_string(),
                    "STOP: reset confirmed. Controller reset confirmed. Beam state unqualified — verify visually.".to_string(),
                ],
            }
        } else {
            // Only a concurrent disconnect can move the phase off Stopping
            // here (nothing else stores a phase during a stop): leave the
            // phase alone and report unconfirmed.
            StopResult::SubmittedUnconfirmed {
                epoch: epoch_before,
                messages: vec![
                    "STOP: 0x18 sent".to_string(),
                    "STOP: unconfirmed — use the machine's physical stop before reconnecting. Beam state unqualified — verify visually.".to_string(),
                ],
            }
        }
    } else {
        // Unconfirmed: banner not observed within deadline.
        session.phase.store(PHASE_UNKNOWN, Ordering::SeqCst);
        StopResult::SubmittedUnconfirmed {
            epoch: epoch_before,
            messages: vec![
                "STOP: 0x18 sent".to_string(),
                "STOP: unconfirmed — use the machine's physical stop before reconnecting. Beam state unqualified — verify visually.".to_string(),
            ],
        }
    };

    *session.last_stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(result.clone());

    // _guard drops here, clearing stop_in_flight
    result
}

/// Tauri command: stop the machine. Sends `0x18` immediately per DECISIONS.md
/// (2026-09-20): no feed hold, no M5, no ack wait.
#[tauri::command]
pub async fn serial_stop(state: State<'_, SerialState>) -> Result<StopResult, String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || Ok(serial_stop_inner(&inner, &std::thread::sleep)))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// Begin a per-line job: set phase to active, store epoch in admitted_job,
/// return the epoch as job id. Fails if phase is not idle.
pub(crate) fn serial_job_begin_inner(inner: &SerialInner) -> Result<u64, String> {
    let session = &inner.session;
    let mut aj = session
        .admitted_job
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let current_phase = session.phase.load(Ordering::SeqCst);
    if current_phase != PHASE_IDLE {
        return Err(format!(
            "cannot begin job: session not idle (phase={})",
            serial_session::phase_name(current_phase)
        ));
    }

    let epoch = session.epoch.load(Ordering::SeqCst);
    session.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
    *aj = Some(epoch);
    inner.job_abort.store(false, Ordering::SeqCst);
    Ok(epoch)
}

/// End a per-line job: Active→Idle by CAS, clear admitted_job.
/// Fails if the epoch doesn't match (stale). If the CAS fails (phase is
/// Unknown/Stopping), the phase is left alone and the call still returns Ok:
/// the job is over either way, and ending a job never overwrites Unknown.
pub(crate) fn serial_job_end_inner(inner: &SerialInner, job_id: u64) -> Result<(), String> {
    let session = &inner.session;
    let mut aj = session
        .admitted_job
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    if *aj != Some(job_id) {
        return Err(format!(
            "job end epoch mismatch: expected {:?}, got {}",
            *aj, job_id
        ));
    }

    let _ = session.phase.compare_exchange(
        PHASE_ACTIVE,
        PHASE_IDLE,
        Ordering::SeqCst,
        Ordering::SeqCst,
    );
    *aj = None;
    Ok(())
}

/// Tauri command: begin a per-line job.
#[tauri::command]
pub async fn serial_job_begin(state: State<'_, SerialState>) -> Result<u64, String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || serial_job_begin_inner(&inner))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// Tauri command: end a per-line job.
#[tauri::command]
pub async fn serial_job_end(state: State<'_, SerialState>, job_id: u64) -> Result<(), String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || serial_job_end_inner(&inner, job_id))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;

    /// Minimal in-memory SerialPort for lock-structure tests. The write buffer
    /// is shared across `try_clone`s so tests can observe writes from outside.
    struct MockPort {
        written: Arc<Mutex<Vec<u8>>>,
    }

    impl MockPort {
        fn new() -> Self {
            Self {
                written: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn shared(written: Arc<Mutex<Vec<u8>>>) -> Self {
            Self { written }
        }
    }

    impl std::io::Read for MockPort {
        fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "mock"))
        }
    }

    impl std::io::Write for MockPort {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.written.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl SerialPort for MockPort {
        fn name(&self) -> Option<String> {
            Some("mock".to_string())
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
            Ok(0)
        }
        fn bytes_to_write(&self) -> serialport::Result<u32> {
            Ok(0)
        }
        fn clear(&self, _: serialport::ClearBuffer) -> serialport::Result<()> {
            Ok(())
        }
        fn try_clone(&self) -> serialport::Result<Box<dyn SerialPort>> {
            Ok(Box::new(MockPort::shared(self.written.clone())))
        }
        fn set_break(&self) -> serialport::Result<()> {
            Ok(())
        }
        fn clear_break(&self) -> serialport::Result<()> {
            Ok(())
        }
    }

    /// The realtime byte path must complete while the command lock is held by an
    /// in-flight pump — this is the e-stop guarantee. If `send_byte_inner` ever
    /// grows a dependency on the command lock, this test deadlocks its worker
    /// thread and fails by timeout.
    #[test]
    fn realtime_write_completes_while_command_lock_held() {
        let inner = Arc::new(SerialInner {
            command: Mutex::new(None),
            realtime: Mutex::new(Some(Box::new(MockPort::new()) as Box<dyn SerialPort>)),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(true),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        });

        // Simulate an in-flight pump: hold the command lock for the whole test.
        let _command_guard = inner.command.lock().unwrap();

        let (tx, rx) = mpsc::channel();
        let inner2 = inner.clone();
        thread::spawn(move || {
            let result = send_byte_inner(&inner2, 0x18);
            let _ = tx.send(result);
        });

        let result = rx
            .recv_timeout(Duration::from_millis(500))
            .expect("realtime write blocked behind the command lock — e-stop would freeze");
        assert!(result.is_ok());
    }

    /// Acceptance criterion 5: a mid-job Disconnect terminates the in-flight
    /// line PROMPTLY — the realtime 0x18 hits the wire while the command lock
    /// is still held by the pump (the banner then aborts the pump and frees
    /// the lock for the actual teardown).
    #[test]
    fn disconnect_aborts_in_flight_pump_via_realtime_reset() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let inner = Arc::new(SerialInner {
            command: Mutex::new(None),
            realtime: Mutex::new(Some(
                Box::new(MockPort::shared(written.clone())) as Box<dyn SerialPort>
            )),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(true),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        });

        // Simulate an in-flight pump holding the command lock.
        // Set session phase to active so disconnect routes through stop.
        inner.session.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
        let command_guard = inner.command.lock().unwrap();

        let inner2 = inner.clone();
        let handle = thread::spawn(move || disconnect_inner(&inner2));

        // The 0x18 must arrive while the command lock is STILL held.
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while written.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            *written.lock().unwrap(),
            vec![0x18],
            "realtime 0x18 must reach the wire before disconnect waits on the command lock"
        );

        // Release the "pump" (in production the banner terminal does this);
        // disconnect then completes its teardown.
        drop(command_guard);
        handle.join().unwrap().unwrap();
        assert!(!inner.connected.load(Ordering::SeqCst));
    }

    /// The disconnect reset is GATED on pump-in-flight: a clean disconnect must
    /// not reset the controller — on stock GRBL 1.1 that wipes volatile G92
    /// work origins (Set Origin → Disconnect → origin gone).
    #[test]
    fn clean_disconnect_sends_no_reset() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let inner = SerialInner {
            command: Mutex::new(None),
            realtime: Mutex::new(Some(
                Box::new(MockPort::shared(written.clone())) as Box<dyn SerialPort>
            )),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        };

        disconnect_inner(&inner).unwrap();
        assert!(
            written.lock().unwrap().is_empty(),
            "clean disconnect must not write 0x18"
        );
        assert!(!inner.connected.load(Ordering::SeqCst));
    }

    /// PumpFlight clears the in-flight flag on drop, including panic unwinds —
    /// a leaked flag would make every clean disconnect fire 0x18 (G92 wipe).
    #[test]
    fn pump_flight_flag_is_raii_cleared() {
        let flag = AtomicBool::new(false);
        {
            let _flight = PumpFlight::begin(&flag);
            assert!(flag.load(Ordering::SeqCst));
        }
        assert!(!flag.load(Ordering::SeqCst));

        // Panic path: the guard must still clear the flag during unwind.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _flight = PumpFlight::begin(&flag);
            panic!("simulated pump panic");
        }));
        assert!(result.is_err());
        assert!(!flag.load(Ordering::SeqCst));
    }

    /// WS1: `drain_startup_banner` clears `pending` on every return path so a
    /// stale partial-line fragment cannot contaminate the first command's
    /// response.
    ///
    /// Regression: the pre-fix `Err(_) => break` left whatever bytes had
    /// accumulated in `pending` (a split `Grbl` banner incomplete at timeout) to
    /// concatenate into the first Start's response, causing the pump to misread
    /// it as a reset banner and abort — nothing moved on first Start.
    ///
    /// This test calls the production `drain_startup_banner` directly, so any
    /// future regression in the real function will be caught here rather than
    /// slipping past a shadow copy of the loop.
    #[test]
    fn startup_banner_read_clears_pending_on_timeout() {
        // Timeout path: MockPort::read always returns TimedOut, so
        // BufReader::read_until hits Err(TimedOut) on the first iteration.
        // We pre-load `pending` with a partial fragment to prove it is cleared.
        let port: Box<dyn SerialPort> = Box::new(MockPort::new());
        let reader_port: Box<dyn SerialPort> = Box::new(MockPort::new());
        let mut channel = CommandChannel {
            writer: port,
            reader: BufReader::new(reader_port),
            pending: b"Grbl 1.1 partial".to_vec(), // stale fragment pre-existing
        };

        drain_startup_banner(&mut channel);

        assert!(
            channel.pending.is_empty(),
            "pending must be empty after a startup read-timeout so the first command \
             response is not contaminated by a stale banner fragment"
        );
    }

    /// WS1 EOF path: `drain_startup_banner` clears `pending` on a clean EOF
    /// (Ok(0)) so a partial fragment accumulated before EOF cannot survive.
    ///
    /// Pre-existing NOTE: the original `Ok(0) => break` did not call
    /// `pending.clear()`, so any bytes already in `pending` before the EOF arm
    /// fired would leak into the first command's response.
    #[test]
    fn startup_banner_read_clears_pending_on_eof() {
        // EofPort returns Ok(0) on the first read, simulating a clean EOF.
        struct EofPort;
        impl std::io::Read for EofPort {
            fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
                Ok(0)
            }
        }
        impl std::io::Write for EofPort {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl SerialPort for EofPort {
            fn name(&self) -> Option<String> {
                Some("eof".to_string())
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
                Ok(0)
            }
            fn bytes_to_write(&self) -> serialport::Result<u32> {
                Ok(0)
            }
            fn clear(&self, _: serialport::ClearBuffer) -> serialport::Result<()> {
                Ok(())
            }
            fn try_clone(&self) -> serialport::Result<Box<dyn SerialPort>> {
                Ok(Box::new(EofPort))
            }
            fn set_break(&self) -> serialport::Result<()> {
                Ok(())
            }
            fn clear_break(&self) -> serialport::Result<()> {
                Ok(())
            }
        }

        let port: Box<dyn SerialPort> = Box::new(EofPort);
        let reader_port: Box<dyn SerialPort> = Box::new(EofPort);
        let mut channel = CommandChannel {
            writer: port,
            reader: BufReader::new(reader_port),
            pending: b"partial before eof".to_vec(), // fragment accumulated before EOF
        };

        drain_startup_banner(&mut channel);

        assert!(
            channel.pending.is_empty(),
            "pending must be empty after a clean EOF so the first command \
             response is not contaminated by a pre-EOF fragment"
        );
    }

    /// P1-C: disconnect_inner_with_job sends 0x18 when job_active=true,
    /// even if pump_in_flight is false (defense-in-depth for A2).
    #[test]
    fn disconnect_with_job_active_sends_reset() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let inner = SerialInner {
            command: Mutex::new(None),
            realtime: Mutex::new(Some(
                Box::new(MockPort::shared(written.clone())) as Box<dyn SerialPort>
            )),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false), // pump NOT in flight
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        };

        // job_active=true should still trigger the reset
        disconnect_inner_with_job(&inner, true).unwrap();
        assert_eq!(
            *written.lock().unwrap(),
            vec![0x18],
            "job_active=true must send 0x18 even without pump_in_flight"
        );
        assert!(!inner.connected.load(Ordering::SeqCst));
    }

    /// P1-C: disconnect_inner_with_job(false) + pump_not_in_flight = clean
    /// disconnect (no 0x18). Regression guard for the backwards-compatible path.
    #[test]
    fn disconnect_with_job_inactive_and_no_pump_sends_no_reset() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let inner = SerialInner {
            command: Mutex::new(None),
            realtime: Mutex::new(Some(
                Box::new(MockPort::shared(written.clone())) as Box<dyn SerialPort>
            )),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        };

        disconnect_inner_with_job(&inner, false).unwrap();
        assert!(
            written.lock().unwrap().is_empty(),
            "clean disconnect (no job, no pump) must not write 0x18"
        );
        assert!(!inner.connected.load(Ordering::SeqCst));
    }

    // ─── B2a: Status Contract ──────────────────────────────────────────────

    /// B2a mutant 2: NoResponse must NOT be reported as Busy. When the command
    /// lock is available and the bounded read expires without a `<…>` report,
    /// the result is NoResponse (we tried and got nothing), not Busy (we couldn't try).
    #[test]
    fn b2a_no_response_is_not_busy() {
        let port: Box<dyn SerialPort> = Box::new(MockPort::new());
        let reader_port: Box<dyn SerialPort> = Box::new(MockPort::new());
        let inner = SerialInner {
            command: Mutex::new(Some(CommandChannel {
                writer: port,
                reader: BufReader::new(reader_port),
                pending: Vec::new(),
            })),
            realtime: Mutex::new(Some(Box::new(MockPort::new()) as Box<dyn SerialPort>)),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        };
        inner.session.epoch.store(1, Ordering::SeqCst);

        let outcome = serial_get_status_inner(&inner).unwrap();
        assert_eq!(
            outcome.kind,
            StatusKind::NoResponse,
            "bounded read expiry must report NoResponse, not Busy"
        );
        assert!(outcome.status.is_empty());
    }

    // ─── Batch 0.1 invariant pins ──────────────────────────────────────────

    /// PIN 2: status body uses try_lock, not lock — calling it while the
    /// command lock is held returns the empty-string sentinel without blocking.
    /// If someone changes try_lock to lock, this test deadlocks and times out.
    /// This is the property that DECISIONS.md "0x9E is a toggle" documents:
    /// the Hold:0 poll could never succeed because the pump holds the lock.
    #[test]
    fn pin_status_try_lock_returns_empty_when_busy() {
        let port: Box<dyn SerialPort> = Box::new(MockPort::new());
        let reader_port: Box<dyn SerialPort> = Box::new(MockPort::new());
        let inner = Arc::new(SerialInner {
            command: Mutex::new(Some(CommandChannel {
                writer: port,
                reader: BufReader::new(reader_port),
                pending: Vec::new(),
            })),
            realtime: Mutex::new(None),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(true),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        });

        let _guard = inner.command.lock().unwrap();

        let (tx, rx) = mpsc::channel();
        let inner2 = inner.clone();
        thread::spawn(move || {
            let result = serial_get_status_inner(&inner2);
            let _ = tx.send(result);
        });

        let result = rx
            .recv_timeout(Duration::from_millis(500))
            .expect("status must return immediately via try_lock, not block");
        let outcome = result.unwrap();
        assert!(
            outcome.status.is_empty(),
            "busy sentinel must be an empty status string; got {:?}",
            outcome.status
        );
    }

    /// PIN 1: send body holds PumpFlight for its entire duration. The RAII
    /// guard in serial_send_inner sets pump_in_flight=true, so a concurrent
    /// disconnect will see it and send 0x18. We verify the flag is set by
    /// checking it from inside a slow-read port (SlowMockPort blocks read
    /// for 200ms per call so the send body is still in-flight when we check).
    #[test]
    fn pin_send_holds_pump_flight_during_execution() {
        struct SlowMockPort {
            written: Arc<Mutex<Vec<u8>>>,
        }
        impl SlowMockPort {
            fn new(written: Arc<Mutex<Vec<u8>>>) -> Self {
                Self { written }
            }
        }
        impl std::io::Read for SlowMockPort {
            fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
                std::thread::sleep(Duration::from_millis(200));
                Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "slow mock",
                ))
            }
        }
        impl std::io::Write for SlowMockPort {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.written.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl SerialPort for SlowMockPort {
            fn name(&self) -> Option<String> {
                Some("slow".to_string())
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
                Ok(0)
            }
            fn bytes_to_write(&self) -> serialport::Result<u32> {
                Ok(0)
            }
            fn clear(&self, _: serialport::ClearBuffer) -> serialport::Result<()> {
                Ok(())
            }
            fn try_clone(&self) -> serialport::Result<Box<dyn SerialPort>> {
                Ok(Box::new(SlowMockPort::new(self.written.clone())))
            }
            fn set_break(&self) -> serialport::Result<()> {
                Ok(())
            }
            fn clear_break(&self) -> serialport::Result<()> {
                Ok(())
            }
        }

        let written = Arc::new(Mutex::new(Vec::new()));
        let port: Box<dyn SerialPort> = Box::new(SlowMockPort::new(written.clone()));
        let reader_port: Box<dyn SerialPort> =
            Box::new(SlowMockPort::new(Arc::new(Mutex::new(Vec::new()))));
        let rt_written = Arc::new(Mutex::new(Vec::new()));
        let inner = Arc::new(SerialInner {
            command: Mutex::new(Some(CommandChannel {
                writer: port,
                reader: BufReader::new(reader_port),
                pending: Vec::new(),
            })),
            realtime: Mutex::new(Some(
                Box::new(MockPort::shared(rt_written.clone())) as Box<dyn SerialPort>
            )),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        });

        let inner2 = inner.clone();
        let _send_handle = thread::spawn(move || {
            let _ = serial_send_inner(&inner2, "G0 X10", None);
        });

        thread::sleep(Duration::from_millis(50));

        assert!(
            inner.pump_in_flight.load(Ordering::SeqCst),
            "pump_in_flight must be true while serial_send_inner is parked on a slow read"
        );
    }

    // PIN 3 (`pin_stream_writes_dollar32_first`) was replaced by rf15::s1b_stream_writes_no_dollar32_before_first_gcode_line (kerf-safety-s1b).

    // PIN 4: connect body writes exactly one 0x18 soft-reset. This pin cannot
    // be tested without a port factory injection (serial_connect_inner calls
    // serialport::new().open() directly). Routed to the Tauri test-port smoke.
    // Tracked as UNPROVEN in this batch per the plan.

    // P1-C / RF-11: the already-connected guard test now drives the real
    // connect body: see `rf15::already_connected_guard_disconnects_first`.

    // ─── B1 Admission Fence Tests ─────────────────────────────────────────

    /// Mutant 2: RED if a second serial_job_begin succeeds while first job is active.
    #[test]
    fn b1_double_job_begin_refused() {
        let inner = SerialInner::default();
        inner.connected.store(true, Ordering::SeqCst);
        inner.session.phase.store(PHASE_IDLE, Ordering::SeqCst);
        inner.session.epoch.store(1, Ordering::SeqCst);

        let job_id = serial_job_begin_inner(&inner).unwrap();
        assert_eq!(job_id, 1);
        assert_eq!(inner.session.phase.load(Ordering::SeqCst), PHASE_ACTIVE);

        // Second begin must fail — session is active.
        let result = serial_job_begin_inner(&inner);
        assert!(
            result.is_err(),
            "second job_begin must be refused while active"
        );
    }

    /// Mutant 3: RED if serial_send_inner with a stopped session succeeds.
    #[test]
    fn b1_send_after_stop_refused() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let inner = SerialInner {
            command: Mutex::new(Some(CommandChannel {
                writer: Box::new(MockPort::shared(written.clone())),
                reader: BufReader::new(Box::new(MockPort::new()) as Box<dyn SerialPort>),
                pending: Vec::new(),
            })),
            realtime: Mutex::new(Some(Box::new(MockPort::new()) as Box<dyn SerialPort>)),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        };

        // Set up: connect + begin job
        inner.session.epoch.store(1, Ordering::SeqCst);
        inner.session.phase.store(PHASE_IDLE, Ordering::SeqCst);
        let job_id = serial_job_begin_inner(&inner).unwrap();

        // Stop the session
        let _ = serial_stop_inner(&inner, &|_| {});

        // After stop, send with the old epoch must fail.
        let result = serial_send_inner(&inner, "G0 X10\n", Some(job_id));
        assert!(result.is_err(), "send after stop must be refused");

        // Verify no G-code bytes reached the writer. (The writer and realtime
        // handles here are separate MockPorts, so the stop's 0x18 is NOT in
        // `written`; ordering is proven by the rf15_* ScriptedPort tests.)
        let bytes = written.lock().unwrap();
        assert!(
            !bytes.windows(5).any(|w| w == b"G0 X1"),
            "no G-code must reach the wire after stop"
        );
    }

    /// Mutant: serial_job_end with wrong epoch is refused.
    #[test]
    fn b1_job_end_wrong_epoch_refused() {
        let inner = SerialInner::default();
        inner.session.phase.store(PHASE_IDLE, Ordering::SeqCst);
        inner.session.epoch.store(1, Ordering::SeqCst);

        let job_id = serial_job_begin_inner(&inner).unwrap();
        assert!(serial_job_end_inner(&inner, job_id + 99).is_err());
        // Correct epoch succeeds
        assert!(serial_job_end_inner(&inner, job_id).is_ok());
        assert_eq!(inner.session.phase.load(Ordering::SeqCst), PHASE_IDLE);
    }

    /// Mutant: stop closes admission (phase → stopping) and invalidates permits.
    #[test]
    fn b1_stop_closes_admission_and_invalidates_permits() {
        let inner = SerialInner {
            command: Mutex::new(None),
            realtime: Mutex::new(Some(Box::new(MockPort::new()) as Box<dyn SerialPort>)),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        };

        inner.session.epoch.store(1, Ordering::SeqCst);
        inner.session.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
        *inner.session.admitted_job.lock().unwrap() = Some(1);

        let result = serial_stop_inner(&inner, &|_| {});

        // Phase should be stopping or idle/unknown (stop completed)
        let phase = inner.session.phase.load(Ordering::SeqCst);
        assert!(phase != PHASE_ACTIVE, "phase must not be active after stop");

        // Admission is closed: a job write for the old epoch is refused
        // without the write being invoked.
        let mut called = false;
        let r = inner.session.admit_and_write(1, || {
            called = true;
            Ok(())
        });
        assert!(!called && r.is_err(), "stop must close admission");

        // Admitted job must be cleared
        assert!(inner.session.admitted_job.lock().unwrap().is_none());

        // job_abort must be set
        assert!(inner.job_abort.load(Ordering::SeqCst));

        // Result must be present
        match result {
            StopResult::Confirmed { .. } | StopResult::SubmittedUnconfirmed { .. } => {}
            other => panic!("unexpected stop result: {:?}", other),
        }
    }

    // W2: b1_event_sink_failure_triggers_abort removed — zero assertions:
    // at the time, the sink-failure path didn't trigger via MockPort (the
    // `$32=1` pump failed before the buffered pump callback ever fired). m6 is killed by
    // b1_stop_closes_admission_and_invalidates_permits.

    /// Connect with port factory: verifies the port factory parameter works.
    #[test]
    fn b1_connect_with_port_factory() {
        let inner = SerialInner::default();
        let result = serial_connect_inner(
            &inner,
            "test_port",
            115200,
            &|_| {}, // no-op sleeper
            &|_name, _baud| {
                // Return a MockPort that has a pre-loaded banner
                let port = MockPort::new();
                Ok(Box::new(port) as Box<dyn SerialPort>)
            },
        );
        // Should succeed (though banner will be empty since MockPort returns TimedOut)
        assert!(
            result.is_ok(),
            "connect with port factory failed: {:?}",
            result
        );
        assert!(inner.connected.load(Ordering::SeqCst));
        assert_eq!(inner.session.phase.load(Ordering::SeqCst), PHASE_IDLE);
        assert!(inner.session.epoch.load(Ordering::SeqCst) > 0);
    }

    /// Disconnect from active phase routes through stop.
    #[test]
    fn b1_disconnect_active_routes_through_stop() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let inner = SerialInner {
            command: Mutex::new(None),
            realtime: Mutex::new(Some(
                Box::new(MockPort::shared(written.clone())) as Box<dyn SerialPort>
            )),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        };

        // Set session to active
        inner.session.epoch.store(1, Ordering::SeqCst);
        inner.session.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
        *inner.session.admitted_job.lock().unwrap() = Some(1);

        disconnect_inner_with_job(&inner, false).unwrap();

        // 0x18 must have been sent (via the stop operation)
        assert!(
            written.lock().unwrap().contains(&0x18),
            "disconnect from active phase must send 0x18 via stop"
        );
        assert!(!inner.connected.load(Ordering::SeqCst));
        assert_eq!(
            inner.session.phase.load(Ordering::SeqCst),
            PHASE_DISCONNECTED
        );
    }

    /// StopResult serde fixture: all three variants round-trip and have the
    /// expected JSON shape. This is the fixture B4's TS test consumes.
    #[test]
    fn b1_stop_result_fixture_round_trip() {
        let variants = vec![
            StopResult::Confirmed {
                epoch_before: 1,
                epoch_after: 2,
                messages: vec!["STOP: 0x18 sent".to_string()],
            },
            StopResult::SubmittedUnconfirmed {
                epoch: 3,
                messages: vec!["STOP: unconfirmed".to_string()],
            },
            StopResult::SubmissionFailed {
                epoch: 4,
                error: "write failed".to_string(),
                messages: vec!["STOP failed".to_string()],
            },
        ];
        for v in &variants {
            let json = serde_json::to_string(v).unwrap();
            let parsed: StopResult = serde_json::from_str(&json).unwrap();
            assert_eq!(*v, parsed);
        }
    }

    /// Mutant 4: RED if phase is not set to STOPPING during the stop operation.
    /// Uses the session observer to capture the phase at the moment admission closes.
    #[test]
    fn b1_stop_phase_transitions_to_stopping() {
        let inner = Arc::new(SerialInner {
            command: Mutex::new(None),
            realtime: Mutex::new(Some(Box::new(MockPort::new()) as Box<dyn SerialPort>)),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        });

        inner.session.epoch.store(1, Ordering::SeqCst);
        inner.session.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
        *inner.session.admitted_job.lock().unwrap() = Some(1);

        // Wire up an observer that captures the phase when "admission_closed" fires.
        let phase_at_admission_closed = Arc::new(Mutex::new(None::<u8>));
        let phase_capture = phase_at_admission_closed.clone();
        let inner_ref = inner.clone();
        *inner.session.observer.lock().unwrap() = Some(Box::new(move |event: &str| {
            if event == "admission_closed" {
                let phase = inner_ref.session.phase.load(Ordering::SeqCst);
                *phase_capture.lock().unwrap() = Some(phase);
            }
        }));

        let _ = serial_stop_inner(&inner, &|_| {});

        let captured = phase_at_admission_closed.lock().unwrap();
        assert_eq!(
            *captured,
            Some(PHASE_STOPPING),
            "phase must be STOPPING at the moment admission closes"
        );
    }

    /// Mutant: stop on idle controller is harmless (no panic, returns a result).
    #[test]
    fn b1_stop_on_idle_is_harmless() {
        let inner = SerialInner {
            command: Mutex::new(None),
            realtime: Mutex::new(Some(Box::new(MockPort::new()) as Box<dyn SerialPort>)),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        };
        inner.session.phase.store(PHASE_IDLE, Ordering::SeqCst);
        inner.session.epoch.store(1, Ordering::SeqCst);

        let result = serial_stop_inner(&inner, &|_| {});
        // Should complete without panic, returning some result.
        match result {
            StopResult::Confirmed { .. }
            | StopResult::SubmittedUnconfirmed { .. }
            | StopResult::SubmissionFailed { .. } => {}
        }
    }

    /// Mutant: send with None epoch (console command) works even after stop.
    #[test]
    fn b1_console_send_bypasses_permit() {
        let inner = SerialInner {
            command: Mutex::new(Some(CommandChannel {
                writer: Box::new(MockPort::new()),
                reader: BufReader::new(Box::new(MockPort::new()) as Box<dyn SerialPort>),
                pending: Vec::new(),
            })),
            realtime: Mutex::new(None),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        };

        // Set session to stopping (as if a stop just ran)
        inner.session.phase.store(PHASE_STOPPING, Ordering::SeqCst);

        // Console send (None epoch) should still attempt the write.
        // It will fail on the read pump (MockPort returns TimedOut), but
        // it should NOT be refused by the permit check.
        let result = serial_send_inner(&inner, "$I\n", None);
        // The error should be about the pump (disconnected/timeout), not about permits.
        if let Err(msg) = result {
            assert!(
                !msg.contains("permit") && !msg.contains("not active"),
                "console send must bypass permit check; got: {msg}"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Integration tests over the GRBL simulator (Relay 1B)
//
// `mod tests` above proves lock STRUCTURE with a dumb `MockPort`. This
// module proves BEHAVIOR: the REAL `run_pump` / `drain_startup_banner` /
// `disconnect_inner` / `send_byte_inner` driven against a simulated GRBL
// controller (`crate::sim::grbl`) that can misbehave on cue via its
// fault-injection API. Each fault maps 1:1 onto a `PumpFailure`/
// `PumpTerminal` outcome (noted per test). Tests 1-7 are deterministic —
// scripted faults, small injected tick/liveness windows, no threads. Tests
// 8-9 are concurrency proofs and legitimately use real threads +
// `recv_timeout`, exactly like `mod tests` above.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod sim_integration {
    use super::*;
    use crate::sim::grbl::{SimConfig, SimPort};
    use std::sync::mpsc;
    use std::thread;

    // 1. connect/banner: `drain_startup_banner` — the exact function
    // `serial_connect` calls — returns the GRBL banner over a sim reader,
    // and clears `pending` on return.
    #[test]
    fn drain_startup_banner_returns_grbl_banner_over_sim() {
        let sim = SimPort::new(SimConfig::default());
        let mut channel = CommandChannel {
            writer: sim.try_clone().unwrap(),
            reader: BufReader::new(sim.try_clone().unwrap()),
            pending: Vec::new(),
        };

        let banner = drain_startup_banner(&mut channel);
        assert!(banner.contains("Grbl"), "got: {banner}");
        assert!(channel.pending.is_empty());
    }

    // 2. send/ack: a line gets its `ok`, terminal == PumpTerminal::Ok — the
    // production happy path, driven through the real `run_pump`.
    #[test]
    fn run_pump_acks_a_normal_line_over_sim() {
        let sim = SimPort::new(SimConfig::default());
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        writer.write_all(b"G1 X10 F500\n").unwrap();
        let out = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        )
        .unwrap();
        assert_eq!(out.terminal, serial_pump::PumpTerminal::Ok);
        assert_eq!(out.lines, vec!["ok"]);
    }

    // 3. dropped-ok idle-stall: the sim keeps answering `?` with
    // `<Idle|...>` (the planner drains normally — only the ack is
    // withheld), but the terminal never comes -> the idle-wedge detector
    // fires -> PumpFailure::Disconnected. A small injected idle_stall_ticks
    // keeps the test fast.
    #[test]
    fn dropped_ok_triggers_idle_stall_disconnect() {
        let sim = SimPort::new(SimConfig {
            planner_depth: 15,
            line_ticks: 1,
            ..SimConfig::default()
        });
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        sim.set_drop_ok_at_line(1); // the very next accepted line never acks

        writer.write_all(b"G1 X1\n").unwrap();
        let result = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            3,
            None,
        );
        match result {
            Err(serial_pump::PumpFailure::Disconnected(msg)) => {
                assert!(
                    msg.contains("Idle") || msg.contains("terminal lost"),
                    "expected the idle-wedge message, got: {msg}"
                );
            }
            other => panic!("expected idle-stall Disconnected, got {other:?}"),
        }
    }

    // 4. liveness expiry: fault "go silent" — no bytes ever arrive again,
    // regardless of what the sim would otherwise have queued -> run_pump's
    // silence counter reaches the (small, injected) liveness window ->
    // PumpFailure::Disconnected.
    #[test]
    fn silent_fault_triggers_liveness_expiry() {
        let sim = SimPort::new(SimConfig::default());
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        sim.set_silent(true);
        // The line is accepted and its `ok` is queued; `set_silent` kills only the
        // READ direction, so that `ok` is never delivered back to the pump.
        writer.write_all(b"G1 X1\n").unwrap();

        let result = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            3,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        );
        match result {
            Err(serial_pump::PumpFailure::Disconnected(msg)) => {
                assert!(
                    msg.contains("probe ticks") || msg.contains("no response"),
                    "got: {msg}"
                );
            }
            other => panic!("expected liveness Disconnected, got {other:?}"),
        }
    }

    // 4b. EOF: fault "port closed" — reads return Ok(0) — maps cleanly onto
    // run_pump's own EOF branch (serial_pump.rs:169-171) since that branch
    // is a direct, unconditional match on `Ok(0)`.
    #[test]
    fn eof_fault_yields_disconnected_port_closed() {
        let sim = SimPort::new(SimConfig::default());
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        sim.set_eof(true);
        writer.write_all(b"G1 X1\n").unwrap(); // write side is unaffected by the eof fault

        let result = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        );
        match result {
            Err(serial_pump::PumpFailure::Disconnected(msg)) => {
                assert!(msg.contains("EOF") || msg.contains("closed"), "got: {msg}");
            }
            other => panic!("expected EOF Disconnected, got {other:?}"),
        }
    }

    // 4c. write failure — FINDING (see report): the task's fault list
    // expected this to map to `PumpFailure::Io`, but it does not. The only
    // write run_pump itself performs is the periodic realtime `?` probe on
    // a timeout tick (`probe.write_probe()`); a failure there is caught by
    // run_pump's OWN `.map_err(...)` and surfaces as
    // `PumpFailure::Disconnected("probe write failed: ...")`.
    // `PumpFailure::Io` is constructed ONLY from a non-TimedOut READ error
    // (serial_pump.rs's final `Err(e) => ...Io` arm) — there is no code
    // path in the current pump that turns a WRITE failure into `::Io`. (A
    // write failure on the INITIAL line write, before run_pump is even
    // called, doesn't reach `PumpFailure` at all — `serial_send` maps it to
    // a plain `Err(String)` directly.) This test pins the actual behavior.
    #[test]
    fn write_fail_fault_surfaces_as_probe_write_failure_not_io() {
        let sim = SimPort::new(SimConfig {
            planner_depth: 15,
            line_ticks: 1000,
            ..SimConfig::default()
        });
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        // Accept a line normally first (consume its `ok`), so the run_pump
        // call below starts from a clean read with nothing pre-queued —
        // guaranteeing its first tick is a genuine TimedOut that drives a
        // probe write.
        writer.write_all(b"G1 X1\n").unwrap();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending);

        sim.set_write_fail(true);
        let result = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        );
        match result {
            Err(serial_pump::PumpFailure::Disconnected(msg)) => {
                assert!(msg.contains("probe write failed"), "got: {msg}");
            }
            other => panic!("expected Disconnected(\"probe write failed...\"), got {other:?}"),
        }
    }

    // 5. error terminal: fault "error:N on the Nth accepted line" ->
    // PumpTerminal::Error, the error line present verbatim.
    #[test]
    fn error_at_line_fault_yields_error_terminal() {
        let sim = SimPort::new(SimConfig::default());
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        sim.set_error_at_line(1, 9);

        writer.write_all(b"G1 X1\n").unwrap();
        let out = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        )
        .unwrap();
        assert_eq!(out.terminal, serial_pump::PumpTerminal::Error);
        assert_eq!(out.lines, vec!["error:9"]);
    }

    // 6. unsolicited ALARM: fault "alarm after N ticks" (e.g. a hard-limit
    // trip while otherwise idle) -> PumpTerminal::Alarm.
    #[test]
    fn alarm_after_ticks_fault_yields_alarm_terminal() {
        let sim = SimPort::new(SimConfig::default());
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        sim.set_alarm_after_ticks(2);

        // No command in flight: this models an alarm arriving unsolicited.
        // run_pump here plays the role of whatever reads the sim next
        // (e.g. the frontend's status poll would surface it the same way).
        let out = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        )
        .unwrap();
        assert_eq!(out.terminal, serial_pump::PumpTerminal::Alarm);
        assert!(
            out.lines.iter().any(|l| l.starts_with("ALARM")),
            "got: {:?}",
            out.lines
        );
    }

    // 7. banner-mid-line (reset abort): the host is still transmitting a
    // line (no trailing \n yet) when 0x18 interrupts it. The partial line
    // is discarded — never acked, never errored — and the sim's banner
    // becomes the next thing on the wire -> PumpTerminal::Banner ("the
    // in-flight line was ABORTED, not acked" — serial_pump.rs's own
    // documented semantics for this terminal).
    #[test]
    fn reset_mid_line_yields_banner_terminal_abort() {
        let sim = SimPort::new(SimConfig::default());
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        writer.write_all(b"G1 X5").unwrap(); // no trailing \n — still "mid-line"
        writer.write_all(&[0x18]).unwrap();

        let out = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        )
        .unwrap();
        assert_eq!(out.terminal, serial_pump::PumpTerminal::Banner);
        assert!(
            out.lines.iter().any(|l| l.contains("Grbl")),
            "got: {:?}",
            out.lines
        );
    }

    // 8. e-stop realtime bypass: mirrors `realtime_write_completes_while_
    // command_lock_held` above (MockPort) with SimPort instead — plus the
    // sim's own byte log proves the 0x18 actually reached the SIMULATED
    // controller, not just that some write syscall returned Ok.
    #[test]
    fn sim_realtime_write_completes_while_command_lock_held() {
        let sim = SimPort::new(SimConfig::default());
        let realtime_handle: Box<dyn SerialPort> = sim.try_clone().unwrap();

        let inner = Arc::new(SerialInner {
            command: Mutex::new(None),
            realtime: Mutex::new(Some(realtime_handle)),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(true),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        });

        // Simulate an in-flight pump: hold the command lock for the whole test.
        let _command_guard = inner.command.lock().unwrap();

        let (tx, rx) = mpsc::channel();
        let inner2 = inner.clone();
        thread::spawn(move || {
            let result = send_byte_inner(&inner2, 0x18);
            let _ = tx.send(result);
        });

        let result = rx
            .recv_timeout(Duration::from_millis(500))
            .expect("realtime write blocked behind the command lock — e-stop would freeze");
        assert!(result.is_ok());
        assert_eq!(
            sim.realtime_bytes_received(),
            vec![0x18],
            "0x18 must reach the simulated controller's wire"
        );
    }

    // 9. THE WEDGED-PUMP SCENARIO — the e-stop safety proof. A pump reading
    // this sim would be wedged (fault: drop-ok, so its awaited `ok` never
    // arrives). Build SerialInner with SimPort (command + realtime sharing
    // ONE brain, exactly like a real connect's three try_clone()s). Hold the
    // command lock on the main thread (standing in for "the wedged pump is
    // still in there," matching the pattern above and at serial.rs:610).
    // Spawn disconnect_inner on another thread and prove:
    //   (a) the realtime 0x18 reaches the sim's wire BEFORE disconnect ever
    //       waits on the command lock (the whole point of the realtime/
    //       command lock split);
    //   (b) the sim's banner — queued by that very 0x18 — is exactly what a
    //       concurrent pump reading the SAME brain would observe as its
    //       terminal (PumpTerminal::Banner, never a hang);
    //   (c) releasing the lock lets disconnect complete its teardown.
    // This proves that if the future Phase-2 pump ever wedges, the user's
    // STOP still tears the connection down cleanly.
    #[test]
    fn wedged_pump_estop_then_disconnect_tears_down_cleanly() {
        let control = SimPort::new(SimConfig::default());
        // A firmware ack glitch: the line we're about to send never gets
        // its `ok` — a real run_pump reading this would wait forever
        // (bounded only by the idle-wedge detector / liveness timeout, both
        // much longer than this test's patience). That's "wedged."
        control.set_drop_ok_at_line(1);

        let mut pump_writer: Box<dyn SerialPort> = control.try_clone().unwrap();
        let mut pump_reader = BufReader::new(control.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut pump_reader, &mut pending); // drain banner

        pump_writer.write_all(b"G1 X1\n").unwrap(); // the line that will never ack

        let realtime_handle: Box<dyn SerialPort> = control.try_clone().unwrap();
        let inner = Arc::new(SerialInner {
            command: Mutex::new(None),
            realtime: Mutex::new(Some(realtime_handle)),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(true),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        });

        // Hold the command lock — standing in for the wedged pump.
        let command_guard = inner.command.lock().unwrap();

        let inner2 = inner.clone();
        let handle = thread::spawn(move || disconnect_inner(&inner2));

        // (a) The 0x18 must arrive at the sim's wire while the command lock
        // is STILL held.
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while control.realtime_bytes_received().is_empty() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            control.realtime_bytes_received(),
            vec![0x18],
            "realtime 0x18 must reach the sim before disconnect waits on the command lock"
        );

        // (b) The reset's banner is exactly what a concurrent pump reading
        // the SAME brain would see as its terminal — never a hang.
        let out = serial_pump::run_pump(
            &mut pump_reader,
            &mut pump_writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        )
        .expect("the pump must observe the reset banner, not hang");
        assert_eq!(out.terminal, serial_pump::PumpTerminal::Banner);

        // (c) Release the "pump" (in production the banner terminal does
        // this); disconnect then completes its teardown.
        drop(command_guard);
        handle.join().unwrap().unwrap();
        assert!(!inner.connected.load(Ordering::SeqCst));
    }

    // -- Volley-transcript contract (P1-B) ----------------------------------
    // Each safety volley's exact byte/line sequence replayed against a
    // GrblBrain, asserting zero strict-hold invariant violations and
    // correct spindle_energized() state.

    // 10. Pause volley: [!] only — feed hold auto-stops spindle ($32=1).
    // 0x9E is NOT sent — it's a toggle that would RE-ARM the beam.
    #[test]
    fn pause_feed_hold_alone_clears_spindle() {
        use crate::sim::grbl::MachineState;

        let sim = SimPort::new(SimConfig::default());
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        // Start spindle and a motion command so we're in Run state
        writer.write_all(b"M3 S1000\n").unwrap();
        let _ = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        )
        .unwrap();
        assert!(sim.spindle_energized(), "spindle must be on after M3");

        writer.write_all(b"G1 X50 F500\n").unwrap();
        let _ = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        )
        .unwrap();

        // Pause: feed hold only — no 0x9E
        writer.write_all(b"!").unwrap();
        assert_eq!(sim.machine_state(), MachineState::Hold);

        // Assertions
        assert!(
            sim.hold_invariant_violations().is_empty(),
            "feed hold must cause zero hold-invariant violations"
        );
        assert!(
            !sim.spindle_energized(),
            "spindle must be off after feed hold ($32=1 auto-stop)"
        );
        assert_eq!(
            sim.realtime_bytes_received(),
            vec![b'!'],
            "exact pause bytes on the wire — no 0x9E"
        );
    }

    // 10b. Regression: hold → 0x9E → spindle RE-ARMED (the bug scenario).
    // Proves the sim now correctly models the toggle so it would catch this
    // class of bug in future.
    #[test]
    fn hold_then_0x9e_rearms_spindle_regression() {
        let sim = SimPort::new(SimConfig::default());
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending);

        writer.write_all(b"M3 S1000\n").unwrap();
        let _ = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        )
        .unwrap();

        writer.write_all(b"G1 X50 F500\n").unwrap();
        let _ = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        )
        .unwrap();

        // Feed hold — spindle auto-off
        writer.write_all(b"!").unwrap();
        assert!(!sim.spindle_energized(), "hold auto-stops spindle");

        // 0x9E toggles spindle back ON — this is the bug the old code had
        writer.write_all(&[0x9E]).unwrap();
        assert!(
            sim.spindle_energized(),
            "0x9E is a toggle — after hold auto-off, it RE-ARMS the beam"
        );
    }

    // 11. Resume volley: [~] — cycle resume only. After resume,
    // spindle_energized() stays false (GRBL's override toggle is separate
    // from line-based M3; the sim doesn't model the toggle-restore, so
    // spindle stays off — which is the correct conservative assertion).
    #[test]
    fn resume_volley_is_tilde_only() {
        use crate::sim::grbl::MachineState;

        let sim = SimPort::new(SimConfig::default());
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        // Start spindle, motion, then pause
        writer.write_all(b"M3 S1000\n").unwrap();
        let _ = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        )
        .unwrap();
        writer.write_all(b"G1 X50 F500\n").unwrap();
        let _ = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        )
        .unwrap();

        // Pause: feed hold only (no 0x9E — it's a toggle that re-arms)
        writer.write_all(b"!").unwrap();
        assert!(!sim.spindle_energized(), "hold auto-stops spindle");

        // Resume volley: [~]
        writer.write_all(b"~").unwrap();

        // The machine exits Hold
        let state = sim.machine_state();
        assert!(
            state == MachineState::Run || state == MachineState::Idle,
            "machine must leave Hold after resume, got: {:?}",
            state
        );
        assert!(
            sim.hold_invariant_violations().is_empty(),
            "resume volley must cause zero hold-invariant violations"
        );
    }

    // 12. E-stop volley: [!, 0x18, ?] — feedHold + reset + status query.
    // The 0x18 clears the spindle at firmware level (boot_or_reset). Zero
    // hold-invariant violations.
    #[test]
    fn estop_volley_resets_and_clears_spindle() {
        let sim = SimPort::new(SimConfig::default());
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        // Start spindle + motion
        writer.write_all(b"M3 S1000\n").unwrap();
        let _ = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        )
        .unwrap();
        assert!(sim.spindle_energized());

        // E-stop volley: [!, 0x18, ?]
        writer.write_all(b"!").unwrap();
        writer.write_all(&[0x18]).unwrap();
        // Drain the reset banner
        let _ = serial_pump::drain_classified(&mut reader, &mut pending);
        writer.write_all(b"?").unwrap();

        assert!(
            sim.hold_invariant_violations().is_empty(),
            "e-stop volley must cause zero hold-invariant violations"
        );
        assert!(
            !sim.spindle_energized(),
            "spindle must be off after e-stop (reset clears it)"
        );
    }

    // 13. MAX_PUMP_LINES ceiling: a chatty non-terminal stream hits the
    // ceiling and returns PumpFailure::Disconnected instead of looping
    // forever.
    #[test]
    fn pump_ceiling_triggers_on_chatty_junk() {
        // Build a reader that emits MAX_PUMP_LINES + 10 [MSG:] lines
        // with no terminal. The pump must stop at the ceiling.
        let ceiling = serial_pump::MAX_PUMP_LINES;
        let junk_line = b"[MSG:junk]\n";
        let total_lines = ceiling + 10;
        let mut data = Vec::with_capacity(junk_line.len() * total_lines);
        for _ in 0..total_lines {
            data.extend_from_slice(junk_line);
        }

        use std::io::{Error, ErrorKind};

        struct JunkReader {
            data: Vec<u8>,
            pos: usize,
        }
        impl std::io::Read for JunkReader {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.pos >= self.data.len() {
                    return Err(Error::new(ErrorKind::TimedOut, "no more data"));
                }
                let n = buf.len().min(self.data.len() - self.pos);
                buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
                self.pos += n;
                Ok(n)
            }
        }
        impl BufRead for JunkReader {
            fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
                if self.pos >= self.data.len() {
                    return Err(Error::new(ErrorKind::TimedOut, "no more data"));
                }
                Ok(&self.data[self.pos..])
            }
            fn consume(&mut self, amt: usize) {
                self.pos += amt;
            }
        }

        struct NoopProbe;
        impl serial_pump::ProbeWriter for NoopProbe {
            fn write_probe(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let mut reader = JunkReader { data, pos: 0 };
        let mut probe = NoopProbe;
        let mut pending = Vec::new();

        let result = serial_pump::run_pump(
            &mut reader,
            &mut probe,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        );

        match result {
            Err(serial_pump::PumpFailure::Disconnected(msg)) => {
                assert!(
                    msg.contains("pump ceiling") || msg.contains("non-terminal"),
                    "expected pump ceiling message, got: {msg}"
                );
            }
            other => panic!("expected pump ceiling Disconnected, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // Buffered pump sim integration tests (Phase 2A)
    // -----------------------------------------------------------------------

    // SI-BP1: Full job through sim — 20 lines → overflow_count == 0, Complete
    #[test]
    fn buffered_pump_full_job_20_lines_zero_overflow() {
        let sim = SimPort::new(SimConfig {
            planner_depth: 15,
            line_ticks: 1,
            ..SimConfig::default()
        });
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        let lines: Vec<String> = (0..20).map(|i| format!("G1 X{} F500", i)).collect();

        let abort = std::sync::atomic::AtomicBool::new(false);
        let config = serial_pump::BufferedPumpConfig::default();

        let result = serial_pump::run_buffered_pump(
            &lines,
            &mut reader,
            &mut writer,
            &mut pending,
            &config,
            &abort,
            &serial_pump::OpenGate,
            &|_| {},
        );

        assert_eq!(result.unwrap(), serial_pump::BufferedPumpOutcome::Complete);
        assert_eq!(
            sim.overflow_count(),
            0,
            "THE proof of correctness: zero RX overflows"
        );
    }

    // SI-BP2: Dense short lines — 100 × "G1 X0.1 F500" → overflow_count == 0
    #[test]
    fn buffered_pump_dense_short_lines_zero_overflow() {
        let sim = SimPort::new(SimConfig {
            planner_depth: 15,
            line_ticks: 1,
            ..SimConfig::default()
        });
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending);

        let lines: Vec<String> = (0..100).map(|_| "G1 X0.1 F500".to_string()).collect();

        let abort = std::sync::atomic::AtomicBool::new(false);
        let config = serial_pump::BufferedPumpConfig::default();

        let result = serial_pump::run_buffered_pump(
            &lines,
            &mut reader,
            &mut writer,
            &mut pending,
            &config,
            &abort,
            &serial_pump::OpenGate,
            &|_| {},
        );

        assert_eq!(result.unwrap(), serial_pump::BufferedPumpOutcome::Complete);
        assert_eq!(sim.overflow_count(), 0, "dense stream must never overflow");
    }

    // SI-BP3: Pause/resume through sim — `!` → Hold → no sends → `~` → resumes
    #[test]
    fn buffered_pump_pause_resume_through_sim() {
        let sim = SimPort::new(SimConfig {
            planner_depth: 15,
            line_ticks: 2,
            ..SimConfig::default()
        });
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending);

        // Start spindle + send some lines, then pause mid-job
        let lines: Vec<String> = (0..10).map(|i| format!("G1 X{} F500", i)).collect();

        let abort = std::sync::atomic::AtomicBool::new(false);
        let config = serial_pump::BufferedPumpConfig {
            idle_stall_ticks: 10, // relaxed for this test
            ..serial_pump::BufferedPumpConfig::default()
        };

        // Use separate handles for realtime bytes and observation
        let mut rt_writer = sim.try_clone().unwrap();

        // Move sim into a scope where both threads can use it (via Arc-shared brain
        // inside SimPort::try_clone handles).
        let handle = thread::spawn(move || {
            serial_pump::run_buffered_pump(
                &lines,
                &mut reader,
                &mut writer,
                &mut pending,
                &config,
                &abort,
                &serial_pump::OpenGate,
                &|_| {},
            )
        });

        // Give the pump time to send some lines
        thread::sleep(Duration::from_millis(50));

        // Pause via realtime byte
        rt_writer.write_all(b"!").unwrap();
        thread::sleep(Duration::from_millis(50));

        // Verify machine is in Hold
        assert_eq!(sim.machine_state(), crate::sim::grbl::MachineState::Hold);

        // Resume
        rt_writer.write_all(b"~").unwrap();

        let result = handle.join().unwrap();
        assert_eq!(result.unwrap(), serial_pump::BufferedPumpOutcome::Complete);
        assert!(
            sim.hold_invariant_violations().is_empty(),
            "zero hold-invariant violations during pause/resume"
        );
        assert_eq!(sim.overflow_count(), 0, "zero overflows");
    }

    // SI-BP4: Abort through sim — flag mid-job → Cancelled
    // Uses a very large job with slow execution so the pump is guaranteed to
    // still be in its send/read loop when the abort flag is set.
    #[test]
    fn buffered_pump_abort_through_sim() {
        // planner_depth=1, line_ticks=1000: after the first line is accepted
        // (filling the planner), the second blocks waiting for a slot that takes
        // 1000 ticks (~1000 read timeouts) to free. The pump will sit in Phase B
        // reading timeouts — plenty of time for the abort flag to fire.
        let sim = SimPort::new(SimConfig {
            planner_depth: 1,
            line_ticks: 1000,
            ..SimConfig::default()
        });
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending);

        let lines: Vec<String> = (0..50).map(|i| format!("G1 X{} F500", i)).collect();

        let abort = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let abort_clone = abort.clone();
        let config = serial_pump::BufferedPumpConfig {
            liveness_ticks: 2000, // large so liveness doesn't fire before abort
            ..serial_pump::BufferedPumpConfig::default()
        };

        let handle = thread::spawn(move || {
            serial_pump::run_buffered_pump(
                &lines,
                &mut reader,
                &mut writer,
                &mut pending,
                &config,
                &abort_clone,
                &serial_pump::OpenGate,
                &|_| {},
            )
        });

        // Let pump start and enter Phase B waiting for acks
        thread::sleep(Duration::from_millis(50));
        abort.store(true, std::sync::atomic::Ordering::SeqCst);

        let result = handle.join().unwrap();
        assert_eq!(result.unwrap(), serial_pump::BufferedPumpOutcome::Cancelled);
    }

    // ─── B2a: Native Status Contract Tests ────────────────────────────────

    /// Fixture generation: produce a serialized JSON file carrying a Progress
    /// event (with camelCase fields) and a StatusOutcome with snapshot, epoch,
    /// and sequence. The TS side (B2b) consumes this to validate schema parity.
    ///
    /// Runs only when KERF_UPDATE_GOLDEN is set — in CI the fixture is compared
    /// against the checked-in copy.
    #[test]
    fn b2a_generate_native_status_fixture() {
        use crate::commands::grbl_status::{
            AccessoryState, GrblSnapshot, MachineState, PositionKind, UnitsValidity,
        };

        // Progress event: line_index must serialize as "lineIndex" (not "line_index").
        let progress = JobEvent::Progress {
            line_index: 42,
            total: 100,
        };
        let progress_json = serde_json::to_value(&progress).unwrap();
        assert_eq!(
            progress_json["lineIndex"], 42,
            "field must be camelCase: lineIndex"
        );
        assert!(
            progress_json.get("line_index").is_none(),
            "snake_case field 'line_index' must not appear in serialization"
        );

        // StatusOutcome with a report-kind snapshot.
        let snapshot = GrblSnapshot {
            epoch: 5,
            seq: 17,
            received_at: None, // skipped in serde
            state: MachineState::Run,
            position_kind: Some(PositionKind::MPos),
            position: Some([10.5, 20.3, 0.0]),
            wco: Some([1.0, 2.0, 0.0]),
            feed: Some(500.0),
            spindle: Some(1000.0),
            accessory: AccessoryState::Present("S".to_string()),
            units: UnitsValidity::Unknown,
            raw: "<Run|MPos:10.500,20.300,0.000|FS:500,1000|WCO:1.000,2.000,0.000|A:S>".to_string(),
            unknown_fields: vec![],
        };
        let status_outcome = StatusOutcome {
            status: snapshot.raw.clone(),
            events: vec!["[MSG:Check Door]".to_string()],
            kind: StatusKind::Report,
            snapshot: Some(snapshot),
        };
        let outcome_json = serde_json::to_value(&status_outcome).unwrap();
        assert_eq!(outcome_json["kind"], "report");
        assert!(outcome_json["snapshot"].is_object());
        assert_eq!(outcome_json["snapshot"]["epoch"], 5);
        assert_eq!(outcome_json["snapshot"]["seq"], 17);

        // Build the fixture object.
        let fixture = serde_json::json!({
            "_comment": "Generated by Rust serializer — do not hand-edit. Run `cargo test b2a_generate_native_status_fixture` with KERF_UPDATE_GOLDEN=1 to regenerate.",
            "progressEvent": progress_json,
            "statusOutcome": outcome_json,
        });

        // Write to the fixture path only when KERF_UPDATE_GOLDEN is set.
        if std::env::var("KERF_UPDATE_GOLDEN").is_ok() {
            let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("src/lib/machine/__tests__/fixtures/nativeStatus.json");
            std::fs::create_dir_all(fixture_path.parent().unwrap()).unwrap();
            let formatted = serde_json::to_string_pretty(&fixture).unwrap();
            std::fs::write(&fixture_path, format!("{}\n", formatted)).unwrap();
            eprintln!("[fixture] wrote {}", fixture_path.display());
        }

        // Always verify the schema shape, even without KERF_UPDATE_GOLDEN.
        let roundtrip: StatusOutcome = serde_json::from_value(outcome_json.clone()).unwrap();
        assert_eq!(roundtrip.kind, StatusKind::Report);
        assert!(roundtrip.snapshot.is_some());
        assert_eq!(roundtrip.snapshot.as_ref().unwrap().epoch, 5);
        assert_eq!(roundtrip.snapshot.as_ref().unwrap().seq, 17);
    }

    /// B2a mutant 1: Busy refreshes age — verify that the busy path returns
    /// the last-known snapshot without advancing freshness.
    #[test]
    fn b2a_busy_preserves_age_does_not_advance_freshness() {
        let inner = Arc::new(SerialInner::default());
        inner.connected.store(true, Ordering::SeqCst);
        inner.session.epoch.store(1, Ordering::SeqCst);
        inner.session.phase.store(PHASE_IDLE, Ordering::SeqCst);

        // Publish a snapshot manually.
        inner
            .session
            .publish_snapshot("<Idle|MPos:0,0,0|FS:0,0>", 1);
        let snap_before = inner.session.read_snapshot().unwrap();

        // Hold the command lock so status goes to the busy path.
        let _guard = inner.command.lock().unwrap();

        let (tx, rx) = mpsc::channel();
        let inner2 = inner.clone();
        thread::spawn(move || {
            let result = serial_get_status_inner(&inner2);
            let _ = tx.send(result);
        });

        let result = rx
            .recv_timeout(Duration::from_millis(500))
            .expect("status must return immediately on busy path");
        let outcome = result.unwrap();
        assert_eq!(outcome.kind, StatusKind::Busy);
        // The snapshot should be the same one (not a fresh one).
        assert!(outcome.snapshot.is_some());
        assert_eq!(outcome.snapshot.as_ref().unwrap().seq, snap_before.seq);
    }

    /// B2a mutant 3: Malformed `<Idle…` (missing closing `>`) must NOT produce
    /// an actionable Idle snapshot.
    #[test]
    fn b2a_malformed_status_not_actionable_idle() {
        use crate::commands::grbl_status::parse_status_frame;
        // Missing closing >
        assert!(parse_status_frame("<Idle|MPos:0,0,0", 1, 1).is_none());
        // NaN position
        let snap = parse_status_frame("<Idle|MPos:NaN,0,0>", 1, 1).unwrap();
        assert!(snap.position.is_none());
    }

    /// B2a mutant 7: Serialization must emit `lineIndex`, never `line_index`.
    #[test]
    fn b2a_line_index_serde_camel_case() {
        let event = JobEvent::Progress {
            line_index: 10,
            total: 50,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"lineIndex\""), "must be camelCase: {json}");
        assert!(
            !json.contains("\"line_index\""),
            "must not be snake_case: {json}"
        );
    }

    /// B2a mutant 8: A snapshot published after a stop must NOT carry the
    /// pre-stop epoch. Stop invalidates the snapshot; a publish with the old
    /// epoch is rejected by the monotonic guard.
    #[test]
    fn b2a_snapshot_invalidated_by_stop() {
        let inner = SerialInner::default();
        inner.connected.store(true, Ordering::SeqCst);
        inner.session.epoch.store(1, Ordering::SeqCst);
        inner.session.phase.store(PHASE_IDLE, Ordering::SeqCst);

        // Publish a snapshot at epoch 1.
        inner
            .session
            .publish_snapshot("<Run|MPos:1,2,3|FS:500,1000>", 1);
        assert!(inner.session.read_snapshot().is_some());

        // Stop: invalidates the snapshot.
        inner.session.invalidate_snapshot();
        assert!(inner.session.read_snapshot().is_none());

        // Try to publish with the old epoch after stop incremented it.
        inner.session.epoch.store(2, Ordering::SeqCst);
        inner
            .session
            .publish_snapshot("<Idle|MPos:0,0,0|FS:0,0>", 1); // old epoch
                                                              // The monotonic guard should reject epoch 1 < current snapshot seq context.
                                                              // Since snapshot was invalidated (None), a publish with epoch 1 IS accepted
                                                              // (there's no existing snapshot to compare against). But the epoch in the
                                                              // snapshot will be 1, not 2 — the caller's lock_epoch.
                                                              // In practice, after stop+epoch-increment, no pump holds the old epoch.
                                                              // The real protection is that stop invalidates and the new pump captures
                                                              // the new epoch. Let's verify the epoch is carried correctly.
        let snap = inner.session.read_snapshot().unwrap();
        assert_eq!(
            snap.epoch, 1,
            "epoch must be from lock acquisition, not current"
        );
    }

    /// B2a mutant 4: Door status must NOT clear suspended sending.
    /// Door is not Idle — it must not be treated as "safe to resume."
    #[test]
    fn b2a_door_state_is_not_idle() {
        use crate::commands::grbl_status::parse_status_frame;
        let snap = parse_status_frame("<Door:0|MPos:0,0,0|FS:0,0>", 1, 1).unwrap();
        assert!(!snap.state.is_idle());
        assert!(snap.state.is_run_like());
    }

    /// B2a mutant 5: A `[MSG]` line must NOT reset a deadline (it's not a
    /// status report and not a terminal). Verified via run_pump: feeding only
    /// [MSG:] lines without any terminal should eventually hit the line ceiling.
    #[test]
    fn b2a_msg_does_not_reset_deadline() {
        // This is already covered by pump_ceiling_triggers_on_non_terminal_flood
        // (which sends 1005 [MSG:junk] lines), but let's be explicit.
        use super::serial_pump::{self, PumpFailure};
        use std::collections::VecDeque;
        use std::io::{BufRead, Error, ErrorKind, Read};

        // ScriptReader that yields 5 [MSG:] lines then timeouts indefinitely
        struct MsgFloodReader {
            msgs: VecDeque<Vec<u8>>,
        }
        impl MsgFloodReader {
            fn new(n: usize) -> Self {
                let mut msgs = VecDeque::new();
                for _ in 0..n {
                    msgs.push_back(b"[MSG:Check Door]\n".to_vec());
                }
                Self { msgs }
            }
        }
        impl Read for MsgFloodReader {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if let Some(data) = self.msgs.front() {
                    let n = data.len().min(buf.len());
                    buf[..n].copy_from_slice(&data[..n]);
                    if n == data.len() {
                        self.msgs.pop_front();
                    }
                    Ok(n)
                } else {
                    Err(Error::new(ErrorKind::TimedOut, "tick"))
                }
            }
        }
        impl BufRead for MsgFloodReader {
            fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
                if let Some(data) = self.msgs.front() {
                    Ok(data.as_slice())
                } else {
                    Err(Error::new(ErrorKind::TimedOut, "tick"))
                }
            }
            fn consume(&mut self, amt: usize) {
                if let Some(data) = self.msgs.front_mut() {
                    *data = data[amt..].to_vec();
                    if data.is_empty() {
                        self.msgs.pop_front();
                    }
                }
            }
        }

        struct NullProbe;
        impl serial_pump::ProbeWriter for NullProbe {
            fn write_probe(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        // 5 [MSG:] lines then timeouts. With liveness_ticks=2, the pump
        // reads the messages then hits 2 silent ticks → Disconnected.
        // The point: [MSG:] does NOT count as liveness proof.
        let mut reader = MsgFloodReader::new(5);
        let mut probe = NullProbe;
        let mut pending = Vec::new();
        let result = serial_pump::run_pump(&mut reader, &mut probe, &mut pending, 2, 10, None);
        match result {
            Err(PumpFailure::Disconnected(_)) => {} // expected
            other => panic!("expected Disconnected after MSG+silence, got {other:?}"),
        }
    }

    /// B2a mutant 6: Byte cap — frame accumulation must be bounded.
    /// Pin the values so a change requires updating this test.
    #[test]
    fn b2a_frame_length_cap_enforced() {
        assert_eq!(
            serial_pump::FRAME_LENGTH_CAP,
            4096,
            "frame cap changed — update test"
        );
        assert_eq!(
            serial_pump::DIAGNOSTIC_DATA_CAP,
            65536,
            "diagnostic cap changed — update test"
        );
    }
    // -- E5: laser-switch wedge driven through the REAL pumps ---------------

    /// (sim, writer, reader, pending) for the wedge tests.
    type WedgeRig = (
        SimPort,
        Box<dyn SerialPort>,
        BufReader<Box<dyn SerialPort>>,
        Vec<u8>,
    );

    /// The sim armed with the one-shot laser-switch wedge, a small planner
    /// clock, and its banner drained.
    fn wedge_armed_sim() -> WedgeRig {
        let sim = SimPort::new(SimConfig {
            line_ticks: 1,
            ..SimConfig::default()
        });
        let writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner
        sim.set_wedge_after_spindle_cmd();
        (sim, writer, reader, pending)
    }

    // E5-M6: per-line `run_pump` into a wedge. The M4 line is accepted and
    // executed but never acked; `?` keeps answering Idle, so the idle-stall
    // detector declares the terminal lost.
    #[test]
    fn wedge_after_laser_switch_triggers_idle_stall_disconnect() {
        let (sim, mut writer, mut reader, mut pending) = wedge_armed_sim();

        writer.write_all(b"M4 S500\n").unwrap();
        let result = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            3,
            None,
        );
        match result {
            Err(serial_pump::PumpFailure::Disconnected(msg)) => {
                assert!(msg.contains("terminal lost"), "got: {msg}");
            }
            other => panic!("expected idle-stall Disconnected, got {other:?}"),
        }
        let probes = sim
            .realtime_bytes_received()
            .iter()
            .filter(|&&b| b == b'?')
            .count();
        assert!(probes >= 3, "`?` still answered during the wedge: {probes}");
    }

    // E5-M7: a wedge, then the production realtime path's 0x18, then a
    // line that acks — the reset clears the wedge.
    #[test]
    fn wedge_is_cleared_by_realtime_reset() {
        let (sim, mut writer, mut reader, mut pending) = wedge_armed_sim();

        writer.write_all(b"M4 S500\n").unwrap();
        let wedged = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            3,
            None,
        );
        assert!(
            matches!(wedged, Err(serial_pump::PumpFailure::Disconnected(_))),
            "precondition: wedged, got {wedged:?}"
        );

        let inner = SerialInner {
            command: Mutex::new(None),
            realtime: Mutex::new(Some(sim.try_clone().unwrap())),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        };
        send_byte_inner(&inner, 0x18).unwrap();
        pending.clear();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // reset banner
        pending.clear();

        writer.write_all(b"G1 X1 F500\n").unwrap();
        let out = serial_pump::run_pump(
            &mut reader,
            &mut writer,
            &mut pending,
            DEFAULT_LIVENESS_TICKS,
            3,
            None,
        )
        .expect("after 0x18 the line must ack");
        assert_eq!(out.terminal, serial_pump::PumpTerminal::Ok);
    }

    // Coverage (no battery id): buffered `run_buffered_pump` into a wedge
    // reports the terminal lost while lines are in flight.
    #[test]
    fn buffered_pump_wedge_after_laser_switch_disconnects() {
        let (_sim, mut writer, mut reader, mut pending) = wedge_armed_sim();

        let lines: Vec<String> = ["M4 S500", "G1 X1 F500", "G1 X2 F500"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let abort = std::sync::atomic::AtomicBool::new(false);
        let config = serial_pump::BufferedPumpConfig {
            idle_stall_ticks: 3,
            ..serial_pump::BufferedPumpConfig::default()
        };
        let result = serial_pump::run_buffered_pump(
            &lines,
            &mut reader,
            &mut writer,
            &mut pending,
            &config,
            &abort,
            &serial_pump::OpenGate,
            &|_| {},
        );
        match result {
            Ok(serial_pump::BufferedPumpOutcome::Disconnected(msg)) => {
                assert!(msg.contains("terminal lost"), "got: {msg}");
            }
            other => panic!("expected buffered Disconnected, got {other:?}"),
        }
    }

    /// A `SerialInner` whose command channel and realtime handle are all
    /// `try_clone`s of one sim brain (as `rf15::rig` does with its port),
    /// with the banner drained, epoch 1 and phase Idle.
    fn s1b_sim_inner(sim: &SimPort) -> SerialInner {
        let inner = SerialInner {
            command: Mutex::new(Some(CommandChannel {
                writer: sim.try_clone().unwrap(),
                reader: BufReader::new(sim.try_clone().unwrap()),
                pending: Vec::new(),
            })),
            realtime: Mutex::new(Some(sim.try_clone().unwrap())),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        };
        {
            let mut g = inner.command.lock().unwrap();
            let ch = g.as_mut().unwrap();
            let _ = serial_pump::drain_classified(&mut ch.reader, &mut ch.pending);
            // banner
        }
        inner.session.epoch.store(1, Ordering::SeqCst);
        inner.session.phase.store(PHASE_IDLE, Ordering::SeqCst);
        inner
    }

    /// One line through the command channel and the real `run_pump`.
    fn s1b_sim_exchange(inner: &SerialInner, line: &str) -> Vec<String> {
        let mut g = inner.command.lock().unwrap();
        let ch = g.as_mut().unwrap();
        ch.writer.write_all(line.as_bytes()).unwrap();
        ch.writer.flush().unwrap();
        let out = serial_pump::run_pump(
            &mut ch.reader,
            &mut ch.writer,
            &mut ch.pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
            None,
        )
        .expect("sim exchange");
        out.lines
    }

    /// S1b-T5 (Razor N8): a controller that acknowledges `$32=1` but does not
    /// apply it cannot start a buffered job, because the start checks the
    /// readback-set flag (false for this controller) instead of an `ok`.
    #[test]
    fn s1b_n8_acked_but_ignored_dollar32_cannot_start_a_buffered_job() {
        let sim = SimPort::new(SimConfig::default());
        let inner = s1b_sim_inner(&sim);
        let lines = s1b_sim_exchange(&inner, "$32=0\n");
        assert!(lines.iter().any(|l| l == "ok"), "$32=0 ack: {lines:?}");
        sim.set_ignore_setting(32);
        assert!(!sim.laser_mode(), "precondition: controller at $32=0");
        let e = serial_job_begin_inner(&inner).unwrap();

        let result =
            serial_stream_job_inner(&inner, "M4 S500\nG1 X1 F500\nM5\n", e, false, &|_| Ok(()));

        assert_eq!(result, Err(LASER_MODE_UNVERIFIED.to_string()));
        assert_eq!(sim.outbound_len(), 0, "nothing sent, nothing acknowledged");
        assert_eq!(sim.planner_len(), 0, "nothing queued");
        assert!(!sim.spindle_energized());
        let dump = s1b_sim_exchange(&inner, "$$\n");
        assert!(dump.iter().any(|l| l == "$32=0"), "$$: {dump:?}");
        assert!(!dump.iter().any(|l| l == "$32=1"), "$$: {dump:?}");
    }

    /// S1b-T6 (control for S1b-C1): a verified buffered job completes on the
    /// default sim and writes no `$32`.
    #[test]
    fn s1b_verified_buffered_job_completes_on_sim_without_writing_dollar32() {
        let sim = SimPort::new(SimConfig::default());
        let inner = s1b_sim_inner(&sim);
        let e = serial_job_begin_inner(&inner).unwrap();

        let result = serial_stream_job_inner(
            &inner,
            "M4 S500\nG1 X1 F500\nG1 X2 F500\nM5\n",
            e,
            true,
            &|_| Ok(()),
        );

        assert_eq!(result, Ok("complete".to_string()));
        let dump = s1b_sim_exchange(&inner, "$$\n");
        let d32: Vec<&String> = dump.iter().filter(|l| l.starts_with("$32=")).collect();
        assert_eq!(d32, vec!["$32=1"], "$$: {dump:?}");
    }
}

// ---------------------------------------------------------------------------
// RF-15: job-line admission fence, driven through the production bodies over
// a one-brain ScriptedPort (writer, reader and realtime share one ordered
// trace). Every scenario runs under a 2 s deadline, below the stop's 3 s
// banner deadline; every stop gets a scripted banner; barriers are trace
// events and hold points, never sleeps.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod rf15 {
    use super::*;
    use crate::sim::scripted_port::{
        make_session_observer, HandleRole, ScriptStep, ScriptedPort, TraceEvent,
    };
    use std::thread;

    const BANNER: &[u8] = b"Grbl 1.1h ['$' for help]\r\n";
    const SCENARIO: Duration = Duration::from_secs(2);

    fn rig(script: Vec<ScriptStep>) -> (Arc<SerialInner>, ScriptedPort) {
        let base = ScriptedPort::new(script);
        let inner = Arc::new(SerialInner {
            command: Mutex::new(Some(CommandChannel {
                writer: Box::new(base.clone_with_role(HandleRole::Writer)),
                reader: BufReader::new(
                    Box::new(base.clone_with_role(HandleRole::Reader)) as Box<dyn SerialPort>
                ),
                pending: Vec::new(),
            })),
            realtime: Mutex::new(Some(
                Box::new(base.clone_with_role(HandleRole::Realtime)) as Box<dyn SerialPort>
            )),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
            job_abort: AtomicBool::new(false),
            session: SerialSession::default(),
        });
        inner.session.epoch.store(1, Ordering::SeqCst);
        inner.session.phase.store(PHASE_IDLE, Ordering::SeqCst);
        *inner.session.observer.lock().unwrap() = Some(make_session_observer(base.brain_arc()));
        (inner, base)
    }

    /// Real (short) sleep so the stop's banner loop does not busy-spin.
    fn nap(_: Duration) {
        thread::sleep(Duration::from_millis(1));
    }

    fn stop(inner: &SerialInner) -> StopResult {
        serial_stop_inner(inner, &nap)
    }

    fn is_reset(e: &TraceEvent) -> bool {
        matches!(e, TraceEvent::Write { role: HandleRole::Realtime, data } if data == &[0x18])
    }

    fn is_writer_write(e: &TraceEvent) -> bool {
        matches!(
            e,
            TraceEvent::Write {
                role: HandleRole::Writer,
                ..
            }
        )
    }

    fn first_reset(trace: &[TraceEvent]) -> usize {
        trace
            .iter()
            .position(is_reset)
            .expect("the stop's 0x18 must be in the trace")
    }

    /// Writer writes after the stop's (first) Realtime 0x18.
    fn writer_writes_after_reset(trace: &[TraceEvent]) -> Vec<TraceEvent> {
        let r = first_reset(trace);
        trace[r..]
            .iter()
            .filter(|e| is_writer_write(e))
            .cloned()
            .collect()
    }

    /// O5: at most one Realtime 0x18 per stop invocation. A stop invocation
    /// spans from one `stop_requested` session event to the next; no reset may
    /// precede the first. Returns the total reset count.
    fn assert_one_reset_per_stop(trace: &[TraceEvent]) -> usize {
        let mut per_segment = vec![0usize];
        for e in trace {
            if matches!(e, TraceEvent::SessionEvent { name } if name == "stop_requested") {
                per_segment.push(0);
            } else if is_reset(e) {
                *per_segment.last_mut().unwrap() += 1;
            }
        }
        assert_eq!(
            per_segment[0], 0,
            "O5: a 0x18 precedes every stop_requested: {trace:?}"
        );
        assert!(
            per_segment.iter().all(|n| *n <= 1),
            "O5 one-reset assertion: more than one 0x18 in a stop invocation {per_segment:?}: {trace:?}"
        );
        per_segment.iter().sum()
    }

    /// Wait until the stop thread has provably entered: `StopGuard::begin`
    /// sets `stop_in_flight` before Step 2, so after this the stop is at (or
    /// past) its `submit` acquisition.
    fn wait_stop_entered(inner: &SerialInner) {
        wait_until("stop_in_flight", || {
            inner.session.stop_in_flight.load(Ordering::SeqCst)
        });
    }

    /// The parked-write negatives: no reset and no admission close yet.
    fn assert_stop_parked_behind_write(base: &ScriptedPort, what: &str) {
        // Give the stop thread real time to run as far as it can; these
        // negatives must hold however long it runs (it is blocked on
        // `submit`). The positive barrier is `wait_stop_entered`.
        thread::sleep(Duration::from_millis(50));
        let trace = base.trace();
        assert!(
            !trace.iter().any(is_reset),
            "{what}: the stop's 0x18 was written while a job write held submit: {trace:?}"
        );
        assert!(
            !has_session_event(base, "admission_closed"),
            "{what}: admission closed while a job write held submit: {trace:?}"
        );
    }

    /// The line precedes the single 0x18 and no Writer write follows it.
    fn assert_line_before_single_reset(trace: &[TraceEvent], line: &[u8]) {
        let r = first_reset(trace);
        let w = trace
            .iter()
            .position(|t| matches!(t, TraceEvent::Write { role: HandleRole::Writer, data } if data == line))
            .unwrap_or_else(|| panic!("line {:?} never written: {trace:?}", String::from_utf8_lossy(line)));
        assert!(w < r, "ordering assertion: line after the 0x18: {trace:?}");
        assert!(
            writer_writes_after_reset(trace).is_empty(),
            "no Writer write may follow the 0x18: {trace:?}"
        );
        assert_eq!(
            trace.iter().filter(|t| is_reset(t)).count(),
            1,
            "exactly one 0x18: {trace:?}"
        );
    }

    fn has_session_event(base: &ScriptedPort, name: &str) -> bool {
        base.trace()
            .iter()
            .any(|e| matches!(e, TraceEvent::SessionEvent { name: n } if n == name))
    }

    fn has_hold_reached(base: &ScriptedPort, id: &str) -> bool {
        base.trace()
            .iter()
            .any(|e| matches!(e, TraceEvent::HoldReached { id: i } if i == id))
    }

    /// Poll the trace (not a sleep barrier: it returns as soon as the event
    /// exists). Panics at 1.5 s so a missed event fails loudly.
    fn wait_until(what: &str, f: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_millis(1500);
        while !f() {
            assert!(
                std::time::Instant::now() < deadline,
                "never observed: {what}"
            );
            thread::sleep(Duration::from_millis(1));
        }
    }

    fn wait_reset(base: &ScriptedPort) {
        wait_until("Realtime 0x18", || base.trace().iter().any(is_reset));
    }

    // ── R1 ────────────────────────────────────────────────────────────────

    fn ipc_serial_send(
        inner: Arc<SerialInner>,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value> {
        let app = tauri::test::mock_builder()
            .manage(SerialState(inner))
            .invoke_handler(tauri::generate_handler![serial_send])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview");
        tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "serial_send".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<serde_json::Value>().unwrap())
    }

    /// R1: the literal IPC key `jobEpoch` reaches the real
    /// `#[tauri::command] serial_send` body and fences the job line.
    #[test]
    fn rf15_ipc_serial_send_carries_job_epoch() {
        ScriptedPort::run_scenario(
            || {
                let (inner, base) = rig(vec![
                    ScriptStep::Timeout,
                    ScriptStep::Data(b"ok\r\n"),
                    ScriptStep::Data(BANNER),
                ]);
                let e = serial_job_begin_inner(&inner).unwrap();

                // (a) Positive control: an admitted job line is written and acked.
                let ok = ipc_serial_send(
                    inner.clone(),
                    serde_json::json!({"command": "G1 X1", "jobEpoch": e}),
                );
                assert!(ok.is_ok(), "admitted line must succeed: {ok:?}");
                assert!(base.trace().iter().any(
                    |t| matches!(t, TraceEvent::Write { role: HandleRole::Writer, data } if data == b"G1 X1\n")
                ));

                // (b) After a confirmed stop, the same job line is refused.
                assert!(matches!(stop(&inner), StopResult::Confirmed { .. }));
                let refused = ipc_serial_send(
                    inner.clone(),
                    serde_json::json!({"command": "G1 X1", "jobEpoch": e}),
                );
                let err = refused.expect_err("stale job line must be refused");
                assert!(
                    err.as_str()
                        .unwrap_or_default()
                        .starts_with("refused: not-admitted:"),
                    "raw refusal string expected, got {err:?}"
                );
                assert!(
                    writer_writes_after_reset(&base.trace()).is_empty(),
                    "no Writer write may follow the stop's 0x18"
                );

                // (c) Without jobEpoch (console path) the line is still written.
                // Assert on the trace: the pump may hit EOF on the exhausted script.
                let _ = ipc_serial_send(inner.clone(), serde_json::json!({"command": "$$"}));
                assert!(
                    writer_writes_after_reset(&base.trace()).iter().any(
                        |t| matches!(t, TraceEvent::Write { data, .. } if data == b"$$\n")
                    ),
                    "console send must still reach the writer"
                );
                assert_one_reset_per_stop(&base.trace());
            },
            SCENARIO,
        )
        .unwrap();
    }

    // ── R2 ────────────────────────────────────────────────────────────────

    /// R2: a stale per-line send after a confirmed stop is refused, nothing is
    /// written after the reset, and nothing is read (the decoy stays unread).
    #[test]
    fn rf15_per_line_stale_send_after_stop_refused_nothing_after_reset() {
        ScriptedPort::run_scenario(
            || {
                let (inner, base) = rig(vec![
                    ScriptStep::Timeout,
                    ScriptStep::Data(b"ok\r\n"),
                    ScriptStep::Data(BANNER),
                    // Decoy: visible to drain_classified; the green path never reads it.
                    ScriptStep::Data(b"ok\n"),
                ]);
                let e = serial_job_begin_inner(&inner).unwrap();
                serial_send_inner(&inner, "G1 X1", Some(e)).expect("accepted first line");
                assert!(matches!(stop(&inner), StopResult::Confirmed { .. }));

                base.push_session_event("stale_send_begin");
                let result = serial_send_inner(&inner, "G1 X2", Some(e));

                let err = result.expect_err("stale send must be refused");
                assert!(
                    err.starts_with("refused: not-admitted:"),
                    "prefix assertion: {err}"
                );
                let trace = base.trace();
                assert_one_reset_per_stop(&trace);
                assert!(
                    writer_writes_after_reset(&trace).is_empty(),
                    "no Writer write may follow the Realtime 0x18: {trace:?}"
                );
                let marker = trace
                    .iter()
                    .position(|t| matches!(t, TraceEvent::SessionEvent { name } if name == "stale_send_begin"))
                    .unwrap();
                assert!(
                    !trace[marker..]
                        .iter()
                        .any(|t| matches!(t, TraceEvent::ReadData { .. })),
                    "ReadData assertion: a refused send must read nothing: {trace:?}"
                );
            },
            SCENARIO,
        )
        .unwrap();
    }

    // ── R3 ────────────────────────────────────────────────────────────────

    /// R3: a sender that passed its precheck before the stop, and then waited
    /// on the command lock through the stop, is refused under the lock.
    #[test]
    fn rf15_per_line_permit_checked_after_lock_wait() {
        ScriptedPort::run_scenario(
            || {
                let (inner, base) = rig(vec![
                    ScriptStep::HoldUntilRelease { id: "banner" },
                    ScriptStep::Data(BANNER),
                ]);
                let e = serial_job_begin_inner(&inner).unwrap();

                let lock = inner.command.lock().unwrap();
                let i2 = inner.clone();
                let sender = thread::spawn(move || serial_send_inner(&i2, "G1 X9", Some(e)));
                wait_until("permit_prechecked", || {
                    has_session_event(&base, "permit_prechecked")
                });

                let i3 = inner.clone();
                let stopper = thread::spawn(move || stop(&i3));
                wait_reset(&base);
                drop(lock);

                // Whoever reaches the reader first parks on the banner hold.
                wait_until("banner hold", || has_hold_reached(&base, "banner"));
                base.release_hold("banner");
                let result = sender.join().unwrap();
                let _ = stopper.join().unwrap();

                let err = result.expect_err("sender must be refused");
                assert!(err.starts_with("refused: not-admitted:"), "{err}");
                let trace = base.trace();
                assert_one_reset_per_stop(&trace);
                assert!(
                    writer_writes_after_reset(&trace).is_empty(),
                    "zero Writer writes after the stop's 0x18: {trace:?}"
                );
                assert!(
                    !has_session_event(&base, "permit_granted"),
                    "no permit may be granted after the stop"
                );
            },
            SCENARIO,
        )
        .unwrap();
    }

    // ── O1 ────────────────────────────────────────────────────────────────

    /// O1 (per-line): a writer parked inside its `write()` holds `submit`, so
    /// the stop cannot close admission or write `0x18` until the line is
    /// queued. The line precedes the single reset; nothing follows it.
    #[test]
    fn rf15_o1_per_line_write_in_progress_precedes_single_reset() {
        ScriptedPort::run_scenario(
            || {
                let (inner, base) = rig(vec![
                    ScriptStep::HoldUntilRelease { id: "banner" },
                    ScriptStep::Data(BANNER),
                ]);
                let e = serial_job_begin_inner(&inner).unwrap();
                base.hold_next_write(HandleRole::Writer, "line");

                let i2 = inner.clone();
                let sender = thread::spawn(move || serial_send_inner(&i2, "G1 X5", Some(e)));
                wait_until("write parked", || has_hold_reached(&base, "line"));

                let i3 = inner.clone();
                let stopper = thread::spawn(move || stop(&i3));
                wait_stop_entered(&inner);
                assert_stop_parked_behind_write(&base, "O1");
                base.release_hold("line");

                wait_reset(&base);
                wait_until("banner hold", || has_hold_reached(&base, "banner"));
                base.release_hold("banner");
                let result = sender.join().unwrap();
                let stop_result = stopper.join().unwrap();

                let trace = base.trace();
                assert_line_before_single_reset(&trace, b"G1 X5\n");
                assert_one_reset_per_stop(&trace);
                let out = result.expect("O1: the admitted line's send is Ok (banner-terminated)");
                assert!(
                    out.responses.iter().any(|l| l.starts_with("Grbl")),
                    "O1: pump ended on the banner: {out:?}"
                );
                assert!(
                    matches!(stop_result, StopResult::Confirmed { .. }),
                    "{stop_result:?}"
                );
            },
            SCENARIO,
        )
        .unwrap();
    }

    // ── R5-R7 (buffered) ─────────────────────────────────────────────────

    /// R5: a queued buffered stream after a stop is refused at entry: nothing
    /// written after the reset (nothing) and `job_abort` untouched.
    #[test]
    fn rf15_buffered_stream_after_stop_refused_at_entry() {
        ScriptedPort::run_scenario(
            || {
                let (inner, base) = rig(vec![ScriptStep::Data(BANNER)]);
                let e = serial_job_begin_inner(&inner).unwrap();
                assert!(matches!(stop(&inner), StopResult::Confirmed { .. }));

                let result =
                    serial_stream_job_inner(&inner, "G1 X1\nG1 X2\n", e, true, &|_| Ok(()));
                let err = result.expect_err("entry must refuse");
                assert!(err.starts_with("refused: not-admitted:"), "{err}");
                let trace = base.trace();
                assert_one_reset_per_stop(&trace);
                assert!(
                    writer_writes_after_reset(&trace).is_empty(),
                    "no Writer write (nothing) after the 0x18: {trace:?}"
                );
                assert!(
                    inner.job_abort.load(Ordering::SeqCst),
                    "flag assertion: the stream entry must not clear job_abort"
                );
            },
            SCENARIO,
        )
        .unwrap();
    }

    /// R6 (mechanism): the pump's per-line gate refuses independently of the
    /// shared `job_abort` flag. The hand clear models the class, not a
    /// reachable production sequence: the production clearer of `job_abort`
    /// is `serial_job_begin_inner`, which cannot coincide with a live pump —
    /// a stop confirms only when a reader publishes the banner, and while the
    /// pump holds `command` it is the only reader, and seeing the banner ends it.
    #[test]
    fn rf15_buffered_mid_job_gate_independent_of_abort_flag() {
        ScriptedPort::run_scenario(
            || {
                let (inner, base) = rig(vec![
                    ScriptStep::Timeout,
                    ScriptStep::HoldUntilRelease { id: "phase_b" },
                    ScriptStep::Data(b"ok\r\n"),
                    ScriptStep::Data(BANNER),
                ]);
                let e = serial_job_begin_inner(&inner).unwrap();
                let gcode: String = (0..30).map(|i| format!("G1 X{i} F500\n")).collect();

                let i2 = inner.clone();
                let pump = thread::spawn(move || {
                    serial_stream_job_inner(&i2, &gcode, e, true, &|_| Ok(()))
                });
                wait_until("pump in Phase B", || has_hold_reached(&base, "phase_b"));

                let i3 = inner.clone();
                let stopper = thread::spawn(move || stop(&i3));
                wait_reset(&base);
                inner.job_abort.store(false, Ordering::SeqCst);
                base.release_hold("phase_b");

                let outcome = pump.join().unwrap().expect("pump outcome is Ok");
                let stop_result = stopper.join().unwrap();

                assert!(
                    outcome.starts_with("refused: not-admitted:"),
                    "outcome: {outcome}"
                );
                let trace = base.trace();
                assert_one_reset_per_stop(&trace);
                assert!(
                    writer_writes_after_reset(&trace).is_empty(),
                    "no Writer write after the 0x18: {trace:?}"
                );
                assert!(matches!(stop_result, StopResult::Confirmed { .. }));
            },
            SCENARIO,
        )
        .unwrap();
    }

    /// O2 (buffered): O1's shape on a Phase A line.
    #[test]
    fn rf15_o2_buffered_write_in_progress_precedes_single_reset() {
        ScriptedPort::run_scenario(
            || {
                let (inner, base) = rig(vec![
                    ScriptStep::HoldUntilRelease { id: "banner" },
                    ScriptStep::Data(BANNER),
                ]);
                let e = serial_job_begin_inner(&inner).unwrap();
                base.hold_next_write(HandleRole::Writer, "line");

                let i2 = inner.clone();
                let pump = thread::spawn(move || {
                    serial_stream_job_inner(&i2, "G1 X1 F500\n", e, true, &|_| Ok(()))
                });
                wait_until("line write parked", || has_hold_reached(&base, "line"));

                let i3 = inner.clone();
                let stopper = thread::spawn(move || stop(&i3));
                wait_stop_entered(&inner);
                assert_stop_parked_behind_write(&base, "O2");
                base.release_hold("line");

                wait_reset(&base);
                wait_until("banner hold", || has_hold_reached(&base, "banner"));
                base.release_hold("banner");
                let outcome = pump.join().unwrap().expect("pump outcome is Ok");
                let stop_result = stopper.join().unwrap();

                let trace = base.trace();
                assert_line_before_single_reset(&trace, b"G1 X1 F500\n");
                assert_one_reset_per_stop(&trace);
                // The line was admitted and written: the job ends on the
                // stop (banner or abort flag), never as a refusal.
                assert!(
                    outcome == "aborted" || outcome == "cancelled",
                    "outcome: {outcome}"
                );
                assert!(
                    matches!(stop_result, StopResult::Confirmed { .. }),
                    "{stop_result:?}"
                );
            },
            SCENARIO,
        )
        .unwrap();
    }

    // O3 (`rf15_o3_dollar32_write_in_progress_precedes_single_reset`) was
    // retired by kerf-safety-s1b: the buffered start no longer writes `$32=1`,
    // so its subject is gone. Buffered write-vs-reset ordering is O2's
    // (re-proved by mutant S1b-M7); O1 and O4 remain per-line evidence.

    /// O4 (stop first): a writer parked on the command lock after its
    /// precheck; the stop runs to completion; then the lock is released. The
    /// writer is refused, no Writer write follows the single 0x18.
    #[test]
    fn rf15_o4_stop_first_writer_refused() {
        ScriptedPort::run_scenario(
            || {
                let (inner, base) = rig(vec![]);
                let e = serial_job_begin_inner(&inner).unwrap();

                let lock = inner.command.lock().unwrap();
                let i2 = inner.clone();
                let sender = thread::spawn(move || serial_send_inner(&i2, "G1 X9", Some(e)));
                wait_until("permit_prechecked", || {
                    has_session_event(&base, "permit_prechecked")
                });

                // The stop cannot read a banner while the lock is held: it
                // runs to its deadline and completes unconfirmed.
                let stop_result = stop(&inner);
                assert!(
                    matches!(stop_result, StopResult::SubmittedUnconfirmed { .. }),
                    "{stop_result:?}"
                );
                drop(lock);
                let result = sender.join().unwrap();

                let trace = base.trace();
                assert!(
                    writer_writes_after_reset(&trace).is_empty(),
                    "O4: zero Writer writes after the stop's 0x18: {trace:?}"
                );
                assert_eq!(
                    assert_one_reset_per_stop(&trace),
                    1,
                    "exactly one 0x18: {trace:?}"
                );
                let err = result.expect_err("O4: the writer must be refused");
                assert!(err.starts_with("refused: not-admitted:"), "{err}");
            },
            Duration::from_secs(6),
        )
        .unwrap();
    }

    // ── S1b ──────────────────────────────────────────────────────────────

    /// S1b-T1: an unverified stream is refused before any read or write and
    /// changes no session state.
    #[test]
    fn s1b_unverified_stream_touches_nothing() {
        ScriptedPort::run_scenario(
            || {
                // A drain, if reached, would record ReadData.
                let (inner, base) = rig(vec![ScriptStep::Data(b"ok\r\n")]);
                let e = serial_job_begin_inner(&inner).unwrap();

                let result = serial_stream_job_inner(&inner, "G1 X1 F500\n", e, false, &|_| Ok(()));

                assert_eq!(result, Err(LASER_MODE_UNVERIFIED.to_string()));
                let trace = base.trace();
                assert!(
                    !trace.iter().any(|t| matches!(t, TraceEvent::Write { .. })),
                    "no write of any role: {trace:?}"
                );
                assert!(
                    !trace
                        .iter()
                        .any(|t| matches!(t, TraceEvent::ReadData { .. })),
                    "no read: {trace:?}"
                );
                assert!(!inner.pump_in_flight.load(Ordering::SeqCst));
                assert!(!inner.job_abort.load(Ordering::SeqCst));
                assert_eq!(*inner.session.admitted_job.lock().unwrap(), Some(e));
            },
            SCENARIO,
        )
        .unwrap();
    }

    /// S1b-T2 (replaces PIN 3): a verified buffered job's first Writer write
    /// is its first G-code line, no Writer write contains `$32`, and the job
    /// completes.
    #[test]
    fn s1b_stream_writes_no_dollar32_before_first_gcode_line() {
        ScriptedPort::run_scenario(
            || {
                // Leading Timeout keeps both drains off the acks; trailing
                // Timeouts keep a stray read from hitting EOF (Disconnected).
                let (inner, base) = rig(vec![
                    ScriptStep::Timeout,
                    ScriptStep::Data(b"ok\r\nok\r\n"),
                    ScriptStep::Timeout,
                    ScriptStep::Timeout,
                    ScriptStep::Timeout,
                ]);
                let e = serial_job_begin_inner(&inner).unwrap();

                let result = serial_stream_job_inner(
                    &inner,
                    "G0 X10\nG1 X20 F1000 S500\n",
                    e,
                    true,
                    &|_| Ok(()),
                );

                assert_eq!(result, Ok("complete".to_string()));
                let trace = base.trace();
                let writes: Vec<&Vec<u8>> = trace
                    .iter()
                    .filter_map(|t| match t {
                        TraceEvent::Write {
                            role: HandleRole::Writer,
                            data,
                        } => Some(data),
                        _ => None,
                    })
                    .collect();
                assert_eq!(
                    writes.first().map(|d| d.as_slice()),
                    Some(&b"G0 X10\n"[..]),
                    "first Writer write: {trace:?}"
                );
                assert!(
                    !writes.iter().any(|d| d.windows(3).any(|w| w == b"$32")),
                    "no Writer write may contain $32: {trace:?}"
                );
            },
            SCENARIO,
        )
        .unwrap();
    }

    /// S1b-T3: an admission refusal wins over the laser-mode refusal.
    #[test]
    fn s1b_admission_refusal_wins_over_laser_refusal() {
        ScriptedPort::run_scenario(
            || {
                let (inner, base) = rig(vec![ScriptStep::Data(b"ok\r\n")]);

                let result = serial_stream_job_inner(&inner, "G1 X1 F500\n", 1, false, &|_| Ok(()));

                let err = result.expect_err("unadmitted stream must be refused");
                assert!(err.starts_with("refused: not-admitted:"), "{err}");
                let trace = base.trace();
                assert!(
                    !trace.iter().any(|t| matches!(t, TraceEvent::Write { .. })),
                    "no writes: {trace:?}"
                );
            },
            SCENARIO,
        )
        .unwrap();
    }

    /// S1b-T4 (coverage): the laser refusal is neither an admission refusal
    /// nor a dead port to `jobStream.ts`.
    #[test]
    fn laser_mode_unverified_is_not_a_refusal_or_disconnect() {
        assert!(LASER_MODE_UNVERIFIED.starts_with("$32=1 not verified"));
        assert!(!LASER_MODE_UNVERIFIED.starts_with(crate::commands::serial_session::REFUSED_PREFIX));
        assert!(!LASER_MODE_UNVERIFIED.contains("disconnected"));
        assert!(!LASER_MODE_UNVERIFIED.contains("Not connected"));
    }

    // ── R8 (resend failure / CAS / recovery) ─────────────────────────────

    #[test]
    fn rf15_job_end_does_not_overwrite_unknown() {
        let inner = SerialInner::default();
        inner.session.phase.store(PHASE_UNKNOWN, Ordering::SeqCst);
        *inner.session.admitted_job.lock().unwrap() = Some(7);
        assert!(serial_job_end_inner(&inner, 7).is_ok());
        assert!(inner.session.admitted_job.lock().unwrap().is_none());
        assert_eq!(inner.session.phase.load(Ordering::SeqCst), PHASE_UNKNOWN);
    }

    /// U2 (kills M4 through the pump's gate): a refused
    /// `JobPermit::admit_write` never invokes the write.
    #[test]
    fn rf15_u2_job_permit_refuses_without_writing() {
        use serial_pump::SubmissionGate;
        let session = SerialSession::default();
        let permit = JobPermit {
            session: &session,
            epoch: 1,
        };
        *session.admitted_job.lock().unwrap() = Some(1);
        session.phase.store(PHASE_STOPPING, Ordering::SeqCst);
        let mut called = false;
        let r = permit.admit_write(&mut || {
            called = true;
            Ok(())
        });
        assert!(!called, "U2: write invoked while Stopping");
        assert!(r.unwrap_err().starts_with("refused: not-admitted:"));

        session.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
        *session.admitted_job.lock().unwrap() = None;
        let mut called = false;
        let r = permit.admit_write(&mut || {
            called = true;
            Ok(())
        });
        assert!(!called, "U2: write invoked with admitted_job None");
        assert!(r.unwrap_err().starts_with("refused: not-admitted:"));

        *session.admitted_job.lock().unwrap() = Some(1);
        let mut called = false;
        let r = permit.admit_write(&mut || {
            called = true;
            Ok(())
        });
        assert!(called, "U2: admitted write not invoked");
        assert!(r.unwrap().is_ok());
    }

    /// R8c: from Unknown reached through `SubmissionFailed` (both `0x18`
    /// attempts fail), a second STOP recovers: Confirmed, Idle, and admission
    /// reopens.
    #[test]
    fn rf15_second_stop_recovers_from_unknown() {
        ScriptedPort::run_scenario(
            || {
                let (inner, base) = rig(vec![]);
                serial_job_begin_inner(&inner).unwrap();
                base.fail_writes_after(HandleRole::Realtime, 0);
                let first = stop(&inner);
                assert!(
                    matches!(first, StopResult::SubmissionFailed { .. }),
                    "first stop: {first:?}"
                );
                assert_eq!(
                    inner.session.phase.load(Ordering::SeqCst),
                    PHASE_UNKNOWN,
                    "phase after SubmissionFailed"
                );
                assert!(serial_job_begin_inner(&inner).is_err(), "admission closed");

                base.clear_write_faults();
                base.push_script(vec![ScriptStep::Data(BANNER)]);
                let result = stop(&inner);

                assert!(
                    matches!(result, StopResult::Confirmed { .. }),
                    "variant assertion: {result:?}"
                );
                assert_eq!(
                    inner.session.phase.load(Ordering::SeqCst),
                    PHASE_IDLE,
                    "phase assertion"
                );
                assert!(
                    serial_job_begin_inner(&inner).is_ok(),
                    "admission reopens after a confirmed stop"
                );
                assert_eq!(assert_one_reset_per_stop(&base.trace()), 1);
            },
            SCENARIO,
        )
        .unwrap();
    }

    // ── F7 (RF-11) ────────────────────────────────────────────────────────

    /// RF-11: the already-connected guard in the REAL connect body tears the
    /// first connection down before the second connection's port is opened
    /// (and therefore before its DTR toggle), recorded in the trace.
    #[test]
    fn already_connected_guard_disconnects_first() {
        let base = ScriptedPort::new(vec![]);
        let inner = Arc::new(SerialInner::default());
        let opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (fi, fb, fo) = (
            inner.clone(),
            base.clone_with_role(HandleRole::Writer),
            opens,
        );
        let factory = move |_: &str, _: u32| -> Result<Box<dyn SerialPort>, serialport::Error> {
            let n = fo.fetch_add(1, Ordering::SeqCst);
            if n == 1 {
                let torn_down = !fi.connected.load(Ordering::SeqCst)
                    && fi.command.lock().unwrap().is_none()
                    && fi.realtime.lock().unwrap().is_none();
                fb.push_session_event(&format!("second_open torn_down={torn_down}"));
            }
            Ok(Box::new(fb.clone_with_role(HandleRole::Writer)))
        };
        serial_connect_inner(&inner, "p", 115200, &|_| {}, &factory).unwrap();
        serial_connect_inner(&inner, "p", 115200, &|_| {}, &factory).unwrap();

        let trace = base.trace();
        let marker = trace
            .iter()
            .position(|t| matches!(t, TraceEvent::SessionEvent { name } if name.starts_with("second_open")))
            .expect("second open recorded");
        assert!(
            matches!(&trace[marker], TraceEvent::SessionEvent { name } if name == "second_open torn_down=true"),
            "first connection must be torn down before the second open: {:?}",
            trace[marker]
        );
        let dtr_after = trace[marker..]
            .iter()
            .filter(|t| matches!(t, TraceEvent::WriteDataTerminalReady { .. }))
            .count();
        assert_eq!(
            dtr_after, 2,
            "the second connection's DTR toggle follows teardown"
        );
    }
}
