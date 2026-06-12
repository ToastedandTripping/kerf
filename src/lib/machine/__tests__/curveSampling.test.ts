/**
 * W1c (F2) — bezier curves cut as curves: adaptive sampling at the
 * toCutObjects serialization boundary.
 *
 * The audit's empirical defect: toCutObjects built CutObject paths via
 * points.map(p => ({x, y})) — handleIn/handleOut dropped, so a 4-anchor
 * bezier circle (convertToPath of an ellipse) cut as a DIAMOND while
 * rendering as a circle. These tests assert on toCutObjects OUTPUT (the
 * production serialization path) and on the sampler's pinned contracts:
 *  - max radial deviation bounded by CURVE_CHORD_TOLERANCE_MM (not point
 *    counts — the sampler may improve)
 *  - the CLOSING segment of a closed bezier path is sampled (interior
 *    samples only; never a terminal point equal to the first anchor —
 *    Rust appends gpts[0] to close the ring)
 *  - NO consecutive duplicate points in any serialized path (ε = POINTS_EPSILON
 *    on emit — NOT the chord tolerance: anchors 0.001mm apart both survive)
 *  - straight-segment paths byte-identical to the pre-fix serialization
 *  - kerf offset applies AFTER sampling (ring density preserved)
 *  - non-finite coordinates error instead of hanging (depth-capped recursion)
 *  - W1c rider: fill-mode 2×-energy warning for grouped objects on a
 *    non-"line" layer
 */
import { describe, it, expect } from "vitest";
import { toCutObjectsForTest } from "../gcodeGen";
import { sampleBezierPath, CURVE_CHORD_TOLERANCE_MM, POINTS_EPSILON } from "../../geometry";
import type { DesignObject, Layer, PathPoint } from "../../../app/types";
import { DEFAULT_LAYERS } from "../../../app/types";

const K = 0.5522847498; // circle-from-cubics constant (same as convertToPath)

function basePath(id: string, points: PathPoint[], closed: boolean, layerIndex = 0): DesignObject {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    id,
    type: "path",
    name: `Path ${id}`,
    transform: { x: minX, y: minY, width: maxX - minX, height: maxY - minY, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    points,
    closed,
  };
}

/** The 4-anchor bezier circle convertToPath produces for an ellipse. */
function bezierCirclePoints(cx: number, cy: number, r: number): PathPoint[] {
  return [
    { x: cx, y: cy - r, handleIn: { x: cx + r * K, y: cy - r }, handleOut: { x: cx - r * K, y: cy - r } },
    { x: cx - r, y: cy, handleIn: { x: cx - r, y: cy - r * K }, handleOut: { x: cx - r, y: cy + r * K } },
    { x: cx, y: cy + r, handleIn: { x: cx - r * K, y: cy + r }, handleOut: { x: cx + r * K, y: cy + r } },
    { x: cx + r, y: cy, handleIn: { x: cx + r, y: cy + r * K }, handleOut: { x: cx + r, y: cy - r * K } },
  ];
}

function assertNoConsecutiveDuplicates(points: Array<{ x: number; y: number }>): void {
  for (let i = 1; i < points.length; i++) {
    const same =
      Math.abs(points[i].x - points[i - 1].x) <= POINTS_EPSILON &&
      Math.abs(points[i].y - points[i - 1].y) <= POINTS_EPSILON;
    expect(same, `consecutive duplicate at index ${i}: (${points[i].x}, ${points[i].y})`).toBe(false);
  }
}

describe("F2: bezier sampling at toCutObjects serialization", () => {
  it("4-anchor bezier circle: dense polyline within chord tolerance of the true circle (diamond repro dead)", () => {
    const cx = 30, cy = 30, r = 20;
    const obj = basePath("c1", bezierCirclePoints(cx, cy, r), true);
    const { objects } = toCutObjectsForTest([obj], DEFAULT_LAYERS);
    expect(objects).toHaveLength(1);
    const pts = objects[0].paths[0].points;

    // Pre-fix this was the 4 anchors (a diamond: chord-midpoint radial
    // deviation ≈ 0.29r ≈ 5.86mm). The 4-arc cubic approximation itself
    // deviates ≤ ~2.7e-4·r from a true circle; allow tolerance + that margin.
    const bound = CURVE_CHORD_TOLERANCE_MM + 0.001 * r;
    expect(pts.length).toBeGreaterThan(4);
    for (const p of pts) {
      expect(Math.abs(Math.hypot(p.x - cx, p.y - cy) - r)).toBeLessThanOrEqual(bound);
    }
    // Chord midpoints too — sample points alone sit ON the curve and would
    // pass even for sparse sampling.
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length]; // closing chord included (Rust appends gpts[0])
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      expect(Math.abs(Math.hypot(mx - cx, my - cy) - r)).toBeLessThanOrEqual(bound);
    }
    assertNoConsecutiveDuplicates(pts);
    expect(objects[0].paths[0].closed).toBe(true);
  });

  it("CLOSING segment of a closed bezier path is sampled — interior points only, never the first anchor", () => {
    // 3-anchor closed curve, every segment curved INCLUDING the closing one.
    const pts: PathPoint[] = [
      { x: 0, y: 0, handleIn: { x: -10, y: 10 }, handleOut: { x: 10, y: -10 } },
      { x: 40, y: 0, handleIn: { x: 30, y: -10 }, handleOut: { x: 50, y: 10 } },
      { x: 20, y: 30, handleIn: { x: 35, y: 25 }, handleOut: { x: 5, y: 35 } },
    ];
    const obj = basePath("c2", pts, true);
    const { objects } = toCutObjectsForTest([obj], DEFAULT_LAYERS);
    const out = objects[0].paths[0].points;

    // Red-before: 3 anchor points, closing curve cut as a chord.
    expect(out.length).toBeGreaterThan(3);
    // Samples BEYOND the last anchor exist (the closing curve's interior) …
    const lastAnchorIdx = out.findIndex((p) => Math.abs(p.x - 20) < 1e-9 && Math.abs(p.y - 30) < 1e-9);
    expect(lastAnchorIdx).toBeGreaterThan(-1);
    expect(out.length - 1).toBeGreaterThan(lastAnchorIdx);
    // …but the terminal point (= first anchor) is NEVER emitted: Rust appends
    // gpts[0]; a duplicate would make a zero-length G1 seam.
    const last = out[out.length - 1];
    expect(Math.abs(last.x - out[0].x) > POINTS_EPSILON || Math.abs(last.y - out[0].y) > POINTS_EPSILON).toBe(true);
    expect(objects[0].paths[0].closed).toBe(true);
    assertNoConsecutiveDuplicates(out);
  });

  it("straight-segment path serializes byte-identical to the anchors (characterization)", () => {
    const square: PathPoint[] = [
      { x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 },
    ];
    const obj = basePath("s1", square, true);
    const { objects } = toCutObjectsForTest([obj], DEFAULT_LAYERS);
    expect(objects[0].paths[0].points).toEqual([
      { x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 },
    ]);
    expect(objects[0].paths[0].closed).toBe(true);
  });

  it("mixed curved/straight path follows the Viewport's exact per-segment condition", () => {
    // segment 0→1 curved (handleOut+handleIn), segment 1→2 straight
    // (handleOut present but next handleIn missing — renders as lineTo).
    const pts: PathPoint[] = [
      { x: 0, y: 0, handleOut: { x: 10, y: -15 } },
      { x: 30, y: 0, handleIn: { x: 20, y: -15 }, handleOut: { x: 40, y: 15 } },
      { x: 60, y: 0 },
    ];
    const obj = basePath("m1", pts, false);
    const { objects } = toCutObjectsForTest([obj], DEFAULT_LAYERS);
    const out = objects[0].paths[0].points;
    expect(out.length).toBeGreaterThan(3); // curve got dense
    expect(out[out.length - 1]).toEqual({ x: 60, y: 0 }); // straight chord kept
    const idx30 = out.findIndex((p) => Math.abs(p.x - 30) < 1e-9 && Math.abs(p.y) < 1e-9);
    expect(out.length - 1 - idx30).toBe(1); // nothing inserted on the straight segment
  });

  it("ε-dedup uses POINTS_EPSILON, not the chord tolerance: anchors 0.001mm apart BOTH survive", () => {
    const out = sampleBezierPath(
      [{ x: 0, y: 0 }, { x: 0.001, y: 0 }, { x: 10, y: 0 }],
      false,
    );
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 0.001, y: 0 }, { x: 10, y: 0 }]);
  });

  it("exact duplicate anchors are dropped on emit (real imports carry them)", () => {
    const out = sampleBezierPath(
      [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }],
      false,
    );
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  });

  it("closed path with an explicit return-to-start point drops the seam duplicate", () => {
    const out = sampleBezierPath(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 }],
      true,
    );
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });

  it("kerf offset applies AFTER sampling — the offset ring reflects the dense polyline", () => {
    const kerfLayers: Layer[] = [
      { ...DEFAULT_LAYERS[0], kerfOffset: 0.1 },
      ...DEFAULT_LAYERS.slice(1),
    ];
    const obj = basePath("k1", bezierCirclePoints(30, 30, 20), true);
    const { objects } = toCutObjectsForTest([obj], kerfLayers);
    const pts = objects[0].paths[0].points;
    // Offsetting the sparse 4 anchors then sampling would yield 4 points;
    // sampling first yields a dense offset ring.
    expect(pts.length).toBeGreaterThan(50);
    // Every offset point sits ~r+kerf from the center (vertex-normal offset
    // of a dense circle ring).
    for (const p of pts) {
      expect(Math.hypot(p.x - 30, p.y - 30)).toBeGreaterThan(20);
      expect(Math.hypot(p.x - 30, p.y - 30)).toBeLessThan(20.2);
    }
    assertNoConsecutiveDuplicates(pts);
  });

  it("non-finite curve coordinates ERROR instead of hanging Generate", () => {
    expect(() =>
      sampleBezierPath(
        [
          { x: 0, y: 0, handleOut: { x: Infinity, y: 0 } },
          { x: 10, y: 0, handleIn: { x: 5, y: NaN } },
        ],
        false,
      ),
    ).toThrow(/non-finite/);
  });
});

describe("W1c rider: fill-mode 2×-energy warning for grouped objects", () => {
  function groupedSquares(layerIndex: number): DesignObject {
    const child = (id: string, off: number): DesignObject =>
      basePath(id, [
        { x: off, y: off }, { x: off + 10, y: off }, { x: off + 10, y: off + 10 }, { x: off, y: off + 10 },
      ], true, layerIndex);
    const c1 = child("c1", 0);
    const c2 = child("c2", 2);
    return {
      id: "g1",
      type: "group",
      name: "Group 1",
      transform: { x: 0, y: 0, width: 12, height: 12, rotation: 0, scaleX: 1, scaleY: 1 },
      layerIndex,
      visible: true,
      locked: false,
      fill: null,
      stroke: "#ffffff",
      strokeWidth: 0,
      opacity: 1,
      children: [c1, c2],
    };
  }

  it("warns once when ≥2 grouped objects sit on a non-'line' layer", () => {
    const { warnings } = toCutObjectsForTest([groupedSquares(1)], DEFAULT_LAYERS); // layer 1 = Engrave (fill)
    expect(warnings.filter((w) => w.includes("double energy"))).toHaveLength(1);
  });

  it("does NOT warn for a group on a 'line' layer", () => {
    const { warnings } = toCutObjectsForTest([groupedSquares(0)], DEFAULT_LAYERS); // layer 0 = Cut (line)
    expect(warnings.some((w) => w.includes("double energy"))).toBe(false);
  });

  it("does NOT warn for ungrouped fill objects", () => {
    const a = basePath("a", [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true, 1);
    const b = basePath("b", [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }], true, 1);
    const { warnings } = toCutObjectsForTest([a, b], DEFAULT_LAYERS);
    expect(warnings.some((w) => w.includes("double energy"))).toBe(false);
  });
});
