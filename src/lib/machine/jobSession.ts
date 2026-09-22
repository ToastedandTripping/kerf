/**
 * jobSession.ts — job lifetime ownership from begin through draining.
 *
 * One session owns all progress/pause/cleanup across per-line, buffered, and
 * draining phases. The backend job ID (serial_job_begin) is acquired before
 * the first line and released only after confirmed completion or explicit stop.
 *
 * Safety contract:
 * - A delayed callback from job A cannot mutate job B's state.
 * - Transmit-finished enters draining; completion requires a confirmed Idle
 *   snapshot (not a stale buffered Idle).
 * - A 30-second drain timeout enters "unknown" state, retains protection,
 *   and never returns "complete."
 * - STOP cancels drain waits and blocks new jobs until the old session settles.
 *
 * Keep-awake: the inhibitor remains held through draining/unknown. Release
 * follows confirmed completion or explicit physical-stop acknowledgement,
 * not timeout alone.
 */

import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../app/store";
import { machineConnection } from "./connection";

/** Outcome of a completed job session. */
export type SessionOutcome =
  | "complete"
  | "cancelled"
  | "aborted"
  | "alarm"
  | "error"
  | "unknown";

/** The currently active session, or null. Module-level singleton. */
let activeSession: JobSession | null = null;

/** Promise that resolves when a stopping session finishes teardown.
 *  New jobs must await this before proceeding. */
let stoppingPromise: Promise<void> | null = null;

/**
 * Acquire a new job session. All four entry points (main job, main FRAME,
 * material test, material FRAME) call this before streaming.
 *
 * Returns null if a session is already active or stopping.
 */
export async function beginJobSession(label: string): Promise<JobSession | null> {
  // Block if a previous session is still stopping/draining.
  if (stoppingPromise) {
    const store = useStore.getState();
    store.addConsoleLine(
      `Cannot start ${label}: previous job is still stopping`,
      "error"
    );
    return null;
  }

  if (activeSession) {
    const store = useStore.getState();
    store.addConsoleLine(
      `Cannot start ${label}: another job is active`,
      "error"
    );
    return null;
  }

  // Acquire backend job ID.
  let jobId: number;
  try {
    jobId = await invoke<number>("serial_job_begin");
  } catch (e) {
    const store = useStore.getState();
    store.addConsoleLine(
      `Cannot start ${label}: ${String(e)}`,
      "error"
    );
    return null;
  }

  const session = new JobSession(jobId, label);
  activeSession = session;
  return session;
}

/**
 * Get the currently active session, or null.
 * Used by STOP to cancel the active drain.
 */
export function getActiveSession(): JobSession | null {
  return activeSession;
}

/** Drain poll interval (ms). */
const DRAIN_POLL_MS = 200;
/** Drain timeout (ms). */
const DRAIN_TIMEOUT_MS = 30_000;

export class JobSession {
  /** Backend job epoch — uniquely identifies this session. */
  readonly jobId: number;
  /** Display label for console messages. */
  readonly label: string;
  /** Set to true when STOP cancels this session. */
  private _cancelled = false;
  /** Resolves when the session is fully settled (complete, unknown, or stopped). */
  private _settledResolve: (() => void) | null = null;
  private _settledPromise: Promise<void>;

  constructor(jobId: number, label: string) {
    this.jobId = jobId;
    this.label = label;
    this._settledPromise = new Promise((resolve) => {
      this._settledResolve = resolve;
    });
  }

  /** Check if a callback belongs to this session. Callbacks from a previous
   *  session (different jobId) must be discarded. */
  isOwner(checkJobId: number): boolean {
    return checkJobId === this.jobId;
  }

  /** Whether this session has been cancelled by STOP. */
  get cancelled(): boolean {
    return this._cancelled;
  }

  /**
   * Called by the streaming infrastructure when all lines have been sent/acked
   * but the controller may still be executing (head decelerating, buffered
   * commands in flight). Enters draining phase.
   *
   * For waitForIdle=false paths (FRAME, material test), this still drains
   * briefly to confirm the controller is idle, preventing premature "complete."
   *
   * Returns the final outcome after draining.
   */
  async drain(waitForIdle: boolean): Promise<SessionOutcome> {
    if (this._cancelled) return "cancelled";

    if (!waitForIdle) {
      // Non-idle-waiting paths: brief confirmation poll (one cycle).
      // They don't need the full 30s drain — the controller is typically
      // already idle for non-cutting FRAME paths. But they still must
      // not return "complete" if the controller is in Run/Hold.
      const BRIEF_TIMEOUT_MS = 5000;
      const deadline = Date.now() + BRIEF_TIMEOUT_MS;
      while (Date.now() < deadline && !this._cancelled) {
        await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
        try {
          const report = await machineConnection.getStatusReport();
          if (report && /^<Idle/i.test(report)) {
            return "complete";
          }
        } catch {
          break;
        }
      }
      // If cancelled during drain, return cancelled.
      if (this._cancelled) return "cancelled";
      // Brief timeout: still return complete for non-critical paths
      // (FRAME/material FRAME don't fire the laser in these moves).
      return "complete";
    }

    // Full drain for cutting jobs (waitForIdle=true).
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (Date.now() < deadline && !this._cancelled) {
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
      try {
        const report = await machineConnection.getStatusReport();
        if (this._cancelled) return "cancelled";
        if (!report) continue;
        if (/^<Idle/i.test(report)) {
          return "complete";
        }
        if (/^<Alarm/i.test(report)) {
          return "alarm";
        }
        // Run or Hold — continue polling, controller is still working.
      } catch {
        // Poll failure — continue trying until timeout.
      }
    }

    if (this._cancelled) return "cancelled";

    // 30s drain timeout: enter "unknown" state. Retain protection (jobRunning
    // stays true, keep-awake stays held). Offer STOP — never return "complete."
    const store = useStore.getState();
    store.addConsoleLine(
      `${this.label} drain timeout -- controller state unknown. Press STOP to release.`,
      "warning"
    );
    return "unknown";
  }

  /**
   * Cancel this session (called by STOP). Wakes any drain wait.
   */
  cancel(): void {
    this._cancelled = true;
  }

  /**
   * End this session: release the backend job ID and clear module state.
   * For "unknown" outcome, jobRunning is NOT cleared here — the caller
   * retains it until explicit STOP.
   */
  async end(outcome: SessionOutcome): Promise<void> {
    // Release backend job.
    try {
      await invoke("serial_job_end", { jobId: this.jobId });
    } catch {
      // Stale epoch or already ended — non-fatal.
    }

    // Clear module-level active session.
    if (activeSession === this) {
      activeSession = null;
    }

    // For non-unknown outcomes, clear jobRunning and jobProgress.
    // "unknown" retains jobRunning=true so keep-awake stays held and
    // STOP remains available.
    if (outcome !== "unknown") {
      const store = useStore.getState();
      store.setJobRunning(false);
      store.setJobProgress(0);
    }

    // Resolve the settled promise.
    if (this._settledResolve) {
      this._settledResolve();
      this._settledResolve = null;
    }
  }

  /** Promise that resolves when the session is fully settled. */
  get settled(): Promise<void> {
    return this._settledPromise;
  }
}

/**
 * Test-only: reset module state. Not imported in production code.
 */
export function _testResetJobSession(): void {
  activeSession = null;
  stoppingPromise = null;
}

/**
 * Stop the active session. Called by the STOP button handler.
 * Cancels drain waits, detaches old callbacks, blocks new jobs until
 * the old session settles and the controller confirms off/idle.
 */
export async function stopActiveSession(): Promise<void> {
  const session = activeSession;
  if (!session) return;

  // Cancel the session (wakes drain waits).
  session.cancel();

  // Create a stopping promise that blocks new jobs.
  let resolveStop: () => void;
  stoppingPromise = new Promise((resolve) => {
    resolveStop = resolve;
  });

  // Wait for the session to settle (drain exits).
  await session.settled;

  // Clear the stopping promise, allowing new jobs.
  stoppingPromise = null;
  resolveStop!();
}
