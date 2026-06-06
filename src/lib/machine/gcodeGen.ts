import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../app/store";
import type { DesignObject, Layer } from "../../app/types";
import { offsetRingByDistance, composeGroupChildTransform, rotatePathPoint } from "../geometry";

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

export interface PreviewDitherResult {
  imageData: string;
  width: number;
  height: number;
  ditherMethod: string;
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
    scanAngle: number;
    angleIncrement: number;
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
    powerCurve?: Array<[number, number]>;
    fillOrder?: string;
    newsprintCellSize?: number;
    newsprintAngle?: number;
  };
  cornerRadius: number | null;
  rotation: number;
  priority?: number;
  groupId?: string;
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
    scanAngle: layer.scanAngle ?? 0,
    angleIncrement: layer.angleIncrement ?? 0,
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
    powerCurve: layer.powerCurve?.map((p) => [p.x, p.y] as [number, number]),
    fillOrder: layer.fillOrder || "sequential",
    newsprintCellSize: layer.newsprintCellSize,
    newsprintAngle: layer.newsprintAngle,
  };
}


/**
 * D2: Compose group rotation onto a child's transform.
 *
 * For PRIMITIVE children (rectangle, ellipse, text, image):
 *   - Delegate to composeGroupChildTransform to rotate the AABB center and combine
 *     rotation angles (r_g + r_c). Downstream (Rust rotate_segment, Viewport
 *     applyObjectRotation) will apply the combined rotation to the generated geometry.
 *
 * For PATH/LINE children (points[] stores absolute workspace coords, decoupled from
 *   transform.x/y):
 *   - Physically rotate each point (and bezier handles) by r_g around the group center.
 *   - Recompute transform.x/y/width/height from the new points AABB.
 *   - Keep transform.rotation = r_c (child's own rotation only); r_g is already baked
 *     into the point positions so downstream must NOT add it again.
 */
function applyGroupRotationToChild(child: DesignObject, group: DesignObject): DesignObject {
  const t = child.transform;
  const g = group.transform;
  const groupRot = g.rotation || 0;

  // Path/line: points are absolute workspace coords — physically apply r_g
  if ((child.type === "path" || child.type === "line") && child.points && child.points.length >= 1) {
    if (groupRot === 0) {
      // Fast path: no rotation, just apply group translation to transform x/y
      return {
        ...child,
        transform: {
          ...t,
          x: t.x + g.x,
          y: t.y + g.y,
        },
      };
    }
    const gcx = g.x + g.width / 2;
    const gcy = g.y + g.height / 2;
    const rotatedPoints = child.points.map((pt) => rotatePathPoint(pt, gcx, gcy, groupRot));

    // Recompute AABB from rotated points
    const xs = rotatedPoints.map((p) => p.x);
    const ys = rotatedPoints.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    return {
      ...child,
      points: rotatedPoints,
      transform: {
        ...t,
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        rotation: t.rotation || 0, // r_c only — r_g is baked into points
      },
    };
  }

  // Primitive: delegate to shared AABB-center rotation helper
  const composed = composeGroupChildTransform(
    t.x, t.y, t.width, t.height, t.rotation || 0,
    g.x, g.y, g.width, g.height, groupRot,
  );
  return {
    ...child,
    transform: {
      ...t,
      x: composed.x,
      y: composed.y,
      rotation: composed.rotation,
    },
  };
}

/** Recursively flatten groups into leaf objects with parent transform applied.
 *  Composes group rotation onto each child's center and rotation field.
 *  Sets groupId on each child to the nearest parent group's id for cut-planner affinity. */
function flattenObjects(objects: DesignObject[], parentGroupId?: string): DesignObject[] {
  const result: DesignObject[] = [];
  for (const obj of objects) {
    if (obj.type === "group" && obj.children) {
      for (const child of obj.children) {
        const expanded = {
          ...applyGroupRotationToChild(child, obj),
          groupId: obj.id,
        };
        result.push(...flattenObjects([expanded], obj.id));
      }
    } else {
      result.push(parentGroupId ? { ...obj, groupId: parentGroupId } : obj);
    }
  }
  return result;
}

/** Exported for unit testing — do not use in production code outside this module. */
export { flattenObjects as flattenObjectsForTest };

/** Convert store objects to CutObjects for the Rust engine, sorted by layer order */
function toCutObjects(objects: DesignObject[], layers: Layer[]): { objects: CutObject[]; warnings: string[] } {
  const flat = flattenObjects(objects);
  // Sort by layer array position (cut sequence order)
  const layerOrder = new Map(layers.map((l, pos) => [l.index, pos]));
  flat.sort((a, b) => (layerOrder.get(a.layerIndex) ?? 0) - (layerOrder.get(b.layerIndex) ?? 0));
  const result: CutObject[] = [];
  const warnings: string[] = [];

  for (const obj of flat) {
    if (!obj.visible || obj.locked) continue;
    const layer = layers.find((l) => l.index === obj.layerIndex) || layers[0];
    if (!layer.visible || layer.output === false) continue;
    if (obj.type === "text") {
      warnings.push(`Text object "${obj.name}" skipped -- use Ctrl+Shift+C to convert to path`);
      continue;
    }
    if (obj.type === "image") continue;

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
      priority: obj.priority ?? 0,
      groupId: obj.groupId,
    };

    const scale = obj.powerScale ?? 1.0;

    // If layer has sub-layers, emit one CutObject per sub-layer
    if (layer.subLayers && layer.subLayers.length > 0) {
      for (const sub of layer.subLayers) {
        const cl = buildCutLayer(layer, sub);
        cl.power *= scale;
        cl.powerMin *= scale;
        result.push({ ...base, id: `${obj.id}_${sub.id}`, layer: cl });
      }
    } else {
      const cl = buildCutLayer(layer);
      cl.power *= scale;
      cl.powerMin *= scale;
      result.push({ ...base, layer: cl });
    }
  }

  return { objects: result, warnings };
}

/** Generate G-code for image objects using the dedicated Rust image pipeline */
async function generateImageGcode(sValueMax: number = 1000): Promise<GcodeResult | null> {
  const store = useStore.getState();
  const imageObjects = store.objects.filter(
    (obj) => obj.type === "image" && obj.visible && !obj.locked && obj.imageData,
  );

  if (imageObjects.length === 0) return null;

  const results: GcodeResult[] = [];
  for (const obj of imageObjects) {
    const layer = store.layers.find((l) => l.index === obj.layerIndex) || store.layers[0];
    if (!layer.visible || layer.output === false) continue;
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
        sValueMax,
        powerCurve: layer.powerCurve?.map((p) => [p.x, p.y] as [number, number]),
        newsprintCellSize: layer.newsprintCellSize,
        newsprintAngle: layer.newsprintAngle,
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
  const { objects: cutObjects, warnings } = toCutObjects(store.objects, store.layers);

  // Surface warnings for skipped objects in the console panel
  for (const w of warnings) {
    store.addConsoleLine(w, "info");
  }

  // M3 constant-power warnings
  for (const obj of cutObjects) {
    if (obj.layer.powerMode !== "variable") {
      store.addConsoleLine(
        `Layer uses constant power (M3). Laser will not reduce power during speed changes. Use variable power (M4) unless doing constant-speed through-cuts.`,
        "warning",
      );
      break; // One warning is enough
    }
  }

  const sValueMax = store.grblSValueMax;

  try {
    // Image engraving first (runs before vector cuts)
    const imageResult = await generateImageGcode(sValueMax);

    const vectorResult = await invoke<GcodeResult>("generate_gcode", {
      objects: cutObjects,
      workspaceHeight: store.workspaceHeight,
      sValueMax,
      startCorner: store.startCorner || "bottomLeft",
      workspaceWidth: store.workspaceWidth,
    });

    if (imageResult) {
      return mergeGcodeResults([imageResult, vectorResult]);
    }
    return vectorResult;
  } catch (e) {
    // Fallback: generate G-code in JS if Rust isn't available
    console.warn("Rust G-code gen failed, using JS fallback:", e);
    return generateGcodeFallback(cutObjects, store.workspaceHeight, sValueMax);
  }
}

/** Pure JS fallback G-code generator */
function generateGcodeFallback(objects: CutObject[], workspaceHeight: number, sValueMax: number = 1000): GcodeResult {
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
    const sMax = Math.round(obj.layer.power / 100 * sValueMax);
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
  let prevX = 0, prevY = 0;
  for (const m of moves) {
    const d = Math.hypot(m.x - prevX, m.y - prevY);
    time += d / (m.speed / 60); // speed is mm/min
    prevX = m.x;
    prevY = m.y;
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

/** Preview dithered image for a specific image object */
export async function previewImageDither(objectId: string): Promise<PreviewDitherResult> {
  const store = useStore.getState();
  const obj = store.objects.find((o) => o.id === objectId);
  if (!obj || obj.type !== "image" || !obj.imageData) {
    throw new Error("No image object found");
  }
  const layer = store.layers.find((l) => l.index === obj.layerIndex) || store.layers[0];
  const adj = obj.imageAdjustments || { brightness: 0, contrast: 0, gamma: 1, invert: false };

  return invoke<PreviewDitherResult>("preview_image_dither", {
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
      sValueMax: store.grblSValueMax,
      powerCurve: layer.powerCurve?.map((p) => [p.x, p.y] as [number, number]),
      newsprintCellSize: layer.newsprintCellSize,
      newsprintAngle: layer.newsprintAngle,
    },
  });
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
