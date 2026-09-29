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
