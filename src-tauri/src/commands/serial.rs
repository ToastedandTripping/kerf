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

/// Connect to a serial port
#[tauri::command]
pub async fn serial_connect(
    state: State<'_, SerialState>,
    port_name: String,
    baud_rate: u32,
) -> Result<String, String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || {
        let port = serialport::new(&port_name, baud_rate)
            .timeout(Duration::from_millis(1000))
            .open()
            .map_err(|e| format!("Failed to open port '{}': {}", port_name, e))?;

        let realtime = port.try_clone().map_err(|e| e.to_string())?;
        let reader_port = port.try_clone().map_err(|e| e.to_string())?;
        let mut channel = CommandChannel {
            writer: port,
            reader: BufReader::new(reader_port),
            pending: Vec::new(),
        };

        // Read the GRBL startup banner through THE persistent reader — no reader
        // is ever constructed after connect.
        let mut startup = String::new();
        for _ in 0..5 {
            match channel.reader.read_until(b'\n', &mut channel.pending) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&channel.pending).to_string();
                    channel.pending.clear();
                    let done = line.contains("Grbl");
                    startup.push_str(&line);
                    if done {
                        break;
                    }
                }
                Err(_) => break,
            }
        }

        *inner
            .command
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))? = Some(channel);
        *inner
            .realtime
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))? = Some(realtime);
        inner.connected.store(true, Ordering::SeqCst);

        if startup.trim().is_empty() {
            Ok(format!("Connected to {} at {} baud", port_name, baud_rate))
        } else {
            Ok(startup.trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Disconnect from serial port.
///
/// When a pump is mid-line it holds the command lock for up to the line's
/// duration — abort it via a realtime `0x18` FIRST so disconnect is prompt. The
/// reset is gated on `pump_in_flight`: an unconditional reset on a clean
/// disconnect would wipe volatile G92 work origins on stock GRBL 1.1
/// (Set Origin → Disconnect → origin gone).
#[tauri::command]
pub async fn serial_disconnect(state: State<'_, SerialState>) -> Result<(), String> {
    let inner = state.0.clone();
    tokio::task::spawn_blocking(move || disconnect_inner(&inner))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// Disconnect body. The realtime `0x18` happens BEFORE any wait on the command
/// lock (pinned by `disconnect_aborts_in_flight_pump_via_realtime_reset`), and
/// ONLY when a pump is in flight (pinned by `clean_disconnect_sends_no_reset`).
pub(crate) fn disconnect_inner(inner: &SerialInner) -> Result<(), String> {
    if inner.pump_in_flight.load(Ordering::SeqCst) {
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
}
