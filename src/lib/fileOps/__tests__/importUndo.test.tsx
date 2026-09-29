/**
 * refresh-editing-shortcuts F8: image and PDF-vector imports record exactly one
 * undo step, so Ctrl+Z removes the import (and only the import) and Ctrl+Y
 * brings it back with its original imageData.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { useStore } from "../../../app/store";
import type { DesignObject } from "../../../app/types";
import { ImageImportDialog } from "../../../components/panels/ImageImportDialog";
import { importImageData } from "../imageImport";
import { importPdfVectors } from "../../../app/App";

function makeRect(id: string, x = 10): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x, y: 10, width: 40, height: 30, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

function makePath(id: string): DesignObject {
  return {
    ...makeRect(id),
    type: "path",
    name: `Path ${id}`,
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    closed: true,
  };
}

/** One unrelated undoable action: nudge "r" from x=10 to x=15. */
function seedNudge() {
  const s = useStore.getState();
  s.addObject(makeRect("r", 10));
  s.withUndo("nudge", () => {
    useStore.getState().updateObject("r", {
      transform: { ...useStore.getState().objectsById.get("r")!.transform, x: 15 },
    });
  });
}

const images = () => useStore.getState().objects.filter((o) => o.type === "image");
const rX = () => useStore.getState().objectsById.get("r")?.transform.x;

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
    openDialogs: new Set(),
    snapToGrid: false,
  });
});

describe("F8 image import through ImageImportDialog records one undo step", () => {
  it("Import grows the undo stack by 1; undo removes only the image; redo restores it", () => {
    seedNudge();
    const before = useStore.getState().undoStack.length;
    render(
      <ImageImportDialog
        open
        imageData="data:image/png;base64,AAAA"
        fileName="a.png"
        imageWidth={100}
        imageHeight={100}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(images()).toHaveLength(1);
    expect(useStore.getState().selectedIds).toEqual([images()[0].id]);
    expect(useStore.getState().undoStack.length).toBe(before + 1);

    useStore.getState().undo();
    expect(images()).toHaveLength(0);
    expect(rX()).toBe(15);
    expect(useStore.getState().selectedIds).toEqual([]);

    useStore.getState().redo();
    expect(images()).toHaveLength(1);
    expect(images()[0].imageData).toBe("data:image/png;base64,AAAA");
    expect(useStore.getState().selectedIds).toEqual([images()[0].id]);
  });
});

describe("F8 importImageData (File > Import Image) records one undo step", () => {
  const RealImage = globalThis.Image;
  beforeEach(() => {
    class FakeImage {
      width = 100;
      height = 100;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        this.onload?.();
      }
    }
    globalThis.Image = FakeImage as unknown as typeof Image;
  });
  afterEach(() => {
    globalThis.Image = RealImage;
  });

  it("undo stack grows by 1; undo removes only the image; redo restores its imageData", () => {
    seedNudge();
    const before = useStore.getState().undoStack.length;
    importImageData(new Uint8Array([1, 2, 3, 4]), "png");
    expect(images()).toHaveLength(1);
    expect(useStore.getState().selectedIds).toEqual([images()[0].id]);
    const data = images()[0].imageData;
    expect(data).toBe(`data:image/png;base64,${btoa("\x01\x02\x03\x04")}`);
    expect(useStore.getState().undoStack.length).toBe(before + 1);

    useStore.getState().undo();
    expect(images()).toHaveLength(0);
    expect(rX()).toBe(15);
    expect(useStore.getState().selectedIds).toEqual([]);

    useStore.getState().redo();
    expect(images()).toHaveLength(1);
    expect(images()[0].imageData).toBe(data);
    expect(useStore.getState().selectedIds).toEqual([images()[0].id]);
  });
});

describe("F8 importPdfVectors (PDF onImportVector) records one undo step", () => {
  it("two paths import as one entry and one undo removes both", () => {
    seedNudge();
    useStore.getState().openDialog("pdfImport");
    useStore.getState().setDialogData({ pendingPdf: { data: new ArrayBuffer(0), name: "x.pdf" } });
    const before = useStore.getState().undoStack.length;
    importPdfVectors([makePath("pa"), makePath("pb")]);
    expect(useStore.getState().openDialogs.has("pdfImport")).toBe(false);
    expect(useStore.getState().dialogData.pendingPdf).toBeNull();
    const ids = () => useStore.getState().objects.map((o) => o.id);
    expect(ids()).toEqual(["r", "pa", "pb"]);
    expect(useStore.getState().undoStack.length).toBe(before + 1);

    useStore.getState().undo();
    expect(ids()).toEqual(["r"]);
    expect(rX()).toBe(15);

    useStore.getState().redo();
    expect(ids()).toEqual(["r", "pa", "pb"]);
  });
});
