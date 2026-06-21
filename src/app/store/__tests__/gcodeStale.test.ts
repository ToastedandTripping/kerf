/**
 * F15 staleness-gate tests — every store action whose state feeds G-code
 * generation must flip gcodeStale when a gcodeResult exists, must NOT when it
 * is null, and value-equal workspace/S-max writes must NOT re-stale (they are
 * re-set on every connect by queryGrblSettings).
 *
 * This file also pins the REVISED applyObjects contract (storeHelpers.ts):
 * group/ungroup — and every other objects write through applyObjects — stales.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../index";
import type { AppState } from "../storeTypes";
import type { DesignObject } from "../../types";
import { DEFAULT_LAYERS } from "../../types";

function makeRect(id: string, x = 0, y = 0): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x, y, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

function fakeGcode(): NonNullable<AppState["gcodeResult"]> {
  return {
    gcode: "G0 X0 Y0",
    moves: [],
    totalDistance: 0,
    cutDistance: 0,
    travelDistance: 0,
    estimatedTimeSecs: 0,
    lineCount: 1,
  };
}

/** Mark G-code as freshly generated (the state START gates on). */
function markFresh() {
  useStore.setState({ gcodeResult: fakeGcode(), gcodeStale: false });
}

function stale(): boolean {
  return useStore.getState().gcodeStale;
}

describe("F15 gcodeStale writers", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      objectsById: new Map(),
      selectedIds: [],
      selectedSet: new Set(),
      undoStack: [],
      redoStack: [],
      layers: DEFAULT_LAYERS,
      workspaceWidth: 500,
      workspaceHeight: 300,
      grblSValueMax: 1000,
      startCorner: "bottomLeft",
      gcodeResult: null,
      gcodeStale: false,
      isDirty: false,
    });
  });

  // --- object writers (pre-existing pattern, pinned here) ---

  it("addObject / updateObject / removeObjects stale when gcode exists", () => {
    markFresh();
    useStore.getState().addObject(makeRect("a"));
    expect(stale()).toBe(true);

    markFresh();
    useStore.getState().updateObject("a", { name: "renamed" });
    expect(stale()).toBe(true);

    markFresh();
    useStore.getState().removeObjects(["a"]);
    expect(stale()).toBe(true);
  });

  it("object writers do NOT stale when gcodeResult is null", () => {
    useStore.getState().addObject(makeRect("a"));
    expect(stale()).toBe(false);
  });

  // --- layer writers ---

  it("updateLayer stales when gcode exists, not when null", () => {
    useStore.getState().updateLayer(0, { power: 55 });
    expect(stale()).toBe(false);

    markFresh();
    useStore.getState().updateLayer(0, { power: 60 });
    expect(stale()).toBe(true);
  });

  it("reorderLayers stales", () => {
    markFresh();
    useStore.getState().reorderLayers(0, 1);
    expect(stale()).toBe(true);
  });

  it("updateLineOverlay stales (direct generation-input writer, does not route through updateLayer)", () => {
    markFresh();
    useStore.getState().updateLineOverlay(0, { power: 80 });
    expect(stale()).toBe(true);

    markFresh();
    useStore.getState().updateLineOverlay(0, { speed: 900, passes: 2 });
    expect(stale()).toBe(true);
  });

  // --- workspace / S-max: VALUE-CHANGE ONLY ---

  it("setWorkspaceSize stales on value change, NOT on same-value writes", () => {
    markFresh();
    useStore.getState().setWorkspaceSize(500, 300); // same as seeded values
    expect(stale()).toBe(false);

    useStore.getState().setWorkspaceSize(400, 300);
    expect(stale()).toBe(true);
  });

  it("setGrblSValueMax stales on value change, NOT on same-value writes", () => {
    markFresh();
    useStore.getState().setGrblSValueMax(1000); // same as seeded value
    expect(stale()).toBe(false);

    useStore.getState().setGrblSValueMax(255);
    expect(stale()).toBe(true);
  });

  it("setWorkspaceSize does not stale when gcodeResult is null", () => {
    useStore.getState().setWorkspaceSize(400, 300);
    expect(stale()).toBe(false);
  });

  // --- start corner ---

  it("setStartCorner stales (feeds the optimizer's cut order)", () => {
    markFresh();
    useStore.getState().setStartCorner("topRight");
    expect(stale()).toBe(true);
  });

  // --- undo/redo restore closures ---

  it("undo and redo of an object edit re-stale", () => {
    useStore.getState().addObject(makeRect("a"));
    useStore.getState().withUndo("move", () => {
      useStore.getState().updateObject("a", { name: "moved" });
    });

    markFresh();
    useStore.getState().undo();
    expect(stale()).toBe(true);

    markFresh();
    useStore.getState().redo();
    expect(stale()).toBe(true);
  });

  // --- group/ungroup via the revised applyObjects contract ---

  it("groupSelected and ungroupSelected stale", () => {
    useStore.getState().addObject(makeRect("a", 0, 0));
    useStore.getState().addObject(makeRect("b", 20, 20));
    useStore.getState().setSelectedIds(["a", "b"]);

    markFresh();
    useStore.getState().groupSelected();
    expect(stale()).toBe(true);

    const groupId = useStore.getState().selectedIds[0];
    useStore.getState().setSelectedIds([groupId]);
    markFresh();
    useStore.getState().ungroupSelected();
    expect(stale()).toBe(true);
  });

  // --- z-order (inline patch, NOT via applyObjects — mechanism is explicit) ---

  it("z-order moves stale (array order feeds within-layer emission order)", () => {
    useStore.getState().addObject(makeRect("a"));
    useStore.getState().addObject(makeRect("b"));

    markFresh();
    useStore.getState().moveObjectForward("a");
    expect(stale()).toBe(true);
  });

  it("z-order boundary no-op does NOT stale", () => {
    useStore.getState().addObject(makeRect("a"));
    useStore.getState().addObject(makeRect("b"));

    markFresh();
    useStore.getState().moveObjectForward("b"); // already at front — no-op
    expect(stale()).toBe(false);
  });

  // --- regenerate clears the gate ---

  it("setGcodeResult clears staleness", () => {
    markFresh();
    useStore.getState().addObject(makeRect("a"));
    expect(stale()).toBe(true);
    useStore.getState().setGcodeResult(fakeGcode());
    expect(stale()).toBe(false);
  });
});
