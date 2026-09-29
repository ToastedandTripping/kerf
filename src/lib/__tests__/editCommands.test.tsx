/**
 * refresh-editing-shortcuts: the edit commands (copy/cut/paste/paste-in-place,
 * delete, flip) through the PRODUCTION surfaces. The keyboard harness mounts
 * useKeyboardShortcuts and dispatches real KeyboardEvents on window; the menu
 * is a rendered <MenuBar /> whose items are clicked.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { render, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useStore } from "../../app/store";
import type { DesignObject, PathPoint } from "../../app/types";
import { useKeyboardShortcuts } from "../shortcuts";
import { MenuBar } from "../../components/topbar/MenuBar";
import { measureState } from "../tools/toolHandler";

function ShortcutHarness() {
  useKeyboardShortcuts();
  return null;
}

function makePath(id: string, x = 10, y = 10): DesignObject {
  const points: PathPoint[] = [
    { x, y, handleOut: { x: x + 5, y: y - 5 } },
    { x: x + 20, y, handleIn: { x: x + 15, y: y - 5 } },
    { x: x + 20, y: y + 30 },
  ];
  return {
    id,
    type: "path",
    name: `Path ${id}`,
    transform: { x, y, width: 20, height: 30, rotation: 0, scaleX: 1, scaleY: 1 },
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

/** Raw dispatch: store-only assertions follow (plan's keyboard dispatch rule). */
function key(opts: KeyboardEventInit) {
  window.dispatchEvent(new KeyboardEvent("keydown", { cancelable: true, ...opts }));
}

function flatten(objs: DesignObject[]): DesignObject[] {
  return objs.flatMap((o) => [o, ...(o.children ? flatten(o.children) : [])]);
}

/** Open a top-level menu and click the item whose label (not shortcut) matches. */
function clickMenu(menu: string, item: string) {
  fireEvent.click(screen.getByRole("menuitem", { name: menu }));
  const list = screen.getByRole("menu", { name: menu });
  const btn = within(list)
    .getAllByRole("menuitem")
    .find((b) => b.querySelector("span")?.textContent === item);
  if (!btn) throw new Error(`menu item not found: ${menu} > ${item}`);
  fireEvent.click(btn);
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
    openDialogs: new Set(),
    snapToGrid: false,
  });
});

describe("F1 paste deep-clones with fresh ids at every depth", () => {
  it("group paste via Ctrl+V, Alt+V, menu Paste and Paste in Place: unique ids, no write aliasing, fresh points", () => {
    render(
      <>
        <ShortcutHarness />
        <MenuBar />
      </>
    );
    const s = useStore.getState();
    s.addObject(makePath("a", 10, 10));
    s.addObject(makePath("b", 50, 10));
    s.setSelectedIds(["a", "b"]);
    useStore.getState().groupSelected();
    const groupId = useStore.getState().selectedIds[0];
    expect(useStore.getState().objects.find((o) => o.id === groupId)?.type).toBe("group");

    key({ key: "c", ctrlKey: true });
    key({ key: "v", ctrlKey: true });
    key({ key: "v", altKey: true });
    clickMenu("Edit", "Paste");
    clickMenu("Edit", "Paste in Place");

    const all = flatten(useStore.getState().objects);
    // 5 groups x (1 group + 2 children)
    expect(all).toHaveLength(15);
    const ids = all.map((o) => o.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);

    useStore.getState().updateObject("a", { name: "EDITED" });
    expect(flatten(useStore.getState().objects).filter((o) => o.name === "EDITED")).toHaveLength(1);

    const originalA = flatten(useStore.getState().objects).find((o) => o.id === "a")!;
    const groups = useStore.getState().objects.filter((o) => o.type === "group");
    for (const g of groups.slice(1)) {
      for (const child of g.children!) {
        expect(child.points).not.toBe(originalA.points);
        expect(child.points).not.toBe(
          flatten(useStore.getState().objects).find((o) => o.id === "b")!.points
        );
      }
    }
  });

  it("Alt+V on a single path: fresh points, same transform", () => {
    render(<ShortcutHarness />);
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);
    key({ key: "c", ctrlKey: true });
    key({ key: "v", altKey: true });

    const [orig, pasted] = useStore.getState().objects;
    expect(pasted.id).not.toBe(orig.id);
    expect(pasted.points).not.toBe(orig.points);
    expect(pasted.transform).toEqual(orig.transform);
  });

  it("Ctrl+C with nothing selected leaves the clipboard alone (positive control: Ctrl+C with a selection copies)", () => {
    render(<ShortcutHarness />);
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().addObject(makePath("p2", 60, 10));

    // positive control: a live Ctrl+C copies exactly the selection
    useStore.getState().setSelectedIds(["p1"]);
    key({ key: "c", ctrlKey: true });
    expect(useStore.getState().clipboard.map((o) => o.id)).toEqual(["p1"]);

    useStore.getState().setSelectedIds([]);
    key({ key: "c", ctrlKey: true });
    expect(useStore.getState().clipboard.map((o) => o.id)).toEqual(["p1"]);
  });
});

describe("F2 Delete undo restores original array positions", () => {
  it("Delete A from [A,B,C] then Ctrl+Z gives [A,B,C] with A selected", () => {
    // Array order within a layer is cut order (toCutObjects stable sort; store F15): undo must restore original positions, or Delete+Undo silently re-sequences the job.
    render(<ShortcutHarness />);
    for (const id of ["A", "B", "C"]) useStore.getState().addObject(makeRect(id));
    useStore.getState().setSelectedIds(["A"]);
    key({ key: "Delete" });
    expect(useStore.getState().objects.map((o) => o.id)).toEqual(["B", "C"]);
    key({ key: "z", ctrlKey: true });
    expect(useStore.getState().objects.map((o) => o.id)).toEqual(["A", "B", "C"]);
    expect(useStore.getState().selectedIds).toEqual(["A"]);
  });

  it("Delete with nothing selected pushes no undo entry, from the key and from the menu (each with a positive control)", () => {
    render(
      <>
        <ShortcutHarness />
        <MenuBar />
      </>
    );
    for (const id of ["A", "B", "C"]) useStore.getState().addObject(makeRect(id));
    const depth = () => useStore.getState().undoStack.length;
    const ids = () => useStore.getState().objects.map((o) => o.id);

    // keyboard positive control
    useStore.getState().setSelectedIds(["B"]);
    let before = depth();
    key({ key: "Delete" });
    expect(depth()).toBe(before + 1);
    expect(ids()).not.toContain("B");

    // keyboard, empty selection
    useStore.getState().setSelectedIds([]);
    before = depth();
    key({ key: "Delete" });
    expect(depth()).toBe(before);

    // menu positive control
    useStore.getState().setSelectedIds(["C"]);
    before = depth();
    clickMenu("Edit", "Delete");
    expect(depth()).toBe(before + 1);
    expect(ids()).not.toContain("C");

    // menu, empty selection
    useStore.getState().setSelectedIds([]);
    before = depth();
    clickMenu("Edit", "Delete");
    expect(depth()).toBe(before);
  });
});

describe("F3 Ctrl+Shift+V is Flip Vertical (Lee 2026-09-22)", () => {
  it("flips the selection top-to-bottom and does not paste; plain Ctrl+V still pastes", () => {
    render(<ShortcutHarness />);
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);
    key({ key: "c", ctrlKey: true }); // non-empty clipboard
    const before = useStore.getState().objects[0];
    const t = before.transform;
    const cy = t.y + t.height / 2;

    key({ key: "V", shiftKey: true, ctrlKey: true });
    const objs = useStore.getState().objects;
    expect(objs).toHaveLength(1);
    expect(objs[0].points!.map((p) => p.y)).toEqual(before.points!.map((p) => 2 * cy - p.y));

    // positive control: plain Ctrl+V still offset-pastes
    key({ key: "v", ctrlKey: true });
    expect(useStore.getState().objects).toHaveLength(2);
  });
});

describe("F6 labelled keys are bound: S, ], [", () => {
  it("S toggles snap false -> true -> false; Shift+S right after a live S does nothing; S is not an undo step", () => {
    render(<ShortcutHarness />);
    const snap = () => useStore.getState().snapToGrid;
    const depth = useStore.getState().undoStack.length;
    expect(snap()).toBe(false);
    key({ key: "s" });
    expect(snap()).toBe(true);
    key({ key: "S", shiftKey: true });
    expect(snap()).toBe(true);
    key({ key: "s" });
    expect(snap()).toBe(false);
    // setSnapToGrid is a view setting (plain set), not a document edit
    expect(useStore.getState().undoStack.length).toBe(depth);
  });

  it("] rotates +90 and [ rotates -90, each as one undo step", () => {
    render(<ShortcutHarness />);
    useStore.getState().addObject(makeRect("r1"));
    useStore.getState().setSelectedIds(["r1"]);
    const rot = () => useStore.getState().objects[0].transform.rotation;
    const depth = () => useStore.getState().undoStack.length;

    let before = depth();
    key({ key: "]" });
    expect(rot()).toBe(90);
    expect(depth()).toBe(before + 1);

    before = depth();
    key({ key: "[" });
    expect(rot()).toBe(0);
    expect(depth()).toBe(before + 1);

    key({ key: "[" });
    expect(rot()).toBe(270);
  });
});

describe("F5 keyboard tool keys and Escape go through switchTool", () => {
  it("N with one path selected enters node editing; V leaves it and clears node-edit state", () => {
    render(<ShortcutHarness />);
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);
    key({ key: "n" });
    expect(useStore.getState().activeTool).toBe("node");
    expect(useStore.getState().nodeEditState.pathId).toBe("p1");
    key({ key: "v" });
    expect(useStore.getState().activeTool).toBe("select");
    expect(useStore.getState().nodeEditState.pathId).toBeNull();
  });

  it("Escape from the measure tool runs the tool-change cleanup (measure state reset)", () => {
    render(<ShortcutHarness />);
    useStore.setState({ activeTool: "measure" });
    // A diameter readout with no active segment: the viewport handler does not
    // intercept Escape, so the global branch switches to select.
    measureState.diameterLabel = "Ø 12.0 mm";
    key({ key: "Escape" });
    expect(useStore.getState().activeTool).toBe("select");
    expect(measureState.diameterLabel).toBeNull();
  });
});

describe("fix pass: Cut, paste selection, menu Flip Vertical", () => {
  // Cut is the destructive half of F1: it must copy first and be one undo step, or the objects are unrecoverable.
  function cutCase(doCut: () => void) {
    for (const id of ["A", "B", "C"]) useStore.getState().addObject(makeRect(id));
    useStore.getState().setSelectedIds(["B"]);
    const before = useStore.getState().undoStack.length;
    doCut();
    expect(useStore.getState().clipboard.map((o) => o.id)).toEqual(["B"]);
    expect(useStore.getState().objects.map((o) => o.id)).toEqual(["A", "C"]);
    expect(useStore.getState().undoStack.length).toBe(before + 1);
    useStore.getState().undo();
    expect(useStore.getState().objects.map((o) => o.id)).toEqual(["A", "B", "C"]);
  }

  it("keyboard Ctrl+X copies, removes, is one undo step, and undo restores positions", () => {
    render(<ShortcutHarness />);
    cutCase(() => key({ key: "x", ctrlKey: true }));
  });

  it("Edit > Cut copies, removes, is one undo step, and undo restores positions", () => {
    render(<MenuBar />);
    cutCase(() => clickMenu("Edit", "Cut"));
  });

  it("paste selects exactly what it pasted", () => {
    render(<ShortcutHarness />);
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);
    key({ key: "c", ctrlKey: true });
    key({ key: "v", ctrlKey: true });
    const pasted = useStore.getState().objects[1];
    expect(useStore.getState().selectedIds).toEqual([pasted.id]);
  });

  it("Arrange > Flip Vertical flips vertically", () => {
    render(<MenuBar />);
    useStore.getState().addObject(makePath("p1"));
    useStore.getState().setSelectedIds(["p1"]);
    const before = useStore.getState().objects[0];
    const cy = before.transform.y + before.transform.height / 2;
    clickMenu("Arrange", "Flip Vertical");
    const after = useStore.getState().objects[0];
    expect(after.points!.map((p) => p.y)).toEqual(before.points!.map((p) => 2 * cy - p.y));
    expect(after.points!.map((p) => p.x)).toEqual(before.points!.map((p) => p.x));
  });
});
