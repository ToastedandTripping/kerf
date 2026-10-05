/**
 * JobActionBar — pinned-bottom START / FRAME / PAUSE / STOP + progress.
 *
 * Extracted from MachinePanel.tsx as a unit. Handlers are VERBATIM moves —
 * no logic changes. Laser-safety contract is identical to MachinePanel's
 * original implementation.
 *
 * Error-185 audit — every useStore call reads a scalar, whole-object, or
 * stable function reference. NO object/array literals are returned from any
 * selector. The canStartJob gate receives individual scalars (same pattern
 * as MachinePanel's existing IIFE). useStore.getState() is used inside
 * handlers (call-time access, safe).
 */

import { useState, useEffect, useRef } from "react";
import { useStore } from "../../app/store";
import { machineConnection } from "../../lib/machine/connection";
import { canStartJob, frameTargets } from "../../lib/machine/canStartJob";
import { streamJob, pauseJob, resumeJob } from "../../lib/machine/jobStream";
import { beginJobSession, stopActiveSession } from "../../lib/machine/jobSession";
import { formatTime } from "../../lib/constants";
import { excludedLayers } from "../../lib/layerContents";
import {
  DOOR_LINE,
  STOP_TITLE,
  exclusionCaption,
  progressFill,
  progressText,
  refusalLine,
  stopPresentation,
} from "./jobBarPresentation";

export function JobActionBar() {
  // --- Scalar / stable-ref selectors only (Error-185 safe) ---
  const machineConnected = useStore((s) => s.machineConnected);
  const machineState = useStore((s) => s.machineState);
  const jobRunning = useStore((s) => s.jobRunning);
  const setJobRunning = useStore((s) => s.setJobRunning);
  const setJobProgress = useStore((s) => s.setJobProgress);
  const jobProgress = useStore((s) => s.jobProgress);
  const addConsoleLine = useStore((s) => s.addConsoleLine);
  const setStatusMessage = useStore((s) => s.setStatusMessage);
  const gcodeResult = useStore((s) => s.gcodeResult); // whole-object ref (stable unless replaced)
  const gcodeStale = useStore((s) => s.gcodeStale);
  const workspaceWidth = useStore((s) => s.workspaceWidth);
  const workspaceHeight = useStore((s) => s.workspaceHeight);
  const originTop = useStore((s) => s.originTop);
  const workspaceVerified = useStore((s) => s.workspaceVerified);
  const grblLaserMode = useStore((s) => s.grblLaserMode);
  const statusStale = useStore((s) => s.statusStale);
  const layers = useStore((s) => s.layers); // whole-array ref (stable unless replaced)
  const objects = useStore((s) => s.objects); // whole-array ref (stable unless replaced)

  // Elapsed-time timer (moved verbatim from MachinePanel)
  const jobStartTimeRef = useRef<number>(0);
  const [elapsedSecs, setElapsedSecs] = useState(0);

  useEffect(() => {
    if (jobRunning) {
      if (jobStartTimeRef.current === 0) jobStartTimeRef.current = Date.now();
      const timer = setInterval(() => {
        setElapsedSecs(Math.floor((Date.now() - jobStartTimeRef.current) / 1000));
      }, 1000);
      return () => clearInterval(timer);
    } else {
      jobStartTimeRef.current = 0;
      setElapsedSecs(0);
    }
  }, [jobRunning]);

  // --- Handlers (verbatim from MachinePanel — logic unchanged) ---

  async function handleStartJob() {
    // F15: pure pre-flight gate — bounds come from gcodeResult.moves (the true
    // machine-frame extents), not rotation-blind object AABBs.
    const gate = canStartJob(useStore.getState());
    if (!gate.ok) {
      addConsoleLine(gate.reason!, "error");
      return;
    }
    const job = useStore.getState().gcodeResult!;

    // B3: acquire a job session before streaming.
    const session = await beginJobSession("Job");
    if (!session) return; // blocked by active/stopping session

    setJobRunning(true);
    setJobProgress(0);
    addConsoleLine("Sending job...", "info");

    const result = await streamJob(job.gcode, {
      label: "Job",
      waitForIdle: true,
      session,
    });

    if (result.endState === "complete") {
      setStatusMessage(`Job complete -- ${formatTime(job.estimatedTimeSecs)}`);
    }
  }

  async function handlePauseResume() {
    if (machineState === "hold") {
      // A1 fix: cycle resume only (realtime byte `~`). No M3 re-enable —
      // that's a line command into Hold (F13 hazard). GRBL restores spindle
      // state automatically when the spindle-stop-override toggle is released
      // by the resume.
      await resumeJob();
    } else {
      // A1 fix: feed hold + spindle-stop-override (realtime bytes only).
      // No M5 line — that's the F13 deadlock (line command queued in Hold,
      // never executed, beam stays on).
      await pauseJob();
    }
  }

  async function handleStop() {
    // B3: cancel the active session (wakes drain waits) but do NOT await
    // it before the emergency stop — awaiting session.settled creates a
    // circular dependency in buffered mode (Razor C1). The pre-B3 order
    // (setJobRunning false, then emergencyStop) is safety-critical.
    stopActiveSession(); // fire-and-forget: session settles after e-stop
    setJobRunning(false);
    await machineConnection.emergencyStop();
  }

  async function handleFrame() {
    // Machine-frame moves extents — the old design->machine Y-flip
    // is deliberately DELETED, not ported: moves[] is already
    // machine-frame, flipping again would trace a mirrored rect.
    // S1: the same admission START uses (no ext — main FRAME traces the
    // design's gcodeResult, so gcodeStale applies). Reason printed verbatim.
    const moves = useStore.getState().gcodeResult?.moves ?? [];
    const gate = canStartJob(useStore.getState());
    if (!gate.ok) {
      addConsoleLine(gate.reason!, "error");
      return;
    }
    const targets = frameTargets(moves);
    if (!targets) {
      addConsoleLine("Nothing to cut -- no moves in the generated G-code", "error");
      return;
    }

    // Build M5-bracketed G0 program — F16 safety: M5 clears any stale M3
    // before framing so bare G0 moves can't trace-cut; belt-and-suspenders
    // M5 after the final frame move.
    const frameLines: string[] = ["M5"];
    for (const t of targets) {
      frameLines.push(`G0 X${t.x.toFixed(3)} Y${t.y.toFixed(3)}`);
    }
    frameLines.push("M5");

    // B3: acquire a job session for FRAME.
    const session = await beginJobSession("Frame");
    if (!session) return;

    setJobRunning(true);
    setJobProgress(0);
    await streamJob(frameLines.join("\n"), { label: "Frame", session });
  }

  // --- Gate computation (scalars passed individually — same as MachinePanel IIFE) ---
  const startGate = canStartJob({
    machineConnected,
    machineState,
    jobRunning,
    gcodeResult,
    gcodeStale,
    workspaceWidth,
    workspaceHeight,
    originTop,
    workspaceVerified,
    grblLaserMode,
    statusStale,
  });

  // FRAME contract: framing traces the true G-code extents; fresh G-code +
  // verified workspace are prerequisites.
  const frameDisabled = !startGate.ok;
  // C7: one admission, one first step — FRAME shows the gate's own reason.
  const frameHint = startGate.reason;

  // --- Presentation only (A7): derived from the state above, owns nothing ---
  const stop = stopPresentation({ machineConnected, jobRunning, machineState, statusStale });
  const refusal = refusalLine(startGate, jobRunning);
  const exclusion = jobRunning ? null : exclusionCaption(excludedLayers(layers, objects));
  const progress = progressText(elapsedSecs, jobProgress);
  // While STOP is solid, START and FRAME size to their own labels (never
  // clipped) and STOP takes what the row has left, floor 104px. They stay
  // rendered and disabled by their own expressions.
  const startFrameFlex = stop.variant === "solid" ? "0 0 auto" : "1";
  const startFramePadding = stop.variant === "solid" ? "6px 2px" : "6px";

  return (
    <div style={{ flexShrink: 0, borderTop: "1px solid var(--border)" }}>
      {/* Job progress bar — shown when job is running */}
      {jobRunning && (
        <div style={{ padding: "6px 8px 2px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "var(--text-md)",
              fontWeight: 600,
              color: "var(--text-primary)",
              fontVariantNumeric: "tabular-nums",
              marginBottom: "4px",
            }}
          >
            <span data-testid="job-progress-time">
              <span style={{ fontFamily: "var(--font-mono)" }}>{progress.elapsed}</span>
              {progress.remaining !== null && (
                <>
                  {" · about "}
                  <span style={{ fontFamily: "var(--font-mono)" }}>{progress.remaining}</span>
                  {" left"}
                </>
              )}
            </span>
            <span data-testid="job-progress-percent">{progress.percent}</span>
          </div>
          <div
            style={{
              background: "var(--bg-input)",
              borderRadius: "var(--radius-sm)",
              height: "6px",
              overflow: "hidden",
            }}
          >
            <div
              data-testid="job-progress-fill"
              style={{
                height: "100%",
                width: `${jobProgress * 100}%`,
                background: progressFill(machineState, statusStale),
                transition: "width 0.3s",
              }}
            />
          </div>
          {machineState === "door" && (
            <div
              role="status"
              style={{ fontSize: "var(--text-xs)", color: "var(--warning)", marginTop: "4px" }}
            >
              {DOOR_LINE}
            </div>
          )}
        </div>
      )}

      {/* Why START and FRAME cannot act, where the eye already is */}
      {(exclusion !== null || refusal !== null) && (
        <div
          style={{
            padding: "6px 8px 0",
            fontSize: "var(--text-xs)",
            color: "var(--text-secondary)",
          }}
        >
          {exclusion !== null && <div data-testid="job-exclusion">{exclusion}</div>}
          {refusal !== null && (
            <div
              role="status"
              data-testid="job-refusal"
              style={{
                display: "flex",
                alignItems: "flex-start",
                lineHeight: "16px",
                gap: "6px",
                marginTop: exclusion ? "2px" : 0,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: "var(--warning)",
                  flexShrink: 0,
                  marginTop: "5px",
                }}
              />
              {refusal}
            </div>
          )}
        </div>
      )}

      {/* START / FRAME / PAUSE / STOP button row */}
      <div style={{ display: "flex", alignItems: "center", gap: "4px", padding: "6px 8px" }}>
        <button
          onClick={handleStartJob}
          disabled={!startGate.ok}
          title={startGate.reason}
          style={{
            flex: startFrameFlex,
            height: "32px",
            padding: startFramePadding,
            borderRadius: "var(--radius-sm)",
            border: "1px solid rgba(74,226,138,0.5)",
            fontSize: "11px",
            fontWeight: 700,
            cursor: startGate.ok ? "pointer" : "not-allowed",
            background: "rgba(74,226,138,0.2)",
            color: "var(--success)",
            opacity: startGate.ok ? 1 : 0.4,
          }}
        >
          START
        </button>
        <button
          onClick={handleFrame}
          disabled={frameDisabled}
          title={frameHint}
          style={{
            flex: startFrameFlex,
            height: "32px",
            padding: startFramePadding,
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--accent)",
            fontSize: "11px",
            fontWeight: 700,
            cursor: frameDisabled ? "not-allowed" : "pointer",
            background: "rgba(74,144,226,0.15)",
            color: "var(--accent-text)",
            opacity: frameDisabled ? 0.4 : 1,
          }}
        >
          FRAME
        </button>
        <button
          onClick={handlePauseResume}
          disabled={!machineConnected || !jobRunning}
          style={{
            padding: "6px 10px",
            borderRadius: "var(--radius-sm)",
            border: "none",
            fontSize: "11px",
            fontWeight: 600,
            cursor: machineConnected && jobRunning ? "pointer" : "not-allowed",
            background: "rgba(196,165,123,0.2)",
            color: "var(--accent-warm)",
            opacity: !machineConnected || !jobRunning ? 0.4 : 1,
          }}
        >
          {machineState === "hold" ? "RESUME" : "PAUSE"}
        </button>
        <button
          onClick={handleStop}
          disabled={!machineConnected}
          title={STOP_TITLE}
          data-stop-variant={stop.variant}
          style={{
            padding: "0 10px",
            borderRadius: "var(--radius-sm)",
            ...stop.style,
          }}
        >
          STOP
        </button>
      </div>
    </div>
  );
}
