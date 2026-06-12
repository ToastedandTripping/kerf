import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../app/store";
import type { DesignObject, Layer } from "../../app/types";
import { offsetRingByDistance, composeGroupChild, sampleBezierPath } from "../geometry";

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


/** Recursively flatten groups into leaf objects with parent transform applied.
 *
 *  Group composition (translation + rotation, for primitives AND path/line
 *  children whose points[] are GROUP-LOCAL) lives in lib/geometry's
 *  composeGroupChild — the ONE function shared with the Viewport renderer, so
 *  the cut can never disagree with the screen. This recursion only owns the
 *  groupId stamping (nearest parent group, for cut-planner affinity). */
function flattenObjects(objects: DesignObject[], parentGroupId?: string): DesignObject[] {
  const result: DesignObject[] = [];
  for (const obj of objects) {
    if (obj.type === "group" && obj.children) {
      for (const child of obj.children) {
        const expanded = {
          ...composeGroupChild(child, obj),
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
  // W1c rider (F3 interim): fill mode scans each object's raw bbox, so ≥2
  // grouped objects on a fill layer put 2× energy into overlapping regions
  // (a split compound shape's hole bbox burns twice) until hole-aware fill
  // ships. Counted per SOURCE object (pre-sub-layer expansion).
  const fillGroupCounts = new Map<string, number>();

  for (const obj of flat) {
    if (!obj.visible || obj.locked) continue;
    const layer = layers.find((l) => l.index === obj.layerIndex) || layers[0];
    if (!layer.visible || layer.output === false) continue;
    if (obj.type === "text") {
      warnings.push(`Text object "${obj.name}" skipped -- use Ctrl+Shift+C to convert to path`);
      continue;
    }
    if (obj.type === "image") continue;

    if (obj.groupId && layer.mode !== "line") {
      fillGroupCounts.set(obj.groupId, (fillGroupCounts.get(obj.groupId) || 0) + 1);
    }

    const paths: CutObject["paths"] = [];

    if (obj.points && obj.points.length >= 2) {
      // W1c (F2): adaptive bezier sampling — handles no longer stripped; the
      // laser cuts the rendered curve to CURVE_CHORD_TOLERANCE_MM. Sampling
      // happens BEFORE the kerf block below so the ring offset operates on
      // the dense polyline (a faithful curve-offset approximation).
      paths.push({
        points: sampleBezierPath(obj.points, obj.closed || false),
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

  for (const count of fillGroupCounts.values()) {
    if (count >= 2) {
      warnings.push(
        "Fill warning: overlapping fill regions in a group receive double energy until hole-aware fill ships -- a compound shape's hole area is scanned twice (char risk on thin stock)",
      );
      break; // One warning is enough
    }
  }

  return { objects: result, warnings };
}

/** Exported for unit testing — do not use in production code outside this module. */
export { toCutObjects as toCutObjectsForTest };

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

    try {
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
    } catch (e) {
      // Multi-image jobs: which image broke matters — wrap with the object name.
      throw new Error(`Image "${obj.name}": ${e}`, { cause: e });
    }
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

/** Generate G-code from the current design using the Rust backend.
 *
 *  THROWS on engine failure — there is no JS fallback (deleted by decision:
 *  under Tauri the Rust engine is always present, so any failure means the
 *  REAL generator is broken; the old silent fallback lacked lead-in/out, tabs,
 *  perforation, overscan, offsetFill and scan-angle and let users run
 *  materially degraded cuts indefinitely). Callers MUST surface the error
 *  (the single caller, MachinePanel.handleGenerateGcode, logs to console and
 *  sets a status line). */
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

  // No try/catch: a failure here is a broken engine, and it must propagate
  // loudly to the caller (rethrow-only semantics; an actual catch{throw}
  // would only add a useless-catch lint warning). Nothing soft lives below —
  // toCutObjects warnings already emitted above.
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

