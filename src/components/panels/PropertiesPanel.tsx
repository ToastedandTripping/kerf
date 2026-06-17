import { useStore } from "../../app/store";
import type { ImageAdjustments } from "../../app/types";
import { openDitherPreview } from "../../app/App";
import { movePartial, scalePartial } from "../../lib/geometry";

export function PropertiesPanel() {
  const selectedIds = useStore((s) => s.selectedIds);
  const objects = useStore((s) => s.objects);
  const layers = useStore((s) => s.layers);
  const updateObject = useStore((s) => s.updateObject);
  const moveObjectsToLayer = useStore((s) => s.moveObjectsToLayer);
  const beginEdit = useStore((s) => s.beginPropertyEdit);
  const commitEdit = useStore((s) => s.commitPropertyEdit);

  const selected = objects.filter((o) => selectedIds.includes(o.id));

  if (selected.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
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
          Properties
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-muted)",
            fontSize: "12px",
            padding: "20px",
            textAlign: "center",
          }}
        >
          No selection
        </div>
      </div>
    );
  }

  const obj = selected[0];
  const multi = selected.length > 1;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto" }}>
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
        Properties {multi ? `(${selected.length})` : ""}
      </div>

      {/* Layer indicator + selector (works for single and multi-select) */}
      {(() => {
        const layerIndices = new Set(selected.map((o) => o.layerIndex));
        const isMixed = layerIndices.size > 1;
        const currentIndex = isMixed ? -1 : [...layerIndices][0];
        const currentLayer = isMixed ? null : layers[currentIndex];
        return (
          <div style={{ padding: "0 12px 8px", display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{
              width: "10px", height: "10px", borderRadius: "2px", flexShrink: 0,
              background: currentLayer?.color || "transparent",
              border: isMixed ? "1px dashed var(--text-muted)" : "none",
            }} />
            <select
              value={currentIndex}
              onChange={(e) => moveObjectsToLayer(selectedIds, Number(e.target.value))}
              style={{
                flex: 1, background: "var(--bg-input)", border: "1px solid var(--border)",
                color: "var(--text-primary)", padding: "3px 6px", borderRadius: "var(--radius-sm)",
                fontSize: "11px", cursor: "pointer",
                appearance: "none", WebkitAppearance: "none",
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Cpath d='M0 2l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.5'/%3E%3C/svg%3E")`,
                backgroundRepeat: "no-repeat", backgroundPosition: "right 6px center",
                paddingRight: "20px",
              }}
            >
              {isMixed && <option value={-1} disabled>Mixed</option>}
              {layers.map((l) => (
                <option key={l.index} value={l.index}>{l.name}</option>
              ))}
            </select>
          </div>
        );
      })()}

      {!multi && (
        <div style={{ padding: "0 12px 12px" }}>
          {/* Name */}
          <PropertyRow label="Name">
            <input
              value={obj.name}
              onChange={(e) => updateObject(obj.id, { name: e.target.value })}
              onFocus={beginEdit}
              onBlur={commitEdit}
              style={inputStyle}
            />
          </PropertyRow>

          {/* Position — W1b: movePartial/scalePartial keep path points synced */}
          <PropertyGroup label="Position">
            <NumberField
              label="X"
              value={obj.transform.x}
              onChange={(v) => updateObject(obj.id, movePartial(obj, v, obj.transform.y))}
              unit="mm"
              onFocus={beginEdit}
              onBlur={commitEdit}
            />
            <NumberField
              label="Y"
              value={obj.transform.y}
              onChange={(v) => updateObject(obj.id, movePartial(obj, obj.transform.x, v))}
              unit="mm"
              onFocus={beginEdit}
              onBlur={commitEdit}
            />
          </PropertyGroup>

          {/* Size */}
          <PropertyGroup label="Size">
            <NumberField
              label="W"
              value={obj.transform.width}
              onChange={(v) =>
                updateObject(obj.id, scalePartial(obj, {
                  x: obj.transform.x, y: obj.transform.y,
                  width: Math.max(0, v), height: obj.transform.height,
                }))
              }
              unit="mm"
              onFocus={beginEdit}
              onBlur={commitEdit}
            />
            <NumberField
              label="H"
              value={obj.transform.height}
              onChange={(v) =>
                updateObject(obj.id, scalePartial(obj, {
                  x: obj.transform.x, y: obj.transform.y,
                  width: obj.transform.width, height: Math.max(0, v),
                }))
              }
              unit="mm"
              onFocus={beginEdit}
              onBlur={commitEdit}
            />
          </PropertyGroup>

          {/* Rotation */}
          <PropertyGroup label="Rotation">
            <NumberField
              label="Deg"
              value={obj.transform.rotation}
              onChange={(v) =>
                updateObject(obj.id, {
                  transform: { ...obj.transform, rotation: v },
                })
              }
              unit="deg"
              onFocus={beginEdit}
              onBlur={commitEdit}
            />
          </PropertyGroup>

          {/* Stroke */}
          <PropertyGroup label="Stroke">
            <PropertyRow label="Color">
              <input
                type="color"
                value={obj.stroke}
                onChange={(e) => updateObject(obj.id, { stroke: e.target.value })}
                onFocus={beginEdit}
                onBlur={commitEdit}
                style={{
                  width: "28px",
                  height: "22px",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  background: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
              />
            </PropertyRow>
            <NumberField
              label="Width"
              value={obj.strokeWidth}
              onChange={(v) => updateObject(obj.id, { strokeWidth: Math.max(0, v) })}
              unit="px"
              step={0.5}
              onFocus={beginEdit}
              onBlur={commitEdit}
            />
          </PropertyGroup>

          {/* Corner radius for rectangles */}
          {obj.type === "rectangle" && (
            <PropertyGroup label="Corners">
              <NumberField
                label="Radius"
                value={obj.cornerRadius || 0}
                onChange={(v) => updateObject(obj.id, { cornerRadius: Math.max(0, v) })}
                unit="mm"
                onFocus={beginEdit}
                onBlur={commitEdit}
              />
            </PropertyGroup>
          )}

          {/* Opacity & Power Scale */}
          <PropertyGroup label="Appearance">
            <NumberField
              label="Opacity"
              value={Math.round(obj.opacity * 100)}
              onChange={(v) => updateObject(obj.id, { opacity: Math.max(0, Math.min(100, v)) / 100 })}
              unit="%"
              step={1}
              onFocus={beginEdit}
              onBlur={commitEdit}
            />
            <NumberField
              label="Power Scale"
              value={Math.round((obj.powerScale ?? 1) * 100)}
              onChange={(v) => updateObject(obj.id, { powerScale: Math.max(1, Math.min(100, v)) / 100 })}
              unit="%"
              step={5}
              onFocus={beginEdit}
              onBlur={commitEdit}
            />
          </PropertyGroup>

          {/* Cut Order */}
          <PropertyGroup label="Cut Order">
            <NumberField
              label="Priority"
              value={obj.priority ?? 0}
              onChange={(v) => updateObject(obj.id, { priority: Math.max(0, Math.min(99, Math.round(v))) })}
              unit=""
              step={1}
              onFocus={beginEdit}
              onBlur={commitEdit}
            />
            <div style={{ fontSize: "10px", color: "var(--text-muted)", marginTop: "4px", lineHeight: 1.4 }}>
              Higher cuts first. 0 = default order.
            </div>
          </PropertyGroup>

          {/* Image adjustments */}
          {obj.type === "image" && (
            <PropertyGroup label="Image">
              <NumberField
                label="Brightness"
                value={obj.imageAdjustments?.brightness ?? 0}
                onChange={(v) =>
                  updateObject(obj.id, {
                    imageAdjustments: {
                      brightness: v,
                      contrast: obj.imageAdjustments?.contrast ?? 0,
                      gamma: obj.imageAdjustments?.gamma ?? 1,
                      invert: obj.imageAdjustments?.invert ?? false,
                    } satisfies ImageAdjustments,
                  })
                }
                unit=""
                step={1}
                onFocus={beginEdit}
                onBlur={commitEdit}
              />
              <NumberField
                label="Contrast"
                value={obj.imageAdjustments?.contrast ?? 0}
                onChange={(v) =>
                  updateObject(obj.id, {
                    imageAdjustments: {
                      brightness: obj.imageAdjustments?.brightness ?? 0,
                      contrast: v,
                      gamma: obj.imageAdjustments?.gamma ?? 1,
                      invert: obj.imageAdjustments?.invert ?? false,
                    } satisfies ImageAdjustments,
                  })
                }
                unit=""
                step={1}
                onFocus={beginEdit}
                onBlur={commitEdit}
              />
              <NumberField
                label="Gamma"
                value={obj.imageAdjustments?.gamma ?? 1}
                onChange={(v) =>
                  updateObject(obj.id, {
                    imageAdjustments: {
                      brightness: obj.imageAdjustments?.brightness ?? 0,
                      contrast: obj.imageAdjustments?.contrast ?? 0,
                      gamma: v,
                      invert: obj.imageAdjustments?.invert ?? false,
                    } satisfies ImageAdjustments,
                  })
                }
                unit=""
                step={0.1}
                onFocus={beginEdit}
                onBlur={commitEdit}
              />
              <PropertyRow label="Invert">
                <input
                  type="checkbox"
                  checked={obj.imageAdjustments?.invert ?? false}
                  onChange={(e) =>
                    updateObject(obj.id, {
                      imageAdjustments: {
                        brightness: obj.imageAdjustments?.brightness ?? 0,
                        contrast: obj.imageAdjustments?.contrast ?? 0,
                        gamma: obj.imageAdjustments?.gamma ?? 1,
                        invert: e.target.checked,
                        removeBackground: obj.imageAdjustments?.removeBackground ?? false,
                        bgTolerance: obj.imageAdjustments?.bgTolerance ?? 20,
                      } satisfies ImageAdjustments,
                    })
                  }
                  onFocus={beginEdit}
                  onBlur={commitEdit}
                  style={inputStyle}
                />
              </PropertyRow>
              <PropertyRow label="Remove Bg">
                <input
                  type="checkbox"
                  checked={obj.imageAdjustments?.removeBackground ?? false}
                  onChange={(e) =>
                    updateObject(obj.id, {
                      imageAdjustments: {
                        brightness: obj.imageAdjustments?.brightness ?? 0,
                        contrast: obj.imageAdjustments?.contrast ?? 0,
                        gamma: obj.imageAdjustments?.gamma ?? 1,
                        invert: obj.imageAdjustments?.invert ?? false,
                        removeBackground: e.target.checked,
                        bgTolerance: obj.imageAdjustments?.bgTolerance ?? 20,
                      } satisfies ImageAdjustments,
                    })
                  }
                  onFocus={beginEdit}
                  onBlur={commitEdit}
                  style={inputStyle}
                />
              </PropertyRow>
              {(obj.imageAdjustments?.removeBackground ?? false) && (
                <NumberField
                  label="Tolerance"
                  value={obj.imageAdjustments?.bgTolerance ?? 20}
                  onChange={(v) =>
                    updateObject(obj.id, {
                      imageAdjustments: {
                        brightness: obj.imageAdjustments?.brightness ?? 0,
                        contrast: obj.imageAdjustments?.contrast ?? 0,
                        gamma: obj.imageAdjustments?.gamma ?? 1,
                        invert: obj.imageAdjustments?.invert ?? false,
                        removeBackground: obj.imageAdjustments?.removeBackground ?? false,
                        bgTolerance: Math.max(0, Math.min(50, v)),
                      } satisfies ImageAdjustments,
                    })
                  }
                  unit=""
                  step={1}
                  onFocus={beginEdit}
                  onBlur={commitEdit}
                />
              )}
              <button
                onClick={() => openDitherPreview(obj.id)}
                style={{
                  marginTop: 4,
                  width: "100%",
                  padding: "5px 8px",
                  fontSize: 11,
                  background: "var(--bg-input)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                Preview Dither
              </button>
            </PropertyGroup>
          )}
        </div>
      )}
    </div>
  );
}

function PropertyGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: "8px" }}>
      <div
        style={{
          fontSize: "10px",
          color: "var(--text-muted)",
          marginBottom: "4px",
          textTransform: "uppercase",
          letterSpacing: "0.3px",
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        {children}
      </div>
    </div>
  );
}

function PropertyRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        marginBottom: "4px",
      }}
    >
      <span
        style={{
          fontSize: "11px",
          color: "var(--text-secondary)",
          minWidth: "40px",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  unit,
  step = 1,
  onFocus,
  onBlur,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  unit: string;
  step?: number;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "4px",
      }}
    >
      <span
        style={{
          fontSize: "11px",
          color: "var(--text-muted)",
          minWidth: "16px",
        }}
      >
        {label}
      </span>
      <input
        type="number"
        value={Math.round(value * 100) / 100}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) onChange(v);
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        style={inputStyle}
      />
      <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>{unit}</span>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
  padding: "4px 6px",
  fontSize: "12px",
  width: "100%",
};
