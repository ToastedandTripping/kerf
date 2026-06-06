/**
 * D1 regression: selectedSet must always mirror selectedIds.
 * These tests must FAIL on the original code and PASS after the fix.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../index";
import type { DesignObject } from "../../types";

function assertSync() {
  const { selectedIds, selectedSet } = useStore.getState();
  expect([...selectedSet].sort()).toEqual([...selectedIds].sort());
}

function makeRect(id: string, layerIndex = 0): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x: 10, y: 10, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

describe("D1 — selectedSet stays in sync with selectedIds", () => {
  beforeEach(() => {
    useStore.setState({
      objects: [],
      selectedIds: [],
      selectedSet: new Set(),
      undoStack: [],
      redoStack: [],
    });
  });

  it("invertSelection keeps selectedSet in sync", () => {
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().addObject(makeRect("r2"));
    useStore.getState().setSelectedIds(["r1"]);
    useStore.getState().invertSelection();
    assertSync();
    expect(useStore.getState().selectedIds).toEqual(["r2"]);
  });

  it("selectByLayer keeps selectedSet in sync", () => {
    useStore.getState().addObject(makeRect("r1", 0));
    useStore.getState().addObject(makeRect("r2", 1));
    useStore.getState().selectByLayer(0);
    assertSync();
    expect(useStore.getState().selectedIds).toEqual(["r1"]);
  });

  it("selectNext keeps selectedSet in sync", () => {
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().addObject(makeRect("r2"));
    useStore.getState().setSelectedIds(["r1"]);
    useStore.getState().selectNext();
    assertSync();
  });

  it("selectPrev keeps selectedSet in sync", () => {
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().addObject(makeRect("r2"));
    useStore.getState().setSelectedIds(["r2"]);
    useStore.getState().selectPrev();
    assertSync();
  });

  it("duplicateInPlace keeps selectedSet in sync", () => {
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().setSelectedIds(["r1"]);
    useStore.getState().duplicateInPlace();
    assertSync();
    // After duplicate the new ids should be selected, not the original
    const { selectedIds, objects } = useStore.getState();
    expect(selectedIds).toHaveLength(1);
    expect(objects).toHaveLength(2);
  });

  it("groupSelected keeps selectedSet in sync", () => {
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().addObject(makeRect("r2"));
    useStore.getState().setSelectedIds(["r1", "r2"]);
    useStore.getState().groupSelected();
    assertSync();
    // Should now select the group
    expect(useStore.getState().selectedIds).toHaveLength(1);
  });

  it("ungroupSelected keeps selectedSet in sync", () => {
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().addObject(makeRect("r2"));
    useStore.getState().setSelectedIds(["r1", "r2"]);
    useStore.getState().groupSelected();
    const groupId = useStore.getState().selectedIds[0];
    useStore.getState().setSelectedIds([groupId]);
    useStore.getState().ungroupSelected();
    assertSync();
  });

  it("undo restores selectedSet in sync (withUndo restore closure)", () => {
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().addObject(makeRect("r2"));
    useStore.getState().setSelectedIds(["r1"]);
    useStore.getState().withUndo("test", () => {
      useStore.getState().removeObjects(["r2"]);
    });
    useStore.getState().undo();
    assertSync();
  });

  it("redo restores selectedSet in sync (withUndo restore closure)", () => {
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().addObject(makeRect("r2"));
    useStore.getState().setSelectedIds(["r1"]);
    useStore.getState().withUndo("test", () => {
      useStore.getState().removeObjects(["r2"]);
    });
    useStore.getState().undo();
    useStore.getState().redo();
    assertSync();
  });

  it("setSelectedIds → undo → redo round-trip keeps selectedSet in sync", () => {
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().addObject(makeRect("r2"));
    // Trigger a withUndo action that captures beforeSelectedIds / afterSelectedIds
    useStore.getState().setSelectedIds(["r1"]);
    useStore.getState().withUndo("test", () => {
      useStore.getState().setSelectedIds(["r2"]);
      useStore.getState().removeObjects(["r1"]);
    });
    assertSync(); // after action: selectedIds = ["r2"]
    useStore.getState().undo();
    assertSync(); // after undo: selectedIds = ["r1"]
    useStore.getState().redo();
    assertSync(); // after redo: selectedIds = ["r2"]
  });

  it("commitPropertyEdit undo/redo keeps selectedSet in sync", () => {
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().setSelectedIds(["r1"]);
    useStore.getState().beginPropertyEdit();
    useStore.getState().updateObject("r1", { transform: { x: 99, y: 10, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 } });
    useStore.getState().commitPropertyEdit();
    assertSync();
    useStore.getState().undo();
    assertSync();
    useStore.getState().redo();
    assertSync();
  });
});
