/**
 * Shared geometry utilities for polygon offset operations, group transform composition,
 * and the points/transform invariant helpers.
 * Used by gcodeGen.ts, geometryActions.ts, toolHandler.ts, and Viewport.tsx.
 *
 * INVARIANT (W1b): for every points-bearing object (path/line), transform.x/y/width/height
 * is ALWAYS the axis-aligned bounding box of its anchor points (anchors only — bezier
 * handles may overshoot; the bbox is a selection/handle frame, not a render bound).
 * Points carry the geometry; the transform is a derived, synced AABB plus the rotation
 * field. Every writer that moves or scales a points-bearing object must route through
 * movePartial / scalePartial / pointsPartial below so the invariant holds by construction.
 *
 * PURITY: these helpers are pure — they always return NEW points arrays with NEW point
 * and handle objects. Points arrays are aliased across paste/duplicate/array copies and
 * undo snapshots; in-place mutation corrupts undo history and copies. The ONLY permitted
 * in-place mutation context is the load-time migration (fresh-parsed JSON, pre-store).
 */

import type { DesignObject, PathPoint, Transform } from "../../app/types";

/**
 * D2: Apply a group's rotation to a PRIMITIVE child's transform, composing center
 * position and rotation angle so that G-code and Viewport render agree.
 *
 * The child's AABB center is rotated around the group's center by r_g.
 * The child's own rotation r_c is combined: emitted rotation = r_g + r_c (normalized).
 * This is the transform-geometry (rectangle/ellipse/text/image) half of the group
 * composition — downstream (Rust gcode_gen.rs, Viewport applyObjectRotation) applies
 * the combined rotation to the generated geometry. Path/line children carry their
 * geometry in group-local points[] and compose through composeGroupChild instead.
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
 * Rotate a PathPoint (and its optional bezier handles) around a center by degrees.
 * Used by composeGroupChild (group rotation onto path/line children) and the
 * load-time rotation bake in the W1b migration.
 */
export function rotatePathPoint(
  pt: { x: number; y: number; handleIn?: { x: number; y: number }; handleOut?: { x: number; y: number } },
  cx: number,
  cy: number,
  deg: number,
): { x: number; y: number; handleIn?: { x: number; y: number }; handleOut?: { x: number; y: number } } {
  const rad = deg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  function rotXY(x: number, y: number): { x: number; y: number } {
    const dx = x - cx;
    const dy = y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  }

  const p = rotXY(pt.x, pt.y);
  return {
    x: p.x,
    y: p.y,
    handleIn: pt.handleIn ? rotXY(pt.handleIn.x, pt.handleIn.y) : undefined,
    handleOut: pt.handleOut ? rotXY(pt.handleOut.x, pt.handleOut.y) : undefined,
  };
}

// --- W1b: points/transform invariant helpers ---

/** Comparison epsilon for the points/transform invariant (mm). Incremental drags
 *  accumulate float drift, so exact equality is never asserted. */
export const POINTS_EPSILON = 1e-6;

/** Minimum scale TARGET dimension (mm) for points-bearing objects in scalePartial.
 *  Per-keystroke numeric entry (Properties W/H) calls scalePartial with transient
 *  targets — typing "0.5" fires width 0 on the first keystroke. An exact-zero
 *  target collapses every anchor onto one coordinate, and the degenerate-SOURCE
 *  guard then pins scale 1 for every later keystroke: the axis geometry is
 *  unrecoverable for the rest of the edit. Clamping the target to this floor keeps
 *  relative anchor proportions, so the next keystroke rescales losslessly.
 *  MUST be comfortably above POINTS_EPSILON — clamping to the comparison epsilon
 *  itself would leave the clamped state degenerate-by-guard and re-open the
 *  trapdoor. 0.01mm is far below laser kerf, so the transient state is invisible. */
export const MIN_SCALE_TARGET = 0.01;

/** A partial object update produced by the invariant-maintaining helpers. */
export interface GeometryPartial {
  points?: PathPoint[];
  transform: Transform;
}

function isPointsBearing(obj: DesignObject): boolean {
  return (obj.type === "path" || obj.type === "line") && !!obj.points && obj.points.length > 0;
}

/**
 * Anchors-only AABB of a points array. Loop-based on purpose — never spread
 * into Math.min/max (RangeError on multi-thousand-point traces).
 */
export function pointsBBox(points: ReadonlyArray<PathPoint>): { x: number; y: number; width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Pure translation of a points array — fresh point and handle objects, never mutates. */
export function translatePoints(points: ReadonlyArray<PathPoint>, dx: number, dy: number): PathPoint[] {
  const result: PathPoint[] = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    result[i] = {
      ...p,
      x: p.x + dx,
      y: p.y + dy,
      handleIn: p.handleIn ? { x: p.handleIn.x + dx, y: p.handleIn.y + dy } : undefined,
      handleOut: p.handleOut ? { x: p.handleOut.x + dx, y: p.handleOut.y + dy } : undefined,
    };
  }
  return result;
}

/**
 * Move an object to (newX, newY). For points-bearing objects, shifts every anchor
 * AND handle by (newX − transform.x, newY − transform.y) and derives the new
 * transform x/y/width/height from the SHIFTED points bbox (self-healing: identical
 * to newX/newY when the invariant holds, repairs drift when it doesn't).
 * For transform-geometry objects, writes transform x/y only. PURE.
 */
export function movePartial(obj: DesignObject, newX: number, newY: number): GeometryPartial {
  if (!isPointsBearing(obj)) {
    return { transform: { ...obj.transform, x: newX, y: newY } };
  }
  const dx = newX - obj.transform.x;
  const dy = newY - obj.transform.y;
  const points = translatePoints(obj.points!, dx, dy);
  const bb = pointsBBox(points);
  return {
    points,
    transform: { ...obj.transform, x: bb.x, y: bb.y, width: bb.width, height: bb.height },
  };
}

/**
 * Scale/move an object so its bbox becomes `target` — an old-bbox → new-bbox affine
 * map over anchors AND handles, applied in the unrotated frame the points live in.
 * Applies REGARDLESS of the object's rotation field (the rotation rides along
 * untouched; skipping points-scaling on rotated paths would re-manufacture the
 * transform/points desync at the one writer left unpinned). Degenerate guards:
 * a zero/near-zero source dimension maps with scale 1 on that axis (offsets
 * preserved, anchors land on the target origin); zero/sub-ε TARGET dimensions
 * clamp to MIN_SCALE_TARGET — never a divide-by-zero, and never an irreversible
 * anchor collapse (the per-keystroke W/H entry fires width 0 while typing "0.5";
 * the clamp lives HERE so every present and future caller is protected). The new
 * transform derives from the mapped anchors bbox (self-healing, same as
 * movePartial). PURE.
 */
export function scalePartial(
  obj: DesignObject,
  target: { x: number; y: number; width: number; height: number },
): GeometryPartial {
  if (!isPointsBearing(obj)) {
    return {
      transform: {
        ...obj.transform,
        x: target.x, y: target.y, width: target.width, height: target.height,
      },
    };
  }
  const t = obj.transform;
  // Clamp the TARGET (points-bearing only): a zero/sub-ε target would collapse
  // anchors onto one coordinate, which the degenerate-SOURCE guard below then
  // freezes for the rest of the edit. The ε-state retains relative proportions,
  // so the next keystroke recovers the axis losslessly. See MIN_SCALE_TARGET.
  const tw = Math.max(target.width, MIN_SCALE_TARGET);
  const th = Math.max(target.height, MIN_SCALE_TARGET);
  const sx = t.width > POINTS_EPSILON ? tw / t.width : 1;
  const sy = t.height > POINTS_EPSILON ? th / t.height : 1;
  const mapX = (x: number) => target.x + (x - t.x) * sx;
  const mapY = (y: number) => target.y + (y - t.y) * sy;
  const src = obj.points!;
  const points: PathPoint[] = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const p = src[i];
    points[i] = {
      ...p,
      x: mapX(p.x),
      y: mapY(p.y),
      handleIn: p.handleIn ? { x: mapX(p.handleIn.x), y: mapY(p.handleIn.y) } : undefined,
      handleOut: p.handleOut ? { x: mapX(p.handleOut.x), y: mapY(p.handleOut.y) } : undefined,
    };
  }
  const bb = pointsBBox(points);
  return {
    points,
    transform: { ...obj.transform, x: bb.x, y: bb.y, width: bb.width, height: bb.height },
  };
}

/**
 * Replace an object's points wholesale (node edits: move/delete/toggle-smooth) and
 * derive the synced transform from the new anchors bbox. PURE (the caller supplies
 * a fresh points array; this never mutates it).
 */
export function pointsPartial(obj: DesignObject, points: PathPoint[]): GeometryPartial {
  const bb = pointsBBox(points);
  return {
    points,
    transform: { ...obj.transform, x: bb.x, y: bb.y, width: bb.width, height: bb.height },
  };
}

/**
 * Test/sweep helper: throws if a points-bearing object violates the invariant
 * (transform x/y/w/h ≡ anchors-only points bbox, within ε). Recurses into group
 * children — under the group-local convention, child points and child transform
 * share the group-local frame, so the invariant holds at every level.
 */
export function assertPointsInvariant(obj: DesignObject, epsilon: number = POINTS_EPSILON): void {
  if (obj.type === "group" && obj.children) {
    for (const child of obj.children) assertPointsInvariant(child, epsilon);
    return;
  }
  if (!isPointsBearing(obj)) return;
  const bb = pointsBBox(obj.points!);
  const t = obj.transform;
  const drift = Math.max(
    Math.abs(t.x - bb.x), Math.abs(t.y - bb.y),
    Math.abs(t.width - bb.width), Math.abs(t.height - bb.height),
  );
  if (drift > epsilon) {
    throw new Error(
      `points invariant violated for "${obj.id}" (${obj.type}): transform=` +
      `{x:${t.x}, y:${t.y}, w:${t.width}, h:${t.height}} vs pointsBBox=` +
      `{x:${bb.x}, y:${bb.y}, w:${bb.width}, h:${bb.height}} (drift ${drift})`,
    );
  }
}

/**
 * Compose a group's transform onto one child, producing the world-frame child.
 * THE single shared group-flatten composition — consumed by BOTH the Viewport
 * renderer and gcodeGen's flatten so screen and cut can never disagree (the
 * pre-W1b duplication of this math is exactly how D2 happened).
 *
 * Convention (W1b): path/line child points are GROUP-LOCAL (same frame as the
 * child transform). Composition:
 *   - translate points by (g.x, g.y) to world;
 *   - if the group is rotated, physically rotate the world points (and handles)
 *     about the group's world center by r_g, keeping rotation = r_c only (r_g is
 *     baked into the points so downstream must NOT add it again);
 *   - derive transform x/y/w/h from the composed points bbox (invariant holds).
 * Primitive children delegate to composeGroupChildTransform (AABB-center
 * rotation + combined angle, applied downstream). PURE.
 */
export function composeGroupChild(child: DesignObject, group: DesignObject): DesignObject {
  const t = child.transform;
  const g = group.transform;
  const groupRot = g.rotation || 0;

  if ((child.type === "path" || child.type === "line") && child.points && child.points.length >= 1) {
    let worldPoints = translatePoints(child.points, g.x, g.y);
    if (groupRot !== 0) {
      const gcx = g.x + g.width / 2;
      const gcy = g.y + g.height / 2;
      worldPoints = worldPoints.map((pt) => rotatePathPoint(pt, gcx, gcy, groupRot));
    }
    const bb = pointsBBox(worldPoints);
    return {
      ...child,
      points: worldPoints,
      transform: {
        ...t,
        x: bb.x, y: bb.y, width: bb.width, height: bb.height,
        rotation: t.rotation || 0, // r_c only — r_g is baked into the points
      },
    };
  }

  const composed = composeGroupChildTransform(
    t.x, t.y, t.width, t.height, t.rotation || 0,
    g.x, g.y, g.width, g.height, groupRot,
  );
  return {
    ...child,
    transform: { ...t, x: composed.x, y: composed.y, rotation: composed.rotation },
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
