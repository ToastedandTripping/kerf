use crate::engine::gcode_gen::{self, CutObject, GcodeResult};
use crate::engine::image_gcode_gen::{self, ImageEngraveRequest};
use crate::engine::optimizer;

/// Generate G-code from design objects
#[tauri::command]
pub fn generate_gcode(objects: Vec<CutObject>, workspace_height: f64) -> Result<GcodeResult, String> {
    // Optimize cut order
    let mut sorted = objects;

    // Separate by layer mode: cut inner first for line mode
    let mut line_objects: Vec<CutObject> = Vec::new();
    let mut fill_objects: Vec<CutObject> = Vec::new();

    for obj in sorted.drain(..) {
        if obj.layer.mode == "fill" || obj.layer.mode == "offsetFill" {
            fill_objects.push(obj);
        } else {
            line_objects.push(obj);
        }
    }

    // Sort inner first for line cuts
    optimizer::sort_inner_first(&mut line_objects);

    // Optimize travel order
    let line_order = optimizer::optimize_cut_order(&line_objects);
    let fill_order = optimizer::optimize_cut_order(&fill_objects);

    // Build final ordered list: engrave first (so cuts happen last)
    let mut final_objects: Vec<CutObject> = Vec::new();
    for &idx in &fill_order {
        final_objects.push(fill_objects[idx].clone());
    }
    for &idx in &line_order {
        final_objects.push(line_objects[idx].clone());
    }

    let result = gcode_gen::generate_gcode(&final_objects, workspace_height);
    Ok(result)
}

/// Generate G-code from an image for engraving
/// Runs in spawn_blocking since image processing is CPU-heavy
#[tauri::command]
pub async fn generate_image_gcode(request: ImageEngraveRequest) -> Result<GcodeResult, String> {
    tokio::task::spawn_blocking(move || {
        image_gcode_gen::generate(&request)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
