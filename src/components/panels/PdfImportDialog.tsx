import { useState, useEffect, useRef, useCallback } from "react";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { DesignObject } from "../../app/types";
import { useStore } from "../../app/store";
import { extractVectorPaths } from "../../lib/fileOps/pdfImport";

interface PdfImportDialogProps {
  open: boolean;
  pdfData: ArrayBuffer | null;
  fileName: string;
  onClose: () => void;
  onImport: (imageData: string, width: number, height: number) => void;
  onImportVector?: (objects: DesignObject[]) => void;
  generateId?: () => string;
  defaultLayerIndex?: number;
}

interface PageInfo {
  pageNum: number;
  thumbnail: string | null;
  /** Page width in PDF points (1 pt = 1/72 inch), at scale 1.0 */
  widthPt: number;
  /** Page height in PDF points (1 pt = 1/72 inch), at scale 1.0 */
  heightPt: number;
}

type ImportMode = "raster" | "vector";

export function PdfImportDialog({ open, pdfData, fileName, onClose, onImport, onImportVector, generateId, defaultLayerIndex }: PdfImportDialogProps) {
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [selectedPage, setSelectedPage] = useState<number>(1);
  const [dpi, setDpi] = useState(150);
  const [mode, setMode] = useState<ImportMode>("raster");
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Load PDF when data changes
  useEffect(() => {
    if (!open || !pdfData) return;

    let cancelled = false;

    async function loadPdf() {
      setLoading(true);
      setError(null);
      setPages([]);
      setSelectedPage(1);
      setPreview(null);

      try {
        const pdfjsLib = await import("pdfjs-dist");
        // Set worker source - use Vite ?url import for reliable bundling in Tauri production builds
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

        const loadingTask = pdfjsLib.getDocument({ data: pdfData! });
        const doc = await loadingTask.promise;

        if (cancelled) return;
        pdfDocRef.current = doc;

        // Generate thumbnails for all pages
        const pageInfos: PageInfo[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale: 1.0 }); // Scale 1.0 = dimensions in PDF points
          pageInfos.push({
            pageNum: i,
            thumbnail: null,
            widthPt: viewport.width,
            heightPt: viewport.height,
          });
        }

        if (cancelled) return;
        setPages(pageInfos);
        setSelectedPage(1);

        // Render thumbnails lazily
        for (let i = 0; i < Math.min(pageInfos.length, 20); i++) {
          if (cancelled) break;
          const page = await doc.getPage(i + 1);
          const viewport = page.getViewport({ scale: 0.3 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            await page.render({ canvasContext: ctx, viewport, canvas }).promise;
            if (!cancelled) {
              setPages((prev) =>
                prev.map((p) =>
                  p.pageNum === i + 1 ? { ...p, thumbnail: canvas.toDataURL() } : p
                )
              );
            }
          }
        }

        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(`Failed to load PDF: ${e}`);
          setLoading(false);
        }
      }
    }

    loadPdf();
    return () => { cancelled = true; };
  }, [open, pdfData]);

  // Render preview when selection/DPI changes
  useEffect(() => {
    if (!open || !pdfDocRef.current || !selectedPage) return;

    let cancelled = false;

    async function renderPreview() {
      try {
        const doc = pdfDocRef.current;
        if (!doc) return;
        const page = await doc.getPage(selectedPage);
        const pdfWidth = page.getViewport({ scale: 1 }).width;
        const scale = (dpi / 72) * (pdfWidth > 0 ? 1 : 1);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
          if (!cancelled) {
            setPreview(canvas.toDataURL("image/png"));
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(`Preview render failed: ${e}`);
        }
      }
    }

    renderPreview();
    return () => { cancelled = true; };
  }, [open, selectedPage, dpi]);

  const handleImport = useCallback(async () => {
    if (!pdfDocRef.current || !selectedPage) return;

    setLoading(true);
    try {
      const doc = pdfDocRef.current;
      const page = await doc.getPage(selectedPage);

      if (mode === "vector" && onImportVector && generateId) {
        // Vector extraction mode
        const viewport = page.getViewport({ scale: 1.0 });
        const pageHeightPt = viewport.height;
        const layerIdx = defaultLayerIndex ?? 0;
        const vectorObjects = await extractVectorPaths(page, pageHeightPt, generateId, layerIdx);

        if (vectorObjects.length === 0) {
          // No vectors found (scanned PDF) -- fall back to raster
          useStore.getState().setStatusMessage("No vector paths found -- imported as raster image");
          const scale = dpi / 72;
          const rasterViewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = rasterViewport.width;
          canvas.height = rasterViewport.height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            await page.render({ canvasContext: ctx, viewport: rasterViewport, canvas }).promise;
            const imageData = canvas.toDataURL("image/png");
            onImport(imageData, rasterViewport.width, rasterViewport.height);
          }
        } else {
          onImportVector(vectorObjects);
        }
      } else {
        // Raster mode (existing behavior)
        const scale = dpi / 72;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
          const imageData = canvas.toDataURL("image/png");
          onImport(imageData, viewport.width, viewport.height);
        }
      }
    } catch (e) {
      setError(`Import failed: ${e}`);
    }
    setLoading(false);
  }, [selectedPage, dpi, mode, onImport, onImportVector, generateId, defaultLayerIndex]);

  // Handle Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  // Calculate pixel dimensions for the DPI readout
  // PageInfo stores dimensions in PDF points (1 pt = 1/72 inch) at scale 1.0
  const selectedPageInfo = pages.find((p) => p.pageNum === selectedPage);
  const pxWidth = selectedPageInfo ? Math.round(selectedPageInfo.widthPt * dpi / 72) : 0;
  const pxHeight = selectedPageInfo ? Math.round(selectedPageInfo.heightPt * dpi / 72) : 0;
  const mmWidth = selectedPageInfo ? Math.round(selectedPageInfo.widthPt * 25.4 / 72) : 0;
  const mmHeight = selectedPageInfo ? Math.round(selectedPageInfo.heightPt * 25.4 / 72) : 0;

  const titleId = "pdf-import-title";

  return (
    <>
      {/* Backdrop */}
      <div
        ref={backdropRef}
        onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
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
          width: "600px",
          maxHeight: "85vh",
          overflow: "hidden",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-modal)",
          zIndex: 10000,
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        {/* Title */}
        <div id={titleId} style={{
          fontSize: "14px",
          fontWeight: 600,
          color: "var(--text-primary)",
        }}>
          Import PDF
        </div>

        {/* Filename + page count */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}>
          <span style={{
            fontSize: "12px",
            color: "var(--text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}>
            {fileName}
          </span>
          <span style={{
            fontSize: "11px",
            color: "var(--text-secondary)",
            flexShrink: 0,
          }}>
            {pages.length > 0 ? `${pages.length} page${pages.length !== 1 ? "s" : ""}` : ""}
          </span>
        </div>

        {error && (
          <div style={{
            fontSize: "12px",
            color: "var(--danger)",
            padding: "8px",
            background: "rgba(226,74,74,0.1)",
            borderRadius: "var(--radius-sm)",
          }}>
            {error}
          </div>
        )}

        {/* Thumbnail grid */}
        {pages.length > 1 && (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
            gap: "8px",
            maxHeight: "200px",
            overflow: "auto",
            background: "var(--bg-input)",
            borderRadius: "var(--radius-sm)",
            padding: "8px",
            border: "1px solid var(--border)",
          }}>
            {pages.map((page) => (
              <div
                key={page.pageNum}
                onClick={() => setSelectedPage(page.pageNum)}
                style={{
                  width: "100%",
                  aspectRatio: "210/297",
                  background: "#111111",
                  borderRadius: "var(--radius-sm)",
                  overflow: "hidden",
                  cursor: "pointer",
                  border: selectedPage === page.pageNum
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
                  position: "relative",
                  transition: "border-color 100ms ease",
                }}
                onMouseEnter={(e) => {
                  if (selectedPage !== page.pageNum)
                    e.currentTarget.style.borderColor = "rgba(74,144,226,0.4)";
                }}
                onMouseLeave={(e) => {
                  if (selectedPage !== page.pageNum)
                    e.currentTarget.style.borderColor = "transparent";
                }}
              >
                {page.thumbnail ? (
                  <img
                    src={page.thumbnail}
                    alt={`Page ${page.pageNum}`}
                    style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  />
                ) : (
                  <div style={{
                    width: "100%",
                    height: "100%",
                    background: "rgba(255,255,255,0.04)",
                  }} />
                )}
                <span style={{
                  position: "absolute",
                  bottom: "2px",
                  right: "4px",
                  fontSize: "8px",
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  background: "rgba(0,0,0,0.5)",
                  padding: "1px 3px",
                  borderRadius: "2px",
                }}>
                  {page.pageNum}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Page preview */}
        <div style={{
          background: "#111111",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border)",
          height: "240px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}>
          {preview ? (
            <img
              src={preview}
              alt={`Page ${selectedPage} preview`}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            />
          ) : (
            <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
              {loading ? "Rendering..." : "No preview"}
            </span>
          )}
        </div>

        {/* DPI row */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{
              fontSize: "11px",
              color: "var(--text-muted)",
              minWidth: "28px",
              textTransform: "uppercase",
              letterSpacing: "0.3px",
            }}>
              DPI
            </span>
            <input
              type="range"
              min={72}
              max={600}
              step={12}
              value={dpi}
              onChange={(e) => setDpi(Number(e.target.value))}
              style={{ flex: 1, accentColor: "var(--accent)" }}
            />
            <input
              type="number"
              min={72}
              max={600}
              step={12}
              value={dpi}
              onChange={(e) => setDpi(Math.max(72, Math.min(600, Number(e.target.value))))}
              style={{
                width: "50px",
                textAlign: "right",
                background: "var(--bg-input)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-primary)",
                padding: "3px 6px",
                fontSize: "11px",
              }}
            />
            <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>dpi</span>
          </div>
          {selectedPageInfo && (
            <div style={{
              fontSize: "10px",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              display: "block",
              marginTop: "3px",
              paddingLeft: "36px",
            }}>
              {"→"} {pxWidth} x {pxHeight} px ({mmWidth} x {mmHeight} mm)
            </div>
          )}
        </div>

        {/* Mode toggle */}
        <div>
          <div style={{ display: "flex", gap: "4px" }}>
            <button
              onClick={() => setMode("raster")}
              style={{
                padding: "4px 12px",
                fontSize: "11px",
                borderRadius: "var(--radius-sm)",
                cursor: "pointer",
                background: mode === "raster" ? "rgba(196,165,123,0.15)" : "var(--bg-input)",
                border: mode === "raster" ? "1px solid var(--accent-warm)" : "1px solid var(--border)",
                color: mode === "raster" ? "var(--accent-warm)" : "var(--text-secondary)",
              }}
            >
              Raster
            </button>
            <button
              onClick={() => setMode("vector")}
              style={{
                padding: "4px 12px",
                fontSize: "11px",
                borderRadius: "var(--radius-sm)",
                cursor: "pointer",
                background: mode === "vector" ? "rgba(74,144,226,0.15)" : "var(--bg-input)",
                border: mode === "vector" ? "1px solid var(--accent)" : "1px solid var(--border)",
                color: mode === "vector" ? "var(--accent)" : "var(--text-secondary)",
              }}
            >
              Vector
            </button>
          </div>
          {mode === "vector" && (
            <div style={{
              fontSize: "10px",
              color: "var(--text-muted)",
              padding: "6px 8px",
              background: "rgba(74,144,226,0.06)",
              borderRadius: "var(--radius-sm)",
              marginTop: "4px",
            }}>
              Vector extraction works best with Illustrator or Inkscape PDFs.
              Scanned documents will fall back to raster.
            </div>
          )}
        </div>

        {/* Action buttons */}
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
            onClick={handleImport}
            disabled={!selectedPage || loading || pages.length === 0}
            style={{
              background: (!selectedPage || loading || pages.length === 0) ? "var(--bg-input)" : "var(--accent-warm)",
              border: "none",
              color: (!selectedPage || loading || pages.length === 0) ? "var(--text-muted)" : "#ffffff",
              padding: "6px 20px",
              borderRadius: "var(--radius-sm)",
              cursor: (!selectedPage || loading || pages.length === 0) ? "not-allowed" : "pointer",
              fontSize: "13px",
              fontWeight: 600,
              opacity: (!selectedPage || loading || pages.length === 0) ? 0.5 : 1,
            }}
          >
            Import
          </button>
        </div>
      </div>
    </>
  );
}
