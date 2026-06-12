/**
 * W1c (F20) — compound paths split at the producers, grouped per source
 * shape, asserted at the FLATTEN level (coordinates, not just counts: a
 * hand-rolled world-frame-children group double-translates on flatten while
 * every per-child invariant stays green — only flatten coordinates catch it).
 *
 * Producers under test (critic-verified census):
 *  - SVG import (_testImportSvgWithLayers — production parse→walk→store)
 *  - text-to-path (textObjectToPaths, multi-contour synthetic glyph)
 *  - image trace (buildTracedPathObjects — the dialog's commit construction)
 *  - pdfImport: NOT affected (splits on moveTo already) — untouched, no test.
 *
 * Single-subpath behavior is pinned unchanged (characterization): one flat
 * object, no group wrapper.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

// Synthetic font: "O" is a two-contour glyph (700×700 outer square + 300×300
// hole), every other char a single-contour 500×700 square. unitsPerEm 1000.
vi.mock("opentype.js", () => {
  const outerHole = [
    { type: "M", x: 0, y: 0 },
    { type: "L", x: 700, y: 0 },
    { type: "L", x: 700, y: -700 },
    { type: "L", x: 0, y: -700 },
    { type: "Z" },
    { type: "M", x: 200, y: -200 },
    { type: "L", x: 500, y: -200 },
    { type: "L", x: 500, y: -500 },
    { type: "L", x: 200, y: -500 },
    { type: "Z" },
  ];
  const square = [
    { type: "M", x: 0, y: 0 },
    { type: "L", x: 500, y: 0 },
    { type: "L", x: 500, y: -700 },
    { type: "L", x: 0, y: -700 },
    { type: "Z" },
  ];
  const makeFont = () => ({
    unitsPerEm: 1000,
    stringToGlyphs: (text: string) =>
      text.split("").map((ch) => ({
        advanceWidth: 500,
        getPath: () => ({ commands: ch === "O" ? outerHole : square }),
      })),
  });
  return {
    default: {
      load: vi.fn().mockImplementation(() => Promise.resolve(makeFont())),
    },
  };
});

import { useStore } from "../../app/store";
import type { DesignObject } from "../../app/types";
import { assertPointsInvariant } from "../geometry";
import { _testImportSvgWithLayers } from "../../components/panels/SvgImportDialog";
import { buildTracedPathObjects } from "../../components/panels/ImageTraceDialog";
import { textObjectToPaths } from "../../app/store/geometryActions";
import { flattenObjectsForTest, toCutObjectsForTest } from "../machine/gcodeGen";
import { DEFAULT_LAYERS } from "../../app/types";

const DONUT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
  <path d="M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z" stroke="#000"/>
</svg>`;

function pts(o: DesignObject): Array<{ x: number; y: number }> {
  return o.points!.map((p) => ({ x: p.x, y: p.y }));
}

beforeEach(() => {
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

describe("SVG import: compound path → grouped per-contour objects", () => {
  it("donut imports as ONE group of TWO closed paths whose flatten coordinates match the source", () => {
    _testImportSvgWithLayers(DONUT_SVG, null);
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    const group = objects[0];
    expect(group.type).toBe("group");
    expect(group.children).toHaveLength(2);
    assertPointsInvariant(group); // group-local convention holds at birth

    // FLATTEN COORDINATES — the world positions the source encodes. A
    // double-translated (world-frame-children) group would fail here only.
    const flat = flattenObjectsForTest(objects);
    expect(flat).toHaveLength(2);
    expect(pts(flat[0])).toEqual([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]);
    expect(pts(flat[1])).toEqual([
      { x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 },
    ]);
    expect(flat[0].closed).toBe(true);
    expect(flat[1].closed).toBe(true);
    // Cut-planner affinity: both children carry the group's id
    expect(flat[0].groupId).toBe(group.id);
    expect(flat[1].groupId).toBe(group.id);

    // Selection references the GROUP id, not nested children
    expect(useStore.getState().selectedIds).toEqual([group.id]);

    // Serialization level: two 4-point rings — the pre-fix bridge pair
    // (0,10) → (2,2) exists in NO serialized path.
    const { objects: cut } = toCutObjectsForTest(objects, DEFAULT_LAYERS);
    expect(cut).toHaveLength(2);
    for (const c of cut) {
      expect(c.paths[0].points).toHaveLength(4);
      expect(c.paths[0].closed).toBe(true);
      for (let i = 1; i < c.paths[0].points.length; i++) {
        const a = c.paths[0].points[i - 1];
        const b = c.paths[0].points[i];
        expect(a.x === 0 && a.y === 10 && b.x === 2 && b.y === 2).toBe(false);
      }
    }
    expect(cut[0].groupId).toBe(group.id);
    expect(cut[1].groupId).toBe(group.id);
  });

  it("CHARACTERIZATION: single-subpath path imports as one flat object — no group", () => {
    _testImportSvgWithLayers(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
         <path d="M0 0 H10 V10 H0 Z" stroke="#000"/>
       </svg>`,
      null,
    );
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("path");
    expect(objects[0].closed).toBe(true);
    expect(pts(objects[0])).toEqual([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]);
  });

  it("per-subpath closed flags: open trailing subpath stays open (whole-string regex was wrong)", () => {
    _testImportSvgWithLayers(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
         <path d="M0 0 H10 V10 H0 Z M20 20 L30 20 L30 30" stroke="#000"/>
       </svg>`,
      null,
    );
    const flat = flattenObjectsForTest(useStore.getState().objects);
    expect(flat).toHaveLength(2);
    expect(flat[0].closed).toBe(true);
    expect(flat[1].closed).toBe(false);
  });

  it("degenerate one-point subpaths don't force a group (surviving ≥2-point subpaths = 1)", () => {
    _testImportSvgWithLayers(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
         <path d="M5 5 M0 0 H10 V10 H0 Z" stroke="#000"/>
       </svg>`,
      null,
    );
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("path");
  });
});

describe("text-to-path: multi-contour glyphs group per glyph", () => {
  function makeText(id: string, text: string): DesignObject {
    return {
      id,
      type: "text",
      name: `Text ${id}`,
      transform: { x: 20, y: 30, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      layerIndex: 0,
      visible: true,
      locked: false,
      fill: "#e8e8e8",
      stroke: "#e8e8e8",
      strokeWidth: 0,
      opacity: 1,
      text,
      fontSize: 18,
      fontFamily: "sans-serif",
    };
  }

  it('"O" yields ONE group with the hole contour as a separate path; flatten coordinates exact', async () => {
    const prepared = await textObjectToPaths(makeText("t1", "O"));
    expect(prepared).toHaveLength(1);
    const group = prepared[0];
    expect(group.type).toBe("group");
    expect(group.children).toHaveLength(2);
    assertPointsInvariant(group);

    // World coordinates from the production formula: x = 20 + cmd.x*0.018,
    // y = 30 + 18 + cmd.y*0.018 (fontSize 18 / unitsPerEm 1000).
    const s = 18 / 1000;
    const flat = flattenObjectsForTest(prepared);
    expect(flat).toHaveLength(2);
    expect(pts(flat[0])).toEqual([
      { x: 20, y: 48 },
      { x: 20 + 700 * s, y: 48 },
      { x: 20 + 700 * s, y: 48 - 700 * s },
      { x: 20, y: 48 - 700 * s },
    ]);
    expect(pts(flat[1])).toEqual([
      { x: 20 + 200 * s, y: 48 - 200 * s },
      { x: 20 + 500 * s, y: 48 - 200 * s },
      { x: 20 + 500 * s, y: 48 - 500 * s },
      { x: 20 + 200 * s, y: 48 - 500 * s },
    ]);
    expect(flat[0].closed).toBe(true);
    expect(flat[1].closed).toBe(true);
  });

  it('CHARACTERIZATION: single-contour glyphs stay FLAT — "AB" is two ungrouped paths', async () => {
    const prepared = await textObjectToPaths(makeText("t2", "AB"));
    expect(prepared).toHaveLength(2);
    for (const o of prepared) {
      expect(o.type).toBe("path");
      assertPointsInvariant(o);
    }
  });

  it('mixed "IO": single-contour glyph flat, multi-contour glyph grouped', async () => {
    const prepared = await textObjectToPaths(makeText("t3", "IO"));
    expect(prepared).toHaveLength(2);
    expect(prepared[0].type).toBe("path");
    expect(prepared[1].type).toBe("group");
    expect(prepared[1].children).toHaveLength(2);
    for (const o of prepared) assertPointsInvariant(o);
  });
});

describe("image trace: compound d split, single-subpath traces ungrouped", () => {
  const imgT = { x: 10, y: 20, width: 50, height: 30, rotation: 0, scaleX: 1, scaleY: 1 };

  it("compound trace path becomes ONE group of two contours with exact flatten coordinates", () => {
    // image space 100×80 px mapped onto imgT (50×30 mm at (10,20))
    const objects = buildTracedPathObjects(
      `<svg><path d="M0 0 L100 0 L100 80 L0 80 Z M20 16 L80 16 L80 64 L20 64 Z"/></svg>`,
      imgT, 100, 80, 0, "#4a90e2",
    );
    expect(objects).toHaveLength(1);
    const group = objects[0];
    expect(group.type).toBe("group");
    expect(group.children).toHaveLength(2);
    assertPointsInvariant(group);

    const flat = flattenObjectsForTest(objects);
    expect(pts(flat[0])).toEqual([
      { x: 10, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 50 }, { x: 10, y: 50 },
    ]);
    expect(pts(flat[1])).toEqual([
      { x: 20, y: 26 }, { x: 50, y: 26 }, { x: 50, y: 44 }, { x: 20, y: 44 },
    ]);
    expect(flat[0].closed).toBe(true);
    expect(flat[1].closed).toBe(true);
  });

  it("CHARACTERIZATION: single-subpath trace stays an ungrouped path", () => {
    const objects = buildTracedPathObjects(
      `<svg><path d="M 0 0 L 100 0 L 100 80 Z"/></svg>`,
      imgT, 100, 80, 0, "#4a90e2",
    );
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("path");
    assertPointsInvariant(objects[0]);
  });
});
