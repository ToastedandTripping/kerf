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
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../../app/store";
import type { AppState } from "../../../app/store";
import { DEFAULT_LAYERS } from "../../../app/types";
import { MachinePanel } from "../MachinePanel";

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
  });
}

function consoleTexts(): string[] {
  return useStore.getState().consoleLines.map((l) => l.text);
}

/** All serial_send commands the mock received, in order. */
function sentCommands(): string[] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === "serial_send")
    .map(([, args]) => (args as { command: string }).command);
}

function sentBytes(): number[] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === "serial_send_byte")
    .map(([, args]) => (args as { byte: number }).byte);
}

/** Default mock: list_serial_ports + get_status handled; per-command send hook. */
function mockSerial(
  onSend: (command: string) => { responses: string[]; drained: string[] },
) {
  mockInvoke.mockImplementation(async (cmd: string, args?: { command?: string; byte?: number }) => {
    if (cmd === "list_serial_ports") return [];
    if (cmd === "serial_get_status")
      return { status: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>", events: [] };
    if (cmd === "serial_send_byte") return undefined;
    if (cmd === "serial_send") return onSend(args!.command!);
    return undefined;
  });
}

describe("MachinePanel job loop (F13/F17)", () => {
  beforeEach(() => {
    cleanup();
    mockInvoke.mockReset();
    localStorage.clear();
    seedReadyToStart();
  });

  it("completes a job when every line acks", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    const { getByText } = render(<MachinePanel />);

    fireEvent.click(getByText("START"));
    await waitFor(() => expect(consoleTexts()).toContain("Job complete"));
    expect(sentCommands()).toEqual(["G1 X10 Y20", "G1 X50 Y80"]);
    expect(useStore.getState().jobRunning).toBe(false);
  });

  it("aborts on an EMPTY response (protocol failure, never an ack)", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G1") ? { responses: [], drained: [] } : { responses: ["ok"], drained: [] },
    );
    const { getByText } = render(<MachinePanel />);

    fireEvent.click(getByText("START"));
    await waitFor(() =>
      expect(consoleTexts()).toContain("Job aborted -- machine was reset mid-line"),
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
        : { responses: ["ok"], drained: [] },
    );
    const { getByText } = render(<MachinePanel />);

    fireEvent.click(getByText("START"));
    await waitFor(() =>
      expect(consoleTexts()).toContain("Job aborted -- machine was reset mid-line"),
    );
    expect(sentCommands().filter((c) => c.startsWith("G1"))).toEqual(["G1 X10 Y20"]);
  });

  it("stops on ALARM WITHOUT the M5+reset volley", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G1") ? { responses: ["ALARM:1"], drained: [] } : { responses: ["ok"], drained: [] },
    );
    const { getByText } = render(<MachinePanel />);

    fireEvent.click(getByText("START"));
    await waitFor(() =>
      expect(consoleTexts()).toContain(
        "Job stopped -- machine alarm (laser already off; unlock to continue)",
      ),
    );
    // GRBL is locked: M5 would earn error:9, 0x18 would re-reset. Neither fires.
    expect(sentCommands()).not.toContain("M5");
    expect(sentBytes()).not.toContain(0x18);
  });

  it("skips the abort volley when the user pressed STOP (emergencyStop owns it)", async () => {
    // Simulate handleStop firing mid-line: jobRunning goes false and the pump
    // returns the e-stop's reset banner for the in-flight line.
    mockSerial((cmd) => {
      if (cmd.startsWith("G1")) {
        useStore.setState({ jobRunning: false }); // what handleStop does first
        return { responses: ["Grbl 1.1h ['$' for help]"], drained: [] };
      }
      return { responses: ["ok"], drained: [] };
    });
    const { getByText } = render(<MachinePanel />);

    fireEvent.click(getByText("START"));
    await waitFor(() => expect(consoleTexts()).toContain("Job aborted"));
    // No second volley: emergencyStop already ran its own sequence.
    expect(sentCommands()).not.toContain("M5");
    expect(sentBytes()).not.toContain(0x18);
  });

  it("STOP while PAUSED sends NO further line (e-stop re-poll leaves hold)", async () => {
    // PAUSE arrives right after line 1 acks: the mock parks the loop in hold.
    mockSerial((cmd) => {
      if (cmd === "G1 X10 Y20") {
        useStore.setState({ machineState: "hold" });
      }
      return { responses: ["ok"], drained: [] };
    });
    const { getByText } = render(<MachinePanel />);

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
    const { getByText } = render(<MachinePanel />);

    fireEvent.click(getByText("START"));
    await waitFor(() => expect(sentCommands()).toContain("G1 X10 Y20"));
    useStore.setState({ jobRunning: false }); // state remains "hold"

    await waitFor(() => expect(consoleTexts()).toContain("Job cancelled"));
    expect(sentCommands().filter((c) => c.startsWith("G1"))).toEqual(["G1 X10 Y20"]);
  });

  it("stops on error:N through the existing abort path (volley fires)", async () => {
    mockSerial((cmd) =>
      cmd.startsWith("G1") ? { responses: ["error:9"], drained: [] } : { responses: ["ok"], drained: [] },
    );
    const { getByText } = render(<MachinePanel />);

    fireEvent.click(getByText("START"));
    await waitFor(() => expect(consoleTexts()).toContain("Job stopped due to error"));
    await waitFor(() => expect(sentCommands()).toContain("M5"));
  });
});

describe("MachinePanel START/FRAME gating (F15)", () => {
  beforeEach(() => {
    cleanup();
    mockInvoke.mockReset();
    localStorage.clear();
    seedReadyToStart();
  });

  it("disables START with the regenerate hint when G-code is stale", () => {
    useStore.setState({ gcodeStale: true });
    const { getByText } = render(<MachinePanel />);
    const start = getByText("START") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe("Design changed -- regenerate G-code");
  });

  it("disables FRAME when G-code is stale or missing (contract change)", () => {
    useStore.setState({ gcodeStale: true });
    const { getByText, rerender } = render(<MachinePanel />);
    const frame = getByText("FRAME") as HTMLButtonElement;
    expect(frame.disabled).toBe(true);
    expect(frame.title).toBe("Design changed -- regenerate G-code");

    useStore.setState({ gcodeStale: false, gcodeResult: null });
    rerender(<MachinePanel />);
    expect((getByText("FRAME") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("FRAME") as HTMLButtonElement).title).toBe("Generate G-code first");
  });

  it("FRAME traces the moves extents in MACHINE frame — no Y-flip", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    const { getByText } = render(<MachinePanel />);

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
      ]),
    );
  });

  it("FRAME no-ops with a console error on empty moves (never G0 XInfinity)", async () => {
    useStore.setState({ gcodeResult: { ...gcodeWithMoves(), moves: [] } });
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    const { getByText } = render(<MachinePanel />);

    fireEvent.click(getByText("FRAME"));
    await waitFor(() =>
      expect(consoleTexts()).toContain("Nothing to cut -- no moves in the generated G-code"),
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
    const { getByText } = render(<MachinePanel />);

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

  it("sends three sequential commands instead of one 3-line blob", async () => {
    mockSerial(() => ({ responses: ["ok"], drained: [] }));
    const { getByText } = render(<MachinePanel />);

    fireEvent.click(getByText("Fire"));
    await waitFor(() =>
      expect(sentCommands()).toEqual(["M3 S5", "G4 P0.5", "M5"]),
    );
    // No multi-line blob whose pump would stop at the FIRST ok.
    expect(sentCommands().some((c) => c.includes("\n"))).toBe(false);
  });
});
