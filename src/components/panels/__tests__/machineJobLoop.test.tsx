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
import { MaterialTestDialog } from "../MaterialTestDialog";
import { streamJob, pauseJob, resumeJob } from "../../../lib/machine/jobStream";
import { beginJobSession, _testResetJobSession } from "../../../lib/machine/jobSession";
import { machineConnection, _testResetJogAndBedState } from "../../../lib/machine/connection";
import { JOG_REASON_BED } from "../../../lib/machine/jogBounds";
import { StatusBar } from "../../bottom/StatusBar";
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

/** Default mock: list_serial_ports + get_status + serial_stop handled; per-command send hook. */
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

    // B4: emergencyStop calls serial_stop (the native stop)
    if (cmd === "serial_stop") {
      recorder.handler(cmd, args);
      return {
        outcome: "confirmed",
        epochBefore: 1,
        epochAfter: 2,
        messages: [
          "STOP: 0x18 sent",
          "STOP: reset confirmed. Controller reset confirmed. Beam state unqualified — verify visually.",
        ],
      };
    }

    // For serial_get_status, use hold state — B2b extended StatusOutcome
    if (cmd === "serial_get_status") {
      _mockSeq++;
      if (_mockHoldActive) {
        return {
          status: "<Hold:0|MPos:0.000,0.000,0.000|FS:0,0>",
          events: [],
          kind: "report",
          snapshot: {
            epoch: 1,
            seq: _mockSeq,
            state: { hold: { substate: 0 } },
            positionKind: "MPos",
            position: [0, 0, 0],
            wco: null,
            feed: 0,
            spindle: 0,
            accessory: "Unknown",
            units: "Unknown",
            raw: "<Hold:0|MPos:0.000,0.000,0.000|FS:0,0>",
            unknownFields: [],
          },
        };
      }
      return {
        status: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>",
        events: [],
        kind: "report",
        snapshot: {
          epoch: 1,
          seq: _mockSeq,
          state: "idle",
          positionKind: "MPos",
          position: [0, 0, 0],
          wco: null,
          feed: 0,
          spindle: 0,
          accessory: "Unknown",
          units: "Unknown",
          raw: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>",
          unknownFields: [],
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
    // …and the safety volley fired (job was NOT user-stopped): emergencyStop via serial_stop.
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("serial_stop"));
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
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("serial_stop"));
  });

  it("STOP click dispatches emergencyStop via serial_stop (0x18 only, no 0x21, no M5)", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    // serial_stop is invoked directly by emergencyStop — mock it
    mockInvoke.mockImplementation(
      async (cmd: string, args?: { command?: string; byte?: number }) => {
        if (cmd === "serial_stop") {
          return {
            outcome: "confirmed",
            epochBefore: 1,
            epochAfter: 2,
            messages: [
              "STOP: 0x18 sent",
              "STOP: reset confirmed. Controller reset confirmed. Beam state unqualified — verify visually.",
            ],
          };
        }
        if (cmd === "serial_send_byte") {
          recorder.handler(cmd, args);
          return undefined;
        }
        if (cmd === "serial_send") {
          return recorder.handler(cmd, args);
        }
        if (cmd === "serial_get_status") {
          _mockSeq++;
          return {
            status: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>",
            events: [],
            kind: "report",
            snapshot: {
              epoch: 1,
              seq: _mockSeq,
              state: "idle",
              positionKind: "MPos",
              position: [0, 0, 0],
              wco: null,
              feed: 0,
              spindle: 0,
              accessory: "Unknown",
              units: "Unknown",
              raw: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>",
              unknownFields: [],
            },
          };
        }
        return undefined;
      }
    );

    useStore.setState({ jobRunning: true }); // Simulate a running job
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("STOP"));
    await waitFor(() => expect(useStore.getState().jobRunning).toBe(false));

    // DECISIONS ruling: no 0x21 (feed hold), no M5. serial_stop sends 0x18
    // directly in Rust. The TS side must NOT send any bytes itself.
    const bytes = sentBytes();
    expect(bytes).not.toContain(0x21); // No feed hold
    const commands = sentCommands();
    expect(commands).not.toContain("M5"); // No M5

    // serial_stop was invoked
    expect(mockInvoke).toHaveBeenCalledWith("serial_stop");
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
    // T7 (RF-15): every FRAME line from JobActionBar's path carries the
    // session's epoch (the id serial_job_begin returned).
    const records = recorder.allRecords();
    const jobId = records.find((r) => r.command === "serial_job_begin")!.result;
    expect(typeof jobId).toBe("number");
    const sends = records.filter((r) => r.command === "serial_send");
    expect(sends).toHaveLength(7);
    for (const r of sends) expect(r.args.jobEpoch).toBe(jobId);
  });

  it("FRAME no-ops with a console error on empty moves (never G0 XInfinity)", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    const { getByText } = render(<JobActionBar />);
    // S1: the button now shares START's gate, so it renders disabled with the
    // gate reason as its title on empty moves. Reach the HANDLER guard by
    // emptying moves after render and clicking before React re-renders.
    useStore.setState({ gcodeResult: { ...gcodeWithMoves(), moves: [] } });
    fireEvent.click(getByText("FRAME"));
    await waitFor(() =>
      expect(consoleTexts()).toContain("Nothing to cut -- no moves in the generated G-code")
    );
    expect((getByText("FRAME") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("FRAME") as HTMLButtonElement).title).toBe(
      "Nothing to cut -- no moves in the generated G-code"
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

/** RF-15: streamJob requires a session (its jobId is every line's epoch). */
async function freshSession(label: string) {
  _testResetJobSession();
  return beginJobSession(label);
}

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

    const result = await streamJob(frameGcode, {
      label: "Frame",
      session: (await freshSession("Frame"))!,
    });
    expect(result.endState).toBe("aborted");
    expect(consoleTexts()).toContain("Frame aborted -- machine was reset mid-line");
    expect(useStore.getState().jobRunning).toBe(false);
    // Safety volley fired via emergencyStop -> serial_stop
    expect(mockInvoke).toHaveBeenCalledWith("serial_stop");
  });

  it("aborts FRAME on reset banner (line was aborted, not acked)", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G0")
        ? { responses: ["Grbl 1.1h ['$' for help]"], drained: [] }
        : { responses: ["ok"], drained: [] }
    );

    const result = await streamJob(frameGcode, {
      label: "Frame",
      session: (await freshSession("Frame"))!,
    });
    expect(result.endState).toBe("aborted");
    expect(consoleTexts()).toContain("Frame aborted -- machine was reset mid-line");
    expect(useStore.getState().jobRunning).toBe(false);
    // Safety volley fired via serial_stop
    expect(mockInvoke).toHaveBeenCalledWith("serial_stop");
  });

  it("aborts FRAME on ALARM without emergencyStop", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G0")
        ? { responses: ["ALARM:1"], drained: [] }
        : { responses: ["ok"], drained: [] }
    );

    const result = await streamJob(frameGcode, {
      label: "Frame",
      session: (await freshSession("Frame"))!,
    });
    expect(result.endState).toBe("alarm");
    expect(consoleTexts()).toContain(
      "Frame stopped -- machine alarm (laser already off; unlock to continue)"
    );
    expect(useStore.getState().jobRunning).toBe(false);
    // GRBL is locked: no stop fires (alarm excluded from safety path)
    expect(mockInvoke).not.toHaveBeenCalledWith("serial_stop");
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

    const result = await streamJob(testGcode, {
      label: "Material test",
      session: (await freshSession("Material test"))!,
    });
    expect(result.endState).toBe("aborted");
    expect(consoleTexts()).toContain("Material test aborted -- machine was reset mid-line");
    expect(useStore.getState().jobRunning).toBe(false);
    // Safety volley fired via serial_stop
    expect(mockInvoke).toHaveBeenCalledWith("serial_stop");
  });

  it("aborts material test on reset banner (line was aborted, not acked)", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G1")
        ? { responses: ["Grbl 1.1h ['$' for help]"], drained: [] }
        : { responses: ["ok"], drained: [] }
    );

    const result = await streamJob(testGcode, {
      label: "Material test",
      session: (await freshSession("Material test"))!,
    });
    expect(result.endState).toBe("aborted");
    expect(consoleTexts()).toContain("Material test aborted -- machine was reset mid-line");
    expect(useStore.getState().jobRunning).toBe(false);
    // Safety volley fired via serial_stop
    expect(mockInvoke).toHaveBeenCalledWith("serial_stop");
  });

  it("aborts material test on ALARM without emergencyStop", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G1")
        ? { responses: ["ALARM:1"], drained: [] }
        : { responses: ["ok"], drained: [] }
    );

    const result = await streamJob(testGcode, {
      label: "Material test",
      session: (await freshSession("Material test"))!,
    });
    expect(result.endState).toBe("alarm");
    expect(consoleTexts()).toContain(
      "Material test stopped -- machine alarm (laser already off; unlock to continue)"
    );
    expect(useStore.getState().jobRunning).toBe(false);
    // GRBL is locked: no stop fires
    expect(mockInvoke).not.toHaveBeenCalledWith("serial_stop");
  });
});

// ---------------------------------------------------------------------------
// P1-B A1: Pause/Resume volley contract — the exact byte sequences the
// frontend must emit. These pin the F13 deadlock fix: only realtime bytes,
// never line-based M5/M3 in Hold state.
// ---------------------------------------------------------------------------

describe("pauseJob becomes stop / resumeJob contract (B4)", () => {
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

  it("pauseJob routes through emergencyStop (serial_stop), not feed hold", async () => {
    const calls: string[] = [];
    mockInvoke.mockImplementation(async (cmd: string) => {
      calls.push(cmd);
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

    useStore.setState({ jobRunning: true });
    await pauseJob();

    // pauseJob must call serial_stop (via emergencyStop), NOT send 0x21
    expect(calls).toContain("serial_stop");
    expect(calls).not.toContain("serial_send_byte");
    // jobRunning must be false (pause is stop)
    expect(useStore.getState().jobRunning).toBe(false);
    // Must surface the explicit message
    expect(consoleTexts()).toContain(
      "Paused jobs cannot resume until a dark hold is qualified on hardware; the job has been stopped."
    );
  });

  it("pauseJob does NOT emit 0x9E (the toggle that re-arms the beam)", async () => {
    const calls: string[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: { byte?: number }) => {
      if (cmd === "serial_send_byte") calls.push(`byte(${args?.byte?.toString(16)})`);
      else calls.push(cmd);
      if (cmd === "serial_stop") {
        return { outcome: "confirmed", epochBefore: 1, epochAfter: 2, messages: [] };
      }
      return undefined;
    });

    useStore.setState({ jobRunning: true });
    await pauseJob();

    expect(calls).not.toContain("byte(9e)");
  });

  it("pauseJob cannot resume a job (sends no cycle resume)", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "serial_stop") {
        return { outcome: "confirmed", epochBefore: 1, epochAfter: 2, messages: [] };
      }
      return undefined;
    });

    useStore.setState({ jobRunning: true });
    await pauseJob();

    // After pauseJob, jobRunning is false — resume is impossible
    expect(useStore.getState().jobRunning).toBe(false);
  });

  it("resumeJob emits [~ (0x7E)] only — no line M3 re-enable", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));

    await resumeJob();

    // Exact volley: cycle resume byte only
    expect(sentBytes()).toEqual([0x7e]);
    expect(sentCommands()).not.toContain("M3");
    expect(sentCommands()).toHaveLength(0);
  });

  it("PAUSE button routes through pauseJob (stop, not hold)", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
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

    useStore.setState({ jobRunning: true, machineState: "run" });
    const { getByText } = render(<JobActionBar />);

    fireEvent.click(getByText("PAUSE"));

    await waitFor(() => expect(useStore.getState().jobRunning).toBe(false));
    expect(consoleTexts()).toContain(
      "Paused jobs cannot resume until a dark hold is qualified on hardware; the job has been stopped."
    );
  });
});

// ---------------------------------------------------------------------------
// B4: emergencyStop routes through native serial_stop — no TS-side bytes.
// The old A6 edge cases (feed-hold retry, narrowed M5 gate) are deleted:
// serial_stop handles retry and sends 0x18 only (no hold, no M5).
// ---------------------------------------------------------------------------

describe("emergencyStop — native stop contract (B4)", () => {
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

  it("sets alarm on submissionFailed (Rust could not send 0x18)", async () => {
    mockInvoke.mockResolvedValueOnce({
      outcome: "submissionFailed",
      epoch: 1,
      error: "not connected",
      messages: [
        "STOP failed: could not send reset. Use the machine's physical emergency stop. Beam state unqualified.",
      ],
    });

    await machineConnection.emergencyStop();

    expect(useStore.getState().machineState).toBe("alarm");
    expect(consoleTexts()).toContain(
      "STOP failed: could not send reset. Use the machine's physical emergency stop. Beam state unqualified."
    );
  });

  it("handles IPC rejection gracefully", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("channel closed"));

    await machineConnection.emergencyStop();

    expect(useStore.getState().machineState).toBe("alarm");
    expect(consoleTexts().some((t) => t.includes("Beam state unqualified"))).toBe(true);
  });
});

describe("S1 — one admission for four doors", () => {
  const LASER_REASON = "Laser mode is off ($32=0). Press Enable Laser Mode in the Machine panel.";

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

  /** Every powered/motion write the recorder saw (line sends and streamed jobs). */
  function powerWrites() {
    return recorder
      .allRecords()
      .filter((r) => r.command === "serial_send" || r.command === "serial_stream_job");
  }

  it("S1-M3: main FRAME handler with laser mode off and fresh G-code makes zero sends", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    const { getByText } = render(<JobActionBar />);
    useStore.setState({ grblLaserMode: false });
    fireEvent.click(getByText("FRAME")); // synchronous: button not yet re-rendered disabled
    await waitFor(() => expect(consoleTexts()).toContain(LASER_REASON));
    expect(powerWrites()).toEqual([]);
    expect(recorder.findRecords("serial_job_begin")).toEqual([]);
  });

  it("S1-M10: main FRAME handler with stale G-code makes zero sends", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    const { getByText } = render(<JobActionBar />);
    useStore.setState({ gcodeStale: true });
    fireEvent.click(getByText("FRAME"));
    await waitFor(() => expect(consoleTexts()).toContain("Design changed -- regenerate G-code"));
    // Give any (wrongly) admitted frame a chance to reach the wire.
    await new Promise((r) => setTimeout(r, 50));
    expect(powerWrites()).toEqual([]);
    expect(recorder.findRecords("serial_job_begin")).toEqual([]);
  });

  it("S1-M4: main FRAME button is disabled when status is stale", () => {
    useStore.setState({ statusStale: true });
    const { getByText } = render(<JobActionBar />);
    const frame = getByText("FRAME") as HTMLButtonElement;
    expect(frame.disabled).toBe(true);
    expect(frame.title).toBe("Machine status stale — waiting for a fresh status report");
    // Positive sibling: fresh status enables it.
    cleanup();
    useStore.setState({ statusStale: false });
    const again = render(<JobActionBar />);
    expect((again.getByText("FRAME") as HTMLButtonElement).disabled).toBe(false);
  });

  it("S1-M5: a console $32=0 clears laser mode and START then refuses", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    const { getByText } = render(<JobActionBar />);
    await machineConnection.send("$32=0"); // what Console.tsx sends
    fireEvent.click(getByText("START"));
    await waitFor(() => expect((getByText("START") as HTMLButtonElement).title).toBe(LASER_REASON));
    expect((getByText("START") as HTMLButtonElement).disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(sentCommands()).toEqual(["$32=0"]);
    expect(useStore.getState().grblLaserMode).toBe(false);
  });

  describe("material test dialog", () => {
    it("S1-M1: grid send with laser mode off makes zero sends; dialog stays open; reason names $32", async () => {
      mockSerial(() => ({ responses: ["ok"], drained: [] }));
      const onClose = vi.fn();
      const { getByText, getByLabelText } = render(<MaterialTestDialog open onClose={onClose} />);
      // Labels engrave real text, whose font does not load under jsdom.
      fireEvent.click(getByLabelText("Labels"));
      useStore.setState({ grblLaserMode: false });
      fireEvent.click(getByText("Send to Machine"));
      await waitFor(() => expect(consoleTexts()).toContain(LASER_REASON));
      await new Promise((r) => setTimeout(r, 50));
      expect(powerWrites()).toEqual([]);
      expect(recorder.findRecords("serial_job_begin")).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("S1-M2: material FRAME with laser mode off makes zero sends; dialog stays open", async () => {
      mockSerial(() => ({ responses: ["ok"], drained: [] }));
      const onClose = vi.fn();
      const { getByText, getByLabelText } = render(<MaterialTestDialog open onClose={onClose} />);
      // Labels engrave real text, whose font does not load under jsdom.
      fireEvent.click(getByLabelText("Labels"));
      useStore.setState({ grblLaserMode: false });
      fireEvent.click(getByText("Frame"));
      await waitFor(() => expect(consoleTexts()).toContain(LASER_REASON));
      await new Promise((r) => setTimeout(r, 50));
      expect(powerWrites()).toEqual([]);
      expect(recorder.findRecords("serial_job_begin")).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
    });

    // S3 rewrite of S1-M7: the grid is now generated in the machine's frame, so
    // on an origin-top machine it is ADMITTED and every Y it sends is <= 0. The
    // S1 bounds gate still sees originTop (re-pinned by S3-M15).
    it("S1-M7 (S3): an origin-top grid is admitted and lands in negative Y", async () => {
      mockSerial(() => ({ responses: ["ok"], drained: [] }));
      const onClose = vi.fn();
      const { getByText, getByLabelText } = render(<MaterialTestDialog open onClose={onClose} />);
      // Labels engrave real text, whose font does not load under jsdom.
      fireEvent.click(getByLabelText("Labels"));
      useStore.setState({ originTop: true }); // after render: exercise the click-time read
      fireEvent.click(getByText("Send to Machine"));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      await waitFor(() => expect(useStore.getState().jobRunning).toBe(false), { timeout: 5000 });
      expect(recorder.findRecords("serial_job_begin").length).toBe(1);
      const ys = sentCommands().flatMap((c) =>
        [...c.split(";")[0].matchAll(/Y(-?\d*\.?\d+)/g)].map((m) => Number(m[1]))
      );
      expect(ys.some((y) => y < 0)).toBe(true);
      for (const y of ys) expect(y).toBeLessThanOrEqual(0);
    });

    it("S1-D1: a refusal renders in the dialog as an alert with the console closed", async () => {
      useStore.setState({ showConsole: false });
      mockSerial(() => ({ responses: ["ok"], drained: [] }));
      const onClose = vi.fn();
      const { getByText, getByLabelText, queryByRole, rerender } = render(
        <MaterialTestDialog open onClose={onClose} />
      );
      fireEvent.click(getByLabelText("Labels"));
      expect(queryByRole("alert")).toBeNull();
      useStore.setState({ grblLaserMode: false });
      fireEvent.click(getByText("Send to Machine"));
      await waitFor(() => expect(queryByRole("alert")?.textContent).toBe(LASER_REASON));
      expect(useStore.getState().showConsole).toBe(false);
      expect(powerWrites()).toEqual([]);
      // Closing the dialog clears it.
      rerender(<MaterialTestDialog open={false} onClose={onClose} />);
      rerender(<MaterialTestDialog open onClose={onClose} />);
      expect(queryByRole("alert")).toBeNull();
    });

    it.each([
      ["grblLaserMode false", { grblLaserMode: false }, LASER_REASON],
      [
        "workspaceVerified false",
        { workspaceVerified: false },
        "Confirm bed size first — Machine panel, Set bed size",
      ],
      [
        "statusStale true",
        { statusStale: true },
        "Machine status stale — waiting for a fresh status report",
      ],
    ] as const)("S1-D2: Send and Frame are disabled when %s", (_label, patch, reason) => {
      useStore.setState(patch);
      const { getByText } = render(<MaterialTestDialog open onClose={vi.fn()} />);
      const send = getByText("Send to Machine") as HTMLButtonElement;
      const frame = getByText("Frame") as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      expect(frame.disabled).toBe(true);
      expect(send.title).toBe(reason);
      expect(frame.title).toBe(reason);
    });

    it("S1-D3: Send and Frame are enabled in the ready state (positive sibling)", () => {
      const { getByText } = render(<MaterialTestDialog open onClose={vi.fn()} />);
      expect((getByText("Send to Machine") as HTMLButtonElement).disabled).toBe(false);
      expect((getByText("Frame") as HTMLButtonElement).disabled).toBe(false);
    });

    it("S1-C3: grid is admitted with bed verified, laser on, idle and NO design G-code", async () => {
      useStore.setState({ gcodeResult: null, gcodeStale: true });
      mockSerial(() => ({ responses: ["ok"], drained: [] }));
      const onClose = vi.fn();
      const { getByText, getByLabelText } = render(<MaterialTestDialog open onClose={onClose} />);
      // Labels engrave real text, whose font does not load under jsdom.
      fireEvent.click(getByLabelText("Labels"));
      fireEvent.click(getByText("Send to Machine"));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      await waitFor(() => expect(useStore.getState().jobRunning).toBe(false), { timeout: 5000 });
      expect(recorder.findRecords("serial_job_begin").length).toBe(1);
      expect(powerWrites().length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// S3 — MachinePanel and StatusBar: the bed confirmation is remembered per
// machine (kerf-f1 b), the jog gate is visible (kerf-f1 a), and a stale status
// never shows a green "Ready" (Jen C3).
// ---------------------------------------------------------------------------
describe("S3 — MachinePanel and StatusBar", () => {
  const KEYED = ["$3=0", "$23=0", "$32=1", "$100=80", "$101=80", "ok"];

  function mockPanelMachine(settings: string[]) {
    let seq = 0;
    mockInvoke.mockImplementation(async (cmd: string, args?: { command?: string }) => {
      if (cmd === "serial_connect") return "Grbl 1.1h ['$' for help]";
      if (cmd === "list_serial_ports") return [];
      if (cmd === "serial_send" && args?.command === "$$")
        return { responses: settings, drained: [] };
      if (cmd === "serial_send") return { responses: ["ok"], drained: [] };
      if (cmd === "serial_get_status") {
        seq++;
        return {
          status: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>",
          events: [],
          kind: "report",
          snapshot: {
            epoch: 1,
            seq,
            state: "idle",
            positionKind: "MPos",
            position: [0, 0, 0],
            wco: null,
            feed: 0,
            spindle: 0,
            accessory: "Unknown",
            units: "Unknown",
            raw: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>",
            unknownFields: [],
          },
        };
      }
      return undefined;
    });
  }

  beforeEach(() => {
    cleanup();
    mockInvoke.mockReset();
    resetStatusConsumer();
    _testResetJogAndBedState();
    localStorage.clear();
    seedReadyToStart();
    useStore.setState({ positionKind: "machine", workCoordOffset: { x: 0, y: 0 } });
  });

  afterEach(async () => {
    cleanup();
    if (useStore.getState().machineConnected) await machineConnection.disconnect();
  });

  async function reconnect(port = "/dev/ttyUSB0") {
    await machineConnection.disconnect();
    useStore.setState({ workspaceWidth: 500, workspaceHeight: 300 });
    await machineConnection.connect(port, 115200);
  }

  it("kerf-f1 (b): Confirm in the panel is remembered for this machine across a reconnect", async () => {
    mockPanelMachine(KEYED);
    useStore.setState({ machineConnected: false, workspaceVerified: false });
    await machineConnection.connect("/dev/ttyUSB0", 115200);
    expect(useStore.getState().workspaceVerified).toBe(false);
    const { getByText, getByDisplayValue } = render(<MachinePanel />);
    expect(
      getByText(
        "Kerf couldn't read the bed size from the machine. Confirm it before jogging or cutting."
      )
    ).toBeTruthy();
    fireEvent.click(getByText("Set bed size"));
    getByText("The width and height the laser head can reach, in mm.");
    const wInput = getByDisplayValue("500");
    const hInput = getByDisplayValue("300");
    fireEvent.change(wInput, { target: { value: "300" } });
    fireEvent.change(hInput, { target: { value: "200" } });
    fireEvent.click(getByText("Confirm"));
    expect(useStore.getState().workspaceVerified).toBe(true);
    await reconnect();
    const st = useStore.getState();
    expect(st.workspaceVerified).toBe(true);
    expect([st.workspaceWidth, st.workspaceHeight]).toEqual([300, 200]);
  });

  it("N7: an empty width is refused in plain words, the inputs stay open, nothing remembered", async () => {
    mockPanelMachine(KEYED);
    useStore.setState({ machineConnected: false, workspaceVerified: false });
    await machineConnection.connect("/dev/ttyUSB0", 115200);
    const { getByText, getByDisplayValue } = render(<MachinePanel />);
    fireEvent.click(getByText("Set bed size"));
    fireEvent.change(getByDisplayValue("500"), { target: { value: "" } });
    fireEvent.click(getByText("Confirm"));
    expect(useStore.getState().workspaceVerified).toBe(false);
    expect(localStorage.getItem("kerf-bed-confirmations")).toBeNull();
    expect(consoleTexts()).toContain(
      "Bed size not set — enter a width and height in mm, both above 0."
    );
    getByText("The width and height the laser head can reach, in mm.");
  });

  it("a remembered bed shows who set it, with a Change button that opens the inputs", async () => {
    mockPanelMachine(KEYED);
    useStore.setState({ machineConnected: false, workspaceVerified: false });
    await machineConnection.connect("/dev/ttyUSB0", 115200);
    machineConnection.confirmBedSize(300, 200);
    await reconnect();
    const { getByText, queryByText } = render(<MachinePanel />);
    await waitFor(() =>
      expect(getByText("Bed 300 × 200 mm — you confirmed this size earlier.")).toBeTruthy()
    );
    expect(queryByText("The width and height the laser head can reach, in mm.")).toBeNull();
    fireEvent.click(getByText("Change"));
    getByText("The width and height the laser head can reach, in mm.");
  });

  it("an unconfirmed bed disables all four jog buttons and says why, visibly", () => {
    useStore.setState({ workspaceVerified: false, statusStale: false });
    const { getByText, getAllByTitle, getByTestId } = render(<MachinePanel />);
    fireEvent.click(getByText("Positioning (10mm)"));
    const buttons = getAllByTitle(JOG_REASON_BED) as HTMLButtonElement[];
    expect(buttons).toHaveLength(4);
    for (const b of buttons) expect(b.disabled).toBe(true);
    expect(getByTestId("jog-blocked-note").textContent).toBe(JOG_REASON_BED);
  });

  it("jog buttons are enabled and titled by axis when the gate is clear (positive sibling)", () => {
    const { getByText, getByTitle, queryByTestId } = render(<MachinePanel />);
    fireEvent.click(getByText("Positioning (10mm)"));
    for (const t of ["Y+", "X-", "X+", "Y-"]) {
      expect((getByTitle(t) as HTMLButtonElement).disabled).toBe(false);
    }
    expect(queryByTestId("jog-blocked-note")).toBeNull();
  });

  it("C3: a stale status reads Stale in the StatusBar, never Ready", () => {
    useStore.setState({ machineConnected: true, machineState: "idle", statusStale: true });
    const { getByText, queryByText } = render(<StatusBar />);
    expect(getByText("Stale")).toBeTruthy();
    expect(queryByText("Ready")).toBeNull();
    cleanup();
    useStore.setState({ statusStale: false });
    const fresh = render(<StatusBar />);
    expect(fresh.getByText("Ready")).toBeTruthy();
  });

  it("C3: the Machine header reads stale, not idle, while status is stale", () => {
    useStore.setState({ machineConnected: true, machineState: "idle", statusStale: true });
    const { getByText, queryByText } = render(<MachinePanel />);
    expect(getByText("stale")).toBeTruthy();
    expect(queryByText("idle")).toBeNull();
  });

  it("C3 control: disconnected reads Disconnected, not Stale", () => {
    useStore.setState({
      machineConnected: false,
      machineState: "disconnected",
      statusStale: true,
    });
    const { getByText, queryByText } = render(<StatusBar />);
    expect(getByText("Disconnected")).toBeTruthy();
    expect(queryByText("Stale")).toBeNull();
  });
});
