/**
 * W1b — F1 writer tests for the Properties panel numeric X/Y/W/H fields,
 * through the PRODUCTION component (render + change events on the real inputs).
 *
 * Field order inside the single-selection panel (path object): the number
 * inputs appear as X, Y, W, H, Rotation, Stroke width, Opacity, Power.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { render, fireEvent, cleanup } from "@testing-library/react";
import { useStore } from "../../../app/store";
import type { DesignObject, PathPoint } from "../../../app/types";
import { assertPointsInvariant } from "../../../lib/geometry";
import { PropertiesPanel } from "../PropertiesPanel";

function makePath(id: string): DesignObject {
  const points: PathPoint[] = [
    { x: 10, y: 10, handleOut: { x: 15, y: 5 } },
    { x: 30, y: 10, handleIn: { x: 25, y: 5 } },
    { x: 30, y: 30 },
  ];
  return {
    id,
    type: "path",
    name: `Path ${id}`,
    transform: { x: 10, y: 10, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
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

const get = (id: string) => useStore.getState().objects.find((o) => o.id === id)!;

function numberInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[type="number"]'));
}

beforeEach(() => {
  cleanup();
  useStore.setState({
    objects: [],
    objectsById: new Map(),
    selectedIds: [],
    selectedSet: new Set(),
    undoStack: [],
    redoStack: [],
    _propertyEditSnapshot: null,
  });
});

describe("PropertiesPanel position/size fields on a path", () => {
  it("typing X moves points and handles with the transform", () => {
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);
    const { container } = render(<PropertiesPanel />);

    const [xField] = numberInputs(container);
    fireEvent.change(xField, { target: { value: "60" } });

    const p = get("p1");
    expect(p.transform.x).toBe(60);
    expect(p.points![0]).toMatchObject({ x: 60, y: 10 });
    expect(p.points![0].handleOut).toEqual({ x: 65, y: 5 });
    assertPointsInvariant(p);
  });

  it("typing Y moves points with the transform", () => {
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);
    const { container } = render(<PropertiesPanel />);

    const [, yField] = numberInputs(container);
    fireEvent.change(yField, { target: { value: "100" } });

    const p = get("p1");
    expect(p.transform.y).toBe(100);
    expect(p.points![0]).toMatchObject({ x: 10, y: 100 });
    assertPointsInvariant(p);
  });

  it("typing W scales points about the anchor (matches handle-drag semantics)", () => {
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);
    const { container } = render(<PropertiesPanel />);

    const [, , wField] = numberInputs(container);
    fireEvent.change(wField, { target: { value: "40" } }); // sx = 2 about x=10

    const p = get("p1");
    expect(p.transform).toMatchObject({ x: 10, y: 10, width: 40, height: 20 });
    expect(p.points![1].x).toBeCloseTo(50, 9); // 10 + (30-10)*2
    expect(p.points![1].handleIn!.x).toBeCloseTo(40, 9); // 10 + (25-10)*2
    assertPointsInvariant(p);
  });

  it("typing H scales points vertically", () => {
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);
    const { container } = render(<PropertiesPanel />);

    const [, , , hField] = numberInputs(container);
    fireEvent.change(hField, { target: { value: "10" } }); // sy = 0.5 about y=10

    const p = get("p1");
    expect(p.transform).toMatchObject({ x: 10, y: 10, width: 20, height: 10 });
    expect(p.points![2].y).toBeCloseTo(20, 9); // 10 + (30-10)*0.5
    assertPointsInvariant(p);
  });
});
