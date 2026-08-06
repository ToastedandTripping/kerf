use crate::engine::tracer::{TraceParams, TraceResult};

#[tauri::command]
pub async fn trace_image_command(params: TraceParams) -> Result<TraceResult, String> {
    tokio::task::spawn_blocking(move || crate::engine::tracer::trace_image(params))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}
