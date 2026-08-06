/**
 * PDF Import module.
 * Lazy-loads pdfjs-dist to render PDF pages as raster images.
 * The actual rendering is done in PdfImportDialog.tsx;
 * this module provides the file-loading entry point and vector path extraction.
 */

import type { DesignObject, PathPoint } from "../../app/types";
import { pointsBBox, buildGroupObject, applyMatrix2x3, multiplyMatrix2x3 } from "../geometry";
import { MM_PER_INCH, PT_PER_INCH } from "../constants";

/** Read PDF bytes from a Uint8Array (e.g., from Tauri fs) */
export function pdfBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Copy into a fresh ArrayBuffer (avoids SharedArrayBuffer issues from wasm)
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

// --- Vector path extraction from PDF operator list ---

/** Points-to-mm factor: 1 PDF point = 25.4/72 mm */
const PT_TO_MM = MM_PER_INCH / PT_PER_INCH;

interface SubPath {
  points: PathPoint[];
  closed: boolean;
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
    const t = applyMatrix2x3(ctm, px, py);
    return {
      x: t.x * PT_TO_MM,
      y: (pageHeightPt - t.y) * PT_TO_MM, // flip Y: PDF is bottom-up, Kerf is top-down
    };
  }

  function emitPaths(pathList: SubPath[]) {
    // Filter out degenerate sub-paths (< 2 points) before grouping
    const validSubs = pathList.filter((sub) => sub.points.length >= 2);
    if (validSubs.length === 0) return;

    // Build individual path DesignObjects for each subpath.
    // W1b: ANCHORS-ONLY bbox (the app-wide invariant definition — a curve
    // may overshoot the anchor bbox; accepted and consistent: the bbox is a
    // selection/handle frame, not a render bound). No ||1 clamp — axis-
    // parallel PDF segments get their true zero-thickness bbox; hit-testing
    // carries the ε band for them.
    const subObjects: DesignObject[] = validSubs.map((sub) => {
      const bb = pointsBBox(sub.points);
      return {
        id: generateId(),
        type: "path",
        name: `PDF Path`,
        transform: {
          x: bb.x,
          y: bb.y,
          width: bb.width,
          height: bb.height,
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
      } as DesignObject;
    });

    if (subObjects.length === 1) {
      // Single-subpath: emit as a flat path (unchanged behavior)
      objects.push(subObjects[0]);
    } else {
      // Compound path (multiple subpaths): group via buildGroupObject BEFORE objects.push
      // so the outer/hole pairing is preserved for fill coalescing (Phase 1 fix).
      // Regrouping after objects.push is wrong — the pairing is lost once objects are separate.
      // This mirrors the SVG/trace producers (SvgImportDialog, ImageTraceDialog).
      const group = buildGroupObject(subObjects, generateId(), "PDF Compound Path", layerIndex);
      objects.push(group);
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
        ctm = multiplyMatrix2x3(ctm, arg as number[]);
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
        // pdfjs v5 emits a single hex string "#rrggbb"; v4 emitted 3 floats.
        if (typeof arg[0] === "string" && arg[0].startsWith("#")) {
          strokeColor = arg[0];
        } else {
          strokeColor = `#${toHex(arg[0])}${toHex(arg[1])}${toHex(arg[2])}`;
        }
        break;

      case OPS.setStrokeGray:
        strokeColor = `#${toHex(arg[0])}${toHex(arg[0])}${toHex(arg[0])}`;
        break;

      // pdfjs v5 packs all path ops into a single OPS.constructPath call.
      // Args: [finishingOp, [Float32Array pathData], minMax].
      // pathData is a flat buffer of DrawOPS opcodes interleaved with coords:
      //   moveTo(0)=2 coords, lineTo(1)=2, curveTo(2)=6, quadraticCurveTo(3)=4, closePath(4)=0.
      case OPS.constructPath: {
        const pathDataArr = arg[1];
        if (!pathDataArr || !pathDataArr[0]) break;
        const buf: Float32Array | number[] = pathDataArr[0];
        let j = 0;
        while (j < buf.length) {
          const drawOp = buf[j++];
          switch (drawOp) {
            case 0: { // moveTo
              flushSubPath();
              const pt = toKerf(buf[j], buf[j + 1]);
              currentSubPath = [pt];
              j += 2;
              break;
            }
            case 1: { // lineTo
              const pt = toKerf(buf[j], buf[j + 1]);
              currentSubPath.push(pt);
              j += 2;
              break;
            }
            case 2: { // curveTo (cubic bezier): cp1x,cp1y,cp2x,cp2y,x,y
              const cp1 = toKerf(buf[j], buf[j + 1]);
              const cp2 = toKerf(buf[j + 2], buf[j + 3]);
              const end = toKerf(buf[j + 4], buf[j + 5]);
              if (currentSubPath.length > 0) {
                currentSubPath[currentSubPath.length - 1].handleOut = { x: cp1.x, y: cp1.y };
              }
              end.handleIn = { x: cp2.x, y: cp2.y };
              currentSubPath.push(end);
              j += 6;
              break;
            }
            case 3: { // quadraticCurveTo: qx,qy,x,y — promote to cubic
              const qx = buf[j], qy = buf[j + 1];
              const ex = buf[j + 2], ey = buf[j + 3];
              if (currentSubPath.length > 0) {
                // Reverse-transform last Kerf point back to PDF space is complex;
                // instead compute cubic CPs in Kerf space directly.
                const prev = currentSubPath[currentSubPath.length - 1];
                const qKerf = toKerf(qx, qy);
                const endKerf = toKerf(ex, ey);
                const cp1x = prev.x + (2 / 3) * (qKerf.x - prev.x);
                const cp1y = prev.y + (2 / 3) * (qKerf.y - prev.y);
                const cp2x = endKerf.x + (2 / 3) * (qKerf.x - endKerf.x);
                const cp2y = endKerf.y + (2 / 3) * (qKerf.y - endKerf.y);
                prev.handleOut = { x: cp1x, y: cp1y };
                endKerf.handleIn = { x: cp2x, y: cp2y };
                currentSubPath.push(endKerf);
              } else {
                currentSubPath.push(toKerf(ex, ey));
              }
              j += 4;
              break;
            }
            case 4: // closePath
              if (currentSubPath.length > 0) {
                currentPath.push({ points: currentSubPath, closed: true });
                currentSubPath = [];
              }
              break;
            default:
              // Unknown draw op — bail out of this constructPath to avoid
              // misaligned reads
              j = buf.length;
              break;
          }
        }
        // The finishing op (arg[0]) determines how to emit.
        // Process it like the corresponding standalone op.
        const finishOp = arg[0];
        if (finishOp === OPS.stroke || finishOp === OPS.closeStroke) {
          if (finishOp === OPS.closeStroke && currentSubPath.length > 0) {
            currentPath.push({ points: currentSubPath, closed: true });
            currentSubPath = [];
          } else {
            flushSubPath();
          }
          emitPaths(currentPath);
          currentPath = [];
        } else if (
          finishOp === OPS.fill || finishOp === OPS.eoFill ||
          finishOp === OPS.fillStroke || finishOp === OPS.eoFillStroke ||
          finishOp === OPS.closeFillStroke || finishOp === OPS.closeEOFillStroke
        ) {
          flushSubPath();
          for (const sub of currentPath) sub.closed = true;
          emitPaths(currentPath);
          currentPath = [];
        } else if (finishOp === OPS.endPath) {
          currentSubPath = [];
          currentPath = [];
        }
        break;
      }

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
