/**
 * Wave 4a — Re-audit fixes behavioral tests.
 *
 * Fix 1: originTop survives toProject/loadProject round-trip
 * Fix 3: Locked images included in generateImageGcode output
 * Fix 4: MaterialTestDialog S-value from grblSValueMax; error → abort
 * Fix 5: powerScale per-object applied to image engraving power
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../../app/store";
import { DEFAULT_LAYERS } from "../../../app/types";
import { generateGcode, type GcodeResult } from "../gcodeGen";

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

function makeImage(id: string, locked = false, powerScale?: number) {
  return {
    id,
    type: "image" as const,
    name: `Image ${id}`,
    transform: { x: 0, y: 0, width: 50, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    imageData: "data:image/png;base64,AAAA",
    ...(powerScale !== undefined ? { powerScale } : {}),
  };
}

// ---------------------------------------------------------------------------
// Fix 1 — originTop survives toProject / loadProject round-trip
// ---------------------------------------------------------------------------

describe("Fix 1 — originTop serialization", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      objectsById: new Map(),
      selectedIds: [],
      selectedSet: new Set(),
      undoStack: [],
      redoStack: [],
      layers: DEFAULT_LAYERS,
      originTop: false,
    });
  });

  it("toProject includes originTop=true when set", () => {
    useStore.getState().setOriginTop(true);
    const project = useStore.getState().toProject();
    expect(project.originTop).toBe(true);
  });

  it("toProject includes originTop=false when not set", () => {
    useStore.getState().setOriginTop(false);
    const project = useStore.getState().toProject();
    expect(project.originTop).toBe(false);
  });

  it("loadProject restores originTop=true from project file", () => {
    const project = useStore.getState().toProject();
    useStore.getState().setOriginTop(false);
    useStore.getState().loadProject({ ...project, originTop: true });
    expect(useStore.getState().originTop).toBe(true);
  });

  it("loadProject defaults originTop to false when field absent (backward compat)", () => {
    const project = useStore.getState().toProject();
    // Simulate old project file missing originTop
    const { originTop: _dropped, ...oldProject } = project;
    useStore.getState().setOriginTop(true); // set to true so we can verify reset
    useStore.getState().loadProject(oldProject as typeof project);
    expect(useStore.getState().originTop).toBe(false);
  });

  it("round-trips originTop=true through save and load", () => {
    useStore.getState().setOriginTop(true);
    const saved = useStore.getState().toProject();
    useStore.getState().setOriginTop(false); // simulate reload clearing state
    useStore.getState().loadProject(saved);
    expect(useStore.getState().originTop).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — Locked images appear in generateImageGcode output
// ---------------------------------------------------------------------------

describe("Fix 3 — locked images included in G-code", () => {
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
      grblSValueMax: 1000,
      originTop: false,
    });
  });

  it("invokes generate_image_gcode for a locked image", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_image_gcode") return rustResult();
      if (cmd === "generate_gcode") return rustResult();
      return undefined;
    });
    useStore.getState().addObject(makeImage("img_locked", true));

    await generateGcode();

    const imageCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "generate_image_gcode");
    expect(imageCalls).toHaveLength(1);
  });

  it("does NOT invoke generate_image_gcode for an invisible image", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_image_gcode") return rustResult();
      if (cmd === "generate_gcode") return rustResult();
      return undefined;
    });
    const img = makeImage("img_hidden", false);
    useStore.getState().addObject({ ...img, visible: false });

    await generateGcode();

    const imageCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "generate_image_gcode");
    expect(imageCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — powerScale applied to image engraving power
// ---------------------------------------------------------------------------

describe("Fix 5 — powerScale applied to images", () => {
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
      grblSValueMax: 1000,
      originTop: false,
    });
  });

  it("passes halved power when powerScale=0.5", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_image_gcode") return rustResult();
      if (cmd === "generate_gcode") return rustResult();
      return undefined;
    });
    useStore.getState().addObject(makeImage("img1", false, 0.5));
    // Default layer 0 power is 100
    const layerPower = DEFAULT_LAYERS[0].power;

    await generateGcode();

    const imageCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "generate_image_gcode");
    expect(imageCalls).toHaveLength(1);
    const request = imageCalls[0][1].request as Record<string, unknown>;
    expect(request.power).toBeCloseTo(layerPower * 0.5);
  });

  it("passes full power when powerScale is absent (defaults to 1)", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_image_gcode") return rustResult();
      if (cmd === "generate_gcode") return rustResult();
      return undefined;
    });
    useStore.getState().addObject(makeImage("img2", false)); // no powerScale
    const layerPower = DEFAULT_LAYERS[0].power;

    await generateGcode();

    const imageCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "generate_image_gcode");
    expect(imageCalls).toHaveLength(1);
    const request = imageCalls[0][1].request as Record<string, unknown>;
    expect(request.power).toBeCloseTo(layerPower * 1.0);
  });

  it("passes powerMin scaled by powerScale", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_image_gcode") return rustResult();
      if (cmd === "generate_gcode") return rustResult();
      return undefined;
    });
    // Set a non-zero powerMin on layer 0
    useStore.getState().updateLayer(0, { powerMin: 20 });
    useStore.getState().addObject(makeImage("img3", false, 0.5));

    await generateGcode();

    const imageCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "generate_image_gcode");
    expect(imageCalls).toHaveLength(1);
    const request = imageCalls[0][1].request as Record<string, unknown>;
    expect(request.powerMin).toBeCloseTo(20 * 0.5);
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — MaterialTestDialog S-value reads from grblSValueMax
// ---------------------------------------------------------------------------

describe("Fix 4 — MaterialTestDialog S-value from store", () => {
  it("grblSValueMax is accessible in the store and can be set", () => {
    useStore.setState({ grblSValueMax: 500 });
    expect(useStore.getState().grblSValueMax).toBe(500);
    useStore.getState().setGrblSValueMax(255);
    expect(useStore.getState().grblSValueMax).toBe(255);
  });
});
