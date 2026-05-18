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
    expect(objects[0].points![0]).toEqual({ x: 0, y: 0 });
    expect(objects[0].points![1]).toEqual({ x: 50, y: 30 });
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
