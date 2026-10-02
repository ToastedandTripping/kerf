/**
 * refresh-editing-shortcuts F8 (Razor W1): App hands PdfImportDialog the
 * undoable `importPdfVectors` as `onImportVector`. Without that prop the
 * dialog silently falls back to a raster import (PdfImportDialog.tsx:172).
 * Every heavy child is mocked; PdfImportDialog is mocked to capture its props.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  pdfProps: null as null | Record<string, unknown>,
  Null: () => null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));
vi.mock("../../lib/autoSave", () => ({
  startAutoSave: vi.fn(),
  checkRecoveryFile: vi.fn(() => Promise.resolve(null)),
  clearRecoveryFile: vi.fn(),
}));
vi.mock("../../components/panels/PdfImportDialog", () => ({
  PdfImportDialog: (props: Record<string, unknown>) => {
    h.pdfProps = props;
    return null;
  },
}));
vi.mock("../../components/topbar/MenuBar", () => ({ MenuBar: h.Null }));
vi.mock("../../components/toolbar/Toolbar", () => ({ Toolbar: h.Null }));
vi.mock("../../components/viewport/Viewport", () => ({ Viewport: h.Null }));
vi.mock("../../components/viewport/Rulers", () => ({ Rulers: h.Null }));
vi.mock("../../components/panels/LayerPanel", () => ({ LayerPanel: h.Null }));
vi.mock("../../components/panels/MaterialLibrary", () => ({ MaterialLibrary: h.Null }));
vi.mock("../../components/panels/PropertiesPanel", () => ({ PropertiesPanel: h.Null }));
vi.mock("../../components/panels/MachinePanel", () => ({ MachinePanel: h.Null }));
vi.mock("../../components/panels/JobActionBar", () => ({ JobActionBar: h.Null }));
vi.mock("../../components/bottom/StatusBar", () => ({ StatusBar: h.Null }));
vi.mock("../../components/bottom/Console", () => ({ Console: h.Null }));
vi.mock("../../components/bottom/JobPreview", () => ({ JobPreview: h.Null }));
vi.mock("../../components/panels/GrblSettingsDialog", () => ({ GrblSettingsDialog: h.Null }));
vi.mock("../../components/panels/MaterialTestDialog", () => ({ MaterialTestDialog: h.Null }));
vi.mock("../../components/panels/ImageTraceDialog", () => ({ ImageTraceDialog: h.Null }));
vi.mock("../../components/panels/DitherPreviewDialog", () => ({ DitherPreviewDialog: h.Null }));
vi.mock("../../components/panels/NestingDialog", () => ({ NestingDialog: h.Null }));
vi.mock("../../components/panels/OnboardingOverlay", () => ({
  OnboardingOverlay: h.Null,
  shouldShowOnboarding: () => false,
}));

import { render, cleanup, act } from "@testing-library/react";
import { useStore } from "../store";
import type { DesignObject } from "../types";
import App from "../App";

function makePath(id: string): DesignObject {
  return {
    id,
    type: "path",
    name: id,
    transform: { x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    closed: true,
  };
}

beforeEach(() => {
  cleanup();
  h.pdfProps = null;
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

describe("F8 App wires PdfImportDialog.onImportVector to the undoable import", () => {
  it("the prop App passes imports the vectors as one undo step and closes the dialog", () => {
    useStore.getState().openDialog("pdfImport");
    useStore.getState().setDialogData({ pendingPdf: { data: new ArrayBuffer(0), name: "v.pdf" } });
    render(<App />);
    const onImportVector = h.pdfProps?.onImportVector as
      | ((objs: DesignObject[]) => void)
      | undefined;
    expect(typeof onImportVector).toBe("function");

    act(() => onImportVector!([makePath("pa"), makePath("pb")]));
    const s = useStore.getState();
    expect(s.objects.map((o) => o.id)).toEqual(["pa", "pb"]);
    expect(s.undoStack.length).toBe(1);
    expect(s.openDialogs.has("pdfImport")).toBe(false);
    expect(s.dialogData.pendingPdf).toBeNull();
  });
});
