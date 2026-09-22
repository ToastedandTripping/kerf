/**
 * F13/F15/F17 — job loop + START/FRAME gating through the PRODUCTION component.
 *
 * Covers the frontend protocol contract the Rust pump enables:
 *  - empty response / reset banner  ⇒ abort (a banner means the line was
 *    ABORTED, not acked — advancing would desync ack attribution)
 *  - ALARM response ⇒ stop WITHOUT the M5+reset volley (GRBL is locked, laser
 *    already de-energized; the volley earns a confusing error:9)
 *  - abort volley GUARDED by jobRunning: STOP already ran emergencyStop — a
 *    second M5+0x18 would push another banner into the buffer
 *  - STOP while PAUSED: the hold-wait un-parks (whether or not the e-stop
 *    re-poll moved the state out of "hold") and flows into the cancel path —
 *    never a stray post-reset send (W1 Razor WARNING 1)
 *  - START disabled by the canStartJob gate (stale G-code surfaced as hint)
 *  - FRAME uses machine-frame moves extents (Y-flip DELETED), requires fresh
 *    G-code, and no-ops on empty moves instead of sending G0 XInfinity
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../../app/store";
import type { AppState } from "../../../app/store";
import { DEFAULT_LAYERS } from "../../../app/types";
import { JobActionBar } from "../JobActionBar";
import { MachinePanel } from "../MachinePanel";
import { streamJob, pauseJob, resumeJob } from "../../../lib/machine/jobStream";
import { machineConnection } from "../../../lib/machine/connection";
import { resetStatusConsumer } from "../../../lib/machine/machineStatus";
import { SerialTraceRecorder } from "../../../lib/machine/__tests__/serialTraceHarness";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

function gcodeWithMoves(): NonNullable<AppState["gcodeResult"]> {
  return {
    gcode: "G1 X10 Y20\nG1 X50 Y80",
    moves: [
      { x: 10, y: 20, moveType: "cut", speed: 100, power: 50 },
      { x: 50, y: 80, moveType: "cut", speed: 100, power: 50 },
    ],
    totalDistance: 100,
    cutDistance: 100,
    travelDistance: 0,
    estimatedTimeSecs: 10,
    lineCount: 2,
  };
}

function seedReadyToStart() {
  useStore.setState({
    objects: [],
    objectsById: new Map(),
    selectedIds: [],
    selectedSet: new Set(),
    undoStack: [],
    redoStack: [],
    consoleLines: [],
    layers: DEFAULT_LAYERS,
    machineConnected: true,
    machineState: "idle",
    machinePosition: { x: 0, y: 0, z: 0 },
    jobRunning: false,
    jobProgress: 0,
    gcodeResult: gcodeWithMoves(),
    gcodeStale: false,
    workspaceWidth: 500,
    workspaceHeight: 300,
    grblSValueMax: 1000,
    // Hardcoded moves have positive Y (10–80mm) which only fits originTop:false bounds.
    // Set explicitly so the gate doesn't reject after the new originTop:true default.
    originTop: false,
    // workspaceVerified must be true or canStartJob blocks START.
    workspaceVerified: true,
    // $32=1 gate: canStartJob blocks START and FRAME without laser mode.
    grblLaserMode: true,
    // B2b: statusStale must be false for canStartJob to pass.
    statusStale: false,
  });
}

function consoleTexts(): string[] {
  return useStore.getState().consoleLines.map((l) => l.text);
}

let recorder: SerialTraceRecorder;
let _mockSeq = 0;

/** All serial_send commands the mock received, in order. */
function sentCommands(): string[] {
  return recorder.sentCommands();
}

function sentBytes(): number[] {
  return recorder.sentBytes();
}

/** Default mock: list_serial_ports + get_status handled; per-command send hook. */
let _mockHoldActive = false;
function mockSerial(onSend: (command: string) => { responses: string[]; drained: string[] }) {
  _mockHoldActive = false;
  recorder = new SerialTraceRecorder(onSend);

  mockInvoke.mockImplementation(async (cmd: string, args?: { command?: string; byte?: number }) => {
    // Handle hold state tracking
    if (cmd === "serial_send_byte") {
      if (args?.byte === 0x21) _mockHoldActive = true;
      if (args?.byte === 0x7e) _mockHoldActive = false;
    }

    // For serial_get_status, use hold state — B2b extended StatusOutcome
    if (cmd === "serial_get_status") {
      _mockSeq++;
      if (_mockHoldActive) {
        return {
          status: "<Hold:0|MPos:0.000,0.000,0.000|FS:0,0>", events: [],
          kind: "report",
          snapshot: {
            epoch: 1, seq: _mockSeq, state: { hold: { substate: 0 } },
            positionKind: "MPos", position: [0, 0, 0],
            wco: null, feed: 0, spindle: 0,
            accessory: "Unknown", units: "Unknown",
            raw: "<Hold:0|MPos:0.000,0.000,0.000|FS:0,0>", unknownFields: [],
          },
        };
      }
      return {
        status: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>", events: [],
        kind: "report",
        snapshot: {
          epoch: 1, seq: _mockSeq, state: "idle",
          positionKind: "MPos", position: [0, 0, 0],
          wco: null, feed: 0, spindle: 0,
          accessory: "Unknown", units: "Unknown",
          raw: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>", unknownFields: [],
        },
      };
    }

    // Use recorder for everything else
    return recorder.handler(cmd, args);
  });
}

describe("MachinePanel job loop (F13/F17)", () => {
  beforeEach(() => {
    cleanup();
    mockInvoke.mockReset();
    resetStatusConsumer();
    _mockSeq = 0;
    localStorage.clear();
    seedReadyToStart();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (recorder) {
      await recorder.dispose();
    }
  });

  it("completes a job when every line acks", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("START"));
    await waitFor(() => expect(consoleTexts()).toContain("Job complete"));
    expect(sentCommands()).toEqual(["G1 X10 Y20", "G1 X50 Y80"]);
    expect(useStore.getState().jobRunning).toBe(false);
  });

  it("aborts on an EMPTY response (protocol failure, never an ack)", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G1") ? { responses: [], drained: [] } : { responses: ["ok"], drained: [] }
    );
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("START"));
    await waitFor(() =>
      expect(consoleTexts()).toContain("Job aborted -- machine was reset mid-line")
    );
    // Only the first line was sent — the loop never advanced past the failure…
    expect(sentCommands().filter((c) => c.startsWith("G1"))).toEqual(["G1 X10 Y20"]);
    // …and the safety volley fired (job was NOT user-stopped): M5 + soft reset.
    await waitFor(() => expect(sentCommands()).toContain("M5"));
    expect(sentBytes()).toContain(0x18);
  });

  it("aborts on a reset banner (the line was aborted, not acked)", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G1")
        ? { responses: ["Grbl 1.1h ['$' for help]"], drained: [] }
        : { responses: ["ok"], drained: [] }
    );
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("START"));
    await waitFor(() =>
      expect(consoleTexts()).toContain("Job aborted -- machine was reset mid-line")
    );
    expect(sentCommands().filter((c) => c.startsWith("G1"))).toEqual(["G1 X10 Y20"]);
  });

  it("stops on ALARM WITHOUT the M5+reset volley", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G1")
        ? { responses: ["ALARM:1"], drained: [] }
        : { responses: ["ok"], drained: [] }
    );
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("START"));
    await waitFor(() =>
      expect(consoleTexts()).toContain(
        "Job stopped -- machine alarm (laser already off; unlock to continue)"
      )
    );
    // GRBL is locked: M5 would earn error:9, 0x18 would re-reset. Neither fires.
    expect(sentCommands()).not.toContain("M5");
    expect(sentBytes()).not.toContain(0x18);
  });

  it("stores skip abort volley guard: jobRunning false prevents loop volley (store-only check)", async () => {
    // Simulate handleStop firing mid-line: jobRunning goes false and the pump
    // returns the e-stop's reset banner for the in-flight line.
    // This test verifies the store-side gate only, not dispatch of emergencyStop bytes.
    mockSerial((cmd) => {
      if (cmd.startsWith("G1")) {
        useStore.setState({ jobRunning: false }); // what handleStop does first
        return { responses: ["Grbl 1.1h ['$' for help]"], drained: [] };
      }
      return { responses: ["ok"], drained: [] };
    });
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("START"));
    await waitFor(() => expect(consoleTexts()).toContain("Job aborted"));
    // No second volley: emergencyStop already ran its own sequence.
    expect(sentCommands()).not.toContain("M5");
    expect(sentBytes()).not.toContain(0x18);
  });

  it("stores hold-wait exit guard: jobRunning false un-parks hold even without state change (store-only check)", async () => {
    // PAUSE arrives right after line 1 acks: the mock parks the loop in hold.
    // This test verifies the store-side hold-wait gate only.
    mockSerial((cmd) => {
      if (cmd === "G1 X10 Y20") {
        useStore.setState({ machineState: "hold" });
      }
      return { responses: ["ok"], drained: [] };
    });
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("START"));
    await waitFor(() => expect(sentCommands()).toContain("G1 X10 Y20"));
    // The loop is now parked in the hold-wait. STOP: emergencyStop flips
    // jobRunning false and its re-poll writes a fresh NON-hold state — the
    // exact sequence that used to un-park the wait straight into send().
    useStore.setState({ jobRunning: false, machineState: "idle" });

    await waitFor(() => expect(consoleTexts()).toContain("Job cancelled"));
    // The stray line must NEVER fire after the reset.
    expect(sentCommands().filter((c) => c.startsWith("G1"))).toEqual(["G1 X10 Y20"]);
    // emergencyStop owns the abort volley — jobRunning false skips a second one.
    expect(sentCommands()).not.toContain("M5");
    expect(sentBytes()).not.toContain(0x18);
  });

  it("STOP while PAUSED un-parks the wait even when the state STAYS hold", async () => {
    // Mutation guard: remove the jobRunning clause from the hold-wait and this
    // test hangs forever (the e-stop re-poll returned nothing, so the state
    // never leaves "hold") — waitFor times out and the test fails.
    mockSerial((cmd) => {
      if (cmd === "G1 X10 Y20") {
        useStore.setState({ machineState: "hold" });
      }
      return { responses: ["ok"], drained: [] };
    });
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("START"));
    await waitFor(() => expect(sentCommands()).toContain("G1 X10 Y20"));
    useStore.setState({ jobRunning: false }); // state remains "hold"

    await waitFor(() => expect(consoleTexts()).toContain("Job cancelled"));
    expect(sentCommands().filter((c) => c.startsWith("G1"))).toEqual(["G1 X10 Y20"]);
  });

  it("stops on error:N through the existing abort path (volley fires)", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G1")
        ? { responses: ["error:9"], drained: [] }
        : { responses: ["ok"], drained: [] }
    );
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("START"));
    await waitFor(() => expect(consoleTexts()).toContain("Job stopped due to error"));
    await waitFor(() => expect(sentCommands()).toContain("M5"));
  });

  it("STOP click dispatches emergencyStop byte sequence (0x21 then 0x18)", async () => {
    vi.useFakeTimers();
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    useStore.setState({ jobRunning: true }); // Simulate a running job
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("STOP"));
    await vi.runAllTimersAsync();

    // The STOP button calls handleStop which sets jobRunning=false
    // and then calls emergencyStop(). The byte sequence must be:
    // 1. 0x21 (feed hold)
    // 2. (100ms sleep)
    // 3. 0x18 (soft reset)
    // 4. (200ms sleep)
    // 5. serial_get_status (re-poll)
    // 6. conditional M5
    const bytes = sentBytes();
    expect(bytes.length).toBeGreaterThanOrEqual(2);
    expect(bytes[0]).toBe(0x21); // Feed hold comes first
    expect(bytes[1]).toBe(0x18); // Soft reset comes second

    vi.useRealTimers();
  });
});

describe("MachinePanel START/FRAME gating (F15)", () => {
  beforeEach(() => {
    cleanup();
    mockInvoke.mockReset();
    localStorage.clear();
    seedReadyToStart();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (recorder) {
      await recorder.dispose();
    }
  });

  it("disables START with the regenerate hint when G-code is stale", () => {
    useStore.setState({ gcodeStale: true });
    const { getByText } = render(<JobActionBar />);
    const start = getByText("START") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe("Design changed -- regenerate G-code");
  });

  it("disables FRAME when G-code is stale or missing (contract change)", () => {
    useStore.setState({ gcodeStale: true });
    const { getByText, rerender } = render(<JobActionBar />);
    const frame = getByText("FRAME") as HTMLButtonElement;
    expect(frame.disabled).toBe(true);
    expect(frame.title).toBe("Design changed -- regenerate G-code");

    useStore.setState({ gcodeStale: false, gcodeResult: null });
    rerender(<JobActionBar />);
    expect((getByText("FRAME") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("FRAME") as HTMLButtonElement).title).toBe("Generate G-code first");
  });

  it("FRAME traces the moves extents in MACHINE frame — no Y-flip", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("FRAME"));
    // Extents of the seeded moves: X 10..50, Y 20..80. Under the deleted
    // design→machine flip (H=300) the Ys would have been 220/280.
    // F16: Frame now sends M5 before first move (clear stale M3) and M5 after
    // last move (belt-and-suspenders). Update test to match new behavior.
    await waitFor(() =>
      expect(sentCommands()).toEqual([
        "M5",
        "G0 X10.000 Y20.000",
        "G0 X50.000 Y20.000",
        "G0 X50.000 Y80.000",
        "G0 X10.000 Y80.000",
        "G0 X10.000 Y20.000",
        "M5",
      ])
    );
  });

  it("FRAME no-ops with a console error on empty moves (never G0 XInfinity)", async () => {
    useStore.setState({ gcodeResult: { ...gcodeWithMoves(), moves: [] } });
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("FRAME"));
    await waitFor(() =>
      expect(consoleTexts()).toContain("Nothing to cut -- no moves in the generated G-code")
    );
    expect(sentCommands()).toEqual([]);
  });

  it("START surfaces the gate reason via console when clicked while blocked", async () => {
    // Out-of-bounds moves: gate blocks inside handleStartJob too (defense for
    // keyboard/programmatic triggers even if the disabled attribute is bypassed).
    useStore.setState({
      gcodeResult: {
        ...gcodeWithMoves(),
        moves: [
          { x: -5, y: 20, moveType: "cut", speed: 100, power: 50 },
          { x: 50, y: 80, moveType: "cut", speed: 100, power: 50 },
        ],
      },
    });
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    const { getByText } = render(<JobActionBar />);

    const start = getByText("START") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toContain("outside workspace bounds");
  });
});

describe("MachinePanel Fire button (F17 Fix 2.3)", () => {
  beforeEach(() => {
    cleanup();
    mockInvoke.mockReset();
    localStorage.clear();
    seedReadyToStart();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (recorder) {
      await recorder.dispose();
    }
  });

  it("sends three sequential commands instead of one 3-line blob", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    const { getByText } = render(<MachinePanel />);

    fireEvent.click(getByText("Fire"));
    await waitFor(() => expect(sentCommands()).toEqual(["M3 S5", "G4 P0.5", "M5"]));
    // No multi-line blob whose pump would stop at the FIRST ok.
    expect(sentCommands().some((c) => c.includes("\n"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1-A safety contract: streamJob abort protocol for FRAME and material-test
// paths. These exercise the REAL streamJob function (no mocks of it) with the
// serial layer mocked. Each test is mutation-verified: removing the abort
// check makes the test fail.
// ---------------------------------------------------------------------------

describe("streamJob FRAME abort protocol (P1-A)", () => {
  const frameGcode = "G0 X10 Y20\nG0 X50 Y80";

  beforeEach(() => {
    cleanup();
    mockInvoke.mockReset();
    localStorage.clear();
    seedReadyToStart();
    // Pre-set jobRunning as the caller (handleFrame) would
    useStore.setState({ jobRunning: true, jobProgress: 0 });
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (recorder) {
      await recorder.dispose();
    }
  });

  it("aborts FRAME on empty response (protocol failure)", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G0") ? { responses: [], drained: [] } : { responses: ["ok"], drained: [] }
    );

    const result = await streamJob(frameGcode, { label: "Frame" });
    expect(result.endState).toBe("aborted");
    expect(consoleTexts()).toContain("Frame aborted -- machine was reset mid-line");
    expect(useStore.getState().jobRunning).toBe(false);
    // Safety volley fired (not user-stopped): M5 + soft reset
    expect(sentCommands()).toContain("M5");
    expect(sentBytes()).toContain(0x18);
  });

  it("aborts FRAME on reset banner (line was aborted, not acked)", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G0")
        ? { responses: ["Grbl 1.1h ['$' for help]"], drained: [] }
        : { responses: ["ok"], drained: [] }
    );

    const result = await streamJob(frameGcode, { label: "Frame" });
    expect(result.endState).toBe("aborted");
    expect(consoleTexts()).toContain("Frame aborted -- machine was reset mid-line");
    expect(useStore.getState().jobRunning).toBe(false);
    // Safety volley fired
    expect(sentCommands()).toContain("M5");
    expect(sentBytes()).toContain(0x18);
  });

  it("aborts FRAME on ALARM without M5+reset volley", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G0")
        ? { responses: ["ALARM:1"], drained: [] }
        : { responses: ["ok"], drained: [] }
    );

    const result = await streamJob(frameGcode, { label: "Frame" });
    expect(result.endState).toBe("alarm");
    expect(consoleTexts()).toContain(
      "Frame stopped -- machine alarm (laser already off; unlock to continue)"
    );
    expect(useStore.getState().jobRunning).toBe(false);
    // GRBL is locked: M5 would earn error:9, 0x18 would re-reset. Neither fires.
    expect(sentCommands()).not.toContain("M5");
    expect(sentBytes()).not.toContain(0x18);
  });
});

describe("streamJob material-test abort protocol (P1-A)", () => {
  const testGcode = "G1 X10 Y10 F1000 S500\nG1 X20 Y10 F1000 S500";

  beforeEach(() => {
    cleanup();
    mockInvoke.mockReset();
    localStorage.clear();
    seedReadyToStart();
    // Pre-set jobRunning as the caller (handleGenerate) would
    useStore.setState({ jobRunning: true, jobProgress: 0 });
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (recorder) {
      await recorder.dispose();
    }
  });

  it("aborts material test on empty response (protocol failure)", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G1") ? { responses: [], drained: [] } : { responses: ["ok"], drained: [] }
    );

    const result = await streamJob(testGcode, { label: "Material test" });
    expect(result.endState).toBe("aborted");
    expect(consoleTexts()).toContain("Material test aborted -- machine was reset mid-line");
    expect(useStore.getState().jobRunning).toBe(false);
    // Safety volley fired
    expect(sentCommands()).toContain("M5");
    expect(sentBytes()).toContain(0x18);
  });

  it("aborts material test on reset banner (line was aborted, not acked)", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G1")
        ? { responses: ["Grbl 1.1h ['$' for help]"], drained: [] }
        : { responses: ["ok"], drained: [] }
    );

    const result = await streamJob(testGcode, { label: "Material test" });
    expect(result.endState).toBe("aborted");
    expect(consoleTexts()).toContain("Material test aborted -- machine was reset mid-line");
    expect(useStore.getState().jobRunning).toBe(false);
    // Safety volley fired
    expect(sentCommands()).toContain("M5");
    expect(sentBytes()).toContain(0x18);
  });

  it("aborts material test on ALARM without M5+reset volley", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G1")
        ? { responses: ["ALARM:1"], drained: [] }
        : { responses: ["ok"], drained: [] }
    );

    const result = await streamJob(testGcode, { label: "Material test" });
    expect(result.endState).toBe("alarm");
    expect(consoleTexts()).toContain(
      "Material test stopped -- machine alarm (laser already off; unlock to continue)"
    );
    expect(useStore.getState().jobRunning).toBe(false);
    // GRBL is locked: no volley
    expect(sentCommands()).not.toContain("M5");
    expect(sentBytes()).not.toContain(0x18);
  });
});

// ---------------------------------------------------------------------------
// P1-B A1: Pause/Resume volley contract — the exact byte sequences the
// frontend must emit. These pin the F13 deadlock fix: only realtime bytes,
// never line-based M5/M3 in Hold state.
// ---------------------------------------------------------------------------

describe("pauseJob / resumeJob volley contract (P1-B A1)", () => {
  beforeEach(() => {
    cleanup();
    mockInvoke.mockReset();
    localStorage.clear();
    seedReadyToStart();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (recorder) {
      await recorder.dispose();
    }
  });

  it("pauseJob emits [! (0x21)] only — feed hold, no 0x9E toggle", async () => {
    vi.useFakeTimers();
    mockSerial(() => ({ responses: ["ok"], drained: [] }));

    const pausePromise = pauseJob();
    await vi.runAllTimersAsync();
    await pausePromise;

    // Feed hold only — no 0x9E (which is a toggle that RE-ARMS the beam)
    expect(sentBytes()).toEqual([0x21]);
    // No line-based M5 — the F13 hazard
    expect(sentCommands()).not.toContain("M5");
    // No line-based M3 either
    expect(sentCommands()).not.toContain("M3");

    vi.useRealTimers();
  });

  it("resumeJob emits [~ (0x7E)] only — no line M3 re-enable", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));

    await resumeJob();

    // Exact volley: cycle resume byte only
    expect(sentBytes()).toEqual([0x7e]);
    // No line-based M3 — the F13 hazard
    expect(sentCommands()).not.toContain("M3");
    // No other line commands
    expect(sentCommands()).toHaveLength(0);
  });

  // 0x9E write-fail test REMOVED: 0x9E is no longer sent during pause.
  // The firmware auto-stops the spindle at hold-complete ($32=1, enforced
  // by canStartJob gate). Sending 0x9E was the bug — it toggled the
  // spindle back on.

  it("handlePauseResume uses pauseJob (feed hold only, no 0x9E) when pausing", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    useStore.setState({ jobRunning: true, machineState: "run" });
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("PAUSE"));

    // Wait for feed hold byte
    await waitFor(() => {
      expect(sentBytes()).toContain(0x21); // feedHold
    });

    // Feed hold only — no 0x9E toggle, no line-based M5/M3
    expect(sentBytes()).toEqual([0x21]);
    expect(sentCommands()).not.toContain("M5");
    expect(sentCommands()).not.toContain("M3");
  });

  it("handlePauseResume uses resumeJob (no line M3) when resuming", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    useStore.setState({ jobRunning: true, machineState: "hold" });
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("RESUME"));
    await waitFor(() => expect(sentBytes()).toContain(0x7e));

    // Must use the realtime resume, not the old line-based M3
    expect(sentBytes()).toEqual([0x7e]); // cycleResume only
    expect(sentCommands()).not.toContain("M3");
  });
});

// ---------------------------------------------------------------------------
// P1-B A6: E-stop edge cases — retry on partial send, narrowed M5 gate.
// ---------------------------------------------------------------------------

describe("emergencyStop edge cases (P1-B A6)", () => {
  beforeEach(() => {
    cleanup();
    mockInvoke.mockReset();
    localStorage.clear();
    seedReadyToStart();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (recorder) {
      await recorder.dispose();
    }
  });

  it("retries 0x18 once when feedHold sent but reset failed, then completes", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let resetAttempts = 0;
    mockInvoke.mockImplementation(
      async (cmd: string, args?: { byte?: number; command?: string }) => {
        if (cmd === "serial_send_byte") {
          const byte = args?.byte ?? 0;
          calls.push(`byte(${byte.toString(16)})`);
          if (byte === 0x18) {
            resetAttempts++;
            if (resetAttempts === 1) {
              throw new Error("first reset failed");
            }
            // Second attempt succeeds
          }
          return undefined;
        }
        if (cmd === "serial_get_status") {
          calls.push("status");
          _mockSeq++;
          return {
            status: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>", events: [],
            kind: "report",
            snapshot: {
              epoch: 1, seq: _mockSeq, state: "idle",
              positionKind: "MPos", position: [0, 0, 0],
              wco: null, feed: 0, spindle: 0,
              accessory: "Unknown", units: "Unknown",
              raw: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>", unknownFields: [],
            },
          };
        }
        if (cmd === "serial_send") {
          calls.push(`send(${args?.command ?? "?"})`);
          return { responses: ["ok"], drained: [] };
        }
        return undefined;
      }
    );

    const stopPromise = machineConnection.emergencyStop();
    await vi.runAllTimersAsync();
    await stopPromise;

    // feedHold -> first reset fails -> retry reset succeeds -> status -> M5
    expect(calls).toEqual(["byte(21)", "byte(18)", "byte(18)", "status", "send(M5)"]);
    expect(consoleTexts()).toContain("Emergency stop complete");

    vi.useRealTimers();
  });

  it("sets alarm when feedHold sent but reset fails even on retry", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation(async (cmd: string, args?: { byte?: number }) => {
      if (cmd === "serial_send_byte") {
        const byte = args?.byte ?? 0;
        if (byte === 0x18) {
          throw new Error("reset failed");
        }
        return undefined;
      }
      return undefined;
    });

    const stopPromise = machineConnection.emergencyStop();
    await vi.runAllTimersAsync();
    await stopPromise;

    expect(useStore.getState().machineState).toBe("alarm");
    expect(consoleTexts()).toContain(
      "E-stop incomplete — feed hold sent but soft reset failed after retry. Beam may still be on — treat as unsafe."
    );

    vi.useRealTimers();
  });

  it("skips M5 when re-poll reports Hold state (narrowed from !== alarm)", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    mockInvoke.mockImplementation(
      async (cmd: string, args?: { byte?: number; command?: string }) => {
        if (cmd === "serial_send_byte") {
          calls.push(`byte(${args?.byte?.toString(16) ?? "?"})`);
          return undefined;
        }
        if (cmd === "serial_get_status") {
          calls.push("status");
          // Machine stuck in Hold after reset (edge case)
          return { status: "<Hold|MPos:0.000,0.000,0.000|FS:0,0>", events: [] };
        }
        if (cmd === "serial_send") {
          calls.push(`send(${args?.command ?? "?"})`);
          return { responses: ["ok"], drained: [] };
        }
        return undefined;
      }
    );

    const stopPromise = machineConnection.emergencyStop();
    await vi.runAllTimersAsync();
    await stopPromise;

    // Old behavior: would have sent M5 because Hold !== "alarm"
    // New behavior (A6): skips M5 because Hold is not "idle" or "run"
    expect(calls).toEqual(["byte(21)", "byte(18)", "status"]);
    expect(calls).not.toContain("send(M5)");

    vi.useRealTimers();
  });

  it("skips M5 when re-poll reports Door state (narrowed gate)", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    mockInvoke.mockImplementation(
      async (cmd: string, args?: { byte?: number; command?: string }) => {
        if (cmd === "serial_send_byte") {
          calls.push(`byte(${args?.byte?.toString(16) ?? "?"})`);
          return undefined;
        }
        if (cmd === "serial_get_status") {
          calls.push("status");
          return { status: "<Door|MPos:0.000,0.000,0.000|FS:0,0>", events: [] };
        }
        if (cmd === "serial_send") {
          calls.push(`send(${args?.command ?? "?"})`);
          return { responses: ["ok"], drained: [] };
        }
        return undefined;
      }
    );

    const stopPromise = machineConnection.emergencyStop();
    await vi.runAllTimersAsync();
    await stopPromise;

    expect(calls).not.toContain("send(M5)");

    vi.useRealTimers();
  });
});
