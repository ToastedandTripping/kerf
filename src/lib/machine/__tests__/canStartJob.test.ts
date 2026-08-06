/**
 * F15 — pure START gate + moves-extents/Frame helpers.
 *
 * The Frame tests pin the COORDINATE FRAME contract: moves[] is already
 * machine-frame, so frame targets equal the raw extents with NO Y transform
 * (the old design→machine `workspaceHeight - y` flip is deleted, not ported).
 */
import { describe, it, expect } from "vitest";
import { canStartJob, movesExtents, frameTargets, gcodeExtents, type JobGateState } from "../canStartJob";

const MOVES = [
  { x: 10, y: 20 },
  { x: 50, y: 80 },
  { x: 30, y: 40 },
];

function okState(): JobGateState {
  return {
    machineConnected: true,
    jobRunning: false,
    gcodeResult: { moves: [...MOVES] },
    gcodeStale: false,
    workspaceWidth: 500,
    workspaceHeight: 300,
    // NOTE-1: workspaceVerified is now required and fail-closed (undefined blocks)
    workspaceVerified: true,
  };
}

describe("canStartJob", () => {
  it("passes when connected, idle, fresh G-code with in-bounds moves", () => {
    expect(canStartJob(okState())).toEqual({ ok: true });
  });

  it("blocks when disconnected", () => {
    const gate = canStartJob({ ...okState(), machineConnected: false });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("Machine not connected");
  });

  it("blocks when a job is already running", () => {
    const gate = canStartJob({ ...okState(), jobRunning: true });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("Job already running");
  });

  // P1-C: START/FRAME gate unification — START now requires idle too
  it("blocks when machineState is hold (gate unification)", () => {
    const gate = canStartJob({ ...okState(), machineState: "hold" });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("hold");
    expect(gate.reason).toContain("wait for idle");
  });

  it("blocks when machineState is run (gate unification)", () => {
    const gate = canStartJob({ ...okState(), machineState: "run" });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("run");
  });

  it("blocks when machineState is door (gate unification)", () => {
    const gate = canStartJob({ ...okState(), machineState: "door" });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("door");
  });

  it("blocks without generated G-code", () => {
    const gate = canStartJob({ ...okState(), gcodeResult: null });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("Generate G-code first");
  });

  it("blocks when G-code is stale, with the regenerate hint", () => {
    const gate = canStartJob({ ...okState(), gcodeStale: true });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("Design changed -- regenerate G-code");
  });

  it("blocks on EMPTY moves (reachable: text-only / output-off designs)", () => {
    // min/max over [] is ±Infinity — without this gate the bounds check passes
    // vacuously and Frame would send G0 XInfinity (GRBL error:33).
    const gate = canStartJob({ ...okState(), gcodeResult: { moves: [] } });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("Nothing to cut");
  });

  it("blocks when moves extend outside the workspace", () => {
    const below = canStartJob({
      ...okState(),
      gcodeResult: { moves: [{ x: -1, y: 10 }, { x: 50, y: 80 }] },
    });
    expect(below.ok).toBe(false);
    expect(below.reason).toContain("outside workspace bounds");

    const beyond = canStartJob({
      ...okState(),
      gcodeResult: { moves: [{ x: 10, y: 10 }, { x: 501, y: 80 }] },
    });
    expect(beyond.ok).toBe(false);

    const tall = canStartJob({
      ...okState(),
      gcodeResult: { moves: [{ x: 10, y: 10 }, { x: 50, y: 301 }] },
    });
    expect(tall.ok).toBe(false);
  });

  it("accepts moves exactly on the workspace boundary", () => {
    const gate = canStartJob({
      ...okState(),
      gcodeResult: { moves: [{ x: 0, y: 0 }, { x: 500, y: 300 }] },
    });
    expect(gate.ok).toBe(true);
  });
});

describe("movesExtents", () => {
  it("computes min/max over all moves", () => {
    expect(movesExtents(MOVES)).toEqual({ minX: 10, minY: 20, maxX: 50, maxY: 80 });
  });

  it("returns null for empty moves (never ±Infinity)", () => {
    expect(movesExtents([])).toBeNull();
  });
});

describe("frameTargets (machine-frame, no Y transform)", () => {
  it("traces the extents rectangle with RAW machine coordinates", () => {
    // With the old design→machine flip and a 300mm workspace these Ys would be
    // 280/220 — the contract is the raw 20/80.
    expect(frameTargets(MOVES)).toEqual([
      { x: 10, y: 20 },
      { x: 50, y: 20 },
      { x: 50, y: 80 },
      { x: 10, y: 80 },
      { x: 10, y: 20 },
    ]);
  });

  it("returns null for empty moves (Frame must no-op, not G0 XInfinity)", () => {
    expect(frameTargets([])).toBeNull();
  });
});

// P1-C: gcodeExtents — A5 material-test bounds helper
describe("gcodeExtents (G-code text to bounding box)", () => {
  it("extracts min/max from G0/G1 lines", () => {
    const gcode = [
      "; comment",
      "G21",
      "G90",
      "G0 X10 Y10",
      "G1 X50 Y20 F500 S100",
      "G1 X30 Y80 F500 S100",
      "M5",
    ].join("\n");
    expect(gcodeExtents(gcode)).toEqual({ minX: 10, minY: 10, maxX: 50, maxY: 80 });
  });

  it("handles X0 Y0 as valid coordinates (not skipped)", () => {
    const gcode = "G0 X0 Y0\nG1 X100 Y50 F500";
    expect(gcodeExtents(gcode)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
  });

  it("returns null for G-code with no coordinates (comment-only)", () => {
    expect(gcodeExtents("; comment only\n; another comment")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(gcodeExtents("")).toBeNull();
  });

  it("ignores comment lines starting with semicolon", () => {
    // The comment starts with ';' which the early-bail catches.
    // The regex would also reject it (doesn't start with G/X/Y/etc.).
    // This is defense-in-depth; the test documents the intent.
    const gcode = "; G0 X999 Y999\nG0 X10 Y10";
    const ext = gcodeExtents(gcode)!;
    expect(ext.maxX).toBe(10);
    expect(ext.maxY).toBe(10);
  });

  it("ignores non-motion G-code commands", () => {
    // M-codes, G21, G90 etc. should not contribute to extents
    const gcode = "G21\nG90\nM5\nG0 X10 Y10\nM2";
    const ext = gcodeExtents(gcode)!;
    expect(ext.minX).toBe(10);
    expect(ext.minY).toBe(10);
    expect(ext.maxX).toBe(10);
    expect(ext.maxY).toBe(10);
  });

  it("handles negative coordinates", () => {
    const gcode = "G0 X-5 Y-10\nG1 X20 Y30 F500";
    expect(gcodeExtents(gcode)).toEqual({ minX: -5, minY: -10, maxX: 20, maxY: 30 });
  });
});
