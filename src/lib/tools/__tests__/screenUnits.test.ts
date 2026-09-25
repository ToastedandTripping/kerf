/**
 * R2 F6 — handle, rotate, pen-close and node hit sizes are SCREEN pixels.
 * Tool handlers receive world coordinates in mm, so a screen size converts
 * through screenPxToMm(px, zoom) = px / (zoom * PX_PER_MM), not px / zoom.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { useStore } from "../../../app/store";
import type { DesignObject, PathPoint } from "../../../app/types";
import { ROTATE_HANDLE_OFFSET_PX, screenPxToMm } from "../../constants";
import { orientedHandlePoints } from "../../geometry";
import {
  hitTestHandle,
  hitTestNodeHandles,
  handleViewportPointerDown,
  handleViewportPointerUp,
} from "../toolHandler";

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

function pe(): React.PointerEvent {
  return { ctrlKey: false, shiftKey: false, button: 0 } as unknown as React.PointerEvent;
}

function select(...objs: DesignObject[]) {
  useStore.setState({
    objects: objs,
    objectsById: new Map(objs.map((o) => [o.id, o])),
    selectedIds: objs.map((o) => o.id),
    selectedSet: new Set(objs.map((o) => o.id)),
  });
}

beforeEach(() => {
  useStore.setState({
    objects: [],
    objectsById: new Map(),
    selectedIds: [],
    selectedSet: new Set(),
    undoStack: [],
    redoStack: [],
    activeTool: "select",
    snapToGrid: false,
    guides: [],
    camera: { x: 0, y: 0, zoom: 1 },
    drawingObject: null,
    nodeEditState: { pathId: null, selectedNodeIndex: null },
  });
});

describe("screen-pixel hit sizes (R2 F6)", () => {
  it("screenPxToMm converts through PX_PER_MM and zoom", () => {
    expect(screenPxToMm(3.78, 1)).toBeCloseTo(1, 12);
    expect(screenPxToMm(12, 4)).toBeCloseTo(12 / (4 * 3.78), 12);
    expect(ROTATE_HANDLE_OFFSET_PX).toBe(20);
  });

  it("multi-select: the drawn rotate circle (20 px above the box) hits rotate", () => {
    select(makeRect("a", 0, 0, 20, 20), makeRect("b", 40, 10, 20, 20));
    // Selection bbox: x 0..60, y 0..30.
    expect(hitTestHandle(30, 0 - screenPxToMm(20, 1), 1)).toBe("rotate");
  });

  it("a small object's body is a move target, not a corner", () => {
    select(makeRect("s", 0, 0, 5, 5));
    expect(hitTestHandle(2.5, 2.5, 1)).toBeNull();
  });

  it("single-select: rotate hits at its drawn position at every zoom; 20 mm above does not", () => {
    const r = makeRect("r", 10, 10, 40, 20);
    select(r);
    for (const z of [0.5, 1, 4]) {
      const h = orientedHandlePoints(r.transform, screenPxToMm(ROTATE_HANDLE_OFFSET_PX, z));
      expect(hitTestHandle(h.rotate.x, h.rotate.y, z)).toBe("rotate");
    }
    expect(hitTestHandle(30, 10 - 20, 1)).toBeNull();
  });

  it("zoom invariance: 5 screen px from a corner hits it at zoom 4; 8 px does not", () => {
    select(makeRect("z", 10, 10, 40, 20));
    const d5 = screenPxToMm(5, 4);
    const d8 = screenPxToMm(8, 4);
    expect(hitTestHandle(50 + d5, 30, 4)).toBe("se");
    expect(hitTestHandle(50 + d8, 30, 4)).toBeNull();
  });

  it("pen: a click 15 px from the first point adds a point; within 8 px it closes", () => {
    useStore.setState({ activeTool: "pen" });
    for (const [x, y] of [
      [10, 10],
      [40, 10],
      [40, 30],
    ]) {
      handleViewportPointerDown(x, y, pe());
      handleViewportPointerUp(x, y, pe());
    }
    handleViewportPointerDown(14, 10, pe()); // 4 mm = 15 px away
    handleViewportPointerUp(14, 10, pe());
    expect(useStore.getState().objects).toHaveLength(0);
    handleViewportPointerDown(11, 10, pe()); // 1 mm = 3.8 px away
    handleViewportPointerUp(11, 10, pe());
    const objs = useStore.getState().objects;
    expect(objs).toHaveLength(1);
    expect(objs[0].closed).toBe(true);
  });

  it("node hit: 15 px from a node misses; 3.8 px hits", () => {
    const points: PathPoint[] = [
      { x: 10, y: 10 },
      { x: 40, y: 10 },
      { x: 40, y: 40 },
    ];
    const path: DesignObject = {
      ...makeRect("p", 10, 10, 30, 30),
      type: "path",
      points,
      closed: false,
    };
    select(path);
    useStore.setState({ nodeEditState: { pathId: "p", selectedNodeIndex: null } });
    expect(hitTestNodeHandles(14, 10, 1)).toBeNull();
    expect(hitTestNodeHandles(11, 10, 1)).toEqual({ index: 0, target: "node" });
  });
});
