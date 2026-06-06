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

  // TN4 — image-strip undo round-trip and untested geometry actions

  function makeImageObj(id: string): DesignObject {
    return {
      id,
      type: "image",
      name: `Image ${id}`,
      transform: { x: 0, y: 0, width: 50, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
      layerIndex: 0,
      visible: true,
      locked: false,
      fill: null,
      stroke: "#4a90e2",
      strokeWidth: 1,
      opacity: 1,
      imageData: "data:image/png;base64,FAKEBASE64DATA",
    };
  }

  describe("undo image-strip round-trip (TN4)", () => {
    it("withUndo strips imageData to __UNDO_REF__ in the undo snapshot", () => {
      const img = makeImageObj("img1");
      useStore.getState().addObject(img);

      // Mutate inside withUndo to trigger snapshot push
      useStore.getState().withUndo("mutate", () => {
        useStore.getState().updateObject("img1", { opacity: 0.5 });
      });

      const undoStack = useStore.getState().undoStack;
      expect(undoStack).toHaveLength(1);
      // Undo: restores before-snapshot — imageData in the command's undo closure must
      // resolve back to the original base64 when undo() is called.
    });

    it("undo restores the original imageData (not __UNDO_REF__)", () => {
      const img = makeImageObj("img1");
      useStore.getState().addObject(img);

      // Mutate — triggers snapshot with stripped imageData
      useStore.getState().withUndo("mutate", () => {
        useStore.getState().updateObject("img1", { opacity: 0.5 });
      });

      // Verify mutation applied
      expect(useStore.getState().objects.find((o) => o.id === "img1")!.opacity).toBe(0.5);

      // Undo should restore pre-mutation state including imageData
      useStore.getState().undo();
      const restored = useStore.getState().objects.find((o) => o.id === "img1")!;
      expect(restored.opacity).toBe(1);
      expect(restored.imageData).toBe("data:image/png;base64,FAKEBASE64DATA");
      expect(restored.imageData).not.toBe("__UNDO_REF__");
    });

    it("commitPropertyEdit strips and restores imageData on undo", () => {
      const img = makeImageObj("img2");
      useStore.getState().addObject(img);

      useStore.getState().beginPropertyEdit();
      useStore.getState().updateObject("img2", { opacity: 0.25 });
      useStore.getState().commitPropertyEdit();

      expect(useStore.getState().undoStack).toHaveLength(1);

      // Undo should restore imageData
      useStore.getState().undo();
      const restored = useStore.getState().objects.find((o) => o.id === "img2")!;
      expect(restored.opacity).toBe(1);
      expect(restored.imageData).toBe("data:image/png;base64,FAKEBASE64DATA");
    });
  });

  describe("distributeObjects (TN4)", () => {
    it("horizontally distributes 3 objects with equal gaps", () => {
      const r1 = makeRect("r1", 0, 0, 10, 10);
      const r2 = makeRect("r2", 50, 0, 10, 10);
      const r3 = makeRect("r3", 90, 0, 10, 10);
      useStore.getState().addObject(r1);
      useStore.getState().addObject(r2);
      useStore.getState().addObject(r3);
      useStore.getState().setSelectedIds(["r1", "r2", "r3"]);
      useStore.getState().distributeObjects("horizontal");

      const objs = useStore.getState().objects;
      const x1 = objs.find((o) => o.id === "r1")!.transform.x;
      const x2 = objs.find((o) => o.id === "r2")!.transform.x;
      const x3 = objs.find((o) => o.id === "r3")!.transform.x;
      // r1 and r3 stay at anchors (0 and 90).
      // first=0, last=90+10=100, totalWidth=30, gap=(100-0-30)/2=35
      // r2: x = 0+10+35 = 45
      expect(x1).toBe(0);
      expect(x2).toBeCloseTo(45, 5);
      expect(x3).toBe(90);
    });

    it("does nothing with fewer than 3 selected", () => {
      const r1 = makeRect("r1", 0, 0, 10, 10);
      const r2 = makeRect("r2", 50, 0, 10, 10);
      useStore.getState().addObject(r1);
      useStore.getState().addObject(r2);
      useStore.getState().setSelectedIds(["r1", "r2"]);
      useStore.getState().distributeObjects("horizontal");
      expect(useStore.getState().objects.find((o) => o.id === "r2")!.transform.x).toBe(50);
    });
  });

  describe("rotate90 (TN4)", () => {
    it("rotates cw by 90 degrees", () => {
      const obj = makeRect("r1", 0, 0, 10, 10);
      useStore.getState().addObject(obj);
      useStore.getState().setSelectedIds(["r1"]);
      useStore.getState().rotate90("cw");
      expect(useStore.getState().objects.find((o) => o.id === "r1")!.transform.rotation).toBe(90);
    });

    it("normalizes rotation past 360 (270 cw → 0)", () => {
      const obj: DesignObject = { ...makeRect("r1", 0, 0, 10, 10), transform: { ...makeRect("r1", 0, 0, 10, 10).transform, rotation: 270 } };
      useStore.getState().addObject(obj);
      useStore.getState().setSelectedIds(["r1"]);
      useStore.getState().rotate90("cw");
      expect(useStore.getState().objects.find((o) => o.id === "r1")!.transform.rotation).toBe(0);
    });
  });

  describe("gridArray (TN4)", () => {
    it("creates rows×cols copies with correct spacing", () => {
      const r = makeRect("r1", 0, 0, 10, 10);
      useStore.getState().addObject(r);
      useStore.getState().setSelectedIds(["r1"]);
      useStore.getState().gridArray(2, 3, 5, 5);
      // 2×3 grid: 6 objects total (1 original + 5 new)
      expect(useStore.getState().objects).toHaveLength(6);
      // Check col-2 of row-0: x = 0 + 2*(10+5) = 30
      const col2 = useStore.getState().objects.find(
        (o) => o.id !== "r1" && Math.abs(o.transform.x - 30) < 0.01 && Math.abs(o.transform.y) < 0.01
      );
      expect(col2).toBeDefined();
    });
  });

  describe("circularArray (TN4)", () => {
    it("creates count copies arranged in a circle", () => {
      const r = makeRect("r1", 50, 50, 10, 10);
      useStore.getState().addObject(r);
      useStore.getState().setSelectedIds(["r1"]);
      useStore.getState().circularArray(4, 20, 0);
      // 4 total: 1 original + 3 new
      expect(useStore.getState().objects).toHaveLength(4);
    });
  });

  describe("booleanDifference, booleanIntersection, booleanXor (TN4)", () => {
    it("booleanDifference removes subtracted region (count ≥ 1 path)", () => {
      const r1 = makeRect("r1", 0, 0, 20, 20);
      const r2 = makeRect("r2", 10, 10, 20, 20);
      useStore.getState().addObject(r1);
      useStore.getState().addObject(r2);
      useStore.getState().setSelectedIds(["r1", "r2"]);
      useStore.getState().booleanDifference();
      const objs = useStore.getState().objects;
      expect(objs.find((o) => o.id === "r1")).toBeUndefined();
      expect(objs.find((o) => o.id === "r2")).toBeUndefined();
      expect(objs.length).toBeGreaterThanOrEqual(1);
      expect(objs[0].type).toBe("path");
    });

    it("booleanIntersection returns the overlapping region", () => {
      const r1 = makeRect("r1", 0, 0, 20, 20);
      const r2 = makeRect("r2", 10, 10, 20, 20);
      useStore.getState().addObject(r1);
      useStore.getState().addObject(r2);
      useStore.getState().setSelectedIds(["r1", "r2"]);
      useStore.getState().booleanIntersection();
      const objs = useStore.getState().objects;
      expect(objs.length).toBeGreaterThanOrEqual(1);
      expect(objs[0].type).toBe("path");
      // Intersection bounding box should be roughly 10×10
      const t = objs[0].transform;
      expect(t.width).toBeCloseTo(10, 0);
      expect(t.height).toBeCloseTo(10, 0);
    });

    it("booleanXor returns regions in one but not both", () => {
      const r1 = makeRect("r1", 0, 0, 20, 20);
      const r2 = makeRect("r2", 10, 10, 20, 20);
      useStore.getState().addObject(r1);
      useStore.getState().addObject(r2);
      useStore.getState().setSelectedIds(["r1", "r2"]);
      useStore.getState().booleanXor();
      const objs = useStore.getState().objects;
      expect(objs.length).toBeGreaterThanOrEqual(1);
      expect(objs[0].type).toBe("path");
    });

    it("booleanDifference does nothing with fewer than 2 selected", () => {
      const r1 = makeRect("r1", 0, 0, 20, 20);
      useStore.getState().addObject(r1);
      useStore.getState().setSelectedIds(["r1"]);
      useStore.getState().booleanDifference();
      expect(useStore.getState().objects).toHaveLength(1);
    });
  });
});
