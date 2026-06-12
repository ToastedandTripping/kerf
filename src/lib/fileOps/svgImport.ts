import type { PathPoint } from "../../app/types";

/** One subpath of a parsed `d` attribute: own points, own closed flag (W1c/F20). */
export interface ParsedSubpath {
  points: PathPoint[];
  closed: boolean;
}

/**
 * Parse an SVG path `d` into SUBPATHS (W1c / F20). Pre-fix, every subpath was
 * concatenated into one points array, so `M..Z M..Z` (donut, glyph, compound
 * path) became one connected polyline — render and cut drew a spurious bridge
 * segment from each subpath's end to the next's start, CUT through the
 * workpiece.
 *
 * The split is IN-PARSER and STATE-PRESERVING (critic-pinned): SVG pen state
 * crosses subpath boundaries — `Z` resets the pen to the CURRENT subpath's
 * start, so a relative `m` after `Z` chains off the PREVIOUS subpath's start
 * point. A stateless split-on-M wrapper would scatter relative-coordinate
 * subpaths while absolute-M tests stayed green. Only the points-array
 * segmentation changes here; the existing pen/reflection state machine is
 * untouched (S/T reflection deliberately re-anchors at every M/m and
 * non-curve command — that is spec behavior, NOT state to carry across).
 *
 * Pinned behaviors:
 *  - Z closes the CURRENT subpath only and flushes it.
 *  - A drawing command after Z without an intervening M starts a NEW subpath
 *    anchored at the just-closed subpath's start point (sx,sy) — matching the
 *    pen-state semantics; it never reopens the closed subpath.
 *  - Leading non-M commands parse from (0,0) without pushing an origin point
 *    (pre-existing behavior, preserved).
 *  - Degenerate subpaths (single stray M point) are returned as-is; callers
 *    apply their own ≥2-point filter.
 *
 * LEGACY objects cannot be migrated: pre-fix imports concatenated subpaths
 * into one stored points[] — the M-boundaries are destroyed at import and a
 * large jump between points is not provably a boundary (glyphs legitimately
 * contain long straight segments). Pre-fix imported compound paths keep the
 * bridge defect; RE-IMPORT to repair.
 */
export function parsePathD(d: string): ParsedSubpath[] {
  const subpaths: ParsedSubpath[] = [];
  let points: PathPoint[] = [];
  let closed = false;
  /** Set by Z; a following drawing command without M anchors a new subpath at (sx,sy). */
  let justClosed = false;
  const flush = (): void => {
    if (points.length > 0) subpaths.push({ points, closed });
    points = [];
    closed = false;
  };
  const tokens = tokenizePath(d);
  let cx = 0, cy = 0;
  let sx = 0, sy = 0;
  let lastCmd = "";
  let lastCx2 = 0, lastCy2 = 0;

  let i = 0;
  while (i < tokens.length) {
    let cmd = tokens[i];

    if (!isNaN(Number(cmd))) {
      if (lastCmd === "M") cmd = "L";
      else if (lastCmd === "m") cmd = "l";
      else cmd = lastCmd;
    } else {
      i++;
    }

    // Post-Z continuation: a drawing command (not M/m/Z/z) after Z starts a
    // new subpath anchored at the closed subpath's start point.
    if (justClosed && points.length === 0 && cmd.length === 1 && "LlHhVvCcSsQqTtAa".indexOf(cmd) !== -1) {
      points.push({ x: sx, y: sy });
    }

    switch (cmd) {
      case "M": {
        flush();
        justClosed = false;
        cx = numT(tokens, i); cy = numT(tokens, i + 1); i += 2;
        sx = cx; sy = cy;
        lastCx2 = cx; lastCy2 = cy; // SVG spec: S/T after non-curve reflects through current point
        points.push({ x: cx, y: cy });
        lastCmd = "M";
        break;
      }
      case "m": {
        flush();
        justClosed = false;
        cx += numT(tokens, i); cy += numT(tokens, i + 1); i += 2;
        sx = cx; sy = cy;
        lastCx2 = cx; lastCy2 = cy;
        points.push({ x: cx, y: cy });
        lastCmd = "m";
        break;
      }
      case "L": {
        cx = numT(tokens, i); cy = numT(tokens, i + 1); i += 2;
        lastCx2 = cx; lastCy2 = cy;
        points.push({ x: cx, y: cy });
        lastCmd = "L";
        break;
      }
      case "l": {
        cx += numT(tokens, i); cy += numT(tokens, i + 1); i += 2;
        lastCx2 = cx; lastCy2 = cy;
        points.push({ x: cx, y: cy });
        lastCmd = "l";
        break;
      }
      case "H": {
        cx = numT(tokens, i); i += 1;
        lastCx2 = cx; lastCy2 = cy;
        points.push({ x: cx, y: cy });
        lastCmd = "H";
        break;
      }
      case "h": {
        cx += numT(tokens, i); i += 1;
        lastCx2 = cx; lastCy2 = cy;
        points.push({ x: cx, y: cy });
        lastCmd = "h";
        break;
      }
      case "V": {
        cy = numT(tokens, i); i += 1;
        lastCx2 = cx; lastCy2 = cy;
        points.push({ x: cx, y: cy });
        lastCmd = "V";
        break;
      }
      case "v": {
        cy += numT(tokens, i); i += 1;
        lastCx2 = cx; lastCy2 = cy;
        points.push({ x: cx, y: cy });
        lastCmd = "v";
        break;
      }
      case "C": {
        const x1 = numT(tokens, i), y1 = numT(tokens, i + 1);
        const x2 = numT(tokens, i + 2), y2 = numT(tokens, i + 3);
        const x = numT(tokens, i + 4), y = numT(tokens, i + 5);
        i += 6;
        if (points.length > 0) {
          points[points.length - 1].handleOut = { x: x1, y: y1 };
        }
        points.push({ x, y, handleIn: { x: x2, y: y2 } });
        lastCx2 = x2; lastCy2 = y2;
        cx = x; cy = y;
        lastCmd = "C";
        break;
      }
      case "c": {
        const x1 = cx + numT(tokens, i), y1 = cy + numT(tokens, i + 1);
        const x2 = cx + numT(tokens, i + 2), y2 = cy + numT(tokens, i + 3);
        const x = cx + numT(tokens, i + 4), y = cy + numT(tokens, i + 5);
        i += 6;
        if (points.length > 0) {
          points[points.length - 1].handleOut = { x: x1, y: y1 };
        }
        points.push({ x, y, handleIn: { x: x2, y: y2 } });
        lastCx2 = x2; lastCy2 = y2;
        cx = x; cy = y;
        lastCmd = "c";
        break;
      }
      case "S": {
        const rx = 2 * cx - lastCx2, ry = 2 * cy - lastCy2;
        const x2 = numT(tokens, i), y2 = numT(tokens, i + 1);
        const x = numT(tokens, i + 2), y = numT(tokens, i + 3);
        i += 4;
        if (points.length > 0) {
          points[points.length - 1].handleOut = { x: rx, y: ry };
        }
        points.push({ x, y, handleIn: { x: x2, y: y2 } });
        lastCx2 = x2; lastCy2 = y2;
        cx = x; cy = y;
        lastCmd = "S";
        break;
      }
      case "s": {
        const rx = 2 * cx - lastCx2, ry = 2 * cy - lastCy2;
        const x2 = cx + numT(tokens, i), y2 = cy + numT(tokens, i + 1);
        const x = cx + numT(tokens, i + 2), y = cy + numT(tokens, i + 3);
        i += 4;
        if (points.length > 0) {
          points[points.length - 1].handleOut = { x: rx, y: ry };
        }
        points.push({ x, y, handleIn: { x: x2, y: y2 } });
        lastCx2 = x2; lastCy2 = y2;
        cx = x; cy = y;
        lastCmd = "s";
        break;
      }
      case "Q": {
        const qx = numT(tokens, i), qy = numT(tokens, i + 1);
        const x = numT(tokens, i + 2), y = numT(tokens, i + 3);
        i += 4;
        const cp1x = cx + (2 / 3) * (qx - cx), cp1y = cy + (2 / 3) * (qy - cy);
        const cp2x = x + (2 / 3) * (qx - x), cp2y = y + (2 / 3) * (qy - y);
        if (points.length > 0) {
          points[points.length - 1].handleOut = { x: cp1x, y: cp1y };
        }
        points.push({ x, y, handleIn: { x: cp2x, y: cp2y } });
        lastCx2 = cp2x; lastCy2 = cp2y;
        cx = x; cy = y;
        lastCmd = "Q";
        break;
      }
      case "q": {
        const qx = cx + numT(tokens, i), qy = cy + numT(tokens, i + 1);
        const x = cx + numT(tokens, i + 2), y = cy + numT(tokens, i + 3);
        i += 4;
        const cp1x = cx + (2 / 3) * (qx - cx), cp1y = cy + (2 / 3) * (qy - cy);
        const cp2x = x + (2 / 3) * (qx - x), cp2y = y + (2 / 3) * (qy - y);
        if (points.length > 0) {
          points[points.length - 1].handleOut = { x: cp1x, y: cp1y };
        }
        points.push({ x, y, handleIn: { x: cp2x, y: cp2y } });
        lastCx2 = cp2x; lastCy2 = cp2y;
        cx = x; cy = y;
        lastCmd = "q";
        break;
      }
      case "T": {
        const rx = 2 * cx - lastCx2, ry = 2 * cy - lastCy2;
        const x = numT(tokens, i), y = numT(tokens, i + 1);
        i += 2;
        const cp1x = cx + (2 / 3) * (rx - cx), cp1y = cy + (2 / 3) * (ry - cy);
        const cp2x = x + (2 / 3) * (rx - x), cp2y = y + (2 / 3) * (ry - y);
        if (points.length > 0) {
          points[points.length - 1].handleOut = { x: cp1x, y: cp1y };
        }
        points.push({ x, y, handleIn: { x: cp2x, y: cp2y } });
        lastCx2 = cp2x; lastCy2 = cp2y;
        cx = x; cy = y;
        lastCmd = "T";
        break;
      }
      case "t": {
        const rx = 2 * cx - lastCx2, ry = 2 * cy - lastCy2;
        const x = cx + numT(tokens, i), y = cy + numT(tokens, i + 1);
        i += 2;
        const cp1x = cx + (2 / 3) * (rx - cx), cp1y = cy + (2 / 3) * (ry - cy);
        const cp2x = x + (2 / 3) * (rx - x), cp2y = y + (2 / 3) * (ry - y);
        if (points.length > 0) {
          points[points.length - 1].handleOut = { x: cp1x, y: cp1y };
        }
        points.push({ x, y, handleIn: { x: cp2x, y: cp2y } });
        lastCx2 = cp2x; lastCy2 = cp2y;
        cx = x; cy = y;
        lastCmd = "t";
        break;
      }
      case "A":
      case "a": {
        const isRel = cmd === "a";
        const arx = numT(tokens, i), ary = numT(tokens, i + 1);
        const rotation = numT(tokens, i + 2);
        const largeArc = numT(tokens, i + 3);
        const sweep = numT(tokens, i + 4);
        let ex = numT(tokens, i + 5), ey = numT(tokens, i + 6);
        i += 7;
        if (isRel) { ex += cx; ey += cy; }
        const arcPoints = approximateArc(cx, cy, arx, ary, rotation, largeArc !== 0, sweep !== 0, ex, ey);
        for (const p of arcPoints) {
          points.push({ x: p.x, y: p.y });
        }
        cx = ex; cy = ey;
        lastCx2 = cx; lastCy2 = cy; // non-curve: reset S/T reflection anchor
        lastCmd = cmd;
        break;
      }
      case "Z":
      case "z": {
        cx = sx; cy = sy;
        lastCx2 = cx; lastCy2 = cy; // non-curve: reset S/T reflection anchor
        closed = true;
        flush();
        justClosed = true;
        lastCmd = cmd;
        break;
      }
      default:
        i++;
    }
  }

  flush();
  return subpaths;
}

function tokenizePath(d: string): string[] {
  const tokens: string[] = [];
  const regex = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
  let match;
  while ((match = regex.exec(d)) !== null) {
    tokens.push(match[0]);
  }
  return tokens;
}

function numT(tokens: string[], i: number): number {
  return i < tokens.length ? parseFloat(tokens[i]) || 0 : 0;
}

function approximateArc(
  x1: number, y1: number,
  rx: number, ry: number,
  phi: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number, y2: number
): Array<{ x: number; y: number }> {
  if (rx === 0 || ry === 0) return [{ x: x2, y: y2 }];

  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phiRad = (phi * Math.PI) / 180;
  const cosPhi = Math.cos(phiRad);
  const sinPhi = Math.sin(phiRad);

  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const sqrtL = Math.sqrt(lambda);
    rx *= sqrtL;
    ry *= sqrtL;
  }

  const rxSq = rx * rx, rySq = ry * ry;
  const x1pSq = x1p * x1p, y1pSq = y1p * y1p;
  let num2 = rxSq * rySq - rxSq * y1pSq - rySq * x1pSq;
  const den = rxSq * y1pSq + rySq * x1pSq;
  if (den === 0) return [{ x: x2, y: y2 }];
  if (num2 < 0) num2 = 0;
  let sq = Math.sqrt(num2 / den);
  if (largeArc === sweep) sq = -sq;

  const cxp = sq * (rx * y1p) / ry;
  const cyp = sq * -(ry * x1p) / rx;

  const cxo = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cyo = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);

  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;

  const segments = Math.max(8, Math.ceil(Math.abs(dtheta) / (Math.PI / 16)));
  const result: Array<{ x: number; y: number }> = [];

  for (let s = 1; s <= segments; s++) {
    const t = theta1 + (dtheta * s) / segments;
    const xp = rx * Math.cos(t);
    const yp = ry * Math.sin(t);
    result.push({
      x: cosPhi * xp - sinPhi * yp + cxo,
      y: sinPhi * xp + cosPhi * yp + cyo,
    });
  }

  return result;
}
