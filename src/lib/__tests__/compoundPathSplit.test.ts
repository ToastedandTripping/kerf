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
import { assertPointsInvariant } from "../geometry/__tests__/pointsInvariant";
import { _testImportSvgWithLayers } from "../../components/panels/SvgImportDialog";
import { buildTracedPathObjects } from "../../components/panels/ImageTraceDialog";
import { textObjectToPaths } from "../../app/store/geometryActions";
import { flattenObjectsForTest, toCutObjectsForTest } from "../machine/gcodeGen";
import { DEFAULT_LAYERS } from "../../app/types";

// Donut deliberately AWAY from the origin: the group origin lands at (5,7),
// so a hand-rolled world-frame-children group (the double-translate failure
// mode the flatten assertions exist to catch) shifts every point by (5,7)
// and FAILS. At M0 0 the origin was (0,0) — a (0,0) double-translate is a
// no-op and the mutation stayed green (Razor WARNING 2).
const DONUT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
  <path d="M5 7 H15 V17 H5 Z M7 9 H13 V15 H7 Z" stroke="#000"/>
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
      { x: 5, y: 7 }, { x: 15, y: 7 }, { x: 15, y: 17 }, { x: 5, y: 17 },
    ]);
    expect(pts(flat[1])).toEqual([
      { x: 7, y: 9 }, { x: 13, y: 9 }, { x: 13, y: 15 }, { x: 7, y: 15 },
    ]);
    expect(flat[0].closed).toBe(true);
    expect(flat[1].closed).toBe(true);
    // Cut-planner affinity: both children carry the group's id
    expect(flat[0].groupId).toBe(group.id);
    expect(flat[1].groupId).toBe(group.id);

    // Selection references the GROUP id, not nested children
    expect(useStore.getState().selectedIds).toEqual([group.id]);

    // Phase 1 (maskFill): on a FILL layer, the donut group coalesces into ONE
    // CutObject with paths.length === 2 (outer + hole), not two separate objects.
    // This is the correct behavior — both contours must be rasterized together
    // via even-odd so the counter (hole) is left unburned.
    const fillLayers = DEFAULT_LAYERS; // DEFAULT_LAYERS[0] is "Engrave" (fill)
    const { objects: fillCut } = toCutObjectsForTest(objects, fillLayers);
    expect(fillCut).toHaveLength(1);
    expect(fillCut[0].paths).toHaveLength(2);
    expect(fillCut[0].paths[0].points).toHaveLength(4); // outer square
    expect(fillCut[0].paths[1].points).toHaveLength(4); // inner square (hole)
    expect(fillCut[0].paths[0].closed).toBe(true);
    expect(fillCut[0].paths[1].closed).toBe(true);
    expect(fillCut[0].layer.mode).toBe("maskFill");
    expect(fillCut[0].groupId).toBe(group.id);
    // Union bbox: covers both the outer (5,7)-(15,17) contour
    expect(fillCut[0].x).toBeCloseTo(5, 5);
    expect(fillCut[0].y).toBeCloseTo(7, 5);
    expect(fillCut[0].width).toBeCloseTo(10, 5);
    expect(fillCut[0].height).toBeCloseTo(10, 5);

    // On a LINE layer, the group emits TWO separate CutObjects (unchanged)
    const lineLayers = DEFAULT_LAYERS.map((l, i) => i === 0 ? { ...l, mode: "line" as const } : l);
    const { objects: lineCut } = toCutObjectsForTest(objects, lineLayers);
    expect(lineCut).toHaveLength(2);
    for (const c of lineCut) {
      expect(c.paths[0].points).toHaveLength(4);
      expect(c.paths[0].closed).toBe(true);
    }
    expect(lineCut[0].groupId).toBe(group.id);
    expect(lineCut[1].groupId).toBe(group.id);
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

describe("SVG import: compound path inside transformed groups", () => {
  it("compound path in a translated group: flatten coords = source + translation", () => {
    _testImportSvgWithLayers(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200mm" height="200mm">
         <g transform="translate(50 50)">
           <path d="M0 0 H10 V10 H0 Z M20 0 H30 V10 H20 Z" stroke="#000"/>
         </g>
       </svg>`,
      null,
    );
    const flat = flattenObjectsForTest(useStore.getState().objects);
    expect(flat).toHaveLength(2);
    expect(pts(flat[0])).toEqual([
      { x: 50, y: 50 }, { x: 60, y: 50 }, { x: 60, y: 60 }, { x: 50, y: 60 },
    ]);
    expect(pts(flat[1])).toEqual([
      { x: 70, y: 50 }, { x: 80, y: 50 }, { x: 80, y: 60 }, { x: 70, y: 60 },
    ]);
  });

  it("compound path in a scaled group: flatten coords = source * scale", () => {
    _testImportSvgWithLayers(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200mm" height="200mm">
         <g transform="scale(2)">
           <path d="M5 5 H15 V15 H5 Z M20 5 H30 V15 H20 Z" stroke="#000"/>
         </g>
       </svg>`,
      null,
    );
    const flat = flattenObjectsForTest(useStore.getState().objects);
    expect(flat).toHaveLength(2);
    expect(pts(flat[0])).toEqual([
      { x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 },
    ]);
    expect(pts(flat[1])).toEqual([
      { x: 40, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 30 }, { x: 40, y: 30 },
    ]);
  });

  it("separate paths in a translated group: each has correct world position", () => {
    _testImportSvgWithLayers(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200mm" height="200mm">
         <g transform="translate(100 100)">
           <path d="M0 0 H10 V10 H0 Z" stroke="#000"/>
           <path d="M20 0 H30 V10 H20 Z" stroke="#000"/>
         </g>
       </svg>`,
      null,
    );
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(2);
    expect(pts(objects[0])).toEqual([
      { x: 100, y: 100 }, { x: 110, y: 100 }, { x: 110, y: 110 }, { x: 100, y: 110 },
    ]);
    expect(pts(objects[1])).toEqual([
      { x: 120, y: 100 }, { x: 130, y: 100 }, { x: 130, y: 110 }, { x: 120, y: 110 },
    ]);
  });

  it("nested groups: inner translate + outer translate compose correctly", () => {
    _testImportSvgWithLayers(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300mm" height="300mm">
         <g transform="translate(50 50)">
           <g transform="translate(10 10)">
             <path d="M0 0 H5 V5 H0 Z" stroke="#000"/>
           </g>
         </g>
       </svg>`,
      null,
    );
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    expect(pts(objects[0])).toEqual([
      { x: 60, y: 60 }, { x: 65, y: 60 }, { x: 65, y: 65 }, { x: 60, y: 65 },
    ]);
  });

  it("viewBox offset: non-zero viewBox min shifts all coordinates", () => {
    _testImportSvgWithLayers(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 10 100 100" width="100mm" height="100mm">
         <path d="M10 10 H20 V20 H10 Z M30 10 H40 V20 H30 Z" stroke="#000"/>
       </svg>`,
      null,
    );
    const flat = flattenObjectsForTest(useStore.getState().objects);
    expect(flat).toHaveLength(2);
    // viewBox="10 10 ..." → initial matrix translates by (-10, -10)
    expect(pts(flat[0])).toEqual([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]);
    expect(pts(flat[1])).toEqual([
      { x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 20, y: 10 },
    ]);
  });

  it("globalScale applies: px-unit SVG scales to mm", () => {
    // No width/height in mm, viewBox present → globalScale = 0.2646 * width / vbWidth
    _testImportSvgWithLayers(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
         <path d="M0 0 H100 V100 H0 Z M10 10 H90 V90 H10 Z" stroke="#000"/>
       </svg>`,
      null,
    );
    const flat = flattenObjectsForTest(useStore.getState().objects);
    expect(flat).toHaveLength(2);
    // globalScale = (100px * 0.2646) / 100 = 0.2646
    const s = 0.2646;
    for (const p of pts(flat[0])) {
      expect(p.x).toBeCloseTo(p.x, 2); // just verify non-NaN
    }
    expect(pts(flat[0])[0].x).toBeCloseTo(0, 2);
    expect(pts(flat[0])[1].x).toBeCloseTo(100 * s, 2);
    expect(pts(flat[1])[0].x).toBeCloseTo(10 * s, 2);
    expect(pts(flat[1])[1].x).toBeCloseTo(90 * s, 2);
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

// ─── Phase 1: fill-layer coalescing via toCutObjects ─────────────────────────

describe("Phase 1: toCutObjects — fill layer coalesces grouped compound shapes into maskFill", () => {
  // Multi-path CutObject round-trip gate (critic must-fix #4):
  // A CutObject with >1 PathSegment must serialize/deserialize correctly.
  // Here we verify it passes through toCutObjects with paths.length === 2
  // and the correct mode before the Tauri serde boundary.
  it("fill layer: donut group → one CutObject with 2 paths and mode=maskFill", () => {
    _testImportSvgWithLayers(DONUT_SVG, null);
    const objects = useStore.getState().objects;
    const { objects: cut } = toCutObjectsForTest(objects, DEFAULT_LAYERS);
    // fill layer → coalesced: 1 CutObject, 2 paths, mode = maskFill
    expect(cut).toHaveLength(1);
    expect(cut[0].paths).toHaveLength(2);
    expect(cut[0].layer.mode).toBe("maskFill");
  });

  it("line layer: donut group → two separate CutObjects (unchanged)", () => {
    _testImportSvgWithLayers(DONUT_SVG, null);
    const objects = useStore.getState().objects;
    const lineLayers = DEFAULT_LAYERS.map((l, i) => i === 0 ? { ...l, mode: "line" as const } : l);
    const { objects: cut } = toCutObjectsForTest(objects, lineLayers);
    // line mode → NOT coalesced: 2 CutObjects
    expect(cut).toHaveLength(2);
    for (const c of cut) expect(c.layer.mode).toBe("line");
  });

  it("nested word group: 'IO' text on fill layer → one CutObject per glyph, O coalesced with 2 paths", async () => {
    // 'I' is a single-contour glyph (flat path, no groupId after textObjectToPaths);
    // 'O' is a two-contour glyph (group with 2 children that get groupId on flatten).
    // On a fill layer:
    //   I (no groupId, non-rect path) → 1 CutObject, mode=maskFill (ungrouped non-rect on fill)
    //   O (group with 2 children sharing groupId) → 1 coalesced CutObject, paths.length=2, mode=maskFill
    // Total: 2 CutObjects, NOT 1 per word group.
    const prepared = await textObjectToPaths({
      id: "w1",
      type: "text",
      name: "IO",
      transform: { x: 0, y: 30, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      layerIndex: 0,
      visible: true, locked: false,
      fill: "#e8e8e8", stroke: "#e8e8e8", strokeWidth: 0, opacity: 1,
      text: "IO", fontSize: 18, fontFamily: "sans-serif",
    });
    // prepared = [I_path, O_group]
    expect(prepared).toHaveLength(2);

    const { objects: cut } = toCutObjectsForTest(prepared, DEFAULT_LAYERS);
    // 2 CutObjects total: one for I (single path), one coalesced for O (2 paths)
    expect(cut).toHaveLength(2);

    // The coalesced O group must have paths.length === 2 and mode=maskFill
    const coalescedO = cut.find((c) => c.paths.length === 2);
    expect(coalescedO).toBeDefined();
    expect(coalescedO!.layer.mode).toBe("maskFill");

    // Both cut objects must be maskFill (I is ungrouped non-rect on fill → maskFill too)
    const maskFillCuts = cut.filter((c) => c.layer.mode === "maskFill");
    expect(maskFillCuts).toHaveLength(2);
  });
});
