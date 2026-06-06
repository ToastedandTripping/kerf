/**
 * D3 regression: updating a group must mark its children dirty.
 * These tests must FAIL on original code and PASS after the fix.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useStore, getDirtyObjectIds, clearDirtyObjectIds } from "../index";
import type { DesignObject } from "../../types";

function makeRect(id: string): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x: 5, y: 5, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

function makeGroup(groupId: string, children: DesignObject[]): DesignObject {
  return {
    id: groupId,
    type: "group",
    name: `Group ${groupId}`,
    transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
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

describe("D3 — group update marks children dirty", () => {
  beforeEach(() => {
    clearDirtyObjectIds();
    useStore.setState({
      objects: [],
      selectedIds: [],
      selectedSet: new Set(),
      undoStack: [],
      redoStack: [],
    });
  });

  it("updateObject on a group marks child ids AND group id dirty", () => {
    const child1 = makeRect("child1");
    const child2 = makeRect("child2");
    const group = makeGroup("group1", [child1, child2]);
    useStore.getState().addObject(group);
    clearDirtyObjectIds(); // clear addObject's dirty mark

    useStore.getState().updateObject("group1", {
      transform: { x: 10, y: 10, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
    });

    const dirty = getDirtyObjectIds();
    expect(dirty.has("group1")).toBe(true);
    expect(dirty.has("child1")).toBe(true);
    expect(dirty.has("child2")).toBe(true);
  });

  it("updateObjects on a group marks child ids AND group id dirty", () => {
    const child1 = makeRect("child1");
    const child2 = makeRect("child2");
    const group = makeGroup("group1", [child1, child2]);
    useStore.getState().addObject(group);
    clearDirtyObjectIds();

    useStore.getState().updateObjects([{
      id: "group1",
      partial: { transform: { x: 20, y: 20, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 } },
    }]);

    const dirty = getDirtyObjectIds();
    expect(dirty.has("group1")).toBe(true);
    expect(dirty.has("child1")).toBe(true);
    expect(dirty.has("child2")).toBe(true);
  });

  it("updating a non-group object does NOT dirty unrelated objects", () => {
    const rect = makeRect("solo1");
    useStore.getState().addObject(rect);
    clearDirtyObjectIds();

    useStore.getState().updateObject("solo1", {
      transform: { x: 5, y: 5, width: 20, height: 20, rotation: 5, scaleX: 1, scaleY: 1 },
    });

    const dirty = getDirtyObjectIds();
    expect(dirty.has("solo1")).toBe(true);
    expect(dirty.size).toBe(1);
  });

  it("nested group children also get dirtied (one extra level)", () => {
    const grandchild = makeRect("gc1");
    const innerGroup = makeGroup("inner1", [grandchild]);
    const outerGroup = makeGroup("outer1", [innerGroup]);
    useStore.getState().addObject(outerGroup);
    clearDirtyObjectIds();

    useStore.getState().updateObject("outer1", {
      transform: { x: 5, y: 5, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
    });

    const dirty = getDirtyObjectIds();
    expect(dirty.has("outer1")).toBe(true);
    expect(dirty.has("inner1")).toBe(true);
    expect(dirty.has("gc1")).toBe(true);
  });
});
