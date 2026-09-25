import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../index";
import type { DesignObject } from "../../types";
import { DEFAULT_LAYERS } from "../../types";

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

  // D4 — loadProject must reset all prior-project state
  it("D4: loadProject clears undoStack, redoStack, gcodeResult, gcodeStale, projectPath, nodeEditState", () => {
    // Seed project A state
    const objA = makeObject({ id: "objA" });
    useStore.getState().addObject(objA);
    useStore.getState().withUndo("mutate", () => {
      useStore.getState().removeObjects(["objA"]);
    });
    expect(useStore.getState().undoStack).toHaveLength(1); // non-empty undo
    useStore.setState({
      gcodeResult: {
        gcode: "G21",
        moves: [],
        totalDistance: 0,
        cutDistance: 0,
        travelDistance: 0,
        estimatedTimeSecs: 0,
        lineCount: 1,
      },
      gcodeStale: true,
      projectPath: "/path/to/projectA.kerf",
      nodeEditState: { pathId: "objA", selectedNodeIndex: 0 },
    });

    // Load project B
    const projectB = {
      version: "0.6.0",
      name: "Project B",
      objects: [makeObject({ id: "objB" })],
      layers: DEFAULT_LAYERS,
      camera: { x: 0, y: 0, zoom: 1 },
      workspaceWidth: 300,
      workspaceHeight: 200,
    };
    useStore.getState().loadProject(projectB);

    const state = useStore.getState();
    expect(state.undoStack).toEqual([]);
    expect(state.redoStack).toEqual([]);
    expect(state.gcodeResult).toBeNull();
    expect(state.gcodeStale).toBe(false);
    expect(state.projectPath).toBeNull();
    expect(state.nodeEditState).toEqual({ pathId: null, selectedNodeIndex: null });
  });
});

describe("refresh-cut-vs-screen F6: reorderLayers carries group children", () => {
  beforeEach(() => {
    useStore.setState({ objects: [], selectedIds: [], undoStack: [], redoStack: [] });
  });

  it("depth-2 group and its descendants follow their layer; leaves gain no children key", () => {
    useStore.setState({ layers: DEFAULT_LAYERS });
    const a = makeObject({ id: "a", layerIndex: 0 });
    const b = makeObject({ id: "b", layerIndex: 0 });
    const inner = makeObject({ id: "inner", type: "group", layerIndex: 0, children: [a, b] });
    const outer = makeObject({ id: "outer", type: "group", layerIndex: 0, children: [inner] });
    const top = makeObject({ id: "top", layerIndex: 2 });
    useStore.getState().addObject(outer);
    useStore.getState().addObject(top);
    useStore.getState().reorderLayers(0, 1);
    const objs = useStore.getState().objects;
    const o = objs.find((x) => x.id === "outer")!;
    const i = o.children![0];
    expect(o.layerIndex).toBe(1);
    expect(i.layerIndex).toBe(1);
    expect(i.children!.map((c) => c.layerIndex)).toEqual([1, 1]);
    for (const leaf of i.children!) expect("children" in leaf).toBe(false);
    const t = objs.find((x) => x.id === "top")!;
    expect(t.layerIndex).toBe(2);
    expect("children" in t).toBe(false);
  });
});

describe("refresh-cut-vs-screen F7: layer reorder is its own undo command", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      selectedIds: [],
      undoStack: [],
      redoStack: [],
      layers: DEFAULT_LAYERS,
      activeLayerIndex: 0,
    });
  });

  const st = () => useStore.getState();
  const layerName = (id: string) => {
    const findDeep = (os: DesignObject[]): DesignObject | undefined => {
      for (const o of os) {
        if (o.id === id) return o;
        const c = o.children ? findDeep(o.children) : undefined;
        if (c) return c;
      }
      return undefined;
    };
    const o = findDeep(st().objects)!;
    return st().layers.find((l) => l.index === o.layerIndex)?.name;
  };
  const x = (id: string) => st().objects.find((o) => o.id === id)!.transform.x;
  const moveBy10 = (id: string) =>
    st().withUndo("move", () => {
      const o = st().objects.find((q) => q.id === id)!;
      st().updateObject(id, { transform: { ...o.transform, x: o.transform.x + 10 } });
    });

  it("1: the critic's sequence — undo never moves objects onto another layer", () => {
    st().addObject(
      makeObject({ id: "r", layerIndex: 0, transform: { ...makeObject().transform, x: 0 } })
    );
    moveBy10("r");
    st().reorderLayers(0, 1);
    expect(st().undoStack.length).toBe(2);
    expect(layerName("r")).toBe("Engrave");
    st().undo();
    expect(layerName("r")).toBe("Engrave");
    expect(x("r")).toBe(10);
    expect(st().layers[0].name).toBe("Engrave");
    st().undo();
    expect(layerName("r")).toBe("Engrave");
    expect(x("r")).toBe(0);
    st().redo();
    st().redo();
    expect(layerName("r")).toBe("Engrave");
    expect(x("r")).toBe(10);
    expect(st().layers[1].name).toBe("Engrave");
    expect(st().objects.find((o) => o.id === "r")!.layerIndex).toBe(1);
  });

  it("2: commutes with layer edits — undo keeps a power edit made after the reorder", () => {
    st().reorderLayers(0, 1);
    const engraveIdx = st().layers.find((l) => l.name === "Engrave")!.index;
    expect(engraveIdx).toBe(1);
    st().updateLayer(engraveIdx, { power: 42 });
    st().undo();
    const engrave = st().layers.find((l) => l.name === "Engrave")!;
    expect(engrave.index).toBe(0);
    expect(engrave.power).toBe(42);
  });

  it("3: grouped children read Engrave after every step", () => {
    const a = makeObject({ id: "ga", layerIndex: 0 });
    const b = makeObject({ id: "gb", layerIndex: 0 });
    st().addObject(makeObject({ id: "g", type: "group", layerIndex: 0, children: [a, b] }));
    const both = () => {
      expect(layerName("ga")).toBe("Engrave");
      expect(layerName("gb")).toBe("Engrave");
      expect(layerName("g")).toBe("Engrave");
    };
    moveBy10("g");
    both();
    st().reorderLayers(0, 1);
    both();
    st().undo();
    both();
    st().undo();
    both();
    st().redo();
    both();
    st().redo();
    both();
  });

  it("4: activeLayerIndex follows the permutation through undo and redo", () => {
    st().setActiveLayerIndex(0);
    st().reorderLayers(0, 1);
    expect(st().activeLayerIndex).toBe(1);
    const activeName = () => st().layers.find((l) => l.index === st().activeLayerIndex)!.name;
    st().undo();
    expect(st().activeLayerIndex).toBe(0);
    expect(activeName()).toBe("Engrave");
    st().redo();
    expect(st().activeLayerIndex).toBe(1);
    expect(activeName()).toBe("Engrave");
  });

  it("5: no-op reorders push nothing and leave redo and layers untouched", () => {
    st().addObject(makeObject({ id: "n", layerIndex: 0 }));
    moveBy10("n");
    st().undo();
    expect(st().redoStack.length).toBe(1);
    const undoLen = st().undoStack.length;
    const redo = st().redoStack;
    const layers = st().layers;
    st().reorderLayers(0, 0);
    st().reorderLayers(0, 99);
    expect(st().undoStack.length).toBe(undoLen);
    expect(st().redoStack).toBe(redo);
    expect(st().redoStack.length).toBe(1);
    expect(st().layers).toBe(layers);
  });

  it("6: an open property edit across a reorder never lands the object on another layer", () => {
    st().addObject(makeObject({ id: "p", layerIndex: 0 }));
    st().beginPropertyEdit();
    const o = st().objects.find((q) => q.id === "p")!;
    st().updateObject("p", { transform: { ...o.transform, x: o.transform.x + 10 } });
    expect(layerName("p")).toBe("Engrave");
    st().reorderLayers(0, 1);
    expect(layerName("p")).toBe("Engrave");
    st().commitPropertyEdit();
    expect(layerName("p")).toBe("Engrave");
    st().undo();
    expect(layerName("p")).toBe("Engrave");
    st().undo();
    expect(layerName("p")).toBe("Engrave");
  });
});
