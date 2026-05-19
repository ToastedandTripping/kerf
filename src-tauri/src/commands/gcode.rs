use base64::Engine;
use image::ImageEncoder;

use crate::engine::gcode_gen::{self, CutObject, GcodeResult};
use crate::engine::image_gcode_gen::{self, ImageEngraveRequest};
use crate::engine::optimizer;

/// Generate G-code from design objects
#[tauri::command]
pub fn generate_gcode(objects: Vec<CutObject>, workspace_height: f64, s_value_max: Option<f64>) -> Result<GcodeResult, String> {
    let s_value_max = s_value_max.unwrap_or(1000.0);
    // Optimize cut order
    let mut sorted = objects;

    // Separate by layer mode: cut inner first for line mode
    let mut line_objects: Vec<CutObject> = Vec::new();
    let mut fill_objects: Vec<CutObject> = Vec::new();

    for obj in sorted.drain(..) {
        if obj.layer.mode == "fill" {
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

    let result = gcode_gen::generate_gcode(&final_objects, workspace_height, s_value_max);
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

/// Preview dithered image: returns base64 PNG of the processed/dithered result
/// along with dimensions and the dither method used.
#[tauri::command]
pub async fn preview_image_dither(request: ImageEngraveRequest) -> Result<PreviewDitherResult, String> {
    tokio::task::spawn_blocking(move || {
        let dither_method = request.dither.clone();
        let (pixels, width, height) = image_gcode_gen::preview_dither(&request)?;

        // Encode as PNG
        let mut png_buf = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut png_buf);
        encoder.write_image(&pixels, width, height, image::ExtendedColorType::L8)
            .map_err(|e| format!("PNG encode error: {}", e))?;

        let b64 = base64::engine::general_purpose::STANDARD.encode(&png_buf);
        let data_uri = format!("data:image/png;base64,{}", b64);

        Ok(PreviewDitherResult {
            image_data: data_uri,
            width,
            height,
            dither_method,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDitherResult {
    pub image_data: String,
    pub width: u32,
    pub height: u32,
    pub dither_method: String,
}
