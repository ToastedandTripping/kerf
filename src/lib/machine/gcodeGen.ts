import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../app/store";
import type { DesignObject, Layer, InternalCutMode } from "../../app/types";
import { offsetRingByDistance, composeGroupChild, sampleBezierPath } from "../geometry";
import { computeOverscan } from "./overscan";

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

/** Build layer settings for a CutObject from a Layer */
function buildCutLayer(layer: Layer): CutObject["layer"] {
  return {
    mode: layer.mode,
    power: layer.power,
    powerMin: layer.powerMin,
    speed: layer.speed,
    passes: layer.passes,
    powerMode: layer.powerMode,
    interval: layer.interval,
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


/** Build a line-mode CutObject layer for the line overlay of a fillLine layer.
 *  Uses lineOverlay settings (power/speed/etc.) but inherits all geometry-affecting
 *  fields (kerfOffset, leadIn/Out, etc.) from the parent layer. */
function buildLineOverlayCutLayer(layer: Layer): CutObject["layer"] {
  const ov = layer.lineOverlay ?? { power: 100, powerMin: 0, speed: 1200, passes: 1, powerMode: "constant" as const };
  return {
    mode: "line",
    power: ov.power,
    powerMin: ov.powerMin,
    speed: ov.speed,
    passes: ov.passes,
    powerMode: ov.powerMode,
    interval: layer.interval, // line mode ignores interval, but keep consistent
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
  // Sort by layer array position (cut sequence order).
  // Orphan objects (unknown layerIndex) are clamped to end (layers.length) rather than
  // silently sorting to position 0 (which would emit them first, potentially freeing a part
  // before engraving). One warning per generation is added for orphans.
  const layerOrder = new Map(layers.map((l, pos) => [l.index, pos]));
  const orphanIds: string[] = [];
  flat.sort((a, b) => {
    const posA = layerOrder.has(a.layerIndex) ? layerOrder.get(a.layerIndex)! : layers.length;
    const posB = layerOrder.has(b.layerIndex) ? layerOrder.get(b.layerIndex)! : layers.length;
    return posA - posB;
  });
  // Track orphans for warning
  for (const obj of flat) {
    if (!layerOrder.has(obj.layerIndex)) {
      orphanIds.push(obj.id);
    }
  }
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

    // Fill-mode (or fillLine) non-rect shapes with a groupId → coalesce into one maskFill CutObject.
    // Rectangles keep the AABB fill path (their bbox IS the shape, no coalescing needed).
    if ((layer.mode === "fill" || layer.mode === "fillLine") && isNonRectShape && obj.groupId) {
      // Use the resolved layer.index for the group key so orphan groups (unknown
      // layerIndex → resolved to layers[0] above) are keyed on the same layer
      // whose settings they actually use — not on the raw (possibly undefined)
      // layerIndex value, which would produce key "0:..." even when layers[0]
      // has a different index.
      const key = `${layer.index}:${obj.groupId}`;

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

    // Phase 2: ungrouped fill/fillLine non-rect closed shapes route to maskFill.
    // Rectangles keep the AABB fast path (their bbox IS the shape).
    // offsetFill remains an explicit opt-in dropdown mode.
    let effectiveMode: InternalCutMode = layer.mode;
    if ((layer.mode === "fill" || layer.mode === "fillLine") && isNonRectShape) {
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

    // Emit fill CutObject (or maskFill/line as determined by effectiveMode)
    const cl = buildCutLayer(layer);
    cl.power *= scale;
    cl.powerMin *= scale;
    if (effectiveMode !== layer.mode) cl.mode = effectiveMode;
    result.push({ ...base, layer: cl });

    // fillLine: also emit a line overlay CutObject for the perimeter cut.
    // Line overlay emits iff there are closed paths (independent of fill success).
    if (layer.mode === "fillLine") {
      const hasClosed = paths.some((p) => p.closed);
      if (hasClosed) {
        const overlayLayer = buildLineOverlayCutLayer(layer);
        overlayLayer.power *= scale;
        overlayLayer.powerMin *= scale;
        result.push({
          ...base,
          id: `${obj.id}_line_overlay`,
          layer: overlayLayer,
        });
      }
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
    // maskFill is internal-only; never persisted to disk (Layer.mode stays "fill"/"fillLine")
    cl.mode = "maskFill";

    const baseCoalesced = {
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
    };

    result.push({ ...baseCoalesced, layer: cl });

    // fillLine: after the maskFill, also emit a line overlay CutObject over the
    // coalesced paths. Line emits independent of fill — it is a real perimeter
    // cut the user requested. Skip only when there are no closed paths.
    if (layer.mode === "fillLine") {
      const hasClosed = coalescedPaths.some((p) => p.closed);
      if (hasClosed) {
        const overlayLayer = buildLineOverlayCutLayer(layer);
        overlayLayer.power *= scale;
        overlayLayer.powerMin *= scale;
        result.push({
          ...baseCoalesced,
          id: `${firstObj.groupId!}_line_overlay`,
          layer: overlayLayer,
        });
      }
    }
  }

  // F11: emit info message when locked objects are present in the output
  if (lockedCount > 0) {
    console.info(
      `Note: ${lockedCount} locked object(s) included in G-code — use layer Output toggle to exclude from cut`,
    );
  }

  // Orphan warning: objects with unknown layerIndex were clamped to end (emitted last).
  if (orphanIds.length > 0) {
    warnings.push(
      `${orphanIds.length} object(s) have an unknown layer and will be emitted last: ${orphanIds.slice(0, 3).join(", ")}${orphanIds.length > 3 ? "..." : ""}`,
    );
  }

  return { objects: result, warnings };
}

/** Exported for unit testing — do not use in production code outside this module. */
export { toCutObjects as toCutObjectsForTest };

/** Generate image G-code for visible output images, keyed by layer array position.
 *
 *  This replaces the old `generateImageGcode` which emitted ALL images first,
 *  ignoring their layer position. Now each image result is stored under its
 *  layer's position in the layers array so `assembleGcode` can interleave it
 *  correctly with vector fragments.
 *
 *  Preserves Fix 3 (locked images included) and Fix 5 (powerScale) unchanged.
 *
 *  Returns a Map<layerPos, GcodeResult[]> — multiple images can share a layer.
 */
async function generateImageGcodeByLayer(
  layers: Layer[],
  objects: DesignObject[],
  workspaceHeight: number,
  originTop: boolean,
  sValueMax: number,
  accelX: number = 0,
): Promise<{ byLayer: Map<number, GcodeResult[]>; lockedCount: number }> {
  const layerOrder = new Map(layers.map((l, pos) => [l.index, pos]));
  const imageObjects = objects.filter(
    (obj) => obj.type === "image" && obj.visible && obj.imageData,
  );

  const byLayer = new Map<number, GcodeResult[]>();
  let lockedCount = 0;

  for (const obj of imageObjects) {
    if (obj.locked) lockedCount++;
    const layer = layers.find((l) => l.index === obj.layerIndex) || layers[0];
    if (!layer.visible || layer.output === false) continue;

    // Orphan images with unknown layerIndex → clamp to end (layers.length)
    const layerPos = layerOrder.has(obj.layerIndex)
      ? layerOrder.get(obj.layerIndex)!
      : layers.length;

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
          overscan: computeOverscan(layer.speed, accelX),
          bidirectional: layer.bidirectional,
          scanningOffset: layer.scanningOffset,
          brightness: adj.brightness,
          contrast: adj.contrast,
          gamma: adj.gamma,
          invert: adj.invert,
          removeBackground: adj.removeBackground ?? false,
          bgTolerance: adj.bgTolerance ?? 20,
          workspaceHeight,
          originTop,
          sValueMax,
          powerCurve: layer.powerCurve?.map((p) => [p.x, p.y] as [number, number]),
          newsprintCellSize: layer.newsprintCellSize,
          newsprintAngle: layer.newsprintAngle,
        },
      });

      const existing = byLayer.get(layerPos);
      if (existing) {
        existing.push(result);
      } else {
        byLayer.set(layerPos, [result]);
      }
    } catch (e) {
      // Multi-image jobs: which image broke matters — wrap with the object
      // name. cause is set post-construction: the ErrorOptions constructor
      // argument is ES2022, above this project's ES2021 lib target.
      const wrapped = new Error(`Image "${obj.name}": ${e}`);
      (wrapped as Error & { cause?: unknown }).cause = e;
      throw wrapped;
    }
  }

  return { byLayer, lockedCount };
}

/** Sentinel strings emitted by the Rust engines to delimit preamble and footer.
 *
 *  Cross-reference: gcode_gen.rs emits "; KERF:PREAMBLE_END" after the header
 *  block and "; KERF:FOOTER_BEGIN" before the M5/G0/M2 footer.
 *  image_gcode_gen.rs emits "; KERF:PREAMBLE_END" after the preamble block.
 *  Image fragments have no footer sentinel (no M2 emitted from the image engine).
 *
 *  If either engine changes its sentinel strings, update these constants too. */
const SENTINEL_PREAMBLE_END = "; KERF:PREAMBLE_END";
const SENTINEL_FOOTER_BEGIN = "; KERF:FOOTER_BEGIN";

/** Shared line-count helper — avoids duplicating the split("\n").length pattern
 *  across assembleGcode's two return branches. */
function countLines(gcode: string): number {
  return gcode.split("\n").length;
}

/** Strip the engine-emitted preamble and footer from a G-code fragment.
 *
 *  Uses the machine-readable sentinel comments rather than allow-listing prose
 *  strings — so an engine that changes its human-readable labels doesn't
 *  silently break the assembled document.
 *
 *  Strips:
 *    - Everything from the start up to and including the PREAMBLE_END sentinel
 *    - Everything from the FOOTER_BEGIN sentinel to the end (if present)
 *
 *  Image fragments have no FOOTER_BEGIN sentinel, so only preamble is stripped. */
function stripFraming(gcode: string): string {
  const lines = gcode.split("\n");

  // Bounded sentinel search — guards against a body G-code line that
  // coincidentally equals a sentinel string silently eating body content.
  // The Rust engines own these sentinel strings and never emit them in body
  // G-code, but the bounded search makes that contract explicit and cheap.
  //
  // PREAMBLE_END must appear within the first 12 lines of any engine output;
  // FOOTER_BEGIN must appear within the last 8 lines.
  const PREAMBLE_SEARCH_LIMIT = 12;
  const FOOTER_SEARCH_LIMIT = 8;

  // Strip preamble: remove all lines up to and including PREAMBLE_END
  const preambleSearchEnd = Math.min(PREAMBLE_SEARCH_LIMIT, lines.length);
  const preambleEndIdx = lines
    .slice(0, preambleSearchEnd)
    .findIndex((l) => l.trim() === SENTINEL_PREAMBLE_END);
  const bodyStart = preambleEndIdx >= 0 ? preambleEndIdx + 1 : 0;

  // Strip footer: remove FOOTER_BEGIN and everything after.
  // Search only the tail of the file (last FOOTER_SEARCH_LIMIT lines).
  const footerSearchStart = Math.max(0, lines.length - FOOTER_SEARCH_LIMIT);
  const footerRelIdx = lines
    .slice(footerSearchStart)
    .findIndex((l) => l.trim() === SENTINEL_FOOTER_BEGIN);
  const footerBeginIdx = footerRelIdx >= 0 ? footerSearchStart + footerRelIdx : -1;
  const bodyEnd = footerBeginIdx >= 0 ? footerBeginIdx : lines.length;

  return lines.slice(bodyStart, bodyEnd).join("\n");
}

/** Assemble ordered fragments into a single G-code document.
 *
 *  LASER-SAFETY CONTRACT:
 *   - Exactly ONE preamble (G21/G90/M5/G0 X0 Y0) at the document start
 *   - Exactly ONE footer (M5/G0 X0 Y0/M2) at the document end
 *   - Exactly ONE "M5 ; laser off at layer seam" between every pair of fragments
 *   - No mid-stream M2 (fragment footers are stripped before joining)
 *
 *  Each fragment is stripped of its own preamble/footer using sentinel comments
 *  emitted by the Rust engines. This makes the JS↔Rust contract machine-readable
 *  rather than dependent on fragile prose allow-lists. */
function assembleGcode(fragments: GcodeResult[]): GcodeResult {
  if (fragments.length === 0) {
    // Should never happen in normal flow, but be safe
    const gcode =
      "G21 ; mm mode\nG90 ; absolute positioning\nM5 ; laser off\nG0 X0 Y0 ; home\nM5 ; laser off\nG0 X0 Y0 ; return home\nM2 ; program end";
    return {
      gcode,
      moves: [],
      totalDistance: 0,
      cutDistance: 0,
      travelDistance: 0,
      estimatedTimeSecs: 0,
      lineCount: countLines(gcode),
    };
  }

  // Always run the strip-and-assemble path for non-empty fragments.
  // The single-fragment fast path that returned fragments[0] as-is was removed
  // because image-only jobs produce a fragment with no M2 and no return-home —
  // the image engine never emits those. The assemble path ensures every job
  // (including image-only, single-layer) gets exactly one docPreamble + docFooter.

  // Document preamble — emitted exactly once
  const docPreamble = [
    "; Generated by Kerf",
    "G21 ; mm mode",
    "G90 ; absolute positioning",
    "M5 ; laser off",
    "G0 X0 Y0 ; home",
    "",
  ].join("\n");

  // Document footer — emitted exactly once
  const docFooter = [
    "",
    "M5 ; laser off",
    "G0 X0 Y0 ; return home",
    "M2 ; program end",
  ].join("\n");

  // Strip each fragment's preamble/footer and join with M5 seams
  const bodyParts: string[] = [];
  for (let i = 0; i < fragments.length; i++) {
    const body = stripFraming(fragments[i].gcode);
    if (i === 0) {
      bodyParts.push(body);
    } else {
      // M5 seam between fragments — laser-off between layers
      bodyParts.push("M5 ; laser off at layer seam");
      bodyParts.push(body);
    }
  }

  const gcode = docPreamble + bodyParts.join("\n") + docFooter;

  return {
    gcode,
    moves: fragments.flatMap((f) => f.moves),
    totalDistance: fragments.reduce((s, f) => s + f.totalDistance, 0),
    cutDistance: fragments.reduce((s, f) => s + f.cutDistance, 0),
    travelDistance: fragments.reduce((s, f) => s + f.travelDistance, 0),
    estimatedTimeSecs: fragments.reduce((s, f) => s + f.estimatedTimeSecs, 0),
    lineCount: countLines(gcode),
  };
}

/** Exported for unit testing — do not use in production code outside this module. */
export { stripFraming as stripFramingForTest, assembleGcode as assembleGcodeForTest };

/** Generate G-code from the current design using the Rust backend.
 *
 *  THROWS on engine failure — there is no JS fallback (deleted by decision:
 *  under Tauri the Rust engine is always present, so any failure means the
 *  REAL generator is broken; the old silent fallback lacked lead-in/out, tabs,
 *  perforation, overscan, offsetFill and scan-angle and let users run
 *  materially degraded cuts indefinitely). Callers MUST surface the error
 *  (the single caller, MachinePanel.handleGenerateGcode, logs to console and
 *  sets a status line).
 *
 *  WS2: strict layer-order for ALL operation types.
 *  The old path emitted all images first regardless of layer position.
 *  This path buckets both images and vectors by layer position and emits
 *  them in strict ascending order. Within a tie (image + vector on the same
 *  layer), images emit before the vector fragment. */
export async function generateGcode(): Promise<GcodeResult> {
  const store = useStore.getState();
  const { objects: cutObjects, warnings } = toCutObjects(store.objects, store.layers);
  const layerOrder = new Map(store.layers.map((l, pos) => [l.index, pos]));

  // Lever 3: apply v²/(2·$120) overscan to all fill/engrave/maskFill CutObjects,
  // replacing the flat layer.overscan default. Line-mode objects keep their own
  // overscan unchanged (overscan is not meaningful for line cutting).
  const accelX = store.grblAccelX;
  for (const obj of cutObjects) {
    const m = obj.layer.mode;
    if (m === "fill" || m === "fillLine" || m === "maskFill" || m === "offsetFill") {
      obj.layer.overscan = computeOverscan(obj.layer.speed, accelX);
    }
  }

  // Surface warnings for skipped objects in the console panel
  for (const w of warnings) {
    store.addConsoleLine(w, "info");
  }

  // M3 constant-power advisory
  for (const obj of cutObjects) {
    if (obj.layer.powerMode !== "variable") {
      store.addConsoleLine(
        `Layer uses constant power (M3). Laser will not reduce power during speed changes. Use variable power (M4) unless doing constant-speed through-cuts.`,
        "warning",
      );
      break; // One warning is enough
    }
  }

  // B1: $32=0 warning — connect-time grblLaserMode can go stale (user toggles
  // $32 after connecting, or machine wasn't queried). Fire at job-generation time
  // so it's current. Without $32=1: M4 is a no-op (≡M3), per-row G0 lead-ins
  // may fire the laser during rapids, and dynamic power scaling is completely
  // disabled — all three failures apply to any fill/raster job regardless of
  // power mode. Fires for any job that contains fill/raster layers.
  if (!store.grblLaserMode) {
    const hasFillLayer = cutObjects.some((obj) => {
      const m = obj.layer.mode;
      return m === "fill" || m === "fillLine" || m === "maskFill" || m === "offsetFill";
    });
    const hasImageLayer = store.objects.some(
      (obj) => obj.type === "image" && obj.visible && obj.imageData,
    );
    if (hasFillLayer || hasImageLayer) {
      store.addConsoleLine(
        "GRBL laser mode ($32) is disabled — M4 is a no-op, dynamic power scaling is off, " +
        "and the laser may fire during G0 travel on fill/raster jobs. " +
        "Use the 'Enable Laser Mode' button in the Machine panel, or run $32=1 in the console.",
        "warning",
      );
    }
  }

  // WS2: Risky-order warning — if any "line" mode layer position is less than
  // a later "fill"/"fillLine"/image layer position, warn once. A line cut frees
  // the part; engraving/filling a freed part usually misregisters.
  // fillLine layers are internally fine (fill-before-line runs within the layer).
  // The risk is strictly cross-layer: line-mode layer emitting BEFORE a fill/image layer.
  {
    // Collect positions of each output-producing layer by mode
    const lineModePositions: number[] = [];
    const engraveModePositions: number[] = [];

    for (const layer of store.layers) {
      if (!layer.visible || layer.output === false) continue;
      const pos = layerOrder.get(layer.index);
      if (pos === undefined) continue;

      // Does this layer have any objects?
      const hasVectorObjs = cutObjects.some((obj) => obj.layerIndex === layer.index);
      const hasImageObjs = store.objects.some(
        (obj) => obj.type === "image" && obj.visible && obj.imageData &&
          (store.layers.find((l) => l.index === obj.layerIndex) || store.layers[0]).index === layer.index &&
          (store.layers.find((l) => l.index === obj.layerIndex) || store.layers[0]).output !== false,
      );

      if (!hasVectorObjs && !hasImageObjs) continue;

      if (layer.mode === "line") {
        lineModePositions.push(pos);
      } else {
        // fill, fillLine, or image layer
        engraveModePositions.push(pos);
      }
    }

    // Also treat any layer position that has images as an engrave position
    // (already covered by checking layer.mode above since image layers are usually fill/engrave)

    // Warn if ANY line-mode position < ANY engrave/fill/image position
    // i.e. a cut fires before an engrave that comes after it in layer order
    const riskyOrder = lineModePositions.some((linePos) =>
      engraveModePositions.some((engravePos) => linePos < engravePos),
    );

    if (riskyOrder) {
      store.addConsoleLine(
        "Warning: a Cut/Line layer fires before an Engrave/Fill layer. " +
        "The part may be freed before engraving completes. " +
        "Drag the Engrave layer above the Cut layer to prevent this.",
        "warning",
      );
    }
  }

  const sValueMax = store.grblSValueMax;

  // Step 1: Generate image fragments keyed by layer position
  const { byLayer: imageByLayer, lockedCount: lockedImageCount } =
    await generateImageGcodeByLayer(
      store.layers,
      store.objects,
      store.workspaceHeight,
      store.originTop,
      sValueMax,
      accelX,
    );

  if (lockedImageCount > 0) {
    console.info(
      `Note: ${lockedImageCount} locked image(s) included in G-code — use layer Output toggle to exclude from cut`,
    );
  }

  // Step 2: Bucket vector CutObjects by layer position and call generate_gcode
  // once per layer-position group (A4b fill-before-line + NN already run per layer
  // by the Rust engine when it receives the per-layer subset).
  const vectorByLayer = new Map<number, CutObject[]>();
  for (const obj of cutObjects) {
    const idx = obj.layerIndex;
    const pos = (idx !== undefined && layerOrder.has(idx))
      ? layerOrder.get(idx)!
      : store.layers.length;
    const existing = vectorByLayer.get(pos);
    if (existing) {
      existing.push(obj);
    } else {
      vectorByLayer.set(pos, [obj]);
    }
  }

  // Step 3: Collect all layer positions that have content
  const allPositions = new Set<number>([
    ...imageByLayer.keys(),
    ...vectorByLayer.keys(),
  ]);
  const sortedPositions = Array.from(allPositions).sort((a, b) => a - b);

  // Step 4: Build ordered fragments list. For each layer position:
  //   - image fragments first (within the position), then vector fragment
  const fragments: GcodeResult[] = [];

  for (const pos of sortedPositions) {
    // Image fragments at this position (in object order — order already preserved)
    const imgFragments = imageByLayer.get(pos);
    if (imgFragments) {
      for (const imgResult of imgFragments) {
        fragments.push(imgResult);
      }
    }

    // Vector fragment at this position
    const vectorObjs = vectorByLayer.get(pos);
    if (vectorObjs && vectorObjs.length > 0) {
      const vectorResult = await invoke<GcodeResult>("generate_gcode", {
        objects: vectorObjs,
        workspaceHeight: store.workspaceHeight,
        sValueMax,
        startCorner: store.startCorner || "bottomLeft",
        workspaceWidth: store.workspaceWidth,
        originTop: store.originTop,
      });
      fragments.push(vectorResult);
    }
  }

  // Step 5: Assemble into single document with correct framing and M5 seams
  return assembleGcode(fragments);
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

