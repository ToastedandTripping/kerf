/**
 * TB3 power-curve presets (plan kerf-power-curve-presets, T1-T6).
 *
 * Point convention: x = input shade 0-255, y = output power 0-100%. The Rust
 * LUT (`build_power_curve_lut`) maps power 100% to shade 0 (full burn), so a
 * preset must give black (shade 0) its maximum power or the image burns as its
 * negative. T2 pins these arrays to the Rust fixtures that N1/N2 check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { PowerCurveEditor, PRESETS } from "../PowerCurveEditor";
import type { CurvePoint } from "../PowerCurveEditor";
import { LayerPanel } from "../LayerPanel";
import { MachinePanel } from "../MachinePanel";
import { JobActionBar } from "../JobActionBar";
import { useStore } from "../../../app/store";
import type { AppState } from "../../../app/store";
import type { DesignObject, Layer } from "../../../app/types";
import { DEFAULT_LAYERS } from "../../../app/types";
import { parseAndValidateProject, loadProjectWithMigrations } from "../../../lib/fileOps";
import { generateGcode } from "../../../lib/machine/gcodeGen";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;
type GcodeResult = NonNullable<AppState["gcodeResult"]>;

const OLD_S_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 64, y: 10 },
  { x: 128, y: 50 },
  { x: 192, y: 90 },
  { x: 255, y: 100 },
];
const OLD_POSTERIZE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 84, y: 0 },
  { x: 85, y: 33 },
  { x: 169, y: 33 },
  { x: 170, y: 66 },
  { x: 254, y: 66 },
  { x: 255, y: 100 },
];
const pairs = (pts: CurvePoint[]) => pts.map((p) => [p.x, p.y]);

// Recomputed from the component's constants (CANVAS_W 480, CANVAS_H 280).
const CANVAS_W = 480;
const CANVAS_H = 280;
const shadeToCanvasX = (s: number) => (s / 255) * CANVAS_W;
const powerToCanvasY = (p: number) => CANVAS_H - (p / 100) * CANVAS_H;
const CURVE_STROKE = "#c4a57b";

// ------------------------------------------------------- recording context

type Rec = { op: string; args: unknown[] } | { set: string; value: unknown };
let recording: Rec[];
let contextMode: "record" | "null";

function recordingContext(): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        recording.push({ op: prop, args });
      };
    },
    set(t, prop: string, value) {
      t[prop] = value;
      recording.push({ set: prop, value });
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/**
 * The curve stroke: strokeStyle set to the curve colour, beginPath, a moveTo at
 * the first point's canvas coordinates, then one lineTo per canvas column, then
 * stroke. Returns the LAST such stroke's moveTo args (the most recent draw), or
 * null when no such sequence was recorded.
 */
function findCurveStroke(): [number, number] | null {
  for (let i = recording.length - 1; i >= 0; i--) {
    const r = recording[i];
    if (!("set" in r) || r.set !== "strokeStyle" || r.value !== CURVE_STROKE) continue;
    const rest = recording.slice(i + 1);
    const ops = rest.filter((x): x is { op: string; args: unknown[] } => "op" in x);
    if (ops[0]?.op !== "beginPath" || ops[1]?.op !== "moveTo") continue;
    let j = 2;
    while (ops[j]?.op === "lineTo") j++;
    if (j - 2 !== CANVAS_W || ops[j]?.op !== "stroke") continue;
    return ops[1].args as [number, number];
  }
  return null;
}

function arcs(): [number, number][] {
  return recording
    .filter((r): r is { op: string; args: unknown[] } => "op" in r && r.op === "arc")
    .map((r) => [r.args[0] as number, r.args[1] as number]);
}

beforeEach(() => {
  cleanup();
  recording = [];
  contextMode = "record";
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => (contextMode === "record" ? recordingContext() : null) as never
  );
  mockInvoke.mockReset();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- T1

describe("T1: every preset burns black hardest", () => {
  it.each(Object.keys(PRESETS))("%s falls from shade 0 to shade 255", (name) => {
    const pts = PRESETS[name];
    const maxY = Math.max(...pts.map((p) => p.y));
    expect(pts[0].x).toBe(0);
    expect(pts[0].y).toBe(maxY);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].x).toBeGreaterThan(pts[i - 1].x);
      expect(pts[i].y).toBeLessThanOrEqual(pts[i - 1].y);
    }
    expect(pts[pts.length - 1]).toEqual({ x: 255, y: 0 });
  });

  it("has exactly the three presets", () => {
    expect(Object.keys(PRESETS)).toEqual(["Linear", "S-Curve", "Posterize"]);
  });
});

// ---------------------------------------------------------------- T2

describe("T2: TS presets match the Rust fixtures", () => {
  const rust = readFileSync(join(process.cwd(), "src-tauri/src/engine/image_gcode_gen.rs"), "utf8");
  function extract(name: string): CurvePoint[] {
    const re = new RegExp(`const ${name}: &\\[\\(f64, f64\\)\\] = &\\[([\\s\\S]*?)\\];`, "g");
    const found = [...rust.matchAll(re)];
    expect(found.length, `${name} must appear exactly once in image_gcode_gen.rs`).toBe(1);
    const tuples = [...found[0][1].matchAll(/\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/g)];
    expect(tuples.length).toBeGreaterThan(1);
    return tuples.map((t) => ({ x: Number(t[1]), y: Number(t[2]) }));
  }
  it("TB3_S_CURVE equals the S-Curve preset", () => {
    expect(extract("TB3_S_CURVE")).toEqual(PRESETS["S-Curve"]);
  });
  it("TB3_POSTERIZE equals the Posterize preset", () => {
    expect(extract("TB3_POSTERIZE")).toEqual(PRESETS.Posterize);
  });
  it("TB3_OLD_S_CURVE and TB3_OLD_POSTERIZE are the legacy arrays", () => {
    expect(extract("TB3_OLD_S_CURVE")).toEqual(OLD_S_CURVE);
    expect(extract("TB3_OLD_POSTERIZE")).toEqual(OLD_POSTERIZE);
  });
});

// ---------------------------------------------------------------- T3

function editor(open: boolean, points: CurvePoint[], onApply = vi.fn(), onClose = vi.fn()) {
  return <PowerCurveEditor open={open} points={points} onApply={onApply} onClose={onClose} />;
}

describe("T3: the editor draws its curve when it opens", () => {
  it("draws the curve stroke and control points on open, with the same points reference", () => {
    const pts = PRESETS["S-Curve"];
    const { rerender, getByText } = render(editor(false, pts));
    expect(recording).toEqual([]);
    rerender(editor(true, pts));

    const move = findCurveStroke();
    expect(move).not.toBeNull();
    expect(move![0]).toBeCloseTo(shadeToCanvasX(pts[0].x));
    expect(move![1]).toBeCloseTo(powerToCanvasY(pts[0].y));
    const a = arcs();
    expect(a).toHaveLength(pts.length);
    a.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(shadeToCanvasX(pts[i].x));
      expect(y).toBeCloseTo(powerToCanvasY(pts[i].y));
    });

    // Cancel, reopen with different incoming points: drawn from the new start.
    recording = [];
    fireEvent.click(getByText("Cancel"));
    rerender(editor(false, pts));
    const other: CurvePoint[] = [
      { x: 0, y: 60 },
      { x: 255, y: 0 },
    ];
    rerender(editor(true, other));
    const move2 = findCurveStroke();
    expect(move2).not.toBeNull();
    expect(move2![1]).toBeCloseTo(powerToCanvasY(60));
    // The last draw's control points are the new two.
    const last = arcs().slice(-2);
    expect(last[0][1]).toBeCloseTo(powerToCanvasY(60));
    expect(last[1][0]).toBeCloseTo(shadeToCanvasX(255));
    expect(last[1][1]).toBeCloseTo(powerToCanvasY(0));
  });
});

// ---------------------------------------------------------------- T4

describe("T4: Apply writes once", () => {
  it("Apply after picking S-Curve calls onApply once with the new points", () => {
    const onApply = vi.fn();
    const { getByText } = render(editor(true, PRESETS.Linear, onApply));
    fireEvent.click(getByText("S-Curve"));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(getByText("Apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(PRESETS["S-Curve"]);
  });

  it("Cancel after picking a preset applies nothing", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    const { getByText } = render(editor(true, PRESETS.Linear, onApply, onClose));
    fireEvent.click(getByText("Posterize"));
    fireEvent.click(getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("with no 2D context, nothing is drawn and Apply still works", () => {
    contextMode = "null";
    const onApply = vi.fn();
    const { getByText } = render(editor(true, PRESETS.Linear, onApply));
    expect(recording).toEqual([]);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(getByText("Posterize"));
    fireEvent.click(getByText("Apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(PRESETS.Posterize);
  });
});

// ---------------------------------------------------------------- shared seeding

const IMG_DATA = "data:image/png;base64,iVBORw0KGgo=";

function makeImage(id: string, layerIndex: number): DesignObject {
  return {
    id,
    type: "image",
    name: `Image ${id}`,
    transform: {
      x: 10,
      y: 10 + layerIndex * 20,
      width: 40,
      height: 10,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    },
    layerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#000000",
    strokeWidth: 0,
    opacity: 1,
    imageData: IMG_DATA,
  };
}

function frag(): GcodeResult {
  return {
    gcode: "G1 X10 Y20",
    moves: [{ x: 10, y: 20, moveType: "cut", speed: 100, power: 50 }],
    totalDistance: 1,
    cutDistance: 1,
    travelDistance: 0,
    estimatedTimeSecs: 1,
    lineCount: 1,
  };
}

/** Layers 0 (Engrave) and 2 both raster, with the given curves. */
function rasterLayers(c0?: CurvePoint[], c2?: CurvePoint[]): Layer[] {
  return DEFAULT_LAYERS.map((l) =>
    l.index === 0
      ? { ...l, mode: "fill" as const, dither: "grayscale" as const, powerCurve: c0 }
      : l.index === 2
        ? { ...l, mode: "fill" as const, dither: "grayscale" as const, powerCurve: c2 }
        : l
  );
}

function seedDesign(layers: Layer[]) {
  const objects = [makeImage("img0", 0), makeImage("img2", 2)];
  useStore.setState({
    objects,
    objectsById: new Map(objects.map((o) => [o.id, o])),
    selectedIds: [],
    selectedSet: new Set(),
    undoStack: [],
    redoStack: [],
    consoleLines: [],
    layers,
    activeLayerIndex: 0,
    gcodeResult: null,
    gcodeStale: false,
    statusMessage: null,
    machineConnected: true,
    machineState: "idle",
    jobRunning: false,
    workspaceWidth: 500,
    workspaceHeight: 300,
    originTop: false,
    startCorner: "bottomLeft",
    grblSValueMax: 1000,
    workspaceVerified: true,
    grblLaserMode: true,
    statusStale: false,
    isDirty: false,
  });
}

/** Save exactly as saveToPath does, then open as openProject does. */
function saveAndReopen() {
  const content = JSON.stringify(useStore.getState().toProject(), null, 2);
  const project = parseAndValidateProject(content, "/tmp/t5.kerf");
  expect(project).not.toBeNull();
  expect(loadProjectWithMigrations(project!)).toBe(true);
}

async function capturedCurves(): Promise<unknown[]> {
  const curves: unknown[] = [];
  mockInvoke.mockImplementation((cmd: string, args: { request?: { powerCurve?: unknown } }) => {
    if (cmd === "generate_image_gcode") {
      curves.push(args.request?.powerCurve);
      return Promise.resolve(frag());
    }
    if (cmd === "generate_gcode") return Promise.resolve(frag());
    if (cmd === "list_serial_ports") return Promise.resolve([]);
    throw new Error(`unexpected invoke: ${cmd}`);
  });
  await generateGcode();
  return curves;
}

/** Open layer `index`'s curve editor in the real LayerPanel, pick, Apply. */
function applyPresetThroughLayerPanel(container: HTMLElement, layerPos: number, preset: string) {
  const toggles = container.querySelectorAll("button[aria-expanded]");
  fireEvent.click(toggles[layerPos]);
  const edit = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Edit"
  );
  expect(edit).toBeDefined();
  fireEvent.click(edit!);
  const btn = Array.from(container.ownerDocument.querySelectorAll("button")).find(
    (b) => b.textContent === preset
  );
  fireEvent.click(btn!);
  const apply = Array.from(container.ownerDocument.querySelectorAll("button")).find(
    (b) => b.textContent === "Apply"
  );
  fireEvent.click(apply!);
  // collapse again so the next layer's Edit is the only one
  fireEvent.click(container.querySelectorAll("button[aria-expanded]")[layerPos]);
}

describe("T4: a failed regeneration after Apply", () => {
  it("keeps the old result stale, shows the failure, and dispatches nothing", async () => {
    seedDesign(rasterLayers());
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_serial_ports") return Promise.resolve([]);
      if (cmd === "generate_image_gcode") return Promise.reject(new Error("engine exploded"));
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    const s = useStore.getState();
    const prev = frag();
    expect(s.publishGeneration(s.beginGeneration(), prev)).toBe("published");

    const { container, getByText, queryByText } = render(
      <>
        <LayerPanel />
        <MachinePanel />
        <JobActionBar />
      </>
    );
    applyPresetThroughLayerPanel(container, 0, "S-Curve");
    expect(useStore.getState().layers[0].powerCurve).toEqual(PRESETS["S-Curve"]);
    expect(useStore.getState().gcodeStale).toBe(true);

    fireEvent.click(getByText("Regenerate G-code"));
    await waitFor(() => expect(queryByText("Generating...")).toBeNull());
    await act(async () => {});

    const st = useStore.getState();
    expect(st.gcodeResult).toBe(prev);
    expect(st.gcodeStale).toBe(true);
    expect(st.statusMessage).toBe("G-code generation failed — see console");
    expect(st.consoleLines.some((l) => l.text.startsWith("G-code generation failed: "))).toBe(true);
    const start = getByText("START") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    const cmds = mockInvoke.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("generate_image_gcode");
    expect(cmds).not.toContain("serial_job_begin");
    expect(cmds).not.toContain("serial_stream_job");
  });
});

// ---------------------------------------------------------------- T5

describe("T5: saved curves are never rewritten", () => {
  it("legacy S-Curve and Posterize survive save, reopen and generate unchanged", async () => {
    seedDesign(rasterLayers(OLD_S_CURVE, OLD_POSTERIZE));
    saveAndReopen();
    const st = useStore.getState();
    expect(st.layers.find((l) => l.index === 0)!.powerCurve).toEqual(OLD_S_CURVE);
    expect(st.layers.find((l) => l.index === 2)!.powerCurve).toEqual(OLD_POSTERIZE);
    expect(await capturedCurves()).toEqual([pairs(OLD_S_CURVE), pairs(OLD_POSTERIZE)]);
  });

  it("new presets applied in the LayerPanel survive save, reopen and generate", async () => {
    seedDesign(rasterLayers());
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_serial_ports") return Promise.resolve([]);
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    const { container } = render(<LayerPanel />);
    applyPresetThroughLayerPanel(container, 0, "S-Curve");
    applyPresetThroughLayerPanel(container, 2, "Posterize");
    cleanup();
    saveAndReopen();
    expect(await capturedCurves()).toEqual([pairs(PRESETS["S-Curve"]), pairs(PRESETS.Posterize)]);
  });
});

// ---------------------------------------------------------------- T6

describe("T6: the preset highlight", () => {
  // jsdom normalises #c4a57b to rgb(196, 165, 123); the inactive border is var(--border).
  const isHighlighted = (el: HTMLElement) => el.style.border === "1px solid rgb(196, 165, 123)";
  it("the highlight check can see both states", () => {
    const { getByText } = render(editor(true, PRESETS.Linear));
    expect(getByText("S-Curve").style.border).toBe("1px solid var(--border)");
    expect(isHighlighted(getByText("Linear"))).toBe(true);
  });
  it("old S-Curve points highlight no preset", () => {
    const { getByText } = render(editor(true, OLD_S_CURVE));
    for (const name of Object.keys(PRESETS)) expect(isHighlighted(getByText(name))).toBe(false);
  });
  it("new S-Curve points highlight S-Curve only", () => {
    const { getByText } = render(editor(true, PRESETS["S-Curve"]));
    expect(isHighlighted(getByText("S-Curve"))).toBe(true);
    expect(isHighlighted(getByText("Linear"))).toBe(false);
    expect(isHighlighted(getByText("Posterize"))).toBe(false);
  });
});

// ---------------------------------------------------------------- owner card fixture

describe("owner-card fixture docs/owner-cards/tb3-legacy-s-curve.kerf", () => {
  it("loads, and carries exactly the fixed recipe with the old S-Curve", () => {
    const content = readFileSync(
      join(process.cwd(), "docs/owner-cards/tb3-legacy-s-curve.kerf"),
      "utf8"
    );
    const project = parseAndValidateProject(content, "tb3-legacy-s-curve.kerf");
    expect(project).not.toBeNull();
    const images = project!.objects.filter((o) => o.type === "image");
    expect(project!.objects).toHaveLength(1);
    expect(images).toHaveLength(1);
    const img = images[0];
    expect(img.transform.width).toBe(40);
    expect(img.transform.height).toBe(10);
    expect(img.imageAdjustments ?? null).toEqual({
      brightness: 0,
      contrast: 0,
      gamma: 1,
      invert: false,
      removeBackground: false,
      bgTolerance: 20,
    });
    const outputLayers = project!.layers.filter((l) => l.output);
    expect(outputLayers).toHaveLength(1);
    const layer = outputLayers[0];
    expect(layer.index).toBe(img.layerIndex);
    expect(layer.mode).toBe("fill");
    expect(layer.power).toBe(15);
    expect(layer.powerMin).toBe(0);
    expect(layer.speed).toBe(3000);
    expect(layer.powerMode).toBe("variable");
    expect(layer.dither).toBe("grayscale");
    expect(layer.interval).toBe(0.1);
    expect(layer.passes).toBe(1);
    expect(layer.powerCurve).toEqual(OLD_S_CURVE);
    expect(img.powerScale ?? 1).toBe(1);
    expect(loadProjectWithMigrations(project!)).toBe(true);
    expect(useStore.getState().layers.find((l) => l.index === layer.index)!.powerCurve).toEqual(
      OLD_S_CURVE
    );
  });
});
