/**
 * F22: SVG rotated rect/ellipse → path conversion.
 *
 * Exercises the production import pipeline via _testImportSvgWithLayers.
 * A <rect> with a rotation transform must import as a path with 4 corner
 * points that reflect the rotation — not an axis-aligned rectangle whose
 * width equals the diagonal of the original.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { useStore } from "../../../app/store";
import { _testImportSvgWithLayers } from "../SvgImportDialog";

beforeEach(() => {
  useStore.setState({ objects: [], selectedIds: [], undoStack: [], redoStack: [] });
});

describe("F22 — SVG rotated rect → path", () => {
  it("non-rotated rect imports as rectangle type (characterization)", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" viewBox="0 0 200 100">
      <rect x="10" y="10" width="80" height="50" stroke="#ff0000"/>
    </svg>`;
    _testImportSvgWithLayers(svg, null);
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("rectangle");
  });

  it("rotated rect (rotate(45)) imports as path with 4 points, not rectangle", () => {
    // A 100×50 rect rotated 45°. Without the fix, it would import as a rectangle
    // whose width/height equal the axis-aligned bounding box (~106mm square).
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" viewBox="0 0 200 200">
      <rect x="0" y="0" width="100" height="50" stroke="#ff0000" transform="rotate(45 50 50)"/>
    </svg>`;
    _testImportSvgWithLayers(svg, null);
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    // Must be a path, not a rectangle
    expect(objects[0].type).toBe("path");
    // Must have exactly 4 corner points
    expect(objects[0].points).toHaveLength(4);
    // Closed shape
    expect(objects[0].closed).toBe(true);
    // The corners must not all be axis-aligned (rotation must be reflected)
    const pts = objects[0].points!;
    const allSameX = pts.every((p) => Math.abs(p.x - pts[0].x) < 0.01);
    const allSameY = pts.every((p) => Math.abs(p.y - pts[0].y) < 0.01);
    expect(allSameX).toBe(false);
    expect(allSameY).toBe(false);
  });
});

describe("F22 — SVG rotated ellipse → path", () => {
  it("non-rotated ellipse imports as ellipse type (characterization)", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" viewBox="0 0 200 200">
      <ellipse cx="100" cy="100" rx="50" ry="30" stroke="#ff0000"/>
    </svg>`;
    _testImportSvgWithLayers(svg, null);
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("ellipse");
  });

  it("rotated ellipse imports as path with 4 bezier anchors", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" viewBox="0 0 200 200">
      <ellipse cx="100" cy="100" rx="50" ry="30" stroke="#ff0000" transform="rotate(30 100 100)"/>
    </svg>`;
    _testImportSvgWithLayers(svg, null);
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("path");
    expect(objects[0].points).toHaveLength(4);
    expect(objects[0].closed).toBe(true);
    // Bezier handles must be present (it's a bezier circle approximation)
    const firstPt = objects[0].points![0];
    expect(firstPt.handleIn).toBeDefined();
    expect(firstPt.handleOut).toBeDefined();
  });
});
