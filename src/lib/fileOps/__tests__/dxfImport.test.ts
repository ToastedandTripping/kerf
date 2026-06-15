import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../../../app/store";

// We test parseDxfManual indirectly through importDxfDirect
import { importDxfDirect } from "../dxfImport";

const MINIMAL_DXF_LINE = `0
SECTION
2
ENTITIES
0
LINE
10
0.0
20
0.0
11
50.0
21
30.0
0
ENDSEC
0
EOF`;

const MINIMAL_DXF_CIRCLE = `0
SECTION
2
ENTITIES
0
CIRCLE
10
25.0
20
25.0
40
10.0
0
ENDSEC
0
EOF`;

const MINIMAL_DXF_LWPOLYLINE = `0
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
10.0
10
0.0
20
10.0
0
ENDSEC
0
EOF`;

describe("DXF Import", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      selectedIds: [],
      undoStack: [],
      redoStack: [],
    });
  });

  it("imports a LINE entity", () => {
    importDxfDirect(MINIMAL_DXF_LINE);
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("line");
    expect(objects[0].points).toBeDefined();
    expect(objects[0].points!.length).toBe(2);
    // DXF Y-up is flipped to screen Y-down (F23).
    // Source: (0,0)→(50,30) in Y-up. After flip (maxY=30): y' = 30 - y.
    // (0,0) → (0,30), (50,30) → (50,0).
    expect(objects[0].points![0]).toEqual({ x: 0, y: 30 });
    expect(objects[0].points![1]).toEqual({ x: 50, y: 0 });
  });

  it("imports a CIRCLE entity as ellipse", () => {
    importDxfDirect(MINIMAL_DXF_CIRCLE);
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("ellipse");
    expect(objects[0].transform.width).toBe(20); // radius * 2
    expect(objects[0].transform.height).toBe(20);
    expect(objects[0].transform.x).toBe(15); // cx - r
    expect(objects[0].transform.y).toBe(15);
  });

  it("imports a closed LWPOLYLINE as path", () => {
    importDxfDirect(MINIMAL_DXF_LWPOLYLINE);
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("path");
    expect(objects[0].closed).toBe(true);
    expect(objects[0].points!.length).toBe(4);
  });

  it("reports error to console for empty DXF", () => {
    importDxfDirect("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF");
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(0);
    const consoleLines = useStore.getState().consoleLines;
    expect(consoleLines.some((l) => l.type === "error")).toBe(true);
  });
});

// F23: Y-flip, $INSUNITS, bulge, unsupported entity surfacing
describe("DXF Import — F23 fixes", () => {
  beforeEach(() => {
    useStore.setState({ objects: [], selectedIds: [], undoStack: [], redoStack: [] });
  });

  it("F23 Y-flip: Y coordinates are inverted (DXF Y-up → screen Y-down)", () => {
    // LINE from (0,0) to (0,100) in DXF Y-up.
    // After flip: (0,100) → y=0, (0,0) → y=100.
    const dxf = `0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0.0\n20\n0.0\n11\n0.0\n21\n100.0\n0\nENDSEC\n0\nEOF`;
    importDxfDirect(dxf);
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    const pts = objects[0].points!;
    // (0,0) in DXF Y-up becomes y=100 in screen Y-down
    expect(pts[0].y).toBeCloseTo(100, 5);
    // (0,100) in DXF Y-up becomes y=0 in screen Y-down
    expect(pts[1].y).toBeCloseTo(0, 5);
  });

  it("F23 $INSUNITS=1 (inches): coordinates scaled ×25.4", () => {
    // 1 inch LINE should become 25.4mm
    const dxf = `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n1\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0.0\n20\n0.0\n11\n1.0\n21\n0.0\n0\nENDSEC\n0\nEOF`;
    importDxfDirect(dxf);
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    const pts = objects[0].points!;
    // x2 = 1 inch × 25.4 = 25.4mm
    expect(pts[1].x).toBeCloseTo(25.4, 3);
  });

  it("F23 LWPOLYLINE bulge: non-zero bulge produces arc points (more than 2)", () => {
    // Square with bulge=1 on all sides (full circles effectively).
    // We just need to verify that bulge generates extra arc points.
    const dxf = `0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n70\n0\n10\n0.0\n20\n0.0\n42\n0.5\n10\n10.0\n20\n0.0\n0\nENDSEC\n0\nEOF`;
    importDxfDirect(dxf);
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(1);
    // With bulge=0.5 between the two vertices, we expect arc points > 2
    expect(objects[0].points!.length).toBeGreaterThan(2);
  });

  it("F23 unsupported entity: console message emitted (not silent drop)", () => {
    const dxf = `0\nSECTION\n2\nENTITIES\n0\nSPLINE\n10\n0.0\n20\n0.0\n0\nLINE\n10\n0.0\n20\n0.0\n11\n10.0\n21\n10.0\n0\nENDSEC\n0\nEOF`;
    importDxfDirect(dxf);
    const objects = useStore.getState().objects;
    // LINE is imported, SPLINE is skipped
    expect(objects).toHaveLength(1);
    // Console should have a line mentioning the skipped entity
    const consoleLines = useStore.getState().consoleLines;
    const hasWarning = consoleLines.some((l) => l.text.includes("SPLINE") || l.text.includes("skipped"));
    expect(hasWarning).toBe(true);
  });
});
