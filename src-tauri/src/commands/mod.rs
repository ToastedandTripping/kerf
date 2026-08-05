// File I/O is handled entirely through tauri-plugin-fs with scoped permissions.
// No custom commands needed -- the plugin respects capability scopes.

pub mod gcode;
pub mod image_trace;
pub mod power;
pub mod serial;
pub mod serial_pump;
