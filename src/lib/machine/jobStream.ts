/**
 * jobStream.ts — shared streaming loop for all G-code sending paths.
 *
 * Extracted from JobActionBar's START handler (the reviewed, tested main loop).
 * The per-line abort protocol is preserved UNCHANGED:
 *   send line -> wait for ok/error/ALARM/banner -> classify -> continue/abort
 *
 * Safety contract:
 * - Every job line carries the owning session's epoch (`jobEpoch`); the
 *   backend admission fence refuses a line from a job that STOP has closed
 *   (RF-15). A refusal is never "complete", never read as a dead port, and
 *   never causes TS to send anything (no stop, no M5, no line).
 * - Empty response or reset banner = the line was ABORTED, not acked
 * - ALARM = controller locked, laser already de-energized by firmware
 * - On error/abort, ONE shared stop (`emergencyStop` → native `serial_stop`:
 *   0x18 immediately, no feed hold, no M5, no ack wait, per 2026-09-20) fires
 *   only when jobRunning is still true -- STOP already ran otherwise
 * - The owning JobSession releases jobRunning/jobProgress on every exit path
 *   ("unknown" deliberately retains jobRunning so STOP stays live)
 */

import { invoke, Channel } from "@tauri-apps/api/core";
import { useStore } from "../../app/store";
import { machineConnection, PERMIT_REFUSED_PREFIX } from "./connection";
import type { JobSession } from "./jobSession";
import {
  bufferedJobLines,
  endJobEvidence,
  noteSpindleSample,
  setLastSentLine,
  startJobEvidence,
} from "./lastSentLine";

/**
 * pauseJob — becomes STOP per DECISIONS.md rulings.
 *
 * "Pause is hold-only, and becomes stop wherever a dark hold has not been
 * observed on hardware." + "Hardware evidence for this program is status-only;
 * optical shutdown cannot be qualified." = hold cannot be qualified = pause is
 * stop.
 *
 * The old feed-hold + Hold:0 poll is deleted. Its Rust side
 * (serial_get_status's try_lock) returned the empty sentinel for as long as
 * the pump held the command lock — it could never succeed during a job. It
 * always timed out at 3s and would have fired 0x9E (the pause re-arm defect).
 */
export async function pauseJob(): Promise<void> {
  const store = useStore.getState();
  store.addConsoleLine(
    "Paused jobs cannot resume until a dark hold is qualified on hardware; the job has been stopped.",
    "warning"
  );

  // Route through the shared stop — same path as STOP button and error abort.
  store.setJobRunning(false);
  await machineConnection.emergencyStop();
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

  /** B3: job session that owns this stream. REQUIRED (RF-15): its `jobId` is
   *  the epoch every job line carries, so an unfenced job is not type-legal.
   *  The session gates progress/cleanup and handles draining. Callbacks that
   *  don't match the session's jobId are discarded (cross-job safety). */
  session: JobSession;
}

export interface StreamJobResult {
  endState: "complete" | "cancelled" | "aborted" | "alarm" | "error" | "unknown";
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
 * - Release the session on every exit path (jobRunning/jobProgress cleared
 *   except for "unknown", which keeps STOP live)
 * - Route error/abort through the one shared stop (`emergencyStop` →
 *   `serial_stop`, 0x18 only) when jobRunning is still true -- STOP's own
 *   path is not duplicated; a backend refusal never triggers it
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

/**
 * RF-15 refusal contract. The backend's only refusal is
 * `refused: not-admitted: …` (nothing was written). Maps it to `cancelled` and
 * logs the operator message. Any other `refused:` string is unknown to the
 * contract and takes the same `cancelled` path, never `complete` or
 * `disconnected`. The caller must skip every post-loop stop and console line
 * when this ran.
 */
function handleRefusal(reason: string, label: string): StreamJobResult["endState"] {
  const store = useStore.getState();
  const detailMatch = reason.match(/^refused: not-admitted: (.*)$/);
  const detail = detailMatch ? detailMatch[1] : reason;
  store.addConsoleLine(
    `${label} stopped: the controller is no longer accepting this job's lines (${detail}). Nothing further was sent.`,
    "warning"
  );
  return "cancelled";
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
  const session = opts.session;
  const sentLines = bufferedJobLines(gcode);

  const channel = new Channel<JobEvent>();

  channel.onmessage = (event: JobEvent) => {
    // B3: discard callbacks that don't belong to this session.
    if (session.cancelled) return;
    const s = useStore.getState();
    switch (event.type) {
      case "progress":
        setLastSentLine(event.lineIndex!, sentLines[event.lineIndex!] ?? "", true);
        if (event.total && event.total > 0) {
          // B3: progress yields a finite sent-lines percentage.
          // 100% does NOT release ownership — draining does that.
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
          noteSpindleSample(event.report);
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

  // RF-8: default "unknown", never "complete" -- an outcome string no branch
  // recognises must not report a stopped job as finished.
  let endState: StreamJobResult["endState"] = "unknown";
  let portDisconnected = false;
  let refused = false;

  try {
    const outcome = await invoke<string>("serial_stream_job", {
      gcode,
      jobEpoch: session.jobId,
      channel,
    });

    if (outcome.startsWith(PERMIT_REFUSED_PREFIX)) {
      refused = true;
      endState = handleRefusal(outcome, opts.label);
    } else if (outcome.startsWith("complete")) {
      endState = "complete";
      // B3: drain through the session (idle-wait and timeout-to-unknown).
      const drainResult = await session.drain(!!opts.waitForIdle);
      if (drainResult === "unknown") {
        // 30s drain timeout: "unknown" state. Session retains protection
        // (jobRunning stays true, keep-awake held). Razor W1: must NOT
        // map to "complete" — that releases protection prematurely.
        endState = "unknown";
      } else if (drainResult === "alarm") {
        endState = "alarm";
        store.addConsoleLine(
          `${opts.label} stopped -- machine alarm (laser already off; unlock to continue)`,
          "error"
        );
      } else if (drainResult === "cancelled") {
        endState = "cancelled";
        store.addConsoleLine(`${opts.label} cancelled`, "info");
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
    } else {
      // RF-8: explicit final branch; endState stays "unknown".
      store.addConsoleLine(
        `${opts.label} ended with an unrecognised result (${outcome}); controller state unknown`,
        "warning"
      );
    }
  } catch (e) {
    const msg = String(e);
    if (msg.startsWith(PERMIT_REFUSED_PREFIX)) {
      // Checked BEFORE the disconnected test: the refusal text can contain
      // "phase=disconnected", which is not a dead port.
      refused = true;
      endState = handleRefusal(msg, opts.label);
    } else {
      endState = "error";
      store.addConsoleLine(`${opts.label} failed: ${msg}`, "error");
      if (msg.includes("disconnected") || msg.includes("Not connected")) {
        portDisconnected = true;
        useStore.getState().setMachineConnected(false);
        useStore.getState().setMachineState("disconnected");
      }
    }
  }

  // Safety: on non-complete, non-alarm outcomes, route through one shared
  // emergencyStop (B1's native stop). ALARM excluded: GRBL is already locked.
  // SKIPPED when jobRunning is already false (STOP already ran), and ALWAYS
  // skipped on a refusal: the backend has already reset the controller or
  // handed it to another admission, and a stop sent on an epoch mismatch could
  // reset a job that is not this producer's.
  if (
    !refused &&
    endState !== "complete" &&
    endState !== "alarm" &&
    useStore.getState().jobRunning
  ) {
    try {
      await machineConnection.emergencyStop();
    } catch {
      /* port may be gone */
    }
  }

  endJobEvidence(opts.label); // E3: buffered job end
  // B3: the session handles cleanup.
  await session.end(endState);

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
  startJobEvidence();
  const mode = getStreamingMode();
  if (mode === "buffered") {
    return streamJobBuffered(gcode, opts);
  }

  // -- Per-line path --

  // Capture action creators (stable refs) at the start; read volatile state
  // fresh via useStore.getState() inside the loop.
  const store = useStore.getState();

  const lines = gcode.split("\n").filter((l) => l.trim() && !l.startsWith(";"));

  const session = opts.session;
  let endState: StreamJobResult["endState"] = "complete";
  let portDisconnected = false;
  let refused = false;

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

    setLastSentLine(i, lines[i]);
    const responses = await machineConnection.send(lines[i], { jobEpoch: session.jobId });

    // RF-15: a backend refusal is checked FIRST, before any other
    // classification. Nothing further is sent for this job.
    const refusal = responses.find((r) => r.startsWith(PERMIT_REFUSED_PREFIX));
    if (refusal !== undefined) {
      refused = true;
      endState = handleRefusal(refusal, opts.label);
      break;
    }

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
  if (refused) {
    // RF-15: handleRefusal already logged the only message; no stop, no
    // "aborted"/"cancelled"/"complete" line.
  } else if (endState === "complete") {
    // B3: drain through the session.
    const drainResult = await session.drain(!!opts.waitForIdle);
    if (drainResult === "unknown") {
      // Drain timeout: session retains protection; don't announce complete.
      // Razor W1: must map to "unknown", not leave as "complete".
      endState = "unknown";
    } else if (drainResult === "alarm") {
      endState = "alarm";
      store.addConsoleLine(
        `${opts.label} stopped -- machine alarm (laser already off; unlock to continue)`,
        "error"
      );
    } else if (drainResult === "cancelled") {
      endState = "cancelled";
      store.addConsoleLine(`${opts.label} cancelled`, "info");
    } else {
      store.addConsoleLine(`${opts.label} complete`, "info");
    }
  } else if (endState === "alarm") {
    store.addConsoleLine(
      `${opts.label} stopped -- machine alarm (laser already off; unlock to continue)`,
      "error"
    );
  } else {
    // Safety: route through one shared emergencyStop (B1's native stop).
    // SKIPPED when jobRunning is already false — STOP already ran.
    if (useStore.getState().jobRunning) {
      try {
        await machineConnection.emergencyStop();
      } catch {
        /* port may be gone */
      }
    }
    store.addConsoleLine(`${opts.label} aborted`, "error");
  }

  endJobEvidence(opts.label); // E3: per-line job end
  // B3: the session handles cleanup.
  await session.end(endState);

  // Tear down the serial port on disconnect so a subsequent reconnect
  // (which now sends 0x18) doesn't fail with "port busy". Runs AFTER the
  // shared stop above so the reset has already been attempted before teardown.
  if (portDisconnected) {
    try {
      await machineConnection.disconnect();
    } catch {
      /* port already gone */
    }
  }

  return { endState, portDisconnected };
}
