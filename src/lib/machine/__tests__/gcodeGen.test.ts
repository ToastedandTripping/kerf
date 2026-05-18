import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri invoke API so tests can run without the Rust backend
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { useStore } from "../../../app/store";
import type { DesignObject } from "../../../app/types";
import { DEFAULT_LAYERS } from "../../../app/types";
import { generateGcode } from "../gcodeGen";

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

describe("G-code Generation (JS fallback)", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      selectedIds: [],
      undoStack: [],
      redoStack: [],
      consoleLines: [],
      layers: DEFAULT_LAYERS,
    });
  });

  it("generates valid G-code for a simple rectangle", async () => {
    const obj = makeRect("r1", 10, 10, 20, 15);
    useStore.getState().addObject(obj);

    const result = await generateGcode();
    expect(result.gcode).toContain("G21"); // mm mode
    expect(result.gcode).toContain("G90"); // absolute positioning
    expect(result.gcode).toContain("M5"); // laser off
    expect(result.gcode).toContain("M2"); // program end
    expect(result.lineCount).toBeGreaterThan(5);
    expect(result.cutDistance).toBeGreaterThan(0);
  });

  it("respects layer output=false (skips objects on disabled layers)", async () => {
    const obj = makeRect("r1", 0, 0, 10, 10);
    useStore.getState().addObject(obj);
    // Disable layer output
    useStore.getState().updateLayer(0, { output: false });

    const result = await generateGcode();
    // No cutting commands should exist (only header/footer)
    expect(result.cutDistance).toBe(0);
  });

  it("skips text objects and adds a warning", async () => {
    useStore.getState().addObject({
      id: "t1",
      type: "text",
      name: "Test Text",
      transform: { x: 10, y: 10, width: 50, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
      layerIndex: 0,
      visible: true,
      locked: false,
      fill: null,
      stroke: "#4a90e2",
      strokeWidth: 1,
      opacity: 1,
      text: "Hello",
      fontSize: 12,
    });

    const result = await generateGcode();
    // Text should not produce any cutting distance
    expect(result.cutDistance).toBe(0);
    // The warning about text objects should appear in the console
    const consoleLines = useStore.getState().consoleLines;
    const warningTexts = consoleLines.map((l) => l.text);
    expect(warningTexts.some((t) => t.includes("Text") || t.includes("text") || t.includes("skipped"))).toBe(true);
  });

  it("returns zero distances when no objects exist", async () => {
    const result = await generateGcode();
    expect(result.cutDistance).toBe(0);
    expect(result.travelDistance).toBe(0);
  });
});
