import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../app/store";
import type { DesignObject, Layer } from "../../app/types";

export interface GcodeMove {
  x: number;
  y: number;
  moveType: "rapid" | "cut" | "engrave";
  speed: number;
  power: number;
}

export interface GcodeResult {
  gcode: string;
  moves: GcodeMove[];
  totalDistance: number;
  cutDistance: number;
  travelDistance: number;
  estimatedTimeSecs: number;
  lineCount: number;
}

interface CutObject {
  id: string;
  objType: string;
  x: number;
  y: number;
  width: number;
  height: number;
  paths: Array<{ points: Array<{ x: number; y: number }>; closed: boolean }>;
  layer: {
    mode: string;
    power: number;
    powerMin: number;
    speed: number;
    passes: number;
    powerMode: string;
    interval: number;
    airAssist: boolean;
    cutInnerFirst: boolean;
    dither: string;
    overcut: number;
    leadIn: number;
    leadOut: number;
    overscan: number;
    bidirectional: boolean;
    crossHatch: boolean;
    scanningOffset: number;
    tabSpacing: number;
    tabWidth: number;
    perforationCut: number;
    perforationSkip: number;
  };
  cornerRadius: number | null;
  rotation: number;
}

/** Build layer settings for a CutObject from a Layer (or SubLayer override) */
function buildCutLayer(layer: Layer, sub?: { mode: string; power: number; powerMin: number; speed: number; passes: number; powerMode: string; interval: number }): CutObject["layer"] {
  return {
    mode: sub?.mode ?? layer.mode,
    power: sub?.power ?? layer.power,
    powerMin: sub?.powerMin ?? layer.powerMin,
    speed: sub?.speed ?? layer.speed,
    passes: sub?.passes ?? layer.passes,
    powerMode: sub?.powerMode ?? layer.powerMode,
    interval: sub?.interval ?? layer.interval,
    airAssist: layer.airAssist,
    cutInnerFirst: layer.cutInnerFirst,
    dither: layer.dither,
    overcut: layer.overcut,
    leadIn: layer.leadIn,
    leadOut: layer.leadOut,
    overscan: layer.overscan,
    bidirectional: layer.bidirectional,
    crossHatch: layer.crossHatch,
    scanningOffset: layer.scanningOffset,
    tabSpacing: layer.tabSpacing,
    tabWidth: layer.tabWidth,
    perforationCut: layer.perforationCut,
    perforationSkip: layer.perforationSkip,
  };
}

/** Offset a closed ring of points by a distance using vertex-normal averaging */
function offsetRingByDistance(
  ring: Array<[number, number]>,
  distance: number,
): Array<[number, number]> {
  const n = ring.length;
  if (n < 3) return ring;
  const closed = ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring;
  const len = pts.length;
  const result: Array<[number, number]> = [];

  for (let i = 0; i < len; i++) {
    const prev = pts[(i - 1 + len) % len];
    const curr = pts[i];
    const next = pts[(i + 1) % len];
    const dx1 = curr[0] - prev[0], dy1 = curr[1] - prev[1];
    const dx2 = next[0] - curr[0], dy2 = next[1] - curr[1];
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
    const nx1 = -dy1 / len1, ny1 = dx1 / len1;
    const nx2 = -dy2 / len2, ny2 = dx2 / len2;
    const nx = nx1 + nx2, ny = ny1 + ny2;
    const nlen = Math.sqrt(nx * nx + ny * ny) || 1;
    result.push([curr[0] + (nx / nlen) * distance, curr[1] + (ny / nlen) * distance]);
  }
  if (result.length > 0) result.push([result[0][0], result[0][1]]);
  return result;
}

/** Convert store objects to CutObjects for the Rust engine */
function toCutObjects(objects: DesignObject[], layers: Layer[]): CutObject[] {
  const result: CutObject[] = [];

  for (const obj of objects) {
    if (!obj.visible || obj.locked || obj.type === "text" || obj.type === "image") continue;

    const layer = layers.find((l) => l.index === obj.layerIndex) || layers[0];
    const paths: CutObject["paths"] = [];

    if (obj.points && obj.points.length >= 2) {
      paths.push({
        points: obj.points.map((p) => ({ x: p.x, y: p.y })),
        closed: obj.closed || false,
      });
    }

    // Apply kerf offset for closed paths in line mode
    if (layer.kerfOffset !== 0 && layer.mode === "line") {
      for (const path of paths) {
        if (!path.closed || path.points.length < 3) continue;
        const ring: Array<[number, number]> = path.points.map((p) => [p.x, p.y]);
        ring.push([ring[0][0], ring[0][1]]); // close
        const offset = offsetRingByDistance(ring, layer.kerfOffset);
        path.points = offset.slice(0, -1).map(([x, y]) => ({ x, y }));
      }
    }

    const base = {
      id: obj.id,
      objType: obj.type,
      x: obj.transform.x,
      y: obj.transform.y,
      width: obj.transform.width,
      height: obj.transform.height,
      paths,
      cornerRadius: obj.cornerRadius || null,
      rotation: obj.transform.rotation || 0,
    };

    // If layer has sub-layers, emit one CutObject per sub-layer
    if (layer.subLayers && layer.subLayers.length > 0) {
      for (const sub of layer.subLayers) {
        result.push({ ...base, id: `${obj.id}_${sub.id}`, layer: buildCutLayer(layer, sub) });
      }
    } else {
      result.push({ ...base, layer: buildCutLayer(layer) });
    }
  }

  return result;
}

/** Generate G-code for image objects using the dedicated Rust image pipeline */
async function generateImageGcode(): Promise<GcodeResult | null> {
  const store = useStore.getState();
  const imageObjects = store.objects.filter(
    (obj) => obj.type === "image" && obj.visible && !obj.locked && obj.imageData,
  );

  if (imageObjects.length === 0) return null;

  const results: GcodeResult[] = [];
  for (const obj of imageObjects) {
    const layer = store.layers.find((l) => l.index === obj.layerIndex) || store.layers[0];
    const adj = obj.imageAdjustments || { brightness: 0, contrast: 0, gamma: 1, invert: false };

    const result = await invoke<GcodeResult>("generate_image_gcode", {
      request: {
        imageData: obj.imageData,
        x: obj.transform.x,
        y: obj.transform.y,
        width: obj.transform.width,
        height: obj.transform.height,
        rotation: obj.transform.rotation || 0,
        power: layer.power,
        powerMin: layer.powerMin,
        speed: layer.speed,
        passes: layer.passes,
        powerMode: layer.powerMode,
        interval: layer.interval,
        dither: layer.dither,
        overscan: layer.overscan,
        bidirectional: layer.bidirectional,
        scanningOffset: layer.scanningOffset,
        brightness: adj.brightness,
        contrast: adj.contrast,
        gamma: adj.gamma,
        invert: adj.invert,
        workspaceHeight: store.workspaceHeight,
      },
    });
    results.push(result);
  }

  return mergeGcodeResults(results);
}

/** Merge multiple GcodeResults into one (concatenates G-code, sums distances) */
function mergeGcodeResults(results: GcodeResult[]): GcodeResult {
  if (results.length === 1) return results[0];
  return {
    gcode: results.map((r) => r.gcode).join("\n"),
    moves: results.flatMap((r) => r.moves),
    totalDistance: results.reduce((s, r) => s + r.totalDistance, 0),
    cutDistance: results.reduce((s, r) => s + r.cutDistance, 0),
    travelDistance: results.reduce((s, r) => s + r.travelDistance, 0),
    estimatedTimeSecs: results.reduce((s, r) => s + r.estimatedTimeSecs, 0),
    lineCount: results.reduce((s, r) => s + r.lineCount, 0),
  };
}

/** Generate G-code from the current design using Rust backend */
export async function generateGcode(): Promise<GcodeResult> {
  const store = useStore.getState();
  const cutObjects = toCutObjects(store.objects, store.layers);

  try {
    // Image engraving first (runs before vector cuts)
    const imageResult = await generateImageGcode();

    const vectorResult = await invoke<GcodeResult>("generate_gcode", {
      objects: cutObjects,
      workspaceHeight: store.workspaceHeight,
    });

    if (imageResult) {
      return mergeGcodeResults([imageResult, vectorResult]);
    }
    return vectorResult;
  } catch (e) {
    // Fallback: generate G-code in JS if Rust isn't available
    console.warn("Rust G-code gen failed, using JS fallback:", e);
    return generateGcodeFallback(cutObjects, store.workspaceHeight);
  }
}

/** Pure JS fallback G-code generator */
function generateGcodeFallback(objects: CutObject[], workspaceHeight: number): GcodeResult {
  const lines: string[] = [];
  const moves: GcodeMove[] = [];
  let cutDist = 0;
  let travelDist = 0;
  let cx = 0, cy = 0;

  lines.push("; Generated by Kerf");
  lines.push("G21 ; mm mode");
  lines.push("G90 ; absolute positioning");
  lines.push("M5 ; laser off");
  lines.push("G0 X0 Y0");
  lines.push("");

  for (const obj of objects) {
    const speed = obj.layer.speed * 60; // mm/s to mm/min
    const sMax = Math.round(obj.layer.power / 100 * 1000);
    const powerCmd = obj.layer.powerMode === "variable" ? "M4" : "M3";

    for (let pass = 0; pass < obj.layer.passes; pass++) {
      if (obj.layer.mode === "line") {
        let pts = obj.paths.length > 0 ? obj.paths[0].points : objectToPoints(obj);
        const closed = obj.paths.length > 0 ? obj.paths[0].closed : (obj.objType !== "line");

        // Rotate explicit path points if needed
        if (obj.paths.length > 0 && obj.rotation && Math.abs(obj.rotation) > 0.001) {
          pts = rotatePoints(pts, obj.x + obj.width / 2, obj.y + obj.height / 2,
            obj.rotation * Math.PI / 180);
        }

        if (pts.length < 2) continue;

        // Rapid to start
        const sy = workspaceHeight - pts[0].y;
        const d = Math.hypot(pts[0].x - cx, sy - cy);
        travelDist += d;
        lines.push(`G0 X${pts[0].x.toFixed(3)} Y${sy.toFixed(3)}`);
        moves.push({ x: pts[0].x, y: sy, moveType: "rapid", speed: 3000, power: 0 });
        cx = pts[0].x; cy = sy;

        lines.push(`${powerCmd} S${sMax}`);

        for (let i = 1; i < pts.length; i++) {
          const py = workspaceHeight - pts[i].y;
          const dd = Math.hypot(pts[i].x - cx, py - cy);
          cutDist += dd;
          lines.push(`G1 X${pts[i].x.toFixed(3)} Y${py.toFixed(3)} F${speed} S${sMax}`);
          moves.push({ x: pts[i].x, y: py, moveType: "cut", speed, power: sMax });
          cx = pts[i].x; cy = py;
        }

        if (closed && pts.length > 2) {
          const fy = workspaceHeight - pts[0].y;
          const dd = Math.hypot(pts[0].x - cx, fy - cy);
          cutDist += dd;
          lines.push(`G1 X${pts[0].x.toFixed(3)} Y${fy.toFixed(3)} F${speed} S${sMax}`);
          moves.push({ x: pts[0].x, y: fy, moveType: "cut", speed, power: sMax });
          cx = pts[0].x; cy = fy;
        }

        lines.push("M5");
      } else {
        // Fill mode
        const interval = obj.layer.interval || 0.1;
        let y = obj.y;
        let ltr = true;

        while (y <= obj.y + obj.height) {
          const gy = workspaceHeight - y;
          const sx = ltr ? obj.x : obj.x + obj.width;
          const ex = ltr ? obj.x + obj.width : obj.x;

          travelDist += Math.hypot(sx - cx, gy - cy);
          lines.push(`G0 X${sx.toFixed(3)} Y${gy.toFixed(3)}`);
          moves.push({ x: sx, y: gy, moveType: "rapid", speed: 3000, power: 0 });

          lines.push(`${powerCmd} S${sMax}`);
          cutDist += Math.abs(ex - sx);
          lines.push(`G1 X${ex.toFixed(3)} Y${gy.toFixed(3)} F${speed} S${sMax}`);
          moves.push({ x: ex, y: gy, moveType: "engrave", speed, power: sMax });
          lines.push("M5");

          cx = ex; cy = gy;
          y += interval;
          ltr = !ltr;
        }
      }
      lines.push("");
    }
  }

  lines.push("M5 ; laser off");
  lines.push("G0 X0 Y0 ; return home");
  lines.push("M2 ; program end");

  const totalDist = cutDist + travelDist;

  // Basic time estimate
  let time = 0;
  for (const m of moves) {
    const prev = moves.indexOf(m) > 0 ? moves[moves.indexOf(m) - 1] : { x: 0, y: 0 };
    const d = Math.hypot(m.x - prev.x, m.y - prev.y);
    time += d / (m.speed / 60); // speed is mm/min
  }

  return {
    gcode: lines.join("\n"),
    moves,
    totalDistance: totalDist,
    cutDistance: cutDist,
    travelDistance: travelDist,
    estimatedTimeSecs: time,
    lineCount: lines.length,
  };
}

function rotatePoints(
  pts: Array<{ x: number; y: number }>,
  cx: number, cy: number, rad: number
): Array<{ x: number; y: number }> {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return pts.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  });
}

function objectToPoints(obj: CutObject): Array<{ x: number; y: number }> {
  let pts: Array<{ x: number; y: number }>;
  switch (obj.objType) {
    case "rectangle":
      pts = [
        { x: obj.x, y: obj.y },
        { x: obj.x + obj.width, y: obj.y },
        { x: obj.x + obj.width, y: obj.y + obj.height },
        { x: obj.x, y: obj.y + obj.height },
      ];
      break;
    case "ellipse": {
      const cxe = obj.x + obj.width / 2;
      const cye = obj.y + obj.height / 2;
      const rx = obj.width / 2;
      const ry = obj.height / 2;
      pts = [];
      for (let i = 0; i < 64; i++) {
        const a = (2 * Math.PI * i) / 64;
        pts.push({ x: cxe + rx * Math.cos(a), y: cye + ry * Math.sin(a) });
      }
      break;
    }
    case "line":
      pts = [
        { x: obj.x, y: obj.y },
        { x: obj.x + obj.width, y: obj.y + obj.height },
      ];
      break;
    default:
      pts = [];
  }

  if (obj.rotation && Math.abs(obj.rotation) > 0.001) {
    pts = rotatePoints(pts, obj.x + obj.width / 2, obj.y + obj.height / 2,
      obj.rotation * Math.PI / 180);
  }
  return pts;
}
