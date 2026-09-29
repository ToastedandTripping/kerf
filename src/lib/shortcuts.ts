import { useEffect } from "react";
import { useStore } from "../app/store";
import { fileOperations } from "./fileOps";
import { handleViewportKeyDown, switchTool } from "./tools/toolHandler";
import { FOCUSABLE_SELECTORS } from "./hooks/useFocusTrap";
import { movePartial } from "./geometry";
import { MIN_ZOOM, MAX_ZOOM } from "./constants";
import {
  copySelection,
  cutSelection,
  deleteSelection,
  pasteClipboard,
  duplicateSelection,
  flipSelection,
} from "./editCommands";
import type { ToolType } from "../app/types";

const toolShortcuts: Record<string, ToolType> = {
  v: "select",
  r: "rectangle",
  e: "ellipse",
  l: "line",
  p: "pen",
  t: "text",
  n: "node",
  m: "measure",
  h: "pan",
};

/** Hidden-but-mounted modal roots already reported (dev-only warning fires once each). */
const warnedModals = new WeakSet<Element>();

/**
 * Central focus-containment fallback for modal roots without their own trap
 * (GrblSettingsDialog is frozen and has none; MaterialTestDialog, also frozen,
 * already has one). A per-dialog
 * useFocusTrap runs first on the dialog element; if it already handled the edge
 * (defaultPrevented) this does nothing, so there is no double step. A Tab moving
 * normally between two inside elements is left to the browser.
 */
function containTab(e: KeyboardEvent, modal: Element) {
  if (e.defaultPrevented) return;
  const nodes = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)).filter(
    (n) => !n.closest("[disabled]") && n.checkVisibility?.() !== false
  );
  const active = document.activeElement;
  if (nodes.length === 0) {
    e.preventDefault();
    return;
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!active || !modal.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // A modal owns the keyboard: the canvas behind it is not the user's target.
      // Contract: every modal root carries aria-modal="true" and UNMOUNTS when closed
      // (hidden-by-CSS would kill every shortcut). ROADMAP Phase 5 ModalShell owns this.
      // `?` (ShortcutOverlay) and Ctrl+K (CommandPalette) deliberately still work over
      // other modals — they are separate listeners, not this handler. Do not "fix" that.
      const modal = document.querySelector('[aria-modal="true"]');
      if (modal) {
        // Dev-only stuck-modal detector: warn only when the modal root is mounted but
        // NOT visible (the contract breach above). A normal open dialog stays silent.
        if (
          import.meta.env.DEV &&
          modal.checkVisibility?.() === false &&
          !warnedModals.has(modal)
        ) {
          warnedModals.add(modal);
          console.warn("[shortcuts] all shortcuts suppressed by a hidden aria-modal root:", modal);
        }
        if (e.key === "Tab") containTab(e, modal);
        return;
      }

      // Tool-context key events (pen Enter/Escape, node Delete)
      if (handleViewportKeyDown(e)) return;

      // Don't handle shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }

      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt = e.altKey;
      const key = e.key.toLowerCase();

      // File operations
      if (ctrl && key === "n") {
        e.preventDefault();
        fileOperations.newProject();
        return;
      }
      if (ctrl && key === "o") {
        e.preventDefault();
        fileOperations.openProject();
        return;
      }
      if (ctrl && key === "s") {
        e.preventDefault();
        if (shift) {
          fileOperations.saveProjectAs();
        } else {
          fileOperations.saveProject();
        }
        return;
      }

      // Undo/Redo
      if (ctrl && key === "z") {
        e.preventDefault();
        if (shift) {
          useStore.getState().redo();
        } else {
          useStore.getState().undo();
        }
        return;
      }
      if (ctrl && key === "y") {
        e.preventDefault();
        useStore.getState().redo();
        return;
      }

      // Copy/Cut/Paste (shift guard: Ctrl+Shift+C is "convert to path" below)
      if (ctrl && !shift && key === "c") {
        e.preventDefault();
        copySelection();
        return;
      }
      if (ctrl && key === "x") {
        e.preventDefault();
        cutSelection();
        return;
      }
      // shift guard: Ctrl+Shift+V is "flip vertical" below
      if (ctrl && !shift && key === "v") {
        e.preventDefault();
        pasteClipboard(false);
        return;
      }

      // Paste in Place (Alt+V)
      if (alt && key === "v") {
        e.preventDefault();
        pasteClipboard(true);
        return;
      }

      // Group/Ungroup (Ctrl+G / Ctrl+U)
      if (ctrl && key === "g") {
        e.preventDefault();
        useStore.getState().groupSelected();
        return;
      }
      if (ctrl && key === "u") {
        e.preventDefault();
        useStore.getState().ungroupSelected();
        return;
      }

      // Convert to Path (Ctrl+Shift+C)
      if (ctrl && shift && key === "c") {
        e.preventDefault();
        const s = useStore.getState();
        for (const id of s.selectedIds) {
          const obj = s.objects.find((o) => o.id === id);
          if (obj?.type === "text") {
            s.convertTextToPath(id);
          } else {
            s.convertToPath(id);
          }
        }
        return;
      }

      // Duplicate in Place (Ctrl+D)
      if (ctrl && key === "d") {
        e.preventDefault();
        duplicateSelection();
        return;
      }

      // Select All (shift guard: Ctrl+Shift+A is "frame selection" below)
      if (ctrl && !shift && key === "a") {
        e.preventDefault();
        const s = useStore.getState();
        s.setSelectedIds(s.objects.filter((o) => o.visible && !o.locked).map((o) => o.id));
        return;
      }

      // Invert Selection (Ctrl+Shift+I)
      if (ctrl && shift && key === "i") {
        e.preventDefault();
        useStore.getState().invertSelection();
        return;
      }

      // Flip (Ctrl+Shift+H / Ctrl+Shift+V)
      if (ctrl && shift && key === "h") {
        e.preventDefault();
        flipSelection("horizontal");
        return;
      }
      // Lee 2026-09-22: Ctrl+Shift+V = Flip Vertical (LightBurn parity); Alt+V is Paste in Place.
      if (ctrl && shift && key === "v") {
        e.preventDefault();
        flipSelection("vertical");
        return;
      }

      // Alignment shortcuts (Ctrl+Shift+Arrow)
      if (ctrl && shift && key === "arrowleft") {
        e.preventDefault();
        useStore.getState().alignObjects("left");
        return;
      }
      if (ctrl && shift && key === "arrowright") {
        e.preventDefault();
        useStore.getState().alignObjects("right");
        return;
      }
      if (ctrl && shift && key === "arrowup") {
        e.preventDefault();
        useStore.getState().alignObjects("top");
        return;
      }
      if (ctrl && shift && key === "arrowdown") {
        e.preventDefault();
        useStore.getState().alignObjects("bottom");
        return;
      }

      // Z-order (Page Up/Down)
      if (key === "pageup") {
        e.preventDefault();
        const s = useStore.getState();
        if (ctrl) {
          for (const id of s.selectedIds) s.moveObjectToFront(id);
        } else {
          for (const id of s.selectedIds) s.moveObjectForward(id);
        }
        return;
      }
      if (key === "pagedown") {
        e.preventDefault();
        const s = useStore.getState();
        if (ctrl) {
          for (const id of [...s.selectedIds].reverse()) s.moveObjectToBack(id);
        } else {
          for (const id of [...s.selectedIds].reverse()) s.moveObjectBackward(id);
        }
        return;
      }

      // Tab - cycle through objects
      if (key === "tab") {
        e.preventDefault();
        if (shift) {
          useStore.getState().selectPrev();
        } else {
          useStore.getState().selectNext();
        }
        return;
      }

      // Delete
      if (key === "delete" || key === "backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }

      // Arrow key nudge
      if (["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key) && !ctrl) {
        e.preventDefault();
        const s = useStore.getState();
        if (s.selectedIds.length === 0) return;
        const step = shift ? 10 : 1;
        let dx = 0,
          dy = 0;
        if (key === "arrowleft") dx = -step;
        if (key === "arrowright") dx = step;
        if (key === "arrowup") dy = -step;
        if (key === "arrowdown") dy = step;

        s.withUndo("nudge", () => {
          for (const id of s.selectedIds) {
            const obj = s.objects.find((o) => o.id === id);
            if (obj) {
              // W1b: path/line points must move with the nudge
              s.updateObject(id, movePartial(obj, obj.transform.x + dx, obj.transform.y + dy));
            }
          }
        });
        return;
      }

      // Escape - deselect / switch to select tool
      if (key === "escape") {
        const s = useStore.getState();
        if (s.selectedIds.length > 0) {
          s.clearSelection();
        }
        switchTool("select");
        return;
      }

      // Layer assignment shortcuts (1-6)
      if (!ctrl && !shift && !alt && key >= "1" && key <= "6") {
        const s = useStore.getState();
        if (s.selectedIds.length > 0) {
          const layerIndex = parseInt(key) - 1;
          s.moveObjectsToLayer(s.selectedIds, layerIndex);
          return;
        }
      }

      // Snap toggle (S). Same modifier guard as the tool keys, so Shift+S does nothing.
      if (!ctrl && !shift && !alt && key === "s") {
        const s = useStore.getState();
        s.setSnapToGrid(!s.snapToGrid);
        return;
      }

      // Rotate 90 CW / CCW (] / [)
      if (!ctrl && !alt && e.key === "]") {
        useStore.getState().rotate90("cw");
        return;
      }
      if (!ctrl && !alt && e.key === "[") {
        useStore.getState().rotate90("ccw");
        return;
      }

      // Tool shortcuts (single key, no modifier)
      if (!ctrl && !shift && !alt && toolShortcuts[key]) {
        switchTool(toolShortcuts[key]);
        return;
      }

      // Grid toggle
      if (key === "g" && !ctrl) {
        const s = useStore.getState();
        s.setGridVisible(!s.gridVisible);
        return;
      }

      // Zoom shortcuts
      if (ctrl && (key === "=" || key === "+")) {
        e.preventDefault();
        const s = useStore.getState();
        s.setCamera({ zoom: Math.min(MAX_ZOOM, s.camera.zoom * 1.25) });
        return;
      }
      if (ctrl && key === "-") {
        e.preventDefault();
        const s = useStore.getState();
        s.setCamera({ zoom: Math.max(MIN_ZOOM, s.camera.zoom / 1.25) });
        return;
      }
      if (ctrl && key === "0") {
        e.preventDefault();
        useStore.getState().zoomToFitAll();
        return;
      }

      // Frame Selection (Ctrl+Shift+A)
      if (ctrl && shift && key === "a") {
        e.preventDefault();
        useStore.getState().zoomToFitSelection();
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
