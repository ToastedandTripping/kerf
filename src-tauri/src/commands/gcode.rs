use base64::Engine;
use image::ImageEncoder;

use crate::engine::gcode_gen::{self, CutObject, GcodeResult};
use crate::engine::image_gcode_gen::{self, ImageEngraveRequest};
use crate::engine::optimizer;

/// Compute the start point for nearest-neighbor from a corner name + workspace dims.
/// When origin_top is true, Y=0 is at the top (no Y-flip), so the mapping inverts.
fn start_point_from_corner(corner: &str, width: f64, height: f64, origin_top: bool) -> (f64, f64) {
    if origin_top {
        match corner {
            "bottomRight" => (width, -height),
            "topLeft" => (0.0, 0.0),
            "topRight" => (width, 0.0),
            "center" => (width / 2.0, -height / 2.0),
            _ => (0.0, -height), // "bottomLeft" or default
        }
    } else {
        match corner {
            "bottomRight" => (width, 0.0),
            "topLeft" => (0.0, height),
            "topRight" => (width, height),
            "center" => (width / 2.0, height / 2.0),
            _ => (0.0, 0.0), // "bottomLeft" or default
        }
    }
}

/// Generate G-code from design objects
/// Runs in spawn_blocking since G-code generation with optimization is CPU-heavy
#[tauri::command]
pub async fn generate_gcode(
    objects: Vec<CutObject>,
    workspace_height: f64,
    s_value_max: Option<f64>,
    start_corner: Option<String>,
    workspace_width: Option<f64>,
    origin_top: Option<bool>,
) -> Result<GcodeResult, String> {
    tokio::task::spawn_blocking(move || {
        let s_value_max = s_value_max.unwrap_or(1000.0);
        let ws_width = workspace_width.unwrap_or(500.0);
        let origin_top = origin_top.unwrap_or(false);
        let corner = start_corner.as_deref().unwrap_or("bottomLeft");
        let (start_x, start_y) = start_point_from_corner(corner, ws_width, workspace_height, origin_top);

        let mut sorted = objects;

        // Apply multi-criteria sort (priority, group, inner-first)
        optimizer::multi_criteria_sort(&mut sorted, start_x, start_y);

        // Separate by layer mode: cut inner first for line mode
        let mut line_objects: Vec<CutObject> = Vec::new();
        let mut fill_objects: Vec<CutObject> = Vec::new();
        let mut offset_fill_objects: Vec<CutObject> = Vec::new();

        for obj in sorted.drain(..) {
            match obj.layer.mode.as_str() {
                "fill" => fill_objects.push(obj),
                "offsetFill" => offset_fill_objects.push(obj),
                _ => line_objects.push(obj),
            }
        }

        // Sort inner first for line cuts
        optimizer::sort_inner_first(&mut line_objects);

        // Optimize travel order from the configured start point
        let line_order = optimizer::optimize_cut_order_from(&line_objects, start_x, start_y);
        let fill_order = optimizer::optimize_cut_order_from(&fill_objects, start_x, start_y);
        let offset_order = optimizer::optimize_cut_order_from(&offset_fill_objects, start_x, start_y);

        // Build final ordered list: engrave first, then offset fills, then cuts
        let mut final_objects: Vec<CutObject> = Vec::new();
        for &idx in &fill_order {
            final_objects.push(fill_objects[idx].clone());
        }
        for &idx in &offset_order {
            final_objects.push(offset_fill_objects[idx].clone());
        }
        for &idx in &line_order {
            final_objects.push(line_objects[idx].clone());
        }

        let result = gcode_gen::generate_gcode(&final_objects, workspace_height, s_value_max, origin_top);
        Ok(result)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
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
