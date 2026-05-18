import { describe, it, expect } from "vitest";
import { parsePathD } from "../svgImport";

describe("parsePathD", () => {
  it("parses a simple M L path", () => {
    const points = parsePathD("M 0 0 L 10 0 L 10 10 L 0 10 Z");
    expect(points.length).toBeGreaterThanOrEqual(4);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[1]).toEqual({ x: 10, y: 0 });
    expect(points[2]).toEqual({ x: 10, y: 10 });
    expect(points[3]).toEqual({ x: 0, y: 10 });
  });

  it("handles relative commands (m l)", () => {
    const points = parsePathD("m 5 5 l 10 0 l 0 10 l -10 0 z");
    expect(points.length).toBeGreaterThanOrEqual(4);
    expect(points[0]).toEqual({ x: 5, y: 5 });
    expect(points[1]).toEqual({ x: 15, y: 5 });
    expect(points[2]).toEqual({ x: 15, y: 15 });
    expect(points[3]).toEqual({ x: 5, y: 15 });
  });

  it("parses H and V commands", () => {
    const points = parsePathD("M 0 0 H 20 V 15");
    expect(points).toHaveLength(3);
    expect(points[1]).toEqual({ x: 20, y: 0 });
    expect(points[2]).toEqual({ x: 20, y: 15 });
  });

  it("parses cubic bezier (C) and produces handleIn/handleOut", () => {
    const points = parsePathD("M 0 0 C 5 0 10 5 10 10");
    expect(points).toHaveLength(2);
    // First point should have handleOut
    expect(points[0].handleOut).toEqual({ x: 5, y: 0 });
    // Second point should have handleIn
    expect(points[1].handleIn).toEqual({ x: 10, y: 5 });
    expect(points[1].x).toBe(10);
    expect(points[1].y).toBe(10);
  });

  it("parses quadratic bezier (Q) converted to cubic", () => {
    const points = parsePathD("M 0 0 Q 5 5 10 0");
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
    const points = parsePathD("M 0 10 A 10 10 0 0 1 10 0");
    // Arc should produce multiple approximation points
    expect(points.length).toBeGreaterThanOrEqual(2);
  });
});
