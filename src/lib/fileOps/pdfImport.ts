/**
 * PDF Import module.
 * Lazy-loads pdfjs-dist to render PDF pages as raster images.
 * The actual rendering is done in PdfImportDialog.tsx;
 * this module provides the file-loading entry point and vector path extraction.
 */

import type { DesignObject, PathPoint } from "../../app/types";

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

// --- Vector path extraction from PDF operator list ---

/** Points-to-mm factor: 1 PDF point = 25.4/72 mm */
const PT_TO_MM = 25.4 / 72;

interface SubPath {
  points: PathPoint[];
  closed: boolean;
}

/** Apply a 6-element transform matrix [a,b,c,d,e,f] to (x,y) */
function applyTransform(x: number, y: number, m: number[]): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Multiply two 6-element transform matrices */
function multiplyTransform(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/**
 * Extract vector paths from a pdfjs page using getOperatorList().
 *
 * Supports: moveTo, lineTo, curveTo (cubic bezier), closePath, rectangle,
 * transform matrix, save/restore, stroke/fill color (for layer assignment).
 *
 * Skips: text, images, clipping, gradients, shading.
 *
 * @returns Array of DesignObjects (paths), or empty array if no vectors found.
 */
export async function extractVectorPaths(
  page: any,
  pageHeightPt: number,
  generateId: () => string,
  layerIndex: number,
): Promise<DesignObject[]> {
  const pdfjsLib = await import("pdfjs-dist");
  const OPS = pdfjsLib.OPS;

  const opList = await page.getOperatorList();
  const ops: number[] = opList.fnArray;
  const args: any[][] = opList.argsArray;

  const objects: DesignObject[] = [];

  // Current graphics state
  let ctm: number[] = [1, 0, 0, 1, 0, 0]; // current transform matrix
  const stateStack: Array<{ ctm: number[]; strokeColor: string }> = [];
  let strokeColor = "#000000";

  // Current path being built
  let currentPath: SubPath[] = [];
  let currentSubPath: PathPoint[] = [];

  function flushSubPath() {
    if (currentSubPath.length > 0) {
      currentPath.push({ points: currentSubPath, closed: false });
      currentSubPath = [];
    }
  }

  /** Convert a PDF-space point to Kerf-space (mm, Y-up to Y-down) */
  function toKerf(px: number, py: number): PathPoint {
    const [tx, ty] = applyTransform(px, py, ctm);
    return {
      x: tx * PT_TO_MM,
      y: (pageHeightPt - ty) * PT_TO_MM, // flip Y: PDF is bottom-up, Kerf is top-down
    };
  }

  function emitPaths(pathList: SubPath[]) {
    for (const sub of pathList) {
      if (sub.points.length < 2) continue;

      // Compute bounding box (include bezier control points which can extend beyond endpoints)
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of sub.points) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
        if (pt.handleIn) {
          minX = Math.min(minX, pt.handleIn.x);
          minY = Math.min(minY, pt.handleIn.y);
          maxX = Math.max(maxX, pt.handleIn.x);
          maxY = Math.max(maxY, pt.handleIn.y);
        }
        if (pt.handleOut) {
          minX = Math.min(minX, pt.handleOut.x);
          minY = Math.min(minY, pt.handleOut.y);
          maxX = Math.max(maxX, pt.handleOut.x);
          maxY = Math.max(maxY, pt.handleOut.y);
        }
      }

      const obj: DesignObject = {
        id: generateId(),
        type: "path",
        name: `PDF Path`,
        transform: {
          x: minX,
          y: minY,
          width: maxX - minX || 1,
          height: maxY - minY || 1,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
        },
        layerIndex,
        visible: true,
        locked: false,
        fill: null,
        stroke: strokeColor,
        strokeWidth: 0.5,
        opacity: 1,
        points: sub.points,
        closed: sub.closed,
      };
      objects.push(obj);
    }
  }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const arg = args[i];

    switch (op) {
      case OPS.save:
        stateStack.push({ ctm: [...ctm], strokeColor });
        break;

      case OPS.restore:
        if (stateStack.length > 0) {
          const state = stateStack.pop()!;
          ctm = state.ctm;
          strokeColor = state.strokeColor;
        }
        break;

      case OPS.transform:
        ctm = multiplyTransform(ctm, arg as number[]);
        break;

      case OPS.moveTo: {
        flushSubPath();
        const pt = toKerf(arg[0], arg[1]);
        currentSubPath = [pt];
        break;
      }

      case OPS.lineTo: {
        const pt = toKerf(arg[0], arg[1]);
        currentSubPath.push(pt);
        break;
      }

      case OPS.curveTo: {
        // Cubic bezier: cp1x, cp1y, cp2x, cp2y, x, y
        const cp1 = toKerf(arg[0], arg[1]);
        const cp2 = toKerf(arg[2], arg[3]);
        const end = toKerf(arg[4], arg[5]);

        // Store control points as handleOut on previous point and handleIn on end point
        if (currentSubPath.length > 0) {
          const prev = currentSubPath[currentSubPath.length - 1];
          prev.handleOut = { x: cp1.x, y: cp1.y };
        }
        end.handleIn = { x: cp2.x, y: cp2.y };
        currentSubPath.push(end);
        break;
      }

      case OPS.curveTo2: {
        // curveTo2: cp2x, cp2y, x, y (cp1 = current point)
        const cp2 = toKerf(arg[0], arg[1]);
        const end = toKerf(arg[2], arg[3]);
        if (currentSubPath.length > 0) {
          const prev = currentSubPath[currentSubPath.length - 1];
          prev.handleOut = { x: prev.x, y: prev.y };
        }
        end.handleIn = { x: cp2.x, y: cp2.y };
        currentSubPath.push(end);
        break;
      }

      case OPS.curveTo3: {
        // curveTo3: cp1x, cp1y, x, y (cp2 = end point)
        const cp1 = toKerf(arg[0], arg[1]);
        const end = toKerf(arg[2], arg[3]);
        if (currentSubPath.length > 0) {
          const prev = currentSubPath[currentSubPath.length - 1];
          prev.handleOut = { x: cp1.x, y: cp1.y };
        }
        end.handleIn = { x: end.x, y: end.y };
        currentSubPath.push(end);
        break;
      }

      case OPS.closePath:
        if (currentSubPath.length > 0) {
          currentPath.push({ points: currentSubPath, closed: true });
          currentSubPath = [];
        }
        break;

      case OPS.rectangle: {
        // rectangle(x, y, w, h) -- emit as closed path directly
        flushSubPath();
        const [rx, ry, rw, rh] = arg;
        const p1 = toKerf(rx, ry);
        const p2 = toKerf(rx + rw, ry);
        const p3 = toKerf(rx + rw, ry + rh);
        const p4 = toKerf(rx, ry + rh);
        currentPath.push({ points: [p1, p2, p3, p4], closed: true });
        break;
      }

      case OPS.stroke:
      case OPS.closeStroke: {
        if (op === OPS.closeStroke && currentSubPath.length > 0) {
          currentPath.push({ points: currentSubPath, closed: true });
          currentSubPath = [];
        } else {
          flushSubPath();
        }
        emitPaths(currentPath);
        currentPath = [];
        break;
      }

      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke: {
        // For fill/fillStroke ops, still emit as stroked paths (useful for vector cutting)
        flushSubPath();
        // Mark fill paths as closed
        for (const sub of currentPath) {
          sub.closed = true;
        }
        emitPaths(currentPath);
        currentPath = [];
        break;
      }

      case OPS.endPath:
        // Discard current path (clipping path that wasn't stroked/filled)
        currentSubPath = [];
        currentPath = [];
        break;

      case OPS.setStrokeRGBColor:
        strokeColor = `#${toHex(arg[0])}${toHex(arg[1])}${toHex(arg[2])}`;
        break;

      case OPS.setStrokeGray:
        strokeColor = `#${toHex(arg[0])}${toHex(arg[0])}${toHex(arg[0])}`;
        break;

      // Skip text, image, clipping, and other ops we don't handle
      default:
        break;
    }
  }

  // Flush any remaining paths
  flushSubPath();
  if (currentPath.length > 0) {
    emitPaths(currentPath);
  }

  return objects;
}

/** Convert a 0-1 float color component to two-char hex */
function toHex(v: number): string {
  const n = Math.round(Math.max(0, Math.min(1, v)) * 255);
  return n.toString(16).padStart(2, "0");
}
