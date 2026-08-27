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
import {
  canStartJob,
  movesExtents,
  frameTargets,
  isWithinBounds,
} from "../../lib/machine/canStartJob";
import { streamJob, pauseJob, resumeJob } from "../../lib/machine/jobStream";
import { formatTime } from "../../lib/constants";

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

    setJobRunning(true);
    setJobProgress(0);
    addConsoleLine("Sending job...", "info");

    const result = await streamJob(job.gcode, {
      label: "Job",
      waitForIdle: true,
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
    setJobRunning(false);
    await machineConnection.emergencyStop();
  }

  async function handleFrame() {
    // Machine-frame moves extents — the old design->machine Y-flip
    // is deliberately DELETED, not ported: moves[] is already
    // machine-frame, flipping again would trace a mirrored rect.
    const storeState = useStore.getState();
    // WARNING-2: explicit guard — frameDisabled already blocks the button,
    // but guard here too so the handler is safe if called by other paths.
    if (!storeState.workspaceVerified) {
      addConsoleLine("FRAME blocked: confirm bed size before framing", "error");
      return;
    }
    const moves = storeState.gcodeResult?.moves ?? [];
    const targets = frameTargets(moves);
    if (!targets) {
      addConsoleLine("Nothing to cut -- no moves in the generated G-code", "error");
      return;
    }
    // Bounds check: same gate that START uses — never send out-of-range G0s
    const ext = movesExtents(moves)!; // targets non-null implies ext non-null
    if (
      !isWithinBounds(
        ext,
        storeState.workspaceWidth,
        storeState.workspaceHeight,
        storeState.originTop
      )
    ) {
      addConsoleLine(
        "FRAME blocked: G-code extends outside workspace bounds. Move or resize the design to fit.",
        "error"
      );
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

    setJobRunning(true);
    setJobProgress(0);
    await streamJob(frameLines.join("\n"), { label: "Frame" });
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
  });

  // FRAME contract: framing traces the true G-code extents; fresh G-code +
  // verified workspace are prerequisites.
  const frameDisabled =
    !machineConnected ||
    machineState === "alarm" ||
    machineState !== "idle" ||
    jobRunning ||
    !gcodeResult ||
    gcodeStale ||
    !workspaceVerified;
  const frameHint = !workspaceVerified
    ? "Confirm bed size before framing"
    : !gcodeResult
      ? "Generate G-code first"
      : gcodeStale
        ? "Design changed -- regenerate G-code"
        : undefined;

  return (
    <div style={{ flexShrink: 0, borderTop: "1px solid var(--border)" }}>
      {/* Job progress bar — shown when job is running */}
      {jobRunning && (
        <div style={{ padding: "6px 8px 2px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "10px",
              color: "var(--text-muted)",
              marginBottom: "2px",
            }}
          >
            <span style={{ fontFamily: "var(--font-mono)" }}>
              {formatTimeMSS(elapsedSecs)}
              {jobProgress > 0.01 && (
                <span>
                  {" "}
                  / ~{formatTimeMSS(
                    Math.round((elapsedSecs / jobProgress) * (1 - jobProgress))
                  )}{" "}
                  est.
                </span>
              )}
            </span>
            <span>{Math.round(jobProgress * 100)}%</span>
          </div>
          <div
            style={{
              background: "var(--bg-input)",
              borderRadius: "var(--radius-sm)",
              height: "4px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${jobProgress * 100}%`,
                background: machineState === "hold" ? "var(--accent-warm)" : "var(--accent)",
                transition: "width 0.3s",
              }}
            />
          </div>
        </div>
      )}

      {/* START / FRAME / PAUSE / STOP button row */}
      <div style={{ display: "flex", gap: "4px", padding: "6px 8px" }}>
        <button
          onClick={handleStartJob}
          disabled={!startGate.ok}
          title={startGate.reason}
          style={{
            flex: 1,
            padding: "6px",
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
            flex: 1,
            padding: "6px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--accent)",
            fontSize: "11px",
            fontWeight: 700,
            cursor: frameDisabled ? "not-allowed" : "pointer",
            background: "rgba(74,144,226,0.15)",
            color: "var(--accent)",
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
          style={{
            padding: "6px 10px",
            borderRadius: "var(--radius-sm)",
            border: "none",
            fontSize: "11px",
            fontWeight: 700,
            cursor: machineConnected && jobRunning ? "pointer" : "not-allowed",
            background: "rgba(226,74,74,0.2)",
            color: "var(--danger)",
            opacity: !machineConnected ? 0.4 : !jobRunning ? 0.4 : 1,
          }}
        >
          STOP
        </button>
      </div>
    </div>
  );
}

/** Format seconds as M:SS for compact job timer display */
function formatTimeMSS(totalSecs: number): string {
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
