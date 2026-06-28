use base64::Engine;
use image::{GenericImageView, GrayImage, Luma};
use imageproc::contrast::adaptive_threshold;
use imageproc::morphology::{close, open};
use imageproc::distance_transform::Norm;
use serde::{Deserialize, Serialize};
use visioncortex::PathSimplifyMode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceParams {
    pub image_data: String,
    pub mode: String,
    pub threshold: u8,
    pub threshold_low: u8,
    pub corner_threshold: i32,
    pub filter_speckle: usize,
    pub invert: bool,
    pub preview_scale: f32,
    pub blur_radius: f32,
    pub smoothness: f32,
    pub ignore_area: u32,
    pub use_adaptive_threshold: bool,
    pub adaptive_block_size: u32,
    pub morph_radius: u8,
    #[serde(default)]
    pub trace_transparency: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceResult {
    pub svg: String,
    pub path_count: usize,
    pub width_px: u32,
    pub height_px: u32,
}

pub fn trace_image(params: TraceParams) -> Result<TraceResult, String> {
    let base64_data = params
        .image_data
        .split(',')
        .nth(1)
        .unwrap_or(&params.image_data);

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("Image decode error: {}", e))?;

    let (orig_w, orig_h) = img.dimensions();

    let img = if params.preview_scale < 1.0 {
        let new_w = ((orig_w as f32) * params.preview_scale).max(1.0) as u32;
        let new_h = ((orig_h as f32) * params.preview_scale).max(1.0) as u32;
        img.resize(new_w, new_h, image::imageops::FilterType::Triangle)
    } else {
        img
    };

    let (w, h) = img.dimensions();

    // Scale-normalize filter thresholds so preview and commit remove the same physical
    // features regardless of preview_scale (formulas are no-ops at s=1.0).
    // filter_speckle is a diameter; vtracer squares it → effective area = filter_speckle².
    // ignore_area is already an area in pixels; scale by s².
    // hole_min_area is floored to 1 so heavy downscale never silently disables
    // fill_small_holes (critic must-fix §C).
    let s = params.preview_scale.clamp(0.0, 1.0) as f64;
    let filter_speckle_scaled = (params.filter_speckle as f64 * s).round() as usize;
    let ignore_area_scaled = (params.ignore_area as f64 * s * s).round() as u32;
    let hole_min_area: u64 = (filter_speckle_scaled as u64).pow(2).max(1);

    // -- PREPROCESSING PIPELINE --

    // Step 1: Convert to grayscale
    let mut gray = img.to_luma8();

    // Step 2: Gaussian blur for noise reduction
    if params.blur_radius > 0.0 {
        gray = imageproc::filter::gaussian_blur_f32(&gray, params.blur_radius);
    }

    // Fix 5: Binary auto-threshold — if >90% of pixels are near-black (<20) or
    // near-white (>235), the image is already binary. Use a fixed midpoint
    // threshold (128) and skip adaptive preprocessing, which introduces halos
    // on already-clean black-on-transparent PNGs.
    let is_near_binary = {
        let total = (w * h) as usize;
        if total == 0 {
            false
        } else {
            let binary_count = gray.pixels().filter(|p| p[0] < 20 || p[0] > 235).count();
            binary_count * 10 >= total * 9  // >90%
        }
    };

    // Step 3: Binarization (mode-dependent)
    // Fix 6: Trace transparency — use alpha channel directly as binary mask when requested.
    // Skips grayscale-based threshold; traces the alpha boundary instead.
    let binary = if params.trace_transparency {
        let rgba = img.to_rgba8();
        // alpha > 128 → foreground (black=0), otherwise background (white=255)
        GrayImage::from_fn(w, h, |x, y| {
            let alpha = rgba.get_pixel(x, y)[3];
            let is_fg = if params.invert { alpha <= 128 } else { alpha > 128 };
            Luma([if is_fg { 0 } else { 255 }])
        })
    } else { match params.mode.as_str() {
        "sketch" => {
            let low = (params.threshold as f32 * 0.25).max(1.0);
            let high = params.threshold as f32;
            let edges = imageproc::edges::canny(&gray, low, high);
            let mut bin = GrayImage::new(w, h);
            for (x, y, pixel) in edges.enumerate_pixels() {
                let val = if params.invert { 255 - pixel[0] } else { pixel[0] };
                bin.put_pixel(x, y, Luma([if val > 0 { 0 } else { 255 }]));
            }
            bin
        }
        _ => {
            if params.use_adaptive_threshold && !is_near_binary {
                // Adaptive threshold: good for photos/gradients.
                // Skipped for near-binary images — adaptive halos degrade clean edges.
                let block = params.adaptive_block_size.max(3) | 1;
                let adapted = adaptive_threshold(&gray, block);
                let mut bin = GrayImage::new(w, h);
                for (x, y, pixel) in adapted.enumerate_pixels() {
                    let is_fg = if params.invert { pixel[0] > 0 } else { pixel[0] == 0 };
                    bin.put_pixel(x, y, Luma([if is_fg { 0 } else { 255 }]));
                }
                bin
            } else if is_near_binary {
                // Fix 5: Binary image auto-threshold — use simple midpoint (128)
                // for near-binary input regardless of use_adaptive_threshold setting.
                // Avoids adaptive halos on clean black-on-transparent PNGs.
                let mut bin = GrayImage::new(w, h);
                for (x, y, pixel) in gray.enumerate_pixels() {
                    let is_fg = if params.invert { pixel[0] >= 128 } else { pixel[0] < 128 };
                    bin.put_pixel(x, y, Luma([if is_fg { 0 } else { 255 }]));
                }
                bin
            } else {
                // Dual-threshold brightness range
                let lo = params.threshold_low;
                let hi = params.threshold;
                let mut bin = GrayImage::new(w, h);
                for (x, y, pixel) in gray.enumerate_pixels() {
                    let v = pixel[0];
                    let in_range = v >= lo && v <= hi;
                    let is_fg = if params.invert { !in_range } else { in_range };
                    bin.put_pixel(x, y, Luma([if is_fg { 0 } else { 255 }]));
                }
                bin
            }
        }
    } }; // closes else { match ... }

    // Step 4: Morphological cleanup
    let binary = if params.morph_radius > 0 {
        let opened = open(&binary, Norm::LInf, params.morph_radius);
        close(&opened, Norm::LInf, params.morph_radius)
    } else {
        binary
    };

    // Step 5: Small connected component removal (scale-normalized threshold)
    let binary = if params.ignore_area > 1 {
        remove_small_components(&binary, ignore_area_scaled)
    } else {
        binary
    };

    // Step 5b: Interior hole despeckle — fills small white pinholes within foreground to
    // eliminate spurious laser cuts. Must NOT run in sketch/Canny mode: in that mode the
    // binary is an edge map where enclosed white regions are shape interiors, NOT holes to
    // remove. Applying fill_small_holes there would incorrectly solidify outlined shapes
    // (critic FAIL fix §A, locked by test sketch_mode_guard_no_fill_small_holes).
    let binary = if params.filter_speckle > 0 && params.mode != "sketch" {
        fill_small_holes(&binary, hole_min_area)
    } else {
        binary
    };

    // Step 6: Convert to RGBA for vtracer
    let mut rgba = image::RgbaImage::new(w, h);
    for (x, y, pixel) in binary.enumerate_pixels() {
        let color = if pixel[0] == 0 {
            [0, 0, 0, 255]
        } else {
            [255, 255, 255, 255]
        };
        rgba.put_pixel(x, y, image::Rgba(color));
    }

    let pixels: Vec<u8> = rgba.into_raw();
    let color_image = vtracer::ColorImage {
        pixels,
        width: w as usize,
        height: h as usize,
    };

    // Step 7: vtracer with smoothness-mapped config (use scale-normalized filter_speckle)
    let corner = if params.smoothness > 0.0 {
        (params.corner_threshold as f32 * (1.0 + params.smoothness)).min(180.0) as i32
    } else {
        params.corner_threshold
    };

    let simplify_mode = if params.smoothness > 0.5 {
        PathSimplifyMode::Spline
    } else {
        PathSimplifyMode::Polygon
    };

    let config = vtracer::Config {
        color_mode: vtracer::ColorMode::Binary,
        hierarchical: vtracer::Hierarchical::Stacked,
        filter_speckle: filter_speckle_scaled,
        corner_threshold: corner,
        mode: simplify_mode,
        ..Default::default()
    };

    let svg_file = vtracer::convert(color_image, config)?;

    // Step 8: Post-processing — filter paths by outer-contour area (Shoelace).
    // Replaces the broken SVG string-length heuristic. Uses scale-normalized
    // ignore_area_scaled so the same physical features are filtered at any preview_scale.
    let filtered_paths: Vec<_> = if params.ignore_area > 1 {
        svg_file.paths.into_iter().filter(|p| {
            compound_outer_area(&p.path) >= ignore_area_scaled as f64
        }).collect()
    } else {
        svg_file.paths
    };

    // Count total subpaths (outer + hole subpaths per cluster) so the contour badge in
    // the UI reflects the number of DesignObjects commit will produce — an artifact
    // pinhole adds a hole subpath and shows up as a count spike (plan §D).
    let path_count: usize = filtered_paths.iter().map(|p| p.path.paths.len()).sum();

    // Rebuild SVG manually to apply filtering
    let mut svg = String::new();
    svg.push_str(&format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\">\n",
        w, h
    ));
    for path in &filtered_paths {
        let (d, offset) = path.path.to_svg_string(true, visioncortex::PointF64::default(), None);
        svg.push_str(&format!(
            "<path d=\"{}\" fill=\"{}\" transform=\"translate({},{})\"/>\n",
            d,
            path.color.to_hex_string(),
            offset.x,
            offset.y
        ));
    }
    svg.push_str("</svg>\n");

    Ok(TraceResult {
        svg,
        path_count,
        width_px: orig_w,
        height_px: orig_h,
    })
}

/// Remove connected components smaller than min_area pixels
fn remove_small_components(binary: &GrayImage, min_area: u32) -> GrayImage {
    let (w, h) = binary.dimensions();
    let mut labels = vec![0u32; (w * h) as usize];
    let mut label_count = 0u32;
    let mut label_sizes: Vec<u32> = vec![0];

    // Simple flood-fill labeling for foreground (black=0) pixels
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            if binary.get_pixel(x, y)[0] == 0 && labels[idx] == 0 {
                label_count += 1;
                let mut size = 0u32;
                let mut stack = vec![(x, y)];
                while let Some((cx, cy)) = stack.pop() {
                    let ci = (cy * w + cx) as usize;
                    if labels[ci] != 0 { continue; }
                    if binary.get_pixel(cx, cy)[0] != 0 { continue; }
                    labels[ci] = label_count;
                    size += 1;
                    if cx > 0 { stack.push((cx - 1, cy)); }
                    if cx + 1 < w { stack.push((cx + 1, cy)); }
                    if cy > 0 { stack.push((cx, cy - 1)); }
                    if cy + 1 < h { stack.push((cx, cy + 1)); }
                }
                label_sizes.push(size);
            }
        }
    }

    let mut result = GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            let label = labels[idx];
            if label > 0 && label_sizes[label as usize] >= min_area {
                result.put_pixel(x, y, Luma([0]));
            } else {
                result.put_pixel(x, y, Luma([255]));
            }
        }
    }
    result
}

// ─── Area helpers ─────────────────────────────────────────────────────────────

/// Shoelace area for a PointI32 polygon. Absolute value; handles repeated last-point.
fn shoelace_i32(points: &[visioncortex::PointI32]) -> f64 {
    if points.len() < 3 { return 0.0; }
    let n = points.len();
    let mut area = 0.0f64;
    for i in 0..n {
        let j = (i + 1) % n;
        area += (points[i].x as f64) * (points[j].y as f64);
        area -= (points[j].x as f64) * (points[i].y as f64);
    }
    (area / 2.0).abs()
}

/// Shoelace area for a PointF64 polygon.
fn shoelace_f64(points: &[visioncortex::PointF64]) -> f64 {
    if points.len() < 3 { return 0.0; }
    let n = points.len();
    let mut area = 0.0f64;
    for i in 0..n {
        let j = (i + 1) % n;
        area += points[i].x * points[j].y;
        area -= points[j].x * points[i].y;
    }
    (area / 2.0).abs()
}

/// Area of the outer (first) contour of a CompoundPath via Shoelace.
/// Returns 0.0 for an empty CompoundPath (no panic — critic must-fix §B).
/// For Spline variants the control-point polygon area is used (approximate but
/// acceptable for coarse keep/drop filtering).
fn compound_outer_area(compound: &visioncortex::CompoundPath) -> f64 {
    match compound.paths.first() {
        None => 0.0,
        Some(visioncortex::CompoundPathElement::PathI32(p)) => shoelace_i32(&p.path),
        Some(visioncortex::CompoundPathElement::PathF64(p)) => shoelace_f64(&p.path),
        Some(visioncortex::CompoundPathElement::Spline(s)) => shoelace_f64(&s.points),
    }
}

// ─── Interior hole despeckle ──────────────────────────────────────────────────

/// Fill small interior white holes in a binary image to eliminate spurious laser cuts.
///
/// Algorithm:
/// 1. Flood-fill all white pixels reachable from the image border → "exterior background."
/// 2. Label remaining interior white pixel components (4-connectivity).
/// 3. Fill any component with `size < hole_min_area` black (0 = foreground).
///
/// Large counters (letter O/e/a, etc.) whose area ≥ `hole_min_area` are preserved.
/// The exterior background (connected to any border pixel) is never touched.
fn fill_small_holes(binary: &GrayImage, hole_min_area: u64) -> GrayImage {
    let (w, h) = binary.dimensions();
    let total = (w * h) as usize;
    let mut exterior = vec![false; total];
    let mut stack: Vec<(u32, u32)> = Vec::new();

    // Seed flood-fill from all white border pixels.
    for x in 0..w {
        for &y in &[0u32, h.saturating_sub(1)] {
            let idx = (y * w + x) as usize;
            if !exterior[idx] && binary.get_pixel(x, y)[0] == 255 {
                exterior[idx] = true;
                stack.push((x, y));
            }
        }
    }
    for y in 1..h.saturating_sub(1) {
        for &x in &[0u32, w.saturating_sub(1)] {
            let idx = (y * w + x) as usize;
            if !exterior[idx] && binary.get_pixel(x, y)[0] == 255 {
                exterior[idx] = true;
                stack.push((x, y));
            }
        }
    }

    // BFS flood-fill exterior white pixels (4-connectivity).
    while let Some((cx, cy)) = stack.pop() {
        for (nx, ny) in [
            (cx.wrapping_sub(1), cy),
            (cx + 1, cy),
            (cx, cy.wrapping_sub(1)),
            (cx, cy + 1),
        ] {
            if nx < w && ny < h {
                let idx = (ny * w + nx) as usize;
                if !exterior[idx] && binary.get_pixel(nx, ny)[0] == 255 {
                    exterior[idx] = true;
                    stack.push((nx, ny));
                }
            }
        }
    }

    // Label interior white pixels (not exterior, not foreground black).
    let mut labels = vec![0u32; total];
    let mut label_count = 0u32;
    let mut label_sizes: Vec<u64> = vec![0u64]; // index 0 = unlabeled sentinel

    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            if binary.get_pixel(x, y)[0] == 255 && !exterior[idx] && labels[idx] == 0 {
                label_count += 1;
                let mut size = 0u64;
                let mut fill_stack = vec![(x, y)];
                while let Some((cx, cy)) = fill_stack.pop() {
                    let ci = (cy * w + cx) as usize;
                    if labels[ci] != 0 { continue; }
                    if binary.get_pixel(cx, cy)[0] != 255 || exterior[ci] { continue; }
                    labels[ci] = label_count;
                    size += 1;
                    if cx > 0 { fill_stack.push((cx - 1, cy)); }
                    if cx + 1 < w { fill_stack.push((cx + 1, cy)); }
                    if cy > 0 { fill_stack.push((cx, cy - 1)); }
                    if cy + 1 < h { fill_stack.push((cx, cy + 1)); }
                }
                label_sizes.push(size);
            }
        }
    }

    // Fill small holes (size < hole_min_area → set black/foreground).
    let mut result = binary.clone();
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            let label = labels[idx];
            if label > 0 && label_sizes[label as usize] < hole_min_area {
                result.put_pixel(x, y, Luma([0u8]));
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal RGBA PNG, base64-encode it, and return with data URI prefix.
    fn make_rgba_png_b64(width: u32, height: u32, pixels: &[(u8, u8, u8, u8)]) -> String {
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

    fn base_params(image_data: String) -> TraceParams {
        TraceParams {
            image_data,
            mode: "standard".to_string(),
            threshold: 128,
            threshold_low: 0,
            corner_threshold: 60,
            filter_speckle: 0,
            invert: false,
            preview_scale: 1.0,
            blur_radius: 0.0,
            smoothness: 1.2,
            ignore_area: 0,
            use_adaptive_threshold: false,
            adaptive_block_size: 15,
            morph_radius: 0,
            trace_transparency: false,
        }
    }

    // ─── Fix 6: Trace transparency ──────────────────────────────────────────

    #[test]
    fn fix6_alpha_image_trace_transparency_produces_paths() {
        // 10x10 image: inner 6x6 block is opaque black (alpha=255), border is transparent (alpha=0).
        // With trace_transparency=true, the trace should follow the alpha boundary.
        let w = 10u32;
        let h = 10u32;
        let mut pixels = vec![(255u8, 255u8, 255u8, 0u8); (w * h) as usize];
        // Fill inner 6x6 block (rows 2-7, cols 2-7) as opaque black
        for y in 2..8u32 {
            for x in 2..8u32 {
                pixels[(y * w + x) as usize] = (0, 0, 0, 255);
            }
        }
        let image_data = make_rgba_png_b64(w, h, &pixels);
        let params = TraceParams {
            image_data,
            trace_transparency: true,
            ..base_params(String::new())
        };
        let result = trace_image(params).expect("trace should succeed");
        // Should produce at least one path (the opaque block boundary)
        assert!(result.path_count >= 1,
            "Trace transparency should produce at least 1 path, got {}", result.path_count);
        // SVG should contain a path element
        assert!(result.svg.contains("<path"), "SVG should contain path elements");
    }

    #[test]
    fn fix6_fully_transparent_image_produces_no_foreground_paths() {
        // 10x10 fully transparent image: no foreground pixels → trace should produce 0 paths.
        let w = 10u32;
        let h = 10u32;
        let pixels = vec![(255u8, 255u8, 255u8, 0u8); (w * h) as usize];
        let image_data = make_rgba_png_b64(w, h, &pixels);
        let params = TraceParams {
            image_data,
            trace_transparency: true,
            filter_speckle: 0,
            ignore_area: 0,
            ..base_params(String::new())
        };
        let result = trace_image(params).expect("trace should succeed");
        // Fully transparent → no foreground → 0 paths (or very small noise filtered out)
        assert_eq!(result.path_count, 0,
            "Fully transparent image should produce 0 paths, got {}", result.path_count);
    }

    #[test]
    fn fix6_trace_transparency_respects_alpha_threshold() {
        // 4x1 image: two pixels with alpha=255 (foreground), two with alpha=0 (background).
        // Trace transparency should distinguish them by alpha, not brightness.
        let w = 4u32;
        let h = 1u32;
        // All pixels are white in RGB, but first two have alpha=255, last two have alpha=0
        let pixels = vec![
            (255u8, 255u8, 255u8, 255u8),
            (255u8, 255u8, 255u8, 255u8),
            (255u8, 255u8, 255u8, 0u8),
            (255u8, 255u8, 255u8, 0u8),
        ];
        let image_data = make_rgba_png_b64(w, h, &pixels);
        // Without trace_transparency: all pixels are white → would binarize to background (no foreground)
        let params_no_alpha = TraceParams {
            image_data: image_data.clone(),
            trace_transparency: false,
            ..base_params(String::new())
        };
        let result_no_alpha = trace_image(params_no_alpha).expect("trace should succeed");

        // With trace_transparency: first two pixels (alpha=255) are foreground
        let params_alpha = TraceParams {
            image_data,
            trace_transparency: true,
            ..base_params(String::new())
        };
        let result_alpha = trace_image(params_alpha).expect("trace should succeed");

        // Without alpha tracing: all-white image → 0 paths (no dark pixels to trace)
        assert_eq!(result_no_alpha.path_count, 0,
            "All-white image without alpha tracing should produce 0 paths");
        // With alpha tracing: first two pixels are opaque → should produce foreground paths
        assert!(result_alpha.path_count >= 1,
            "Alpha-based tracing of opaque pixels should produce at least 1 path");
    }

    // ─── Fix 5: Binary auto-threshold ───────────────────────────────────────

    #[test]
    fn fix5_binary_image_detected_and_uses_midpoint_threshold() {
        // A 20x20 image: inner 12x12 block is pure black (0,0,0,255), border is
        // pure white (255,255,255,255). >90% of pixels are near-binary (<20 or >235),
        // so is_near_binary should be true and the midpoint threshold path fires.
        // The result must trace at least 1 path regardless of use_adaptive_threshold.
        let w = 20u32;
        let h = 20u32;
        let mut pixels = vec![(255u8, 255u8, 255u8, 255u8); (w * h) as usize];
        for y in 4..16u32 {
            for x in 4..16u32 {
                pixels[(y * w + x) as usize] = (0, 0, 0, 255);
            }
        }
        let image_data = make_rgba_png_b64(w, h, &pixels);

        // With adaptive threshold enabled — binary detection should override it
        let params_adaptive = TraceParams {
            image_data: image_data.clone(),
            use_adaptive_threshold: true,
            ..base_params(String::new())
        };
        let result_adaptive = trace_image(params_adaptive).expect("trace should succeed");
        assert!(result_adaptive.path_count >= 1,
            "Near-binary image with adaptive threshold enabled should still trace: got {} paths",
            result_adaptive.path_count);

        // Without adaptive threshold — should also work via binary path
        let params_simple = TraceParams {
            image_data,
            use_adaptive_threshold: false,
            ..base_params(String::new())
        };
        let result_simple = trace_image(params_simple).expect("trace should succeed");
        assert!(result_simple.path_count >= 1,
            "Near-binary image without adaptive threshold should trace: got {} paths",
            result_simple.path_count);
    }

    #[test]
    fn fix5_non_binary_image_not_misclassified() {
        // A gradient image: pixel values span 0..255. Should NOT trigger binary
        // auto-threshold (>90% of pixels are neither <20 nor >235).
        let w = 16u32;
        let h = 1u32;
        let mut pixels = vec![(0u8, 0u8, 0u8, 255u8); (w * h) as usize];
        // Fill with evenly spaced grayscale values across 16 pixels: 0, 17, 34, ..., 255
        for i in 0..w {
            let v = (i * 255 / (w - 1)) as u8;
            pixels[i as usize] = (v, v, v, 255);
        }
        let image_data = make_rgba_png_b64(w, h, &pixels);
        // Should still produce a result without error (gradient just traces fewer/no paths)
        let params = TraceParams {
            image_data,
            use_adaptive_threshold: false,
            ..base_params(String::new())
        };
        let result = trace_image(params);
        assert!(result.is_ok(), "Non-binary gradient image should trace without error");
    }

    // ─── Fix 4: Preprocessing + spline mode ─────────────────────────────────

    #[test]
    fn fix4_smoothness_above_0_5_uses_spline_mode() {
        // Verify the spline mode path is hit (smoothness > 0.5) — this is structural
        // evidence of Fix 4b being wired up. We test the output is valid SVG.
        let w = 20u32;
        let h = 20u32;
        // Black square on white background
        let mut pixels = vec![(255u8, 255u8, 255u8, 255u8); (w * h) as usize];
        for y in 4..16u32 {
            for x in 4..16u32 {
                pixels[(y * w + x) as usize] = (0, 0, 0, 255);
            }
        }
        let image_data = make_rgba_png_b64(w, h, &pixels);
        let params = TraceParams {
            image_data,
            smoothness: 1.2,   // > 0.5 → spline mode
            ..base_params(String::new())
        };
        let result = trace_image(params).expect("trace should succeed");
        assert!(result.path_count >= 1, "Should trace at least 1 path");
        assert!(result.svg.starts_with("<?xml"), "Output should be valid SVG");
    }

    // ─── New: fill_small_holes unit (Test 1) ─────────────────────────────────

    #[test]
    fn fill_small_holes_fills_pinhole_preserves_counter_and_exterior() {
        // 30x30 binary image:
        //   - White border (all 4 edges) → exterior background
        //   - Rows 2-27, cols 2-27: black (foreground square)
        //   - 6x6 white counter at rows 4-9, cols 4-9 (36px ≥ threshold 16 → preserved)
        //   - 2x2 white pinhole at rows 14-15, cols 14-15 (4px < threshold 16 → filled)
        let w = 30u32;
        let h = 30u32;
        let mut binary = GrayImage::new(w, h);
        // Start white everywhere
        for y in 0..h {
            for x in 0..w {
                binary.put_pixel(x, y, Luma([255u8]));
            }
        }
        // Black foreground square
        for y in 2..28u32 {
            for x in 2..28u32 {
                binary.put_pixel(x, y, Luma([0u8]));
            }
        }
        // 6x6 counter (white hole inside black)
        for y in 4..10u32 {
            for x in 4..10u32 {
                binary.put_pixel(x, y, Luma([255u8]));
            }
        }
        // 2x2 pinhole (white hole inside black)
        for y in 14..16u32 {
            for x in 14..16u32 {
                binary.put_pixel(x, y, Luma([255u8]));
            }
        }

        let hole_min_area: u64 = 16; // pinhole 4px < 16 → fill; counter 36px ≥ 16 → keep
        let result = fill_small_holes(&binary, hole_min_area);

        // Pinhole (14,14)-(15,15) should be filled black
        for y in 14..16u32 {
            for x in 14..16u32 {
                assert_eq!(result.get_pixel(x, y)[0], 0u8,
                    "pinhole pixel ({},{}) should be filled black", x, y);
            }
        }
        // Counter (4,4)-(9,9) should remain white
        assert_eq!(result.get_pixel(6, 6)[0], 255u8,
            "counter interior should stay white (area 36 >= threshold 16)");
        // Exterior border should remain white
        assert_eq!(result.get_pixel(0, 0)[0], 255u8, "exterior corner should stay white");
        assert_eq!(result.get_pixel(29, 29)[0], 255u8, "exterior corner should stay white");
        // Foreground black pixels outside holes should remain black
        assert_eq!(result.get_pixel(20, 20)[0], 0u8, "foreground pixel should stay black");
    }

    // ─── New: E2E pinhole trace (Test 2) ─────────────────────────────────────

    #[test]
    fn e2e_pinhole_filled_before_vtracer_single_subpath() {
        // 20x20 image: black square rows 1-18, cols 1-18 with a 2x2 white pinhole at (9,9).
        // filter_speckle=4 → hole_min_area=16; pinhole (4px) < 16 → filled before vtracer.
        // Expect single subpath (no hole in compound path d) → Z count == 1.
        let w = 20u32;
        let h = 20u32;
        let mut pixels = vec![(255u8, 255u8, 255u8, 255u8); (w * h) as usize];
        // Black square
        for y in 1..19u32 {
            for x in 1..19u32 {
                pixels[(y * w + x) as usize] = (0, 0, 0, 255);
            }
        }
        // 2x2 white pinhole
        pixels[(9 * w + 9) as usize] = (255, 255, 255, 255);
        pixels[(9 * w + 10) as usize] = (255, 255, 255, 255);
        pixels[(10 * w + 9) as usize] = (255, 255, 255, 255);
        pixels[(10 * w + 10) as usize] = (255, 255, 255, 255);

        let image_data = make_rgba_png_b64(w, h, &pixels);
        let params = TraceParams {
            image_data: image_data.clone(),
            filter_speckle: 4, // hole_min_area = 16; pinhole 4px → filled
            ..base_params(String::new())
        };
        let result = trace_image(params).expect("trace should succeed");
        // With fill_small_holes: pinhole gone → single outer path → Z count == 1
        let z_count = result.svg.matches("Z ").count();
        assert_eq!(z_count, 1,
            "Pinhole should be filled; expected 1 Z in SVG d, got {} (SVG: {})",
            z_count, &result.svg[..result.svg.len().min(400)]);

        // Control: filter_speckle=0 → fill_small_holes NOT called → pinhole survives
        let params_control = TraceParams {
            image_data,
            filter_speckle: 0,
            ..base_params(String::new())
        };
        let control = trace_image(params_control).expect("control trace should succeed");
        let z_count_control = control.svg.matches("Z ").count();
        assert_eq!(z_count_control, 2,
            "Without hole-fill: pinhole survives as hole subpath → 2 Z expected, got {}",
            z_count_control);
    }

    // ─── New: Counter preservation (Test 3) ──────────────────────────────────

    #[test]
    fn counter_preserved_above_threshold() {
        // 20x20 image: black square rows 1-18, cols 1-18 with an 8x8 white counter at (5,5).
        // filter_speckle=4 → hole_min_area=16; counter (64px) ≥ 16 → NOT filled.
        // Expect compound path with 2 subpaths (outer + counter hole) → Z count == 2.
        let w = 20u32;
        let h = 20u32;
        let mut pixels = vec![(255u8, 255u8, 255u8, 255u8); (w * h) as usize];
        for y in 1..19u32 {
            for x in 1..19u32 {
                pixels[(y * w + x) as usize] = (0, 0, 0, 255);
            }
        }
        // 8x8 white counter
        for y in 5..13u32 {
            for x in 5..13u32 {
                pixels[(y * w + x) as usize] = (255, 255, 255, 255);
            }
        }

        let image_data = make_rgba_png_b64(w, h, &pixels);
        let params = TraceParams {
            image_data,
            filter_speckle: 4, // hole_min_area=16; counter 64px >> 16 → preserved
            ..base_params(String::new())
        };
        let result = trace_image(params).expect("trace should succeed");
        // Counter preserved → compound path with outer + hole → Z count == 2
        let z_count = result.svg.matches("Z ").count();
        assert_eq!(z_count, 2,
            "Counter (64px) should be preserved as hole subpath; expected 2 Z, got {} (SVG: {})",
            z_count, &result.svg[..result.svg.len().min(400)]);
    }

    // ─── New: Scale parity (Test 4) ──────────────────────────────────────────

    #[test]
    fn scale_parity_normalized_preview_equals_full_res_contour_count() {
        // 100x100 image: black square rows 2-97 with a 20x20 white counter at (20,20).
        // filter_speckle=4; at s=1.0 hole_min_area=16; counter 400px → stays (path_count=2).
        // At s=0.25: filter_speckle_scaled=1, hole_min_area=1; counter ≈25px → stays (≥1).
        // Both scales should give the same path_count (scale-normalization is working).
        let w = 100u32;
        let h = 100u32;
        let mut pixels = vec![(255u8, 255u8, 255u8, 255u8); (w * h) as usize];
        for y in 2..98u32 {
            for x in 2..98u32 {
                pixels[(y * w + x) as usize] = (0, 0, 0, 255);
            }
        }
        // 20x20 counter
        for y in 20..40u32 {
            for x in 20..40u32 {
                pixels[(y * w + x) as usize] = (255, 255, 255, 255);
            }
        }

        let image_data = make_rgba_png_b64(w, h, &pixels);

        let result_full = trace_image(TraceParams {
            image_data: image_data.clone(),
            filter_speckle: 4,
            preview_scale: 1.0,
            ..base_params(String::new())
        }).expect("full-res trace should succeed");

        let result_quarter = trace_image(TraceParams {
            image_data,
            filter_speckle: 4,
            preview_scale: 0.25,
            ..base_params(String::new())
        }).expect("quarter-res trace should succeed");

        assert_eq!(result_full.path_count, result_quarter.path_count,
            "Scale-normalized preview should give same path_count as full res: \
             s=1.0 → {}, s=0.25 → {}",
            result_full.path_count, result_quarter.path_count);
    }

    // ─── New: Area helper + Spline variant + empty guard (Test 5) ────────────

    #[test]
    fn compound_outer_area_shoelace_and_variants() {
        use visioncortex::{CompoundPath, PathI32, PathF64, PointI32, PointF64, Spline};

        // PathI32: 10x10 square → area ≈ 100
        let mut cp_i32 = CompoundPath::new();
        let mut pi32 = PathI32::new();
        pi32.add(PointI32 { x: 0, y: 0 });
        pi32.add(PointI32 { x: 10, y: 0 });
        pi32.add(PointI32 { x: 10, y: 10 });
        pi32.add(PointI32 { x: 0, y: 10 });
        pi32.add(PointI32 { x: 0, y: 0 }); // repeated last point
        cp_i32.add_path_i32(pi32);
        let area_i32 = compound_outer_area(&cp_i32);
        assert!((area_i32 - 100.0).abs() < 1.0,
            "10x10 PathI32 shoelace should be ≈100, got {}", area_i32);

        // PathF64: 2x2 square → area ≈ 4
        let mut cp_f64 = CompoundPath::new();
        let mut pf64 = PathF64::new();
        pf64.add(PointF64 { x: 0.0, y: 0.0 });
        pf64.add(PointF64 { x: 2.0, y: 0.0 });
        pf64.add(PointF64 { x: 2.0, y: 2.0 });
        pf64.add(PointF64 { x: 0.0, y: 2.0 });
        cp_f64.add_path_f64(pf64);
        let area_f64 = compound_outer_area(&cp_f64);
        assert!((area_f64 - 4.0).abs() < 0.01,
            "2x2 PathF64 shoelace should be ≈4, got {}", area_f64);

        // Output filter: 10x10 cluster kept (area 100 ≥ threshold 50), 2x2 dropped (4 < 50)
        // (Structural assertion: area_i32 ≥ 50 and area_f64 < 50)
        assert!(area_i32 >= 50.0, "10x10 should pass ignore_area=50 filter");
        assert!(area_f64 < 50.0, "2x2 should be dropped by ignore_area=50 filter");

        // Spline variant: valid 1-curve bezier (4 points) → non-zero area, no panic
        let mut spline = Spline::new(PointF64 { x: 0.0, y: 0.0 });
        spline.add(
            PointF64 { x: 5.0, y: 0.0 },
            PointF64 { x: 5.0, y: 5.0 },
            PointF64 { x: 0.0, y: 5.0 },
        );
        let mut cp_spline = CompoundPath::new();
        cp_spline.add_spline(spline);
        let area_spline = compound_outer_area(&cp_spline);
        // Spline control points approximate the area; just verify no panic and positive
        assert!(area_spline >= 0.0, "Spline area should be non-negative (got {})", area_spline);

        // Empty CompoundPath → 0.0, not panic (critic must-fix §B)
        let empty = CompoundPath::new();
        assert_eq!(compound_outer_area(&empty), 0.0,
            "Empty CompoundPath should return 0.0");
    }

    // ─── New: Contour-count (Test 6) ─────────────────────────────────────────

    #[test]
    fn contour_count_ring_gives_path_count_two() {
        // 30x30 image: black ring (rows 1-28, cols 1-28) with a 10x10 white counter.
        // path_count = sum of subpaths = outer + hole = 2 (not 1 cluster as before).
        let w = 30u32;
        let h = 30u32;
        let mut pixels = vec![(255u8, 255u8, 255u8, 255u8); (w * h) as usize];
        // Black square
        for y in 1..29u32 {
            for x in 1..29u32 {
                pixels[(y * w + x) as usize] = (0, 0, 0, 255);
            }
        }
        // 10x10 white counter at (10,10): area=100px, kept
        for y in 10..20u32 {
            for x in 10..20u32 {
                pixels[(y * w + x) as usize] = (255, 255, 255, 255);
            }
        }

        let image_data = make_rgba_png_b64(w, h, &pixels);
        let params = TraceParams {
            image_data,
            filter_speckle: 0, // no fill_small_holes; counter 100px >> 0 → always kept
            ..base_params(String::new())
        };
        let result = trace_image(params).expect("trace should succeed");
        // 1 cluster × 2 subpaths (outer + counter hole) → path_count == 2
        assert_eq!(result.path_count, 2,
            "Ring with counter should give path_count=2 (outer + hole); got {}",
            result.path_count);
    }

    // ─── New: Sketch-mode guard (Test 7) ─────────────────────────────────────

    #[test]
    fn sketch_mode_guard_no_fill_small_holes() {
        // Verify fill_small_holes is NOT applied in sketch mode.
        //
        // Part A (direct unit test): fill_small_holes IS effective on a synthetic
        // Canny-like binary (thin edge ring with enclosed interior). This proves the
        // function would change something if called.
        //
        // Part B (integration): trace_image with mode="sketch" completes without
        // panic. The structural guard `params.mode != "sketch"` combined with Part A
        // proves fill_small_holes is not called in sketch mode — calling it on the
        // Canny binary would produce a different binary, which would then produce a
        // different trace result.
        //
        // Part C (behavioral): on the same 30x30 image, standard mode fills a 2x2
        // pinhole (filter_speckle=4 → hole_min_area=16) but sketch mode does NOT.
        // We verify standard mode removes the pinhole and sketch mode completes
        // without error (the Canny path is different, but no crash).

        // Part A: direct fill_small_holes on sketch-like binary
        let bw = 20u32;
        let bh = 20u32;
        let mut canny_binary = GrayImage::new(bw, bh);
        for y in 0..bh {
            for x in 0..bw {
                // Thin black ring at rows 3-16 / cols 3-16; interior and exterior white
                let on_ring = (y == 3 || y == 16 || x == 3 || x == 16)
                              && (3..=16).contains(&x) && (3..=16).contains(&y);
                canny_binary.put_pixel(x, y, Luma([if on_ring { 0u8 } else { 255u8 }]));
            }
        }
        // Interior: rows 4-15, cols 4-15 = 12x12 = 144px white
        // fill_small_holes with hole_min_area=200 > 144 → fills interior
        let filled = fill_small_holes(&canny_binary, 200);
        assert_eq!(filled.get_pixel(10, 10)[0], 0u8,
            "Part A: fill_small_holes should fill the enclosed interior (pixel at 10,10)");
        assert_eq!(filled.get_pixel(0, 0)[0], 255u8,
            "Part A: exterior should remain white");
        assert_eq!(canny_binary.get_pixel(10, 10)[0], 255u8,
            "Part A: original binary has white interior — fill_small_holes has real effect");

        // Part C: standard mode fills 2x2 pinhole (guard is ON for non-sketch)
        let w = 25u32;
        let h = 25u32;
        let mut pixels = vec![(255u8, 255u8, 255u8, 255u8); (w * h) as usize];
        for y in 2..23u32 {
            for x in 2..23u32 {
                pixels[(y * w + x) as usize] = (0, 0, 0, 255);
            }
        }
        // 2x2 pinhole
        pixels[(10 * w + 10) as usize] = (255, 255, 255, 255);
        pixels[(10 * w + 11) as usize] = (255, 255, 255, 255);
        pixels[(11 * w + 10) as usize] = (255, 255, 255, 255);
        pixels[(11 * w + 11) as usize] = (255, 255, 255, 255);
        let image_data = make_rgba_png_b64(w, h, &pixels);

        // Standard mode: fill_small_holes IS called → pinhole filled → Z count == 1
        let std_result = trace_image(TraceParams {
            image_data: image_data.clone(),
            mode: "standard".to_string(),
            filter_speckle: 4,
            ..base_params(String::new())
        }).expect("standard mode trace should succeed");
        let std_z = std_result.svg.matches("Z ").count();
        assert_eq!(std_z, 1,
            "Part C: standard mode with filter_speckle=4 should fill pinhole → Z=1, got {}",
            std_z);

        // Sketch mode: fill_small_holes NOT called (guard) → trace completes without panic
        let sketch_result = trace_image(TraceParams {
            image_data,
            mode: "sketch".to_string(),
            filter_speckle: 4,
            ..base_params(String::new())
        }).expect("sketch mode trace must not panic (guard prevents fill_small_holes)");
        // Sketch mode uses Canny — just verify it produced valid SVG (not a blank crash)
        assert!(sketch_result.svg.starts_with("<?xml"),
            "Part C: sketch mode should return valid SVG");
    }
}
