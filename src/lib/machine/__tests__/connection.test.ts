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
  });
}

describe("connection.ts (TN3)", () => {
  beforeEach(() => {
    _testResetPollFailures();
    mockInvoke.mockReset();
    seedConnectedStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // TN3a — GRBL status-report regex parsing
  describe("pollStatus — status regex", () => {
    it("parses <Idle|MPos:1.000,2.000,0.000> and updates store", async () => {
      mockInvoke.mockResolvedValueOnce("<Idle|MPos:1.000,2.000,0.000|FS:0,0>");
      await machineConnection.pollStatus();

      const state = useStore.getState();
      expect(state.machineState).toBe("idle");
      expect(state.machinePosition).toEqual({ x: 1, y: 2, z: 0 });
    });

    it("parses <Run|MPos:5.500,3.250,0.000> and sets run state", async () => {
      mockInvoke.mockResolvedValueOnce("<Run|MPos:5.500,3.250,0.000|FS:100,0>");
      await machineConnection.pollStatus();

      const state = useStore.getState();
      expect(state.machineState).toBe("run");
      expect(state.machinePosition!.x).toBeCloseTo(5.5, 5);
      expect(state.machinePosition!.y).toBeCloseTo(3.25, 5);
    });

    it("handles non-matching status string without crashing", async () => {
      mockInvoke.mockResolvedValueOnce("ok");
      await expect(machineConnection.pollStatus()).resolves.toBeUndefined();
      // State should not change from idle
      expect(useStore.getState().machineState).toBe("idle");
    });
  });

  // TN3b — $$ settings parse
  describe("queryGrblSettings", () => {
    it("parses $30 (S-value max) and $32 (laser mode)", async () => {
      mockInvoke.mockResolvedValueOnce(["$30=1000", "$32=1"]);
      await machineConnection.queryGrblSettings();

      const state = useStore.getState();
      expect(state.grblSValueMax).toBe(1000);
      expect(state.grblLaserMode).toBe(true);
    });

    it("sets workspace size from $130/$131 only when both are > 0", async () => {
      mockInvoke.mockResolvedValueOnce(["$130=300", "$131=200"]);
      await machineConnection.queryGrblSettings();

      const state = useStore.getState();
      expect(state.workspaceWidth).toBe(300);
      expect(state.workspaceHeight).toBe(200);
    });

    it("does not set workspace if only one travel axis is present", async () => {
      const prev = useStore.getState().workspaceWidth;
      mockInvoke.mockResolvedValueOnce(["$130=400"]);
      await machineConnection.queryGrblSettings();
      // workspaceWidth must stay the same — both must be > 0 to update
      expect(useStore.getState().workspaceWidth).toBe(prev);
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
  });

  // TN3d — e-stop sequencing (fake timers for 100ms wait)
  describe("emergencyStop sequencing", () => {
    it("calls sendByte(0x21) then send(M5) then sendByte(0x18) in order", async () => {
      vi.useFakeTimers();
      const calls: string[] = [];

      // sendByte maps to invoke("serial_send_byte", ...)
      // send maps to invoke("serial_send", ...)
      mockInvoke.mockImplementation(async (cmd: string, args?: { byte?: number; command?: string }) => {
        if (cmd === "serial_send_byte") {
          calls.push(`sendByte(${args?.byte?.toString(16) ?? "?"})`);
          return;
        }
        if (cmd === "serial_send") {
          calls.push(`send(${args?.command ?? "?"})`);
          return ["ok"];
        }
        if (cmd === "serial_get_status") {
          return "<Idle|MPos:0.000,0.000,0.000|FS:0,0>";
        }
        return undefined;
      });

      const stopPromise = machineConnection.emergencyStop();
      // Advance fake timer past the 100ms deceleration wait
      await vi.runAllTimersAsync();
      await stopPromise;

      expect(calls[0]).toBe("sendByte(21)");       // feed hold (0x21)
      expect(calls).toContain("send(M5)");           // explicit laser off
      expect(calls).toContain("sendByte(18)");       // soft reset (0x18)
    });
  });
});
