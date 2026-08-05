/**
 * W1b — §5 creation-site invariant sweep: every creator of points-bearing
 * objects must establish transform ≡ anchors-only pointsBBox at birth.
 *
 * Swept creators (through PRODUCTION code paths):
 *  - SVG import  (_testImportSvgWithLayers — full parse→walk→store pipeline)
 *  - DXF import  (importDxfDirect)
 *  - PDF import  (extractVectorPaths with a synthetic operator list)
 *  - image trace (buildTracedPathObjects — the dialog's commit construction)
 *  - pen tool    (pointer handlers + double-click commit)
 *  - text-to-path (textObjectToPaths with a synthetic font; the convert
 *    fallback via a one-shot font-load failure)
 *  - convertToPath (rect incl. corner radius, ellipse)
 *  - booleans, offset
 *  - node edits  (move via pointer pipeline, delete, toggle-smooth)
 *
 * Degenerate fixtures are mandatory per importer: typical fixtures never fire
 * the old `||1` clamps, so a sweep without collinear (axis-parallel) inputs
 * proves nothing about them. The clamps are GONE (true bbox at birth); the
 * hitTest ε band keeps those objects click-selectable.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

// pdfjs-dist cannot load under jsdom (DOMMatrix missing). Only the OPS opcode
// table is substituted; the production extractVectorPaths switch and the test's
// synthetic operator lists both read the SAME imported OPS object, so the
// operator-interpretation logic is exercised faithfully regardless of values.
vi.mock("pdfjs-dist", () => ({
  OPS: {
    save: 10, restore: 11, transform: 12, moveTo: 13, lineTo: 14,
    curveTo: 15, curveTo2: 16, curveTo3: 17, closePath: 18, rectangle: 19,
    stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24,
    eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27, endPath: 28,
    setStrokeRGBColor: 58, setStrokeGray: 51,
  },
}));

// Synthetic font: a 500×700-unit square glyph per character. The mock feeds
// the PRODUCTION command→points conversion in textObjectToPaths; only the
// font FILE loading (fetch — unavailable in jsdom) is substituted.
vi.mock("opentype.js", () => {
  const makeFont = () => ({
    unitsPerEm: 1000,
    stringToGlyphs: (text: string) =>
      text.split("").map(() => ({
        advanceWidth: 500,
        getPath: () => ({
          commands: [
            { type: "M", x: 0, y: 0 },
            { type: "L", x: 500, y: 0 },
            { type: "L", x: 500, y: -700 },
            { type: "L", x: 0, y: -700 },
            { type: "Z" },
          ],
        }),
      })),
  });
  return {
    default: {
      load: vi.fn().mockImplementation(() => Promise.resolve(makeFont())),
    },
  };
});

import opentype from "opentype.js";
import { useStore } from "../../app/store";
import type { DesignObject, PathPoint } from "../../app/types";
import { assertPointsInvariant } from "../geometry/__tests__/pointsInvariant";
import { importDxfDirect } from "../fileOps/dxfImport";
import { extractVectorPaths } from "../fileOps/pdfImport";
import { _testImportSvgWithLayers } from "../../components/panels/SvgImportDialog";
import { buildTracedPathObjects } from "../../components/panels/ImageTraceDialog";
import { textObjectToPaths } from "../../app/store/geometryActions";
import {
  handleViewportPointerDown,
  handleViewportPointerMove,
  handleViewportPointerUp,
  handleViewportDoubleClick,
  deleteSelectedNode,
  _testHitTest,
} from "../tools/toolHandler";

function pe(): React.PointerEvent {
  return { ctrlKey: false, shiftKey: false, button: 0 } as unknown as React.PointerEvent;
}

function sweepStore() {
  for (const obj of useStore.getState().objects) assertPointsInvariant(obj);
}

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

function makeRect(id: string, x: number, y: number, w: number, h: number, cornerRadius = 0): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x, y, width: w, height: h, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    cornerRadius: cornerRadius || undefined,
  };
}

beforeEach(() => {
  useStore.setState({
    objects: [],
    objectsById: new Map(),
    selectedIds: [],
    selectedSet: new Set(),
    undoStack: [],
    redoStack: [],
    activeTool: "select",
    snapToGrid: false,
    guides: [],
    camera: { x: 0, y: 0, zoom: 1 },
    drawingObject: null,
    nodeEditState: { pathId: null, selectedNodeIndex: null },
  });
});

describe("SVG import", () => {
  it("typical path satisfies the invariant", () => {
    _testImportSvgWithLayers(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
         <path d="M 10 10 C 20 0 40 0 50 10 L 50 50 Z" stroke="#000"/>
       </svg>`,
      null,
    );
    expect(useStore.getState().objects.length).toBeGreaterThan(0);
    sweepStore();
  });

  it("DEGENERATE: horizontal segment imports with true zero-height bbox and stays clickable", () => {
    _testImportSvgWithLayers(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
         <path d="M 10 50 L 90 50" stroke="#000"/>
       </svg>`,
      null,
    );
    const obj = useStore.getState().objects[0];
    expect(obj.transform.height).toBe(0); // no ||1 clamp
    expect(obj.transform.width).toBeCloseTo(80, 6);
    sweepStore();
    // ε hit-band: 2mm off the line still selects; 5mm off misses
    expect(_testHitTest(50, 52)).toBe(obj.id);
    expect(_testHitTest(50, 55)).toBeNull();
  });
});

describe("DXF import", () => {
  it("typical polyline + arc satisfy the invariant", () => {
    importDxfDirect(`0
SECTION
2
ENTITIES
0
LWPOLYLINE
70
1
10
0.0
20
0.0
10
10.0
20
0.0
10
10.0
20
8.0
0
ARC
10
30.0
20
30.0
40
5.0
50
0
51
180
0
ENDSEC
0
EOF`);
    expect(useStore.getState().objects.length).toBe(2);
    sweepStore();
  });

  it("DEGENERATE: collinear horizontal polyline gets a true zero-height bbox", () => {
    importDxfDirect(`0
SECTION
2
ENTITIES
0
LWPOLYLINE
70
0
10
5.0
20
40.0
10
25.0
20
40.0
10
60.0
20
40.0
0
ENDSEC
0
EOF`);
    const obj = useStore.getState().objects[0];
    expect(obj.type).toBe("path");
    expect(obj.transform.height).toBe(0);
    expect(obj.transform.width).toBeCloseTo(55, 6);
    sweepStore();
    expect(_testHitTest(30, 41)).toBe(obj.id); // ε band keeps it clickable
  });
});

describe("PDF import", () => {
  async function extract(build: (OPS: Record<string, number>) => { fnArray: number[]; argsArray: unknown[][] }) {
    const { OPS } = await import("pdfjs-dist");
    const opList = build(OPS as unknown as Record<string, number>);
    const page = { getOperatorList: () => Promise.resolve(opList) };
    let n = 0;
    return extractVectorPaths(page, 100, () => `pdf_${++n}`, 0);
  }

  it("typical path (with bezier) satisfies the anchors-only invariant", async () => {
    const objects = await extract((OPS) => ({
      fnArray: [OPS.moveTo, OPS.curveTo, OPS.lineTo, OPS.stroke],
      argsArray: [[10, 10], [20, 40, 60, 40, 70, 10], [70, 70], []],
    }));
    expect(objects.length).toBe(1);
    // handles overshoot the anchor bbox — the invariant must be anchors-only
    for (const o of objects) assertPointsInvariant(o);
  });

  it("DEGENERATE: axis-parallel segment gets a true zero-thickness bbox", async () => {
    const objects = await extract((OPS) => ({
      fnArray: [OPS.moveTo, OPS.lineTo, OPS.stroke],
      argsArray: [[10, 50], [90, 50], []],
    }));
    expect(objects.length).toBe(1);
    expect(objects[0].transform.height).toBe(0); // no ||1 clamp
    assertPointsInvariant(objects[0]);
  });
});

describe("image trace", () => {
  const imgT = { x: 10, y: 20, width: 50, height: 30, rotation: 0, scaleX: 1, scaleY: 1 };

  it("typical traced path satisfies the invariant", () => {
    const objects = buildTracedPathObjects(
      `<svg><path d="M 0 0 L 100 0 L 100 80 Z"/></svg>`,
      imgT, 100, 80, 0, "#4a90e2",
    );
    expect(objects.length).toBe(1);
    for (const o of objects) assertPointsInvariant(o);
  });

  it("DEGENERATE: collinear trace output gets a true zero-height bbox", () => {
    const objects = buildTracedPathObjects(
      `<svg><path d="M 0 40 L 100 40"/></svg>`,
      imgT, 100, 80, 0, "#4a90e2",
    );
    expect(objects.length).toBe(1);
    expect(objects[0].transform.height).toBe(0);
    assertPointsInvariant(objects[0]);
  });

  // Fix 1: Multi-element trace → top-level group
  it("Fix 1: multiple traced paths from one image are wrapped in a single group", () => {
    // Two separate <path> elements (simulating e.g. two letters from vtracer)
    const svg = [
      `<svg>`,
      `<path d="M 0 0 L 20 0 L 20 20 L 0 20 Z"/>`,
      `<path d="M 30 0 L 50 0 L 50 20 L 30 20 Z"/>`,
      `</svg>`,
    ].join("\n");
    const objects = buildTracedPathObjects(svg, imgT, 100, 80, 0, "#4a90e2", "sign.png");
    // Fix 1: multiple paths → one group
    expect(objects.length).toBe(1);
    expect(objects[0].type).toBe("group");
    expect(objects[0].name).toBe("Trace: sign.png");
    // Children are the two traced paths
    expect(objects[0].children?.length).toBeGreaterThanOrEqual(2);
    assertPointsInvariant(objects[0]);
  });

  // Fix 2: Winding normalization
  it("Fix 2: CW-wound closed paths are normalized to CCW after trace", () => {
    // A CW square in screen coords (Y-down): going right→down→left→up gives negative signedArea
    // per the shoelace formula with Y-down. vtracer sometimes emits these.
    // After buildTracedPathObjects, all closed paths should have positive signedArea (CCW).
    const svg = `<svg><path d="M 0 10 L 0 0 L 10 0 L 10 10 Z"/></svg>`;
    const objects = buildTracedPathObjects(svg, imgT, 100, 80, 0, "#4a90e2");
    expect(objects.length).toBe(1);
    expect(objects[0].type).toBe("path");
    const pts = objects[0].points!;
    const area = pts.reduce((acc, p, i) => {
      const j = (i + 1) % pts.length;
      return acc + p.x * pts[j].y - pts[j].x * p.y;
    }, 0) / 2;
    // CCW in screen Y-down coords = positive signedArea
    expect(area).toBeGreaterThanOrEqual(0);
  });
});

describe("pen tool (pointer pipeline)", () => {
  it("committed pen path satisfies the invariant", () => {
    useStore.setState({ activeTool: "pen" });
    handleViewportPointerDown(10, 10, pe());
    handleViewportPointerUp(10, 10, pe());
    handleViewportPointerDown(40, 10, pe());
    handleViewportPointerUp(40, 10, pe());
    handleViewportPointerDown(40, 30, pe());
    handleViewportPointerUp(40, 30, pe());
    handleViewportDoubleClick(40, 30); // commit
    const objects = useStore.getState().objects;
    expect(objects.length).toBe(1);
    sweepStore();
  });

  it("DEGENERATE: collinear pen path is born with a zero-height bbox (no clamp)", () => {
    useStore.setState({ activeTool: "pen" });
    handleViewportPointerDown(10, 10, pe());
    handleViewportPointerUp(10, 10, pe());
    handleViewportPointerDown(30, 10, pe());
    handleViewportPointerUp(30, 10, pe());
    handleViewportPointerDown(60, 10, pe());
    handleViewportPointerUp(60, 10, pe());
    handleViewportDoubleClick(60, 10);
    const obj = useStore.getState().objects[0];
    expect(obj.transform.height).toBe(0);
    sweepStore();
  });
});

describe("text to path", () => {
  it("convertTextToPath FALLBACK (font load failure) creates an invariant-coherent box path", async () => {
    (opentype.load as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no font in jsdom"));
    const text = { ...makeText("t1", "A"), transform: { x: 20, y: 30, width: 40, height: 18, rotation: 0, scaleX: 1, scaleY: 1 } };
    useStore.getState().addObject(text);
    await useStore.getState().convertTextToPath("t1");
    const obj = useStore.getState().objects.find((o) => o.id === "t1")!;
    expect(obj.type).toBe("path");
    assertPointsInvariant(obj);
  });

  it("textObjectToPaths glyph output satisfies the invariant (synthetic font)", async () => {
    const objects = await textObjectToPaths(makeText("t2", "AB"));
    expect(objects.length).toBe(2);
    for (const o of objects) assertPointsInvariant(o);
  });
});

describe("convertToPath / booleans / offset", () => {
  it("convertToPath on rect, rounded rect, and ellipse", () => {
    useStore.getState().addObject(makeRect("r1", 10, 10, 30, 20));
    useStore.getState().addObject(makeRect("r2", 50, 10, 30, 20, 5));
    useStore.getState().addObject({ ...makeRect("e1", 90, 10, 30, 20), type: "ellipse" });
    useStore.getState().convertToPath("r1");
    useStore.getState().convertToPath("r2");
    useStore.getState().convertToPath("e1");
    for (const id of ["r1", "r2", "e1"]) {
      const obj = useStore.getState().objects.find((o) => o.id === id)!;
      expect(obj.type).toBe("path");
      assertPointsInvariant(obj);
    }
  });

  it("boolean union result paths satisfy the invariant", () => {
    useStore.getState().addObject(makeRect("r1", 0, 0, 20, 20));
    useStore.getState().addObject(makeRect("r2", 10, 10, 20, 20));
    useStore.getState().setSelectedIds(["r1", "r2"]);
    useStore.getState().booleanUnion();
    const paths = useStore.getState().objects.filter((o) => o.type === "path");
    expect(paths.length).toBeGreaterThan(0);
    sweepStore();
  });

  it("offset result paths satisfy the invariant", () => {
    useStore.getState().addObject(makeRect("r1", 10, 10, 30, 20));
    useStore.getState().setSelectedIds(["r1"]);
    useStore.getState().offsetPaths(2);
    const paths = useStore.getState().objects.filter((o) => o.type === "path");
    expect(paths.length).toBe(1);
    sweepStore();
  });
});

describe("node edits (the mutating writers, through production paths)", () => {
  function addEditablePath(): DesignObject {
    const points: PathPoint[] = [
      { x: 10, y: 10 },
      { x: 40, y: 10 },
      { x: 40, y: 40 },
    ];
    const obj: DesignObject = {
      id: "np1",
      type: "path",
      name: "NodePath",
      transform: { x: 10, y: 10, width: 30, height: 30, rotation: 0, scaleX: 1, scaleY: 1 },
      layerIndex: 0,
      visible: true,
      locked: false,
      fill: null,
      stroke: "#4a90e2",
      strokeWidth: 1,
      opacity: 1,
      points,
      closed: true,
    };
    useStore.getState().addObject(obj);
    return obj;
  }

  it("handleNodeMove keeps transform ≡ pointsBBox while a node drags", () => {
    addEditablePath();
    useStore.setState({ activeTool: "node" });
    useStore.getState().setNodeEditState({ pathId: "np1", selectedNodeIndex: null });

    handleViewportPointerDown(40, 40, pe()); // grab the (40,40) anchor
    handleViewportPointerMove(70, 60, pe());
    const mid = useStore.getState().objects.find((o) => o.id === "np1")!;
    expect(mid.points![2]).toMatchObject({ x: 70, y: 60 });
    assertPointsInvariant(mid); // invariant holds DURING the drag
    handleViewportPointerUp(70, 60, pe());
    assertPointsInvariant(useStore.getState().objects.find((o) => o.id === "np1")!);
  });

  it("deleteSelectedNode shrinks the bbox coherently", () => {
    addEditablePath();
    useStore.setState({ activeTool: "node" });
    useStore.getState().setNodeEditState({ pathId: "np1", selectedNodeIndex: 2 });
    deleteSelectedNode();
    const obj = useStore.getState().objects.find((o) => o.id === "np1")!;
    expect(obj.points!.length).toBe(2);
    expect(obj.transform).toMatchObject({ x: 10, y: 10, width: 30, height: 0 });
    assertPointsInvariant(obj);
  });

  it("toggle-smooth (double-click) keeps the invariant (handles excluded from bbox)", () => {
    addEditablePath();
    useStore.setState({ activeTool: "node" });
    useStore.getState().setNodeEditState({ pathId: "np1", selectedNodeIndex: null });
    handleViewportDoubleClick(40, 10); // toggle smooth on the middle anchor
    const obj = useStore.getState().objects.find((o) => o.id === "np1")!;
    expect(obj.points![1].handleIn || obj.points![1].handleOut).toBeTruthy();
    assertPointsInvariant(obj);
  });
});
