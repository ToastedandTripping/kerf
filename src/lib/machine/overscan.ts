/**
 * Compute the acceleration-derived overscan distance for fill/engrave layers.
 *
 * Formula: max(0.5, 1.2 * v² / (2 * a))
 *   where v = speed in mm/s, a = acceleration in mm/s²
 *   The 1.2 factor adds a 20% safety margin on top of the bare stopping distance.
 *
 * Floor: 0.5 mm — the kinematic minimum at very low speeds on the owner's
 * machine ($120=1000 mm/s²). No upper clamp: a value capped below the actual
 * stopping distance cannot be called a kinematic minimum; existing bounds
 * validation must reject an infeasible job rather than silently shorten ramps.
 *
 * @param speedMmMin  Layer speed in mm/min (as stored in Layer.speed)
 * @param acceleration  Scan-axis acceleration in mm/s². Pass 0 or non-finite
 *                      to use the built-in fallback of 300 mm/s².
 */
export function computeOverscan(speedMmMin: number, acceleration: number): number {
  if (!Number.isFinite(speedMmMin) || speedMmMin <= 0) return 0.5;
  const v = speedMmMin / 60; // mm/min → mm/s
  const a = Number.isFinite(acceleration) && acceleration > 0 ? acceleration : 300; // fallback: 300 mm/s²
  const raw = (1.2 * (v * v)) / (2 * a);
  return Math.max(0.5, raw);
}
