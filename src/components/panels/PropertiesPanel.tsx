import { useState } from "react";
import { useStore } from "../../app/store";
import type { ImageAdjustments } from "../../app/types";
import { openDitherPreview } from "../../app/App";
import { movePartial, scalePartial } from "../../lib/geometry";
import { MM_PER_INCH } from "../../lib/constants";
import { BUNDLED_FONTS } from "../../app/store/geometryActions";
import { Chevron } from "./Chevron";
const UNITS_KEY = "kerf-display-units";

// N1: @font-face declarations derived from BUNDLED_FONTS (single source of truth).
let fontFacesInjected = false;
function injectFontFaces() {
  if (fontFacesInjected) return;
  fontFacesInjected = true;
  const css = BUNDLED_FONTS.map((f) => {
    // Extract the primary family name from the cssFamily string (e.g. "'Open Sans', sans-serif" → "Open Sans")
    const familyName = f.cssFamily.split(",")[0].trim().replace(/'/g, "");
    return `@font-face { font-family: '${familyName}'; src: url('${f.file}') format('truetype'); font-weight: 400; font-style: normal; font-display: swap; }`;
  }).join("\n");
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}
injectFontFaces();

export function PropertiesPanel() {
  const selectedIds = useStore((s) => s.selectedIds);
  const objects = useStore((s) => s.objects);
  const layers = useStore((s) => s.layers);
  const updateObject = useStore((s) => s.updateObject);
  const moveObjectsToLayer = useStore((s) => s.moveObjectsToLayer);
  const beginEdit = useStore((s) => s.beginPropertyEdit);
  const commitEdit = useStore((s) => s.commitPropertyEdit);

  const [displayUnit, setDisplayUnit] = useState<"mm" | "in">(() => {
    try {
      return (localStorage.getItem(UNITS_KEY) as "mm" | "in") || "mm";
    } catch {
      return "mm";
    }
  });
  const [aspectLocked, setAspectLocked] = useState(false);

  const toggleUnit = () => {
    const next = displayUnit === "mm" ? "in" : "mm";
    setDisplayUnit(next);
    try {
      localStorage.setItem(UNITS_KEY, next);
    } catch {
      // localStorage unavailable (private browsing, disabled storage) — non-critical, ignore
    }
  };

  const toDisplay = (mm: number) => (displayUnit === "in" ? mm / MM_PER_INCH : mm);
  const fromDisplay = (v: number) => (displayUnit === "in" ? v * MM_PER_INCH : v);
  const unitLabel = displayUnit;

  const [appearanceOpen, setAppearanceOpen] = useState(false);

  const selected = objects.filter((o) => selectedIds.includes(o.id));

  if (selected.length === 0) {
    return (
      <div
        style={{
          color: "var(--text-muted)",
          fontSize: "var(--text-sm)",
          padding: "20px",
          textAlign: "center",
        }}
      >
        No selection
      </div>
    );
  }

  const obj = selected[0];
  const multi = selected.length > 1;

  // Layer indicator + selector (works for single and multi-select)
  const layerIndices = new Set(selected.map((o) => o.layerIndex));
  const isMixed = layerIndices.size > 1;
  const currentIndex = isMixed ? -1 : [...layerIndices][0];
  const currentLayer = isMixed ? null : layers[currentIndex];

  // The section header in App carries the "(N)" count; this panel draws no header (P48).
  return (
    <div
      style={{ padding: "8px 12px 12px", display: "flex", flexDirection: "column", minWidth: 0 }}
    >
      {!multi && (
        <>
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
          <PropertyGroup
            label="Position"
            trailing={
              <button
                onClick={toggleUnit}
                title={`Switch to ${displayUnit === "mm" ? "inches" : "millimeters"}`}
                style={chipStyle}
              >
                {displayUnit}
              </button>
            }
          >
            <div style={pairStyle}>
              <NumberField
                label="X"
                labelWidth={12}
                value={toDisplay(obj.transform.x)}
                onChange={(v) =>
                  updateObject(obj.id, movePartial(obj, fromDisplay(v), obj.transform.y))
                }
                unit={unitLabel}
                step={displayUnit === "in" ? 0.01 : 1}
                onFocus={beginEdit}
                onBlur={commitEdit}
              />
              <NumberField
                label="Y"
                labelWidth={12}
                value={toDisplay(obj.transform.y)}
                onChange={(v) =>
                  updateObject(obj.id, movePartial(obj, obj.transform.x, fromDisplay(v)))
                }
                unit={unitLabel}
                step={displayUnit === "in" ? 0.01 : 1}
                onFocus={beginEdit}
                onBlur={commitEdit}
              />
            </div>
          </PropertyGroup>

          {/* Size: W and H side by side, the aspect lock between them */}
          <PropertyGroup label="Size">
            <div style={{ ...pairStyle, gridTemplateColumns: "1fr auto 1fr" }}>
              <NumberField
                label="W"
                labelWidth={12}
                value={toDisplay(obj.transform.width)}
                onChange={(v) => {
                  const newW = Math.max(0, fromDisplay(v));
                  const newH =
                    aspectLocked && obj.transform.width > 0
                      ? obj.transform.height * (newW / obj.transform.width)
                      : obj.transform.height;
                  updateObject(
                    obj.id,
                    scalePartial(obj, {
                      x: obj.transform.x,
                      y: obj.transform.y,
                      width: newW,
                      height: newH,
                    })
                  );
                }}
                unit={unitLabel}
                step={displayUnit === "in" ? 0.01 : 1}
                onFocus={beginEdit}
                onBlur={commitEdit}
              />
              <button
                onClick={() => setAspectLocked(!aspectLocked)}
                title={aspectLocked ? "Unlock aspect ratio" : "Lock aspect ratio"}
                aria-pressed={aspectLocked}
                style={{
                  ...chipStyle,
                  background: aspectLocked ? "var(--accent-bg)" : "none",
                  border: aspectLocked
                    ? "1px solid var(--accent-border)"
                    : "1px solid var(--border-control)",
                  boxShadow: aspectLocked ? "inset 0 0 0 1px var(--accent)" : "none",
                  color: aspectLocked ? "var(--accent-text)" : "var(--text-secondary)",
                  fontWeight: aspectLocked ? 600 : 400,
                }}
              >
                {aspectLocked ? "1:1" : "W/H"}
              </button>
              <NumberField
                label="H"
                labelWidth={12}
                value={toDisplay(obj.transform.height)}
                onChange={(v) => {
                  const newH = Math.max(0, fromDisplay(v));
                  const newW =
                    aspectLocked && obj.transform.height > 0
                      ? obj.transform.width * (newH / obj.transform.height)
                      : obj.transform.width;
                  updateObject(
                    obj.id,
                    scalePartial(obj, {
                      x: obj.transform.x,
                      y: obj.transform.y,
                      width: newW,
                      height: newH,
                    })
                  );
                }}
                unit={unitLabel}
                step={displayUnit === "in" ? 0.01 : 1}
                onFocus={beginEdit}
                onBlur={commitEdit}
              />
            </div>
          </PropertyGroup>

          {/* Rotation */}
          <NumberField
            label="Angle"
            value={obj.transform.rotation}
            onChange={(v) =>
              updateObject(obj.id, {
                transform: { ...obj.transform, rotation: v },
              })
            }
            unit="°"
            onFocus={beginEdit}
            onBlur={commitEdit}
          />

          {obj.type === "rectangle" && (
            <PropertyGroup label="Corners">
              <NumberField
                label="Radius"
                value={toDisplay(obj.cornerRadius || 0)}
                onChange={(v) =>
                  updateObject(obj.id, { cornerRadius: Math.max(0, fromDisplay(v)) })
                }
                unit={unitLabel}
                step={displayUnit === "in" ? 0.01 : 1}
                onFocus={beginEdit}
                onBlur={commitEdit}
              />
            </PropertyGroup>
          )}
        </>
      )}

      {/* Laser: the fields that reach the G-code */}
      <PropertyGroup label="Laser">
        <PropertyRow label="Layer">
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: "6px" }}>
            <div
              style={{
                width: "10px",
                height: "10px",
                borderRadius: "2px",
                flexShrink: 0,
                background: currentLayer?.color || "transparent",
                border: isMixed ? "1px dashed var(--text-muted)" : "none",
              }}
            />
            <select
              value={currentIndex}
              onChange={(e) => moveObjectsToLayer(selectedIds, Number(e.target.value))}
              className="k-select"
              style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
            >
              {isMixed && (
                <option value={-1} disabled>
                  Mixed
                </option>
              )}
              {layers.map((l) => (
                <option key={l.index} value={l.index}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        </PropertyRow>
        {!multi && (
          <>
            <NumberField
              label="Power Scale"
              value={Math.round((obj.powerScale ?? 1) * 100)}
              onChange={(v) =>
                updateObject(obj.id, { powerScale: Math.max(1, Math.min(100, v)) / 100 })
              }
              unit="%"
              step={5}
              onFocus={beginEdit}
              onBlur={commitEdit}
            />
            <NumberField
              label="Cut order"
              value={obj.priority ?? 0}
              onChange={(v) =>
                updateObject(obj.id, { priority: Math.max(0, Math.min(99, Math.round(v))) })
              }
              unit=""
              step={1}
              onFocus={beginEdit}
              onBlur={commitEdit}
            />
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-muted)",
                margin: "2px 0 0 72px",
                lineHeight: 1.4,
              }}
            >
              Higher cuts first. 0 = default order.
            </div>
          </>
        )}
      </PropertyGroup>

      {!multi && (
        <>
          {obj.type === "text" && (
            <PropertyGroup label="Text">
              <PropertyRow label="Content">
                <textarea
                  value={obj.text ?? ""}
                  onChange={(e) => updateObject(obj.id, { text: e.target.value })}
                  onFocus={beginEdit}
                  onBlur={commitEdit}
                  rows={Math.min(5, (obj.text ?? "").split("\n").length || 1)}
                  style={{
                    ...inputStyle,
                    resize: "vertical",
                    lineHeight: "1.3",
                    minHeight: "24px",
                    fontFamily: "inherit",
                  }}
                />
              </PropertyRow>
              <NumberField
                label="Size"
                value={obj.fontSize ?? 16}
                onChange={(v) => updateObject(obj.id, { fontSize: Math.max(1, v) })}
                unit="px"
                step={1}
                onFocus={beginEdit}
                onBlur={commitEdit}
              />
              <PropertyRow label="Align">
                <div style={{ display: "flex", gap: "2px" }}>
                  {(["left", "center", "right"] as const).map((a) => (
                    <button
                      key={a}
                      onClick={() => {
                        beginEdit();
                        updateObject(obj.id, { textAlign: a });
                        commitEdit();
                      }}
                      style={{
                        ...inputStyle,
                        flex: 1,
                        cursor: "pointer",
                        fontWeight: (obj.textAlign ?? "left") === a ? 600 : 400,
                        background:
                          (obj.textAlign ?? "left") === a
                            ? "var(--accent-bg)"
                            : inputStyle.background,
                        border:
                          (obj.textAlign ?? "left") === a
                            ? "1px solid var(--accent-border)"
                            : "1px solid var(--border-control)",
                        boxShadow:
                          (obj.textAlign ?? "left") === a
                            ? "inset 0 0 0 1px var(--accent)"
                            : "none",
                        color:
                          (obj.textAlign ?? "left") === a
                            ? "var(--accent-text)"
                            : "var(--text-primary)",
                        textAlign: "center",
                        padding: "2px 4px",
                        fontSize: "11px",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                      }}
                    >
                      {a === "left" ? "L" : a === "center" ? "C" : "R"}
                    </button>
                  ))}
                </div>
              </PropertyRow>
              <PropertyRow label="Font">
                <select
                  value={obj.fontFamily ?? "sans-serif"}
                  onChange={(e) => updateObject(obj.id, { fontFamily: e.target.value })}
                  onFocus={beginEdit}
                  onBlur={commitEdit}
                  className="k-select"
                  style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
                >
                  {BUNDLED_FONTS.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </PropertyRow>
            </PropertyGroup>
          )}

          {obj.type === "image" && (
            <PropertyGroup label="Image">
              <NumberField
                label="Brightness"
                value={obj.imageAdjustments?.brightness ?? 0}
                onChange={(v) =>
                  updateObject(obj.id, {
                    imageAdjustments: {
                      ...obj.imageAdjustments,
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
                      ...obj.imageAdjustments,
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
                      ...obj.imageAdjustments,
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
                  border: "1px solid var(--border-control)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                }}
              >
                Preview Dither
              </button>
            </PropertyGroup>
          )}

          {/* Appearance: stroke and opacity reach no generation request (P48) */}
          <div style={{ marginBottom: "8px" }}>
            <button
              onClick={() => setAppearanceOpen((v) => !v)}
              aria-expanded={appearanceOpen}
              style={{
                ...groupLabelStyle,
                width: "100%",
                background: "none",
                border: "none",
                padding: "4px 0",
                minHeight: "24px",
                cursor: "pointer",
                justifyContent: "flex-start",
                gap: "6px",
                textAlign: "left",
              }}
            >
              <Chevron open={appearanceOpen} />
              <span>Appearance</span>
              <span style={metaStyle}>(not in the G-code)</span>
            </button>
            {appearanceOpen && (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <PropertyRow label="Stroke">
                  <input
                    type="color"
                    value={obj.stroke}
                    onChange={(e) => updateObject(obj.id, { stroke: e.target.value })}
                    onFocus={beginEdit}
                    onBlur={commitEdit}
                    style={{
                      width: "28px",
                      height: "22px",
                      border: "1px solid var(--border-control)",
                      borderRadius: "var(--radius-sm)",
                      background: "none",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  />
                </PropertyRow>
                <NumberField
                  label="Stroke width"
                  value={obj.strokeWidth}
                  onChange={(v) => updateObject(obj.id, { strokeWidth: Math.max(0, v) })}
                  unit="px"
                  step={0.5}
                  onFocus={beginEdit}
                  onBlur={commitEdit}
                />
                <NumberField
                  label="Opacity"
                  value={Math.round(obj.opacity * 100)}
                  onChange={(v) =>
                    updateObject(obj.id, { opacity: Math.max(0, Math.min(100, v)) / 100 })
                  }
                  unit="%"
                  step={1}
                  onFocus={beginEdit}
                  onBlur={commitEdit}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Trailing "(N)" for the Properties section header when several objects are
 *  selected. Same derivation as the panel: selected ids that name a live object.
 *  Selectors return stable store references; the count is derived outside. */
export function PropertiesSelectionCount() {
  const selectedIds = useStore((s) => s.selectedIds);
  const objects = useStore((s) => s.objects);
  const count = objects.filter((o) => selectedIds.includes(o.id)).length;
  return count > 1 ? <>({count})</> : null;
}

const groupLabelStyle: React.CSSProperties = {
  fontSize: "var(--text-2xs)",
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.4px",
  display: "flex",
  alignItems: "center",
};

const metaStyle: React.CSSProperties = {
  textTransform: "none",
  fontWeight: 400,
  letterSpacing: 0,
  fontSize: "var(--text-xs)",
};

const pairStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "8px",
  alignItems: "center",
};

const chipStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--border-control)",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  padding: "2px 6px",
  minHeight: "20px",
  color: "var(--text-secondary)",
  fontSize: "var(--text-xs)",
  lineHeight: 1,
};

function PropertyGroup({
  label,
  children,
  trailing,
}: {
  label: string;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: "8px" }}>
      <div
        style={{
          ...groupLabelStyle,
          justifyContent: "space-between",
          minHeight: "24px",
          marginBottom: "2px",
        }}
      >
        {label}
        {trailing}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>{children}</div>
    </div>
  );
}

/** One 64px label column, 11px secondary (P48). */
function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        minHeight: "24px",
        marginBottom: "4px",
      }}
    >
      <span style={labelStyle(64)}>{label}</span>
      {children}
    </div>
  );
}

function labelStyle(width: number): React.CSSProperties {
  return {
    flex: `0 0 ${width}px`,
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
  };
}

function NumberField({
  label,
  value,
  onChange,
  unit,
  step = 1,
  onFocus,
  onBlur,
  labelWidth = 64,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  unit: string;
  step?: number;
  onFocus?: () => void;
  onBlur?: () => void;
  labelWidth?: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: labelWidth === 64 ? "8px" : "4px",
        minWidth: 0,
      }}
    >
      <span style={labelStyle(labelWidth)}>{label}</span>
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
        style={{ ...inputStyle, minWidth: 0, fontVariantNumeric: "tabular-nums" }}
      />
      <span style={{ flex: "0 0 24px", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
        {unit}
      </span>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  border: "1px solid var(--border-control)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
  padding: "4px 6px",
  fontSize: "var(--text-sm)",
  width: "100%",
};
