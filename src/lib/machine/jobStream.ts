/**
 * jobStream.ts — shared streaming loop for all G-code sending paths.
 *
 * Extracted from JobActionBar's START handler (the reviewed, tested main loop).
 * The per-line abort protocol is preserved UNCHANGED:
 *   send line -> wait for ok/error/ALARM/banner -> classify -> continue/abort
 *
 * Safety contract:
 * - Empty response or reset banner = the line was ABORTED, not acked
 * - ALARM = controller locked, laser already de-energized by firmware
 * - Safety volley (M5 + softReset) on abort ONLY when jobRunning is still
 *   true -- STOP's emergencyStop owns its own sequence
 * - jobRunning and jobProgress cleaned up on every exit path
 */

import { invoke, Channel } from "@tauri-apps/api/core";
import { useStore } from "../../app/store";
import { machineConnection } from "./connection";

/**
 * pauseJob — A1 fix: feed hold + spindle-stop-override (realtime, ack-less).
 *
 * The old handlePauseResume sent a line-based M5 on pause. During Hold state,
 * GRBL queues line commands but doesn't execute them — the M5 never fires, the
 * beam stays on (F13 ack-in-Hold hazard). This replacement uses only realtime
 * bytes:
 *   1. `!` (0x21) — feed hold, brings motion to a controlled stop
 *   2. Poll until the machine reports Hold:0 (fully decelerated), max 3s
 *   3. `0x9E` — spindle-stop-override (realtime, ack-less, Hold:0-only)
 *
 * The poll replaces the original fixed 100ms delay. GRBL ignores 0x9E
 * during Hold:1 (still decelerating), so a fixed timer that's shorter
 * than the actual deceleration time silently drops the spindle-stop and
 * leaves the laser on. Hardware-confirmed 2026-08-29.
 *
 * If the 0x9E byte write throws, a loud console warning surfaces so the
 * operator knows the beam may still be on. Never degrades silently.
 */
export async function pauseJob(): Promise<void> {
  await machineConnection.feedHold();

  const HOLD_POLL_MS = 50;
  const HOLD_TIMEOUT_MS = 3000;
  const deadline = Date.now() + HOLD_TIMEOUT_MS;
  let reachedHold0 = false;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, HOLD_POLL_MS));
    try {
      const report = await machineConnection.getStatusReport();
      if (report && /^<Hold:0/i.test(report)) {
        reachedHold0 = true;
        break;
      }
      if (report && /^<Hold\|/i.test(report)) {
        reachedHold0 = true;
        break;
      }
    } catch {
      break;
    }
  }

  if (!reachedHold0) {
    useStore
      .getState()
      .addConsoleLine(
        "WARNING: Machine did not reach full Hold within 3s — spindle stop may not take effect",
        "warning"
      );
  }

  try {
    await machineConnection.sendByte(0x9e);
  } catch (e) {
    console.warn("Spindle stop override (0x9E) failed — beam may still be on during pause", e);
    useStore
      .getState()
      .addConsoleLine(
        "WARNING: Spindle stop override (0x9E) failed — beam may still be on during pause",
        "error"
      );
  }
}

/**
 * resumeJob — A1 fix: cycle resume only, no M3 re-enable.
 *
 * The old handlePauseResume sent a line-based M3 before resume (to re-enable
 * the laser for $32=0 machines). This is the same F13 hazard — a line command
 * sent into Hold. The spindle-stop-override (0x9E) is a toggle: GRBL restores
 * spindle state on resume automatically. The only realtime byte needed is `~`.
 */
export async function resumeJob(): Promise<void> {
  await machineConnection.cycleResume();
}

export interface StreamJobOptions {
  /** Display label for console messages (e.g. "Job", "Frame", "Material test").
   *  Used directly in messages -- capitalize accordingly. */
  label: string;

  /** When true, wait up to 30s for machine to reach Idle after the last line
   *  acks (head is still decelerating at last-ack time). START-only. */
  waitForIdle?: boolean;
}

export interface StreamJobResult {
  endState: "complete" | "cancelled" | "aborted" | "alarm" | "error";
  portDisconnected: boolean;
}

/**
 * Stream G-code lines to the machine one at a time with full abort protocol.
 *
 * The caller MUST:
 * - Set jobRunning=true and jobProgress=0 before calling
 * - Handle any caller-specific post-stream work (e.g. status message)
 *
 * This function WILL:
 * - Set jobRunning=false and jobProgress=0 on every exit path
 * - Fire the M5+softReset safety volley on error/abort (when jobRunning is
 *   still true -- STOP's emergencyStop path is not duplicated)
 * - Tear down the serial port on disconnect detection
 */
/**
 * Get the current streaming mode from localStorage. Defaults to "perLine"
 * per DECISIONS.md pin: `streamingMode` defaults to `perLine`.
 */
export function getStreamingMode(): "perLine" | "buffered" {
  try {
    const mode = localStorage.getItem("streamingMode");
    if (mode === "buffered") return "buffered";
  } catch {
    // localStorage unavailable — non-critical, use default
  }
  return "perLine";
}

/** Mirror of Rust `JobEvent` (serde-tagged). */
interface JobEvent {
  type: "progress" | "console" | "status" | "finished";
  lineIndex?: number;
  total?: number;
  text?: string;
  report?: string;
  outcome?: string;
}

/**
 * Stream a G-code job using the buffered (character-counting) pump.
 *
 * The Rust side handles the $32=1 gate, RX budget accounting, and the full
 * send/read loop. This function creates a Tauri Channel to receive progress
 * events and updates the store accordingly.
 */
async function streamJobBuffered(gcode: string, opts: StreamJobOptions): Promise<StreamJobResult> {
  const store = useStore.getState();

  const channel = new Channel<JobEvent>();

  channel.onmessage = (event: JobEvent) => {
    const s = useStore.getState();
    switch (event.type) {
      case "progress":
        if (event.total && event.total > 0) {
          s.setJobProgress((event.lineIndex! + 1) / event.total);
        }
        break;
      case "console":
        if (event.text) {
          const type =
            event.text.startsWith("error:") || event.text.startsWith("ALARM")
              ? ("error" as const)
              : ("info" as const);
          s.addConsoleLine(event.text, type);
        }
        break;
      case "status":
        if (event.report) {
          // Update DRO position from status report (same as connection.ts)
          const m = event.report.match(/[MW]Pos:([-\d.]+),([-\d.]+),([-\d.]+)/);
          if (m) {
            s.setMachinePosition({
              x: parseFloat(m[1]),
              y: parseFloat(m[2]),
              z: parseFloat(m[3]),
            });
          }
        }
        break;
      case "finished":
        // Handled via the invoke return value below
        break;
    }
  };

  let endState: StreamJobResult["endState"] = "complete";
  let portDisconnected = false;

  try {
    const outcome = await invoke<string>("serial_stream_job", { gcode, channel });

    if (outcome.startsWith("complete")) {
      endState = "complete";
      if (opts.waitForIdle) {
        const IDLE_TIMEOUT_MS = 30000;
        const IDLE_POLL_MS = 200;
        const idleDeadline = Date.now() + IDLE_TIMEOUT_MS;
        let reachedIdle = false;
        while (Date.now() < idleDeadline) {
          await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
          try {
            const report = await machineConnection.getStatusReport();
            if (report && report.match(/^<Idle/i)) {
              reachedIdle = true;
              break;
            }
          } catch {
            break;
          }
        }
        if (!reachedIdle) {
          store.addConsoleLine(
            `${opts.label} complete (Idle timeout -- head may still be moving)`,
            "warning"
          );
        } else {
          store.addConsoleLine(`${opts.label} complete`, "info");
        }
      } else {
        store.addConsoleLine(`${opts.label} complete`, "info");
      }
    } else if (outcome.startsWith("cancelled")) {
      endState = "cancelled";
      store.addConsoleLine(`${opts.label} cancelled`, "info");
    } else if (outcome.startsWith("aborted")) {
      endState = "aborted";
      store.addConsoleLine(`${opts.label} aborted -- machine was reset`, "error");
    } else if (outcome.startsWith("alarm")) {
      endState = "alarm";
      store.addConsoleLine(
        `${opts.label} stopped -- machine alarm (laser already off; unlock to continue)`,
        "error"
      );
    } else if (outcome.startsWith("error")) {
      endState = "error";
      store.addConsoleLine(`${opts.label} stopped: ${outcome}`, "error");
    } else if (outcome.startsWith("disconnected")) {
      endState = "error";
      portDisconnected = true;
      store.addConsoleLine(`${opts.label} stopped: ${outcome}`, "error");
      useStore.getState().setMachineConnected(false);
      useStore.getState().setMachineState("disconnected");
    }
  } catch (e) {
    endState = "error";
    const msg = String(e);
    store.addConsoleLine(`${opts.label} failed: ${msg}`, "error");
    if (msg.includes("disconnected") || msg.includes("Not connected")) {
      portDisconnected = true;
      useStore.getState().setMachineConnected(false);
      useStore.getState().setMachineState("disconnected");
    }
  }

  // Safety volley: ensure laser is off on non-complete, non-alarm outcomes.
  // ALARM excluded: GRBL is already locked and the volley earns error:9.
  // SKIPPED when jobRunning is already false -- the user pressed STOP and
  // emergencyStop ran its own sequence; a second M5+0x18 would be redundant.
  if (endState !== "complete" && endState !== "alarm" && useStore.getState().jobRunning) {
    try {
      await machineConnection.send("M5");
    } catch {
      /* port may be gone */
    }
    try {
      await machineConnection.softReset();
    } catch {
      /* port may be gone */
    }
  }

  store.setJobRunning(false);
  store.setJobProgress(0);

  if (portDisconnected) {
    try {
      await machineConnection.disconnect();
    } catch {
      /* port already gone */
    }
  }

  return { endState, portDisconnected };
}

export async function streamJob(gcode: string, opts: StreamJobOptions): Promise<StreamJobResult> {
  // Mode dispatch: "buffered" routes to the Rust character-counting pump;
  // "perLine" (default) uses the existing TS per-line loop.
  const mode = getStreamingMode();
  if (mode === "buffered") {
    return streamJobBuffered(gcode, opts);
  }

  // -- Per-line path (unchanged) --

  // Capture action creators (stable refs) at the start; read volatile state
  // fresh via useStore.getState() inside the loop.
  const store = useStore.getState();

  const lines = gcode.split("\n").filter((l) => l.trim() && !l.startsWith(";"));

  let endState: StreamJobResult["endState"] = "complete";
  let portDisconnected = false;

  // -- Per-line protocol (F13/F17 -- unchanged from JobActionBar) --

  for (let i = 0; i < lines.length; i++) {
    // Wait while paused. The wait ALSO exits when jobRunning goes false
    // (STOP-while-PAUSED): emergencyStop's re-poll may write a fresh
    // non-hold state, or the state may stay "hold" if the re-poll got
    // nothing -- either way the loop must un-park.
    while (useStore.getState().machineState === "hold" && useStore.getState().jobRunning) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // Cancel check -- sits AFTER the hold-wait so every exit flows through
    // the wait before any send; a stray post-reset line can never fire.
    if (!useStore.getState().jobRunning) {
      store.addConsoleLine(`${opts.label} cancelled`, "error");
      endState = "cancelled";
      break;
    }

    const responses = await machineConnection.send(lines[i]);
    store.setJobProgress((i + 1) / lines.length);

    // F13/F17: empty response or reset banner = the line was ABORTED, not
    // acked; advancing would desync ack attribution.
    if (responses.length === 0 || responses.some((r) => r.startsWith("Grbl "))) {
      store.addConsoleLine(`${opts.label} aborted -- machine was reset mid-line`, "error");
      endState = "aborted";
      break;
    }

    // ALARM = controller locked, laser already de-energized by firmware.
    // NO M5+reset volley: GRBL is locked; the volley earns error:9.
    if (responses.some((r) => r.startsWith("ALARM"))) {
      endState = "alarm";
      break;
    }

    // error:N -- stop with safety volley (handled in post-loop).
    if (responses.some((r) => r.startsWith("error:"))) {
      store.addConsoleLine(`${opts.label} stopped due to error`, "error");
      endState = "error";
      // Detect disconnect
      if (responses.some((r) => r === "error:disconnected")) {
        useStore.getState().setMachineConnected(false);
        useStore.getState().setMachineState("disconnected");
        portDisconnected = true;
      }
      break;
    }
  }

  // -- Post-loop handling --

  if (endState === "complete") {
    if (opts.waitForIdle) {
      // F19: after last ack, wait for machine to actually reach Idle before
      // re-enabling START -- head is still decelerating at last-ack time.
      const IDLE_TIMEOUT_MS = 30000;
      const IDLE_POLL_MS = 200;
      const idleDeadline = Date.now() + IDLE_TIMEOUT_MS;
      let reachedIdle = false;
      while (Date.now() < idleDeadline) {
        await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
        try {
          const report = await machineConnection.getStatusReport();
          if (report && report.match(/^<Idle/i)) {
            reachedIdle = true;
            break;
          }
        } catch {
          /* port may be gone; fall through to timeout */
        }
      }
      if (!reachedIdle) {
        store.addConsoleLine(
          `${opts.label} complete (Idle timeout -- head may still be moving)`,
          "warning"
        );
      } else {
        store.addConsoleLine(`${opts.label} complete`, "info");
      }
    } else {
      store.addConsoleLine(`${opts.label} complete`, "info");
    }
  } else if (endState === "alarm") {
    store.addConsoleLine(
      `${opts.label} stopped -- machine alarm (laser already off; unlock to continue)`,
      "error"
    );
  } else {
    // Safety volley: ensure laser is off. SKIPPED when jobRunning is already
    // false -- the user pressed STOP and emergencyStop ran its own sequence;
    // a second M5+0x18 would push another reset banner into the buffer.
    if (useStore.getState().jobRunning) {
      try {
        await machineConnection.send("M5");
      } catch {
        /* port may be gone */
      }
      try {
        await machineConnection.softReset();
      } catch {
        /* port may be gone */
      }
    }
    store.addConsoleLine(`${opts.label} aborted`, "error");
  }

  store.setJobRunning(false);
  store.setJobProgress(0);

  // Tear down the serial port on disconnect so a subsequent reconnect
  // (which now sends 0x18) doesn't fail with "port busy". Runs AFTER the
  // safety volley above so M5 has already been attempted before teardown.
  if (portDisconnected) {
    try {
      await machineConnection.disconnect();
    } catch {
      /* port already gone */
    }
  }

  return { endState, portDisconnected };
}
