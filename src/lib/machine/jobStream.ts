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

import { useStore } from "../../app/store";
import { machineConnection } from "./connection";

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
export async function streamJob(
  gcode: string,
  opts: StreamJobOptions,
): Promise<StreamJobResult> {
  // Capture action creators (stable refs) at the start; read volatile state
  // fresh via useStore.getState() inside the loop.
  const store = useStore.getState();

  const lines = gcode
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith(";"));

  let endState: StreamJobResult["endState"] = "complete";
  let portDisconnected = false;

  // -- Per-line protocol (F13/F17 -- unchanged from JobActionBar) --

  for (let i = 0; i < lines.length; i++) {
    // Wait while paused. The wait ALSO exits when jobRunning goes false
    // (STOP-while-PAUSED): emergencyStop's re-poll may write a fresh
    // non-hold state, or the state may stay "hold" if the re-poll got
    // nothing -- either way the loop must un-park.
    while (
      useStore.getState().machineState === "hold" &&
      useStore.getState().jobRunning
    ) {
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
      store.addConsoleLine(
        `${opts.label} aborted -- machine was reset mid-line`,
        "error",
      );
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
        } catch { /* port may be gone; fall through to timeout */ }
      }
      if (!reachedIdle) {
        store.addConsoleLine(
          `${opts.label} complete (Idle timeout -- head may still be moving)`,
          "warning",
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
      "error",
    );
  } else {
    // Safety volley: ensure laser is off. SKIPPED when jobRunning is already
    // false -- the user pressed STOP and emergencyStop ran its own sequence;
    // a second M5+0x18 would push another reset banner into the buffer.
    if (useStore.getState().jobRunning) {
      try { await machineConnection.send("M5"); } catch { /* port may be gone */ }
      try { await machineConnection.softReset(); } catch { /* port may be gone */ }
    }
    store.addConsoleLine(`${opts.label} aborted`, "error");
  }

  store.setJobRunning(false);
  store.setJobProgress(0);

  // Tear down the serial port on disconnect so a subsequent reconnect
  // (which now sends 0x18) doesn't fail with "port busy". Runs AFTER the
  // safety volley above so M5 has already been attempted before teardown.
  if (portDisconnected) {
    try { await machineConnection.disconnect(); } catch { /* port already gone */ }
  }

  return { endState, portDisconnected };
}
