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

        // F7: Group by layer_index to preserve user-set layer order.
        // Within each layer group:
        //   - line mode: apply inner-first, then NN travel optimization
        //   - fill/offsetFill: NN travel optimization only (inner-first irrelevant for fills)
        // Emit groups in the order their layer_index values first appear.

        // Collect unique layer indices in arrival order
        let mut layer_order: Vec<i32> = Vec::new();
        for obj in &objects {
            let li = obj.layer_index.unwrap_or(0);
            if !layer_order.contains(&li) {
                layer_order.push(li);
            }
        }

        let mut final_objects: Vec<CutObject> = Vec::new();
        let mut cur_x = start_x;
        let mut cur_y = start_y;

        for &li in &layer_order {
            let layer_objs: Vec<CutObject> = objects.iter()
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
                    // P2-A Fix #9: use optimizer's object_end_point (last path point)
                    // instead of bbox corner, matching the optimizer's own tracking.
                    let (ex, ey) = optimizer::object_end_point(obj);
                    cur_x = ex;
                    cur_y = ey;
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
                    // P2-A Fix #9: use optimizer's object_end_point (last path point)
                    // instead of bbox corner, matching the optimizer's own tracking.
                    let (ex, ey) = optimizer::object_end_point(obj);
                    cur_x = ex;
                    cur_y = ey;
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
                    // P2-A Fix #9: use optimizer's object_end_point (last path point)
                    // instead of bbox corner, matching the optimizer's own tracking.
                    let (ex, ey) = optimizer::object_end_point(obj);
                    cur_x = ex;
                    cur_y = ey;
                    final_objects.push(obj.clone());
                }
            }
        }

        gcode_gen::generate_gcode(&final_objects, workspace_height, s_value_max, origin_top)
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
        let line_group: Vec<CutObject> = objs.iter().filter(|o| o.layer.mode == "line").cloned().collect();

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

        let line_order = optimizer::order_inner_first_nn(&line_group, cur_x, cur_y);
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

// ─────────────────────────────────────────────────────────────────────────
// Golden G-code snapshot corpus (kerf-hardening-program Phase 1, Relay 1C)
// ─────────────────────────────────────────────────────────────────────────
//
// These tests drive the REAL generation path -- the exact `generate_gcode` /
// `generate_image_gcode` command functions the frontend invokes over Tauri
// IPC -- and snapshot the emitted `gcode: String` against a committed fixture
// file under `tests/golden/`. See `tests/golden/README.md` for the full
// rationale and the KERF_UPDATE_GOLDEN regenerate workflow.
//
// The goldens capture CURRENT behavior, warts and all -- they are not a
// hand-verified "this is correct G-code" oracle. Phase 3 (IPC payload
// compaction) must keep every one of these byte-identical; Phase 4
// (geometry correctness work) is expected to change some of them
// deliberately, reviewed as a git diff.
#[cfg(test)]
mod golden_tests {
    use super::*;
    use crate::engine::gcode_gen::{CutLayer, PathSegment, Point};
    use std::path::PathBuf;

    // ── golden-file harness ────────────────────────────────────────────────

    fn golden_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden")
    }

    /// Compare `actual` (the generator's emitted `gcode` string) against the
    /// committed golden fixture `<name>.gcode`. Set `KERF_UPDATE_GOLDEN=1` to
    /// (re)write the fixture instead of asserting -- see
    /// `tests/golden/README.md`.
    fn assert_golden(name: &str, actual: &str) {
        let path = golden_dir().join(format!("{name}.gcode"));
        if std::env::var("KERF_UPDATE_GOLDEN").is_ok() {
            std::fs::create_dir_all(path.parent().expect("golden path has a parent dir"))
                .expect("failed to create tests/golden directory");
            std::fs::write(&path, format!("{actual}\n")).unwrap_or_else(|e| {
                panic!("failed to write golden file {}: {e}", path.display())
            });
        } else {
            let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
                panic!(
                    "failed to read golden file {}: {e}. Run `KERF_UPDATE_GOLDEN=1 cargo test` \
                     to create it (see tests/golden/README.md).",
                    path.display()
                )
            });
            let expected = raw.strip_suffix('\n').unwrap_or(&raw);
            assert_eq!(
                actual, expected,
                "\nGolden mismatch for '{name}'.\n\
                 If this is a deliberate generator change (e.g. Phase 4 geometry work), \
                 regenerate with `KERF_UPDATE_GOLDEN=1 cargo test` and review the diff at \
                 {}.\nOtherwise this is a regression in generator output.\n",
                path.display()
            );
        }
    }

    // ── shared fixture builders ────────────────────────────────────────────

    fn base_layer(mode: &str) -> CutLayer {
        CutLayer {
            mode: mode.to_string(),
            power: 100.0,
            power_min: 0.0,
            speed: 1200.0,
            passes: 1,
            power_mode: "constant".to_string(),
            interval: 1.0,
            air_assist: true,
            cut_inner_first: true,
            dither: "threshold".to_string(),
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

    fn rect_obj(id: &str, x: f64, y: f64, w: f64, h: f64, layer: CutLayer) -> CutObject {
        CutObject {
            id: id.to_string(),
            obj_type: "rectangle".to_string(),
            x,
            y,
            width: w,
            height: h,
            paths: vec![],
            layer,
            corner_radius: None,
            rotation: 0.0,
            priority: None,
            group_id: None,
            layer_index: None,
        }
    }

    fn rect_path(x: f64, y: f64, w: f64, h: f64) -> PathSegment {
        PathSegment {
            points: vec![
                Point { x, y },
                Point { x: x + w, y },
                Point { x: x + w, y: y + h },
                Point { x, y: y + h },
            ],
            closed: true,
        }
    }

    fn make_rgba_png_base64(width: u32, height: u32, pixels: &[(u8, u8, u8, u8)]) -> String {
        use image::{ImageBuffer, Rgba};
        let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(width, height);
        for (i, &(r, g, b, a)) in pixels.iter().enumerate() {
            let x = (i as u32) % width;
            let y = (i as u32) / width;
            img.put_pixel(x, y, Rgba([r, g, b, a]));
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        image::codecs::png::PngEncoder::new(&mut buf)
            .write_image(img.as_raw(), width, height, image::ExtendedColorType::Rgba8)
            .unwrap();
        let bytes = buf.into_inner();
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        )
    }

    // ── (1) simple rectangle cut ────────────────────────────────────────────

    #[tokio::test]
    async fn golden_01_simple_rect_cut() {
        let layer = CutLayer { power: 80.0, ..base_layer("line") };
        let obj = rect_obj("rect", 10.0, 10.0, 30.0, 20.0, layer);
        let result = generate_gcode(vec![obj], 300.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed");
        assert_golden("01_simple_rect_cut", &result.gcode);
    }

    // ── (2) compound path with holes, inner-first ordering ─────────────────

    #[tokio::test]
    async fn golden_02_compound_holes_inner_first() {
        let mut layer = base_layer("line");
        layer.cut_inner_first = true;
        let mut obj = rect_obj("compound", 0.0, 0.0, 100.0, 100.0, layer);
        obj.obj_type = "path".to_string();
        obj.paths = vec![
            rect_path(0.0, 0.0, 100.0, 100.0), // outer perimeter
            rect_path(30.0, 30.0, 20.0, 20.0), // hole
        ];
        let result = generate_gcode(vec![obj], 150.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed");
        assert_golden("02_compound_holes_inner_first", &result.gcode);
    }

    // ── (3) a fill layer ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn golden_03_fill_layer() {
        let mut layer = base_layer("fill");
        layer.power = 50.0;
        layer.speed = 3000.0;
        layer.interval = 5.0;
        let obj = rect_obj("fill_sq", 0.0, 0.0, 20.0, 20.0, layer);
        let result = generate_gcode(vec![obj], 50.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed");
        assert_golden("03_fill_layer", &result.gcode);
    }

    // ── (4) a fillLine mixed layer (maskFill + perimeter line overlay) ─────

    #[tokio::test]
    async fn golden_04_fillline_mixed_layer() {
        let outer = rect_path(0.0, 0.0, 40.0, 40.0);
        let hole = rect_path(15.0, 15.0, 10.0, 10.0);

        let mut mask_layer = base_layer("maskFill");
        mask_layer.interval = 5.0;
        let mut mask_obj = rect_obj("fillline_fill", 0.0, 0.0, 40.0, 40.0, mask_layer);
        mask_obj.obj_type = "path".to_string();
        mask_obj.paths = vec![outer.clone(), hole];
        mask_obj.layer_index = Some(0);

        let mut line_layer = base_layer("line");
        line_layer.cut_inner_first = false; // single path, N/A
        let mut line_obj = rect_obj("fillline_perimeter", 0.0, 0.0, 40.0, 40.0, line_layer);
        line_obj.obj_type = "path".to_string();
        line_obj.paths = vec![outer];
        line_obj.layer_index = Some(0);

        // Deliberately present the line object FIRST in input order -- the
        // A4b partition in commands::gcode::generate_gcode must still emit
        // ALL fill-ish objects before ANY line objects within the shared layer.
        let result = generate_gcode(vec![line_obj, mask_obj], 60.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed");

        // Explicit invariant check (belt-and-suspenders alongside the snapshot):
        // the fill marker comment must precede the line-cut marker comment.
        let fill_pos = result.gcode.find("; Mask Fill:").expect("mask fill marker present");
        let line_pos = result.gcode.find("; Cut:").expect("line cut marker present");
        assert!(fill_pos < line_pos, "fill-ish pass must be emitted before the line pass");

        assert_golden("04_fillline_mixed_layer", &result.gcode);
    }

    // ── (5) an image engrave ─────────────────────────────────────────────────

    #[tokio::test]
    async fn golden_05_image_engrave() {
        let image_data = make_rgba_png_base64(
            4,
            1,
            &[
                (0, 0, 0, 255),       // black
                (255, 255, 255, 255), // white
                (0, 0, 0, 255),       // black
                (255, 255, 255, 255), // white
            ],
        );
        let request = ImageEngraveRequest {
            image_data,
            x: 0.0,
            y: 0.0,
            width: 4.0,
            height: 1.0,
            rotation: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            power: 100.0,
            power_min: 0.0,
            speed: 3000.0,
            passes: 1,
            power_mode: "constant".to_string(),
            interval: 1.0,
            dither: "threshold".to_string(),
            overscan: 0.0,
            bidirectional: true,
            scanning_offset: 0.0,
            brightness: 0.0,
            contrast: 0.0,
            gamma: 1.0,
            invert: false,
            workspace_height: 50.0,
            origin_top: false,
            s_value_max: 1000.0,
            power_curve: None,
            newsprint_cell_size: None,
            newsprint_angle: None,
            remove_background: false,
            bg_tolerance: 20.0,
        };
        let result = generate_image_gcode(request)
            .await
            .expect("generate_image_gcode should succeed");
        assert_golden("05_image_engrave", &result.gcode);
    }

    // ── (6) a rotated object ─────────────────────────────────────────────────

    #[tokio::test]
    async fn golden_06_rotated_object() {
        let mut layer = base_layer("line");
        layer.power = 90.0;
        layer.speed = 1500.0;
        let mut obj = rect_obj("rotated", 0.0, 0.0, 20.0, 10.0, layer);
        obj.rotation = 30.0;
        let result = generate_gcode(vec![obj], 80.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed");
        assert_golden("06_rotated_object", &result.gcode);
    }

    // ── (7) multi-layer priority ordering ───────────────────────────────────

    #[tokio::test]
    async fn golden_07_multilayer_priority_order() {
        // layer_index arrival order (5, then 1) must dominate travel distance:
        // B sits at the start corner (nearest possible object) but its
        // layer_index (1) is seen SECOND in the input, so it must still be
        // emitted after both layer-5 objects.
        let mut obj_a = rect_obj("A_far", 200.0, 200.0, 10.0, 10.0, base_layer("line"));
        obj_a.layer_index = Some(5);
        let mut obj_b = rect_obj("B_near_origin", 0.0, 0.0, 10.0, 10.0, base_layer("line"));
        obj_b.layer_index = Some(1);
        let mut obj_c = rect_obj("C_far_sibling", 220.0, 200.0, 5.0, 5.0, base_layer("line"));
        obj_c.layer_index = Some(5);

        let result = generate_gcode(vec![obj_a, obj_b, obj_c], 250.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed");

        // Explicit invariant: both layer-5 objects precede the layer-1 object,
        // despite B being geometrically nearest the start corner.
        let pos_a = result.gcode.find("; Cut: A_far").expect("A_far present");
        let pos_b = result.gcode.find("; Cut: B_near_origin").expect("B_near_origin present");
        let pos_c = result.gcode.find("; Cut: C_far_sibling").expect("C_far_sibling present");
        assert!(pos_a < pos_b, "layer_index 5 (arrival order first) must precede layer_index 1");
        assert!(pos_c < pos_b, "layer_index 5 (arrival order first) must precede layer_index 1");

        assert_golden("07_multilayer_priority_order", &result.gcode);
    }

    // ── (8) origin-top vs origin-bottom for the same design ─────────────────

    fn origin_test_object() -> CutObject {
        rect_obj("origin_test", 20.0, 20.0, 15.0, 25.0, base_layer("line"))
    }

    #[tokio::test]
    async fn golden_08a_origin_bottom() {
        let result = generate_gcode(vec![origin_test_object()], 100.0, Some(1000.0), None, None, Some(false))
            .await
            .expect("generate_gcode should succeed");
        assert_golden("08a_origin_bottom", &result.gcode);
    }

    #[tokio::test]
    async fn golden_08b_origin_top() {
        let result = generate_gcode(vec![origin_test_object()], 100.0, Some(1000.0), None, None, Some(true))
            .await
            .expect("generate_gcode should succeed");
        assert_golden("08b_origin_top", &result.gcode);
    }

    // ── (9) offsetFill: concentric inward rings ─────────────────────────────

    #[tokio::test]
    async fn golden_09_offsetfill() {
        let mut layer = base_layer("offsetFill");
        layer.power = 60.0;
        layer.interval = 4.0;
        let mut obj = rect_obj("offset_sq", 0.0, 0.0, 40.0, 40.0, layer);
        obj.obj_type = "path".to_string();
        obj.paths = vec![rect_path(0.0, 0.0, 40.0, 40.0)];
        let result = generate_gcode(vec![obj], 100.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed");
        assert_golden("09_offsetfill", &result.gcode);
    }

    // ── (10) perforation: alternating cut / skip along the path ─────────────

    #[tokio::test]
    async fn golden_10_perforation() {
        let mut layer = base_layer("line");
        layer.perforation_cut = 3.0;
        layer.perforation_skip = 2.0;
        let mut obj = rect_obj("perf_sq", 0.0, 0.0, 30.0, 20.0, layer);
        obj.obj_type = "path".to_string();
        obj.paths = vec![rect_path(0.0, 0.0, 30.0, 20.0)];
        let result = generate_gcode(vec![obj], 100.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed");
        assert_golden("10_perforation", &result.gcode);
    }

    // ── (11) tabs: uncut bridges holding the part in the sheet ──────────────

    #[tokio::test]
    async fn golden_11_tabs() {
        let mut layer = base_layer("line");
        layer.tab_spacing = 8.0;
        layer.tab_width = 2.0;
        let mut obj = rect_obj("tab_sq", 0.0, 0.0, 30.0, 20.0, layer);
        obj.obj_type = "path".to_string();
        obj.paths = vec![rect_path(0.0, 0.0, 30.0, 20.0)];
        let result = generate_gcode(vec![obj], 100.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed");
        assert_golden("11_tabs", &result.gcode);
    }

    // ── (12) lead-in / lead-out approach and exit moves ─────────────────────

    #[tokio::test]
    async fn golden_12_lead_in_out() {
        let mut layer = base_layer("line");
        layer.lead_in = 3.0;
        layer.lead_out = 2.0;
        let mut obj = rect_obj("lead_sq", 20.0, 20.0, 30.0, 20.0, layer);
        obj.obj_type = "path".to_string();
        obj.paths = vec![rect_path(20.0, 20.0, 30.0, 20.0)];
        let result = generate_gcode(vec![obj], 100.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed");
        assert_golden("12_lead_in_out", &result.gcode);
    }

    // ── (13) overcut: closed contour overshoots its own start ───────────────

    #[tokio::test]
    async fn golden_13_overcut() {
        let mut layer = base_layer("line");
        layer.overcut = 2.5;
        let mut obj = rect_obj("overcut_sq", 0.0, 0.0, 30.0, 20.0, layer);
        obj.obj_type = "path".to_string();
        obj.paths = vec![rect_path(0.0, 0.0, 30.0, 20.0)];
        let result = generate_gcode(vec![obj], 100.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed");
        assert_golden("13_overcut", &result.gcode);
    }

    // ── (14) cross-hatch: horizontal fill plus a vertical second pass ───────

    #[tokio::test]
    async fn golden_14_cross_hatch() {
        let mut layer = base_layer("fill");
        layer.power = 50.0;
        layer.interval = 5.0;
        layer.cross_hatch = true;
        let obj = rect_obj("hatch_sq", 0.0, 0.0, 20.0, 20.0, layer);
        let result = generate_gcode(vec![obj], 50.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed");
        assert_golden("14_cross_hatch", &result.gcode);
    }

    // ── determinism guard ────────────────────────────────────────────────────

    /// The generator must be a pure function of its inputs: no HashMap iteration
    /// order, no time/random seeding. Running the same compound-path fixture
    /// twice in-process must produce byte-identical output. This is the
    /// in-CI complement to the manual "regenerate twice, diff" check performed
    /// when these goldens were authored (kerf-hardening-program Relay 1C).
    #[tokio::test]
    async fn golden_determinism_two_runs_identical() {
        let mut layer = base_layer("line");
        layer.cut_inner_first = true;
        let make_obj = || {
            let mut obj = rect_obj("compound", 0.0, 0.0, 100.0, 100.0, layer.clone());
            obj.obj_type = "path".to_string();
            obj.paths = vec![
                rect_path(0.0, 0.0, 100.0, 100.0),
                rect_path(30.0, 30.0, 20.0, 20.0),
            ];
            obj
        };

        let run1 = generate_gcode(vec![make_obj()], 150.0, Some(1000.0), None, None, None)
            .await
            .expect("run 1 should succeed");
        let run2 = generate_gcode(vec![make_obj()], 150.0, Some(1000.0), None, None, None)
            .await
            .expect("run 2 should succeed");

        assert_eq!(run1.gcode, run2.gcode, "generator output must be deterministic across runs");
    }
}
