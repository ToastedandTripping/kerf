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
import { beginJobSession, _testResetJobSession } from "../jobSession";
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
    _testResetJobSession();
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

    it("maps error outcome and fires emergencyStop via serial_stop (not M5+softReset)", async () => {
      const calls: string[] = [];
      mockInvoke.mockImplementation(async (cmd: string) => {
        calls.push(cmd);
        if (cmd === "serial_stream_job") return "error: error:9";
        if (cmd === "serial_stop") {
          return {
            outcome: "confirmed",
            epochBefore: 1,
            epochAfter: 2,
            messages: ["STOP: 0x18 sent"],
          };
        }
        return undefined;
      });
      const result = await streamJob("G1 X10 F500", { label: "Test" });
      expect(result.endState).toBe("error");
      // Safety volley must route through serial_stop, NOT send M5+softReset
      expect(calls).toContain("serial_stop");
      expect(calls).not.toContain("serial_send");
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

  // ---- B3: Job session draining and lifetime tests ----
  describe("Job session draining (B3)", () => {
    it("drain timeout returns unknown, not complete", async () => {
      // Mutant 2: if 30s expiry returns "complete" instead of "unknown", this fails.
      vi.useFakeTimers();

      recorder = new SerialTraceRecorder();
      mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === "serial_job_begin") return 1;
        if (cmd === "serial_job_end") return undefined;
        if (cmd === "serial_get_status") {
          // Always return Run — never Idle — to trigger drain timeout.
          return {
            status: "<Run|MPos:0.000,0.000,0.000|FS:1000,0>",
            events: [],
          };
        }
        return recorder.handler(cmd, args);
      });

      const session = await beginJobSession("Test");
      expect(session).not.toBeNull();
      useStore.setState({ jobRunning: true, jobProgress: 0 });

      // Start drain in background.
      const drainPromise = session!.drain(true);

      // Advance past the 30s drain timeout.
      await vi.advanceTimersByTimeAsync(35000);

      const result = await drainPromise;
      // Must be "unknown", NOT "complete".
      expect(result).toBe("unknown");

      // Verify console warning about drain timeout.
      const consoleTexts = useStore.getState().consoleLines.map((l) => l.text);
      expect(consoleTexts.some((t) => t.includes("drain timeout"))).toBe(true);

      vi.useRealTimers();
    });

    it("auxiliary jobs (FRAME) go through session draining", async () => {
      // Mutant 3: if auxiliary jobs skip draining, they wouldn't acquire a session.
      recorder = new SerialTraceRecorder();
      let jobBeginCalled = false;
      let jobEndCalled = false;
      mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === "serial_job_begin") {
          jobBeginCalled = true;
          return 1;
        }
        if (cmd === "serial_job_end") {
          jobEndCalled = true;
          return undefined;
        }
        return recorder.handler(cmd, args);
      });

      const session = await beginJobSession("Frame");
      expect(session).not.toBeNull();
      expect(jobBeginCalled).toBe(true);

      useStore.setState({ jobRunning: true, jobProgress: 0 });
      await streamJob("M5\nG0 X10 Y10\nM5", { label: "Frame", session: session! });

      expect(jobEndCalled).toBe(true);
      expect(useStore.getState().jobRunning).toBe(false);
    });

    it("session.cancel() wakes drain wait", async () => {
      // Mutant 5: STOP clears running before native quiescence.
      // If cancel doesn't work, drain hangs.
      recorder = new SerialTraceRecorder();
      mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === "serial_job_begin") return 1;
        if (cmd === "serial_job_end") return undefined;
        if (cmd === "serial_get_status") {
          return {
            status: "<Run|MPos:0.000,0.000,0.000|FS:1000,0>",
            events: [],
          };
        }
        return recorder.handler(cmd, args);
      });

      const session = await beginJobSession("Test");
      expect(session).not.toBeNull();

      // Start draining in background.
      const drainPromise = session!.drain(true);

      // Cancel after a brief delay (simulates STOP).
      await new Promise((r) => setTimeout(r, 300));
      session!.cancel();

      const result = await drainPromise;
      expect(result).toBe("cancelled");
    });

    it("old Channel callback is discarded when session is cancelled", async () => {
      // Mutant 4: if old callback changes B's progress, this fails.
      localStorage.setItem("streamingMode", "buffered");
      recorder = new SerialTraceRecorder();
      recorder.defer("serial_stream_job");
      // Use recorder as base handler, which captures channels for emit().
      mockInvoke.mockImplementation(recorder.handler);

      // Start job A with session
      const sessionA = await beginJobSession("Job A");
      expect(sessionA).not.toBeNull();
      useStore.setState({ jobRunning: true, jobProgress: 0 });

      const jobA = streamJob("G1 X10 F500", {
        label: "Job A",
        session: sessionA!,
      });
      recorder.trackJobPromise(jobA);

      await recorder.waitUntilInvoked("serial_stream_job");

      // Cancel session A (simulates STOP)
      sessionA!.cancel();

      // Emit a progress event to the channel AFTER cancellation.
      // This should be discarded, not applied to the store.
      recorder.emit({ type: "progress", lineIndex: 5, total: 10 });
      const progressAfterCancel = useStore.getState().jobProgress;
      expect(progressAfterCancel).toBe(0); // Must not have been updated

      // Release to let the promise settle.
      const idx = recorder.getRecordIndex("serial_stream_job");
      recorder.releaseInvoke(idx, "complete");
      await jobA;
    });

    it("Rust progress fixture yields finite sent-lines percentage; 100% does not release ownership", async () => {
      // Mutant acceptance criterion 4: 100% progress does not release ownership.
      localStorage.setItem("streamingMode", "buffered");
      recorder = new SerialTraceRecorder();
      recorder.defer("serial_stream_job");
      // Use recorder as base handler, which captures channels for emit().
      mockInvoke.mockImplementation(recorder.handler);

      const session = await beginJobSession("Test");
      expect(session).not.toBeNull();
      useStore.setState({ jobRunning: true, jobProgress: 0 });

      const job = streamJob("G1 X10 F500", {
        label: "Test",
        session: session!,
      });
      recorder.trackJobPromise(job);

      await recorder.waitUntilInvoked("serial_stream_job");

      // Emit progress to 100%
      recorder.emit({ type: "progress", lineIndex: 9, total: 10 });
      expect(useStore.getState().jobProgress).toBeCloseTo(1.0);

      // jobRunning must still be true — 100% does not release.
      expect(useStore.getState().jobRunning).toBe(true);

      // Release the job
      const idx = recorder.getRecordIndex("serial_stream_job");
      recorder.releaseInvoke(idx, "complete");
      await job;
    });
  });

  // ---- Cross-job safety (B3: session ownership) ----
  describe("Cross-job safety (B3 session ownership)", () => {
    it(
      "R4/R11: job B is refused while job A session is active",
      async () => {
        // B3 fix: beginJobSession blocks a second job while the first
        // session is still active. Job A's late callback cannot corrupt
        // job B because job B is never admitted.

        localStorage.setItem("streamingMode", "buffered");
        recorder = new SerialTraceRecorder();
        recorder.defer("serial_stream_job");
        // Use recorder which handles serial_job_begin/end natively.
        mockInvoke.mockImplementation(recorder.handler);

        // Start job A with a session
        const sessionA = await beginJobSession("Job A");
        expect(sessionA).not.toBeNull();

        useStore.setState({ jobRunning: true, jobProgress: 0 });
        const jobA = streamJob("G1 X10 F500", {
          label: "Job A",
          session: sessionA!,
        });
        recorder.trackJobPromise(jobA);

        // Wait for job A to invoke serial_stream_job
        await recorder.waitUntilInvoked("serial_stream_job");

        // Attempt to start job B — should be refused (session A is active).
        const sessionB = await beginJobSession("Job B");
        expect(sessionB).toBeNull();

        // Verify console reports the block.
        const consoleTexts = useStore
          .getState()
          .consoleLines.map((l) => l.text);
        expect(
          consoleTexts.some((t) => t.includes("Cannot start Job B"))
        ).toBe(true);

        // Release job A's invoke — cleanup is session-gated.
        const jobAIndex = recorder.getRecordIndex("serial_stream_job");
        recorder.releaseInvoke(jobAIndex, "complete");

        const resultA = await jobA;
        expect(resultA.endState).toBe("complete");
      }
    );
  });
});
