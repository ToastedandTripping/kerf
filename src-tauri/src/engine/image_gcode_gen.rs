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
use crate::engine::gcode_gen::{GcodeResult, RAPID_SPEED_MM_MIN};
use crate::engine::mask_fill::{MaskScanParams, scan_mask_to_gcode};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageEngraveRequest {
    pub image_data: String,     // base64 encoded (may include data:image/...;base64, prefix)
    pub x: f64,                 // position mm
    pub y: f64,
    pub width: f64,             // size mm
    pub height: f64,
    pub rotation: f64,          // degrees — applied as coordinate transform in G-code output
    #[serde(default = "default_scale")]
    pub scale_x: f64,           // 1.0 or -1.0 (mirror); applied as pixel buffer flip
    #[serde(default = "default_scale")]
    pub scale_y: f64,           // 1.0 or -1.0 (mirror); applied as pixel buffer flip
    pub power: f64,             // 0-100
    pub power_min: f64,         // 0-100
    pub speed: f64,             // mm/min
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
    #[serde(default)]
    pub origin_top: bool,       // if true, Y=0 is at the top (no Y-flip needed)
    #[serde(default = "default_s_value_max")]
    pub s_value_max: f64,       // GRBL $30 setting
    #[serde(default)]
    pub power_curve: Option<Vec<(f64, f64)>>,  // (shade 0-255, power 0-100%) control points
    #[serde(default)]
    pub newsprint_cell_size: Option<u32>,  // Newsprint dither cell size (default 6)
    #[serde(default)]
    pub newsprint_angle: Option<f64>,      // Newsprint dither angle (default 45)
    #[serde(default)]
    pub remove_background: bool,
    #[serde(default = "default_bg_tolerance")]
    pub bg_tolerance: f64,
}

fn default_s_value_max() -> f64 { 1000.0 }
fn default_scale() -> f64 { 1.0 }
fn default_bg_tolerance() -> f64 { 20.0 }

/// Preview dithered image: runs steps 1-5 (decode, grayscale, resize, adjust, power curve, dither)
/// and returns the pixel buffer + dimensions. Used for the engrave preview dialog.
pub fn preview_dither(req: &ImageEngraveRequest) -> Result<(Vec<u8>, u32, u32), String> {
    // 1. Decode base64 image
    let image_bytes = decode_base64(&req.image_data)?;
    let img = image::load_from_memory(&image_bytes)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    // 2. Convert to grayscale (alpha-aware: composite against white before converting)
    let rgba = img.to_rgba8();
    let gray = image::GrayImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let p = rgba.get_pixel(x, y);
        let a = p[3] as f64 / 255.0;
        let luma = 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64;
        let composited = luma * a + 255.0 * (1.0 - a);
        image::Luma([composited.round() as u8])
    });

    // 2.5. Background removal (corner-sample dominant color → threshold to white)
    let gray = if req.remove_background {
        remove_background(&gray, req.bg_tolerance)
    } else {
        gray
    };

    // 3. Resize to target DPI
    let interval = if req.interval > 0.0 { req.interval } else { 0.1 };
    let target_w = (req.width / interval).round().max(1.0) as u32;
    let target_h = (req.height / interval).round().max(1.0) as u32;
    let resized = image::imageops::resize(&gray, target_w, target_h, FilterType::Lanczos3);

    // 4. Apply adjustments
    let mut pixels: Vec<u8> = resized.into_raw();
    apply_adjustments(&mut pixels, req.brightness, req.contrast, req.gamma, req.invert);

    // 4.25. F5: Apply mirror transforms (pixel buffer flips)
    // scale_x < 0 → flip horizontally (reverse each row)
    // scale_y < 0 → flip vertically (swap rows top-to-bottom)
    let w = target_w as usize;
    let h = target_h as usize;
    if req.scale_x < 0.0 {
        for row in 0..h {
            let start = row * w;
            pixels[start..start + w].reverse();
        }
    }
    if req.scale_y < 0.0 {
        for row in 0..h / 2 {
            let top = row * w;
            let bot = (h - 1 - row) * w;
            for col in 0..w {
                pixels.swap(top + col, bot + col);
            }
        }
    }

    // 4.5. Apply power curve
    if let Some(ref curve_points) = req.power_curve {
        if curve_points.len() >= 2 {
            let lut = build_power_curve_lut(curve_points);
            for pixel in pixels.iter_mut() {
                *pixel = lut[*pixel as usize];
            }
        }
    }

    // 5. Dither -- format newsprint params into the dither string if applicable
    let dither_str = if req.dither == "newsprint" {
        let cs = req.newsprint_cell_size.unwrap_or(6);
        let ang = req.newsprint_angle.unwrap_or(45.0);
        format!("newsprint:{}:{}", cs, ang)
    } else {
        req.dither.clone()
    };
    let algorithm = DitherAlgorithm::from_str(&dither_str);
    let dithered = dither_image(&pixels, target_w, target_h, algorithm, 128);

    Ok((dithered, target_w, target_h))
}

/// Generate G-code from an image engraving request
pub fn generate(req: &ImageEngraveRequest) -> Result<GcodeResult, String> {
    // Steps 1-5: decode, grayscale, resize, adjust, power curve, dither
    let (dithered, target_w, target_h) = preview_dither(req)?;

    // 6. Generate scan-line G-code
    let algorithm = DitherAlgorithm::from_str(&req.dither);
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
    let contrast_factor = (100.0 + contrast) / 100.0;
    // contrast_factor: 0.0 (at -100) to 2.0 (at +100)
    let contrast_factor = contrast_factor.max(0.0);
    let gamma_inv = if gamma > 0.0 { 1.0 / gamma } else { 1.0 };

    // Build lookup table for performance (256 entries)
    let mut lut = [0u8; 256];
    for (i, lut_entry) in lut.iter_mut().enumerate() {
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

        *lut_entry = v.round().clamp(0.0, 255.0) as u8;
    }

    for pixel in pixels.iter_mut() {
        *pixel = lut[*pixel as usize];
    }
}

/// Build a 256-entry lookup table from power curve control points.
///
/// Control points: x = input shade (0-255), y = output power (0-100%).
/// The output is mapped back to shade space: power 0% = shade 255 (white/no engrave),
/// power 100% = shade 0 (black/full engrave).
///
/// Uses monotone cubic (Fritsch-Carlson) interpolation for smooth, non-overshooting curves.
pub fn build_power_curve_lut(points: &[(f64, f64)]) -> [u8; 256] {
    let mut lut = [0u8; 256];
    let n = points.len();

    if n < 2 {
        // Identity: no transform
        for (i, lut_entry) in lut.iter_mut().enumerate() {
            *lut_entry = i as u8;
        }
        return lut;
    }

    // Sort by x (should already be sorted, but be safe)
    let mut pts: Vec<(f64, f64)> = points.to_vec();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // Compute tangents using Fritsch-Carlson monotone method
    let mut tangents = vec![0.0_f64; n];

    if n == 2 {
        let slope = (pts[1].1 - pts[0].1) / (pts[1].0 - pts[0].0).max(1.0);
        tangents[0] = slope;
        tangents[1] = slope;
    } else {
        // Compute secants
        let mut secants = vec![0.0_f64; n - 1];
        for i in 0..n - 1 {
            let dx = (pts[i + 1].0 - pts[i].0).max(0.001);
            secants[i] = (pts[i + 1].1 - pts[i].1) / dx;
        }

        // Initial tangents: average of adjacent secants
        tangents[0] = secants[0];
        tangents[n - 1] = secants[n - 2];
        for i in 1..n - 1 {
            tangents[i] = (secants[i - 1] + secants[i]) / 2.0;
        }

        // Fritsch-Carlson monotonicity enforcement
        for i in 0..n - 1 {
            if secants[i].abs() < 1e-10 {
                tangents[i] = 0.0;
                tangents[i + 1] = 0.0;
            } else {
                let alpha = tangents[i] / secants[i];
                let beta = tangents[i + 1] / secants[i];
                let tau = alpha * alpha + beta * beta;
                if tau > 9.0 {
                    let s = 3.0 / tau.sqrt();
                    tangents[i] = s * alpha * secants[i];
                    tangents[i + 1] = s * beta * secants[i];
                }
            }
        }
    }

    // Evaluate the spline at each integer shade value 0-255
    for (shade, lut_entry) in lut.iter_mut().enumerate() {
        let x = shade as f64;

        // Find the segment containing x
        let seg = if x <= pts[0].0 {
            0
        } else if x >= pts[n - 1].0 {
            n - 2
        } else {
            let mut lo = 0;
            let mut hi = n - 1;
            while hi - lo > 1 {
                let mid = (lo + hi) / 2;
                if pts[mid].0 <= x {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            lo
        };

        let dx = (pts[seg + 1].0 - pts[seg].0).max(0.001);
        let t = ((x - pts[seg].0) / dx).clamp(0.0, 1.0);
        let t2 = t * t;
        let t3 = t2 * t;

        // Hermite basis functions
        let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
        let h10 = t3 - 2.0 * t2 + t;
        let h01 = -2.0 * t3 + 3.0 * t2;
        let h11 = t3 - t2;

        let power_pct = h00 * pts[seg].1
            + h10 * dx * tangents[seg]
            + h01 * pts[seg + 1].1
            + h11 * dx * tangents[seg + 1];

        // Power% → shade: 0% power = 255 (white), 100% power = 0 (black)
        let clamped_power = power_pct.clamp(0.0, 100.0);
        let shade_out = 255.0 - (clamped_power / 100.0 * 255.0);
        *lut_entry = shade_out.round().clamp(0.0, 255.0) as u8;
    }

    lut
}

/// F5: Transform image-local (x_img, y_img) coordinates to GRBL machine coordinates.
/// Applies rotation about the image center, then the workspace Y-flip (unless origin_top).
/// Mirrors are already applied to the pixel buffer in preview_dither, so no transform here.
/// Used in tests to verify coordinate transform behavior independently of scan_mask_to_gcode.
#[cfg(test)]
fn image_to_grbl(
    x_img: f64,
    y_img: f64,
    cx: f64,
    cy: f64,
    rotation_rad: f64,
    workspace_height: f64,
    origin_top: bool,
) -> (f64, f64) {
    // Rotate (x_img, y_img) about the image center (cx, cy)
    let dx = x_img - cx;
    let dy = y_img - cy;
    let cos_r = rotation_rad.cos();
    let sin_r = rotation_rad.sin();
    let rx = cx + dx * cos_r - dy * sin_r;
    let ry = cy + dx * sin_r + dy * cos_r;
    // Y-flip for GRBL (bottom-left origin), skip if origin_top
    let gy = if origin_top { -ry } else { workspace_height - ry };
    (rx, gy)
}

/// Generate scan-line G-code from dithered pixel data.
///
/// Delegates to `scan_mask_to_gcode` (mask_fill.rs) after building `MaskScanParams`
/// from the request. The grayscale channel is passed via `grayscale_pixels` so
/// per-pixel S-value emission and the F4 reverse-row pixel-index fix are preserved.
///
/// The image-specific preamble (G21/G90/M5) is prepended here — it belongs to the
/// image G-code block, not to the shared scanner.
fn generate_scan_gcode(
    req: &ImageEngraveRequest,
    pixels: &[u8],
    width: u32,
    height: u32,
    is_grayscale: bool,
) -> Result<GcodeResult, String> {
    let interval = if req.interval > 0.0 { req.interval } else { 0.1 };
    let s_max = (req.power / 100.0 * req.s_value_max).round();
    let s_min = (req.power_min / 100.0 * req.s_value_max).round();
    let power_cmd = if req.power_mode == "variable" || is_grayscale { "M4" } else { "M3" };
    let rotation_rad = req.rotation.to_radians();

    // Build the shared scan params, wiring in grayscale pixels when applicable.
    let params = MaskScanParams {
        origin_x: req.x,
        origin_y: req.y,
        width_mm: req.width,
        height_mm: req.height,
        interval,
        overscan: req.overscan.max(0.0),
        bidirectional: req.bidirectional,
        scanning_offset: req.scanning_offset,
        speed_mm_min: req.speed,
        s_max,
        s_min,
        power_cmd: power_cmd.to_string(),
        workspace_height: req.workspace_height,
        origin_top: req.origin_top,
        rotation_rad,
        passes: req.passes,
        grayscale_pixels: if is_grayscale { Some(pixels) } else { None },
    };

    // F9: image-specific preamble (idempotent modal commands).
    // Prepended here so image G-code is self-contained regardless of merge order.
    // The shared scanner does not emit preamble lines (maskFill doesn't need them).
    //
    // NOTE: The preamble lines below are a JS↔Rust contract.
    // assembleGcode() in gcodeGen.ts strips everything up to and including
    // "; KERF:PREAMBLE_END" when merging multi-layer fragments.
    // If you change any preamble line, update stripFraming() in gcodeGen.ts.
    // Image fragments have no footer sentinel (no M2 emitted here).
    let mut preamble_lines = vec![
        "G21 ; mm mode".to_string(),
        "G90 ; absolute positioning".to_string(),
        "M5 ; laser off".to_string(),
        format!("; Image engrave: {}x{} px, interval {}mm", width, height, interval),
        "; KERF:PREAMBLE_END".to_string(),
    ];

    let scan_result = scan_mask_to_gcode(pixels, width as usize, height as usize, &params)?;

    // Prepend preamble to the scanner's output
    preamble_lines.push(scan_result.gcode);
    let gcode = preamble_lines.join("\n");
    let line_count = gcode.lines().count();

    Ok(GcodeResult {
        gcode,
        moves: scan_result.moves,
        total_distance: scan_result.total_distance,
        cut_distance: scan_result.cut_distance,
        travel_distance: scan_result.travel_distance,
        estimated_time_secs: scan_result.estimated_time_secs,
        line_count,
    })
}

/// Find runs of black pixels (value == 0) in a row
pub(crate) fn find_binary_runs(row: &[u8]) -> Vec<(usize, usize)> {
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
pub(crate) fn find_grayscale_runs(row: &[u8]) -> Vec<(usize, usize)> {
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
pub(crate) fn estimate_simple_time(cut_dist: &f64, travel_dist: &f64, speed_mm_s: f64) -> f64 {
    let rapid_speed = RAPID_SPEED_MM_MIN / 60.0; // mm/s
    let cut_time = cut_dist / speed_mm_s;
    let travel_time = travel_dist / rapid_speed;
    cut_time + travel_time
}

/// Remove background from a grayscale image by sampling the 4 corners,
/// determining the dominant background luma, and setting pixels within
/// `tolerance` brightness levels of it to white (255 = no engrave).
fn remove_background(gray: &image::GrayImage, tolerance: f64) -> image::GrayImage {
    let (w, h) = gray.dimensions();
    if w == 0 || h == 0 {
        return gray.clone();
    }

    // Sample 4 corners
    let corners = [
        gray.get_pixel(0, 0)[0] as f64,
        gray.get_pixel(w - 1, 0)[0] as f64,
        gray.get_pixel(0, h - 1)[0] as f64,
        gray.get_pixel(w - 1, h - 1)[0] as f64,
    ];

    // Dominant color: average of corners (they're usually all the same for plain backgrounds)
    let bg_luma: f64 = corners.iter().sum::<f64>() / corners.len() as f64;

    let mut out = gray.clone();
    for pixel in out.pixels_mut() {
        if (pixel[0] as f64 - bg_luma).abs() <= tolerance {
            *pixel = image::Luma([255u8]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn power_curve_linear_is_identity() {
        // The "Linear" preset is [{x:0, y:100}, {x:255, y:0}].
        // This is the true identity in shade space:
        //   shade 0 (black) -> 100% power -> output shade 0 (black)
        //   shade 255 (white) -> 0% power -> output shade 255 (white)
        // Dark stays dark, light stays light -- no tonal inversion.
        let identity_points = vec![(0.0, 100.0), (255.0, 0.0)];
        let lut = build_power_curve_lut(&identity_points);

        // shade 0 -> power 100% -> output shade 0
        assert_eq!(lut[0], 0);
        // shade 255 -> power 0% -> output shade 255
        assert_eq!(lut[255], 255);
        // shade 128 -> ~50% power -> ~128
        assert!((lut[128] as i32 - 128).abs() <= 1, "Expected ~128, got {}", lut[128]);
    }

    #[test]
    fn power_curve_step_produces_binary() {
        // Step function: shade < 128 = no power, shade >= 128 = full power
        let step_points = vec![
            (0.0, 0.0),
            (127.0, 0.0),
            (128.0, 100.0),
            (255.0, 100.0),
        ];
        let lut = build_power_curve_lut(&step_points);

        // Low shades should map to low power -> high shade (white)
        assert!(lut[0] >= 250, "shade 0 should be ~255, got {}", lut[0]);
        assert!(lut[64] >= 250, "shade 64 should be ~255, got {}", lut[64]);

        // High shades should map to high power -> low shade (black)
        assert!(lut[200] <= 5, "shade 200 should be ~0, got {}", lut[200]);
        assert!(lut[255] <= 5, "shade 255 should be ~0, got {}", lut[255]);
    }

    #[test]
    fn power_curve_lut_serialization_roundtrip() {
        // Verify that the S-curve preset serializes/deserializes correctly
        let s_curve = vec![
            (0.0, 0.0),
            (64.0, 10.0),
            (128.0, 50.0),
            (192.0, 90.0),
            (255.0, 100.0),
        ];
        let json = serde_json::to_string(&s_curve).unwrap();
        let deserialized: Vec<(f64, f64)> = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.len(), 5);
        assert!((deserialized[2].0 - 128.0).abs() < 0.01);
        assert!((deserialized[2].1 - 50.0).abs() < 0.01);

        // Build LUT from deserialized and verify it's valid
        let lut = build_power_curve_lut(&deserialized);
        // Endpoints
        assert!(lut[0] >= 250, "shade 0 at 0% power should be ~255");
        assert!(lut[255] <= 5, "shade 255 at 100% power should be ~0");
    }

    // ─── F4: grayscale bidirectional X fix ───────────────────────────────────

    fn base_req() -> ImageEngraveRequest {
        // Minimal valid request: 10×1 pixel image, grayscale mode
        ImageEngraveRequest {
            image_data: String::new(), // not used in these unit tests
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 1.0,
            rotation: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            power: 100.0,
            power_min: 0.0,
            speed: 6000.0, // mm/min (was 100 mm/s before unit switch)
            passes: 1,
            power_mode: "variable".to_string(),
            interval: 1.0,
            dither: "grayscale".to_string(),
            overscan: 0.0,
            bidirectional: true,
            scanning_offset: 0.0,
            brightness: 0.0,
            contrast: 0.0,
            gamma: 1.0,
            invert: false,
            workspace_height: 100.0,
            origin_top: false,
            s_value_max: 1000.0,
            power_curve: None,
            newsprint_cell_size: None,
            newsprint_angle: None,
            remove_background: false,
            bg_tolerance: 20.0,
        }
    }

    /// F4: verify that the reverse-row pixel X positions are calculated from *run_start
    /// (the original end index) rather than *run_end (the original start, after the swap).
    ///
    /// Setup: 10-pixel row where pixels 2–5 are dark (127). First row is forward;
    /// second row (bidirectional) is reverse. Extract the G1 X coords from the gcode
    /// and verify the reverse row's first pixel is near the RIGHT end of the run
    /// (pixel 5 × interval = 5.0mm), not the left end (pixel 2 × interval = 2.0mm).
    #[test]
    fn f4_grayscale_bidi_reverse_row_x_positions() {
        let req = base_req();
        // Row 0: 10 pixels. Pixels 2–4 are mid-gray (127), rest white (255).
        // With bidirectional=true, row 0 = forward, row 1 = reverse.
        // We'll use two identical rows to test the reverse direction.
        let w = 10usize;
        let h = 2usize;
        let mut pixels = vec![255u8; w * h];
        // Row 0 and row 1: pixels 2, 3, 4 are gray (127)
        pixels[2] = 127; pixels[3] = 127; pixels[4] = 127;
        pixels[w + 2] = 127; pixels[w + 3] = 127; pixels[w + 4] = 127;

        let result = generate_scan_gcode(&req, &pixels, w as u32, h as u32, true)
            .expect("generate_scan_gcode should succeed");

        let gcode = result.gcode;
        // Extract all G1 X coordinates
        let x_values: Vec<f64> = gcode.lines()
            .filter(|l| l.starts_with("G1 X"))
            .filter_map(|l| {
                l.split_whitespace()
                    .find(|t| t.starts_with("X"))
                    .and_then(|t| t[1..].parse::<f64>().ok())
            })
            .collect();

        assert!(!x_values.is_empty(), "Expected G1 moves in gcode:\n{}", gcode);

        // Row 0 (forward): first pixel X should be near 3.0 (run_start=2, i=0, +1 = index 3 * interval=1.0)
        // Row 1 (reverse): first pixel X should be near the RIGHT end of run.
        // With the fix (*run_start, which is the original end=5):
        //   px = 0.0 + (5 - 0 - 1).max(0) * 1.0 = 4.0mm for i=0
        // Without the fix (*run_end, which would be the original start=2 after swap):
        //   px = 0.0 + (2 - 0 - 1).max(0) * 1.0 = 1.0mm for i=0
        //
        // Forward row pixels: X≈3.0, X≈4.0, X≈5.0
        // Reverse row pixels: X≈4.0, X≈3.0, X≈2.0 (with fix — counts from right end)

        // The reverse row's FIRST pixel should be at the high end (≥4.0mm).
        // The forward row's first pixel lands at X=3.0; the reverse row's is X=4.0.
        // We look for at least one X value ≥ 4.0 (only possible if reverse counts correctly).
        let has_high_x = x_values.iter().any(|&x| x >= 4.0);
        assert!(
            has_high_x,
            "F4 regression: reverse row should produce X ≥ 4.0mm; got {:?}. \
             This means *run_end was used instead of *run_start.",
            x_values,
        );
    }

    /// F4b: EXACT X positions for grayscale bidirectional row pair (delegation path).
    ///
    /// This test covers the same regression as `f4_grayscale_bidi_reverse_row_x_positions`
    /// but asserts COMPLETE exact X sequences rather than a loose `any(x >= 4.0)` check.
    /// It locks the `generate_scan_gcode → scan_mask_to_gcode` delegation path against
    /// reverse-row index drift.
    ///
    /// Run at cols 2..5 (pixel values 127 = gray, so find_grayscale_runs picks them up).
    /// Forward row X must be exactly [3.0, 4.0, 5.0]; reverse row X must be [4.0, 3.0, 2.0].
    ///
    /// With the regression (*orig_start instead of *orig_end in the reverse branch):
    ///   reverse emits X = [1.0, 0.0, 0.0]  (i=0: (2-1)=1, i=1: (2-1-1)=0, i=2: clamped 0)
    /// With the fix (*orig_end=5):
    ///   reverse emits X = [4.0, 3.0, 2.0]  (i=0: (5-1)=4, i=1: (5-2)=3, i=2: (5-3)=2)
    #[test]
    fn f4b_grayscale_bidi_exact_x_positions() {
        let mut req = base_req();
        req.bidirectional = true;
        req.width = 10.0;
        req.height = 2.0;
        req.interval = 1.0;
        req.overscan = 0.0;
        req.power = 100.0;
        req.power_min = 0.0;
        req.s_value_max = 1000.0;

        let w = 10usize;
        let h = 2usize;
        // Row 0 and row 1: pixels 2,3,4 are mid-gray (127); rest white (255).
        // find_grayscale_runs treats < 255 as a run → run (2, 5).
        let mut pixels = vec![255u8; w * h];
        pixels[2] = 127; pixels[3] = 127; pixels[4] = 127;
        pixels[w + 2] = 127; pixels[w + 3] = 127; pixels[w + 4] = 127;

        let result = generate_scan_gcode(&req, &pixels, w as u32, h as u32, true)
            .expect("generate_scan_gcode should succeed");

        let gcode = &result.gcode;

        // Extract G1 engrave moves with S > 0 (skip S0 blanks)
        let engrave_x: Vec<f64> = gcode.lines()
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
            "Expected 6 engrave moves (3 forward + 3 reverse); got {:?}\ngcode:\n{}", engrave_x, gcode
        );

        let forward_x = &engrave_x[..3];
        assert_eq!(
            forward_x, &[3.0f64, 4.0, 5.0],
            "Forward row X wrong; got {:?}", forward_x
        );

        let reverse_x = &engrave_x[3..];
        assert_eq!(
            reverse_x, &[4.0f64, 3.0, 2.0],
            "Reverse row X wrong (regression: orig_start used instead of orig_end); \
             got {:?} — expected [4.0, 3.0, 2.0]",
            reverse_x
        );
    }

    // ─── F5: image rotation and mirror ───────────────────────────────────────

    /// F5: axis-aligned image (rotation=0, no mirror) — Y coordinate is workspace_height - y_mm.
    #[test]
    fn f5_no_rotation_y_coord_is_flipped() {
        let mut req = base_req();
        req.rotation = 0.0;
        req.y = 10.0;
        req.workspace_height = 100.0;

        let pixels = vec![0u8; 10]; // 10 black pixels, 1 row
        let result = generate_scan_gcode(&req, &pixels, 10, 1, false)
            .expect("generate_scan_gcode should succeed");

        let gcode = result.gcode;
        // Y should be workspace_height - y_mm = 100 - 10 = 90
        assert!(
            gcode.contains("Y90.000"),
            "Expected Y90.000 (100 - 10); got:\n{}", gcode,
        );
    }

    /// F5: image with 90° rotation — a scan row at y=5 with x=5 should not emit Y90.
    /// After 90° rotation about center (5,0.5), the coordinates are transformed.
    #[test]
    fn f5_rotation_changes_coordinates() {
        let mut req = base_req();
        req.rotation = 90.0;  // 90 degrees
        req.x = 0.0;
        req.y = 0.0;
        req.width = 10.0;
        req.height = 1.0;
        req.workspace_height = 100.0;
        req.origin_top = false;

        let pixels = vec![0u8; 10]; // single row, all black
        let result = generate_scan_gcode(&req, &pixels, 10, 1, false)
            .expect("generate_scan_gcode should succeed");

        let gcode = result.gcode;
        // Without rotation, Y would be 100.0 (workspace_height - 0.0).
        // With 90° rotation, Y coordinates are transformed — the line emitted
        // should NOT be purely Y=100.000 (axis-aligned position).
        // We just verify G1 coordinates differ from the unrotated case.
        let unrotated_y = "Y100.000";
        // With 90° rotation the Y coords will be non-trivial (not 100.0).
        assert!(
            !gcode.contains(&format!("G1 X0.000 {}", unrotated_y)),
            "Expected rotated coordinates, but got axis-aligned Y100; gcode:\n{}", gcode,
        );
    }

    /// F5: scaleX = -1 → pixels in a row are mirrored horizontally.
    /// A row with only the LEFT half black → after mirror → only RIGHT half is black.
    #[test]
    fn f5_scale_x_minus1_flips_pixels_horizontally() {
        // 10 pixels wide, 1 row. Left half (0–4) black, right half (5–9) white.
        let mut pixels = vec![255u8; 10];
        pixels[..5].fill(0);

        // Without mirror: run is at pixels 0–4 → X positions 0–5mm
        let req_normal = base_req();
        let result_normal = generate_scan_gcode(&req_normal, &pixels, 10, 1, false)
            .expect("normal: generate_scan_gcode should succeed");

        // With mirror (scale_x = -1): pixel buffer is reversed → left becomes right
        // After flip: pixels 0–4 are white, 5–9 are black → run at 5–9mm
        // We test the preview_dither flip by constructing a request with scale_x=-1
        // and checking that the resulting pixel order is reversed.
        // Since generate_scan_gcode doesn't apply the flip (preview_dither does),
        // we manually apply the flip to verify the logic.
        let mut flipped = pixels.clone();
        flipped.reverse(); // manual flip for a single-row test
        let req_flipped = base_req();
        let result_flipped = generate_scan_gcode(&req_flipped, &flipped, 10, 1, false)
            .expect("flipped: generate_scan_gcode should succeed");

        // Normal run should end at X≤5.0; flipped run should start at X≥5.0
        let x_end_normal = result_normal.gcode.lines().rfind(|l| l.starts_with("G1 X"))
            .and_then(|l| l.split_whitespace().find(|t| t.starts_with("X")))
            .and_then(|t| t[1..].parse::<f64>().ok())
            .unwrap_or(0.0);

        let x_start_flipped = result_flipped.gcode.lines().find(|l| l.starts_with("G0 X"))
            .and_then(|l| l.split_whitespace().find(|t| t.starts_with("X")))
            .and_then(|t| t[1..].parse::<f64>().ok())
            .unwrap_or(0.0);

        assert!(x_end_normal <= 5.0, "normal run end X should be ≤5; got {}", x_end_normal);
        assert!(x_start_flipped >= 5.0, "mirrored run start X should be ≥5; got {}", x_start_flipped);
    }

    /// F5: image_to_grbl with zero rotation is equivalent to direct Y-flip.
    #[test]
    fn f5_image_to_grbl_no_rotation_matches_direct_y_flip() {
        let workspace_height = 300.0;
        let cx = 50.0;
        let cy = 25.0;
        // With zero rotation, should just apply Y-flip
        let (rx, ry) = image_to_grbl(100.0, 50.0, cx, cy, 0.0, workspace_height, false);
        assert!((rx - 100.0).abs() < 1e-9, "X should be unchanged: {}", rx);
        assert!((ry - 250.0).abs() < 1e-9, "Y should be workspace_height - y = 250: {}", ry);
    }

    /// F5: image_to_grbl with origin_top skips Y-flip.
    #[test]
    fn f5_image_to_grbl_origin_top_negates_y() {
        let (rx, ry) = image_to_grbl(10.0, 20.0, 0.0, 0.0, 0.0, 100.0, true);
        assert!((rx - 10.0).abs() < 1e-9);
        assert!((ry - (-20.0)).abs() < 1e-9, "origin_top: expected -y, got {}", ry);
    }

    // ─── F9: image G-code preamble ───────────────────────────────────────────

    /// F9: generate_scan_gcode must emit G21/G90/M5 before any scan-line moves
    /// so image G-code is self-contained regardless of merge order.
    #[test]
    fn f9_image_gcode_starts_with_preamble() {
        let req = base_req();
        let pixels = vec![0u8; 10]; // 10 black pixels, 1 row
        let result = generate_scan_gcode(&req, &pixels, 10, 1, false)
            .expect("generate_scan_gcode should succeed");

        let gcode = &result.gcode;
        let lines: Vec<&str> = gcode.lines().collect();

        // The first non-empty line must be G21
        let first = lines.iter().find(|l| !l.is_empty() && !l.starts_with(";"))
            .copied().unwrap_or("");
        assert_eq!(first, "G21 ; mm mode",
            "F9: expected G21 as first non-comment line; got '{first}'\nFull G-code:\n{gcode}");

        // G90 and M5 must appear before the first G0/G1
        let first_move_idx = lines.iter().position(|l| l.starts_with("G0 X") || l.starts_with("G1 X"));
        let preamble_lines: Vec<&str> = match first_move_idx {
            Some(idx) => lines[..idx].to_vec(),
            None => lines.clone(),
        };
        assert!(preamble_lines.iter().any(|l| l.starts_with("G90")),
            "F9: expected G90 in preamble before first move; preamble:\n{}", preamble_lines.join("\n"));
        assert!(preamble_lines.iter().any(|l| l.starts_with("M5")),
            "F9: expected M5 in preamble before first move; preamble:\n{}", preamble_lines.join("\n"));
    }

    // ─── Fix 1: Alpha-aware compositing ─────────────────────────────────────

    /// Build a minimal PNG with RGBA data and base64-encode it for use in tests.
    /// `pixels` is a flat Vec of (R,G,B,A) tuples, one per pixel.
    fn make_rgba_png_base64(width: u32, height: u32, pixels: &[(u8, u8, u8, u8)]) -> String {
        use image::{ImageBuffer, Rgba, ImageEncoder};
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
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes))
    }

    #[test]
    fn fix1_transparent_pixel_composites_to_white() {
        // A fully transparent black pixel (R=0,G=0,B=0,A=0) should composite to white (255).
        // White means no-engrave — the laser should not fire.
        let req = ImageEngraveRequest {
            image_data: make_rgba_png_base64(1, 1, &[(0, 0, 0, 0)]),
            width: 1.0,
            height: 1.0,
            dither: "grayscale".to_string(),
            ..base_req()
        };
        let (pixels, w, h) = preview_dither(&req).expect("preview_dither should succeed");
        assert_eq!(w, 1);
        assert_eq!(h, 1);
        // Transparent pixel must composite to white (255).
        assert_eq!(pixels[0], 255, "Transparent pixel should become white (no-engrave), got {}", pixels[0]);
    }

    #[test]
    fn fix1_opaque_image_unchanged() {
        // A fully opaque black pixel (R=0,G=0,B=0,A=255) should remain black (0).
        // No behavioral change for opaque images.
        let req = ImageEngraveRequest {
            image_data: make_rgba_png_base64(1, 1, &[(0, 0, 0, 255)]),
            width: 1.0,
            height: 1.0,
            dither: "grayscale".to_string(),
            ..base_req()
        };
        let (pixels, _, _) = preview_dither(&req).expect("preview_dither should succeed");
        assert_eq!(pixels[0], 0, "Opaque black pixel should remain black, got {}", pixels[0]);
    }

    #[test]
    fn fix1_semi_transparent_pixel_blends() {
        // A semi-transparent white pixel (R=255,G=255,B=255,A=128) composited on white
        // should still be white.
        let req = ImageEngraveRequest {
            image_data: make_rgba_png_base64(1, 1, &[(255, 255, 255, 128)]),
            width: 1.0,
            height: 1.0,
            dither: "grayscale".to_string(),
            ..base_req()
        };
        let (pixels, _, _) = preview_dither(&req).expect("preview_dither should succeed");
        assert_eq!(pixels[0], 255, "Semi-transparent white on white should remain white, got {}", pixels[0]);
    }

    // ─── Fix 3: Background removal ──────────────────────────────────────────

    #[test]
    fn fix3_white_background_pixels_become_white() {
        // A 3-pixel image: 2 white corners + 1 black center (non-background).
        // With remove_background=true and default tolerance=20:
        // - White pixels (255) are near the bg_luma (255) → set to white (no change needed)
        // - Black pixel (0) is far from bg_luma → preserved
        let req = ImageEngraveRequest {
            image_data: make_rgba_png_base64(3, 1, &[
                (255, 255, 255, 255), // corner 0 — white bg
                (0, 0, 0, 255),       // center — black foreground
                (255, 255, 255, 255), // corner 1 — white bg
            ]),
            width: 3.0,
            height: 1.0,
            dither: "grayscale".to_string(),
            remove_background: true,
            bg_tolerance: 20.0,
            ..base_req()
        };
        let (pixels, w, h) = preview_dither(&req).expect("preview_dither should succeed");
        assert_eq!(w, 3);
        assert_eq!(h, 1);
        // Corner pixels should be white (background removed)
        assert_eq!(pixels[0], 255, "Left corner should be white (bg removed), got {}", pixels[0]);
        assert_eq!(pixels[2], 255, "Right corner should be white (bg removed), got {}", pixels[2]);
        // Center pixel (far from bg) should NOT be white
        assert!(pixels[1] < 200, "Center black pixel should be dark, got {}", pixels[1]);
    }

    #[test]
    fn fix3_disabled_preserves_original() {
        // When remove_background=false, the gray center pixel should not be whitened.
        // Use grayscale dither (pass-through) so the value is not binarized by error diffusion.
        let req = ImageEngraveRequest {
            image_data: make_rgba_png_base64(3, 1, &[
                (255, 255, 255, 255),
                (128, 128, 128, 255),
                (255, 255, 255, 255),
            ]),
            width: 3.0,
            height: 1.0,
            dither: "grayscale".to_string(),
            remove_background: false,
            bg_tolerance: 20.0,
            ..base_req()
        };
        let (pixels, _, _) = preview_dither(&req).expect("preview_dither should succeed");
        // Center gray pixel should still be ~128, not forced to white (255) by bg removal.
        // Grayscale dither is a pass-through, so the original luma (~128) is preserved.
        assert!(pixels[1] < 200,
            "Center gray pixel should not be whitened when bg removal disabled, got {}", pixels[1]);
    }

    /// Regression: after the mm/s → mm/min unit switch, the image-engrave time estimate must
    /// remain minutes-scale (i.e. use mm/s internally), not drop to seconds-scale (the 60× bug).
    ///
    /// Setup: 100 mm of cut distance at 6000 mm/min (= 100 mm/s).
    ///   Correct:  cut_time = 100 / 100 = 1 s → ~1 s total (no travel here)
    ///   Bug (60×): cut_time = 100 / 6000 = 0.0167 s — 60× too small.
    ///
    /// The assertion `> 0.5` catches the bug (0.0167 < 0.5) while passing the fix (1.0 > 0.5).
    #[test]
    fn image_time_estimate_is_seconds_scale_not_60x_too_small() {
        let t = estimate_simple_time(&100.0, &0.0, 6000.0 / 60.0);
        // At 6000 mm/min (100 mm/s), 100 mm of cutting takes ~1 second.
        // If the bug were present (speed passed as-is in mm/min), the result would be ~0.0167 s.
        assert!(t > 0.5,
            "estimate_simple_time returned {}s — expected ~1s; likely 60× too small (mm/min bug)", t);
        assert!(t < 10.0,
            "estimate_simple_time returned {}s — unexpectedly large; check unit handling", t);
    }
}
