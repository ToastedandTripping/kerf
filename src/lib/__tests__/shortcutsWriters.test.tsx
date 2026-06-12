/**
 * W1b — F1 writer tests for the keyboard pipeline (arrow nudge, Ctrl+V paste)
 * and the MenuBar clipboard writer, through the PRODUCTION handlers:
 * useKeyboardShortcuts is mounted in a harness component and real KeyboardEvents
 * are dispatched on window; the MenuBar paste runs via its test-only export.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { render, cleanup } from "@testing-library/react";
import { useStore } from "../../app/store";
import type { DesignObject, PathPoint } from "../../app/types";
import { useKeyboardShortcuts } from "../shortcuts";
import { assertPointsInvariant } from "../geometry";
import { _testClipboardOp } from "../../components/topbar/MenuBar";

function ShortcutHarness() {
  useKeyboardShortcuts();
  return null;
}

function makePath(id: string): DesignObject {
  const points: PathPoint[] = [
    { x: 10, y: 10, handleOut: { x: 15, y: 5 } },
    { x: 30, y: 10, handleIn: { x: 25, y: 5 } },
    { x: 30, y: 30 },
  ];
  return {
    id,
    type: "path",
    name: `Path ${id}`,
    transform: { x: 10, y: 10, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
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

const get = (id: string) => useStore.getState().objects.find((o) => o.id === id)!;

function key(opts: KeyboardEventInit) {
  window.dispatchEvent(new KeyboardEvent("keydown", { cancelable: true, ...opts }));
}

beforeEach(() => {
  cleanup();
  useStore.setState({
    objects: [],
    objectsById: new Map(),
    selectedIds: [],
    selectedSet: new Set(),
    undoStack: [],
    redoStack: [],
    clipboard: [],
    activeTool: "select",
    nodeEditState: { pathId: null, selectedNodeIndex: null },
  });
});

describe("arrow nudge", () => {
  it("nudges path points (and handles) with the transform; undo restores", () => {
    render(<ShortcutHarness />);
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);

    key({ key: "ArrowRight" });
    key({ key: "ArrowDown", shiftKey: true }); // 10mm step

    const p = get("p1");
    expect(p.transform).toMatchObject({ x: 11, y: 20 });
    expect(p.points![0]).toMatchObject({ x: 11, y: 20 });
    expect(p.points![0].handleOut).toEqual({ x: 16, y: 15 });
    assertPointsInvariant(p);

    useStore.getState().undo(); // undo the shift-nudge
    useStore.getState().undo(); // undo the nudge
    const restored = get("p1");
    expect(restored.points![0]).toMatchObject({ x: 10, y: 10 });
    assertPointsInvariant(restored);
  });
});

describe("Ctrl+V paste (+10 offset)", () => {
  it("pastes a path with offset points and NO shared arrays with the clipboard", () => {
    render(<ShortcutHarness />);
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);

    key({ key: "c", ctrlKey: true });
    key({ key: "v", ctrlKey: true });

    const objects = useStore.getState().objects;
    expect(objects).toHaveLength(2);
    const pasted = objects[1];
    expect(pasted.transform).toMatchObject({ x: 20, y: 20 });
    expect(pasted.points![0]).toMatchObject({ x: 20, y: 20 });
    expect(pasted.points![0].handleOut).toEqual({ x: 25, y: 15 });
    assertPointsInvariant(pasted);

    // aliasing: pasted points must be fresh, not the clipboard's live references
    const original = get("p1");
    expect(pasted.points).not.toBe(original.points);
    expect(pasted.points![0]).not.toBe(original.points![0]);
    expect(original.points![0]).toMatchObject({ x: 10, y: 10 }); // untouched
  });
});

describe("MenuBar clipboardOp paste (production writer via test-only export)", () => {
  it("paste offsets path points by +10 with fresh arrays; pasteInPlace keeps position", () => {
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);

    _testClipboardOp("copy");
    _testClipboardOp("paste");
    let objects = useStore.getState().objects;
    expect(objects).toHaveLength(2);
    const pasted = objects[1];
    expect(pasted.transform).toMatchObject({ x: 20, y: 20 });
    expect(pasted.points![0]).toMatchObject({ x: 20, y: 20 });
    assertPointsInvariant(pasted);
    expect(pasted.points).not.toBe(get("p1").points);

    _testClipboardOp("pasteInPlace");
    objects = useStore.getState().objects;
    expect(objects).toHaveLength(3);
    const inPlace = objects[2];
    expect(inPlace.transform).toMatchObject({ x: 10, y: 10 });
    expect(inPlace.points![0]).toMatchObject({ x: 10, y: 10 });
    assertPointsInvariant(inPlace);
    expect(inPlace.points).not.toBe(get("p1").points);
  });
});
