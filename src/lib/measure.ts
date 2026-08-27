/**
 * Pure measurement helpers for the Measure tool.
 * All functions are side-effect-free and unit-testable.
 */

import type { DesignObject } from "../app/types";

export interface MeasurePoint {
  x: number;
  y: number;
}

export interface SnapPoint {
  x: number;
  y: number;
  kind: "corner" | "center" | "rim";
}

/** Euclidean distance in mm between two world-coordinate points. */
export function measureDistance(p1: MeasurePoint, p2: MeasurePoint): number {
  // Degenerate case: identical points -> 0, never NaN.
  return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

/**
 * Angle from p1 to p2, in degrees, 0–360°, counter-clockwise from the +X axis
 * as the user SEES it on screen.
 *
 * Screen Y is DOWN, so we negate the Y delta before calling atan2 so that
 * an up-and-right vector (positive X, negative screen-Y) reads ~30° rather
 * than ~330°.  This matches the mathematical CCW convention that users expect
 * from physical measuring tools.
 *
 * Convention: 0° = right (+X), 90° = up (−screen Y), 180° = left, 270° = down.
 */
export function measureAngleDeg(p1: MeasurePoint, p2: MeasurePoint): number {
  // Negate dy: screen Y is down, we want math-CCW (Y up = positive angle).
  const rad = Math.atan2(-(p2.y - p1.y), p2.x - p1.x);
  const deg = rad * (180 / Math.PI);
  return ((deg % 360) + 360) % 360;
}

/** Format a measure label from distance (mm) and angle (degrees). */
export function formatMeasureLabel(distMm: number, angleDeg: number): string {
  return `${distMm.toFixed(1)} mm  ·  ${angleDeg.toFixed(1)}°`;
}

/**
 * Diameter readout for an ellipse/circle object.
 *
 * Circle (w ≈ h, within 0.5 mm): returns "Ø 12.0 mm"
 * Ellipse: returns "12.0 × 8.0 mm"
 *
 * Limitation (documented): axes come from local transform.width/height.
 * For a ROTATED ellipse the on-screen axes differ from the local axes — this
 * is an acceptable v1 limitation, using local dimensions for the readout.
 */
export function ellipseDiameter(obj: DesignObject): string {
  const w = obj.transform.width;
  const h = obj.transform.height;
  if (Math.abs(w - h) < 0.5) {
    return `Ø ${w.toFixed(1)} mm`;
  }
  return `${w.toFixed(1)} × ${h.toFixed(1)} mm`;
}

/**
 * Find the nearest snap point to (worldX, worldY) within thresholdMm.
 *
 * Snap targets per object:
 *   - 4 bbox corners + center (all object types)
 *   - For ellipse objects: the 4 axis-RIM points (cardinal on-curve points at
 *     ±semi-axis from center), so a click across a hole snaps to the rim and
 *     measures the TRUE DIAMETER, not the bbox diagonal.
 *
 * Performance: objects whose bbox center is farther than threshold are skipped
 * before expanding path anchors (cheap bbox cull).
 *
 * Threshold: zoom-aware (≈8 screen px / zoom), CLAMPED to [0.5, 10] mm so that
 * extreme zoom-out can't snap to far objects and extreme zoom-in can still snap.
 *
 * @param worldX      cursor X in world mm
 * @param worldY      cursor Y in world mm
 * @param thresholdMm clamped snap radius in mm
 * @param objects     array of design objects to snap against
 * @returns nearest snap point or null
 */
export function findNearestSnapPoint(
  worldX: number,
  worldY: number,
  thresholdMm: number,
  objects: DesignObject[]
): SnapPoint | null {
  // Clamp threshold to sane range
  const thresh = Math.max(0.5, Math.min(10, thresholdMm));

  let bestDist = thresh;
  let bestPt: SnapPoint | null = null;

  for (const obj of objects) {
    if (!obj.visible) continue;

    const t = obj.transform;
    const cx = t.x + t.width / 2;
    const cy = t.y + t.height / 2;

    // Cheap bbox-cull: skip if object center is too far away
    // (using center-to-cursor distance as a loose filter)
    if (Math.hypot(worldX - cx, worldY - cy) > thresh + Math.hypot(t.width, t.height) / 2) {
      continue;
    }

    // Candidate snap points
    const candidates: SnapPoint[] = [
      // 4 corners
      { x: t.x, y: t.y, kind: "corner" },
      { x: t.x + t.width, y: t.y, kind: "corner" },
      { x: t.x, y: t.y + t.height, kind: "corner" },
      { x: t.x + t.width, y: t.y + t.height, kind: "corner" },
      // center
      { x: cx, y: cy, kind: "center" },
    ];

    // For ellipses: add the 4 axis-rim points (cardinal on-curve points)
    // These sit at the ends of the semi-axes, on the ellipse curve.
    if (obj.type === "ellipse") {
      const rx = t.width / 2;
      const ry = t.height / 2;
      candidates.push(
        { x: cx + rx, y: cy, kind: "rim" }, // east
        { x: cx - rx, y: cy, kind: "rim" }, // west
        { x: cx, y: cy + ry, kind: "rim" }, // south
        { x: cx, y: cy - ry, kind: "rim" } // north
      );
    }

    for (const pt of candidates) {
      const d = Math.hypot(worldX - pt.x, worldY - pt.y);
      if (d < bestDist) {
        bestDist = d;
        bestPt = pt;
      }
    }
  }

  return bestPt;
}

/**
 * Compute a zoom-aware snap threshold in mm.
 * ~8 screen pixels at the current zoom level, clamped to [0.5, 10] mm.
 *
 * @param zoom     current camera zoom factor
 * @param pxPerMm  screen pixels per mm (PX_PER_MM constant)
 */
export function snapThresholdMm(zoom: number, pxPerMm: number): number {
  const rawMm = 8 / (zoom * pxPerMm);
  return Math.max(0.5, Math.min(10, rawMm));
}
