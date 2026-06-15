import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../app/store";
import { sortPortsByPriority } from "./knownDevices";

interface PortInfo {
  name: string;
  portType: string;
  vid: number | null;
  pid: number | null;
  manufacturer: string | null;
  product: string | null;
}

/** Mirror of Rust `SendOutcome`: the command's own response lines plus
 * console-meaningful lines drained from the buffer BEFORE the command was
 * written (stale banner/ALARM debris — never attributed to this command). */
interface SendOutcome {
  responses: string[];
  drained: string[];
}

/** Mirror of Rust `StatusOutcome`: `status` is `""` when the command lock was
 * busy (a pump is mid-line) or the bounded read expired — an Ok-typed sentinel,
 * not a failure. `events` carries ALARM/[MSG:] lines skipped on the way. */
interface StatusOutcome {
  status: string;
  events: string[];
}

/** Surface an unsolicited protocol line (drained debris or status junk-skip)
 * with honest styling: an idle-time hard-limit ALARM must reach the console
 * (and thus the alarm panel's code parser) — never silently vanish. */
function surfaceUnsolicited(line: string): void {
  const store = useStore.getState();
  if (line.startsWith("ALARM")) store.addConsoleLine(line, "error");
  else if (line.startsWith("[MSG:")) store.addConsoleLine(line, "info");
  else store.addConsoleLine(line, "received");
}

const LAST_PORT_KEY = "kerf-last-port";
const LAST_BAUD_KEY = "kerf-last-baud";
let statusPollInterval: ReturnType<typeof setInterval> | null = null;
let jobPollingSuspended = false;
let unsubscribeJobRunning: (() => void) | null = null;
let consecutivePollFailures = 0;

export const machineConnection = {
  async listPorts(): Promise<PortInfo[]> {
    try {
      const ports = await invoke<PortInfo[]>("list_serial_ports");
      return sortPortsByPriority(ports);
    } catch (e) {
      console.error("Failed to list ports:", e);
      return [];
    }
  },

  getLastPort(): { name: string; baudRate: number } | null {
    try {
      const name = localStorage.getItem(LAST_PORT_KEY);
      const baud = localStorage.getItem(LAST_BAUD_KEY);
      if (name) return { name, baudRate: baud ? parseInt(baud) : 115200 };
    } catch {}
    return null;
  },

  async autoConnect(): Promise<boolean> {
    const last = this.getLastPort();
    if (!last) return false;
    const ports = await this.listPorts();
    const exists = ports.find(p => p.name === last.name);
    if (!exists) return false;
    try {
      await this.connect(last.name, last.baudRate);
      return true;
    } catch {
      return false;
    }
  },

  async connect(portName: string, baudRate: number = 115200): Promise<string> {
    const store = useStore.getState();
    try {
      const response = await invoke<string>("serial_connect", {
        portName,
        baudRate,
      });
      store.setMachineConnected(true);
      store.setMachineState("idle");
      store.addConsoleLine(response, "received");

      try {
        localStorage.setItem(LAST_PORT_KEY, portName);
        localStorage.setItem(LAST_BAUD_KEY, String(baudRate));
      } catch {}

      // Start status polling
      statusPollInterval = setInterval(() => this.pollStatus(), 250);

      // Suspend polling automatically when a job is running to prevent
      // the status '?' query from interleaving with G-code commands on
      // the shared serial port mutex, which causes garbled responses.
      unsubscribeJobRunning = useStore.subscribe((state) => {
        jobPollingSuspended = state.jobRunning;
      });

      // F14: the post-connect settings sequence lives HERE so it is structurally
      // impossible to connect without it. autoConnect used to skip it entirely:
      // sValueMax stayed 1000 on a $30=255 machine (4x overpower), no laser-mode
      // warning, default workspace. Both entry paths now produce identical output.
      const settingsVerified = await this.queryGrblSettings();
      if (settingsVerified) {
        // $32 warning ONLY on a successful $$ parse: grblLaserMode defaults
        // false, so warning off the default after a failed query would be a
        // spurious alarm.
        if (!useStore.getState().grblLaserMode) {
          store.addConsoleLine(
            "GRBL laser mode ($32) is disabled. Laser will not auto-zero at speed changes. Run $32=1 in the console to enable.",
            "warning",
          );
        }
      } else {
        store.addConsoleLine(
          "Machine settings unverified -- using defaults. Run $$ in the console to retry.",
          "warning",
        );
      }

      return response;
    } catch (e) {
      const msg = String(e);
      store.addConsoleLine(`Connection failed: ${msg}`, "error");
      throw categorizeConnectionError(msg);
    }
  },

  async disconnect(): Promise<void> {
    const store = useStore.getState();
    try {
      if (statusPollInterval) {
        clearInterval(statusPollInterval);
        statusPollInterval = null;
      }
      if (unsubscribeJobRunning) {
        unsubscribeJobRunning();
        unsubscribeJobRunning = null;
      }
      jobPollingSuspended = false;
      await invoke("serial_disconnect");
      store.setMachineConnected(false);
      store.setMachineState("disconnected");
      store.addConsoleLine("Disconnected", "info");
    } catch (e) {
      console.error("Disconnect error:", e);
    }
  },

  async send(command: string): Promise<string[]> {
    const store = useStore.getState();
    try {
      store.addConsoleLine(command, "sent");
      const outcome = await invoke<SendOutcome>("serial_send", { command });
      for (const d of outcome.drained) surfaceUnsolicited(d);
      let lastStatusReport: string | null = null;
      for (const r of outcome.responses) {
        if (r.startsWith("<")) {
          // In-pump status reports: filter from console (a 60s segment would
          // flood it at ~1/sec) — keep the most recent for the DRO below.
          lastStatusReport = r;
          continue;
        }
        // F17 Fix 2.2: ALARM lines are protocol errors, not "received" chatter.
        const type = r.startsWith("error:") || r.startsWith("ALARM")
          ? "error" as const
          : "received" as const;
        store.addConsoleLine(r, type);
      }
      // In-pump reports refresh POSITION ONLY — never machineState: a stale
      // <Hold…> consumed after resume would re-arm the job loop's pause-wait
      // with polling suspended (permanently wedged job).
      if (lastStatusReport) {
        // F19: accept both MPos and WPos for $10=0 machines
        const m = lastStatusReport.match(/[MW]Pos:([-\d.]+),([-\d.]+),([-\d.]+)/);
        if (m) {
          store.setMachinePosition({
            x: parseFloat(m[1]),
            y: parseFloat(m[2]),
            z: parseFloat(m[3]),
          });
        }
      }
      return outcome.responses;
    } catch (e) {
      const msg = String(e);
      store.addConsoleLine(`Send failed: ${msg}`, "error");
      return ["error:disconnected"];
    }
  },

  async sendByte(byte: number): Promise<void> {
    try {
      await invoke("serial_send_byte", { byte });
    } catch (e) {
      console.error("Send byte error:", e);
    }
  },

  /** One bounded status query. Returns the raw `<…>` report, or `""` when the
   * command lock was busy or the bounded read expired (Ok-typed sentinel from
   * Rust — never a thrown error, so it can never feed the 3-strike counter). */
  async getStatusReport(): Promise<string> {
    const outcome = await invoke<StatusOutcome>("serial_get_status");
    for (const e of outcome.events) surfaceUnsolicited(e);
    return outcome.status;
  },

  async pollStatus(): Promise<void> {
    const store = useStore.getState();
    // F19: guard against stacking — if disconnected, clear the interval and bail.
    // This prevents intervals leaking when a serial error triggers disconnect()
    // before the next poll fires (e.g. 3-strike path clears the interval, but
    // an unexpected disconnect path may not reach disconnect() immediately).
    if (!store.machineConnected) {
      if (statusPollInterval) {
        clearInterval(statusPollInterval);
        statusPollInterval = null;
      }
      return;
    }
    if (jobPollingSuspended) return;

    try {
      const status = await this.getStatusReport();
      // Busy/none sentinel included: the strike counter RESETS on it — the
      // command lock being held (e.g. a 30s $H pump) proves the port path is
      // alive; a genuinely dead port surfaces as a write failure (rejection).
      consecutivePollFailures = 0;
      if (!status) return;
      // F19: Parse GRBL status — handles MPos and WPos ($10=0 machines), and
      // Hold:n / Door:n substates. Map substates to their parent for the UI.
      const match = status.match(/<(\w+(?::\d+)?)\|[MW]Pos:([-\d.]+),([-\d.]+),([-\d.]+)/);
      if (match) {
        const rawState = match[1].toLowerCase();
        // Map Hold:n → "hold", Door:n → "door" (any substate collapses to parent)
        const baseState = rawState.split(":")[0] as "idle" | "run" | "hold" | "alarm" | "door";
        store.setMachineState(baseState);
        store.setMachinePosition({
          x: parseFloat(match[2]),
          y: parseFloat(match[3]),
          z: parseFloat(match[4]),
        });
      }
    } catch {
      consecutivePollFailures++;
      if (consecutivePollFailures >= 3) {
        store.setMachineConnected(false);
        store.setMachineState("disconnected");
        store.addConsoleLine("Connection lost — check USB cable", "error");
        if (store.jobRunning) {
          store.setJobRunning(false);
          store.addConsoleLine("Job aborted due to disconnect", "error");
        }
        this.disconnect();
        consecutivePollFailures = 0;
      }
    }
  },

  async jog(axis: string, distance: number, feedRate: number = 1000): Promise<void> {
    await this.send(`$J=G91 ${axis}${distance} F${feedRate}`);
  },

  async jogTo(x: number, y: number, feedRate: number = 3000): Promise<void> {
    await this.send(`$J=G90 X${x.toFixed(3)} Y${y.toFixed(3)} F${feedRate}`);
  },

  async home(): Promise<void> {
    await this.send("$H");
  },

  async setOrigin(): Promise<void> {
    await this.send("G92 X0 Y0");
  },

  async softReset(): Promise<void> {
    await this.sendByte(0x18); // Ctrl+X
    const store = useStore.getState();
    store.addConsoleLine("Soft reset sent", "info");
    // Poll actual state instead of assuming idle
    await this.pollStatus();
  },

  async feedHold(): Promise<void> {
    await this.sendByte(0x21); // '!'
    useStore.getState().setMachineState("hold");
  },

  async cycleResume(): Promise<void> {
    await this.sendByte(0x7e); // '~'
    useStore.getState().setMachineState("run");
  },

  /**
   * Emergency stop — F13 resequenced (safety-critical).
   *
   * Sequence: `!` → ~100ms settle → `0x18` → bounded re-poll → conditional M5.
   * The OLD order (`!` → M5 → `0x18`) deadlocks under the read pump: feed hold
   * freezes the planner, the in-flight line's `ok` never arrives, M5 queues on
   * the command lock forever, `0x18` never sends — laser stays on under
   * M3/$32=0. Both bytes go via the REALTIME handle so they reach the wire
   * while a pump holds the command lock; the reset banner terminates the pump.
   *
   * M5 fires ONLY when the re-poll RETURNED an actual non-alarm `<…>` report.
   * Busy sentinel, no report, or alarm ⇒ skip it: the reset already
   * de-energized the laser at firmware level, and M5 into a post-reset alarm
   * earns a confusing error:9. Never key this off store.machineState — it is
   * stale ("idle") during jobs because polling is suspended.
   */
  async emergencyStop(): Promise<void> {
    const store = useStore.getState();
    store.addConsoleLine("Emergency stop initiated", "warning");

    // F16: track whether the stop bytes were actually sent. If both writes fail,
    // the port is dead — set alarm state and report honestly instead of logging
    // "Emergency stop complete" when nothing reached the machine.
    let feedHoldSent = false;
    let resetSent = false;

    // 1. Feed hold -- bring motion to a controlled stop first (resetting during
    //    active motion makes ALARM:3 + lost position the routine outcome).
    try { await invoke("serial_send_byte", { byte: 0x21 }); feedHoldSent = true; } catch { /* continue regardless */ }

    // 2. Deceleration settle.
    await new Promise((r) => setTimeout(r, 100));

    // 3. Soft reset -- de-energizes the laser at firmware level and aborts any
    //    in-flight pump (banner terminal frees the command lock).
    try { await invoke("serial_send_byte", { byte: 0x18 }); resetSent = true; } catch { /* continue regardless */ }

    // F16: if neither byte was delivered, the port is gone — go to alarm state.
    if (!feedHoldSent && !resetSent) {
      store.setMachineState("alarm");
      store.addConsoleLine(
        "E-stop send failed — port may be disconnected. Machine state unknown — treat as unsafe.",
        "error",
      );
      return;
    }

    // 4. Let GRBL's reboot window pass (it drops RX bytes while resetting),
    //    then re-poll. Bounded in Rust -- can never hang mid-emergency.
    await new Promise((r) => setTimeout(r, 200));
    let report = "";
    try { report = await this.getStatusReport(); } catch { /* port may be gone */ }

    // Refresh DRO/state from the fresh post-reset report, if any.
    // F19: accept both MPos and WPos to support $10=0 machines.
    const match = report.match(/<(\w+(?::\d+)?)\|[MW]Pos:([-\d.]+),([-\d.]+),([-\d.]+)/);
    if (match) {
      const rawState = match[1].toLowerCase();
      store.setMachineState(rawState.split(":")[0] as "idle" | "run" | "hold" | "alarm" | "door");
      store.setMachinePosition({
        x: parseFloat(match[2]),
        y: parseFloat(match[3]),
        z: parseFloat(match[4]),
      });
    }

    // 5. Conditional M5, keyed ONLY off the returned report.
    const reportedState = report.match(/^<(\w+)/)?.[1]?.toLowerCase();
    if (reportedState && reportedState !== "alarm") {
      try { await this.send("M5"); } catch { /* port may be gone */ }
      store.addConsoleLine("Emergency stop complete", "warning");
    } else if (reportedState === "alarm") {
      // Expected aftermath of a mid-motion reset; the alarm panel takes over.
      store.addConsoleLine(
        "Machine in alarm after stop -- laser off, unlock to continue",
        "warning",
      );
    } else {
      store.addConsoleLine(
        "Emergency stop complete -- machine reset, laser de-energized",
        "warning",
      );
    }
  },

  /** Query $$ and apply $30/$32/$120-131. Returns true when the response
   * parsed as settings (at least one `$N=V` line) — the $32 warning and the
   * "unverified" fallback in connect() key off this. */
  async queryGrblSettings(): Promise<boolean> {
    const store = useStore.getState();
    try {
      store.addConsoleLine("$$", "sent");
      const outcome = await invoke<SendOutcome>("serial_send", { command: "$$" });
      for (const d of outcome.drained) surfaceUnsolicited(d);
      let parsedAny = false;
      let accelX = 0, accelY = 0;
      let maxTravelX = 0, maxTravelY = 0;
      for (const line of outcome.responses) {
        const match = line.match(/^\$(\d+)=([\d.]+)/);
        if (match) {
          parsedAny = true;
          const key = parseInt(match[1], 10);
          const value = parseFloat(match[2]);
          if (key === 30) {
            store.setGrblSValueMax(value);
            store.addConsoleLine(`$30=${value} (S-value max)`, "info");
          } else if (key === 32) {
            store.setGrblLaserMode(value === 1);
            store.addConsoleLine(`$32=${value} (laser mode ${value === 1 ? "enabled" : "disabled"})`, "info");
          } else if (key === 120) {
            accelX = value;
          } else if (key === 121) {
            accelY = value;
          } else if (key === 130) {
            maxTravelX = value;
          } else if (key === 131) {
            maxTravelY = value;
          }
        }
      }
      if (accelX > 0 || accelY > 0) {
        store.setGrblAccel(accelX || 500, accelY || 500);
        store.addConsoleLine(`Acceleration: X=${accelX} Y=${accelY} mm/s²`, "info");
      }
      if (maxTravelX > 0 && maxTravelY > 0) {
        store.setWorkspaceSize(maxTravelX, maxTravelY);
        store.addConsoleLine(`Workspace set to ${maxTravelX}×${maxTravelY}mm from machine settings`, "info");
      }
      return parsedAny;
    } catch (e) {
      store.addConsoleLine(`Failed to query GRBL settings: ${e}`, "error");
      return false;
    }
  },
};

export interface ConnectionError {
  message: string;
  suggestions: string[];
}

function categorizeConnectionError(raw: string): ConnectionError {
  const lower = raw.toLowerCase();

  if (lower.includes("permission") || lower.includes("access denied") || lower.includes("eacces")) {
    return {
      message: "Permission denied on serial port",
      suggestions: [
        "Close other programs using the port (e.g. Arduino IDE)",
        "Check your user has permission to access serial devices",
        "Try unplugging and reconnecting the USB cable",
      ],
    };
  }

  if (lower.includes("not found") || lower.includes("no such file") || lower.includes("does not exist")) {
    return {
      message: "Serial port not found",
      suggestions: [
        "Verify USB cable is connected",
        "Try a different USB port",
        "Click Refresh to rescan available ports",
        "Check if the device driver is installed",
      ],
    };
  }

  if (lower.includes("busy") || lower.includes("in use") || lower.includes("resource")) {
    return {
      message: "Port is busy or in use",
      suggestions: [
        "Close other programs using this port (Arduino IDE, PuTTY, etc.)",
        "Unplug and reconnect the USB cable",
        "Try restarting the application",
      ],
    };
  }

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      message: "Connection timed out",
      suggestions: [
        "Verify baud rate is 115200 (standard for GRBL)",
        "Check that the controller is powered on",
        "Try unplugging and reconnecting the USB cable",
      ],
    };
  }

  // Generic fallback
  return {
    message: `Connection failed: ${raw}`,
    suggestions: [
      "Check COM port selection",
      "Verify baud rate (115200 for GRBL)",
      "Confirm USB cable is connected",
      "Try unplugging and reconnecting",
    ],
  };
}

// Test-only reset for the module-level failure counter.
// Not imported anywhere in production code.
export function _testResetPollFailures(): void {
  consecutivePollFailures = 0;
}
