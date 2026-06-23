/**
 * speedScale.ts — Log-scale slider helpers for speed inputs.
 *
 * The slider pos range is 0–1000 (integer steps). Mapping is logarithmic so
 * the low end (100–1000 mm/min, where engraving lives) gets real travel.
 *
 * FLOOR boundary: every map fn computes effectiveFloor = Math.min(floor, max)
 * so the slider NEVER inverts when a machine's $110/$111 cap is below the
 * nominal floor (e.g. max=30 < SPEED_SLIDER_FLOOR=50). In that case both
 * bounds collapse to max and every position maps to the same value — sane
 * (no inversion, monotonic-non-decreasing), and the number field is still
 * authoritative for exact values.
 */

export const SPEED_FALLBACK_MAX = 30000; // mm/min — used when GRBL max unknown
export const SPEED_SLIDER_FLOOR = 50;    // mm/min — log-scale low end

/** Coerce non-finite values (NaN / ±Infinity from empty/garbage fields) to a
 *  safe positive number before they can reach Math.log. */
export function safeNum(v: number, fallback = 1): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Logarithmic interpolation: slider position (0–1000) → speed (mm/min).
 *  pos is clamped to [0, 1000] before mapping. */
export function sliderPosToSpeed(
  pos: number,
  max: number,
  floor: number = SPEED_SLIDER_FLOOR,
): number {
  const safeMax = safeNum(max, SPEED_FALLBACK_MAX);
  const effectiveFloor = Math.min(floor, safeMax);
  const p = Math.max(0, Math.min(1000, pos)) / 1000;
  const logFloor = Math.log(effectiveFloor);
  const logMax = Math.log(safeMax);
  return Math.round(Math.exp(logFloor + (logMax - logFloor) * p));
}

/** Inverse: speed (mm/min) → slider position (0–1000).
 *  Sub-floor speeds clamp to 0 (number field is authoritative for them). */
export function speedToSliderPos(
  speed: number,
  max: number,
  floor: number = SPEED_SLIDER_FLOOR,
): number {
  const safeMax = safeNum(max, SPEED_FALLBACK_MAX);
  const effectiveFloor = Math.min(floor, safeMax);
  const safeSpeed = safeNum(speed, effectiveFloor);
  if (safeSpeed <= effectiveFloor) return 0;
  if (safeSpeed >= safeMax) return 1000;
  const logFloor = Math.log(effectiveFloor);
  const logMax = Math.log(safeMax);
  return Math.round(((Math.log(safeSpeed) - logFloor) / (logMax - logFloor)) * 1000);
}

/** Clamp speed to [1, max], coercing non-finite to 1. */
export function clampSpeed(speed: number, max: number): number {
  const safeMax = safeNum(max, SPEED_FALLBACK_MAX);
  return Math.max(1, Math.min(safeMax, safeNum(speed, 1)));
}

/** Derive the effective max from GRBL $110 (X) and $111 (Y) feed-rate settings.
 *  Both must be > 0 (connected and parsed); otherwise falls back to SPEED_FALLBACK_MAX.
 *  The minimum of the two axes is the real bottleneck. */
export function effectiveMaxSpeed(grblMaxX: number, grblMaxY: number): number {
  if (grblMaxX > 0 && grblMaxY > 0) {
    return Math.min(grblMaxX, grblMaxY);
  }
  return SPEED_FALLBACK_MAX;
}
