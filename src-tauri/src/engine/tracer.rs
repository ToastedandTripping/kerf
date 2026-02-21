use base64::Engine;
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use visioncortex::PathSimplifyMode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceParams {
    pub image_data: String,
    pub mode: String, // "standard" or "sketch"
    pub threshold: u8,
    pub corner_threshold: i32,
    pub filter_speckle: usize,
    pub invert: bool,
    pub preview_scale: f32,
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
    // 1. Strip data URI prefix and decode base64
    let base64_data = params
        .image_data
        .split(',')
        .nth(1)
        .unwrap_or(&params.image_data);

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    // 2. Load image
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("Image decode error: {}", e))?;

    let (orig_w, orig_h) = img.dimensions();

    // 3. Optionally resize for preview
    let img = if params.preview_scale < 1.0 {
        let new_w = ((orig_w as f32) * params.preview_scale).max(1.0) as u32;
        let new_h = ((orig_h as f32) * params.preview_scale).max(1.0) as u32;
        img.resize(new_w, new_h, image::imageops::FilterType::Triangle)
    } else {
        img
    };

    let (w, h) = img.dimensions();

    // 4. Apply thresholding or edge detection based on mode
    let binary_rgba = match params.mode.as_str() {
        "sketch" => {
            let gray = img.to_luma8();
            let low = (params.threshold as f32 * 0.25).max(1.0);
            let high = params.threshold as f32;
            let edges = imageproc::edges::canny(&gray, low, high);

            let mut rgba = image::RgbaImage::new(w, h);
            for (x, y, pixel) in edges.enumerate_pixels() {
                let val = if params.invert {
                    255 - pixel[0]
                } else {
                    pixel[0]
                };
                // Edge pixels (white) become dark for tracing in Binary mode
                let color = if val > 0 {
                    [0, 0, 0, 255]
                } else {
                    [255, 255, 255, 255]
                };
                rgba.put_pixel(x, y, image::Rgba(color));
            }
            rgba
        }
        _ => {
            // Standard threshold binarization
            let gray = img.to_luma8();
            let mut rgba = image::RgbaImage::new(w, h);
            for (x, y, pixel) in gray.enumerate_pixels() {
                let is_foreground = if params.invert {
                    pixel[0] >= params.threshold
                } else {
                    pixel[0] < params.threshold
                };
                let color = if is_foreground {
                    [0, 0, 0, 255]
                } else {
                    [255, 255, 255, 255]
                };
                rgba.put_pixel(x, y, image::Rgba(color));
            }
            rgba
        }
    };

    // 5. Convert to visioncortex ColorImage (expects raw RGBA bytes)
    let pixels: Vec<u8> = binary_rgba.into_raw();

    let color_image = vtracer::ColorImage {
        pixels,
        width: w as usize,
        height: h as usize,
    };

    // 6. Run vtracer conversion
    let config = vtracer::Config {
        color_mode: vtracer::ColorMode::Binary,
        hierarchical: vtracer::Hierarchical::Stacked,
        filter_speckle: params.filter_speckle,
        corner_threshold: params.corner_threshold,
        mode: PathSimplifyMode::Spline,
        ..Default::default()
    };

    let svg_file = vtracer::convert(color_image, config)?;

    // 7. Count paths and convert to string
    let path_count = svg_file.paths.len();
    let svg = svg_file.to_string();

    Ok(TraceResult {
        svg,
        path_count,
        width_px: orig_w,
        height_px: orig_h,
    })
}
