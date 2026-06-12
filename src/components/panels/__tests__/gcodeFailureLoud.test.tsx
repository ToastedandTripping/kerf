/**
 * W1c — fallback deletion: Rust-engine failure must be LOUD and BLOCKING,
 * exercised through the PRODUCTION MachinePanel handler (the single
 * generateGcode caller):
 *  - console error (durable record) + status line (3s transient pointer)
 *  - gcodeResult untouched (null on first generation, previous value on
 *    stale regenerate) — the null/stale gates keep START and FRAME blocked
 *  - the preview button never opens an empty preview on a failed generation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../../app/store";
import type { AppState } from "../../../app/store";
import type { DesignObject } from "../../../app/types";
import { DEFAULT_LAYERS } from "../../../app/types";
import { MachinePanel } from "../MachinePanel";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

function previousResult(): NonNullable<AppState["gcodeResult"]> {
  return {
    gcode: "G1 X10 Y20\nG1 X50 Y80",
    moves: [
      { x: 10, y: 20, moveType: "cut", speed: 100, power: 50 },
      { x: 50, y: 80, moveType: "cut", speed: 100, power: 50 },
    ],
    totalDistance: 100,
    cutDistance: 100,
    travelDistance: 0,
    estimatedTimeSecs: 10,
    lineCount: 2,
  };
}

function makeRect(id: string): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x: 10, y: 10, width: 20, height: 15, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

function seedBase() {
  useStore.setState({
    objects: [],
    objectsById: new Map(),
    selectedIds: [],
    selectedSet: new Set(),
    undoStack: [],
    redoStack: [],
    consoleLines: [],
    layers: DEFAULT_LAYERS,
    machineConnected: true,
    machineState: "idle",
    machinePosition: { x: 0, y: 0, z: 0 },
    jobRunning: false,
    jobProgress: 0,
    gcodeResult: null,
    gcodeStale: false,
    previewVisible: false,
    statusMessage: null,
    workspaceWidth: 500,
    workspaceHeight: 300,
    grblSValueMax: 1000,
  });
}

/** Engine mock: serial endpoints work, G-code generation always fails. */
function mockBrokenEngine() {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_serial_ports") return [];
    if (cmd === "serial_get_status")
      return { status: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>", events: [] };
    if (cmd === "generate_gcode" || cmd === "generate_image_gcode")
      throw new Error("engine exploded");
    return undefined;
  });
}

function consoleTexts(): string[] {
  return useStore.getState().consoleLines.map((l) => l.text);
}

describe("Rust-engine failure is loud and blocking (fallback deleted)", () => {
  beforeEach(() => {
    cleanup();
    mockInvoke.mockReset();
    localStorage.clear();
    seedBase();
  });

  it("FIRST-generation failure: console + status line, gcodeResult stays null, START/FRAME blocked", async () => {
    mockBrokenEngine();
    useStore.getState().addObject(makeRect("r1"));
    const { getByText } = render(<MachinePanel />);

    fireEvent.click(getByText("Generate G-code"));
    await waitFor(() =>
      expect(consoleTexts().some((t) => t.includes("G-code generation failed") && t.includes("engine exploded"))).toBe(true),
    );
    expect(useStore.getState().statusMessage).toBe("G-code generation failed — see console");
    expect(useStore.getState().gcodeResult).toBeNull();

    const start = getByText("START") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe("Generate G-code first");
    const frame = getByText("FRAME") as HTMLButtonElement;
    expect(frame.disabled).toBe(true);
    expect(frame.title).toBe("Generate G-code first");
  });

  it("STALE-regenerate failure: gcodeResult keeps its previous value, stale gate still blocks", async () => {
    mockBrokenEngine();
    const prev = previousResult();
    useStore.setState({ gcodeResult: prev });
    useStore.getState().addObject(makeRect("r1")); // objects write flips gcodeStale
    expect(useStore.getState().gcodeStale).toBe(true);
    const { getByText } = render(<MachinePanel />);

    fireEvent.click(getByText("Regenerate G-code"));
    await waitFor(() =>
      expect(consoleTexts().some((t) => t.includes("G-code generation failed"))).toBe(true),
    );
    // Untouched, not nulled: the previous result object is still there…
    expect(useStore.getState().gcodeResult).toBe(prev);
    // …and the STALE gate (set by the edit that prompted regeneration) blocks.
    expect(useStore.getState().gcodeStale).toBe(true);
    const start = getByText("START") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe("Design changed -- regenerate G-code");
    expect((getByText("FRAME") as HTMLButtonElement).disabled).toBe(true);
  });

  it("preview button does NOT open the preview when generation fails", async () => {
    mockBrokenEngine();
    useStore.getState().addObject(makeRect("r1"));
    const { getByText } = render(<MachinePanel />);

    fireEvent.click(getByText("Preview"));
    await waitFor(() =>
      expect(consoleTexts().some((t) => t.includes("G-code generation failed"))).toBe(true),
    );
    expect(useStore.getState().previewVisible).toBe(false);
  });
});
