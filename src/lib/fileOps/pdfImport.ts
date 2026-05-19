/**
 * PDF Import module.
 * Lazy-loads pdfjs-dist to render PDF pages as raster images.
 * The actual rendering is done in PdfImportDialog.tsx;
 * this module provides the file-loading entry point.
 */

/** Read a PDF file into an ArrayBuffer suitable for pdfjs-dist */
export async function loadPdfFile(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read PDF as ArrayBuffer"));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** Read PDF bytes from a Uint8Array (e.g., from Tauri fs) */
export function pdfBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Copy into a fresh ArrayBuffer (avoids SharedArrayBuffer issues from wasm)
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

/** Calculate pixel dimensions for a given DPI and page size in points */
export function calculatePixelDimensions(
  pageWidthPt: number,
  pageHeightPt: number,
  dpi: number,
): { width: number; height: number; mmWidth: number; mmHeight: number } {
  // 1 point = 1/72 inch
  const width = Math.round(pageWidthPt * dpi / 72);
  const height = Math.round(pageHeightPt * dpi / 72);
  const mmWidth = Math.round(pageWidthPt * 25.4 / 72);
  const mmHeight = Math.round(pageHeightPt * 25.4 / 72);
  return { width, height, mmWidth, mmHeight };
}
