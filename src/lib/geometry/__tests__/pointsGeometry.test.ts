/**
 * W1b — unit tests for the points/transform invariant helpers.
 *
 * These helpers are the structural fix for F1 (paths can't be moved): every
 * translation/scale writer routes through them, so the invariant
 * (transform x/y/w/h ≡ anchors-only points bbox) holds by construction.
 *
 * Purity is load-bearing: points arrays are aliased across paste/duplicate/array
 * copies and undo snapshots — the helpers must NEVER mutate inputs.
 */
import { describe, it, expect } from "vitest";
import type { DesignObject, PathPoint } from "../../../app/types";
import {
  movePartial,
  scalePartial,
  pointsPartial,
  pointsBBox,
  translatePoints,
  assertPointsInvariant,
  composeGroupChild,
  POINTS_EPSILON,
} from "../index";

function makePath(id: string, points: PathPoint[], rotation = 0): DesignObject {
  const bb = pointsBBox(points);
  return {
    id,
    type: "path",
    name: `Path ${id}`,
    transform: { x: bb.x, y: bb.y, width: bb.width, height: bb.height, rotation, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    points,
    closed: false,
  };
}

function makeRect(id: string, x: number, y: number, w: number, h: number, rotation = 0): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x, y, width: w, height: h, rotation, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

const bezierPoints = (): PathPoint[] => [
  { x: 10, y: 10, handleOut: { x: 15, y: 5 } },
  { x: 30, y: 10, handleIn: { x: 25, y: 5 }, handleOut: { x: 35, y: 15 } },
  { x: 30, y: 30, handleIn: { x: 35, y: 25 } },
];

describe("pointsBBox", () => {
  it("computes anchors-only bbox (handles excluded)", () => {
    const bb = pointsBBox(bezierPoints());
    // handles overshoot to y=5 and x=35 — anchors-only must ignore them
    expect(bb).toEqual({ x: 10, y: 10, width: 20, height: 20 });
  });

  it("returns zero-extent bbox for collinear points (no clamp)", () => {
    const bb = pointsBBox([{ x: 5, y: 7 }, { x: 25, y: 7 }]);
    expect(bb).toEqual({ x: 5, y: 7, width: 20, height: 0 });
  });

  it("handles large arrays without spread (no RangeError)", () => {
    const pts: PathPoint[] = [];
    for (let i = 0; i < 200_000; i++) pts.push({ x: i % 100, y: Math.floor(i / 100) });
    expect(() => pointsBBox(pts)).not.toThrow();
    expect(pointsBBox(pts).x).toBe(0);
  });
});

describe("movePartial", () => {
  it("shifts anchors AND handles by the delta and syncs the transform", () => {
    const obj = makePath("p1", bezierPoints());
    const partial = movePartial(obj, 110, 60); // delta (+100, +50)
    expect(partial.points![0]).toMatchObject({ x: 110, y: 60 });
    expect(partial.points![0].handleOut).toEqual({ x: 115, y: 55 });
    expect(partial.points![1].handleIn).toEqual({ x: 125, y: 55 });
    expect(partial.transform).toMatchObject({ x: 110, y: 60, width: 20, height: 20 });
    assertPointsInvariant({ ...obj, ...partial });
  });

  it("is PURE: never mutates the source points (aliasing safety)", () => {
    const shared = bezierPoints();
    const obj = makePath("p1", shared);
    movePartial(obj, 500, 500);
    expect(shared[0]).toMatchObject({ x: 10, y: 10 });
    expect(shared[0].handleOut).toEqual({ x: 15, y: 5 });
    // fresh arrays and fresh point/handle objects
    const partial = movePartial(obj, 500, 500);
    expect(partial.points).not.toBe(shared);
    expect(partial.points![0]).not.toBe(shared[0]);
    expect(partial.points![0].handleOut).not.toBe(shared[0].handleOut);
  });

  it("self-heals a desynced transform (derives from the shifted points bbox)", () => {
    const obj = makePath("p1", bezierPoints());
    // simulate the legacy corruption: transform drifted away from the points
    obj.transform = { ...obj.transform, x: 999, y: 999 };
    const partial = movePartial(obj, 1009, 1009); // intends a (+10, +10) move
    // points moved by the delta; transform re-derived from the points (healed)
    expect(partial.points![0]).toMatchObject({ x: 20, y: 20 });
    expect(partial.transform.x).toBeCloseTo(20, 9);
    assertPointsInvariant({ ...obj, ...partial });
  });

  it("writes transform-only for transform-geometry objects (rect unchanged behavior)", () => {
    const obj = makeRect("r1", 10, 10, 20, 20);
    const partial = movePartial(obj, 50, 60);
    expect(partial.points).toBeUndefined();
    expect(partial.transform).toMatchObject({ x: 50, y: 60, width: 20, height: 20 });
  });
});

describe("scalePartial", () => {
  it("maps anchors and handles through the old-bbox→new-bbox affine map", () => {
    const obj = makePath("p1", bezierPoints()); // bbox 10,10 20×20
    const partial = scalePartial(obj, { x: 10, y: 10, width: 40, height: 10 }); // sx=2, sy=0.5
    expect(partial.points![0]).toMatchObject({ x: 10, y: 10 });
    expect(partial.points![1]).toMatchObject({ x: 50, y: 10 });
    expect(partial.points![2]).toMatchObject({ x: 50, y: 20 });
    // handleOut (15,5) → x: 10+(15-10)*2 = 20, y: 10+(5-10)*0.5 = 7.5
    expect(partial.points![0].handleOut).toEqual({ x: 20, y: 7.5 });
    expect(partial.transform).toMatchObject({ x: 10, y: 10, width: 40, height: 10 });
    assertPointsInvariant({ ...obj, ...partial });
  });

  it("applies REGARDLESS of rotation — rotation field rides along untouched", () => {
    const obj = makePath("p1", bezierPoints(), 30);
    const partial = scalePartial(obj, { x: 0, y: 0, width: 10, height: 10 });
    expect(partial.points).toBeDefined(); // points DID scale (no rotation guard)
    expect(partial.points![0]).toMatchObject({ x: 0, y: 0 });
    expect(partial.transform.rotation).toBe(30);
    assertPointsInvariant({ ...obj, ...partial });
  });

  it("guards degenerate source dims (no divide-by-zero, offsets preserved)", () => {
    const obj = makePath("p1", [{ x: 5, y: 7 }, { x: 25, y: 7 }]); // height 0
    const partial = scalePartial(obj, { x: 5, y: 20, width: 40, height: 0 });
    expect(Number.isFinite(partial.points![1].x)).toBe(true);
    expect(partial.points![1].x).toBeCloseTo(45, 9); // sx = 2
    expect(partial.points![0].y).toBeCloseTo(20, 9); // sy clamps to 1, anchors land on target.y
    assertPointsInvariant({ ...obj, ...partial });
  });

  it("tolerates zero targets (scale to zero, not NaN)", () => {
    const obj = makePath("p1", bezierPoints());
    const partial = scalePartial(obj, { x: 10, y: 10, width: 0, height: 20 });
    expect(partial.points!.every((p) => Number.isFinite(p.x))).toBe(true);
    expect(partial.points![1].x).toBeCloseTo(10, 9);
  });

  it("is PURE: never mutates the source points", () => {
    const shared = bezierPoints();
    const obj = makePath("p1", shared);
    scalePartial(obj, { x: 0, y: 0, width: 100, height: 100 });
    expect(shared[0]).toMatchObject({ x: 10, y: 10 });
  });

  it("inverse bbox map restores the original points exactly (resize undo)", () => {
    const obj = makePath("p1", bezierPoints());
    const grown = { ...obj, ...scalePartial(obj, { x: 0, y: 0, width: 50, height: 35 }) };
    const restored = { ...grown, ...scalePartial(grown, { x: 10, y: 10, width: 20, height: 20 }) };
    for (let i = 0; i < obj.points!.length; i++) {
      expect(restored.points![i].x).toBeCloseTo(obj.points![i].x, 9);
      expect(restored.points![i].y).toBeCloseTo(obj.points![i].y, 9);
    }
    expect(restored.points![0].handleOut!.x).toBeCloseTo(15, 9);
    expect(restored.points![0].handleOut!.y).toBeCloseTo(5, 9);
  });

  it("writes transform-only for rects (characterization)", () => {
    const obj = makeRect("r1", 10, 10, 20, 20, 45);
    const partial = scalePartial(obj, { x: 5, y: 5, width: 40, height: 40 });
    expect(partial.points).toBeUndefined();
    expect(partial.transform).toMatchObject({ x: 5, y: 5, width: 40, height: 40, rotation: 45 });
  });
});

describe("pointsPartial", () => {
  it("derives the synced transform from a replacement points array", () => {
    const obj = makePath("p1", bezierPoints());
    const newPoints: PathPoint[] = [{ x: 0, y: 0 }, { x: 100, y: 40 }];
    const partial = pointsPartial(obj, newPoints);
    expect(partial.transform).toMatchObject({ x: 0, y: 0, width: 100, height: 40 });
    assertPointsInvariant({ ...obj, ...partial });
  });
});

describe("translatePoints purity", () => {
  it("returns fresh point and handle objects", () => {
    const src = bezierPoints();
    const out = translatePoints(src, 1, 1);
    expect(out).not.toBe(src);
    expect(out[0]).not.toBe(src[0]);
    expect(out[0].handleOut).not.toBe(src[0].handleOut);
    expect(src[0].x).toBe(10);
  });
});

describe("assertPointsInvariant", () => {
  it("passes for a coherent path and throws for a desynced one", () => {
    const obj = makePath("p1", bezierPoints());
    expect(() => assertPointsInvariant(obj)).not.toThrow();
    const corrupt = { ...obj, transform: { ...obj.transform, x: obj.transform.x + 5 } };
    expect(() => assertPointsInvariant(corrupt)).toThrow(/invariant violated/);
  });

  it("tolerates drift below epsilon", () => {
    const obj = makePath("p1", bezierPoints());
    const drifted = { ...obj, transform: { ...obj.transform, x: obj.transform.x + POINTS_EPSILON / 2 } };
    expect(() => assertPointsInvariant(drifted)).not.toThrow();
  });

  it("recurses into group children (group-local frame)", () => {
    const child = makePath("c1", [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    const group: DesignObject = {
      ...makeRect("g1", 50, 50, 10, 10),
      type: "group",
      children: [child],
    };
    expect(() => assertPointsInvariant(group)).not.toThrow();
    const corruptChild = { ...child, transform: { ...child.transform, y: 99 } };
    expect(() => assertPointsInvariant({ ...group, children: [corruptChild] })).toThrow();
  });
});

describe("composeGroupChild (THE shared Viewport/gcodeGen flatten composition)", () => {
  it("rot==0: translates group-local points to world by the group origin", () => {
    const child = makePath("c1", [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    const group = { ...makeRect("g1", 100, 200, 10, 10), type: "group" as const, children: [child] };
    const composed = composeGroupChild(child, group);
    expect(composed.points![0]).toMatchObject({ x: 100, y: 200 });
    expect(composed.points![1]).toMatchObject({ x: 110, y: 210 });
    expect(composed.transform).toMatchObject({ x: 100, y: 200, width: 10, height: 10, rotation: 0 });
    assertPointsInvariant(composed);
  });

  it("rot==0: world output FOLLOWS a group move (the F1 group-move fix)", () => {
    const child = makePath("c1", [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    const group = { ...makeRect("g1", 0, 0, 10, 10), type: "group" as const, children: [child] };
    const before = composeGroupChild(child, group);
    const movedGroup = { ...group, transform: { ...group.transform, x: 40, y: 70 } };
    const after = composeGroupChild(child, movedGroup);
    expect(after.points![0].x - before.points![0].x).toBeCloseTo(40, 9);
    expect(after.points![0].y - before.points![0].y).toBeCloseTo(70, 9);
  });

  it("rot≠0: translates to world then rotates about the group's CURRENT world center", () => {
    const child = makePath("c1", [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    // group moved to (20, 30) — rotation must pivot about the MOVED center (25, 35)
    const group = { ...makeRect("g1", 20, 30, 10, 10, 90), type: "group" as const, children: [child] };
    const composed = composeGroupChild(child, group);
    // world point (20,30) rotated 90° about (25,35): (30, 30)
    expect(composed.points![0].x).toBeCloseTo(30, 9);
    expect(composed.points![0].y).toBeCloseTo(30, 9);
    // world point (30,40) rotated 90° about (25,35): (20, 40)
    expect(composed.points![1].x).toBeCloseTo(20, 9);
    expect(composed.points![1].y).toBeCloseTo(40, 9);
    expect(composed.transform.rotation).toBe(0); // r_c only — r_g baked into points
    assertPointsInvariant(composed);
  });

  it("rotates bezier handles along with anchors", () => {
    const child = makePath("c1", [
      { x: 0, y: 0, handleOut: { x: 5, y: 0 } },
      { x: 10, y: 10 },
    ]);
    const group = { ...makeRect("g1", 0, 0, 10, 10, 90), type: "group" as const, children: [child] };
    const composed = composeGroupChild(child, group);
    // handle (5,0) rotated 90° about (5,5): (10, 5)
    expect(composed.points![0].handleOut!.x).toBeCloseTo(10, 9);
    expect(composed.points![0].handleOut!.y).toBeCloseTo(5, 9);
  });

  it("primitive children keep the AABB-center composition (characterization)", () => {
    const child = makeRect("c1", 5, 5, 10, 10);
    const group = { ...makeRect("g1", 10, 10, 40, 40, 90), type: "group" as const, children: [child] };
    const composed = composeGroupChild(child, group);
    // matches composeGroupChildTransform: child center (20,20) → rotated about (30,30) by 90° → (40,20)
    expect(composed.transform.x).toBeCloseTo(35, 9);
    expect(composed.transform.y).toBeCloseTo(15, 9);
    expect(composed.transform.rotation).toBeCloseTo(90, 9);
  });

  it("is PURE: does not mutate the stored child", () => {
    const pts: PathPoint[] = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
    const child = makePath("c1", pts);
    const group = { ...makeRect("g1", 100, 200, 10, 10, 45), type: "group" as const, children: [child] };
    composeGroupChild(child, group);
    expect(pts[0]).toMatchObject({ x: 0, y: 0 });
    expect(child.transform.x).toBe(0);
  });
});
