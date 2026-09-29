/**
 * refresh-editing-shortcuts fix2: every aria-modal root contains focus.
 *
 * F7 made the global shortcut handler inert behind a modal, including its Tab
 * handler, which used to preventDefault Tab (object cycling) and so, by
 * accident, kept focus from leaving. With that gone, a modal without a focus
 * trap lets Tab walk out to the menubar and side panel, where arrow keys edit
 * layer power behind the dialog. So every .tsx that renders aria-modal="true"
 * must call useFocusTrap, unless it is on the allowlist below with a reason.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { useStore } from "../../app/store";
import { ShortcutOverlay } from "../../components/panels/ShortcutOverlay";

const SRC = path.resolve(__dirname, "../..");

/** Files that render aria-modal but may not call useFocusTrap, each with its reason. */
const ALLOWLIST: Record<string, string> = {
  "components/panels/GrblSettingsDialog.tsx":
    "remediation-frozen file (refresh-editing-shortcuts plan, Files: out of scope); containment owed, see fix2 report",
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "__tests__" ? [] : walk(p);
    return d.name.endsWith(".tsx") ? [p] : [];
  });
}

describe("every aria-modal root contains focus (class-level source scan)", () => {
  const modalFiles = walk(SRC)
    .filter((f) => /aria-modal="true"/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(SRC, f).split(path.sep).join("/"));

  it("finds the modal surfaces (positive control: the scan is not vacuous)", () => {
    expect(modalFiles).toContain("components/panels/SettingsDialog.tsx");
    expect(modalFiles).toContain("components/panels/ShortcutOverlay.tsx");
    expect(modalFiles.length).toBeGreaterThanOrEqual(17);
  });

  it("each one calls useFocusTrap, or is allowlisted with a reason", () => {
    const missing = modalFiles.filter(
      (f) => !ALLOWLIST[f] && !/useFocusTrap\(/.test(fs.readFileSync(path.join(SRC, f), "utf8"))
    );
    expect(missing).toEqual([]);
  });

  it("the allowlist names only real, still-untrapped modal files", () => {
    for (const f of Object.keys(ALLOWLIST)) {
      expect(modalFiles).toContain(f);
      expect(/useFocusTrap\(/.test(fs.readFileSync(path.join(SRC, f), "utf8"))).toBe(false);
    }
  });
});

describe("the ? sheet contains focus", () => {
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

  it("focus moves into the sheet on open, Tab cannot leave it, ? still closes it, and focus returns", () => {
    const { getByText } = render(
      <>
        <button>outside</button>
        <ShortcutOverlay />
      </>
    );
    const outside = getByText("outside");
    outside.focus();
    fireEvent.keyDown(window, { key: "?" });
    const dialog = document.querySelector('[aria-modal="true"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => {
      (document.activeElement as HTMLElement).dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);

    // closing with focus on the sheet still works, and focus goes back
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "?" });
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });
});
