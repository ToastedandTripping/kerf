/**
 * W1b — F1 writer tests for the store-level translation mechanisms:
 * align, distribute, multi-flip positions, gridArray, circularArray, nest,
 * group/ungroup (group-local points convention), and the aliasing regressions
 * (duplicate shares no points arrays; Ctrl+Z after grouping restores children).
 *
 * Each path test asserts: points (incl. handles) moved by the delta, the
 * flatten/cut output follows, and the transform≡pointsBBox invariant holds.
 * Rect twins pin unchanged primitive behavior (characterization).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { useStore } from "../index";
import type { DesignObject, PathPoint } from "../../types";
import { movePartial } from "../../../lib/geometry";
import { assertPointsInvariant } from "../../../lib/geometry/__tests__/pointsInvariant";
import { flattenObjectsForTest } from "../../../lib/machine/gcodeGen";

function makePath(id: string, ox = 0, oy = 0): DesignObject {
  const points: PathPoint[] = [
    { x: ox + 0, y: oy + 0, handleOut: { x: ox + 5, y: oy - 5 } },
    { x: ox + 20, y: oy + 0, handleIn: { x: ox + 15, y: oy - 5 } },
    { x: ox + 20, y: oy + 10 },
    { x: ox + 0, y: oy + 10 },
  ];
  return {
    id,
    type: "path",
    name: `Path ${id}`,
    transform: { x: ox, y: oy, width: 20, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
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
}

function makeRect(id: string, x: number, y: number, w = 20, h = 10): DesignObject {
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
    clipboard: [],
    workspaceWidth: 500,
    workspaceHeight: 300,
  });
});

describe("alignObjects moves path points", () => {
  it("align left shifts points, handles, flatten output; invariant holds", () => {
    useStore.getState().addObject(makeRect("r1", 0, 0));
    useStore.getState().addObject(makePath("p1", 50, 30));
    useStore.getState().setSelectedIds(["r1", "p1"]);
    useStore.getState().alignObjects("left");

    const p = get("p1");
    expect(p.transform.x).toBe(0);
    expect(p.points![0]).toMatchObject({ x: 0, y: 30 }); // shifted by -50
    expect(p.points![0].handleOut).toEqual({ x: 5, y: 25 });
    assertPointsInvariant(p);
    const flat = flattenObjectsForTest(useStore.getState().objects);
    expect(flat.find((o) => o.id === "p1")!.points![0].x).toBe(0);
    // rect characterization
    expect(get("r1").transform.x).toBe(0);
  });

  it("align bottom shifts path points vertically", () => {
    useStore.getState().addObject(makeRect("r1", 0, 100));
    useStore.getState().addObject(makePath("p1", 50, 0));
    useStore.getState().setSelectedIds(["r1", "p1"]);
    useStore.getState().alignObjects("bottom");
    const p = get("p1");
    expect(p.transform.y).toBe(100); // bottom 110 - height 10
    expect(p.points![0].y).toBe(100);
    assertPointsInvariant(p);
  });
});

describe("distributeObjects moves path points", () => {
  it("horizontal distribute shifts the middle path's points", () => {
    useStore.getState().addObject(makeRect("r1", 0, 0));
    useStore.getState().addObject(makePath("p1", 30, 0));
    useStore.getState().addObject(makeRect("r2", 100, 0));
    useStore.getState().setSelectedIds(["r1", "p1", "r2"]);
    useStore.getState().distributeObjects("horizontal");
    const p = get("p1");
    // span 0..120, total width 60, gap (120-60)/2 = 30 → middle at x=50
    expect(p.transform.x).toBe(50);
    expect(p.points![0].x).toBe(50);
    assertPointsInvariant(p);
  });
});

describe("multi-flip mirrors path geometry and repositions (F29)", () => {
  it("horizontal multi-flip mirrors path points across the selection axis", () => {
    // p1: path at x=0..20 (width 20), r1: rect at x=80..100 (width 20)
    // Selection spans x=0..100. Flip axis = x=50 (allLeft+allRight = 100, mirror = 100-x).
    useStore.getState().addObject(makePath("p1", 0, 0));
    useStore.getState().addObject(makeRect("r1", 80, 0));
    useStore.getState().setSelectedIds(["p1", "r1"]);
    useStore.getState().flipObjects("horizontal");
    const p = get("p1");
    // F29: path is mirrored geometrically — points x' = 100 - x
    // Original point[0] at x=0 → mirrored to x=100; point[1] at x=20 → x=80
    // pointsBBox of mirrored points: x=80..100, so transform.x=80
    expect(p.transform.x).toBe(80); // AABB left of mirrored points
    expect(p.points![0].x).toBe(100); // first point is mirrored to the far end
    assertPointsInvariant(p);
    // rect is also mirrored in position (and scaleX negated)
    expect(get("r1").transform.x).toBe(0);
    expect(get("r1").transform.scaleX).toBe(-1);
  });
});

describe("gridArray / circularArray copies", () => {
  it("gridArray copies carry shifted points and share NO arrays with the original", () => {
    useStore.getState().addObject(makePath("p1", 0, 0));
    useStore.getState().setSelectedIds(["p1"]);
    useStore.getState().gridArray(1, 2, 5, 5); // one copy at x + (20 + 5)
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(2);
    const copy = objects[1];
    expect(copy.transform.x).toBe(25);
    expect(copy.points![0]).toMatchObject({ x: 25, y: 0 });
    expect(copy.points![0].handleOut).toEqual({ x: 30, y: -5 });
    assertPointsInvariant(copy);
    // aliasing: arrays and point objects are fresh
    const original = get("p1");
    expect(copy.points).not.toBe(original.points);
    expect(copy.points![0]).not.toBe(original.points![0]);
  });

  it("circularArray copies carry moved points and the rotation field", () => {
    useStore.getState().addObject(makePath("p1", 0, 0));
    useStore.getState().setSelectedIds(["p1"]);
    useStore.getState().circularArray(2, 50, 0); // one copy at 180°
    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(2);
    const copy = objects[1];
    // center (10,5); copy center = (10,5) + 50·(cos180, sin180) = (-40, 5)
    expect(copy.transform.x).toBeCloseTo(-50, 6);
    expect(copy.points![0].x).toBeCloseTo(-50, 6);
    expect(copy.transform.rotation).toBeCloseTo(180, 6);
    assertPointsInvariant(copy);
  });
});

describe("nestObjects placement", () => {
  it("nest placement moves path points with the transform", async () => {
    useStore.getState().addObject(makePath("p1", 200, 150));
    useStore.getState().setSelectedIds(["p1"]);
    const result = await useStore.getState().nestObjects({
      spacing: 2,
      rotation: "none",
      useSelection: true,
    });
    expect(result.placed).toHaveLength(1);
    const p = get("p1");
    assertPointsInvariant(p);
    // placement is algorithm-defined; the contract is points ≡ transform
    expect(p.points![0].x).toBeCloseTo(p.transform.x, 6);
    expect(p.points![0].y).toBeCloseTo(p.transform.y, 6);
    const flat = flattenObjectsForTest(useStore.getState().objects);
    expect(flat[0].points![0].x).toBeCloseTo(p.transform.x, 6);
  });
});

describe("group / ungroup (group-local points convention)", () => {
  it("grouping re-bases child path POINTS to group-local alongside the transform", () => {
    useStore.getState().addObject(makePath("p1", 50, 30));
    useStore.getState().addObject(makeRect("r1", 100, 30));
    useStore.getState().setSelectedIds(["p1", "r1"]);
    useStore.getState().groupSelected();

    const group = useStore.getState().objects.find((o) => o.type === "group")!;
    expect(group.transform).toMatchObject({ x: 50, y: 30 });
    const child = group.children!.find((c) => c.id === "p1")!;
    expect(child.transform).toMatchObject({ x: 0, y: 0 });
    expect(child.points![0]).toMatchObject({ x: 0, y: 0 }); // group-local now
    expect(child.points![0].handleOut).toEqual({ x: 5, y: -5 });
    assertPointsInvariant(group);

    // flatten reproduces the original world geometry exactly
    const flat = flattenObjectsForTest(useStore.getState().objects);
    const flatPath = flat.find((o) => o.id === "p1")!;
    expect(flatPath.points![0]).toMatchObject({ x: 50, y: 30 });
  });

  it("group-move then ungroup: children land where they appeared", () => {
    useStore.getState().addObject(makePath("p1", 50, 30));
    useStore.getState().addObject(makeRect("r1", 100, 30));
    useStore.getState().setSelectedIds(["p1", "r1"]);
    useStore.getState().groupSelected();
    const group = useStore.getState().objects.find((o) => o.type === "group")!;

    // move the group by (+10, +20) through the store writer
    useStore.getState().updateObject(group.id, {
      transform: { ...group.transform, x: group.transform.x + 10, y: group.transform.y + 20 },
    });

    // flatten shows both children moved by the delta
    const flat = flattenObjectsForTest(useStore.getState().objects);
    expect(flat.find((o) => o.id === "p1")!.points![0]).toMatchObject({ x: 60, y: 50 });
    expect(flat.find((o) => o.id === "r1")!.transform).toMatchObject({ x: 110, y: 50 });

    // ungroup: children expand to world coords where they appeared
    useStore.getState().setSelectedIds([group.id]);
    useStore.getState().ungroupSelected();
    const p = get("p1");
    expect(p.transform).toMatchObject({ x: 60, y: 50 });
    expect(p.points![0]).toMatchObject({ x: 60, y: 50 });
    expect(p.points![0].handleOut).toEqual({ x: 65, y: 45 });
    assertPointsInvariant(p);
    expect(get("r1").transform).toMatchObject({ x: 110, y: 50 });
  });

  it("ALIASING: Ctrl+Z after grouping restores children to pre-group absolute positions", () => {
    // the group re-base must be pure — an in-place re-base would mutate the
    // points arrays shared with the withUndo before-snapshot, teleporting
    // children to group-local coords near the origin on undo.
    useStore.getState().addObject(makePath("p1", 50, 30));
    useStore.getState().addObject(makeRect("r1", 100, 30));
    useStore.getState().setSelectedIds(["p1", "r1"]);
    useStore.getState().groupSelected();

    useStore.getState().undo();
    const p = get("p1");
    expect(p.points![0]).toMatchObject({ x: 50, y: 30 }); // NOT (0,0)
    expect(p.points![0].handleOut).toEqual({ x: 55, y: 25 });
    expect(p.transform).toMatchObject({ x: 50, y: 30 });
    assertPointsInvariant(p);
  });

  it("ALIASING: move the original after duplicate — the duplicate must not follow", () => {
    // duplicateInPlace shallow-copies the object, so the duplicate SHARES the
    // original's points array. That sharing is safe only because every writer
    // is pure — this test breaks if any move writer mutates in place.
    useStore.getState().addObject(makePath("p1", 0, 0));
    useStore.getState().setSelectedIds(["p1"]);
    useStore.getState().duplicateInPlace();
    const dupId = useStore.getState().objects[1].id;

    // move the original by (+5, 0) through the store writer path (same
    // updateObject(movePartial(...)) call shortcuts' nudge makes)
    const p1 = get("p1");
    useStore.getState().updateObject("p1", movePartial(p1, p1.transform.x + 5, p1.transform.y));

    const dup = get(dupId);
    expect(dup.points![0]).toMatchObject({ x: 0, y: 0 }); // unchanged
    expect(dup.points![0].handleOut).toEqual({ x: 5, y: -5 });
    expect(get("p1").points![0]).toMatchObject({ x: 5, y: 0 });
    assertPointsInvariant(dup);
  });
});
