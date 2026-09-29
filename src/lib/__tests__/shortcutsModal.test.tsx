/**
 * refresh-editing-shortcuts F7: global shortcuts are inert while any
 * aria-modal root is mounted, and live again once it unmounts.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { useEffect } from "react";
import { flushSync } from "react-dom";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { useStore } from "../../app/store";
import type { DesignObject } from "../../app/types";
import { useKeyboardShortcuts } from "../shortcuts";
import { NestingDialog } from "../../components/panels/NestingDialog";
import { ShortcutOverlay } from "../../components/panels/ShortcutOverlay";

function ShortcutHarness() {
  useKeyboardShortcuts();
  return null;
}

/** App.tsx shape: the hook in the parent, the sheet as a child. Child effects run
 *  first, so the sheet's window listener is registered BEFORE the global one. */
function AppShapedHarness() {
  useKeyboardShortcuts();
  return <ShortcutOverlay />;
}

/** A real browser runs a microtask checkpoint between window listeners for a
 *  user-agent keydown, so React commits the sheet's close BEFORE the global
 *  handler runs. jsdom (script dispatch) does not; this listener, registered
 *  between the two, reproduces that commit with flushSync. */
function CheckpointEmulator() {
  useEffect(() => {
    const flush = () => flushSync(() => {});
    window.addEventListener("keydown", flush);
    return () => window.removeEventListener("keydown", flush);
  }, []);
  return null;
}
function BrowserOrderHarness() {
  useKeyboardShortcuts();
  return (
    <>
      <ShortcutOverlay />
      <CheckpointEmulator />
    </>
  );
}

function makeRect(id: string): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x: 10, y: 10, width: 40, height: 30, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: "#cccccc",
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

/** Bubbling keydown dispatched at a target (store-only assertions follow). */
function keyAt(target: EventTarget, opts: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(ev);
  return ev;
}

const noop = () => {};

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
    openDialogs: new Set(),
    snapToGrid: false,
  });
});

afterEach(() => vi.restoreAllMocks());

describe("F7 modal guard", () => {
  let warn: MockInstance;

  it("Delete is suppressed while NestingDialog is open, and fires once it unmounts; no warning for an ordinary dialog", () => {
    warn = vi.spyOn(console, "warn");
    render(<ShortcutHarness />);
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().setSelectedIds(["r1"]);

    const dialog = render(<NestingDialog open onClose={noop} />);
    const button = dialog.container.querySelector("button")!;
    button.focus();
    keyAt(button, { key: "Delete" });
    expect(useStore.getState().objects).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();

    dialog.rerender(<NestingDialog open={false} onClose={noop} />);
    keyAt(document.body, { key: "Delete" });
    expect(useStore.getState().objects).toHaveLength(0);
  });

  it("Ctrl+Z is suppressed behind a modal (positive control: the nudge before it went through)", () => {
    render(<ShortcutHarness />);
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().setSelectedIds(["r1"]);
    keyAt(document.body, { key: "ArrowRight" });
    expect(useStore.getState().undoStack.length).toBe(1);
    expect(useStore.getState().objects[0].transform.x).toBe(11);

    const dialog = render(<NestingDialog open onClose={noop} />);
    const button = dialog.container.querySelector("button")!;
    button.focus();
    keyAt(button, { key: "z", ctrlKey: true });
    expect(useStore.getState().undoStack.length).toBe(1);
    expect(useStore.getState().objects[0].transform.x).toBe(11);
  });

  it("Tab is not prevented inside a bare aria-modal root; after removing only that root it is", () => {
    render(<ShortcutHarness />);
    const bare = render(
      <div role="dialog" aria-modal="true">
        <button>ok</button>
      </div>
    );
    const button = bare.container.querySelector("button")!;
    button.focus();
    expect(keyAt(button, { key: "Tab" }).defaultPrevented).toBe(false);

    bare.unmount(); // the harness stays mounted
    expect(keyAt(document.body, { key: "Tab" }).defaultPrevented).toBe(true);
  });

  it("Escape with the ? sheet open only closes the sheet; a second Escape deselects", () => {
    render(<AppShapedHarness />);
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().setSelectedIds(["r1"]);
    useStore.setState({ activeTool: "rectangle" });

    fireEvent.keyDown(window, { key: "?" });
    expect(useStore.getState().openDialogs.has("shortcuts")).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().openDialogs.has("shortcuts")).toBe(false);
    expect(useStore.getState().selectedIds).toEqual(["r1"]);
    expect(useStore.getState().activeTool).toBe("rectangle");

    // positive control: with no modal mounted the global Escape branch runs
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().selectedIds).toEqual([]);
    expect(useStore.getState().activeTool).toBe("select");
  });

  it("Escape that closes the ? sheet never reaches the global handler, even when the close commits first (browser listener timing)", async () => {
    render(<BrowserOrderHarness />);
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().setSelectedIds(["r1"]);
    useStore.setState({ activeTool: "rectangle" });
    act(() => useStore.getState().openDialog("shortcuts"));
    expect(document.querySelector('[aria-modal="true"]')).not.toBeNull();

    // raw dispatch: no act batching, so the emulated checkpoint really commits the close
    keyAt(window, { key: "Escape" });
    expect(useStore.getState().openDialogs.has("shortcuts")).toBe(false);
    expect(useStore.getState().selectedIds).toEqual(["r1"]);
    expect(useStore.getState().activeTool).toBe("rectangle");
    await act(async () => {});
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });
});
