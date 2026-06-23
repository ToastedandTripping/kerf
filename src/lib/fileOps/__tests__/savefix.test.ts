/**
 * Save Fix (v0.8.11) — unit tests for Fix B (error surfacing + data-loss correctness)
 * and a regression guard for Fix A (capability file content).
 *
 * The Tauri ACL itself is NOT testable here (build-time/runtime concern).
 * These tests mock @tauri-apps/plugin-fs to verify:
 *   1. saveToPath returns false and surfaces an error (setStatusMessage + addConsoleLine "error")
 *      when the write throws; returns true and clears dirty on success.
 *   2. A failed saveProject does NOT call clearRecoveryFile and does NOT addRecentFile.
 *   3. checkUnsavedChanges returns false (aborts) when the user picks "Save" but the save fails.
 *   4. exportSvg / exportGcode surface errors on failure; emit success line only on success.
 *   5. Regression guard: capabilities/default.json contains fs:allow-write-text-file and
 *      does NOT rely on bare fs:allow-write as the sole write grant.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Tauri shim (required before module imports) ────────────────────────────

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

// The dialog plugin is lazy-imported inside ensureTauri(). We need it to return
// a mock that controls dialog results. We do this by mocking the module so the
// dynamic `import("@tauri-apps/plugin-dialog")` resolves our fake.
const mockDialogMessage = vi.fn();
const mockDialogSave = vi.fn();
const mockDialogOpen = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: mockDialogMessage,
  save: mockDialogSave,
  open: mockDialogOpen,
}));

// The fs plugin is lazy-imported inside saveToPath / exportSvg / exportGcode.
// We mock the module and expose individual fn mocks we can swap per test.
const mockWriteTextFile = vi.fn();
const mockReadTextFile = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();
const mockRemove = vi.fn();
const mockMkdir = vi.fn();

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: mockWriteTextFile,
  readTextFile: mockReadTextFile,
  readFile: mockReadFile,
  stat: mockStat,
  remove: mockRemove,
  mkdir: mockMkdir,
}));

// autoSave imports @tauri-apps/api/path for appDataDir — stub it
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn().mockResolvedValue("/mock/appdata/"),
}));

// ─── Application imports ─────────────────────────────────────────────────────

import { useStore } from "../../../app/store";
import { DEFAULT_LAYERS } from "../../../app/types";
import { fileOperations } from "../index";
import * as recentFilesModule from "../../recentFiles";
import * as autoSaveModule from "../../autoSave";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resetStore() {
  useStore.setState({
    objects: [],
    objectsById: new Map(),
    selectedIds: [],
    selectedSet: new Set(),
    undoStack: [],
    redoStack: [],
    isDirty: true,          // start dirty so save paths are exercised
    projectPath: "/tmp/test.kerf",
    projectName: "TestProject",
    layers: DEFAULT_LAYERS,
    workspaceWidth: 300,
    workspaceHeight: 200,
    statusMessage: null,
    consoleLines: [],
    gcodeResult: null,
  });
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe("saveToPath — success/failure behaviour via saveProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it("saveProject: write succeeds → isDirty cleared, returns true", async () => {
    mockWriteTextFile.mockResolvedValueOnce(undefined);

    const ok = await fileOperations.saveProject();

    expect(ok).toBe(true);
    expect(useStore.getState().isDirty).toBe(false);
    expect(useStore.getState().statusMessage).toBeNull();
    // No error console line emitted
    const errorLines = useStore.getState().consoleLines.filter((l) => l.type === "error");
    expect(errorLines).toHaveLength(0);
  });

  it("saveProject: write throws → returns false, dirty preserved, error surfaced", async () => {
    mockWriteTextFile.mockRejectedValueOnce(new Error("permission denied"));

    const ok = await fileOperations.saveProject();

    expect(ok).toBe(false);
    // isDirty must remain true — the project is still unsaved
    expect(useStore.getState().isDirty).toBe(true);
    // Status message must be set
    expect(useStore.getState().statusMessage).toBeTruthy();
    // An error console line must be emitted
    const errorLines = useStore.getState().consoleLines.filter((l) => l.type === "error");
    expect(errorLines.length).toBeGreaterThan(0);
  });
});

describe("saveProject: recovery + recent-file are not cleared/added on failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("failed save does NOT call clearRecoveryFile", async () => {
    mockWriteTextFile.mockRejectedValueOnce(new Error("disk full"));
    const clearSpy = vi.spyOn(autoSaveModule, "clearRecoveryFile").mockResolvedValue(undefined);

    await fileOperations.saveProject();

    expect(clearSpy).not.toHaveBeenCalled();
  });

  it("failed save does NOT call addRecentFile", async () => {
    mockWriteTextFile.mockRejectedValueOnce(new Error("disk full"));
    const recentSpy = vi.spyOn(recentFilesModule, "addRecentFile").mockReturnValue(undefined);

    await fileOperations.saveProject();

    expect(recentSpy).not.toHaveBeenCalled();
  });

  it("successful save DOES call clearRecoveryFile and addRecentFile", async () => {
    mockWriteTextFile.mockResolvedValueOnce(undefined);
    const clearSpy = vi.spyOn(autoSaveModule, "clearRecoveryFile").mockResolvedValue(undefined);
    const recentSpy = vi.spyOn(recentFilesModule, "addRecentFile").mockReturnValue(undefined);

    await fileOperations.saveProject();

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(recentSpy).toHaveBeenCalledTimes(1);
  });
});

describe("checkUnsavedChanges: aborts when save fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it("user picks Save, write fails → checkUnsavedChanges returns false (aborts New/Open)", async () => {
    // Dialog returns "Save" (or "Yes")
    mockDialogMessage.mockResolvedValueOnce("Save");
    mockWriteTextFile.mockRejectedValueOnce(new Error("permission denied"));

    // checkUnsavedChanges is not exported directly; we exercise it via newProject()
    // which calls it and only proceeds if it returns true. If it returns false,
    // newProject returns early and the project name stays "TestProject" (not "Untitled").
    const nameBefore = useStore.getState().projectName;
    await fileOperations.newProject();

    // If abort worked, project name unchanged (newProject's loadProject never ran)
    expect(useStore.getState().projectName).toBe(nameBefore);
  });

  it("user picks Save, write succeeds → newProject proceeds (name becomes Untitled)", async () => {
    mockDialogMessage.mockResolvedValueOnce("Save");
    mockWriteTextFile.mockResolvedValueOnce(undefined);
    vi.spyOn(autoSaveModule, "clearRecoveryFile").mockResolvedValue(undefined);
    vi.spyOn(recentFilesModule, "addRecentFile").mockReturnValue(undefined);

    await fileOperations.newProject();

    expect(useStore.getState().projectName).toBe("Untitled");
  });
});

describe("exportSvg: error surfacing + success line", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    useStore.setState({ isDirty: false, workspaceWidth: 300, workspaceHeight: 200 });
    // Dialog returns a path
    mockDialogSave.mockResolvedValueOnce("/tmp/out.svg");
  });

  it("write failure → statusMessage set and error console line emitted", async () => {
    mockWriteTextFile.mockRejectedValueOnce(new Error("no space left"));

    await fileOperations.exportSvg();

    expect(useStore.getState().statusMessage).toBeTruthy();
    const errorLines = useStore.getState().consoleLines.filter((l) => l.type === "error");
    expect(errorLines.length).toBeGreaterThan(0);
    // No info line emitted
    const infoLines = useStore.getState().consoleLines.filter((l) => l.type === "info");
    expect(infoLines).toHaveLength(0);
  });

  it("write success → info console line emitted, no statusMessage error", async () => {
    mockWriteTextFile.mockResolvedValueOnce(undefined);

    await fileOperations.exportSvg();

    expect(useStore.getState().statusMessage).toBeNull();
    const infoLines = useStore.getState().consoleLines.filter((l) => l.type === "info");
    expect(infoLines.length).toBeGreaterThan(0);
    expect(infoLines[0].text).toContain("/tmp/out.svg");
    const errorLines = useStore.getState().consoleLines.filter((l) => l.type === "error");
    expect(errorLines).toHaveLength(0);
  });
});

describe("exportGcode: error surfacing + success line only on success", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    useStore.setState({
      isDirty: false,
      gcodeResult: {
        gcode: "G21\nG90\nM5\n",
        moves: [],
        totalDistance: 0,
        cutDistance: 0,
        travelDistance: 0,
        estimatedTimeSecs: 0,
        lineCount: 3,
      },
    });
    mockDialogSave.mockResolvedValueOnce("/tmp/out.gcode");
  });

  it("write failure → statusMessage set and error console line emitted, no success line", async () => {
    mockWriteTextFile.mockRejectedValueOnce(new Error("permission denied"));

    await fileOperations.exportGcode();

    expect(useStore.getState().statusMessage).toBeTruthy();
    const errorLines = useStore.getState().consoleLines.filter((l) => l.type === "error");
    expect(errorLines.length).toBeGreaterThan(0);
    const infoLines = useStore.getState().consoleLines.filter((l) => l.type === "info");
    expect(infoLines).toHaveLength(0);
  });

  it("write success → info console line emitted, no error", async () => {
    mockWriteTextFile.mockResolvedValueOnce(undefined);

    await fileOperations.exportGcode();

    expect(useStore.getState().statusMessage).toBeNull();
    const infoLines = useStore.getState().consoleLines.filter((l) => l.type === "info");
    expect(infoLines.length).toBeGreaterThan(0);
    expect(infoLines[0].text).toContain("/tmp/out.gcode");
    const errorLines = useStore.getState().consoleLines.filter((l) => l.type === "error");
    expect(errorLines).toHaveLength(0);
  });
});

// ─── Regression guard: capabilities/default.json must grant write_text_file ──

describe("Regression guard: capabilities/default.json permission grants", () => {
  it("contains fs:allow-write-text-file (the command grant for writeTextFile)", () => {
    // Resolve path relative to this test file's location:
    // __dirname = src/lib/fileOps/__tests__
    // capabilities is at: src-tauri/capabilities/default.json
    const capPath = path.resolve(
      __dirname,
      "../../../../src-tauri/capabilities/default.json",
    );
    const raw = fs.readFileSync(capPath, "utf-8");
    const cap = JSON.parse(raw) as { permissions: string[] };
    expect(cap.permissions).toContain("fs:allow-write-text-file");
  });

  it("does NOT rely on bare fs:allow-write as the sole write grant", () => {
    // fs:allow-write only grants the low-level write-to-handle command, NOT
    // writeTextFile. If it's present alongside fs:allow-write-text-file that's
    // fine; but it must NOT be the only write-capable permission.
    const capPath = path.resolve(
      __dirname,
      "../../../../src-tauri/capabilities/default.json",
    );
    const raw = fs.readFileSync(capPath, "utf-8");
    const cap = JSON.parse(raw) as { permissions: string[] };

    const hasWriteTextFile = cap.permissions.includes("fs:allow-write-text-file");
    const hasOnlyBareWrite =
      cap.permissions.includes("fs:allow-write") && !hasWriteTextFile;

    expect(hasOnlyBareWrite).toBe(false);
  });
});
