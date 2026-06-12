import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore, generateId } from "../../app/store";
import { parsePathD } from "../../lib/fileOps";
import { pointsBBox } from "../../lib/geometry";
import type { DesignObject, PathPoint, Transform } from "../../app/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Build path DesignObjects from a trace result's SVG — the production object
 * construction for the trace creator (exported so the W1b invariant sweep can
 * exercise it without the Rust tracer). Anchors-only loop bbox, no ||1 clamp:
 * traced objects are born with transform ≡ pointsBBox.
 */
export function buildTracedPathObjects(
  svg: string,
  imgT: Transform,
  widthPx: number,
  heightPx: number,
  layerIndex: number,
  layerColor: string,
): DesignObject[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, "image/svg+xml");
  const pathElements = doc.querySelectorAll("path");

  const prepared: DesignObject[] = [];
  for (const pathEl of pathElements) {
    const d = pathEl.getAttribute("d");
    if (!d) continue;
    const rawPoints = parsePathD(d);
    if (rawPoints.length < 2) continue;

    let offsetX = 0, offsetY = 0;
    const transformAttr = pathEl.getAttribute("transform");
    if (transformAttr) {
      const m = transformAttr.match(/translate\(\s*([^,\s]+)\s*[,\s]\s*([^)]+)\)/);
      if (m) { offsetX = parseFloat(m[1]) || 0; offsetY = parseFloat(m[2]) || 0; }
    }

    const scaledPoints: PathPoint[] = rawPoints.map((p) => {
      const px = p.x + offsetX, py = p.y + offsetY;
      const scaled: PathPoint = {
        x: imgT.x + (px / widthPx) * imgT.width,
        y: imgT.y + (py / heightPx) * imgT.height,
      };
      if (p.handleIn) {
        scaled.handleIn = {
          x: imgT.x + ((p.handleIn.x + offsetX) / widthPx) * imgT.width,
          y: imgT.y + ((p.handleIn.y + offsetY) / heightPx) * imgT.height,
        };
      }
      if (p.handleOut) {
        scaled.handleOut = {
          x: imgT.x + ((p.handleOut.x + offsetX) / widthPx) * imgT.width,
          y: imgT.y + ((p.handleOut.y + offsetY) / heightPx) * imgT.height,
        };
      }
      return scaled;
    });

    const bb = pointsBBox(scaledPoints);

    prepared.push({
      id: generateId(), type: "path", name: "Traced path",
      transform: { x: bb.x, y: bb.y, width: bb.width, height: bb.height, rotation: 0, scaleX: 1, scaleY: 1 },
      layerIndex, visible: true, locked: false,
      fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
      points: scaledPoints, closed: /[Zz]\s*$/.test(d.trim()),
    });
  }
  return prepared;
}

type TraceMode = "standard" | "sketch";
type Preset = "auto" | "logo" | "photo" | "detailed" | "custom";

interface TraceResult {
  svg: string;
  pathCount: number;
  widthPx: number;
  heightPx: number;
}

const PRESETS: Record<Exclude<Preset, "custom">, {
  mode: TraceMode; threshold: number; thresholdLow: number; cornerThreshold: number;
  filterSpeckle: number; blurRadius: number; smoothness: number; ignoreArea: number;
  useAdaptiveThreshold: boolean; adaptiveBlockSize: number; morphRadius: number;
}> = {
  auto: {
    mode: "standard", threshold: 128, thresholdLow: 0, cornerThreshold: 60,
    filterSpeckle: 4, blurRadius: 1.0, smoothness: 0.8, ignoreArea: 20,
    useAdaptiveThreshold: true, adaptiveBlockSize: 15, morphRadius: 1,
  },
  logo: {
    mode: "standard", threshold: 128, thresholdLow: 0, cornerThreshold: 40,
    filterSpeckle: 8, blurRadius: 0.5, smoothness: 1.0, ignoreArea: 30,
    useAdaptiveThreshold: false, adaptiveBlockSize: 15, morphRadius: 0,
  },
  photo: {
    mode: "sketch", threshold: 100, thresholdLow: 0, cornerThreshold: 80,
    filterSpeckle: 6, blurRadius: 2.0, smoothness: 1.2, ignoreArea: 40,
    useAdaptiveThreshold: false, adaptiveBlockSize: 21, morphRadius: 1,
  },
  detailed: {
    mode: "standard", threshold: 128, thresholdLow: 0, cornerThreshold: 30,
    filterSpeckle: 2, blurRadius: 0.5, smoothness: 0.4, ignoreArea: 5,
    useAdaptiveThreshold: true, adaptiveBlockSize: 11, morphRadius: 0,
  },
};

export function ImageTraceDialog({ open, onClose }: Props) {
  const [preset, setPreset] = useState<Preset>("auto");
  const [mode, setMode] = useState<TraceMode>("standard");
  const [threshold, setThreshold] = useState(128);
  const [thresholdLow, setThresholdLow] = useState(0);
  const [cornerThreshold, setCornerThreshold] = useState(60);
  const [filterSpeckle, setFilterSpeckle] = useState(4);
  const [invert, setInvert] = useState(false);
  const [blurRadius, setBlurRadius] = useState(1.0);
  const [smoothness, setSmoothness] = useState(0.8);
  const [ignoreArea, setIgnoreArea] = useState(20);
  const [useAdaptiveThreshold, setUseAdaptiveThreshold] = useState(true);
  const [adaptiveBlockSize, setAdaptiveBlockSize] = useState(15);
  const [morphRadius, setMorphRadius] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [preview, setPreview] = useState<{ svg: string; pathCount: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  const generationRef = useRef(0);

  const selectedImage = useStore((s) => {
    const selected = s.objects.filter((o) => s.selectedIds.includes(o.id));
    if (selected.length === 1 && selected[0].type === "image" && selected[0].imageData) {
      return selected[0];
    }
    return null;
  });

  function applyPreset(p: Exclude<Preset, "custom">) {
    const v = PRESETS[p];
    setPreset(p);
    setMode(v.mode); setThreshold(v.threshold); setThresholdLow(v.thresholdLow);
    setCornerThreshold(v.cornerThreshold); setFilterSpeckle(v.filterSpeckle);
    setBlurRadius(v.blurRadius); setSmoothness(v.smoothness);
    setIgnoreArea(v.ignoreArea); setUseAdaptiveThreshold(v.useAdaptiveThreshold);
    setAdaptiveBlockSize(v.adaptiveBlockSize); setMorphRadius(v.morphRadius);
  }

  function buildParams(scale: number) {
    return {
      imageData: selectedImage!.imageData!,
      mode, threshold, thresholdLow, cornerThreshold, filterSpeckle, invert,
      previewScale: scale, blurRadius, smoothness, ignoreArea,
      useAdaptiveThreshold, adaptiveBlockSize, morphRadius,
    };
  }

  // Preview with debounce
  useEffect(() => {
    if (!open || !selectedImage?.imageData) return;
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);

    const timer = setTimeout(async () => {
      try {
        const result = await invoke<TraceResult>("trace_image_command", { params: buildParams(0.25) });
        if (generation === generationRef.current) {
          setPreview({ svg: result.svg, pathCount: result.pathCount });
          setLoading(false);
        }
      } catch (e) {
        if (generation === generationRef.current) { setError(String(e)); setLoading(false); }
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [open, mode, threshold, thresholdLow, cornerThreshold, filterSpeckle, invert,
      blurRadius, smoothness, ignoreArea, useAdaptiveThreshold, adaptiveBlockSize,
      morphRadius, selectedImage?.id]);

  if (!open) return null;

  if (!selectedImage) {
    return (
      <>
        <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999 }} />
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="image-trace-dialog-title"
          style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          width: "420px", background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-modal)", zIndex: 10000, padding: "20px",
        }}>
          <div id="image-trace-dialog-title" style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "12px" }}>Trace Image</div>
          <div style={{ color: "var(--text-secondary)", fontSize: "13px", marginBottom: "16px" }}>Select a single image object to trace.</div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button onClick={onClose} style={{ background: "none", border: "1px solid var(--border)", color: "var(--text-secondary)", padding: "6px 16px", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "13px" }}>Close</button>
          </div>
        </div>
      </>
    );
  }

  async function handleCommit() {
    if (!selectedImage?.imageData || committing) return;
    setCommitting(true);
    try {
      const result = await invoke<TraceResult>("trace_image_command", { params: buildParams(1.0) });
      const store = useStore.getState();
      const layerColor = store.layers[store.activeLayerIndex]?.color || "#4a90e2";

      const prepared = buildTracedPathObjects(
        result.svg,
        selectedImage.transform,
        result.widthPx,
        result.heightPx,
        store.activeLayerIndex,
        layerColor,
      );

      store.withUndo("trace", () => {
        const newIds: string[] = [];
        for (const obj of prepared) { store.addObject(obj); newIds.push(obj.id); }
        if (newIds.length > 0) {
          store.setSelectedIds(newIds);
          store.addConsoleLine(`Traced image: ${newIds.length} paths added`, "info");
        }
      });
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
    padding: "4px 10px", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "11px",
  });

  const sliderRow = (label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void, unit?: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <span style={{ fontSize: "11px", color: "var(--text-secondary)", minWidth: "70px" }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => { onChange(Number(e.target.value)); if (preset !== "custom") setPreset("custom"); }}
        style={{ flex: 1, accentColor: "var(--accent-warm)" }} />
      <span style={{ fontSize: "11px", color: "var(--text-muted)", minWidth: "36px", textAlign: "right" }}>
        {step < 1 ? value.toFixed(1) : value}{unit || ""}
      </span>
    </div>
  );

  const previewSvgUrl = preview?.svg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.svg)}` : null;

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999 }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-trace-main-dialog-title"
        style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        width: "460px", maxHeight: "85vh", overflow: "auto",
        background: "var(--bg-panel)", border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-modal)", zIndex: 10000, padding: "20px",
      }}>
        <div id="image-trace-main-dialog-title" style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "16px" }}>Trace Image</div>

        {/* Presets */}
        <div style={{ display: "flex", gap: "4px", marginBottom: "12px", flexWrap: "wrap" }}>
          {(["auto", "logo", "photo", "detailed"] as const).map((p) => (
            <button key={p} style={chipStyle(preset === p)} onClick={() => applyPreset(p)}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
          <button style={chipStyle(preset === "custom")} onClick={() => setPreset("custom")}>Custom</button>
        </div>

        {/* Mode */}
        <div style={{ display: "flex", gap: "4px", marginBottom: "12px" }}>
          <button style={chipStyle(mode === "standard")} onClick={() => { setMode("standard"); if (preset !== "custom") setPreset("custom"); }}>Standard</button>
          <button style={chipStyle(mode === "sketch")} onClick={() => { setMode("sketch"); if (preset !== "custom") setPreset("custom"); }}>Sketch</button>
        </div>

        {/* Core controls */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "12px" }}>
          {sliderRow("Threshold", threshold, 1, 255, 1, setThreshold)}
          {sliderRow("Smoothness", smoothness, 0, 1.5, 0.1, setSmoothness)}
          {sliderRow("Blur", blurRadius, 0, 5, 0.5, setBlurRadius, "px")}
          {sliderRow("Min Area", ignoreArea, 0, 200, 5, setIgnoreArea, "px")}
        </div>

        {/* Invert + adaptive threshold */}
        <div style={{ display: "flex", gap: "12px", marginBottom: "12px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer", fontSize: "11px", color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} /> Invert
          </label>
          {mode === "standard" && (
            <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer", fontSize: "11px", color: "var(--text-secondary)" }}>
              <input type="checkbox" checked={useAdaptiveThreshold}
                onChange={(e) => { setUseAdaptiveThreshold(e.target.checked); if (preset !== "custom") setPreset("custom"); }} />
              Adaptive threshold
            </label>
          )}
        </div>

        {/* Advanced */}
        <button onClick={() => setShowAdvanced(!showAdvanced)} style={{
          background: "none", border: "none", color: "var(--text-muted)",
          fontSize: "10px", cursor: "pointer", padding: "2px 0", textTransform: "uppercase", marginBottom: "8px",
        }}>
          {showAdvanced ? "▼" : "▶"} Advanced
        </button>
        {showAdvanced && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "12px", paddingLeft: "8px", borderLeft: "2px solid var(--border)" }}>
            {mode === "standard" && !useAdaptiveThreshold && sliderRow("Low Cutoff", thresholdLow, 0, 254, 1, setThresholdLow)}
            {sliderRow("Corner", cornerThreshold, 0, 180, 1, setCornerThreshold, "°")}
            {sliderRow("Speckle", filterSpeckle, 0, 50, 1, setFilterSpeckle)}
            {sliderRow("Morph", morphRadius, 0, 5, 1, setMorphRadius, "px")}
            {useAdaptiveThreshold && sliderRow("Block Size", adaptiveBlockSize, 3, 51, 2, setAdaptiveBlockSize)}
          </div>
        )}

        {/* Preview */}
        <div style={{
          background: "#1a1a2e", borderRadius: "var(--radius-sm)", height: "200px",
          display: "flex", alignItems: "center", justifyContent: "center",
          marginBottom: "12px", position: "relative", overflow: "hidden",
        }}>
          {loading && <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>Processing...</span>}
          {!loading && error && <span style={{ color: "#e24a4a", fontSize: "12px" }}>{error}</span>}
          {!loading && previewSvgUrl && (
            <img src={previewSvgUrl} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} alt="Trace preview" />
          )}
          {!loading && preview && (
            <span style={{
              position: "absolute", bottom: "8px", right: "8px", fontSize: "11px", color: "var(--text-muted)",
              background: "rgba(0,0,0,0.5)", padding: "2px 6px", borderRadius: "var(--radius-sm)",
            }}>{preview.pathCount} path{preview.pathCount !== 1 ? "s" : ""}</span>
          )}
        </div>

        {/* Hint */}
        <div style={{
          fontSize: "10px", color: "var(--text-muted)", marginBottom: "12px",
          padding: "6px 8px", background: "rgba(74,144,226,0.06)", borderRadius: "var(--radius-sm)",
        }}>
          For complex images, trace in Inkscape (Path &gt; Trace Bitmap) and import the SVG for best results.
        </div>

        {/* Buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button onClick={onClose} style={{
            background: "none", border: "1px solid var(--border)", color: "var(--text-secondary)",
            padding: "6px 16px", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "13px",
          }}>Cancel</button>
          <button onClick={handleCommit} disabled={committing || !preview} style={{
            background: preview && !committing ? "var(--accent-warm)" : "var(--bg-input)",
            border: "none", color: preview && !committing ? "#fff" : "var(--text-muted)",
            padding: "6px 16px", borderRadius: "var(--radius-sm)",
            cursor: preview && !committing ? "pointer" : "default", fontSize: "13px",
          }}>{committing ? "Tracing..." : "Trace to Canvas"}</button>
        </div>
      </div>
    </>
  );
}
