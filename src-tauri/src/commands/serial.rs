use serde::{Deserialize, Serialize};
use serialport::{self, SerialPort};
use std::io::{BufRead, BufReader, Write};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub name: String,
    pub port_type: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

pub struct SerialState {
    pub port: Mutex<Option<Box<dyn SerialPort>>>,
    pub connected: Mutex<bool>,
}

impl Default for SerialState {
    fn default() -> Self {
        Self {
            port: Mutex::new(None),
            connected: Mutex::new(false),
        }
    }
}

/// List available serial ports
#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports()
        .map_err(|e| format!("Failed to list ports: {}", e))?;

    Ok(ports
        .iter()
        .map(|p| match &p.port_type {
            serialport::SerialPortType::UsbPort(info) => PortInfo {
                name: p.port_name.clone(),
                port_type: format!("USB: {} {}",
                    info.manufacturer.as_deref().unwrap_or("Unknown"),
                    info.product.as_deref().unwrap_or("")),
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
                vid: None, pid: None, manufacturer: None, product: None,
            },
        })
        .collect())
}

/// Connect to a serial port
#[tauri::command]
pub fn serial_connect(
    state: State<'_, SerialState>,
    port_name: String,
    baud_rate: u32,
) -> Result<String, String> {
    let port = serialport::new(&port_name, baud_rate)
        .timeout(Duration::from_millis(1000))
        .open()
        .map_err(|e| format!("Failed to open port '{}': {}", port_name, e))?;

    // Wait for GRBL startup message
    let mut reader = BufReader::new(port.try_clone().map_err(|e| e.to_string())?);
    let mut startup = String::new();

    // Read lines until we get the GRBL banner or timeout
    for _ in 0..5 {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                startup.push_str(&line);
                if line.contains("Grbl") {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    *state.port.lock().unwrap() = Some(port);
    *state.connected.lock().unwrap() = true;

    if startup.is_empty() {
        Ok(format!("Connected to {} at {} baud", port_name, baud_rate))
    } else {
        Ok(startup.trim().to_string())
    }
}

/// Disconnect from serial port
#[tauri::command]
pub fn serial_disconnect(state: State<'_, SerialState>) -> Result<(), String> {
    *state.port.lock().unwrap() = None;
    *state.connected.lock().unwrap() = false;
    Ok(())
}

/// Send a command and get response
#[tauri::command]
pub fn serial_send(
    state: State<'_, SerialState>,
    command: String,
) -> Result<Vec<String>, String> {
    let mut port_lock = state.port.lock().unwrap();
    let port = port_lock.as_mut().ok_or("Not connected")?;

    // Send command with newline
    let cmd = if command.ends_with('\n') {
        command.clone()
    } else {
        format!("{}\n", command)
    };
    port.write_all(cmd.as_bytes())
        .map_err(|e| format!("Write error: {}", e))?;
    port.flush().map_err(|e| format!("Flush error: {}", e))?;

    // Read response lines
    let mut reader = BufReader::new(port.try_clone().map_err(|e| e.to_string())?);
    let mut responses = Vec::new();

    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() { continue; }
                let is_terminal = trimmed == "ok" || trimmed.starts_with("error:");
                responses.push(trimmed);
                if is_terminal { break; }
            }
            Err(_) => break,
        }
    }

    Ok(responses)
}

/// Send raw bytes (for soft reset 0x18, etc.)
#[tauri::command]
pub fn serial_send_byte(
    state: State<'_, SerialState>,
    byte: u8,
) -> Result<(), String> {
    let mut port_lock = state.port.lock().unwrap();
    let port = port_lock.as_mut().ok_or("Not connected")?;
    port.write_all(&[byte])
        .map_err(|e| format!("Write error: {}", e))?;
    port.flush().map_err(|e| format!("Flush error: {}", e))?;
    Ok(())
}

/// Query GRBL status (sends '?')
#[tauri::command]
pub fn serial_get_status(
    state: State<'_, SerialState>,
) -> Result<String, String> {
    let mut port_lock = state.port.lock().unwrap();
    let port = port_lock.as_mut().ok_or("Not connected")?;

    port.write_all(b"?")
        .map_err(|e| format!("Write error: {}", e))?;
    port.flush().map_err(|e| format!("Flush error: {}", e))?;

    let mut reader = BufReader::new(port.try_clone().map_err(|e| e.to_string())?);
    let mut line = String::new();
    reader.read_line(&mut line)
        .map_err(|e| format!("Read error: {}", e))?;

    Ok(line.trim().to_string())
}

/// Check if connected
#[tauri::command]
pub fn serial_is_connected(state: State<'_, SerialState>) -> bool {
    *state.connected.lock().unwrap()
}
