import { useStore } from "../../app/store";
import type { ImageAdjustments } from "../../app/types";
import { dialogState } from "../../app/App";

export function PropertiesPanel() {
  const selectedIds = useStore((s) => s.selectedIds);
  const objects = useStore((s) => s.objects);
  const updateObject = useStore((s) => s.updateObject);
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

          {/* Position */}
          <PropertyGroup label="Position">
            <NumberField
              label="X"
              value={obj.transform.x}
              onChange={(v) =>
                updateObject(obj.id, {
                  transform: { ...obj.transform, x: v },
                })
              }
              unit="mm"
              onFocus={beginEdit}
              onBlur={commitEdit}
            />
            <NumberField
              label="Y"
              value={obj.transform.y}
              onChange={(v) =>
                updateObject(obj.id, {
                  transform: { ...obj.transform, y: v },
                })
              }
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
                updateObject(obj.id, {
                  transform: { ...obj.transform, width: Math.max(0, v) },
                })
              }
              unit="mm"
              onFocus={beginEdit}
              onBlur={commitEdit}
            />
            <NumberField
              label="H"
              value={obj.transform.height}
              onChange={(v) =>
                updateObject(obj.id, {
                  transform: { ...obj.transform, height: Math.max(0, v) },
                })
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
                      } satisfies ImageAdjustments,
                    })
                  }
                  onFocus={beginEdit}
                  onBlur={commitEdit}
                  style={inputStyle}
                />
              </PropertyRow>
              <button
                onClick={() => dialogState.openDitherPreview(obj.id)}
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
