import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore, generateId } from "../../app/store";
import { parsePathD } from "../../lib/fileOps";
import type { DesignObject, PathPoint } from "../../app/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

type TraceMode = "standard" | "sketch";

interface TraceResult {
  svg: string;
  pathCount: number;
  widthPx: number;
  heightPx: number;
}

export function ImageTraceDialog({ open, onClose }: Props) {
  const [mode, setMode] = useState<TraceMode>("standard");
  const [threshold, setThreshold] = useState(128);
  const [cornerThreshold, setCornerThreshold] = useState(60);
  const [filterSpeckle, setFilterSpeckle] = useState(4);
  const [invert, setInvert] = useState(false);

  const [preview, setPreview] = useState<{ svg: string; pathCount: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  const generationRef = useRef(0);

  // Get selected image object
  const selectedImage = useStore((s) => {
    const selected = s.objects.filter((o) => s.selectedIds.includes(o.id));
    if (selected.length === 1 && selected[0].type === "image" && selected[0].imageData) {
      return selected[0];
    }
    return null;
  });

  // Preview effect with debounce
  useEffect(() => {
    if (!open || !selectedImage?.imageData) return;

    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);

    const timer = setTimeout(async () => {
      try {
        const result = await invoke<TraceResult>("trace_image_command", {
          params: {
            imageData: selectedImage.imageData,
            mode,
            threshold,
            cornerThreshold,
            filterSpeckle,
            invert,
            previewScale: 0.25,
          },
        });

        if (generation === generationRef.current) {
          setPreview({ svg: result.svg, pathCount: result.pathCount });
          setLoading(false);
        }
      } catch (e) {
        if (generation === generationRef.current) {
          setError(String(e));
          setLoading(false);
        }
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [open, mode, threshold, cornerThreshold, filterSpeckle, invert, selectedImage?.id]);

  if (!open) return null;

  if (!selectedImage) {
    return (
      <>
        <div
          onClick={onClose}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999 }}
        />
        <div
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "420px",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            boxShadow: "var(--shadow-modal)",
            zIndex: 10000,
            padding: "20px",
          }}
        >
          <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "12px" }}>
            Trace Image
          </div>
          <div style={{ color: "var(--text-secondary)", fontSize: "13px", marginBottom: "16px" }}>
            Select a single image object to trace.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={onClose}
              style={{
                background: "none",
                border: "1px solid var(--border)",
                color: "var(--text-secondary)",
                padding: "6px 16px",
                borderRadius: "var(--radius-sm)",
                cursor: "pointer",
                fontSize: "13px",
              }}
            >
              Close
            </button>
          </div>
        </div>
      </>
    );
  }

  async function handleCommit() {
    if (!selectedImage?.imageData || committing) return;
    setCommitting(true);

    try {
      const result = await invoke<TraceResult>("trace_image_command", {
        params: {
          imageData: selectedImage.imageData,
          mode,
          threshold,
          cornerThreshold,
          filterSpeckle,
          invert,
          previewScale: 1.0,
        },
      });

      // Parse SVG to extract paths
      const parser = new DOMParser();
      const doc = parser.parseFromString(result.svg, "image/svg+xml");
      const pathElements = doc.querySelectorAll("path");

      const store = useStore.getState();
      const layerColor = store.layers[store.activeLayerIndex]?.color || "#4a90e2";
      const newIds: string[] = [];

      const imgT = selectedImage.transform;

      for (const pathEl of pathElements) {
        const d = pathEl.getAttribute("d");
        if (!d) continue;

        const rawPoints = parsePathD(d);
        if (rawPoints.length < 2) continue;

        // Scale from SVG pixel space to mm space
        const scaledPoints: PathPoint[] = rawPoints.map((p) => {
          const scaled: PathPoint = {
            x: imgT.x + (p.x / result.widthPx) * imgT.width,
            y: imgT.y + (p.y / result.heightPx) * imgT.height,
          };
          if (p.handleIn) {
            scaled.handleIn = {
              x: imgT.x + (p.handleIn.x / result.widthPx) * imgT.width,
              y: imgT.y + (p.handleIn.y / result.heightPx) * imgT.height,
            };
          }
          if (p.handleOut) {
            scaled.handleOut = {
              x: imgT.x + (p.handleOut.x / result.widthPx) * imgT.width,
              y: imgT.y + (p.handleOut.y / result.heightPx) * imgT.height,
            };
          }
          return scaled;
        });

        // Compute bounding box
        const xs = scaledPoints.map((p) => p.x);
        const ys = scaledPoints.map((p) => p.y);
        const minX = Math.min(...xs),
          minY = Math.min(...ys);
        const maxX = Math.max(...xs),
          maxY = Math.max(...ys);

        const closed = /[Zz]\s*$/.test(d.trim());

        const obj: DesignObject = {
          id: generateId(),
          type: "path",
          name: "Traced path",
          transform: {
            x: minX,
            y: minY,
            width: maxX - minX || 1,
            height: maxY - minY || 1,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
          },
          layerIndex: store.activeLayerIndex,
          visible: true,
          locked: false,
          fill: null,
          stroke: layerColor,
          strokeWidth: 1,
          opacity: 1,
          points: scaledPoints,
          closed,
        };

        store.addObject(obj);
        newIds.push(obj.id);
      }

      if (newIds.length > 0) {
        store.setSelectedIds(newIds);
        store.addConsoleLine(`Traced image: ${newIds.length} paths added`, "info");
      }

      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
  }

  const chipStyle = (active: boolean): React.CSSProperties => ({
    background: active ? "var(--accent-warm)" : "var(--bg-input)",
    border: "1px solid " + (active ? "var(--accent-warm)" : "var(--border)"),
    color: active ? "#fff" : "var(--text-secondary)",
    padding: "4px 12px",
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    fontSize: "12px",
  });

  const sliderLabelStyle: React.CSSProperties = {
    fontSize: "12px",
    color: "var(--text-secondary)",
    minWidth: "80px",
  };

  const sliderStyle: React.CSSProperties = {
    flex: 1,
    accentColor: "var(--accent-warm)",
  };

  const sliderValueStyle: React.CSSProperties = {
    fontSize: "12px",
    color: "var(--text-muted)",
    minWidth: "32px",
    textAlign: "right",
  };

  const previewSvgUrl = preview?.svg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.svg)}`
    : null;

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999 }}
      />
      <div
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "420px",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-modal)",
          zIndex: 10000,
          padding: "20px",
        }}
      >
        {/* Header */}
        <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "16px" }}>
          Trace Image
        </div>

        {/* Mode selector */}
        <div style={{ display: "flex", gap: "6px", marginBottom: "16px" }}>
          <button style={chipStyle(mode === "standard")} onClick={() => setMode("standard")}>
            Standard
          </button>
          <button style={chipStyle(mode === "sketch")} onClick={() => setMode("sketch")}>
            Sketch
          </button>
        </div>

        {/* Sliders */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={sliderLabelStyle}>Threshold</span>
            <input
              type="range"
              min={1}
              max={255}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              style={sliderStyle}
            />
            <span style={sliderValueStyle}>{threshold}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={sliderLabelStyle}>Smoothness</span>
            <input
              type="range"
              min={0}
              max={180}
              value={cornerThreshold}
              onChange={(e) => setCornerThreshold(Number(e.target.value))}
              style={sliderStyle}
            />
            <span style={sliderValueStyle}>{cornerThreshold}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={sliderLabelStyle}>Min Area</span>
            <input
              type="range"
              min={0}
              max={100}
              value={filterSpeckle}
              onChange={(e) => setFilterSpeckle(Number(e.target.value))}
              style={sliderStyle}
            />
            <span style={sliderValueStyle}>{filterSpeckle} px</span>
          </div>
        </div>

        {/* Invert checkbox */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            marginBottom: "16px",
            cursor: "pointer",
            fontSize: "12px",
            color: "var(--text-secondary)",
          }}
        >
          <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
          Invert
        </label>

        {/* Preview area */}
        <div
          style={{
            background: "#1a1a2e",
            borderRadius: "var(--radius-sm)",
            height: "200px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: "12px",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {loading && <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>Adjusting...</span>}
          {!loading && error && <span style={{ color: "#e24a4a", fontSize: "12px" }}>{error}</span>}
          {!loading && previewSvgUrl && (
            <img
              src={previewSvgUrl}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
              alt="Trace preview"
            />
          )}
          {!loading && preview && (
            <span
              style={{
                position: "absolute",
                bottom: "8px",
                right: "8px",
                fontSize: "11px",
                color: "var(--text-muted)",
                background: "rgba(0,0,0,0.5)",
                padding: "2px 6px",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {preview.pathCount} path{preview.pathCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {/* Buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "1px solid var(--border)",
              color: "var(--text-secondary)",
              padding: "6px 16px",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleCommit}
            disabled={committing || !preview}
            style={{
              background: preview && !committing ? "var(--accent-warm)" : "var(--bg-input)",
              border: "none",
              color: preview && !committing ? "#fff" : "var(--text-muted)",
              padding: "6px 16px",
              borderRadius: "var(--radius-sm)",
              cursor: preview && !committing ? "pointer" : "default",
              fontSize: "13px",
            }}
          >
            {committing ? "Tracing..." : "Trace to Canvas"}
          </button>
        </div>
      </div>
    </>
  );
}
