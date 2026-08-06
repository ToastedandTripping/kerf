//! Serial / GRBL command layer.
//!
//! LOCK INVARIANTS (Fortification W1a — F13):
//! - `SerialInner.command` guards the line-protocol channel (writes + THE persistent
//!   reader). A read pump may legitimately hold it for MINUTES (planner backpressure).
//! - `SerialInner.realtime` guards a `try_clone`'d handle used ONLY for single-byte
//!   real-time writes (`!`, `~`, `0x18`, `?`). **Real-time writes must never wait on
//!   the command lock** — that is the whole point of the split: e-stop bytes reach
//!   the wire while a line is in flight. Never acquire `realtime` while holding
//!   `command` (disconnect acquires them strictly in sequence, realtime first,
//!   released before command).
//! - Every command is `async` and does its blocking work inside `spawn_blocking`
//!   so a minutes-long pump can never freeze the Tauri event loop (matching the
//!   gcode.rs pattern). `SerialInner` is Arc-wrapped because `spawn_blocking`'s
//!   `'static` closures cannot capture `State<'_, _>`. No mutex guard is ever held
//!   across an await point (locks are taken only inside the blocking closures).
//! - `pump_in_flight` is the SOLE gate for disconnect's pre-lock soft reset (Rust
//!   cannot see the frontend's jobRunning): set inside the command lock immediately
//!   before a pump starts, cleared by an RAII guard so no panic/early-return path
//!   can leak it (a leaked flag would make every clean disconnect fire `0x18`,
//!   wiping volatile G92 work origins).

use serde::{Deserialize, Serialize};
use serialport::{self, SerialPort};
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::Duration;
use tauri::State;

use super::serial_pump::{
    self, ProbeWriter, PumpFailure, PumpReader, DEFAULT_LIVENESS_TICKS, STATUS_MAX_TICKS,
};

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

/// Result of `serial_get_status`. `status` is `""` when the command lock was busy
/// (a pump is mid-line) or the bounded read expired without a report — an Ok-typed
/// sentinel, NEVER an `Err`: three Err-skips in 750ms would trip the frontend's
/// 3-strike auto-disconnect and abort the very `$H` the busy-skip exists to tolerate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusOutcome {
    pub status: String,
    pub events: Vec<String>,
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
}

impl Default for SerialInner {
    fn default() -> Self {
        Self {
            command: Mutex::new(None),
            realtime: Mutex::new(None),
            connected: AtomicBool::new(false),
            pump_in_flight: AtomicBool::new(false),
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
        let ports = serialport::available_ports()
            .map_err(|e| format!("Failed to list ports: {}", e))?;

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

/// Connect to a serial port
#[tauri::command]
pub async fn serial_connect(
    state: State<'_, SerialState>,
    port_name: String,
    baud_rate: u32,
) -> Result<String, String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || {
        // P1-C: already-connected guard — if a connection is live, disconnect
        // first to prevent resource leaks. This handles rapid reconnect or
        // StrictMode double-mount on the frontend.
        if inner.connected.load(Ordering::SeqCst) {
            let _ = disconnect_inner(&inner);
        }

        let mut port = serialport::new(&port_name, baud_rate)
            .timeout(Duration::from_millis(1000))
            .open()
            .map_err(|e| format!("Failed to open port '{}': {}", port_name, e))?;

        // Hardware-reset the GRBL controller via DTR toggle. Arduino boards
        // connect DTR to RESET through a 100nF cap — the falling edge (assert)
        // pulses the MCU reset line. Deassert first to guarantee an edge
        // regardless of the adapter's initial DTR state.
        let _ = port.write_data_terminal_ready(false);
        std::thread::sleep(Duration::from_millis(50));
        let _ = port.write_data_terminal_ready(true);
        std::thread::sleep(Duration::from_millis(1500));

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
        std::thread::sleep(Duration::from_millis(500));
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

        if banner.trim().is_empty() {
            Ok(format!("Connected to {} at {} baud", port_name, baud_rate))
        } else {
            Ok(banner.trim().to_string())
        }
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
    tokio::task::spawn_blocking(move || disconnect_inner_with_job(&inner, job_active.unwrap_or(false)))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// Disconnect body (backwards-compatible wrapper). See `disconnect_inner_with_job`.
pub(crate) fn disconnect_inner(inner: &SerialInner) -> Result<(), String> {
    disconnect_inner_with_job(inner, false)
}

/// Disconnect body. The realtime `0x18` happens BEFORE any wait on the command
/// lock (pinned by `disconnect_aborts_in_flight_pump_via_realtime_reset`), and
/// ONLY when a pump is in flight OR `job_active` is true (defense-in-depth for
/// A2: disconnect beam-on). Clean idle disconnect still skips the reset
/// (pinned by `clean_disconnect_sends_no_reset`).
pub(crate) fn disconnect_inner_with_job(inner: &SerialInner, job_active: bool) -> Result<(), String> {
    if inner.pump_in_flight.load(Ordering::SeqCst) || job_active {
        if let Ok(mut rt) = inner.realtime.lock() {
            if let Some(port) = rt.as_mut() {
                let _ = port.write_all(&[0x18]);
                let _ = port.flush();
            }
        }
    }
    *inner
        .command
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))? = None;
    *inner
        .realtime
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))? = None;
    inner.connected.store(false, Ordering::SeqCst);
    Ok(())
}

/// Send a command line and pump until a terminal response (`ok` / `error:N` /
/// `ALARM…` / reset banner). See `serial_pump` for the protocol design.
#[tauri::command]
pub async fn serial_send(
    state: State<'_, SerialState>,
    command: String,
) -> Result<SendOutcome, String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || {
        let mut guard = inner
            .command
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        let channel = guard.as_mut().ok_or("Not connected")?;
        let _flight = PumpFlight::begin(&inner.pump_in_flight);

        // Pre-write drain: classify anything already buffered (a banner left by an
        // idle-time 0x18, an unsolicited ALARM, …) so it is never attributed to
        // THIS command.
        let drain = serial_pump::drain_classified(&mut channel.reader, &mut channel.pending);
        for line in &drain.dropped {
            eprintln!("[serial] drained stale line: {}", line);
        }

        let cmd = if command.ends_with('\n') {
            command.clone()
        } else {
            format!("{}\n", command)
        };
        channel
            .writer
            .write_all(cmd.as_bytes())
            .map_err(|e| format!("Write error: {}", e))?;
        channel
            .writer
            .flush()
            .map_err(|e| format!("Flush error: {}", e))?;

        match serial_pump::run_pump(
            &mut channel.reader,
            &mut channel.writer,
            &mut channel.pending,
            DEFAULT_LIVENESS_TICKS,
            serial_pump::DEFAULT_IDLE_STALL_TICKS,
        ) {
            Ok(out) => Ok(SendOutcome {
                responses: out.lines,
                drained: drain.surfaced,
            }),
            // Err here surfaces as an invoke rejection; the frontend maps it to
            // its existing "error:disconnected" contract.
            Err(PumpFailure::Disconnected(msg)) => Err(format!("disconnected: {}", msg)),
            Err(PumpFailure::Io(msg)) => Err(msg),
        }
    })
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

/// Query GRBL status (writes `?`, reads until a `<…>` report, bounded).
///
/// Uses `try_lock` on the command lock: the status poller fires every 250ms and a
/// manual `$H` legitimately pumps for 30s+ — polls must skip, not stack. The busy
/// skip returns the Ok-typed empty sentinel (see `StatusOutcome`).
#[tauri::command]
pub async fn serial_get_status(state: State<'_, SerialState>) -> Result<StatusOutcome, String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || {
        let mut guard = match inner.command.try_lock() {
            Ok(g) => g,
            Err(TryLockError::WouldBlock) => {
                // A pump is in flight: the port path is provably alive, so this is
                // "no data", not a failure.
                return Ok(StatusOutcome {
                    status: String::new(),
                    events: Vec::new(),
                });
            }
            Err(TryLockError::Poisoned(e)) => return Err(format!("Lock failed: {}", e)),
        };
        let channel = guard.as_mut().ok_or("Not connected")?;

        let read = serial_pump::read_status_bounded(
            &mut channel.reader,
            &mut channel.writer,
            &mut channel.pending,
            STATUS_MAX_TICKS,
        )?;
        for line in &read.dropped {
            eprintln!("[serial] status junk-skip: {}", line);
        }
        Ok(StatusOutcome {
            status: read.status.unwrap_or_default(),
            events: read.surfaced,
        })
    })
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
            Self { written: Arc::new(Mutex::new(Vec::new())) }
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
        });

        // Simulate an in-flight pump holding the command lock.
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
        };

        disconnect_inner(&inner).unwrap();
        assert!(written.lock().unwrap().is_empty(), "clean disconnect must not write 0x18");
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
            fn name(&self) -> Option<String> { Some("eof".to_string()) }
            fn baud_rate(&self) -> serialport::Result<u32> { Ok(115200) }
            fn data_bits(&self) -> serialport::Result<serialport::DataBits> { Ok(serialport::DataBits::Eight) }
            fn flow_control(&self) -> serialport::Result<serialport::FlowControl> { Ok(serialport::FlowControl::None) }
            fn parity(&self) -> serialport::Result<serialport::Parity> { Ok(serialport::Parity::None) }
            fn stop_bits(&self) -> serialport::Result<serialport::StopBits> { Ok(serialport::StopBits::One) }
            fn timeout(&self) -> Duration { Duration::from_millis(1000) }
            fn set_baud_rate(&mut self, _: u32) -> serialport::Result<()> { Ok(()) }
            fn set_data_bits(&mut self, _: serialport::DataBits) -> serialport::Result<()> { Ok(()) }
            fn set_flow_control(&mut self, _: serialport::FlowControl) -> serialport::Result<()> { Ok(()) }
            fn set_parity(&mut self, _: serialport::Parity) -> serialport::Result<()> { Ok(()) }
            fn set_stop_bits(&mut self, _: serialport::StopBits) -> serialport::Result<()> { Ok(()) }
            fn set_timeout(&mut self, _: Duration) -> serialport::Result<()> { Ok(()) }
            fn write_request_to_send(&mut self, _: bool) -> serialport::Result<()> { Ok(()) }
            fn write_data_terminal_ready(&mut self, _: bool) -> serialport::Result<()> { Ok(()) }
            fn read_clear_to_send(&mut self) -> serialport::Result<bool> { Ok(false) }
            fn read_data_set_ready(&mut self) -> serialport::Result<bool> { Ok(false) }
            fn read_ring_indicator(&mut self) -> serialport::Result<bool> { Ok(false) }
            fn read_carrier_detect(&mut self) -> serialport::Result<bool> { Ok(false) }
            fn bytes_to_read(&self) -> serialport::Result<u32> { Ok(0) }
            fn bytes_to_write(&self) -> serialport::Result<u32> { Ok(0) }
            fn clear(&self, _: serialport::ClearBuffer) -> serialport::Result<()> { Ok(()) }
            fn try_clone(&self) -> serialport::Result<Box<dyn SerialPort>> {
                Ok(Box::new(EofPort))
            }
            fn set_break(&self) -> serialport::Result<()> { Ok(()) }
            fn clear_break(&self) -> serialport::Result<()> { Ok(()) }
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
        };

        disconnect_inner_with_job(&inner, false).unwrap();
        assert!(
            written.lock().unwrap().is_empty(),
            "clean disconnect (no job, no pump) must not write 0x18"
        );
        assert!(!inner.connected.load(Ordering::SeqCst));
    }

    /// P1-C: already-connected guard — calling serial_connect on a connected
    /// inner should disconnect first. Verified via the connected flag lifecycle.
    #[test]
    fn already_connected_guard_disconnects_first() {
        let inner = SerialInner {
            command: Mutex::new(None),
            realtime: Mutex::new(Some(Box::new(MockPort::new()) as Box<dyn SerialPort>)),
            connected: AtomicBool::new(true),
            pump_in_flight: AtomicBool::new(false),
        };

        // Simulate the guard: if connected, disconnect first
        if inner.connected.load(Ordering::SeqCst) {
            let _ = disconnect_inner(&inner);
        }

        // After disconnect, connected should be false
        assert!(!inner.connected.load(Ordering::SeqCst));
        // And the channels should be cleared
        assert!(inner.command.lock().unwrap().is_none());
        assert!(inner.realtime.lock().unwrap().is_none());
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
        let sim = SimPort::new(SimConfig { planner_depth: 15, line_ticks: 1, ..SimConfig::default() });
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        sim.set_drop_ok_at_line(1); // the very next accepted line never acks

        writer.write_all(b"G1 X1\n").unwrap();
        let result = serial_pump::run_pump(&mut reader, &mut writer, &mut pending, DEFAULT_LIVENESS_TICKS, 3);
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

        let result =
            serial_pump::run_pump(&mut reader, &mut writer, &mut pending, 3, serial_pump::DEFAULT_IDLE_STALL_TICKS);
        match result {
            Err(serial_pump::PumpFailure::Disconnected(msg)) => {
                assert!(msg.contains("probe ticks") || msg.contains("no response"), "got: {msg}");
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
        let sim = SimPort::new(SimConfig { planner_depth: 15, line_ticks: 1000, ..SimConfig::default() });
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
        )
        .unwrap();
        assert_eq!(out.terminal, serial_pump::PumpTerminal::Alarm);
        assert!(out.lines.iter().any(|l| l.starts_with("ALARM")), "got: {:?}", out.lines);
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
        )
        .unwrap();
        assert_eq!(out.terminal, serial_pump::PumpTerminal::Banner);
        assert!(out.lines.iter().any(|l| l.contains("Grbl")), "got: {:?}", out.lines);
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

    // 10. Pause volley: [!, 0x9E] — feedHold + spindle-stop-override.
    // After the volley, spindle_energized() must be false (beam off during
    // pause). Zero hold-invariant violations (no line commands in Hold).
    #[test]
    fn pause_volley_clears_spindle_and_zero_hold_violations() {
        use crate::sim::grbl::MachineState;

        let sim = SimPort::new(SimConfig::default());
        let mut writer = sim.try_clone().unwrap();
        let mut reader = BufReader::new(sim.try_clone().unwrap());
        let mut pending = Vec::new();
        let _ = serial_pump::drain_classified(&mut reader, &mut pending); // drain banner

        // Start spindle and a motion command so we're in Run state
        writer.write_all(b"M3 S1000\n").unwrap();
        let _ = serial_pump::run_pump(
            &mut reader, &mut writer, &mut pending,
            DEFAULT_LIVENESS_TICKS, serial_pump::DEFAULT_IDLE_STALL_TICKS,
        ).unwrap();
        assert!(sim.spindle_energized(), "spindle must be on after M3");

        writer.write_all(b"G1 X50 F500\n").unwrap();
        let _ = serial_pump::run_pump(
            &mut reader, &mut writer, &mut pending,
            DEFAULT_LIVENESS_TICKS, serial_pump::DEFAULT_IDLE_STALL_TICKS,
        ).unwrap();

        // Pause volley: [!, 0x9E]
        writer.write_all(b"!").unwrap();
        assert_eq!(sim.machine_state(), MachineState::Hold);
        writer.write_all(&[0x9E]).unwrap();

        // Assertions
        assert!(
            sim.hold_invariant_violations().is_empty(),
            "pause volley must cause zero hold-invariant violations"
        );
        assert!(
            !sim.spindle_energized(),
            "spindle must be off after pause volley [!, 0x9E]"
        );
        assert_eq!(
            sim.realtime_bytes_received(),
            vec![b'!', 0x9E],
            "exact pause volley bytes on the wire"
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
            &mut reader, &mut writer, &mut pending,
            DEFAULT_LIVENESS_TICKS, serial_pump::DEFAULT_IDLE_STALL_TICKS,
        ).unwrap();
        writer.write_all(b"G1 X50 F500\n").unwrap();
        let _ = serial_pump::run_pump(
            &mut reader, &mut writer, &mut pending,
            DEFAULT_LIVENESS_TICKS, serial_pump::DEFAULT_IDLE_STALL_TICKS,
        ).unwrap();

        // Pause volley
        writer.write_all(b"!").unwrap();
        writer.write_all(&[0x9E]).unwrap();
        assert!(!sim.spindle_energized());

        // Resume volley: [~]
        writer.write_all(b"~").unwrap();

        // The machine exits Hold
        let state = sim.machine_state();
        assert!(
            state == MachineState::Run || state == MachineState::Idle,
            "machine must leave Hold after resume, got: {:?}", state
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
            &mut reader, &mut writer, &mut pending,
            DEFAULT_LIVENESS_TICKS, serial_pump::DEFAULT_IDLE_STALL_TICKS,
        ).unwrap();
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
}
