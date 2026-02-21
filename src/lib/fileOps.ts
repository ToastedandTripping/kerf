import { useStore, generateId } from "../app/store";
import type { DesignObject, KerfProject } from "../app/types";

// We use Tauri's dialog and fs plugins when available, fallback to web APIs
let dialogModule: typeof import("@tauri-apps/plugin-dialog") | null = null;
let fsModule: typeof import("@tauri-apps/plugin-fs") | null = null;

async function ensureTauri() {
  if (dialogModule && fsModule) return true;
  try {
    dialogModule = await import("@tauri-apps/plugin-dialog");
    fsModule = await import("@tauri-apps/plugin-fs");
    return true;
  } catch {
    return false;
  }
}

export const fileOperations = {
  async newProject() {
    const store = useStore.getState();
    if (store.isDirty) {
      // In future: prompt to save
    }
    store.setObjects([]);
    store.setSelectedIds([]);
    store.setProjectName("Untitled");
    store.setProjectPath(null);
    store.setDirty(false);
  },

  async openProject() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.open({
        filters: [
          { name: "Kerf Project", extensions: ["kerf"] },
          { name: "SVG", extensions: ["svg"] },
          { name: "DXF", extensions: ["dxf"] },
          { name: "Images", extensions: ["png", "jpg", "jpeg", "bmp", "gif", "webp"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (!path) return;
      const pathStr = typeof path === "string" ? path : (path as any).path ?? String(path);
      const ext = pathStr.split(".").pop()?.toLowerCase() || "";
      if (ext === "svg") {
        const content = await fsModule.readTextFile(pathStr);
        importSvgContent(content);
      } else if (ext === "dxf") {
        const content = await fsModule.readTextFile(pathStr);
        importDxfContent(content);
      } else if (["png", "jpg", "jpeg", "bmp", "gif", "webp"].includes(ext)) {
        const data = await fsModule.readFile(pathStr);
        importImageData(data, ext);
      } else {
        const content = await fsModule.readTextFile(pathStr);
        const project = JSON.parse(content) as KerfProject;
        useStore.getState().loadProject(project);
        useStore.getState().setProjectPath(pathStr);
      }
    }
  },

  async saveProject() {
    const store = useStore.getState();
    if (store.projectPath) {
      await saveToPath(store.projectPath);
    } else {
      await fileOperations.saveProjectAs();
    }
  },

  async saveProjectAs() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.save({
        filters: [{ name: "Kerf Project", extensions: ["kerf"] }],
        defaultPath: `${useStore.getState().projectName}.kerf`,
      });
      if (!path) return;
      const pathStr = typeof path === "string" ? path : String(path);
      await saveToPath(pathStr);
      useStore.getState().setProjectPath(pathStr);
      const name = pathStr.split("/").pop()?.replace(".kerf", "") || "Untitled";
      useStore.getState().setProjectName(name);
    }
  },

  async importSvg() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.open({
        filters: [{ name: "SVG", extensions: ["svg"] }],
      });
      if (!path) return;
      const pathStr = typeof path === "string" ? path : (path as any).path ?? String(path);
      const content = await fsModule.readTextFile(pathStr);
      importSvgContent(content);
    }
  },

  async exportSvg() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.save({
        filters: [{ name: "SVG", extensions: ["svg"] }],
        defaultPath: `${useStore.getState().projectName}.svg`,
      });
      if (!path) return;
      const pathStr = typeof path === "string" ? path : String(path);
      const svg = exportSvgContent();
      await fsModule.writeTextFile(pathStr, svg);
    }
  },

  async importDxf() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.open({
        filters: [{ name: "DXF", extensions: ["dxf"] }],
      });
      if (!path) return;
      const pathStr = typeof path === "string" ? path : (path as any).path ?? String(path);
      const content = await fsModule.readTextFile(pathStr);
      importDxfContent(content);
    }
  },

  async importImage() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.open({
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "bmp", "gif", "webp"] }],
      });
      if (!path) return;
      const pathStr = typeof path === "string" ? path : (path as any).path ?? String(path);
      const ext = pathStr.split(".").pop()?.toLowerCase() || "png";
      const data = await fsModule.readFile(pathStr);
      importImageData(data, ext);
    }
  },

  async exportGcode() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const store = useStore.getState();
      if (!store.gcodeResult) {
        store.addConsoleLine("Generate G-code first before exporting", "error");
        return;
      }
      const path = await dialogModule.save({
        filters: [{ name: "G-code", extensions: ["gcode", "gc", "nc"] }],
        defaultPath: `${store.projectName}.gcode`,
      });
      if (!path) return;
      const pathStr = typeof path === "string" ? path : String(path);
      await fsModule.writeTextFile(pathStr, store.gcodeResult.gcode);
      store.addConsoleLine(`G-code exported: ${pathStr}`, "info");
    }
  },
};

async function saveToPath(path: string) {
  if (!fsModule) return;
  const project = useStore.getState().toProject();
  await fsModule.writeTextFile(path, JSON.stringify(project, null, 2));
  useStore.getState().setDirty(false);
}

// ===================== DXF IMPORT =====================

function importDxfContent(content: string) {
  try {
    // Dynamic import of dxf-parser
    const DxfParser = (window as any).__dxfParser || null;
    if (!DxfParser) {
      // Fallback: parse DXF manually for common entities
      parseDxfManual(content);
      return;
    }
    const parser = new DxfParser();
    const dxf = parser.parseSync(content);
    if (!dxf || !dxf.entities) return;

    const store = useStore.getState();
    const layerColor = store.layers[store.activeLayerIndex]?.color || "#4a90e2";
    const newObjects: DesignObject[] = [];

    for (const entity of dxf.entities) {
      const obj = dxfEntityToObject(entity, layerColor);
      if (obj) newObjects.push(obj);
    }

    if (newObjects.length > 0) {
      newObjects.forEach(store.addObject);
      store.setSelectedIds(newObjects.map((o) => o.id));
      store.addConsoleLine(`DXF imported: ${newObjects.length} objects`, "info");
    }
  } catch (err) {
    parseDxfManual(content);
  }
}

function parseDxfManual(content: string) {
  const store = useStore.getState();
  const layerColor = store.layers[store.activeLayerIndex]?.color || "#4a90e2";
  const newObjects: DesignObject[] = [];

  // Simple DXF parser for LINE, CIRCLE, ARC, LWPOLYLINE
  const lines = content.split("\n").map((l) => l.trim());
  let i = 0;

  function nextPair(): [number, string] | null {
    if (i >= lines.length - 1) return null;
    const code = parseInt(lines[i]);
    const value = lines[i + 1];
    i += 2;
    return [code, value];
  }

  // Skip to ENTITIES section
  while (i < lines.length) {
    if (lines[i] === "ENTITIES") { i++; break; }
    i++;
  }

  while (i < lines.length) {
    const pair = nextPair();
    if (!pair) break;
    const [code, value] = pair;

    if (code === 0 && value === "ENDSEC") break;

    if (code === 0 && value === "LINE") {
      let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
      while (i < lines.length) {
        const p = nextPair();
        if (!p) break;
        if (p[0] === 0) { i -= 2; break; }
        if (p[0] === 10) x1 = parseFloat(p[1]);
        if (p[0] === 20) y1 = parseFloat(p[1]);
        if (p[0] === 11) x2 = parseFloat(p[1]);
        if (p[0] === 21) y2 = parseFloat(p[1]);
      }
      newObjects.push({
        id: generateId(), type: "line", name: `DXF Line ${newObjects.length + 1}`,
        transform: { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), rotation: 0, scaleX: 1, scaleY: 1 },
        layerIndex: store.activeLayerIndex, visible: true, locked: false,
        fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
        points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
      });
    }

    if (code === 0 && value === "CIRCLE") {
      let cx = 0, cy = 0, r = 0;
      while (i < lines.length) {
        const p = nextPair();
        if (!p) break;
        if (p[0] === 0) { i -= 2; break; }
        if (p[0] === 10) cx = parseFloat(p[1]);
        if (p[0] === 20) cy = parseFloat(p[1]);
        if (p[0] === 40) r = parseFloat(p[1]);
      }
      newObjects.push({
        id: generateId(), type: "ellipse", name: `DXF Circle ${newObjects.length + 1}`,
        transform: { x: cx - r, y: cy - r, width: r * 2, height: r * 2, rotation: 0, scaleX: 1, scaleY: 1 },
        layerIndex: store.activeLayerIndex, visible: true, locked: false,
        fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
      });
    }

    if (code === 0 && value === "LWPOLYLINE") {
      const pts: Array<{ x: number; y: number }> = [];
      let closed = false;
      let currentX = 0, currentY = 0;
      while (i < lines.length) {
        const p = nextPair();
        if (!p) break;
        if (p[0] === 0) { i -= 2; break; }
        if (p[0] === 70) closed = (parseInt(p[1]) & 1) === 1;
        if (p[0] === 10) { currentX = parseFloat(p[1]); }
        if (p[0] === 20) {
          currentY = parseFloat(p[1]);
          pts.push({ x: currentX, y: currentY });
        }
      }
      if (pts.length >= 2) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pt of pts) {
          minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
          maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
        }
        newObjects.push({
          id: generateId(), type: "path", name: `DXF Polyline ${newObjects.length + 1}`,
          transform: { x: minX, y: minY, width: maxX - minX, height: maxY - minY, rotation: 0, scaleX: 1, scaleY: 1 },
          layerIndex: store.activeLayerIndex, visible: true, locked: false,
          fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
          points: pts, closed,
        });
      }
    }
  }

  if (newObjects.length > 0) {
    newObjects.forEach(store.addObject);
    store.setSelectedIds(newObjects.map((o) => o.id));
    store.addConsoleLine(`DXF imported: ${newObjects.length} objects`, "info");
  } else {
    store.addConsoleLine("DXF import: no supported entities found", "error");
  }
}

function dxfEntityToObject(entity: any, layerColor: string): DesignObject | null {
  const store = useStore.getState();
  const base = {
    layerIndex: store.activeLayerIndex, visible: true, locked: false,
    fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
  };

  switch (entity.type) {
    case "LINE":
      return {
        ...base, id: generateId(), type: "line", name: `DXF Line`,
        transform: {
          x: Math.min(entity.vertices[0].x, entity.vertices[1].x),
          y: Math.min(entity.vertices[0].y, entity.vertices[1].y),
          width: Math.abs(entity.vertices[1].x - entity.vertices[0].x),
          height: Math.abs(entity.vertices[1].y - entity.vertices[0].y),
          rotation: 0, scaleX: 1, scaleY: 1,
        },
        points: entity.vertices.map((v: any) => ({ x: v.x, y: v.y })),
      };
    case "CIRCLE":
      return {
        ...base, id: generateId(), type: "ellipse", name: `DXF Circle`,
        transform: {
          x: entity.center.x - entity.radius, y: entity.center.y - entity.radius,
          width: entity.radius * 2, height: entity.radius * 2,
          rotation: 0, scaleX: 1, scaleY: 1,
        },
      };
    case "LWPOLYLINE":
    case "POLYLINE": {
      const pts = (entity.vertices || []).map((v: any) => ({ x: v.x, y: v.y }));
      if (pts.length < 2) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      return {
        ...base, id: generateId(), type: "path", name: `DXF Polyline`,
        transform: { x: minX, y: minY, width: maxX - minX, height: maxY - minY, rotation: 0, scaleX: 1, scaleY: 1 },
        points: pts, closed: entity.shape || false,
      };
    }
    default:
      return null;
  }
}

// ===================== IMAGE IMPORT =====================

function importImageData(data: Uint8Array, ext: string) {
  const store = useStore.getState();
  const mimeMap: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    bmp: "image/bmp", gif: "image/gif", webp: "image/webp",
  };
  const mime = mimeMap[ext] || "image/png";

  // Convert to base64
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  const base64 = `data:${mime};base64,${btoa(binary)}`;

  // Create image to get dimensions
  const img = new Image();
  img.onload = () => {
    // Convert pixel dimensions to mm (assuming 96 DPI)
    const widthMm = (img.width / 96) * 25.4;
    const heightMm = (img.height / 96) * 25.4;

    const obj: DesignObject = {
      id: generateId(),
      type: "image",
      name: `Image ${store.objects.length + 1}`,
      transform: {
        x: 10, y: 10,
        width: widthMm, height: heightMm,
        rotation: 0, scaleX: 1, scaleY: 1,
      },
      layerIndex: store.activeLayerIndex,
      visible: true, locked: false,
      fill: null, stroke: "#999999", strokeWidth: 0, opacity: 1,
      imageData: base64,
    };

    store.addObject(obj);
    store.setSelectedIds([obj.id]);
    store.addConsoleLine(`Image imported: ${img.width}x${img.height}px (${widthMm.toFixed(0)}x${heightMm.toFixed(0)}mm)`, "info");
  };
  img.src = base64;
}

// ===================== 2D TRANSFORM MATRIX =====================

type Matrix = [number, number, number, number, number, number]; // [a, b, c, d, e, f]

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
          // rotate(angle, cx, cy)
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

// ===================== SVG IMPORT =====================

function importSvgContent(svgText: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const svg = doc.querySelector("svg");
  if (!svg) return;

  const store = useStore.getState();
  const newObjects: DesignObject[] = [];

  // Determine coordinate scaling from viewBox + width/height
  const globalScale = computeGlobalScale(svg);

  // Collect CSS styles from <style> elements
  const styleMap = parseEmbeddedStyles(svg);

  // Recursively walk the SVG tree, accumulating transforms
  walkElement(svg, identityMatrix, globalScale, styleMap, store.activeLayerIndex, newObjects);

  newObjects.forEach(store.addObject);
  if (newObjects.length > 0) {
    store.setSelectedIds(newObjects.map((o) => o.id));
  }
}

function computeGlobalScale(svg: SVGSVGElement): number {
  const vb = svg.getAttribute("viewBox");
  const wAttr = svg.getAttribute("width");

  if (!vb) {
    // No viewBox: check if width/height are in mm/cm/in/pt and convert
    if (wAttr) return parseSvgLength(wAttr, 1);
    return 1;
  }

  const parts = vb.split(/[\s,]+/).map(Number);
  if (parts.length < 4 || parts[2] === 0) return 1;

  const vbWidth = parts[2];

  // If width is specified with units, use that to determine scale
  if (wAttr) {
    const widthMm = parseSvgLengthToMm(wAttr);
    if (widthMm > 0) {
      return widthMm / vbWidth;
    }
  }

  // If width is just a number (px), assume 96dpi -> 1px = 0.2646mm
  if (wAttr) {
    const widthPx = parseFloat(wAttr);
    if (!isNaN(widthPx) && widthPx > 0) {
      return (widthPx * 0.2646) / vbWidth;
    }
  }

  // No width attr: assume viewBox units are user units at 96dpi
  return 0.2646; // 1 SVG user unit = ~0.2646mm
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
  // Bare number or px: assume 96dpi
  return num * 0.2646;
}

function parseEmbeddedStyles(svg: SVGSVGElement): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  const styleEls = svg.querySelectorAll("style");
  for (const styleEl of styleEls) {
    const css = styleEl.textContent || "";
    // Simple CSS parser: handles .class { prop: value; }
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
  // Check inline style first
  const inlineStyle = el.getAttribute("style") || "";
  const inlineMatch = inlineStyle.match(new RegExp(`${prop}\\s*:\\s*([^;]+)`));
  if (inlineMatch) return inlineMatch[1].trim();

  // Check direct attribute
  const attr = el.getAttribute(prop);
  if (attr) return attr;

  // Check CSS classes
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
  // Accumulate transform
  const transformAttr = el.getAttribute("transform");
  let matrix = parentMatrix;
  if (transformAttr) {
    const localMatrix = parseTransform(transformAttr);
    matrix = multiplyMatrices(parentMatrix, localMatrix);
  }

  const tag = el.tagName.toLowerCase();

  // Skip non-renderable elements
  if (tag === "defs" || tag === "clippath" || tag === "mask" || tag === "style" || tag === "metadata") return;

  // Try to parse this element as a shape
  if (tag !== "svg" && tag !== "g" && tag !== "use" && tag !== "a") {
    const obj = parseSvgElement(el, matrix, globalScale, styleMap, layerIndex);
    if (obj) {
      results.push(obj);
      return; // Don't recurse into shape elements
    }
  }

  // Recurse into children (for svg, g, a, use, etc.)
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

  // Resolve styles
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
      const x = n(el, "x");
      const y = n(el, "y");
      const w = n(el, "width");
      const h = n(el, "height");
      const rx = n(el, "rx");
      if (w === 0 && h === 0) return null;

      // Transform all four corners
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
      const cx = n(el, "cx");
      const cy = n(el, "cy");
      const r = n(el, "r");
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
      const cx = n(el, "cx");
      const cy = n(el, "cy");
      const erx = n(el, "rx");
      const ery = n(el, "ry");
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
      const x1 = n(el, "x1"), y1 = n(el, "y1");
      const x2 = n(el, "x2"), y2 = n(el, "y2");
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

      // Apply matrix transform to all points (including bezier handles)
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
      const x = n(el, "x");
      const y = n(el, "y");

      // Collect all text including tspan children
      const textContent = collectTextContent(el);
      if (!textContent.trim()) return null;

      // Resolve font properties
      let fontSize = parseFloat(getResolvedStyle(el, "font-size", styleMap) || "16");
      let fontFamily = getResolvedStyle(el, "font-family", styleMap) || "sans-serif";
      const fontWeight = getResolvedStyle(el, "font-weight", styleMap) || "normal";
      const textAnchor = getResolvedStyle(el, "text-anchor", styleMap) || "start";

      // Clean font family
      fontFamily = fontFamily.replace(/['"]/g, "");

      // Apply transform to position
      const pos = applyMatrix(matrix, x, y);
      const ms = getMatrixScale(matrix);
      fontSize = fontSize * ms.sy * scale;

      // Approximate text dimensions
      const avgCharWidth = fontSize * 0.55;
      const estWidth = textContent.length * avgCharWidth;
      const estHeight = fontSize * 1.3;

      // Adjust x based on text-anchor
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
          y: pos.y * scale - fontSize, // SVG text y is baseline
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
      const x = n(el, "x");
      const y = n(el, "y");
      const w = n(el, "width");
      const h = n(el, "height");
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

// ===================== PATH PARSING =====================

interface PathPoint {
  x: number;
  y: number;
  handleIn?: { x: number; y: number };
  handleOut?: { x: number; y: number };
}

function parsePathD(d: string): PathPoint[] {
  const points: PathPoint[] = [];
  const tokens = tokenizePath(d);
  let cx = 0, cy = 0; // current point
  let sx = 0, sy = 0; // subpath start
  let lastCmd = "";
  let lastCx2 = 0, lastCy2 = 0; // last control point for S/T

  let i = 0;
  while (i < tokens.length) {
    let cmd = tokens[i];

    // Implicit repeat: if we get a number where we expect a command, repeat last command
    if (!isNaN(Number(cmd))) {
      if (lastCmd === "M") cmd = "L";
      else if (lastCmd === "m") cmd = "l";
      else cmd = lastCmd;
    } else {
      i++;
    }

    switch (cmd) {
      case "M": {
        cx = num(tokens, i); cy = num(tokens, i + 1); i += 2;
        sx = cx; sy = cy;
        points.push({ x: cx, y: cy });
        lastCmd = "M";
        break;
      }
      case "m": {
        cx += num(tokens, i); cy += num(tokens, i + 1); i += 2;
        sx = cx; sy = cy;
        points.push({ x: cx, y: cy });
        lastCmd = "m";
        break;
      }
      case "L": {
        cx = num(tokens, i); cy = num(tokens, i + 1); i += 2;
        points.push({ x: cx, y: cy });
        lastCmd = "L";
        break;
      }
      case "l": {
        cx += num(tokens, i); cy += num(tokens, i + 1); i += 2;
        points.push({ x: cx, y: cy });
        lastCmd = "l";
        break;
      }
      case "H": {
        cx = num(tokens, i); i += 1;
        points.push({ x: cx, y: cy });
        lastCmd = "H";
        break;
      }
      case "h": {
        cx += num(tokens, i); i += 1;
        points.push({ x: cx, y: cy });
        lastCmd = "h";
        break;
      }
      case "V": {
        cy = num(tokens, i); i += 1;
        points.push({ x: cx, y: cy });
        lastCmd = "V";
        break;
      }
      case "v": {
        cy += num(tokens, i); i += 1;
        points.push({ x: cx, y: cy });
        lastCmd = "v";
        break;
      }
      case "C": {
        const x1 = num(tokens, i), y1 = num(tokens, i + 1);
        const x2 = num(tokens, i + 2), y2 = num(tokens, i + 3);
        const x = num(tokens, i + 4), y = num(tokens, i + 5);
        i += 6;

        // Set handleOut on previous point
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
        const x1 = cx + num(tokens, i), y1 = cy + num(tokens, i + 1);
        const x2 = cx + num(tokens, i + 2), y2 = cy + num(tokens, i + 3);
        const x = cx + num(tokens, i + 4), y = cy + num(tokens, i + 5);
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
        // Smooth cubic: reflect previous control point
        const rx = 2 * cx - lastCx2, ry = 2 * cy - lastCy2;
        const x2 = num(tokens, i), y2 = num(tokens, i + 1);
        const x = num(tokens, i + 2), y = num(tokens, i + 3);
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
        const x2 = cx + num(tokens, i), y2 = cy + num(tokens, i + 1);
        const x = cx + num(tokens, i + 2), y = cy + num(tokens, i + 3);
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
        const qx = num(tokens, i), qy = num(tokens, i + 1);
        const x = num(tokens, i + 2), y = num(tokens, i + 3);
        i += 4;
        // Convert quadratic to cubic handles
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
        const qx = cx + num(tokens, i), qy = cy + num(tokens, i + 1);
        const x = cx + num(tokens, i + 2), y = cy + num(tokens, i + 3);
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
        const x = num(tokens, i), y = num(tokens, i + 1);
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
        const x = cx + num(tokens, i), y = cy + num(tokens, i + 1);
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
        // Arc: approximate with line segments
        const isRel = cmd === "a";
        const arx = num(tokens, i), ary = num(tokens, i + 1);
        const rotation = num(tokens, i + 2);
        const largeArc = num(tokens, i + 3);
        const sweep = num(tokens, i + 4);
        let ex = num(tokens, i + 5), ey = num(tokens, i + 6);
        i += 7;

        if (isRel) { ex += cx; ey += cy; }

        // Approximate arc with line segments
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

/** Tokenize SVG path data into commands and numbers */
function tokenizePath(d: string): string[] {
  const tokens: string[] = [];
  // Match commands (single letters) and numbers (including negative, decimal, and scientific notation)
  const regex = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
  let match;
  while ((match = regex.exec(d)) !== null) {
    tokens.push(match[0]);
  }
  return tokens;
}

function num(tokens: string[], i: number): number {
  return i < tokens.length ? parseFloat(tokens[i]) || 0 : 0;
}

function n(el: Element, attr: string): number {
  return parseFloat(el.getAttribute(attr) || "0") || 0;
}

function boundingBox(points: Array<{ x: number; y: number }>): { x: number; y: number; w: number; h: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const maxX = Math.max(...xs), maxY = Math.max(...ys);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Approximate an SVG arc with line segments */
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

  // Step 1: Transform to center parameterization
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Ensure radii are large enough
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const sqrtL = Math.sqrt(lambda);
    rx *= sqrtL;
    ry *= sqrtL;
  }

  const rxSq = rx * rx, rySq = ry * ry;
  const x1pSq = x1p * x1p, y1pSq = y1p * y1p;
  let num2 = rxSq * rySq - rxSq * y1pSq - rySq * x1pSq;
  let den = rxSq * y1pSq + rySq * x1pSq;
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

  let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);

  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;

  // Generate points
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
  // Handle tspan children
  const tspans = el.querySelectorAll("tspan");
  if (tspans.length > 0) {
    return Array.from(tspans)
      .map((ts) => ts.textContent || "")
      .join(" ");
  }
  return el.textContent || "";
}

// ===================== SVG EXPORT =====================

function exportSvgContent(): string {
  const store = useStore.getState();
  const { objects, workspaceWidth, workspaceHeight } = store;

  let elements = "";

  for (const obj of objects) {
    if (!obj.visible) continue;
    const t = obj.transform;
    const stroke = obj.stroke;
    const sw = obj.strokeWidth;
    const fill = obj.fill || "none";
    const opacity = obj.opacity < 1 ? ` opacity="${obj.opacity}"` : "";

    switch (obj.type) {
      case "rectangle": {
        const rx = obj.cornerRadius ? ` rx="${obj.cornerRadius}"` : "";
        elements += `  <rect x="${t.x}" y="${t.y}" width="${t.width}" height="${t.height}"${rx} fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${opacity}/>\n`;
        break;
      }
      case "ellipse": {
        const cx = t.x + t.width / 2;
        const cy = t.y + t.height / 2;
        elements += `  <ellipse cx="${cx}" cy="${cy}" rx="${t.width / 2}" ry="${t.height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${opacity}/>\n`;
        break;
      }
      case "line": {
        if (obj.points && obj.points.length >= 2) {
          elements += `  <line x1="${obj.points[0].x}" y1="${obj.points[0].y}" x2="${obj.points[1].x}" y2="${obj.points[1].y}" stroke="${stroke}" stroke-width="${sw}"${opacity}/>\n`;
        }
        break;
      }
      case "path": {
        if (obj.points && obj.points.length >= 2) {
          let d = `M${obj.points[0].x},${obj.points[0].y}`;
          for (let i = 1; i < obj.points.length; i++) {
            const pt = obj.points[i];
            const prev = obj.points[i - 1];
            if (prev.handleOut && pt.handleIn) {
              d += ` C${prev.handleOut.x},${prev.handleOut.y} ${pt.handleIn.x},${pt.handleIn.y} ${pt.x},${pt.y}`;
            } else {
              d += ` L${pt.x},${pt.y}`;
            }
          }
          if (obj.closed) d += " Z";
          elements += `  <path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${opacity}/>\n`;
        }
        break;
      }
      case "text": {
        if (obj.text) {
          const fs = obj.fontSize || 16;
          const ff = obj.fontFamily || "sans-serif";
          const textFill = obj.fill || obj.stroke || "#e8e8e8";
          const textY = t.y + fs;
          const escaped = obj.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          elements += `  <text x="${t.x}" y="${textY}" font-size="${fs}" font-family="${ff}" fill="${textFill}"${opacity}>${escaped}</text>\n`;
        }
        break;
      }
      case "image": {
        if (obj.imageData) {
          elements += `  <image x="${t.x}" y="${t.y}" width="${t.width}" height="${t.height}" href="${obj.imageData}"${opacity}/>\n`;
        }
        break;
      }
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${workspaceWidth}mm" height="${workspaceHeight}mm" viewBox="0 0 ${workspaceWidth} ${workspaceHeight}">
${elements}</svg>`;
}
