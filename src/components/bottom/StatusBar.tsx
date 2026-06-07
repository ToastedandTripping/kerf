import { useSyncExternalStore } from "react";
import { useStore } from "../../app/store";
import { subscribeCursorPosition, getCursorPosition } from "../../app/store";
import { MACHINE_STATE_COLORS, MACHINE_STATE_LABELS } from "../../lib/machine/machineStateDisplay";

export function StatusBar() {
  // P4: Cursor position via useSyncExternalStore (removed from Zustand)
  const cursorPosition = useSyncExternalStore(subscribeCursorPosition, getCursorPosition);
  const camera = useStore((s) => s.camera);
  const objects = useStore((s) => s.objects);
  const selectedIds = useStore((s) => s.selectedIds);
  const gridVisible = useStore((s) => s.gridVisible);
  const snapToGrid = useStore((s) => s.snapToGrid);
  const machineState = useStore((s) => s.machineState);
  const statusMessage = useStore((s) => s.statusMessage);
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
            background: MACHINE_STATE_COLORS[machineState] ?? "var(--text-muted)",
          }} />
          <span style={{ color: MACHINE_STATE_COLORS[machineState] ?? "var(--text-muted)" }}>
            {MACHINE_STATE_LABELS[machineState] ?? machineState}
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

        {/* Transient status message */}
        {statusMessage && (
          <span style={{
            color: "var(--accent)",
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "300px",
          }}>
            {statusMessage}
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <ZoomButton label="Fit" onClick={() => useStore.getState().zoomToFitAll()} />
        <ZoomButton label="100%" onClick={() => useStore.getState().setCamera({ zoom: 1 })} />
        <span style={{ minWidth: "44px", textAlign: "right" }}>{Math.round(camera.zoom * 100)}%</span>
        <span style={{ color: "var(--border)" }}>|</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}>
          X: {cursorPosition.x.toFixed(1)} &nbsp; Y: {cursorPosition.y.toFixed(1)} mm
        </span>
        <span style={{ color: "var(--border)" }}>|</span>
        <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>? shortcuts</span>
      </div>
    </div>
  );
}

function ZoomButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "none", border: "1px solid var(--border)",
        borderRadius: "3px", color: "var(--text-muted)", fontSize: "9px",
        fontWeight: 600, padding: "1px 6px", cursor: "pointer",
      }}
    >
      {label}
    </button>
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
