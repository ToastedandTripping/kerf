/**
 * R2 F7 — the node editor on a rotated path, through the production pointer
 * pipeline. Node edits are display-only with respect to rotation: nodes are
 * drawn and hit at their rotated (world) positions, drags are mapped back into
 * the path's own frame, and transform.rotation is never written.
 *
 * 30° rather than 90°: at 90° a rotated node coincides with a different raw
 * node, which would mask the defect.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../../app/store";
import type { DesignObject, PathPoint } from "../../../app/types";
import { DEFAULT_LAYERS } from "../../../app/types";
import { pathPointsToWorld } from "../../geometry";
import { assertPointsInvariant } from "../../geometry/__tests__/pointsInvariant";
import { generateGcode } from "../../machine/gcodeGen";
import {
  deleteSelectedNode,
  handleViewportDoubleClick,
  handleViewportPointerDown,
  handleViewportPointerMove,
  handleViewportPointerUp,
  hitTestNodeHandles,
} from "../toolHandler";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

type XY = { x: number; y: number };

function pe(): React.PointerEvent {
  return { ctrlKey: false, shiftKey: false, button: 0 } as unknown as React.PointerEvent;
}

function addRotatedPath(layerIndex = 0): DesignObject {
  const points: PathPoint[] = [
    { x: 10, y: 10 },
    { x: 40, y: 10 },
    { x: 40, y: 40 },
  ];
  const obj: DesignObject = {
    id: "rp",
    type: "path",
    name: "RotatedPath",
    transform: { x: 10, y: 10, width: 30, height: 30, rotation: 30, scaleX: 1, scaleY: 1 },
    layerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    points,
    closed: true,
  };
  useStore.getState().addObject(obj);
  useStore.setState({ activeTool: "node" });
  useStore.getState().setNodeEditState({ pathId: "rp", selectedNodeIndex: null });
  return useStore.getState().objects.find((o) => o.id === "rp")!;
}

function getPath(): DesignObject {
  return useStore.getState().objects.find((o) => o.id === "rp")!;
}

function expectAt(a: XY, b: XY, tol = 1e-9) {
  expect(Math.abs(a.x - b.x)).toBeLessThan(tol);
  expect(Math.abs(a.y - b.y)).toBeLessThan(tol);
}

function drag(from: XY, by: XY) {
  handleViewportPointerDown(from.x, from.y, pe());
  handleViewportPointerMove(from.x + by.x, from.y + by.y, pe());
  handleViewportPointerUp(from.x + by.x, from.y + by.y, pe());
}

beforeEach(() => {
  mockInvoke.mockReset();
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
    consoleLines: [],
    layers: DEFAULT_LAYERS,
  });
});

describe("node editor on a rotated path (R2 F7)", () => {
  it("hit-tests nodes at their visible (rotated) positions", () => {
    const obj = addRotatedPath();
    const visible = pathPointsToWorld(obj);
    expect(hitTestNodeHandles(visible[0].x, visible[0].y, 1)).toEqual({
      index: 0,
      target: "node",
    });
  });

  it("drag: the node follows the cursor, the rest stay put, rotation unchanged, undo restores", () => {
    const original = addRotatedPath();
    const visible = pathPointsToWorld(original);
    // Several frames in one drag: each is computed from the drag-start snapshot
    // and centre, so an intermediate frame must leave no residue.
    handleViewportPointerDown(visible[2].x, visible[2].y, pe());
    handleViewportPointerMove(visible[2].x + 20, visible[2].y - 11, pe());
    handleViewportPointerMove(visible[2].x + 5, visible[2].y + 3, pe());
    handleViewportPointerUp(visible[2].x + 5, visible[2].y + 3, pe());

    const after = getPath();
    expect(after.transform.rotation).toBe(30);
    const world = pathPointsToWorld(after);
    expectAt(world[2], { x: visible[2].x + 5, y: visible[2].y + 3 });
    expectAt(world[0], visible[0]);
    expectAt(world[1], visible[1]);
    assertPointsInvariant(after);

    useStore.getState().undo();
    expect(getPath()).toEqual(original);
  });

  it("delete: rotation stays and the surviving nodes do not move", () => {
    const obj = addRotatedPath();
    const visible = pathPointsToWorld(obj);
    useStore.getState().setNodeEditState({ pathId: "rp", selectedNodeIndex: 2 });
    deleteSelectedNode();
    const after = getPath();
    expect(after.transform.rotation).toBe(30);
    expect(after.points).toHaveLength(2);
    const world = pathPointsToWorld(after);
    expectAt(world[0], visible[0]);
    expectAt(world[1], visible[1]);
    assertPointsInvariant(after);
  });

  it("toggle-smooth then handle drag: handle follows the cursor, twin mirrors in world, anchors fixed", () => {
    const obj = addRotatedPath();
    const visible = pathPointsToWorld(obj);
    const storedBefore = obj.points!.map((p) => ({ x: p.x, y: p.y }));

    // Toggle-smooth on node 1 by double-clicking its visible position.
    handleViewportDoubleClick(visible[1].x, visible[1].y);
    const smooth = getPath();
    expect(smooth.points![1].handleIn).toBeDefined();
    expect(smooth.points![1].handleOut).toBeDefined();
    expect(smooth.transform.rotation).toBe(30);
    expectAt(pathPointsToWorld(smooth)[1], visible[1]);
    smooth.points!.forEach((p, i) => expectAt(p, storedBefore[i]));

    // Handle drag on node 1's world-space handleOut.
    const w0 = pathPointsToWorld(smooth);
    const hOut = w0[1].handleOut!;
    drag(hOut, { x: 5, y: 3 });
    const after = getPath();
    const w1 = pathPointsToWorld(after);
    expectAt(w1[1].handleOut!, { x: hOut.x + 5, y: hOut.y + 3 });
    expectAt(w1[1].handleIn!, {
      x: 2 * w1[1].x - w1[1].handleOut!.x,
      y: 2 * w1[1].y - w1[1].handleOut!.y,
    });
    for (let i = 0; i < 3; i++) {
      expectAt(w1[i], w0[i]);
      expectAt(after.points![i], storedBefore[i]);
    }
    expect(after.transform.rotation).toBe(30);
  });
});

describe("generator input after node selection on a rotated fill path (R2 F7)", () => {
  function captureArgs(): string {
    const calls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "generate_gcode");
    expect(calls.length).toBeGreaterThan(0);
    return JSON.stringify(calls[calls.length - 1][1]);
  }

  it("a no-op node selection leaves the generate_gcode input byte-identical; a real edit keeps rotation 30", async () => {
    // Honest scope: this proves the INPUT to the Rust generator is identical.
    // The G-code bytes come from deterministic Rust given that input; running
    // Rust from vitest is not possible.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_gcode" || cmd === "generate_image_gcode")
        return {
          gcode: "G21\nG90\nM5\nM2",
          moves: [],
          totalDistance: 0,
          cutDistance: 0,
          travelDistance: 0,
          estimatedTimeSecs: 0,
          lineCount: 4,
        };
      return undefined;
    });
    useStore.setState({
      layers: [{ ...DEFAULT_LAYERS[0], mode: "fill" as const }, ...DEFAULT_LAYERS.slice(1)],
    });
    const obj = addRotatedPath(0);
    const visible = pathPointsToWorld(obj);

    await generateGcode();
    const first = captureArgs();

    drag(visible[1], { x: 0, y: 0 });
    await generateGcode();
    expect(captureArgs()).toBe(first);

    drag(visible[2], { x: 5, y: 3 });
    await generateGcode();
    const payload = JSON.parse(captureArgs()) as { objects: Array<Record<string, unknown>> };
    expect(payload.objects).toHaveLength(1);
    expect(payload.objects[0].rotation).toBe(30);
    expect(getPath().transform.rotation).toBe(30);
  });
});
