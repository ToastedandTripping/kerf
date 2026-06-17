import { useState, useRef } from "react";
import { useStore, generateId } from "../../app/store";
import type { DesignObject } from "../../app/types";
import { useEscapeClose } from "../../lib/hooks/useEscapeClose";
import { useFocusTrap } from "../../lib/hooks/useFocusTrap";

const TRACE_TIP_KEY = "kerf_image_trace_tip_dismissed";

interface Props {
  open: boolean;
  imageData: string | null;
  fileName: string;
  imageWidth: number;
  imageHeight: number;
  /** Optional: physical mm dimensions override (used when caller knows the true DPI, e.g. PDF). */
  widthMmOverride?: number;
  heightMmOverride?: number;
  detectedDpi?: number;
  onClose: () => void;
  onImported: (autoTrace: boolean) => void;
}

export function ImageImportDialog({ open, imageData, fileName, imageWidth, imageHeight, widthMmOverride, heightMmOverride, detectedDpi, onClose, onImported }: Props) {
  const layers = useStore((s) => s.layers);
  const [selectedLayer, setSelectedLayer] = useState(0);
  const [autoTrace, setAutoTrace] = useState(true);
  const [dpiOverride, setDpiOverride] = useState<string>("");

  const [tipDismissed, setTipDismissed] = useState(
    () => localStorage.getItem(TRACE_TIP_KEY) === "1",
  );

  const dialogRef = useRef<HTMLDivElement>(null);
  useEscapeClose(open, onClose);
  useFocusTrap(dialogRef, open);

  const selectedLayerMode = layers[selectedLayer]?.mode ?? "line";
  const showTraceTip = !tipDismissed && selectedLayerMode === "fill";

  function dismissTip() {
    localStorage.setItem(TRACE_TIP_KEY, "1");
    setTipDismissed(true);
  }

  const effectiveDpi = dpiOverride ? parseFloat(dpiOverride) || 300 : (detectedDpi ?? 300);
  const effectiveWidthMm = widthMmOverride ?? (imageWidth / effectiveDpi) * 25.4;
  const effectiveHeightMm = heightMmOverride ?? (imageHeight / effectiveDpi) * 25.4;

  if (!open || !imageData) return null;

  function handleImport() {
    const store = useStore.getState();
    const layerColor = layers[selectedLayer]?.color || "#4a90e2";

    const obj: DesignObject = {
      id: generateId(),
      type: "image",
      name: fileName,
      transform: {
        x: 10, y: 10,
        width: effectiveWidthMm, height: effectiveHeightMm,
        rotation: 0, scaleX: 1, scaleY: 1,
      },
      layerIndex: selectedLayer,
      visible: true, locked: false,
      fill: null, stroke: layerColor, strokeWidth: 0, opacity: 1,
      imageData: imageData || undefined,
    };

    store.addObject(obj);
    store.setSelectedIds([obj.id]);
    const dpiNote = widthMmOverride ? "from source DPI" : `at ${effectiveDpi.toFixed(0)} dpi`;
    store.addConsoleLine(
      `Imported ${fileName} to ${layers[selectedLayer]?.name}${imageWidth > 0 ? ` (${imageWidth}x${imageHeight}px)` : ""} ${effectiveWidthMm.toFixed(0)}x${effectiveHeightMm.toFixed(0)}mm ${dpiNote}`,
      "info"
    );

    useStore.getState().setStatusMessage(`Imported ${fileName}${imageWidth > 0 ? ` -- ${imageWidth}x${imageHeight}px` : ""} -- ${effectiveWidthMm.toFixed(0)}x${effectiveHeightMm.toFixed(0)}mm`);
    onImported(autoTrace);
    onClose();
  }

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999 }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-import-dialog-title"
        style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        width: "420px", background: "var(--bg-panel)", border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-modal)", zIndex: 10000,
        padding: "20px",
      }}>
        <div id="image-import-dialog-title" style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "16px" }}>
          Import Image
        </div>

        {/* Preview */}
        <div style={{
          background: "#1a1a2e", borderRadius: "var(--radius-sm)",
          height: "140px", display: "flex", alignItems: "center", justifyContent: "center",
          marginBottom: "16px", overflow: "hidden",
        }}>
          <img src={imageData} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} alt="Preview" />
        </div>

        {/* Info */}
        <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "12px" }}>
          {fileName}{imageWidth > 0 ? ` -- ${imageWidth}x${imageHeight}px` : ""} ({effectiveWidthMm.toFixed(0)}x{effectiveHeightMm.toFixed(0)}mm)
        </div>
        {!widthMmOverride && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
            <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
              DPI: {detectedDpi ? `${detectedDpi.toFixed(0)} (from file)` : "300 (assumed)"}
            </span>
            <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>Override:</span>
            <input
              type="number"
              min="36" max="1200"
              placeholder={String(detectedDpi?.toFixed(0) ?? "300")}
              value={dpiOverride}
              onChange={(e) => setDpiOverride(e.target.value)}
              style={{
                width: "60px", background: "var(--bg-input)", border: "1px solid var(--border)",
                color: "var(--text-primary)", padding: "2px 6px",
                borderRadius: "var(--radius-sm)", fontSize: "11px",
              }}
            />
            <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>DPI</span>
          </div>
        )}

        {/* Layer selection */}
        <div style={{ marginBottom: "12px" }}>
          <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "6px" }}>
            Assign to layer
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {layers.map((l) => (
              <button
                key={l.index}
                onClick={() => setSelectedLayer(l.index)}
                style={{
                  display: "flex", alignItems: "center", gap: "8px",
                  padding: "6px 10px", border: "none", borderRadius: "var(--radius-sm)",
                  background: selectedLayer === l.index ? "var(--bg-active)" : "transparent",
                  cursor: "pointer", width: "100%", textAlign: "left",
                }}
              >
                <div style={{
                  width: "12px", height: "12px", borderRadius: "2px",
                  background: l.color, flexShrink: 0,
                  outline: selectedLayer === l.index ? "2px solid var(--accent)" : "none",
                  outlineOffset: "1px",
                }} />
                <span style={{ fontSize: "12px", color: "var(--text-primary)", flex: 1 }}>{l.name}</span>
                <span style={{
                  fontSize: "9px", padding: "1px 4px", borderRadius: "3px",
                  background: l.mode === "fill" ? "rgba(226,74,74,0.2)" : "rgba(74,144,226,0.2)",
                  color: l.mode === "fill" ? "#e28a8a" : "#8ab4e2",
                  textTransform: "uppercase", fontWeight: 600,
                }}>{l.mode}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Trace tip — shown once for engrave/fill layers */}
        {showTraceTip && (
          <div style={{
            display: "flex", alignItems: "flex-start", gap: "8px",
            fontSize: "11px", color: "var(--text-secondary)", marginBottom: "12px",
            padding: "8px 10px", background: "rgba(74,144,226,0.08)",
            borderRadius: "var(--radius-sm)", border: "1px solid rgba(74,144,226,0.2)",
          }}>
            <span style={{ flex: 1 }}>
              Tip: For text and logos, use Trace (Alt+T) to convert to vectors for faster cutting. Raster engraving scans every pixel — best for photos and detailed images.
            </span>
            <button
              onClick={dismissTip}
              aria-label="Dismiss tip"
              style={{
                flexShrink: 0, background: "none", border: "none",
                color: "var(--text-muted)", cursor: "pointer", fontSize: "13px",
                padding: "0 2px", lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        )}

        {/* Auto-trace option */}
        <label style={{
          display: "flex", alignItems: "center", gap: "6px",
          marginBottom: "16px", cursor: "pointer", fontSize: "12px", color: "var(--text-secondary)",
        }}>
          <input type="checkbox" checked={autoTrace} onChange={(e) => setAutoTrace(e.target.checked)} />
          Open trace dialog after import
        </label>

        {/* Hint */}
        <div style={{
          fontSize: "10px", color: "var(--text-muted)", marginBottom: "16px",
          padding: "8px", background: "rgba(74,144,226,0.06)", borderRadius: "var(--radius-sm)",
        }}>
          After tracing, select any path and use the Layer dropdown in Properties to reassign it, or press 1-6. Each traced element can be on its own layer for separate cut/engrave settings.
        </div>

        {/* Buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button onClick={onClose} style={{
            background: "none", border: "1px solid var(--border)",
            color: "var(--text-secondary)", padding: "6px 16px",
            borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "13px",
          }}>Cancel</button>
          <button onClick={handleImport} style={{
            background: "var(--accent-warm)", border: "none", color: "#fff",
            padding: "6px 16px", borderRadius: "var(--radius-sm)",
            cursor: "pointer", fontSize: "13px",
          }}>Import</button>
        </div>
      </div>
    </>
  );
}
