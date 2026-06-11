/**
 * F15 — pure START gate + moves-extents/Frame helpers.
 *
 * The Frame tests pin the COORDINATE FRAME contract: moves[] is already
 * machine-frame, so frame targets equal the raw extents with NO Y transform
 * (the old design→machine `workspaceHeight - y` flip is deleted, not ported).
 */
import { describe, it, expect } from "vitest";
import { canStartJob, movesExtents, frameTargets, type JobGateState } from "../canStartJob";

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
