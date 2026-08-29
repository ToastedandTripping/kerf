import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must mock before importing modules that use it
vi.mock("@tauri-apps/api/core", () => {
  class MockChannel {
    onmessage: ((event: unknown) => void) | null = null;
  }
  return {
    invoke: vi.fn(),
    Channel: MockChannel,
  };
});

import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../../app/store";
import { DEFAULT_LAYERS } from "../../../app/types";
import { getStreamingMode, streamJob } from "../jobStream";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

function seedStore() {
  useStore.setState({
    objects: [],
    selectedIds: [],
    undoStack: [],
    redoStack: [],
    consoleLines: [],
    layers: DEFAULT_LAYERS,
    machineConnected: true,
    machineState: "idle",
    machinePosition: { x: 0, y: 0, z: 0 },
    jobRunning: true,
    jobProgress: 0,
    grblLaserMode: true,
    grblSValueMax: 1000,
    grblMaxFeedRateX: 0,
    grblMaxFeedRateY: 0,
  });
}

describe("jobStream.ts — Phase 2A streaming mode dispatch", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    localStorage.clear();
    seedStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getStreamingMode", () => {
    it("defaults to perLine when localStorage is empty", () => {
      expect(getStreamingMode()).toBe("perLine");
    });

    it("returns perLine when set to perLine", () => {
      localStorage.setItem("streamingMode", "perLine");
      expect(getStreamingMode()).toBe("perLine");
    });

    it("returns buffered when set to buffered", () => {
      localStorage.setItem("streamingMode", "buffered");
      expect(getStreamingMode()).toBe("buffered");
    });

    it("defaults to perLine for unknown values", () => {
      localStorage.setItem("streamingMode", "somethingElse");
      expect(getStreamingMode()).toBe("perLine");
    });
  });

  describe("streamJob mode dispatch", () => {
    it("uses per-line path when mode is perLine (default)", async () => {
      // Per-line path calls serial_send for each G-code line
      mockInvoke.mockResolvedValue({ responses: ["ok"], drained: [] });
      const result = await streamJob("G1 X10 F500", { label: "Test" });
      // Per-line path invokes serial_send
      expect(mockInvoke).toHaveBeenCalledWith("serial_send", expect.anything());
      expect(result.endState).toBe("complete");
    });

    it("uses buffered path when mode is buffered", async () => {
      localStorage.setItem("streamingMode", "buffered");
      // Buffered path calls serial_stream_job
      mockInvoke.mockResolvedValueOnce("complete");
      const result = await streamJob("G1 X10 F500", { label: "Test" });
      expect(mockInvoke).toHaveBeenCalledWith("serial_stream_job", expect.anything());
      expect(result.endState).toBe("complete");
    });
  });

  describe("streamJobBuffered outcomes", () => {
    beforeEach(() => {
      localStorage.setItem("streamingMode", "buffered");
    });

    it("maps cancelled outcome correctly", async () => {
      mockInvoke.mockResolvedValueOnce("cancelled");
      const result = await streamJob("G1 X10 F500", { label: "Test" });
      expect(result.endState).toBe("cancelled");
    });

    it("maps alarm outcome correctly", async () => {
      mockInvoke.mockResolvedValueOnce("alarm: ALARM:1");
      const result = await streamJob("G1 X10 F500", { label: "Test" });
      expect(result.endState).toBe("alarm");
    });

    it("maps error outcome correctly", async () => {
      mockInvoke.mockResolvedValueOnce("error: error:9");
      const result = await streamJob("G1 X10 F500", { label: "Test" });
      expect(result.endState).toBe("error");
    });

    it("maps disconnected outcome and updates store", async () => {
      mockInvoke.mockResolvedValueOnce("disconnected: port closed");
      // Mock the disconnect call
      mockInvoke.mockResolvedValueOnce(undefined);
      const result = await streamJob("G1 X10 F500", { label: "Test" });
      expect(result.endState).toBe("error");
      expect(result.portDisconnected).toBe(true);
      expect(useStore.getState().machineConnected).toBe(false);
    });

    it("handles invoke rejection", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("Not connected"));
      // Mock the disconnect call
      mockInvoke.mockResolvedValueOnce(undefined);
      const result = await streamJob("G1 X10 F500", { label: "Test" });
      expect(result.endState).toBe("error");
    });

    it("cleans up jobRunning and jobProgress on every exit", async () => {
      mockInvoke.mockResolvedValueOnce("complete");
      await streamJob("G1 X10 F500", { label: "Test" });
      expect(useStore.getState().jobRunning).toBe(false);
      expect(useStore.getState().jobProgress).toBe(0);
    });
  });
});
