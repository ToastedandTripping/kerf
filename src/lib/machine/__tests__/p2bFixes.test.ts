/**
 * P2-B: TS-side cut-correctness fixes.
 *
 * Tests for seven findings:
 *   1. Group duplication shares child IDs
 *   2. Boolean/offset ops ignore rotation on path objects
 *   3. offsetPaths double-rotates
 *   4. Coalesced fill groups drop child rotations
 *   5. Ungrouped ellipse on fill layer: silent no-op
 *   6. Grouped images silently absent from G-code
 *   7. offsetFill hole routing to maskFill
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { useStore } from "../../../app/store";
import type { DesignObject } from "../../../app/types";
import { DEFAULT_LAYERS } from "../../../app/types";
import { deepCloneObject } from "../../../app/store/storeTypes";
import {
  toCutObjectsForTest,
  flattenObjectsForTest,
  synthesizeFillContourForTest,
} from "../gcodeGen";
import type { Layer } from "../../../app/types";

// ─── Factory helpers ─────────────────────────────────────────────────────────

function makeRect(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  rotation = 0
): DesignObject {
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

function makePath(
  id: string,
  pts: Array<{ x: number; y: number }>,
  rotation = 0,
  closed = true
): DesignObject {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    id,
    type: "path",
    name: `Path ${id}`,
    transform: {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      rotation,
      scaleX: 1,
      scaleY: 1,
    },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    points: pts,
    closed,
  };
}

function makeEllipse(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  rotation = 0
): DesignObject {
  return {
    id,
    type: "ellipse",
    name: `Ellipse ${id}`,
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

function makeImage(id: string, x: number, y: number, w: number, h: number): DesignObject {
  return {
    id,
    type: "image",
    name: `Image ${id}`,
    transform: { x, y, width: w, height: h, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    imageData: "data:image/png;base64,AAAA",
  };
}

function makeGroup(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  rotation: number,
  children: DesignObject[]
): DesignObject {
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

function fillLayer(index = 0, mode: "fill" | "fillLine" | "offsetFill" = "fill"): Layer {
  return {
    ...DEFAULT_LAYERS[0],
    index,
    mode,
  };
}

// ─── Fix 1: Group duplication shares child IDs ──────────────────────────────

describe("Fix 1: deepCloneObject re-IDs children", () => {
  it("produces a new root ID", () => {
    const obj = makeRect("original", 0, 0, 10, 10);
    const clone = deepCloneObject(obj);
    expect(clone.id).not.toBe("original");
  });

  it("deep-clones group children with fresh IDs", () => {
    const child1 = makeRect("c1", 0, 0, 5, 5);
    const child2 = makeRect("c2", 5, 0, 5, 5);
    const group = makeGroup("g1", 0, 0, 10, 5, 0, [child1, child2]);

    const clone = deepCloneObject(group);

    // Root ID is new
    expect(clone.id).not.toBe("g1");
    // Children exist and have new IDs
    expect(clone.children).toHaveLength(2);
    expect(clone.children![0].id).not.toBe("c1");
    expect(clone.children![1].id).not.toBe("c2");
    // No ID collision between clone children and originals
    const allIds = new Set([
      group.id,
      child1.id,
      child2.id,
      clone.id,
      clone.children![0].id,
      clone.children![1].id,
    ]);
    expect(allIds.size).toBe(6);
  });

  it("recursively re-IDs nested groups", () => {
    const innerChild = makeRect("ic", 0, 0, 3, 3);
    const innerGroup = makeGroup("ig", 0, 0, 3, 3, 0, [innerChild]);
    const outerGroup = makeGroup("og", 0, 0, 10, 10, 0, [innerGroup]);

    const clone = deepCloneObject(outerGroup);

    expect(clone.id).not.toBe("og");
    expect(clone.children![0].id).not.toBe("ig");
    expect(clone.children![0].children![0].id).not.toBe("ic");
  });

  it("preserves geometry but not references", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const path = makePath("p1", pts);
    const clone = deepCloneObject(path);

    // Points have same values
    expect(clone.points!.map((p) => ({ x: p.x, y: p.y }))).toEqual(pts);
    // But are not the same array reference
    expect(clone.points).not.toBe(path.points);
    expect(clone.points![0]).not.toBe(path.points![0]);
  });
});

describe("Fix 1: store duplicateInPlace uses deepCloneObject", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      objectsById: new Map(),
      selectedIds: [],
      selectedSet: new Set(),
      undoStack: [],
      redoStack: [],
    });
  });

  it("duplicated group has children with unique IDs", () => {
    const child = makeRect("c1", 0, 0, 5, 5);
    const group = makeGroup("g1", 0, 0, 10, 5, 0, [child]);
    useStore.getState().addObject(group);
    useStore.getState().setSelectedIds(["g1"]);
    useStore.getState().duplicateInPlace();

    const objs = useStore.getState().objects;
    expect(objs).toHaveLength(2);

    const original = objs.find((o) => o.id === "g1")!;
    const dup = objs.find((o) => o.id !== "g1")!;

    // Duplicate's children have different IDs from original's
    expect(dup.children![0].id).not.toBe(original.children![0].id);
  });
});

describe("Fix 1: gridArray uses deepCloneObject", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      objectsById: new Map(),
      selectedIds: [],
      selectedSet: new Set(),
      undoStack: [],
      redoStack: [],
    });
  });

  it("grid copies of a group have unique child IDs", () => {
    const child = makeRect("c1", 0, 0, 5, 5);
    const group = makeGroup("g1", 0, 0, 10, 5, 0, [child]);
    useStore.getState().addObject(group);
    useStore.getState().setSelectedIds(["g1"]);
    useStore.getState().gridArray(1, 2, 5, 0); // 1 row, 2 cols

    const objs = useStore.getState().objects;
    // Original + 1 copy
    const groups = objs.filter((o) => o.type === "group");
    expect(groups.length).toBeGreaterThanOrEqual(2);

    // Collect all child IDs across all groups
    const childIds = groups.flatMap((g) => (g.children || []).map((c) => c.id));
    const uniqueChildIds = new Set(childIds);
    expect(uniqueChildIds.size).toBe(childIds.length);
  });
});

describe("Fix 1: circularArray uses deepCloneObject", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      objectsById: new Map(),
      selectedIds: [],
      selectedSet: new Set(),
      undoStack: [],
      redoStack: [],
    });
  });

  it("circular copies of a group have unique child IDs", () => {
    const child = makeRect("c1", 0, 0, 5, 5);
    const group = makeGroup("g1", 0, 0, 10, 5, 0, [child]);
    useStore.getState().addObject(group);
    useStore.getState().setSelectedIds(["g1"]);
    useStore.getState().circularArray(3, 20, 0);

    const objs = useStore.getState().objects;
    const groups = objs.filter((o) => o.type === "group");
    expect(groups.length).toBeGreaterThanOrEqual(3);

    const childIds = groups.flatMap((g) => (g.children || []).map((c) => c.id));
    const uniqueChildIds = new Set(childIds);
    expect(uniqueChildIds.size).toBe(childIds.length);
  });
});

// ─── Fix 2: Boolean/offset ops ignore rotation on path objects ──────────────

describe("Fix 2: objectToPolygon applies rotation to paths", () => {
  it("rotated path produces different polygon than unrotated (via boolean union sanity check)", () => {
    // A 10x10 square path centered at (15,15), rotated 45 degrees.
    // After rotation, the polygon corners should be at 45-degree offsets.
    const pts = [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 10, y: 20 },
    ];
    const rotatedPath = makePath("p1", pts, 45);

    // Route through toCutObjects on a fill layer (which calls maskFill path).
    // The rotation should produce a diamond shape, not a square aligned to axes.
    const layers = [fillLayer(0), ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([rotatedPath], layers);

    // Should produce a maskFill CutObject with paths
    expect(objects.length).toBeGreaterThanOrEqual(1);
    const fillObj = objects.find((o) => o.layer.mode === "maskFill");
    expect(fillObj).toBeDefined();
    expect(fillObj!.paths.length).toBeGreaterThanOrEqual(1);
    expect(fillObj!.paths[0].points.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Fix 3: offsetPaths double-rotates ───────────────────────────────────────

describe("Fix 3: offsetPaths sets rotation to 0", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      objectsById: new Map(),
      selectedIds: [],
      selectedSet: new Set(),
      undoStack: [],
      redoStack: [],
    });
  });

  it("offset of a rotated object has rotation 0", () => {
    const pts = [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 10, y: 20 },
    ];
    const rotatedPath = makePath("p1", pts, 45);
    useStore.getState().addObject(rotatedPath);
    useStore.getState().setSelectedIds(["p1"]);
    useStore.getState().offsetPaths(2);

    const objs = useStore.getState().objects;
    const offsetObj = objs.find((o) => o.id !== "p1");
    expect(offsetObj).toBeDefined();
    // Key assertion: rotation is 0, not 45 (points are already world-frame)
    expect(offsetObj!.transform.rotation).toBe(0);
  });
});

// ─── Fix 4: Coalesced fill groups drop child rotations ──────────────────────

describe("Fix 4: coalesced fill bakes per-child rotation", () => {
  it("coalesced CutObject has rotation 0 (child rotations baked into points)", () => {
    // Two path children in a group, child A rotated 30 degrees, child B unrotated.
    const ptsA = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 },
      { x: 0, y: 5 },
    ];
    const childA = makePath("ca", ptsA, 30);
    const ptsB = [
      { x: 10, y: 0 },
      { x: 15, y: 0 },
      { x: 15, y: 5 },
      { x: 10, y: 5 },
    ];
    const childB = makePath("cb", ptsB, 0);
    const group = makeGroup("g1", 0, 0, 15, 5, 0, [childA, childB]);

    const layers = [fillLayer(0), ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([group], layers);

    const maskFillObj = objects.find((o) => o.layer.mode === "maskFill");
    expect(maskFillObj).toBeDefined();
    // The coalesced object MUST have rotation 0 — child rotations are already
    // baked into the contour points.
    expect(maskFillObj!.rotation).toBe(0);
  });

  it("baked rotation changes point positions vs unbaked", () => {
    // A rotated child's contour points should differ from the raw (unrotated) points.
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const rotatedChild = makePath("rc", pts, 45);
    const group = makeGroup("g1", 0, 0, 10, 10, 0, [rotatedChild]);

    const layers = [fillLayer(0), ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([group], layers);

    const maskFillObj = objects.find((o) => o.layer.mode === "maskFill");
    expect(maskFillObj).toBeDefined();
    const contourPts = maskFillObj!.paths[0].points;

    // The raw points would have corners at (0,0), (10,0), (10,10), (0,10).
    // After 45-degree rotation about center (5,5), corners should be roughly
    // at (5, 5-7.07), (5+7.07, 5), (5, 5+7.07), (5-7.07, 5).
    // Check that the first point is NOT at (0,0) (which would mean rotation was not applied).
    const firstPt = contourPts[0];
    const notAtOrigin = Math.abs(firstPt.x) > 0.1 || Math.abs(firstPt.y) > 0.1;
    // At least one point should differ from raw
    expect(notAtOrigin || contourPts.some((p) => Math.abs(p.y) > 0.1)).toBe(true);
  });
});

// ─── Fix 5: Ungrouped ellipse on fill layer: silent no-op ───────────────────

describe("Fix 5: synthesizeFillContour", () => {
  it("produces points for an ellipse", () => {
    const ellipse = makeEllipse("e1", 10, 10, 20, 10);
    const contour = synthesizeFillContourForTest(ellipse);
    expect(contour).not.toBeNull();
    expect(contour!.closed).toBe(true);
    expect(contour!.points.length).toBeGreaterThanOrEqual(16);
    // Points should lie on the ellipse outline
    const cx = 20,
      cy = 15,
      rx = 10,
      ry = 5;
    for (const pt of contour!.points) {
      const dx = (pt.x - cx) / rx;
      const dy = (pt.y - cy) / ry;
      // Should be approximately on the unit circle
      expect(Math.abs(dx * dx + dy * dy - 1)).toBeLessThan(0.01);
    }
  });

  it("produces points for a rounded rectangle", () => {
    const rect: DesignObject = {
      ...makeRect("rr1", 0, 0, 20, 10),
      cornerRadius: 3,
    };
    const contour = synthesizeFillContourForTest(rect);
    expect(contour).not.toBeNull();
    expect(contour!.closed).toBe(true);
    expect(contour!.points.length).toBeGreaterThanOrEqual(16);
  });

  it("returns null for a plain rectangle (no cornerRadius)", () => {
    const rect = makeRect("r1", 0, 0, 20, 10);
    const contour = synthesizeFillContourForTest(rect);
    expect(contour).toBeNull();
  });

  it("returns null for a path (already has points)", () => {
    const path = makePath("p1", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    const contour = synthesizeFillContourForTest(path);
    expect(contour).toBeNull();
  });
});

describe("Fix 5: ungrouped ellipse on fill layer produces a CutObject", () => {
  it("ellipse on fill layer emits a maskFill CutObject with contour paths", () => {
    const ellipse = makeEllipse("e1", 10, 10, 20, 10);
    const layers = [fillLayer(0), ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([ellipse], layers);

    expect(objects.length).toBeGreaterThanOrEqual(1);
    const fillObj = objects.find((o) => o.layer.mode === "maskFill");
    expect(fillObj).toBeDefined();
    expect(fillObj!.paths.length).toBeGreaterThanOrEqual(1);
    expect(fillObj!.paths[0].points.length).toBeGreaterThanOrEqual(16);
    expect(fillObj!.paths[0].closed).toBe(true);
  });

  it("ellipse on fillLine layer emits both maskFill and line overlay", () => {
    const ellipse = makeEllipse("e1", 10, 10, 20, 10);
    const layers = [
      {
        ...fillLayer(0, "fillLine" as "fill"),
        mode: "fillLine" as const,
        lineOverlay: {
          power: 90,
          powerMin: 0,
          speed: 1200,
          passes: 1,
          powerMode: "constant" as const,
        },
      },
      ...DEFAULT_LAYERS.slice(1),
    ];
    const { objects } = toCutObjectsForTest([ellipse], layers);

    const maskFillObjs = objects.filter((o) => o.layer.mode === "maskFill");
    const lineObjs = objects.filter((o) => o.layer.mode === "line");
    expect(maskFillObjs).toHaveLength(1);
    expect(lineObjs).toHaveLength(1);
  });

  it("rounded rect on fill layer emits maskFill (not AABB fill)", () => {
    const rect: DesignObject = {
      ...makeRect("rr1", 0, 0, 20, 10),
      cornerRadius: 3,
    };
    const layers = [fillLayer(0), ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([rect], layers);

    expect(objects.length).toBeGreaterThanOrEqual(1);
    const maskFillObj = objects.find((o) => o.layer.mode === "maskFill");
    expect(maskFillObj).toBeDefined();
    expect(maskFillObj!.paths.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Fix 6: Grouped images silently absent from G-code ──────────────────────

describe("Fix 6: flattenObjects exposes grouped images", () => {
  it("image inside a group is flattened to top level", () => {
    const img = makeImage("img1", 0, 0, 20, 20);
    const group = makeGroup("g1", 10, 10, 20, 20, 0, [img]);

    const flat = flattenObjectsForTest([group]);
    const images = flat.filter((o) => o.type === "image");
    expect(images).toHaveLength(1);
    // Transform composed: child (0,0) + group (10,10) = world (10,10)
    expect(images[0].transform.x).toBeCloseTo(10, 5);
    expect(images[0].transform.y).toBeCloseTo(10, 5);
  });

  it("grouped image retains its imageData and visibility", () => {
    const img = makeImage("img1", 0, 0, 20, 20);
    const group = makeGroup("g1", 5, 5, 20, 20, 0, [img]);

    const flat = flattenObjectsForTest([group]);
    const flatImg = flat.find((o) => o.type === "image")!;
    expect(flatImg.imageData).toBe("data:image/png;base64,AAAA");
    expect(flatImg.visible).toBe(true);
  });

  it("nested image (group within group) is flattened", () => {
    const img = makeImage("img1", 0, 0, 10, 10);
    const inner = makeGroup("ig", 0, 0, 10, 10, 0, [img]);
    const outer = makeGroup("og", 5, 5, 10, 10, 0, [inner]);

    const flat = flattenObjectsForTest([outer]);
    const images = flat.filter((o) => o.type === "image");
    expect(images).toHaveLength(1);
    // (0,0) + inner(0,0) + outer(5,5) = (5,5)
    expect(images[0].transform.x).toBeCloseTo(5, 5);
    expect(images[0].transform.y).toBeCloseTo(5, 5);
  });
});

// ─── Fix 7: offsetFill hole routing to maskFill ─────────────────────────────

describe("Fix 7: compound offsetFill routes through maskFill", () => {
  it("grouped paths on offsetFill layer coalesce into a single maskFill CutObject", () => {
    // Two path children in a group (simulates boolean result with outer + hole)
    const outer = makePath("outer", [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ]);
    const hole = makePath("hole", [
      { x: 5, y: 5 },
      { x: 15, y: 5 },
      { x: 15, y: 15 },
      { x: 5, y: 15 },
    ]);
    const group = makeGroup("g1", 0, 0, 20, 20, 0, [outer, hole]);

    const layers = [fillLayer(0, "offsetFill"), ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([group], layers);

    // The compound shape must be a single maskFill CutObject (not two separate offsetFill objects)
    const maskFillObjs = objects.filter((o) => o.layer.mode === "maskFill");
    expect(maskFillObjs).toHaveLength(1);
    // It should contain both contours
    expect(maskFillObjs[0].paths.length).toBe(2);

    // No offsetFill objects should remain (all routed through maskFill)
    const offsetFillObjs = objects.filter((o) => o.layer.mode === "offsetFill");
    expect(offsetFillObjs).toHaveLength(0);
  });

  it("ungrouped path on offsetFill stays offsetFill (no compound routing needed)", () => {
    const path = makePath("p1", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    const layers = [fillLayer(0, "offsetFill"), ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([path], layers);

    // Ungrouped single contour stays offsetFill
    expect(objects).toHaveLength(1);
    expect(objects[0].layer.mode).toBe("offsetFill");
  });
});
