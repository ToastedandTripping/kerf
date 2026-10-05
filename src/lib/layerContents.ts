/**
 * layerContents — what each layer holds, read-only and PURE.
 *
 * Every question is answered over composedLeaves (the same recursion
 * gcodeGen's flattenObjects uses), so a grouped or nested image counts for
 * the layer its leaf names. A leaf's own `visible` flag is not consulted:
 * a hidden image is still an image on that layer. Nothing here writes the
 * store or decides what is generated; it only describes the design.
 */
import type { DesignObject, Layer } from "../app/types";
import { composedLeaves } from "./geometry";

/** Every leaf of every top-level object, groups expanded. */
export function layerLeaves(objects: ReadonlyArray<DesignObject>): DesignObject[] {
  return objects.flatMap((o) => composedLeaves(o).map((l) => l.obj));
}

/** True when any leaf on `layerIndex` is an image. */
export function layerHasImage(layerIndex: number, objects: ReadonlyArray<DesignObject>): boolean {
  return layerLeaves(objects).some((o) => o.layerIndex === layerIndex && o.type === "image");
}

/** True when any leaf sits on `layerIndex`. */
export function layerHasObjects(layerIndex: number, objects: ReadonlyArray<DesignObject>): boolean {
  return layerLeaves(objects).some((o) => o.layerIndex === layerIndex);
}

export type ExclusionReason = "output off" | "hidden";

export interface ExcludedLayer {
  name: string;
  reason: ExclusionReason;
}

/**
 * Layers that hold at least one leaf and that the generator skips: output off
 * (gcodeGen.ts:288, :687 skip `!layer.visible || layer.output === false`) or hidden. Empty
 * layers are ignored. Output off is reported first when both apply, since
 * that is the deliberate exclusion. Layer order is preserved.
 */
export function excludedLayers(
  layers: ReadonlyArray<Layer>,
  objects: ReadonlyArray<DesignObject>
): ExcludedLayer[] {
  const used = new Set(layerLeaves(objects).map((o) => o.layerIndex));
  const out: ExcludedLayer[] = [];
  for (const l of layers) {
    if (!used.has(l.index)) continue;
    if (l.output === false) out.push({ name: l.name, reason: "output off" });
    else if (!l.visible) out.push({ name: l.name, reason: "hidden" });
  }
  return out;
}
