/**
 * S3: jog admission and clipping (pure). Drives the production functions only.
 * A jog is a nudge: it may shrink toward zero, never grow and never reverse.
 */
import { describe, it, expect } from "vitest";
import {
  JOG_REASON_ALARM,
  JOG_REASON_BED,
  JOG_REASON_BUSY,
  JOG_REASON_EDGE,
  JOG_REASON_JOB,
  JOG_REASON_NOT_CONNECTED,
  JOG_REASON_OFFSET,
  JOG_REASON_OUTSIDE,
  JOG_REASON_STALE,
  clipJog,
  jogBlockReason,
  jogEnvelope,
  targetInEnvelope,
  type JogGateState,
} from "../jogBounds";

describe("clipJog", () => {
  it("A3-1: origin-top, Y=-248.913, bed 250, -1 sends -1", () => {
    const r = clipJog({ axis: "Y", distance: -1, position: -248.913, bed: 250, originTop: true });
    expect(r).toEqual({ kind: "send", distance: -1 });
  });

  it("A3-2: origin-top, Y=-248.913, bed 250, -2 clips to -1.087 and is never positive", () => {
    const r = clipJog({ axis: "Y", distance: -2, position: -248.913, bed: 250, originTop: true });
    expect(r.kind).toBe("send");
    if (r.kind !== "send") return;
    expect(r.distance).toBeCloseTo(-1.087, 9);
    expect(r.distance).toBeLessThan(0);
  });

  it("origin-bottom Y keeps [0, bed]; X is [0, W] in both frames", () => {
    expect(jogEnvelope("Y", 300, false)).toEqual([0, 300]);
    expect(jogEnvelope("Y", 300, true)).toEqual([-300, 0]);
    expect(jogEnvelope("X", 500, true)).toEqual([0, 500]);
    expect(jogEnvelope("X", 500, false)).toEqual([0, 500]);
  });

  it("refuses when the head is outside the envelope (origin-top, Y=+5)", () => {
    const r = clipJog({ axis: "Y", distance: -1, position: 5, bed: 250, originTop: true });
    expect(r).toEqual({ kind: "refuse", reason: JOG_REASON_OUTSIDE });
  });

  it("refuses at the edge toward the edge; the other way sends", () => {
    expect(clipJog({ axis: "X", distance: -1, position: 0, bed: 500, originTop: false })).toEqual({
      kind: "refuse",
      reason: JOG_REASON_EDGE,
    });
    expect(clipJog({ axis: "X", distance: 1, position: 0, bed: 500, originTop: false })).toEqual({
      kind: "send",
      distance: 1,
    });
  });

  it("A3-3: property table — never reverses, never grows, always lands inside", () => {
    const beds = [250, 415];
    const requests = [-50, -10, -1, -0.1, 0.1, 1, 10, 50];
    let cases = 0;
    let sent = 0;
    for (const originTop of [false, true]) {
      for (const axis of ["X", "Y"] as const) {
        for (const bed of beds) {
          const [lo, hi] = jogEnvelope(axis, bed, originTop);
          const positions = [lo, lo + 0.05, lo + 5, (lo + hi) / 2, hi - 5, hi - 0.05, hi];
          positions.push(lo - 1, hi + 1); // outside
          for (const position of positions) {
            for (const distance of requests) {
              cases++;
              const r = clipJog({ axis, distance, position, bed, originTop });
              if (r.kind === "refuse") continue;
              sent++;
              expect(Math.sign(r.distance)).toBe(Math.sign(distance));
              expect(Math.abs(r.distance)).toBeLessThanOrEqual(Math.abs(distance) + 1e-12);
              expect(position + r.distance).toBeGreaterThanOrEqual(lo - 1e-9);
              expect(position + r.distance).toBeLessThanOrEqual(hi + 1e-9);
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThanOrEqual(200);
    expect(sent).toBeGreaterThan(cases / 2);
  });
});

describe("targetInEnvelope", () => {
  it("origin-top admits negative Y only; origin-bottom admits positive Y only", () => {
    expect(targetInEnvelope(10, -150, 500, 300, true)).toBe(true);
    expect(targetInEnvelope(10, 150, 500, 300, true)).toBe(false);
    expect(targetInEnvelope(10, 150, 500, 300, false)).toBe(true);
    expect(targetInEnvelope(10, -150, 500, 300, false)).toBe(false);
    expect(targetInEnvelope(501, 150, 500, 300, false)).toBe(false);
  });
});

describe("jogBlockReason ordering", () => {
  const ready: JogGateState = {
    machineConnected: true,
    machineState: "idle",
    jobRunning: false,
    statusStale: false,
    workspaceVerified: true,
    positionKind: "machine",
    workCoordOffset: { x: 0, y: 0 },
  };

  it("ready passes in both modes", () => {
    expect(jogBlockReason(ready, "by")).toBeNull();
    expect(jogBlockReason(ready, "to")).toBeNull();
  });

  it("each precondition names its own reason", () => {
    expect(jogBlockReason({ ...ready, machineConnected: false }, "by")).toBe(
      JOG_REASON_NOT_CONNECTED
    );
    expect(jogBlockReason({ ...ready, machineState: "alarm" }, "by")).toBe(JOG_REASON_ALARM);
    expect(jogBlockReason({ ...ready, jobRunning: true }, "by")).toBe(JOG_REASON_JOB);
    expect(jogBlockReason({ ...ready, workspaceVerified: false }, "by")).toBe(JOG_REASON_BED);
    expect(jogBlockReason({ ...ready, statusStale: true }, "by")).toBe(JOG_REASON_STALE);
    expect(jogBlockReason({ ...ready, positionKind: null }, "by")).toBe(JOG_REASON_STALE);
    expect(jogBlockReason({ ...ready, machineState: "run" }, "by")).toBe(JOG_REASON_BUSY);
    const offset = { ...ready, workCoordOffset: { x: 1, y: 0 } };
    expect(jogBlockReason(offset, "to")).toBe(JOG_REASON_OFFSET);
    expect(jogBlockReason({ ...offset, positionKind: "work" }, "by")).toBe(JOG_REASON_OFFSET);
    expect(jogBlockReason(offset, "by")).toBeNull();
  });

  it("a running job refuses before the (frozen) stale and idle checks", () => {
    const during = { ...ready, jobRunning: true, workspaceVerified: false, statusStale: true };
    expect(jogBlockReason(during, "by")).toBe(JOG_REASON_JOB);
    expect(jogBlockReason({ ...during, machineState: "alarm" }, "by")).toBe(JOG_REASON_ALARM);
  });

  it("an unconfirmed bed is named before a stale status", () => {
    expect(jogBlockReason({ ...ready, workspaceVerified: false, statusStale: true }, "by")).toBe(
      JOG_REASON_BED
    );
  });
});
