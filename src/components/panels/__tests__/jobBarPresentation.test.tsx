/**
 * A7 — JobActionBar presentation. Pure helpers over the full state product,
 * then the PRODUCTION component with machine state injected through the store
 * (serial is Tauri-only).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { render, cleanup } from "@testing-library/react";
import { useStore } from "../../../app/store";
import type { AppState } from "../../../app/store";
import type { DesignObject } from "../../../app/types";
import { DEFAULT_LAYERS } from "../../../app/types";
import { canStartJob } from "../../../lib/machine/canStartJob";
import { JobActionBar } from "../JobActionBar";
import {
  stopPresentation,
  refusalLine,
  progressText,
  progressFill,
  exclusionCaption,
  STOP_TITLE,
  DOOR_LINE,
  type StoredMachineState,
} from "../jobBarPresentation";

const STATES: StoredMachineState[] = ["idle", "run", "hold", "alarm", "door", "disconnected"];

function gcode(): NonNullable<AppState["gcodeResult"]> {
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

function seed(patch: Partial<AppState> = {}) {
  useStore.setState({
    objects: [],
    layers: DEFAULT_LAYERS,
    consoleLines: [],
    machineConnected: true,
    machineState: "idle",
    jobRunning: false,
    jobProgress: 0,
    gcodeResult: gcode(),
    gcodeStale: false,
    workspaceWidth: 500,
    workspaceHeight: 300,
    originTop: false,
    workspaceVerified: true,
    grblLaserMode: true,
    statusStale: false,
    ...patch,
  });
}

function path(id: string, layerIndex: number): DesignObject {
  return {
    id,
    type: "path",
    name: id,
    transform: { x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#000",
    strokeWidth: 1,
    opacity: 1,
  };
}

function stopButton(container: HTMLElement): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll("button")).find((x) => x.textContent === "STOP");
  if (!b) throw new Error("no STOP");
  return b as HTMLButtonElement;
}

describe("stopPresentation over connected x job x state x stale", () => {
  for (const machineConnected of [false, true])
    for (const jobRunning of [false, true])
      for (const machineState of STATES)
        for (const statusStale of [false, true]) {
          const name = `connected=${machineConnected} job=${jobRunning} ${machineState} stale=${statusStale}`;
          it(name, () => {
            const p = stopPresentation({ machineConnected, jobRunning, machineState, statusStale });
            const disabled = !machineConnected; // JobActionBar's own disabled expression
            expect(p.style.opacity < 1).toBe(disabled);
            expect(p.style.cursor).toBe(disabled ? "not-allowed" : "pointer");
            if (disabled) expect(p.variant).toBe("disabled");
            else if (!jobRunning && machineState === "idle" && !statusStale)
              expect(p.variant).toBe("outline");
            else expect(p.variant).toBe("solid");
          });
        }

  it("outline and solid sizes and fills", () => {
    const o = stopPresentation({
      machineConnected: true,
      jobRunning: false,
      machineState: "idle",
      statusStale: false,
    });
    expect(o.style).toMatchObject({
      background: "transparent",
      border: "1px solid var(--danger-text)",
      color: "var(--danger-text)",
      fontSize: "var(--text-md)",
      fontWeight: 700,
      flex: "1",
      minWidth: "72px",
      height: "32px",
    });
    const s = stopPresentation({
      machineConnected: true,
      jobRunning: true,
      machineState: "run",
      statusStale: false,
    });
    expect(s.style).toMatchObject({
      background: "var(--danger-strong)",
      color: "#fff",
      fontWeight: 700,
      flex: "2",
      minWidth: "120px",
      height: "40px",
    });
  });
});

describe("refusalLine / progressText / progressFill / exclusionCaption", () => {
  it("refusal is the gate reason verbatim, only when refused and no job", () => {
    expect(refusalLine({ ok: false, reason: "Generate G-code first" }, false)).toBe(
      "Generate G-code first"
    );
    expect(refusalLine({ ok: false, reason: "Generate G-code first" }, true)).toBeNull();
    expect(refusalLine({ ok: true }, false)).toBeNull();
  });

  it("progress shows remaining only past 1%", () => {
    expect(progressText(6, 0.01)).toEqual({ elapsed: "0:06", remaining: null, percent: "1%" });
    expect(progressText(6, 0.42)).toEqual({ elapsed: "0:06", remaining: "0:08", percent: "42%" });
    expect(progressText(75, 0.5)).toEqual({ elapsed: "1:15", remaining: "1:15", percent: "50%" });
  });

  it("fill is amber for hold and door, blue otherwise", () => {
    for (const st of STATES)
      expect(progressFill(st)).toBe(
        st === "hold" || st === "door" ? "var(--warning)" : "var(--accent)"
      );
  });

  it("caption lists each excluded layer with its reason", () => {
    expect(
      exclusionCaption([
        { name: "Score", reason: "output off" },
        { name: "Custom 4", reason: "hidden" },
      ])
    ).toBe("Not in the G-code: Score (output off), Custom 4 (hidden)");
    expect(exclusionCaption([])).toBeNull();
  });
});

describe("JobActionBar (production component, state injected)", () => {
  beforeEach(() => {
    cleanup();
    seed();
  });
  afterEach(() => cleanup());

  it("STOP's DOM disabled and drawn opacity agree in every injected state", () => {
    for (const machineConnected of [false, true])
      for (const jobRunning of [false, true])
        for (const machineState of STATES)
          for (const statusStale of [false, true]) {
            cleanup();
            seed({ machineConnected, jobRunning, machineState, statusStale });
            const { container } = render(<JobActionBar />);
            const b = stopButton(container);
            expect(b.disabled).toBe(!machineConnected);
            expect(Number(getComputedStyle(b).opacity) < 1).toBe(b.disabled);
          }
  });

  it("STOP carries its exact title", () => {
    const { container } = render(<JobActionBar />);
    expect(stopButton(container).getAttribute("title")).toBe(STOP_TITLE);
    expect(STOP_TITLE).toBe(
      "Sends a controller reset (0x18). Keep the machine's own emergency stop within reach."
    );
  });

  const refusals: Array<[string, Partial<AppState>]> = [
    ["not connected", { machineConnected: false }],
    ["stale status", { statusStale: true }],
    ["laser mode off", { grblLaserMode: false }],
    ["alarm", { machineState: "alarm" }],
    ["hold", { machineState: "hold" }],
    ["door", { machineState: "door" }],
    ["no gcode", { gcodeResult: null }],
    ["stale gcode", { gcodeStale: true }],
    ["bed unconfirmed", { workspaceVerified: false }],
    ["no moves", { gcodeResult: { ...gcode(), moves: [] } }],
    ["out of bounds", { workspaceWidth: 20 }],
  ];
  for (const [label, patch] of refusals) {
    it(`refusal line shows the gate reason when idle: ${label}`, () => {
      seed(patch);
      const reason = canStartJob(useStore.getState()).reason;
      expect(reason).toBeTruthy();
      const { getByTestId } = render(<JobActionBar />);
      const line = getByTestId("job-refusal");
      expect(line.getAttribute("role")).toBe("status");
      expect(line.textContent).toBe(reason);
    });
  }

  it("no refusal line when START can act, nor while a job runs", () => {
    const { queryByTestId, rerender } = render(<JobActionBar />);
    expect(queryByTestId("job-refusal")).toBeNull();
    seed({ jobRunning: true, machineState: "run" });
    rerender(<JobActionBar />);
    expect(queryByTestId("job-refusal")).toBeNull();
  });

  it("door line has the exact text while a job runs in door, and only then", () => {
    seed({ jobRunning: true, machineState: "door", jobProgress: 0.3 });
    const { getByText, queryByText, rerender } = render(<JobActionBar />);
    expect(getByText(DOOR_LINE).textContent).toBe("Controller reports Door. STOP ends the job.");
    seed({ jobRunning: true, machineState: "hold", jobProgress: 0.3 });
    rerender(<JobActionBar />);
    expect(queryByText(DOOR_LINE)).toBeNull();
    seed({ jobRunning: false, machineState: "door" });
    rerender(<JobActionBar />);
    expect(queryByText(DOOR_LINE)).toBeNull();
  });

  it("progress row reads elapsed, about remaining left, and percent", () => {
    seed({ jobRunning: true, machineState: "run", jobProgress: 0.42 });
    const { getByTestId } = render(<JobActionBar />);
    expect(getByTestId("job-progress-time").textContent).toBe("0:00 · about 0:00 left");
    expect(getByTestId("job-progress-percent").textContent).toBe("42%");
    expect(getByTestId("job-progress-fill").style.background).toBe("var(--accent)");
  });

  it("hold fills the bar amber", () => {
    seed({ jobRunning: true, machineState: "hold", jobProgress: 0.005 });
    const { getByTestId } = render(<JobActionBar />);
    expect(getByTestId("job-progress-time").textContent).toBe("0:00");
    expect(getByTestId("job-progress-fill").style.background).toBe("var(--warning)");
  });

  it("caption names excluded layers holding objects, hidden while a job runs", () => {
    seed({
      layers: DEFAULT_LAYERS.map((l) =>
        l.index === 1 ? { ...l, output: false } : l.index === 3 ? { ...l, visible: false } : l
      ),
      objects: [path("a", 1), path("b", 3), path("c", 0)],
    });
    const { getByTestId, queryByTestId, rerender } = render(<JobActionBar />);
    expect(getByTestId("job-exclusion").textContent).toBe(
      "Not in the G-code: Score (output off), Custom 4 (hidden)"
    );
    // Same layers and objects, now running: the caption goes.
    useStore.setState({ jobRunning: true, machineState: "run" });
    rerender(<JobActionBar />);
    expect(queryByTestId("job-exclusion")).toBeNull();
  });

  it("START and FRAME shrink but stay rendered while a job runs", () => {
    seed({ jobRunning: true, machineState: "run" });
    const { getByText } = render(<JobActionBar />);
    for (const label of ["START", "FRAME"]) {
      const b = getByText(label) as HTMLButtonElement;
      expect(b.style.flex).toBe("0 0 56px");
      expect(b.disabled).toBe(true);
    }
  });
});
