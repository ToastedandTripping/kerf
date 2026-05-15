import { useState, useMemo } from "react";
import { useStore, generateId } from "../../app/store";
import type { DesignObject } from "../../app/types";

interface Props {
  open: boolean;
  imageData: string | null;
  fileName: string;
  imageWidth: number;
  imageHeight: number;
  onClose: () => void;
  onImported: () => void;
}

export function ImageImportDialog({ open, imageData, fileName, imageWidth, imageHeight, onClose, onImported }: Props) {
  const layers = useStore((s) => s.layers);
  const [selectedLayer, setSelectedLayer] = useState(0);
  const [autoTrace, setAutoTrace] = useState(true);

  const widthMm = useMemo(() => (imageWidth / 96) * 25.4, [imageWidth]);
  const heightMm = useMemo(() => (imageHeight / 96) * 25.4, [imageHeight]);

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
        width: widthMm, height: heightMm,
        rotation: 0, scaleX: 1, scaleY: 1,
      },
      layerIndex: selectedLayer,
      visible: true, locked: false,
      fill: null, stroke: layerColor, strokeWidth: 0, opacity: 1,
      imageData: imageData || undefined,
    };

    store.addObject(obj);
    store.setSelectedIds([obj.id]);
    store.addConsoleLine(
      `Imported ${fileName} to ${layers[selectedLayer]?.name} (${imageWidth}x${imageHeight}px, ${widthMm.toFixed(0)}x${heightMm.toFixed(0)}mm)`,
      "info"
    );

    onImported();
    onClose();
  }

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999 }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        width: "420px", background: "var(--bg-panel)", border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-modal)", zIndex: 10000,
        padding: "20px",
      }}>
        <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "16px" }}>
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
          {fileName} -- {imageWidth}x{imageHeight}px ({widthMm.toFixed(0)}x{heightMm.toFixed(0)}mm)
        </div>

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
          After tracing, right-click any path to move it to a different layer. Each traced element can be on its own layer for separate cut/engrave settings.
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
