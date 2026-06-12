/**
 * W1b — F1 writer tests through the PRODUCTION pointer pipeline.
 *
 * The defining defect: every translation mechanism wrote transform x/y only,
 * which the renderer and G-code generator both ignore for path/line objects.
 * These tests drive the real handleViewportPointerDown/Move/Up handlers and
 * assert (a) points (incl. bezier handles) moved, (b) the flatten output the
 * laser cuts moved, (c) the transform≡pointsBBox invariant holds, and (d) the
 * drag/resize undo closures restore POINTS, not just transforms.
 *
 * RED-BEFORE: on pre-W1b code the drag test fails at (a) — points unchanged —
 * and the undo tests fail with a visual no-op restore.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { useStore } from "../../../app/store";
import type { DesignObject, PathPoint } from "../../../app/types";
import {
  handleViewportPointerDown,
  handleViewportPointerMove,
  handleViewportPointerUp,
} from "../toolHandler";
import { assertPointsInvariant } from "../../geometry";
import { flattenObjectsForTest } from "../../machine/gcodeGen";

function pe(opts: Partial<{ ctrlKey: boolean; shiftKey: boolean; button: number }> = {}): React.PointerEvent {
  return { ctrlKey: false, shiftKey: false, button: 0, ...opts } as unknown as React.PointerEvent;
}

function makePath(id: string, rotation = 0): DesignObject {
  const points: PathPoint[] = [
    { x: 10, y: 10, handleOut: { x: 15, y: 5 } },
    { x: 30, y: 10, handleIn: { x: 25, y: 5 }, handleOut: { x: 35, y: 15 } },
    { x: 30, y: 30, handleIn: { x: 35, y: 25 } },
    { x: 10, y: 30 },
  ];
  return {
    id,
    type: "path",
    name: `Path ${id}`,
    transform: { x: 10, y: 10, width: 20, height: 20, rotation, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    points,
    closed: true,
  };
}

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

function getObj(id: string): DesignObject {
  return useStore.getState().objects.find((o) => o.id === id)!;
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
    clipboard: [],
    nodeEditState: { pathId: null, selectedNodeIndex: null },
  });
});

describe("drag-move (select tool pointer pipeline)", () => {
  it("dragging a path moves points AND handles AND the flatten/cut output", () => {
    useStore.getState().addObject(makePath("p1"));

    // grab inside the path AABB, drag by (+25, +15)
    handleViewportPointerDown(20, 20, pe());
    handleViewportPointerMove(45, 35, pe());
    handleViewportPointerUp(45, 35, pe());

    const moved = getObj("p1");
    expect(moved.points![0]).toMatchObject({ x: 35, y: 25 });
    expect(moved.points![0].handleOut).toEqual({ x: 40, y: 20 });
    expect(moved.points![1].handleIn).toEqual({ x: 50, y: 20 });
    expect(moved.transform).toMatchObject({ x: 35, y: 25, width: 20, height: 20 });
    assertPointsInvariant(moved);

    // the cut follows: flatten output carries the moved points
    const flat = flattenObjectsForTest(useStore.getState().objects);
    expect(flat[0].points![0]).toMatchObject({ x: 35, y: 25 });
  });

  it("dragging a rect behaves exactly as before (characterization)", () => {
    useStore.getState().addObject(makeRect("r1", 10, 10, 20, 20));
    handleViewportPointerDown(20, 20, pe());
    handleViewportPointerMove(45, 35, pe());
    handleViewportPointerUp(45, 35, pe());
    const moved = getObj("r1");
    expect(moved.transform).toMatchObject({ x: 35, y: 25, width: 20, height: 20 });
    expect(moved.points).toBeUndefined();
  });

  it("undo after path drag restores POINTS (not a transform-only ghost); redo re-applies", () => {
    useStore.getState().addObject(makePath("p1"));
    handleViewportPointerDown(20, 20, pe());
    handleViewportPointerMove(45, 35, pe());
    handleViewportPointerUp(45, 35, pe());
    expect(getObj("p1").points![0].x).toBeCloseTo(35, 9);

    useStore.getState().undo();
    const undone = getObj("p1");
    expect(undone.points![0]).toMatchObject({ x: 10, y: 10 });
    expect(undone.points![0].handleOut).toEqual({ x: 15, y: 5 });
    expect(undone.transform).toMatchObject({ x: 10, y: 10 });
    assertPointsInvariant(undone);

    useStore.getState().redo();
    const redone = getObj("p1");
    expect(redone.points![0]).toMatchObject({ x: 35, y: 25 });
    expect(redone.transform).toMatchObject({ x: 35, y: 25 });
    assertPointsInvariant(redone);
  });
});

describe("handle-resize (select tool pointer pipeline)", () => {
  it("dragging the SE handle scales path points and handles about the anchor", () => {
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);

    // SE corner of selection bbox is (30, 30); drag to (50, 40) → bbox 40×30
    handleViewportPointerDown(30, 30, pe());
    handleViewportPointerMove(50, 40, pe());
    handleViewportPointerUp(50, 40, pe());

    const resized = getObj("p1");
    expect(resized.transform).toMatchObject({ x: 10, y: 10, width: 40, height: 30 });
    // anchor (10,10) fixed; (30,30) → (50,40); sx=2, sy=1.5
    expect(resized.points![0]).toMatchObject({ x: 10, y: 10 });
    expect(resized.points![2]).toMatchObject({ x: 50, y: 40 });
    // handleOut (15,5): x→10+(15-10)*2=20, y→10+(5-10)*1.5=2.5
    expect(resized.points![0].handleOut!.x).toBeCloseTo(20, 9);
    expect(resized.points![0].handleOut!.y).toBeCloseTo(2.5, 9);
    assertPointsInvariant(resized);

    // the cut follows
    const flat = flattenObjectsForTest(useStore.getState().objects);
    expect(flat[0].points![2]).toMatchObject({ x: 50, y: 40 });
  });

  it("ROTATED-path resize still scales points (invariant holds at all rotations)", () => {
    // R2's blocking scenario: rotated paths reach the resize handles via the
    // rotation-aware selection bbox — a rotation guard here would silently
    // re-manufacture the desync this phase exists to kill.
    useStore.getState().addObject(makePath("p1", 90)); // square bbox: rotated AABB == unrotated
    useStore.getState().setSelectedIds(["p1"]);

    handleViewportPointerDown(30, 30, pe());
    handleViewportPointerMove(40, 40, pe());
    handleViewportPointerUp(40, 40, pe());

    const resized = getObj("p1");
    expect(resized.transform.rotation).toBe(90); // rotation field untouched
    // points scaled in the unrotated frame: (30,30) → (40,40)
    expect(resized.points![2].x).toBeCloseTo(40, 9);
    expect(resized.points![2].y).toBeCloseTo(40, 9);
    assertPointsInvariant(resized);
  });

  it("resizing a rect behaves exactly as before (characterization)", () => {
    useStore.getState().addObject(makeRect("r1", 10, 10, 20, 20));
    useStore.getState().setSelectedIds(["r1"]);
    handleViewportPointerDown(30, 30, pe());
    handleViewportPointerMove(50, 40, pe());
    handleViewportPointerUp(50, 40, pe());
    const resized = getObj("r1");
    expect(resized.transform).toMatchObject({ x: 10, y: 10, width: 40, height: 30 });
  });

  it("undo after path resize restores points exactly; redo re-applies", () => {
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);
    handleViewportPointerDown(30, 30, pe());
    handleViewportPointerMove(50, 40, pe());
    handleViewportPointerUp(50, 40, pe());

    useStore.getState().undo();
    const undone = getObj("p1");
    expect(undone.transform).toMatchObject({ x: 10, y: 10, width: 20, height: 20 });
    expect(undone.points![2].x).toBeCloseTo(30, 9);
    expect(undone.points![2].y).toBeCloseTo(30, 9);
    expect(undone.points![0].handleOut!.x).toBeCloseTo(15, 9);
    expect(undone.points![0].handleOut!.y).toBeCloseTo(5, 9);
    assertPointsInvariant(undone);

    useStore.getState().redo();
    const redone = getObj("p1");
    expect(redone.transform).toMatchObject({ x: 10, y: 10, width: 40, height: 30 });
    expect(redone.points![2].x).toBeCloseTo(50, 9);
    assertPointsInvariant(redone);
  });

  it("undo after rotate restores the rotation field without disturbing points", () => {
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);
    const before = getObj("p1");

    // rotation handle sits 20mm above bbox top-center: (20, -10)
    handleViewportPointerDown(20, -10, pe());
    handleViewportPointerMove(40, 20, pe()); // swing around the center
    handleViewportPointerUp(40, 20, pe());

    const rotated = getObj("p1");
    expect(rotated.transform.rotation).not.toBe(0);
    // points live in the unrotated frame — rotation alone must not move them
    expect(rotated.points![0]).toMatchObject({ x: 10, y: 10 });
    assertPointsInvariant(rotated);

    useStore.getState().undo();
    const undone = getObj("p1");
    expect(undone.transform.rotation).toBe(0);
    expect(undone.points![0]).toMatchObject({ x: before.points![0].x, y: before.points![0].y });
    assertPointsInvariant(undone);
  });
});
