/**
 * Shared geometry utilities for polygon offset operations.
 * Used by both gcodeGen.ts (kerf offset) and geometryActions.ts (path offset tool).
 */

/**
 * Offset a closed ring of points by a distance using vertex-normal averaging.
 * Positive distance offsets outward (assuming CCW winding), negative inward.
 */
export function offsetRingByDistance(
  ring: Array<[number, number]>,
  distance: number,
): Array<[number, number]> {
  const n = ring.length;
  if (n < 3) return ring;
  const closed = ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring;
  const len = pts.length;
  const result: Array<[number, number]> = [];

  for (let i = 0; i < len; i++) {
    const prev = pts[(i - 1 + len) % len];
    const curr = pts[i];
    const next = pts[(i + 1) % len];
    const dx1 = curr[0] - prev[0], dy1 = curr[1] - prev[1];
    const dx2 = next[0] - curr[0], dy2 = next[1] - curr[1];
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
    const nx1 = -dy1 / len1, ny1 = dx1 / len1;
    const nx2 = -dy2 / len2, ny2 = dx2 / len2;
    const nx = nx1 + nx2, ny = ny1 + ny2;
    const nlen = Math.sqrt(nx * nx + ny * ny) || 1;
    result.push([curr[0] + (nx / nlen) * distance, curr[1] + (ny / nlen) * distance]);
  }
  if (result.length > 0) result.push([result[0][0], result[0][1]]);
  return result;
}
