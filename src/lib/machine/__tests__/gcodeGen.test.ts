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
import { generateGcode, toCutObjectsForTest, stripFramingForTest, assembleGcodeForTest, type GcodeResult } from "../gcodeGen";
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
    // The assembled result carries the engine's cut metrics
    expect(result.cutDistance).toBe(vector.cutDistance);
    expect(result.moves).toEqual(vector.moves);
  });

  // Re-homed from "respects layer output=false" (fallback cutDistance===0):
  // the filtering lives in toCutObjects BEFORE the invoke — the engine must
  // not be called when all objects are filtered out.
  // WS2: with per-layer bucketing, no bucket → no generate_gcode invoke.
  it("respects layer output=false (object never reaches the engine)", async () => {
    mockRustEngine();
    useStore.getState().addObject(makeRect("r1", 0, 0, 10, 10));
    useStore.getState().updateLayer(0, { output: false });

    await generateGcode();
    // With per-layer bucketing: filtered object means empty buckets → no generate_gcode call.
    const calls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "generate_gcode");
    expect(calls).toHaveLength(0);
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
    // Text object is filtered by toCutObjects — no bucket formed → no generate_gcode call.
    const calls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "generate_gcode");
    expect(calls).toHaveLength(0);
    const warningTexts = useStore.getState().consoleLines.map((l) => l.text);
    expect(warningTexts.some((t) => t.includes("Test Text") && t.includes("skipped"))).toBe(true);
  });

  // Re-homed from "returns zero distances when no objects exist" (fallback):
  // an empty design has no buckets → no generate_gcode call → assembleGcode
  // returns the empty-fragments fallback (non-null, valid G-code structure).
  // WS2: empty design no longer invokes generate_gcode at all (no bucket).
  it("empty design produces no engine calls and a valid (minimal) G-code result", async () => {
    mockRustEngine();

    const result = await generateGcode();
    // No invokes fired
    const calls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "generate_gcode");
    expect(calls).toHaveLength(0);
    // assembleGcode([]) returns a minimal valid G-code document (not null/undefined)
    expect(result).toBeDefined();
    expect(result.gcode).toBeTruthy();
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

    // Invisible object filtered → no bucket → no generate_gcode call.
    const calls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "generate_gcode");
    expect(calls).toHaveLength(0);
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

// ─── B1: M4 default + $32=0 warning ──────────────────────────────────────────

describe("B1 — M4 default and $32=0 warning at job generation", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_gcode") return rustResult();
      if (cmd === "generate_image_gcode") return undefined;
      return undefined;
    });
    useStore.setState({
      objects: [],
      objectsById: new Map(),
      selectedIds: [],
      selectedSet: new Set(),
      undoStack: [],
      redoStack: [],
      consoleLines: [],
      layers: DEFAULT_LAYERS,
      grblLaserMode: false,
      grblSValueMax: 1000,
    });
  });

  it("B1a: DEFAULT_LAYERS Engrave layer defaults to powerMode='variable' (M4)", () => {
    const engrave = DEFAULT_LAYERS[0];
    expect(engrave.mode).toBe("fill");
    expect(engrave.powerMode).toBe("variable");
  });

  it("B1a: DEFAULT_LAYERS line layers retain powerMode='constant' (M3)", () => {
    const lineLayers = DEFAULT_LAYERS.filter((l) => l.mode === "line");
    for (const layer of lineLayers) {
      expect(layer.powerMode).toBe("constant");
    }
  });

  it("B1c: warns when a fill layer is in job but $32=0 (laser mode disabled)", async () => {
    // DEFAULT_LAYERS[0] is mode='fill', so any object on layer 0 triggers the warning
    useStore.setState({ grblLaserMode: false });
    useStore.getState().addObject(makeRect("r1", 0, 0, 10, 10));

    await generateGcode();

    const warnings = useStore.getState().consoleLines.map((l) => l.text);
    // New wider warning: fires for any fill/raster layer; checks $32 + dynamic power mention
    const has32Warning = warnings.some(
      (t) => t.includes("$32") && t.includes("M4") && t.includes("dynamic power"),
    );
    expect(has32Warning).toBe(true);
  });

  it("B1c: does NOT warn about $32 when $32=1 (laser mode enabled)", async () => {
    useStore.setState({ grblLaserMode: true });
    useStore.getState().addObject(makeRect("r1", 0, 0, 10, 10));

    await generateGcode();

    const warnings = useStore.getState().consoleLines.map((l) => l.text);
    const has32Warning = warnings.some(
      (t) => t.includes("$32") && t.includes("M4") && t.includes("dynamic power"),
    );
    expect(has32Warning).toBe(false);
  });

  it("B1c: warns for fill layer even with M3 (constant power) — $32=0 is unsafe for raster regardless", async () => {
    // $32=0 causes G0 rapids to potentially fire the laser during lead-ins, regardless of power mode.
    // The widened warning fires on fill-mode layer presence, not powerMode.
    useStore.setState({
      grblLaserMode: false,
      layers: DEFAULT_LAYERS.map((l) => ({ ...l, powerMode: "constant" as const })),
    });
    useStore.getState().addObject(makeRect("r1", 0, 0, 10, 10));

    await generateGcode();

    const warnings = useStore.getState().consoleLines.map((l) => l.text);
    const has32Warning = warnings.some(
      (t) => t.includes("$32") && t.includes("M4") && t.includes("dynamic power"),
    );
    expect(has32Warning).toBe(true);
  });

  it("B1 regression: M3/constant layer emits unchanged layer settings (no silent M4 upgrade)", async () => {
    useStore.setState({
      layers: DEFAULT_LAYERS.map((l) => ({ ...l, powerMode: "constant" as const })),
    });
    useStore.getState().addObject(makeRect("r1", 0, 0, 10, 10));

    await generateGcode();

    const objects = sentCutObjects();
    expect(objects).toHaveLength(1);
    expect((objects[0].layer as Record<string, unknown>).powerMode).toBe("constant");
  });
});

// ─── WS2 — Layer-order assembly + risky-order warning ────────────────────────
//
// These tests cover the new strict layer-order assembly: images are no longer
// emitted first unconditionally — both images and vectors are bucketed by layer
// position and emitted in ascending order. Within a tie, image fragments precede
// the vector fragment.

/** A realistic mock vector fragment from the Rust engine with sentinels. */
function vectorFragment(label: string): GcodeResult {
  // Mirrors the real engine output shape:
  // Header: "; Generated by Kerf", G21, G90, M5, G0 X0 Y0, "; KERF:PREAMBLE_END", ""
  // Body:   "; Cut: {label}" + a G1 move
  // Footer: "; KERF:FOOTER_BEGIN", "M5 ; laser off", "G0 X0 Y0 ; return home", "M2 ; program end"
  const gcode = [
    "; Generated by Kerf",
    "G21 ; mm mode",
    "G90 ; absolute positioning",
    "M5 ; laser off",
    "G0 X0 Y0 ; home",
    "; KERF:PREAMBLE_END",
    "",
    `; Cut: ${label}`,
    "G0 X10 Y10",
    "M3 S1000",
    "G1 X50 Y10 F1200 S1000",
    "M5",
    "",
    "; KERF:FOOTER_BEGIN",
    "M5 ; laser off",
    "G0 X0 Y0 ; return home",
    "M2 ; program end",
  ].join("\n");
  return {
    gcode,
    moves: [{ x: 50, y: 10, moveType: "cut", speed: 1200, power: 1000 }],
    totalDistance: 40,
    cutDistance: 40,
    travelDistance: 0,
    estimatedTimeSecs: 2,
    lineCount: gcode.split("\n").length,
  };
}

/** A realistic mock image fragment from the Rust engine with sentinels.
 *  Image engine has preamble sentinel but no footer sentinel (no M2). */
function imageFragment(label: string): GcodeResult {
  const gcode = [
    "G21 ; mm mode",
    "G90 ; absolute positioning",
    "M5 ; laser off",
    `; Image engrave: 10x10 px, interval 0.1mm — ${label}`,
    "; KERF:PREAMBLE_END",
    "",
    "; Scan line 1",
    "G0 X0 Y50",
    "M4 S800",
    "G1 X100 Y50 F6000 S800",
    "M5",
  ].join("\n");
  return {
    gcode,
    moves: [{ x: 100, y: 50, moveType: "engrave", speed: 6000, power: 800 }],
    totalDistance: 100,
    cutDistance: 100,
    travelDistance: 0,
    estimatedTimeSecs: 1,
    lineCount: gcode.split("\n").length,
  };
}

/** Make an image object assigned to a specific layerIndex. */
function makeImage(id: string, layerIndex: number): DesignObject {
  return {
    id,
    type: "image" as const,
    name: `Image ${id}`,
    transform: { x: 0, y: 0, width: 50, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    imageData: "data:image/png;base64,AAAA",
  };
}

// ─── stripFraming unit tests ──────────────────────────────────────────────────

describe("WS2 — stripFraming (sentinel-based framing removal)", () => {
  it("strips vector fragment preamble and footer using sentinels", () => {
    const fragment = vectorFragment("test-cut");
    const stripped = stripFramingForTest(fragment.gcode);
    // Preamble (before and including KERF:PREAMBLE_END) should be gone
    expect(stripped).not.toContain("G21 ; mm mode");
    expect(stripped).not.toContain("G90 ; absolute positioning");
    expect(stripped).not.toContain("; KERF:PREAMBLE_END");
    // Footer (from KERF:FOOTER_BEGIN onward) should be gone
    expect(stripped).not.toContain("; KERF:FOOTER_BEGIN");
    expect(stripped).not.toContain("M2 ; program end");
    // Body content should remain
    expect(stripped).toContain("; Cut: test-cut");
    expect(stripped).toContain("G1 X50 Y10");
  });

  it("strips image fragment preamble (no footer sentinel — image engine emits none)", () => {
    const fragment = imageFragment("engrave");
    const stripped = stripFramingForTest(fragment.gcode);
    // Preamble gone
    expect(stripped).not.toContain("G21 ; mm mode");
    expect(stripped).not.toContain("; KERF:PREAMBLE_END");
    // Body content remains (no footer sentinel, so everything after preamble stays)
    expect(stripped).toContain("; Scan line 1");
    expect(stripped).toContain("G1 X100 Y50");
  });

  it("preserves gcode unchanged when no sentinels present (graceful degradation)", () => {
    const bare = "G21\nG90\nG1 X10 Y10\nM5\nM2";
    const stripped = stripFramingForTest(bare);
    // No sentinels found → bodyStart=0, bodyEnd=end → unchanged
    expect(stripped).toBe(bare);
  });
});

// ─── assembleGcode unit tests (framing-lock) ─────────────────────────────────

describe("WS2 — assembleGcode (document framing lock)", () => {
  it("single fragment: framing lock applies (exactly one preamble, one M2, no seam)", () => {
    const fragment = vectorFragment("solo");
    const result = assembleGcodeForTest([fragment]);
    const lines = result.gcode.split("\n");
    // Exactly one G21 — no duplication from strip-and-assemble
    expect(lines.filter((l) => l === "G21 ; mm mode")).toHaveLength(1);
    // Exactly one M2 (program end)
    expect(lines.filter((l) => l === "M2 ; program end")).toHaveLength(1);
    // Exactly one G90
    expect(lines.filter((l) => l === "G90 ; absolute positioning")).toHaveLength(1);
    // No seam lines (single fragment has no inter-fragment seam)
    expect(lines.filter((l) => l === "M5 ; laser off at layer seam")).toHaveLength(0);
    // Body content is present
    expect(result.gcode).toContain("; Cut: solo");
  });

  it("two fragments: exactly one G21, one G90, one M2, and one M5 seam between them", () => {
    const f1 = vectorFragment("cut");
    const f2 = vectorFragment("engrave");
    const result = assembleGcodeForTest([f1, f2]);

    const lines = result.gcode.split("\n");

    // Framing lock: exactly one of each critical document command
    expect(lines.filter((l) => l === "G21 ; mm mode")).toHaveLength(1);
    expect(lines.filter((l) => l === "G90 ; absolute positioning")).toHaveLength(1);
    // M2 must be the final non-empty line
    const lastNonEmpty = [...lines].reverse().find((l) => l.trim() !== "");
    expect(lastNonEmpty).toBe("M2 ; program end");
    // Exactly one M2 total
    expect(lines.filter((l) => l === "M2 ; program end")).toHaveLength(1);

    // Seam: one "M5 ; laser off at layer seam" between the two fragment bodies
    const seamLines = lines.filter((l) => l === "M5 ; laser off at layer seam");
    expect(seamLines).toHaveLength(1);
  });

  it("image fragment before vector fragment: correct framing with one M5 seam", () => {
    const imgFrag = imageFragment("top-engrave");
    const vecFrag = vectorFragment("bottom-cut");
    const result = assembleGcodeForTest([imgFrag, vecFrag]);

    const lines = result.gcode.split("\n");

    // Framing lock
    expect(lines.filter((l) => l === "G21 ; mm mode")).toHaveLength(1);
    expect(lines.filter((l) => l === "G90 ; absolute positioning")).toHaveLength(1);
    expect(lines.filter((l) => l === "M2 ; program end")).toHaveLength(1);

    // Seam between fragments
    const seamCount = lines.filter((l) => l === "M5 ; laser off at layer seam").length;
    expect(seamCount).toBe(1);

    // Body content: image body present, then seam, then vector body — check both present
    expect(result.gcode).toContain("; Scan line 1"); // image body
    expect(result.gcode).toContain("; Cut: bottom-cut"); // vector body

    // Correct ordering: image body before vector body
    const imgIdx = result.gcode.indexOf("; Scan line 1");
    const vecIdx = result.gcode.indexOf("; Cut: bottom-cut");
    expect(imgIdx).toBeLessThan(vecIdx);
  });

  it("three fragments: N-1 seams (two seams for three fragments)", () => {
    const f1 = imageFragment("layer0-img");
    const f2 = vectorFragment("layer1-vec");
    const f3 = vectorFragment("layer2-cut");
    const result = assembleGcodeForTest([f1, f2, f3]);

    const lines = result.gcode.split("\n");
    // Two seams for three fragments
    const seamLines = lines.filter((l) => l === "M5 ; laser off at layer seam");
    expect(seamLines).toHaveLength(2);
    // Still exactly one document preamble and one M2
    expect(lines.filter((l) => l === "G21 ; mm mode")).toHaveLength(1);
    expect(lines.filter((l) => l === "M2 ; program end")).toHaveLength(1);
  });

  it("sums distances and moves from all fragments", () => {
    const f1 = vectorFragment("a");
    const f2 = imageFragment("b");
    const result = assembleGcodeForTest([f1, f2]);
    expect(result.cutDistance).toBe(f1.cutDistance + f2.cutDistance);
    expect(result.totalDistance).toBe(f1.totalDistance + f2.totalDistance);
    expect(result.estimatedTimeSecs).toBe(f1.estimatedTimeSecs + f2.estimatedTimeSecs);
    expect(result.moves).toHaveLength(f1.moves.length + f2.moves.length);
  });
});

// ─── generateGcode integration tests (layer ordering) ────────────────────────

describe("WS2 — generateGcode layer ordering", () => {
  /** Standard state setup with given layers */
  function setupStore(layers: Layer[]) {
    mockInvoke.mockReset();
    useStore.setState({
      objects: [],
      objectsById: new Map(),
      selectedIds: [],
      selectedSet: new Set(),
      undoStack: [],
      redoStack: [],
      consoleLines: [],
      layers,
      grblSValueMax: 1000,
      grblLaserMode: true,
      originTop: false,
      workspaceHeight: 400,
      workspaceWidth: 600,
      startCorner: "bottomLeft",
    });
  }

  /** Return all generate_gcode invoke call args in order */
  function allVectorCalls(): Array<{ objects: Array<Record<string, unknown>> }> {
    return mockInvoke.mock.calls
      .filter(([cmd]) => cmd === "generate_gcode")
      .map(([, args]) => args as { objects: Array<Record<string, unknown>> });
  }

  /** Return all generate_image_gcode invoke call args in order */
  function allImageCalls(): Array<{ request: Record<string, unknown> }> {
    return mockInvoke.mock.calls
      .filter(([cmd]) => cmd === "generate_image_gcode")
      .map(([, args]) => args as { request: Record<string, unknown> });
  }

  // Layers for ordering tests:
  //   pos 0 → index 0 "Engrave" (fill)
  //   pos 1 → index 1 "Score"   (line)
  //   pos 2 → index 2 "Cut"     (line)
  // DEFAULT_LAYERS matches this layout.

  it("image on low-layer (pos 0) emits before vector cut on high-layer (pos 2)", async () => {
    // Image on Engrave layer (pos 0), rect on Cut layer (pos 2)
    const layers = DEFAULT_LAYERS;
    setupStore(layers);

    useStore.getState().addObject(makeImage("img-low", 0));  // pos 0 (Engrave)
    useStore.getState().addObject(makeRect("rect-cut", 0, 0, 10, 10)); // will be on Cut (index 2)
    // Override rect to be on Cut layer (index 2)
    useStore.getState().updateObject("rect-cut", { layerIndex: 2 });

    // Mock: image → imageFragment, vector → vectorFragment
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_image_gcode") return imageFragment("img-low-result");
      if (cmd === "generate_gcode") return vectorFragment("cut-result");
      return undefined;
    });

    const result = await generateGcode();

    // The result should have image content before vector content
    const imgBodyIdx = result.gcode.indexOf("; Scan line 1");
    const vecBodyIdx = result.gcode.indexOf("; Cut: cut-result");
    expect(imgBodyIdx).toBeGreaterThan(-1);
    expect(vecBodyIdx).toBeGreaterThan(-1);
    expect(imgBodyIdx).toBeLessThan(vecBodyIdx);

    // Image invoke fired before vector invoke
    const calls = mockInvoke.mock.calls.map(([cmd]) => cmd);
    const imgCallIdx = calls.indexOf("generate_image_gcode");
    const vecCallIdx = calls.indexOf("generate_gcode");
    expect(imgCallIdx).toBeLessThan(vecCallIdx);
  });

  it("image on high-layer (pos 2) emits AFTER vector cut on low-layer (pos 0)", async () => {
    // Reorder: put Cut at pos 0, Engrave at pos 2
    // layers array order = cut order, so: [Cut(index 2), Score(index 1), Engrave(index 0)]
    const layers: Layer[] = [
      { ...DEFAULT_LAYERS[2], index: 2 }, // pos 0 → Cut (line mode)
      { ...DEFAULT_LAYERS[1], index: 1 }, // pos 1 → Score (line mode)
      { ...DEFAULT_LAYERS[0], index: 0 }, // pos 2 → Engrave (fill mode)
    ];
    setupStore(layers);

    useStore.getState().addObject(makeImage("img-high", 0));  // Engrave layer (index 0) → pos 2
    useStore.getState().addObject(makeRect("rect-cut", 0, 0, 10, 10)); // Cut layer (index 2) → pos 0
    useStore.getState().updateObject("rect-cut", { layerIndex: 2 });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_image_gcode") return imageFragment("img-high-result");
      if (cmd === "generate_gcode") return vectorFragment("cut-low-result");
      return undefined;
    });

    const result = await generateGcode();

    // Vector cut (pos 0) should appear before image (pos 2)
    const vecBodyIdx = result.gcode.indexOf("; Cut: cut-low-result");
    const imgBodyIdx = result.gcode.indexOf("; Scan line 1");
    expect(vecBodyIdx).toBeGreaterThan(-1);
    expect(imgBodyIdx).toBeGreaterThan(-1);
    expect(vecBodyIdx).toBeLessThan(imgBodyIdx);
  });

  it("same-layer tie: image fragment emits before vector fragment", async () => {
    // Image and rect both on Engrave layer (pos 0)
    setupStore(DEFAULT_LAYERS);

    useStore.getState().addObject(makeImage("img-same", 0));   // Engrave (pos 0)
    useStore.getState().addObject(makeRect("rect-same", 0, 0, 10, 10)); // Engrave (pos 0 via default)

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_image_gcode") return imageFragment("same-layer-img");
      if (cmd === "generate_gcode") return vectorFragment("same-layer-vec");
      return undefined;
    });

    const result = await generateGcode();

    // Image body before vector body within the same layer
    const imgBodyIdx = result.gcode.indexOf("; Scan line 1");
    const vecBodyIdx = result.gcode.indexOf("; Cut: same-layer-vec");
    expect(imgBodyIdx).toBeLessThan(vecBodyIdx);
  });

  it("vector-fill on a layer ordered BELOW a Cut: cut precedes fill + risky-order warning fires", async () => {
    // Lee's exact case: Fill (Engrave at pos 0) sits BELOW a Cut (at pos 2).
    // Reorder layers: put Cut first (pos 0), then Engrave (pos 2).
    // This means Cut fires before Engrave → risky warning should fire.
    const layers: Layer[] = [
      { ...DEFAULT_LAYERS[2], index: 2 }, // pos 0 → Cut (line mode)
      { ...DEFAULT_LAYERS[1], index: 1 }, // pos 1 → Score
      { ...DEFAULT_LAYERS[0], index: 0 }, // pos 2 → Engrave (fill mode)
    ];
    setupStore(layers);

    // Rect on Cut layer (pos 0 / index 2) — a line-mode cut
    useStore.getState().addObject(makeRect("rect-cut", 0, 0, 10, 10));
    useStore.getState().updateObject("rect-cut", { layerIndex: 2 });

    // Rect on Engrave layer (pos 2 / index 0) — a fill-mode engrave
    useStore.getState().addObject(makeRect("rect-fill", 20, 0, 10, 10));
    useStore.getState().updateObject("rect-fill", { layerIndex: 0 });

    // Two separate vector invokes (per layer group), each returns distinct fragment
    let callCount = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_gcode") {
        callCount++;
        return callCount === 1 ? vectorFragment("cut-first") : vectorFragment("fill-second");
      }
      if (cmd === "generate_image_gcode") return imageFragment("unused");
      return undefined;
    });

    const result = await generateGcode();

    // Cut body (pos 0) before fill body (pos 2)
    const cutIdx = result.gcode.indexOf("; Cut: cut-first");
    const fillIdx = result.gcode.indexOf("; Cut: fill-second");
    expect(cutIdx).toBeGreaterThan(-1);
    expect(fillIdx).toBeGreaterThan(-1);
    expect(cutIdx).toBeLessThan(fillIdx);

    // Risky-order warning fires (line-mode layer pos 0 < fill-mode layer pos 2)
    const warnings = useStore.getState().consoleLines
      .filter((l) => l.type === "warning")
      .map((l) => l.text);
    const hasRiskyWarn = warnings.some(
      (t) => t.toLowerCase().includes("cut") || t.toLowerCase().includes("freed") ||
              t.toLowerCase().includes("engrave") || t.toLowerCase().includes("line"),
    );
    expect(hasRiskyWarn).toBe(true);
  });

  it("risky warning does NOT fire when engrave is above cut (default safe order)", async () => {
    // DEFAULT_LAYERS: Engrave (fill, pos 0) < Cut (line, pos 2) → safe, no warning
    setupStore(DEFAULT_LAYERS);

    useStore.getState().addObject(makeRect("rect1", 0, 0, 10, 10)); // default layer 0 (Engrave)
    useStore.getState().addObject(makeRect("rect2", 20, 0, 10, 10));
    useStore.getState().updateObject("rect2", { layerIndex: 2 }); // Cut layer

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_gcode") return vectorFragment("any");
      return undefined;
    });

    await generateGcode();

    const warnings = useStore.getState().consoleLines
      .filter((l) => l.type === "warning")
      .map((l) => l.text);
    // Should not fire risky-order warning (no line-mode layer before fill-mode)
    const hasRiskyWarn = warnings.some(
      (t) => t.includes("freed") || t.includes("line fires before") ||
              (t.includes("Cut") && t.includes("Engrave")),
    );
    expect(hasRiskyWarn).toBe(false);
  });

  it("image-only job assembles cleanly (no empty preamble/footer, no missing M2)", async () => {
    setupStore(DEFAULT_LAYERS);
    useStore.getState().addObject(makeImage("img-only", 0));

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_image_gcode") return imageFragment("image-only-result");
      if (cmd === "generate_gcode") return vectorFragment("empty-vector");
      return undefined;
    });

    const result = await generateGcode();

    // Image-only job has no vector objects → no generate_gcode call.
    // The single image fragment goes through strip-and-assemble (single-fragment
    // fast path was removed). Image engine emits no M2 or return-home, so the
    // assemble path's docFooter provides them — this is the regression fix.
    expect(result.gcode).toBeTruthy();
    expect(result.gcode).toContain("; Scan line 1");
    // Exactly one docPreamble G21 (not the engine's, which is stripped)
    const lines = result.gcode.split("\n");
    expect(lines.filter((l) => l === "G21 ; mm mode")).toHaveLength(1);
    // Must have M2 (program end) — previously missing for image-only jobs
    expect(result.gcode).toContain("M2 ; program end");
    // Must have return-home — previously missing for image-only jobs
    expect(result.gcode).toContain("G0 X0 Y0 ; return home");
    // Single image fragment → no vector invoke needed
    const vectorCalls = allVectorCalls();
    expect(vectorCalls).toHaveLength(0);
  });

  it("vector-only job (no images) assembles cleanly", async () => {
    setupStore(DEFAULT_LAYERS);
    useStore.getState().addObject(makeRect("vec-only", 0, 0, 10, 10));

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_gcode") return vectorFragment("vector-only-result");
      return undefined;
    });

    const result = await generateGcode();

    // No image invokes fired
    expect(allImageCalls()).toHaveLength(0);
    // One vector invoke
    expect(allVectorCalls()).toHaveLength(1);
    // Result has the expected framing
    expect(result.gcode).toContain("G21 ; mm mode");
    expect(result.gcode).toContain("; Cut: vector-only-result");
    // Single fragment still gets docFooter (M2 from assembleGcode, not the engine)
    expect(result.gcode).toContain("M2 ; program end");
  });

  it("orphan-layerIndex object is emitted last and a warning is present in console", async () => {
    setupStore(DEFAULT_LAYERS);

    // Object with no matching layerIndex (e.g. 99 — not in DEFAULT_LAYERS)
    useStore.getState().addObject({ ...makeRect("orphan", 0, 0, 10, 10), layerIndex: 99 });
    // Normal object on Cut layer (pos 2 / index 2)
    useStore.getState().addObject(makeRect("normal", 20, 0, 10, 10));
    useStore.getState().updateObject("normal", { layerIndex: 2 });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_gcode") return vectorFragment("any");
      return undefined;
    });

    await generateGcode();

    // Orphan warning in console
    const consoleMsgs = useStore.getState().consoleLines.map((l) => l.text);
    const hasOrphanWarn = consoleMsgs.some(
      (t) => t.includes("unknown layer") || t.includes("emitted last"),
    );
    expect(hasOrphanWarn).toBe(true);
  });

  it("vector-only ordering unchanged: all objects still reach generate_gcode", async () => {
    // Verify that the per-layer invoke approach sends the same set of objects as
    // the old single invoke (just potentially in separate calls).
    setupStore(DEFAULT_LAYERS);

    const r1 = makeRect("r1", 0, 0, 10, 10);
    const r2 = makeRect("r2", 20, 0, 10, 10);
    useStore.getState().addObject(r1); // Engrave layer (pos 0)
    useStore.getState().addObject(r2); // Engrave layer (pos 0) — same layer

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_gcode") return vectorFragment("any");
      return undefined;
    });

    await generateGcode();

    const vectorCalls = allVectorCalls();
    // Both objects on same layer → one generate_gcode call with both objects
    expect(vectorCalls).toHaveLength(1);
    expect(vectorCalls[0].objects).toHaveLength(2);
    const ids = vectorCalls[0].objects.map((o) => o.id);
    expect(ids).toContain("r1");
    expect(ids).toContain("r2");
  });

  it("per-layer generate_gcode calls fire with correct subset of objects", async () => {
    // Objects on two different layers → two separate generate_gcode invokes
    const layers: Layer[] = [
      { ...DEFAULT_LAYERS[0], index: 0 }, // pos 0 Engrave (fill)
      { ...DEFAULT_LAYERS[2], index: 2 }, // pos 1 Cut (line)
    ];
    setupStore(layers);

    useStore.getState().addObject(makeRect("engrave-obj", 0, 0, 10, 10));    // index 0 (pos 0)
    useStore.getState().addObject(makeRect("cut-obj", 20, 0, 10, 10));       // default index 0
    useStore.getState().updateObject("cut-obj", { layerIndex: 2 });           // index 2 (pos 1)

    let invokesWithObjs: string[][] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: { objects?: Array<{ id: string }> }) => {
      if (cmd === "generate_gcode") {
        invokesWithObjs.push((args?.objects ?? []).map((o) => o.id));
        return vectorFragment(`layer-call-${invokesWithObjs.length}`);
      }
      return undefined;
    });

    await generateGcode();

    // Two separate invokes, one per layer position
    expect(invokesWithObjs).toHaveLength(2);
    // First invoke (pos 0, Engrave) has only the engrave object
    expect(invokesWithObjs[0]).toContain("engrave-obj");
    expect(invokesWithObjs[0]).not.toContain("cut-obj");
    // Second invoke (pos 1, Cut) has only the cut object
    expect(invokesWithObjs[1]).toContain("cut-obj");
    expect(invokesWithObjs[1]).not.toContain("engrave-obj");
  });
});
