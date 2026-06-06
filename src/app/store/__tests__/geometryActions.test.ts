import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../index";
import type { DesignObject } from "../../types";

function makeRect(id: string, x: number, y: number, w: number, h: number): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x, y, width: w, height: h, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

describe("Geometry Actions", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      selectedIds: [],
      undoStack: [],
      redoStack: [],
    });
  });

  describe("alignObjects", () => {
    it("aligns objects to the left edge", () => {
      const obj1 = makeRect("r1", 10, 10, 20, 20);
      const obj2 = makeRect("r2", 50, 30, 20, 20);
      useStore.getState().addObject(obj1);
      useStore.getState().addObject(obj2);
      useStore.getState().setSelectedIds(["r1", "r2"]);
      useStore.getState().alignObjects("left");
      const objects = useStore.getState().objects;
      expect(objects.find((o) => o.id === "r1")!.transform.x).toBe(10);
      expect(objects.find((o) => o.id === "r2")!.transform.x).toBe(10);
    });

    it("does nothing with fewer than 2 selected", () => {
      const obj = makeRect("r1", 10, 10, 20, 20);
      useStore.getState().addObject(obj);
      useStore.getState().setSelectedIds(["r1"]);
      useStore.getState().alignObjects("left");
      // Should not throw or modify
      expect(useStore.getState().objects[0].transform.x).toBe(10);
    });
  });

  describe("flipObjects", () => {
    it("flips a single rectangle horizontally (resets scale)", () => {
      const obj = makeRect("r1", 10, 10, 40, 20);
      useStore.getState().addObject(obj);
      useStore.getState().setSelectedIds(["r1"]);
      useStore.getState().flipObjects("horizontal");
      const updated = useStore.getState().objects.find((o) => o.id === "r1")!;
      // Rectangle flip resets scaleX/scaleY to 1
      expect(updated.transform.scaleX).toBe(1);
      expect(updated.transform.scaleY).toBe(1);
    });

    it("flips multiple objects' positions horizontally", () => {
      const obj1 = makeRect("r1", 0, 0, 10, 10);
      const obj2 = makeRect("r2", 30, 0, 10, 10);
      useStore.getState().addObject(obj1);
      useStore.getState().addObject(obj2);
      useStore.getState().setSelectedIds(["r1", "r2"]);
      useStore.getState().flipObjects("horizontal");
      const objects = useStore.getState().objects;
      // After horizontal flip, positions should swap
      const r1 = objects.find((o) => o.id === "r1")!;
      const r2 = objects.find((o) => o.id === "r2")!;
      expect(r1.transform.x).toBe(30);
      expect(r2.transform.x).toBe(0);
    });
  });

  describe("booleanUnion", () => {
    it("requires at least 2 selected objects", () => {
      const obj = makeRect("r1", 0, 0, 10, 10);
      useStore.getState().addObject(obj);
      useStore.getState().setSelectedIds(["r1"]);
      useStore.getState().booleanUnion();
      // Should not crash; objects unchanged
      expect(useStore.getState().objects).toHaveLength(1);
    });

    it("produces path objects from two overlapping rectangles", () => {
      const obj1 = makeRect("r1", 0, 0, 20, 20);
      const obj2 = makeRect("r2", 10, 10, 20, 20);
      useStore.getState().addObject(obj1);
      useStore.getState().addObject(obj2);
      useStore.getState().setSelectedIds(["r1", "r2"]);
      useStore.getState().booleanUnion();
      const objects = useStore.getState().objects;
      // Originals should be removed, new path(s) added
      expect(objects.find((o) => o.id === "r1")).toBeUndefined();
      expect(objects.find((o) => o.id === "r2")).toBeUndefined();
      expect(objects.length).toBeGreaterThanOrEqual(1);
      expect(objects[0].type).toBe("path");
    });
  });

  // D5 — convertToPath rounded-rect corners: TR/BR arc-end anchors must have no handleOut
  describe("convertToPath", () => {
    it("D5: arc-end anchors that begin straight edges have no handleOut; arc handles are intact", () => {
      // Rounded rect 100×80 corner-radius 10, origin at (0,0)
      const obj: DesignObject = {
        id: "rr1",
        type: "rectangle",
        name: "RR",
        transform: { x: 0, y: 0, width: 100, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
        layerIndex: 0,
        visible: true,
        locked: false,
        fill: null,
        stroke: "#4a90e2",
        strokeWidth: 1,
        opacity: 1,
        cornerRadius: 10,
      };
      useStore.getState().addObject(obj);
      useStore.getState().convertToPath("rr1");

      const result = useStore.getState().objects.find((o) => o.id === "rr1")!;
      expect(result.type).toBe("path");
      const pts = result.points!;
      // 8-anchor ring: indices 0-7 in absolute coords (origin 0,0)
      // Index 2 = TR arc-end {w,cr} = (100,10) — begins right straight edge
      // Index 4 = BR arc-end {w-cr,h} = (90,80) — begins bottom straight edge
      const tr = pts[2]; // top-right arc-end
      const br = pts[4]; // bottom-right arc-end
      expect(tr.handleOut).toBeUndefined();
      expect(br.handleOut).toBeUndefined();

      // Arc handles on adjacent corners should use k-offset (non-zero, no NaN)
      const k = 0.5522847498;
      const cr = 10;
      // Index 1 = top-right arc-start {w-cr,0} — handleOut should be (w-cr+cr*k, 0)
      const trStart = pts[1];
      expect(trStart.handleOut).toBeDefined();
      expect(trStart.handleOut!.x).toBeCloseTo(100 - cr + cr * k, 5);
      expect(trStart.handleOut!.y).toBeCloseTo(0, 5);
      // Index 2 = TR arc-end — handleIn should be (w, cr-cr*k)
      expect(tr.handleIn).toBeDefined();
      expect(tr.handleIn!.x).toBeCloseTo(100, 5);
      expect(tr.handleIn!.y).toBeCloseTo(cr - cr * k, 5);
    });
  });
});
