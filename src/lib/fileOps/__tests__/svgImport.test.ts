import { describe, it, expect } from "vitest";
import { parsePathD } from "../svgImport";

// W1c (F20): parsePathD returns SUBPATHS ({ points, closed }[]). The 9
// pre-existing direct tests below are re-homed onto the new return shape —
// single-subpath inputs assert on [0].points (same geometry as before);
// the empty-input test's [] is now an empty subpath array.
describe("parsePathD", () => {
  it("parses a simple M L path", () => {
    const subpaths = parsePathD("M 0 0 L 10 0 L 10 10 L 0 10 Z");
    expect(subpaths).toHaveLength(1);
    const points = subpaths[0].points;
    expect(points.length).toBeGreaterThanOrEqual(4);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[1]).toEqual({ x: 10, y: 0 });
    expect(points[2]).toEqual({ x: 10, y: 10 });
    expect(points[3]).toEqual({ x: 0, y: 10 });
    expect(subpaths[0].closed).toBe(true);
  });

  it("handles relative commands (m l)", () => {
    const subpaths = parsePathD("m 5 5 l 10 0 l 0 10 l -10 0 z");
    expect(subpaths).toHaveLength(1);
    const points = subpaths[0].points;
    expect(points.length).toBeGreaterThanOrEqual(4);
    expect(points[0]).toEqual({ x: 5, y: 5 });
    expect(points[1]).toEqual({ x: 15, y: 5 });
    expect(points[2]).toEqual({ x: 15, y: 15 });
    expect(points[3]).toEqual({ x: 5, y: 15 });
    expect(subpaths[0].closed).toBe(true);
  });

  it("parses H and V commands", () => {
    const subpaths = parsePathD("M 0 0 H 20 V 15");
    expect(subpaths).toHaveLength(1);
    const points = subpaths[0].points;
    expect(points).toHaveLength(3);
    expect(points[1]).toEqual({ x: 20, y: 0 });
    expect(points[2]).toEqual({ x: 20, y: 15 });
    expect(subpaths[0].closed).toBe(false);
  });

  it("parses cubic bezier (C) and produces handleIn/handleOut", () => {
    const subpaths = parsePathD("M 0 0 C 5 0 10 5 10 10");
    expect(subpaths).toHaveLength(1);
    const points = subpaths[0].points;
    expect(points).toHaveLength(2);
    // First point should have handleOut
    expect(points[0].handleOut).toEqual({ x: 5, y: 0 });
    // Second point should have handleIn
    expect(points[1].handleIn).toEqual({ x: 10, y: 5 });
    expect(points[1].x).toBe(10);
    expect(points[1].y).toBe(10);
  });

  it("parses quadratic bezier (Q) converted to cubic", () => {
    const subpaths = parsePathD("M 0 0 Q 5 5 10 0");
    expect(subpaths).toHaveLength(1);
    const points = subpaths[0].points;
    expect(points).toHaveLength(2);
    expect(points[0].handleOut).toBeDefined();
    expect(points[1].handleIn).toBeDefined();
    expect(points[1].x).toBe(10);
    expect(points[1].y).toBe(0);
  });

  it("returns empty array for empty input", () => {
    expect(parsePathD("")).toEqual([]);
  });

  it("handles arc (A) commands by approximation", () => {
    const subpaths = parsePathD("M 0 10 A 10 10 0 0 1 10 0");
    expect(subpaths).toHaveLength(1);
    // Arc should produce multiple approximation points
    expect(subpaths[0].points.length).toBeGreaterThanOrEqual(2);
  });

  // D7 — S/T after non-curve command must reflect through current point, not stale (0,0)
  it("D7: S after L reflects through current point (not stale lastCx2)", () => {
    // M0,0 L10,0 S20,10 20,0
    // After L, current point = (10,0). S reflects lastCx2/lastCy2.
    // Bug: lastCx2/lastCy2 remain 0,0 → reflected CP = (2*10-0, 2*0-0) = (20, 0) (wrong)
    // Fix: reset to current point → reflected CP = (2*10-10, 2*0-0) = (10, 0) = current point
    const subpaths = parsePathD("M0,0 L10,0 S20,10 20,0");
    expect(subpaths).toHaveLength(1);
    const points = subpaths[0].points;
    // points[1] = L endpoint (10,0); points[1].handleOut = reflected CP of S
    expect(points).toHaveLength(3);
    expect(points[1].x).toBe(10);
    expect(points[1].y).toBe(0);
    // Per SVG spec: preceding command is not cubic, so first CP = current point (10,0)
    expect(points[1].handleOut).toBeDefined();
    expect(points[1].handleOut!.x).toBeCloseTo(10, 5);
    expect(points[1].handleOut!.y).toBeCloseTo(0, 5);
  });

  it("D7: C→S chain still works correctly (lastCx2 updated by C)", () => {
    // C 5,5 15,5 20,0 — stores lastCx2=15, lastCy2=5
    // S 30,5 40,0 — reflects (2*20-15, 2*0-5) = (25, -5)
    const subpaths = parsePathD("M0,0 C5,5 15,5 20,0 S30,5 40,0");
    expect(subpaths).toHaveLength(1);
    const points = subpaths[0].points;
    expect(points).toHaveLength(3);
    expect(points[1].handleOut).toBeDefined();
    // Reflected: (2*20-15, 2*0-5) = (25, -5)
    expect(points[1].handleOut!.x).toBeCloseTo(25, 5);
    expect(points[1].handleOut!.y).toBeCloseTo(-5, 5);
  });
});

// W1c (F20): in-parser, state-preserving subpath split.
describe("parsePathD subpath split (F20)", () => {
  it("splits an absolute donut (M..Z M..Z) into two closed subpaths — no bridge", () => {
    const subpaths = parsePathD("M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z");
    expect(subpaths).toHaveLength(2);
    expect(subpaths[0].points).toEqual([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]);
    expect(subpaths[0].closed).toBe(true);
    expect(subpaths[1].points).toEqual([
      { x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 },
    ]);
    expect(subpaths[1].closed).toBe(true);
    // Pre-fix this was ONE 8-point array whose consecutive pair
    // (0,10) → (2,2) was the bridge segment, CUT through the workpiece.
  });

  it("RELATIVE-m donut: pen state chains across the boundary (Z resets pen to subpath start)", () => {
    // Z resets the pen to (10,10) — the first subpath's start — so the
    // relative `m 2 2` lands at (12,12). A stateless split-on-m wrapper
    // re-parsing the second fragment from a cold pen would put it at (2,2).
    const subpaths = parsePathD("M10 10 h 10 v 10 h -10 z m 2 2 h 6 v 6 h -6 z");
    expect(subpaths).toHaveLength(2);
    expect(subpaths[0].points[0]).toEqual({ x: 10, y: 10 });
    expect(subpaths[0].closed).toBe(true);
    expect(subpaths[1].points).toEqual([
      { x: 12, y: 12 }, { x: 18, y: 12 }, { x: 18, y: 18 }, { x: 12, y: 18 },
    ]);
    expect(subpaths[1].closed).toBe(true);
  });

  it("post-Z-without-M: drawing command starts a NEW subpath anchored at (sx,sy), never reopens the closed one", () => {
    const subpaths = parsePathD("M0 0 L10 0 L10 10 Z L5 5");
    expect(subpaths).toHaveLength(2);
    expect(subpaths[0].points).toEqual([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
    ]);
    expect(subpaths[0].closed).toBe(true); // stays closed
    // New subpath anchored at the just-closed subpath's start point
    expect(subpaths[1].points).toEqual([{ x: 0, y: 0 }, { x: 5, y: 5 }]);
    expect(subpaths[1].closed).toBe(false);
  });

  it("open trailing subpath: per-subpath closed flags (old whole-string regex was wrong here)", () => {
    const subpaths = parsePathD("M0 0 L10 0 Z M20 20 L30 20");
    expect(subpaths).toHaveLength(2);
    expect(subpaths[0].closed).toBe(true);
    expect(subpaths[1].closed).toBe(false);
  });

  it("preserves bezier handles within each subpath", () => {
    const subpaths = parsePathD("M0 0 C1 1 2 1 3 0 Z M10 10 C11 11 12 11 13 10 Z");
    expect(subpaths).toHaveLength(2);
    expect(subpaths[0].points[0].handleOut).toEqual({ x: 1, y: 1 });
    expect(subpaths[0].points[1].handleIn).toEqual({ x: 2, y: 1 });
    expect(subpaths[1].points[0].handleOut).toEqual({ x: 11, y: 11 });
    expect(subpaths[1].points[1].handleIn).toEqual({ x: 12, y: 11 });
  });

  it("degenerate one-point subpaths from stray M commands are returned for callers' ≥2-point filter", () => {
    const subpaths = parsePathD("M5 5 M10 10 L20 20");
    expect(subpaths).toHaveLength(2);
    expect(subpaths[0].points).toEqual([{ x: 5, y: 5 }]);
    expect(subpaths[1].points).toEqual([{ x: 10, y: 10 }, { x: 20, y: 20 }]);
  });

  it("leading non-M command still parses from (0,0) without pushing an origin point", () => {
    const subpaths = parsePathD("L10 0 L10 10");
    expect(subpaths).toHaveLength(1);
    expect(subpaths[0].points).toEqual([{ x: 10, y: 0 }, { x: 10, y: 10 }]);
  });
});
