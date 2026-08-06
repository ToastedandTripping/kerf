import { useState, useEffect, useMemo, useRef } from "react";
import { useStore, generateId } from "../../app/store";
import { parsePathD } from "../../lib/fileOps";
import { pointsBBox, buildGroupObject, applyMatrix2x3, multiplyMatrix2x3, type Matrix2x3 } from "../../lib/geometry";
import type { DesignObject, PathPoint } from "../../app/types";
import { useEscapeClose } from "../../lib/hooks/useEscapeClose";
import { useFocusTrap } from "../../lib/hooks/useFocusTrap";

interface Props {
  open: boolean;
  svgContent: string | null;
  onClose: () => void;
}

interface ColorGroup {
  color: string;
  count: number;
  layerIndex: number;
}

type Matrix = Matrix2x3;
const identityMatrix: Matrix = [1, 0, 0, 1, 0, 0];

function getMatrixScale(m: Matrix) {
  return { sx: Math.sqrt(m[0] * m[0] + m[1] * m[1]), sy: Math.sqrt(m[2] * m[2] + m[3] * m[3]) };
}

function parseTransformAttr(attr: string): Matrix {
  let result: Matrix = [...identityMatrix];
  const transforms = attr.match(/\w+\([^)]*\)/g);
  if (!transforms) return result;
  for (const t of transforms) {
    const name = t.match(/^(\w+)/)?.[1] || "";
    const nums = (t.match(/\(([^)]+)\)/)?.[1] || "").split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
    let m: Matrix;
    switch (name) {
      case "translate": m = [1, 0, 0, 1, nums[0] || 0, nums[1] || 0]; break;
      case "scale": { const sx = nums[0] || 1; m = [sx, 0, 0, nums.length > 1 ? nums[1] : sx, 0, 0]; break; }
      case "rotate": { const a = ((nums[0] || 0) * Math.PI) / 180; const c = Math.cos(a), s = Math.sin(a);
        if (nums.length >= 3) { const cx = nums[1], cy = nums[2]; m = [c, s, -s, c, cx - c*cx + s*cy, cy - s*cx - c*cy]; }
        else m = [c, s, -s, c, 0, 0]; break; }
      case "matrix": m = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]]; break;
      default: continue;
    }
    result = multiplyMatrix2x3(result, m);
  }
  return result;
}

function normalizeColor(color: string | null): string {
  if (!color || color === "none" || color === "transparent") return "none";
  const c = color.trim().toLowerCase();
  if (c === "black" || c === "#000" || c === "#000000" || c === "rgb(0,0,0)" || c === "rgb(0, 0, 0)") return "#000000";
  if (c === "white" || c === "#fff" || c === "#ffffff") return "#ffffff";
  if (c === "red" || c === "#f00" || c === "#ff0000") return "#ff0000";
  if (c === "blue" || c === "#00f" || c === "#0000ff") return "#0000ff";
  if (c === "green" || c === "#0f0" || c === "#00ff00") return "#00ff00";
  if (c.startsWith("#") && c.length === 4) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }
  return c;
}

function findClosestLayer(color: string, layers: { color: string }[]): number {
  const hex = color.replace("#", "");
  if (hex.length !== 6) return 0;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);

  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < layers.length; i++) {
    const lh = layers[i].color.replace("#", "");
    if (lh.length !== 6) continue;
    const lr = parseInt(lh.slice(0, 2), 16);
    const lg = parseInt(lh.slice(2, 4), 16);
    const lb = parseInt(lh.slice(4, 6), 16);
    const dist = (r - lr) ** 2 + (g - lg) ** 2 + (b - lb) ** 2;
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  }
  return bestIdx;
}

function extractColors(svgText: string): ColorGroup[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const colorCounts = new Map<string, number>();

  function walk(el: Element) {
    const tag = el.tagName.toLowerCase();
    if (tag === "defs" || tag === "style" || tag === "clippath") return;
    const stroke = el.getAttribute("stroke");
    const fill = el.getAttribute("fill");
    const style = el.getAttribute("style") || "";

    let effectiveColor = "none";
    const strokeMatch = style.match(/stroke\s*:\s*([^;]+)/);
    const fillMatch = style.match(/fill\s*:\s*([^;]+)/);

    const s = normalizeColor(strokeMatch ? strokeMatch[1] : stroke);
    const f = normalizeColor(fillMatch ? fillMatch[1] : fill);

    if (s !== "none") effectiveColor = s;
    else if (f !== "none") effectiveColor = f;

    if (effectiveColor !== "none" && tag !== "svg" && tag !== "g") {
      colorCounts.set(effectiveColor, (colorCounts.get(effectiveColor) || 0) + 1);
    }
    for (const child of el.children) walk(child);
  }
  walk(doc.documentElement);

  const layers = useStore.getState().layers;
  return Array.from(colorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([color, count]) => ({
      color,
      count,
      layerIndex: findClosestLayer(color, layers),
    }));
}

function extractTextFonts(svgText: string): string[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const fonts = new Set<string>();
  for (const el of doc.querySelectorAll("text, tspan")) {
    const style = el.getAttribute("style") || "";
    const fontFamilyMatch = style.match(/font-family\s*:\s*([^;]+)/);
    const fontFamily = fontFamilyMatch
      ? fontFamilyMatch[1].trim()
      : el.getAttribute("font-family");
    if (fontFamily) {
      // Remove quotes and split comma-separated fallbacks, take the first one
      const primary = fontFamily.replace(/['"]/g, "").split(",")[0].trim();
      if (primary) fonts.add(primary);
    }
    // Also check if there's no font-family but there is text — record as "unknown"
    if (!fontFamily && el.tagName.toLowerCase() === "text") {
      fonts.add("(unknown)");
    }
  }
  return Array.from(fonts);
}

export function SvgImportDialog({ open, svgContent, onClose }: Props) {
  const layers = useStore((s) => s.layers);
  const [colorGroups, setColorGroups] = useState<ColorGroup[]>([]);
  const [textFonts, setTextFonts] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  useEscapeClose(open, onClose);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open || !svgContent) { setTextFonts([]); return; }
    setColorGroups(extractColors(svgContent));
    setTextFonts(extractTextFonts(svgContent));
  }, [open, svgContent]);

  const previewSvgUrl = useMemo(() => {
    if (!svgContent) return null;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`;
  }, [svgContent]);

  if (!open || !svgContent) return null;

  function setLayerForColor(colorIndex: number, layerIndex: number) {
    setColorGroups(prev => prev.map((g, i) =>
      i === colorIndex ? { ...g, layerIndex } : g
    ));
  }

  function handleImport() {
    if (!svgContent || importing) return;
    setImporting(true);

    try {
      const colorToLayer = new Map<string, number>();
      for (const g of colorGroups) {
        colorToLayer.set(g.color, g.layerIndex);
      }
      importSvgWithLayers(svgContent, colorToLayer);
      onClose();
    } finally {
      setImporting(false);
    }
  }

  function handleImportFlat() {
    if (!svgContent || importing) return;
    setImporting(true);
    try {
      importSvgWithLayers(svgContent, null);
      onClose();
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999 }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="svg-import-dialog-title"
        style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        width: "520px", maxHeight: "80vh", display: "flex", flexDirection: "column",
        background: "var(--bg-panel)", border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-modal)", zIndex: 10000,
      }}>
        <div style={{ padding: "20px 20px 0" }}>
          <div id="svg-import-dialog-title" style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "12px" }}>
            Import SVG
          </div>

          {/* Preview */}
          <div style={{
            background: "#1a1a2e", borderRadius: "var(--radius-sm)",
            height: "160px", display: "flex", alignItems: "center", justifyContent: "center",
            marginBottom: "16px", overflow: "hidden",
          }}>
            {previewSvgUrl && (
              <img src={previewSvgUrl} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} alt="SVG preview" />
            )}
          </div>

          {/* SVG text warning */}
          {textFonts.length > 0 && (
            <div style={{
              marginBottom: "12px", padding: "8px 10px",
              background: "rgba(226,200,74,0.1)", border: "1px solid rgba(226,200,74,0.3)",
              borderRadius: "var(--radius-sm)", fontSize: "11px", color: "rgba(226,200,74,0.9)",
            }}>
              This SVG contains text using: <strong>{textFonts.join(", ")}</strong>.
              Text may render differently without the original fonts. Convert text to paths before exporting for exact results.
            </div>
          )}

          {/* Color-to-layer mapping */}
          {colorGroups.length > 0 && (
            <div style={{ marginBottom: "12px" }}>
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "4px" }}>
                Assign colors to layers ({colorGroups.length} color{colorGroups.length !== 1 ? "s" : ""} found)
              </div>
              <div style={{ fontSize: "10px", color: "var(--text-muted)", marginBottom: "8px" }}>
                Each color group maps to a layer. Elements with the same color will share cut/engrave settings.
              </div>
              <div style={{ maxHeight: "200px", overflowY: "auto" }}>
                {colorGroups.map((group, idx) => (
                  <div key={idx} style={{
                    display: "flex", alignItems: "center", gap: "8px",
                    padding: "6px 0", borderBottom: "1px solid var(--border)",
                  }}>
                    <div style={{
                      width: "16px", height: "16px", borderRadius: "3px",
                      background: group.color, border: "1px solid rgba(255,255,255,0.2)",
                      flexShrink: 0,
                    }} />
                    <span style={{ fontSize: "12px", color: "var(--text-muted)", minWidth: "60px" }}>
                      {group.color}
                    </span>
                    <span style={{ fontSize: "11px", color: "var(--text-muted)", minWidth: "30px" }}>
                      x{group.count}
                    </span>
                    <div style={{ flex: 1 }} />
                    <select
                      value={group.layerIndex}
                      onChange={(e) => setLayerForColor(idx, Number(e.target.value))}
                      style={{
                        background: "var(--bg-input)", border: "1px solid var(--border)",
                        color: "var(--text-primary)", padding: "3px 6px",
                        borderRadius: "var(--radius-sm)", fontSize: "12px",
                      }}
                    >
                      {layers.map((l, li) => (
                        <option key={li} value={li}>{l.name}</option>
                      ))}
                    </select>
                    <div style={{
                      width: "12px", height: "12px", borderRadius: "2px",
                      background: layers[group.layerIndex]?.color || "#4a90e2",
                      flexShrink: 0,
                    }} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Hint */}
        <div style={{
          padding: "0 20px 0",
        }}>
          <div style={{
            fontSize: "10px", color: "var(--text-muted)",
            padding: "8px", background: "rgba(74,144,226,0.06)", borderRadius: "var(--radius-sm)",
          }}>
            Select any object and use the Layer dropdown in Properties to reassign it, or press 1-6 to assign layers. Each element can have its own layer for separate cut/engrave settings.
          </div>
        </div>

        {/* Buttons */}
        <div style={{
          display: "flex", justifyContent: "flex-end", gap: "8px",
          padding: "16px 20px", borderTop: "1px solid var(--border)",
        }}>
          <button onClick={onClose} style={{
            background: "none", border: "1px solid var(--border)",
            color: "var(--text-secondary)", padding: "6px 16px",
            borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "13px",
          }}>Cancel</button>
          <button onClick={handleImportFlat} style={{
            background: "rgba(74,144,226,0.08)", border: "1px solid rgba(74,144,226,0.25)",
            color: "var(--accent)", padding: "6px 16px",
            borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "13px",
          }}>Import to Active Layer</button>
          <button onClick={handleImport} disabled={importing} style={{
            background: importing ? "var(--bg-input)" : "var(--accent-warm)",
            border: "none", color: importing ? "var(--text-muted)" : "#fff",
            padding: "6px 16px", borderRadius: "var(--radius-sm)",
            cursor: importing ? "default" : "pointer", fontSize: "13px",
            fontWeight: 600,
          }}>{importing ? "Importing..." : "Import with Layers"}</button>
        </div>
      </div>
    </>
  );
}

// Test-only export — exercises the production SVG import pipeline (parse →
// walk → create objects in the store) without driving the dialog UI.
export { importSvgWithLayers as _testImportSvgWithLayers };

// SVG import with layer assignment based on color mapping
function getViewBoxOffset(svg: SVGSVGElement): { x: number; y: number } {
  const vb = svg.getAttribute("viewBox");
  if (!vb) return { x: 0, y: 0 };
  const parts = vb.split(/[\s,]+/).map(Number);
  if (parts.length < 4) return { x: 0, y: 0 };
  return { x: parts[0] || 0, y: parts[1] || 0 };
}

function importSvgWithLayers(svgText: string, colorToLayer: Map<string, number> | null) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const svg = doc.querySelector("svg");
  if (!svg) return;

  const store = useStore.getState();
  const newObjects: DesignObject[] = [];
  const globalScale = computeGlobalScale(svg);
  const styleMap = parseEmbeddedStyles(svg);

  const vbOffset = getViewBoxOffset(svg);
  const initialMatrix: Matrix = vbOffset.x !== 0 || vbOffset.y !== 0
    ? [1, 0, 0, 1, -vbOffset.x, -vbOffset.y]
    : identityMatrix;

  const skippedElements = new Map<string, number>();
  walkElementWithLayers(svg, initialMatrix, globalScale, styleMap, store.activeLayerIndex, colorToLayer, newObjects, skippedElements);

  if (newObjects.length > 0) {
    store.withUndo("svg-import", () => {
      for (const obj of newObjects) store.addObject(obj);
      store.setSelectedIds(newObjects.map(o => o.id));
    });
    let msg = `SVG imported: ${newObjects.length} objects`;
    if (skippedElements.size > 0) {
      const summary = Array.from(skippedElements.entries())
        .map(([tag, count]) => `${tag} (${count})`)
        .join(", ");
      msg += ` — skipped: ${summary}`;
    }
    store.addConsoleLine(msg, "info");
  } else {
    let msg = "SVG import: no supported elements found";
    if (skippedElements.size > 0) {
      const summary = Array.from(skippedElements.entries())
        .map(([tag, count]) => `${tag} (${count})`)
        .join(", ");
      msg += ` — unsupported: ${summary}`;
    }
    store.addConsoleLine(msg, "error");
  }
}

function computeGlobalScale(svg: SVGSVGElement): number {
  const vb = svg.getAttribute("viewBox");
  const wAttr = svg.getAttribute("width");
  if (!vb) {
    if (wAttr) {
      const widthMm = parseSvgLengthToMm(wAttr);
      if (widthMm > 0) return 1;
    }
    return 0.2646;
  }
  const parts = vb.split(/[\s,]+/).map(Number);
  if (parts.length < 4 || parts[2] === 0) return 1;
  const vbWidth = parts[2];
  if (wAttr) {
    const widthMm = parseSvgLengthToMm(wAttr);
    if (widthMm > 0) return widthMm / vbWidth;
    const widthPx = parseFloat(wAttr);
    if (!isNaN(widthPx) && widthPx > 0) return (widthPx * 0.2646) / vbWidth;
  }
  return 0.2646;
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
  for (const styleEl of svg.querySelectorAll("style")) {
    const css = styleEl.textContent || "";
    const ruleRegex = /([^{]+)\{([^}]+)\}/g;
    let match;
    while ((match = ruleRegex.exec(css)) !== null) {
      const selector = match[1].trim();
      const props: Record<string, string> = {};
      for (const decl of match[2].split(";")) {
        const [key, ...valParts] = decl.split(":");
        if (key && valParts.length) props[key.trim()] = valParts.join(":").trim();
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

function resolveLayerIndex(
  el: Element,
  styleMap: Map<string, Record<string, string>>,
  defaultLayer: number,
  colorToLayer: Map<string, number> | null,
): number {
  if (!colorToLayer) return defaultLayer;

  const stroke = getResolvedStyle(el, "stroke", styleMap);
  const fill = getResolvedStyle(el, "fill", styleMap);
  const s = normalizeColor(stroke);
  const f = normalizeColor(fill);

  if (s !== "none" && colorToLayer.has(s)) return colorToLayer.get(s)!;
  if (f !== "none" && colorToLayer.has(f)) return colorToLayer.get(f)!;
  return defaultLayer;
}

function walkElementWithLayers(
  el: Element, parentMatrix: Matrix, globalScale: number,
  styleMap: Map<string, Record<string, string>>,
  defaultLayer: number, colorToLayer: Map<string, number> | null,
  results: DesignObject[],
  skipped: Map<string, number>,
) {
  const transformAttr = el.getAttribute("transform");
  let matrix = parentMatrix;
  if (transformAttr) matrix = multiplyMatrix2x3(parentMatrix, parseTransformAttr(transformAttr));

  const tag = el.tagName.toLowerCase();
  if (tag === "defs" || tag === "clippath" || tag === "mask" || tag === "style" || tag === "metadata") return;

  if (tag !== "svg" && tag !== "g" && tag !== "use" && tag !== "a") {
    const layerIndex = resolveLayerIndex(el, styleMap, defaultLayer, colorToLayer);
    const obj = parseSvgElementForImport(el, matrix, globalScale, styleMap, layerIndex);
    if (obj) { results.push(obj); return; }
    // Track unsupported/degenerate elements that produced no object
    skipped.set(tag, (skipped.get(tag) || 0) + 1);
    return;
  }

  for (const child of el.children) {
    walkElementWithLayers(child, matrix, globalScale, styleMap, defaultLayer, colorToLayer, results, skipped);
  }
}

function n(el: Element, attr: string): number {
  return parseFloat(el.getAttribute(attr) || "0") || 0;
}

function boundingBox(points: { x: number; y: number }[]) {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function parseSvgElementForImport(
  el: Element, matrix: Matrix, scale: number,
  styleMap: Map<string, Record<string, string>>, layerIndex: number,
): DesignObject | null {
  const tag = el.tagName.toLowerCase();
  const stroke = getResolvedStyle(el, "stroke", styleMap) || "none";
  const fill = getResolvedStyle(el, "fill", styleMap);
  const strokeWidthStr = getResolvedStyle(el, "stroke-width", styleMap) || "1";
  const opacity = parseFloat(getResolvedStyle(el, "opacity", styleMap) || "1");

  const store = useStore.getState();
  const layerColor = store.layers[layerIndex]?.color || "#4a90e2";
  const resolvedStroke = stroke === "none" ? layerColor : stroke;
  const resolvedFill = fill && fill !== "none" ? fill : null;

  const base: Omit<DesignObject, "type" | "transform"> = {
    id: generateId(), name: `Imported ${tag}`, layerIndex,
    visible: true, locked: false, fill: resolvedFill,
    stroke: resolvedStroke, strokeWidth: Math.max(0.5, parseFloat(strokeWidthStr) * scale), opacity,
  };

  // Detect rotation in matrix: angle = atan2(b, a) where matrix = [a, b, c, d, e, f]
  const matrixRotation = Math.atan2(matrix[1], matrix[0]);
  const isRotated = Math.abs(matrixRotation) > 0.001;

  switch (tag) {
    case "rect": {
      const x = n(el, "x"), y = n(el, "y"), w = n(el, "width"), h = n(el, "height"), rx = n(el, "rx");
      if (w === 0 && h === 0) return null;
      const corners = [[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(([px,py]) => applyMatrix2x3(matrix, px, py));
      if (isRotated) {
        // Rotated rect → path preserving geometry in world space.
        const pts = corners.map(c => ({ x: c.x * scale, y: c.y * scale }));
        const bb = boundingBox(pts);
        return { ...base, type: "path", transform: { x: bb.x, y: bb.y, width: bb.w, height: bb.h, rotation: 0, scaleX: 1, scaleY: 1 }, points: pts, closed: true };
      }
      const bb = boundingBox(corners);
      return { ...base, type: "rectangle", transform: { x: bb.x*scale, y: bb.y*scale, width: bb.w*scale, height: bb.h*scale, rotation: 0, scaleX: 1, scaleY: 1 }, cornerRadius: rx * scale };
    }
    case "circle": {
      const cx = n(el, "cx"), cy = n(el, "cy"), r = n(el, "r");
      if (r === 0) return null;
      const center = applyMatrix2x3(matrix, cx, cy); const ms = getMatrixScale(matrix);
      const rrx = r * ms.sx * scale, rry = r * ms.sy * scale;
      return { ...base, type: "ellipse", transform: { x: center.x*scale-rrx, y: center.y*scale-rry, width: rrx*2, height: rry*2, rotation: 0, scaleX: 1, scaleY: 1 }};
    }
    case "ellipse": {
      const cx = n(el, "cx"), cy = n(el, "cy"), erx = n(el, "rx"), ery = n(el, "ry");
      if (erx === 0 && ery === 0) return null;
      const center = applyMatrix2x3(matrix, cx, cy); const ms = getMatrixScale(matrix);
      const rrx = erx * ms.sx * scale, rry = ery * ms.sy * scale;
      if (isRotated) {
        // Rotated ellipse → 4-anchor bezier circle approximation in world space.
        // kappa ≈ 0.5522847498 for a unit circle bezier approximation.
        const K = 0.5522847498;
        // Compute semi-axis vectors in world space (rotated by matrix)
        const cosR = Math.cos(matrixRotation), sinR = Math.sin(matrixRotation);
        const ax = erx * ms.sx * scale * cosR, ay = erx * ms.sx * scale * sinR;
        const bx = -ery * ms.sy * scale * sinR, by = ery * ms.sy * scale * cosR;
        const c = { x: center.x * scale, y: center.y * scale };
        // 4 anchor points on ellipse at 0°, 90°, 180°, 270°
        const p0 = { x: c.x + ax, y: c.y + ay };
        const p1 = { x: c.x + bx, y: c.y + by };
        const p2 = { x: c.x - ax, y: c.y - ay };
        const p3 = { x: c.x - bx, y: c.y - by };
        const pts = [
          { x: p0.x, y: p0.y, handleIn: { x: p0.x - K*bx, y: p0.y - K*by }, handleOut: { x: p0.x + K*bx, y: p0.y + K*by } },
          { x: p1.x, y: p1.y, handleIn: { x: p1.x + K*ax, y: p1.y + K*ay }, handleOut: { x: p1.x - K*ax, y: p1.y - K*ay } },
          { x: p2.x, y: p2.y, handleIn: { x: p2.x + K*bx, y: p2.y + K*by }, handleOut: { x: p2.x - K*bx, y: p2.y - K*by } },
          { x: p3.x, y: p3.y, handleIn: { x: p3.x - K*ax, y: p3.y - K*ay }, handleOut: { x: p3.x + K*ax, y: p3.y + K*ay } },
        ];
        const bb = boundingBox(pts);
        return { ...base, type: "path", transform: { x: bb.x, y: bb.y, width: bb.w, height: bb.h, rotation: 0, scaleX: 1, scaleY: 1 }, points: pts, closed: true };
      }
      return { ...base, type: "ellipse", transform: { x: center.x*scale-rrx, y: center.y*scale-rry, width: rrx*2, height: rry*2, rotation: 0, scaleX: 1, scaleY: 1 }};
    }
    case "line": {
      const p1 = applyMatrix2x3(matrix, n(el, "x1"), n(el, "y1"));
      const p2 = applyMatrix2x3(matrix, n(el, "x2"), n(el, "y2"));
      const sp1 = { x: p1.x*scale, y: p1.y*scale }, sp2 = { x: p2.x*scale, y: p2.y*scale };
      return { ...base, type: "line", transform: { x: Math.min(sp1.x,sp2.x), y: Math.min(sp1.y,sp2.y), width: Math.abs(sp2.x-sp1.x), height: Math.abs(sp2.y-sp1.y), rotation: 0, scaleX: 1, scaleY: 1 }, points: [sp1, sp2] };
    }
    case "polyline": case "polygon": {
      const raw = el.getAttribute("points") || "";
      const nums = raw.trim().split(/[\s,]+/).map(Number);
      if (nums.length < 4) return null;
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i < nums.length - 1; i += 2) {
        const p = applyMatrix2x3(matrix, nums[i], nums[i+1]);
        points.push({ x: p.x*scale, y: p.y*scale });
      }
      const bb = boundingBox(points);
      return { ...base, type: "path", transform: { x: bb.x, y: bb.y, width: bb.w, height: bb.h, rotation: 0, scaleX: 1, scaleY: 1 }, points, closed: tag === "polygon" };
    }
    case "path": {
      const d = el.getAttribute("d") || "";
      // W1c (F20): parsePathD returns SUBPATHS — a compound path (donut,
      // glyph, stroke-to-path output) becomes one path object per surviving
      // (≥2-point) contour, GROUPED when there is more than one, so the cut
      // contains no bridge segment through the workpiece. Per-subpath closed
      // flags replace the old whole-string trailing-Z regex.
      const pathObjects: DesignObject[] = [];
      for (const sub of parsePathD(d)) {
        if (sub.points.length < 2) continue;
        const points: PathPoint[] = sub.points.map(p => {
          const tp = applyMatrix2x3(matrix, p.x, p.y);
          const result: PathPoint = { x: tp.x*scale, y: tp.y*scale };
          if (p.handleIn) { const hi = applyMatrix2x3(matrix, p.handleIn.x, p.handleIn.y); result.handleIn = { x: hi.x*scale, y: hi.y*scale }; }
          if (p.handleOut) { const ho = applyMatrix2x3(matrix, p.handleOut.x, p.handleOut.y); result.handleOut = { x: ho.x*scale, y: ho.y*scale }; }
          return result;
        });
        // W1b: anchors-only loop bbox; no ||1 clamp (true bbox at birth — the
        // hitTest ε band keeps collinear imports clickable)
        const bb = pointsBBox(points);
        pathObjects.push({ ...base, id: generateId(), type: "path", transform: { x: bb.x, y: bb.y, width: bb.width, height: bb.height, rotation: 0, scaleX: 1, scaleY: 1 }, points, closed: sub.closed });
      }
      if (pathObjects.length === 0) return null;
      if (pathObjects.length === 1) return pathObjects[0];
      // Group via the ONE shared builder (group-local child re-base) — never
      // hand-rolled world-frame children, never groupSelected (undo/selection
      // coupled).
      return buildGroupObject(pathObjects, generateId(), base.name, layerIndex);
    }
    case "text": {
      const x = n(el, "x"), y = n(el, "y");
      const textContent = el.textContent || "";
      if (!textContent.trim()) return null;
      let fontSize = parseFloat(getResolvedStyle(el, "font-size", styleMap) || "16");
      const fontFamily = (getResolvedStyle(el, "font-family", styleMap) || "sans-serif").replace(/['"]/g, "");
      const pos = applyMatrix2x3(matrix, x, y); const ms = getMatrixScale(matrix);
      fontSize = fontSize * ms.sy * scale;
      const estWidth = textContent.length * fontSize * 0.55, estHeight = fontSize * 1.3;
      return { ...base, type: "text", name: `Text: "${textContent.slice(0,20)}"`, transform: { x: pos.x*scale, y: pos.y*scale - fontSize, width: estWidth, height: estHeight, rotation: 0, scaleX: 1, scaleY: 1 }, text: textContent, fontSize, fontFamily, fill: resolvedFill || resolvedStroke };
    }
    default: return null;
  }
}
