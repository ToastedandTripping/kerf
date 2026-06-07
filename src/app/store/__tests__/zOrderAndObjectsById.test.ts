/**
 * P3a guard tests — characterization tests that must pass on CURRENT code
 * before the B3/B4 refactors, and must STILL pass after.
 *
 * Covers:
 *  1. Z-order four directions (B4.3 — currently zero coverage)
 *  2. Z-order boundary no-ops
 *  3. objectsById consistency after mutations (B3 — currently unasserted)
 *  4. isDirty preservation after group/ungroup (B3 — currently unasserted)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../index";
import type { DesignObject } from "../../types";

function makeRect(id: string, x = 0, y = 0): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x, y, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

/** Assert objectsById is consistent with objects array */
function assertObjectsByIdConsistent() {
  const { objects, objectsById } = useStore.getState();
  expect(objectsById.size).toBe(objects.length);
  for (const obj of objects) {
    expect(objectsById.get(obj.id)).toBe(obj);
  }
}

describe("P3a guard tests", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      objectsById: new Map(),
      selectedIds: [],
      selectedSet: new Set(),
      undoStack: [],
      redoStack: [],
      isDirty: false,
    });
  });

  // -------------------------------------------------------------------------
  // Z-order: four direction tests
  // -------------------------------------------------------------------------
  describe("moveObjectForward", () => {
    it("moves object one step toward front", () => {
      useStore.getState().addObject(makeRect("a"));
      useStore.getState().addObject(makeRect("b"));
      useStore.getState().addObject(makeRect("c"));
      // order: [a, b, c]
      useStore.getState().moveObjectForward("a");
      const ids = useStore.getState().objects.map((o) => o.id);
      expect(ids).toEqual(["b", "a", "c"]);
    });

    it("no-op when already at front (boundary)", () => {
      useStore.getState().addObject(makeRect("a"));
      useStore.getState().addObject(makeRect("b"));
      // order: [a, b]
      useStore.getState().moveObjectForward("b"); // b is already at front (last)
      const ids = useStore.getState().objects.map((o) => o.id);
      expect(ids).toEqual(["a", "b"]);
    });
  });

  describe("moveObjectBackward", () => {
    it("moves object one step toward back", () => {
      useStore.getState().addObject(makeRect("a"));
      useStore.getState().addObject(makeRect("b"));
      useStore.getState().addObject(makeRect("c"));
      // order: [a, b, c]
      useStore.getState().moveObjectBackward("c");
      const ids = useStore.getState().objects.map((o) => o.id);
      expect(ids).toEqual(["a", "c", "b"]);
    });

    it("no-op when already at back (boundary)", () => {
      useStore.getState().addObject(makeRect("a"));
      useStore.getState().addObject(makeRect("b"));
      // order: [a, b]
      useStore.getState().moveObjectBackward("a"); // a is already at back (index 0)
      const ids = useStore.getState().objects.map((o) => o.id);
      expect(ids).toEqual(["a", "b"]);
    });
  });

  describe("moveObjectToFront", () => {
    it("moves object to the very front", () => {
      useStore.getState().addObject(makeRect("a"));
      useStore.getState().addObject(makeRect("b"));
      useStore.getState().addObject(makeRect("c"));
      // order: [a, b, c]
      useStore.getState().moveObjectToFront("a");
      const ids = useStore.getState().objects.map((o) => o.id);
      expect(ids).toEqual(["b", "c", "a"]);
    });

    it("no-op when object not found (unknown id)", () => {
      useStore.getState().addObject(makeRect("a"));
      useStore.getState().addObject(makeRect("b"));
      const before = useStore.getState().objects.map((o) => o.id);
      useStore.getState().moveObjectToFront("NOPE");
      const after = useStore.getState().objects.map((o) => o.id);
      expect(after).toEqual(before);
    });
  });

  describe("moveObjectToBack", () => {
    it("moves object to the very back", () => {
      useStore.getState().addObject(makeRect("a"));
      useStore.getState().addObject(makeRect("b"));
      useStore.getState().addObject(makeRect("c"));
      // order: [a, b, c]
      useStore.getState().moveObjectToBack("c");
      const ids = useStore.getState().objects.map((o) => o.id);
      expect(ids).toEqual(["c", "a", "b"]);
    });

    it("no-op when object not found (unknown id)", () => {
      useStore.getState().addObject(makeRect("a"));
      useStore.getState().addObject(makeRect("b"));
      const before = useStore.getState().objects.map((o) => o.id);
      useStore.getState().moveObjectToBack("NOPE");
      const after = useStore.getState().objects.map((o) => o.id);
      expect(after).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------
  // Z-order: undo/redo round-trip
  // -------------------------------------------------------------------------
  describe("z-order undo/redo", () => {
    it("forward undo restores original order", () => {
      useStore.getState().addObject(makeRect("a"));
      useStore.getState().addObject(makeRect("b"));
      useStore.getState().addObject(makeRect("c"));
      useStore.getState().moveObjectForward("a");
      expect(useStore.getState().objects.map((o) => o.id)).toEqual(["b", "a", "c"]);
      useStore.getState().undo();
      expect(useStore.getState().objects.map((o) => o.id)).toEqual(["a", "b", "c"]);
    });
  });

  // -------------------------------------------------------------------------
  // objectsById consistency guard (B3)
  // -------------------------------------------------------------------------
  describe("objectsById consistency", () => {
    it("is consistent after addObject", () => {
      useStore.getState().addObject(makeRect("a"));
      assertObjectsByIdConsistent();
    });

    it("is consistent after groupSelected", () => {
      useStore.getState().addObject(makeRect("a", 0, 0));
      useStore.getState().addObject(makeRect("b", 20, 20));
      useStore.getState().setSelectedIds(["a", "b"]);
      useStore.getState().groupSelected();
      assertObjectsByIdConsistent();
    });

    it("is consistent after ungroupSelected", () => {
      useStore.getState().addObject(makeRect("a", 0, 0));
      useStore.getState().addObject(makeRect("b", 20, 20));
      useStore.getState().setSelectedIds(["a", "b"]);
      useStore.getState().groupSelected();
      const groupId = useStore.getState().selectedIds[0];
      useStore.getState().setSelectedIds([groupId]);
      useStore.getState().ungroupSelected();
      assertObjectsByIdConsistent();
    });

    it("is consistent after moveObjectForward", () => {
      useStore.getState().addObject(makeRect("a"));
      useStore.getState().addObject(makeRect("b"));
      useStore.getState().moveObjectForward("a");
      assertObjectsByIdConsistent();
    });
  });

  // -------------------------------------------------------------------------
  // isDirty preservation guard (B3)
  // -------------------------------------------------------------------------
  describe("isDirty preservation", () => {
    it("groupSelected sets isDirty true", () => {
      useStore.getState().addObject(makeRect("a", 0, 0));
      useStore.getState().addObject(makeRect("b", 20, 20));
      useStore.getState().setSelectedIds(["a", "b"]);
      useStore.setState({ isDirty: false }); // reset after addObject
      useStore.getState().groupSelected();
      expect(useStore.getState().isDirty).toBe(true);
    });

    it("ungroupSelected sets isDirty true", () => {
      useStore.getState().addObject(makeRect("a", 0, 0));
      useStore.getState().addObject(makeRect("b", 20, 20));
      useStore.getState().setSelectedIds(["a", "b"]);
      useStore.getState().groupSelected();
      const groupId = useStore.getState().selectedIds[0];
      useStore.getState().setSelectedIds([groupId]);
      useStore.setState({ isDirty: false }); // reset
      useStore.getState().ungroupSelected();
      expect(useStore.getState().isDirty).toBe(true);
    });

    it("moveObjectForward sets isDirty true", () => {
      useStore.getState().addObject(makeRect("a"));
      useStore.getState().addObject(makeRect("b"));
      useStore.setState({ isDirty: false }); // reset
      useStore.getState().moveObjectForward("a");
      expect(useStore.getState().isDirty).toBe(true);
    });
  });
});
