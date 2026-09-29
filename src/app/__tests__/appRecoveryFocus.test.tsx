/**
 * refresh-editing-shortcuts fix4 (Razor W2): the crash-recovery prompt must not
 * open with focus on "Discard", which deletes the recovery file for good on a
 * stray Enter or a held Space. Every heavy child is mocked (as appPdfWiring).
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
  checkRecoveryFile: vi.fn(() =>
    Promise.resolve({ project: { version: 1, objects: [], layers: [] }, timestamp: 1 })
  ),
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
import { afterAll, beforeAll } from "vitest";
import { useStore } from "../store";
import App from "../App";

const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
beforeAll(() => {
  // jsdom's offsetParent is always null; let the trap see children as a browser does
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentNode;
    },
  });
});
afterAll(() => {
  if (desc) Object.defineProperty(HTMLElement.prototype, "offsetParent", desc);
});

beforeEach(() => {
  cleanup();
  useStore.setState({ openDialogs: new Set(), snapToGrid: false });
});

describe("recovery prompt initial focus", () => {
  it("opens with focus on Restore, never on Discard", async () => {
    render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const dialog = document.querySelector('[aria-labelledby="recovery-dialog-title"]');
    expect(dialog).not.toBeNull();
    expect(document.activeElement?.textContent?.trim()).toBe("Restore");
  });
});
