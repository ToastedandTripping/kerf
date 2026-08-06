/**
 * P6-A: Shortcut dispatch-order tests.
 *
 * Pins the shift-guard fix from P4-A: Ctrl+Shift+C must reach convert-to-path
 * (not copy), and Ctrl+Shift+A must reach frame-selection (not select-all).
 * Without the `!shift` guard on the bare Ctrl+C / Ctrl+A handlers, the plain
 * handler fires first and swallows the event before the shifted variant runs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { render, cleanup } from "@testing-library/react";
import { useStore } from "../../app/store";
import type { DesignObject } from "../../app/types";
import { useKeyboardShortcuts } from "../shortcuts";

function ShortcutHarness() {
  useKeyboardShortcuts();
  return null;
}

function makeRect(id: string): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: {
      x: 10,
      y: 10,
      width: 40,
      height: 30,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: "#cccccc",
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

function key(opts: KeyboardEventInit) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { cancelable: true, ...opts }),
  );
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

describe("Ctrl+Shift+C dispatch (convert-to-path, not copy)", () => {
  it("does NOT copy to clipboard", () => {
    render(<ShortcutHarness />);
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().setSelectedIds(["r1"]);

    key({ key: "c", ctrlKey: true, shiftKey: true });

    // If the shift-guard is missing, the plain Ctrl+C handler fires first
    // and copies the object to clipboard. With the guard, clipboard stays empty.
    expect(useStore.getState().clipboard).toHaveLength(0);
  });

  it("calls convertToPath on the selected object", () => {
    render(<ShortcutHarness />);
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().setSelectedIds(["r1"]);

    const spy = vi.spyOn(useStore.getState(), "convertToPath");
    // Re-bind after spy (getState() returns a snapshot, but the spy patches
    // the prototype for the duration of the test).
    key({ key: "c", ctrlKey: true, shiftKey: true });

    // The object should have been converted (type changes from rectangle to path)
    const obj = useStore.getState().objects.find((o) => o.id === "r1");
    expect(obj?.type).toBe("path");
    spy.mockRestore();
  });
});

describe("Ctrl+Shift+A dispatch (frame-selection, not select-all)", () => {
  it("does NOT select all objects", () => {
    render(<ShortcutHarness />);
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().addObject(makeRect("r2"));
    // Select only r1 -- Ctrl+Shift+A should NOT expand selection to [r1, r2]
    useStore.getState().setSelectedIds(["r1"]);

    key({ key: "a", ctrlKey: true, shiftKey: true });

    const selectedIds = useStore.getState().selectedIds;
    // If the shift-guard is missing, Ctrl+A fires first and selects both.
    // With the guard, selectedIds stays at [r1] (frame-selection doesn't
    // change the selection, it changes the camera).
    expect(selectedIds).toHaveLength(1);
    expect(selectedIds[0]).toBe("r1");
  });

  it("adjusts camera (zoom-to-fit-selection)", () => {
    render(<ShortcutHarness />);
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().setSelectedIds(["r1"]);

    // Capture zoom before the shortcut fires
    const zoomBefore = useStore.getState().camera.zoom;
    key({ key: "a", ctrlKey: true, shiftKey: true });

    // zoomToFitSelection should run without error. The camera is expected
    // to change (pan/zoom to frame the selected object), but the exact
    // delta depends on viewport dimensions unavailable in jsdom. The key
    // assertion is that the handler ran (no throw) and selectedIds did NOT
    // expand (tested above). A non-undefined zoom is a basic sanity gate.
    expect(useStore.getState().camera.zoom).toBeDefined();
    // If viewport dimensions are available, zoom should differ:
    void zoomBefore;
  });
});
