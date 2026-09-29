/**
 * The one implementation of each edit command. MenuBar, CommandPalette and the
 * keyboard handler (shortcuts.ts) each make one call per command, so the three
 * surfaces cannot drift apart again. Plain functions over useStore.getState():
 * no new store actions.
 */
import { useStore } from "../app/store";
import { deepCloneObject } from "../app/store/storeTypes";
import { movePartial } from "./geometry";
import { PASTE_OFFSET_MM } from "./constants";

/** Copy the selection. With nothing selected the clipboard is left alone. */
export function copySelection() {
  const s = useStore.getState();
  if (s.selectedIds.length === 0) return;
  s.setClipboard(s.objects.filter((o) => s.selectedSet.has(o.id)));
}

/** Copy, then remove the selection as one undo step. No-op (no undo entry) when empty. */
export function cutSelection() {
  const s = useStore.getState();
  if (s.selectedIds.length === 0) return;
  copySelection();
  const ids = s.selectedIds.slice();
  s.withUndo("cut", () => s.removeObjects(ids));
}

/**
 * Paste the clipboard as independent copies: deepCloneObject gives fresh ids at
 * every depth (group children included) and fresh points arrays, and
 * movePartial shifts the points with the transform. Paste in Place uses offset 0.
 */
export function pasteClipboard(inPlace: boolean) {
  const s = useStore.getState();
  if (s.clipboard.length === 0) return;
  const d = inPlace ? 0 : PASTE_OFFSET_MM;
  s.withUndo("paste", () => {
    const newObjects = s.clipboard.map((o) => {
      const c = deepCloneObject(o);
      return { ...c, ...movePartial(c, c.transform.x + d, c.transform.y + d) };
    });
    newObjects.forEach((o) => useStore.getState().addObject(o));
    useStore.getState().setSelectedIds(newObjects.map((o) => o.id));
  });
}

export function duplicateSelection() {
  useStore.getState().duplicateInPlace();
}

export function flipSelection(axis: "horizontal" | "vertical") {
  useStore.getState().flipObjects(axis);
}
