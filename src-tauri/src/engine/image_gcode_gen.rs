/// Image engraving G-code generator
///
/// Pipeline: decode base64 -> grayscale -> resize to DPI -> adjust -> dither -> scan-line G-code
///
/// Uses a separate Tauri command from vector G-code because:
/// - Image data is fundamentally different from vector paths
/// - Image processing is CPU-heavy (needs spawn_blocking)
/// - Keeps the vector pipeline clean

use base64::Engine;
use image::imageops::FilterType;
use serde::{Deserialize, Serialize};

use crate::engine::dither::{DitherAlgorithm, dither_image};
use crate::engine::gcode_gen::{GcodeMove, GcodeResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageEngraveRequest {
    pub image_data: String,     // base64 encoded (may include data:image/...;base64, prefix)
    pub x: f64,                 // position mm
    pub y: f64,
    pub width: f64,             // size mm
    pub height: f64,
    pub rotation: f64,          // degrees (unused for now -- images engrave axis-aligned)
    pub power: f64,             // 0-100
    pub power_min: f64,         // 0-100
    pub speed: f64,             // mm/s
    pub passes: u32,
    pub power_mode: String,     // "constant" or "variable"
    pub interval: f64,          // mm (DPI = 25.4 / interval)
    pub dither: String,         // algorithm name
    pub overscan: f64,          // mm
    pub bidirectional: bool,
    pub scanning_offset: f64,   // mm
    pub brightness: f64,        // -100 to 100
    pub contrast: f64,          // -100 to 100
    pub gamma: f64,             // 0.1 to 5.0
    pub invert: bool,
    pub workspace_height: f64,  // for Y-flip
}

/// Generate G-code from an image engraving request
pub fn generate(req: &ImageEngraveRequest) -> Result<GcodeResult, String> {
    // 1. Decode base64 image
    let image_bytes = decode_base64(&req.image_data)?;
    let img = image::load_from_memory(&image_bytes)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    // 2. Convert to grayscale
    let gray = img.to_luma8();

    // 3. Resize to target DPI
    let interval = if req.interval > 0.0 { req.interval } else { 0.1 };
    let target_w = (req.width / interval).round().max(1.0) as u32;
    let target_h = (req.height / interval).round().max(1.0) as u32;
    let resized = image::imageops::resize(&gray, target_w, target_h, FilterType::Lanczos3);

    // 4. Apply adjustments
    let mut pixels: Vec<u8> = resized.into_raw();
    apply_adjustments(&mut pixels, req.brightness, req.contrast, req.gamma, req.invert);

    // 5. Dither
    let algorithm = DitherAlgorithm::from_str(&req.dither);
    let dithered = dither_image(&pixels, target_w, target_h, algorithm, 128);

    // 6. Generate scan-line G-code
    let is_grayscale = algorithm == DitherAlgorithm::Grayscale;
    generate_scan_gcode(req, &dithered, target_w, target_h, is_grayscale)
}

/// Strip data URI prefix and decode base64
fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
    let b64 = if let Some(idx) = data.find(",") {
        &data[idx + 1..]
    } else {
        data
    };
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Base64 decode error: {}", e))
}

/// Apply brightness, contrast, gamma, and invert adjustments to pixel data
fn apply_adjustments(pixels: &mut [u8], brightness: f64, contrast: f64, gamma: f64, invert: bool) {
    let brightness_offset = brightness * 2.55; // scale -100..100 to -255..255
    let contrast_factor = if contrast >= 0.0 {
        (100.0 + contrast) / 100.0
    } else {
        (100.0 + contrast) / 100.0
    };
    // contrast_factor: 0.0 (at -100) to 2.0 (at +100)
    let contrast_factor = contrast_factor.max(0.0);
    let gamma_inv = if gamma > 0.0 { 1.0 / gamma } else { 1.0 };

    // Build lookup table for performance (256 entries)
    let mut lut = [0u8; 256];
    for i in 0..256 {
        let mut v = i as f64;

        // Brightness
        v += brightness_offset;

        // Contrast (around midpoint 128)
        v = (v - 128.0) * contrast_factor + 128.0;

        // Gamma
        v = (v / 255.0).clamp(0.0, 1.0).powf(gamma_inv) * 255.0;

        // Invert
        if invert {
            v = 255.0 - v;
        }

        lut[i] = v.round().clamp(0.0, 255.0) as u8;
    }

    for pixel in pixels.iter_mut() {
        *pixel = lut[*pixel as usize];
    }
}

/// Generate scan-line G-code from dithered pixel data
fn generate_scan_gcode(
    req: &ImageEngraveRequest,
    pixels: &[u8],
    width: u32,
    height: u32,
    is_grayscale: bool,
) -> Result<GcodeResult, String> {
    let mut lines: Vec<String> = Vec::new();
    let mut moves: Vec<GcodeMove> = Vec::new();
    let mut cut_distance = 0.0_f64;
    let mut travel_distance = 0.0_f64;
    let mut total_distance = 0.0_f64;
    let mut cur_x = 0.0_f64;
    let mut cur_y = 0.0_f64;

    let speed_mm_min = req.speed * 60.0;
    let s_max = (req.power / 100.0 * 1000.0).round();
    let s_min = (req.power_min / 100.0 * 1000.0).round();
    let power_cmd = if req.power_mode == "variable" || is_grayscale { "M4" } else { "M3" };
    let interval = if req.interval > 0.0 { req.interval } else { 0.1 };
    let overscan = req.overscan.max(0.0);

    let w = width as usize;
    let h = height as usize;

    lines.push(format!("; Image engrave: {}x{} px, interval {}mm", width, height, interval));

    for pass in 0..req.passes {
        if req.passes > 1 {
            lines.push(format!("; Pass {}/{}", pass + 1, req.passes));
        }

        let mut forward = true;

        for row in 0..h {
            let y_mm = req.y + row as f64 * interval;
            let gy = req.workspace_height - y_mm; // Y-flip for GRBL

            // Find runs of "on" pixels in this row
            let row_start = row * w;
            let row_pixels = &pixels[row_start..row_start + w];

            let runs = if is_grayscale {
                // For grayscale, find runs of non-white pixels (< 255 means some engraving)
                find_grayscale_runs(row_pixels)
            } else {
                // For binary dithering, find runs of black pixels (0)
                find_binary_runs(row_pixels)
            };

            if runs.is_empty() {
                continue;
            }

            // Process runs in forward or reverse order based on bidirectional setting
            let ordered_runs: Vec<(usize, usize, Option<&[u8]>)> = if forward {
                runs.iter().map(|&(start, end)| {
                    if is_grayscale {
                        (start, end, Some(&row_pixels[start..end]))
                    } else {
                        (start, end, None)
                    }
                }).collect()
            } else {
                runs.iter().rev().map(|&(start, end)| {
                    if is_grayscale {
                        (end, start, Some(&row_pixels[start..end]))
                    } else {
                        (end, start, None)
                    }
                }).collect()
            };

            for (run_start, run_end, gray_data) in &ordered_runs {
                let offset = if !forward { req.scanning_offset } else { 0.0 };

                // Convert pixel positions to mm
                let x_start = req.x + *run_start as f64 * interval + offset;
                let x_end = req.x + *run_end as f64 * interval + offset;

                // Overscan approach
                let os_start = if forward { x_start - overscan } else { x_start + overscan };

                // Rapid to overscan start
                let dist = ((os_start - cur_x).powi(2) + (gy - cur_y).powi(2)).sqrt();
                travel_distance += dist;
                total_distance += dist;
                lines.push(format!("G0 X{:.3} Y{:.3}", os_start, gy));
                moves.push(GcodeMove { x: os_start, y: gy, move_type: "rapid".to_string(), speed: 3000.0, power: 0.0 });

                // Accelerate through overscan zone
                if overscan > 0.0 {
                    travel_distance += overscan;
                    total_distance += overscan;
                    lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S0", x_start, gy, speed_mm_min));
                    moves.push(GcodeMove { x: x_start, y: gy, move_type: "rapid".to_string(), speed: speed_mm_min, power: 0.0 });
                }

                // Engrave the run
                if is_grayscale {
                    // Variable power: emit segments with varying S values
                    if let Some(data) = gray_data {
                        let run_forward = run_end > run_start;
                        let pixel_iter: Box<dyn Iterator<Item = &u8>> = if run_forward {
                            Box::new(data.iter())
                        } else {
                            Box::new(data.iter().rev())
                        };

                        lines.push(format!("{} S0", power_cmd));

                        for (i, &pixel) in pixel_iter.enumerate() {
                            // Map pixel brightness to laser power
                            // 0 = full power (black = engrave), 255 = no power (white = skip)
                            let s_val = if pixel == 255 {
                                0.0
                            } else {
                                let fraction = (255 - pixel) as f64 / 255.0;
                                s_min + fraction * (s_max - s_min)
                            };

                            let px = if run_forward {
                                req.x + (*run_start + i + 1) as f64 * interval + offset
                            } else {
                                req.x + (*run_end as i64 - i as i64 - 1).max(0) as f64 * interval + offset
                            };

                            let d = interval;
                            cut_distance += d;
                            total_distance += d;
                            lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{:.0}", px, gy, speed_mm_min, s_val));
                            moves.push(GcodeMove { x: px, y: gy, move_type: "engrave".to_string(), speed: speed_mm_min, power: s_val });
                        }
                        lines.push("M5".to_string());
                    }
                } else {
                    // Binary: single engrave line at full power
                    lines.push(format!("{} S{}", power_cmd, s_max));
                    let scan_dist = (x_end - x_start).abs();
                    cut_distance += scan_dist;
                    total_distance += scan_dist;
                    lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S{}", x_end, gy, speed_mm_min, s_max));
                    moves.push(GcodeMove { x: x_end, y: gy, move_type: "engrave".to_string(), speed: speed_mm_min, power: s_max });
                    lines.push("M5".to_string());
                }

                // Deceleration overscan
                if overscan > 0.0 {
                    let os_end = if forward { x_end + overscan } else { x_end - overscan };
                    travel_distance += overscan;
                    total_distance += overscan;
                    lines.push(format!("G1 X{:.3} Y{:.3} F{:.0} S0", os_end, gy, speed_mm_min));
                    moves.push(GcodeMove { x: os_end, y: gy, move_type: "rapid".to_string(), speed: speed_mm_min, power: 0.0 });
                    cur_x = os_end;
                } else {
                    cur_x = x_end;
                }
                cur_y = gy;
            }

            if req.bidirectional {
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
        estimated_time_secs: estimate_simple_time(&cut_distance, &travel_distance, req.speed),
        line_count: lines.len(),
    })
}

/// Find runs of black pixels (value == 0) in a row
fn find_binary_runs(row: &[u8]) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let mut i = 0;
    while i < row.len() {
        if row[i] == 0 {
            let start = i;
            while i < row.len() && row[i] == 0 {
                i += 1;
            }
            runs.push((start, i));
        } else {
            i += 1;
        }
    }
    runs
}

/// Find runs of non-white pixels (value < 255) in a row for grayscale mode
fn find_grayscale_runs(row: &[u8]) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let mut i = 0;
    while i < row.len() {
        if row[i] < 255 {
            let start = i;
            while i < row.len() && row[i] < 255 {
                i += 1;
            }
            runs.push((start, i));
        } else {
            i += 1;
        }
    }
    runs
}

/// Simple time estimate based on distances and speeds
fn estimate_simple_time(cut_dist: &f64, travel_dist: &f64, speed_mm_s: f64) -> f64 {
    let rapid_speed = 50.0; // mm/s assumed rapid speed
    let cut_time = cut_dist / speed_mm_s;
    let travel_time = travel_dist / rapid_speed;
    cut_time + travel_time
}
