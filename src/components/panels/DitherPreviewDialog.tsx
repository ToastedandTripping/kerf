import { useState, useEffect } from "react";
import { previewImageDither } from "../../lib/machine/gcodeGen";
import type { PreviewDitherResult } from "../../lib/machine/gcodeGen";

const ZOOM_STEPS = [25, 50, 100, 200, 400];

export function DitherPreviewDialog({
  open,
  objectId,
  onClose,
}: {
  open: boolean;
  objectId: string | null;
  onClose: () => void;
}) {
  const [result, setResult] = useState<PreviewDitherResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoomIndex, setZoomIndex] = useState(2); // default 100%
  const titleId = "dither-preview-title";

  useEffect(() => {
    if (!open || !objectId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setZoomIndex(2);

    previewImageDither(objectId)
      .then((r) => {
        setResult(r);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [open, objectId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const zoom = ZOOM_STEPS[zoomIndex];
  const canZoomOut = zoomIndex > 0;
  const canZoomIn = zoomIndex < ZOOM_STEPS.length - 1;

  const fitZoom = () => {
    if (!result) return;
    const containerW = 600;
    const containerH = 380;
    const scaleW = containerW / result.width;
    const scaleH = containerH / result.height;
    const fitPct = Math.min(scaleW, scaleH) * 100;
    // Find closest zoom step
    let best = 0;
    for (let i = 0; i < ZOOM_STEPS.length; i++) {
      if (ZOOM_STEPS[i] <= fitPct) best = i;
    }
    setZoomIndex(best);
  };

  // Estimated time placeholder (would need data from the backend)
  const estTime = result
    ? formatTime(estimateEngraveTime(result.width, result.height))
    : "--";

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 9999,
        }}
      />
      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 640,
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-modal)",
          zIndex: 10000,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Title */}
        <div
          id={titleId}
          style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}
        >
          Engrave Preview
        </div>

        {/* Preview area */}
        <div
          style={{
            background: "#111111",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            width: "100%",
            height: 380,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            position: "relative",
          }}
        >
          {loading && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Processing...</span>
          )}
          {error && (
            <span style={{ fontSize: 12, color: "var(--danger)" }}>{error}</span>
          )}
          {result && !loading && (
            <img
              src={result.imageData}
              alt="Dither preview"
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
                imageRendering: "pixelated",
                transform: `scale(${zoom / 100})`,
                transformOrigin: "center center",
              }}
            />
          )}
          {/* Zoom badge */}
          <div
            style={{
              position: "absolute",
              bottom: 8,
              right: 8,
              background: "rgba(0,0,0,0.6)",
              padding: "2px 8px",
              borderRadius: "var(--radius-sm)",
              fontSize: 10,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {zoom === 100 ? "1:1" : `${zoom}%`}
          </div>
        </div>

        {/* Zoom controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}>
          <button
            onClick={() => canZoomOut && setZoomIndex(zoomIndex - 1)}
            disabled={!canZoomOut}
            style={{
              width: 32,
              height: 24,
              background: "var(--bg-input)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-secondary)",
              cursor: canZoomOut ? "pointer" : "not-allowed",
              fontSize: 14,
              opacity: canZoomOut ? 1 : 0.4,
            }}
          >
            -
          </button>
          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              minWidth: 36,
              textAlign: "center",
            }}
          >
            {zoom}%
          </span>
          <button
            onClick={() => canZoomIn && setZoomIndex(zoomIndex + 1)}
            disabled={!canZoomIn}
            style={{
              width: 32,
              height: 24,
              background: "var(--bg-input)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-secondary)",
              cursor: canZoomIn ? "pointer" : "not-allowed",
              fontSize: 14,
              opacity: canZoomIn ? 1 : 0.4,
            }}
          >
            +
          </button>
          <button
            onClick={fitZoom}
            style={{
              padding: "4px 10px",
              fontSize: 11,
              background: "var(--bg-input)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            Fit
          </button>
        </div>

        {/* Info strip */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 4,
            background: "var(--bg-input)",
            borderRadius: "var(--radius-sm)",
            padding: "6px 10px",
          }}
        >
          <div>
            <span
              style={{
                color: "var(--text-muted)",
                fontSize: 9,
                textTransform: "uppercase",
                letterSpacing: 0.3,
                display: "block",
                marginBottom: 1,
              }}
            >
              Resolution
            </span>
            <span
              style={{
                color: "var(--text-primary)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
            >
              {result ? `${result.width} x ${result.height} px` : "--"}
            </span>
          </div>
          <div>
            <span
              style={{
                color: "var(--text-muted)",
                fontSize: 9,
                textTransform: "uppercase",
                letterSpacing: 0.3,
                display: "block",
                marginBottom: 1,
              }}
            >
              Method
            </span>
            <span
              style={{
                color: "var(--text-primary)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
            >
              {result?.ditherMethod ?? "--"}
            </span>
          </div>
          <div>
            <span
              style={{
                color: "var(--text-muted)",
                fontSize: 9,
                textTransform: "uppercase",
                letterSpacing: 0.3,
                display: "block",
                marginBottom: 1,
              }}
            >
              Est. Time (approx.)
            </span>
            <span
              style={{
                color: "var(--text-primary)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
            >
              {estTime}
            </span>
          </div>
        </div>

        {/* Close button */}
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
              fontSize: 13,
            }}
          >
            Close
          </button>
        </div>
      </div>
    </>
  );
}

/** Rough engrave time estimate from pixel dimensions.
 *  Uses hardcoded assumptions (100mm/s, 0.1mm interval) -- does not
 *  reflect actual layer settings. Displayed as "approx." in the UI. */
function estimateEngraveTime(w: number, h: number): number {
  const interval = 0.1;  // assumed line interval (mm)
  const speed = 100;     // assumed engrave speed (mm/s)
  const widthMm = w * interval;
  const rows = h;
  return (rows * widthMm) / speed;
}

function formatTime(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${s}s`;
}
