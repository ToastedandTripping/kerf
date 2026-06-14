import { useState, useRef } from "react";
import { useShallow } from "zustand/shallow";
import { useStore } from "../../app/store";
import type { Layer, CutMode, SubLayer, MaterialPreset } from "../../app/types";
import { PowerCurveEditor, PowerCurveThumbnail } from "./PowerCurveEditor";
import type { CurvePoint } from "./PowerCurveEditor";

const inputStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
  padding: "3px 6px",
  fontSize: "11px",
  width: "100%",
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
  const reorderLayers = useStore((s) => s.reorderLayers);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragSourceRef = useRef<number | null>(null);

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
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>Cut Layers</span>
        <span style={{ fontSize: "9px", color: "var(--text-muted)", fontWeight: 400 }}>drag to reorder</span>
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        {layers.map((layer, pos) => (
          <div
            key={layer.index}
            draggable
            onDragStart={() => { dragSourceRef.current = layer.index; }}
            onDragOver={(e) => { e.preventDefault(); setDragOverIndex(layer.index); }}
            onDragLeave={() => setDragOverIndex(null)}
            onDrop={() => {
              if (dragSourceRef.current !== null && dragSourceRef.current !== layer.index) {
                reorderLayers(dragSourceRef.current, layer.index);
              }
              dragSourceRef.current = null;
              setDragOverIndex(null);
            }}
            onDragEnd={() => { dragSourceRef.current = null; setDragOverIndex(null); }}
            style={{
              borderTop: dragOverIndex === layer.index ? "2px solid var(--accent, #4a90e2)" : "2px solid transparent",
            }}
          >
            <LayerRow
              layer={layer}
              position={pos + 1}
              active={layer.index === activeLayerIndex}
              onClick={() => setActiveLayerIndex(layer.index)}
              onUpdate={(partial) => updateLayer(layer.index, partial)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function LayerRow({
  layer,
  position,
  active,
  onClick,
  onUpdate,
}: {
  layer: Layer;
  position: number;
  active: boolean;
  onClick: () => void;
  onUpdate: (partial: Partial<Layer>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [curveEditorOpen, setCurveEditorOpen] = useState(false);
  const addSubLayer = useStore((s) => s.addSubLayer);
  const addSubLayers = useStore((s) => s.addSubLayers);
  const removeSubLayer = useStore((s) => s.removeSubLayer);
  const updateSubLayer = useStore((s) => s.updateSubLayer);
  const layerObjects = useStore(useShallow((s) => s.objects.filter((o) => o.layerIndex === layer.index)));
  const selectedSet = useStore((s) => s.selectedSet);
  const setSelectedIds = useStore((s) => s.setSelectedIds);
  const addToSelection = useStore((s) => s.addToSelection);

  // Clear activePreset when user manually changes cut settings
  const onManualUpdate = (partial: Partial<Layer>) => {
    if (!("activePreset" in partial)) {
      onUpdate({ ...partial, activePreset: undefined });
    } else {
      onUpdate(partial);
    }
  };

  // U7: Highlight layer if any selected object belongs to it
  const hasSelectedObject = useStore((s) =>
    s.selectedIds.some((id) => s.objectsById.get(id)?.layerIndex === layer.index)
  );

  const hasSubLayers = (layer.subLayers?.length ?? 0) > 0;
  const defaultCurve: CurvePoint[] = [{ x: 0, y: 100 }, { x: 255, y: 0 }];

  return (
    <div
      style={{
        borderLeft: `3px solid ${layer.color}`,
        transition: "background 0.1s",
        background: hasSelectedObject && !active ? "rgba(74,144,226,0.06)" : undefined,
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
          aria-expanded={expanded}
          aria-label={`${layer.name} settings`}
          style={{
            background: "none", border: "none", color: "var(--text-muted)",
            cursor: "pointer", padding: "0", fontSize: "10px", width: "12px",
          }}
        >
          {expanded ? "\u25BC" : "\u25B6"}
        </button>

        {/* Cut order number */}
        <span style={{ fontSize: "9px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", width: "12px", textAlign: "center" }}>
          {position}
        </span>

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

        {layerObjects.length > 0 && (
          <span style={{ fontSize: "9px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", minWidth: "14px", textAlign: "center" }}>
            {layerObjects.length}
          </span>
        )}

        {/* Mode badge -- show sub-layer count if present, otherwise current mode */}
        {hasSubLayers ? (
          <span style={{
            fontSize: "9px", padding: "1px 4px", borderRadius: "3px",
            background: "rgba(226,165,74,0.2)",
            color: "#e2c08a",
            textTransform: "uppercase", fontWeight: 600,
          }}>
            {layer.subLayers!.length} ops
          </span>
        ) : (
          <span style={{
            fontSize: "9px", padding: "1px 4px", borderRadius: "3px",
            background: layer.mode === "fill" ? "rgba(226,74,74,0.2)"
              : layer.mode === "offsetFill" ? "rgba(74,226,138,0.2)"
              : "rgba(74,144,226,0.2)",
            color: layer.mode === "fill" ? "#e28a8a"
              : layer.mode === "offsetFill" ? "#8ae2b4"
              : "#8ab4e2",
            textTransform: "uppercase", fontWeight: 600,
          }}>
            {layer.mode === "offsetFill" ? "offset" : layer.mode}
          </span>
        )}

        {/* Compact power/speed readout */}
        <span style={{ fontSize: "9px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
          {layer.power}% {layer.speed}mm/s
        </span>

        {/* Output toggle */}
        <IconButton
          onClick={() => onUpdate({ output: !layer.output })}
          title={layer.output ? "Disable output (won't cut)" : "Enable output"}
          active={layer.output}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
            {layer.output ? (
              <path d="M7 2v8M3 6l4 4 4-4" />
            ) : (
              <><path d="M7 2v8M3 6l4 4 4-4" opacity="0.3" /><line x1="2" y1="2" x2="12" y2="12" /></>
            )}
          </svg>
        </IconButton>

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
          {/* Objects on this layer */}
          {layerObjects.length > 0 && (
            <div style={{ marginBottom: "2px" }}>
              <div style={{ fontSize: "9px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.3px", marginBottom: "4px" }}>
                Objects ({layerObjects.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
                {layerObjects.map((obj) => (
                  <button
                    key={obj.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (e.shiftKey) { addToSelection(obj.id); } else { setSelectedIds([obj.id]); }
                    }}
                    style={{
                      display: "flex", alignItems: "center", gap: "6px",
                      padding: "3px 6px", fontSize: "10px",
                      background: selectedSet.has(obj.id) ? "rgba(74,144,226,0.15)" : "transparent",
                      border: "none", color: selectedSet.has(obj.id) ? "var(--text-primary)" : "var(--text-secondary)",
                      cursor: "pointer", borderRadius: "var(--radius-sm)",
                      textAlign: "left", width: "100%",
                    }}
                  >
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{obj.name}</span>
                    <span style={{ fontSize: "8px", color: "var(--text-muted)", textTransform: "uppercase" }}>{obj.type}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Material Preset Quick-Apply */}
          <PresetQuickApply layer={layer} onUpdate={onManualUpdate} />

          {/* Sub-layers section -- replaces main cut controls when sub-layers exist */}
          {hasSubLayers ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {layer.subLayers!.map((sub, i) => (
                <SubLayerRow
                  key={sub.id}
                  sub={sub}
                  index={i}
                  layerColor={layer.color}
                  onUpdate={(changes) => updateSubLayer(layer.index, sub.id, changes)}
                  onRemove={() => removeSubLayer(layer.index, sub.id)}
                />
              ))}
            </div>
          ) : (
            <>
              {/* Mode */}
              <SettingRow label="Mode">
                <select
                  value={layer.mode}
                  onChange={(e) => onManualUpdate({ mode: e.target.value as CutMode })}
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
                    onChange={(e) => onManualUpdate({ power: Number(e.target.value) })}
                    style={{ flex: 1, accentColor: "var(--accent-warm)" }}
                  />
                  <input
                    type="number" min="0" max="100" value={layer.power}
                    onChange={(e) => onManualUpdate({ power: Math.max(0, Math.min(100, Number(e.target.value))) })}
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
                    onChange={(e) => onManualUpdate({ powerMin: Number(e.target.value) })}
                    style={{ flex: 1, accentColor: "var(--accent-warm)" }}
                  />
                  <input
                    type="number" min="0" max="100" value={layer.powerMin}
                    onChange={(e) => onManualUpdate({ powerMin: Math.max(0, Math.min(100, Number(e.target.value))) })}
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
                    onChange={(e) => onManualUpdate({ speed: Number(e.target.value) })}
                    style={{ flex: 1, accentColor: "var(--accent)" }}
                  />
                  <input
                    type="number" min="1" max="10000" value={layer.speed}
                    onChange={(e) => onManualUpdate({ speed: Math.max(1, Number(e.target.value)) })}
                    style={{ ...inputStyle, width: "50px", textAlign: "right" }}
                  />
                  <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>mm/s</span>
                </div>
              </SettingRow>

              {/* Passes */}
              <SettingRow label="Passes">
                <input
                  type="number" min="1" max="100" value={layer.passes}
                  onChange={(e) => onManualUpdate({ passes: Math.max(1, Number(e.target.value)) })}
                  style={{ ...inputStyle, width: "50px", textAlign: "right" }}
                />
              </SettingRow>

              {/* Power mode */}
              <SettingRow label="Power Mode">
                <select
                  value={layer.powerMode}
                  onChange={(e) => onManualUpdate({ powerMode: e.target.value as "constant" | "variable" })}
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
                        onChange={(e) => onManualUpdate({ interval: Math.max(0.01, Number(e.target.value)) })}
                        style={{ ...inputStyle, width: "60px", textAlign: "right" }}
                      />
                      <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>mm</span>
                    </div>
                  </SettingRow>

                  {layer.mode === "fill" && (
                    <>
                      <SettingRow label="Dither">
                        <select
                          value={layer.dither}
                          onChange={(e) => onManualUpdate({ dither: e.target.value as Layer["dither"] })}
                          style={selectStyle}
                        >
                          <option value="threshold">Threshold</option>
                          <option value="ordered">Ordered</option>
                          <option value="floydSteinberg">Floyd-Steinberg</option>
                          <option value="jarvis">Jarvis</option>
                          <option value="stucki">Stucki</option>
                          <option value="grayscale">Grayscale</option>
                          <option value="newsprint">Newsprint (Halftone)</option>
                        </select>
                      </SettingRow>

                      {layer.dither === "newsprint" && (
                        <>
                          <SettingRow label="Cell Size">
                            <div style={{ display: "flex", alignItems: "center", gap: "4px", width: "100%" }}>
                              <input
                                type="range" min="2" max="20" value={layer.newsprintCellSize ?? 6}
                                onChange={(e) => onManualUpdate({ newsprintCellSize: Number(e.target.value) })}
                                style={{ flex: 1, accentColor: "var(--accent)" }}
                              />
                              <input
                                type="number" min="2" max="20" value={layer.newsprintCellSize ?? 6}
                                onChange={(e) => onManualUpdate({ newsprintCellSize: Math.max(2, Math.min(20, Number(e.target.value))) })}
                                style={{ ...inputStyle, width: "42px", textAlign: "right" }}
                              />
                              <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>px</span>
                            </div>
                          </SettingRow>
                          <SettingRow label="Angle">
                            <div style={{ display: "flex", alignItems: "center", gap: "4px", width: "100%" }}>
                              <input
                                type="range" min="0" max="90" step="5" value={layer.newsprintAngle ?? 45}
                                onChange={(e) => onManualUpdate({ newsprintAngle: Number(e.target.value) })}
                                style={{ flex: 1, accentColor: "var(--accent)" }}
                              />
                              <input
                                type="number" min="0" max="90" step="5" value={layer.newsprintAngle ?? 45}
                                onChange={(e) => onManualUpdate({ newsprintAngle: Math.max(0, Math.min(90, Number(e.target.value))) })}
                                style={{ ...inputStyle, width: "42px", textAlign: "right" }}
                              />
                              <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>{"°"}</span>
                            </div>
                          </SettingRow>
                        </>
                      )}

                      <SettingRow label="Order">
                        <select
                          value={layer.fillOrder ?? "sequential"}
                          onChange={(e) => onManualUpdate({ fillOrder: e.target.value as "sequential" | "flood" })}
                          style={selectStyle}
                        >
                          <option value="sequential">Sequential</option>
                          <option value="flood">Flood (Nearest)</option>
                        </select>
                      </SettingRow>

                      {/* Power Curve */}
                      <SettingRow label="Curve">
                        <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                          <PowerCurveThumbnail points={layer.powerCurve ?? defaultCurve} />
                          <button
                            onClick={() => setCurveEditorOpen(true)}
                            style={{
                              padding: "3px 8px",
                              fontSize: 10,
                              background: "var(--bg-input)",
                              border: "1px solid var(--border)",
                              borderRadius: "var(--radius-sm)",
                              color: "var(--text-secondary)",
                              cursor: "pointer",
                              flexShrink: 0,
                            }}
                          >
                            Edit
                          </button>
                        </div>
                      </SettingRow>

                      <SettingRow label="Scan Angle">
                        <input
                          type="number" min="0" max="360" step="1" value={layer.scanAngle ?? 0}
                          onChange={(e) => onManualUpdate({ scanAngle: Number(e.target.value) % 360 })}
                          style={{ ...inputStyle, width: "60px" }}
                        />
                        <span style={{ fontSize: "9px", color: "var(--text-muted)", marginLeft: "4px" }}>°</span>
                      </SettingRow>
                      {layer.passes > 1 && (
                        <SettingRow label="Angle/Pass">
                          <input
                            type="number" min="0" max="180" step="1" value={layer.angleIncrement ?? 0}
                            onChange={(e) => onManualUpdate({ angleIncrement: Number(e.target.value) })}
                            style={{ ...inputStyle, width: "60px" }}
                          />
                          <span style={{ fontSize: "9px", color: "var(--text-muted)", marginLeft: "4px" }}>°</span>
                        </SettingRow>
                      )}
                    </>
                  )}
                </>
              )}

              {/* Toggles row */}
              <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "2px", flexWrap: "wrap" }}>
                <ToggleChip label="Air Assist" active={layer.airAssist} onClick={() => onManualUpdate({ airAssist: !layer.airAssist })} />
                <ToggleChip label="Inner First" active={layer.cutInnerFirst} onClick={() => onManualUpdate({ cutInnerFirst: !layer.cutInnerFirst })} />
                <ToggleChip label="Lock" active={layer.locked} onClick={() => onManualUpdate({ locked: !layer.locked })} />
                {(layer.mode === "fill" || layer.mode === "offsetFill") && (
                  <>
                    {layer.mode === "fill" && (
                      <>
                        <ToggleChip label="Bidir" active={layer.bidirectional} onClick={() => onManualUpdate({ bidirectional: !layer.bidirectional })} />
                        <ToggleChip label="Cross" active={layer.crossHatch} onClick={() => onManualUpdate({ crossHatch: !layer.crossHatch })} />
                      </>
                    )}
                  </>
                )}
              </div>

              {/* Advanced settings */}
              <AdvancedSettings layer={layer} onUpdate={onManualUpdate} />
            </>
          )}

          {/* Power Curve Editor Modal */}
          <PowerCurveEditor
            open={curveEditorOpen}
            points={layer.powerCurve ?? defaultCurve}
            onApply={(pts) => {
              onManualUpdate({ powerCurve: pts });
              setCurveEditorOpen(false);
            }}
            onClose={() => setCurveEditorOpen(false)}
          />

          {/* Add Sub-Layer button group */}
          <div style={{ padding: "4px 0 0 0", display: "flex", gap: "4px" }}>
            <button
              onClick={() => addSubLayer(layer.index)}
              style={{
                flex: 1,
                padding: "4px 8px",
                fontSize: "11px",
                background: "var(--bg-input)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              Add Sub-Layer
            </button>
            {!hasSubLayers && (
              <button
                onClick={() => {
                  // Fill+Line preset: add both sub-layers atomically
                  addSubLayers(layer.index, [
                    { mode: "fill", power: 50, speed: 100 },
                    { mode: "line", power: 100, speed: 20 },
                  ]);
                }}
                style={{
                  flex: 1,
                  padding: "4px 8px",
                  fontSize: "11px",
                  background: "var(--bg-input)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                Fill+Line
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SubLayerRow({
  sub,
  index,
  layerColor,
  onUpdate,
  onRemove,
}: {
  sub: SubLayer;
  index: number;
  layerColor: string;
  onUpdate: (changes: Partial<SubLayer>) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        borderLeft: `2px solid ${layerColor}`,
        marginLeft: "4px",
        paddingLeft: "8px",
        paddingTop: "5px",
        paddingBottom: "5px",
        display: "flex",
        flexDirection: "column",
        gap: "5px",
        background: "rgba(255,255,255,0.03)",
        borderRadius: "0 var(--radius-sm) var(--radius-sm) 0",
      }}
    >
      {/* Sub-layer header: number + mode badge + remove button */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span style={{
          fontSize: "9px", color: "var(--text-muted)", fontWeight: 600,
          textTransform: "uppercase", letterSpacing: "0.3px", minWidth: "12px",
        }}>
          {index + 1}
        </span>
        <span style={{
          fontSize: "9px", padding: "1px 4px", borderRadius: "3px",
          background: sub.mode === "fill" ? "rgba(226,74,74,0.2)" : "rgba(74,144,226,0.2)",
          color: sub.mode === "fill" ? "#e28a8a" : "#8ab4e2",
          textTransform: "uppercase", fontWeight: 600,
        }}>
          {sub.mode}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={onRemove}
          title="Remove sub-layer"
          style={{
            background: "none", border: "none",
            color: "var(--text-muted)", cursor: "pointer",
            fontSize: "12px", padding: "0 2px", lineHeight: 1,
          }}
        >
          &times;
        </button>
      </div>

      {/* Mode select */}
      <SettingRow label="Mode">
        <select
          value={sub.mode}
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
            type="number" min="0" max="100" value={sub.power}
            onChange={(e) => onUpdate({ power: Math.max(0, Math.min(100, Number(e.target.value))) })}
            style={{ ...inputStyle, width: "42px", textAlign: "right" }}
          />
          <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>%</span>
        </div>
      </SettingRow>

      {/* Speed */}
      <SettingRow label="Speed">
        <div style={{ display: "flex", alignItems: "center", gap: "4px", width: "100%" }}>
          <input
            type="number" min="1" max="10000" value={sub.speed}
            onChange={(e) => onUpdate({ speed: Math.max(1, Number(e.target.value)) })}
            style={{ ...inputStyle, width: "50px", textAlign: "right" }}
          />
          <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>mm/s</span>
        </div>
      </SettingRow>

      {/* Passes */}
      <SettingRow label="Passes">
        <input
          type="number" min="1" max="100" value={sub.passes}
          onChange={(e) => onUpdate({ passes: Math.max(1, Number(e.target.value)) })}
          style={{ ...inputStyle, width: "50px", textAlign: "right" }}
        />
      </SettingRow>
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
              <SettingRow label="Kerf">
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <input type="number" min="-2" max="2" step="0.01" value={layer.kerfOffset}
                    onChange={(e) => onUpdate({ kerfOffset: Math.max(-2, Math.min(2, Number(e.target.value))) })}
                    style={{ ...inputStyle, width: "50px", textAlign: "right" }}
                  />
                  <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>mm</span>
                </div>
              </SettingRow>
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
              <SettingRow label="Perf">
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <input type="number" min="0" max="50" step="0.5" value={layer.perforationCut}
                    onChange={(e) => onUpdate({ perforationCut: Math.max(0, Number(e.target.value)) })}
                    style={{
                      ...inputStyle, width: "40px", textAlign: "right",
                      opacity: layer.tabSpacing > 0 ? 0.4 : 1,
                    }}
                    title={layer.tabSpacing > 0 ? "Perforation disabled when tabs are active" : "Cut length"}
                  />
                  <span style={{ fontSize: "9px", color: "var(--text-muted)" }}>cut</span>
                  <input type="number" min="0" max="50" step="0.5" value={layer.perforationSkip}
                    onChange={(e) => onUpdate({ perforationSkip: Math.max(0, Number(e.target.value)) })}
                    style={{
                      ...inputStyle, width: "35px", textAlign: "right",
                      opacity: layer.tabSpacing > 0 ? 0.4 : 1,
                    }}
                    title={layer.tabSpacing > 0 ? "Perforation disabled when tabs are active" : "Skip length"}
                  />
                  <span style={{ fontSize: "9px", color: "var(--text-muted)" }}>skip</span>
                </div>
              </SettingRow>
            </>
          )}
          {layer.mode === "fill" && (
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

function PresetQuickApply({ layer, onUpdate }: { layer: Layer; onUpdate: (partial: Partial<Layer>) => void }) {
  const materials = useStore((s) => s.materials);
  if (materials.length === 0) return null;

  // Group presets by material+thickness
  const grouped = materials.reduce<Record<string, MaterialPreset[]>>((acc, m) => {
    const key = `${m.material} ${m.thickness}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(m);
    return acc;
  }, {});

  function applyPreset(preset: MaterialPreset) {
    onUpdate({
      mode: preset.mode,
      power: preset.power,
      powerMin: preset.powerMin,
      speed: preset.speed,
      passes: preset.passes,
      airAssist: preset.airAssist,
      interval: preset.interval,
      activePreset: preset.name,
    });
  }

  return (
    <SettingRow label="Preset">
      <select
        value={layer.activePreset ?? ""}
        onChange={(e) => {
          const preset = materials.find((m) => m.name === e.target.value);
          if (preset) applyPreset(preset);
          else onUpdate({ activePreset: undefined });
        }}
        style={selectStyle}
      >
        <option value="">{layer.activePreset ? "Custom" : "Select preset..."}</option>
        {Object.entries(grouped).map(([group, presets]) => (
          <optgroup key={group} label={group}>
            {presets.map((p) => (
              <option key={p.id} value={p.name}>{p.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </SettingRow>
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
