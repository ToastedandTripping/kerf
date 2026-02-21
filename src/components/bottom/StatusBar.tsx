import { useStore } from "../../app/store";

const stateColors: Record<string, string> = {
  idle: "var(--success)",
  run: "var(--accent)",
  hold: "var(--accent-warm)",
  alarm: "var(--danger)",
  disconnected: "var(--text-muted)",
};

export function StatusBar() {
  const cursorPosition = useStore((s) => s.cursorPosition);
  const camera = useStore((s) => s.camera);
  const objects = useStore((s) => s.objects);
  const selectedIds = useStore((s) => s.selectedIds);
  const gridVisible = useStore((s) => s.gridVisible);
  const snapToGrid = useStore((s) => s.snapToGrid);
  const machineState = useStore((s) => s.machineState);
  const showConsole = useStore((s) => s.showConsole);
  const setShowConsole = useStore((s) => s.setShowConsole);

  return (
    <div
      style={{
        height: "var(--statusbar-height)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "var(--bg-panel)",
        borderTop: "1px solid var(--border)",
        padding: "0 12px",
        fontSize: "11px",
        color: "var(--text-secondary)",
        gap: "16px",
      }}
    >
      <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
        {/* Machine status */}
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{
            width: "6px", height: "6px", borderRadius: "50%",
            background: stateColors[machineState],
          }} />
          <span style={{ textTransform: "capitalize", color: stateColors[machineState] }}>
            {machineState}
          </span>
        </span>

        <span style={{ color: "var(--border)" }}>|</span>

        <span>
          {objects.length} obj{objects.length !== 1 ? "s" : ""}
          {selectedIds.length > 0 && ` / ${selectedIds.length} sel`}
        </span>
        <Indicator label="Grid" active={gridVisible} />
        <Indicator label="Snap" active={snapToGrid} />

        {/* Console toggle */}
        <button
          onClick={() => setShowConsole(!showConsole)}
          style={{
            background: showConsole ? "rgba(74,144,226,0.15)" : "none",
            border: `1px solid ${showConsole ? "var(--accent)" : "var(--border)"}`,
            borderRadius: "3px",
            color: showConsole ? "var(--accent)" : "var(--text-muted)",
            fontSize: "9px",
            fontWeight: 600,
            padding: "1px 6px",
            cursor: "pointer",
            textTransform: "uppercase",
          }}
        >
          Console
        </button>
      </div>
      <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
        <span>Zoom: {Math.round(camera.zoom * 100)}%</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}>
          X: {cursorPosition.x.toFixed(1)} &nbsp; Y: {cursorPosition.y.toFixed(1)} mm
        </span>
      </div>
    </div>
  );
}

function Indicator({ label, active }: { label: string; active: boolean }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
      <span style={{
        width: "6px", height: "6px", borderRadius: "50%",
        background: active ? "var(--success)" : "var(--text-muted)",
      }} />
      {label}
    </span>
  );
}
