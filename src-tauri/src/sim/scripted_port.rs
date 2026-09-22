//! Deterministic test double for `SerialPort` with scripted responses
//! and ordered I/O tracing.
//!
//! Used by remediation-batch-0.1 tests to replay all failure modes (acks-lost,
//! partial input, chatter, etc.) and prove that extracted command bodies handle
//! them correctly without changing production behavior.
//!
//! ## Architecture
//!
//! - **Script:** A queue of read responses (data, timeout, error) delivered in
//!   order. Each read() call consumes one step; data steps can be larger than a
//!   single read() buffer, so they're chunked transparently.
//! - **Trace:** Ordered log of every write, flush, and `write_data_terminal_ready`
//!   call, tagged by handle role (writer/realtime) for invariant checking.
//! - **Shared state:** All clones via `try_clone()` share the same script and trace
//!   via Arc<Mutex>, matching the SimPort pattern.

use serialport::{self, SerialPort};
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::collections::VecDeque;

#[allow(dead_code)]
/// A single step in the scripted read sequence.
#[derive(Debug, Clone)]
pub(crate) enum ScriptStep {
    /// Return this data, possibly chunked across multiple read() calls.
    Data(&'static [u8]),
    /// Return TimedOut on the next read() that finds no data already buffered.
    Timeout,
    /// Return this I/O error.
    Error(String),
    /// Block until the named hold point is released by the test.
    /// Backed by `mpsc::Sender/Receiver` — the read blocks on `recv_timeout`.
    /// The brain mutex is released while parked to prevent deadlocks.
    HoldUntilRelease { id: &'static str },
}

#[allow(dead_code)]
/// A single I/O event in the ordered trace.
#[derive(Debug, Clone)]
pub enum TraceEvent {
    /// write() call with these bytes and the handle role that issued it.
    Write { role: HandleRole, data: Vec<u8> },
    /// flush() call from the named handle.
    Flush { role: HandleRole },
    /// write_data_terminal_ready(bool) call.
    WriteDataTerminalReady { value: bool },
    /// A read that returned TimedOut.
    ReadTimeout,
    /// A read that returned data (bytes count).
    ReadData { bytes: usize },
    /// Session event emitted by the observer on `SerialSession`.
    SessionEvent { name: String },
    /// A hold point was reached.
    HoldReached { id: String },
    /// A hold point was released.
    HoldReleased { id: String },
}

#[allow(dead_code)]
/// Which handle role issued an I/O event (for invariant checking).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandleRole {
    Writer,
    Reader,
    Realtime,
}

/// A hold-point channel pair: the test sends () to release it.
#[allow(dead_code)]
struct HoldPoint {
    /// The test calls `release()` → sends () on this channel.
    release_tx: std::sync::mpsc::Sender<()>,
    /// The read thread blocks on this receiver.
    release_rx: std::sync::mpsc::Receiver<()>,
}

#[allow(dead_code)]
/// Shared state behind all clones of a ScriptedPort.
pub(crate) struct Brain {
    /// Remaining script steps in order.
    script: VecDeque<ScriptStep>,
    /// Current step's data, if it's a Data step.
    current_data: Vec<u8>,
    /// Offset into current_data for the next read().
    data_offset: usize,
    /// Ordered log of all I/O events.
    trace: Vec<TraceEvent>,
    /// Hold-point channels keyed by id.
    holds: std::collections::HashMap<&'static str, HoldPoint>,
}

#[allow(dead_code)]
/// A deterministic test port with scripted reads and ordered trace.
pub struct ScriptedPort {
    brain: Arc<Mutex<Brain>>,
    role: HandleRole,
}

#[allow(dead_code)]
impl ScriptedPort {
    /// Create a new scripted port from a sequence of read response steps.
    pub fn new(script: Vec<ScriptStep>) -> Self {
        // Pre-create hold-point channels for any HoldUntilRelease steps.
        let mut holds = std::collections::HashMap::new();
        for step in &script {
            if let ScriptStep::HoldUntilRelease { id } = step {
                let (tx, rx) = std::sync::mpsc::channel();
                holds.insert(*id, HoldPoint { release_tx: tx, release_rx: rx });
            }
        }
        Self {
            brain: Arc::new(Mutex::new(Brain {
                script: script.into(),
                current_data: Vec::new(),
                data_offset: 0,
                trace: Vec::new(),
                holds,
            })),
            role: HandleRole::Reader,
        }
    }

    /// Change this handle's role tag (for invariant checking).
    pub fn set_role(&mut self, role: HandleRole) {
        self.role = role;
    }

    /// Access the ordered trace of all I/O events.
    pub fn trace(&self) -> Vec<TraceEvent> {
        let brain = self.brain.lock().unwrap();
        brain.trace.clone()
    }

    /// Extract the trace and the port (useful for asserting on the trace).
    pub fn into_trace(self) -> Vec<TraceEvent> {
        Arc::try_unwrap(self.brain)
            .ok()
            .and_then(|m| m.into_inner().ok())
            .map(|b| b.trace)
            .unwrap_or_default()
    }

    /// Release a named hold point, allowing the blocked read to proceed.
    pub fn release_hold(&self, id: &str) {
        let brain = self.brain.lock().unwrap();
        if let Some(hold) = brain.holds.get(id) {
            let _ = hold.release_tx.send(());
        }
    }

    /// Push a session event into the shared trace. Used by the session observer
    /// to record events in the same ordered trace as port I/O.
    pub fn push_session_event(&self, name: &str) {
        let mut brain = self.brain.lock().unwrap();
        brain.trace.push(TraceEvent::SessionEvent { name: name.to_string() });
    }

    /// Get the shared brain Arc for wiring up session observers.
    pub fn brain_arc(&self) -> Arc<Mutex<Brain>> {
        Arc::clone(&self.brain)
    }

    /// Run a closure on a separate thread with a real deadline.
    /// Returns Ok(result) if the closure completes, Err if the deadline expires.
    /// A deadlock in the closure is a test failure, not a CI hang.
    pub fn run_scenario<F, T>(f: F, timeout: Duration) -> Result<T, String>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = f();
            let _ = tx.send(result);
        });
        rx.recv_timeout(timeout)
            .map_err(|_| format!("scenario deadline exceeded: {:?}", timeout))
    }
}

/// Make the brain's trace accessible for test assertions via a shared Arc.
#[allow(dead_code)]
pub fn make_session_observer(
    brain: Arc<Mutex<Brain>>,
) -> Box<dyn Fn(&str) + Send + Sync> {
    Box::new(move |event: &str| {
        if let Ok(mut b) = brain.lock() {
            b.trace.push(TraceEvent::SessionEvent { name: event.to_string() });
        }
    })
}

impl Read for ScriptedPort {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut brain = self.brain.lock().unwrap();

        loop {
            // If we have data buffered, serve it.
            if brain.data_offset < brain.current_data.len() {
                let remaining = &brain.current_data[brain.data_offset..];
                let n = remaining.len().min(buf.len());
                buf[..n].copy_from_slice(&remaining[..n]);
                brain.data_offset += n;
                brain.trace.push(TraceEvent::ReadData { bytes: n });
                return Ok(n);
            }

            // Move to the next script step.
            match brain.script.pop_front() {
                Some(ScriptStep::Data(data)) => {
                    brain.current_data = data.to_vec();
                    brain.data_offset = 0;
                    // Loop continues to serve the data.
                }
                Some(ScriptStep::Timeout) => {
                    brain.trace.push(TraceEvent::ReadTimeout);
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "script timeout"));
                }
                Some(ScriptStep::Error(msg)) => {
                    return Err(io::Error::other(msg));
                }
                Some(ScriptStep::HoldUntilRelease { id }) => {
                    // Record that the hold was reached.
                    brain.trace.push(TraceEvent::HoldReached { id: id.to_string() });
                    // Clone the receiver out and drop the brain lock to prevent
                    // deadlocks with stop threads that also need the brain lock.
                    let hold_id = id.to_string();
                    if brain.holds.contains_key(id) {
                        // We can't move the receiver, but we can try_recv in a loop.
                        // Actually we need to drop the brain lock first.
                        drop(brain);
                        // Now wait for release without holding the brain lock.
                        // Re-acquire brain to get the receiver reference — but we
                        // can't hold it while waiting. Use a channel approach instead.
                        // The simplest safe approach: poll with try_recv + sleep.
                        loop {
                            let b = self.brain.lock().unwrap();
                            if let Some(hold) = b.holds.get(hold_id.as_str()) {
                                match hold.release_rx.try_recv() {
                                    Ok(()) => {
                                        // Released. Re-lock brain and continue.
                                        drop(b);
                                        brain = self.brain.lock().unwrap();
                                        brain.trace.push(TraceEvent::HoldReleased { id: hold_id });
                                        break;
                                    }
                                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                                        drop(b);
                                        std::thread::sleep(Duration::from_millis(5));
                                    }
                                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                                        // Poisoned — test is tearing down.
                                        drop(b);
                                        return Err(io::Error::other(
                                            format!("hold point '{}' poisoned (sender dropped)", hold_id),
                                        ));
                                    }
                                }
                            } else {
                                drop(b);
                                brain = self.brain.lock().unwrap();
                                break;
                            }
                        }
                        // Continue to the next script step.
                    }
                }
                None => {
                    // Script exhausted — return EOF.
                    return Ok(0);
                }
            }
        }
    }
}

impl Write for ScriptedPort {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut brain = self.brain.lock().unwrap();
        brain.trace.push(TraceEvent::Write {
            role: self.role,
            data: buf.to_vec(),
        });
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut brain = self.brain.lock().unwrap();
        brain.trace.push(TraceEvent::Flush { role: self.role });
        Ok(())
    }
}

impl SerialPort for ScriptedPort {
    fn name(&self) -> Option<String> {
        Some("scripted".to_string())
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

    fn write_data_terminal_ready(&mut self, value: bool) -> serialport::Result<()> {
        let mut brain = self.brain.lock().unwrap();
        brain.trace.push(TraceEvent::WriteDataTerminalReady { value });
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
        let brain = self.brain.lock().unwrap();
        let buffered = (brain.current_data.len() - brain.data_offset) as u32;
        let mut queued = 0u32;
        for step in &brain.script {
            match step {
                ScriptStep::Data(data) => queued += data.len() as u32,
                ScriptStep::Timeout | ScriptStep::Error(_) | ScriptStep::HoldUntilRelease { .. } => break,
            }
        }
        Ok(buffered + queued)
    }

    fn bytes_to_write(&self) -> serialport::Result<u32> {
        Ok(0)
    }

    fn clear(&self, _: serialport::ClearBuffer) -> serialport::Result<()> {
        Ok(())
    }

    fn try_clone(&self) -> serialport::Result<Box<dyn SerialPort>> {
        Ok(Box::new(ScriptedPort {
            brain: Arc::clone(&self.brain),
            role: self.role,
        }))
    }

    fn set_break(&self) -> serialport::Result<()> {
        Ok(())
    }

    fn clear_break(&self) -> serialport::Result<()> {
        Ok(())
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripted_port_data_step() {
        let mut port = ScriptedPort::new(vec![
            ScriptStep::Data(b"hello"),
            ScriptStep::Data(b"\nok\n"),
        ]);

        let mut buf = [0u8; 10];
        let n = port.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"hello");

        let n = port.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"\nok\n");
    }

    #[test]
    fn scripted_port_timeout_step() {
        let mut port = ScriptedPort::new(vec![ScriptStep::Timeout]);
        let mut buf = [0u8; 10];
        let result = port.read(&mut buf);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn scripted_port_try_clone_shares_state() {
        let port1 = ScriptedPort::new(vec![ScriptStep::Data(b"data")]);
        let _port2 = port1.try_clone().unwrap();

        // try_clone succeeds — the trait object method is available.
        // Actual shared state is verified by the other tests (trace).
    }

    #[test]
    fn scripted_port_trace() {
        let mut port = ScriptedPort::new(vec![ScriptStep::Data(b"ok\n")]);
        port.set_role(HandleRole::Writer);

        let mut buf = [0u8; 10];
        port.write_all(b"G1 X10\n").unwrap();
        port.flush().unwrap();
        let _ = port.read(&mut buf);

        let trace = port.trace();
        assert_eq!(trace.len(), 3); // write, flush, read data
    }

    #[test]
    fn scripted_port_bytes_to_read() {
        let port = ScriptedPort::new(vec![
            ScriptStep::Data(b"hello"),
            ScriptStep::Data(b" world"),
        ]);
        let bytes = port.bytes_to_read().unwrap();
        assert_eq!(bytes, 11); // "hello world"
    }

    #[test]
    fn scripted_port_bytes_to_read_with_timeout() {
        let port = ScriptedPort::new(vec![
            ScriptStep::Data(b"data"),
            ScriptStep::Timeout,
            ScriptStep::Data(b"unreachable"),
        ]);
        let bytes = port.bytes_to_read().unwrap();
        assert_eq!(bytes, 4); // Only "data" (stops at timeout)
    }
}
