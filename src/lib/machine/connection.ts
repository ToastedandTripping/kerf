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

      return response;
    } catch (e) {
      const msg = String(e);
      store.addConsoleLine(`Connection failed: ${msg}`, "error");
      throw e;
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
      const responses = await invoke<string[]>("serial_send", { command });
      for (const r of responses) {
        const type = r.startsWith("error:") ? "error" as const : "received" as const;
        store.addConsoleLine(r, type);
      }
      return responses;
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

  async pollStatus(): Promise<void> {
    const store = useStore.getState();
    if (!store.machineConnected) return;
    if (jobPollingSuspended) return;

    try {
      const status = await invoke<string>("serial_get_status");
      consecutivePollFailures = 0;
      // Parse GRBL status: <Idle|MPos:0.000,0.000,0.000|FS:0,0>
      const match = status.match(/<(\w+)\|MPos:([-\d.]+),([-\d.]+),([-\d.]+)/);
      if (match) {
        const state = match[1].toLowerCase() as "idle" | "run" | "hold" | "alarm";
        store.setMachineState(state);
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

  async emergencyStop(): Promise<void> {
    const store = useStore.getState();
    store.addConsoleLine("Emergency stop initiated", "warning");

    // 1. Feed hold -- decelerates and auto-zeros laser under M4
    try { await this.sendByte(0x21); } catch { /* continue regardless */ }

    // 2. Wait for deceleration
    await new Promise((r) => setTimeout(r, 100));

    // 3. Explicit M5 -- kills laser in both M3 and M4 modes
    try { await this.send("M5"); } catch { /* continue regardless */ }

    // 4. Soft reset -- reinitialize controller
    try {
      await this.sendByte(0x18);
      await this.pollStatus();
    } catch { /* continue regardless */ }

    store.addConsoleLine("Emergency stop complete", "warning");
  },

  async queryGrblSettings(): Promise<void> {
    const store = useStore.getState();
    try {
      store.addConsoleLine("$$", "sent");
      const responses = await invoke<string[]>("serial_send", { command: "$$" });
      let accelX = 0, accelY = 0;
      let maxTravelX = 0, maxTravelY = 0;
      for (const line of responses) {
        const match = line.match(/^\$(\d+)=([\d.]+)/);
        if (match) {
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
    } catch (e) {
      store.addConsoleLine(`Failed to query GRBL settings: ${e}`, "error");
    }
  },
};
