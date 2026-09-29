/**
 * refresh-editing-shortcuts: the command surfaces (MenuBar, CommandPalette,
 * ShortcutOverlay) rendered under jsdom and driven the way a user drives them.
 * Keys whose effect is asserted on the DOM go through fireEvent (act-wrapped).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { useStore } from "../../../app/store";
import { CommandPalette } from "../CommandPalette";
import { MenuBar } from "../MenuBar";
import { ShortcutOverlay } from "../../panels/ShortcutOverlay";

function paletteRow(label: string): HTMLElement {
  const row = screen
    .getAllByText(label)
    .map((el) => el.closest("div[style*='justify-content']") as HTMLElement | null)
    .find((el) => el !== null);
  if (!row) throw new Error(`palette row not found: ${label}`);
  return row;
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

describe("F3 palette label", () => {
  it('the "Flip Vertical" row shows Ctrl+Shift+V', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const row = paletteRow("Flip Vertical");
    expect(row.textContent).toContain("Ctrl+Shift+V");
  });
});

describe("F4 sheet and palette open state lives in openDialogs", () => {
  it("Help > Keyboard Shortcuts opens the sheet", () => {
    render(
      <>
        <MenuBar />
        <ShortcutOverlay />
      </>
    );
    expect(screen.queryByRole("dialog", { name: "Keyboard Shortcuts" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    const item = screen
      .getAllByRole("menuitem")
      .find((b) => b.querySelector("span")?.textContent === "Keyboard Shortcuts")!;
    fireEvent.click(item);
    // queryByRole, not getByRole: getByRole's not-found message pretty-prints every
    // role, and jsdom throws cloning the menu buttons' var() backgrounds, which would
    // mask this assertion behind a harness TypeError.
    expect(screen.queryByRole("dialog", { name: "Keyboard Shortcuts" })).not.toBeNull();
  });

  it("? toggles the sheet, Escape closes it, and openDialogs tracks both", () => {
    render(<ShortcutOverlay />);
    const tracked = () => useStore.getState().openDialogs.has("shortcuts");
    const shown = () => screen.queryByRole("dialog", { name: "Keyboard Shortcuts" });
    expect(tracked()).toBe(false);
    fireEvent.keyDown(window, { key: "?" });
    expect(tracked()).toBe(true);
    expect(shown()).not.toBeNull();
    fireEvent.keyDown(window, { key: "?" });
    expect(tracked()).toBe(false);
    expect(shown()).toBeNull();
    fireEvent.keyDown(window, { key: "?" });
    expect(tracked()).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(tracked()).toBe(false);
    expect(shown()).toBeNull();
  });

  it("Ctrl+K opens the palette in openDialogs, Escape closes it, and reopening resets the search", () => {
    render(<CommandPalette />);
    const tracked = () => useStore.getState().openDialogs.has("commandPalette");
    expect(tracked()).toBe(false);
    expect(screen.queryByPlaceholderText(/command/i)).toBeNull();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(tracked()).toBe(true);
    const input = screen.getByPlaceholderText(/command/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "flip" } });
    expect(input.value).toBe("flip");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(tracked()).toBe(false);
    expect(screen.queryByPlaceholderText(/command/i)).toBeNull();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect((screen.getByPlaceholderText(/command/i) as HTMLInputElement).value).toBe("");
  });
});
