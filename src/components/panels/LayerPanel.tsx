import { useState } from "react";
import { useStore } from "../../app/store";
import type { Layer, CutMode } from "../../app/types";

const inputStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
  padding: "3px 6px",
  fontSize: "11px",
  width: "100%",
  outline: "none",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: "none",
  cursor: "pointer",
  paddingRight: "16px",
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%23999'/%3E%3C/svg%3E")`,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 4px center",
};

export function LayerPanel() {
  const layers = useStore((s) => s.layers);
  const activeLayerIndex = useStore((s) => s.activeLayerIndex);
  const setActiveLayerIndex = useStore((s) => s.setActiveLayerIndex);
  const updateLayer = useStore((s) => s.updateLayer);

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        maxHeight: "50%",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          fontSize: "11px",
          fontWeight: 600,
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        Cut Layers
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        {layers.map((layer) => (
          <LayerRow
            key={layer.index}
            layer={layer}
            active={layer.index === activeLayerIndex}
            onClick={() => setActiveLayerIndex(layer.index)}
            onUpdate={(partial) => updateLayer(layer.index, partial)}
          />
        ))}
      </div>
    </div>
  );
}

function LayerRow({
  layer,
  active,
  onClick,
  onUpdate,
}: {
  layer: Layer;
  active: boolean;
  onClick: () => void;
  onUpdate: (partial: Partial<Layer>) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        borderLeft: `3px solid ${layer.color}`,
        transition: "background 0.1s",
      }}
    >
      {/* Header row */}
      <div
        onClick={onClick}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "5px 8px 5px 8px",
          background: active ? "var(--bg-active)" : "transparent",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.background = "transparent";
        }}
      >
        {/* Expand toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          style={{
            background: "none", border: "none", color: "var(--text-muted)",
            cursor: "pointer", padding: "0", fontSize: "10px", width: "12px",
          }}
        >
          {expanded ? "\u25BC" : "\u25B6"}
        </button>

        {/* Color swatch */}
        <div
          style={{
            width: "10px", height: "10px", borderRadius: "2px",
            background: layer.color, flexShrink: 0,
          }}
        />

        {/* Name */}
        <span style={{
          flex: 1, fontSize: "11px",
          color: layer.visible ? "var(--text-primary)" : "var(--text-muted)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {layer.name}
        </span>

        {/* Mode badge */}
        <span style={{
          fontSize: "9px", padding: "1px 4px", borderRadius: "3px",
          background: layer.mode === "fill" ? "rgba(226,74,74,0.2)" :
                      layer.mode === "offsetFill" ? "rgba(226,165,74,0.2)" :
                      "rgba(74,144,226,0.2)",
          color: layer.mode === "fill" ? "#e28a8a" :
                 layer.mode === "offsetFill" ? "#e2c08a" :
                 "#8ab4e2",
          textTransform: "uppercase", fontWeight: 600,
        }}>
          {layer.mode === "offsetFill" ? "offset" : layer.mode}
        </span>

        {/* Compact power/speed readout */}
        <span style={{ fontSize: "9px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
          {layer.power}% {layer.speed}mm/s
        </span>

        {/* Visibility */}
        <IconButton
          onClick={() => onUpdate({ visible: !layer.visible })}
          title={layer.visible ? "Hide" : "Show"}
          active={layer.visible}
        >
          {layer.visible ? (
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
              <path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
              <circle cx="7" cy="7" r="2" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
              <path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
              <line x1="2" y1="2" x2="12" y2="12" />
            </svg>
          )}
        </IconButton>
      </div>

      {/* Expanded settings */}
      {expanded && (
        <div style={{
          padding: "6px 8px 8px 24px",
          background: active ? "var(--bg-active)" : "rgba(0,0,0,0.15)",
          display: "flex", flexDirection: "column", gap: "6px",
        }}>
          {/* Mode */}
          <SettingRow label="Mode">
            <select
              value={layer.mode}
              onChange={(e) => onUpdate({ mode: e.target.value as CutMode })}
              style={selectStyle}
            >
              <option value="line">Line (Vector Cut)</option>
              <option value="fill">Fill (Raster Engrave)</option>
              <option value="offsetFill">Offset Fill</option>
            </select>
          </SettingRow>

          {/* Power */}
          <SettingRow label="Power">
            <div style={{ display: "flex", alignItems: "center", gap: "4px", width: "100%" }}>
              <input
                type="range" min="0" max="100" value={layer.power}
                onChange={(e) => onUpdate({ power: Number(e.target.value) })}
                style={{ flex: 1, accentColor: "var(--accent-warm)" }}
              />
              <input
                type="number" min="0" max="100" value={layer.power}
                onChange={(e) => onUpdate({ power: Math.max(0, Math.min(100, Number(e.target.value))) })}
                style={{ ...inputStyle, width: "42px", textAlign: "right" }}
              />
              <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>%</span>
            </div>
          </SettingRow>

          {/* Min Power */}
          <SettingRow label="Min Pwr">
            <div style={{ display: "flex", alignItems: "center", gap: "4px", width: "100%" }}>
              <input
                type="range" min="0" max="100" value={layer.powerMin}
                onChange={(e) => onUpdate({ powerMin: Number(e.target.value) })}
                style={{ flex: 1, accentColor: "var(--accent-warm)" }}
              />
              <input
                type="number" min="0" max="100" value={layer.powerMin}
                onChange={(e) => onUpdate({ powerMin: Math.max(0, Math.min(100, Number(e.target.value))) })}
                style={{ ...inputStyle, width: "42px", textAlign: "right" }}
              />
              <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>%</span>
            </div>
          </SettingRow>

          {/* Speed */}
          <SettingRow label="Speed">
            <div style={{ display: "flex", alignItems: "center", gap: "4px", width: "100%" }}>
              <input
                type="range" min="1" max="1000" value={layer.speed}
                onChange={(e) => onUpdate({ speed: Number(e.target.value) })}
                style={{ flex: 1, accentColor: "var(--accent)" }}
              />
              <input
                type="number" min="1" max="10000" value={layer.speed}
                onChange={(e) => onUpdate({ speed: Math.max(1, Number(e.target.value)) })}
                style={{ ...inputStyle, width: "50px", textAlign: "right" }}
              />
              <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>mm/s</span>
            </div>
          </SettingRow>

          {/* Passes */}
          <SettingRow label="Passes">
            <input
              type="number" min="1" max="100" value={layer.passes}
              onChange={(e) => onUpdate({ passes: Math.max(1, Number(e.target.value)) })}
              style={{ ...inputStyle, width: "50px", textAlign: "right" }}
            />
          </SettingRow>

          {/* Power mode */}
          <SettingRow label="Power Mode">
            <select
              value={layer.powerMode}
              onChange={(e) => onUpdate({ powerMode: e.target.value as "constant" | "variable" })}
              style={selectStyle}
            >
              <option value="constant">Constant (M3)</option>
              <option value="variable">Variable (M4)</option>
            </select>
          </SettingRow>

          {/* Fill-specific settings */}
          {(layer.mode === "fill" || layer.mode === "offsetFill") && (
            <>
              <SettingRow label="Interval">
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <input
                    type="number" min="0.01" max="5" step="0.01" value={layer.interval}
                    onChange={(e) => onUpdate({ interval: Math.max(0.01, Number(e.target.value)) })}
                    style={{ ...inputStyle, width: "60px", textAlign: "right" }}
                  />
                  <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>mm</span>
                </div>
              </SettingRow>

              <SettingRow label="Dither">
                <select
                  value={layer.dither}
                  onChange={(e) => onUpdate({ dither: e.target.value as Layer["dither"] })}
                  style={selectStyle}
                >
                  <option value="threshold">Threshold</option>
                  <option value="ordered">Ordered</option>
                  <option value="floydSteinberg">Floyd-Steinberg</option>
                  <option value="jarvis">Jarvis</option>
                  <option value="stucki">Stucki</option>
                  <option value="grayscale">Grayscale</option>
                </select>
              </SettingRow>
            </>
          )}

          {/* Toggles row */}
          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "2px", flexWrap: "wrap" }}>
            <ToggleChip label="Air Assist" active={layer.airAssist} onClick={() => onUpdate({ airAssist: !layer.airAssist })} />
            <ToggleChip label="Inner First" active={layer.cutInnerFirst} onClick={() => onUpdate({ cutInnerFirst: !layer.cutInnerFirst })} />
            <ToggleChip label="Lock" active={layer.locked} onClick={() => onUpdate({ locked: !layer.locked })} />
            {(layer.mode === "fill" || layer.mode === "offsetFill") && (
              <>
                <ToggleChip label="Bidir" active={layer.bidirectional} onClick={() => onUpdate({ bidirectional: !layer.bidirectional })} />
                <ToggleChip label="Cross" active={layer.crossHatch} onClick={() => onUpdate({ crossHatch: !layer.crossHatch })} />
              </>
            )}
          </div>

          {/* Advanced settings */}
          <AdvancedSettings layer={layer} onUpdate={onUpdate} />
        </div>
      )}
    </div>
  );
}

function AdvancedSettings({ layer, onUpdate }: { layer: Layer; onUpdate: (partial: Partial<Layer>) => void }) {
  const [showAdv, setShowAdv] = useState(false);
  return (
    <div>
      <button
        onClick={() => setShowAdv(!showAdv)}
        style={{
          background: "none", border: "none", color: "var(--text-muted)",
          fontSize: "9px", cursor: "pointer", padding: "2px 0", textTransform: "uppercase",
        }}
      >
        {showAdv ? "\u25BC" : "\u25B6"} Advanced
      </button>
      {showAdv && (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" }}>
          {layer.mode === "line" && (
            <>
              <SettingRow label="Overcut">
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <input type="number" min="0" max="10" step="0.1" value={layer.overcut}
                    onChange={(e) => onUpdate({ overcut: Math.max(0, Number(e.target.value)) })}
                    style={{ ...inputStyle, width: "50px", textAlign: "right" }}
                  />
                  <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>mm</span>
                </div>
              </SettingRow>
              <SettingRow label="Lead-In">
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <input type="number" min="0" max="20" step="0.5" value={layer.leadIn}
                    onChange={(e) => onUpdate({ leadIn: Math.max(0, Number(e.target.value)) })}
                    style={{ ...inputStyle, width: "50px", textAlign: "right" }}
                  />
                  <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>mm</span>
                </div>
              </SettingRow>
              <SettingRow label="Lead-Out">
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <input type="number" min="0" max="20" step="0.5" value={layer.leadOut}
                    onChange={(e) => onUpdate({ leadOut: Math.max(0, Number(e.target.value)) })}
                    style={{ ...inputStyle, width: "50px", textAlign: "right" }}
                  />
                  <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>mm</span>
                </div>
              </SettingRow>
              <SettingRow label="Tabs">
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <input type="number" min="0" max="100" step="5" value={layer.tabSpacing}
                    onChange={(e) => onUpdate({ tabSpacing: Math.max(0, Number(e.target.value)) })}
                    style={{ ...inputStyle, width: "40px", textAlign: "right" }}
                  />
                  <span style={{ fontSize: "9px", color: "var(--text-muted)" }}>gap</span>
                  <input type="number" min="0.5" max="10" step="0.5" value={layer.tabWidth}
                    onChange={(e) => onUpdate({ tabWidth: Math.max(0.5, Number(e.target.value)) })}
                    style={{ ...inputStyle, width: "35px", textAlign: "right" }}
                  />
                  <span style={{ fontSize: "9px", color: "var(--text-muted)" }}>w</span>
                </div>
              </SettingRow>
            </>
          )}
          {(layer.mode === "fill" || layer.mode === "offsetFill") && (
            <>
              <SettingRow label="Overscan">
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <input type="number" min="0" max="20" step="0.5" value={layer.overscan}
                    onChange={(e) => onUpdate({ overscan: Math.max(0, Number(e.target.value)) })}
                    style={{ ...inputStyle, width: "50px", textAlign: "right" }}
                  />
                  <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>mm</span>
                </div>
              </SettingRow>
              <SettingRow label="Scan Offset">
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <input type="number" min="-5" max="5" step="0.01" value={layer.scanningOffset}
                    onChange={(e) => onUpdate({ scanningOffset: Number(e.target.value) })}
                    style={{ ...inputStyle, width: "50px", textAlign: "right" }}
                  />
                  <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>mm</span>
                </div>
              </SettingRow>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
      <span style={{
        fontSize: "10px", color: "var(--text-muted)", minWidth: "50px",
        textTransform: "uppercase", letterSpacing: "0.3px",
      }}>
        {label}
      </span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function ToggleChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        padding: "2px 6px", borderRadius: "3px", fontSize: "9px",
        fontWeight: 600, textTransform: "uppercase", cursor: "pointer",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "rgba(74,144,226,0.15)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-muted)",
      }}
    >
      {label}
    </button>
  );
}

function IconButton({
  onClick, title, active, children,
}: {
  onClick: () => void; title: string; active: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      style={{
        background: "none", border: "none",
        color: active ? "var(--text-secondary)" : "var(--text-muted)",
        cursor: "pointer", padding: "1px", lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}
