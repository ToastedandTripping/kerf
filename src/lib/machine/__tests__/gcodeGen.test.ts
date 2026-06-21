import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri invoke API. The old file-level always-reject mock exercised
// the (now deleted) JS fallback generator; these re-homed tests drive the
// SAME generateGcode entry through a mocked Rust contract instead, asserting
// the flatten/serialization-level behavior that lives in the frontend
// (toCutObjects filtering, warnings, invoke args) plus the new hard-fail.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../../app/store";
import type { DesignObject } from "../../../app/types";
import { DEFAULT_LAYERS } from "../../../app/types";
import { generateGcode, toCutObjectsForTest, type GcodeResult } from "../gcodeGen";
import type { Layer } from "../../../app/types";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

function rustResult(overrides: Partial<GcodeResult> = {}): GcodeResult {
  return {
    gcode: "G21\nG90\nM5\nM2",
    moves: [],
    totalDistance: 0,
    cutDistance: 0,
    travelDistance: 0,
    estimatedTimeSecs: 0,
    lineCount: 4,
    ...overrides,
  };
}

/** Resolving Rust-contract mock; returns the per-command canned results. */
function mockRustEngine(vector: GcodeResult = rustResult()) {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "generate_gcode") return vector;
    if (cmd === "generate_image_gcode") return rustResult();
    return undefined;
  });
}

/** The objects payload of the LAST generate_gcode invoke. */
function sentCutObjects(): Array<Record<string, unknown>> {
  const calls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "generate_gcode");
  expect(calls.length).toBeGreaterThan(0);
  const args = calls[calls.length - 1][1] as { objects: Array<Record<string, unknown>> };
  return args.objects;
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

describe("G-code generation (Rust contract + hard-fail)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useStore.setState({
      objects: [],
      objectsById: new Map(),
      selectedIds: [],
      selectedSet: new Set(),
      undoStack: [],
      redoStack: [],
      consoleLines: [],
      layers: DEFAULT_LAYERS,
    });
  });

  // Re-homed from "generates valid G-code for a simple rectangle" (JS fallback):
  // the serialization-level contract — the rectangle reaches the engine as a
  // CutObject with its transform geometry and layer settings, and the engine's
  // result is returned unchanged.
  it("serializes a simple rectangle into the generate_gcode invoke args", async () => {
    const vector = rustResult({ gcode: "G21\nG90\nG1 X30 Y25\nM5\nM2", cutDistance: 70, lineCount: 5 });
    mockRustEngine(vector);
    useStore.getState().addObject(makeRect("r1", 10, 10, 20, 15));

    const result = await generateGcode();

    const objects = sentCutObjects();
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({
      id: "r1",
      objType: "rectangle",
      x: 10, y: 10, width: 20, height: 15,
      rotation: 0,
    });
    expect((objects[0].layer as Record<string, unknown>).mode).toBe(DEFAULT_LAYERS[0].mode);
    expect(result).toBe(vector); // Rust result passes through untouched
  });

  // Re-homed from "respects layer output=false" (fallback cutDistance===0):
  // the filtering lives in toCutObjects BEFORE the invoke — the engine must
  // receive zero objects.
  it("respects layer output=false (object never reaches the engine)", async () => {
    mockRustEngine();
    useStore.getState().addObject(makeRect("r1", 0, 0, 10, 10));
    useStore.getState().updateLayer(0, { output: false });

    await generateGcode();
    expect(sentCutObjects()).toHaveLength(0);
  });

  // Re-homed from "skips text objects and adds a warning" (fallback): the
  // text-skip + console warning are emitted before the invoke and the text
  // object must not reach the engine.
  it("skips text objects with a console warning (nothing sent to the engine)", async () => {
    mockRustEngine();
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

    await generateGcode();
    expect(sentCutObjects()).toHaveLength(0);
    const warningTexts = useStore.getState().consoleLines.map((l) => l.text);
    expect(warningTexts.some((t) => t.includes("Test Text") && t.includes("skipped"))).toBe(true);
  });

  // Re-homed from "returns zero distances when no objects exist" (fallback):
  // an empty design sends an empty objects array and returns the engine's
  // result verbatim.
  it("sends an empty objects array for an empty design", async () => {
    const vector = rustResult();
    mockRustEngine(vector);

    const result = await generateGcode();
    expect(sentCutObjects()).toHaveLength(0);
    expect(result).toBe(vector);
  });

  // NEW (fallback deletion): engine failure REJECTS — no JS fallback exists,
  // no G-code of any kind comes back.
  it("rejects when the Rust engine fails — no fallback G-code", async () => {
    mockInvoke.mockRejectedValue(new Error("engine exploded"));
    useStore.getState().addObject(makeRect("r1", 10, 10, 20, 15));

    await expect(generateGcode()).rejects.toThrow("engine exploded");
  });

  // F11: locked objects are included in G-code output; only visibility and
  // layer.output control exclusion. Lock is "protect from edits", not "exclude from cut".
  it("F11: locked object is included in G-code (lock ≠ exclude)", async () => {
    mockRustEngine();
    const lockedRect = { ...makeRect("r1", 0, 0, 10, 10), locked: true };
    useStore.getState().addObject(lockedRect);

    await generateGcode();

    const objects = sentCutObjects();
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ id: "r1" });
  });

  // F11: invisible objects are still excluded
  it("F11: invisible object is excluded from G-code (visible=false ≠ locked)", async () => {
    mockRustEngine();
    const invisRect = { ...makeRect("r1", 0, 0, 10, 10), visible: false };
    useStore.getState().addObject(invisRect);

    await generateGcode();

    expect(sentCutObjects()).toHaveLength(0);
  });

  // NEW (fallback deletion): an image-pipeline failure no longer falls into a
  // vector-only fallback that silently drops image content — it rejects, and
  // the error names the failing image object.
  it("wraps an image-pipeline failure with the failing object's name", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_image_gcode") throw new Error("dither panic");
      return rustResult();
    });
    useStore.getState().addObject({
      id: "img1",
      type: "image",
      name: "Logo Photo",
      transform: { x: 0, y: 0, width: 50, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
      layerIndex: 0,
      visible: true,
      locked: false,
      fill: null,
      stroke: "#4a90e2",
      strokeWidth: 1,
      opacity: 1,
      imageData: "data:image/png;base64,AAAA",
    });

    await expect(generateGcode()).rejects.toThrow(/Logo Photo.*dither panic/);
  });
});

// ─── fillLine dual-emission regression guard ───────────────────────────────

/** Build a closed path object (simulates a traced glyph contour). */
function makeClosedPath(id: string, layerIndex = 0): DesignObject {
  return {
    id,
    type: "path",
    name: `Path ${id}`,
    transform: { x: 10, y: 10, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    points: [
      { x: 10, y: 10 },
      { x: 30, y: 10 },
      { x: 30, y: 30 },
      { x: 10, y: 30 },
    ],
    closed: true,
  };
}

/** Build an open path object (line — should NOT get a line overlay). */
function makeOpenPath(id: string, layerIndex = 0): DesignObject {
  return {
    id,
    type: "path",
    name: `OpenPath ${id}`,
    transform: { x: 0, y: 0, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    points: [{ x: 0, y: 0 }, { x: 20, y: 20 }],
    closed: false,
  };
}

function fillLineLayer(index = 0): Layer {
  return {
    ...DEFAULT_LAYERS[0],
    index,
    mode: "fillLine",
    lineOverlay: { power: 90, powerMin: 0, speed: 1200, passes: 1, powerMode: "constant" },
  };
}

describe("fillLine dual-emission (regression guard for dropped-pass bug)", () => {
  it("a fillLine layer with a closed path emits BOTH a fill CutObject and a line overlay CutObject", () => {
    const layers = [fillLineLayer(0), ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([makeClosedPath("p1", 0)], layers);
    // Must have exactly 2 objects: the fill/maskFill pass and the line overlay
    expect(objects).toHaveLength(2);
    // First is the fill (effectiveMode = maskFill for non-rect closed path)
    expect(["fill", "maskFill"]).toContain(objects[0].layer.mode);
    // Second is the line overlay
    expect(objects[1].layer.mode).toBe("line");
    expect(objects[1].id).toMatch(/line_overlay/);
  });

  it("line overlay carries lineOverlay settings (power/speed from lineOverlay, not layer fill)", () => {
    const layers = [fillLineLayer(0), ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([makeClosedPath("p1", 0)], layers);
    const lineObj = objects.find((o) => o.layer.mode === "line");
    expect(lineObj).toBeDefined();
    expect(lineObj!.layer.power).toBe(90);
    expect(lineObj!.layer.speed).toBe(1200);
  });

  it("open path on fillLine layer does NOT get a line overlay (no closed paths)", () => {
    const layers = [fillLineLayer(0), ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([makeOpenPath("p1", 0)], layers);
    // Only the fill object — no line overlay because path is open
    const lineObjs = objects.filter((o) => o.layer.mode === "line");
    expect(lineObjs).toHaveLength(0);
  });

  it("fill-mode layer (not fillLine) does NOT emit a line overlay", () => {
    const layers = [{ ...DEFAULT_LAYERS[0], mode: "fill" as const }, ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([makeClosedPath("p1", 0)], layers);
    const lineObjs = objects.filter((o) => o.layer.mode === "line");
    expect(lineObjs).toHaveLength(0);
  });

  it("line-mode layer does NOT emit a second line overlay", () => {
    const layers = [{ ...DEFAULT_LAYERS[0], mode: "line" as const }, ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([makeClosedPath("p1", 0)], layers);
    expect(objects).toHaveLength(1);
  });

  it("fillLine grouped paths (coalesced maskFill) emit the maskFill + line overlay", () => {
    // Two closed paths in the same group → coalesced into one maskFill CutObject
    // The fill line overlay should also be emitted for the coalesced group
    const obj1 = makeClosedPath("p1", 0);
    const obj2 = makeClosedPath("p2", 0);
    // Wrap in a group to trigger coalescing
    const group: DesignObject = {
      id: "g1",
      type: "group",
      name: "Glyph",
      transform: { x: 10, y: 10, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
      layerIndex: 0,
      visible: true,
      locked: false,
      fill: null,
      stroke: "#4a90e2",
      strokeWidth: 1,
      opacity: 1,
      children: [obj1, obj2],
    };
    const layers = [fillLineLayer(0), ...DEFAULT_LAYERS.slice(1)];
    const { objects } = toCutObjectsForTest([group], layers);
    const maskFillObjs = objects.filter((o) => o.layer.mode === "maskFill");
    const lineObjs = objects.filter((o) => o.layer.mode === "line");
    expect(maskFillObjs).toHaveLength(1);
    expect(lineObjs).toHaveLength(1);
    expect(lineObjs[0].id).toMatch(/line_overlay/);
  });
});
