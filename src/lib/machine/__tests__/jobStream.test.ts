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
import {
  beginJobSession,
  stopActiveSession,
  JobSession,
  _testResetJobSession,
} from "../jobSession";
import { machineConnection } from "../connection";
import { resetStatusConsumer } from "../machineStatus";
import { _testResetJobEvidence, bufferedJobLines } from "../lastSentLine";
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

/** A session for tests that mock invoke by call order (no serial_job_begin
 *  in the sequence). Its jobId is the epoch every job line carries. */
function detachedSession(label = "Test"): JobSession {
  return new JobSession(1, label);
}

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
      const session = (await beginJobSession("Test"))!;
      const result = await streamJob("G1 X10 F500", { label: "Test", session });
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
      const session = (await beginJobSession("Test"))!;
      const result = await streamJob("G1 X10 F500", { label: "Test", session });
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
      const result = await streamJob("G1 X10 F500", { label: "Test", session: detachedSession() });
      expect(result.endState).toBe("cancelled");
    });

    it("maps alarm outcome correctly", async () => {
      mockInvoke.mockResolvedValueOnce("alarm: ALARM:1");
      const result = await streamJob("G1 X10 F500", { label: "Test", session: detachedSession() });
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
      const result = await streamJob("G1 X10 F500", { label: "Test", session: detachedSession() });
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
      const result = await streamJob("G1 X10 F500", { label: "Test", session: detachedSession() });
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
      const result = await streamJob("G1 X10 F500", { label: "Test", session: detachedSession() });
      expect(result.endState).toBe("error");
    });

    it("S1b-T8: a laser-mode refusal from Rust is an error, not a dead port", async () => {
      // Literal text of the Rust constant LASER_MODE_UNVERIFIED (serial.rs).
      const refusal =
        "$32=1 not verified -- laser mode must be read back before a job starts (Enable Laser Mode, $$ in the console, or reconnect)";
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "serial_stream_job") throw refusal;
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
      const result = await streamJob("G1 X10 F500", { label: "Test", session: detachedSession() });
      expect(result.endState).toBe("error");
      const lines = useStore.getState().consoleLines.map((l) => l.text);
      expect(lines.some((t) => t.includes("failed: $32=1 not verified"))).toBe(true);
      expect(useStore.getState().machineConnected).toBe(true);
    });

    it("cleans up jobRunning and jobProgress on every exit", async () => {
      mockInvoke.mockResolvedValueOnce("complete");
      await streamJob("G1 X10 F500", { label: "Test", session: detachedSession() });
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
    it("R4/R11: job B is refused while job A session is active", async () => {
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
      const consoleTexts = useStore.getState().consoleLines.map((l) => l.text);
      expect(consoleTexts.some((t) => t.includes("Cannot start Job B"))).toBe(true);

      // Release job A's invoke — cleanup is session-gated.
      const jobAIndex = recorder.getRecordIndex("serial_stream_job");
      recorder.releaseInvoke(jobAIndex, "complete");

      const resultA = await jobA;
      expect(resultA.endState).toBe("complete");
    });
  });
});

// ---------------------------------------------------------------------------
// RF-15: job lines carry the session epoch; backend refusals map to the
// refusal contract (never complete, never a dead port, never a TS-sent stop).
// The fence model evaluates each job line at RESOLUTION time and rejects with
// the RAW string, exactly as Tauri rejects an `Err(String)`.
// ---------------------------------------------------------------------------
describe("RF-15 admission fence (jobStream)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    localStorage.clear();
    _testResetJobSession();
    seedStore();
  });

  afterEach(async () => {
    if (recorder) await recorder.dispose();
  });

  /** JobActionBar.handleStop's exact production order. */
  async function pressStop(): Promise<void> {
    void stopActiveSession();
    useStore.getState().setJobRunning(false);
    await machineConnection.emergencyStop();
  }

  function fenced(opts?: { deferSend?: boolean; deferStream?: boolean }) {
    recorder = new SerialTraceRecorder(() => ({ responses: ["ok"], drained: [] }));
    recorder.enableFenceModel();
    if (opts?.deferSend) recorder.defer("serial_send");
    if (opts?.deferStream) recorder.defer("serial_stream_job");
    mockInvoke.mockImplementation(recorder.handler);
  }

  const texts = () => useStore.getState().consoleLines.map((l) => l.text);
  const recs = () => recorder.allRecords();
  const count = (cmd: string) => recs().filter((r) => r.command === cmd).length;

  it("harness self-test: the fence model rejects with the raw Tauri string", async () => {
    fenced();
    await recorder.handler("serial_job_begin");
    recorder.closeAdmission();
    let rejection: unknown;
    try {
      await recorder.handler("serial_send", { command: "G1 X1", jobEpoch: 1 });
    } catch (e) {
      rejection = e;
    }
    expect(typeof rejection).toBe("string");
    expect(String(rejection)).toBe("refused: not-admitted: session not active (phase=stopping)");
  });

  it("T1: a late per-line send from the stopped job is refused and writes nothing", async () => {
    fenced({ deferSend: true });
    const session = (await beginJobSession("Job"))!;
    useStore.setState({ jobRunning: true });
    const job = streamJob("G1 X1\nG1 X2\nG1 X3", { label: "Job", session });
    await recorder.waitUntilInvoked("serial_send");
    await pressStop();
    recorder.releaseInvoke(recorder.getRecordIndex("serial_send"), {
      responses: ["ok"],
      drained: [],
    });
    const result = await job;

    const sends = recs().filter((r) => r.command === "serial_send");
    expect(sends).toHaveLength(1);
    expect(sends[0].args.jobEpoch).toBe(session.jobId);
    expect(sends[0].wrote).toBe(false);
    const stopIdx = recs().findIndex((r) => r.command === "serial_stop");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(
      recs()
        .slice(stopIdx)
        .some((r) => r.command === "serial_send" && r.wrote === true)
    ).toBe(false);
    expect(count("serial_stop")).toBe(1);
    expect(recs().some((r) => r.command === "serial_send" && r.args.command === "M5")).toBe(false);
    expect(count("serial_disconnect")).toBe(0);
    expect(useStore.getState().machineConnected).toBe(true);
    expect(result.endState).toBe("cancelled");
    expect(texts().some((t) => t.includes("no longer accepting this job's lines"))).toBe(true);
    expect(texts().some((t) => /aborted/.test(t))).toBe(false);
    expect(texts().some((t) => /Disconnected/.test(t))).toBe(false);
    expect(texts().some((t) => /complete/.test(t))).toBe(false);
  });

  it("T2: a refusal with jobRunning still true never completes and sends no stop", async () => {
    fenced();
    const session = (await beginJobSession("Job"))!;
    recorder.closeAdmission();
    useStore.setState({ jobRunning: true });
    const result = await streamJob("G1 X1\nG1 X2", { label: "Job", session });
    expect(result.endState).toBe("cancelled");
    expect(count("serial_stop")).toBe(0);
    expect(count("serial_send")).toBe(1);
  });

  it("T3: buffered entry refusal is cancelled, not a dead port", async () => {
    localStorage.setItem("streamingMode", "buffered");
    fenced({ deferStream: true });
    const session = (await beginJobSession("Job"))!;
    const job = streamJob("G1 X1", { label: "Job", session });
    await recorder.waitUntilInvoked("serial_stream_job");
    recorder.releaseInvokeReject(
      recorder.getRecordIndex("serial_stream_job"),
      "refused: not-admitted: session not active (phase=disconnected)"
    );
    const result = await job;
    expect(result.endState).toBe("cancelled");
    expect(result.portDisconnected).toBe(false);
    expect(count("serial_disconnect")).toBe(0);
    expect(count("serial_stop")).toBe(0);
    expect(useStore.getState().machineConnected).toBe(true);
  });

  it("T4: a refusal string unknown to the contract is cancelled, never complete or disconnected", async () => {
    fenced({ deferSend: true });
    const session = (await beginJobSession("Job"))!;
    useStore.setState({ jobRunning: true });
    const job = streamJob("G1 X1\nG1 X2", { label: "Job", session });
    await recorder.waitUntilInvoked("serial_send");
    const legacy = "refused: in-flight: legacy contract string";
    recorder.releaseInvokeReject(recorder.getRecordIndex("serial_send"), legacy);
    const result = await job;
    expect(result.endState).toBe("cancelled");
    expect(result.portDisconnected).toBe(false);
    expect(count("serial_send")).toBe(1);
    expect(count("serial_stop")).toBe(0);
    expect(count("serial_disconnect")).toBe(0);
    expect(useStore.getState().machineConnected).toBe(true);
    expect(texts().some((t) => t.includes(`(${legacy})`))).toBe(true);
  });

  it("T5 (RF-8): an unrecognised buffered outcome is unknown, never complete", async () => {
    localStorage.setItem("streamingMode", "buffered");
    fenced({ deferStream: true });
    const session = (await beginJobSession("Job"))!;
    useStore.setState({ jobRunning: true });
    const job = streamJob("G1 X1", { label: "Job", session });
    await recorder.waitUntilInvoked("serial_stream_job");
    recorder.releaseInvoke(recorder.getRecordIndex("serial_stream_job"), "bogus");
    const result = await job;
    expect(result.endState).toBe("unknown");
    expect(texts().some((t) => t.includes("unrecognised result (bogus)"))).toBe(true);
  });

  it("T7: every per-line job send carries jobEpoch === session.jobId", async () => {
    fenced();
    const session = (await beginJobSession("Job"))!;
    const result = await streamJob("G1 X1\nG1 X2\nG1 X3", { label: "Job", session });
    expect(result.endState).toBe("complete");
    const sends = recs().filter((r) => r.command === "serial_send");
    expect(sends).toHaveLength(3);
    for (const r of sends) expect(r.args.jobEpoch).toBe(session.jobId);
  });

  it("T7: the buffered invoke carries jobEpoch === session.jobId", async () => {
    localStorage.setItem("streamingMode", "buffered");
    fenced();
    const session = (await beginJobSession("Job"))!;
    const result = await streamJob("G1 X1", { label: "Job", session });
    expect(result.endState).toBe("complete");
    const stream = recs().find((r) => r.command === "serial_stream_job")!;
    expect(stream.args.jobEpoch).toBe(session.jobId);
  });

  it("S1b-T7a: the buffered invoke carries laserModeVerified === true when the flag is set", async () => {
    localStorage.setItem("streamingMode", "buffered");
    fenced();
    const session = (await beginJobSession("Job"))!;
    useStore.setState({ grblLaserMode: true });
    await streamJob("G1 X1", { label: "Job", session });
    const stream = recs().find((r) => r.command === "serial_stream_job")!;
    expect(stream.args.laserModeVerified).toBe(true);
  });

  it("S1b-T7b: the buffered invoke carries laserModeVerified === false when the flag is clear", async () => {
    localStorage.setItem("streamingMode", "buffered");
    fenced();
    const session = (await beginJobSession("Job"))!;
    useStore.setState({ grblLaserMode: false });
    await streamJob("G1 X1", { label: "Job", session });
    const stream = recs().find((r) => r.command === "serial_stream_job")!;
    expect(stream.args.laserModeVerified).toBe(false);
  });

  it("T7 negative control: a reconnect before the first line refuses it (cancelled, never complete)", async () => {
    fenced();
    const session = (await beginJobSession("Job"))!;
    recorder.simulateReconnect();
    const result = await streamJob("G1 X1\nG1 X2", { label: "Job", session });
    expect(result.endState).toBe("cancelled");
    expect(count("serial_send")).toBe(1);
    expect(recs().find((r) => r.command === "serial_send")!.wrote).toBe(false);
  });
});

describe("spindle-drop evidence during jobs (E3)", () => {
  const RUN_500 = "<Run|MPos:0.000,0.000,0.000|FS:1000,500>";
  const RUN_0 = "<Run|MPos:0.000,0.000,0.000|FS:1000,0>";
  const PROGRAM = "G0 X0\nG1 X1 S500\nG1 X2 S500";

  const lines = () => useStore.getState().consoleLines;
  const texts = () => lines().map((l) => l.text);
  const dropLines = () => texts().filter((t) => t.includes("spindle 0 during Run"));
  const tallyLines = () => texts().filter((t) => t.includes("status reports during Run"));

  let seq = 0;
  /** makeStatusOutcome's shape (connection.test.ts): a snapshot-carrying
   *  outcome, so pollStatus's consumer accepts it. */
  function statusOutcome(raw: string) {
    const state = raw.match(/^<(\w+)/)![1].toLowerCase();
    const fs = raw.match(/FS:([-\d.]+),([-\d.]+)/)!;
    return {
      status: raw,
      events: [],
      kind: "report",
      snapshot: {
        epoch: 1,
        seq: ++seq,
        state,
        positionKind: "MPos",
        position: [0, 0, 0],
        wco: null,
        feed: parseFloat(fs[1]),
        spindle: parseFloat(fs[2]),
        accessory: "Unknown",
        units: "Unknown",
        raw,
        unknownFields: [],
      },
    };
  }

  async function poll(raw: string) {
    useStore.setState({ jobRunning: false, machineConnected: true });
    mockInvoke.mockImplementationOnce(async () => statusOutcome(raw));
    await machineConnection.pollStatus();
  }

  /** Per-line job; `inPump` maps a sent line to the in-pump reports that
   *  precede its `ok`. The drain is answered Idle by the recorder. */
  async function runPerLine(gcode: string, inPump: Record<string, string[]> = {}) {
    useStore.setState({ jobRunning: true });
    recorder = new SerialTraceRecorder((cmd) => ({
      responses: [...(inPump[cmd] ?? []), "ok"],
      drained: [],
    }));
    mockInvoke.mockImplementation(recorder.handler);
    const result = await streamJob(gcode, { label: "Job", session: detachedSession("Job") });
    mockInvoke.mockReset();
    return result;
  }

  /** Buffered job: the given channel events are delivered before the pump
   *  resolves "complete". */
  async function runBuffered(gcode: string, events: unknown[]) {
    localStorage.setItem("streamingMode", "buffered");
    useStore.setState({ jobRunning: true });
    mockInvoke.mockImplementation(
      async (cmd: string, args?: { channel: { onmessage: (e: unknown) => void } }) => {
        if (cmd === "serial_stream_job") {
          for (const e of events) args!.channel.onmessage(e);
          return "complete";
        }
        if (cmd === "serial_get_status") {
          return { status: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>", events: [] };
        }
        return undefined;
      }
    );
    const result = await streamJob(gcode, { label: "Job", session: detachedSession("Job") });
    mockInvoke.mockReset();
    return result;
  }

  beforeEach(() => {
    mockInvoke.mockReset();
    localStorage.clear();
    _testResetJobSession();
    seedStore();
    useStore.setState({ spindleSpeed: 0 });
    resetStatusConsumer();
    seq = 0;
    _testResetJobEvidence();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("per-line: the drop line names the line being sent (#2 and its text), at info", async () => {
    const r = await runPerLine(PROGRAM, { "G1 X1 S500": [RUN_500, RUN_0] });
    expect(r.endState).toBe("complete");
    const drops = lines().filter((l) => l.text.includes("spindle 0 during Run"));
    expect(drops).toHaveLength(1);
    expect(drops[0].type).toBe("info");
    expect(drops[0].text).toContain('#2 "G1 X1 S500"');
    expect(drops[0].text).not.toContain("#1");
    expect(drops[0].text).toContain("the controller may still be executing earlier lines");
    expect(
      lines().some((l) => l.type === "warning" && l.text.toLowerCase().includes("spindle"))
    ).toBe(false);
  });

  it("per-line: the drop line and tally carry the wall-clock time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 25, 9, 3, 7));
    await runPerLine(PROGRAM, { "G1 X1 S500": [RUN_500, RUN_0] });
    expect(dropLines()[0]).toContain("at 09:03:07");
    expect(tallyLines()).toHaveLength(1);
    expect(tallyLines()[0]).toContain('First at 09:03:07, last line sent #2 "G1 X1 S500".');
  });

  it("per-line: 0 to 0 is not a drop", async () => {
    await runPerLine(PROGRAM, {
      "G0 X0": ["<Run|MPos:0.000,0.000,0.000|FS:0,0>"],
      "G1 X1 S500": ["<Run|MPos:0.000,0.000,0.000|FS:0,0>"],
    });
    expect(dropLines()).toHaveLength(0);
    expect(tallyLines()).toHaveLength(1);
    expect(tallyLines()[0].startsWith("Job: 2 of 2 status reports during Run")).toBe(true);
  });

  it("per-line: exactly one tally line, counting every Run sample", async () => {
    await runPerLine(PROGRAM, {
      "G0 X0": [RUN_500],
      "G1 X1 S500": [RUN_0],
      "G1 X2 S500": [RUN_0],
    });
    expect(dropLines()).toHaveLength(1);
    expect(tallyLines()).toHaveLength(1);
    expect(tallyLines()[0].startsWith("Job: 2 of 3 status reports during Run")).toBe(true);
  });

  it("bufferedJobLines mirrors Rust's filter, and a buffered drop names that line", async () => {
    const gcode = "G0 X0\n  ; note\n\nG1 X1 S500\nG1 X2";
    expect(bufferedJobLines(gcode)).toEqual(["G0 X0", "G1 X1 S500", "G1 X2"]);
    await runBuffered(gcode, [
      { type: "progress", lineIndex: 2, total: 3 },
      { type: "status", report: RUN_500 },
      { type: "status", report: RUN_0 },
    ]);
    expect(dropLines()).toHaveLength(1);
    expect(dropLines()[0]).toContain('#3 "G1 X2"');
  });

  it("buffered: status events feed the check and the job ends with one tally", async () => {
    const r = await runBuffered("G1 X1 S500", [
      { type: "status", report: RUN_500 },
      { type: "status", report: RUN_0 },
    ]);
    expect(r.endState).toBe("complete");
    expect(dropLines()).toHaveLength(1);
    expect(tallyLines()).toHaveLength(1);
    expect(tallyLines()[0]).toContain("1 of 2");
  });

  it("job start clears the record and tally left by between-jobs polling", async () => {
    await runPerLine(PROGRAM, { "G1 X1 S500": [RUN_500, RUN_0] });
    await poll(RUN_500);
    await poll(RUN_0);
    expect(dropLines()).toHaveLength(2);
    expect(dropLines()[1]).toContain("no job line recorded");
    await runPerLine(PROGRAM);
    const tallies = tallyLines();
    expect(tallies).toHaveLength(2);
    expect(tallies[1]).toContain("Job: 0 of 0 status reports");
  });

  it("job start resets the previous sample, so a drop is within one job", async () => {
    await poll(RUN_500);
    expect(useStore.getState().spindleSpeed).toBe(500);
    await runPerLine(PROGRAM, { "G0 X0": [RUN_0] });
    expect(dropLines()).toHaveLength(0);
    expect(tallyLines()[0]).toContain("Job: 1 of 1 status reports");
  });

  it("after the tally, a no-job drop never names the finished job's line", async () => {
    await runPerLine(PROGRAM);
    await poll(RUN_500);
    await poll(RUN_0);
    expect(dropLines()).toHaveLength(1);
    expect(dropLines()[0]).toContain("no job line recorded");
    expect(dropLines()[0]).not.toContain("G1 X2");
  });

  it("the tally counts every Run report at 0, not transitions (W1)", async () => {
    await runPerLine(PROGRAM, {
      "G0 X0": [RUN_0],
      "G1 X1 S500": [RUN_500, RUN_0],
      "G1 X2 S500": [RUN_0],
    });
    // One transition, three zero reports.
    expect(dropLines()).toHaveLength(1);
    expect(tallyLines()[0].startsWith("Job: 3 of 4 status reports during Run")).toBe(true);
  });

  it("First/Last name the first and last zero report, in order", async () => {
    await runPerLine(PROGRAM, {
      "G0 X0": [RUN_500],
      "G1 X1 S500": [RUN_0],
      "G1 X2 S500": [RUN_0],
    });
    const t = tallyLines()[0];
    expect(t).toContain('last line sent #2 "G1 X1 S500". Last at');
    expect(t).toMatch(/Last at \d\d:\d\d:\d\d, last line sent #3 "G1 X2 S500"\.$/);
  });

  it("buffered: the last-sent field says it is approximate (W2)", async () => {
    await runBuffered("G1 X1 S500", [
      { type: "progress", lineIndex: 0, total: 1 },
      { type: "status", report: RUN_500 },
      { type: "status", report: RUN_0 },
    ]);
    expect(dropLines()[0]).toContain(
      'Last job line sent: #1 "G1 X1 S500" (approximate in buffered mode)'
    );
    expect(tallyLines()[0]).toContain("(approximate in buffered mode)");
  });

  it("per-line: the last-sent field is not marked approximate (W2)", async () => {
    await runPerLine(PROGRAM, { "G1 X1 S500": [RUN_500, RUN_0] });
    expect(dropLines()[0]).toContain('Last job line sent: #2 "G1 X1 S500" (the controller');
    expect(dropLines()[0]).not.toContain("approximate");
  });
});
