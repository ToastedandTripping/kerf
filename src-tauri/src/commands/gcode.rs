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
        let (start_x, start_y) =
            start_point_from_corner(corner, ws_width, workspace_height, origin_top);

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
            let layer_objs: Vec<CutObject> = objects
                .iter()
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
            let is_fill_ish = |mode: &str| matches!(mode, "fill" | "maskFill" | "offsetFill");

            let has_mixed = layer_objs.iter().any(|o| is_fill_ish(&o.layer.mode))
                && layer_objs.iter().any(|o| o.layer.mode == "line");

            if has_mixed {
                // Partition into fill-ish and line groups
                let fill_group: Vec<CutObject> = layer_objs
                    .iter()
                    .filter(|o| is_fill_ish(&o.layer.mode))
                    .cloned()
                    .collect();
                let line_group: Vec<CutObject> = layer_objs
                    .iter()
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
                let inner_first = line_group
                    .first()
                    .map(|o| o.layer.cut_inner_first)
                    .unwrap_or(true);
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
                let is_line_mode = layer_objs
                    .first()
                    .map(|o| o.layer.mode.as_str() == "line")
                    .unwrap_or(false);

                // Pure-fill layers stay pure NN even with the toggle on (is_line_mode guard).
                let order = if is_line_mode {
                    // All objects in this layer group share one layer definition; reading the
                    // first object's flag is correct. (If per-object overrides are ever added,
                    // this becomes a per-object branch rather than a group-level read.)
                    let inner_first = layer_objs
                        .first()
                        .map(|o| o.layer.cut_inner_first)
                        .unwrap_or(true);
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
    tokio::task::spawn_blocking(move || image_gcode_gen::generate(&request))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// Preview dithered image: returns base64 PNG of the processed/dithered result
/// along with dimensions and the dither method used.
#[tauri::command]
pub async fn preview_image_dither(
    request: ImageEngraveRequest,
) -> Result<PreviewDitherResult, String> {
    tokio::task::spawn_blocking(move || {
        let dither_method = request.dither.clone();
        let (pixels, width, height) = image_gcode_gen::preview_dither(&request)?;

        // Encode as PNG
        let mut png_buf = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut png_buf);
        encoder
            .write_image(&pixels, width, height, image::ExtendedColorType::L8)
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

        let fill_group: Vec<CutObject> = objs
            .iter()
            .filter(|o| is_fill_ish(&o.layer.mode))
            .cloned()
            .collect();
        let line_group: Vec<CutObject> = objs
            .iter()
            .filter(|o| o.layer.mode == "line")
            .cloned()
            .collect();

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
            scan_motion: None,
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
                assert!(
                    i < line_pos,
                    "fill-ish object '{}' at pos {} must precede line at pos {}",
                    obj.id,
                    i,
                    line_pos
                );
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

    // ── P6-A: start_point_from_corner table test ──────────────────────────
    //
    // 4 named corners x 2 origin modes = 8 cases. Pins the coordinate
    // mapping that feeds the nearest-neighbor optimizer's start position.

    use super::start_point_from_corner;

    #[test]
    fn start_point_from_corner_origin_bottom() {
        let (w, h) = (500.0, 300.0);
        // origin_top = false: Y=0 at bottom, Y=height at top
        assert_eq!(
            start_point_from_corner("bottomLeft", w, h, false),
            (0.0, 0.0)
        );
        assert_eq!(
            start_point_from_corner("bottomRight", w, h, false),
            (500.0, 0.0)
        );
        assert_eq!(
            start_point_from_corner("topLeft", w, h, false),
            (0.0, 300.0)
        );
        assert_eq!(
            start_point_from_corner("topRight", w, h, false),
            (500.0, 300.0)
        );
    }

    #[test]
    fn start_point_from_corner_origin_top() {
        let (w, h) = (500.0, 300.0);
        // origin_top = true: Y=0 at top, Y=-height at bottom
        assert_eq!(
            start_point_from_corner("bottomLeft", w, h, true),
            (0.0, -300.0)
        );
        assert_eq!(
            start_point_from_corner("bottomRight", w, h, true),
            (500.0, -300.0)
        );
        assert_eq!(start_point_from_corner("topLeft", w, h, true), (0.0, 0.0));
        assert_eq!(
            start_point_from_corner("topRight", w, h, true),
            (500.0, 0.0)
        );
    }

    #[test]
    fn start_point_from_corner_unknown_defaults_to_bottom_left() {
        // Unknown corner names fall through to the default arm (bottomLeft behavior)
        assert_eq!(
            start_point_from_corner("nonsense", 400.0, 200.0, false),
            (0.0, 0.0)
        );
        assert_eq!(
            start_point_from_corner("nonsense", 400.0, 200.0, true),
            (0.0, -200.0)
        );
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
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("golden")
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
            std::fs::write(&path, format!("{actual}\n"))
                .unwrap_or_else(|e| panic!("failed to write golden file {}: {e}", path.display()));
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
                actual,
                expected,
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
            scan_motion: None,
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
        let layer = CutLayer {
            power: 80.0,
            ..base_layer("line")
        };
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
        let result = generate_gcode(
            vec![line_obj, mask_obj],
            60.0,
            Some(1000.0),
            None,
            None,
            None,
        )
        .await
        .expect("generate_gcode should succeed");

        // Explicit invariant check (belt-and-suspenders alongside the snapshot):
        // the fill marker comment must precede the line-cut marker comment.
        let fill_pos = result
            .gcode
            .find("; Mask Fill:")
            .expect("mask fill marker present");
        let line_pos = result
            .gcode
            .find("; Cut:")
            .expect("line cut marker present");
        assert!(
            fill_pos < line_pos,
            "fill-ish pass must be emitted before the line pass"
        );

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
            scan_motion: None,
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

        let result = generate_gcode(
            vec![obj_a, obj_b, obj_c],
            250.0,
            Some(1000.0),
            None,
            None,
            None,
        )
        .await
        .expect("generate_gcode should succeed");

        // Explicit invariant: both layer-5 objects precede the layer-1 object,
        // despite B being geometrically nearest the start corner.
        let pos_a = result.gcode.find("; Cut: A_far").expect("A_far present");
        let pos_b = result
            .gcode
            .find("; Cut: B_near_origin")
            .expect("B_near_origin present");
        let pos_c = result
            .gcode
            .find("; Cut: C_far_sibling")
            .expect("C_far_sibling present");
        assert!(
            pos_a < pos_b,
            "layer_index 5 (arrival order first) must precede layer_index 1"
        );
        assert!(
            pos_c < pos_b,
            "layer_index 5 (arrival order first) must precede layer_index 1"
        );

        assert_golden("07_multilayer_priority_order", &result.gcode);
    }

    // ── (8) origin-top vs origin-bottom for the same design ─────────────────

    fn origin_test_object() -> CutObject {
        rect_obj("origin_test", 20.0, 20.0, 15.0, 25.0, base_layer("line"))
    }

    #[tokio::test]
    async fn golden_08a_origin_bottom() {
        let result = generate_gcode(
            vec![origin_test_object()],
            100.0,
            Some(1000.0),
            None,
            None,
            Some(false),
        )
        .await
        .expect("generate_gcode should succeed");
        assert_golden("08a_origin_bottom", &result.gcode);
    }

    #[tokio::test]
    async fn golden_08b_origin_top() {
        let result = generate_gcode(
            vec![origin_test_object()],
            100.0,
            Some(1000.0),
            None,
            None,
            Some(true),
        )
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

    // ── (15) line layer, VARIABLE power, non-zero power_min ────────────────

    /// The path that the M4 default just made the common case, and which had
    /// ZERO golden coverage: every other fixture in this corpus hardcodes
    /// `power_mode: "constant"`, so the M4 count across the whole committed
    /// corpus was zero, and the `line` arm had no variable-power test anywhere.
    ///
    /// It also pins W4's arithmetic in the same fixture. `power: 40` with
    /// `s_value_max: 1000` gives s_max = 400. `power_min: 60` would give an
    /// unclamped s_min of 600, and the M4 branch's `s_max.max(s_min)` would
    /// then command S600 — 50% more power than the operator's Power box.
    /// Clamped, power_min becomes 40, s_min becomes 400, and the commanded
    /// value stays S400.
    ///
    /// So the expected S value is **S400** on every `G1`, with the **M4** mode
    /// line at `S0`. If a `G1` reads S600, W4 has regressed; if the mode line
    /// reads M3, the variable default has regressed.
    #[tokio::test]
    async fn golden_15_line_variable_power_min() {
        let mut layer = base_layer("line");
        layer.power = 40.0; // s_max = 400
        layer.power_min = 60.0; // clamped to 40 => s_min = 400
        layer.power_mode = "variable".to_string(); // M4
        let mut obj = rect_obj("var_sq", 0.0, 0.0, 30.0, 20.0, layer);
        obj.obj_type = "path".to_string();
        obj.paths = vec![rect_path(0.0, 0.0, 30.0, 20.0)];
        let result = generate_gcode(vec![obj], 100.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed");

        // Asserted inline as well as against the fixture: a golden proves the
        // bytes did not move, but only a named assertion says WHY these bytes.
        assert!(
            result.gcode.contains("M4 S0"),
            "expected the M4 mode line at S0 (W4's evidence now lives on the G1 words); \
             gcode:\n{}",
            result.gcode
        );
        let g1: Vec<&str> = result
            .gcode
            .lines()
            .filter(|l| l.starts_with("G1 "))
            .collect();
        assert!(
            !g1.is_empty() && g1.iter().all(|l| l.ends_with(" S400")),
            "expected every G1 at S400 (power=40% of s_value_max=1000); W4's evidence lives \
             on the G1 words. gcode:\n{}",
            result.gcode
        );
        assert!(
            !result.gcode.contains("S600"),
            "power_min=60 must not raise commanded power above power=40; gcode:\n{}",
            result.gcode
        );

        assert_golden("15_line_variable_power_min", &result.gcode);
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

        assert_eq!(
            run1.gcode, run2.gcode,
            "generator output must be deterministic across runs"
        );
    }

    // ── safety engine-arm: G-code word parser and arm-diff classifier ──────
    //
    // "Mode line" means a line carrying an M3 or M4 word. The engine-arm rule
    // is that every mode line carries S0 and positive S rides only on G1 words
    // with motion. These helpers read that from emitted text, with no regex
    // crate: a hand-written scanner over `([A-Z])\s*(-?\d*\.?\d+)`.

    /// Every `(letter, number)` word on the code part of `line` (everything
    /// from the first `;` is a comment and is ignored).
    fn words(line: &str) -> Vec<(char, f64)> {
        let code = line.split(';').next().unwrap_or("");
        let bytes = code.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            let c = bytes[i] as char;
            if c.is_ascii_uppercase() {
                let mut j = i + 1;
                while j < bytes.len() && (bytes[j] as char).is_ascii_whitespace() {
                    j += 1;
                }
                let start = j;
                if j < bytes.len() && bytes[j] == b'-' {
                    j += 1;
                }
                let digits_start = j;
                let mut seen_dot = false;
                while j < bytes.len() {
                    let d = bytes[j] as char;
                    if d.is_ascii_digit() {
                        j += 1;
                    } else if d == '.' && !seen_dot {
                        seen_dot = true;
                        j += 1;
                    } else {
                        break;
                    }
                }
                let num = &code[start..j];
                let has_digit = code[digits_start..j].bytes().any(|b| b.is_ascii_digit());
                if has_digit && !num.ends_with('.') {
                    if let Ok(v) = num.parse::<f64>() {
                        out.push((c, v));
                        i = j;
                        continue;
                    }
                }
            }
            i += 1;
        }
        out
    }

    fn s_word(line: &str) -> Option<f64> {
        words(line)
            .into_iter()
            .find(|&(c, _)| c == 'S')
            .map(|(_, v)| v)
    }

    fn is_mode_line(line: &str) -> bool {
        words(line)
            .iter()
            .any(|&(c, v)| c == 'M' && (v == 3.0 || v == 4.0))
    }

    fn has_word(line: &str, letter: char, value: f64) -> bool {
        words(line).iter().any(|&(c, v)| c == letter && v == value)
    }

    fn has_xy(line: &str) -> bool {
        words(line).iter().any(|&(c, _)| c == 'X' || c == 'Y')
    }

    /// `line` with its ` S<number>` token removed from the code part. Any `;`
    /// comment is kept byte-for-byte.
    fn strip_s_word(line: &str) -> String {
        let (code, comment) = match line.find(';') {
            Some(k) => (&line[..k], &line[k..]),
            None => (line, ""),
        };
        let bytes = code.as_bytes();
        let mut k = 0;
        while k < bytes.len() {
            let at_token_start = bytes[k] == b'S' && (k == 0 || bytes[k - 1] == b' ');
            if at_token_start {
                let mut j = k + 1;
                if j < bytes.len() && bytes[j] == b'-' {
                    j += 1;
                }
                let num_start = j;
                while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b'.') {
                    j += 1;
                }
                if j > num_start {
                    let from = if k > 0 { k - 1 } else { k };
                    return format!("{}{}{}", &code[..from], &code[j..], comment);
                }
            }
            k += 1;
        }
        line.to_string()
    }

    #[derive(Debug, Default, PartialEq)]
    struct ArmDiff {
        mode_s0: usize,
        g1_gained_s: usize,
    }

    /// Classify every changed line between two programs. The only accepted
    /// changes are class A (a positive mode line goes to S0, nothing else on
    /// the line moves) and class B (a G1 with X/Y and no S gains a positive S).
    fn classify_arm_diff(before: &str, after: &str) -> Result<ArmDiff, String> {
        let bl: Vec<&str> = before.lines().collect();
        let al: Vec<&str> = after.lines().collect();
        if bl.len() != al.len() {
            return Err(format!(
                "line count changed: {} before, {} after",
                bl.len(),
                al.len()
            ));
        }
        let mut diff = ArmDiff::default();
        for (i, (b, a)) in bl.iter().zip(al.iter()).enumerate() {
            let (b, a) = (*b, *a);
            if b == a {
                continue;
            }
            let same_apart_from_s = strip_s_word(b) == strip_s_word(a);
            let after_is_s0 = s_word(a) == Some(0.0);
            let before_s = s_word(b);
            if is_mode_line(b)
                && before_s.is_some_and(|s| s > 0.0)
                && after_is_s0
                && same_apart_from_s
            {
                diff.mode_s0 += 1;
                continue;
            }
            if has_word(b, 'G', 1.0)
                && has_xy(b)
                && before_s.is_none()
                && s_word(a).is_some_and(|s| s > 0.0)
                && same_apart_from_s
            {
                diff.g1_gained_s += 1;
                continue;
            }
            return Err(format!(
                "line {}: {:?} -> {:?} is neither a mode-line S0 nor a G1 gaining S",
                i + 1,
                b,
                a
            ));
        }
        Ok(diff)
    }

    /// Number of mode lines carrying a positive S in `program`.
    fn positive_mode_lines(program: &str) -> usize {
        program
            .lines()
            .filter(|l| is_mode_line(l) && s_word(l).is_some_and(|s| s > 0.0))
            .count()
    }

    #[test]
    fn arm_diff_accepts_only_mode_s0_and_g1_gaining_s() {
        assert_eq!(
            classify_arm_diff("M3 S1000", "M3 S0"),
            Ok(ArmDiff {
                mode_s0: 1,
                g1_gained_s: 0
            })
        );
        assert_eq!(
            classify_arm_diff("M4 S400", "M4 S0"),
            Ok(ArmDiff {
                mode_s0: 1,
                g1_gained_s: 0
            })
        );
        assert_eq!(
            classify_arm_diff("G1 X1.000 Y2.000 F1200", "G1 X1.000 Y2.000 F1200 S600"),
            Ok(ArmDiff {
                mode_s0: 0,
                g1_gained_s: 1
            })
        );
        let before = "G21\nM3 S600\nG1 X1.000 Y2.000 F1200\nG0 X0 Y0\nM4 S250 ; ring\nM5";
        let after = "G21\nM3 S0\nG1 X1.000 Y2.000 F1200 S600\nG0 X0 Y0\nM4 S0 ; ring\nM5";
        assert_eq!(
            classify_arm_diff(before, after),
            Ok(ArmDiff {
                mode_s0: 2,
                g1_gained_s: 1
            })
        );
    }

    #[test]
    fn arm_diff_rejects_everything_else() {
        let cases: [(&str, &str, &str, &str); 8] = [
            ("R1", "G21\nM3 S500", "G21\nM4 S0", "line 2:"),
            ("R2", "G21\nM3 S500", "G21\nM3 S700", "line 2:"),
            (
                "R3",
                "G1 X1.000 Y2.000 F1200 S600",
                "G1 X1.000 Y2.500 F1200 S600",
                "line 1:",
            ),
            (
                "R4",
                "G1 X1.000 Y2.000 F1200 S600",
                "G1 X1.000 Y2.000 F1200 S0",
                "line 1:",
            ),
            ("R5", "G21\nM3 S500", "G21\nM3 S0\nM5", "line count changed"),
            ("R6", "G0 X1.000 Y2.000", "G0 X1.000 Y2.000 S600", "line 1:"),
            ("R7", "G21\nG90\nM3 S500", "G21\nG90\nM3", "line 3:"),
            ("R8", "M3 S500 ; a", "M3 S0 ; b", "line 1:"),
        ];
        for (id, before, after, needle) in cases {
            match classify_arm_diff(before, after) {
                Ok(d) => panic!("{id}: {before:?} -> {after:?} must be rejected, got {d:?}"),
                Err(e) => assert!(
                    e.contains(needle),
                    "{id}: error must name {needle:?}, got {e:?}"
                ),
            }
        }
    }

    // ── safety engine-arm: the fixture matrix (every layer type, M3 and M4) ─

    /// One generated program from the matrix, with what it is expected to say.
    struct Program {
        gcode: String,
        /// `3.0` or `4.0`: the only M3/M4 number the program may carry.
        expected_mode: f64,
        /// The positive S every burning vector G1 must carry; `None` for raster.
        expected_s: Option<f64>,
    }

    fn arm_line_obj(id: &str, layer: CutLayer) -> CutObject {
        let mut obj = rect_obj(id, 0.0, 0.0, 30.0, 20.0, layer);
        obj.obj_type = "path".to_string();
        obj.paths = vec![rect_path(0.0, 0.0, 30.0, 20.0)];
        obj
    }

    fn arm_layer(mode: &str, power_mode: &str) -> CutLayer {
        CutLayer {
            power: 60.0,
            power_min: 0.0,
            power_mode: power_mode.to_string(),
            ..base_layer(mode)
        }
    }

    fn arm_image_request(
        power_mode: &str,
        pixels: &[(u8, u8, u8, u8)],
        dither: &str,
    ) -> ImageEngraveRequest {
        ImageEngraveRequest {
            image_data: make_rgba_png_base64(4, 1, pixels),
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
            power_mode: power_mode.to_string(),
            interval: 1.0,
            dither: dither.to_string(),
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
            scan_motion: None,
        }
    }

    async fn arm_vector(objs: Vec<CutObject>) -> String {
        generate_gcode(objs, 100.0, Some(1000.0), None, None, None)
            .await
            .expect("generate_gcode should succeed")
            .gcode
    }

    /// 12 fixtures x {constant, variable} = 24 programs, labelled
    /// `<label>_<power_mode>`. Shared by T1 and T5; labels and parameters must
    /// not change between a before-snapshot and its after-snapshot.
    async fn arm_matrix() -> Vec<(String, Program)> {
        let mut out = Vec::new();
        for pm in ["constant", "variable"] {
            let mode_letter = if pm == "variable" { 4.0 } else { 3.0 };
            let vector = |gcode: String| Program {
                gcode,
                expected_mode: mode_letter,
                expected_s: Some(600.0),
            };
            let name = |label: &str| format!("{label}_{pm}");

            let mut l = arm_layer("line", pm);
            l.passes = 2;
            out.push((
                name("line_plain_2pass"),
                vector(arm_vector(vec![arm_line_obj("plain", l)]).await),
            ));

            let mut l = arm_layer("line", pm);
            l.lead_in = 3.0;
            l.lead_out = 2.0;
            out.push((
                name("line_lead_in_out"),
                vector(arm_vector(vec![arm_line_obj("lead", l)]).await),
            ));

            let mut l = arm_layer("line", pm);
            l.perforation_cut = 3.0;
            l.perforation_skip = 2.0;
            out.push((
                name("line_perforation"),
                vector(arm_vector(vec![arm_line_obj("perf", l)]).await),
            ));

            let mut l = arm_layer("line", pm);
            l.tab_spacing = 8.0;
            l.tab_width = 2.0;
            out.push((
                name("line_tabs"),
                vector(arm_vector(vec![arm_line_obj("tabs", l)]).await),
            ));

            let mut l = arm_layer("line", pm);
            l.perforation_cut = 3.0;
            l.perforation_skip = 2.0;
            l.overcut = 2.5;
            l.lead_out = 2.0;
            out.push((
                name("line_perf_overcut_leadout"),
                vector(arm_vector(vec![arm_line_obj("perf_oc_lo", l)]).await),
            ));

            let mut l = arm_layer("fill", pm);
            l.interval = 5.0;
            l.overscan = 0.0;
            let obj = rect_obj("fill0", 0.0, 0.0, 20.0, 20.0, l);
            out.push((name("fill_overscan0"), vector(arm_vector(vec![obj]).await)));

            let mut l = arm_layer("fill", pm);
            l.interval = 5.0;
            l.overscan = 2.0;
            l.bidirectional = true;
            let obj = rect_obj("fill2", 0.0, 0.0, 20.0, 20.0, l);
            out.push((name("fill_overscan2"), vector(arm_vector(vec![obj]).await)));

            let mut l = arm_layer("fill", pm);
            l.interval = 5.0;
            l.overscan = 1.0;
            l.cross_hatch = true;
            l.fill_order = Some("flood".to_string());
            l.scan_angle = 30.0;
            let obj = rect_obj("hatch", 0.0, 0.0, 20.0, 20.0, l);
            out.push((
                name("fill_hatch_flood_30"),
                vector(arm_vector(vec![obj]).await),
            ));

            let mut l = arm_layer("offsetFill", pm);
            l.interval = 2.0;
            let mut obj = rect_obj("offset", 0.0, 0.0, 20.0, 20.0, l);
            obj.obj_type = "path".to_string();
            obj.paths = vec![rect_path(0.0, 0.0, 20.0, 20.0)];
            out.push((name("offset_fill"), vector(arm_vector(vec![obj]).await)));

            let outer = rect_path(0.0, 0.0, 40.0, 40.0);
            let hole = rect_path(15.0, 15.0, 10.0, 10.0);
            let mut ml = arm_layer("maskFill", pm);
            ml.interval = 5.0;
            let mut mask_obj = rect_obj("mf_fill", 0.0, 0.0, 40.0, 40.0, ml);
            mask_obj.obj_type = "path".to_string();
            mask_obj.paths = vec![outer.clone(), hole];
            mask_obj.layer_index = Some(0);
            let mut ll = arm_layer("line", pm);
            ll.cut_inner_first = false;
            let mut line_obj = rect_obj("mf_perimeter", 0.0, 0.0, 40.0, 40.0, ll);
            line_obj.obj_type = "path".to_string();
            line_obj.paths = vec![outer];
            line_obj.layer_index = Some(0);
            out.push((
                name("maskfill_then_line"),
                vector(arm_vector(vec![line_obj, mask_obj]).await),
            ));

            let bw = [
                (0, 0, 0, 255),
                (255, 255, 255, 255),
                (0, 0, 0, 255),
                (255, 255, 255, 255),
            ];
            let img = generate_image_gcode(arm_image_request(pm, &bw, "threshold"))
                .await
                .expect("generate_image_gcode should succeed");
            out.push((
                name("image_threshold"),
                Program {
                    gcode: img.gcode,
                    expected_mode: mode_letter,
                    expected_s: None,
                },
            ));

            let grey = [
                (0, 0, 0, 255),
                (128, 128, 128, 255),
                (200, 200, 200, 255),
                (255, 255, 255, 255),
            ];
            let img = generate_image_gcode(arm_image_request(pm, &grey, "grayscale"))
                .await
                .expect("generate_image_gcode should succeed");
            out.push((
                name("image_grayscale"),
                Program {
                    gcode: img.gcode,
                    // Grayscale forces M4 whatever the layer says.
                    expected_mode: 4.0,
                    expected_s: None,
                },
            ));
        }
        out
    }

    const ARM_MATRIX_OUT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/arm-matrix-out");
    const GOLDEN_BEFORE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/golden-before");

    fn gcode_files(dir: &std::path::Path) -> std::collections::BTreeMap<String, String> {
        let mut out = std::collections::BTreeMap::new();
        let entries =
            std::fs::read_dir(dir).unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("dir entry").path();
            if path.extension().and_then(|x| x.to_str()) == Some("gcode") {
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                let text = std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
                out.insert(name, text);
            }
        }
        out
    }

    /// T5: write every matrix program to `target/arm-matrix-out/<label>_<mode>.gcode`.
    /// Run explicitly (`-- --ignored`) to snapshot before/after an engine change.
    #[tokio::test]
    #[ignore]
    async fn arm_matrix_snapshot() {
        let dir = std::path::Path::new(ARM_MATRIX_OUT);
        if dir.exists() {
            std::fs::remove_dir_all(dir).expect("clear arm-matrix-out");
        }
        std::fs::create_dir_all(dir).expect("create arm-matrix-out");
        let matrix = arm_matrix().await;
        for (label, prog) in &matrix {
            std::fs::write(dir.join(format!("{label}.gcode")), &prog.gcode)
                .unwrap_or_else(|e| panic!("write {label}: {e}"));
        }
        let written = gcode_files(dir);
        assert_eq!(matrix.len(), 24, "matrix must hold 24 programs");
        assert_eq!(written.len(), 24, "must write exactly 24 distinct files");
    }

    /// T4: one-shot proof that a regeneration changed nothing but mode lines
    /// going to S0. Needs `target/golden-before` (the committed goldens plus
    /// `matrix/`, the T5 snapshot taken before the engine edit).
    #[test]
    #[ignore]
    fn golden_corpus_regeneration_is_arm_only() {
        let before_dir = std::path::Path::new(GOLDEN_BEFORE);
        assert!(
            before_dir.is_dir(),
            "{} is missing: snapshot the before state first",
            before_dir.display()
        );
        let before = gcode_files(before_dir);
        let after = gcode_files(&golden_dir());
        assert!(
            !after.is_empty() && before.len() >= after.len(),
            "before dir holds {} .gcode files, tests/golden holds {}",
            before.len(),
            after.len()
        );
        let before_m = gcode_files(&before_dir.join("matrix"));
        let after_m = gcode_files(std::path::Path::new(ARM_MATRIX_OUT));

        let check = |corpus: &str,
                     before: &std::collections::BTreeMap<String, String>,
                     after: &std::collections::BTreeMap<String, String>|
         -> (usize, usize) {
            assert_eq!(
                before.keys().collect::<Vec<_>>(),
                after.keys().collect::<Vec<_>>(),
                "{corpus}: before and after file sets differ"
            );
            let mut total = ArmDiff::default();
            let mut positive_before = 0;
            let mut errors = Vec::new();
            for (name, b) in before {
                let a = &after[name];
                let pos = positive_mode_lines(b);
                positive_before += pos;
                match classify_arm_diff(b, a) {
                    Ok(d) => {
                        println!(
                            "{corpus} {name}: mode_s0={} g1_gained_s={} (positive mode lines before: {pos})",
                            d.mode_s0, d.g1_gained_s
                        );
                        total.mode_s0 += d.mode_s0;
                        total.g1_gained_s += d.g1_gained_s;
                    }
                    Err(e) => errors.push(format!("{corpus} {name}: {e}")),
                }
                assert_eq!(
                    positive_mode_lines(a),
                    0,
                    "{corpus} {name}: positive mode line left after regeneration"
                );
            }
            let changed = before.iter().filter(|(n, b)| after[*n] != **b).count();
            println!(
                "{corpus} TOTAL: files={} changed={changed} mode_s0={} g1_gained_s={} rejects={} positive_before={positive_before}",
                before.len(),
                total.mode_s0,
                total.g1_gained_s,
                errors.len()
            );
            assert!(
                errors.is_empty(),
                "{corpus}: rejects:\n{}",
                errors.join("\n")
            );
            assert_eq!(
                total.g1_gained_s, 0,
                "{corpus}: no G1 may gain S in this batch"
            );
            assert_eq!(
                total.mode_s0, positive_before,
                "{corpus}: mode_s0 must equal the positive mode lines before"
            );
            (total.mode_s0, positive_before)
        };

        let (g, _) = check("golden", &before, &after);
        assert_eq!(before_m.len(), 24, "before matrix must hold 24 files");
        assert_eq!(after_m.len(), 24, "after matrix must hold 24 files");
        let (m, _) = check("matrix", &before_m, &after_m);
        assert!(
            g + m >= 1,
            "vacuous: no positive mode line in the before set"
        );
    }

    /// I1 and I2 over one program. Returns the number of mode lines seen.
    fn assert_never_arms(ctx: &str, gcode: &str) -> usize {
        let mut mode_lines = 0;
        for (i, line) in gcode.lines().enumerate() {
            let s = s_word(line);
            if is_mode_line(line) {
                mode_lines += 1;
                assert_eq!(
                    s,
                    Some(0.0),
                    "I1 ({ctx}) line {}: every M3/M4 line must carry S0: {line:?}",
                    i + 1
                );
            }
            if s.is_some_and(|v| v > 0.0) {
                assert!(
                    has_word(line, 'G', 1.0) && has_xy(line),
                    "I2 ({ctx}) line {}: positive S only on a G1 with X or Y: {line:?}",
                    i + 1
                );
            }
        }
        mode_lines
    }

    /// T1: no layer type, in either power mode, arms a stationary beam.
    #[tokio::test]
    async fn arm_invariants_every_layer_type() {
        let matrix = arm_matrix().await;
        assert_eq!(matrix.len(), 24, "matrix must hold 24 programs");
        for (label, prog) in &matrix {
            let modes = assert_never_arms(label, &prog.gcode);
            assert!(modes >= 1, "I3 ({label}): program has no mode line");
            let mut section = "";
            let mut positive_g1 = 0;
            for (i, line) in prog.gcode.lines().enumerate() {
                let n = i + 1;
                for marker in ["; Cut:", "; Offset Fill:", "; Engrave:", "; Mask Fill:"] {
                    if line.starts_with(marker) {
                        section = marker;
                    }
                }
                for &(c, v) in &words(line) {
                    if c == 'M' && (v == 3.0 || v == 4.0) {
                        assert_eq!(
                            v, prog.expected_mode,
                            "I3 ({label}) line {n}: wrong mode letter: {line:?}"
                        );
                    }
                }
                if !has_word(line, 'G', 1.0) {
                    continue;
                }
                let s = s_word(line);
                assert!(
                    s.is_some(),
                    "I4 ({label}) line {n}: every G1 must carry its own S: {line:?}"
                );
                let s = s.unwrap();
                if s > 0.0 {
                    positive_g1 += 1;
                }
                match (prog.expected_s, section) {
                    (Some(want), "; Cut:") | (Some(want), "; Offset Fill:") => assert_eq!(
                        s, want,
                        "P1 ({label}) line {n}: a {section} G1 must keep its power: {line:?}"
                    ),
                    (Some(want), "; Engrave:") => assert!(
                        s == 0.0 || s == want,
                        "P1 ({label}) line {n}: an engrave G1 is S0 or S{want}: {line:?}"
                    ),
                    _ => assert!(
                        s <= 1000.0,
                        "P1 ({label}) line {n}: raster S above s_value_max: {line:?}"
                    ),
                }
            }
            assert!(
                positive_g1 >= 1,
                "P1 ({label}): no G1 carries positive power; the program burns nothing"
            );
        }
    }

    /// T2: the committed corpus never arms. Guards a future regeneration from
    /// pinning a re-armed program as the new truth. (Kills no code mutant: it
    /// reads committed files.)
    #[test]
    fn committed_goldens_never_arm() {
        let files = gcode_files(&golden_dir());
        assert!(
            files.len() >= 16,
            "expected at least 16 goldens, found {}",
            files.len()
        );
        let modes: usize = files
            .iter()
            .map(|(name, text)| assert_never_arms(name, text))
            .sum();
        assert!(modes >= 1, "vacuous: no mode line across the corpus");
    }

    // ── safety leadin: every path starts G0 + mode line; no burning G1 stands still ─

    const SECTION_MARKERS: [&str; 5] = [
        "; Cut:",
        "; Engrave:",
        "; Offset Fill:",
        "; Mask Fill:",
        "; Pass ",
    ];

    /// The section marker `line` starts with, if any.
    fn starts_section(line: &str) -> Option<&'static str> {
        SECTION_MARKERS
            .iter()
            .copied()
            .find(|m| line.starts_with(m))
    }

    /// One step of a motor at the owner's $100/$101 = 80 steps/mm. A literal on
    /// purpose, never the engine's MIN_G1_AXIS_MM, so a mutant of the engine
    /// constant cannot move this yardstick.
    const STEP_MM: f64 = 0.0125;

    /// What a controller reading the program so far would believe.
    #[derive(Clone, Debug, Default)]
    struct LeadinState {
        pos: (f64, f64),
        positioned: bool,
        armed: bool,
        spindle_on: bool,
        section: &'static str,
    }

    impl LeadinState {
        fn step(&mut self, line: &str) {
            if let Some(m) = starts_section(line) {
                self.section = m;
            }
            let resets = starts_section(line).is_some() || has_word(line, 'M', 5.0);
            if resets {
                self.positioned = false;
                self.armed = false;
            }
            if has_word(line, 'M', 5.0) {
                self.spindle_on = false;
            }
            if is_mode_line(line) {
                self.armed = true;
                self.spindle_on = true;
            }
            let g0 = has_word(line, 'G', 0.0);
            if (g0 || has_word(line, 'G', 1.0)) && has_xy(line) {
                self.pos = g1_target(line, self.pos);
                if g0 {
                    self.positioned = true;
                }
            }
        }

        /// A mask fill that has left the laser enabled: an `M5` here is a seal.
        fn sealable(&self) -> bool {
            self.section == "; Mask Fill:" && self.spindle_on
        }
    }

    /// The modal X/Y target of a motion line from `pos`.
    fn g1_target(line: &str, pos: (f64, f64)) -> (f64, f64) {
        let mut t = pos;
        for (c, v) in words(line) {
            if c == 'X' {
                t.0 = v;
            } else if c == 'Y' {
                t.1 = v;
            }
        }
        t
    }

    /// True when a move from `from` to `to` (as written) is at least one step on some axis.
    fn g1_moves_text(from: (f64, f64), to: (f64, f64)) -> bool {
        (to.0 - from.0).abs() >= STEP_MM || (to.1 - from.1).abs() >= STEP_MM
    }

    fn is_g1_xy(line: &str) -> bool {
        has_word(line, 'G', 1.0) && has_xy(line)
    }

    fn is_positive_g1(line: &str) -> bool {
        is_g1_xy(line) && s_word(line).is_some_and(|s| s > 0.0)
    }

    fn is_g0_xy(line: &str) -> bool {
        has_word(line, 'G', 0.0) && has_xy(line)
    }

    fn is_mode_s0(line: &str) -> bool {
        is_mode_line(line) && s_word(line) == Some(0.0)
    }

    fn f_word(line: &str) -> Option<f64> {
        words(line)
            .into_iter()
            .find(|&(c, _)| c == 'F')
            .map(|(_, v)| v)
    }

    fn same_f_and_s(b: &str, a: &str) -> bool {
        f_word(b) == f_word(a) && s_word(b) == s_word(a)
    }

    fn is_boundary(line: &str) -> bool {
        line.is_empty() || starts_section(line).is_some() || line.starts_with("; KERF:FOOTER_BEGIN")
    }

    /// I-SEAM, I-ARM, I-DISP and I-STEP over one program. Each line is checked
    /// against the state BEFORE it.
    fn leadin_violations(label: &str, gcode: &str) -> Vec<String> {
        let mut st = LeadinState::default();
        let mut out = Vec::new();
        for (i, line) in gcode.lines().enumerate() {
            let n = i + 1;
            if starts_section(line).is_some() && st.spindle_on {
                out.push(format!(
                    "I-SEAM {label} line {n}: section starts with the laser enabled: {line:?}"
                ));
            }
            if is_positive_g1(line) && !(st.positioned && st.armed) {
                out.push(format!(
                    "I-ARM {label} line {n}: burning G1 without a G0 and mode line since the last M5: {line:?}"
                ));
            }
            if is_g1_xy(line) {
                let t = g1_target(line, st.pos);
                if (t.0 - st.pos.0).abs() < 1e-9 && (t.1 - st.pos.1).abs() < 1e-9 {
                    out.push(format!(
                        "I-DISP {label} line {n}: G1 with zero displacement: {line:?}"
                    ));
                }
            }
            if is_positive_g1(line)
                && matches!(st.section, "; Cut:" | "; Engrave:" | "; Offset Fill:")
                && !g1_moves_text(st.pos, g1_target(line, st.pos))
            {
                out.push(format!(
                    "I-STEP {label} line {n}: burning G1 moves less than one step: {line:?}"
                ));
            }
            st.step(line);
        }
        out
    }

    #[derive(Debug, Default, PartialEq)]
    struct LeadinDiff {
        start: usize,
        retarget: usize,
        delete: usize,
        seal: usize,
    }

    /// Classify a regeneration. Accepted changes: S (a G0 + S0 mode line inserted
    /// before an unarmed burn), R (the first burn after an inserted start moves
    /// by less than a step), M (an M5 sealing a mask fill at a boundary), D (a
    /// G1 that does not move the fixed program's head removed).
    fn classify_leadin_diff(before: &str, after: &str) -> Result<LeadinDiff, String> {
        let bl: Vec<&str> = before.lines().collect();
        let al: Vec<&str> = after.lines().collect();
        let (mut i, mut j) = (0usize, 0usize);
        let mut b_st = LeadinState::default();
        let mut a_st = LeadinState::default();
        let mut just_started = false;
        let mut diff = LeadinDiff::default();
        while i < bl.len() || j < al.len() {
            if i >= bl.len() {
                return Err(format!(
                    "after line {}: {:?} is not a leadin change (before has ended)",
                    j + 1,
                    al[j]
                ));
            }
            let b = bl[i];
            if j >= al.len() {
                let bt = g1_target(b, b_st.pos);
                if is_g1_xy(b) && !g1_moves_text(a_st.pos, bt) {
                    b_st.step(b);
                    i += 1;
                    diff.delete += 1;
                    continue;
                }
                return Err(format!(
                    "before line {}: {:?} is not a leadin change (after has ended)",
                    i + 1,
                    b
                ));
            }
            let a = al[j];
            if b == a {
                b_st.step(b);
                a_st.step(a);
                i += 1;
                j += 1;
                just_started = false;
                continue;
            }
            let (bt, at) = (g1_target(b, b_st.pos), g1_target(a, a_st.pos));
            let may_delete = is_g1_xy(b) && !g1_moves_text(a_st.pos, bt);
            let may_start = is_positive_g1(b) && !(b_st.positioned && b_st.armed);
            let may_seal = a == "M5" && b_st.sealable() && is_boundary(b);
            let may_retarget = just_started && same_f_and_s(b, a) && !g1_moves_text(bt, at);
            if may_start && is_g0_xy(a) && j + 1 < al.len() && is_mode_s0(al[j + 1]) {
                a_st.step(a);
                a_st.step(al[j + 1]);
                j += 2;
                diff.start += 1;
                just_started = true;
                continue;
            }
            if may_retarget && is_positive_g1(b) && is_positive_g1(a) {
                b_st.step(b);
                a_st.step(a);
                i += 1;
                j += 1;
                diff.retarget += 1;
                just_started = false;
                continue;
            }
            if may_seal {
                a_st.step(a);
                j += 1;
                diff.seal += 1;
                continue;
            }
            if may_delete {
                b_st.step(b);
                i += 1;
                diff.delete += 1;
                continue;
            }
            return Err(format!(
                "before line {} / after line {}: {:?} -> {:?} is not a leadin change",
                i + 1,
                j + 1,
                b,
                a
            ));
        }
        Ok(diff)
    }

    /// Number of section or footer markers `before` reaches while a mask fill
    /// has left the laser enabled: the seals a correct regeneration inserts.
    fn expected_seals(before: &str) -> usize {
        let mut st = LeadinState::default();
        let mut n = 0;
        for line in before.lines() {
            if (starts_section(line).is_some() || line.starts_with("; KERF:FOOTER_BEGIN"))
                && st.sealable()
            {
                n += 1;
            }
            st.step(line);
        }
        n
    }

    /// T-L3: the classifier accepts each known class with the right counts.
    #[test]
    fn leadin_diff_accepts_only_known_classes() {
        let ld = |start, retarget, delete, seal| LeadinDiff {
            start,
            retarget,
            delete,
            seal,
        };
        // A1: a duplicate G1 removed
        let b = "; Cut: a\nG0 X0.000 Y0.000\nM3 S0\nG1 X5.000 Y0.000 F1200 S600\nG1 X5.000 Y0.000 F1200 S600\nM5";
        let a = "; Cut: a\nG0 X0.000 Y0.000\nM3 S0\nG1 X5.000 Y0.000 F1200 S600\nM5";
        assert_eq!(classify_leadin_diff(b, a), Ok(ld(0, 0, 1, 0)), "A1");
        // A2: a start inserted
        let b = "; Cut: a\nG1 X10.000 Y90.000 F1200 S600\nM5";
        let a = "; Cut: a\nG0 X7.000 Y90.000\nM3 S0\nG1 X10.000 Y90.000 F1200 S600\nM5";
        assert_eq!(classify_leadin_diff(b, a), Ok(ld(1, 0, 0, 0)), "A2");
        // A3: a start inserted and the first burn retargeted
        let b = "; Cut: a\nG1 X10.001 Y90.000 F1200 S600\nM5";
        assert_eq!(classify_leadin_diff(b, a), Ok(ld(1, 1, 0, 0)), "A3");
        // A4: a mask fill sealed
        let b = "; Mask Fill: m\nM3 S0\nG0 X0.000 Y10.000 S0\nG1 X40.000 F1200 S1000\n\n; Cut: c";
        let a =
            "; Mask Fill: m\nM3 S0\nG0 X0.000 Y10.000 S0\nG1 X40.000 F1200 S1000\nM5\n\n; Cut: c";
        assert_eq!(classify_leadin_diff(b, a), Ok(ld(0, 0, 0, 1)), "A4");
        // A5: path_all_coincide
        let b = "; Cut: z\nG1 X20.000 Y80.000 F1200 S600\nG1 X20.000 Y80.000 F1200 S600\nM5";
        let a = "; Cut: z\nG0 X20.000 Y80.000\nM3 S0\nM5";
        assert_eq!(classify_leadin_diff(b, a), Ok(ld(1, 0, 2, 0)), "A5");
        // A6: identical
        let p = "; Cut: a\nG0 X0.000 Y0.000\nM3 S0\nG1 X5.000 Y0.000 F1200 S600\nM5";
        assert_eq!(classify_leadin_diff(p, p), Ok(ld(0, 0, 0, 0)), "A6");
    }

    /// T-L3b: everything else is rejected, naming the offending line.
    #[test]
    fn leadin_diff_rejects_everything_else() {
        let armed = "; Cut: a\nG0 X0.000 Y0.000\nM3 S0";
        let cases: Vec<(&str, String, String, &str)> = vec![
            (
                "R1",
                format!("{armed}\nG1 X5.000 Y0.000 F1200 S600\nM5"),
                format!("{armed}\nM5"),
                "before line 4",
            ),
            (
                "R2",
                format!("{armed}\nG1 X5.000 Y0.000 F1200 S600\nM5"),
                format!("{armed}\nG0 X0.000 Y0.000\nM3 S0\nG1 X5.000 Y0.000 F1200 S600\nM5"),
                "before line 4",
            ),
            (
                "R3",
                format!("{armed}\nG1 X5.000 Y0.000 F1200 S600\n\n; Cut: b"),
                format!("{armed}\nG1 X5.000 Y0.000 F1200 S600\nM5\n\n; Cut: b"),
                "after line 5",
            ),
            (
                "R4",
                format!("{armed}\nG1 X5.000 Y0.000 F1200 S600\nM5"),
                format!("{armed}\nG1 X5.001 Y0.000 F1200 S600\nM5"),
                "before line 4",
            ),
            (
                "R5",
                "; Cut: a\nG1 X10.001 Y90.000 F1200 S600\nM5".to_string(),
                "; Cut: a\nG0 X7.000 Y90.000\nM3 S0\nG1 X10.000 Y90.000 F1200 S500\nM5".to_string(),
                "before line 2",
            ),
            (
                "R6",
                format!("{armed}\nG1 X5.000 Y0.000 F1200 S600\nM5"),
                format!("{armed}\nG1 X5.000 Y0.000 F1200 S600\nG1 X7.000 Y0.000 F1200 S600\nM5"),
                "after line 5",
            ),
            (
                "R7",
                "; Cut: a\nG1 X10.000 Y90.000 F1200 S600\nM5".to_string(),
                "; Cut: a\nM3 S0\nG1 X10.000 Y90.000 F1200 S600\nM5".to_string(),
                "before line 2",
            ),
            (
                "R8",
                "; Mask Fill: m\nM3 S0\nG1 X40.000 F1200 S1000\nM5\n\n; Cut: c".to_string(),
                "; Mask Fill: m\nM3 S0\nG1 X40.000 F1200 S1000\nM5\nM5\n\n; Cut: c".to_string(),
                "after line 5",
            ),
            (
                "R9",
                format!("{armed}\nG1 X5.000 Y0.000 F1200 S600\nM5"),
                "; Cut: a\nM3 S0\nG1 X5.000 Y0.000 F1200 S600\nM5".to_string(),
                "before line 2",
            ),
        ];
        for (id, before, after, needle) in cases {
            match classify_leadin_diff(&before, &after) {
                Ok(d) => panic!("{id}: {before:?} -> {after:?} must be rejected, got {d:?}"),
                Err(e) => assert!(
                    e.contains(needle),
                    "{id}: error must name {needle:?}, got {e:?}"
                ),
            }
        }
    }

    /// T-L3c: the checker flags each known-bad shape, and only those.
    #[test]
    fn leadin_checker_flags_known_bad_programs() {
        let has = |v: &[String], id: &str| v.iter().any(|m| m.starts_with(id));
        // K1: clean
        let k1 = "; Cut: a\nG0 X0.000 Y0.000\nM3 S0\nG1 X5.000 Y0.000 F1200 S600\nM5\n\n; Cut: b";
        assert_eq!(leadin_violations("K1", k1), Vec::<String>::new(), "K1");
        // K2: burn straight after the marker
        let k2 = leadin_violations("K2", "; Cut: a\nG1 X5.000 Y0.000 F1200 S600\nM5");
        assert!(has(&k2, "I-ARM"), "K2: {k2:?}");
        // K3: the M5 resets arming within a section
        let k3 = leadin_violations(
            "K3",
            "; Cut: a\nG0 X0.000 Y0.000\nM3 S0\nG1 X5.000 Y0.000 F1200 S600\nM5\nG0 X10.000 Y0.000\nG1 X15.000 Y0.000 F1200 S600\nM5",
        );
        assert_eq!(k3.len(), 1, "K3: {k3:?}");
        assert!(
            k3[0].starts_with("I-ARM K3 line 7"),
            "K3: second burn must be I-ARM: {k3:?}"
        );
        // K4: a repeated G1
        let k4 = leadin_violations(
            "K4",
            "; Cut: a\nG0 X0.000 Y0.000\nM3 S0\nG1 X5.000 Y0.000 F1200 S600\nG1 X5.000 Y0.000 F1200 S600\nM5",
        );
        assert!(has(&k4, "I-DISP"), "K4: {k4:?}");
        // K5: sub-step burn in a vector section
        let k5 = leadin_violations(
            "K5",
            "; Cut: a\nG0 X0.000 Y0.000\nM3 S0\nG1 X0.010 Y0.000 F1200 S600\nM5",
        );
        assert!(has(&k5, "I-STEP"), "K5: {k5:?}");
        // K6: a mask fill hands the next section an enabled laser
        let k6 = leadin_violations(
            "K6",
            "; Mask Fill: m\nM3 S0\nG0 X0.000 Y10.000 S0\nG1 X40.000 F1200 S1000\n\n; Cut: c",
        );
        assert!(has(&k6, "I-SEAM"), "K6: {k6:?}");
        // K7: a sub-step raster burn is out of I-STEP's scope
        let k7 = leadin_violations(
            "K7",
            "; Mask Fill: m\nM3 S0\nG0 X0.000 Y10.000 S0\nG1 X0.010 F1200 S1000\nM5",
        );
        assert_eq!(k7, Vec::<String>::new(), "K7");
    }

    /// One leadin matrix program and what it must satisfy.
    struct LeadinFixture {
        gcode: String,
        /// P2: the path perimeter (times passes) the burn must cover.
        perimeter: Option<f64>,
        /// P3: the requested lead-in length.
        lead_in: Option<f64>,
        /// P1: whether anything must burn.
        expect_burn: bool,
    }

    fn pts_perimeter(pts: &[(f64, f64)], closed: bool) -> f64 {
        let mut p = 0.0;
        for w in pts.windows(2) {
            p += ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt();
        }
        if closed && pts.len() > 2 {
            let (f, l) = (pts[0], pts[pts.len() - 1]);
            p += ((f.0 - l.0).powi(2) + (f.1 - l.1).powi(2)).sqrt();
        }
        p
    }

    fn obj_perimeter(obj: &CutObject) -> f64 {
        let seg = crate::engine::gcode_gen::object_to_path(obj);
        let pts: Vec<(f64, f64)> = seg.points.iter().map(|p| (p.x, p.y)).collect();
        pts_perimeter(&pts, seg.closed)
    }

    fn leadin_path_obj(id: &str, pts: &[(f64, f64)], layer: CutLayer) -> CutObject {
        let min_x = pts.iter().map(|p| p.0).fold(f64::MAX, f64::min);
        let min_y = pts.iter().map(|p| p.1).fold(f64::MAX, f64::min);
        let max_x = pts.iter().map(|p| p.0).fold(f64::MIN, f64::max);
        let max_y = pts.iter().map(|p| p.1).fold(f64::MIN, f64::max);
        let mut obj = rect_obj(id, min_x, min_y, max_x - min_x, max_y - min_y, layer);
        obj.obj_type = "path".to_string();
        obj.paths = vec![PathSegment {
            points: pts.iter().map(|&(x, y)| Point { x, y }).collect(),
            closed: true,
        }];
        obj
    }

    fn rounded_obj(id: &str, x: f64, y: f64, w: f64, h: f64, r: f64, layer: CutLayer) -> CutObject {
        let mut obj = rect_obj(id, x, y, w, h, layer);
        obj.corner_radius = Some(r);
        obj
    }

    /// 17 fixtures x {constant, variable} = 34 programs, labelled
    /// `<label>_<power_mode>`. Labels and parameters must not change between a
    /// before-snapshot and its after-snapshot.
    async fn leadin_matrix() -> Vec<(String, LeadinFixture)> {
        let mut out = Vec::new();
        for pm in ["constant", "variable"] {
            let name = |label: &str| format!("{label}_{pm}");
            let line = |lead_in: f64| {
                let mut l = arm_layer("line", pm);
                l.lead_in = lead_in;
                l
            };
            let fx = |gcode: String, perimeter: Option<f64>, lead_in: Option<f64>, expect_burn| {
                LeadinFixture {
                    gcode,
                    perimeter,
                    lead_in,
                    expect_burn,
                }
            };

            // pill_leadin
            let obj = rounded_obj("pill", 10.0, 10.0, 10.0, 20.0, 5.0, line(3.0));
            let p = obj_perimeter(&obj);
            out.push((
                name("pill_leadin"),
                fx(arm_vector(vec![obj]).await, Some(p), Some(3.0), true),
            ));

            // pill_after_maskfill
            let outer = rect_path(0.0, 0.0, 40.0, 40.0);
            let hole = rect_path(15.0, 15.0, 10.0, 10.0);
            let mut ml = arm_layer("maskFill", pm);
            ml.interval = 5.0;
            let mut mask_obj = rect_obj("mf_fill", 0.0, 0.0, 40.0, 40.0, ml);
            mask_obj.obj_type = "path".to_string();
            mask_obj.paths = vec![outer, hole];
            mask_obj.layer_index = Some(0);
            let mut pill = rounded_obj("pill", 50.0, 10.0, 10.0, 20.0, 5.0, line(3.0));
            pill.layer_index = Some(0);
            let p = obj_perimeter(&pill);
            out.push((
                name("pill_after_maskfill"),
                fx(
                    arm_vector(vec![pill, mask_obj]).await,
                    Some(p),
                    Some(3.0),
                    true,
                ),
            ));

            // pill_radius_clamp
            let obj = rounded_obj("pill", 10.0, 10.0, 10.0, 20.0, 8.0, line(3.0));
            let p = obj_perimeter(&obj);
            out.push((
                name("pill_radius_clamp"),
                fx(arm_vector(vec![obj]).await, Some(p), Some(3.0), true),
            ));

            // pill_wide
            let mut l = line(3.0);
            l.lead_out = 2.0;
            let obj = rounded_obj("pill", 10.0, 10.0, 20.0, 10.0, 5.0, l);
            let p = obj_perimeter(&obj);
            out.push((
                name("pill_wide"),
                fx(arm_vector(vec![obj]).await, Some(p), Some(3.0), true),
            ));

            // rounded_plain_2pass
            let mut l = line(0.0);
            l.passes = 2;
            let obj = rounded_obj("rr", 10.0, 10.0, 30.0, 20.0, 3.0, l);
            let p = obj_perimeter(&obj) * 2.0;
            out.push((
                name("rounded_plain_2pass"),
                fx(arm_vector(vec![obj]).await, Some(p), None, true),
            ));

            // rounded_perf (control)
            let mut l = line(2.0);
            l.perforation_cut = 3.0;
            l.perforation_skip = 2.0;
            let obj = rounded_obj("rr", 10.0, 10.0, 30.0, 20.0, 3.0, l);
            out.push((
                name("rounded_perf"),
                fx(arm_vector(vec![obj]).await, None, None, true),
            ));

            // rounded_tabs (control)
            let mut l = line(0.0);
            l.tab_spacing = 8.0;
            l.tab_width = 2.0;
            let obj = rounded_obj("rr", 10.0, 10.0, 30.0, 20.0, 3.0, l);
            out.push((
                name("rounded_tabs"),
                fx(arm_vector(vec![obj]).await, None, None, true),
            ));

            // path_dup_first
            let pts = [
                (10.0, 10.0),
                (10.0, 10.0),
                (30.0, 10.0),
                (30.0, 30.0),
                (10.0, 30.0),
            ];
            let obj = leadin_path_obj("dup", &pts, line(3.0));
            out.push((
                name("path_dup_first"),
                fx(
                    arm_vector(vec![obj]).await,
                    Some(pts_perimeter(&pts, true)),
                    Some(3.0),
                    true,
                ),
            ));

            // path_near_dup_first
            let pts = [
                (10.0, 10.0),
                (10.0008, 10.0),
                (30.0, 10.0),
                (30.0, 30.0),
                (10.0, 30.0),
            ];
            let obj = leadin_path_obj("neardup", &pts, line(3.0));
            out.push((
                name("path_near_dup_first"),
                fx(
                    arm_vector(vec![obj]).await,
                    Some(pts_perimeter(&pts, true)),
                    Some(3.0),
                    true,
                ),
            ));

            // path_all_coincide
            let pts = [(20.0, 20.0); 4];
            let obj = leadin_path_obj("z", &pts, line(3.0));
            out.push((
                name("path_all_coincide"),
                fx(arm_vector(vec![obj]).await, None, None, false),
            ));

            // substep_junction
            let pts = [
                (10.0, 10.0),
                (30.0, 10.0),
                (30.0098, 10.0),
                (30.0098, 30.0),
                (10.0, 30.0),
            ];
            let obj = leadin_path_obj("junction", &pts, line(0.0));
            out.push((
                name("substep_junction"),
                fx(
                    arm_vector(vec![obj]).await,
                    Some(pts_perimeter(&pts, true)),
                    None,
                    true,
                ),
            ));

            // boundary_rounding
            let pts = [
                (10.0006, 10.0),
                (10.0133, 10.0),
                (30.0, 10.0),
                (30.0, 30.0),
                (10.0, 30.0),
            ];
            let obj = leadin_path_obj("rounding", &pts, line(0.0));
            out.push((
                name("boundary_rounding"),
                fx(
                    arm_vector(vec![obj]).await,
                    Some(pts_perimeter(&pts, true)),
                    None,
                    true,
                ),
            ));

            // rect_perf_on_corner
            let mut l = line(0.0);
            l.perforation_cut = 30.0;
            l.perforation_skip = 5.0;
            out.push((
                name("rect_perf_on_corner"),
                fx(
                    arm_vector(vec![arm_line_obj("perf", l)]).await,
                    None,
                    None,
                    true,
                ),
            ));

            // rect_tab_on_corner
            let mut l = line(0.0);
            l.tab_spacing = 30.0;
            l.tab_width = 2.0;
            out.push((
                name("rect_tab_on_corner"),
                fx(
                    arm_vector(vec![arm_line_obj("tabs", l)]).await,
                    None,
                    None,
                    true,
                ),
            ));

            // tiny_extensions
            let mut l = line(0.005);
            l.overcut = 0.005;
            l.lead_out = 0.005;
            out.push((
                name("tiny_extensions"),
                fx(
                    arm_vector(vec![arm_line_obj("tiny", l)]).await,
                    None,
                    None,
                    true,
                ),
            ));

            // zero_width_fill
            let mut l = arm_layer("fill", pm);
            l.interval = 2.0;
            l.overscan = 0.0;
            let obj = rect_obj("zw", 10.0, 10.0, 0.0, 10.0, l);
            out.push((
                name("zero_width_fill"),
                fx(arm_vector(vec![obj]).await, None, None, false),
            ));

            // offset_fill_rounded
            let mut l = arm_layer("offsetFill", pm);
            l.interval = 2.0;
            let obj = rounded_obj("of", 10.0, 10.0, 20.0, 20.0, 3.0, l);
            out.push((
                name("offset_fill_rounded"),
                fx(arm_vector(vec![obj]).await, None, None, true),
            ));
        }
        out
    }

    const LEADIN_MATRIX_OUT: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/target/leadin-matrix-out");
    const LEADIN_BEFORE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/leadin-before");

    /// T-L5: write every leadin and arm matrix program to
    /// `target/leadin-matrix-out/`. Run explicitly (`-- --ignored`) to snapshot
    /// before and after the engine change.
    #[tokio::test]
    #[ignore]
    async fn leadin_matrix_snapshot() {
        let dir = std::path::Path::new(LEADIN_MATRIX_OUT);
        if dir.exists() {
            std::fs::remove_dir_all(dir).expect("clear leadin-matrix-out");
        }
        std::fs::create_dir_all(dir).expect("create leadin-matrix-out");
        let leadin = leadin_matrix().await;
        for (label, fx) in &leadin {
            std::fs::write(dir.join(format!("leadin__{label}.gcode")), &fx.gcode)
                .unwrap_or_else(|e| panic!("write {label}: {e}"));
        }
        let arm = arm_matrix().await;
        for (label, prog) in &arm {
            std::fs::write(dir.join(format!("arm__{label}.gcode")), &prog.gcode)
                .unwrap_or_else(|e| panic!("write {label}: {e}"));
        }
        assert_eq!(leadin.len(), 34, "leadin matrix must hold 34 programs");
        assert_eq!(arm.len(), 24, "arm matrix must hold 24 programs");
        assert_eq!(
            gcode_files(dir).len(),
            58,
            "must write exactly 58 distinct files"
        );
        let no_burn: Vec<&str> = leadin
            .iter()
            .filter(|(_, f)| !f.expect_burn)
            .map(|(l, _)| l.as_str())
            .collect();
        assert_eq!(no_burn.len(), 4, "expect_burn false: {no_burn:?}");
        assert!(no_burn
            .iter()
            .all(|l| l.starts_with("path_all_coincide_") || l.starts_with("zero_width_fill_")));
        let perims = leadin.iter().filter(|(_, f)| f.perimeter.is_some()).count();
        assert_eq!(perims, 18, "perimeter is Some for 18 programs");
        let leads: Vec<&str> = leadin
            .iter()
            .filter(|(_, f)| f.lead_in.is_some())
            .map(|(l, _)| l.as_str())
            .collect();
        assert_eq!(
            leads.len(),
            12,
            "lead_in is Some for 12 programs: {leads:?}"
        );
        for l in &leads {
            assert!(
                [
                    "pill_leadin_",
                    "pill_after_maskfill_",
                    "pill_radius_clamp_",
                    "pill_wide_",
                    "path_dup_first_",
                    "path_near_dup_first_"
                ]
                .iter()
                .any(|p| l.starts_with(p)),
                "unexpected lead_in fixture {l}"
            );
        }
    }

    /// Expected per-fixture classifier counts: (start, retarget, delete, seal,
    /// delete is a minimum).
    fn leadin_expected(fixture: &str) -> (usize, usize, usize, usize, bool) {
        match fixture {
            "pill_leadin" => (1, 0, 6, 0, false),
            "pill_after_maskfill" => (1, 0, 6, 1, false),
            "pill_radius_clamp" => (1, 0, 6, 0, false),
            "pill_wide" => (0, 0, 7, 0, false),
            "rounded_plain_2pass" => (0, 0, 10, 0, false),
            "rounded_perf" => (0, 0, 0, 0, false),
            "rounded_tabs" => (0, 0, 0, 0, false),
            "path_dup_first" => (1, 0, 0, 0, false),
            "path_near_dup_first" => (1, 1, 0, 0, false),
            "path_all_coincide" => (1, 0, 4, 0, false),
            "substep_junction" => (0, 0, 1, 0, false),
            "boundary_rounding" => (0, 0, 1, 0, false),
            "rect_perf_on_corner" => (0, 0, 1, 0, false),
            "rect_tab_on_corner" => (0, 0, 1, 0, false),
            "tiny_extensions" => (0, 0, 3, 0, false),
            "zero_width_fill" => (0, 0, 1, 0, true),
            "offset_fill_rounded" => (0, 0, 4, 0, true),
            other => panic!("no expectation for leadin fixture {other:?}"),
        }
    }

    /// T-L4: one-shot proof that the regeneration changed only classified
    /// lines. Needs `target/leadin-before` (the goldens) and
    /// `target/leadin-before/matrix` (the T-L5 snapshot at Commit 1), and the
    /// after-snapshot in `target/leadin-matrix-out`.
    #[test]
    #[ignore]
    fn leadin_regeneration_is_classified() {
        let before_dir = std::path::Path::new(LEADIN_BEFORE);
        assert!(
            before_dir.is_dir(),
            "{} is missing: snapshot the before state first",
            before_dir.display()
        );
        let before_g = gcode_files(before_dir);
        let after_g = gcode_files(&golden_dir());
        assert!(before_g.len() >= 16, "before goldens: {}", before_g.len());
        let before_m = gcode_files(&before_dir.join("matrix"));
        let after_m = gcode_files(std::path::Path::new(LEADIN_MATRIX_OUT));
        assert_eq!(before_m.len(), 58, "before matrix must hold 58 files");
        assert_eq!(after_m.len(), 58, "after matrix must hold 58 files");

        let mut errors = Vec::new();
        for (corpus, before, after) in [
            ("golden", &before_g, &after_g),
            ("matrix", &before_m, &after_m),
        ] {
            assert_eq!(
                before.keys().collect::<Vec<_>>(),
                after.keys().collect::<Vec<_>>(),
                "{corpus}: before and after file sets differ"
            );
            for (name, b) in before {
                let a = &after[name];
                let d = match classify_leadin_diff(b, a) {
                    Ok(d) => d,
                    Err(e) => {
                        errors.push(format!("{corpus} {name}: Err {e}"));
                        continue;
                    }
                };
                println!(
                    "{corpus} {name}: start={} retarget={} delete={} seal={}",
                    d.start, d.retarget, d.delete, d.seal
                );
                let expect = if let Some(rest) = name.strip_prefix("leadin__") {
                    let label = rest.trim_end_matches(".gcode");
                    let fixture = label
                        .strip_suffix("_constant")
                        .or_else(|| label.strip_suffix("_variable"))
                        .expect("leadin label ends in a power mode");
                    let (s, r, del, seal, del_min) = leadin_expected(fixture);
                    let del_ok = if del_min {
                        d.delete >= del
                    } else {
                        d.delete == del
                    };
                    (
                        d.start == s && d.retarget == r && del_ok && d.seal == seal,
                        format!(
                            "start={s} retarget={r} delete{}{del} seal={seal}",
                            if del_min { ">=" } else { "=" }
                        ),
                    )
                } else {
                    let seal = expected_seals(b);
                    (
                        d.start == 0 && d.retarget == 0 && d.delete == 0 && d.seal == seal,
                        format!("start=0 retarget=0 delete=0 seal={seal}"),
                    )
                };
                if !expect.0 {
                    errors.push(format!("{corpus} {name}: got {d:?}, expected {}", expect.1));
                }
            }
        }
        assert!(
            errors.is_empty(),
            "leadin regeneration:\n{}",
            errors.join("\n")
        );
    }

    /// P1, P2 and P3 over one leadin fixture.
    fn leadin_properties(label: &str, fx: &LeadinFixture) -> Vec<String> {
        struct Section {
            marker: &'static str,
            g0: bool,
            mode: bool,
            m5: bool,
            first_burn_after_mode: Option<f64>,
        }
        let mut st = LeadinState::default();
        let mut sections: Vec<Section> = Vec::new();
        let mut positives = 0usize;
        let mut burned = 0.0_f64;
        for line in fx.gcode.lines() {
            if let Some(m) = starts_section(line) {
                sections.push(Section {
                    marker: m,
                    g0: false,
                    mode: false,
                    m5: false,
                    first_burn_after_mode: None,
                });
            }
            if line.starts_with("; KERF:FOOTER_BEGIN") {
                // The footer is not a section: stop attributing lines to the last one.
                sections.push(Section {
                    marker: "footer",
                    g0: false,
                    mode: false,
                    m5: false,
                    first_burn_after_mode: None,
                });
            }
            if let Some(sec) = sections.last_mut() {
                if is_g0_xy(line) {
                    sec.g0 = true;
                }
                if has_word(line, 'M', 5.0) {
                    sec.m5 = true;
                }
                if is_positive_g1(line) {
                    let t = g1_target(line, st.pos);
                    let len = ((t.0 - st.pos.0).powi(2) + (t.1 - st.pos.1).powi(2)).sqrt();
                    if sec.marker == "; Cut:" {
                        burned += len;
                        if sec.mode && sec.first_burn_after_mode.is_none() {
                            sec.first_burn_after_mode = Some(len);
                        }
                    }
                }
                if is_mode_line(line) {
                    sec.mode = true;
                }
            }
            if is_positive_g1(line) {
                positives += 1;
            }
            st.step(line);
        }
        let real: Vec<&Section> = sections.iter().filter(|s| s.marker != "footer").collect();
        let cuts: Vec<&&Section> = real.iter().filter(|s| s.marker == "; Cut:").collect();
        let mut out = Vec::new();
        if fx.expect_burn {
            if positives == 0 {
                out.push(format!("P1 {label}: burns nothing"));
            }
        } else {
            if positives != 0 {
                out.push(format!(
                    "P1 {label}: {positives} burning G1s where nothing may burn"
                ));
            }
            for s in &real {
                if s.marker == "; Pass " {
                    continue;
                }
                if !(s.g0 && s.mode && s.m5) {
                    out.push(format!(
                        "P1 {label}: {} section lacks a G0 ({}), a mode line ({}) or an M5 ({})",
                        s.marker, s.g0, s.mode, s.m5
                    ));
                }
            }
        }
        if let Some(p) = fx.perimeter {
            let lead: f64 = if fx.lead_in.is_some() {
                cuts.iter().filter_map(|s| s.first_burn_after_mode).sum()
            } else {
                0.0
            };
            let net = burned - lead;
            if net < p - 0.1 {
                out.push(format!(
                    "P2 {label}: burned {net:.4} mm (excluding lead-in) < perimeter {p:.4} - 0.1"
                ));
            }
        }
        if let Some(l) = fx.lead_in {
            if cuts.is_empty() {
                out.push(format!("P3 {label}: no ; Cut: section"));
            }
            for s in &cuts {
                if !s.mode {
                    out.push(format!("P3 {label}: ; Cut: section has no mode line"));
                } else {
                    match s.first_burn_after_mode {
                        None => out.push(format!(
                            "P3 {label}: no burning G1 after the section's mode line"
                        )),
                        Some(len) if (len - l).abs() > 0.002 => out.push(format!(
                            "P3 {label}: lead-in G1 is {len:.4} mm, requested {l}"
                        )),
                        Some(_) => {}
                    }
                }
            }
        }
        out
    }

    /// T-L1: every leadin fixture and every arm fixture, both power modes, holds
    /// I-SEAM, I-ARM, I-DISP, I-STEP, P1-P3 and engine-arm's I1/I2.
    #[tokio::test]
    async fn leadin_invariants_every_fixture() {
        let leadin = leadin_matrix().await;
        let arm = arm_matrix().await;
        assert_eq!(leadin.len(), 34, "leadin matrix must hold 34 programs");
        assert_eq!(arm.len(), 24, "arm matrix must hold 24 programs");
        let mut report: Vec<String> = Vec::new();
        for (label, fx) in &leadin {
            let mut v = leadin_violations(label, &fx.gcode);
            v.extend(leadin_properties(label, fx));
            if !v.is_empty() {
                report.push(format!("{label}:\n  {}", v.join("\n  ")));
            }
        }
        for (label, prog) in &arm {
            let label = format!("arm__{label}");
            let v = leadin_violations(&label, &prog.gcode);
            if !v.is_empty() {
                report.push(format!("{label}:\n  {}", v.join("\n  ")));
            }
        }
        assert!(
            report.is_empty(),
            "leadin violations:\n{}",
            report.join("\n")
        );
        for (label, fx) in &leadin {
            assert_never_arms(label, &fx.gcode);
        }
        for (label, prog) in &arm {
            assert_never_arms(label, &prog.gcode);
        }
    }

    /// T-L2: the committed corpus holds the leadin invariants. Guards a future
    /// regeneration; kills no code mutant (it reads committed files).
    #[test]
    fn committed_goldens_hold_leadin_invariants() {
        let files = gcode_files(&golden_dir());
        assert!(
            files.len() >= 16,
            "expected at least 16 goldens, found {}",
            files.len()
        );
        let positives: usize = files
            .values()
            .map(|t| t.lines().filter(|l| is_positive_g1(l)).count())
            .sum();
        assert!(positives >= 1, "vacuous: no burning G1 across the corpus");
        let all: Vec<String> = files
            .iter()
            .flat_map(|(name, text)| leadin_violations(name, text))
            .collect();
        assert!(
            all.is_empty(),
            "golden leadin violations:\n{}",
            all.join("\n")
        );
    }
}
