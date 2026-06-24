mod commands;
mod engine;

use commands::power::KeepAwakeState;
use commands::serial::SerialState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(SerialState::default())
        .manage(KeepAwakeState::default())
        .invoke_handler(tauri::generate_handler![
            commands::gcode::generate_gcode,
            commands::gcode::generate_image_gcode,
            commands::gcode::preview_image_dither,
            commands::serial::list_serial_ports,
            commands::serial::serial_connect,
            commands::serial::serial_disconnect,
            commands::serial::serial_send,
            commands::serial::serial_send_byte,
            commands::serial::serial_get_status,
            commands::serial::serial_is_connected,
            commands::image_trace::trace_image_command,
            commands::power::keep_awake_acquire,
            commands::power::keep_awake_release,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
