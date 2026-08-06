/// Shared coordinate transform: design/image space -> GRBL machine coordinates.
///
/// Applies optional rotation around a center point, then Y-flip for GRBL's
/// coordinate system (Y=0 at bottom for standard, negated for origin_top).
///
/// This is the single source of truth for the transform used by:
/// - `gcode_gen.rs` (fill arm via `ScanLineParams`)
/// - `mask_fill.rs` (scan_mask_to_gcode inner closure)
/// - `image_gcode_gen.rs` (test helper; production delegates to mask_fill)
///
/// # Arguments
/// * `x_img`, `y_img` — point in design/image space (mm)
/// * `cx`, `cy` — rotation center (mm)
/// * `rotation_rad` — rotation angle in radians (positive = CCW in design space)
/// * `origin_top` — if true, Y is negated (origin at top); else Y = workspace_height - y
/// * `workspace_height` — workspace height in mm (used for Y-flip when !origin_top)
pub(crate) fn to_grbl_coords(
    x_img: f64,
    y_img: f64,
    cx: f64,
    cy: f64,
    rotation_rad: f64,
    origin_top: bool,
    workspace_height: f64,
) -> (f64, f64) {
    let (rx, ry) = if rotation_rad.abs() > 1e-6 {
        let dx = x_img - cx;
        let dy = y_img - cy;
        let cos_r = rotation_rad.cos();
        let sin_r = rotation_rad.sin();
        (cx + dx * cos_r - dy * sin_r, cy + dx * sin_r + dy * cos_r)
    } else {
        (x_img, y_img)
    };
    let gy = if origin_top { -ry } else { workspace_height - ry };
    (rx, gy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_rotation_y_flip() {
        let (x, y) = to_grbl_coords(5.0, 10.0, 0.0, 0.0, 0.0, false, 100.0);
        assert!((x - 5.0).abs() < 1e-10);
        assert!((y - 90.0).abs() < 1e-10);
    }

    #[test]
    fn no_rotation_origin_top() {
        let (x, y) = to_grbl_coords(5.0, 10.0, 0.0, 0.0, 0.0, true, 100.0);
        assert!((x - 5.0).abs() < 1e-10);
        assert!((y - (-10.0)).abs() < 1e-10);
    }

    #[test]
    fn rotation_90_around_center() {
        // Rotate (10, 5) 90deg CCW around (5, 5):
        // dx=5, dy=0 -> rx=5+0-0=5, ry=5+5+0=10
        // Then Y-flip: 100 - 10 = 90
        let (x, y) = to_grbl_coords(
            10.0, 5.0, 5.0, 5.0,
            std::f64::consts::FRAC_PI_2, false, 100.0,
        );
        assert!((x - 5.0).abs() < 1e-6, "x={x}");
        assert!((y - 90.0).abs() < 1e-6, "y={y}");
    }

    #[test]
    fn rotation_45_matches_manual_calc() {
        // Rotate (6, 2) 45deg around (4, 2):
        // dx=2, dy=0, cos=sin=0.7071
        // rx = 4 + 2*0.7071 = 5.4142
        // ry = 2 + 2*0.7071 = 3.4142
        // Y-flip: 200 - 3.4142 = 196.5858
        let (x, y) = to_grbl_coords(
            6.0, 2.0, 4.0, 2.0,
            std::f64::consts::FRAC_PI_4, false, 200.0,
        );
        assert!((x - 5.4142).abs() < 0.001, "x={x}");
        assert!((y - 196.5858).abs() < 0.001, "y={y}");
    }
}
