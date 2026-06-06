/**
 * D2 regression: group rotation must be composed onto children in flattenObjects.
 * Tests assert on flattenObjects OUTPUT (flattened coords + rotation field).
 * These tests must FAIL on original code and PASS after the fix.
 *
 * Coordinate convention:
 *   - Child transform.x/y is child's top-left corner relative to GROUP top-left
 *   - Group transform.x/y is group's top-left in workspace coords
 *   - AABB center of child in group-local space = (childX + w/2, childY + h/2)
 *   - Rotating point (px, py) around (cx, cy) by angle θ:
 *       rx = cx + (px - cx)*cos(θ) - (py - cy)*sin(θ)
 *       ry = cy + (px - cx)*sin(θ) + (py - cy)*cos(θ)
 *
 * For a group with rotation r_g:
 *   - group center = (gx + gw/2, gy + gh/2)
 *   - child center in group-local space = (gx + cx + cw/2, gy + cy + ch/2)
 *     (where cx/cy are child.transform.x/y relative to group top-left)
 *   - flattened child center = rotate (gx+cx+cw/2, gy+cy+ch/2) around (gx+gw/2, gy+gh/2) by r_g
 *   - flattened rotation = r_g + r_c (normalized) for PRIMITIVES
 *
 * For PATH/LINE children (points[] stores absolute workspace coords):
 *   - group rotation r_g must be physically applied to each point (and handle)
 *     by rotating around the group center
 *   - the rotation field is kept as r_c (child's own rotation) — r_g is already baked
 *     into the points so downstream does not double-apply it
 *   - transform.x/y/width/height are recomputed from the rotated points' AABB
 */
import { describe, it, expect } from "vitest";
import { flattenObjectsForTest } from "../gcodeGen";
import type { DesignObject } from "../../../app/types";

const EPS = 1e-9;

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
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

function makeGroup(id: string, x: number, y: number, w: number, h: number, rotation: number, children: DesignObject[]): DesignObject {
  return {
    id,
    type: "group",
    name: `Group ${id}`,
    transform: { x, y, width: w, height: h, rotation, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#ffffff",
    strokeWidth: 0,
    opacity: 1,
    children,
  };
}

/**
 * Make a path child as it would appear when stored inside a group.
 * points[] are absolute workspace coords (NOT relative to group).
 * transform.x/y is child top-left relative to GROUP top-left.
 * transform.width/height is the AABB of the points.
 */
function makePath(
  id: string,
  points: Array<{ x: number; y: number }>,
  transformX: number,
  transformY: number,
  rotation = 0,
): DesignObject {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(...xs) - minX;
  const h = Math.max(...ys) - minY;
  return {
    id,
    type: "path",
    name: `Path ${id}`,
    transform: { x: transformX, y: transformY, width: w, height: h, rotation, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    points: points.map((p) => ({ x: p.x, y: p.y })),
    closed: false,
  };
}

/** Rotate point (px, py) around (cx, cy) by angle degrees */
function rotatePoint(px: number, py: number, cx: number, cy: number, deg: number) {
  const r = deg * Math.PI / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return {
    x: cx + (px - cx) * cos - (py - cy) * sin,
    y: cy + (px - cx) * sin + (py - cy) * cos,
  };
}

describe("D2 — flattenObjects composes group rotation onto children", () => {
  // (a) group rotated 90° — exact hand-computed child center + rotation = 90 + child's own (0)
  it("(a) group rotated 90° flattens child to correct center and rotation", () => {
    // Group: top-left at (10, 10), 40×40, rotated 90°
    // Child: top-left at (5, 5) relative to group, 10×10, rotation 0
    // Child center in workspace = (10+5+5, 10+5+5) = (20, 20)
    // Group center = (10+20, 10+20) = (30, 30)
    // After 90° rotation around (30,30): rotatePoint(20,20, 30,30, 90)
    //   rx = 30 + (20-30)*cos90 - (20-30)*sin90 = 30 + 0 - (-10) = 40
    //   ry = 30 + (20-30)*sin90 + (20-30)*cos90 = 30 + (-10) + 0 = 20
    //   flattened child center = (40, 20)
    //   flattened x = 40 - 5 = 35, y = 20 - 5 = 15
    const child = makeRect("c1", 5, 5, 10, 10, 0);
    const group = makeGroup("g1", 10, 10, 40, 40, 90, [child]);
    const result = flattenObjectsForTest([group]);
    expect(result).toHaveLength(1);
    const flat = result[0];

    const groupCx = 10 + 40 / 2; // 30
    const groupCy = 10 + 40 / 2; // 30
    const childCxLocal = 10 + 5 + 10 / 2; // 20
    const childCyLocal = 10 + 5 + 10 / 2; // 20
    const rotated = rotatePoint(childCxLocal, childCyLocal, groupCx, groupCy, 90);
    const expectedX = rotated.x - 10 / 2;
    const expectedY = rotated.y - 10 / 2;

    expect(approx(flat.transform.x, expectedX)).toBe(true);
    expect(approx(flat.transform.y, expectedY)).toBe(true);
    expect(approx(flat.transform.rotation, 90)).toBe(true);
  });

  // (b) child with own rotation r_c inside group rotated r_g → emitted rotation exactly r_g + r_c
  it("(b) child with own rotation inside rotated group emits r_g + r_c (no double-apply)", () => {
    const child = makeRect("c2", 0, 0, 10, 10, 30); // r_c = 30
    const group = makeGroup("g2", 0, 0, 20, 20, 45, [child]); // r_g = 45
    const result = flattenObjectsForTest([group]);
    expect(result).toHaveLength(1);
    expect(approx(result[0].transform.rotation, 75)).toBe(true); // 45 + 30
  });

  // (c) un-transformed group → children unchanged (regression guard)
  it("(c) group with rotation=0 and translation: children get only translation applied", () => {
    const child = makeRect("c3", 5, 5, 10, 10, 15); // r_c = 15
    const group = makeGroup("g3", 100, 200, 50, 50, 0, [child]); // no rotation
    const result = flattenObjectsForTest([group]);
    expect(result).toHaveLength(1);
    const flat = result[0];
    // With rotation=0, child center does NOT move from group rotation (only translation)
    expect(approx(flat.transform.x, 100 + 5)).toBe(true);
    expect(approx(flat.transform.y, 200 + 5)).toBe(true);
    expect(approx(flat.transform.rotation, 15)).toBe(true);
  });

  // (d) single ungrouped object — rotation flows through unchanged
  it("(d) ungrouped object rotation flows through unmodified", () => {
    const obj = makeRect("solo", 10, 10, 30, 30, 45);
    const result = flattenObjectsForTest([obj]);
    expect(result).toHaveLength(1);
    expect(approx(result[0].transform.rotation, 45)).toBe(true);
    expect(approx(result[0].transform.x, 10)).toBe(true);
    expect(approx(result[0].transform.y, 10)).toBe(true);
  });

  // Combined: two children in a rotated group
  it("two children in rotated group get independent rotated centers + combined angles", () => {
    const child1 = makeRect("ca", 0, 0, 10, 10, 0);
    const child2 = makeRect("cb", 20, 0, 10, 10, 10); // r_c = 10
    const group = makeGroup("g4", 0, 0, 30, 30, 90, [child1, child2]);
    const result = flattenObjectsForTest([group]);
    expect(result).toHaveLength(2);

    const groupCx = 15, groupCy = 15;
    // child1 center = (5, 5)
    const r1 = rotatePoint(5, 5, groupCx, groupCy, 90);
    // child2 center = (25, 5)
    const r2 = rotatePoint(25, 5, groupCx, groupCy, 90);

    const f1 = result.find((o) => o.id === "ca")!;
    const f2 = result.find((o) => o.id === "cb")!;

    expect(approx(f1.transform.x, r1.x - 5)).toBe(true);
    expect(approx(f1.transform.y, r1.y - 5)).toBe(true);
    expect(approx(f1.transform.rotation, 90)).toBe(true);

    expect(approx(f2.transform.x, r2.x - 5)).toBe(true);
    expect(approx(f2.transform.y, r2.y - 5)).toBe(true);
    expect(approx(f2.transform.rotation, 100)).toBe(true); // 90 + 10
  });
});

describe("D2 — flattenObjects composes group rotation onto PATH/LINE children (points are absolute)", () => {
  /**
   * Razor's empirical case:
   *   path with points (0,0)-(10,10), stored inside a group rotated 90°.
   *   Group: x=0, y=0, w=10, h=10, rotation=90
   *   Path child: transform={x:0, y:0, w:10, h:10, rotation:0}
   *               points=[{x:0,y:0},{x:10,y:10}]  (absolute workspace coords)
   *
   *   Group center: (5, 5)
   *   Rotate (0,0) around (5,5) by 90°:  rx=5+(0-5)*0-(0-5)*1=10,  ry=5+(0-5)*1+(0-5)*0=0  → (10,0)
   *   Rotate (10,10) around (5,5) by 90°: rx=5+(10-5)*0-(10-5)*1=0, ry=5+(10-5)*1+(10-5)*0=10 → (0,10)
   *
   *   Expected composed output:
   *     points = [{x:10,y:0},{x:0,y:10}]  (physically rotated)
   *     transform.rotation = 0  (r_c — group rotation baked into points, NOT added again)
   *     transform.x/y/w/h = AABB of rotated points = {x:0,y:0,w:10,h:10}
   *
   *   This test MUST be RED before the fix and GREEN after.
   */
  it("(path-a) Razor case: path (0,0)-(10,10) in group rotated 90° — points physically rotated, rotation stays r_c", () => {
    // Points are absolute workspace coords matching the group's AABB (group at 0,0 10×10)
    const pathChild = makePath("p1", [{ x: 0, y: 0 }, { x: 10, y: 10 }], 0, 0, 0);
    const group = makeGroup("g-path-a", 0, 0, 10, 10, 90, [pathChild]);
    const result = flattenObjectsForTest([group]);
    expect(result).toHaveLength(1);
    const flat = result[0];

    // Group center
    const gcx = 5, gcy = 5;

    // Rotated points
    const p0 = rotatePoint(0, 0, gcx, gcy, 90);  // expect (10, 0)
    const p1 = rotatePoint(10, 10, gcx, gcy, 90); // expect (0, 10)

    expect(flat.points).toBeDefined();
    expect(flat.points!.length).toBe(2);
    expect(approx(flat.points![0].x, p0.x)).toBe(true);
    expect(approx(flat.points![0].y, p0.y)).toBe(true);
    expect(approx(flat.points![1].x, p1.x)).toBe(true);
    expect(approx(flat.points![1].y, p1.y)).toBe(true);

    // rotation must be r_c (0) — NOT r_g + r_c (90)
    // because r_g is already baked into the point positions
    expect(approx(flat.transform.rotation, 0)).toBe(true);
  });

  it("(path-b) path child with own rotation r_c in group rotated r_g — points get r_g baked, rotation stays r_c", () => {
    // Group at (10,10), 20×20, rotated 45°
    // Path child: transform={x:5,y:5,w:10,h:10,rotation:30}
    // Points absolute: (15,15),(25,25)  (= group.x + child.transform.x + corners)
    const pathChild = makePath("p2", [{ x: 15, y: 15 }, { x: 25, y: 25 }], 5, 5, 30);
    const group = makeGroup("g-path-b", 10, 10, 20, 20, 45, [pathChild]);
    const result = flattenObjectsForTest([group]);
    expect(result).toHaveLength(1);
    const flat = result[0];

    // Group center
    const gcx = 20, gcy = 20;

    // Points after r_g=45 rotation
    const p0 = rotatePoint(15, 15, gcx, gcy, 45);
    const p1 = rotatePoint(25, 25, gcx, gcy, 45);

    expect(flat.points).toBeDefined();
    expect(flat.points!.length).toBe(2);
    expect(approx(flat.points![0].x, p0.x)).toBe(true);
    expect(flat.points!.length).toBe(2);
    expect(approx(flat.points![1].x, p1.x)).toBe(true);

    // rotation = r_c (30), not r_g + r_c (75)
    expect(approx(flat.transform.rotation, 30)).toBe(true);
  });

  it("(path-c) group with rotation=0 — path points unchanged, only transform.x/y gets group translation rebased", () => {
    // Group at (100,200), no rotation
    // Path child: transform={x:0,y:0,...}, points absolute at (100,200),(110,210)
    const pathChild = makePath("p3", [{ x: 100, y: 200 }, { x: 110, y: 210 }], 0, 0, 0);
    const group = makeGroup("g-path-c", 100, 200, 10, 10, 0, [pathChild]);
    const result = flattenObjectsForTest([group]);
    expect(result).toHaveLength(1);
    const flat = result[0];

    // Points should be unchanged (no rotation to apply)
    expect(flat.points).toBeDefined();
    expect(approx(flat.points![0].x, 100)).toBe(true);
    expect(approx(flat.points![0].y, 200)).toBe(true);
    expect(approx(flat.points![1].x, 110)).toBe(true);
    expect(approx(flat.points![1].y, 210)).toBe(true);
    expect(approx(flat.transform.rotation, 0)).toBe(true);
  });
});
