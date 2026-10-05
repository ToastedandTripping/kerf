/**
 * jobBarPresentation — PURE presentation helpers for JobActionBar.
 *
 * Nothing here decides whether a control acts: STOP's `disabled` stays
 * `!machineConnected` in the component, START and FRAME keep `startGate`.
 * These functions only derive how that existing state is drawn and worded.
 */
import type { JobGate } from "../../lib/machine/canStartJob";

export type StoredMachineState = "idle" | "run" | "hold" | "alarm" | "door" | "disconnected";

export type StopVariant = "disabled" | "outline" | "solid";

export interface StopPresentation {
  variant: StopVariant;
  style: {
    opacity: number;
    cursor: "pointer" | "not-allowed";
    background: string;
    border: string;
    color: string;
    fontSize: string;
    fontWeight: number;
    flex: string;
    minWidth: string;
    height: string;
  };
}

/** STOP's copy: what Kerf sends (DECISIONS 2026-09-20), then advice. */
export const STOP_TITLE =
  "Sends a controller reset (0x18). Keep the machine's own emergency stop within reach.";

/** Shown while a job runs and the controller reports Door. Names the
 *  reported state word and no cause (DECISIONS 2026-09-05). */
export const DOOR_LINE = "Controller reports Door. STOP ends the job.";

const OUTLINE_SIZE = { flex: "1", minWidth: "72px", height: "32px" };

/**
 * STOP is never drawn dimmed while it can act. Dimmed exactly when
 * `!machineConnected` (the component's own `disabled` expression); outline
 * only when connected, no job, idle and status fresh; solid otherwise
 * (run covers jog and home, an unknown state stores as alarm).
 */
export function stopPresentation(s: {
  machineConnected: boolean;
  jobRunning: boolean;
  machineState: StoredMachineState;
  statusStale: boolean;
}): StopPresentation {
  const type = { fontSize: "var(--text-md)", fontWeight: 700 };
  const outline = {
    ...type,
    ...OUTLINE_SIZE,
    background: "transparent",
    border: "1px solid var(--danger-text)",
    color: "var(--danger-text)",
  };
  if (!s.machineConnected) {
    return {
      variant: "disabled",
      style: { ...outline, opacity: 0.4, cursor: "not-allowed" },
    };
  }
  if (!s.jobRunning && s.machineState === "idle" && !s.statusStale) {
    return { variant: "outline", style: { ...outline, opacity: 1, cursor: "pointer" } };
  }
  return {
    variant: "solid",
    style: {
      ...type,
      opacity: 1,
      cursor: "pointer",
      background: "var(--danger-strong)",
      border: "1px solid var(--danger-strong)",
      color: "#fff",
      flex: "1 1 0%",
      minWidth: "104px",
      height: "40px",
    },
  };
}

/** The visible refusal line: the gate's own reason, verbatim, only while no
 *  job runs and the gate refuses. Null renders nothing. */
export function refusalLine(startGate: JobGate, jobRunning: boolean): string | null {
  if (jobRunning || startGate.ok) return null;
  return startGate.reason ?? null;
}

/** Format seconds as M:SS for the compact job timer. */
export function formatTimeMSS(totalSecs: number): string {
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Progress copy. `remaining` is the estimate JobActionBar has always
 * computed, shown only when `jobProgress > 0.01` (the same expression);
 * "about ... left" marks it as an estimate of what remains, not a total.
 */
export function progressText(
  elapsedSecs: number,
  jobProgress: number
): { elapsed: string; remaining: string | null; percent: string } {
  const elapsed = formatTimeMSS(elapsedSecs);
  const remaining =
    jobProgress > 0.01
      ? formatTimeMSS(Math.round((elapsedSecs / jobProgress) * (1 - jobProgress)))
      : null;
  return { elapsed, remaining, percent: `${Math.round(jobProgress * 100)}%` };
}

/** Bar fill. Stale first (the state word is not current): grey. Then alarm
 *  red, hold and door amber (needs attention), otherwise blue. */
export function progressFill(machineState: StoredMachineState, statusStale: boolean): string {
  if (statusStale) return "var(--text-secondary)";
  if (machineState === "alarm") return "var(--danger)";
  if (machineState === "hold" || machineState === "door") return "var(--warning)";
  return "var(--accent)";
}

/** "Not in the G-code: Score (output off), Custom 4 (hidden)", or null. */
export function exclusionCaption(
  excluded: ReadonlyArray<{ name: string; reason: string }>
): string | null {
  if (excluded.length === 0) return null;
  return `Not in the G-code: ${excluded.map((e) => `${e.name} (${e.reason})`).join(", ")}`;
}
