import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../app/store";

interface PortInfo {
  name: string;
  portType: string;
}

let statusPollInterval: ReturnType<typeof setInterval> | null = null;
let jobPollingSuspended = false;
let unsubscribeJobRunning: (() => void) | null = null;

export const machineConnection = {
  async listPorts(): Promise<PortInfo[]> {
    try {
      return await invoke<PortInfo[]>("list_serial_ports");
    } catch (e) {
      console.error("Failed to list ports:", e);
      return [];
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
      // Silently ignore poll errors
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
    store.setMachineState("idle");
    store.addConsoleLine("Soft reset sent", "info");
  },

  async feedHold(): Promise<void> {
    await this.sendByte(0x21); // '!'
    useStore.getState().setMachineState("hold");
  },

  async cycleResume(): Promise<void> {
    await this.sendByte(0x7e); // '~'
    useStore.getState().setMachineState("run");
  },
};
