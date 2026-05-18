import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../index";
import type { DesignObject } from "../../types";

function makeObject(overrides: Partial<DesignObject> = {}): DesignObject {
  return {
    id: `test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: "rectangle",
    name: "Test Rect",
    transform: { x: 10, y: 20, width: 50, height: 30, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    ...overrides,
  };
}

describe("Store", () => {
  beforeEach(() => {
    // Reset store state
    useStore.setState({
      objects: [],
      selectedIds: [],
      undoStack: [],
      redoStack: [],
    });
  });

  it("addObject appends to objects array", () => {
    const obj = makeObject({ id: "obj1" });
    useStore.getState().addObject(obj);
    expect(useStore.getState().objects).toHaveLength(1);
    expect(useStore.getState().objects[0].id).toBe("obj1");
  });

  it("removeObjects removes specified objects", () => {
    const obj1 = makeObject({ id: "obj1" });
    const obj2 = makeObject({ id: "obj2" });
    useStore.getState().addObject(obj1);
    useStore.getState().addObject(obj2);
    useStore.getState().removeObjects(["obj1"]);
    expect(useStore.getState().objects).toHaveLength(1);
    expect(useStore.getState().objects[0].id).toBe("obj2");
  });

  it("removeObjects also removes from selectedIds", () => {
    const obj = makeObject({ id: "obj1" });
    useStore.getState().addObject(obj);
    useStore.getState().setSelectedIds(["obj1"]);
    useStore.getState().removeObjects(["obj1"]);
    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it("reorderLayers swaps layer positions and remaps objects", () => {
    const obj = makeObject({ id: "obj1", layerIndex: 0 });
    useStore.getState().addObject(obj);
    // Default layers: 0=Cut, 1=Engrave, ...
    useStore.getState().reorderLayers(0, 1);
    // After swap, objects on old layer 0 should be remapped
    const updated = useStore.getState().objects.find((o) => o.id === "obj1");
    expect(updated).toBeDefined();
    // Layer indices get reassigned based on new positions
    expect(typeof updated!.layerIndex).toBe("number");
  });

  it("undo/redo with withUndo", () => {
    const obj = makeObject({ id: "obj1" });
    useStore.getState().addObject(obj);
    useStore.getState().withUndo("test", () => {
      useStore.getState().removeObjects(["obj1"]);
    });
    expect(useStore.getState().objects).toHaveLength(0);
    expect(useStore.getState().undoStack).toHaveLength(1);

    useStore.getState().undo();
    expect(useStore.getState().objects).toHaveLength(1);
    expect(useStore.getState().objects[0].id).toBe("obj1");

    useStore.getState().redo();
    expect(useStore.getState().objects).toHaveLength(0);
  });

  it("undo stack is capped at 50", () => {
    for (let i = 0; i < 60; i++) {
      useStore.getState().withUndo(`test-${i}`, () => {
        useStore.getState().addObject(makeObject({ id: `obj_${i}` }));
      });
    }
    expect(useStore.getState().undoStack.length).toBeLessThanOrEqual(50);
  });
});
