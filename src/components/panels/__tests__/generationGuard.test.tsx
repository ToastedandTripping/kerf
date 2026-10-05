/**
 * TB3 publication guard (plan kerf-power-curve-presets, Design 5, G1-G13).
 *
 * Exercised through the production MachinePanel Generate handler and the
 * production JobActionBar, on real store state. The invoke mock dispatches by
 * command name: it answers the mount plumbing (list_serial_ports) and holds
 * the two generation commands as deferred promises the test resolves; any
 * other command goes to an unknown-command ledger (asserted empty after every
 * test) and throws. serial_job_begin / serial_stream_job are deliberately
 * unanswered, so a START or FRAME dispatch would land in the ledger.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../../app/store";
import type { AppState } from "../../../app/store";
import type { DesignObject } from "../../../app/types";
import { DEFAULT_LAYERS } from "../../../app/types";
import {
  GENERATION_INPUT_KEYS,
  inputsChanged,
  selectGenerationInputs,
} from "../../../app/store/generationInputs";
import type { GenerationInputKey } from "../../../app/store/generationInputs";
import { canStartJob } from "../../../lib/machine/canStartJob";
import { fileOperations, loadProjectWithMigrations } from "../../../lib/fileOps";
import { MachinePanel } from "../MachinePanel";
import { JobActionBar } from "../JobActionBar";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;
type GcodeResult = NonNullable<AppState["gcodeResult"]>;

// ---------------------------------------------------------------- invoke mock

interface Deferred {
  resolve: (v: GcodeResult) => void;
  reject: (e: unknown) => void;
}
const GEN_CMDS = ["generate_image_gcode", "generate_gcode"] as const;
type GenCmd = (typeof GEN_CMDS)[number];
let queues: Record<GenCmd, Deferred[]>;
let consumed: Record<GenCmd, number>;
let unknownLedger: string[];

function installInvoke() {
  queues = { generate_image_gcode: [], generate_gcode: [] };
  consumed = { generate_image_gcode: 0, generate_gcode: 0 };
  unknownLedger = [];
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_serial_ports") return Promise.resolve([]);
    if ((GEN_CMDS as readonly string[]).includes(cmd)) {
      return new Promise<GcodeResult>((resolve, reject) => {
        queues[cmd as GenCmd].push({ resolve, reject });
      });
    }
    unknownLedger.push(cmd);
    throw new Error(`unexpected invoke: ${cmd}`);
  });
}

/** Waits (bounded) for the next unconsumed call of `cmd`. Fails, never hangs. */
async function nextCall(cmd: GenCmd): Promise<Deferred> {
  const want = consumed[cmd] + 1;
  await waitFor(
    () => {
      if (queues[cmd].length < want) throw new Error(`${cmd} call #${want} never arrived`);
    },
    { timeout: 2000 }
  );
  consumed[cmd] = want;
  return queues[cmd][want - 1];
}

function frag(tag = "", long = false): GcodeResult {
  return {
    gcode: `G1 X10 Y20 ; ${tag}`,
    moves: [{ x: 10, y: 20, moveType: "cut", speed: 100, power: 50 }],
    totalDistance: 1,
    cutDistance: 1,
    travelDistance: 0,
    estimatedTimeSecs: long ? 2000 : 1,
    lineCount: 1,
  };
}

/** Release one full generation; `mutate` runs while the named call is pending. */
async function runGeneration(
  variant: "raster-wait" | "vector-wait",
  mutate: () => void = () => {},
  opts: { tag?: string; long?: boolean } = {}
) {
  const img = await nextCall("generate_image_gcode");
  if (variant === "raster-wait") act(() => mutate());
  await act(async () => img.resolve(frag(opts.tag, opts.long)));
  const vec = await nextCall("generate_gcode");
  if (variant === "vector-wait") act(() => mutate());
  await act(async () => vec.resolve(frag(opts.tag, opts.long)));
}

// ---------------------------------------------------------------- fake Image

/** getImageContentRatio's Image: onerror resolves the ratio to 0 (sparse). */
let imageMode: "auto" | "deferred";
let pendingImages: FakeImage[];
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    if (imageMode === "auto") queueMicrotask(() => this.onerror?.());
    else pendingImages.push(this);
  }
}

// ---------------------------------------------------------------- seeding

const IMG_DATA = "data:image/png;base64,iVBORw0KGgo=";

function makeImage(id: string): DesignObject {
  return {
    id,
    type: "image",
    name: `Image ${id}`,
    transform: { x: 10, y: 10, width: 40, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0, // Engrave (fill)
    visible: true,
    locked: false,
    fill: null,
    stroke: null,
    strokeWidth: 0,
    opacity: 1,
    imageData: IMG_DATA,
  } as DesignObject;
}

function makeRect(id: string): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x: 60, y: 10, width: 20, height: 15, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 1, // Score (line)
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

function seed() {
  const objects = [makeImage("img1"), makeRect("r1")];
  useStore.setState({
    objects,
    objectsById: new Map(objects.map((o) => [o.id, o])),
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
    originTop: false,
    startCorner: "bottomLeft",
    grblSValueMax: 1000,
    grblAccelX: 500,
    grblAccelY: 500,
    grblMaxFeedRateX: 0,
    grblMaxFeedRateY: 0,
    workspaceVerified: true,
    grblLaserMode: true,
    statusStale: false,
    isDirty: false,
  });
}

function renderPanel() {
  return render(
    <>
      <MachinePanel />
      <JobActionBar />
    </>
  );
}

/** Seeds a current result through the production publish action. */
function seedCurrent(tag = "seed"): GcodeResult {
  const s = useStore.getState();
  const r = frag(tag);
  expect(s.publishGeneration(s.beginGeneration(), r)).toBe("published");
  return r;
}

function lines(): string[] {
  return useStore.getState().consoleLines.map((l) => l.text);
}

const STALE = "Design changed -- regenerate G-code";
const NONE = "Generate G-code first";
const STALE_LINE =
  "G-code generated, but the design or machine settings changed while it ran. Regenerate before START.";
const SKIP_LINE =
  "Skipped the sparse-image check: the project changed or a newer generation started";
const SPARSE_TEXT = /This image is mostly empty space/;

function expectRefused(getByText: (t: string) => HTMLElement, reason: string) {
  const start = getByText("START") as HTMLButtonElement;
  const frame = getByText("FRAME") as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  expect(start.title).toBe(reason);
  expect(frame.disabled).toBe(true);
  expect(frame.title).toBe(reason);
  fireEvent.click(start);
  fireEvent.click(frame);
  const cmds = mockInvoke.mock.calls.map((c) => c[0]);
  expect(cmds).not.toContain("serial_job_begin");
  expect(cmds).not.toContain("serial_stream_job");
  expect(cmds).toContain("list_serial_ports"); // positive sibling: the ledger saw calls
  expect(canStartJob(useStore.getState()).reason).toBe(reason);
}

async function waitIdle(q: (t: string) => HTMLElement | null) {
  await waitFor(() => expect(q("Generating...")).toBeNull(), { timeout: 2000 });
}

function bProject() {
  const p = useStore.getState().toProject();
  return { ...p, name: "B", objects: [] };
}

function replaceWithOpen() {
  expect(loadProjectWithMigrations(bProject())).toBe(true);
}
async function replaceWithNew() {
  useStore.setState({ isDirty: false });
  await fileOperations.newProject();
}

beforeEach(() => {
  cleanup();
  mockInvoke.mockReset();
  localStorage.clear();
  installInvoke();
  imageMode = "auto";
  pendingImages = [];
  vi.stubGlobal("Image", FakeImage);
  seed();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(unknownLedger).toEqual([]);
});

// ---------------------------------------------------------------- G1

describe.each(["raster-wait", "vector-wait"] as const)("G1/G2/G4 (%s)", (variant) => {
  it("G1: a curve Apply in flight with no prior result publishes stale", async () => {
    const { getByText, queryByText } = renderPanel();
    fireEvent.click(getByText("Generate G-code"));
    await runGeneration(variant, () =>
      useStore.getState().updateLayer(0, {
        powerCurve: [
          { x: 0, y: 100 },
          { x: 255, y: 0 },
        ],
      })
    );
    await waitIdle(queryByText);
    expect(useStore.getState().gcodeResult).not.toBeNull();
    expect(useStore.getState().gcodeStale).toBe(true);
    expect(lines()).toContain(STALE_LINE);
    expectRefused(getByText, STALE);
  });

  it("G2: with an existing result, the edit stales at once and the new result publishes stale", async () => {
    const prev = seedCurrent();
    const { getByText, queryByText } = renderPanel();
    fireEvent.click(getByText("Generate G-code"));
    await runGeneration(variant, () => {
      useStore.getState().updateLayer(0, { power: 42 });
      expect(useStore.getState().gcodeStale).toBe(true);
    });
    await waitIdle(queryByText);
    const s = useStore.getState();
    expect(s.gcodeResult).not.toBe(prev);
    expect(s.gcodeResult).not.toBeNull();
    expect(s.gcodeStale).toBe(true);
    expectRefused(getByText, STALE);
  });

  it.each([false, true])(
    "G4: power scale changed in flight publishes stale (prior result: %s)",
    async (prior) => {
      if (prior) seedCurrent();
      const { getByText, queryByText } = renderPanel();
      fireEvent.click(getByText("Generate G-code"));
      await runGeneration(variant, () => useStore.getState().setGrblSValueMax(255));
      await waitIdle(queryByText);
      expect(useStore.getState().gcodeStale).toBe(true);
      expect(lines()).toContain(STALE_LINE);
      expectRefused(getByText, STALE);
    }
  );
});

// ---------------------------------------------------------------- G3

describe("G3: project replaced in flight", () => {
  it.each([
    ["Open", "empty"],
    ["Open", "current"],
    ["New", "empty"],
    ["New", "current"],
  ] as const)("%s with A's slot %s: discarded-project", async (how, slot) => {
    if (slot === "current") seedCurrent();
    const { getByText, queryByText } = renderPanel();
    fireEvent.click(getByText("Generate G-code"));
    const epoch0 = useStore.getState().projectEpoch;
    const img = await nextCall("generate_image_gcode");
    if (how === "Open") act(() => replaceWithOpen());
    else await act(async () => replaceWithNew());
    expect(useStore.getState().projectEpoch).toBe(epoch0 + 1);
    await act(async () => img.resolve(frag("A")));
    const vec = await nextCall("generate_gcode");
    await act(async () => vec.resolve(frag("A")));
    await waitIdle(queryByText);
    expect(useStore.getState().gcodeResult).toBeNull();
    expect(useStore.getState().gcodeStale).toBe(false);
    expect(
      lines().some((t) =>
        t.startsWith("Discarded a G-code generation started in a different project")
      )
    ).toBe(true);
    expect(useStore.getState().projectEpoch).toBe(epoch0 + 1);
    expect((getByText("START") as HTMLButtonElement).title).toBe(NONE);
    expect((getByText("START") as HTMLButtonElement).disabled).toBe(true);
  });
});

// ---------------------------------------------------------------- G5

interface Row {
  name: string;
  keys: GenerationInputKey[];
  change: () => void;
  noop?: () => void;
}
const ROWS: Row[] = [
  {
    name: "updateObject",
    keys: ["objects"],
    change: () =>
      useStore.getState().updateObject("r1", {
        transform: { x: 70, y: 10, width: 20, height: 15, rotation: 0, scaleX: 1, scaleY: 1 },
      }),
  },
  {
    name: "updateLayer",
    keys: ["layers"],
    change: () => useStore.getState().updateLayer(1, { power: 33 }),
  },
  {
    name: "setWorkspaceSize",
    keys: ["workspaceWidth", "workspaceHeight"],
    change: () => useStore.getState().setWorkspaceSize(600, 400),
    noop: () => useStore.getState().setWorkspaceSize(500, 300),
  },
  {
    name: "setOriginTop",
    keys: ["originTop"],
    change: () => useStore.getState().setOriginTop(true),
  },
  {
    name: "setStartCorner",
    keys: ["startCorner"],
    change: () => useStore.getState().setStartCorner("topRight"),
  },
  {
    name: "setGrblSValueMax",
    keys: ["grblSValueMax"],
    change: () => useStore.getState().setGrblSValueMax(255),
    noop: () => useStore.getState().setGrblSValueMax(1000),
  },
  {
    name: "setGrblLaserMode",
    keys: ["grblLaserMode"],
    change: () => useStore.getState().setGrblLaserMode(false),
    noop: () => useStore.getState().setGrblLaserMode(true),
  },
  {
    name: "setGrblAccel",
    keys: ["grblAccelX", "grblAccelY"],
    change: () => useStore.getState().setGrblAccel(800, 900),
    noop: () => useStore.getState().setGrblAccel(500, 500),
  },
  {
    name: "setGrblMaxFeedRate",
    keys: ["grblMaxFeedRateX", "grblMaxFeedRateY"],
    change: () => useStore.getState().setGrblMaxFeedRate(6000, 6000),
    noop: () => useStore.getState().setGrblMaxFeedRate(0, 0),
  },
];

describe("G5: every generation input, both phases", () => {
  it("meta: the rows cover GENERATION_INPUT_KEYS exactly", () => {
    const union = new Set(ROWS.flatMap((r) => r.keys));
    expect([...union].sort()).toEqual([...GENERATION_INPUT_KEYS].sort());
  });

  it.each(ROWS.map((r) => [r.name, r] as const))(
    "%s: each row's action changes its keys",
    (_n, row) => {
      const before = selectGenerationInputs(useStore.getState());
      row.change();
      const after = selectGenerationInputs(useStore.getState());
      for (const k of row.keys) expect(Object.is(before[k], after[k])).toBe(false);
    }
  );

  it.each(ROWS.map((r) => [r.name, r] as const))(
    "%s in flight: published-stale",
    async (_n, row) => {
      const { getByText, queryByText } = renderPanel();
      fireEvent.click(getByText("Generate G-code"));
      await runGeneration("raster-wait", row.change);
      await waitIdle(queryByText);
      expect(useStore.getState().gcodeResult).not.toBeNull();
      expect(useStore.getState().gcodeStale).toBe(true);
      expect(lines()).toContain(STALE_LINE);
    }
  );

  it.each(ROWS.map((r) => [r.name, r] as const))(
    "%s after publication: stales and START refuses",
    (_n, row) => {
      const { getByText } = renderPanel();
      act(() => {
        seedCurrent();
      });
      expect(useStore.getState().gcodeStale).toBe(false);
      act(() => row.change());
      expect(useStore.getState().gcodeStale).toBe(true);
      if (row.name === "setGrblLaserMode") {
        // Laser mode off is refused first; the stale reason must stand on its own.
        expect(canStartJob({ ...useStore.getState(), grblLaserMode: true }).reason).toBe(STALE);
      } else {
        expectRefused(getByText, STALE);
      }
    }
  );

  it.each(ROWS.filter((r) => r.noop).map((r) => [r.name, r] as const))(
    "%s no-op control: the same value leaves a current result current",
    (_n, row) => {
      seedCurrent();
      row.noop!();
      expect(useStore.getState().gcodeStale).toBe(false);
    }
  );
});

// ---------------------------------------------------------------- G6

describe("G6: supersession across a remount", () => {
  async function startAThenB() {
    const first = renderPanel();
    fireEvent.click(first.getByText("Generate G-code"));
    const aImg = await nextCall("generate_image_gcode");
    first.unmount();
    const second = renderPanel();
    const btn = second.getByText("Generate G-code") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    const bImg = await nextCall("generate_image_gcode");
    return { second, aImg, bImg };
  }

  it("A resolves first: discarded-superseded, B still busy, then B publishes current", async () => {
    const seq0 = useStore.getState().generationSeq;
    const { second, aImg, bImg } = await startAThenB();
    await act(async () => aImg.resolve(frag("A")));
    const aVec = await nextCall("generate_gcode");
    await act(async () => aVec.resolve(frag("A")));
    await waitFor(() =>
      expect(
        lines().some((t) => t.startsWith("Discarded an earlier G-code generation: a newer one"))
      ).toBe(true)
    );
    expect(useStore.getState().gcodeResult).toBeNull();
    expect(second.getByText("Generating...")).toBeTruthy();
    await act(async () => bImg.resolve(frag("B")));
    const bVec = await nextCall("generate_gcode");
    await act(async () => bVec.resolve(frag("B")));
    await waitIdle(second.queryByText);
    expect(useStore.getState().gcodeResult!.gcode).toContain("; B");
    expect(useStore.getState().gcodeStale).toBe(false);
    expect(useStore.getState().generationSeq).toBe(seq0 + 2);
  });

  it("B resolves first: published current, then A is discarded and does not overwrite", async () => {
    const seq0 = useStore.getState().generationSeq;
    const { second, aImg, bImg } = await startAThenB();
    await act(async () => bImg.resolve(frag("B")));
    // A's raster call is still held, so the next vector call is B's.
    const bVec = await nextCall("generate_gcode");
    await act(async () => bVec.resolve(frag("B")));
    await waitIdle(second.queryByText);
    expect(useStore.getState().gcodeResult!.gcode).toContain("; B");
    await act(async () => aImg.resolve(frag("A")));
    const aVec = await nextCall("generate_gcode");
    await act(async () => aVec.resolve(frag("A")));
    await waitFor(() =>
      expect(lines().some((t) => t.startsWith("Discarded an earlier G-code generation"))).toBe(true)
    );
    expect(useStore.getState().gcodeResult!.gcode).toContain("; B");
    expect(useStore.getState().gcodeResult!.gcode).not.toContain("; A");
    expect(useStore.getState().gcodeStale).toBe(false);
    expect(useStore.getState().generationSeq).toBe(seq0 + 2);
  });
});

// ---------------------------------------------------------------- G7

describe("G7: identities are never reused", () => {
  it("loads do not reset the sequence; the epoch counts loads", () => {
    const s = useStore.getState;
    const t1 = s().beginGeneration();
    s().loadProject(bProject());
    s().loadProject(bProject());
    const t2 = s().beginGeneration();
    expect(t2.seq).toBe(t1.seq + 1);
    expect(t2.epoch).toBe(t1.epoch + 2);
    expect(s().publishGeneration(t1, frag())).toBe("discarded-project");
    const t3 = s().beginGeneration();
    const t4 = s().beginGeneration();
    expect(s().publishGeneration(t3, frag())).toBe("discarded-superseded");
    expect(s().publishGeneration(t4, frag())).toBe("published");
  });
});

// ---------------------------------------------------------------- G8

describe("G8: positive controls", () => {
  it("no edit: published current and START admitted", async () => {
    const { getByText, queryByText } = renderPanel();
    fireEvent.click(getByText("Generate G-code"));
    await runGeneration("raster-wait");
    await waitIdle(queryByText);
    expect(useStore.getState().gcodeResult).not.toBeNull();
    expect(useStore.getState().gcodeStale).toBe(false);
    expect((getByText("START") as HTMLButtonElement).disabled).toBe(false);
    expect(canStartJob(useStore.getState()).ok).toBe(true);
  });

  it("one setState writing a result together with new objects leaves it current", () => {
    seedCurrent();
    useStore.setState({ gcodeResult: frag("seeded"), objects: [makeRect("r9")] });
    expect(useStore.getState().gcodeStale).toBe(false);
  });

  it("a current failure: error line, status message, result untouched, Preview not opened", async () => {
    const { getByText, queryByText } = renderPanel();
    fireEvent.click(getByText("Preview"));
    const img = await nextCall("generate_image_gcode");
    await act(async () => img.reject(new Error("engine exploded")));
    await waitIdle(queryByText);
    expect(lines().some((t) => t.startsWith("G-code generation failed: "))).toBe(true);
    expect(useStore.getState().statusMessage).toBe("G-code generation failed — see console");
    expect(useStore.getState().gcodeResult).toBeNull();
    expect(useStore.getState().previewVisible).toBe(false);
  });
});

// ---------------------------------------------------------------- G9

describe("G9: a discarded call does nothing else", () => {
  const B1 = /GRBL laser mode \(\$32\) is disabled/;

  it("discarded-project: one console line, no status, no sparse warning, no Preview", async () => {
    useStore.setState({ grblLaserMode: false });
    const { getByText, queryByText } = renderPanel();
    fireEvent.click(getByText("Preview"));
    const img = await nextCall("generate_image_gcode");
    act(() => replaceWithOpen());
    const before = lines().length;
    await act(async () => img.resolve(frag("A", true)));
    const vec = await nextCall("generate_gcode");
    await act(async () => vec.resolve(frag("A", true)));
    await waitIdle(queryByText);
    const added = lines().slice(before);
    expect(added).toEqual([
      "Discarded a G-code generation started in a different project (1 generator messages dropped with it)",
    ]);
    expect(lines().some((t) => B1.test(t))).toBe(false);
    expect(useStore.getState().statusMessage).toBeNull();
    expect(queryByText(SPARSE_TEXT)).toBeNull();
    expect(useStore.getState().previewVisible).toBe(false);
  });

  it("discarded-superseded: one console line, no status, no sparse warning, no Preview", async () => {
    useStore.setState({ grblLaserMode: false });
    const first = renderPanel();
    fireEvent.click(first.getByText("Preview"));
    const aImg = await nextCall("generate_image_gcode");
    first.unmount();
    const second = renderPanel();
    fireEvent.click(second.getByText("Generate G-code"));
    const bImg = await nextCall("generate_image_gcode");
    const before = lines().length;
    await act(async () => aImg.resolve(frag("A", true)));
    const aVec = await nextCall("generate_gcode");
    await act(async () => aVec.resolve(frag("A", true)));
    await waitFor(() => expect(lines().length).toBe(before + 1));
    expect(lines().slice(before)).toEqual([
      "Discarded an earlier G-code generation: a newer one was started (1 generator messages dropped with it)",
    ]);
    expect(lines().some((t) => B1.test(t))).toBe(false);
    expect(useStore.getState().statusMessage).toBeNull();
    expect(second.queryByText(SPARSE_TEXT)).toBeNull();
    expect(useStore.getState().previewVisible).toBe(false);
    await act(async () => bImg.resolve(frag("B")));
    const bVec = await nextCall("generate_gcode");
    await act(async () => bVec.resolve(frag("B")));
    await waitIdle(second.queryByText);
  });

  it("control: the same run, published, shows the B1 warning then the info line", async () => {
    useStore.setState({ grblLaserMode: false });
    const { getByText, queryByText } = renderPanel();
    fireEvent.click(getByText("Generate G-code"));
    const before = lines().length;
    await runGeneration("raster-wait");
    await waitIdle(queryByText);
    const added = lines().slice(before);
    expect(added.length).toBe(2);
    expect(B1.test(added[0])).toBe(true);
    expect(added[1].startsWith("G-code generated: ")).toBe(true);
  });
});

// ---------------------------------------------------------------- G11

describe("G11: invalidation during the sparse-image analysis", () => {
  async function publishLongViaPreview() {
    imageMode = "deferred";
    const r = renderPanel();
    fireEvent.click(r.getByText("Preview"));
    await runGeneration("raster-wait", () => {}, { long: true });
    await waitFor(() => expect(pendingImages.length).toBe(1));
    expect(useStore.getState().gcodeStale).toBe(false);
    expect(useStore.getState().gcodeResult).not.toBeNull();
    return r;
  }

  it("(a) project replaced: no warning, skip line, Preview not opened", async () => {
    const { queryByText } = await publishLongViaPreview();
    act(() => replaceWithOpen());
    await act(async () => pendingImages[0].onerror!());
    await waitIdle(queryByText);
    await waitFor(() => expect(lines()).toContain(SKIP_LINE));
    expect(queryByText(SPARSE_TEXT)).toBeNull();
    expect(useStore.getState().previewVisible).toBe(false);
  });

  it("(b) remount and a newer generation: the same, and the newer one is unaffected", async () => {
    const first = await publishLongViaPreview();
    first.unmount();
    const second = renderPanel();
    fireEvent.click(second.getByText("Generate G-code"));
    // B's ticket is taken synchronously on click, so A is no longer current.
    await act(async () => pendingImages[0].onerror!());
    await waitFor(() => expect(lines()).toContain(SKIP_LINE));
    expect(useStore.getState().previewVisible).toBe(false);
    await runGeneration("raster-wait", () => {}, { tag: "B" });
    await waitIdle(second.queryByText);
    expect(useStore.getState().gcodeResult!.gcode).toContain("; B");
    expect(useStore.getState().gcodeStale).toBe(false);
    expect(second.queryByText(SPARSE_TEXT)).toBeNull();
    expect(useStore.getState().previewVisible).toBe(false);
  });

  it("control: no invalidation shows the warning and opens Preview", async () => {
    const { queryByText } = await publishLongViaPreview();
    await act(async () => pendingImages[0].onerror!());
    await waitIdle(queryByText);
    await waitFor(() => expect(queryByText(SPARSE_TEXT)).not.toBeNull());
    expect(useStore.getState().previewVisible).toBe(true);
    expect(lines()).not.toContain(SKIP_LINE);
  });
});

// ---------------------------------------------------------------- G12

describe("G12: subscription ordering", () => {
  it("no listener ever sees a current-looking result built from other inputs", () => {
    const s = useStore.getState();
    const ticket = s.beginGeneration();
    expect(s.publishGeneration(ticket, frag())).toBe("published");
    const seen: Array<{ bad: boolean }> = [];
    const unsub = useStore.subscribe((state) => {
      seen.push({
        bad:
          state.gcodeResult !== null &&
          inputsChanged(ticket.inputs, selectGenerationInputs(state)) &&
          !state.gcodeStale,
      });
    });
    useStore.getState().setGrblAccel(1234, 1234);
    unsub();
    expect(useStore.getState().gcodeStale).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((n) => n.bad)).toEqual([]);
  });
});

// ---------------------------------------------------------------- G13

describe("G13: an obsolete call fails quietly", () => {
  const CONTEXT =
    "G-code generation failed (an earlier generation, superseded or from a different project): ";

  it("project replaced: context line, result untouched, no status", async () => {
    const { getByText, queryByText } = renderPanel();
    fireEvent.click(getByText("Generate G-code"));
    const img = await nextCall("generate_image_gcode");
    act(() => replaceWithOpen());
    await act(async () => img.reject(new Error("engine exploded")));
    await waitIdle(queryByText);
    expect(lines().some((t) => t.startsWith(CONTEXT))).toBe(true);
    expect(lines().some((t) => t.startsWith("G-code generation failed: "))).toBe(false);
    expect(useStore.getState().gcodeResult).toBeNull();
    expect(useStore.getState().statusMessage).toBeNull();
  });

  it("superseded: context line, no status, the current generation's display unchanged", async () => {
    const first = renderPanel();
    fireEvent.click(first.getByText("Generate G-code"));
    const aImg = await nextCall("generate_image_gcode");
    first.unmount();
    const second = renderPanel();
    fireEvent.click(second.getByText("Generate G-code"));
    const bImg = await nextCall("generate_image_gcode");
    await act(async () => aImg.reject(new Error("engine exploded")));
    await waitFor(() => expect(lines().some((t) => t.startsWith(CONTEXT))).toBe(true));
    expect(useStore.getState().statusMessage).toBeNull();
    expect(second.getByText("Generating...")).toBeTruthy();
    await act(async () => bImg.resolve(frag("B")));
    const bVec = await nextCall("generate_gcode");
    await act(async () => bVec.resolve(frag("B")));
    await waitIdle(second.queryByText);
    expect(useStore.getState().gcodeResult!.gcode).toContain("; B");
    expect(useStore.getState().statusMessage).toBeNull();
  });
});

// ---------------------------------------------------------------- G10

describe("G10: the input and write boundaries", () => {
  const ROOT = process.cwd();

  it("G10b: gcodeGen.ts touches useStore only on the four allowlisted lines", () => {
    const src = readFileSync(join(ROOT, "src/lib/machine/gcodeGen.ts"), "utf8");
    const allowed = [
      'import { useStore } from "../../app/store";',
      "inputs: GenerationInputs = selectGenerationInputs(useStore.getState()),",
      "log: GenerationLog = (msg, level) => useStore.getState().addConsoleLine(msg, level)",
      "const store = useStore.getState();",
    ];
    const hits = src
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("useStore"));
    for (const h of hits) {
      expect(
        allowed,
        `new store access in gcodeGen.ts: "${h}". Add the field to GENERATION_INPUT_KEYS or pass it in.`
      ).toContain(h);
    }
    expect(hits.length).toBe(4);
    expect([...hits].sort()).toEqual([...allowed].sort());
  });

  function productionFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "__tests__") continue;
        out.push(...productionFiles(p));
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
        out.push(p);
      }
    }
    return out;
  }

  it("G10c: no production setState except the raiser; gcodeResult written at three store sites", () => {
    const files = productionFiles(join(ROOT, "src"));
    expect(files.length).toBeGreaterThan(50);
    const setStateHits: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((l) => {
          if (l.includes("useStore.setState")) setStateHits.push(`${f}: ${l.trim()}`);
        });
    }
    // The one exception: the structural raiser in store/index.ts writes only gcodeStale.
    expect(setStateHits).toEqual([
      `${join(ROOT, "src/app/store/index.ts")}: useStore.setState({ gcodeStale: true });`,
    ]);

    const storeFiles = files.filter(
      (f) => f.startsWith(join(ROOT, "src/app/store/")) && !f.endsWith("storeTypes.ts")
    );
    const writes: string[] = [];
    for (const f of storeFiles) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((l) => {
          if (/(^|[^.\w])gcodeResult\s*:/.test(l)) writes.push(`${f}: ${l.trim()}`);
        });
    }
    const idx = join(ROOT, "src/app/store/index.ts");
    expect(writes).toEqual([
      `${idx}: gcodeResult: null,`,
      `${idx}: gcodeResult: null,`,
      `${idx}: set({ gcodeResult: result, gcodeStale: stale });`,
    ]);
  });
});
