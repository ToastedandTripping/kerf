import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must mock before importing modules that use it
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../../app/store";
import { DEFAULT_LAYERS } from "../../../app/types";
import { machineConnection, _testResetPollFailures } from "../connection";
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
      mockInvoke.mockResolvedValueOnce(
        makeStatusOutcome("<Idle|MPos:1.000,2.000,0.000|FS:0,0>")
      );
      await machineConnection.pollStatus();

      const state = useStore.getState();
      expect(state.machineState).toBe("idle");
      expect(state.machinePosition).toEqual({ x: 1, y: 2, z: 0 });
    });

    it("parses <Run|MPos:5.500,3.250,0.000> and sets run state", async () => {
      mockInvoke.mockResolvedValueOnce(
        makeStatusOutcome("<Run|MPos:5.500,3.250,0.000|FS:100,0>")
      );
      await machineConnection.pollStatus();

      const state = useStore.getState();
      expect(state.machineState).toBe("run");
      expect(state.machinePosition!.x).toBeCloseTo(5.5, 5);
      expect(state.machinePosition!.y).toBeCloseTo(3.25, 5);
    });

    it("handles NoResponse without crashing", async () => {
      mockInvoke.mockResolvedValueOnce(
        makeStatusOutcome("", [], { noResponse: true })
      );
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
      mockInvoke.mockResolvedValue(
        makeStatusOutcome("", [], { busy: true })
      );
      await machineConnection.pollStatus();
      await machineConnection.pollStatus();
      await machineConnection.pollStatus();
      expect(useStore.getState().machineConnected).toBe(true);
      expect(useStore.getState().machineState).toBe("idle");

      // And it RESETS the counter: 2 failures + sentinel + 2 failures ≠ 3 strikes.
      mockInvoke.mockReset();
      mockInvoke.mockRejectedValueOnce(new Error("x"));
      mockInvoke.mockRejectedValueOnce(new Error("x"));
      mockInvoke.mockResolvedValueOnce(
        makeStatusOutcome("", [], { busy: true })
      );
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
        inFlightWrite: false,
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
      expect(
        consoleTexts().some((t) => t.includes("Beam state unqualified"))
      ).toBe(true);
    });

    it("sends NO bytes from TS — no 0x21, no 0x18, no M5", async () => {
      const calls: string[] = [];
      mockInvoke.mockImplementation(
        async (cmd: string) => {
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
        }
      );

      await machineConnection.emergencyStop();

      // Only serial_stop — no serial_send_byte, no serial_send, no serial_get_status
      expect(calls).toEqual(["serial_stop"]);
    });
  });

  // ---- A2: disconnect beam-on safety ----
  describe("disconnect — A2 beam-on safety", () => {
    it("fires emergencyStop (serial_stop) before teardown when a job is running", async () => {
      const calls: string[] = [];
      mockInvoke.mockImplementation(
        async (cmd: string) => {
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
        }
      );

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
