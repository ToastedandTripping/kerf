import { useState, useEffect, useCallback, useRef } from "react";
import { useStore } from "../../app/store";
import { machineConnection, type ConnectionError } from "../../lib/machine/connection";
import { generateGcode } from "../../lib/machine/gcodeGen";
import { canStartJob, frameTargets } from "../../lib/machine/canStartJob";
import { MACHINE_STATE_COLORS } from "../../lib/machine/machineStateDisplay";
import type { StartCorner } from "../../app/types";

export function MachinePanel() {
  const machineConnected = useStore((s) => s.machineConnected);
  const machineState = useStore((s) => s.machineState);
  const machinePosition = useStore((s) => s.machinePosition);
  const addConsoleLine = useStore((s) => s.addConsoleLine);
  const setGcodeResult = useStore((s) => s.setGcodeResult);
  const setPreviewVisible = useStore((s) => s.setPreviewVisible);
  const gcodeResult = useStore((s) => s.gcodeResult);
  const jobRunning = useStore((s) => s.jobRunning);
  const setJobRunning = useStore((s) => s.setJobRunning);
  const setJobProgress = useStore((s) => s.setJobProgress);
  const jobProgress = useStore((s) => s.jobProgress);
  const activeTool = useStore((s) => s.activeTool);
  const setActiveTool = useStore((s) => s.setActiveTool);
  const startCorner = useStore((s) => s.startCorner);
  const setStartCorner = useStore((s) => s.setStartCorner);
  const gcodeStale = useStore((s) => s.gcodeStale);
  const workspaceWidth = useStore((s) => s.workspaceWidth);
  const workspaceHeight = useStore((s) => s.workspaceHeight);
  const consoleLines = useStore((s) => s.consoleLines);
  const setStatusMessage = useStore((s) => s.setStatusMessage);

  const [selectedPort, setSelectedPort] = useState("");
  const [ports, setPorts] = useState<Array<{ name: string; portType: string; vid: number | null; pid: number | null }>>([]);
  const [jogStep, setJogStep] = useState(10);
  const [expanded, setExpanded] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [connectionError, setConnectionError] = useState<{ message: string; suggestions: string[] } | null>(null);
  const jobStartTimeRef = useRef<number>(0);
  const [elapsedSecs, setElapsedSecs] = useState(0);

  // Track job elapsed time
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

  const refreshPorts = useCallback(async () => {
    const found = await machineConnection.listPorts();
    setPorts(found);
    if (!selectedPort && found.length > 0) {
      const last = machineConnection.getLastPort();
      const match = found.find(p => p.name === last?.name);
      setSelectedPort(match ? match.name : found[0].name);
    }
  }, [selectedPort]);

  useEffect(() => {
    refreshPorts();
    if (!machineConnected) {
      machineConnection.autoConnect().then(ok => {
        if (ok) refreshPorts();
      }).catch(console.error);
    }
  }, []);

  async function handleConnect() {
    if (machineConnected) {
      await machineConnection.disconnect();
      setConnectionError(null);
    } else {
      if (!selectedPort) {
        addConsoleLine("No port selected", "error");
        return;
      }
      try {
        setConnectionError(null);
        // F14: connect() owns the settings query + $32/unverified warnings so
        // manual and auto connect produce identical output. Only UI-state
        // concerns live here.
        await machineConnection.connect(selectedPort);
      } catch (e) {
        // Display structured error with suggestions
        const err = e as ConnectionError;
        if (err && err.message && err.suggestions) {
          setConnectionError(err);
        } else {
          setConnectionError({
            message: `Connection failed: ${String(e)}`,
            suggestions: ["Check COM port selection", "Verify USB cable is connected"],
          });
        }
      }
    }
  }

  async function handleGenerateGcode() {
    setGenerating(true);
    try {
      const result = await generateGcode();
      setGcodeResult(result);
      addConsoleLine(
        `G-code generated: ${result.lineCount} lines, ${result.cutDistance.toFixed(1)}mm cut, ~${Math.ceil(result.estimatedTimeSecs)}s`,
        "info"
      );
    } catch (e) {
      addConsoleLine(`G-code generation failed: ${e}`, "error");
    }
    setGenerating(false);
  }

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

    const lines = job.gcode
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith(";"));

    // F13/F17 line-response protocol: empty response or reset banner = the line
    // was ABORTED, not acked; ALARM = controller locked, laser already
    // de-energized by firmware.
    let endState: "complete" | "cancelled" | "aborted" | "alarm" | "error" = "complete";

    for (let i = 0; i < lines.length; i++) {
      if (!useStore.getState().jobRunning) {
        addConsoleLine("Job cancelled", "error");
        endState = "cancelled";
        break;
      }
      // Wait while paused
      while (useStore.getState().machineState === "hold") {
        await new Promise((r) => setTimeout(r, 100));
      }
      const responses = await machineConnection.send(lines[i]);
      setJobProgress((i + 1) / lines.length);

      if (responses.length === 0 || responses.some((r) => r.startsWith("Grbl "))) {
        addConsoleLine("Job aborted -- machine was reset mid-line", "error");
        endState = "aborted";
        break;
      }
      if (responses.some((r) => r.startsWith("ALARM"))) {
        // NO M5+reset volley here: GRBL is locked and the laser is already off;
        // the volley would only earn a confusing error:9.
        endState = "alarm";
        break;
      }
      if (responses.some((r) => r.startsWith("error:"))) {
        addConsoleLine("Job stopped due to error", "error");
        endState = "error";
        // Detect disconnect
        if (responses.some((r) => r === "error:disconnected")) {
          useStore.getState().setMachineConnected(false);
          useStore.getState().setMachineState("disconnected");
        }
        break;
      }
    }

    const elapsed = job.estimatedTimeSecs * (jobProgress || 1);
    if (endState === "complete") {
      addConsoleLine("Job complete", "info");
      setStatusMessage(`Job complete -- ${formatTime(elapsed)}`);
    } else if (endState === "alarm") {
      addConsoleLine(
        "Job stopped -- machine alarm (laser already off; unlock to continue)",
        "error",
      );
    } else {
      // Safety volley: ensure laser is off. SKIPPED when jobRunning is already
      // false — the user pressed STOP and emergencyStop ran its own sequence; a
      // second M5+0x18 would push another reset banner into the buffer.
      if (useStore.getState().jobRunning) {
        try { await machineConnection.send("M5"); } catch { /* port may be gone */ }
        try { await machineConnection.softReset(); } catch { /* port may be gone */ }
      }
      addConsoleLine("Job aborted", "error");
    }

    setJobRunning(false);
    setJobProgress(0);
  }

  async function handlePauseResume() {
    if (machineState === "hold") {
      await machineConnection.cycleResume();
    } else {
      await machineConnection.feedHold();
    }
  }

  async function handleStop() {
    setJobRunning(false);
    await machineConnection.emergencyStop();
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(!expanded); } }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label="Machine panel"
        style={{
          padding: "8px 12px",
          fontSize: "11px",
          fontWeight: 600,
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
        Machine
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: MACHINE_STATE_COLORS[machineState],
            marginLeft: "auto",
          }}
        />
        <span style={{ fontSize: "9px", color: MACHINE_STATE_COLORS[machineState], fontWeight: 400, textTransform: "capitalize" }}>
          {machineState}
        </span>
      </div>

      {expanded && (
        <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {/* Alarm recovery */}
          {machineState === "alarm" && (() => {
            // U15: Parse last ALARM line from console to show alarm code
            const alarmLine = [...consoleLines].reverse().find(l => l.text.includes("ALARM:"));
            const alarmCode = alarmLine?.text.match(/ALARM:(\d+)/)?.[1];
            const alarmDescriptions: Record<string, string> = {
              "1": "Hard limit triggered",
              "2": "G-code motion target exceeds machine travel",
              "3": "Reset while in motion",
              "4": "Probe fail -- not cleared",
              "5": "Probe fail -- not contacted",
              "6": "Homing fail -- cycle not completed",
              "7": "Homing fail -- pulloff failed",
              "8": "Homing fail -- could not find limit switch",
              "9": "Homing fail -- search limit switch not found",
            };
            const alarmDesc = alarmCode ? alarmDescriptions[alarmCode] : null;
            return (
            <div style={{
              background: "rgba(220,50,50,0.1)", border: "1px solid rgba(220,50,50,0.3)",
              borderRadius: "var(--radius-sm)", padding: "8px", fontSize: "11px",
            }}>
              <div style={{ fontWeight: 600, color: "var(--danger, #dc3232)", marginBottom: "4px" }}>
                Machine in ALARM state{alarmCode ? ` (ALARM:${alarmCode})` : ""}
              </div>
              <div style={{ color: "var(--text-secondary)", marginBottom: "6px" }}>
                {alarmDesc || "A limit switch was triggered or motion was lost."} Unlock and re-home to resume.
              </div>
              <div style={{ display: "flex", gap: "4px" }}>
                <button
                  onClick={() => machineConnection.send("$X")}
                  style={{ padding: "3px 8px", fontSize: "10px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "3px", color: "var(--text-primary)", cursor: "pointer" }}
                >
                  Unlock ($X)
                </button>
                <button
                  onClick={() => machineConnection.send("$H")}
                  style={{ padding: "3px 8px", fontSize: "10px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "3px", color: "var(--text-primary)", cursor: "pointer" }}
                >
                  Home ($H)
                </button>
              </div>
            </div>
            );
          })()}

          {/* Connection */}
          <div style={{ display: "flex", gap: "4px" }}>
            <select
              value={selectedPort}
              onChange={(e) => setSelectedPort(e.target.value)}
              disabled={machineConnected}
              style={{
                flex: 1,
                background: "var(--bg-input)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-primary)",
                padding: "4px 6px",
                fontSize: "11px",
              }}
            >
              <option value="">Select port...</option>
              {ports.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.portType})
                </option>
              ))}
            </select>
            <button
              onClick={refreshPorts}
              disabled={machineConnected}
              title="Refresh ports"
              style={{
                padding: "4px 6px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-muted)",
                cursor: machineConnected ? "not-allowed" : "pointer",
                fontSize: "11px",
              }}
            >
              &#x21BB;
            </button>
            <button
              onClick={handleConnect}
              style={{
                padding: "4px 10px",
                borderRadius: "var(--radius-sm)",
                border: "none",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                background: machineConnected ? "rgba(226,74,74,0.2)" : "rgba(74,226,138,0.2)",
                color: machineConnected ? "var(--danger)" : "var(--success)",
              }}
            >
              {machineConnected ? "Disconnect" : "Connect"}
            </button>
          </div>

          {/* Connection error with suggestions */}
          {connectionError && (
            <div style={{
              background: "rgba(220,50,50,0.08)", border: "1px solid rgba(220,50,50,0.25)",
              borderRadius: "var(--radius-sm)", padding: "8px", fontSize: "11px",
            }}>
              <div style={{ fontWeight: 600, color: "var(--danger, #dc3232)", marginBottom: "4px" }}>
                {connectionError.message}
              </div>
              <ul style={{ margin: "0", paddingLeft: "16px", color: "var(--text-secondary)" }}>
                {connectionError.suggestions.map((s, i) => (
                  <li key={i} style={{ marginBottom: "2px" }}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Position readout */}
          <div style={{
            background: "var(--bg-input)",
            borderRadius: "var(--radius-sm)",
            padding: "6px 8px",
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            display: "flex",
            justifyContent: "space-between",
          }}>
            <span>X: <strong>{machinePosition.x.toFixed(2)}</strong></span>
            <span>Y: <strong>{machinePosition.y.toFixed(2)}</strong></span>
            <span>Z: <strong>{machinePosition.z.toFixed(2)}</strong></span>
          </div>

          {/* Jog controls */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "2px" }}>
            <div style={{ fontSize: "10px", color: "var(--text-muted)", marginBottom: "2px" }}>
              JOG ({jogStep}mm)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 32px)", gap: "2px" }}>
              <div />
              <JogButton label="&#x25B2;" onClick={() => machineConnection.jog("Y", jogStep)} title="Y+" />
              <div />
              <JogButton label="&#x25C0;" onClick={() => machineConnection.jog("X", -jogStep)} title="X-" />
              <JogButton
                label="&#x2302;"
                onClick={() => machineConnection.home()}
                title="Home"
                accent
              />
              <JogButton label="&#x25B6;" onClick={() => machineConnection.jog("X", jogStep)} title="X+" />
              <div />
              <JogButton label="&#x25BC;" onClick={() => machineConnection.jog("Y", -jogStep)} title="Y-" />
              <div />
            </div>
            {/* Step size */}
            <div style={{ display: "flex", gap: "2px", marginTop: "4px" }}>
              {[0.1, 1, 10, 50].map((s) => (
                <button
                  key={s}
                  onClick={() => setJogStep(s)}
                  style={{
                    padding: "2px 6px",
                    borderRadius: "3px",
                    fontSize: "9px",
                    border: `1px solid ${jogStep === s ? "var(--accent)" : "var(--border)"}`,
                    background: jogStep === s ? "rgba(74,144,226,0.15)" : "transparent",
                    color: jogStep === s ? "var(--accent)" : "var(--text-muted)",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            <ActionButton
              label="Fire"
              color="var(--accent-warm)"
              disabled={!machineConnected || machineState !== "idle" || jobRunning}
              onClick={async () => {
                const sVal = Math.round(5 / 1000 * useStore.getState().grblSValueMax);
                // F17 Fix 2.3: three awaited sends. A single 3-line send's pump
                // stops at the FIRST ok, leaving two unread acks to misattribute
                // to later commands.
                await machineConnection.send(`M3 S${sVal}`);
                await machineConnection.send("G4 P0.5");
                await machineConnection.send("M5");
              }}
            />
            <ActionButton label="Set Origin" color="var(--text-secondary)" onClick={() => machineConnection.setOrigin()} />
            <button
              onClick={() => setActiveTool(activeTool === "positionLaser" ? "select" : "positionLaser")}
              disabled={!machineConnected || machineState !== "idle"}
              style={{
                padding: "4px 8px",
                borderRadius: "var(--radius-sm)",
                border: `1px solid ${activeTool === "positionLaser" ? "var(--accent)" : "var(--accent)33"}`,
                background: activeTool === "positionLaser" ? "rgba(74,144,226,0.25)" : "rgba(74,144,226,0.08)",
                color: !machineConnected || machineState !== "idle" ? "var(--text-muted)" : "var(--accent)",
                fontSize: "10px",
                fontWeight: 600,
                cursor: machineConnected && machineState === "idle" ? "pointer" : "not-allowed",
                textTransform: "uppercase",
                opacity: !machineConnected || machineState !== "idle" ? 0.4 : 1,
              }}
            >
              Position
            </button>
          </div>

          {/* Start Corner selector */}
          <div>
            <div style={{
              fontSize: "10px",
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.3px",
              marginBottom: "4px",
            }}>
              Start Corner
            </div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 32px)",
              gridTemplateRows: "repeat(3, 32px)",
              gap: "2px",
              width: "fit-content",
              margin: "0 auto",
            }}>
              <StartCornerButton corner="topLeft" active={startCorner} onClick={setStartCorner} />
              <div />
              <StartCornerButton corner="topRight" active={startCorner} onClick={setStartCorner} />
              <div />
              <StartCornerButton corner="center" active={startCorner} onClick={setStartCorner} />
              <div />
              <StartCornerButton corner="bottomLeft" active={startCorner} onClick={setStartCorner} />
              <div />
              <StartCornerButton corner="bottomRight" active={startCorner} onClick={setStartCorner} />
            </div>
          </div>

          {/* Generate + Preview buttons */}
          <div style={{ display: "flex", gap: "4px" }}>
            <button
              onClick={handleGenerateGcode}
              disabled={generating}
              title={gcodeStale ? "Design changed -- regenerate" : undefined}
              style={{
                flex: 1,
                padding: "5px",
                borderRadius: "var(--radius-sm)",
                border: gcodeStale ? "1px solid var(--accent-warm)" : "1px solid var(--accent)33",
                fontSize: "10px",
                fontWeight: 600,
                cursor: "pointer",
                background: gcodeStale ? "rgba(196,165,123,0.15)" : "rgba(74,144,226,0.1)",
                color: gcodeStale ? "var(--accent-warm)" : "var(--accent)",
                textTransform: "uppercase",
                opacity: generating ? 0.5 : 1,
              }}
            >
              {generating ? "Generating..." : gcodeStale ? "Regenerate G-code" : "Generate G-code"}
            </button>
            <button
              onClick={() => {
                if (!gcodeResult) handleGenerateGcode().then(() => setPreviewVisible(true));
                else setPreviewVisible(true);
              }}
              disabled={generating}
              style={{
                padding: "5px 10px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--accent-warm)33",
                fontSize: "10px",
                fontWeight: 600,
                cursor: generating ? "not-allowed" : "pointer",
                background: "rgba(196,165,123,0.1)",
                color: "var(--accent-warm)",
                textTransform: "uppercase",
                opacity: generating ? 0.5 : 1,
              }}
            >
              Preview
            </button>
          </div>

          {/* Job stats (if gcode generated) */}
          {gcodeResult && (
            <div style={{
              background: "var(--bg-input)",
              borderRadius: "var(--radius-sm)",
              padding: "6px 8px",
              fontSize: "10px",
              color: "var(--text-secondary)",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "2px 8px",
            }}>
              <span>Lines: {gcodeResult.lineCount}</span>
              <span>Cut: {gcodeResult.cutDistance.toFixed(1)}mm</span>
              <span>Travel: {gcodeResult.travelDistance.toFixed(1)}mm</span>
              <span>Time: ~{formatTime(gcodeResult.estimatedTimeSecs)}</span>
            </div>
          )}

          {/* Job progress bar */}
          {jobRunning && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "var(--text-muted)", marginBottom: "2px" }}>
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {formatTimeMSS(elapsedSecs)}
                  {jobProgress > 0.01 && (
                    <span> / ~{formatTimeMSS(Math.round(elapsedSecs / jobProgress * (1 - jobProgress)))} est.</span>
                  )}
                </span>
                <span>{Math.round(jobProgress * 100)}%</span>
              </div>
              <div style={{
                background: "var(--bg-input)", borderRadius: "var(--radius-sm)",
                height: "4px", overflow: "hidden",
              }}>
                <div style={{
                  height: "100%",
                  width: `${jobProgress * 100}%`,
                  background: machineState === "hold" ? "var(--accent-warm)" : "var(--accent)",
                  transition: "width 0.3s",
                }} />
              </div>
            </div>
          )}

          {/* Start / Frame / Stop controls */}
          {(() => {
            const startGate = canStartJob({
              machineConnected, jobRunning, gcodeResult, gcodeStale,
              workspaceWidth, workspaceHeight,
            });
            // FRAME contract change (F15): framing traces the true G-code
            // extents, so generated, non-stale G-code is now a prerequisite
            // (it used to work from design bounds alone).
            const frameDisabled =
              !machineConnected || machineState !== "idle" || jobRunning ||
              !gcodeResult || gcodeStale;
            const frameHint = !gcodeResult
              ? "Generate G-code first"
              : gcodeStale
                ? "Design changed -- regenerate G-code"
                : undefined;
            return (
          <div style={{ display: "flex", gap: "4px" }}>
            <button
              onClick={handleStartJob}
              disabled={!startGate.ok}
              title={startGate.reason}
              style={{
                flex: 1,
                padding: "6px",
                borderRadius: "var(--radius-sm)",
                border: "none",
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
              onClick={async () => {
                // Machine-frame moves extents — the old design→machine Y-flip
                // is deliberately DELETED, not ported: moves[] is already
                // machine-frame, flipping again would trace a mirrored rect.
                const moves = useStore.getState().gcodeResult?.moves ?? [];
                const targets = frameTargets(moves);
                if (!targets) {
                  addConsoleLine("Nothing to cut -- no moves in the generated G-code", "error");
                  return;
                }
                for (const t of targets) {
                  await machineConnection.send(`G0 X${t.x.toFixed(3)} Y${t.y.toFixed(3)}`);
                }
              }}
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
                cursor: machineConnected && jobRunning ? "pointer" : machineConnected ? "default" : "not-allowed",
                background: "rgba(226,74,74,0.2)",
                color: "var(--danger)",
                opacity: !machineConnected ? 0.4 : !jobRunning ? 0.4 : 1,
              }}
            >
              STOP
            </button>
          </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function formatTime(secs: number): string {
  if (secs < 60) return `${Math.ceil(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.ceil(secs % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Format seconds as M:SS for compact job timer display */
function formatTimeMSS(totalSecs: number): string {
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function JogButton({
  label, onClick, title, accent,
}: {
  label: string; onClick: () => void; title: string; accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: "32px",
        height: "32px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: accent ? "rgba(74,144,226,0.15)" : "var(--bg-input)",
        border: `1px solid ${accent ? "var(--accent)" : "var(--border)"}`,
        borderRadius: "var(--radius-sm)",
        color: accent ? "var(--accent)" : "var(--text-primary)",
        cursor: "pointer",
        fontSize: "14px",
      }}
    >
      {label}
    </button>
  );
}

const CORNER_DOT_POSITIONS: Record<StartCorner, { cx: number; cy: number }> = {
  topLeft: { cx: 2, cy: 2 },
  topRight: { cx: 18, cy: 2 },
  bottomLeft: { cx: 2, cy: 18 },
  bottomRight: { cx: 18, cy: 18 },
  center: { cx: 10, cy: 10 },
};

const CORNER_LABELS: Record<StartCorner, string> = {
  topLeft: "Top Left",
  topRight: "Top Right",
  bottomLeft: "Bottom Left",
  bottomRight: "Bottom Right",
  center: "Center",
};

function StartCornerButton({
  corner,
  active,
  onClick,
}: {
  corner: StartCorner;
  active: StartCorner;
  onClick: (c: StartCorner) => void;
}) {
  const isActive = active === corner;
  const dot = CORNER_DOT_POSITIONS[corner];

  return (
    <button
      onClick={() => onClick(corner)}
      aria-label={CORNER_LABELS[corner]}
      style={{
        width: "32px",
        height: "32px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        border: isActive ? "1px solid var(--accent)" : "1px solid var(--border)",
        background: isActive ? "rgba(74,144,226,0.15)" : "var(--bg-input)",
        fontSize: 0,
        transition: "background 100ms ease, border-color 100ms ease",
        color: isActive ? "var(--accent)" : "var(--text-muted)",
      }}
      onMouseEnter={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = "var(--bg-input)";
          e.currentTarget.style.borderColor = "var(--border)";
        }
      }}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect x="2" y="2" width="16" height="16" rx="1"
          stroke="currentColor" strokeWidth="1" fill="none" />
        <circle cx={dot.cx} cy={dot.cy} r="2" fill="currentColor" />
      </svg>
    </button>
  );
}

function ActionButton({ label, color, onClick, disabled }: { label: string; color: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "4px 8px",
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${color}33`,
        background: `${color}15`,
        color,
        fontSize: "10px",
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        textTransform: "uppercase",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {label}
    </button>
  );
}
