/**
 * Shared geometry utilities for polygon offset operations and group transform composition.
 * Used by gcodeGen.ts, geometryActions.ts, and Viewport.tsx.
 */

/**
 * D2: Apply a group's rotation to a child's transform, composing center position and
 * rotation angle so that G-code and Viewport render agree.
 *
 * The child's AABB center is rotated around the group's center by r_g.
 * The child's own rotation r_c is combined: emitted rotation = r_g + r_c (normalized).
 * Local point clouds are NOT modified — callers (Rust gcode_gen.rs) rotate using the
 * rotation field, so leaving local points unchanged avoids double-rotation.
 *
 * scaleX/scaleY are sign-only flip flags and are not composited here.
 *
 * @param childX   child.transform.x (relative to group top-left)
 * @param childY   child.transform.y (relative to group top-left)
 * @param childW   child.transform.width
 * @param childH   child.transform.height
 * @param childRot child.transform.rotation (degrees)
 * @param groupX   group.transform.x (workspace coords)
 * @param groupY   group.transform.y (workspace coords)
 * @param groupW   group.transform.width
 * @param groupH   group.transform.height
 * @param groupRot group.transform.rotation (degrees)
 * @returns { x, y, rotation } for the flattened/composed child transform
 */
export function composeGroupChildTransform(
  childX: number, childY: number, childW: number, childH: number, childRot: number,
  groupX: number, groupY: number, groupW: number, groupH: number, groupRot: number,
): { x: number; y: number; rotation: number } {
  if (groupRot === 0) {
    // Fast path: no rotation — only apply translation
    return {
      x: childX + groupX,
      y: childY + groupY,
      rotation: childRot,
    };
  }

  // Group center in workspace coords
  const gcx = groupX + groupW / 2;
  const gcy = groupY + groupH / 2;

  // Child center in workspace coords (before group rotation)
  const childCx = groupX + childX + childW / 2;
  const childCy = groupY + childY + childH / 2;

  // Rotate child center around group center by groupRot degrees
  const rad = groupRot * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotCx = gcx + (childCx - gcx) * cos - (childCy - gcy) * sin;
  const rotCy = gcy + (childCx - gcx) * sin + (childCy - gcy) * cos;

  // Combined rotation angle normalized to [0, 360)
  const combined = ((groupRot + childRot) % 360 + 360) % 360;

  return {
    x: rotCx - childW / 2,
    y: rotCy - childH / 2,
    rotation: combined,
  };
}

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
