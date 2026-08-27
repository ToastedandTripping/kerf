//! Engine resource limits — caps that prevent oversized or malformed input
//! from hanging the app or exhausting memory.
//!
//! Constants are tuned for a home-shop laser cutter: generous enough that no
//! legitimate job hits them, tight enough that a corrupt `.kerf` file cannot
//! spin an unbounded loop.
//!
//! Env-var overrides (`KERF_MAX_MOVES`, `KERF_MAX_RASTER_PX`) exist so a user
//! can raise the cap for a genuine edge case without rebuilding. The override
//! is read once at first use via `OnceLock`, so it costs zero at runtime.

use std::sync::OnceLock;

// ─── Constants ──────────────────────────────────────────────────────────────

/// Minimum scan-line interval in mm. A corrupt `.kerf` file might store an
/// interval of 1e-9, producing ~1e11 scan segments and hanging the app.
pub const MIN_SCAN_INTERVAL_MM: f64 = 0.01;

/// Maximum raster pixels (width * height) for mask/image engraving.
/// 64 Mpx covers an 8000x8000 mask — far beyond any realistic scan job.
pub const MAX_RASTER_PIXELS: usize = 64_000_000;

/// Maximum G-code move entries before the generator bails. 5M moves is
/// roughly a 250 MB GcodeResult — beyond practical for a desktop app.
pub const MAX_GCODE_MOVES: usize = 5_000_000;

/// Maximum trace pixels (width * height) for image tracing.
pub const MAX_TRACE_PIXELS: usize = 24_000_000;

// ─── Error type ─────────────────────────────────────────────────────────────

/// Limit violation — distinct from geometry/degenerate-input errors so the
/// caller can route: a geometry error skips one object, a limit error fails
/// the whole job (the user must fix the input).
#[derive(Debug, Clone)]
pub enum EngineError {
    /// A resource cap was hit — oversized input that would hang or OOM.
    Limit(String),
    /// Degenerate geometry — the object is nonsensical but the job can
    /// continue without it (skip + warn).
    #[allow(dead_code)]
    Geometry(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::Limit(msg) => write!(f, "limit exceeded: {}", msg),
            EngineError::Geometry(msg) => write!(f, "geometry error: {}", msg),
        }
    }
}

// ─── Env-var overrides (OnceLock — read once, no rebuild needed) ─────────────

fn env_max_moves() -> &'static usize {
    static VAL: OnceLock<usize> = OnceLock::new();
    VAL.get_or_init(|| {
        std::env::var("KERF_MAX_MOVES")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(MAX_GCODE_MOVES)
    })
}

fn env_max_raster_px() -> &'static usize {
    static VAL: OnceLock<usize> = OnceLock::new();
    VAL.get_or_init(|| {
        std::env::var("KERF_MAX_RASTER_PX")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(MAX_RASTER_PIXELS)
    })
}

// ─── Guard functions ────────────────────────────────────────────────────────

/// Validate scan interval, clamping to `MIN_SCAN_INTERVAL_MM` if below.
/// Returns the validated interval (always >= MIN_SCAN_INTERVAL_MM).
pub fn validated_interval(interval: f64) -> f64 {
    if interval < MIN_SCAN_INTERVAL_MM {
        eprintln!(
            "[limits] scan interval {:.6} mm clamped to minimum {} mm",
            interval, MIN_SCAN_INTERVAL_MM
        );
        MIN_SCAN_INTERVAL_MM
    } else {
        interval
    }
}

/// Check raster pixel count against the cap. Returns Err(EngineError::Limit)
/// if the count exceeds the cap (including env override).
pub fn check_raster_pixels(w: usize, h: usize) -> Result<(), EngineError> {
    let count = w.saturating_mul(h);
    let cap = *env_max_raster_px();
    if count > cap {
        Err(EngineError::Limit(format!(
            "raster size {}x{} = {} pixels exceeds cap {} (set KERF_MAX_RASTER_PX to override)",
            w, h, count, cap
        )))
    } else {
        Ok(())
    }
}

/// Check G-code move count against the cap. Returns Err(EngineError::Limit)
/// if the count exceeds the cap (including env override).
pub fn check_move_count(count: usize) -> Result<(), EngineError> {
    let cap = *env_max_moves();
    if count > cap {
        Err(EngineError::Limit(format!(
            "G-code move count {} exceeds cap {} (set KERF_MAX_MOVES to override)",
            count, cap
        )))
    } else {
        Ok(())
    }
}

/// Check trace pixel count against the cap.
pub fn check_trace_pixels(w: usize, h: usize) -> Result<(), EngineError> {
    let count = w.saturating_mul(h);
    if count > MAX_TRACE_PIXELS {
        Err(EngineError::Limit(format!(
            "trace size {}x{} = {} pixels exceeds cap {}",
            w, h, count, MAX_TRACE_PIXELS
        )))
    } else {
        Ok(())
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validated_interval_clamps_tiny() {
        assert!((validated_interval(0.001) - MIN_SCAN_INTERVAL_MM).abs() < 1e-9);
        assert!((validated_interval(1e-9) - MIN_SCAN_INTERVAL_MM).abs() < 1e-9);
    }

    #[test]
    fn validated_interval_passes_normal() {
        assert!((validated_interval(0.1) - 0.1).abs() < 1e-9);
        assert!((validated_interval(1.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn check_raster_pixels_passes_under_cap() {
        assert!(check_raster_pixels(1000, 1000).is_ok());
    }

    #[test]
    fn check_raster_pixels_fails_over_cap() {
        // 10000 * 10000 = 100M > 64M cap
        assert!(check_raster_pixels(10_000, 10_000).is_err());
    }

    #[test]
    fn check_move_count_passes_under_cap() {
        assert!(check_move_count(1_000_000).is_ok());
    }

    #[test]
    fn check_move_count_fails_over_cap() {
        assert!(check_move_count(6_000_000).is_err());
    }

    #[test]
    fn check_trace_pixels_passes_under_cap() {
        assert!(check_trace_pixels(4000, 4000).is_ok());
    }

    #[test]
    fn check_trace_pixels_fails_over_cap() {
        assert!(check_trace_pixels(5000, 5000).is_err());
    }

    #[test]
    fn engine_error_display() {
        let limit = EngineError::Limit("too big".to_string());
        assert!(format!("{}", limit).contains("limit exceeded"));
        let geom = EngineError::Geometry("degenerate".to_string());
        assert!(format!("{}", geom).contains("geometry error"));
    }
}
