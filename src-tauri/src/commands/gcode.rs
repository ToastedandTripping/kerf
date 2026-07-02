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
            let layer_objs: Vec<CutObject> = sorted.iter()
                .filter(|o| o.layer_index.unwrap_or(0) == li)
                .cloned()
                .collect();

            // A4b (must-fix #2): partition fill-ish and line objects within a layer
            // so that ALL fill passes precede ALL line (perimeter) passes.
            // For a fillLine layer both maskFill/fill objects AND line overlay objects
            // share the same layer_index — without partition, NN reordering could
            // interleave them, cutting the perimeter before the fill finishes and
            // shifting the workpiece. For pre-fillLine layers every object has one
            // mode, so the partition is a no-op.
            let is_fill_ish = |mode: &str| {
                matches!(mode, "fill" | "maskFill" | "offsetFill")
            };

            let has_mixed = layer_objs.iter().any(|o| is_fill_ish(&o.layer.mode))
                && layer_objs.iter().any(|o| o.layer.mode == "line");

            if has_mixed {
                // Partition into fill-ish and line groups
                let fill_group: Vec<CutObject> = layer_objs.iter()
                    .filter(|o| is_fill_ish(&o.layer.mode))
                    .cloned()
                    .collect();
                let line_group: Vec<CutObject> = layer_objs.iter()
                    .filter(|o| o.layer.mode == "line")
                    .cloned()
                    .collect();

                // Fill-ish: NN optimize (inner-first not meaningful for fills)
                let fill_order = optimizer::optimize_cut_order_from(&fill_group, cur_x, cur_y);
                for &idx in &fill_order {
                    let obj = &fill_group[idx];
                    cur_x = obj.x + obj.width;
                    cur_y = obj.y + obj.height;
                    final_objects.push(obj.clone());
                }

                // Line: inner-first (toggle on, default) or pure NN (toggle off),
                // starting from where fills ended.
                // Operational note: cut_inner_first defaults true, so existing line layers
                // switch from plain NN to inner-first order on first generate — intended.
                // Toggle off is the instant escape hatch if a real-world cut regresses.
                // All objects in this layer group share one layer definition; reading the
                // first object's flag is correct. (If per-object overrides are ever added,
                // this becomes a per-object branch rather than a group-level read.)
                let inner_first = line_group.first().map(|o| o.layer.cut_inner_first).unwrap_or(true);
                let line_order = if inner_first {
                    optimizer::order_inner_first_nn(&line_group, cur_x, cur_y)
                } else {
                    optimizer::optimize_cut_order_from(&line_group, cur_x, cur_y)
                };
                for &idx in &line_order {
                    let obj = &line_group[idx];
                    cur_x = obj.x + obj.width;
                    cur_y = obj.y + obj.height;
                    final_objects.push(obj.clone());
                }
            } else {
                // Homogeneous layer (pre-fillLine case — no-op partition)
                let is_line_mode = layer_objs.first()
                    .map(|o| o.layer.mode.as_str() == "line")
                    .unwrap_or(false);

                // Pure-fill layers stay pure NN even with the toggle on (is_line_mode guard).
                let order = if is_line_mode {
                    // All objects in this layer group share one layer definition; reading the
                    // first object's flag is correct. (If per-object overrides are ever added,
                    // this becomes a per-object branch rather than a group-level read.)
                    let inner_first = layer_objs.first().map(|o| o.layer.cut_inner_first).unwrap_or(true);
                    if inner_first {
                        optimizer::order_inner_first_nn(&layer_objs, cur_x, cur_y)
                    } else {
                        optimizer::optimize_cut_order_from(&layer_objs, cur_x, cur_y)
                    }
                } else {
                    optimizer::optimize_cut_order_from(&layer_objs, cur_x, cur_y)
                };
                for &idx in &order {
                    let obj = &layer_objs[idx];
                    cur_x = obj.x + obj.width;
                    cur_y = obj.y + obj.height;
                    final_objects.push(obj.clone());
                }
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

#[cfg(test)]
mod tests {
    use crate::engine::gcode_gen::{CutLayer, CutObject};
    use crate::engine::optimizer;

    /// Test-local helper: apply A4b partition (fill-ish before line) and return
    /// the result as a flat Vec.  Mirrors the inlined logic in generate_gcode.
    fn sort_fill_before_line(objs: Vec<CutObject>, start_x: f64, start_y: f64) -> Vec<CutObject> {
        let is_fill_ish = |mode: &str| matches!(mode, "fill" | "maskFill" | "offsetFill");
        let has_mixed = objs.iter().any(|o| is_fill_ish(&o.layer.mode))
            && objs.iter().any(|o| o.layer.mode == "line");

        if !has_mixed {
            return objs;
        }

        let fill_group: Vec<CutObject> = objs.iter().filter(|o| is_fill_ish(&o.layer.mode)).cloned().collect();
        let mut line_group: Vec<CutObject> = objs.iter().filter(|o| o.layer.mode == "line").cloned().collect();

        let mut result: Vec<CutObject> = Vec::new();
        let mut cur_x = start_x;
        let mut cur_y = start_y;

        let fill_order = optimizer::optimize_cut_order_from(&fill_group, cur_x, cur_y);
        for &idx in &fill_order {
            let obj = &fill_group[idx];
            cur_x = obj.x + obj.width;
            cur_y = obj.y + obj.height;
            result.push(obj.clone());
        }

        optimizer::sort_inner_first(&mut line_group);
        let line_order = optimizer::optimize_cut_order_from(&line_group, cur_x, cur_y);
        for &idx in &line_order {
            let obj = &line_group[idx];
            result.push(obj.clone());
        }
        result
    }

    fn make_cut_layer(mode: &str) -> CutLayer {
        CutLayer {
            mode: mode.to_string(),
            power: 100.0,
            power_min: 0.0,
            speed: 1200.0,
            passes: 1,
            power_mode: "constant".to_string(),
            interval: 0.1,
            air_assist: true,
            cut_inner_first: true,
            dither: "floydSteinberg".to_string(),
            scan_angle: 0.0,
            angle_increment: 0.0,
            overcut: 0.0,
            lead_in: 0.0,
            lead_out: 0.0,
            overscan: 0.0,
            bidirectional: true,
            cross_hatch: false,
            scanning_offset: 0.0,
            tab_spacing: 0.0,
            tab_width: 0.0,
            perforation_cut: 0.0,
            perforation_skip: 0.0,
            power_curve: None,
            fill_order: None,
            newsprint_cell_size: None,
            newsprint_angle: None,
        }
    }

    fn make_obj_with_mode(id: &str, mode: &str, layer_index: i32) -> CutObject {
        CutObject {
            id: id.to_string(),
            obj_type: "path".to_string(),
            x: 10.0,
            y: 10.0,
            width: 20.0,
            height: 20.0,
            paths: vec![],
            layer: make_cut_layer(mode),
            corner_radius: None,
            rotation: 0.0,
            priority: None,
            group_id: None,
            layer_index: Some(layer_index),
        }
    }

    /// A4b: a fillLine layer (mixed maskFill + line) emits ALL fill-ish objects
    /// before ANY line objects — no interleaving.
    #[test]
    fn fill_before_line_fillline_layer() {
        // Simulate: 3 maskFill objects + 1 line overlay (same layer_index)
        let objs = vec![
            make_obj_with_mode("fill_a", "maskFill", 0),
            make_obj_with_mode("line_overlay", "line", 0),
            make_obj_with_mode("fill_b", "maskFill", 0),
            make_obj_with_mode("fill_c", "fill", 0),
        ];
        let result = sort_fill_before_line(objs, 0.0, 0.0);
        // All fill-ish objects must precede the line object
        let line_pos = result.iter().position(|o| o.layer.mode == "line").unwrap();
        for (i, obj) in result.iter().enumerate() {
            if obj.layer.mode != "line" {
                assert!(i < line_pos,
                    "fill-ish object '{}' at pos {} must precede line at pos {}", obj.id, i, line_pos);
            }
        }
        // Total object count preserved
        assert_eq!(result.len(), 4);
    }

    /// A4b: a homogeneous line-only layer is unchanged by the partition (no-op).
    #[test]
    fn homogeneous_line_layer_unchanged() {
        let objs = vec![
            make_obj_with_mode("a", "line", 0),
            make_obj_with_mode("b", "line", 0),
        ];
        let result = sort_fill_before_line(objs, 0.0, 0.0);
        // 2 objects, both line — no change
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|o| o.layer.mode == "line"));
    }

    /// A4b: a homogeneous fill-only layer is unchanged by the partition (no-op).
    #[test]
    fn homogeneous_fill_layer_unchanged() {
        let objs = vec![
            make_obj_with_mode("a", "maskFill", 0),
            make_obj_with_mode("b", "maskFill", 0),
        ];
        let result = sort_fill_before_line(objs, 0.0, 0.0);
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|o| o.layer.mode == "maskFill"));
    }
}
