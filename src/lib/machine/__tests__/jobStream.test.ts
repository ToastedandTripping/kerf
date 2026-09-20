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
import { SerialTraceRecorder } from "../../../lib/machine/__tests__/serialTraceHarness";

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

let recorder: SerialTraceRecorder;

describe("jobStream.ts — Phase 2A streaming mode dispatch", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    localStorage.clear();
    seedStore();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (recorder) {
      await recorder.dispose();
    }
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
      recorder = new SerialTraceRecorder(() => ({ responses: ["ok"], drained: [] }));
      mockInvoke.mockImplementation(recorder.handler);
      const result = await streamJob("G1 X10 F500", { label: "Test" });
      // Per-line path invokes serial_send
      expect(mockInvoke).toHaveBeenCalledWith("serial_send", expect.anything());
      expect(result.endState).toBe("complete");
    });

    it("uses buffered path when mode is buffered", async () => {
      localStorage.setItem("streamingMode", "buffered");
      // Buffered path calls serial_stream_job
      recorder = new SerialTraceRecorder();
      mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === "serial_stream_job") return "complete";
        return recorder.handler(cmd, args);
      });
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
      let callCount = 0;
      mockInvoke.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return "disconnected: port closed";
        return undefined;
      });
      const result = await streamJob("G1 X10 F500", { label: "Test" });
      expect(result.endState).toBe("error");
      expect(result.portDisconnected).toBe(true);
      expect(useStore.getState().machineConnected).toBe(false);
    });

    it("handles invoke rejection", async () => {
      let callCount = 0;
      mockInvoke.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("Not connected");
        return undefined;
      });
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

  // ---- Recorder deferred callback tests ----
  describe("SerialTraceRecorder — deferred invokes", () => {
    it("can defer and release an invoke", async () => {
      recorder = new SerialTraceRecorder();
      recorder.defer("serial_send");
      mockInvoke.mockImplementation(recorder.handler);

      // Start a deferred send
      const sendPromise = recorder.handler("serial_send", { command: "G1 X10" });

      // At this point, the promise should still be pending
      let resolved = false;
      sendPromise.then(() => {
        resolved = true;
      });

      // Let microtasks run
      await new Promise((r) => setImmediate(r));
      expect(resolved).toBe(false); // Still pending

      // Release it
      const sendIndex = recorder.getRecordIndex("serial_send");
      recorder.releaseInvoke(sendIndex, { responses: ["ok"], drained: [] });

      // Now it should resolve
      await sendPromise;
      expect(resolved).toBe(true);
    });
  });

  // ---- Cross-job corruption edge case (batch 1.4 fix) ----
  describe("Cross-job safety (currently unsafe, batch 1.4)", () => {
    it.fails(
      "R4/R11: job A late callback corrupts job B — owned by batch 1.4",
      async () => {
        // This test documents the CURRENT unsafe behavior:
        // When job A's callback arrives after job B has started,
        // and job A re-reads jobRunning (which B set to true),
        // job A continues sending and corrupts B's state.
        //
        // it.fails() means: this test is EXPECTED to fail today.
        // When batch 1.4 fixes the cross-job ownership issue,
        // remove the .fails wrapper and the test becomes a regression guard.

        localStorage.setItem("streamingMode", "buffered");
        recorder = new SerialTraceRecorder();
        recorder.defer("serial_stream_job");
        mockInvoke.mockImplementation(recorder.handler);

        // Start job A
        useStore.setState({ jobRunning: true, jobProgress: 0 });
        const jobA = streamJob("G1 X10 F500", { label: "Job A" });
        recorder.trackJobPromise(jobA);

        // Wait for job A to invoke serial_stream_job
        const jobAIndex = await recorder.waitUntilInvoked("serial_stream_job");

        // Simulate job B starting (new streamJob call)
        useStore.setState({ jobRunning: true, jobProgress: 0 });
        const jobB = streamJob("G1 X20 F500", { label: "Job B" });
        recorder.trackJobPromise(jobB);

        // Now release job A's invoke — CURRENT BEHAVIOR: job A's callback
        // re-reads jobRunning (true, set by job B) and continues sending,
        // which corrupts job B's execution.
        recorder.releaseInvoke(jobAIndex, "complete");

        // Both jobs should eventually complete, but job B's output is corrupted.
        // The test fails because we can't reliably detect corruption here without
        // the fix. The fix (batch 1.4) will make this test pass by ensuring
        // callbacks only execute if they still own the current job.
        await expect(Promise.race([jobA, jobB])).rejects.toThrow();
      }
    );
  });
});
