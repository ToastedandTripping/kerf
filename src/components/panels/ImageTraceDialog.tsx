import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore, generateId } from "../../app/store";
import { parsePathD } from "../../lib/fileOps";
import { pointsBBox, buildGroupObject, signedArea } from "../../lib/geometry";
import type { DesignObject, PathPoint, Transform } from "../../app/types";
import { useEscapeClose } from "../../lib/hooks/useEscapeClose";
import { useFocusTrap } from "../../lib/hooks/useFocusTrap";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Build path DesignObjects from a trace result's SVG — the production object
 * construction for the trace creator (exported so the W1b invariant sweep can
 * exercise it without the Rust tracer). Anchors-only loop bbox, no ||1 clamp:
 * traced objects are born with transform ≡ pointsBBox.
 *
 * Fix 1: All per-image paths are wrapped in a single top-level group named
 * "Trace: {imageName}" so the whole trace moves as a unit and doesn't scatter
 * under grid snap.
 *
 * Fix 2: Each closed contour is normalized to CCW winding (positive signedArea
 * in screen Y-down coords). CW paths fill inward on engrave layers, producing
 * inconsistent solid/outline mixed output. Reversing CW paths to CCW ensures
 * all letters fill consistently regardless of vtracer's winding choice.
 */
export function buildTracedPathObjects(
  svg: string,
  imgT: Transform,
  widthPx: number,
  heightPx: number,
  layerIndex: number,
  layerColor: string,
  imageName?: string,
): DesignObject[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, "image/svg+xml");
  const pathElements = doc.querySelectorAll("path");

  const allPathObjects: DesignObject[] = [];
  for (const pathEl of pathElements) {
    const d = pathEl.getAttribute("d");
    if (!d) continue;

    let offsetX = 0, offsetY = 0;
    const transformAttr = pathEl.getAttribute("transform");
    if (transformAttr) {
      const m = transformAttr.match(/translate\(\s*([^,\s]+)\s*[,\s]\s*([^)]+)\)/);
      if (m) { offsetX = parseFloat(m[1]) || 0; offsetY = parseFloat(m[2]) || 0; }
    }

    // W1c (F20): vtracer emits compound `d` per cluster (M..Z M..Z for shapes
    // with holes) — split into per-contour objects; group ONLY when more than
    // one survives (detailed traces produce many single-subpath paths — don't
    // wrap each in a one-child group). Per-subpath closed flags replace the
    // old trailing-Z regex.
    const contourObjects: DesignObject[] = [];
    for (const sub of parsePathD(d)) {
      if (sub.points.length < 2) continue;
      let scaledPoints: PathPoint[] = sub.points.map((p) => {
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

      // Fix 2: Normalize closed paths to CCW winding (positive signedArea in
      // screen Y-down coords). vtracer output has inconsistent winding; on
      // engrave/fill layers, CW paths fill inward (solid) while CCW fill
      // outward (outline-only). Normalizing to CCW ensures consistent fill.
      if (sub.closed && scaledPoints.length >= 3) {
        const pts = scaledPoints.map((p): [number, number] => [p.x, p.y]);
        if (signedArea(pts) < 0) {
          // CW → reverse to CCW (also swap handles to preserve curve direction)
          scaledPoints = scaledPoints.slice().reverse().map((p) => ({
            ...p,
            handleIn: p.handleOut,
            handleOut: p.handleIn,
          }));
        }
      }

      const bb = pointsBBox(scaledPoints);

      contourObjects.push({
        id: generateId(), type: "path", name: "Traced path",
        transform: { x: bb.x, y: bb.y, width: bb.width, height: bb.height, rotation: 0, scaleX: 1, scaleY: 1 },
        layerIndex, visible: true, locked: false,
        fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
        points: scaledPoints, closed: sub.closed,
      });
    }

    if (contourObjects.length === 1) {
      allPathObjects.push(contourObjects[0]);
    } else if (contourObjects.length > 1) {
      allPathObjects.push(buildGroupObject(contourObjects, generateId(), "Traced path", layerIndex));
    }
  }

  // Fix 1: Wrap all output paths from a single image in one top-level group so
  // the whole trace moves as a unit. Without this, grid snap scatters individual
  // letters/parts on the first drag. Users can Ungroup (Ctrl+Shift+G) if needed.
  if (allPathObjects.length <= 1) return allPathObjects;
  const groupName = imageName ? `Trace: ${imageName}` : "Traced image";
  return [buildGroupObject(allPathObjects, generateId(), groupName, layerIndex)];
}

// ─── Preview zoom ─────────────────────────────────────────────────────────────

export const ZOOM_STEPS = [25, 50, 100, 200, 400];
const PREVIEW_BUDGET_PX = 1600;

/**
 * Finds the largest ZOOM_STEPS index whose value fits the image inside the
 * container at that zoom level. Mirrors DitherPreviewDialog fit logic.
 *
 * @param containerW  Preview container width in px
 * @param containerH  Preview container height in px
 * @param imgW        Image pixel width (widthPx from TraceResult)
 * @param imgH        Image pixel height (heightPx from TraceResult)
 * @returns Index into ZOOM_STEPS
 */
export function computeFitZoomIndex(
  containerW: number,
  containerH: number,
  imgW: number,
  imgH: number,
): number {
  if (imgW === 0 || imgH === 0) return 2; // default to 100%
  const fitPct = Math.min(containerW / imgW, containerH / imgH) * 100;
  let best = 0;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    if (ZOOM_STEPS[i] <= fitPct) best = i;
  }
  return best;
}

// ─── Component ────────────────────────────────────────────────────────────────

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
    // useAdaptiveThreshold off: clean binary art bypasses via is_near_binary anyway;
    // this protects the anti-aliased case from adaptive halos. morphRadius 0: open()
    // was eroding fine strokes. blurRadius 0.5: lighter noise reduction. ignoreArea 15.
    mode: "standard", threshold: 128, thresholdLow: 0, cornerThreshold: 60,
    filterSpeckle: 4, blurRadius: 0.5, smoothness: 0.8, ignoreArea: 15,
    useAdaptiveThreshold: false, adaptiveBlockSize: 15, morphRadius: 0,
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
    useAdaptiveThreshold: false, adaptiveBlockSize: 11, morphRadius: 0,
  },
};

// Preview container inner dimensions (dialog 580px - 40px padding = 540px wide, 360px tall)
const PREVIEW_CONTAINER_W = 540;
const PREVIEW_CONTAINER_H = 360;

export function ImageTraceDialog({ open, onClose }: Props) {
  const [preset, setPreset] = useState<Preset>("auto");
  const [mode, setMode] = useState<TraceMode>("standard");
  const [threshold, setThreshold] = useState(128);
  const [thresholdLow, setThresholdLow] = useState(0);
  const [cornerThreshold, setCornerThreshold] = useState(60);
  const [filterSpeckle, setFilterSpeckle] = useState(4);
  const [invert, setInvert] = useState(false);
  const [blurRadius, setBlurRadius] = useState(0.5);
  const [smoothness, setSmoothness] = useState(0.8);
  const [ignoreArea, setIgnoreArea] = useState(15);
  const [useAdaptiveThreshold, setUseAdaptiveThreshold] = useState(false);
  const [adaptiveBlockSize, setAdaptiveBlockSize] = useState(15);
  const [morphRadius, setMorphRadius] = useState(0);
  const [traceTransparency, setTraceTransparency] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [preview, setPreview] = useState<{ svg: string; pathCount: number; widthPx: number; heightPx: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(2); // default: 100%

  const generationRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEscapeClose(open, onClose);
  useFocusTrap(dialogRef, open);

  // Fix 4: Layer selector — allows targeting a specific layer at trace time.
  // Defaults to active layer; user can switch to any layer (Engrave, Score, Cut, etc.)
  // before committing without having to change the active layer first.
  const [targetLayerIndex, setTargetLayerIndex] = useState<number | null>(null);

  const layers = useStore((s) => s.layers);
  const activeLayerIndex = useStore((s) => s.activeLayerIndex);
  const selectedIds = useStore((s) => s.selectedIds);
  const objects = useStore((s) => s.objects);
  const selectedImage = (selectedIds.length === 1
    && objects.find((o) => o.id === selectedIds[0] && o.type === "image" && o.imageData))
    || null;

  // When the dialog opens, reset the layer target to the active layer
  useEffect(() => {
    if (open) setTargetLayerIndex(null);
  }, [open]);

  const effectiveLayerIndex = targetLayerIndex ?? activeLayerIndex;

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
      traceTransparency,
    };
  }

  // Preview with debounce.
  // Adaptive scale: full-res for images ≤ PREVIEW_BUDGET_PX on long side; capped
  // for huge scans to bound latency. Uses dims from previous preview if available,
  // falls back to 0.25 for first render so there's something to show quickly.
  // Commit always uses scale 1.0 (buildParams(1.0) in handleCommit).
  useEffect(() => {
    if (!open || !selectedImage?.imageData) return;
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);

    const prevDims = preview;
    const adaptiveScale = prevDims
      ? Math.min(1.0, PREVIEW_BUDGET_PX / Math.max(prevDims.widthPx, prevDims.heightPx, 1))
      : 0.25;

    const timer = setTimeout(async () => {
      try {
        const result = await invoke<TraceResult>("trace_image_command", { params: buildParams(adaptiveScale) });
        if (generation === generationRef.current) {
          setPreview({ svg: result.svg, pathCount: result.pathCount, widthPx: result.widthPx, heightPx: result.heightPx });
          setZoomIndex(computeFitZoomIndex(PREVIEW_CONTAINER_W, PREVIEW_CONTAINER_H, result.widthPx, result.heightPx));
          setLoading(false);
        }
      } catch (e) {
        if (generation === generationRef.current) { setError(String(e)); setLoading(false); }
      }
    }, 400);

    return () => clearTimeout(timer);
    // `preview` is intentionally excluded: adaptiveScale reads prior dims via stale closure
    // so preview updates don't re-trigger the trace effect (avoids infinite loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, threshold, thresholdLow, cornerThreshold, filterSpeckle, invert,
      blurRadius, smoothness, ignoreArea, useAdaptiveThreshold, adaptiveBlockSize,
      morphRadius, traceTransparency, selectedImage?.id]);

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
      const layerColor = store.layers[effectiveLayerIndex]?.color || "#4a90e2";
      const imageName = selectedImage.name || selectedImage.id;

      const prepared = buildTracedPathObjects(
        result.svg,
        selectedImage.transform,
        result.widthPx,
        result.heightPx,
        effectiveLayerIndex,
        layerColor,
        imageName,
      );

      store.withUndo("trace", () => {
        const newIds: string[] = [];
        for (const obj of prepared) { store.addObject(obj); newIds.push(obj.id); }
        if (newIds.length > 0) {
          store.setSelectedIds(newIds);
          store.addConsoleLine(`Traced image: ${newIds.length === 1 ? "1 group" : `${newIds.length} paths`} added to ${store.layers[effectiveLayerIndex]?.name ?? "layer"}`, "info");
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

  const zoomBtnStyle = (disabled: boolean): React.CSSProperties => ({
    background: "var(--bg-input)", border: "1px solid var(--border)",
    color: disabled ? "var(--text-muted)" : "var(--text-secondary)",
    width: "24px", height: "24px", borderRadius: "var(--radius-sm)",
    cursor: disabled ? "default" : "pointer", fontSize: "13px",
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    opacity: disabled ? 0.4 : 1,
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

  const currentZoom = ZOOM_STEPS[zoomIndex];

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999 }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-trace-main-dialog-title"
        style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        width: "580px", maxHeight: "85vh", overflow: "auto",
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
          <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer", fontSize: "11px", color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={traceTransparency} onChange={(e) => setTraceTransparency(e.target.checked)} />
            Trace transparency
          </label>
        </div>

        {/* Fix 4: Layer selector */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <span style={{ fontSize: "11px", color: "var(--text-secondary)", minWidth: "70px" }}>Trace to</span>
          <select
            value={effectiveLayerIndex}
            onChange={(e) => setTargetLayerIndex(Number(e.target.value))}
            style={{
              flex: 1, background: "var(--bg-input)", border: "1px solid var(--border)",
              color: "var(--text-primary)", padding: "4px 8px", borderRadius: "var(--radius-sm)",
              fontSize: "11px", cursor: "pointer",
            }}
          >
            {layers.map((layer, idx) => (
              <option key={idx} value={idx}>
                {layer.name}{idx === activeLayerIndex ? " (active)" : ""}
              </option>
            ))}
          </select>
          <span style={{
            width: "10px", height: "10px", borderRadius: "50%", flexShrink: 0,
            background: layers[effectiveLayerIndex]?.color || "#4a90e2",
            border: "1px solid var(--border)",
          }} />
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

        {/* Zoom controls + info strip */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}>
          <button
            style={zoomBtnStyle(zoomIndex === 0)}
            onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
            disabled={zoomIndex === 0}
            aria-label="Zoom out"
          >−</button>
          <span style={{ fontSize: "11px", color: "var(--text-muted)", minWidth: "36px", textAlign: "center" }}>
            {currentZoom}%
          </span>
          <button
            style={zoomBtnStyle(zoomIndex === ZOOM_STEPS.length - 1)}
            onClick={() => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            aria-label="Zoom in"
          >+</button>
          <button
            onClick={() => preview && setZoomIndex(computeFitZoomIndex(PREVIEW_CONTAINER_W, PREVIEW_CONTAINER_H, preview.widthPx, preview.heightPx))}
            disabled={!preview}
            style={{
              background: "var(--bg-input)", border: "1px solid var(--border)",
              color: preview ? "var(--text-secondary)" : "var(--text-muted)",
              padding: "2px 8px", borderRadius: "var(--radius-sm)",
              cursor: preview ? "pointer" : "default", fontSize: "11px",
              opacity: preview ? 1 : 0.4,
            }}
          >Fit</button>
          {preview && (
            <span style={{ marginLeft: "auto", fontSize: "11px", color: "var(--text-muted)" }}>
              {preview.pathCount} contour{preview.pathCount !== 1 ? "s" : ""} · {preview.widthPx}×{preview.heightPx}px
            </span>
          )}
        </div>

        {/* Preview — scrollable at high zoom, full-res for typical images */}
        <div style={{
          background: "#1a1a2e", borderRadius: "var(--radius-sm)", height: "360px",
          marginBottom: "12px", position: "relative", overflow: "auto",
        }}>
          {loading && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
              <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>Processing...</span>
            </div>
          )}
          {!loading && error && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
              <span style={{ color: "#e24a4a", fontSize: "12px" }}>{error}</span>
            </div>
          )}
          {!loading && previewSvgUrl && preview && (() => {
            const scaledW = Math.round(preview.widthPx * currentZoom / 100);
            const scaledH = Math.round(preview.heightPx * currentZoom / 100);
            return (
              <img
                src={previewSvgUrl}
                style={{ width: scaledW, height: scaledH, display: "block" }}
                alt="Trace preview"
              />
            );
          })()}
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
