import { useStore, generateId } from "../../app/store";
import type { DesignObject, PathPoint } from "../../app/types";

type Matrix = [number, number, number, number, number, number];

const identityMatrix: Matrix = [1, 0, 0, 1, 0, 0];

function multiplyMatrices(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function applyMatrix(m: Matrix, x: number, y: number): { x: number; y: number } {
  return {
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5],
  };
}

function getMatrixScale(m: Matrix): { sx: number; sy: number } {
  return {
    sx: Math.sqrt(m[0] * m[0] + m[1] * m[1]),
    sy: Math.sqrt(m[2] * m[2] + m[3] * m[3]),
  };
}

function parseTransform(attr: string): Matrix {
  let result: Matrix = [...identityMatrix];
  const transforms = attr.match(/\w+\([^)]*\)/g);
  if (!transforms) return result;

  for (const t of transforms) {
    const name = t.match(/^(\w+)/)?.[1] || "";
    const nums = (t.match(/\(([^)]+)\)/)?.[1] || "")
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => !isNaN(n));

    let m: Matrix;
    switch (name) {
      case "translate":
        m = [1, 0, 0, 1, nums[0] || 0, nums[1] || 0];
        break;
      case "scale": {
        const sx = nums[0] || 1;
        const sy = nums.length > 1 ? nums[1] : sx;
        m = [sx, 0, 0, sy, 0, 0];
        break;
      }
      case "rotate": {
        const a = ((nums[0] || 0) * Math.PI) / 180;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        if (nums.length >= 3) {
          const cx = nums[1], cy = nums[2];
          m = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
        } else {
          m = [cos, sin, -sin, cos, 0, 0];
        }
        break;
      }
      case "matrix":
        m = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]];
        break;
      case "skewX": {
        const a = Math.tan(((nums[0] || 0) * Math.PI) / 180);
        m = [1, 0, a, 1, 0, 0];
        break;
      }
      case "skewY": {
        const a = Math.tan(((nums[0] || 0) * Math.PI) / 180);
        m = [1, a, 0, 1, 0, 0];
        break;
      }
      default:
        continue;
    }
    result = multiplyMatrices(result, m);
  }
  return result;
}

export function importSvgContent(svgText: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const svg = doc.querySelector("svg");
  if (!svg) return;

  const store = useStore.getState();
  const newObjects: DesignObject[] = [];

  const globalScale = computeGlobalScale(svg);
  const vbOffset = getViewBoxOffset(svg);

  const initialMatrix: Matrix = vbOffset.x !== 0 || vbOffset.y !== 0
    ? [1, 0, 0, 1, -vbOffset.x, -vbOffset.y]
    : identityMatrix;

  const styleMap = parseEmbeddedStyles(svg);

  walkElement(svg, initialMatrix, globalScale, styleMap, store.activeLayerIndex, newObjects);

  newObjects.forEach(store.addObject);
  if (newObjects.length > 0) {
    store.setSelectedIds(newObjects.map((o) => o.id));
  }
}

function getViewBoxOffset(svg: SVGSVGElement): { x: number; y: number } {
  const vb = svg.getAttribute("viewBox");
  if (!vb) return { x: 0, y: 0 };
  const parts = vb.split(/[\s,]+/).map(Number);
  if (parts.length < 4) return { x: 0, y: 0 };
  return { x: parts[0] || 0, y: parts[1] || 0 };
}

function computeGlobalScale(svg: SVGSVGElement): number {
  const vb = svg.getAttribute("viewBox");
  const wAttr = svg.getAttribute("width");

  if (!vb) {
    if (wAttr) return parseSvgLength(wAttr, 1);
    return 1;
  }

  const parts = vb.split(/[\s,]+/).map(Number);
  if (parts.length < 4 || parts[2] === 0) return 1;

  const vbWidth = parts[2];

  if (wAttr) {
    const widthMm = parseSvgLengthToMm(wAttr);
    if (widthMm > 0) {
      return widthMm / vbWidth;
    }
  }

  if (wAttr) {
    const widthPx = parseFloat(wAttr);
    if (!isNaN(widthPx) && widthPx > 0) {
      return (widthPx * 0.2646) / vbWidth;
    }
  }

  return 0.2646;
}

function parseSvgLength(val: string, defaultScale: number): number {
  const num = parseFloat(val);
  if (isNaN(num)) return defaultScale;
  if (val.endsWith("mm")) return 1;
  if (val.endsWith("cm")) return 1;
  if (val.endsWith("in")) return 1;
  if (val.endsWith("pt")) return 1;
  if (val.endsWith("px")) return 1;
  return defaultScale;
}

function parseSvgLengthToMm(val: string): number {
  const num = parseFloat(val);
  if (isNaN(num)) return 0;
  if (val.endsWith("mm")) return num;
  if (val.endsWith("cm")) return num * 10;
  if (val.endsWith("in")) return num * 25.4;
  if (val.endsWith("pt")) return num * 0.3528;
  if (val.endsWith("pc")) return num * 4.2333;
  return num * 0.2646;
}

function parseEmbeddedStyles(svg: SVGSVGElement): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  const styleEls = svg.querySelectorAll("style");
  for (const styleEl of styleEls) {
    const css = styleEl.textContent || "";
    const ruleRegex = /([^{]+)\{([^}]+)\}/g;
    let match;
    while ((match = ruleRegex.exec(css)) !== null) {
      const selector = match[1].trim();
      const body = match[2].trim();
      const props: Record<string, string> = {};
      for (const decl of body.split(";")) {
        const [key, ...valParts] = decl.split(":");
        if (key && valParts.length) {
          props[key.trim()] = valParts.join(":").trim();
        }
      }
      map.set(selector, props);
    }
  }
  return map;
}

function getResolvedStyle(el: Element, prop: string, styleMap: Map<string, Record<string, string>>): string | null {
  const inlineStyle = el.getAttribute("style") || "";
  const inlineMatch = inlineStyle.match(new RegExp(`${prop}\\s*:\\s*([^;]+)`));
  if (inlineMatch) return inlineMatch[1].trim();

  const attr = el.getAttribute(prop);
  if (attr) return attr;

  const classes = el.getAttribute("class");
  if (classes) {
    for (const cls of classes.split(/\s+/)) {
      const classProps = styleMap.get(`.${cls}`);
      if (classProps && classProps[prop]) return classProps[prop];
    }
  }

  return null;
}

function walkElement(
  el: Element,
  parentMatrix: Matrix,
  globalScale: number,
  styleMap: Map<string, Record<string, string>>,
  layerIndex: number,
  results: DesignObject[]
) {
  const transformAttr = el.getAttribute("transform");
  let matrix = parentMatrix;
  if (transformAttr) {
    const localMatrix = parseTransform(transformAttr);
    matrix = multiplyMatrices(parentMatrix, localMatrix);
  }

  const tag = el.tagName.toLowerCase();

  if (tag === "defs" || tag === "clippath" || tag === "mask" || tag === "style" || tag === "metadata") return;

  if (tag !== "svg" && tag !== "g" && tag !== "use" && tag !== "a") {
    const obj = parseSvgElement(el, matrix, globalScale, styleMap, layerIndex);
    if (obj) {
      results.push(obj);
      return;
    }
  }

  for (const child of el.children) {
    walkElement(child, matrix, globalScale, styleMap, layerIndex, results);
  }
}

function parseSvgElement(
  el: Element,
  matrix: Matrix,
  scale: number,
  styleMap: Map<string, Record<string, string>>,
  layerIndex: number
): DesignObject | null {
  const tag = el.tagName.toLowerCase();

  const stroke = getResolvedStyle(el, "stroke", styleMap) || "none";
  const strokeWidthStr = getResolvedStyle(el, "stroke-width", styleMap) || "1";
  const strokeWidth = parseFloat(strokeWidthStr) * scale;
  const fill = getResolvedStyle(el, "fill", styleMap);
  const opacity = parseFloat(getResolvedStyle(el, "opacity", styleMap) || "1");

  const resolvedStroke = stroke === "none" ? "#4a90e2" : stroke;
  const resolvedFill = fill && fill !== "none" ? fill : null;

  const base: Omit<DesignObject, "type" | "transform"> = {
    id: generateId(),
    name: `Imported ${tag}`,
    layerIndex,
    visible: true,
    locked: false,
    fill: resolvedFill,
    stroke: resolvedStroke,
    strokeWidth: Math.max(0.5, strokeWidth),
    opacity,
  };

  switch (tag) {
    case "rect": {
      const x = nAttr(el, "x");
      const y = nAttr(el, "y");
      const w = nAttr(el, "width");
      const h = nAttr(el, "height");
      const rx = nAttr(el, "rx");
      if (w === 0 && h === 0) return null;

      const corners = [
        applyMatrix(matrix, x, y),
        applyMatrix(matrix, x + w, y),
        applyMatrix(matrix, x + w, y + h),
        applyMatrix(matrix, x, y + h),
      ];
      const bb = boundingBox(corners);

      return {
        ...base,
        type: "rectangle",
        transform: {
          x: bb.x * scale, y: bb.y * scale,
          width: bb.w * scale, height: bb.h * scale,
          rotation: 0, scaleX: 1, scaleY: 1,
        },
        cornerRadius: rx * scale,
      };
    }
    case "circle": {
      const cx = nAttr(el, "cx");
      const cy = nAttr(el, "cy");
      const r = nAttr(el, "r");
      if (r === 0) return null;

      const center = applyMatrix(matrix, cx, cy);
      const ms = getMatrixScale(matrix);
      const rx = r * ms.sx * scale;
      const ry = r * ms.sy * scale;

      return {
        ...base,
        type: "ellipse",
        transform: {
          x: center.x * scale - rx, y: center.y * scale - ry,
          width: rx * 2, height: ry * 2,
          rotation: 0, scaleX: 1, scaleY: 1,
        },
      };
    }
    case "ellipse": {
      const cx = nAttr(el, "cx");
      const cy = nAttr(el, "cy");
      const erx = nAttr(el, "rx");
      const ery = nAttr(el, "ry");
      if (erx === 0 && ery === 0) return null;

      const center = applyMatrix(matrix, cx, cy);
      const ms = getMatrixScale(matrix);
      const rx = erx * ms.sx * scale;
      const ry = ery * ms.sy * scale;

      return {
        ...base,
        type: "ellipse",
        transform: {
          x: center.x * scale - rx, y: center.y * scale - ry,
          width: rx * 2, height: ry * 2,
          rotation: 0, scaleX: 1, scaleY: 1,
        },
      };
    }
    case "line": {
      const x1 = nAttr(el, "x1"), y1 = nAttr(el, "y1");
      const x2 = nAttr(el, "x2"), y2 = nAttr(el, "y2");
      const p1 = applyMatrix(matrix, x1, y1);
      const p2 = applyMatrix(matrix, x2, y2);
      const sp1 = { x: p1.x * scale, y: p1.y * scale };
      const sp2 = { x: p2.x * scale, y: p2.y * scale };

      return {
        ...base,
        type: "line",
        transform: {
          x: Math.min(sp1.x, sp2.x), y: Math.min(sp1.y, sp2.y),
          width: Math.abs(sp2.x - sp1.x), height: Math.abs(sp2.y - sp1.y),
          rotation: 0, scaleX: 1, scaleY: 1,
        },
        points: [sp1, sp2],
      };
    }
    case "polyline":
    case "polygon": {
      const raw = el.getAttribute("points") || "";
      const nums = raw.trim().split(/[\s,]+/).map(Number);
      if (nums.length < 4) return null;

      const points: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < nums.length - 1; i += 2) {
        const p = applyMatrix(matrix, nums[i], nums[i + 1]);
        points.push({ x: p.x * scale, y: p.y * scale });
      }

      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      const maxX = Math.max(...xs), maxY = Math.max(...ys);

      return {
        ...base,
        type: "path",
        transform: {
          x: minX, y: minY,
          width: maxX - minX, height: maxY - minY,
          rotation: 0, scaleX: 1, scaleY: 1,
        },
        points,
        closed: tag === "polygon",
      };
    }
    case "path": {
      const d = el.getAttribute("d") || "";
      const rawPoints = parsePathD(d);
      if (rawPoints.length < 2) return null;

      const points = rawPoints.map((p) => {
        const tp = applyMatrix(matrix, p.x, p.y);
        const result: any = { x: tp.x * scale, y: tp.y * scale };
        if (p.handleIn) {
          const hi = applyMatrix(matrix, p.handleIn.x, p.handleIn.y);
          result.handleIn = { x: hi.x * scale, y: hi.y * scale };
        }
        if (p.handleOut) {
          const ho = applyMatrix(matrix, p.handleOut.x, p.handleOut.y);
          result.handleOut = { x: ho.x * scale, y: ho.y * scale };
        }
        return result;
      });

      const xs = points.map((p: any) => p.x);
      const ys = points.map((p: any) => p.y);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      const maxX = Math.max(...xs), maxY = Math.max(...ys);
      const closed = /[Zz]\s*$/.test(d.trim());

      return {
        ...base,
        type: "path",
        transform: {
          x: minX, y: minY,
          width: maxX - minX || 1, height: maxY - minY || 1,
          rotation: 0, scaleX: 1, scaleY: 1,
        },
        points,
        closed,
      };
    }
    case "text": {
      const x = nAttr(el, "x");
      const y = nAttr(el, "y");

      const textContent = collectTextContent(el);
      if (!textContent.trim()) return null;

      let fontSize = parseFloat(getResolvedStyle(el, "font-size", styleMap) || "16");
      let fontFamily = getResolvedStyle(el, "font-family", styleMap) || "sans-serif";
      const fontWeight = getResolvedStyle(el, "font-weight", styleMap) || "normal";
      const textAnchor = getResolvedStyle(el, "text-anchor", styleMap) || "start";

      fontFamily = fontFamily.replace(/['"]/g, "");

      const pos = applyMatrix(matrix, x, y);
      const ms = getMatrixScale(matrix);
      fontSize = fontSize * ms.sy * scale;

      const avgCharWidth = fontSize * 0.55;
      const estWidth = textContent.length * avgCharWidth;
      const estHeight = fontSize * 1.3;

      let adjustedX = pos.x * scale;
      if (textAnchor === "middle") adjustedX -= estWidth / 2;
      else if (textAnchor === "end") adjustedX -= estWidth;

      const textFill = resolvedFill || (stroke !== "none" ? stroke : "#e8e8e8");

      return {
        ...base,
        type: "text",
        name: `Text: "${textContent.slice(0, 20)}"`,
        transform: {
          x: adjustedX,
          y: pos.y * scale - fontSize,
          width: estWidth,
          height: estHeight,
          rotation: 0, scaleX: 1, scaleY: 1,
        },
        text: textContent,
        fontSize,
        fontFamily: fontWeight !== "normal" ? `${fontFamily}` : fontFamily,
        fill: textFill,
      };
    }
    case "image": {
      const x = nAttr(el, "x");
      const y = nAttr(el, "y");
      const w = nAttr(el, "width");
      const h = nAttr(el, "height");
      const href = el.getAttribute("href") || el.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
      if (!href || (w === 0 && h === 0)) return null;

      const corners = [
        applyMatrix(matrix, x, y),
        applyMatrix(matrix, x + w, y),
        applyMatrix(matrix, x + w, y + h),
        applyMatrix(matrix, x, y + h),
      ];
      const bb = boundingBox(corners);

      return {
        ...base,
        type: "image",
        name: "Imported image",
        transform: {
          x: bb.x * scale, y: bb.y * scale,
          width: bb.w * scale, height: bb.h * scale,
          rotation: 0, scaleX: 1, scaleY: 1,
        },
        imageData: href,
      };
    }
    default:
      return null;
  }
}

export function parsePathD(d: string): PathPoint[] {
  const points: PathPoint[] = [];
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

    switch (cmd) {
      case "M": {
        cx = numT(tokens, i); cy = numT(tokens, i + 1); i += 2;
        sx = cx; sy = cy;
        points.push({ x: cx, y: cy });
        lastCmd = "M";
        break;
      }
      case "m": {
        cx += numT(tokens, i); cy += numT(tokens, i + 1); i += 2;
        sx = cx; sy = cy;
        points.push({ x: cx, y: cy });
        lastCmd = "m";
        break;
      }
      case "L": {
        cx = numT(tokens, i); cy = numT(tokens, i + 1); i += 2;
        points.push({ x: cx, y: cy });
        lastCmd = "L";
        break;
      }
      case "l": {
        cx += numT(tokens, i); cy += numT(tokens, i + 1); i += 2;
        points.push({ x: cx, y: cy });
        lastCmd = "l";
        break;
      }
      case "H": {
        cx = numT(tokens, i); i += 1;
        points.push({ x: cx, y: cy });
        lastCmd = "H";
        break;
      }
      case "h": {
        cx += numT(tokens, i); i += 1;
        points.push({ x: cx, y: cy });
        lastCmd = "h";
        break;
      }
      case "V": {
        cy = numT(tokens, i); i += 1;
        points.push({ x: cx, y: cy });
        lastCmd = "V";
        break;
      }
      case "v": {
        cy += numT(tokens, i); i += 1;
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
        lastCmd = cmd;
        break;
      }
      case "Z":
      case "z": {
        cx = sx; cy = sy;
        lastCmd = cmd;
        break;
      }
      default:
        i++;
    }
  }

  return points;
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

function nAttr(el: Element, attr: string): number {
  return parseFloat(el.getAttribute(attr) || "0") || 0;
}

function boundingBox(points: Array<{ x: number; y: number }>): { x: number; y: number; w: number; h: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const maxX = Math.max(...xs), maxY = Math.max(...ys);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
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

function collectTextContent(el: Element): string {
  const tspans = el.querySelectorAll("tspan");
  if (tspans.length > 0) {
    return Array.from(tspans)
      .map((ts) => ts.textContent || "")
      .join(" ");
  }
  return el.textContent || "";
}
