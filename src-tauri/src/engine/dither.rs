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
