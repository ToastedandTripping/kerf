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
