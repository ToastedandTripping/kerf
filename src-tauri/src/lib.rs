mod commands;
mod engine;

use commands::serial::SerialState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(SerialState::default())
        .invoke_handler(tauri::generate_handler![
            commands::file_io::read_file,
            commands::file_io::write_file,
            commands::gcode::generate_gcode,
            commands::serial::list_serial_ports,
            commands::serial::serial_connect,
            commands::serial::serial_disconnect,
            commands::serial::serial_send,
            commands::serial::serial_send_byte,
            commands::serial::serial_get_status,
            commands::serial::serial_is_connected,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
