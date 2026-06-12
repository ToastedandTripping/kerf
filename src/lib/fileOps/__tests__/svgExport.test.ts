import { describe, it, expect, beforeEach, vi } from "vitest";

// svgExport reads useStore.getState() — seed the store, no Tauri needed
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { useStore } from "../../../app/store";
import type { DesignObject, PathPoint } from "../../../app/types";
import { DEFAULT_LAYERS } from "../../../app/types";
import { exportSvgContent } from "../svgExport";
import { _testImportSvgWithLayers } from "../../../components/panels/SvgImportDialog";
import { toCutObjectsForTest } from "../../machine/gcodeGen";

function makeRotatedRect(id: string, x: number, y: number, w: number, h: number, rotation: number): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x, y, width: w, height: h, rotation, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

describe("svgExport", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      selectedIds: [],
      undoStack: [],
      redoStack: [],
      layers: DEFAULT_LAYERS,
      workspaceWidth: 300,
      workspaceHeight: 200,
    });
  });

  // D6 — rotated primitives must emit transform="rotate(deg cx cy)"
  it("D6: exports unrotated rect without rotate transform", () => {
    const obj = makeRotatedRect("r1", 10, 20, 50, 30, 0);
    useStore.getState().addObject(obj);
    const svg = exportSvgContent();
    // unrotated — no rotate transform should appear on this element
    expect(svg).not.toMatch(/transform="rotate\(/);
    expect(svg).toContain('x="10"');
  });

  it("D6: exports rotated rect with rotate(deg cx cy) at AABB center", () => {
    // Rect at (10,20) size 50×30, rotated 45 degrees
    // AABB center = (10+25, 20+15) = (35, 35)
    const obj = makeRotatedRect("r1", 10, 20, 50, 30, 45);
    useStore.getState().addObject(obj);
    const svg = exportSvgContent();
    // Must contain rotate with degrees=45, cx=35, cy=35
    expect(svg).toMatch(/transform="rotate\(45[,\s]+35[,\s]+35\)"/);
  });

  it("D6: exports rotated ellipse with rotate transform at AABB center", () => {
    const obj: DesignObject = {
      id: "e1",
      type: "ellipse",
      name: "Ellipse",
      transform: { x: 0, y: 0, width: 60, height: 40, rotation: 30, scaleX: 1, scaleY: 1 },
      layerIndex: 0,
      visible: true,
      locked: false,
      fill: null,
      stroke: "#e2664a",
      strokeWidth: 1,
      opacity: 1,
    };
    useStore.getState().addObject(obj);
    const svg = exportSvgContent();
    // center = (30, 20), rotation = 30
    expect(svg).toMatch(/transform="rotate\(30[,\s]+30[,\s]+20\)"/);
  });

  it("D6: near-zero rotation does not emit rotate transform", () => {
    const obj = makeRotatedRect("r1", 0, 0, 100, 50, 0.0001);
    useStore.getState().addObject(obj);
    const svg = exportSvgContent();
    expect(svg).not.toMatch(/transform="rotate\(/);
  });
});

// W1c (Fix 4): svgExport learns groups — post-F20 every compound-path import
// is a group; without the flatten, export silently lost those objects.
describe("svgExport groups (W1c Fix 4)", () => {
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
      workspaceWidth: 300,
      workspaceHeight: 200,
    });
  });

  function makeGroupOfPaths(): DesignObject {
    // Group at (10, 20) with two group-local closed square paths (W1b
    // convention: child points group-local, transform ≡ points bbox).
    const child = (id: string, off: number, size: number): DesignObject => ({
      id,
      type: "path",
      name: id,
      transform: { x: off, y: off, width: size, height: size, rotation: 0, scaleX: 1, scaleY: 1 },
      layerIndex: 0,
      visible: true,
      locked: false,
      fill: null,
      stroke: "#4a90e2",
      strokeWidth: 1,
      opacity: 1,
      points: [
        { x: off, y: off }, { x: off + size, y: off },
        { x: off + size, y: off + size }, { x: off, y: off + size },
      ],
      closed: true,
    });
    return {
      id: "g1",
      type: "group",
      name: "Group 1",
      transform: { x: 10, y: 20, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
      layerIndex: 0,
      visible: true,
      locked: false,
      fill: null,
      stroke: "#ffffff",
      strokeWidth: 0,
      opacity: 1,
      children: [child("outer", 0, 10), child("inner", 2, 6)],
    };
  }

  it("flattens group children to world-frame elements (was: silently dropped)", () => {
    useStore.getState().addObject(makeGroupOfPaths());
    const svg = exportSvgContent();
    // Children emitted world-frame: group origin (10,20) + local coords
    expect(svg).toContain('d="M10,20 L20,20 L20,30 L10,30 Z"');
    expect(svg).toContain('d="M12,22 L18,22 L18,28 L12,28 Z"');
  });

  it("honors child visible: hidden children are not exported", () => {
    const group = makeGroupOfPaths();
    group.children![1] = { ...group.children![1], visible: false };
    useStore.getState().addObject(group);
    const svg = exportSvgContent();
    expect(svg).toContain('d="M10,20');
    expect(svg).not.toContain('d="M12,22');
  });

  it("emits the CLOSING curve's handles as a C before Z (was: degraded to a straight chord)", () => {
    const k = 0.5522847498 * 10;
    const circle: PathPoint[] = [
      { x: 30, y: 20, handleIn: { x: 30 + k, y: 20 }, handleOut: { x: 30 - k, y: 20 } },
      { x: 20, y: 30, handleIn: { x: 20, y: 30 - k }, handleOut: { x: 20, y: 30 + k } },
      { x: 30, y: 40, handleIn: { x: 30 - k, y: 40 }, handleOut: { x: 30 + k, y: 40 } },
      { x: 40, y: 30, handleIn: { x: 40, y: 30 + k }, handleOut: { x: 40, y: 30 - k } },
    ];
    useStore.getState().addObject({
      id: "c1", type: "path", name: "Circle",
      transform: { x: 20, y: 20, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
      layerIndex: 0, visible: true, locked: false,
      fill: null, stroke: "#4a90e2", strokeWidth: 1, opacity: 1,
      points: circle, closed: true,
    });
    const svg = exportSvgContent();
    // 4 segments of a 4-anchor closed circle: 3 inner C + 1 closing C, then Z
    const d = svg.match(/d="([^"]+)"/)![1];
    expect(d.match(/C/g)).toHaveLength(4);
    // Closing C ends back at the first anchor, before Z
    expect(d).toMatch(/C40,[\d.]+ [\d.]+,20 30,20 Z$/);
  });

  it("ROUND-TRIP: polygonal donut import → export → re-import keeps exact world geometry; grouping does not survive (by design)", () => {
    _testImportSvgWithLayers(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
         <path d="M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z" stroke="#000"/>
       </svg>`,
      null,
    );
    expect(useStore.getState().objects).toHaveLength(1); // the F20 group
    const exported = exportSvgContent();

    // Re-import into a clean store
    useStore.setState({ objects: [], objectsById: new Map(), selectedIds: [], selectedSet: new Set(), undoStack: [], redoStack: [], consoleLines: [] });
    _testImportSvgWithLayers(exported, null);
    const reimported = useStore.getState().objects;

    // Nothing vanished — but the children come back as two TOP-LEVEL paths:
    // group semantics do not survive the round-trip (documented non-goal;
    // each exported <path> is single-subpath, so re-import does not re-group).
    expect(reimported).toHaveLength(2);
    expect(reimported.every((o) => o.type === "path")).toBe(true);
    expect(reimported[0].points!.map((p) => ({ x: p.x, y: p.y }))).toEqual([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]);
    expect(reimported[1].points!.map((p) => ({ x: p.x, y: p.y }))).toEqual([
      { x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 },
    ]);
    expect(reimported[0].closed).toBe(true);
    expect(reimported[1].closed).toBe(true);
  });

  it("ROUND-TRIP: curved closed path — serialized cut geometry identical within float ε", () => {
    // A closed bezier circle (closing curve included). Equivalence is asserted
    // through the PRODUCTION serialization (toCutObjects sampling): the
    // re-imported representation differs (explicit return-to-start point with
    // handleIn) but must sample to the same polyline.
    const k = 0.5522847498 * 10;
    const circle: PathPoint[] = [
      { x: 30, y: 20, handleIn: { x: 30 + k, y: 20 }, handleOut: { x: 30 - k, y: 20 } },
      { x: 20, y: 30, handleIn: { x: 20, y: 30 - k }, handleOut: { x: 20, y: 30 + k } },
      { x: 30, y: 40, handleIn: { x: 30 - k, y: 40 }, handleOut: { x: 30 + k, y: 40 } },
      { x: 40, y: 30, handleIn: { x: 40, y: 30 + k }, handleOut: { x: 40, y: 30 - k } },
    ];
    const original: DesignObject = {
      id: "c1", type: "path", name: "Circle",
      transform: { x: 20, y: 20, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
      layerIndex: 0, visible: true, locked: false,
      fill: null, stroke: "#4a90e2", strokeWidth: 1, opacity: 1,
      points: circle, closed: true,
    };
    useStore.getState().addObject(original);
    const exported = exportSvgContent();

    useStore.setState({ objects: [], objectsById: new Map(), selectedIds: [], selectedSet: new Set(), undoStack: [], redoStack: [], consoleLines: [] });
    _testImportSvgWithLayers(exported, null);
    const reimported = useStore.getState().objects;
    expect(reimported).toHaveLength(1);

    const cutA = toCutObjectsForTest([original], DEFAULT_LAYERS).objects[0].paths[0];
    const cutB = toCutObjectsForTest(reimported, DEFAULT_LAYERS).objects[0].paths[0];
    expect(cutB.closed).toBe(true);
    expect(cutB.points.length).toBe(cutA.points.length);
    for (let i = 0; i < cutA.points.length; i++) {
      expect(cutB.points[i].x).toBeCloseTo(cutA.points[i].x, 9);
      expect(cutB.points[i].y).toBeCloseTo(cutA.points[i].y, 9);
    }
  });
});
