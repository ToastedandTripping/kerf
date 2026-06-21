/**
 * W1b — load-time migration tests: repair the wild files, preserve what the
 * user SAW (= what the current binary renders), through the ONE load wrapper
 * every loader routes through (openProject, openRecentFile, recovery restore,
 * newProject).
 *
 * Legacy defect model under test:
 *  (a) top-level paths with transform desynced by failed moves (rot==0)
 *  (b) top-level rotated paths desynced (bake about the OLD transform center)
 *  (c) group children with world-absolute points (old convention)
 *  (d) NESTED legacy groups — grandchild re-base must subtract the COMPOSED
 *      world origin, not the immediate parent's local x/y
 *  (e) legacy flips (scaleX/scaleY = -1) — flip bake runs FIRST, then sync
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { useStore } from "../../../app/store";
import type { DesignObject, KerfProject, Layer, PathPoint } from "../../../app/types";
import { DEFAULT_LAYERS, KERF_FORMAT_VERSION } from "../../../app/types";
import { loadProjectWithMigrations, migrateSpeedToMmMin, fileOperations } from "../index";
import { assertPointsInvariant, pointsBBox, rotatePathPoint } from "../../geometry";
import { flattenObjectsForTest } from "../../machine/gcodeGen";

function legacyPath(
  id: string,
  points: PathPoint[],
  transform: Partial<DesignObject["transform"]> = {},
): DesignObject {
  const bb = pointsBBox(points);
  return {
    id,
    type: "path",
    name: `Path ${id}`,
    transform: {
      x: bb.x, y: bb.y, width: bb.width, height: bb.height,
      rotation: 0, scaleX: 1, scaleY: 1,
      ...transform,
    },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    points,
    closed: false,
  };
}

function legacyGroup(id: string, x: number, y: number, w: number, h: number, children: DesignObject[], rotation = 0): DesignObject {
  return {
    id,
    type: "group",
    name: `Group ${id}`,
    transform: { x, y, width: w, height: h, rotation, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#ffffff",
    strokeWidth: 0,
    opacity: 1,
    children,
  };
}

/** A legacy project: NO formatVersion field (that's the legacy marker). */
function legacyProject(objects: DesignObject[]): KerfProject {
  return {
    version: "0.5.0",
    name: "Legacy",
    objects,
    layers: DEFAULT_LAYERS,
    camera: { x: 0, y: 0, zoom: 1 },
    workspaceWidth: 500,
    workspaceHeight: 300,
  };
}

const get = (id: string) => useStore.getState().objects.find((o) => o.id === id)!;

beforeEach(() => {
  useStore.setState({
    objects: [],
    objectsById: new Map(),
    selectedIds: [],
    selectedSet: new Set(),
    undoStack: [],
    redoStack: [],
    isDirty: false,
    projectPath: null,
  });
});

describe("top-level repair", () => {
  it("(a) rot==0 desynced path: transform := pointsBBox, points UNTOUCHED (zero visual change)", () => {
    const p = legacyPath("p1", [{ x: 10, y: 10, handleOut: { x: 15, y: 8 } }, { x: 30, y: 20 }], {
      x: 75, y: 80, // failed moves corrupted the transform; points are the rendered truth
    });
    loadProjectWithMigrations(legacyProject([p]));
    const m = get("p1");
    expect(m.points![0]).toMatchObject({ x: 10, y: 10 });
    expect(m.points![0].handleOut).toEqual({ x: 15, y: 8 });
    expect(m.transform).toMatchObject({ x: 10, y: 10, width: 20, height: 10 });
    assertPointsInvariant(m);
  });

  it("(b) rot≠0 desynced path: rotation baked about the OLD transform center, appearance preserved", () => {
    const points: PathPoint[] = [{ x: 10, y: 10, handleOut: { x: 15, y: 8 } }, { x: 30, y: 20 }];
    // legacy old transform (desynced): center (50, 50); render/cut pivot rotation there
    const p = legacyPath("p1", points, { x: 40, y: 45, width: 20, height: 10, rotation: 90 });
    const oldCx = 40 + 10, oldCy = 45 + 5;
    loadProjectWithMigrations(legacyProject([p]));
    const m = get("p1");
    expect(m.transform.rotation).toBe(0); // field baked (lossy on the field, exact visually)
    const exp0 = rotatePathPoint(points[0], oldCx, oldCy, 90);
    const exp1 = rotatePathPoint(points[1], oldCx, oldCy, 90);
    expect(m.points![0].x).toBeCloseTo(exp0.x, 9);
    expect(m.points![0].y).toBeCloseTo(exp0.y, 9);
    expect(m.points![0].handleOut!.x).toBeCloseTo(exp0.handleOut!.x, 9);
    expect(m.points![1].x).toBeCloseTo(exp1.x, 9);
    assertPointsInvariant(m);
  });

  it("(b2) rot≠0 COHERENT path: left untouched (rotation field survives)", () => {
    const points: PathPoint[] = [{ x: 10, y: 10 }, { x: 30, y: 20 }];
    const p = legacyPath("p1", points, { rotation: 45 }); // transform == pointsBBox
    loadProjectWithMigrations(legacyProject([p]));
    const m = get("p1");
    expect(m.transform.rotation).toBe(45);
    expect(m.points![0]).toMatchObject({ x: 10, y: 10 });
    assertPointsInvariant(m);
  });
});

describe("legacy group children (world-absolute points → group-local)", () => {
  it("(c) moved-group variant: rebase preserves the legacy rendered truth (raw absolute points)", () => {
    // Legacy: group moved to (50, 60) after creation; child points stayed
    // absolute at (10,10)-(30,20) and the legacy binary RENDERED them there
    // (group translation was dropped for paths — that's F1).
    const child = legacyPath("c1", [{ x: 10, y: 10, handleOut: { x: 15, y: 8 } }, { x: 30, y: 20 }], {
      x: 0, y: 0, // child transform group-local (grouping re-based transforms)
    });
    const group = legacyGroup("g1", 50, 60, 20, 10, [child]);
    loadProjectWithMigrations(legacyProject([group]));

    const g = get("g1");
    const c = g.children![0];
    // points re-based by the group origin
    expect(c.points![0]).toMatchObject({ x: -40, y: -50 });
    expect(c.points![0].handleOut).toEqual({ x: -35, y: -52 });
    assertPointsInvariant(g);

    // flatten reproduces EXACTLY what the legacy binary rendered: absolute (10,10)
    const flat = flattenObjectsForTest(useStore.getState().objects);
    expect(flat[0].points![0].x).toBeCloseTo(10, 9);
    expect(flat[0].points![0].y).toBeCloseTo(10, 9);
    expect(flat[0].points![1].x).toBeCloseTo(30, 9);
  });

  it("(d) NESTED legacy group: grandchild re-bases by the COMPOSED world origin", () => {
    // outer at (100,200); inner transform OUTER-LOCAL at (5,5); grandchild
    // points WORLD-absolute at (105,205)-(115,215) (the legacy convention).
    const grandchild = legacyPath("gc1", [{ x: 105, y: 205 }, { x: 115, y: 215 }], { x: 0, y: 0 });
    const inner = legacyGroup("g-inner", 5, 5, 10, 10, [grandchild]);
    const outer = legacyGroup("g-outer", 100, 200, 15, 15, [inner]);
    loadProjectWithMigrations(legacyProject([outer]));

    const innerM = get("g-outer").children![0];
    const gcM = innerM.children![0];
    // local = world − (outer + inner origins) = (105,205) − (105,205) = (0,0)
    expect(gcM.points![0]).toMatchObject({ x: 0, y: 0 });
    expect(gcM.points![1]).toMatchObject({ x: 10, y: 10 });
    assertPointsInvariant(get("g-outer"));

    // flatten restores the world geometry the legacy binary cut
    const flat = flattenObjectsForTest(useStore.getState().objects);
    expect(flat[0].points![0].x).toBeCloseTo(105, 9);
    expect(flat[0].points![0].y).toBeCloseTo(205, 9);
  });

  it("legacy ROTATED group: plain rebase preserves rendered truth (no extra bake)", () => {
    // Legacy D2 branch rotated ABSOLUTE points about the group's world center.
    // New flatten: R((p_abs − g) + g, center, r_g) — identical by algebra.
    const child = legacyPath("c1", [{ x: 20, y: 30 }, { x: 30, y: 40 }], { x: 0, y: 0 });
    const group = legacyGroup("g1", 20, 30, 10, 10, [child], 90);
    loadProjectWithMigrations(legacyProject([group]));

    const flat = flattenObjectsForTest(useStore.getState().objects);
    // legacy rendered truth: rotate world (20,30) about center (25,35) by 90° = (30,30)
    expect(flat[0].points![0].x).toBeCloseTo(30, 9);
    expect(flat[0].points![0].y).toBeCloseTo(30, 9);
  });
});

describe("flip migration ordering (flip FIRST, then transform-sync)", () => {
  it("(e) legacy flipped+desynced path: points mirror about the OLD transform center, then sync", () => {
    // If the sync ran first, the transform would be re-derived from the points
    // and the flip would mirror about the WRONG center — pin the order.
    const points: PathPoint[] = [{ x: 10, y: 10 }, { x: 30, y: 20 }];
    const p = legacyPath("p1", points, { x: 40, y: 45, width: 20, height: 10, scaleX: -1 });
    const oldCx = 40 + 10; // flip mirrors x about 50 (what the current binary renders)
    loadProjectWithMigrations(legacyProject([p]));
    const m = get("p1");
    expect(m.points![0].x).toBeCloseTo(2 * oldCx - 10, 9); // 90
    expect(m.points![1].x).toBeCloseTo(2 * oldCx - 30, 9); // 70
    expect(m.transform.scaleX).toBe(1);
    // then the sync derived the transform from the FLIPPED points
    expect(m.transform.x).toBeCloseTo(70, 9);
    assertPointsInvariant(m);
  });
});

describe("versioning + idempotency", () => {
  it("stamps formatVersion on the project and skips migration when present", () => {
    const child = legacyPath("c1", [{ x: 10, y: 10 }, { x: 30, y: 20 }], { x: 0, y: 0 });
    const group = legacyGroup("g1", 50, 60, 20, 10, [child]);
    const project = legacyProject([group]);
    loadProjectWithMigrations(project);
    expect(project.formatVersion).toBe(KERF_FORMAT_VERSION);
    const firstPoints = JSON.stringify(get("g1").children![0].points);

    // loading the SAME (now stamped) project again must not re-rebase
    loadProjectWithMigrations(project);
    expect(JSON.stringify(get("g1").children![0].points)).toBe(firstPoints);
  });

  it("toProject stamps formatVersion on every save (autoSave writes through toProject)", () => {
    expect(useStore.getState().toProject().formatVersion).toBe(KERF_FORMAT_VERSION);
  });

  it("migrating an already-coherent legacy file is a visual no-op", () => {
    const p = legacyPath("p1", [{ x: 10, y: 10 }, { x: 30, y: 20 }]); // coherent
    loadProjectWithMigrations(legacyProject([p]));
    const m = get("p1");
    expect(m.points![0]).toMatchObject({ x: 10, y: 10 });
    expect(m.transform).toMatchObject({ x: 10, y: 10, width: 20, height: 10 });
  });
});

describe("robustness + loader contract", () => {
  it("one malformed legacy object logs and passes through; the load still succeeds", () => {
    const bad = { id: "bad", type: "path", points: [{ x: 1, y: 2 }], transform: null } as unknown as DesignObject;
    const good = legacyPath("p1", [{ x: 10, y: 10 }, { x: 30, y: 20 }], { x: 99, y: 99 });
    expect(() => loadProjectWithMigrations(legacyProject([bad, good]))).not.toThrow();
    const m = get("p1");
    expect(m.transform).toMatchObject({ x: 10, y: 10 }); // good object still repaired
    expect(useStore.getState().objects).toHaveLength(2); // bad object passed through
  });

  it("recovery-style load: wrapper migrates AND loadProject clears the undo stacks", () => {
    // recovery restore (App.tsx) hands the parsed recovery JSON to the wrapper —
    // simulate exactly that input shape (legacy recovery files lack formatVersion)
    useStore.setState({ undoStack: [{ type: "x", undo: () => {}, redo: () => {} }], redoStack: [] });
    const recovered = JSON.parse(JSON.stringify(
      legacyProject([legacyPath("p1", [{ x: 10, y: 10 }, { x: 30, y: 20 }], { x: 75, y: 80 })]),
    )) as KerfProject;
    loadProjectWithMigrations(recovered);
    expect(get("p1").transform).toMatchObject({ x: 10, y: 10 });
    expect(useStore.getState().undoStack).toHaveLength(0); // pre-migration undo never survives a load
    expect(useStore.getState().redoStack).toHaveLength(0);
  });

  it("newProject routes through the wrapper (no-op migrations on a fresh literal)", async () => {
    useStore.setState({ isDirty: false });
    await fileOperations.newProject();
    expect(useStore.getState().objects).toHaveLength(0);
    expect(useStore.getState().projectName).toBe("Untitled");
    expect(useStore.getState().projectPath).toBeNull();
  });
});

// ─── Speed-unit migration (v1 → v2) ────────────────────────────────────────

/** A v1 project: formatVersion=1, speeds stored in mm/s convention. */
function v1Project(layerOverrides: Partial<Layer>[] = []): KerfProject {
  return {
    version: "0.8.5",
    formatVersion: 1,
    name: "V1 Project",
    objects: [],
    layers: DEFAULT_LAYERS.map((l, i) => ({
      ...l,
      speed: l.speed / 60, // reverse the mm/min default to simulate a v1 mm/s value
      ...(layerOverrides[i] ?? {}),
    })),
    camera: { x: 0, y: 0, zoom: 1 },
    workspaceWidth: 500,
    workspaceHeight: 300,
  };
}

describe("speed-unit migration (v1 → v2)", () => {
  it("v1 project: layer.speed=20 (mm/s) → 1200 (mm/min) after migration", () => {
    const project: KerfProject = {
      ...legacyProject([]),
      formatVersion: 1,
      layers: [{ ...DEFAULT_LAYERS[2], speed: 20 }], // Cut layer at 20 mm/s
    };
    loadProjectWithMigrations(project);
    const layer = useStore.getState().layers[0];
    expect(layer.speed).toBe(1200);
    expect(project.formatVersion).toBe(2);
  });

  it("v1 project: formatVersion stamped to 2 after speed migration", () => {
    const project = v1Project();
    loadProjectWithMigrations(project);
    expect(project.formatVersion).toBe(KERF_FORMAT_VERSION); // = 2
  });

  it("v2 project: speed NOT re-multiplied (no double-convert)", () => {
    const project: KerfProject = {
      version: "0.9.0",
      formatVersion: 2,
      name: "V2 Project",
      objects: [],
      layers: [{ ...DEFAULT_LAYERS[2], speed: 1200 }],
      camera: { x: 0, y: 0, zoom: 1 },
      workspaceWidth: 500,
      workspaceHeight: 300,
    };
    loadProjectWithMigrations(project);
    expect(useStore.getState().layers[0].speed).toBe(1200); // unchanged
  });

  it("legacy (undefined formatVersion) gets BOTH geometry + speed migrations", () => {
    // Verify the geometry migration ran (transform sync) AND speed migration
    const p = legacyPath("p1", [{ x: 10, y: 10 }, { x: 30, y: 20 }], { x: 75, y: 80 });
    const project: KerfProject = {
      ...legacyProject([p]),
      layers: [{ ...DEFAULT_LAYERS[2], speed: 20 }],
    };
    loadProjectWithMigrations(project);
    // Geometry migration: transform repaired to pointsBBox
    expect(get("p1").transform).toMatchObject({ x: 10, y: 10 });
    // Speed migration: 20 mm/s → 1200 mm/min
    expect(useStore.getState().layers[0].speed).toBe(1200);
  });

  it("v1 project does NOT re-run geometry migration (geometry points unchanged)", () => {
    // A v1 file has formatVersion=1 — the geometry gate (< 1) must NOT fire.
    //
    // Use a DESYNCED + ROTATED path (same fixture as test (b) at line ~116).
    // If the geometry gate incorrectly fires (e.g. gate were `< 2`), migratePointsTransformSync
    // would bake the 90° rotation into the points, visibly moving them away from (10,10)/(30,20).
    // A coherent path with rotation:0 would pass even with a broken gate — that was the
    // tautological flaw this test replaces.
    const points = [{ x: 10, y: 10 }, { x: 30, y: 20 }];
    const p = legacyPath("p1", points, { x: 40, y: 45, width: 20, height: 10, rotation: 90 });
    const project: KerfProject = {
      version: "0.8.5",
      formatVersion: 1,
      name: "V1",
      objects: [p],
      layers: [{ ...DEFAULT_LAYERS[2], speed: 20 }],
      camera: { x: 0, y: 0, zoom: 1 },
      workspaceWidth: 500,
      workspaceHeight: 300,
    };
    loadProjectWithMigrations(project);
    // Points must be UNCHANGED — geometry migration must have been skipped.
    // If the gate misfired, migratePointsTransformSync would have rotated them
    // about the OLD transform center (50, 47.5), producing x≈37.5 for point[0] — not 10.
    expect(get("p1").points![0]).toMatchObject({ x: 10, y: 10 });
    expect(get("p1").points![1]).toMatchObject({ x: 30, y: 20 });
    // Speed IS migrated regardless of format version
    expect(useStore.getState().layers[0].speed).toBe(1200);
  });

  it("migrateSpeedToMmMin is guarded: missing/non-numeric speed fields do not throw", () => {
    const project: KerfProject = {
      version: "0.8.5",
      formatVersion: 1,
      name: "Partial",
      objects: [],
      // Intentionally malformed — speed field absent or wrong type
      layers: [{ ...DEFAULT_LAYERS[2], speed: undefined as unknown as number }],
      camera: { x: 0, y: 0, zoom: 1 },
      workspaceWidth: 500,
      workspaceHeight: 300,
    };
    expect(() => migrateSpeedToMmMin(project)).not.toThrow();
  });

  it("migrateSpeedToMmMin also converts in-project materials", () => {
    const project: KerfProject = {
      version: "0.8.5",
      formatVersion: 1,
      name: "WithMaterials",
      objects: [],
      layers: [{ ...DEFAULT_LAYERS[2], speed: 20 }],
      camera: { x: 0, y: 0, zoom: 1 },
      workspaceWidth: 500,
      workspaceHeight: 300,
      materials: [{
        id: "test", name: "Test", material: "Plywood", thickness: "3mm",
        mode: "line", power: 90, powerMin: 0, speed: 10, passes: 1, airAssist: true, interval: 0.1,
      }],
    };
    migrateSpeedToMmMin(project);
    expect(project.layers[0].speed).toBe(1200);
    expect(project.materials![0].speed).toBe(600);
  });
});
