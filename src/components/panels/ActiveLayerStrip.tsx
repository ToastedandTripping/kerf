/**
 * ActiveLayerStrip — pinned-top ~40px strip showing the active layer's
 * color, name, Power slider+value, and Speed bare number field.
 *
 * Error-185 audit:
 *   - layers: stable array ref (Zustand returns the same reference until
 *     the layers array changes, not a new array literal each render)
 *   - activeLayerIndex: scalar
 *   - updateLayer: stable function ref
 *   Derivation of `active` happens OUTSIDE the selectors, after all three
 *   reads, mirroring the LayerPanel.tsx:30-33 pattern exactly.
 *   Speed uses a bare number field (no log-scale slider) — the full
 *   SpeedInput is too wide for the compact strip; it remains in LayerPanel.
 */

import { useStore } from "../../app/store";

export function ActiveLayerStrip() {
  // SEPARATE scalar/stable-ref selectors — no object literal returned (Error-185 safe)
  const layers = useStore((s) => s.layers);
  const activeLayerIndex = useStore((s) => s.activeLayerIndex);
  const updateLayer = useStore((s) => s.updateLayer);

  // Derive active layer OUTSIDE the selector
  const active = layers.find((l) => l.index === activeLayerIndex);
  if (!active) return null;

  function handlePowerChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = Math.max(0, Math.min(100, Number(e.target.value)));
    // Clear activePreset when user manually changes cut settings (mirrors LayerPanel.tsx:123-129)
    updateLayer(active!.index, { power: val, activePreset: undefined });
  }

  function handleSpeedChange(v: number) {
    updateLayer(active!.index, { speed: v, activePreset: undefined });
  }

  return (
    <div
      style={{
        flexShrink: 0,
        borderBottom: "1px solid var(--border)",
        padding: "6px 8px",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
      }}
    >
      {/* Row 1: color swatch + truncated name */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
        <div
          style={{
            width: "10px",
            height: "10px",
            borderRadius: "2px",
            background: active.color,
            flexShrink: 0,
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.15)",
          }}
        />
        <span
          style={{
            flex: 1,
            fontSize: "11px",
            fontWeight: 600,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {active.name}
        </span>
      </div>

      {/* Row 2: Power label + slider + value */}
      <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        <span
          style={{ fontSize: "10px", color: "var(--text-muted)", flexShrink: 0, width: "38px" }}
        >
          Power
        </span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={active.power}
          onChange={handlePowerChange}
          style={{ flex: 1, accentColor: "var(--accent)" }}
        />
        <input
          type="number"
          min="0"
          max="100"
          value={active.power}
          onChange={handlePowerChange}
          style={{
            width: "40px",
            background: "var(--bg-input)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-primary)",
            padding: "2px 4px",
            fontSize: "11px",
            textAlign: "right",
          }}
        />
        <span style={{ fontSize: "10px", color: "var(--text-muted)", flexShrink: 0 }}>%</span>
      </div>

      {/* Row 3: Speed label + bare number field + unit (full SpeedInput too wide for strip) */}
      <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        <span
          style={{ fontSize: "10px", color: "var(--text-muted)", flexShrink: 0, width: "38px" }}
        >
          Speed
        </span>
        <input
          type="number"
          min="1"
          value={active.speed}
          onChange={(e) => handleSpeedChange(Number(e.target.value))}
          style={{
            flex: 1,
            background: "var(--bg-input)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-primary)",
            padding: "2px 4px",
            fontSize: "11px",
            textAlign: "right",
          }}
        />
        <span style={{ fontSize: "10px", color: "var(--text-muted)", flexShrink: 0 }}>mm/min</span>
      </div>
    </div>
  );
}
