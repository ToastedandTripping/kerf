/**
 * Compute the acceleration-derived overscan distance for fill/engrave layers.
 *
 * Formula: 1.2 * v² / (2 * a)
 *   where v = speed in mm/s, a = X-axis acceleration in mm/s²
 *   The 1.2 factor adds a 20% safety margin on top of the bare stopping distance.
 *
 * Clamped to [3, 50] mm to prevent absurdly small values at low speeds and
 * absurdly large travel at very high speeds or very low acceleration.
 *
 * @param speedMmMin  Layer speed in mm/min (as stored in Layer.speed)
 * @param accelX      GRBL $120 — X-axis acceleration in mm/s². Pass 0 to use
 *                    the built-in fallback of 300 mm/s².
 */
export function computeOverscan(speedMmMin: number, accelX: number): number {
  if (!Number.isFinite(speedMmMin) || speedMmMin <= 0) return 3;
  const v = speedMmMin / 60; // mm/min → mm/s
  const a = accelX > 0 ? accelX : 300; // fallback: 300 mm/s²
  const raw = (1.2 * (v * v)) / (2 * a);
  return Math.max(3, Math.min(50, raw));
}
