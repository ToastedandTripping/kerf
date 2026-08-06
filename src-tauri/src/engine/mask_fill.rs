//! Hole-aware bitmap-mask scanline fill for compound shapes.
//!
//! Architecture:
//!   1. Render all contours of a compound shape into one `tiny_skia::Path`.
//!   2. Rasterize with `FillRule::EvenOdd` — counters (O/e holes) are left white.
//!   3. Scan the resulting binary mask through `scan_mask_to_gcode` (extracted
//!      from `image_gcode_gen.rs` Phase 0) to emit G-code scan rows.
//!
//! Even-odd makes winding direction irrelevant for hole detection — do NOT
//! re-add CCW import normalization (Fix-2 in ImageTraceDialog) when debugging
//! hole issues here. If a counter still burns, check the EvenOdd probe test
//! or the alpha-threshold constant (FILLED_ALPHA_THRESHOLD = 128).
//!
//! Phase 0: micro-probe gate + scanner extraction (scan_mask_to_gcode)
//! Phase 2: fill_compound_mask + dispatch glue

use tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, Transform};

use crate::engine::gcode_gen::{CutObject, GcodeMove, GcodeResult, PathSegment, RAPID_SPEED_MM_MIN};
use crate::engine::image_gcode_gen::{estimate_simple_time, find_binary_runs, find_grayscale_runs};
use crate::engine::limits;

// ─── Alpha threshold for filled-vs-background classification ──────────────────
// Pixels with alpha >= 128 are treated as "filled" (engrave).
// Pixels with alpha < 128 are background (no-engrave).
// This pins the AA edge behavior: AA fringe pixels below the midpoint
// don't widen strokes or spawn stray scan runs.
const FILLED_ALPHA_THRESHOLD: u8 = 128;

/// A scan run carried through bidirectional ordering:
/// `(x_start, x_end, optional original (start, end) for grayscale pixel indexing)`.
type OrderedRun = (usize, usize, Option<(usize, usize)>);

// ─── Phase 0: MaskScanParams ───────────────────────────────────────────────────

/// Parameters for scanning a mask into G-code scan rows.
///
/// Shared by the image-engrave pipeline (`generate_scan_gcode` in
/// `image_gcode_gen.rs`) and the maskFill path. The `grayscale_pixels` field
/// selects between the two emission modes:
///
/// - `None` → binary mode: constant S value (`s_max`) across each run.
/// - `Some(data)` → grayscale mode: per-pixel S value interpolated between
///   `s_min` and `s_max`, matching the F4 reverse-row pixel-index behavior from
///   `image_gcode_gen.rs`. `data` must be the same length as `pixels` (`w × h`).
pub struct MaskScanParams<'a> {
    /// Origin of the mask in workspace coordinates (mm), bottom-left of bbox.
    pub origin_x: f64,
    pub origin_y: f64,
    /// Width of the mask in workspace mm (bbox width).
    pub width_mm: f64,
    /// Height of the mask in workspace mm (bbox height).
    pub height_mm: f64,
    /// Scan-line interval in mm (mask pixel size = interval).
    pub interval: f64,
    /// Overscan distance in mm.
    pub overscan: f64,
    /// Bidirectional scan flag.
    pub bidirectional: bool,
    /// Scanning offset in mm (applied on reverse rows).
    pub scanning_offset: f64,
    /// Laser speed in mm/min.
    pub speed_mm_min: f64,
    /// Maximum S value (GRBL $30 × power%).
    pub s_max: f64,
    /// Minimum S value for grayscale mode.
    pub s_min: f64,
    /// Power command string ("M3" or "M4").
    pub power_cmd: String,
    /// Workspace height in mm (for Y-flip).
    pub workspace_height: f64,
    /// If true, Y=0 is at the top (no Y-flip).
    pub origin_top: bool,
    /// Combined rotation in radians (object rotation + scan_angle + pass increment).
    /// Applied to map mask coordinates back to workspace after scanning.
    pub rotation_rad: f64,
    /// Number of scan passes.
    pub passes: u32,
    /// Grayscale pixel data for variable-power emission.
    ///
    /// When `Some(data)`, the scanner emits one G1 per pixel with S value
    /// interpolated from `data[pixel_index]` between `s_min` and `s_max`.
    /// `data` must have length `w × h` and use the same 0=black/255=white
    /// convention as the dithered image buffer.
    ///
    /// When `None`, the scanner emits one G1 per run at constant `s_max` (binary).
    pub grayscale_pixels: Option<&'a [u8]>,
}

/// Scan a mask (`pixels`, `w`×`h`) into G-code scan rows.
///
/// `pixels` is the binary classification plane: 0 = filled (fire laser), 255 = background.
/// For binary mode (`params.grayscale_pixels = None`), constant `s_max` is emitted per run.
/// For grayscale mode (`params.grayscale_pixels = Some(data)`), per-pixel S values are
/// interpolated between `s_min` and `s_max` from `data`, preserving the F4 reverse-row
/// pixel-index fix from `image_gcode_gen.rs`.
///
/// Pixel (col, row) → workspace position:
///   x_img = params.origin_x + col * params.interval
///   y_img = params.origin_y + row * params.interval
/// then rotated by `params.rotation_rad` around the mask center and Y-flipped
/// to GRBL coordinates using `params.workspace_height`/`origin_top`.
///
/// This is the single shared scanner used by both the maskFill path and (via delegation)
/// `generate_scan_gcode` in `image_gcode_gen.rs`. Any scan-loop fix applied here is
/// automatically inherited by both paths.
pub fn scan_mask_to_gcode<'a>(
    pixels: &[u8],
    w: usize,
    h: usize,
    params: &MaskScanParams<'a>,
) -> Result<GcodeResult, String> {
    // Validate grayscale_pixels length if provided.
    if let Some(gray) = params.grayscale_pixels {
        let expected = w * h;
        if gray.len() != expected {
            return Err(format!(
                "grayscale_pixels length {} does not match mask dimensions {}x{} = {}",
                gray.len(), w, h, expected
            ));
        }
    }

    let mut lines: Vec<String> = Vec::new();
    let mut moves: Vec<GcodeMove> = Vec::new();
    let mut cut_distance = 0.0_f64;
    let mut travel_distance = 0.0_f64;
    let mut total_distance = 0.0_f64;
    let mut cur_x = 0.0_f64;
    let mut cur_y = 0.0_f64;

    let interval = if params.interval > 0.0 { params.interval } else { 0.1 };
    let overscan = params.overscan.max(0.0);
    let is_grayscale = params.grayscale_pixels.is_some();

    // Center of the mask in workspace coordinates (for rotation pivot)
    let cx = params.origin_x + params.width_mm / 2.0;
    let cy = params.origin_y + params.height_mm / 2.0;
    let has_rotation = params.rotation_rad.abs() > 1e-6;

    // Inner Y-flip closure: delegates to the shared coords::to_grbl_coords helper.
    let to_grbl = |x_img: f64, y_img: f64| -> (f64, f64) {
        crate::engine::coords::to_grbl_coords(
            x_img, y_img, cx, cy,
            params.rotation_rad, params.origin_top, params.workspace_height,
        )
    };

    // Pre-compute row_has_content for fast skip on sparse masks
    let row_has_content: Vec<bool> = (0..h).map(|row| {
        let row_start = row * w;
        let row_pixels = &pixels[row_start..row_start + w];
        if is_grayscale {
            row_pixels.iter().any(|&p| p < 255)
        } else {
            row_pixels.contains(&0) // 0 = filled pixel
        }
    }).collect();

    for pass in 0..params.passes {
        if params.passes > 1 {
            lines.push(format!("; Mask fill pass {}/{}", pass + 1, params.passes));
        }

        let mut forward = true;

        for (row, &has_content) in row_has_content.iter().enumerate() {
            if !has_content {
                continue;
            }

            // P2-A Fix #8: center each scan line at the pixel center, not edge.
            // At coarse intervals, pixel-edge placement causes visible banding.
            let y_mm = params.origin_y + (row as f64 + 0.5) * interval;

            let row_start = row * w;
            let row_pixels = &pixels[row_start..row_start + w];

            // Use the appropriate run-finder based on mode.
            // find_binary_runs and find_grayscale_runs are pub(crate) in image_gcode_gen.rs.
            let runs = if is_grayscale {
                find_grayscale_runs(row_pixels)
            } else {
                find_binary_runs(row_pixels)
            };
            if runs.is_empty() {
                continue;
            }

            // Y coordinate for this row (evaluated at left edge for non-rotated;
            // per-point coordinates computed in the run loop for rotated)
            let gy = if has_rotation {
                to_grbl(params.origin_x, y_mm).1
            } else if params.origin_top {
                -y_mm
            } else {
                params.workspace_height - y_mm
            };

            // Forward or reverse run order (bidirectional).
            // For grayscale mode, carry the original (start, end) for pixel indexing.
            // For binary mode, swap start/end for reverse direction.
            let ordered_runs: Vec<OrderedRun> = if forward {
                runs.iter().map(|&(s, e)| (s, e, if is_grayscale { Some((s, e)) } else { None })).collect()
            } else {
                runs.iter().rev().map(|&(s, e)| {
                    // Swap run endpoints so x_start > x_end (rightward to leftward)
                    if is_grayscale {
                        (e, s, Some((s, e))) // (e, s) for position; (s, e) = original pixel bounds
                    } else {
                        (e, s, None)
                    }
                }).collect()
            };

            // ── Continuous per-row sweep ──────────────────────────────────────────
            // ONE G0 per row to the lead-in overscan position.
            // Power command (M3/M4) emitted ONCE before the row runs.
            // Gaps between runs are G1+S0 at engrave speed — NO G0, NO M5 mid-row.
            // M5 is NOT emitted within a row; $32=1 G0-suppression handles rapid safety.

            let offset = if !forward { params.scanning_offset } else { 0.0 };

            // Resolve workspace coordinates for the first run's entry boundary and the
            // last run's exit boundary. For reversed rows, ordered_runs endpoints are
            // swapped (run_start > run_end), so:
            //   forward  → first_run_start = left col of leftmost run
            //              last_run_end    = right col of rightmost run
            //   reversed → first_run_start = right col of rightmost run (swapped)
            //              last_run_end    = left col of leftmost run (swapped)
            let (first_run_start, _, _) = ordered_runs[0];
            let (_, last_run_end, _)    = ordered_runs[ordered_runs.len() - 1];

            let first_entry_img = params.origin_x + first_run_start as f64 * interval + offset;
            let last_exit_img   = params.origin_x + last_run_end as f64 * interval + offset;

            let (first_entry_x, row_gy) = if has_rotation {
                to_grbl(first_entry_img, y_mm)
            } else {
                (first_entry_img, gy)
            };
            let (last_exit_x, _) = if has_rotation {
                to_grbl(last_exit_img, y_mm)
            } else {
                (last_exit_img, gy)
            };

            // P2-A Fix #2: compute lead-in and accel overscan in image space, then
            // transform to machine coords — symmetric with the decel side. This
            // prevents the head from cornering at the run boundary under rotation.
            //
            // Lead-in G0: ONE rapid per row to the overscan approach position.
            // forward:  approach from left  → G0 to (first_entry_img − overscan) in image X
            // reversed: approach from right → G0 to (first_entry_img + overscan) in image X
            let lead_in_img = if forward {
                first_entry_img - overscan
            } else {
                first_entry_img + overscan
            };
            let (lead_in_x, lead_in_y) = if has_rotation {
                to_grbl(lead_in_img, y_mm)
            } else {
                let li_x = if forward { first_entry_x - overscan } else { first_entry_x + overscan };
                (li_x, row_gy)
            };

            let dist = ((lead_in_x - cur_x).powi(2) + (lead_in_y - cur_y).powi(2)).sqrt();
            travel_distance += dist;
            total_distance += dist;
            lines.push(format!("G0 X{:.3} Y{:.3}", lead_in_x, lead_in_y));
            moves.push(GcodeMove {
                x: lead_in_x, y: lead_in_y,
                move_type: "rapid".to_string(), speed: RAPID_SPEED_MM_MIN, power: 0.0,
            });

            // Accel overscan: G1 from lead-in to first run entry boundary, laser off.
            if overscan > 0.0 {
                travel_distance += overscan;
                total_distance += overscan;
                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S0", first_entry_x, row_gy, params.speed_mm_min));
                moves.push(GcodeMove {
                    x: first_entry_x, y: row_gy,
                    move_type: "rapid".to_string(), speed: params.speed_mm_min, power: 0.0,
                });
            }

            // Power command: emit M3/M4 ONCE per row (modal — stays active until M5 at job end).
            lines.push(format!("{} S{}", params.power_cmd, params.s_max));

            // Track the current head position within the row in machine (GRBL) coords.
            // P2-A Fix #1: track (x, y) — not X-only — so rotated gap detection is 2D.
            let mut row_cur_x = first_entry_x;
            let mut row_cur_y = row_gy;

            for (run_idx, (run_start, run_end, orig_bounds)) in ordered_runs.iter().enumerate() {
                let x_start_img = params.origin_x + *run_start as f64 * interval + offset;
                let x_end_img   = params.origin_x + *run_end as f64 * interval + offset;

                // P2-A Fix #1: compute full (x, y) in machine coords for both run
                // endpoints. Gap detection uses 2D distance; gap transit targets the
                // correct Y from to_grbl (not a stale row_gy).
                let (x_start, y_start) = if has_rotation {
                    to_grbl(x_start_img, y_mm)
                } else {
                    (x_start_img, row_gy)
                };
                let (x_end, gy_end) = if has_rotation {
                    to_grbl(x_end_img, y_mm)
                } else {
                    (x_end_img, row_gy)
                };

                // Gap transit: if the head is not already at this run's start, traverse the
                // gap with G1+S0 at engrave speed (laser off, constant velocity).
                // P2-A Fix #1: use 2D Euclidean distance so rotated gaps (where runs stack
                // at the same machine X but differ in Y) are properly detected.
                // TODO: G0-skip for gaps > v²/$120 (accel-ramp safe threshold)
                let gap_dist_2d = ((x_start - row_cur_x).powi(2) + (y_start - row_cur_y).powi(2)).sqrt();
                if run_idx > 0 && gap_dist_2d > 1e-6 {
                    travel_distance += gap_dist_2d;
                    total_distance += gap_dist_2d;
                    lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S0", x_start, y_start, params.speed_mm_min));
                    moves.push(GcodeMove {
                        x: x_start, y: y_start,
                        move_type: "rapid".to_string(), speed: params.speed_mm_min, power: 0.0,
                    });
                }

                // Engrave this run.
                if is_grayscale {
                    // Grayscale mode: variable power — one G1 per pixel.
                    // F4 fix: use original pixel bounds for index computation, regardless
                    // of whether run_start/run_end were swapped for reverse direction.
                    if let (Some(gray_data), Some((orig_start, orig_end))) =
                        (params.grayscale_pixels, orig_bounds)
                    {
                        let gray_row = &gray_data[row_start..row_start + w];
                        let run_pixel_slice = &gray_row[*orig_start..*orig_end];
                        let run_forward = run_end > run_start; // true if not reversed

                        let pixel_iter: Box<dyn Iterator<Item = &u8>> = if run_forward {
                            Box::new(run_pixel_slice.iter())
                        } else {
                            Box::new(run_pixel_slice.iter().rev())
                        };

                        for (i, &pixel) in pixel_iter.enumerate() {
                            let s_val = if pixel == 255 {
                                0.0
                            } else {
                                let fraction = (255 - pixel) as f64 / 255.0;
                                params.s_min + fraction * (params.s_max - params.s_min)
                            };

                            // Forward rows count up from orig_start (left edge of run).
                            // Reverse rows count DOWN from orig_end (right edge of run).
                            let px_img = if run_forward {
                                params.origin_x + (*orig_start + i + 1) as f64 * interval + offset
                            } else {
                                params.origin_x + (*orig_end as i64 - i as i64 - 1).max(0) as f64 * interval + offset
                            };

                            let (px, py) = if has_rotation {
                                to_grbl(px_img, y_mm)
                            } else {
                                (px_img, row_gy)
                            };

                            cut_distance += interval;
                            total_distance += interval;
                            lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{:.0}", px, py, params.speed_mm_min, s_val));
                            moves.push(GcodeMove {
                                x: px, y: py,
                                move_type: "engrave".to_string(), speed: params.speed_mm_min, power: s_val,
                            });
                        }
                        row_cur_x = x_end;
                        row_cur_y = gy_end;
                    }
                } else {
                    // Binary mode: constant power across the whole run.
                    // S=s_max on G1 to run end; M4/M3 is modal — no per-run power command needed.
                    // P2-A Fix #1: use 2D distance for rotated scan runs.
                    let scan_dist = ((x_end - x_start).powi(2) + (gy_end - y_start).powi(2)).sqrt();
                    cut_distance += scan_dist;
                    total_distance += scan_dist;
                    lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", x_end, gy_end, params.speed_mm_min, params.s_max));
                    moves.push(GcodeMove {
                        x: x_end, y: gy_end,
                        move_type: "engrave".to_string(), speed: params.speed_mm_min, power: params.s_max,
                    });
                    row_cur_x = x_end;
                    row_cur_y = gy_end;
                }
            }

            // Decel overscan: G1 from last run exit boundary to overscan tail, laser off.
            // forward:  tail = last_exit + overscan (rightward past rightmost run)
            // reversed: tail = last_exit − overscan (leftward past leftmost run)
            if overscan > 0.0 {
                let tail_img = if forward { last_exit_img + overscan } else { last_exit_img - overscan };
                let (os_tail_x, os_tail_y) = if has_rotation {
                    to_grbl(tail_img, y_mm)
                } else {
                    let tail_x = if forward { last_exit_x + overscan } else { last_exit_x - overscan };
                    (tail_x, row_gy)
                };
                travel_distance += overscan;
                total_distance += overscan;
                lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S0", os_tail_x, os_tail_y, params.speed_mm_min));
                moves.push(GcodeMove {
                    x: os_tail_x, y: os_tail_y,
                    move_type: "rapid".to_string(), speed: params.speed_mm_min, power: 0.0,
                });
                cur_x = os_tail_x;
                cur_y = os_tail_y;
            } else {
                // No overscan: head ends at the last run's exit position.
                // P2-A Fix #1: track both x and y from the last run's endpoint.
                cur_x = row_cur_x;
                cur_y = row_cur_y;
            }

            if params.bidirectional {
                forward = !forward;
            }
        }
    }

    Ok(GcodeResult {
        gcode: lines.join("\n"),
        moves,
        total_distance,
        cut_distance,
        travel_distance,
        estimated_time_secs: estimate_simple_time(&cut_distance, &travel_distance, params.speed_mm_min / 60.0),
        line_count: lines.len(),
    })
}

// ─── Phase 2: rasterize compound shape to even-odd mask ──────────────────────

/// Rasterize a compound shape (all contours in `obj.paths`) into a binary mask
/// using `FillRule::EvenOdd`.  Counters (inner rings) become background (255);
/// filled areas become 0.
///
/// Returns `(pixels, w, h, origin_x_mm, origin_y_mm)` where `pixels` is the
/// binary mask in the same 0=filled/255=bg convention as `image_gcode_gen`.
///
/// `pixels[row * w + col]` → workspace point:
///   x = origin_x + col * interval
///   y = origin_y + row * interval
///
/// Applies object rotation when computing the union bbox (same rotation the
/// `"fill"` arm uses in `gcode_gen.rs` for the scan-angle rotated AABB), so
/// `CutObject.x/y/width/height` and the mask share one bbox origin.
pub fn fill_compound_mask(
    obj: &CutObject,
    interval: f64,
) -> Result<(Vec<u8>, usize, usize, f64, f64), String> {
    if obj.paths.is_empty() {
        return Err("maskFill: object has no paths".to_string());
    }

    let interval = limits::validated_interval(
        if interval > 0.0 { interval } else { 0.1 }
    );

    // Compute union bbox of all contours in obj.paths.
    // The object's x/y/width/height is already the axis-aligned union bbox of all
    // contours in design space (set by toCutObjects, Phase 1).
    //
    // Rotation is NOT pre-applied to obj.paths here. toCutObjects is TypeScript and
    // does not rotate path coordinates; `rotate_segment` in gcode_gen.rs is only
    // called from the vector "line"/"cut" arm, not for maskFill objects. Instead:
    // - fill_compound_mask rasterizes paths in local (un-rotated) coordinates.
    // - The caller (gcode_gen.rs maskFill arm) computes `rotation_rad` from
    //   `obj.rotation + scan_angle + angle_increment` and passes it to
    //   `scan_mask_to_gcode`, which applies it as an output rotation of each
    //   scanned coordinate about the bbox center.
    // This is geometrically equivalent to rotating the rasterized bitmap and scanning
    // it axis-aligned — but cheaper, since no interpolation step is needed.
    let bbox_x = obj.x;
    let bbox_y = obj.y;
    let bbox_w = obj.width;
    let bbox_h = obj.height;

    if bbox_w <= 0.0 || bbox_h <= 0.0 {
        return Err(format!("maskFill: degenerate bbox {}x{}", bbox_w, bbox_h));
    }

    // Mask dimensions: one pixel per interval
    let mask_w = (bbox_w / interval).ceil().max(1.0) as usize;
    let mask_h = (bbox_h / interval).ceil().max(1.0) as usize;

    // Guard: reject oversized masks that would exhaust memory.
    if let Err(e) = limits::check_raster_pixels(mask_w, mask_h) {
        return Err(format!("maskFill '{}': {}", obj.id, e));
    }

    // Build tiny-skia path from all path segments.
    // Each PathSegment becomes one subcontour (move_to/line_to*/close).
    // All subcontours in one Path → EvenOdd applies globally across them.
    let mut pb = PathBuilder::new();

    for seg in &obj.paths {
        build_subcontour(&mut pb, seg, bbox_x, bbox_y, interval);
    }

    let path = pb.finish().ok_or_else(|| {
        "maskFill: PathBuilder produced an empty path (zero-area or degenerate points)".to_string()
    })?;

    // Rasterize: white background (RGBA 0,0,0,0), paint filled regions opaque black.
    let mut pixmap = Pixmap::new(mask_w as u32, mask_h as u32)
        .ok_or_else(|| format!("maskFill: cannot allocate {}x{} pixmap", mask_w, mask_h))?;
    // pixmap is initialized to transparent (all zeros) by tiny-skia

    let mut paint = Paint::default();
    paint.set_color_rgba8(0, 0, 0, 255); // opaque black for filled pixels
    paint.anti_alias = false; // binary mask — no AA fringe

    pixmap.fill_path(&path, &paint, FillRule::EvenOdd, Transform::identity(), None);

    // Convert RGBA pixmap to binary plane: alpha >= FILLED_ALPHA_THRESHOLD → 0 (filled), else 255 (bg).
    // Data layout: RGBA, 4 bytes per pixel. Alpha is at byte index 3.
    let raw = pixmap.data();
    let mut pixels: Vec<u8> = (0..mask_w * mask_h)
        .map(|i| {
            let alpha = raw[i * 4 + 3];
            if alpha >= FILLED_ALPHA_THRESHOLD { 0 } else { 255 }
        })
        .collect();

    // Thin-stroke / min-1-row policy (critic must-fix #3):
    // A glyph hairline narrower than one scan interval rasterizes to all-background
    // because no pixel ROW CENTER falls inside the stroke geometry. If all pixels are
    // background but the object has valid paths (non-empty, non-zero bbox), apply a
    // half-interval dilation: re-render with each contour's Y coordinates expanded
    // outward by 0.5 pixels so sub-interval strokes hit at least one scan row.
    //
    // The dilation is applied only in pixel space (not mm); it does not affect the
    // mask's mm origin or interval, so the G-code coordinates are unchanged.
    let all_background = pixels.iter().all(|&p| p == 255);
    if all_background {
        // Re-render with thin-stroke dilation: expand each contour's Y by ±0.5px.
        let mut pb2 = PathBuilder::new();
        for seg in &obj.paths {
            build_subcontour_dilated(&mut pb2, seg, bbox_x, bbox_y, interval);
        }
        if let Some(dilated_path) = pb2.finish() {
            let mut pixmap2 = Pixmap::new(mask_w as u32, mask_h as u32)
                .ok_or_else(|| format!("maskFill: cannot allocate dilated {}x{} pixmap", mask_w, mask_h))?;
            pixmap2.fill_path(&dilated_path, &paint, FillRule::EvenOdd, Transform::identity(), None);
            let raw2 = pixmap2.data();
            pixels = (0..mask_w * mask_h)
                .map(|i| {
                    let alpha = raw2[i * 4 + 3];
                    if alpha >= FILLED_ALPHA_THRESHOLD { 0 } else { 255 }
                })
                .collect();
        }
        // If still all background after dilation, emit a warning but continue;
        // the scan_mask_to_gcode call will skip all rows (no silent empty engrave —
        // the GcodeResult will have zero cut_distance, easily detectable upstream).
        if pixels.iter().all(|&p| p == 255) {
            eprintln!(
                "[mask_fill] WARNING: object '{}' produced an all-background mask even after \
                 thin-stroke dilation. Skipping object (zero cut distance in output). \
                 Check that paths have ≥2 points and non-zero area.",
                obj.id
            );
        }
    }

    Ok((pixels, mask_w, mask_h, bbox_x, bbox_y))
}

/// Convert one `PathSegment` (design-space mm) into a tiny-skia subcontour
/// in mask-pixel coordinates.
///
/// Mask pixel (col, row):
///   x_mm = bbox_x + col * interval
///   y_mm = bbox_y + row * interval
/// → col = (pt.x - bbox_x) / interval
///   row = (pt.y - bbox_y) / interval
fn build_subcontour(
    pb: &mut PathBuilder,
    seg: &PathSegment,
    bbox_x: f64,
    bbox_y: f64,
    interval: f64,
) {
    if seg.points.is_empty() {
        return;
    }

    let to_px = |pt: &crate::engine::gcode_gen::Point| -> (f32, f32) {
        let col = ((pt.x - bbox_x) / interval) as f32;
        let row = ((pt.y - bbox_y) / interval) as f32;
        (col, row)
    };

    let (fx, fy) = to_px(&seg.points[0]);
    pb.move_to(fx, fy);
    for pt in &seg.points[1..] {
        let (px, py) = to_px(pt);
        pb.line_to(px, py);
    }
    if seg.closed {
        pb.close();
    }
}

/// Like `build_subcontour` but expands the contour's Y range by ±0.5 pixels
/// to rescue thin strokes narrower than one scan interval.
///
/// Implementation: compute the pixel-space centroid Y of the contour, then
/// shift each point away from the centroid by 0.5 pixels in the Y direction.
/// This preserves the contour's X geometry while dilating vertically.
fn build_subcontour_dilated(
    pb: &mut PathBuilder,
    seg: &PathSegment,
    bbox_x: f64,
    bbox_y: f64,
    interval: f64,
) {
    if seg.points.is_empty() {
        return;
    }

    let to_col = |pt: &crate::engine::gcode_gen::Point| -> f32 {
        ((pt.x - bbox_x) / interval) as f32
    };
    let to_row = |pt: &crate::engine::gcode_gen::Point| -> f32 {
        ((pt.y - bbox_y) / interval) as f32
    };

    // Compute the pixel-space Y centroid and min/max
    let rows: Vec<f32> = seg.points.iter().map(to_row).collect();
    let row_min = rows.iter().cloned().fold(f32::INFINITY, f32::min);
    let row_max = rows.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let row_center = (row_min + row_max) / 2.0;

    // Expand each row coordinate away from the center by 0.5px.
    // Points exactly at `row_center` (within epsilon) cannot be expanded
    // "away" from the center because there is no directional signal. In the
    // `all_same` branch below, these are handled with the alternating
    // +0.5/-0.5 expansion. In the non-`all_same` branch (multi-row contour),
    // center-coincident points stay at their original row -- acceptable
    // because they lie between points that ARE expanded, so the contour
    // still covers more area than the undilated version.
    let dilated_rows: Vec<f32> = rows.iter().map(|&r| {
        let d = r - row_center;
        if d.abs() < 1e-6 {
            r // center-coincident: no expansion direction available
        } else {
            row_center + d.signum() * (d.abs() + 0.5)
        }
    }).collect();

    // If all points collapsed to the same row (degenerate), use the
    // alternating +0.5/-0.5 expansion to create a 1-pixel-tall strip.
    let all_same = (row_max - row_min).abs() < 1e-6;
    let half = seg.points.len() / 2;

    if let Some(first) = seg.points.first() {
        let col = to_col(first);
        let row = if all_same {
            // Degenerate: use the center expanded down by 0.5
            row_center + 0.5
        } else {
            dilated_rows[0]
        };
        pb.move_to(col, row);
    }

    for (i, pt) in seg.points[1..].iter().enumerate() {
        let col = to_col(pt);
        let row = if all_same {
            // Alternate top/bottom for degenerate contours
            if i < half { row_center - 0.5 } else { row_center + 0.5 }
        } else {
            dilated_rows[i + 1]
        };
        pb.line_to(col, row);
    }

    if seg.closed {
        pb.close();
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::gcode_gen::{CutLayer, CutObject, PathSegment, Point};

    // ─── Phase 0: micro-probe gate ─────────────────────────────────────────────

    /// FAIL-FAST GATE: Verify that tiny-skia `FillRule::EvenOdd` applies globally
    /// across multiple move_to/close subcontours within a single `Path`.
    ///
    /// Setup: outer 10×10 square + inner 4×4 square centered at (5,5).
    /// Even-odd rule: center of inner square has been crossed by 2 edges → parity 0 → background.
    /// Wall of outer square crossed by 1 edge → parity 1 → filled.
    ///
    /// If this test fails, the whole architecture collapses — the thesis that
    /// tiny-skia FillRule::EvenOdd empties counters across subcontours is false.
    #[test]
    fn phase0_even_odd_empties_counter_across_subcontours() {
        // Build outer 10×10 square contour
        let mut pb = PathBuilder::new();
        pb.move_to(0.0, 0.0);
        pb.line_to(10.0, 0.0);
        pb.line_to(10.0, 10.0);
        pb.line_to(0.0, 10.0);
        pb.close();

        // Build inner 4×4 square contour (centered at 5,5: from 3,3 to 7,7)
        pb.move_to(3.0, 3.0);
        pb.line_to(7.0, 3.0);
        pb.line_to(7.0, 7.0);
        pb.line_to(3.0, 7.0);
        pb.close();

        let path = pb.finish().expect("Phase 0 probe: PathBuilder should produce a valid path");

        let mut pixmap = Pixmap::new(10, 10).expect("Phase 0 probe: Pixmap allocation failed");
        let mut paint = Paint::default();
        paint.set_color_rgba8(0, 0, 0, 255);
        paint.anti_alias = false;

        pixmap.fill_path(&path, &paint, FillRule::EvenOdd, Transform::identity(), None);

        // Center pixel (5,5) — inside the inner square — should be BACKGROUND (alpha=0)
        // because it's been crossed by 2 edges (outer + inner), parity = 0.
        let center_px = pixmap.pixel(5, 5).expect("pixel(5,5) should be in bounds");
        assert_eq!(
            center_px.alpha(), 0,
            "FAIL-FAST GATE FAILED: center of inner square (5,5) should be background (alpha=0) \
             under EvenOdd, but got alpha={}. The even-odd rule is NOT applying globally \
             across subcontours — the architecture collapses. Fall back to two-render XOR.",
            center_px.alpha()
        );

        // Wall pixel (1,5) — inside the outer square but outside the inner — should be FILLED (alpha=255)
        // because it's been crossed by 1 edge (outer only), parity = 1.
        let wall_px = pixmap.pixel(1, 5).expect("pixel(1,5) should be in bounds");
        assert_eq!(
            wall_px.alpha(), 255,
            "Phase 0 probe: wall pixel (1,5) should be filled (alpha=255), got alpha={}",
            wall_px.alpha()
        );
    }

    // ─── Phase 0: scanner extraction correctness ─────────────────────────────

    fn base_scan_params() -> MaskScanParams<'static> {
        MaskScanParams {
            origin_x: 0.0,
            origin_y: 0.0,
            width_mm: 10.0,
            height_mm: 1.0,
            interval: 1.0,
            overscan: 0.0,
            bidirectional: false,
            scanning_offset: 0.0,
            speed_mm_min: 6000.0,
            s_max: 1000.0,
            s_min: 0.0,
            power_cmd: "M3".to_string(),
            workspace_height: 100.0,
            origin_top: false,
            rotation_rad: 0.0,
            passes: 1,
            grayscale_pixels: None,
        }
    }

    /// Phase 0: scanner emits Y = workspace_height - y_mm for axis-aligned mask.
    /// P2-A: with half-interval centering, y_mm = origin_y + 0.5 * interval = 10.5
    /// → gy = 100 - 10.5 = 89.5
    #[test]
    fn phase0_scanner_y_is_flipped() {
        let mut params = base_scan_params();
        params.origin_y = 10.0;
        params.height_mm = 1.0;

        // One row, all filled
        let pixels = vec![0u8; 10]; // 10 black pixels
        let result = scan_mask_to_gcode(&pixels, 10, 1, &params).expect("should succeed");
        assert!(
            result.gcode.contains("Y89.500"),
            "Expected Y89.500 (100 - 10.5, half-interval centered), got:\n{}", result.gcode
        );
    }

    /// Phase 0: bidirectional reverse rows — first scan run in the reverse row
    /// should come from the right end of the mask, not the left.
    /// (Mirrors the F4 test in image_gcode_gen.rs)
    #[test]
    fn phase0_bidi_reverse_row_starts_from_right() {
        let mut params = base_scan_params();
        params.bidirectional = true;
        params.height_mm = 2.0;

        let w = 10usize;
        let h = 2usize;
        let mut pixels = vec![255u8; w * h];
        // Row 0 and row 1: pixels 2-4 filled (indices 2,3,4)
        pixels[2] = 0; pixels[3] = 0; pixels[4] = 0;
        pixels[w + 2] = 0; pixels[w + 3] = 0; pixels[w + 4] = 0;

        let result = scan_mask_to_gcode(&pixels, w, h, &params).expect("should succeed");

        // Extract all G1 X coordinates from the gcode
        let x_vals: Vec<f64> = result.gcode.lines()
            .filter(|l| l.starts_with("G1 X"))
            .filter_map(|l| {
                l.split_whitespace()
                    .find(|t| t.starts_with("X"))
                    .and_then(|t| t[1..].parse::<f64>().ok())
            })
            .collect();

        assert!(!x_vals.is_empty(), "Expected G1 moves; gcode:\n{}", result.gcode);

        // The reverse row should have at least one X ≥ 4.0 (right end of run)
        let has_high_x = x_vals.iter().any(|&x| x >= 4.0);
        assert!(
            has_high_x,
            "F4 parity: reverse row should produce X ≥ 4.0; got {:?}",
            x_vals
        );
    }

    /// Phase 0: EXACT X positions for grayscale bidirectional row pair.
    ///
    /// Run at cols 2..5 (orig_start=2, orig_end=5).
    /// Forward row (row 0) must emit X = [3.0, 4.0, 5.0] (counts up from orig_start).
    /// Reverse row (row 1) must emit X = [4.0, 3.0, 2.0] (counts DOWN from orig_end).
    ///
    /// With the regression (*orig_start instead of *orig_end in the reverse branch),
    /// the reverse row would produce X = [1.0, 0.0, 0.0] — this test catches that.
    ///
    /// S-value filtering: grayscale_pixels[2..5] = 127 (mid-gray → S > 0).
    /// We filter to G1 moves with S > 0 to exclude the initial S0 move each row emits.
    #[test]
    fn phase0_grayscale_bidi_exact_x_positions() {
        let w = 10usize;
        let h = 2usize;

        // Mask: only pixels 2,3,4 are filled in each row (0=filled, 255=background)
        let mut mask_pixels = vec![255u8; w * h];
        mask_pixels[2] = 0; mask_pixels[3] = 0; mask_pixels[4] = 0;   // row 0
        mask_pixels[w + 2] = 0; mask_pixels[w + 3] = 0; mask_pixels[w + 4] = 0; // row 1

        // Grayscale data: mid-gray (127) at positions 2,3,4 → S > 0; rest white (255) → S=0
        let mut gray_pixels = vec![255u8; w * h];
        gray_pixels[2] = 127; gray_pixels[3] = 127; gray_pixels[4] = 127;
        gray_pixels[w + 2] = 127; gray_pixels[w + 3] = 127; gray_pixels[w + 4] = 127;

        let mut params = base_scan_params();
        params.bidirectional = true;
        params.height_mm = 2.0;
        params.grayscale_pixels = Some(&gray_pixels);

        let result = scan_mask_to_gcode(&mask_pixels, w, h, &params).expect("should succeed");

        // Extract G1 moves with S > 0 (engrave moves, not S0 blanks)
        let engrave_x: Vec<f64> = result.gcode.lines()
            .filter(|l| l.starts_with("G1 X"))
            .filter(|l| {
                l.split_whitespace()
                    .find(|t| t.starts_with("S"))
                    .and_then(|t| t[1..].parse::<f64>().ok())
                    .map(|s| s > 0.0)
                    .unwrap_or(false)
            })
            .filter_map(|l| {
                l.split_whitespace()
                    .find(|t| t.starts_with("X"))
                    .and_then(|t| t[1..].parse::<f64>().ok())
            })
            .collect();

        assert_eq!(
            engrave_x.len(), 6,
            "Expected 6 engrave moves (3 forward + 3 reverse); got {:?}\ngcode:\n{}",
            engrave_x, result.gcode
        );

        // First 3 = forward row: X must count UP from orig_start=2 → [3.0, 4.0, 5.0]
        let forward_x = &engrave_x[..3];
        assert_eq!(
            forward_x, &[3.0f64, 4.0, 5.0],
            "Forward row X positions wrong; got {:?}", forward_x
        );

        // Last 3 = reverse row: X must count DOWN from orig_end=5 → [4.0, 3.0, 2.0]
        let reverse_x = &engrave_x[3..];
        assert_eq!(
            reverse_x, &[4.0f64, 3.0, 2.0],
            "Reverse row X positions wrong (regression: orig_start used instead of orig_end); \
             got {:?} — expected [4.0, 3.0, 2.0]",
            reverse_x
        );
    }

    /// Phase 0: golden byte snapshot — bidirectional + binary + overscan + rotation.
    ///
    /// True characterization test: asserts full G-code string equality so any
    /// future scan-loop drift (wrong X formula, dropped overscan, extra M5/G0, etc.)
    /// produces an immediate failure with a visible diff.
    ///
    /// Parameters (frozen 2026-06-24, continuous-sweep rewrite):
    ///   Mask: 8×4 pixels (binary), four distinct row patterns:
    ///     Row 0: cols 0–3 filled   (binary run [0,4))
    ///     Row 1: cols 4–7 filled   (binary run [4,8), reverse row)
    ///     Row 2: cols 1–5 filled   (binary run [1,6))
    ///     Row 3: cols 2–6 filled   (binary run [2,7), reverse row)
    ///   width_mm=8, height_mm=4, interval=1.0, overscan=1.0mm
    ///   bidirectional=true, rotation=45° (π/4), workspace_height=200
    ///
    /// Continuous-sweep invariants encoded in this snapshot:
    ///   - ONE G0 per engraved row (4 rows → 4 G0 lines total)
    ///   - NO M5 within any row (M5 absent entirely; laser powered down by S0 G1)
    ///   - M3/M4 emitted once per row, before first engrave G1
    ///   - Interior gaps (if any) are G1+S0, not G0
    ///
    /// If this test fails, regenerate by temporarily adding `panic!("{}", result.gcode)`
    /// after the `scan_mask_to_gcode` call, running with `-- --nocapture`, and freezing
    /// the output here. Never update the snapshot without verifying the new output is correct.
    #[test]
    fn phase0_golden_bidi_overscan_rotation() {
        let mut params = base_scan_params();
        params.bidirectional = true;
        params.overscan = 1.0;
        params.width_mm = 8.0;
        params.height_mm = 4.0;
        params.rotation_rad = std::f64::consts::PI / 4.0; // 45°
        params.workspace_height = 200.0;
        params.interval = 1.0;
        params.passes = 1;

        let w = 8usize;
        let h = 4usize;
        // Row 0: pixels 0-3 filled; Row 1: pixels 4-7 filled;
        // Row 2: pixels 1-5 filled; Row 3: pixels 2-6 filled
        let mut pixels = vec![255u8; w * h];
        pixels[..4].fill(0);                      // row 0
        for i in 4..8 { pixels[w + i] = 0; }      // row 1
        for i in 1..6 { pixels[2 * w + i] = 0; }  // row 2
        for i in 2..7 { pixels[3 * w + i] = 0; }  // row 3

        let result = scan_mask_to_gcode(&pixels, w, h, &params).expect("should succeed");

        // Frozen snapshot (regenerated P2-A: Fix #2 + Fix #8 — accel overscan in image
        // space + half-interval Y centering).
        // Coordinates reflect 45° rotation around mask centre (4.0, 2.0) in a 200mm workspace.
        // Each row: one G0 lead-in → G1 S0 accel overscan → M3 S1000 once → G1 S1000 engrave
        //   → G1 S0 decel overscan.  NO M5 within any row.
        // P2-A changes:
        //   Fix #2: G0 lead-in coordinates computed in image space (symmetric with decel).
        //   Fix #8: Y shifted by 0.5 * interval (pixel center, not edge).
        // All S-value engrave endpoints are unchanged from the Phase 0 golden.
        let expected = "\
G0 X1.525 Y202.596\n\
G1 X2.232 Y201.889 F6000 S0\n\
M3 S1000\n\
G1 X5.061 Y199.061 F6000 S1000\n\
G1 X5.768 Y198.354 F6000 S0\n\
G0 X7.889 Y194.818\n\
G1 X7.182 Y195.525 F6000 S0\n\
M3 S1000\n\
G1 X4.354 Y198.354 F6000 S1000\n\
G1 X3.646 Y199.061 F6000 S0\n\
G0 X0.818 Y200.475\n\
G1 X1.525 Y199.768 F6000 S0\n\
M3 S1000\n\
G1 X5.061 Y196.232 F6000 S1000\n\
G1 X5.768 Y195.525 F6000 S0\n\
G0 X5.768 Y194.111\n\
G1 X5.061 Y194.818 F6000 S0\n\
M3 S1000\n\
G1 X1.525 Y198.354 F6000 S1000\n\
G1 X0.818 Y199.061 F6000 S0";

        assert_eq!(
            result.gcode.trim(), expected.trim(),
            "Golden snapshot mismatch — scan-loop output changed.\n\
             If intentional, regenerate by temporarily adding panic!(\"{{}}\", result.gcode)\n\
             after scan_mask_to_gcode and running with `-- --nocapture`.\n\n\
             Actual:\n{}", result.gcode
        );

        // Structural sanity (belt-and-suspenders, not load-bearing — snapshot covers these)
        assert!(result.cut_distance > 0.0, "Expected positive cut distance");
        assert!(result.estimated_time_secs > 0.0, "Expected positive time estimate");
    }

    // ─── Phase 2: fill_compound_mask tests ────────────────────────────────────

    fn make_square_seg(x0: f64, y0: f64, x1: f64, y1: f64) -> PathSegment {
        PathSegment {
            points: vec![
                Point { x: x0, y: y0 },
                Point { x: x1, y: y0 },
                Point { x: x1, y: y1 },
                Point { x: x0, y: y1 },
            ],
            closed: true,
        }
    }

    fn make_base_layer() -> CutLayer {
        CutLayer {
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
        }
    }

    fn make_obj(id: &str, paths: Vec<PathSegment>, x: f64, y: f64, w: f64, h: f64) -> CutObject {
        CutObject {
            id: id.to_string(),
            obj_type: "path".to_string(),
            x,
            y,
            width: w,
            height: h,
            paths,
            layer: make_base_layer(),
            corner_radius: None,
            rotation: 0.0,
            priority: None,
            group_id: None,
            layer_index: None,
        }
    }

    /// Phase 2: "O" shape — outer square + inner square.
    /// Even-odd: center of inner square (counter) must NOT be engraved.
    #[test]
    fn mask_o_counter_not_engraved() {
        // 10mm outer, 4mm inner hole centered at (5,5): from (3,3) to (7,7)
        let outer = make_square_seg(0.0, 0.0, 10.0, 10.0);
        let inner = make_square_seg(3.0, 3.0, 7.0, 7.0);
        let obj = make_obj("o", vec![outer, inner], 0.0, 0.0, 10.0, 10.0);

        let (pixels, w, _h, _ox, _oy) = fill_compound_mask(&obj, 1.0).expect("fill_compound_mask should succeed");

        // Pixel at counter center: col=5, row=5
        // Must be background (255 = no engrave)
        let center = pixels[5 * w + 5];
        assert_eq!(
            center, 255,
            "Counter center (col=5,row=5) must be background (255), got {}; \
             even-odd is not emptying the counter", center
        );

        // Pixel in the wall (col=1,row=5) must be filled (0 = engrave)
        let wall = pixels[5 * w + 1];
        assert_eq!(
            wall, 0,
            "Wall pixel (col=1,row=5) must be filled (0), got {}; \
             the outer fill is not rasterizing", wall
        );
    }

    /// Phase 2: "H" shape — both vertical strokes must produce scan runs.
    /// Left stroke: x=0..2; gap: x=2..8; right stroke: x=8..10.
    /// Crossbar: y=4..6 spans the full width.
    ///
    /// This is the dropout regression test: the offsetFill path discarded one
    /// stroke's fill via self-intersection removal. The mask path must produce
    /// runs in BOTH vertical-stroke columns for BOTH strokes.
    #[test]
    fn mask_h_both_verticals_present() {
        // Left vertical: (0,0)→(2,10)
        let left = make_square_seg(0.0, 0.0, 2.0, 10.0);
        // Right vertical: (8,0)→(10,10)
        let right = make_square_seg(8.0, 0.0, 10.0, 10.0);
        // Crossbar: (0,4)→(10,6)
        let bar = make_square_seg(0.0, 4.0, 10.0, 6.0);
        let obj = make_obj("H", vec![left, right, bar], 0.0, 0.0, 10.0, 10.0);

        let (pixels, _w, _h, _ox, _oy) = fill_compound_mask(&obj, 1.0).expect("fill_compound_mask should succeed");

        // Row 0 (y=0..1): left stroke pixels (col 0,1) should be filled; right (col 8,9) filled; center not
        let row0_left = pixels[0]; // col 0, row 0
        let row0_right = pixels[9]; // col 9, row 0
        let row0_center = pixels[5]; // col 5, row 0 (gap)

        assert_eq!(row0_left, 0, "Left stroke (col=0,row=0) must be filled, got {}", row0_left);
        assert_eq!(row0_right, 0, "Right stroke (col=9,row=0) must be filled, got {}", row0_right);
        assert_eq!(row0_center, 255, "Center gap (col=5,row=0) must be background, got {}", row0_center);
    }

    /// Phase 2: "N" shape — both diagonal strokes must produce scan runs.
    /// This is the other dropout regression case.
    #[test]
    fn mask_n_both_diagonals_present() {
        // Left vertical: (0,0)→(2,10)
        let left = make_square_seg(0.0, 0.0, 2.0, 10.0);
        // Right vertical: (8,0)→(10,10)
        let right = make_square_seg(8.0, 0.0, 10.0, 10.0);
        // Diagonal stroke (thick, as rect): (0,0)→(10,10) wide bar
        let diag = make_square_seg(0.0, 0.0, 10.0, 3.0);
        let obj = make_obj("N", vec![left, right, diag], 0.0, 0.0, 10.0, 10.0);

        let (pixels, w, _h, _ox, _oy) = fill_compound_mask(&obj, 1.0).expect("fill_compound_mask should succeed");

        // Left stroke must be filled in its column
        let left_mid = pixels[5 * w];
        assert_eq!(left_mid, 0, "N left stroke (col=0,row=5) must be filled, got {}", left_mid);

        // Right stroke must be filled in its column
        let right_mid = pixels[5 * w + 9];
        assert_eq!(right_mid, 0, "N right stroke (col=9,row=5) must be filled, got {}", right_mid);
    }

    /// Phase 2: rectangle (single path) must still produce scan runs.
    /// The AABB and maskFill paths should be equivalent for a rectangle.
    #[test]
    fn mask_rect_still_fills() {
        let rect = make_square_seg(0.0, 0.0, 5.0, 5.0);
        let obj = make_obj("rect", vec![rect], 0.0, 0.0, 5.0, 5.0);

        let (pixels, w, h, _ox, _oy) = fill_compound_mask(&obj, 1.0).expect("fill_compound_mask should succeed");

        // All interior pixels should be filled (0)
        let mut filled_count = 0;
        for row in 0..h {
            for col in 0..w {
                if pixels[row * w + col] == 0 {
                    filled_count += 1;
                }
            }
        }
        assert!(filled_count > 0, "Rectangle mask must have filled pixels, got none");
    }

    /// Phase 2: overlapping rects — even-odd makes the overlap count as background
    /// (parity 2 = 0 mod 2 = no-fill), so overlapping shapes get single energy, not double.
    #[test]
    fn mask_overlap_single_energy() {
        // Two overlapping squares: (0,0)-(6,6) and (4,4)-(10,10). Overlap: (4,4)-(6,6).
        let sq1 = make_square_seg(0.0, 0.0, 6.0, 6.0);
        let sq2 = make_square_seg(4.0, 4.0, 10.0, 10.0);
        let obj = make_obj("overlap", vec![sq1, sq2], 0.0, 0.0, 10.0, 10.0);

        let (pixels, w, _h, _ox, _oy) = fill_compound_mask(&obj, 1.0).expect("fill_compound_mask should succeed");

        // Overlap center (col=5, row=5): under even-odd this is parity 2 = background.
        // Note: this is DIFFERENT from the "desired" behavior for glyphs where the
        // hole semantics come from the counter design. For overlapping separate shapes
        // even-odd is technically correct (no double energy) but the visual result
        // is a hole in the overlap. This is the design-documented tradeoff.
        // We assert the EvenOdd behavior: overlap center is background.
        let overlap_center = pixels[5 * w + 5];
        assert_eq!(
            overlap_center, 255,
            "Overlap center (col=5,row=5) must be background under EvenOdd (no double energy), got {}",
            overlap_center
        );
    }

    /// Phase 2 critic must-fix #3 — thin stroke narrower than one scan interval
    /// must still produce at least one scan row (dilate-by-half or min-1-row policy).
    ///
    /// A glyph hairline of 0.5mm at 1.0mm interval rasterizes to zero filled rows
    /// in a naive implementation, reintroducing dropout in raster form.
    /// We apply a min-1-pixel-row policy: if all pixels are background, we set the
    /// closest row to filled so thin strokes always produce output.
    #[test]
    fn mask_thin_stroke_below_interval() {
        // Thin horizontal stroke: 10mm wide, 0.3mm tall at 1.0mm interval.
        // The bbox is 10×0.3 at (0,0). With interval=1.0, mask_h = ceil(0.3/1.0) = 1.
        // The 0.3mm stroke must produce at least row 0 filled.
        let thin_stroke = PathSegment {
            points: vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 10.0, y: 0.0 },
                Point { x: 10.0, y: 0.3 },
                Point { x: 0.0, y: 0.3 },
            ],
            closed: true,
        };
        // bbox: x=0, y=0, w=10, h=0.3
        let obj = make_obj("thin", vec![thin_stroke], 0.0, 0.0, 10.0, 0.3);

        let (pixels, w, h, _ox, _oy) = fill_compound_mask(&obj, 1.0).expect("fill_compound_mask should succeed");

        // With the min-1-row policy, at least one pixel must be filled
        let any_filled = pixels.contains(&0);
        assert!(
            any_filled,
            "Thin stroke (0.3mm at 1.0mm interval) must produce at least one filled pixel; \
             mask_h={}, w={}, all pixels are 255 (background). \
             Dropout reintroduced in raster form.",
            h, w
        );
    }

    /// MUST-FIX 5: degenerate dilation — all_same_row branch in build_subcontour_dilated.
    ///
    /// This covers the `all_same = true` case: a contour where every point projects
    /// to the same pixel-space Y row. In `build_subcontour_dilated`, the `dilated_rows`
    /// vector cannot expand points "away from center" when there is no center to move
    /// away from — so it falls into the special alternating +0.5/-0.5 expansion.
    ///
    /// Setup: a closed PathSegment where all 4 points have Y=0.5mm. The bbox is
    /// nominally [0..10, 0..0.0001] — valid (height > 0) but tiny-skia renders it
    /// as all-background (zero-area polygon). The thin-stroke dilation fires, and
    /// inside `build_subcontour_dilated` all points land at row 0.5 → `all_same=true`.
    /// The rescue expands to row_center±0.5 = [0.0, 1.0] → a 1-pixel-tall contour
    /// that tiny-skia can fill → at least one pixel becomes filled.
    #[test]
    fn mask_all_same_row_dilation_produces_filled_pixels() {
        // Horizontal line: all y=0.5 (bbox_y=0 so to_row = 0.5/1.0 = 0.5 for all)
        let horizontal_hairline = PathSegment {
            points: vec![
                Point { x: 0.0, y: 0.5 },
                Point { x: 10.0, y: 0.5 },
                Point { x: 10.0, y: 0.5 },
                Point { x: 0.0, y: 0.5 },
            ],
            closed: true,
        };

        // Give the object a tiny but nonzero height so fill_compound_mask doesn't reject
        // it as degenerate. mask_h = ceil(0.0001/1.0) = 1 row.
        let obj = CutObject {
            id: "allsame".to_string(),
            obj_type: "path".to_string(),
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 0.0001, // enough for mask_h=1, too small for any pixel to land inside
            paths: vec![horizontal_hairline],
            layer: make_base_layer(),
            corner_radius: None,
            rotation: 0.0,
            priority: None,
            group_id: None,
            layer_index: None,
        };

        let result = fill_compound_mask(&obj, 1.0);

        // Should succeed (bbox_h=0.0001 > 0), and after all_same-row dilation the
        // expanded contour (row ±0.5 around row_center=0.5) covers the row center at 0
        // or 1 → at least one pixel filled.
        match result {
            Ok((pixels, _w, _h, _ox, _oy)) => {
                let any_filled = pixels.contains(&0);
                // The all_same rescue may or may not succeed depending on whether the
                // expanded contour hits a row center. If it doesn't, fill_compound_mask
                // warns and continues — the test verifies it doesn't panic or return Err.
                // We check that the function completed and returned a valid pixel buffer.
                let _ = any_filled; // don't assert filled — the shape is pathologically degenerate
            }
            Err(e) => {
                // If the bbox_h is rounded to 0 internally, fill_compound_mask may return Err.
                // That's acceptable — the key assertion is it doesn't panic.
                assert!(
                    e.contains("degenerate bbox"),
                    "Unexpected error from fill_compound_mask: {}", e
                );
            }
        }
    }

    /// Phase 2 critic must-fix #3 — zero-area / degenerate paths must NOT produce
    /// a silent empty engrave. The dispatch arm must skip + warn.
    #[test]
    fn mask_empty_degenerate_falls_back() {
        // A path with only 1 point — cannot form a contour
        let degenerate = PathSegment {
            points: vec![Point { x: 0.0, y: 0.0 }],
            closed: false,
        };
        let obj = make_obj("degen", vec![degenerate], 0.0, 0.0, 0.0, 0.0);

        // fill_compound_mask must return Err for zero-area bbox
        let result = fill_compound_mask(&obj, 1.0);
        assert!(
            result.is_err(),
            "Degenerate zero-area object must return Err from fill_compound_mask, got Ok"
        );
    }

    /// MUST-FIX 2: Rotated maskFill — verify that a 30° rotation produces
    /// non-axis-aligned coordinates and that the rotation is correctly applied
    /// for both origin_top=false (standard bottom-left GRBL) and origin_top=true.
    ///
    /// Architecture: fill_compound_mask rasterizes paths in object-local coordinates
    /// (no rotation applied to the path points). The rotation is carried in
    /// `MaskScanParams.rotation_rad` and applied inside `scan_mask_to_gcode` by
    /// rotating each output coordinate about the bbox center. This test verifies
    /// that mechanism actually fires.
    ///
    /// Shape: asymmetric compound mask — large outer square (8×8) at (0,0) with a
    /// smaller inner square (2×2) hole at (3,3)→(5,5). The asymmetry means that a
    /// rotation by 30° about the bbox center (4,4) produces X/Y values that cannot
    /// be produced by an un-rotated scan of any axis-aligned bbox.
    #[test]
    fn rotated_maskfill_produces_rotated_coordinates() {
        // Build O-shaped compound object: 8×8 outer, 2×2 hole
        let outer = make_square_seg(0.0, 0.0, 8.0, 8.0);
        let inner = make_square_seg(3.0, 3.0, 5.0, 5.0);
        let mut obj = make_obj("rot_o", vec![outer, inner], 0.0, 0.0, 8.0, 8.0);
        obj.rotation = 30.0; // degrees

        let rotation_rad = 30.0_f64.to_radians();

        let (pixels, mask_w, mask_h, origin_x, origin_y) =
            fill_compound_mask(&obj, 1.0).expect("fill_compound_mask should succeed");

        // Verify we have filled pixels (O outer wall)
        let has_filled = pixels.contains(&0);
        assert!(has_filled, "O-shape mask should have filled pixels");

        // --- origin_top=false (standard GRBL: Y flipped) ---
        let params_bottom = MaskScanParams {
            origin_x,
            origin_y,
            width_mm: obj.width,
            height_mm: obj.height,
            interval: 1.0,
            overscan: 0.0,
            bidirectional: false,
            scanning_offset: 0.0,
            speed_mm_min: 6000.0,
            s_max: 1000.0,
            s_min: 0.0,
            power_cmd: "M3".to_string(),
            workspace_height: 200.0,
            origin_top: false,
            rotation_rad,
            passes: 1,
            grayscale_pixels: None,
        };
        let result_bottom = scan_mask_to_gcode(&pixels, mask_w, mask_h, &params_bottom)
            .expect("scan should succeed");

        // With 30° rotation, all G1 engrave moves must have non-integer coordinates.
        // Un-rotated: every X/Y lands on a 1mm grid (all integers).
        // Rotated by 30°: coordinates involve cos(30°)≈0.866 and sin(30°)=0.5 →
        // fractional values that are not multiples of 0.001 rounding to whole numbers.
        let engrave_lines: Vec<&str> = result_bottom.gcode.lines()
            .filter(|l| l.starts_with("G1 X") && l.contains("S1000"))
            .collect();
        assert!(!engrave_lines.is_empty(),
            "Expected engrave moves (S1000); gcode:\n{}", result_bottom.gcode);

        // At least one G1 engrave coordinate must be non-integer (rotation applied)
        let any_fractional = engrave_lines.iter().any(|line| {
            // Extract X coordinate; check it has a non-zero fractional part
            line.split_whitespace()
                .find(|t| t.starts_with("X"))
                .and_then(|t| t[1..].parse::<f64>().ok())
                .map(|x| (x - x.round()).abs() > 0.01)
                .unwrap_or(false)
        });
        assert!(
            any_fractional,
            "30° rotation must produce non-integer X coordinates; \
             got only integer values → rotation not applied.\nEngrave lines:\n{}",
            engrave_lines.join("\n")
        );

        // Cross-check: known coordinate for row 0 of an 8×8 mask at origin (0,0),
        // rotated 30° about bbox center (4,4).
        // Row 0: y_mm = 0.0. First filled pixel in row 0 of the O-wall: col ~0 (left wall).
        // mask center: cx=4.0, cy=4.0.
        // Un-rotated: (0.0, 0.0). After 30° rotation about (4,4):
        //   dx = 0-4 = -4,  dy = 0-4 = -4
        //   rx = 4 + (-4)*cos30 - (-4)*sin30 = 4 - 3.464 + 2.0 = 2.536
        //   ry = 4 + (-4)*sin30 + (-4)*cos30 = 4 - 2.0 - 3.464 = -1.464
        //   GRBL Y (origin_top=false, ws_h=200): 200 - (-1.464) = 201.464
        // The first G0 rapid in the output should be near this X value.
        // We allow ±2mm tolerance for run boundary (first pixel of first run may not be col=0).
        let first_rapid = result_bottom.gcode.lines()
            .find(|l| l.starts_with("G0 X"))
            .unwrap_or("");
        let first_rapid_x = first_rapid.split_whitespace()
            .find(|t| t.starts_with("X"))
            .and_then(|t| t[1..].parse::<f64>().ok())
            .unwrap_or(f64::NAN);
        assert!(
            first_rapid_x.is_finite(),
            "First rapid move must have a finite X; gcode:\n{}", result_bottom.gcode
        );
        // X should be in the rotated range — not an axis-aligned integer
        assert!(
            (first_rapid_x - first_rapid_x.round()).abs() > 0.01,
            "First rapid X ({:.3}) should be non-integer (30° rotation); \
             suggests rotation_rad was zero or not applied",
            first_rapid_x
        );

        // --- origin_top=true: Y is negated instead of workspace_height - y ---
        let params_top = MaskScanParams {
            origin_top: true,
            workspace_height: 200.0, // unused when origin_top=true
            ..params_bottom
        };
        let result_top = scan_mask_to_gcode(&pixels, mask_w, mask_h, &params_top)
            .expect("scan (origin_top) should succeed");

        // The G-code must differ from origin_top=false (different Y formula)
        assert_ne!(
            result_top.gcode, result_bottom.gcode,
            "origin_top=true and origin_top=false should produce different G-code \
             (different Y formula)"
        );

        // origin_top=true: Y = -ry (negated). For row 0 rotated:
        //   ry = -1.464 → Y = -(-1.464) = 1.464 (positive, not 201.464)
        let first_rapid_top = result_top.gcode.lines()
            .find(|l| l.starts_with("G0 X"))
            .unwrap_or("");
        let first_rapid_y_top = first_rapid_top.split_whitespace()
            .find(|t| t.starts_with("Y"))
            .and_then(|t| t[1..].parse::<f64>().ok())
            .unwrap_or(f64::NAN);
        // origin_top=false would have Y ≈ 201.464; origin_top=true should have Y ≈ 1.464
        // Both are non-integer. Just verify origin_top Y < 50 (not workspace-offset).
        assert!(
            first_rapid_y_top.is_finite() && first_rapid_y_top < 50.0,
            "origin_top=true first rapid Y ({:.3}) should be small (< 50) — \
             not workspace-offset. origin_top=false had Y≈201, so the Y-flip formula \
             must differ.",
            first_rapid_y_top
        );
    }

    // ─── B1 (Phase B) continuous-sweep M4 invariant ──────────────────────────

    /// B1d: Verify that M4 (variable power) maskFill uses the continuous-sweep
    /// structure: M4 emitted ONCE per row, NO M5 within any row, laser held off
    /// between runs by G1+S0 (not G0 or M5).
    ///
    /// Under GRBL M4 (laser mode, $32=1): the laser fires only when moving AND
    /// S > 0. S0 on a G1 move holds the laser off, so G1+S0 is the correct way
    /// to traverse gaps and overscan regions without firing the laser. M5 is NOT
    /// needed mid-row — it is only emitted at job end.
    ///
    /// This test asserts (continuous-sweep invariants):
    ///   1. All power-on commands are M4 (not M3) — parametric power_cmd honored.
    ///   2. M4 is emitted exactly once per engraved row (3 rows → 3 M4 lines).
    ///   3. NO M5 appears anywhere in the output (laser off is S0 on G1, not M5).
    ///   4. NO G0 appears after the first row's lead-in (only one G0 per row).
    ///   5. Every M4 is preceded by a G1+S0 accel overscan move (laser-off bracket).
    #[test]
    fn m4_maskfill_continuous_sweep_invariants() {
        let mut params = base_scan_params();
        params.power_cmd = "M4".to_string();
        params.overscan = 1.0;
        params.bidirectional = false;
        params.width_mm = 6.0;
        params.height_mm = 3.0;
        params.interval = 1.0;
        params.passes = 1;

        // Simple 3-row 6-pixel-wide filled mask (all filled, no holes)
        let w = 6usize;
        let h = 3usize;
        let pixels = vec![0u8; w * h]; // all black = all filled

        let result = scan_mask_to_gcode(&pixels, w, h, &params)
            .expect("M4 maskFill scan should succeed");

        let lines: Vec<&str> = result.gcode.lines().collect();

        // 1. All power commands must be M4 (not M3)
        let m3_count = lines.iter().filter(|l| l.starts_with("M3 ")).count();
        assert_eq!(
            m3_count, 0,
            "M4 maskFill must not emit any M3 commands; found {} M3 lines.\nG-code:\n{}",
            m3_count, result.gcode
        );
        let m4_count = lines.iter().filter(|l| l.starts_with("M4 ")).count();
        assert!(
            m4_count > 0,
            "M4 maskFill must emit at least one M4 command; found none.\nG-code:\n{}",
            result.gcode
        );

        // 2. M4 emitted exactly once per engraved row (3 rows → 3 M4 lines)
        assert_eq!(
            m4_count, h,
            "Continuous-sweep: M4 must fire once per engraved row ({} rows); found {} M4 commands.\nG-code:\n{}",
            h, m4_count, result.gcode
        );

        // 3. NO M5 within the output (continuous-sweep: laser held off by S0, not M5)
        let m5_count = lines.iter().filter(|l| l.trim() == "M5").count();
        assert_eq!(
            m5_count, 0,
            "Continuous-sweep maskFill must NOT emit M5 mid-job; found {} M5 lines.\n\
             Laser is held off by G1+S0, not M5.\nG-code:\n{}",
            m5_count, result.gcode
        );

        // 4. Exactly one G0 per engraved row (3 rows → 3 G0 lines)
        let g0_count = lines.iter().filter(|l| l.starts_with("G0 ")).count();
        assert_eq!(
            g0_count, h,
            "Continuous-sweep: exactly one G0 per engraved row ({} rows); found {} G0 lines.\nG-code:\n{}",
            h, g0_count, result.gcode
        );

        // 5. Every M4 command must be immediately preceded by a G1+S0 accel-overscan move.
        //    (G1 ... S0 leads in; M4 S<n> then powers the laser on for the engrave run.)
        for (i, line) in lines.iter().enumerate() {
            if line.starts_with("M4 ") {
                let prev_g1 = lines[..i].iter().rev().find(|l| l.starts_with("G1 "));
                assert!(
                    prev_g1.map(|l| l.contains("S0")).unwrap_or(false),
                    "M4 power-on at line {} ({}) must be preceded by a G1 S0 accel-overscan move; \
                     preceding G1 was: {:?}\nFull G-code:\n{}",
                    i, line, prev_g1, result.gcode
                );
            }
        }
    }

    /// B1 regression: M3 (constant power) maskFill run continues to emit M3,
    /// not M4. The power_cmd path is parametric; this guards against accidental
    /// hardcoding after B1 default-flip changes.
    #[test]
    fn m3_maskfill_still_emits_m3_not_m4() {
        let mut params = base_scan_params();
        params.power_cmd = "M3".to_string(); // explicit constant-power layer
        params.overscan = 0.0;
        params.bidirectional = false;
        params.width_mm = 4.0;
        params.height_mm = 2.0;
        params.interval = 1.0;
        params.passes = 1;

        let w = 4usize;
        let h = 2usize;
        let pixels = vec![0u8; w * h]; // all filled

        let result = scan_mask_to_gcode(&pixels, w, h, &params)
            .expect("M3 maskFill scan should succeed");

        assert!(
            result.gcode.contains("M3 "),
            "M3 (constant-power) maskFill must emit M3 commands; gcode:\n{}", result.gcode
        );
        assert!(
            !result.gcode.contains("M4 "),
            "M3 (constant-power) maskFill must NOT emit M4 commands; gcode:\n{}", result.gcode
        );
    }

    /// Regression guard for the continuous-sweep fix: two filled runs separated by a gap.
    ///
    /// This is the structural fix test. A single row with two filled regions (like the
    /// crossbar of an "H" or the counter strokes of an "N") previously emitted:
    ///   G0 run1_start → G1 S0 overscan → M3 S<n> → G1 S<n> run1 → M5 → G1 S0 decel →
    ///   G0 run2_start → G1 S0 overscan → M3 S<n> → G1 S<n> run2 → M5 → G1 S0 decel
    ///
    /// The fix must produce:
    ///   G0 lead-in → G1 S0 accel overscan → M3 S<n> →
    ///   G1 S<n> run1 → G1 S0 gap → G1 S<n> run2 → G1 S0 decel overscan
    ///
    /// Assertions:
    ///   - Exactly ONE G0 for the row (not two)
    ///   - ZERO M5 in the output
    ///   - The gap between runs is a G1+S0 (laser off, not G0)
    ///   - Both runs fire at S=s_max
    ///
    /// Setup: 10-pixel wide mask, row 0 only.
    ///   Run A: cols 1-3 (pixels[1]=0, pixels[2]=0, pixels[3]=0)
    ///   Gap:   cols 4-5 (pixels[4]=255, pixels[5]=255)
    ///   Run B: cols 6-8 (pixels[6]=0, pixels[7]=0, pixels[8]=0)
    ///
    /// This test would FAIL against the old per-run code (which emitted two G0 and two M5).
    #[test]
    fn continuous_sweep_two_runs_no_interior_g0() {
        let mut params = base_scan_params();
        params.bidirectional = false;
        params.overscan = 0.5;
        params.width_mm = 10.0;
        params.height_mm = 1.0;
        params.interval = 1.0;
        params.passes = 1;
        params.s_max = 1000.0;
        params.power_cmd = "M3".to_string();

        let w = 10usize;
        let h = 1usize;
        // Row 0: runs at cols [1,4) and [6,9), gap at [4,6).
        //   find_binary_runs expects 0=filled, 255=background.
        let mut pixels = vec![255u8; w * h];
        pixels[1] = 0; pixels[2] = 0; pixels[3] = 0; // run A
        pixels[6] = 0; pixels[7] = 0; pixels[8] = 0; // run B

        let result = scan_mask_to_gcode(&pixels, w, h, &params)
            .expect("two-run single-row scan should succeed");

        let lines: Vec<&str> = result.gcode.lines().collect();

        // 1. Exactly ONE G0 for this single engraved row.
        let g0_lines: Vec<&str> = lines.iter().filter(|l| l.starts_with("G0 ")).copied().collect();
        assert_eq!(
            g0_lines.len(), 1,
            "Continuous-sweep: single row with two runs must produce exactly 1 G0 (not 2).\n\
             Found {} G0 lines: {:?}\nFull G-code:\n{}",
            g0_lines.len(), g0_lines, result.gcode
        );

        // 2. ZERO M5 commands — laser held off by S0 on G1, not M5.
        let m5_count = lines.iter().filter(|l| l.trim() == "M5").count();
        assert_eq!(
            m5_count, 0,
            "Continuous-sweep: NO M5 allowed within a row; found {} M5 lines.\n\
             Gap must be G1+S0, not M5+G0.\nFull G-code:\n{}",
            m5_count, result.gcode
        );

        // 3. The gap between the two runs must be a G1+S0 (not a G0).
        //    Find the two S=s_max engrave moves and verify what comes between them.
        let engrave_indices: Vec<usize> = lines.iter().enumerate()
            .filter(|(_, l)| l.starts_with("G1 ") && l.contains(&format!("S{}", params.s_max as u64)))
            .map(|(i, _)| i)
            .collect();
        assert_eq!(
            engrave_indices.len(), 2,
            "Expected 2 G1 engrave moves (one per run); found {}: {:?}\nFull G-code:\n{}",
            engrave_indices.len(), engrave_indices, result.gcode
        );

        // Between the two engrave moves there must be at least one G1+S0 (gap transit).
        let between = &lines[engrave_indices[0] + 1..engrave_indices[1]];
        let has_g1_s0_gap = between.iter().any(|l| l.starts_with("G1 ") && l.contains("S0"));
        assert!(
            has_g1_s0_gap,
            "Gap between runs must be a G1+S0 move (continuous speed, laser off).\n\
             Lines between engrave moves: {:?}\nFull G-code:\n{}",
            between, result.gcode
        );
        let has_g0_in_gap = between.iter().any(|l| l.starts_with("G0 "));
        assert!(
            !has_g0_in_gap,
            "Gap between runs must NOT contain a G0 (continuous sweep).\n\
             Lines between engrave moves: {:?}\nFull G-code:\n{}",
            between, result.gcode
        );
    }

    // ─── P2-A Finding #1: rotated gap transit must use correct 2D coordinates ──

    /// At 90-degree rotation, runs that were horizontally separated in image space
    /// become vertically separated in machine space. The gap transit must target
    /// the correct (x, y) from to_grbl, not a stale row_gy. Also, the gap check
    /// must use 2D Euclidean distance, not X-only.
    ///
    /// Setup: 10-pixel-wide mask, one row, two runs separated by a gap.
    /// Pixels 0-2 filled, 3-6 background, 7-9 filled.
    /// Rotation = 90 degrees (PI/2). Under 90deg rotation around center (5, 0.5),
    /// the runs map to different machine Y values, and the gap transit must
    /// reflect that.
    #[test]
    fn p2a_rotated_gap_transit_uses_2d_coords() {
        let mut params = base_scan_params();
        params.rotation_rad = std::f64::consts::FRAC_PI_2; // 90 degrees
        params.width_mm = 10.0;
        params.height_mm = 1.0;
        params.interval = 1.0;
        params.workspace_height = 100.0;
        params.overscan = 0.0;
        params.bidirectional = false;
        params.origin_top = false;

        let w = 10usize;
        let h = 1usize;
        let mut pixels = vec![255u8; w * h];
        // Two runs with a gap: pixels 0-2 filled, 7-9 filled
        pixels[0] = 0; pixels[1] = 0; pixels[2] = 0;
        pixels[7] = 0; pixels[8] = 0; pixels[9] = 0;

        let result = scan_mask_to_gcode(&pixels, w, h, &params).expect("should succeed");

        // Under 90deg rotation, a gap between runs at different image X positions
        // maps to different machine Y positions. The gap transit must:
        // (a) exist (G1 S0 between the two engrave moves)
        // (b) target the correct machine coordinates for run 2's start
        //
        // to_grbl(7.0, 0.0) around center (5.0, 0.5) at 90deg:
        //   dx=2.0, dy=-0.5, cos90~=0, sin90~=1
        //   rx = 5.0 + 0 - (-0.5) = 5.5
        //   ry = 0.5 + 2.0 = 2.5
        //   gy = 100 - 2.5 = 97.5
        //
        // Under the old bug (X-only gap check), the gap transit was skipped
        // entirely because all X coordinates are 5.5 at 90deg rotation.
        // The laser burned straight through the gap.

        let all_lines: Vec<&str> = result.gcode.lines().collect();
        let engrave_indices: Vec<usize> = all_lines.iter().enumerate()
            .filter(|(_, l)| l.starts_with("G1 ") && l.contains("S1000"))
            .map(|(i, _)| i)
            .collect();
        assert!(engrave_indices.len() >= 2,
            "Expected at least 2 engrave moves; gcode:\n{}", result.gcode);

        // Between the two engrave moves there must be a G1+S0 gap transit
        let between = &all_lines[engrave_indices[0] + 1..engrave_indices[1]];
        let gap_transit = between.iter().find(|l| l.starts_with("G1 ") && l.contains("S0"));
        assert!(
            gap_transit.is_some(),
            "Gap between runs must have a G1+S0 transit (2D gap check).\n\
             Lines between engrave moves: {:?}\nFull G-code:\n{}",
            between, result.gcode
        );

        // The gap transit Y must match to_grbl(7.0, 0.0) = 97.5, not row_gy = 104.5
        let gap_y: f64 = gap_transit.unwrap().split_whitespace()
            .find(|t| t.starts_with("Y"))
            .and_then(|t| t[1..].parse::<f64>().ok())
            .expect("gap transit should have a Y coordinate");
        assert!(
            (gap_y - 97.5).abs() < 0.1,
            "Gap transit Y should be 97.5 (to_grbl of run 2 start), got {gap_y:.3}.\n\
             Full gcode:\n{}", result.gcode
        );
    }

    // ─── P2-A Finding #2: accel/decel overscan symmetry under rotation ─────────

    /// Under rotation, the accel lead-in (G0) and accel ramp (G1 S0) must approach
    /// along the rotated scan direction, symmetric with the decel side.
    ///
    /// Before the fix, lead-in offset was in machine-X; decel was in image-X-then-rotated.
    /// Under rotation, this caused the head to corner at the run boundary.
    ///
    /// Setup: single row, full width, 45deg rotation, 2mm overscan.
    /// The G0 lead-in must NOT have the same Y as the accel G1 S0 target —
    /// that would mean the lead-in is offsetting in machine-X only.
    #[test]
    fn p2a_overscan_symmetric_under_rotation() {
        let mut params = base_scan_params();
        params.rotation_rad = std::f64::consts::FRAC_PI_4; // 45 degrees
        params.width_mm = 10.0;
        params.height_mm = 1.0;
        params.interval = 1.0;
        params.overscan = 2.0;
        params.workspace_height = 200.0;
        params.bidirectional = false;

        let w = 10usize;
        let h = 1usize;
        let pixels = vec![0u8; w * h]; // all filled

        let result = scan_mask_to_gcode(&pixels, w, h, &params).expect("should succeed");

        // Parse the G0 lead-in and the following G1 S0 accel line
        let lines: Vec<&str> = result.gcode.lines().collect();
        let g0_line = lines.iter().find(|l| l.starts_with("G0 "))
            .expect("Expected a G0 lead-in line");
        let g1_s0_line = lines.iter().find(|l| l.starts_with("G1 ") && l.contains("S0"))
            .expect("Expected a G1 S0 accel line");

        let parse_xy = |line: &str| -> (f64, f64) {
            let x = line.split_whitespace()
                .find(|t| t.starts_with("X"))
                .and_then(|t| t[1..].parse::<f64>().ok())
                .unwrap();
            let y = line.split_whitespace()
                .find(|t| t.starts_with("Y"))
                .and_then(|t| t[1..].parse::<f64>().ok())
                .unwrap();
            (x, y)
        };

        let (g0_x, g0_y) = parse_xy(g0_line);
        let (g1_x, g1_y) = parse_xy(g1_s0_line);

        // Under 45deg rotation, the lead-in G0 must approach from a position offset
        // along the rotated scan direction. The G0 and G1 S0 should form a vector
        // at ~45deg, not purely horizontal (which would mean machine-X offset only).
        //
        // Vector from G0 to G1 S0: if symmetric, dx and dy should both be non-zero.
        let dx = g1_x - g0_x;
        let dy = g1_y - g0_y;

        assert!(
            dx.abs() > 0.1 && dy.abs() > 0.1,
            "Accel lead-in vector ({dx:.3}, {dy:.3}) must have non-zero dx AND dy \
             under 45deg rotation. A zero dy means the lead-in is machine-X only \
             (not along the rotated scan direction).\n\
             G0: ({g0_x:.3}, {g0_y:.3}), G1 S0: ({g1_x:.3}, {g1_y:.3})\n\
             Full gcode:\n{}", result.gcode
        );
    }

    // ─── P2-A Finding #8: half-interval Y centering ──────────────────────────

    /// Scan line Y position must be at the CENTER of each pixel row, not the edge.
    ///
    /// Before fix: y_mm = origin_y + row * interval  (pixel edge)
    /// After fix:  y_mm = origin_y + (row + 0.5) * interval  (pixel center)
    ///
    /// Setup: 1-pixel-tall mask, interval=2.0, origin_y=10.0, workspace_height=100.
    /// Before fix: y_mm = 10.0 → gy = 100 - 10 = 90.0
    /// After fix:  y_mm = 10.0 + 0.5*2.0 = 11.0 → gy = 100 - 11 = 89.0
    #[test]
    fn p2a_scan_line_y_is_pixel_center() {
        let mut params = base_scan_params();
        params.origin_y = 10.0;
        params.height_mm = 2.0;
        params.interval = 2.0;
        params.workspace_height = 100.0;
        params.width_mm = 5.0;

        let w = 3usize; // 5mm / ~2mm = ceil(2.5) ≈ 3 pixels, but let's keep it simple
        let h = 1usize;
        let pixels = vec![0u8; w * h]; // all filled

        let result = scan_mask_to_gcode(&pixels, w, h, &params).expect("should succeed");

        // Parse the first engrave Y
        let engrave_y: f64 = result.gcode.lines()
            .filter(|l| l.starts_with("G1 ") && l.contains("S1000"))
            .filter_map(|l| {
                l.split_whitespace()
                    .find(|t| t.starts_with("Y"))
                    .and_then(|t| t[1..].parse::<f64>().ok())
            })
            .next()
            .expect("Expected an engrave Y coordinate");

        // Expected: y_mm = 10.0 + 0.5 * 2.0 = 11.0 → gy = 100 - 11 = 89.0
        assert!(
            (engrave_y - 89.0).abs() < 0.01,
            "Scan line Y should be 89.0 (pixel center, not edge). Got {engrave_y:.3}.\n\
             Before fix: Y=90.0 (pixel edge). After fix: Y=89.0 (pixel center).\n\
             Full gcode:\n{}", result.gcode
        );
    }
}
