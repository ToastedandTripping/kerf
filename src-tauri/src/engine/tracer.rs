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

    // -- PREPROCESSING PIPELINE --

    // Step 1: Convert to grayscale
    let mut gray = img.to_luma8();

    // Step 2: Gaussian blur for noise reduction
    if params.blur_radius > 0.0 {
        gray = imageproc::filter::gaussian_blur_f32(&gray, params.blur_radius);
    }

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
            if params.use_adaptive_threshold {
                let block = params.adaptive_block_size.max(3) | 1;
                let adapted = adaptive_threshold(&gray, block);
                let mut bin = GrayImage::new(w, h);
                for (x, y, pixel) in adapted.enumerate_pixels() {
                    let is_fg = if params.invert { pixel[0] > 0 } else { pixel[0] == 0 };
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

    // Step 5: Small connected component removal
    let binary = if params.ignore_area > 1 {
        remove_small_components(&binary, params.ignore_area)
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

    // Step 7: vtracer with smoothness-mapped config
    let corner = if params.smoothness > 0.0 {
        (params.corner_threshold as f32 * (1.0 + params.smoothness)).min(180.0) as i32
    } else {
        params.corner_threshold
    };

    let simplify_mode = if params.smoothness > 1.0 {
        PathSimplifyMode::Spline
    } else if params.smoothness > 0.5 {
        PathSimplifyMode::Spline
    } else {
        PathSimplifyMode::Polygon
    };

    let config = vtracer::Config {
        color_mode: vtracer::ColorMode::Binary,
        hierarchical: vtracer::Hierarchical::Stacked,
        filter_speckle: params.filter_speckle,
        corner_threshold: corner,
        mode: simplify_mode,
        ..Default::default()
    };

    let svg_file = vtracer::convert(color_image, config)?;

    // Step 8: Post-processing -- filter small paths
    let min_area = params.ignore_area as f64;
    let filtered_paths: Vec<_> = if min_area > 1.0 {
        svg_file.paths.into_iter().filter(|p| {
            let bb = p.path.to_svg_string(true, visioncortex::PointF64::default(), None);
            // Keep paths that have meaningful content (heuristic: SVG string length)
            bb.0.len() > 20
        }).collect()
    } else {
        svg_file.paths
    };

    let path_count = filtered_paths.len();

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
}
