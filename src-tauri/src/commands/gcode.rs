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

        let sorted = objects;

        // F7: Group by layer_index to preserve user-set layer order.
        // Within each layer group:
        //   - line mode: apply inner-first, then NN travel optimization
        //   - fill/offsetFill: NN travel optimization only (inner-first irrelevant for fills)
        // Emit groups in the order their layer_index values first appear.

        // Collect unique layer indices in arrival order
        let mut layer_order: Vec<i32> = Vec::new();
        for obj in &sorted {
            let li = obj.layer_index.unwrap_or(0);
            if !layer_order.contains(&li) {
                layer_order.push(li);
            }
        }

        let mut final_objects: Vec<CutObject> = Vec::new();
        let mut cur_x = start_x;
        let mut cur_y = start_y;

        for &li in &layer_order {
            let mut layer_objs: Vec<CutObject> = sorted.iter()
                .filter(|o| o.layer_index.unwrap_or(0) == li)
                .cloned()
                .collect();

            // Determine mode for this layer group (use first object's mode)
            let is_line_mode = layer_objs.first()
                .map(|o| o.layer.mode.as_str() == "line")
                .unwrap_or(false);

            if is_line_mode {
                // Inner-first (smaller bbox area first) then NN
                optimizer::sort_inner_first(&mut layer_objs);
            }

            let order = optimizer::optimize_cut_order_from(&layer_objs, cur_x, cur_y);

            for &idx in &order {
                let obj = &layer_objs[idx];
                // Update current position to end of this object
                cur_x = obj.x + obj.width;
                cur_y = obj.y + obj.height;
                final_objects.push(obj.clone());
            }
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
