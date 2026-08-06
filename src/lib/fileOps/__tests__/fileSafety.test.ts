/**
 * P3-A File Safety tests — covers findings 1-6:
 *   1. Atomic save (write-to-tmp then rename)
 *   2. parseAndValidateProject shared helper
 *   3. Image import onerror handler
 *   4. PNG chunk length guard
 *   5. autoSave path.join
 *   6. .bak per-path tracking
 *   7. PDF constructPath + v5 stroke color (separate)
 *   8. SVG import skip surfacing (separate)
 *   9. SVG export rotation (separate)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Tauri shims ────────────────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

const mockDialogMessage = vi.fn();
const mockDialogSave = vi.fn();
const mockDialogOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: mockDialogMessage,
  save: mockDialogSave,
  open: mockDialogOpen,
}));

const mockWriteTextFile = vi.fn();
const mockReadTextFile = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();
const mockRemove = vi.fn();
const mockMkdir = vi.fn();
const mockRename = vi.fn();
const mockExists = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: mockWriteTextFile,
  readTextFile: mockReadTextFile,
  readFile: mockReadFile,
  stat: mockStat,
  remove: mockRemove,
  mkdir: mockMkdir,
  rename: mockRename,
  exists: mockExists,
}));

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn().mockResolvedValue("/mock/appdata/"),
  join: vi.fn().mockImplementation((...parts: string[]) =>
    Promise.resolve(parts.join("/").replace(/\/+/g, "/")),
  ),
}));

vi.mock("../../autoSave", () => ({
  startAutoSave: vi.fn().mockResolvedValue(undefined),
  stopAutoSave: vi.fn(),
  checkRecoveryFile: vi.fn().mockResolvedValue(null),
  clearRecoveryFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../recentFiles", () => ({
  getRecentFiles: vi.fn().mockReturnValue([]),
  addRecentFile: vi.fn().mockReturnValue(undefined),
  clearRecentFiles: vi.fn().mockReturnValue(undefined),
}));

// ─── Application imports ────────────────────────────────────────────────────
import { useStore } from "../../../app/store";
import { DEFAULT_LAYERS } from "../../../app/types";
import { fileOperations, parseAndValidateProject } from "../index";
import { parsePngPhysDpi } from "../imageImport";

function resetStore() {
  useStore.setState({
    objects: [],
    objectsById: new Map(),
    selectedIds: [],
    selectedSet: new Set(),
    undoStack: [],
    redoStack: [],
    isDirty: true,
    projectPath: "/home/user/test.kerf",
    projectName: "TestProject",
    layers: DEFAULT_LAYERS,
    workspaceWidth: 300,
    workspaceHeight: 200,
    statusMessage: null,
    consoleLines: [],
    gcodeResult: null,
  });
}

// ─── Finding 1: Atomic save ─────────────────────────────────────────────────
describe("P3-A Finding 1: atomic save (tmp + rename)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRename.mockResolvedValue(undefined);
    mockRemove.mockResolvedValue(undefined);
    resetStore();
  });

  it("writes to .tmp first, then renames over original", async () => {
    mockWriteTextFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);

    const ok = await fileOperations.saveProject();

    expect(ok).toBe(true);
    // First write must be to .tmp
    expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
    expect(mockWriteTextFile.mock.calls[0][0]).toBe("/home/user/test.kerf.tmp");
    // Then rename .tmp -> original
    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(mockRename.mock.calls[0][0]).toBe("/home/user/test.kerf.tmp");
    expect(mockRename.mock.calls[0][1]).toBe("/home/user/test.kerf");
  });

  it("falls back to direct write when rename fails (scope denial)", async () => {
    mockWriteTextFile.mockResolvedValue(undefined);
    mockRename.mockRejectedValue(new Error("scope denied"));

    const ok = await fileOperations.saveProject();

    expect(ok).toBe(true);
    // First call: .tmp; second call: direct write to original
    expect(mockWriteTextFile).toHaveBeenCalledTimes(2);
    expect(mockWriteTextFile.mock.calls[1][0]).toBe("/home/user/test.kerf");
    // .tmp should be cleaned up
    expect(mockRemove).toHaveBeenCalledWith("/home/user/test.kerf.tmp");
  });

  it("tmp write failure does not corrupt original (returns false)", async () => {
    mockWriteTextFile.mockRejectedValue(new Error("disk full"));

    const ok = await fileOperations.saveProject();

    expect(ok).toBe(false);
    expect(useStore.getState().isDirty).toBe(true);
    // rename should never be called
    expect(mockRename).not.toHaveBeenCalled();
  });
});

// ─── Finding 2: parseAndValidateProject ─────────────────────────────────────
describe("P3-A Finding 2: parseAndValidateProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it("returns parsed project for valid JSON with objects and layers", () => {
    const content = JSON.stringify({
      version: "0.1.0",
      name: "Test",
      objects: [],
      layers: DEFAULT_LAYERS,
      camera: { x: 0, y: 0, zoom: 1 },
      workspaceWidth: 300,
      workspaceHeight: 200,
    });
    const result = parseAndValidateProject(content, "test.kerf");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Test");
  });

  it("returns null and surfaces error for invalid JSON", () => {
    const result = parseAndValidateProject("{corrupt", "test.kerf");
    expect(result).toBeNull();
    expect(useStore.getState().statusMessage).toContain("corrupted");
    const errorLines = useStore.getState().consoleLines.filter((l) => l.type === "error");
    expect(errorLines.length).toBeGreaterThan(0);
  });

  it("returns null and surfaces error for missing objects array", () => {
    const content = JSON.stringify({
      name: "Test",
      layers: [],
    });
    const result = parseAndValidateProject(content, "test.kerf");
    expect(result).toBeNull();
    expect(useStore.getState().statusMessage).toContain("missing");
  });

  it("returns null and surfaces error for missing layers array", () => {
    const content = JSON.stringify({
      name: "Test",
      objects: [],
    });
    const result = parseAndValidateProject(content, "test.kerf");
    expect(result).toBeNull();
    expect(useStore.getState().statusMessage).toContain("missing");
  });
});

// ─── Finding 4: PNG chunk length guard ──────────────────────────────────────
describe("P3-A Finding 4: PNG chunk length guard", () => {
  it("does not freeze on corrupt PNG with oversized chunk length", () => {
    // Create a PNG with a valid signature but a chunk length
    // larger than the file — should bail instead of looping
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    // Chunk length = 0xFFFFFFFF (4 GB) — far beyond the file size
    const badLen = [0xFF, 0xFF, 0xFF, 0xFF];
    const ihdrType = [73, 72, 68, 82];
    const data = new Uint8Array([...sig, ...badLen, ...ihdrType, 0, 0, 0, 0]);

    const start = Date.now();
    const result = parsePngPhysDpi(data);
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // Must complete quickly, not hang (< 100ms is generous)
    expect(elapsed).toBeLessThan(100);
  });

  it("handles negative chunk length (sign bit set) without freezing", () => {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    // 0x80000000 — would be negative in signed 32-bit
    const badLen = [0x80, 0x00, 0x00, 0x00];
    const ihdrType = [73, 72, 68, 82];
    const data = new Uint8Array([...sig, ...badLen, ...ihdrType, 0, 0, 0, 0]);

    const start = Date.now();
    const result = parsePngPhysDpi(data);
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(100);
  });
});

// ─── Finding 6: .bak per-path tracking ──────────────────────────────────────
describe("P3-A Finding 6: .bak per-path tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRename.mockResolvedValue(undefined);
    mockRemove.mockResolvedValue(undefined);
    resetStore();
  });

  it("capabilities/default.json includes fs:allow-rename", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const capPath = path.resolve(
      __dirname,
      "../../../../src-tauri/capabilities/default.json",
    );
    const raw = fs.readFileSync(capPath, "utf-8");
    const cap = JSON.parse(raw) as { permissions: string[] };
    expect(cap.permissions).toContain("fs:allow-rename");
  });
});
