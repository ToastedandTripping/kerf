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
    pub speed: f64,          // mm/s
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
    (rx, params.workspace_height - ry)
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
pub fn generate_gcode(objects: &[CutObject], workspace_height: f64, s_value_max: f64) -> GcodeResult {
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
        let speed_mm_min = layer.speed * 60.0; // Convert mm/s to mm/min
        let s_max = (layer.power / 100.0 * s_value_max).round();

        // Power mode command
        let power_cmd = if layer.power_mode == "variable" { "M4" } else { "M3" };

        for pass in 0..layer.passes {
            if layer.passes > 1 {
                lines.push(format!("; Pass {}/{}", pass + 1, layer.passes));
            }

            match layer.mode.as_str() {
                "line" => {
                    // Vector cut mode
                    lines.push(format!("; Cut: {} ({}% @ {}mm/s)", obj.id, layer.power, layer.speed));

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
                            .map(|p| (p.x, workspace_height - p.y))
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
                                lines.push(format!("{} S{}", power_cmd, s_max));
                                let d = ((gpts[0].0 - lix).powi(2) + (gpts[0].1 - liy).powi(2)).sqrt();
                                cut_distance += d;
                                total_distance += d;
                                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", gpts[0].0, gpts[0].1, speed_mm_min, s_max));
                                moves.push(GcodeMove { x: gpts[0].0, y: gpts[0].1, move_type: "cut".to_string(), speed: speed_mm_min, power: s_max });
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
                            lines.push(format!("{} S{}", power_cmd, s_max));
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
                                        lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", tx, ty, speed_mm_min, s_max));
                                        moves.push(GcodeMove { x: tx, y: ty, move_type: "cut".to_string(), speed: speed_mm_min, power: s_max });
                                        lines.push("M5".to_string());
                                        laser_on = false;
                                        next_toggle_dist += perf_skip;
                                    } else {
                                        // End of skip segment
                                        travel_distance += d;
                                        total_distance += d;
                                        lines.push(format!("G0 X{:.3} Y{:.3}", tx, ty));
                                        moves.push(GcodeMove { x: tx, y: ty, move_type: "rapid".to_string(), speed: 3000.0, power: 0.0 });
                                        lines.push(format!("{} S{}", power_cmd, s_max));
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
                                        lines.push(format!("{} S{}", power_cmd, s_max));
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
                                        lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", tx, ty, speed_mm_min, s_max));
                                        moves.push(GcodeMove { x: tx, y: ty, move_type: "cut".to_string(), speed: speed_mm_min, power: s_max });
                                        cur_x = tx;
                                        cur_y = ty;
                                        lines.push("M5".to_string());
                                        laser_on = false;
                                        next_toggle_dist = next_toggle_dist + tab_width;
                                        _cur_seg_dist = next_toggle_dist - tab_width;
                                    }
                                }
                            }

                            // Cut (or rapid) to segment endpoint
                            if laser_on {
                                let d = ((px - cur_x).powi(2) + (py - cur_y).powi(2)).sqrt();
                                cut_distance += d;
                                total_distance += d;
                                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", px, py, speed_mm_min, s_max));
                                moves.push(GcodeMove { x: px, y: py, move_type: "cut".to_string(), speed: speed_mm_min, power: s_max });
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
                                    lines.push(format!("{} S{}", power_cmd, s_max));
                                }
                                cut_distance += ext;
                                total_distance += ext;
                                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", ox, oy, speed_mm_min, s_max));
                                moves.push(GcodeMove { x: ox, y: oy, move_type: "cut".to_string(), speed: speed_mm_min, power: s_max });
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
                                    lines.push(format!("{} S{}", power_cmd, s_max));
                                }
                                cut_distance += lead_out;
                                total_distance += lead_out;
                                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", lox, loy, speed_mm_min, s_max));
                                moves.push(GcodeMove { x: lox, y: loy, move_type: "cut".to_string(), speed: speed_mm_min, power: s_max });
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
                    lines.push(format!("; Engrave: {} ({}% @ {}mm/s, interval {}mm)",
                        obj.id, layer.power, layer.speed, layer.interval));

                    let interval = if layer.interval > 0.0 { layer.interval } else { 0.1 };
                    let overscan = layer.overscan.max(0.0);
                    let scanning_offset = layer.scanning_offset;

                    // Scan lines are generated in the object's local (unrotated) space.
                    // The transform_to_grbl helper applies rotation + Y-flip per coordinate.
                    let (x_min, x_max, y_min, y_max) = (obj.x, obj.x + obj.width, obj.y, obj.y + obj.height);
                    // Combine object rotation + layer scan angle + per-pass angle increment
                    let obj_rot = if obj.rotation.abs() > 0.001 { obj.rotation.to_radians() } else { 0.0 };
                    let layer_angle = layer.scan_angle.to_radians() + (pass as f64) * layer.angle_increment.to_radians();
                    let rotation_rad = obj_rot + layer_angle;
                    let center_x = obj.x + obj.width / 2.0;
                    let center_y = obj.y + obj.height / 2.0;

                    let scan_params = ScanLineParams {
                        overscan,
                        scanning_offset,
                        interval,
                        bidirectional: layer.bidirectional,
                        speed_mm_min,
                        s_max,
                        power_cmd: power_cmd.to_string(),
                        workspace_height,
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
                    lines.push(format!("; Offset Fill: {} ({}% @ {}mm/s, interval {}mm)",
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

                    lines.push(format!("{} S{}", power_cmd, s_max));

                    for path in &paths_to_offset {
                        if path.points.len() < 3 { continue; }

                        let polygon: Vec<super::gcode_gen::Point> = path.points.iter()
                            .map(|p| Point { x: p.x, y: p.y })
                            .collect();

                        let rings = super::offset::generate_offset_rings(&polygon, interval);

                        for ring in &rings {
                            if ring.len() < 2 { continue; }

                            // Rapid to ring start
                            let (rsx, rsy) = (ring[0].x, workspace_height - ring[0].y);
                            let dist = ((rsx - cur_x).powi(2) + (rsy - cur_y).powi(2)).sqrt();
                            travel_distance += dist;
                            total_distance += dist;
                            lines.push(format!("G0 X{:.3} Y{:.3}", rsx, rsy));
                            moves.push(GcodeMove { x: rsx, y: rsy, move_type: "rapid".to_string(), speed: 3000.0, power: 0.0 });
                            cur_x = rsx;
                            cur_y = rsy;

                            // Cut along ring
                            for pt in ring.iter().skip(1) {
                                let (px, py) = (pt.x, workspace_height - pt.y);
                                let d = ((px - cur_x).powi(2) + (py - cur_y).powi(2)).sqrt();
                                cut_distance += d;
                                total_distance += d;
                                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", px, py, speed_mm_min, s_max));
                                moves.push(GcodeMove { x: px, y: py, move_type: "cut".to_string(), speed: speed_mm_min, power: s_max });
                                cur_x = px;
                                cur_y = py;
                            }

                            // Close the ring
                            let (fx, fy) = (ring[0].x, workspace_height - ring[0].y);
                            let d = ((fx - cur_x).powi(2) + (fy - cur_y).powi(2)).sqrt();
                            if d > 0.001 {
                                cut_distance += d;
                                total_distance += d;
                                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", fx, fy, speed_mm_min, s_max));
                                moves.push(GcodeMove { x: fx, y: fy, move_type: "cut".to_string(), speed: speed_mm_min, power: s_max });
                                cur_x = fx;
                                cur_y = fy;
                            }
                        }
                    }

                    lines.push("M5".to_string());
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

            let is_rounded = obj.corner_radius.map_or(false, |r| r > 0.0);
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
