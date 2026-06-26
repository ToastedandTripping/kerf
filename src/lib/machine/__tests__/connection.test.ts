import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must mock before importing modules that use it
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../../app/store";
import { DEFAULT_LAYERS } from "../../../app/types";
import { machineConnection, _testResetPollFailures } from "../connection";

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

describe("connection.ts (TN3)", () => {
  beforeEach(() => {
    _testResetPollFailures();
    mockInvoke.mockReset();
    localStorage.clear();
    seedConnectedStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // TN3a — GRBL status-report regex parsing
  describe("pollStatus — status regex", () => {
    it("parses <Idle|MPos:1.000,2.000,0.000> and updates store", async () => {
      mockInvoke.mockResolvedValueOnce({
        status: "<Idle|MPos:1.000,2.000,0.000|FS:0,0>",
        events: [],
      });
      await machineConnection.pollStatus();

      const state = useStore.getState();
      expect(state.machineState).toBe("idle");
      expect(state.machinePosition).toEqual({ x: 1, y: 2, z: 0 });
    });

    it("parses <Run|MPos:5.500,3.250,0.000> and sets run state", async () => {
      mockInvoke.mockResolvedValueOnce({
        status: "<Run|MPos:5.500,3.250,0.000|FS:100,0>",
        events: [],
      });
      await machineConnection.pollStatus();

      const state = useStore.getState();
      expect(state.machineState).toBe("run");
      expect(state.machinePosition!.x).toBeCloseTo(5.5, 5);
      expect(state.machinePosition!.y).toBeCloseTo(3.25, 5);
    });

    it("handles non-matching status string without crashing", async () => {
      mockInvoke.mockResolvedValueOnce({ status: "ok", events: [] });
      await expect(machineConnection.pollStatus()).resolves.toBeUndefined();
      // State should not change from idle
      expect(useStore.getState().machineState).toBe("idle");
    });

    it("surfaces junk-skip events: ALARM styled error, [MSG:] styled info", async () => {
      mockInvoke.mockResolvedValueOnce({
        status: "",
        events: ["ALARM:1", "[MSG:Reset to continue]"],
      });
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
      expect(texts.some((t) => t.includes("Max feed rate") && t.includes("8000") && t.includes("6000"))).toBe(true);
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
      mockInvoke.mockResolvedValue({ status: "", events: [] });
      await machineConnection.pollStatus();
      await machineConnection.pollStatus();
      await machineConnection.pollStatus();
      expect(useStore.getState().machineConnected).toBe(true);
      expect(useStore.getState().machineState).toBe("idle");

      // And it RESETS the counter: 2 failures + sentinel + 2 failures ≠ 3 strikes.
      mockInvoke.mockReset();
      mockInvoke.mockRejectedValueOnce(new Error("x"));
      mockInvoke.mockRejectedValueOnce(new Error("x"));
      mockInvoke.mockResolvedValueOnce({ status: "", events: [] });
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
          return { status: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>", events: [] };
        if (cmd === "list_serial_ports")
          return [{
            name: "/dev/ttyUSB0", portType: "USB", vid: null, pid: null,
            manufacturer: null, product: null,
          }];
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
      mockInvoke.mockImplementation(async (cmd: string, args?: { command?: string; byte?: number }) => {
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
          return { status: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>", events: [] };
        if (cmd === "serial_disconnect") return undefined;
        return undefined;
      });

      await machineConnection.connect("/dev/ttyUSB0", 115200);

      // No TS-side 0x18 — reset is handled in Rust before connect returns
      expect(invokeOrder.filter((o) => o === "byte(18)")).toHaveLength(0);
      // $$ must still be sent
      expect(invokeOrder).toContain("send($$)");

      await machineConnection.disconnect();
    });
  });

  // TN3d — e-stop sequencing, REWRITTEN for the F13 protocol redesign.
  // OLD order (! → M5 → 0x18) deadlocks under the read pump: M5 queues on the
  // command lock held by the in-flight line, 0x18 never sends, laser stays on.
  describe("emergencyStop sequencing (new contract)", () => {
    function mockEStop(statusOutcome: { status: string; events: string[] }) {
      const calls: string[] = [];
      mockInvoke.mockImplementation(async (cmd: string, args?: { byte?: number; command?: string }) => {
        if (cmd === "serial_send_byte") {
          calls.push(`byte(${args?.byte?.toString(16) ?? "?"})`);
          return;
        }
        if (cmd === "serial_send") {
          calls.push(`send(${args?.command ?? "?"})`);
          return { responses: ["ok"], drained: [] };
        }
        if (cmd === "serial_get_status") {
          calls.push("status");
          return statusOutcome;
        }
        return undefined;
      });
      return calls;
    }

    it("pins ! → settle → 0x18 → bounded re-poll → M5 on a non-alarm report", async () => {
      vi.useFakeTimers();
      const calls = mockEStop({ status: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>", events: [] });

      const stopPromise = machineConnection.emergencyStop();
      await vi.runAllTimersAsync();
      await stopPromise;

      expect(calls).toEqual(["byte(21)", "byte(18)", "status", "send(M5)"]);
      expect(consoleTexts()).toContain("Emergency stop complete");
    });

    it("skips M5 and surfaces honest guidance when the re-poll shows alarm", async () => {
      vi.useFakeTimers();
      const calls = mockEStop({ status: "<Alarm|MPos:0.000,0.000,0.000|FS:0,0>", events: [] });

      const stopPromise = machineConnection.emergencyStop();
      await vi.runAllTimersAsync();
      await stopPromise;

      // M5 into a post-reset alarm earns the confusing error:9 — never sent.
      expect(calls).toEqual(["byte(21)", "byte(18)", "status"]);
      expect(consoleTexts()).toContain(
        "Machine in alarm after stop -- laser off, unlock to continue",
      );
      // The alarm panel keys off machineState — refreshed from the report.
      expect(useStore.getState().machineState).toBe("alarm");
    });

    it("skips M5 when the re-poll returns the busy/none sentinel (race branch)", async () => {
      vi.useFakeTimers();
      const calls = mockEStop({ status: "", events: [] });

      const stopPromise = machineConnection.emergencyStop();
      await vi.runAllTimersAsync();
      await stopPromise;

      // No report ⇒ no M5 decision basis ⇒ skip (reset already de-energized
      // the laser); NEVER fall back to store.machineState (stale during jobs).
      expect(calls).toEqual(["byte(21)", "byte(18)", "status"]);
      expect(consoleTexts()).toContain(
        "Emergency stop complete -- machine reset, laser de-energized",
      );
    });
  });
});
