/**
 * Wave 2a — G-code pipeline correctness tests (F3, F4, F5, F6, F7)
 *
 * F3: Non-rect on fill layer → auto-route to offsetFill + warning
 * F4: Grayscale bidirectional reverse-row pixel X positions
 * F5: Image rotation transforms + mirror pixel flips (checked at TS boundary)
 * F6: Kerf offset winding detection, miter corner scaling, rect/ellipse kerf
 * F7: Cut ordering respects user-set layer sequence (layerIndex on CutObject)
 */
import { describe, it, expect } from "vitest";
import { toCutObjectsForTest } from "../gcodeGen";
import { offsetRingByDistance, signedArea } from "../../geometry";
import type { DesignObject, Layer, PathPoint } from "../../../app/types";
import { DEFAULT_LAYERS } from "../../../app/types";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeLayer(overrides: Partial<Layer>, base = DEFAULT_LAYERS[0]): Layer {
  return { ...base, ...overrides };
}

function makeRect(
  id: string,
  opts: { x?: number; y?: number; w?: number; h?: number; layerIndex?: number } = {}
): DesignObject {
  const { x = 0, y = 0, w = 10, h = 10, layerIndex = 0 } = opts;
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x, y, width: w, height: h, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

function makeEllipse(id: string, layerIndex = 0): DesignObject {
  return {
    id,
    type: "ellipse",
    name: `Ellipse ${id}`,
    transform: { x: 0, y: 0, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

function makePath(id: string, points: PathPoint[], layerIndex = 0, closed = true): DesignObject {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
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
    transform: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    },
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

const squarePoints = (x: number, y: number, s: number): PathPoint[] => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];

// ─── F3 (updated): fill mode → maskFill for non-rectangular shapes ───────────
// Phase 2 retires the fill→offsetFill auto-route and replaces it with
// fill→maskFill (hole-aware bitmap scanline fill). The old offsetFill redirect
// warning is removed — even-odd masks fill overlaps once, so no warning needed.

describe("F3 (maskFill): fill mode → maskFill for non-rectangular shapes", () => {
  const fillLayer: Layer = makeLayer({ mode: "fill", index: 0 });
  const fillLayers = [fillLayer, ...DEFAULT_LAYERS.slice(1)];

  it("rectangle on fill layer stays fill (AABB fast path — bbox IS the shape)", () => {
    const { objects, warnings } = toCutObjectsForTest([makeRect("r1")], fillLayers);
    expect(objects).toHaveLength(1);
    expect(objects[0].layer.mode).toBe("fill");
    expect(warnings.some((w) => w.includes("redirected"))).toBe(false);
  });

  it("ungrouped ellipse on fill layer → maskFill (no warning, no offsetFill)", () => {
    const { objects, warnings } = toCutObjectsForTest([makeEllipse("e1")], fillLayers);
    expect(objects).toHaveLength(1);
    expect(objects[0].layer.mode).toBe("maskFill");
    // No redirected warning — even-odd replaces the buggy offsetFill path
    expect(warnings.some((w) => w.includes("redirected"))).toBe(false);
  });

  it("ungrouped path on fill layer → maskFill (retired offsetFill)", () => {
    const path = makePath("p1", squarePoints(0, 0, 10));
    const { objects, warnings } = toCutObjectsForTest([path], fillLayers);
    expect(objects).toHaveLength(1);
    expect(objects[0].layer.mode).toBe("maskFill");
    expect(warnings.some((w) => w.includes("redirected"))).toBe(false);
  });

  it("rectangle on fill layer emits no redirect warning", () => {
    const { warnings } = toCutObjectsForTest([makeRect("r2")], fillLayers);
    expect(warnings.filter((w) => w.includes("redirected"))).toHaveLength(0);
  });
});

// ─── F6: kerf offset — winding detection + miter + rect/ellipse ──────────────

describe("F6: kerf offset direction and winding", () => {
  // Build a CCW square ring (positive signed area in screen-Y-down = CW in standard math)
  // We need the ring winding that previously caused outward expansion with positive kerf.
  const cwSquare: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  const ccwSquare: Array<[number, number]> = [
    [0, 0],
    [0, 10],
    [10, 10],
    [10, 0],
    [0, 0],
  ];

  it("ring with positive signed area + positive kerf → expands outward", () => {
    // cwSquare: right→down→left→up in screen coords (Y-down).
    // Shoelace with Y-down convention: positive area.
    const pts = cwSquare.slice(0, -1);
    expect(signedArea(pts)).toBeGreaterThan(0);
    const offset = offsetRingByDistance(cwSquare, 1.0);
    // All offset points should be further from center (5,5) than original corners (5√2 ≈ 7.07)
    for (const [x, y] of offset.slice(0, -1)) {
      expect(Math.hypot(x - 5, y - 5)).toBeGreaterThan(5 * Math.SQRT2 - 0.001);
    }
  });

  it("ring with negative signed area + positive kerf → expands outward", () => {
    // ccwSquare: right→up→left→down = the reverse winding.
    const pts = ccwSquare.slice(0, -1);
    expect(signedArea(pts)).toBeLessThan(0);
    const offset = offsetRingByDistance(ccwSquare, 1.0);
    for (const [x, y] of offset.slice(0, -1)) {
      expect(Math.hypot(x - 5, y - 5)).toBeGreaterThan(5 * Math.SQRT2 - 0.001);
    }
  });

  it("90° corner offset is within miter range (not the old ~71%)", () => {
    // A right-angle corner: prev=(0,1), curr=(0,0), next=(1,0)
    const ring: Array<[number, number]> = [
      [0, 1],
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const kerf = 1.0;
    const offset = offsetRingByDistance(ring, kerf);
    // The corner (0,0) offset point should be close to (-1,-1) = miter at 90°.
    // Miter factor = 1/cos(45°) ≈ 1.414, so distance along bisector ≈ 1.414.
    // The old unit-normalize gave ~0.707 per axis, total dist ~1.0 (understated).
    // New miter gives ~1.414 total dist from origin — outside the old range.
    const cornerPt = offset[1]; // index 1 = the corner (0,0)
    const distFromOrigin = Math.hypot(cornerPt[0], cornerPt[1]);
    // Miter: should be near sqrt(2)*kerf ≈ 1.414 for 90° corner
    expect(distFromOrigin).toBeGreaterThan(1.3);
    expect(distFromOrigin).toBeLessThan(1.5);
  });

  it("rect on line layer with kerf → generates offset path in CutObject", () => {
    const kerfLayer = makeLayer({ mode: "line", kerfOffset: 0.1, index: 0 });
    const layers = [kerfLayer, ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([makeRect("r1", { w: 20, h: 20 })], layers);
    expect(objects).toHaveLength(1);
    // The kerf rect should generate a path with 4 points (offset corners)
    expect(objects[0].paths.length).toBeGreaterThan(0);
    expect(objects[0].paths[0].points.length).toBeGreaterThanOrEqual(4);
    expect(objects[0].paths[0].closed).toBe(true);
  });

  it("ellipse on line layer with kerf → generates offset path in CutObject", () => {
    const kerfLayer = makeLayer({ mode: "line", kerfOffset: 0.5, index: 0 });
    const layers = [kerfLayer, ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([makeEllipse("e1")], layers);
    expect(objects).toHaveLength(1);
    expect(objects[0].paths.length).toBeGreaterThan(0);
    expect(objects[0].paths[0].points.length).toBeGreaterThanOrEqual(4);
    expect(objects[0].paths[0].closed).toBe(true);
  });
});

// ─── F7: layer index propagated to CutObject ─────────────────────────────────

describe("F7: layerIndex propagated to CutObject for layer-order-respecting cuts", () => {
  it("layerIndex on emitted CutObject matches the source object's layerIndex", () => {
    const layers = [makeLayer({ mode: "line", index: 0 }), makeLayer({ mode: "fill", index: 1 })];
    const r0 = makeRect("r0", { layerIndex: 0 });
    const r1 = makeRect("r1", { layerIndex: 1 });
    const { objects } = toCutObjectsForTest([r0, r1], layers);
    const idx0 = objects.find((o) => o.id === "r0")?.layerIndex;
    const idx1 = objects.find((o) => o.id === "r1")?.layerIndex;
    expect(idx0).toBe(0);
    expect(idx1).toBe(1);
  });

  it("fill layer after line layer preserves source order in emitted objects", () => {
    // toCutObjects sorts by layer POSITION in the layers array (layerIndex).
    // Fix 4: DEFAULT_LAYERS is now [Engrave (index 0), Score (index 1), Cut (index 2), ...].
    // This test uses synthetic layer names but relies on layerIndex ordering:
    // an object with layerIndex=0 always emits before layerIndex=1.
    const r0 = makeRect("first", { layerIndex: 0 }); // first layer (Engrave in new order)
    const r1 = makeRect("second", { layerIndex: 1 }); // second layer (Score in new order)
    const { objects } = toCutObjectsForTest([r1, r0], DEFAULT_LAYERS); // reversed input
    // Should be sorted by layerIndex: 0 first, 1 second
    expect(objects[0].id).toBe("first");
    expect(objects[1].id).toBe("second");
  });
});
