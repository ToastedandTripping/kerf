/**
 * storeHelpers.ts — pure state-patch helpers shared by index.ts and geometryActions.ts.
 *
 * Lives in a leaf module so both files can import it without creating an import cycle
 * (index.ts → geometryActions.ts would close if geometryActions imported from index.ts).
 *
 * Rules:
 * - No imports from index.ts or geometryActions.ts (leaf, no back-edges)
 * - applyObjects bundle MUST include isDirty:true (every mutation site does)
 * - applyObjects MUST NOT include gcodeStale (no mutation site touches it)
 * - selectedIds is OPTIONAL: callers that only reorder (z-order) pass no selection
 */
import type { DesignObject } from "../types";
import type { AppState } from "./storeTypes";

export function buildObjectsById(objects: DesignObject[]): Map<string, DesignObject> {
  const map = new Map<string, DesignObject>();
  for (const o of objects) map.set(o.id, o);
  return map;
}

export function selectionPatch(ids: string[]): { selectedIds: string[]; selectedSet: Set<string> } {
  return { selectedIds: ids, selectedSet: new Set(ids) };
}

/**
 * Canonical mutation bundle.
 * Always writes objects + objectsById + isDirty.
 * Writes selectedIds + selectedSet only when selectedIds is provided.
 */
export function applyObjects(
  objects: DesignObject[],
  selectedIds?: string[],
): Partial<AppState> {
  return {
    objects,
    objectsById: buildObjectsById(objects),
    isDirty: true,
    ...(selectedIds !== undefined ? selectionPatch(selectedIds) : {}),
  };
}
