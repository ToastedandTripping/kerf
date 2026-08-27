import { useState, useRef, useCallback } from "react";
import { useStore } from "../../app/store";
import { fileOperations } from "../../lib/fileOps";
import { getRecentFiles, clearRecentFiles } from "../../lib/recentFiles";
import { movePartial } from "../../lib/geometry";
import { MIN_ZOOM, MAX_ZOOM } from "../../lib/constants";
import { resetOnboarding } from "../panels/OnboardingOverlay";
import {
  openMaterialTest,
  openImageTrace,
  openQrCode,
  openVariableText,
  openNesting,
  openGrblSettings,
  openSettings,
  openProjectNotes,
} from "../../app/App";

function buildRecentFilesItems(): MenuItem[] {
  const recent = getRecentFiles();
  if (recent.length === 0) return [];
  const items: MenuItem[] = [{ type: "separator" }];
  for (const path of recent.slice(0, 5)) {
    const name = path.split("/").pop() || path;
    items.push({ label: name, action: () => fileOperations.openRecentFile(path) });
  }
  if (recent.length > 0) {
    items.push({ label: "Clear Recent", action: clearRecentFiles });
  }
  return items;
}

const MENU_COUNT = 6; // File, Edit, View, Arrange, Tools, Help

export function MenuBar() {
  const projectName = useStore((s) => s.projectName);
  const isDirty = useStore((s) => s.isDirty);

  // Refs for each top-level menu trigger so Arrow keys can move focus between them
  const triggerRefs = useRef<Array<HTMLButtonElement | null>>(
    Array.from({ length: MENU_COUNT }, () => null)
  );
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const focusTrigger = useCallback((index: number) => {
    const el = triggerRefs.current[index];
    if (el) el.focus();
  }, []);

  const handleMenubarKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const focused = triggerRefs.current.findIndex((el) => el === document.activeElement);
      if (focused === -1) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        const next = (focused + 1) % MENU_COUNT;
        focusTrigger(next);
        if (openIndex !== null) setOpenIndex(next);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const prev = (focused - 1 + MENU_COUNT) % MENU_COUNT;
        focusTrigger(prev);
        if (openIndex !== null) setOpenIndex(prev);
      }
    },
    [openIndex, focusTrigger]
  );

  const makeMenuProps = (index: number) => ({
    triggerRef: (el: HTMLButtonElement | null) => {
      triggerRefs.current[index] = el;
    },
    isOpen: openIndex === index,
    onOpen: () => setOpenIndex(index),
    onClose: () => setOpenIndex(null),
  });

  return (
    <div
      role="menubar"
      aria-label="Application menu"
      onKeyDown={handleMenubarKeyDown}
      style={
        {
          height: "var(--menubar-height)",
          display: "flex",
          alignItems: "center",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
          padding: "0 12px",
          gap: "2px",
          WebkitAppRegion: "drag",
        } as React.CSSProperties
      }
    >
      <span
        style={{
          fontWeight: 600,
          fontSize: "13px",
          color: "var(--accent-warm)",
          marginRight: "16px",
          letterSpacing: "0.5px",
        }}
      >
        KERF
      </span>
      <MenuButton
        label="File"
        {...makeMenuProps(0)}
        items={[
          { label: "New", shortcut: "Ctrl+N", action: fileOperations.newProject },
          { label: "Open...", shortcut: "Ctrl+O", action: fileOperations.openProject },
          ...buildRecentFilesItems(),
          { type: "separator" },
          { label: "Save", shortcut: "Ctrl+S", action: fileOperations.saveProject },
          { label: "Save As...", shortcut: "Ctrl+Shift+S", action: fileOperations.saveProjectAs },
          { type: "separator" },
          { label: "Import SVG...", action: fileOperations.importSvg },
          { label: "Import DXF...", action: fileOperations.importDxf },
          { label: "Import Image...", action: fileOperations.importImage },
          { type: "separator" },
          { label: "Export SVG...", action: fileOperations.exportSvg },
          { label: "Save G-code...", action: fileOperations.exportGcode },
        ]}
      />
      <MenuButton
        label="Edit"
        {...makeMenuProps(1)}
        items={[
          { label: "Undo", shortcut: "Ctrl+Z", action: () => useStore.getState().undo() },
          { label: "Redo", shortcut: "Ctrl+Shift+Z", action: () => useStore.getState().redo() },
          { type: "separator" },
          { label: "Cut", shortcut: "Ctrl+X", action: () => clipboardOp("cut") },
          { label: "Copy", shortcut: "Ctrl+C", action: () => clipboardOp("copy") },
          { label: "Paste", shortcut: "Ctrl+V", action: () => clipboardOp("paste") },
          { label: "Paste in Place", shortcut: "Alt+V", action: () => clipboardOp("pasteInPlace") },
          {
            label: "Duplicate",
            shortcut: "Ctrl+D",
            action: () => useStore.getState().duplicateInPlace(),
          },
          { type: "separator" },
          {
            label: "Select All",
            shortcut: "Ctrl+A",
            action: () => {
              const s = useStore.getState();
              s.setSelectedIds(s.objects.filter((o) => o.visible && !o.locked).map((o) => o.id));
            },
          },
          {
            label: "Invert Selection",
            shortcut: "Ctrl+Shift+I",
            action: () => useStore.getState().invertSelection(),
          },
          {
            label: "Select All in Layer",
            action: () => {
              const s = useStore.getState();
              s.selectByLayer(s.activeLayerIndex);
            },
          },
          { type: "separator" },
          {
            label: "Convert to Path",
            shortcut: "Ctrl+Shift+C",
            action: () => {
              const s = useStore.getState();
              for (const id of s.selectedIds) {
                const obj = s.objects.find((o) => o.id === id);
                if (obj?.type === "text") {
                  s.convertTextToPath(id);
                } else {
                  s.convertToPath(id);
                }
              }
            },
          },
          { type: "separator" },
          {
            label: "Delete",
            shortcut: "Del",
            action: () => {
              const s = useStore.getState();
              s.withUndo("delete", () => {
                s.removeObjects(s.selectedIds);
              });
            },
          },
        ]}
      />
      <MenuButton
        label="View"
        {...makeMenuProps(2)}
        items={[
          {
            label: "Toggle Grid",
            shortcut: "G",
            action: () => {
              const s = useStore.getState();
              s.setGridVisible(!s.gridVisible);
            },
          },
          {
            label: "Toggle Snap",
            shortcut: "S",
            action: () => {
              const s = useStore.getState();
              s.setSnapToGrid(!s.snapToGrid);
            },
          },
          { type: "separator" },
          {
            label: "Zoom to Fit",
            shortcut: "Ctrl+0",
            action: () => useStore.getState().zoomToFitAll(),
          },
          {
            label: "Frame Selection",
            shortcut: "Ctrl+Shift+A",
            action: () => useStore.getState().zoomToFitSelection(),
          },
          {
            label: "Zoom In",
            shortcut: "Ctrl++",
            action: () => {
              const s = useStore.getState();
              s.setCamera({ zoom: Math.min(MAX_ZOOM, s.camera.zoom * 1.25) });
            },
          },
          {
            label: "Zoom Out",
            shortcut: "Ctrl+-",
            action: () => {
              const s = useStore.getState();
              s.setCamera({ zoom: Math.max(MIN_ZOOM, s.camera.zoom / 1.25) });
            },
          },
        ]}
      />
      <MenuButton
        label="Arrange"
        {...makeMenuProps(3)}
        items={[
          { label: "Group", shortcut: "Ctrl+G", action: () => useStore.getState().groupSelected() },
          {
            label: "Ungroup",
            shortcut: "Ctrl+U",
            action: () => useStore.getState().ungroupSelected(),
          },
          { type: "separator" },
          { label: "Rotate 90 CW", action: () => useStore.getState().rotate90("cw") },
          { label: "Rotate 90 CCW", action: () => useStore.getState().rotate90("ccw") },
          { type: "separator" },
          {
            label: "Align Left",
            shortcut: "Ctrl+Shift+Left",
            action: () => useStore.getState().alignObjects("left"),
          },
          {
            label: "Align Right",
            shortcut: "Ctrl+Shift+Right",
            action: () => useStore.getState().alignObjects("right"),
          },
          {
            label: "Align Top",
            shortcut: "Ctrl+Shift+Up",
            action: () => useStore.getState().alignObjects("top"),
          },
          {
            label: "Align Bottom",
            shortcut: "Ctrl+Shift+Down",
            action: () => useStore.getState().alignObjects("bottom"),
          },
          { label: "Align H-Center", action: () => useStore.getState().alignObjects("hcenter") },
          { label: "Align V-Center", action: () => useStore.getState().alignObjects("vcenter") },
          { type: "separator" },
          {
            label: "Distribute H",
            action: () => useStore.getState().distributeObjects("horizontal"),
          },
          {
            label: "Distribute V",
            action: () => useStore.getState().distributeObjects("vertical"),
          },
          { type: "separator" },
          {
            label: "Flip Horizontal",
            shortcut: "Ctrl+Shift+H",
            action: () => useStore.getState().flipObjects("horizontal"),
          },
          {
            label: "Flip Vertical",
            shortcut: "Ctrl+Shift+V",
            action: () => useStore.getState().flipObjects("vertical"),
          },
          { type: "separator" },
          {
            label: "Bring Forward",
            shortcut: "PgUp",
            action: () => {
              const s = useStore.getState();
              for (const id of s.selectedIds) s.moveObjectForward(id);
            },
          },
          {
            label: "Send Backward",
            shortcut: "PgDn",
            action: () => {
              const s = useStore.getState();
              for (const id of [...s.selectedIds].reverse()) s.moveObjectBackward(id);
            },
          },
          {
            label: "Bring to Front",
            shortcut: "Ctrl+PgUp",
            action: () => {
              const s = useStore.getState();
              for (const id of s.selectedIds) s.moveObjectToFront(id);
            },
          },
          {
            label: "Send to Back",
            shortcut: "Ctrl+PgDn",
            action: () => {
              const s = useStore.getState();
              for (const id of [...s.selectedIds].reverse()) s.moveObjectToBack(id);
            },
          },
          { type: "separator" },
          {
            label: "Grid Array (3x3, 5mm)",
            action: () => useStore.getState().gridArray(3, 3, 5, 5),
          },
          {
            label: "Circular Array (6)",
            action: () => {
              const s = useStore.getState();
              if (s.selectedIds.length === 0) return;
              const obj = s.objects.find((o) => o.id === s.selectedIds[0]);
              if (!obj) return;
              const r = Math.max(obj.transform.width, obj.transform.height) * 1.5;
              s.circularArray(6, r, 0);
            },
          },
          { type: "separator" },
          {
            label: "Lock Selected",
            action: () => {
              const s = useStore.getState();
              s.withUndo("lock", () => {
                for (const id of s.selectedIds) s.updateObject(id, { locked: true });
                s.clearSelection();
              });
            },
          },
          {
            label: "Unlock All",
            action: () => {
              const s = useStore.getState();
              s.withUndo("unlock", () => {
                for (const obj of s.objects) {
                  if (obj.locked) s.updateObject(obj.id, { locked: false });
                }
              });
            },
          },
        ]}
      />
      <MenuButton
        label="Tools"
        {...makeMenuProps(4)}
        items={[
          { label: "Boolean Union", action: () => useStore.getState().booleanUnion() },
          { label: "Boolean Difference", action: () => useStore.getState().booleanDifference() },
          {
            label: "Boolean Intersection",
            action: () => useStore.getState().booleanIntersection(),
          },
          { label: "Boolean XOR", action: () => useStore.getState().booleanXor() },
          { type: "separator" },
          { label: "Offset Outward (+1mm)", action: () => useStore.getState().offsetPaths(1) },
          { label: "Offset Inward (-1mm)", action: () => useStore.getState().offsetPaths(-1) },
          { type: "separator" },
          { label: "Material Test Grid...", action: () => openMaterialTest() },
          { type: "separator" },
          {
            label: "Trace Image...",
            action: () => {
              const s = useStore.getState();
              const selected = s.objects.filter((o) => s.selectedIds.includes(o.id));
              if (selected.length === 1 && selected[0].type === "image") {
                openImageTrace();
              } else {
                s.addConsoleLine("Select an image object to trace", "error");
              }
            },
          },
          { label: "QR Code Generator...", action: () => openQrCode() },
          { type: "separator" },
          { label: "Variable Text...", action: () => openVariableText() },
          { label: "Auto-Nest...", action: () => openNesting() },
          { type: "separator" },
          { label: "Machine Settings...", action: () => openGrblSettings() },
          { label: "Preferences...", action: () => openSettings() },
          { label: "Project Notes...", action: () => openProjectNotes() },
        ]}
      />
      <MenuButton
        label="Help"
        {...makeMenuProps(5)}
        items={[
          {
            label: "Keyboard Shortcuts",
            shortcut: "?",
            action: () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "?" })),
          },
          { type: "separator" },
          {
            label: "Welcome Guide",
            action: () => {
              const store = useStore.getState();
              if (
                store.isDirty &&
                !confirm("You have unsaved changes. Reload to show the welcome guide?")
              )
                return;
              resetOnboarding();
              window.location.reload();
            },
          },
        ]}
      />

      <div style={{ flex: 1 }} />
      <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
        {projectName}
        {isDirty ? " *" : ""}
      </span>
    </div>
  );
}

// Test-only export — exercises the production paste/duplicate offset writer
// without driving the menu UI. Not imported by production code.
export { clipboardOp as _testClipboardOp };

function clipboardOp(op: "cut" | "copy" | "paste" | "pasteInPlace") {
  const s = useStore.getState();
  if (op === "copy" || op === "cut") {
    const selected = s.objects.filter((o) => s.selectedIds.includes(o.id));
    s.setClipboard(selected);
    if (op === "cut") {
      s.withUndo("cut", () => {
        s.removeObjects(s.selectedIds);
      });
    }
  } else if (op === "paste" || op === "pasteInPlace") {
    s.withUndo("paste", () => {
      const { clipboard, addObject } = s;
      const offset = op === "pasteInPlace" ? 0 : 10;
      // W1b: movePartial shifts path points with the offset and returns fresh
      // points arrays (clipboard objects hold live references to store points).
      const newObjects = clipboard.map((o) => ({
        ...o,
        id: `obj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ...movePartial(o, o.transform.x + offset, o.transform.y + offset),
      }));
      newObjects.forEach(addObject);
      s.setSelectedIds(newObjects.map((o) => o.id));
    });
  }
}

interface MenuItem {
  label?: string;
  shortcut?: string;
  action?: () => void;
  type?: "separator";
}

interface MenuButtonProps {
  label: string;
  items: MenuItem[];
  triggerRef: (el: HTMLButtonElement | null) => void;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}

function MenuButton({ label, items, triggerRef, isOpen, onOpen, onClose }: MenuButtonProps) {
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleClose() {
    closeTimer.current = setTimeout(() => onClose(), 100);
  }
  function cancelClose() {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function handleTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      onOpen();
    } else if (e.key === "Escape") {
      onClose();
    }
    // ArrowLeft/Right are handled by the menubar container
  }

  return (
    <div style={{ position: "relative" }} onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
      <button
        ref={triggerRef}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        style={
          {
            background: isOpen ? "var(--bg-hover)" : "none",
            border: "none",
            color: "var(--text-secondary)",
            padding: "4px 10px",
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
            fontSize: "13px",
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties
        }
        onMouseEnter={(e) => {
          if (!isOpen) e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          if (!isOpen) e.currentTarget.style.background = "none";
        }}
        onClick={() => (isOpen ? onClose() : onOpen())}
        onKeyDown={handleTriggerKeyDown}
      >
        {label}
      </button>
      {isOpen && (
        <div
          role="menu"
          aria-label={label}
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-panel)",
            minWidth: "200px",
            padding: "4px 0",
            zIndex: 1000,
          }}
        >
          {items.map((item, i) =>
            item.type === "separator" ? (
              <div
                key={i}
                role="separator"
                style={{
                  height: "1px",
                  background: "var(--border)",
                  margin: "4px 0",
                }}
              />
            ) : (
              <button
                key={i}
                role="menuitem"
                style={{
                  display: "flex",
                  width: "100%",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "none",
                  border: "none",
                  color: "var(--text-primary)",
                  padding: "6px 12px",
                  cursor: "pointer",
                  fontSize: "13px",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    onClose();
                  }
                }}
                onClick={() => {
                  item.action?.();
                  onClose();
                }}
              >
                <span>{item.label}</span>
                {item.shortcut && (
                  <span
                    style={{ color: "var(--text-muted)", fontSize: "11px", marginLeft: "24px" }}
                  >
                    {item.shortcut}
                  </span>
                )}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
