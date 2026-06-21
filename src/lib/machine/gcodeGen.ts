import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../app/store";
import type { DesignObject, Layer, InternalCutMode } from "../../app/types";
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
    mode: InternalCutMode; // "maskFill" is internal-only, never persisted to disk
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
  layerIndex?: number;
}

/** Build layer settings for a CutObject from a Layer (or SubLayer override) */
function buildCutLayer(layer: Layer, sub?: { mode: InternalCutMode; power: number; powerMin: number; speed: number; passes: number; powerMode: string; interval: number }): CutObject["layer"] {
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

  // Phase 1: group-aware fill coalescing.
  //
  // A fill-mode grouped non-rect object's contours must be rasterized together
  // via even-odd (maskFill) so counters (O/e holes) are left unburned.
  //
  // Key: `${layerIndex}:${groupId}` → accumulates all paths + bbox for the group.
  // Keyed on the LEAF groupId (the immediate parent group after flattenObjects),
  // not any outer word-group id. One coalesced CutObject is emitted per key.
  type GroupEntry = {
    paths: CutObject["paths"];
    minX: number; minY: number; maxX: number; maxY: number;
    firstObj: DesignObject;
    layer: Layer;
  };
  const groupBuf = new Map<string, GroupEntry>();

  // F11: locked objects are included in G-code. Locking protects position from
  // accidental edits — it is not an exclusion from the cut job. Use the layer
  // Output toggle to exclude objects from cutting.
  let lockedCount = 0;

  for (const obj of flat) {
    if (!obj.visible) continue;
    if (obj.locked) lockedCount++;
    const layer = layers.find((l) => l.index === obj.layerIndex) || layers[0];
    if (!layer.visible || layer.output === false) continue;
    if (obj.type === "text") {
      warnings.push(`Text object "${obj.name}" skipped -- use Ctrl+Shift+C to convert to path`);
      continue;
    }
    if (obj.type === "image") continue;

    const isNonRectShape = obj.type === "ellipse" || obj.type === "path" || obj.type === "line";

    // Fill-mode non-rect shapes with a groupId → coalesce into one maskFill CutObject.
    // Rectangles keep the AABB fill path (their bbox IS the shape, no coalescing needed).
    if (layer.mode === "fill" && isNonRectShape && obj.groupId) {
      const key = `${obj.layerIndex ?? 0}:${obj.groupId}`;

      // Build this contour's sampled path
      const contourPaths: CutObject["paths"] = [];
      if (obj.points && obj.points.length >= 2) {
        contourPaths.push({
          points: sampleBezierPath(obj.points, obj.closed || false),
          closed: obj.closed || false,
        });
      }

      const { x, y, width, height } = obj.transform;
      const x2 = x + width;
      const y2 = y + height;

      if (groupBuf.has(key)) {
        const entry = groupBuf.get(key)!;
        entry.paths.push(...contourPaths);
        entry.minX = Math.min(entry.minX, x);
        entry.minY = Math.min(entry.minY, y);
        entry.maxX = Math.max(entry.maxX, x2);
        entry.maxY = Math.max(entry.maxY, y2);
      } else {
        groupBuf.set(key, {
          paths: [...contourPaths],
          minX: x, minY: y, maxX: x2, maxY: y2,
          firstObj: obj,
          layer,
        });
      }
      continue; // will be emitted after the loop as a coalesced CutObject
    }

    // All other objects (line mode, fill+rect, ungrouped fill non-rect) emit normally.
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

    // Phase 2: ungrouped fill non-rect closed shapes route to maskFill.
    // Rectangles keep the AABB fast path (their bbox IS the shape).
    // offsetFill remains an explicit opt-in dropdown mode.
    let effectiveMode: InternalCutMode = layer.mode;
    if (layer.mode === "fill" && isNonRectShape) {
      effectiveMode = "maskFill";
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

    // F6: kerf offset for rect/ellipse in line mode — generate path points first
    if (layer.kerfOffset !== 0 && layer.mode === "line" && paths.length === 0) {
      let rectPoints: Array<{ x: number; y: number }> | null = null;
      const { x, y, width, height } = obj.transform;
      if (obj.type === "rectangle") {
        const cr = obj.cornerRadius || 0;
        if (cr <= 0) {
          // Simple 4-corner rectangle
          rectPoints = [
            { x, y },
            { x: x + width, y },
            { x: x + width, y: y + height },
            { x, y: y + height },
          ];
        } else {
          // Sample rounded rect as dense polyline (8 arcs, 16pts each)
          const steps = 16;
          const pts: Array<{ x: number; y: number }> = [];
          const r = Math.min(cr, width / 2, height / 2);
          const corners = [
            { cx: x + r, cy: y + r, startAngle: Math.PI, endAngle: Math.PI * 1.5 },
            { cx: x + width - r, cy: y + r, startAngle: Math.PI * 1.5, endAngle: Math.PI * 2 },
            { cx: x + width - r, cy: y + height - r, startAngle: 0, endAngle: Math.PI * 0.5 },
            { cx: x + r, cy: y + height - r, startAngle: Math.PI * 0.5, endAngle: Math.PI },
          ];
          for (const c of corners) {
            for (let s = 0; s <= steps; s++) {
              const angle = c.startAngle + (c.endAngle - c.startAngle) * s / steps;
              pts.push({ x: c.cx + Math.cos(angle) * r, y: c.cy + Math.sin(angle) * r });
            }
          }
          rectPoints = pts;
        }
      } else if (obj.type === "ellipse") {
        // Sample ellipse as dense polyline
        const steps = 64;
        const cx = x + width / 2, cy = y + height / 2;
        const rx = width / 2, ry = height / 2;
        const pts: Array<{ x: number; y: number }> = [];
        for (let s = 0; s < steps; s++) {
          const angle = (2 * Math.PI * s) / steps;
          pts.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
        }
        rectPoints = pts;
      }
      if (rectPoints && rectPoints.length >= 3) {
        const ring: Array<[number, number]> = rectPoints.map((p) => [p.x, p.y]);
        ring.push([ring[0][0], ring[0][1]]); // close
        const offset = offsetRingByDistance(ring, layer.kerfOffset);
        paths.push({
          points: offset.slice(0, -1).map(([px, py]) => ({ x: px, y: py })),
          closed: true,
        });
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
      layerIndex: obj.layerIndex,
    };

    const scale = obj.powerScale ?? 1.0;

    // If layer has sub-layers, emit one CutObject per sub-layer
    if (layer.subLayers && layer.subLayers.length > 0) {
      for (const sub of layer.subLayers) {
        const cl = buildCutLayer(layer, sub);
        cl.power *= scale;
        cl.powerMin *= scale;
        if (effectiveMode !== layer.mode && cl.mode === layer.mode) cl.mode = effectiveMode;
        result.push({ ...base, id: `${obj.id}_${sub.id}`, layer: cl });
      }
    } else {
      const cl = buildCutLayer(layer);
      cl.power *= scale;
      cl.powerMin *= scale;
      if (effectiveMode !== layer.mode) cl.mode = effectiveMode;
      result.push({ ...base, layer: cl });
    }
  }

  // Drain groupBuf: emit one coalesced maskFill CutObject per fill group.
  // x/y/width/height = union bbox of all contours — the Rust optimizer
  // reads CutObject.x/y/width/height for nearest-neighbor routing (gcode.rs:88),
  // so the union bbox must be correct here, not just in the mask render.
  for (const [, entry] of groupBuf) {
    const { firstObj, layer, paths: coalescedPaths, minX, minY, maxX, maxY } = entry;
    const scale = firstObj.powerScale ?? 1.0;
    const cl = buildCutLayer(layer);
    cl.power *= scale;
    cl.powerMin *= scale;
    // maskFill is internal-only; never persisted to disk (Layer.mode stays "fill")
    cl.mode = "maskFill";

    result.push({
      id: firstObj.groupId!, // keyed on groupId; uniquely identifies the compound shape
      objType: "path",
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      paths: coalescedPaths,
      cornerRadius: null,
      rotation: firstObj.transform.rotation || 0,
      priority: firstObj.priority ?? 0,
      groupId: firstObj.groupId,
      layerIndex: firstObj.layerIndex,
      layer: cl,
    });
  }

  // F11: emit info message when locked objects are present in the output
  if (lockedCount > 0) {
    console.info(
      `Note: ${lockedCount} locked object(s) included in G-code — use layer Output toggle to exclude from cut`,
    );
  }

  return { objects: result, warnings };
}

/** Exported for unit testing — do not use in production code outside this module. */
export { toCutObjects as toCutObjectsForTest };

/** Generate G-code for image objects using the dedicated Rust image pipeline */
async function generateImageGcode(sValueMax: number = 1000): Promise<GcodeResult | null> {
  const store = useStore.getState();
  // F11 parity: locked images are included in G-code (same as locked vectors).
  // Locking protects position from accidental edits; use the layer Output toggle to exclude.
  const imageObjects = store.objects.filter(
    (obj) => obj.type === "image" && obj.visible && obj.imageData,
  );

  if (imageObjects.length === 0) return null;

  let lockedImageCount = 0;
  const results: GcodeResult[] = [];
  for (const obj of imageObjects) {
    if (obj.locked) lockedImageCount++;
    const layer = store.layers.find((l) => l.index === obj.layerIndex) || store.layers[0];
    if (!layer.visible || layer.output === false) continue;
    const adj = obj.imageAdjustments || { brightness: 0, contrast: 0, gamma: 1, invert: false, removeBackground: false, bgTolerance: 20 };
    // Fix 5: apply per-object powerScale (default 1) to image engraving power
    const powerScale = obj.powerScale ?? 1;

    try {
      const result = await invoke<GcodeResult>("generate_image_gcode", {
        request: {
          imageData: obj.imageData,
          x: obj.transform.x,
          y: obj.transform.y,
          width: obj.transform.width,
          height: obj.transform.height,
          rotation: obj.transform.rotation || 0,
          scaleX: obj.transform.scaleX ?? 1,
          scaleY: obj.transform.scaleY ?? 1,
          power: layer.power * powerScale,
          powerMin: layer.powerMin * powerScale,
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
          removeBackground: adj.removeBackground ?? false,
          bgTolerance: adj.bgTolerance ?? 20,
          workspaceHeight: store.workspaceHeight,
          originTop: store.originTop,
          sValueMax,
          powerCurve: layer.powerCurve?.map((p) => [p.x, p.y] as [number, number]),
          newsprintCellSize: layer.newsprintCellSize,
          newsprintAngle: layer.newsprintAngle,
        },
      });
      results.push(result);
    } catch (e) {
      // Multi-image jobs: which image broke matters — wrap with the object
      // name. cause is set post-construction: the ErrorOptions constructor
      // argument is ES2022, above this project's ES2021 lib target.
      const wrapped = new Error(`Image "${obj.name}": ${e}`);
      (wrapped as Error & { cause?: unknown }).cause = e;
      throw wrapped;
    }
  }

  if (lockedImageCount > 0) {
    console.info(
      `Note: ${lockedImageCount} locked image(s) included in G-code — use layer Output toggle to exclude from cut`,
    );
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
    originTop: store.originTop,
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
  const adj = obj.imageAdjustments || { brightness: 0, contrast: 0, gamma: 1, invert: false, removeBackground: false, bgTolerance: 20 };

  return invoke<PreviewDitherResult>("preview_image_dither", {
    request: {
      imageData: obj.imageData,
      x: obj.transform.x,
      y: obj.transform.y,
      width: obj.transform.width,
      height: obj.transform.height,
      rotation: obj.transform.rotation || 0,
      scaleX: obj.transform.scaleX ?? 1,
      scaleY: obj.transform.scaleY ?? 1,
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
      removeBackground: adj.removeBackground ?? false,
      bgTolerance: adj.bgTolerance ?? 20,
      workspaceHeight: store.workspaceHeight,
      originTop: store.originTop,
      sValueMax: store.grblSValueMax,
      powerCurve: layer.powerCurve?.map((p) => [p.x, p.y] as [number, number]),
      newsprintCellSize: layer.newsprintCellSize,
      newsprintAngle: layer.newsprintAngle,
    },
  });
}

