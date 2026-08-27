/**
 * storeHelpers.ts — pure state-patch helpers shared by index.ts and geometryActions.ts.
 *
 * Lives in a leaf module so both files can import it without creating an import cycle
 * (index.ts → geometryActions.ts would close if geometryActions imported from index.ts).
 *
 * Rules:
 * - No imports from index.ts or geometryActions.ts (leaf, no back-edges)
 * - applyObjects bundle MUST include isDirty:true (every mutation site does)
 * - applyObjects SETS gcodeStale (when gcodeResult !== null) whenever it writes
 *   an objects array (F15 — this REVERSES the old "MUST NOT touch gcodeStale"
 *   rule, which was the staleness side-door: generate → group/ungroup → START
 *   cut the pre-group design through a green gate). Returning a state-function
 *   makes the rule structural: callers cannot forget it.
 * - selectedIds is OPTIONAL: callers that only reorder pass no selection
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
 * Canonical mutation bundle, as a state-function for zustand `set`.
 * Always writes objects + objectsById + isDirty, and stales G-code when a
 * result exists (every objects write invalidates generated G-code — F15).
 * Writes selectedIds + selectedSet only when selectedIds is provided.
 */
export function applyObjects(
  objects: DesignObject[],
  selectedIds?: string[]
): (state: AppState) => Partial<AppState> {
  return (state) => ({
    objects,
    objectsById: buildObjectsById(objects),
    isDirty: true,
    gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
    ...(selectedIds !== undefined ? selectionPatch(selectedIds) : {}),
  });
}
