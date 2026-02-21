use std::fs;
use std::path::PathBuf;

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(PathBuf::from(&path))
        .map_err(|e| format!("Failed to read file '{}': {}", path, e))
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    fs::write(PathBuf::from(&path), contents)
        .map_err(|e| format!("Failed to write file '{}': {}", path, e))
}
