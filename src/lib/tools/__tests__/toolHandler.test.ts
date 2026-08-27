import { describe, it, expect, beforeEach, vi } from "vitest";

// toolHandler imports machineConnection which imports @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { useStore } from "../../../app/store";
import type { DesignObject } from "../../../app/types";
import {
  getSelectionBBox,
  hitTestHandle,
  _testPointToSegmentDist,
  _testHitTest,
} from "../toolHandler";

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

describe("toolHandler geometry helpers (TN2)", () => {
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

  // TN2a — pointToSegmentDist: pure math, no store
  describe("_testPointToSegmentDist", () => {
    it("returns 0 when point is on the segment", () => {
      expect(_testPointToSegmentDist(5, 0, 0, 0, 10, 0)).toBeCloseTo(0, 5);
    });

    it("returns perpendicular distance from a point to a segment", () => {
      // Point (5,3) from segment (0,0)-(10,0): perp dist = 3
      expect(_testPointToSegmentDist(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 5);
    });

    it("returns distance to nearest endpoint when projection is outside segment", () => {
      // Point (15,0) from segment (0,0)-(10,0): nearest end is (10,0), dist = 5
      expect(_testPointToSegmentDist(15, 0, 0, 0, 10, 0)).toBeCloseTo(5, 5);
    });

    it("handles zero-length segment (returns point-to-point distance)", () => {
      expect(_testPointToSegmentDist(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 5); // 3-4-5 triangle
    });
  });

  // TN2b — getSelectionBBox: AABB of selected objects via store
  describe("getSelectionBBox", () => {
    it("returns null when nothing is selected", () => {
      const obj = makeRect("r1", 10, 10, 20, 20);
      useStore.getState().addObject(obj);
      // selectedIds is empty
      expect(getSelectionBBox()).toBeNull();
    });

    it("returns AABB of a single unrotated rect", () => {
      const obj = makeRect("r1", 10, 20, 50, 30);
      useStore.getState().addObject(obj);
      useStore.getState().setSelectedIds(["r1"]);
      const bbox = getSelectionBBox();
      expect(bbox).not.toBeNull();
      expect(bbox!.x).toBeCloseTo(10, 5);
      expect(bbox!.y).toBeCloseTo(20, 5);
      expect(bbox!.w).toBeCloseTo(50, 5);
      expect(bbox!.h).toBeCloseTo(30, 5);
    });

    it("computes AABB of a rotated rect (must be larger than original)", () => {
      // 40×40 square rotated 45° at origin. AABB should be approx 56.57×56.57.
      const obj = makeRect("r1", 0, 0, 40, 40, 45);
      useStore.getState().addObject(obj);
      useStore.getState().setSelectedIds(["r1"]);
      const bbox = getSelectionBBox();
      expect(bbox).not.toBeNull();
      // Diagonal of 40×40 = ~56.57, AABB of rotated square ≈ that
      const expectedSide = 40 * Math.sqrt(2);
      expect(bbox!.w).toBeCloseTo(expectedSide, 1);
      expect(bbox!.h).toBeCloseTo(expectedSide, 1);
    });

    it("returns union AABB of multiple selected objects", () => {
      const r1 = makeRect("r1", 0, 0, 10, 10);
      const r2 = makeRect("r2", 20, 30, 10, 10);
      useStore.getState().addObject(r1);
      useStore.getState().addObject(r2);
      useStore.getState().setSelectedIds(["r1", "r2"]);
      const bbox = getSelectionBBox();
      expect(bbox!.x).toBeCloseTo(0, 5);
      expect(bbox!.y).toBeCloseTo(0, 5);
      expect(bbox!.w).toBeCloseTo(30, 5); // 0 to 30
      expect(bbox!.h).toBeCloseTo(40, 5); // 0 to 40
    });
  });

  // TN2c — hitTest inverse-rotation: clicking inside a rotated rect should hit it
  describe("_testHitTest (inverse-rotation)", () => {
    it("hits an unrotated rect when clicking inside its AABB", () => {
      const obj = makeRect("r1", 0, 0, 100, 50);
      useStore.getState().addObject(obj);
      // Click at center of rect
      const hit = _testHitTest(50, 25);
      expect(hit).toBe("r1");
    });

    it("misses an unrotated rect when clicking outside", () => {
      const obj = makeRect("r1", 0, 0, 100, 50);
      useStore.getState().addObject(obj);
      const hit = _testHitTest(200, 200);
      expect(hit).toBeNull();
    });

    it("hits a rotated rect by applying inverse-rotation to the click point", () => {
      // Rect at (0,0) 100×10 rotated 90°. After rotation it occupies roughly (-45,45)×(45,145).
      // Center = (50, 5). A click at (50,5) in world = (50,5) which should be on the object.
      // Let's use a large 100×10 rect rotated 90° centered at (50,5):
      // After 90° rotation, the object spans y from ~0 to 100, x from ~45 to 55.
      // Click at (50, 50) should be inside.
      const obj = makeRect("r1", 0, 0, 100, 10, 90);
      useStore.getState().addObject(obj);
      // Center of rect = (50, 5). Click at (50, 5) = center → inverse-rotate → always inside.
      const hit = _testHitTest(50, 5);
      expect(hit).toBe("r1");
    });

    it("misses a rotated rect when click is outside the unrotated AABB (inverse test)", () => {
      // Narrow rect (100×2) rotated 90°. Click at (200, 1) is far away.
      const obj = makeRect("r1", 0, 0, 100, 2, 90);
      useStore.getState().addObject(obj);
      const hit = _testHitTest(200, 200);
      expect(hit).toBeNull();
    });
  });

  // R1c: hitTestHandle on rotated single-select object
  describe("hitTestHandle (R1c) — rotated single-select anchors", () => {
    beforeEach(() => {
      useStore.setState({
        objects: [],
        objectsById: new Map(),
        selectedIds: [],
        selectedSet: new Set(),
        undoStack: [],
        redoStack: [],
        camera: { x: 0, y: 0, zoom: 1 },
      });
    });

    it("hits the rotated 'se' corner at its world position for a 45° rect", () => {
      // 20×20 rect at (0,0) rotation=45°. Center=(10,10). hw=hh=10.
      // se in local = (+10, +10). World = (10 + 10·cos45 − 10·sin45, 10 + 10·sin45 + 10·cos45)
      //             = (10, 10 + 10√2) ≈ (10, 24.142)
      const obj = makeRect("r1", 0, 0, 20, 20, 45);
      useStore.getState().addObject(obj);
      useStore.getState().setSelectedIds(["r1"]);

      const cos = Math.cos(Math.PI / 4);
      const sin = Math.sin(Math.PI / 4);
      const cx = 10,
        cy = 10,
        hw = 10,
        hh = 10;
      const seX = cx + hw * cos - hh * sin; // = 10 + 10·cos45 − 10·sin45 = 10
      const seY = cy + hw * sin + hh * cos; // = 10 + 10·sin45 + 10·cos45 = 10 + 10√2

      const handle = hitTestHandle(seX, seY, 1);
      expect(handle).toBe("se");
    });

    it("returns null when clicking at the old (unrotated) AABB SE corner of a 45° rect", () => {
      // For a 20×20 rect at (0,0) rotated 45°, the screen-axis AABB SE corner
      // is at approximately (10 + 10√2, 10 + 10√2) ≈ (24.14, 24.14).
      // That point is NOT one of the rotated handle positions — hitTestHandle should return null.
      const obj = makeRect("r1", 0, 0, 20, 20, 45);
      useStore.getState().addObject(obj);
      useStore.getState().setSelectedIds(["r1"]);

      const aabbEdge = 10 + 10 * Math.sqrt(2); // ≈ 24.14
      const handle = hitTestHandle(aabbEdge, aabbEdge, 1);
      // This point is far from any rotated handle center — should return null
      expect(handle).toBeNull();
    });

    it("multi-select still uses AABB handles (unchanged path)", () => {
      // Two unrotated rects — multi-select AABB SE is at (50, 50)
      const r1 = makeRect("r1", 0, 0, 30, 30);
      const r2 = makeRect("r2", 20, 20, 30, 30);
      useStore.getState().addObject(r1);
      useStore.getState().addObject(r2);
      useStore.getState().setSelectedIds(["r1", "r2"]);

      // Multi-select AABB: x=0,y=0,w=50,h=50 → SE corner at (50,50)
      const handle = hitTestHandle(50, 50, 1);
      expect(handle).toBe("se");
    });
  });
});
