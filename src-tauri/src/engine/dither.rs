/// Dithering algorithms for image engraving
///
/// Converts grayscale images to binary (black/white) pixel data suitable
/// for laser engraving scan lines. Each algorithm produces different visual
/// characteristics optimized for various material/image combinations.

/// Available dithering algorithms
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DitherAlgorithm {
    Threshold,
    Ordered,        // Bayer 4x4 matrix
    FloydSteinberg,
    Jarvis,         // Jarvis-Judice-Ninke
    Stucki,
    Atkinson,
    Grayscale,      // No dithering - pass-through for variable power (M4)
    Newsprint,      // Halftone dots: grid of cells with size-proportional circles
}

impl DitherAlgorithm {
    pub fn from_str(s: &str) -> Self {
        match s {
            "threshold" => Self::Threshold,
            "ordered" => Self::Ordered,
            "floydSteinberg" => Self::FloydSteinberg,
            "jarvis" => Self::Jarvis,
            "stucki" => Self::Stucki,
            "atkinson" => Self::Atkinson,
            "grayscale" => Self::Grayscale,
            "newsprint" => Self::Newsprint,
            _ => Self::FloydSteinberg, // default
        }
    }
}

/// Bayer 4x4 ordered dithering matrix (normalized to 0-255 range)
const BAYER_4X4: [[u8; 4]; 4] = [
    [  0, 128,  32, 160],
    [192,  64, 224,  96],
    [ 48, 176,  16, 144],
    [240, 112, 208,  80],
];

/// Dither a grayscale image using the specified algorithm.
///
/// Input: grayscale pixel data, 1 byte per pixel (0=black, 255=white)
/// Output: dithered pixel data (0 or 255 per pixel, except Grayscale which passes through 0-255)
pub fn dither_image(
    pixels: &[u8],
    width: u32,
    height: u32,
    algorithm: DitherAlgorithm,
    threshold: u8,
) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    if w * h != pixels.len() {
        return pixels.to_vec();
    }

    match algorithm {
        DitherAlgorithm::Threshold => dither_threshold(pixels, threshold),
        DitherAlgorithm::Ordered => dither_ordered(pixels, w, h),
        DitherAlgorithm::FloydSteinberg => dither_floyd_steinberg(pixels, w, h),
        DitherAlgorithm::Jarvis => dither_jarvis(pixels, w, h),
        DitherAlgorithm::Stucki => dither_stucki(pixels, w, h),
        DitherAlgorithm::Atkinson => dither_atkinson(pixels, w, h),
        DitherAlgorithm::Grayscale => pixels.to_vec(), // pass-through
        DitherAlgorithm::Newsprint => dither_newsprint(pixels, w, h, 6, 45.0),
    }
}

fn dither_threshold(pixels: &[u8], threshold: u8) -> Vec<u8> {
    pixels.iter().map(|&p| if p > threshold { 255 } else { 0 }).collect()
}

fn dither_ordered(pixels: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut output = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            let threshold = BAYER_4X4[y % 4][x % 4];
            output[idx] = if pixels[idx] > threshold { 255 } else { 0 };
        }
    }
    output
}

/// Error diffusion helper: applies error to neighbor if in bounds
#[inline]
fn distribute_error(buffer: &mut [i16], w: usize, h: usize, x: usize, y: usize, dx: i32, dy: i32, error: i16, weight: i16, divisor: i16) {
    let nx = x as i32 + dx;
    let ny = y as i32 + dy;
    if nx >= 0 && nx < w as i32 && ny >= 0 && ny < h as i32 {
        let idx = ny as usize * w + nx as usize;
        buffer[idx] += error * weight / divisor;
    }
}

fn dither_floyd_steinberg(pixels: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut buffer: Vec<i16> = pixels.iter().map(|&p| p as i16).collect();
    let mut output = vec![0u8; w * h];

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            let old = buffer[idx].clamp(0, 255);
            let new_val: i16 = if old > 127 { 255 } else { 0 };
            output[idx] = new_val as u8;
            let error = old - new_val;

            // Floyd-Steinberg kernel:
            //       * 7/16
            // 3/16 5/16 1/16
            distribute_error(&mut buffer, w, h, x, y, 1, 0, error, 7, 16);
            distribute_error(&mut buffer, w, h, x, y, -1, 1, error, 3, 16);
            distribute_error(&mut buffer, w, h, x, y, 0, 1, error, 5, 16);
            distribute_error(&mut buffer, w, h, x, y, 1, 1, error, 1, 16);
        }
    }
    output
}

fn dither_jarvis(pixels: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut buffer: Vec<i16> = pixels.iter().map(|&p| p as i16).collect();
    let mut output = vec![0u8; w * h];

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            let old = buffer[idx].clamp(0, 255);
            let new_val: i16 = if old > 127 { 255 } else { 0 };
            output[idx] = new_val as u8;
            let error = old - new_val;

            // Jarvis-Judice-Ninke kernel (divisor = 48):
            //           * 7 5
            // 3 5 7 5 3
            // 1 3 5 3 1
            distribute_error(&mut buffer, w, h, x, y, 1, 0, error, 7, 48);
            distribute_error(&mut buffer, w, h, x, y, 2, 0, error, 5, 48);
            distribute_error(&mut buffer, w, h, x, y, -2, 1, error, 3, 48);
            distribute_error(&mut buffer, w, h, x, y, -1, 1, error, 5, 48);
            distribute_error(&mut buffer, w, h, x, y, 0, 1, error, 7, 48);
            distribute_error(&mut buffer, w, h, x, y, 1, 1, error, 5, 48);
            distribute_error(&mut buffer, w, h, x, y, 2, 1, error, 3, 48);
            distribute_error(&mut buffer, w, h, x, y, -2, 2, error, 1, 48);
            distribute_error(&mut buffer, w, h, x, y, -1, 2, error, 3, 48);
            distribute_error(&mut buffer, w, h, x, y, 0, 2, error, 5, 48);
            distribute_error(&mut buffer, w, h, x, y, 1, 2, error, 3, 48);
            distribute_error(&mut buffer, w, h, x, y, 2, 2, error, 1, 48);
        }
    }
    output
}

fn dither_stucki(pixels: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut buffer: Vec<i16> = pixels.iter().map(|&p| p as i16).collect();
    let mut output = vec![0u8; w * h];

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            let old = buffer[idx].clamp(0, 255);
            let new_val: i16 = if old > 127 { 255 } else { 0 };
            output[idx] = new_val as u8;
            let error = old - new_val;

            // Stucki kernel (divisor = 42):
            //           * 8 4
            // 2 4 8 4 2
            // 1 2 4 2 1
            distribute_error(&mut buffer, w, h, x, y, 1, 0, error, 8, 42);
            distribute_error(&mut buffer, w, h, x, y, 2, 0, error, 4, 42);
            distribute_error(&mut buffer, w, h, x, y, -2, 1, error, 2, 42);
            distribute_error(&mut buffer, w, h, x, y, -1, 1, error, 4, 42);
            distribute_error(&mut buffer, w, h, x, y, 0, 1, error, 8, 42);
            distribute_error(&mut buffer, w, h, x, y, 1, 1, error, 4, 42);
            distribute_error(&mut buffer, w, h, x, y, 2, 1, error, 2, 42);
            distribute_error(&mut buffer, w, h, x, y, -2, 2, error, 1, 42);
            distribute_error(&mut buffer, w, h, x, y, -1, 2, error, 2, 42);
            distribute_error(&mut buffer, w, h, x, y, 0, 2, error, 4, 42);
            distribute_error(&mut buffer, w, h, x, y, 1, 2, error, 2, 42);
            distribute_error(&mut buffer, w, h, x, y, 2, 2, error, 1, 42);
        }
    }
    output
}

/// Newsprint / halftone dithering: grid of cells with proportional dots.
/// Grid is rotated by `angle` degrees to avoid Moire with scan lines.
///
/// For each cell: compute average brightness, draw filled circle of proportional
/// radius at cell center. `r = cell_size/2 * sqrt(1 - avg/255)`.
fn dither_newsprint(pixels: &[u8], w: usize, h: usize, cell_size: usize, angle: f64) -> Vec<u8> {
    let mut output = vec![255u8; w * h]; // start white
    let cell = cell_size.max(2);
    let half = cell as f64 / 2.0;
    let max_r = half;

    let angle_rad = angle * std::f64::consts::PI / 180.0;
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

    // We iterate over a rotated grid. To cover the entire image, we need to
    // overscan in the rotated coordinate system.
    let diagonal = ((w * w + h * h) as f64).sqrt();
    let grid_min = -(diagonal as i32);
    let grid_max = diagonal as i32;
    let cell_i = cell as i32;

    // Iterate over grid cell centers in rotated space
    let mut gy = grid_min;
    while gy <= grid_max {
        let mut gx = grid_min;
        while gx <= grid_max {
            // Cell center in rotated space
            let cx_rot = gx as f64 + half;
            let cy_rot = gy as f64 + half;

            // Transform to image space (inverse rotation)
            let img_cx = cx_rot * cos_a + cy_rot * sin_a;
            let img_cy = -cx_rot * sin_a + cy_rot * cos_a;

            // Check if cell center is within image bounds (with margin)
            if img_cx < -(cell as f64) || img_cx > (w + cell) as f64
                || img_cy < -(cell as f64) || img_cy > (h + cell) as f64
            {
                gx += cell_i;
                continue;
            }

            // Collect average brightness from pixels within this cell
            let mut sum = 0u64;
            let mut count = 0u64;
            for dy in 0..cell {
                for dx in 0..cell {
                    // Point in rotated space
                    let px_rot = gx as f64 + dx as f64;
                    let py_rot = gy as f64 + dy as f64;
                    // Transform to image space
                    let px = (px_rot * cos_a + py_rot * sin_a).round() as i32;
                    let py = (-px_rot * sin_a + py_rot * cos_a).round() as i32;
                    if px >= 0 && px < w as i32 && py >= 0 && py < h as i32 {
                        sum += pixels[py as usize * w + px as usize] as u64;
                        count += 1;
                    }
                }
            }

            if count == 0 {
                gx += cell_i;
                continue;
            }

            let avg = sum as f64 / count as f64;
            // r = max_r * sqrt(1 - avg/255): darker = bigger dot
            let darkness = 1.0 - avg / 255.0;
            if darkness < 0.01 {
                gx += cell_i;
                continue; // nearly white, skip
            }
            let r = max_r * darkness.sqrt();
            let r_sq = r * r;

            // Draw filled circle at (img_cx, img_cy) with radius r
            let ix_min = ((img_cx - r).floor() as i32).max(0);
            let ix_max = ((img_cx + r).ceil() as i32).min(w as i32 - 1);
            let iy_min = ((img_cy - r).floor() as i32).max(0);
            let iy_max = ((img_cy + r).ceil() as i32).min(h as i32 - 1);

            for iy in iy_min..=iy_max {
                for ix in ix_min..=ix_max {
                    let dx = ix as f64 - img_cx;
                    let dy = iy as f64 - img_cy;
                    if dx * dx + dy * dy <= r_sq {
                        output[iy as usize * w + ix as usize] = 0; // black
                    }
                }
            }

            gx += cell_i;
        }
        gy += cell_i;
    }

    output
}

fn dither_atkinson(pixels: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut buffer: Vec<i16> = pixels.iter().map(|&p| p as i16).collect();
    let mut output = vec![0u8; w * h];

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            let old = buffer[idx].clamp(0, 255);
            let new_val: i16 = if old > 127 { 255 } else { 0 };
            output[idx] = new_val as u8;
            let error = old - new_val;

            // Atkinson kernel: 6 neighbors, each gets 1/8 of error
            // (2/8 of error is intentionally discarded for higher contrast)
            //       * 1 1
            //   1 1 1
            //     1
            distribute_error(&mut buffer, w, h, x, y, 1, 0, error, 1, 8);
            distribute_error(&mut buffer, w, h, x, y, 2, 0, error, 1, 8);
            distribute_error(&mut buffer, w, h, x, y, -1, 1, error, 1, 8);
            distribute_error(&mut buffer, w, h, x, y, 0, 1, error, 1, 8);
            distribute_error(&mut buffer, w, h, x, y, 1, 1, error, 1, 8);
            distribute_error(&mut buffer, w, h, x, y, 0, 2, error, 1, 8);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newsprint_from_str() {
        assert_eq!(DitherAlgorithm::from_str("newsprint"), DitherAlgorithm::Newsprint);
    }

    #[test]
    fn newsprint_uniform_white_stays_white() {
        let pixels = vec![255u8; 20 * 20];
        let result = dither_image(&pixels, 20, 20, DitherAlgorithm::Newsprint, 128);
        assert_eq!(result.len(), 400);
        // Uniform white should produce all-white output (no dots)
        assert!(result.iter().all(|&p| p == 255), "Expected all white pixels for uniform white input");
    }

    #[test]
    fn newsprint_uniform_black_produces_dots() {
        let pixels = vec![0u8; 24 * 24];
        let result = dither_image(&pixels, 24, 24, DitherAlgorithm::Newsprint, 128);
        assert_eq!(result.len(), 576);
        // Uniform black should produce a regular dot pattern (some black pixels)
        let black_count = result.iter().filter(|&&p| p == 0).count();
        assert!(black_count > 0, "Expected some black pixels for uniform black input");
    }
}
