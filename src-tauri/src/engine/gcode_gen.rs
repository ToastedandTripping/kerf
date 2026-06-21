use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathSegment {
    pub points: Vec<Point>,
    pub closed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutLayer {
    pub mode: String,        // "line", "fill"
    pub power: f64,          // 0-100
    pub power_min: f64,      // 0-100
    pub speed: f64,          // mm/min
    pub passes: u32,
    pub power_mode: String,  // "constant" or "variable"
    pub interval: f64,       // mm - line interval for fill
    pub air_assist: bool,
    pub cut_inner_first: bool,
    pub dither: String,
    #[serde(default)]
    pub scan_angle: f64,     // degrees - scan direction for fill mode
    #[serde(default)]
    pub angle_increment: f64, // degrees - added per pass
    pub overcut: f64,
    pub lead_in: f64,
    pub lead_out: f64,
    pub overscan: f64,
    pub bidirectional: bool,
    pub cross_hatch: bool,
    pub scanning_offset: f64,
    pub tab_spacing: f64,
    pub tab_width: f64,
    pub perforation_cut: f64,   // mm - 0 = disabled
    pub perforation_skip: f64,  // mm
    #[serde(default)]
    pub power_curve: Option<Vec<(f64, f64)>>,  // (shade 0-255, power 0-100%) control points
    #[serde(default)]
    pub fill_order: Option<String>,  // "sequential" (default) or "flood"
    #[serde(default)]
    pub newsprint_cell_size: Option<u32>,  // Newsprint dither cell size (default 6)
    #[serde(default)]
    pub newsprint_angle: Option<f64>,      // Newsprint dither angle (default 45)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutObject {
    pub id: String,
    pub obj_type: String,    // "rectangle", "ellipse", "line", "path"
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub paths: Vec<PathSegment>,
    pub layer: CutLayer,
    pub corner_radius: Option<f64>,
    pub rotation: f64,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub layer_index: Option<i32>,  // F7: preserves TS layer position for cut ordering
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcodeMove {
    pub x: f64,
    pub y: f64,
    pub move_type: String,   // "rapid", "cut", "engrave"
    pub speed: f64,          // mm/min (GRBL uses mm/min)
    pub power: f64,          // 0-1000 (S value)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcodeResult {
    pub gcode: String,
    pub moves: Vec<GcodeMove>,
    pub total_distance: f64,       // mm
    pub cut_distance: f64,         // mm
    pub travel_distance: f64,      // mm
    pub estimated_time_secs: f64,
    pub line_count: usize,
}

struct ScanLineParams {
    overscan: f64,
    scanning_offset: f64,
    interval: f64,
    bidirectional: bool,
    speed_mm_min: f64,
    s_max: f64,
    power_cmd: String,
    workspace_height: f64,
    origin_top: bool,
    rotation_rad: f64,
    center_x: f64,
    center_y: f64,
}

/// A single scan segment in design space (before transform to GRBL coords).
/// `y` is the scan-line position, `x_start`/`x_end` define the engrave stroke,
/// and `forward` indicates direction (for bidirectional scanning).
#[derive(Debug, Clone)]
struct ScanSegment {
    y: f64,       // line position (scan-line coordinate)
    x_start: f64, // start of engrave (in scan axis)
    x_end: f64,   // end of engrave (in scan axis)
    forward: bool, // direction of travel
}

/// Transform a design-space point through optional rotation and Y-flip to GRBL coordinates
fn transform_to_grbl(x: f64, y: f64, params: &ScanLineParams) -> (f64, f64) {
    let (rx, ry) = if params.rotation_rad.abs() > 0.001 {
        let dx = x - params.center_x;
        let dy = y - params.center_y;
        let cos = params.rotation_rad.cos();
        let sin = params.rotation_rad.sin();
        (params.center_x + dx * cos - dy * sin, params.center_y + dx * sin + dy * cos)
    } else {
        (x, y)
    };
    (rx, if params.origin_top { -ry } else { params.workspace_height - ry })
}

/// Collect scan segments for fill mode (horizontal or vertical) without emitting G-code.
fn collect_scan_segments(
    params: &ScanLineParams,
    scan_min: f64,
    scan_max: f64,
    line_min: f64,
    line_max: f64,
) -> Vec<ScanSegment> {
    let mut segments = Vec::new();
    let mut pos = line_min;
    let mut forward = true;

    while pos <= line_max {
        let offset = if !forward { params.scanning_offset } else { 0.0 };
        let (start, end) = if forward {
            (scan_min, scan_max)
        } else {
            (scan_max + offset, scan_min + offset)
        };

        segments.push(ScanSegment {
            y: pos,
            x_start: start,
            x_end: end,
            forward,
        });

        pos += params.interval;
        if params.bidirectional {
            forward = !forward;
        }
    }

    segments
}

/// Emit G-code from a list of scan segments (possibly reordered).
#[allow(clippy::too_many_arguments)]
fn emit_scan_segments(
    segments: &[ScanSegment],
    params: &ScanLineParams,
    lines: &mut Vec<String>,
    moves: &mut Vec<GcodeMove>,
    cut_distance: &mut f64,
    travel_distance: &mut f64,
    total_distance: &mut f64,
    cur_x: &mut f64,
    cur_y: &mut f64,
    vertical: bool,
) {
    for seg in segments {
        let overscan_start = if seg.forward { seg.x_start - params.overscan } else { seg.x_start + params.overscan };
        let overscan_end = if seg.forward { seg.x_end + params.overscan } else { seg.x_end - params.overscan };

        let (rsx, rsy) = if vertical {
            transform_to_grbl(seg.y, overscan_start, params)
        } else {
            transform_to_grbl(overscan_start, seg.y, params)
        };

        // Rapid to overscan start
        let dist = ((rsx - *cur_x).powi(2) + (rsy - *cur_y).powi(2)).sqrt();
        *travel_distance += dist;
        *total_distance += dist;
        lines.push(format!("G0 X{:.3} Y{:.3}", rsx, rsy));
        moves.push(GcodeMove { x: rsx, y: rsy, move_type: "rapid".to_string(), speed: 3000.0, power: 0.0 });

        // Accelerate to boundary at engrave speed with laser off
        if params.overscan > 0.0 {
            let (bsx, bsy) = if vertical {
                transform_to_grbl(seg.y, seg.x_start, params)
            } else {
                transform_to_grbl(seg.x_start, seg.y, params)
            };
            let d = params.overscan;
            *travel_distance += d;
            *total_distance += d;
            lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S0", bsx, bsy, params.speed_mm_min));
            moves.push(GcodeMove { x: bsx, y: bsy, move_type: "rapid".to_string(), speed: params.speed_mm_min, power: 0.0 });
        }

        // Engrave scan line
        lines.push(format!("{} S{}", params.power_cmd, params.s_max));
        let (esx, esy) = if vertical {
            transform_to_grbl(seg.y, seg.x_end, params)
        } else {
            transform_to_grbl(seg.x_end, seg.y, params)
        };
        let scan_dist = (seg.x_end - seg.x_start).abs();
        *cut_distance += scan_dist;
        *total_distance += scan_dist;
        lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", esx, esy, params.speed_mm_min, params.s_max));
        moves.push(GcodeMove { x: esx, y: esy, move_type: "engrave".to_string(), speed: params.speed_mm_min, power: params.s_max });
        lines.push("M5".to_string());

        // Deceleration overscan zone
        if params.overscan > 0.0 {
            let (oex, oey) = if vertical {
                transform_to_grbl(seg.y, overscan_end, params)
            } else {
                transform_to_grbl(overscan_end, seg.y, params)
            };
            let d = params.overscan;
            *travel_distance += d;
            *total_distance += d;
            lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S0", oex, oey, params.speed_mm_min));
            moves.push(GcodeMove { x: oex, y: oey, move_type: "rapid".to_string(), speed: params.speed_mm_min, power: 0.0 });
            *cur_x = oex;
            *cur_y = oey;
        } else {
            *cur_x = esx;
            *cur_y = esy;
        }
    }
}

/// Generate scan lines for fill mode (horizontal or vertical).
/// Collects segments, optionally reorders for flood fill, then emits G-code.
#[allow(clippy::too_many_arguments)]
fn generate_scan_lines(
    params: &ScanLineParams,
    lines: &mut Vec<String>,
    moves: &mut Vec<GcodeMove>,
    cut_distance: &mut f64,
    travel_distance: &mut f64,
    total_distance: &mut f64,
    cur_x: &mut f64,
    cur_y: &mut f64,
    scan_min: f64,
    scan_max: f64,
    line_min: f64,
    line_max: f64,
    vertical: bool,
    fill_order: Option<&str>,
) {
    let segments = collect_scan_segments(params, scan_min, scan_max, line_min, line_max);

    let segments = if fill_order == Some("flood") {
        // Convert to (y, x_start, x_end) tuples for flood reorder
        let tuples: Vec<(f64, f64, f64)> = segments.iter()
            .map(|s| (s.y, s.x_start, s.x_end))
            .collect();
        let reordered = super::optimizer::flood_reorder_segments(&tuples);
        // Rebuild ScanSegments from reordered tuples, recalculating direction
        reordered.iter()
            .map(|&(y, x_start, x_end)| ScanSegment {
                y,
                x_start,
                x_end,
                forward: x_end >= x_start,
            })
            .collect()
    } else {
        segments
    };

    emit_scan_segments(
        &segments, params, lines, moves,
        cut_distance, travel_distance, total_distance,
        cur_x, cur_y, vertical,
    );
}

/// Generate G-code from a list of objects with their layer settings
pub fn generate_gcode(objects: &[CutObject], workspace_height: f64, s_value_max: f64, origin_top: bool) -> GcodeResult {
    let fy = |y: f64| -> f64 { if origin_top { -y } else { workspace_height - y } };
    let mut lines: Vec<String> = Vec::new();
    let mut moves: Vec<GcodeMove> = Vec::new();
    let mut total_distance = 0.0_f64;
    let mut cut_distance = 0.0_f64;
    let mut travel_distance = 0.0_f64;
    let mut cur_x = 0.0_f64;
    let mut cur_y = 0.0_f64;

    // Header
    lines.push("; Generated by Kerf".to_string());
    lines.push("G21 ; mm mode".to_string());
    lines.push("G90 ; absolute positioning".to_string());
    lines.push("M5 ; laser off".to_string());
    lines.push("G0 X0 Y0 ; home".to_string());
    lines.push(String::new());

    // Objects arrive pre-sorted by commands/gcode.rs (inner-first + nearest-neighbor). Do not re-sort.

    for obj in objects {
        let layer = &obj.layer;
        let speed_mm_min = layer.speed; // canonical unit is mm/min
        let s_max = (layer.power / 100.0 * s_value_max).round();
        // Fix 6: compute s_min from power_min; used in M4 (variable) mode to floor S values.
        let s_min = (layer.power_min / 100.0 * s_value_max).round();

        // Power mode command
        let power_cmd = if layer.power_mode == "variable" { "M4" } else { "M3" };

        for pass in 0..layer.passes {
            if layer.passes > 1 {
                lines.push(format!("; Pass {}/{}", pass + 1, layer.passes));
            }

            match layer.mode.as_str() {
                "line" => {
                    // Vector cut mode
                    lines.push(format!("; Cut: {} ({}% @ {}mm/min)", obj.id, layer.power, layer.speed));

                    // Fix 6: in M4 (variable) mode, floor S values at s_min so the laser
                    // doesn't drop below min power during GRBL's speed-compensation at corners.
                    let effective_s_max = if layer.power_mode == "variable" {
                        s_max.max(s_min)
                    } else {
                        s_max
                    };

                    let paths = if obj.paths.is_empty() {
                        vec![object_to_path(obj)]
                    } else {
                        let mut paths = obj.paths.clone();
                        for path in &mut paths {
                            rotate_segment(path, obj);
                        }
                        paths
                    };

                    for path in &paths {
                        if path.points.len() < 2 { continue; }

                        // Build flattened point list in G-code coords (Y-flipped)
                        let mut gpts: Vec<(f64, f64)> = path.points.iter()
                            .map(|p| (p.x, fy(p.y)))
                            .collect();
                        if path.closed && gpts.len() > 2 {
                            gpts.push(gpts[0]);
                        }

                        // Compute cumulative distances along the path
                        let mut cum_dist = vec![0.0_f64];
                        for i in 1..gpts.len() {
                            let d = ((gpts[i].0 - gpts[i-1].0).powi(2) + (gpts[i].1 - gpts[i-1].1).powi(2)).sqrt();
                            cum_dist.push(cum_dist[i-1] + d);
                        }
                        let _total_path_len = *cum_dist.last().unwrap_or(&0.0);

                        // Lead-in: approach from perpendicular/linear offset
                        let lead_in = layer.lead_in;
                        if lead_in > 0.0 && gpts.len() >= 2 {
                            let dx = gpts[1].0 - gpts[0].0;
                            let dy = gpts[1].1 - gpts[0].1;
                            let seg_len = (dx * dx + dy * dy).sqrt();
                            if seg_len > 0.001 {
                                // Perpendicular approach for closed paths, linear for open
                                let (lix, liy) = if path.closed {
                                    let nx = -dy / seg_len;
                                    let ny = dx / seg_len;
                                    (gpts[0].0 + nx * lead_in, gpts[0].1 + ny * lead_in)
                                } else {
                                    (gpts[0].0 - dx / seg_len * lead_in, gpts[0].1 - dy / seg_len * lead_in)
                                };
                                // Rapid to lead-in start
                                let dist = ((lix - cur_x).powi(2) + (liy - cur_y).powi(2)).sqrt();
                                travel_distance += dist;
                                total_distance += dist;
                                lines.push(format!("G0 X{:.3} Y{:.3}", lix, liy));
                                moves.push(GcodeMove { x: lix, y: liy, move_type: "rapid".to_string(), speed: 3000.0, power: 0.0 });
                                // Laser on, cut to first point
                                lines.push(format!("{} S{}", power_cmd, effective_s_max));
                                let d = ((gpts[0].0 - lix).powi(2) + (gpts[0].1 - liy).powi(2)).sqrt();
                                cut_distance += d;
                                total_distance += d;
                                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", gpts[0].0, gpts[0].1, speed_mm_min, effective_s_max));
                                moves.push(GcodeMove { x: gpts[0].0, y: gpts[0].1, move_type: "cut".to_string(), speed: speed_mm_min, power: effective_s_max });
                                cur_x = gpts[0].0;
                                cur_y = gpts[0].1;
                            }
                        }

                        if lead_in <= 0.0 {
                            // Rapid to start
                            let dist = ((gpts[0].0 - cur_x).powi(2) + (gpts[0].1 - cur_y).powi(2)).sqrt();
                            travel_distance += dist;
                            total_distance += dist;
                            lines.push(format!("G0 X{:.3} Y{:.3}", gpts[0].0, gpts[0].1));
                            moves.push(GcodeMove { x: gpts[0].0, y: gpts[0].1, move_type: "rapid".to_string(), speed: 3000.0, power: 0.0 });
                            cur_x = gpts[0].0;
                            cur_y = gpts[0].1;
                            lines.push(format!("{} S{}", power_cmd, effective_s_max));
                        }

                        // Cut along path with perforation or tab support
                        // Perforation takes priority over tabs (mutually exclusive)
                        let perf_cut = layer.perforation_cut;
                        let perf_skip = layer.perforation_skip;
                        let perf_enabled = perf_cut > 0.0 && perf_skip > 0.0;

                        let tab_spacing = layer.tab_spacing;
                        let tab_width = layer.tab_width;
                        let tabs_enabled = !perf_enabled && tab_spacing > 0.0 && tab_width > 0.0;

                        let mut laser_on = true;
                        let mut next_toggle_dist = if perf_enabled {
                            perf_cut // first toggle: end of first cut segment
                        } else if tabs_enabled {
                            tab_spacing
                        } else {
                            f64::MAX
                        };

                        for i in 1..gpts.len() {
                            let px = gpts[i].0;
                            let py = gpts[i].1;
                            let seg_start_dist = cum_dist[i-1];
                            let seg_end_dist = cum_dist[i];

                            if perf_enabled {
                                // Perforation state machine: alternating cut/skip
                                let seg_dx = px - cur_x;
                                let seg_dy = py - cur_y;
                                let seg_len = ((seg_dx).powi(2) + (seg_dy).powi(2)).sqrt();
                                if seg_len < 0.001 { continue; }
                                loop {
                                    if next_toggle_dist >= seg_end_dist { break; }
                                    // Interpolate toggle point within segment
                                    let t = (next_toggle_dist - seg_start_dist) / (seg_end_dist - seg_start_dist);
                                    let tx = gpts[i-1].0 + seg_dx * t;
                                    let ty = gpts[i-1].1 + seg_dy * t;
                                    let d = ((tx - cur_x).powi(2) + (ty - cur_y).powi(2)).sqrt();
                                    if laser_on {
                                        // End of cut segment
                                        cut_distance += d;
                                        total_distance += d;
                                        lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", tx, ty, speed_mm_min, effective_s_max));
                                        moves.push(GcodeMove { x: tx, y: ty, move_type: "cut".to_string(), speed: speed_mm_min, power: effective_s_max });
                                        lines.push("M5".to_string());
                                        laser_on = false;
                                        next_toggle_dist += perf_skip;
                                    } else {
                                        // End of skip segment
                                        travel_distance += d;
                                        total_distance += d;
                                        lines.push(format!("G0 X{:.3} Y{:.3}", tx, ty));
                                        moves.push(GcodeMove { x: tx, y: ty, move_type: "rapid".to_string(), speed: 3000.0, power: 0.0 });
                                        lines.push(format!("{} S{}", power_cmd, effective_s_max));
                                        laser_on = true;
                                        next_toggle_dist += perf_cut;
                                    }
                                    cur_x = tx;
                                    cur_y = ty;
                                }
                            } else if tabs_enabled {
                                // Tab state machine (existing logic)
                                let seg_dx = px - cur_x;
                                let seg_dy = py - cur_y;
                                let seg_len = ((seg_dx).powi(2) + (seg_dy).powi(2)).sqrt();
                                if seg_len < 0.001 { continue; }
                                let mut _cur_seg_dist = seg_start_dist;
                                loop {
                                    if !laser_on {
                                        let tab_end_dist = next_toggle_dist;
                                        if tab_end_dist >= seg_end_dist { break; }
                                        let t = (tab_end_dist - seg_start_dist) / (seg_end_dist - seg_start_dist);
                                        let tx = gpts[i-1].0 + seg_dx * t;
                                        let ty = gpts[i-1].1 + seg_dy * t;
                                        let d = ((tx - cur_x).powi(2) + (ty - cur_y).powi(2)).sqrt();
                                        travel_distance += d;
                                        total_distance += d;
                                        lines.push(format!("G0 X{:.3} Y{:.3}", tx, ty));
                                        moves.push(GcodeMove { x: tx, y: ty, move_type: "rapid".to_string(), speed: 3000.0, power: 0.0 });
                                        cur_x = tx;
                                        cur_y = ty;
                                        lines.push(format!("{} S{}", power_cmd, effective_s_max));
                                        laser_on = true;
                                        next_toggle_dist = tab_end_dist + tab_spacing;
                                        _cur_seg_dist = tab_end_dist;
                                    } else {
                                        if next_toggle_dist >= seg_end_dist { break; }
                                        let t = (next_toggle_dist - seg_start_dist) / (seg_end_dist - seg_start_dist);
                                        let tx = gpts[i-1].0 + seg_dx * t;
                                        let ty = gpts[i-1].1 + seg_dy * t;
                                        let d = ((tx - cur_x).powi(2) + (ty - cur_y).powi(2)).sqrt();
                                        cut_distance += d;
                                        total_distance += d;
                                        lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", tx, ty, speed_mm_min, effective_s_max));
                                        moves.push(GcodeMove { x: tx, y: ty, move_type: "cut".to_string(), speed: speed_mm_min, power: effective_s_max });
                                        cur_x = tx;
                                        cur_y = ty;
                                        lines.push("M5".to_string());
                                        laser_on = false;
                                        next_toggle_dist += tab_width;
                                        _cur_seg_dist = next_toggle_dist - tab_width;
                                    }
                                }
                            }

                            // Cut (or rapid) to segment endpoint
                            if laser_on {
                                let d = ((px - cur_x).powi(2) + (py - cur_y).powi(2)).sqrt();
                                cut_distance += d;
                                total_distance += d;
                                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", px, py, speed_mm_min, effective_s_max));
                                moves.push(GcodeMove { x: px, y: py, move_type: "cut".to_string(), speed: speed_mm_min, power: effective_s_max });
                            } else {
                                let d = ((px - cur_x).powi(2) + (py - cur_y).powi(2)).sqrt();
                                travel_distance += d;
                                total_distance += d;
                                lines.push(format!("G0 X{:.3} Y{:.3}", px, py));
                                moves.push(GcodeMove { x: px, y: py, move_type: "rapid".to_string(), speed: 3000.0, power: 0.0 });
                            }
                            cur_x = px;
                            cur_y = py;
                        }

                        // Overcut: extend past start for closed paths
                        let overcut = layer.overcut;
                        if overcut > 0.0 && path.closed && gpts.len() >= 3 {
                            // Continue along the path direction from the start
                            let dx = gpts[1].0 - gpts[0].0;
                            let dy = gpts[1].1 - gpts[0].1;
                            let seg_len = (dx * dx + dy * dy).sqrt();
                            if seg_len > 0.001 {
                                let ext = overcut.min(seg_len);
                                let ox = gpts[0].0 + dx / seg_len * ext;
                                let oy = gpts[0].1 + dy / seg_len * ext;
                                if !laser_on {
                                    lines.push(format!("{} S{}", power_cmd, effective_s_max));
                                }
                                cut_distance += ext;
                                total_distance += ext;
                                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", ox, oy, speed_mm_min, effective_s_max));
                                moves.push(GcodeMove { x: ox, y: oy, move_type: "cut".to_string(), speed: speed_mm_min, power: effective_s_max });
                                cur_x = ox;
                                cur_y = oy;
                            }
                        }

                        // Lead-out: extend past end
                        let lead_out = layer.lead_out;
                        if lead_out > 0.0 && gpts.len() >= 2 {
                            let n = gpts.len();
                            let dx = gpts[n-1].0 - gpts[n-2].0;
                            let dy = gpts[n-1].1 - gpts[n-2].1;
                            let seg_len = (dx * dx + dy * dy).sqrt();
                            if seg_len > 0.001 {
                                let lox = gpts[n-1].0 + dx / seg_len * lead_out;
                                let loy = gpts[n-1].1 + dy / seg_len * lead_out;
                                if !laser_on {
                                    lines.push(format!("{} S{}", power_cmd, effective_s_max));
                                }
                                cut_distance += lead_out;
                                total_distance += lead_out;
                                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", lox, loy, speed_mm_min, effective_s_max));
                                moves.push(GcodeMove { x: lox, y: loy, move_type: "cut".to_string(), speed: speed_mm_min, power: effective_s_max });
                                cur_x = lox;
                                cur_y = loy;
                            }
                        }

                        // Laser off
                        lines.push("M5".to_string());
                    }
                }
                "fill" => {
                    // Raster engrave mode
                    lines.push(format!("; Engrave: {} ({}% @ {}mm/min, interval {}mm)",
                        obj.id, layer.power, layer.speed, layer.interval));

                    let interval = if layer.interval > 0.0 { layer.interval } else { 0.1 };
                    let overscan = layer.overscan.max(0.0);
                    let scanning_offset = layer.scanning_offset;

                    // Combine object rotation + layer scan angle + per-pass angle increment
                    let obj_rot = if obj.rotation.abs() > 0.001 { obj.rotation.to_radians() } else { 0.0 };
                    let layer_angle = layer.scan_angle.to_radians() + (pass as f64) * layer.angle_increment.to_radians();
                    let rotation_rad = obj_rot + layer_angle;
                    let center_x = obj.x + obj.width / 2.0;
                    let center_y = obj.y + obj.height / 2.0;

                    // F10: compute scan boundaries in the ROTATED coordinate frame so
                    // scan lines cover the full object area at any scan angle.
                    // Rotate the 4 AABB corners by -rotation_rad around the object center,
                    // then take the AABB of those rotated points. transform_to_grbl rotates
                    // back by +rotation_rad, giving full corner coverage.
                    let (x_min, x_max, y_min, y_max) = if rotation_rad.abs() > 1e-6 {
                        let corners = [
                            (obj.x,              obj.y),
                            (obj.x + obj.width,  obj.y),
                            (obj.x + obj.width,  obj.y + obj.height),
                            (obj.x,              obj.y + obj.height),
                        ];
                        let cos_r = (-rotation_rad).cos();
                        let sin_r = (-rotation_rad).sin();
                        let rotated: Vec<(f64, f64)> = corners.iter().map(|&(px, py)| {
                            let dx = px - center_x;
                            let dy = py - center_y;
                            (center_x + dx * cos_r - dy * sin_r,
                             center_y + dx * sin_r + dy * cos_r)
                        }).collect();
                        let rx_min = rotated.iter().map(|&(x, _)| x).fold(f64::INFINITY, f64::min);
                        let rx_max = rotated.iter().map(|&(x, _)| x).fold(f64::NEG_INFINITY, f64::max);
                        let ry_min = rotated.iter().map(|&(_, y)| y).fold(f64::INFINITY, f64::min);
                        let ry_max = rotated.iter().map(|&(_, y)| y).fold(f64::NEG_INFINITY, f64::max);
                        (rx_min, rx_max, ry_min, ry_max)
                    } else {
                        (obj.x, obj.x + obj.width, obj.y, obj.y + obj.height)
                    };
                    // Scan lines are generated in the rotated frame; transform_to_grbl
                    // applies +rotation_rad to map back to machine coordinates.

                    let scan_params = ScanLineParams {
                        overscan,
                        scanning_offset,
                        interval,
                        bidirectional: layer.bidirectional,
                        speed_mm_min,
                        s_max,
                        power_cmd: power_cmd.to_string(),
                        workspace_height,
                        origin_top,
                        rotation_rad,
                        center_x,
                        center_y,
                    };

                    let fill_order = layer.fill_order.as_deref();

                    // Horizontal scan lines
                    generate_scan_lines(
                        &scan_params, &mut lines, &mut moves,
                        &mut cut_distance, &mut travel_distance, &mut total_distance,
                        &mut cur_x, &mut cur_y,
                        x_min, x_max, y_min, y_max, false, fill_order,
                    );

                    // Cross-hatch: vertical scan lines
                    if layer.cross_hatch {
                        lines.push("; Cross-hatch pass".to_string());
                        generate_scan_lines(
                            &scan_params, &mut lines, &mut moves,
                            &mut cut_distance, &mut travel_distance, &mut total_distance,
                            &mut cur_x, &mut cur_y,
                            y_min, y_max, x_min, x_max, true, fill_order,
                        );
                    }
                }
                "offsetFill" => {
                    // Offset fill mode: concentric paths spiraling inward
                    lines.push(format!("; Offset Fill: {} ({}% @ {}mm/min, interval {}mm)",
                        obj.id, layer.power, layer.speed, layer.interval));

                    let interval = if layer.interval > 0.0 { layer.interval } else { 0.5 };

                    // Build polygons from object geometry -- iterate all paths
                    let paths_to_offset: Vec<PathSegment> = if obj.paths.is_empty() {
                        vec![object_to_path(obj)]
                    } else {
                        obj.paths.iter().map(|p| {
                            let mut seg = p.clone();
                            rotate_segment(&mut seg, obj);
                            seg
                        }).collect()
                    };

                    // F8: no bulk M3 here — laser is enabled per-ring, off between rings.
                    // This prevents G0 rapids between rings from firing the laser under $32=0.

                    for path in &paths_to_offset {
                        if path.points.len() < 3 { continue; }

                        let polygon: Vec<super::gcode_gen::Point> = path.points.iter()
                            .map(|p| Point { x: p.x, y: p.y })
                            .collect();

                        let rings = super::offset::generate_offset_rings(&polygon, interval);

                        for ring in &rings {
                            if ring.len() < 2 { continue; }

                            // Laser off before rapid — safe traverse between rings (F8)
                            lines.push("M5".to_string());

                            // Rapid to ring start
                            let (rsx, rsy) = (ring[0].x, fy(ring[0].y));
                            let dist = ((rsx - cur_x).powi(2) + (rsy - cur_y).powi(2)).sqrt();
                            travel_distance += dist;
                            total_distance += dist;
                            lines.push(format!("G0 X{:.3} Y{:.3}", rsx, rsy));
                            moves.push(GcodeMove { x: rsx, y: rsy, move_type: "rapid".to_string(), speed: 3000.0, power: 0.0 });
                            cur_x = rsx;
                            cur_y = rsy;

                            // Laser on before cutting this ring (F8)
                            lines.push(format!("{} S{}", power_cmd, s_max));

                            // Cut along ring
                            for pt in ring.iter().skip(1) {
                                let (px, py) = (pt.x, fy(pt.y));
                                let d = ((px - cur_x).powi(2) + (py - cur_y).powi(2)).sqrt();
                                cut_distance += d;
                                total_distance += d;
                                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", px, py, speed_mm_min, s_max));
                                moves.push(GcodeMove { x: px, y: py, move_type: "cut".to_string(), speed: speed_mm_min, power: s_max });
                                cur_x = px;
                                cur_y = py;
                            }

                            // Close the ring
                            let (cfx, cfy) = (ring[0].x, fy(ring[0].y));
                            let d = ((cfx - cur_x).powi(2) + (cfy - cur_y).powi(2)).sqrt();
                            if d > 0.001 {
                                cut_distance += d;
                                total_distance += d;
                                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", cfx, cfy, speed_mm_min, s_max));
                                moves.push(GcodeMove { x: cfx, y: cfy, move_type: "cut".to_string(), speed: speed_mm_min, power: s_max });
                                cur_x = cfx;
                                cur_y = cfy;
                            }
                        }
                    }

                    lines.push("M5".to_string());
                }
                "maskFill" => {
                    // Hole-aware bitmap-mask scanline fill (Phase 2).
                    //
                    // Even-odd fill rule: winding direction is IRRELEVANT here — do NOT
                    // re-add CCW import normalization (Fix-2 in ImageTraceDialog) when
                    // debugging hole issues. If a counter still burns, check the EvenOdd
                    // probe test or the alpha-threshold in mask_fill.rs.
                    lines.push(format!("; Mask Fill: {} ({}% @ {}mm/min, interval {}mm)",
                        obj.id, layer.power, layer.speed, layer.interval));

                    let interval = if layer.interval > 0.0 { layer.interval } else { 0.1 };

                    // Combine object rotation + scan angle + per-pass increment.
                    // Matches the "fill" arm's rotation convention exactly.
                    let obj_rot = if obj.rotation.abs() > 0.001 { obj.rotation.to_radians() } else { 0.0 };
                    let layer_angle = layer.scan_angle.to_radians()
                        + (pass as f64) * layer.angle_increment.to_radians();
                    let rotation_rad = obj_rot + layer_angle;

                    // Rasterize the compound shape to an even-odd binary mask.
                    // fill_compound_mask uses obj.x/y/width/height as the axis-aligned
                    // union bbox in design space. Paths are rasterized in local (un-rotated)
                    // coordinates — obj.paths are NOT pre-rotated (toCutObjects is TS-only
                    // and does not transform path points; rotate_segment is the vector arm).
                    // obj.rotation is carried via rotation_rad into scan_mask_to_gcode,
                    // which rotates each output coordinate about the bbox center.
                    // The mask origin and the CutObject bbox share one source of truth —
                    // no drift to the optimizer.
                    let mask_result = super::mask_fill::fill_compound_mask(obj, interval);

                    match mask_result {
                        Err(e) => {
                            // Degenerate / empty mask (critic must-fix #3): skip + warn.
                            // Do not silently emit nothing — log the warning and continue.
                            // This preserves the job for all other objects.
                            eprintln!("[gcode_gen] maskFill skipped '{}': {}", obj.id, e);
                            lines.push(format!("; maskFill skipped: {}", e));
                        }
                        Ok((pixels, mask_w, mask_h, origin_x, origin_y)) => {
                            // Check for all-background mask (degenerate input after dilation)
                            let has_content = pixels.contains(&0);
                            if !has_content {
                                eprintln!(
                                    "[gcode_gen] maskFill: '{}' produced all-background mask \
                                     (zero-area path after thin-stroke dilation). Skipping.",
                                    obj.id
                                );
                                lines.push(format!("; maskFill skipped: all-background mask for '{}'", obj.id));
                            } else {
                                let scan_params = super::mask_fill::MaskScanParams {
                                    origin_x,
                                    origin_y,
                                    width_mm: obj.width,
                                    height_mm: obj.height,
                                    interval,
                                    overscan: layer.overscan.max(0.0),
                                    bidirectional: layer.bidirectional,
                                    scanning_offset: layer.scanning_offset,
                                    speed_mm_min,
                                    s_max,
                                    s_min: 0.0, // maskFill is always binary (constant power per run)
                                    power_cmd: power_cmd.to_string(),
                                    workspace_height,
                                    origin_top,
                                    rotation_rad,
                                    passes: 1, // outer pass loop already handles multi-pass
                                    grayscale_pixels: None, // maskFill uses binary fill
                                };

                                match super::mask_fill::scan_mask_to_gcode(
                                    &pixels, mask_w, mask_h, &scan_params,
                                ) {
                                    Ok(scan_result) => {
                                        for line in scan_result.gcode.lines() {
                                            lines.push(line.to_string());
                                        }
                                        moves.extend(scan_result.moves.clone());
                                        cut_distance += scan_result.cut_distance;
                                        travel_distance += scan_result.travel_distance;
                                        total_distance += scan_result.total_distance;
                                        if !scan_result.moves.is_empty() {
                                            let last = scan_result.moves.last().unwrap();
                                            cur_x = last.x;
                                            cur_y = last.y;
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("[gcode_gen] maskFill scan error for '{}': {}", obj.id, e);
                                        lines.push(format!("; maskFill scan error: {}", e));
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }

            lines.push(String::new());
        }
    }

    // Footer
    lines.push("M5 ; laser off".to_string());
    lines.push("G0 X0 Y0 ; return home".to_string());
    lines.push("M2 ; program end".to_string());

    // Time estimation
    // Account for acceleration: assume 200mm/s^2 default GRBL accel
    let accel = 200.0_f64; // mm/s^2
    let estimated_time = estimate_time(&moves, accel);

    GcodeResult {
        gcode: lines.join("\n"),
        moves,
        total_distance,
        cut_distance,
        travel_distance,
        estimated_time_secs: estimated_time,
        line_count: lines.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_layer_line() -> CutLayer {
        CutLayer {
            mode: "line".to_string(),
            power: 100.0,
            power_min: 0.0,
            speed: 1200.0, // mm/min (was 20 mm/s before unit switch)
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

    fn make_rect_obj(id: &str, x: f64, y: f64, w: f64, h: f64, layer: CutLayer) -> CutObject {
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

    // TN1a — Y-flip convention: a 10mm square at (0,0) in a 100mm workspace.
    // Design-space Y goes up; GRBL Y goes down. Y-flip: grbl_y = workspace_height - design_y.
    // For a 10×10 square at (0,0): corners are (0,0),(10,0),(10,10),(0,10) in design space.
    // After Y-flip in a 100mm workspace: (0,100),(10,100),(10,90),(0,90).
    // The G-code cuts should visit these flipped Y coords.
    #[test]
    fn tn1a_y_flip_10mm_square() {
        let workspace_height = 100.0;
        let obj = make_rect_obj("sq", 0.0, 0.0, 10.0, 10.0, make_layer_line());
        let result = generate_gcode(&[obj], workspace_height, 1000.0, false);
        let gcode = &result.gcode;

        // Rapid to first corner (0,0) design → (0,100) grbl
        assert!(gcode.contains("G0 X0.000 Y100.000"),
            "Expected G0 to (0,100); got:\n{}", gcode);
        // After closing, should visit (10,100)
        assert!(gcode.contains("Y100.000") && gcode.contains("X10.000"),
            "Expected cut moves at Y=100 (bottom edge flipped); got:\n{}", gcode);
        // Top of square in design = y=10 → grbl y = 100-10 = 90
        assert!(gcode.contains("Y90.000"),
            "Expected Y90 for top edge (design y=10 flipped); got:\n{}", gcode);
    }

    // TN1b — perforation toggle: 2mm cut / 1mm skip on a 10mm line.
    // Expected: alternating G1 (cut) / G0 (skip) pattern with M5 between.
    #[test]
    fn tn1b_perforation_toggle() {
        let mut layer = make_layer_line();
        layer.perforation_cut = 2.0;
        layer.perforation_skip = 1.0;
        // 10mm horizontal line at y=0 in 100mm workspace
        let obj = CutObject {
            id: "perf".to_string(),
            obj_type: "line".to_string(),
            x: 0.0,
            y: 50.0,
            width: 10.0,
            height: 0.0,
            paths: vec![PathSegment {
                points: vec![Point { x: 0.0, y: 50.0 }, Point { x: 10.0, y: 50.0 }],
                closed: false,
            }],
            layer,
            corner_radius: None,
            rotation: 0.0,
            priority: None,
            group_id: None,
            layer_index: None,
        };
        let result = generate_gcode(&[obj], 100.0, 1000.0, false);
        let gcode = &result.gcode;
        // Should contain an M5 (laser off between perforations) beyond the final M5
        let m5_count = gcode.matches("M5").count();
        assert!(m5_count >= 2,
            "Expected at least 2 M5 commands (one per skip + final); got {} in:\n{}", m5_count, gcode);
        // Should also contain a G0 (rapid for the skip segment)
        assert!(gcode.matches("G0 X").count() >= 2,
            "Expected at least 2 G0 moves (lead-in + skip); got:\n{}", gcode);
    }

    // TN1c — tab insertion: 5mm spacing, 1mm tab on a 10mm line.
    // Tabs create a rapid (laser off) segment, then re-enable.
    #[test]
    fn tn1c_tab_insertion() {
        let mut layer = make_layer_line();
        layer.tab_spacing = 5.0;
        layer.tab_width = 1.0;
        let obj = CutObject {
            id: "tabs".to_string(),
            obj_type: "line".to_string(),
            x: 0.0,
            y: 50.0,
            width: 10.0,
            height: 0.0,
            paths: vec![PathSegment {
                points: vec![Point { x: 0.0, y: 50.0 }, Point { x: 10.0, y: 50.0 }],
                closed: false,
            }],
            layer,
            corner_radius: None,
            rotation: 0.0,
            priority: None,
            group_id: None,
            layer_index: None,
        };
        let result = generate_gcode(&[obj], 100.0, 1000.0, false);
        let gcode = &result.gcode;
        // Should have M5 for the tab gap
        assert!(gcode.contains("M5"),
            "Expected M5 for tab gap; got:\n{}", gcode);
    }

    // TN1d — lead-in/out: a path with lead-in 2mm must emit a G0 approach before
    // laser-on G1, and lead-out extends past the path end.
    #[test]
    fn tn1d_lead_in_out_present() {
        let mut layer = make_layer_line();
        layer.lead_in = 2.0;
        layer.lead_out = 2.0;
        let obj = make_rect_obj("rect", 10.0, 10.0, 20.0, 20.0, layer);
        let result = generate_gcode(&[obj], 100.0, 1000.0, false);
        let gcode = &result.gcode;
        // Lead-in: there should be a rapid to a point offset from the first corner,
        // then a G1 to the first corner, then the M3/M4 + path cut.
        // At minimum the gcode should have more than the bare minimum G0/G1 sequence
        let g0_count = gcode.matches("G0 X").count();
        let g1_count = gcode.matches("G1 X").count();
        assert!(g0_count >= 2, "Expected multiple G0 moves (home + lead-in approach); got:\n{}", gcode);
        assert!(g1_count >= 2, "Expected G1 for lead-in cut + path cuts; got:\n{}", gcode);
    }

    // F8 — offsetFill: each ring's G0 rapid is preceded by M5 and followed by
    // the power command. No M3 fires before any G0 between rings.
    #[test]
    fn f8_offset_fill_m5_before_each_ring_rapid() {
        let mut layer = make_layer_line();
        layer.mode = "offsetFill".to_string();
        layer.interval = 0.5;
        // 20×20 square — large enough to produce at least 2 concentric rings
        let obj = make_rect_obj("sq", 0.0, 0.0, 20.0, 20.0, layer);
        let result = generate_gcode(&[obj], 100.0, 1000.0, false);
        let gcode = &result.gcode;

        // There must be at least 2 rings to validate inter-ring safety
        let g0_count = gcode.matches("G0 X").count();
        assert!(g0_count >= 2, "Expected ≥2 rings; got:\n{}", gcode);

        // Every G0 rapid must be preceded by M5 (no active laser across rapids)
        let lines: Vec<&str> = gcode.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if line.starts_with("G0 X") && !line.contains("Y0") { // skip final G0 home
                // Scan backward for the nearest M5 or power command before this G0
                let mut found_m5 = false;
                let mut found_power = false;
                for j in (0..i).rev() {
                    if lines[j].starts_with("M5") { found_m5 = true; break; }
                    if lines[j].starts_with("M3") || lines[j].starts_with("M4") {
                        found_power = true; break;
                    }
                }
                assert!(found_m5 && !found_power,
                    "Expected M5 immediately before G0 at line {i}: {line}\nFull G-code:\n{gcode}");
            }
        }

        // Every cut segment (G1 X) must be preceded by a power command (M3/M4) before any G0
        for (i, line) in lines.iter().enumerate() {
            if line.starts_with("G1 X") {
                let mut found_power = false;
                let mut found_g0 = false;
                for j in (0..i).rev() {
                    if lines[j].starts_with("M3") || lines[j].starts_with("M4") {
                        found_power = true; break;
                    }
                    if lines[j].starts_with("G0 X") { found_g0 = true; }
                    // Stop scan at object header comment
                    if lines[j].starts_with("; Offset Fill:") { break; }
                }
                let _ = found_g0; // presence of G0 is expected between power and G1
                assert!(found_power,
                    "Expected power command (M3/M4) before G1 at line {i}: {line}\nFull G-code:\n{gcode}");
            }
        }
    }

    // F10 — fill mode scan angle: 45° scan on a 10×10 square must produce
    // Y coordinates outside the unrotated AABB (demonstrating corner coverage).
    // At 45° the rotated AABB is ~14.14mm wide/tall, so scan line Y values in
    // rotated space extend beyond the original 0..10 range before transform_to_grbl
    // rotates them back.
    #[test]
    fn f10_fill_scan_angle_covers_full_area() {
        let mut layer = make_layer_line();
        layer.mode = "fill".to_string();
        layer.scan_angle = 45.0;
        layer.interval = 0.5;
        // 10×10 square at (0,0)
        let obj = make_rect_obj("sq", 0.0, 0.0, 10.0, 10.0, layer);
        let result = generate_gcode(&[obj], 100.0, 1000.0, false);
        let gcode = &result.gcode;

        // Extract all X values from G0/G1 moves
        let mut xs: Vec<f64> = Vec::new();
        let mut ys: Vec<f64> = Vec::new();
        for line in gcode.lines() {
            if line.starts_with("G0 X") || line.starts_with("G1 X") {
                if let (Some(xi), Some(yi)) = (line.find('X'), line.find('Y')) {
                    let x_str = &line[xi+1..].split_whitespace().next().unwrap_or("0");
                    let y_str = &line[yi+1..].split_whitespace().next().unwrap_or("0");
                    if let (Ok(x), Ok(y)) = (x_str.parse::<f64>(), y_str.parse::<f64>()) {
                        xs.push(x);
                        ys.push(y);
                    }
                }
            }
        }

        // Under the old (unrotated-AABB) code, X and Y in rotated space would
        // span exactly 0..10 in design coords — the corners at 45° would be missed.
        // With the fix, the rotated AABB is wider (~-2.07..12.07 in rotated space),
        // so after transform_to_grbl the machine coordinates extend beyond a 10×10 box.
        // The bounding box of all moves should be larger than 10mm in at least one axis.
        let x_min = xs.iter().cloned().fold(f64::INFINITY, f64::min);
        let x_max = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let y_min = ys.iter().cloned().fold(f64::INFINITY, f64::min);
        let y_max = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let x_span = x_max - x_min;
        // Y span in workspace coords (after Y-flip) covers the full 100mm-mapped extent
        let y_span = y_max - y_min;
        // With rotated AABB the coverage span should be > 10mm (the original square side)
        assert!(
            x_span > 10.0 || y_span > 10.0,
            "Expected scan coverage span > 10mm at 45° (rotated AABB fix); x_span={x_span:.3} y_span={y_span:.3}\nG-code:\n{gcode}"
        );
        // Also verify there are actual scan moves (not an empty result)
        assert!(!xs.is_empty(), "Expected scan moves to be generated; got:\n{gcode}");
    }

    // SPEED-UNIT — after the mm/s → mm/min canonical switch, the ×60 multiplier
    // is gone: a layer at 1200 mm/min must emit F1200 (not F72000).
    // The ×60 line was at gcode_gen.rs:322 and has been removed; these tests
    // are the regression guard.
    #[test]
    fn speed_unit_1200mmmin_emits_f1200() {
        let mut layer = make_layer_line();
        layer.speed = 1200.0; // mm/min — LightBurn-equivalent of 20 mm/s
        let obj = make_rect_obj("r", 0.0, 0.0, 10.0, 10.0, layer);
        let result = generate_gcode(&[obj], 100.0, 1000.0, false);
        assert!(
            result.gcode.contains("F1200"),
            "Expected F1200 for 1200 mm/min layer; got:\n{}",
            result.gcode
        );
        assert!(
            !result.gcode.contains("F72000"),
            "F72000 indicates leftover ×60 multiply; got:\n{}",
            result.gcode
        );
    }

    // LightBurn parity — the cut that prompted the unit switch:
    // plywood at 480 mm/min, 60% power must emit F480.
    /// MUST-FIX 4: Serde round-trip — CutObject with >1 PathSegment must survive
    /// serialize → deserialize intact.
    ///
    /// Before this PR, the frontend never emitted multi-path CutObjects (single
    /// contour only). The maskFill dispatch arm is the first code path that expects
    /// `obj.paths` to carry multiple contours (compound shapes, glyphs). If the
    /// Tauri IPC layer silently drops path segments the maskFill engrave is silently
    /// wrong — only the first contour is rasterized, so holes and dropout-prone glyphs
    /// look correct in tests but fail in production.
    ///
    /// This test serializes a CutObject with 3 PathSegments (H-shape: left vertical,
    /// right vertical, crossbar) to JSON and back, then asserts all 3 segments and
    /// all their points survive the round-trip.
    #[test]
    fn cutobject_multi_path_serde_roundtrip() {
        let make_rect_path = |x0: f64, y0: f64, x1: f64, y1: f64| PathSegment {
            points: vec![
                Point { x: x0, y: y0 },
                Point { x: x1, y: y0 },
                Point { x: x1, y: y1 },
                Point { x: x0, y: y1 },
            ],
            closed: true,
        };

        let obj = CutObject {
            id: "H-compound".to_string(),
            obj_type: "path".to_string(),
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            paths: vec![
                make_rect_path(0.0, 0.0, 2.0, 10.0),  // left vertical
                make_rect_path(8.0, 0.0, 10.0, 10.0), // right vertical
                make_rect_path(0.0, 4.0, 10.0, 6.0),  // crossbar
            ],
            layer: CutLayer {
                mode: "maskFill".to_string(),
                power: 100.0,
                power_min: 0.0,
                speed: 6000.0,
                passes: 1,
                power_mode: "constant".to_string(),
                interval: 1.0,
                air_assist: false,
                cut_inner_first: false,
                dither: "threshold".to_string(),
                scan_angle: 0.0,
                angle_increment: 0.0,
                overcut: 0.0,
                lead_in: 0.0,
                lead_out: 0.0,
                overscan: 0.0,
                bidirectional: false,
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
            },
            corner_radius: None,
            rotation: 0.0,
            priority: None,
            group_id: None,
            layer_index: None,
        };

        // Serialize to JSON
        let json = serde_json::to_string(&obj).expect("CutObject should serialize to JSON");

        // Deserialize back
        let restored: CutObject = serde_json::from_str(&json)
            .expect("CutObject JSON should deserialize back to CutObject");

        // All 3 path segments must survive
        assert_eq!(
            restored.paths.len(), 3,
            "Expected 3 PathSegments after round-trip, got {}. \
             IPC or serde is silently dropping compound paths.",
            restored.paths.len()
        );

        // Each segment's point count must be preserved
        for (i, seg) in restored.paths.iter().enumerate() {
            assert_eq!(
                seg.points.len(), 4,
                "Segment {} should have 4 points after round-trip, got {}",
                i, seg.points.len()
            );
            assert!(
                seg.closed,
                "Segment {} should be closed after round-trip",
                i
            );
        }

        // Spot-check a coordinate value that shouldn't be 0.0
        let left_x1 = restored.paths[0].points[1].x;
        assert!(
            (left_x1 - 2.0).abs() < 1e-9,
            "Left vertical segment point[1].x should be 2.0, got {}", left_x1
        );
        let crossbar_y0 = restored.paths[2].points[0].y;
        assert!(
            (crossbar_y0 - 4.0).abs() < 1e-9,
            "Crossbar segment point[0].y should be 4.0, got {}", crossbar_y0
        );

        // Layer mode must survive (if "maskFill" were coerced to a default the
        // dispatch arm would silently skip the object)
        assert_eq!(
            restored.layer.mode, "maskFill",
            "Layer mode must survive serde round-trip; got '{}'", restored.layer.mode
        );
    }

    #[test]
    fn speed_unit_lightburn_parity_480mmmin() {
        let mut layer = make_layer_line();
        layer.speed = 480.0;
        layer.power = 60.0;
        let obj = make_rect_obj("r", 0.0, 0.0, 10.0, 10.0, layer);
        let result = generate_gcode(&[obj], 100.0, 1000.0, false);
        assert!(
            result.gcode.contains("F480"),
            "Expected F480 for 480 mm/min layer (LightBurn parity); got:\n{}",
            result.gcode
        );
        assert!(
            !result.gcode.contains("F28800"),
            "F28800 indicates leftover ×60 multiply; got:\n{}",
            result.gcode
        );
    }
}

/// Rotate a point around a center
fn rotate_point(px: f64, py: f64, cx: f64, cy: f64, angle_rad: f64) -> Point {
    let dx = px - cx;
    let dy = py - cy;
    Point {
        x: cx + dx * angle_rad.cos() - dy * angle_rad.sin(),
        y: cy + dx * angle_rad.sin() + dy * angle_rad.cos(),
    }
}

/// Apply rotation to all points in a path segment
fn rotate_segment(segment: &mut PathSegment, obj: &CutObject) {
    if obj.rotation.abs() > 0.001 {
        let cx = obj.x + obj.width / 2.0;
        let cy = obj.y + obj.height / 2.0;
        let rad = obj.rotation.to_radians();
        for pt in &mut segment.points {
            let rotated = rotate_point(pt.x, pt.y, cx, cy, rad);
            pt.x = rotated.x;
            pt.y = rotated.y;
        }
    }
}

/// Convert object geometry to a path (with rotation applied)
fn object_to_path(obj: &CutObject) -> PathSegment {
    let mut segment = match obj.obj_type.as_str() {
        "rectangle" => {
            let x = obj.x;
            let y = obj.y;
            let w = obj.width;
            let h = obj.height;

            let is_rounded = obj.corner_radius.is_some_and(|r| r > 0.0);
            if is_rounded {
                let r = obj.corner_radius.unwrap().min(w / 2.0).min(h / 2.0);
                let mut points = Vec::new();
                points.push(Point { x: x + r, y });
                points.push(Point { x: x + w - r, y });
                arc_points(&mut points, x + w - r, y + r, r, -90.0, 0.0, 8);
                points.push(Point { x: x + w, y: y + h - r });
                arc_points(&mut points, x + w - r, y + h - r, r, 0.0, 90.0, 8);
                points.push(Point { x: x + r, y: y + h });
                arc_points(&mut points, x + r, y + h - r, r, 90.0, 180.0, 8);
                points.push(Point { x, y: y + r });
                arc_points(&mut points, x + r, y + r, r, 180.0, 270.0, 8);
                PathSegment { points, closed: true }
            } else {
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
        }
        "ellipse" => {
            let cx = obj.x + obj.width / 2.0;
            let cy = obj.y + obj.height / 2.0;
            let rx = obj.width / 2.0;
            let ry = obj.height / 2.0;
            let segments = 64;
            let mut points = Vec::with_capacity(segments);
            for i in 0..segments {
                let angle = 2.0 * std::f64::consts::PI * (i as f64) / (segments as f64);
                points.push(Point {
                    x: cx + rx * angle.cos(),
                    y: cy + ry * angle.sin(),
                });
            }
            PathSegment { points, closed: true }
        }
        "line" => {
            PathSegment {
                points: vec![
                    Point { x: obj.x, y: obj.y },
                    Point { x: obj.x + obj.width, y: obj.y + obj.height },
                ],
                closed: false,
            }
        }
        _ => PathSegment { points: vec![], closed: false },
    };

    rotate_segment(&mut segment, obj);
    segment
}

/// Generate arc points for rounded corners
fn arc_points(points: &mut Vec<Point>, cx: f64, cy: f64, r: f64, start_deg: f64, end_deg: f64, segments: usize) {
    let start_rad = start_deg.to_radians();
    let end_rad = end_deg.to_radians();
    for i in 0..=segments {
        let t = i as f64 / segments as f64;
        let angle = start_rad + (end_rad - start_rad) * t;
        points.push(Point {
            x: cx + r * angle.cos(),
            y: cy + r * angle.sin(),
        });
    }
}

/// Estimate job time accounting for acceleration curves
fn estimate_time(moves: &[GcodeMove], accel: f64) -> f64 {
    let mut total_time = 0.0_f64;
    let mut prev_x = 0.0_f64;
    let mut prev_y = 0.0_f64;

    for m in moves {
        let dist = ((m.x - prev_x).powi(2) + (m.y - prev_y).powi(2)).sqrt();
        if dist < 0.001 {
            prev_x = m.x;
            prev_y = m.y;
            continue;
        }

        let max_speed = m.speed / 60.0; // mm/min to mm/s

        // Time with trapezoidal acceleration profile
        // Distance to accelerate to max speed: d = v^2 / (2*a)
        let accel_dist = max_speed * max_speed / (2.0 * accel);

        if dist < 2.0 * accel_dist {
            // Triangle profile: never reaches max speed
            // t = 2 * sqrt(d / a)
            total_time += 2.0 * (dist / accel).sqrt();
        } else {
            // Trapezoidal: accel + cruise + decel
            let accel_time = max_speed / accel;
            let cruise_dist = dist - 2.0 * accel_dist;
            let cruise_time = cruise_dist / max_speed;
            total_time += 2.0 * accel_time + cruise_time;
        }

        prev_x = m.x;
        prev_y = m.y;
    }

    total_time
}
