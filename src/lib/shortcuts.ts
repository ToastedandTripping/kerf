import { useEffect } from "react";
import { useStore } from "../app/store";
import { fileOperations } from "./fileOps";
import { handleViewportKeyDown, handleToolChange } from "./tools/toolHandler";
import type { ToolType } from "../app/types";

const toolShortcuts: Record<string, ToolType> = {
  v: "select",
  r: "rectangle",
  e: "ellipse",
  l: "line",
  p: "pen",
  t: "text",
  n: "node",
};

export function useKeyboardShortcuts() {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Tool-context key events (pen Enter/Escape, node Delete)
      if (handleViewportKeyDown(e)) return;

      // Don't handle shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
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

      // Copy/Cut/Paste
      if (ctrl && key === "c") {
        e.preventDefault();
        const s = useStore.getState();
        s.setClipboard(s.objects.filter((o) => s.selectedIds.includes(o.id)));
        return;
      }
      if (ctrl && key === "x") {
        e.preventDefault();
        const s = useStore.getState();
        s.setClipboard(s.objects.filter((o) => s.selectedIds.includes(o.id)));
        s.withUndo("cut", () => {
          s.removeObjects(s.selectedIds);
        });
        return;
      }
      if (ctrl && key === "v") {
        e.preventDefault();
        const s = useStore.getState();
        s.withUndo("paste", () => {
          const newObjects = s.clipboard.map((o) => ({
            ...o,
            id: `obj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            transform: { ...o.transform, x: o.transform.x + 10, y: o.transform.y + 10 },
          }));
          newObjects.forEach(s.addObject);
          s.setSelectedIds(newObjects.map((o) => o.id));
        });
        return;
      }

      // Paste in Place (Alt+V)
      if (alt && key === "v") {
        e.preventDefault();
        const s = useStore.getState();
        s.withUndo("paste", () => {
          const newObjects = s.clipboard.map((o) => ({
            ...o,
            id: `obj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          }));
          newObjects.forEach(s.addObject);
          s.setSelectedIds(newObjects.map((o) => o.id));
        });
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
          const obj = s.objects.find(o => o.id === id);
          if (obj?.type === "text") { s.convertTextToPath(id); } else { s.convertToPath(id); }
        }
        return;
      }

      // Duplicate in Place (Ctrl+D)
      if (ctrl && key === "d") {
        e.preventDefault();
        useStore.getState().duplicateInPlace();
        return;
      }

      // Select All
      if (ctrl && key === "a") {
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
        useStore.getState().flipObjects("horizontal");
        return;
      }
      // Note: Ctrl+Shift+V conflicts with "paste in place" in some apps
      // but we use Alt+V for that, so this is fine

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
        const s = useStore.getState();
        const deletedObjects = s.objects.filter((o) => s.selectedIds.includes(o.id));
        const deletedIds = s.selectedIds.slice();
        s.removeObjects(deletedIds);
        s.pushCommand({
          type: "delete",
          undo: () => {
            deletedObjects.forEach((o) => useStore.getState().addObject(o));
          },
          redo: () => {
            useStore.getState().removeObjects(deletedIds);
          },
        });
        return;
      }

      // Arrow key nudge
      if (["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key) && !ctrl) {
        e.preventDefault();
        const s = useStore.getState();
        if (s.selectedIds.length === 0) return;
        const step = shift ? 10 : 1;
        let dx = 0, dy = 0;
        if (key === "arrowleft") dx = -step;
        if (key === "arrowright") dx = step;
        if (key === "arrowup") dy = -step;
        if (key === "arrowdown") dy = step;

        s.withUndo("nudge", () => {
          for (const id of s.selectedIds) {
            const obj = s.objects.find((o) => o.id === id);
            if (obj) {
              s.updateObject(id, {
                transform: {
                  ...obj.transform,
                  x: obj.transform.x + dx,
                  y: obj.transform.y + dy,
                },
              });
            }
          }
        });
        return;
      }

      // Escape - deselect / switch to select tool
      if (key === "escape") {
        const s = useStore.getState();
        const previousTool = s.activeTool;
        if (s.selectedIds.length > 0) {
          s.clearSelection();
        }
        s.setActiveTool("select");
        handleToolChange("select", previousTool);
        return;
      }

      // Layer assignment shortcuts (1-6)
      if (!ctrl && !shift && !alt && key >= "1" && key <= "6") {
        const s = useStore.getState();
        if (s.selectedIds.length > 0) {
          const layerIndex = parseInt(key) - 1;
          const layerName = s.layers[layerIndex]?.name ?? `Layer ${key}`;
          s.withUndo("layer-assign", () => {
            s.updateObjects(
              s.selectedIds.map((id) => ({ id, partial: { layerIndex } }))
            );
          });
          s.setStatusMessage(`Moved ${s.selectedIds.length} object${s.selectedIds.length > 1 ? "s" : ""} to ${layerName}`);
          return;
        }
      }

      // Tool shortcuts (single key, no modifier)
      if (!ctrl && !shift && !alt && toolShortcuts[key]) {
        const s = useStore.getState();
        const previousTool = s.activeTool;
        const newTool = toolShortcuts[key];
        s.setActiveTool(newTool);
        handleToolChange(newTool, previousTool);
        return;
      }

      // Grid toggle
      if (key === "g" && !ctrl) {
        const s = useStore.getState();
        s.setGridVisible(!s.gridVisible);
        return;
      }

      // Snap toggle
      if (key === "s" && !ctrl && !shift && !alt) {
        // 's' is already a tool shortcut - only toggle snap when not a tool key
        // Actually 's' is not in toolShortcuts, so this works
      }

      // Zoom shortcuts
      if (ctrl && (key === "=" || key === "+")) {
        e.preventDefault();
        const s = useStore.getState();
        s.setCamera({ zoom: Math.min(50, s.camera.zoom * 1.25) });
        return;
      }
      if (ctrl && key === "-") {
        e.preventDefault();
        const s = useStore.getState();
        s.setCamera({ zoom: Math.max(0.05, s.camera.zoom / 1.25) });
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
