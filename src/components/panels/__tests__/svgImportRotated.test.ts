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
import { matrixMaxStretch } from "../../../lib/geometry";

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

describe("refresh-cut-vs-screen F2 — SVG arcs tessellate to 0.05 mm in real mm", () => {
  /** Largest distance from 4000 samples on the true ellipse to the imported
   *  closed polyline (point-to-segment, closing segment included). */
  function maxDeviation(
    points: ReadonlyArray<{ x: number; y: number }>,
    cx: number,
    cy: number,
    rx: number,
    ry: number
  ): number {
    const segDist = (
      px: number,
      py: number,
      a: { x: number; y: number },
      b: { x: number; y: number }
    ) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
    };
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      const th = (2 * Math.PI * i) / 4000;
      const px = cx + rx * Math.cos(th);
      const py = cy + ry * Math.sin(th);
      let best = Infinity;
      for (let j = 0; j < points.length; j++) {
        const d = segDist(px, py, points[j], points[(j + 1) % points.length]);
        if (d < best) best = d;
      }
      if (best > worst) worst = best;
    }
    return worst;
  }

  function importOnePath(svg: string) {
    _testImportSvgWithLayers(svg, null);
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("path");
    return objects[0].points!;
  }

  for (const vb of [1, 10, 100]) {
    it(`(i) 80 mm circle via two A commands, viewBox 0 0 ${vb} ${vb}`, () => {
      const r = 0.4 * vb;
      const c = 0.5 * vb;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 ${vb} ${vb}">
        <path d="M ${c + r} ${c} A ${r} ${r} 0 1 1 ${c - r} ${c} A ${r} ${r} 0 1 1 ${c + r} ${c} Z" stroke="#ff0000"/>
      </svg>`;
      const pts = importOnePath(svg);
      expect(maxDeviation(pts, 50, 50, 40, 40)).toBeLessThanOrEqual(0.05 + 1e-6);
    });
  }

  it("(ii) eccentric ellipse rx=50 ry=5 — segment count from the LARGER radius", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
      <path d="M 100 50 A 50 5 0 1 1 0 50 A 50 5 0 1 1 100 50 Z" stroke="#ff0000"/>
    </svg>`;
    const pts = importOnePath(svg);
    expect(maxDeviation(pts, 50, 50, 50, 5)).toBeLessThanOrEqual(0.05 + 1e-6);
  });

  it("(iii) element matrix stretch (scale(1 5)) is honoured", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
      <path d="M 4 0 A 4 4 0 1 1 -4 0 A 4 4 0 1 1 4 0 Z" transform="translate(50 50) scale(1 5)" stroke="#ff0000"/>
    </svg>`;
    const pts = importOnePath(svg);
    expect(maxDeviation(pts, 50, 50, 4, 20)).toBeLessThanOrEqual(0.05 + 1e-6);
  });
});

describe("refresh-cut-vs-screen F2 — matrixMaxStretch is the max singular value", () => {
  it("skew stretches more than either column: [[1,1],[0,1]] → golden ratio", () => {
    // Column norms are 1 and √2; the true largest stretch is (1+√5)/2.
    expect(matrixMaxStretch([1, 0, 1, 1, 0, 0])).toBeCloseTo((1 + Math.sqrt(5)) / 2, 12);
  });
  it("uniform and axis scales", () => {
    expect(matrixMaxStretch([2, 0, 0, 2, 5, 5])).toBeCloseTo(2, 12);
    expect(matrixMaxStretch([1, 0, 0, 5, 0, 0])).toBeCloseTo(5, 12);
  });
});
