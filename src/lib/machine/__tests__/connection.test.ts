import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must mock before importing modules that use it
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../../app/store";
import { DEFAULT_LAYERS } from "../../../app/types";
import {
  machineConnection,
  _testResetPollFailures,
  _testResetJogAndBedState,
  isGrblSettingsWrite,
  getBedSource,
} from "../connection";
import {
  JOG_REASON_AXIS,
  JOG_REASON_JOB,
  JOG_REASON_OFFSET,
  JOG_REASON_PENDING,
  JOG_REASON_STALE,
  JOG_REASON_TARGET,
} from "../jogBounds";
import { _testResetJobEvidence } from "../lastSentLine";
import { resetStatusConsumer } from "../machineStatus";
import { SerialTraceRecorder } from "../../../lib/machine/__tests__/serialTraceHarness";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

function seedConnectedStore() {
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
    grblLaserMode: false,
    grblSValueMax: 1000,
    grblMaxFeedRateX: 0,
    grblMaxFeedRateY: 0,
  });
}

function consoleTexts(): string[] {
  return useStore.getState().consoleLines.map((l) => l.text);
}

function consoleLine(text: string) {
  return useStore.getState().consoleLines.find((l) => l.text === text);
}

/** Build a StatusOutcome with a snapshot, matching what B2a's Rust side returns. */
let snapshotSeq = 0;
function makeStatusOutcome(
  raw: string,
  events: string[] = [],
  opts?: { epoch?: number; busy?: boolean; noResponse?: boolean }
) {
  if (opts?.busy) {
    return { status: "", events, kind: "busy", snapshot: null };
  }
  if (opts?.noResponse) {
    return { status: "", events, kind: "noResponse", snapshot: null };
  }
  // Parse enough of the raw string to build a minimal snapshot.
  // Rust's serde(rename_all = "camelCase") serializes MachineState variants
  // as lowercase simple variants and camelCase struct variant keys.
  const stateMatch = raw.match(/^<(\w+)/);
  const stateToken = stateMatch?.[1] ?? "Idle";
  let state: unknown = stateToken.toLowerCase();
  const holdMatch = stateToken.match(/^Hold(?::(\d+))?$/);
  const doorMatch = stateToken.match(/^Door(?::(\d+))?$/);
  if (holdMatch) state = { hold: { substate: holdMatch[1] ? parseInt(holdMatch[1]) : null } };
  else if (doorMatch) state = { door: { substate: doorMatch[1] ? parseInt(doorMatch[1]) : null } };

  const posMatch = raw.match(/([MW])Pos:([-\d.]+),([-\d.]+),([-\d.]+)/);
  const wcoMatch = raw.match(/WCO:([-\d.]+),([-\d.]+),([-\d.]+)/);
  const fsMatch = raw.match(/FS:([-\d.]+),([-\d.]+)/);

  snapshotSeq++;
  return {
    status: raw,
    events,
    kind: "report",
    snapshot: {
      epoch: opts?.epoch ?? 1,
      seq: snapshotSeq,
      state,
      positionKind: posMatch ? (posMatch[1] === "M" ? "MPos" : "WPos") : null,
      position: posMatch
        ? [parseFloat(posMatch[2]), parseFloat(posMatch[3]), parseFloat(posMatch[4])]
        : null,
      wco: wcoMatch
        ? [parseFloat(wcoMatch[1]), parseFloat(wcoMatch[2]), parseFloat(wcoMatch[3])]
        : null,
      feed: fsMatch ? parseFloat(fsMatch[1]) : null,
      spindle: fsMatch ? parseFloat(fsMatch[2]) : null,
      accessory: "Unknown",
      units: "Unknown",
      raw,
      unknownFields: [],
    },
  };
}

let recorder: SerialTraceRecorder;

describe("connection.ts (TN3)", () => {
  beforeEach(() => {
    _testResetPollFailures();
    resetStatusConsumer();
    snapshotSeq = 0;
    mockInvoke.mockReset();
    localStorage.clear();
    seedConnectedStore();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (recorder) {
      await recorder.dispose();
    }
  });

  // TN3a — GRBL status-report regex parsing
  describe("pollStatus — status regex", () => {
    it("parses <Idle|MPos:1.000,2.000,0.000> and updates store", async () => {
      mockInvoke.mockResolvedValueOnce(makeStatusOutcome("<Idle|MPos:1.000,2.000,0.000|FS:0,0>"));
      await machineConnection.pollStatus();

      const state = useStore.getState();
      expect(state.machineState).toBe("idle");
      expect(state.machinePosition).toEqual({ x: 1, y: 2, z: 0 });
    });

    it("parses <Run|MPos:5.500,3.250,0.000> and sets run state", async () => {
      mockInvoke.mockResolvedValueOnce(makeStatusOutcome("<Run|MPos:5.500,3.250,0.000|FS:100,0>"));
      await machineConnection.pollStatus();

      const state = useStore.getState();
      expect(state.machineState).toBe("run");
      expect(state.machinePosition!.x).toBeCloseTo(5.5, 5);
      expect(state.machinePosition!.y).toBeCloseTo(3.25, 5);
    });

    it("handles NoResponse without crashing", async () => {
      mockInvoke.mockResolvedValueOnce(makeStatusOutcome("", [], { noResponse: true }));
      await expect(machineConnection.pollStatus()).resolves.toBeUndefined();
      // State should not change from idle
      expect(useStore.getState().machineState).toBe("idle");
    });

    it("surfaces junk-skip events: ALARM styled error, [MSG:] styled info", async () => {
      mockInvoke.mockResolvedValueOnce(
        makeStatusOutcome("", ["ALARM:1", "[MSG:Reset to continue]"], { noResponse: true })
      );
      await machineConnection.pollStatus();
      expect(consoleLine("ALARM:1")?.type).toBe("error");
      expect(consoleLine("[MSG:Reset to continue]")?.type).toBe("info");
    });
  });

  // TN3b — $$ settings parse
  describe("queryGrblSettings", () => {
    it("parses $30 (S-value max) and $32 (laser mode), returns true", async () => {
      mockInvoke.mockResolvedValueOnce({ responses: ["$30=1000", "$32=1"], drained: [] });
      const ok = await machineConnection.queryGrblSettings();

      const state = useStore.getState();
      expect(ok).toBe(true);
      expect(state.grblSValueMax).toBe(1000);
      expect(state.grblLaserMode).toBe(true);
    });

    it("sets workspace size from $130/$131 only when both are > 0", async () => {
      mockInvoke.mockResolvedValueOnce({ responses: ["$130=300", "$131=200"], drained: [] });
      await machineConnection.queryGrblSettings();

      const state = useStore.getState();
      expect(state.workspaceWidth).toBe(300);
      expect(state.workspaceHeight).toBe(200);
    });

    it("does not set workspace if only one travel axis is present", async () => {
      const prev = useStore.getState().workspaceWidth;
      mockInvoke.mockResolvedValueOnce({ responses: ["$130=400"], drained: [] });
      await machineConnection.queryGrblSettings();
      // workspaceWidth must stay the same — both must be > 0 to update
      expect(useStore.getState().workspaceWidth).toBe(prev);
    });

    it("sets grblMaxFeedRateX/Y from $110/$111 when both are > 0", async () => {
      mockInvoke.mockResolvedValueOnce({ responses: ["$110=8000", "$111=8000"], drained: [] });
      await machineConnection.queryGrblSettings();

      const state = useStore.getState();
      expect(state.grblMaxFeedRateX).toBe(8000);
      expect(state.grblMaxFeedRateY).toBe(8000);
    });

    it("sets grblMaxFeedRateX/Y when axes differ", async () => {
      mockInvoke.mockResolvedValueOnce({ responses: ["$110=10000", "$111=8000"], drained: [] });
      await machineConnection.queryGrblSettings();

      const state = useStore.getState();
      expect(state.grblMaxFeedRateX).toBe(10000);
      expect(state.grblMaxFeedRateY).toBe(8000);
    });

    it("does not set feed rate if only one axis is present (both required)", async () => {
      useStore.setState({ grblMaxFeedRateX: 0, grblMaxFeedRateY: 0 });
      mockInvoke.mockResolvedValueOnce({ responses: ["$110=8000"], drained: [] });
      await machineConnection.queryGrblSettings();

      const state = useStore.getState();
      expect(state.grblMaxFeedRateX).toBe(0);
      expect(state.grblMaxFeedRateY).toBe(0);
    });

    it("logs 'Max feed rate' console line when $110/$111 parsed successfully", async () => {
      mockInvoke.mockResolvedValueOnce({ responses: ["$110=8000", "$111=6000"], drained: [] });
      await machineConnection.queryGrblSettings();

      const texts = consoleTexts();
      expect(
        texts.some((t) => t.includes("Max feed rate") && t.includes("8000") && t.includes("6000"))
      ).toBe(true);
    });

    it("returns false when the response contains no $N=V lines", async () => {
      mockInvoke.mockResolvedValueOnce({ responses: ["error:9"], drained: [] });
      expect(await machineConnection.queryGrblSettings()).toBe(false);
    });

    it("returns false when the invoke rejects", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("boom"));
      expect(await machineConnection.queryGrblSettings()).toBe(false);
    });
  });

  // TN3c — 3-consecutive-failure auto-disconnect
  describe("pollStatus — auto-disconnect after 3 failures", () => {
    it("disconnects and resets state after 3 consecutive poll failures", async () => {
      // disconnect() itself calls invoke("serial_disconnect") — mock must accept it
      mockInvoke.mockRejectedValue(new Error("serial error"));

      // 3 failures
      await machineConnection.pollStatus();
      await machineConnection.pollStatus();
      await machineConnection.pollStatus();

      const state = useStore.getState();
      expect(state.machineConnected).toBe(false);
      expect(state.machineState).toBe("disconnected");
    });

    it("does not disconnect after fewer than 3 failures", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("serial error"));
      mockInvoke.mockRejectedValueOnce(new Error("serial error"));
      // Only 2 failures — should still be connected
      await machineConnection.pollStatus();
      await machineConnection.pollStatus();

      expect(useStore.getState().machineConnected).toBe(true);
    });

    it("busy/none sentinel does NOT advance the 3-strike counter (it resets it)", async () => {
      // The Ok-typed empty sentinel means "a pump holds the lock" (e.g. a 30s
      // $H). Three of them within 750ms must NOT disconnect — that would abort
      // the homing cycle the skip exists to tolerate.
      mockInvoke.mockResolvedValue(makeStatusOutcome("", [], { busy: true }));
      await machineConnection.pollStatus();
      await machineConnection.pollStatus();
      await machineConnection.pollStatus();
      expect(useStore.getState().machineConnected).toBe(true);
      expect(useStore.getState().machineState).toBe("idle");

      // And it RESETS the counter: 2 failures + sentinel + 2 failures ≠ 3 strikes.
      mockInvoke.mockReset();
      mockInvoke.mockRejectedValueOnce(new Error("x"));
      mockInvoke.mockRejectedValueOnce(new Error("x"));
      mockInvoke.mockResolvedValueOnce(makeStatusOutcome("", [], { busy: true }));
      mockInvoke.mockRejectedValueOnce(new Error("x"));
      mockInvoke.mockRejectedValueOnce(new Error("x"));
      for (let i = 0; i < 5; i++) await machineConnection.pollStatus();
      expect(useStore.getState().machineConnected).toBe(true);
    });
  });

  // F13/F17 — send(): drained-line surfacing, ALARM styling, position-only DRO
  describe("send — response classification", () => {
    it("styles ALARM response lines as error", async () => {
      mockInvoke.mockResolvedValueOnce({ responses: ["ALARM:1"], drained: [] });
      const responses = await machineConnection.send("G1 X10");
      expect(responses).toEqual(["ALARM:1"]);
      expect(consoleLine("ALARM:1")?.type).toBe("error");
    });

    it("filters <...> reports from the console and refreshes POSITION ONLY", async () => {
      useStore.setState({ machineState: "run" });
      mockInvoke.mockResolvedValueOnce({
        responses: ["<Hold|MPos:1.000,2.000,3.000|FS:0,0>", "ok"],
        drained: [],
      });
      const responses = await machineConnection.send("G1 X10");
      // Raw responses keep the report; console does not.
      expect(responses).toHaveLength(2);
      expect(consoleTexts().some((t) => t.startsWith("<"))).toBe(false);
      // Position refreshed from the in-pump report…
      expect(useStore.getState().machinePosition).toEqual({ x: 1, y: 2, z: 3 });
      // …but machineState is NEVER written from in-pump data: a stale <Hold…>
      // consumed after resume would re-arm the pause-wait loop (wedged job).
      expect(useStore.getState().machineState).toBe("run");
    });

    it("surfaces drained pre-write lines (stale ALARM/MSG) without attributing them", async () => {
      mockInvoke.mockResolvedValueOnce({
        responses: ["ok"],
        drained: ["ALARM:2", "[MSG:Reset to continue]"],
      });
      const responses = await machineConnection.send("$X");
      expect(responses).toEqual(["ok"]);
      expect(consoleLine("ALARM:2")?.type).toBe("error");
      expect(consoleLine("[MSG:Reset to continue]")?.type).toBe("info");
    });

    it("returns the error:disconnected contract when the invoke rejects", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("disconnected: no response"));
      const responses = await machineConnection.send("G1 X10");
      expect(responses).toEqual(["error:disconnected"]);
    });
  });

  // F14 — connect() owns the settings sequence on BOTH entry paths
  describe("connect/autoConnect settings parity", () => {
    function mockMachine(settings: string[]) {
      mockInvoke.mockImplementation(async (cmd: string, args?: { command?: string }) => {
        if (cmd === "serial_connect") return "Grbl 1.1h ['$' for help]";
        // Soft-reset byte sent during connect — accept and ignore
        if (cmd === "serial_send_byte") return undefined;
        if (cmd === "serial_send" && args?.command === "$$")
          return { responses: settings, drained: [] };
        if (cmd === "serial_send") return { responses: ["ok"], drained: [] };
        if (cmd === "serial_get_status")
          return makeStatusOutcome("<Idle|MPos:0.000,0.000,0.000|FS:0,0>");
        if (cmd === "list_serial_ports")
          return [
            {
              name: "/dev/ttyUSB0",
              portType: "USB",
              vid: null,
              pid: null,
              manufacturer: null,
              product: null,
            },
          ];
        if (cmd === "serial_disconnect") return undefined;
        return undefined;
      });
    }

    it("autoConnect produces byte-identical console output to manual connect", async () => {
      vi.useFakeTimers(); // keep the 250ms poller from firing during the test
      mockMachine(["$30=255", "$32=0"]);

      // Manual path — advance past the 2000ms soft-reset settle delay
      const connectPromise1 = machineConnection.connect("/dev/ttyUSB0", 115200);
      await vi.advanceTimersByTimeAsync(2000);
      await connectPromise1;
      const manualLines = useStore.getState().consoleLines.map((l) => `${l.type}|${l.text}`);
      expect(useStore.getState().grblSValueMax).toBe(255);
      await machineConnection.disconnect();

      // Auto path (connect() saved the port to localStorage above)
      seedConnectedStore();
      useStore.setState({ machineConnected: false, grblSValueMax: 1000 });
      const autoPromise = machineConnection.autoConnect();
      await vi.advanceTimersByTimeAsync(2000);
      const ok = await autoPromise;
      expect(ok).toBe(true);
      const autoLines = useStore.getState().consoleLines.map((l) => `${l.type}|${l.text}`);
      await machineConnection.disconnect();

      // The settings query + warnings happened identically on both paths —
      // in particular S-max was read on autoConnect (the F14 defect).
      expect(autoLines).toEqual(manualLines);
      expect(useStore.getState().grblSValueMax).toBe(255);
      expect(autoLines.some((l) => l.includes("$30=255"))).toBe(true);
      expect(autoLines.some((l) => l.includes("laser mode ($32) is disabled"))).toBe(true);
    });

    it("suppresses the $32 warning and emits the unverified line when $$ parse fails", async () => {
      vi.useFakeTimers();
      mockMachine(["error:9"]);

      const connectPromise = machineConnection.connect("/dev/ttyUSB0", 115200);
      await vi.advanceTimersByTimeAsync(2000);
      await connectPromise;
      const texts = consoleTexts();
      expect(texts.some((t) => t.includes("settings unverified"))).toBe(true);
      // grblLaserMode defaults false — warning off the default would be spurious.
      expect(texts.some((t) => t.includes("laser mode ($32) is disabled"))).toBe(false);
      await machineConnection.disconnect();
    });

    it("emits no $32 warning when laser mode is enabled", async () => {
      vi.useFakeTimers();
      mockMachine(["$30=1000", "$32=1"]);

      const connectPromise = machineConnection.connect("/dev/ttyUSB0", 115200);
      await vi.advanceTimersByTimeAsync(2000);
      await connectPromise;
      const texts = consoleTexts();
      expect(texts.some((t) => t.includes("laser mode ($32) is disabled"))).toBe(false);
      expect(texts.some((t) => t.includes("settings unverified"))).toBe(false);
      await machineConnection.disconnect();
    });

    // DTR hardware-reset + 0x18 soft-reset now happen inside Rust's
    // serial_connect (before it returns). The TS side just queries $$ after.
    it("queries GRBL settings immediately after connect (reset is Rust-side)", async () => {
      const invokeOrder: string[] = [];
      mockInvoke.mockImplementation(
        async (cmd: string, args?: { command?: string; byte?: number }) => {
          if (cmd === "serial_connect") return "Grbl 1.1h ['$' for help]";
          if (cmd === "serial_send_byte") {
            invokeOrder.push(`byte(${args?.byte?.toString(16) ?? "?"})`);
            return undefined;
          }
          if (cmd === "serial_send" && args?.command === "$$") {
            invokeOrder.push("send($$)");
            return { responses: ["$30=1000", "$32=1"], drained: [] };
          }
          if (cmd === "serial_send") return { responses: ["ok"], drained: [] };
          if (cmd === "serial_get_status")
            return makeStatusOutcome("<Idle|MPos:0.000,0.000,0.000|FS:0,0>");
          if (cmd === "serial_disconnect") return undefined;
          return undefined;
        }
      );

      await machineConnection.connect("/dev/ttyUSB0", 115200);

      // No TS-side 0x18 — reset is handled in Rust before connect returns
      expect(invokeOrder.filter((o) => o === "byte(18)")).toHaveLength(0);
      // $$ must still be sent
      expect(invokeOrder).toContain("send($$)");

      await machineConnection.disconnect();
    });
  });

  // TN3d — e-stop sequencing, REWRITTEN for the 2026-09-20 DECISIONS ruling:
  // "Abort sends 0x18 immediately — no feed hold, no M5, no ack wait."
  // emergencyStop now invokes B1's serial_stop. No TS-side bytes at all.
  describe("emergencyStop sequencing (native stop contract)", () => {
    it("invokes serial_stop and surfaces confirmed messages", async () => {
      mockInvoke.mockResolvedValueOnce({
        outcome: "confirmed",
        epochBefore: 1,
        epochAfter: 2,
        messages: [
          "STOP: 0x18 sent",
          "STOP: reset confirmed. Controller reset confirmed. Beam state unqualified — verify visually.",
        ],
      });

      await machineConnection.emergencyStop();

      expect(mockInvoke).toHaveBeenCalledWith("serial_stop");
      expect(consoleTexts()).toContain("Emergency stop initiated");
      expect(consoleTexts()).toContain("STOP: 0x18 sent");
      expect(consoleTexts()).toContain(
        "STOP: reset confirmed. Controller reset confirmed. Beam state unqualified — verify visually."
      );
    });

    it("sets alarm state on submissionFailed outcome", async () => {
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

    it("surfaces unconfirmed messages as warnings", async () => {
      mockInvoke.mockResolvedValueOnce({
        outcome: "submittedUnconfirmed",
        epoch: 1,
        messages: [
          "STOP: 0x18 sent",
          "STOP: unconfirmed — use the machine's physical stop before reconnecting. Beam state unqualified — verify visually.",
        ],
      });

      await machineConnection.emergencyStop();

      expect(consoleTexts()).toContain("STOP: 0x18 sent");
      expect(consoleTexts()).toContain(
        "STOP: unconfirmed — use the machine's physical stop before reconnecting. Beam state unqualified — verify visually."
      );
      // Not submissionFailed, so state is NOT forced to alarm
      expect(useStore.getState().machineState).not.toBe("alarm");
    });

    it("sets alarm and surfaces error when invoke rejects (IPC failure)", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("IPC channel closed"));

      await machineConnection.emergencyStop();

      expect(useStore.getState().machineState).toBe("alarm");
      expect(consoleTexts().some((t) => t.includes("Beam state unqualified"))).toBe(true);
    });

    it("sends NO bytes from TS — no 0x21, no 0x18, no M5", async () => {
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

      await machineConnection.emergencyStop();

      // Only serial_stop — no serial_send_byte, no serial_send, no serial_get_status
      expect(calls).toEqual(["serial_stop"]);
    });
  });

  // ---- A2: disconnect beam-on safety ----
  describe("disconnect — A2 beam-on safety", () => {
    it("fires emergencyStop (serial_stop) before teardown when a job is running", async () => {
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
        if (cmd === "serial_disconnect") return undefined;
        return undefined;
      });

      useStore.setState({ jobRunning: true, machineState: "run" });
      await machineConnection.disconnect();

      // serial_stop must fire BEFORE serial_disconnect
      const stopIdx = calls.indexOf("serial_stop");
      const disconnectIdx = calls.indexOf("serial_disconnect");
      expect(stopIdx).toBeGreaterThanOrEqual(0);
      expect(disconnectIdx).toBeGreaterThan(stopIdx);
      // jobRunning must be false after disconnect
      expect(useStore.getState().jobRunning).toBe(false);
      expect(useStore.getState().machineConnected).toBe(false);
    });

    it("skips emergencyStop on clean idle disconnect", async () => {
      const calls: string[] = [];
      mockInvoke.mockImplementation(async (cmd: string) => {
        calls.push(cmd);
        if (cmd === "serial_disconnect") return undefined;
        return undefined;
      });

      useStore.setState({ jobRunning: false, machineState: "idle" });
      await machineConnection.disconnect();

      // No serial_stop — only the teardown
      expect(calls).not.toContain("serial_stop");
      expect(calls).toContain("serial_disconnect");
      expect(useStore.getState().machineConnected).toBe(false);
    });

    it("fires emergencyStop when machine is in hold state (even if jobRunning is false)", async () => {
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
        if (cmd === "serial_disconnect") return undefined;
        return undefined;
      });

      useStore.setState({ jobRunning: false, machineState: "hold" });
      await machineConnection.disconnect();

      // E-stop fires even when jobRunning is false (machine is in hold)
      expect(calls).toContain("serial_stop");
    });
  });

  // ---- Recorder self-test: cross-channel order preservation ----
  describe("SerialTraceRecorder — order preservation", () => {
    it("preserves cross-channel order (bytes before/after sends)", async () => {
      vi.useFakeTimers();
      const onSend = () => ({ responses: ["ok"], drained: [] });
      recorder = new SerialTraceRecorder(onSend);
      mockInvoke.mockImplementation(recorder.handler);

      // Simulate a generic byte+send sequence for recorder verification
      await recorder.handler("serial_send_byte", { byte: 0x18 });
      await vi.advanceTimersByTimeAsync(200);
      await recorder.handler("serial_get_status", {});
      await recorder.handler("serial_send", { command: "$$" });

      // Verify order: all records in sequence
      const records = recorder.allRecords();
      expect(records.length).toBeGreaterThanOrEqual(3);
      expect(records[0].command).toBe("serial_send_byte");
      expect(records[0].args.byte).toBe(0x18);
      expect(records[1].command).toBe("serial_get_status");
      expect(records[2].command).toBe("serial_send");
      expect(records[2].args.command).toBe("$$");

      // Derived views must preserve the same order
      const bytes = recorder.sentBytes();
      expect(bytes[0]).toBe(0x18);
      const commands = recorder.sentCommands();
      expect(commands.some((c) => c === "$$")).toBe(true);

      vi.useRealTimers();
    });
  });

  // ---- A7: connect re-entrancy coalescing ----
  describe("connect — A7 re-entrancy coalescing", () => {
    it("coalesces concurrent connect() calls — serial_connect fires once", async () => {
      vi.useFakeTimers();
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "serial_connect") return "Grbl 1.1h ['$' for help]";
        if (cmd === "serial_send_byte") return undefined;
        if (cmd === "serial_send") return { responses: ["$30=1000", "$32=1"], drained: [] };
        if (cmd === "serial_get_status")
          return makeStatusOutcome("<Idle|MPos:0.000,0.000,0.000|FS:0,0>");
        if (cmd === "serial_disconnect") return undefined;
        return undefined;
      });

      // Fire two connects concurrently
      const p1 = machineConnection.connect("/dev/ttyUSB0", 115200);
      const p2 = machineConnection.connect("/dev/ttyUSB0", 115200);

      await vi.advanceTimersByTimeAsync(2000);
      const [r1, r2] = await Promise.all([p1, p2]);

      // Both resolve to the same value (coalesced)
      expect(r1).toBe(r2);

      // serial_connect was only called once (not twice)
      const connectCalls = mockInvoke.mock.calls.filter(
        ([cmd]: string[]) => cmd === "serial_connect"
      );
      expect(connectCalls).toHaveLength(1);

      await machineConnection.disconnect();
    });
  });
});

// ---------------------------------------------------------------------------
// T6 (RF-15): send() threads the job epoch and surfaces a refusal distinctly.
// ---------------------------------------------------------------------------
describe("spindle-drop evidence (E3)", () => {
  const RUN_500 = "<Run|MPos:0.000,0.000,0.000|FS:1000,500>";
  const RUN_0 = "<Run|MPos:0.000,0.000,0.000|FS:1000,0>";
  const dropLines = () => consoleTexts().filter((t) => t.includes("spindle 0 during Run"));

  beforeEach(() => {
    _testResetPollFailures();
    resetStatusConsumer();
    snapshotSeq = 0;
    mockInvoke.mockReset();
    seedConnectedStore();
    // A connect() subscription left by an earlier test would suspend
    // pollStatus while jobRunning is true (Diagnosis 1).
    useStore.setState({ jobRunning: false });
    _testResetJobEvidence();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pollStatus: Run 500 then Run 0 prints exactly one status-only drop line", async () => {
    mockInvoke.mockResolvedValueOnce(makeStatusOutcome(RUN_500));
    await machineConnection.pollStatus();
    mockInvoke.mockResolvedValueOnce(makeStatusOutcome(RUN_0));
    await machineConnection.pollStatus();
    const drops = dropLines();
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain("Status only");
    expect(drops[0]).toContain("no job line recorded");
    expect(consoleTexts().some((t) => t.includes("may have stopped firing"))).toBe(false);
  });

  it("pollStatus: Run 500 then Idle 0 is not a drop", async () => {
    mockInvoke.mockResolvedValueOnce(makeStatusOutcome(RUN_500));
    await machineConnection.pollStatus();
    mockInvoke.mockResolvedValueOnce(makeStatusOutcome("<Idle|MPos:0.000,0.000,0.000|FS:0,0>"));
    await machineConnection.pollStatus();
    expect(useStore.getState().spindleSpeed).toBe(0);
    expect(dropLines()).toHaveLength(0);
  });

  it("pollStatus: repeated Run 0 after a drop prints no second line", async () => {
    for (const r of [RUN_500, RUN_0, RUN_0, RUN_0]) {
      mockInvoke.mockResolvedValueOnce(makeStatusOutcome(r));
      await machineConnection.pollStatus();
    }
    expect(dropLines()).toHaveLength(1);
  });

  it("getStatusReport (the drain path) feeds the check", async () => {
    mockInvoke.mockResolvedValueOnce({ status: RUN_500, events: [] });
    expect(await machineConnection.getStatusReport()).toBe(RUN_500);
    mockInvoke.mockResolvedValueOnce({ status: RUN_0, events: [] });
    expect(await machineConnection.getStatusReport()).toBe(RUN_0);
    expect(dropLines()).toHaveLength(1);
  });

  it("send(): a throwing diagnostic never reaches send()'s catch", async () => {
    const realInfo = console.info;
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes("spindle 0")) throw new Error("boom");
      realInfo(...args);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const responses = [RUN_500, RUN_0, "ok"];
    mockInvoke.mockResolvedValue({ responses, drained: [] });
    const out = await machineConnection.send("G1 X1", { jobEpoch: 7 });
    expect(out).toEqual(responses);
    expect(consoleTexts().some((t) => t.startsWith("Send failed"))).toBe(false);
    expect(consoleTexts()).toContain("ok");
  });

  it("send(): steady cutting (500, 300, 500) never prints a drop line (control)", async () => {
    const responses = [RUN_500, "<Run|MPos:0.000,0.000,0.000|FS:1000,300>", RUN_500, "ok"];
    mockInvoke.mockResolvedValue({ responses, drained: [] });
    expect(await machineConnection.send("G1 X1", { jobEpoch: 7 })).toEqual(responses);
    expect(consoleTexts()).toContain("ok");
    expect(dropLines()).toHaveLength(0);
  });
});

describe("connection.send — RF-15 job epoch and refusal", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    seedConnectedStore();
  });

  it("a job line invokes serial_send with exactly { command, jobEpoch }", async () => {
    mockInvoke.mockResolvedValue({ responses: ["ok"], drained: [] });
    await machineConnection.send("G1 X1", { jobEpoch: 7 });
    expect(mockInvoke).toHaveBeenCalledWith("serial_send", { command: "G1 X1", jobEpoch: 7 });
  });

  it("a console line invokes serial_send with { command } and no jobEpoch key", async () => {
    mockInvoke.mockResolvedValue({ responses: ["ok"], drained: [] });
    await machineConnection.send("$$");
    const args = mockInvoke.mock.calls.find((c) => c[0] === "serial_send")![1];
    expect(args).toEqual({ command: "$$" });
    expect("jobEpoch" in args).toBe(false);
  });

  it("a raw-string refusal returns the refusal, not error:disconnected", async () => {
    const raw = "refused: not-admitted: session not active (phase=stopping)";
    mockInvoke.mockRejectedValue(raw);
    const out = await machineConnection.send("G1 X1", { jobEpoch: 7 });
    expect(out).toEqual([raw]);
    expect(consoleTexts()).toContain(`Not sent: ${raw}`);
  });

  it("a disconnected rejection still maps to error:disconnected", async () => {
    mockInvoke.mockRejectedValue("disconnected: port closed (EOF)");
    const out = await machineConnection.send("G1 X1", { jobEpoch: 7 });
    expect(out).toEqual(["error:disconnected"]);
  });
});

describe("S1 — readback-only laser-mode flag", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    seedConnectedStore();
  });

  /** Controllable promise for one invoke. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function mockReadback(dollarResponses: string[]) {
    mockInvoke.mockImplementation(async (_cmd: string, args?: { command?: string }) =>
      args?.command === "$$"
        ? { responses: dollarResponses, drained: [] }
        : { responses: ["ok"], drained: [] }
    );
  }

  it("S1-C1: a console $X is not a settings write — the flag is unchanged", async () => {
    useStore.setState({ grblLaserMode: true });
    mockInvoke.mockResolvedValue({ responses: ["ok"], drained: [] });
    await machineConnection.send("$X");
    expect(useStore.getState().grblLaserMode).toBe(true);
    expect(consoleTexts().some((t) => t.startsWith("Settings changed"))).toBe(false);
  });

  it("isGrblSettingsWrite classifies writes and non-writes", () => {
    for (const w of ["$32=0", " $30 = 1000 ", "$N0=G21", "$N=G20", "$RST=$", "$rst=*"]) {
      expect(isGrblSettingsWrite(w)).toBe(true);
    }
    for (const n of ["$X", "$H", "$$", "$#", "$I", "$G", "$C", "$J=G91 X1 F100", "G1 X1"]) {
      expect(isGrblSettingsWrite(n)).toBe(false);
    }
  });

  it("S1-M12: send('$N0=G21') clears the flag (a startup block runs after every reset)", async () => {
    useStore.setState({ grblLaserMode: true });
    mockInvoke.mockResolvedValue({ responses: ["ok"], drained: [] });
    await machineConnection.send("$N0=G21");
    expect(useStore.getState().grblLaserMode).toBe(false);
    expect(consoleTexts()).toContain(
      "Settings changed -- laser mode must be re-verified (Enable Laser Mode, $$ in the console, or reconnect) before starting a job"
    );
  });

  it("S1-M6: enableLaserMode — ok, then a $$ readback showing $32=0, leaves the flag false", async () => {
    mockReadback(["$32=0", "ok"]);
    const result = await machineConnection.enableLaserMode();
    expect(result).toBe(false);
    expect(useStore.getState().grblLaserMode).toBe(false);
    expect(consoleTexts().some((t) => t.startsWith("$32=1 may not have been accepted"))).toBe(true);
  });

  it("S1-C2: enableLaserMode — ok and a $32=1 readback leaves the flag true", async () => {
    mockReadback(["$32=1", "ok"]);
    const result = await machineConnection.enableLaserMode();
    expect(result).toBe(true);
    expect(useStore.getState().grblLaserMode).toBe(true);
    const sent = mockInvoke.mock.calls
      .filter((c) => c[0] === "serial_send")
      .map((c) => (c[1] as { command: string }).command);
    expect(sent).toEqual(["$32=1", "$$"]);
  });

  it("S1-C4: enableLaserMode leaves machineHomed unchanged", async () => {
    useStore.setState({ machineHomed: true });
    mockReadback(["$32=1", "ok"]);
    await machineConnection.enableLaserMode();
    expect(useStore.getState().machineHomed).toBe(true);
    expect(useStore.getState().grblLaserMode).toBe(true);
  });

  it("S1-M8: a readback with no $32 line, after the flag was true, leaves it false", async () => {
    useStore.setState({ grblLaserMode: true });
    mockInvoke.mockResolvedValueOnce({ responses: ["$30=1000", "ok"], drained: [] });
    expect(await machineConnection.queryGrblSettings()).toBe(true);
    expect(useStore.getState().grblLaserMode).toBe(false);
  });

  it("S1-M13: a readback whose invoke rejects, after the flag was true, leaves it false", async () => {
    useStore.setState({ grblLaserMode: true });
    mockInvoke.mockRejectedValueOnce(new Error("boom"));
    expect(await machineConnection.queryGrblSettings()).toBe(false);
    expect(useStore.getState().grblLaserMode).toBe(false);
  });

  it("S1-M9: a stale readback (write lands mid-readback, then $32=1) leaves the flag false", async () => {
    const pending = deferred<{ responses: string[]; drained: string[] }>();
    mockInvoke.mockImplementation((_cmd: string, args?: { command?: string }) =>
      args?.command === "$$" ? pending.promise : Promise.resolve({ responses: ["ok"], drained: [] })
    );
    const readback = machineConnection.readbackGrblSettings();
    await machineConnection.send("$1=25");
    pending.resolve({ responses: ["$32=1", "ok"], drained: [] });
    await readback;
    expect(useStore.getState().grblLaserMode).toBe(false);
  });

  it("S1-M15: a console $$ overtaken by an invalidation before its invoke resolves leaves the flag false", async () => {
    const pending = deferred<{ responses: string[]; drained: string[] }>();
    mockInvoke.mockImplementation((_cmd: string, args?: { command?: string }) =>
      args?.command === "$$" ? pending.promise : Promise.resolve({ responses: ["ok"], drained: [] })
    );
    const readback = machineConnection.send("$$");
    await machineConnection.send("$32=0");
    pending.resolve({ responses: ["$32=1", "ok"], drained: [] });
    await readback;
    expect(useStore.getState().grblLaserMode).toBe(false);
  });

  it("S1-M14: a console $$ with $32=1, after an invalidation, sets the flag true", async () => {
    useStore.setState({ grblLaserMode: true });
    mockReadback(["$30=1000", "$32=1", "ok"]);
    await machineConnection.send("$32=1");
    expect(useStore.getState().grblLaserMode).toBe(false);
    await machineConnection.send("$$");
    expect(useStore.getState().grblLaserMode).toBe(true);
    // parse-only hook: exactly one $$ reached the wire
    const dollars = mockInvoke.mock.calls.filter(
      (c) => c[0] === "serial_send" && (c[1] as { command: string }).command === "$$"
    );
    expect(dollars).toHaveLength(1);
  });

  it("S1-W1: a write in flight when a $$ starts, resolving after a $32=1 readback, leaves the flag false", async () => {
    const write = deferred<{ responses: string[]; drained: string[] }>();
    const read = deferred<{ responses: string[]; drained: string[] }>();
    mockInvoke.mockImplementation((_cmd: string, args?: { command?: string }) =>
      args?.command === "$$" ? read.promise : write.promise
    );
    const w = machineConnection.send("$32=0");
    const r = machineConnection.send("$$");
    read.resolve({ responses: ["$32=1", "ok"], drained: [] });
    await r;
    write.resolve({ responses: ["ok"], drained: [] });
    await w;
    expect(useStore.getState().grblLaserMode).toBe(false);
    expect(consoleTexts().filter((t) => t.startsWith("Settings changed"))).toHaveLength(1);
  });

  it("S1-W1b: a $$ that began during enableLaserMode's write and resolves $32=1 last leaves the flag false", async () => {
    const write = deferred<{ responses: string[]; drained: string[] }>();
    const consoleRead = deferred<{ responses: string[]; drained: string[] }>();
    let dollars = 0;
    mockInvoke.mockImplementation((_cmd: string, args?: { command?: string }) => {
      if (args?.command !== "$$") return write.promise;
      dollars++;
      // First $$ is the overlapping console one; the second is enableLaserMode's own ($32=0).
      return dollars === 1
        ? consoleRead.promise
        : Promise.resolve({ responses: ["$32=0", "ok"], drained: [] });
    });
    const e = machineConnection.enableLaserMode();
    const r = machineConnection.send("$$");
    write.resolve({ responses: ["ok"], drained: [] });
    expect(await e).toBe(false);
    consoleRead.resolve({ responses: ["$32=1", "ok"], drained: [] });
    await r;
    expect(useStore.getState().grblLaserMode).toBe(false);
  });

  it("S1-W2: isGrblSettingsWrite normalizes as GRBL does before classifying", () => {
    for (const w of ["$ 32=0", "$3 2=0", "(x)$32=0", "/$32=0", "$32\t=0", "$n0=G21", "$rst=*"]) {
      expect(isGrblSettingsWrite(w)).toBe(true);
    }
    for (const n of [
      "$X",
      "$H",
      "$$",
      "$#",
      "$I",
      "$G",
      "$C",
      "$J=G91X1F100",
      "G0 X1",
      "($32=0)",
    ]) {
      expect(isGrblSettingsWrite(n)).toBe(false);
    }
  });

  it("S1-W3: a console $$ applies $32 only — workspace and verification untouched", async () => {
    useStore.setState({ workspaceWidth: 400, workspaceHeight: 300, workspaceVerified: false });
    mockReadback(["$130=999", "$131=999", "$32=1", "ok"]);
    await machineConnection.send("$$");
    const st = useStore.getState();
    expect(st.workspaceWidth).toBe(400);
    expect(st.workspaceHeight).toBe(300);
    expect(st.workspaceVerified).toBe(false);
    expect(st.grblLaserMode).toBe(true);
  });

  it("S1-W3b: enableLaserMode applies $32 only — workspace and verification untouched", async () => {
    useStore.setState({ workspaceWidth: 400, workspaceHeight: 300, workspaceVerified: false });
    mockReadback(["$130=999", "$131=999", "$32=1", "ok"]);
    expect(await machineConnection.enableLaserMode()).toBe(true);
    const st = useStore.getState();
    expect(st.workspaceWidth).toBe(400);
    expect(st.workspaceHeight).toBe(300);
    expect(st.workspaceVerified).toBe(false);
    expect(st.grblLaserMode).toBe(true);
  });

  it("S1-N1: a stale $32=1 readback prints 'stale', not 'enabled'", async () => {
    const pending = deferred<{ responses: string[]; drained: string[] }>();
    mockInvoke.mockImplementation((_cmd: string, args?: { command?: string }) =>
      args?.command === "$$" ? pending.promise : Promise.resolve({ responses: ["ok"], drained: [] })
    );
    const readback = machineConnection.send("$$");
    await machineConnection.send("$1=25");
    pending.resolve({ responses: ["$32=1", "ok"], drained: [] });
    await readback;
    expect(consoleTexts()).toContain(
      "$32=1 (laser mode readback stale -- a settings write overlapped it; re-verify)"
    );
    expect(consoleTexts()).not.toContain("$32=1 (laser mode enabled)");
  });

  it("S1-N3: disconnect clears grblLaserMode", async () => {
    useStore.setState({ grblLaserMode: true });
    mockInvoke.mockResolvedValue(undefined);
    await machineConnection.disconnect();
    expect(useStore.getState().grblLaserMode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S3 — jog frame: every refusal sends nothing; one jog in flight at a time.
// Drives the real machineConnection; asserts the actual serial_send strings.
// ---------------------------------------------------------------------------
describe("S3 — jog frame", () => {
  let statusQueue: Array<() => Promise<unknown>>;

  function jogReady(patch: Record<string, unknown> = {}) {
    seedConnectedStore();
    useStore.setState({
      jobRunning: false,
      statusStale: false,
      positionKind: "machine",
      workspaceVerified: true,
      workCoordOffset: { x: 0, y: 0 },
      workspaceWidth: 500,
      workspaceHeight: 300,
      originTop: false,
      machinePosition: { x: 100, y: 100, z: 0 },
      ...patch,
    });
  }

  function sends(): string[] {
    return mockInvoke.mock.calls
      .filter((c) => c[0] === "serial_send")
      .map((c) => (c[1] as { command: string }).command);
  }

  beforeEach(() => {
    _testResetPollFailures();
    _testResetJogAndBedState();
    resetStatusConsumer();
    snapshotSeq = 0;
    mockInvoke.mockReset();
    localStorage.clear();
    statusQueue = [];
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "serial_send") return { responses: ["ok"], drained: [] };
      if (cmd === "serial_get_status") {
        const next = statusQueue.shift();
        if (next) return next();
        return makeStatusOutcome("<Idle|MPos:100.000,100.000,0.000|FS:0,0>");
      }
      return undefined;
    });
    jogReady();
  });

  const idle = () => makeStatusOutcome("<Idle|MPos:100.000,100.000,0.000|FS:0,0>");

  it("A3-5: a relative jog sends $J=G21 G91 with the clipped distance", async () => {
    await machineConnection.jog("x", 10);
    expect(sends()).toEqual(["$J=G21 G91 X10.000 F1000"]);
  });

  it("jogTo in the envelope sends $J=G21 G90", async () => {
    await machineConnection.jogTo(10, 150);
    expect(sends()).toEqual(["$J=G21 G90 X10.000 Y150.000 F3000"]);
  });

  it("A3-6: origin-top jogTo(10, 150) (today's positive Y) is refused, nothing sent", async () => {
    jogReady({ originTop: true, machinePosition: { x: 100, y: -100, z: 0 } });
    await machineConnection.jogTo(10, 150);
    expect(sends()).toEqual([]);
    expect(consoleTexts()).toContain(JOG_REASON_TARGET);
    // Positive sibling: the mirrored target is inside the bed and goes out.
    await machineConnection.jogTo(10, -150);
    expect(sends()).toEqual(["$J=G21 G90 X10.000 Y-150.000 F3000"]);
  });

  it("A3-1 at the connection: origin-top Y=-248.913, bed 250, -1 sends -1 (never +248.913)", async () => {
    jogReady({
      originTop: true,
      workspaceHeight: 250,
      machinePosition: { x: 0, y: -248.913, z: 0 },
    });
    await machineConnection.jog("Y", -1);
    expect(sends()).toEqual(["$J=G21 G91 Y-1.000 F1000"]);
  });

  it("D1: two jogs with no poll between them make exactly one send", async () => {
    await machineConnection.jog("X", 1);
    await machineConnection.jog("X", 1);
    expect(sends()).toHaveLength(1);
    expect(consoleTexts()).toContain(JOG_REASON_PENDING);
  });

  it("D1: a poll in flight across the acknowledgement does not release the jog", async () => {
    let release!: (v: unknown) => void;
    statusQueue.push(
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    const poll = machineConnection.pollStatus(); // invoke begins before the jog
    await machineConnection.jog("X", 1); // sent and acknowledged
    release(idle());
    await poll;
    await machineConnection.jog("X", 1);
    expect(sends()).toHaveLength(1);
    // Positive half: a poll begun after the acknowledgement that reports Idle releases it.
    await machineConnection.pollStatus();
    await machineConnection.jog("X", 1);
    expect(sends()).toHaveLength(2);
  });

  it("D1: a busy poll never releases the jog, whatever the store's state says", async () => {
    await machineConnection.pollStatus(); // a real report first, so status is fresh
    expect(useStore.getState().statusStale).toBe(false);
    await machineConnection.jog("X", 1);
    statusQueue.push(async () => makeStatusOutcome("", [], { busy: true }));
    await machineConnection.pollStatus();
    expect(useStore.getState().machineState).toBe("idle");
    expect(useStore.getState().statusStale).toBe(false);
    useStore.setState({ consoleLines: [] });
    await machineConnection.jog("X", 1);
    expect(sends()).toHaveLength(1);
    expect(consoleTexts()).toEqual([JOG_REASON_PENDING]);
    await machineConnection.pollStatus(); // a real Idle report
    await machineConnection.jog("X", 1);
    expect(sends()).toHaveLength(2);
  });

  it("stale status refuses, nothing sent", async () => {
    jogReady({ statusStale: true });
    await machineConnection.jog("X", 1);
    expect(sends()).toEqual([]);
    expect(consoleTexts()).toContain(JOG_REASON_STALE);
  });

  it("an unknown position kind refuses as stale, nothing sent", async () => {
    jogReady({ statusStale: false, positionKind: null });
    await machineConnection.jog("X", 1);
    expect(sends()).toEqual([]);
    expect(consoleTexts()).toContain(JOG_REASON_STALE);
  });

  it("a work offset refuses a WPos relative jog and any absolute jog", async () => {
    jogReady({ positionKind: "work", workCoordOffset: { x: 100, y: -100 } });
    await machineConnection.jog("X", 1);
    expect(sends()).toEqual([]);
    expect(consoleTexts()).toContain(JOG_REASON_OFFSET);
    jogReady({ positionKind: "machine", workCoordOffset: { x: 100, y: -100 } });
    await machineConnection.jogTo(10, 10);
    expect(sends()).toEqual([]);
    expect(consoleTexts()).toContain(JOG_REASON_OFFSET);
    // Positive sibling: a relative jog on an MPos report is exact whatever the offset.
    await machineConnection.jog("X", 1);
    expect(sends()).toEqual(["$J=G21 G91 X1.000 F1000"]);
  });

  it("a running job refuses the jog, nothing sent", async () => {
    jogReady({ jobRunning: true });
    await machineConnection.jog("X", 1);
    expect(sends()).toEqual([]);
    expect(consoleTexts()).toContain(JOG_REASON_JOB);
  });

  it("an axis other than X/Y refuses, nothing sent", async () => {
    await machineConnection.jog("Z", 1);
    expect(sends()).toEqual([]);
    expect(consoleTexts()).toContain(JOG_REASON_AXIS);
  });

  it("S3-M32: Set Origin records WCO = MPos on ok, and jogTo then refuses", async () => {
    jogReady({ originTop: true, machinePosition: { x: 120, y: -80, z: 0 } });
    await machineConnection.setOrigin();
    expect(sends()).toEqual(["G92 X0 Y0"]);
    expect(useStore.getState().workCoordOffset).toEqual({ x: 120, y: -80 });
    await machineConnection.jogTo(10, -10);
    expect(sends()).toEqual(["G92 X0 Y0"]);
    expect(consoleTexts()).toContain(JOG_REASON_OFFSET);
  });

  it.each([
    ["a WPos report", { positionKind: "work" }],
    ["a stale status", { statusStale: true }],
    ["an unknown position kind", { positionKind: null }],
  ] as const)(
    "N5: Set Origin on %s leaves the offset unknown and jogTo refuses",
    async (_l, patch) => {
      jogReady({ machinePosition: { x: 20, y: 30, z: 0 }, workCoordOffset: { x: 0, y: 0 } });
      useStore.setState(patch);
      await machineConnection.setOrigin();
      const wco = useStore.getState().workCoordOffset;
      expect(Number.isNaN(wco.x) && Number.isNaN(wco.y)).toBe(true);
      jogReady({ workCoordOffset: wco });
      await machineConnection.jogTo(10, 10);
      expect(sends()).toEqual(["G92 X0 Y0"]);
      expect(consoleTexts()).toContain(JOG_REASON_OFFSET);
    }
  );

  it("Set Origin with no ok leaves the offset alone", async () => {
    jogReady({ machinePosition: { x: 20, y: 30, z: 0 }, workCoordOffset: { x: 5, y: -5 } });
    mockInvoke.mockImplementation(async () => ({ responses: ["error:9"], drained: [] }));
    await machineConnection.setOrigin();
    expect(useStore.getState().workCoordOffset).toEqual({ x: 5, y: -5 });
  });
});

// ---------------------------------------------------------------------------
// S3 — remembered bed (kerf-f1 b): one click per machine, not per session.
// ---------------------------------------------------------------------------
describe("S3 — remembered bed", () => {
  const KEYED = ["$3=0", "$23=0", "$32=0", "$100=80", "$101=80", "ok"];

  function mockMachine(settings: string[]) {
    mockInvoke.mockImplementation(async (cmd: string, args?: { command?: string }) => {
      if (cmd === "serial_connect") return "Grbl 1.1h ['$' for help]";
      if (cmd === "serial_send" && args?.command === "$$")
        return { responses: settings, drained: [] };
      if (cmd === "serial_send") return { responses: ["ok"], drained: [] };
      if (cmd === "serial_get_status")
        return makeStatusOutcome("<Idle|MPos:0.000,0.000,0.000|FS:0,0>");
      return undefined;
    });
  }

  async function connectWith(port: string, settings: string[]) {
    mockMachine(settings);
    const p = machineConnection.connect(port, 115200);
    await vi.advanceTimersByTimeAsync(0);
    await p;
  }

  beforeEach(() => {
    vi.useFakeTimers(); // no 250 ms poller
    _testResetPollFailures();
    _testResetJogAndBedState();
    resetStatusConsumer();
    snapshotSeq = 0;
    mockInvoke.mockReset();
    localStorage.clear();
    seedConnectedStore();
    useStore.setState({
      machineConnected: false,
      workspaceVerified: false,
      workspaceWidth: 500,
      workspaceHeight: 300,
    });
  });

  afterEach(async () => {
    await machineConnection.disconnect();
    vi.useRealTimers();
  });

  async function confirmThenReconnect(opts: {
    between?: () => Promise<void>;
    port2?: string;
    settings2?: string[];
  }) {
    await connectWith("/dev/ttyUSB0", KEYED);
    expect(useStore.getState().workspaceVerified).toBe(false);
    if (opts.between) await opts.between();
    machineConnection.confirmBedSize(300, 200);
    expect(useStore.getState().workspaceVerified).toBe(true);
    await machineConnection.disconnect();
    useStore.setState({ workspaceWidth: 500, workspaceHeight: 300, consoleLines: [] });
    await connectWith(opts.port2 ?? "/dev/ttyUSB0", opts.settings2 ?? KEYED);
  }

  it("kerf-f1 (b): a confirmed bed is re-applied on reconnect with no click", async () => {
    await confirmThenReconnect({});
    const raw = localStorage.getItem("kerf-bed-confirmations");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)[0]).toMatchObject({ w: 300, h: 200 });
    const st = useStore.getState();
    expect(st.workspaceVerified).toBe(true);
    expect([st.workspaceWidth, st.workspaceHeight]).toEqual([300, 200]);
    expect(getBedSource()).toBe("remembered");
    expect(
      consoleTexts().some((t) =>
        t.startsWith("Using the bed size you confirmed for this machine before: 300 × 200 mm")
      )
    ).toBe(true);
  });

  it("a different port does not inherit the bed", async () => {
    await confirmThenReconnect({ port2: "/dev/ttyUSB1" });
    expect(useStore.getState().workspaceVerified).toBe(false);
  });

  it("a different $100 does not inherit the bed", async () => {
    await confirmThenReconnect({ settings2: KEYED.map((l) => (l === "$100=80" ? "$100=160" : l)) });
    expect(useStore.getState().workspaceVerified).toBe(false);
  });

  it("control: a flipped $32 still inherits the bed", async () => {
    await confirmThenReconnect({ settings2: KEYED.map((l) => (l === "$32=0" ? "$32=1" : l)) });
    expect(useStore.getState().workspaceVerified).toBe(true);
  });

  it("a key-setting write before the confirm makes it session-only", async () => {
    await confirmThenReconnect({
      between: async () => {
        await machineConnection.send("$100=80");
      },
    });
    expect(useStore.getState().workspaceVerified).toBe(false);
  });

  it("control: a $32=1 write before the confirm does not forget the key", async () => {
    await confirmThenReconnect({
      between: async () => {
        await machineConnection.send("$32=1");
      },
    });
    expect(useStore.getState().workspaceVerified).toBe(true);
  });

  it("a controller-verified bed does not survive disconnect into a machine that reports none", async () => {
    await connectWith("/dev/ttyUSB0", ["$100=80", "$101=80", "$130=400", "$131=415", "ok"]);
    expect(useStore.getState().workspaceVerified).toBe(true);
    expect(getBedSource()).toBe("machine");
    await machineConnection.disconnect();
    await connectWith("/dev/ttyUSB1", ["$100=80", "$101=80", "ok"]);
    expect(useStore.getState().workspaceVerified).toBe(false);
  });

  it("with no readable settings a confirm is session-only and says so", async () => {
    await connectWith("/dev/ttyUSB0", ["error:9"]);
    machineConnection.confirmBedSize(300, 200);
    expect(getBedSource()).toBe("session");
    expect(localStorage.getItem("kerf-bed-confirmations")).toBeNull();
    expect(consoleTexts().some((t) => t.includes("confirmed for this session"))).toBe(true);
  });

  it("N6: a failed save says session-only once, never 'will remember'", async () => {
    await connectWith("/dev/ttyUSB0", KEYED);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      useStore.setState({ consoleLines: [] });
      expect(machineConnection.confirmBedSize(300, 200)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(getBedSource()).toBe("session");
    const texts = consoleTexts();
    expect(texts.some((t) => t.includes("will remember"))).toBe(false);
    expect(texts.filter((t) => t.includes("confirmed for this session"))).toHaveLength(1);
    expect(useStore.getState().workspaceVerified).toBe(true);
  });

  it.each([
    [0, 200],
    [300, -1],
    [NaN, 200],
  ])("N7: confirmBedSize(%s, %s) refuses and changes nothing", async (w, h) => {
    await connectWith("/dev/ttyUSB0", KEYED);
    expect(machineConnection.confirmBedSize(w, h)).toBe(false);
    expect(useStore.getState().workspaceVerified).toBe(false);
    expect(localStorage.getItem("kerf-bed-confirmations")).toBeNull();
    expect(consoleTexts()).toContain(
      "Bed size not set — enter a width and height in mm, both above 0."
    );
  });

  it("malformed storage reads as nothing remembered", async () => {
    localStorage.setItem("kerf-bed-confirmations", "{not json");
    await connectWith("/dev/ttyUSB0", KEYED);
    expect(useStore.getState().workspaceVerified).toBe(false);
  });

  it("S3-M28: a reconnect starts stale until a poll, and a jog refuses", async () => {
    const travel = ["$100=80", "$101=80", "$130=400", "$131=415", "ok"];
    await connectWith("/dev/ttyUSB0", travel);
    await machineConnection.pollStatus();
    expect(useStore.getState().statusStale).toBe(false);
    await machineConnection.disconnect();
    await connectWith("/dev/ttyUSB0", travel);
    const st = useStore.getState();
    expect(st.positionKind).toBe("machine"); // the init status query set it
    expect(st.statusStale).toBe(true);
    mockInvoke.mockClear();
    await machineConnection.jog("X", 1);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "serial_send")).toHaveLength(0);
    expect(consoleTexts()).toContain(JOG_REASON_STALE);
  });
});
