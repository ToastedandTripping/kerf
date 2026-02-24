import { useState, useEffect, useCallback } from "react";
import { useStore } from "../../app/store";
import { machineConnection } from "../../lib/machine/connection";
import { generateGcode } from "../../lib/machine/gcodeGen";
import type { DesignObject } from "../../app/types";

/** Compute bounding box of all visible, unlocked design objects */
function getDesignBounds(objects: DesignObject[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let count = 0;
  for (const obj of flattenAll(objects)) {
    if (!obj.visible || obj.locked) continue;
    if (obj.type === "group") continue;
    minX = Math.min(minX, obj.transform.x);
    minY = Math.min(minY, obj.transform.y);
    maxX = Math.max(maxX, obj.transform.x + obj.transform.width);
    maxY = Math.max(maxY, obj.transform.y + obj.transform.height);
    count++;
  }
  return count > 0 ? { minX, minY, maxX, maxY } : null;
}

/** Recursively flatten groups */
function flattenAll(objects: DesignObject[]): DesignObject[] {
  const result: DesignObject[] = [];
  for (const obj of objects) {
    if (obj.type === "group" && obj.children) {
      for (const child of obj.children) {
        result.push(...flattenAll([{
          ...child,
          transform: {
            ...child.transform,
            x: child.transform.x + obj.transform.x,
            y: child.transform.y + obj.transform.y,
          },
        }]));
      }
    } else {
      result.push(obj);
    }
  }
  return result;
}

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

  const [selectedPort, setSelectedPort] = useState("");
  const [ports, setPorts] = useState<Array<{ name: string; portType: string }>>([]);
  const [jogStep, setJogStep] = useState(10);
  const [expanded, setExpanded] = useState(true);
  const [generating, setGenerating] = useState(false);

  // Scan for serial ports
  const refreshPorts = useCallback(async () => {
    const found = await machineConnection.listPorts();
    setPorts(found);
  }, []);

  useEffect(() => {
    refreshPorts();
  }, [refreshPorts]);

  async function handleConnect() {
    if (machineConnected) {
      await machineConnection.disconnect();
    } else {
      if (!selectedPort) {
        addConsoleLine("No port selected", "error");
        return;
      }
      try {
        await machineConnection.connect(selectedPort);
        await machineConnection.queryGrblSettings();
        await machineConnection.pollStatus();
        // Warn if laser mode is disabled
        if (!useStore.getState().grblLaserMode) {
          addConsoleLine(
            "GRBL laser mode ($32) is disabled. Laser will not auto-zero at speed changes. Run $32=1 in the console to enable.",
            "warning",
          );
        }
      } catch {
        // Error already logged by connection module
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
    if (!gcodeResult) {
      addConsoleLine("Generate G-code first", "error");
      return;
    }

    // Pre-flight bounds check
    const { objects, workspaceWidth, workspaceHeight } = useStore.getState();
    const bounds = getDesignBounds(objects);
    if (bounds) {
      if (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > workspaceWidth || bounds.maxY > workspaceHeight) {
        addConsoleLine(
          "Design extends outside workspace bounds. Move or resize objects to fit.",
          "error",
        );
        return;
      }
    }

    setJobRunning(true);
    setJobProgress(0);
    addConsoleLine("Sending job...", "info");

    const lines = gcodeResult.gcode
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith(";"));

    let jobError = false;

    for (let i = 0; i < lines.length; i++) {
      if (!useStore.getState().jobRunning) {
        addConsoleLine("Job cancelled", "error");
        jobError = true;
        break;
      }
      // Wait while paused
      while (useStore.getState().machineState === "hold") {
        await new Promise((r) => setTimeout(r, 100));
      }
      const responses = await machineConnection.send(lines[i]);
      setJobProgress((i + 1) / lines.length);

      // Check for errors
      if (responses.some((r) => r.startsWith("error:"))) {
        addConsoleLine("Job stopped due to error", "error");
        jobError = true;
        // Detect disconnect
        if (responses.some((r) => r === "error:disconnected")) {
          useStore.getState().setMachineConnected(false);
          useStore.getState().setMachineState("disconnected");
        }
        break;
      }
    }

    // Safety: ensure laser is off on abort/error
    if (jobError) {
      try { await machineConnection.send("M5"); } catch { /* port may be gone */ }
      try { await machineConnection.softReset(); } catch { /* port may be gone */ }
      addConsoleLine("Job aborted", "error");
    } else {
      addConsoleLine("Job complete", "info");
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

  const stateColors: Record<string, string> = {
    idle: "var(--success)",
    run: "var(--accent)",
    hold: "var(--accent-warm)",
    alarm: "var(--danger)",
    disconnected: "var(--text-muted)",
  };

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div
        onClick={() => setExpanded(!expanded)}
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
            background: stateColors[machineState],
            marginLeft: "auto",
          }}
        />
        <span style={{ fontSize: "9px", color: stateColors[machineState], fontWeight: 400, textTransform: "capitalize" }}>
          {machineState}
        </span>
      </div>

      {expanded && (
        <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: "8px" }}>
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
                outline: "none",
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
              label="Frame"
              color="var(--accent)"
              disabled={!machineConnected || machineState !== "idle" || jobRunning}
              onClick={async () => {
                const bounds = getDesignBounds(useStore.getState().objects);
                if (!bounds) {
                  addConsoleLine("No objects to frame", "error");
                  return;
                }
                const { workspaceHeight } = useStore.getState();
                const y0 = workspaceHeight - bounds.maxY;
                const y1 = workspaceHeight - bounds.minY;
                await machineConnection.send(`G0 X${bounds.minX.toFixed(3)} Y${y0.toFixed(3)}`);
                await machineConnection.send(`G0 X${bounds.maxX.toFixed(3)} Y${y0.toFixed(3)}`);
                await machineConnection.send(`G0 X${bounds.maxX.toFixed(3)} Y${y1.toFixed(3)}`);
                await machineConnection.send(`G0 X${bounds.minX.toFixed(3)} Y${y1.toFixed(3)}`);
                await machineConnection.send(`G0 X${bounds.minX.toFixed(3)} Y${y0.toFixed(3)}`);
              }}
            />
            <ActionButton
              label="Fire"
              color="var(--accent-warm)"
              disabled={!machineConnected || machineState !== "idle" || jobRunning}
              onClick={async () => {
                const sVal = Math.round(5 / 1000 * useStore.getState().grblSValueMax);
                await machineConnection.send(`M3 S${sVal}\nG4 P0.5\nM5`);
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

          {/* Generate + Preview buttons */}
          <div style={{ display: "flex", gap: "4px" }}>
            <button
              onClick={handleGenerateGcode}
              disabled={generating}
              style={{
                flex: 1,
                padding: "5px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--accent)33",
                fontSize: "10px",
                fontWeight: 600,
                cursor: "pointer",
                background: "rgba(74,144,226,0.1)",
                color: "var(--accent)",
                textTransform: "uppercase",
                opacity: generating ? 0.5 : 1,
              }}
            >
              {generating ? "Generating..." : "Generate G-code"}
            </button>
            <button
              onClick={() => {
                if (!gcodeResult) handleGenerateGcode().then(() => setPreviewVisible(true));
                else setPreviewVisible(true);
              }}
              style={{
                padding: "5px 10px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--accent-warm)33",
                fontSize: "10px",
                fontWeight: 600,
                cursor: "pointer",
                background: "rgba(196,165,123,0.1)",
                color: "var(--accent-warm)",
                textTransform: "uppercase",
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
            <div style={{ background: "var(--bg-input)", borderRadius: "var(--radius-sm)", height: "4px", overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: `${jobProgress * 100}%`,
                background: "var(--accent)",
                transition: "width 0.3s",
              }} />
            </div>
          )}

          {/* Start / Stop controls */}
          <div style={{ display: "flex", gap: "4px" }}>
            <button
              onClick={handleStartJob}
              disabled={!machineConnected || jobRunning || !gcodeResult}
              style={{
                flex: 1,
                padding: "6px",
                borderRadius: "var(--radius-sm)",
                border: "none",
                fontSize: "11px",
                fontWeight: 700,
                cursor: machineConnected && gcodeResult && !jobRunning ? "pointer" : "not-allowed",
                background: "rgba(74,226,138,0.2)",
                color: "var(--success)",
                opacity: !machineConnected || jobRunning || !gcodeResult ? 0.4 : 1,
              }}
            >
              START
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
                cursor: machineConnected ? "pointer" : "not-allowed",
                background: "rgba(226,74,74,0.2)",
                color: "var(--danger)",
                opacity: !machineConnected ? 0.4 : 1,
              }}
            >
              STOP
            </button>
          </div>
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
