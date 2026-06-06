import { describe, it, expect, beforeEach, vi } from "vitest";

// svgExport reads useStore.getState() — seed the store, no Tauri needed
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { useStore } from "../../../app/store";
import type { DesignObject } from "../../../app/types";
import { DEFAULT_LAYERS } from "../../../app/types";
import { exportSvgContent } from "../svgExport";

function makeRotatedRect(id: string, x: number, y: number, w: number, h: number, rotation: number): DesignObject {
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

describe("svgExport", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      selectedIds: [],
      undoStack: [],
      redoStack: [],
      layers: DEFAULT_LAYERS,
      workspaceWidth: 300,
      workspaceHeight: 200,
    });
  });

  // D6 — rotated primitives must emit transform="rotate(deg cx cy)"
  it("D6: exports unrotated rect without rotate transform", () => {
    const obj = makeRotatedRect("r1", 10, 20, 50, 30, 0);
    useStore.getState().addObject(obj);
    const svg = exportSvgContent();
    // unrotated — no rotate transform should appear on this element
    expect(svg).not.toMatch(/transform="rotate\(/);
    expect(svg).toContain('x="10"');
  });

  it("D6: exports rotated rect with rotate(deg cx cy) at AABB center", () => {
    // Rect at (10,20) size 50×30, rotated 45 degrees
    // AABB center = (10+25, 20+15) = (35, 35)
    const obj = makeRotatedRect("r1", 10, 20, 50, 30, 45);
    useStore.getState().addObject(obj);
    const svg = exportSvgContent();
    // Must contain rotate with degrees=45, cx=35, cy=35
    expect(svg).toMatch(/transform="rotate\(45[,\s]+35[,\s]+35\)"/);
  });

  it("D6: exports rotated ellipse with rotate transform at AABB center", () => {
    const obj: DesignObject = {
      id: "e1",
      type: "ellipse",
      name: "Ellipse",
      transform: { x: 0, y: 0, width: 60, height: 40, rotation: 30, scaleX: 1, scaleY: 1 },
      layerIndex: 0,
      visible: true,
      locked: false,
      fill: null,
      stroke: "#e2664a",
      strokeWidth: 1,
      opacity: 1,
    };
    useStore.getState().addObject(obj);
    const svg = exportSvgContent();
    // center = (30, 20), rotation = 30
    expect(svg).toMatch(/transform="rotate\(30[,\s]+30[,\s]+20\)"/);
  });

  it("D6: near-zero rotation does not emit rotate transform", () => {
    const obj = makeRotatedRect("r1", 0, 0, 100, 50, 0.0001);
    useStore.getState().addObject(obj);
    const svg = exportSvgContent();
    expect(svg).not.toMatch(/transform="rotate\(/);
  });
});
