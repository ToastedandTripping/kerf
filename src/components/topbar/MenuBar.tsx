import { useStore } from "../../app/store";
import { fileOperations } from "../../lib/fileOps";
import { dialogState } from "../../app/App";

export function MenuBar() {
  const projectName = useStore((s) => s.projectName);
  const isDirty = useStore((s) => s.isDirty);

  return (
    <div
      style={{
        height: "var(--menubar-height)",
        display: "flex",
        alignItems: "center",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        padding: "0 12px",
        gap: "2px",
        WebkitAppRegion: "drag",
      } as React.CSSProperties}
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
      <MenuButton label="File" items={[
        { label: "New", shortcut: "Ctrl+N", action: fileOperations.newProject },
        { label: "Open...", shortcut: "Ctrl+O", action: fileOperations.openProject },
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
      ]} />
      <MenuButton label="Edit" items={[
        { label: "Undo", shortcut: "Ctrl+Z", action: () => useStore.getState().undo() },
        { label: "Redo", shortcut: "Ctrl+Shift+Z", action: () => useStore.getState().redo() },
        { type: "separator" },
        { label: "Cut", shortcut: "Ctrl+X", action: () => clipboardOp("cut") },
        { label: "Copy", shortcut: "Ctrl+C", action: () => clipboardOp("copy") },
        { label: "Paste", shortcut: "Ctrl+V", action: () => clipboardOp("paste") },
        { label: "Paste in Place", shortcut: "Alt+V", action: () => clipboardOp("pasteInPlace") },
        { label: "Duplicate", shortcut: "Ctrl+D", action: () => useStore.getState().duplicateInPlace() },
        { type: "separator" },
        { label: "Select All", shortcut: "Ctrl+A", action: () => {
          const s = useStore.getState();
          s.setSelectedIds(s.objects.filter(o => o.visible && !o.locked).map(o => o.id));
        }},
        { label: "Invert Selection", shortcut: "Ctrl+Shift+I", action: () => useStore.getState().invertSelection() },
        { label: "Select All in Layer", action: () => {
          const s = useStore.getState();
          s.selectByLayer(s.activeLayerIndex);
        }},
        { type: "separator" },
        { label: "Convert to Path", shortcut: "Ctrl+Shift+C", action: () => {
          const s = useStore.getState();
          for (const id of s.selectedIds) {
            const obj = s.objects.find(o => o.id === id);
            if (obj?.type === "text") { s.convertTextToPath(id); } else { s.convertToPath(id); }
          }
        }},
        { type: "separator" },
        { label: "Delete", shortcut: "Del", action: () => {
          const s = useStore.getState();
          s.withUndo("delete", () => {
            s.removeObjects(s.selectedIds);
          });
        }},
      ]} />
      <MenuButton label="View" items={[
        { label: "Toggle Grid", shortcut: "G", action: () => {
          const s = useStore.getState();
          s.setGridVisible(!s.gridVisible);
        }},
        { label: "Toggle Snap", shortcut: "S", action: () => {
          const s = useStore.getState();
          s.setSnapToGrid(!s.snapToGrid);
        }},
        { type: "separator" },
        { label: "Zoom to Fit", shortcut: "Ctrl+0", action: () => useStore.getState().zoomToFitAll() },
        { label: "Frame Selection", shortcut: "Ctrl+Shift+A", action: () => useStore.getState().zoomToFitSelection() },
        { label: "Zoom In", shortcut: "Ctrl++", action: () => {
          const s = useStore.getState();
          s.setCamera({ zoom: Math.min(50, s.camera.zoom * 1.25) });
        }},
        { label: "Zoom Out", shortcut: "Ctrl+-", action: () => {
          const s = useStore.getState();
          s.setCamera({ zoom: Math.max(0.05, s.camera.zoom / 1.25) });
        }},
      ]} />
      <MenuButton label="Arrange" items={[
        { label: "Group", shortcut: "Ctrl+G", action: () => useStore.getState().groupSelected() },
        { label: "Ungroup", shortcut: "Ctrl+U", action: () => useStore.getState().ungroupSelected() },
        { type: "separator" },
        { label: "Rotate 90 CW", action: () => useStore.getState().rotate90("cw") },
        { label: "Rotate 90 CCW", action: () => useStore.getState().rotate90("ccw") },
        { type: "separator" },
        { label: "Align Left", shortcut: "Ctrl+Shift+Left", action: () => useStore.getState().alignObjects("left") },
        { label: "Align Right", shortcut: "Ctrl+Shift+Right", action: () => useStore.getState().alignObjects("right") },
        { label: "Align Top", shortcut: "Ctrl+Shift+Up", action: () => useStore.getState().alignObjects("top") },
        { label: "Align Bottom", shortcut: "Ctrl+Shift+Down", action: () => useStore.getState().alignObjects("bottom") },
        { label: "Align H-Center", action: () => useStore.getState().alignObjects("hcenter") },
        { label: "Align V-Center", action: () => useStore.getState().alignObjects("vcenter") },
        { type: "separator" },
        { label: "Distribute H", action: () => useStore.getState().distributeObjects("horizontal") },
        { label: "Distribute V", action: () => useStore.getState().distributeObjects("vertical") },
        { type: "separator" },
        { label: "Flip Horizontal", shortcut: "Ctrl+Shift+H", action: () => useStore.getState().flipObjects("horizontal") },
        { label: "Flip Vertical", shortcut: "Ctrl+Shift+V", action: () => useStore.getState().flipObjects("vertical") },
        { type: "separator" },
        { label: "Bring Forward", shortcut: "PgUp", action: () => {
          const s = useStore.getState();
          for (const id of s.selectedIds) s.moveObjectForward(id);
        }},
        { label: "Send Backward", shortcut: "PgDn", action: () => {
          const s = useStore.getState();
          for (const id of [...s.selectedIds].reverse()) s.moveObjectBackward(id);
        }},
        { label: "Bring to Front", shortcut: "Ctrl+PgUp", action: () => {
          const s = useStore.getState();
          for (const id of s.selectedIds) s.moveObjectToFront(id);
        }},
        { label: "Send to Back", shortcut: "Ctrl+PgDn", action: () => {
          const s = useStore.getState();
          for (const id of [...s.selectedIds].reverse()) s.moveObjectToBack(id);
        }},
        { type: "separator" },
        { label: "Grid Array (3x3, 5mm)", action: () => useStore.getState().gridArray(3, 3, 5, 5) },
        { label: "Circular Array (6)", action: () => {
          const s = useStore.getState();
          if (s.selectedIds.length === 0) return;
          const obj = s.objects.find(o => o.id === s.selectedIds[0]);
          if (!obj) return;
          const r = Math.max(obj.transform.width, obj.transform.height) * 1.5;
          s.circularArray(6, r, 0);
        }},
        { type: "separator" },
        { label: "Lock Selected", action: () => {
          const s = useStore.getState();
          s.withUndo("lock", () => {
            for (const id of s.selectedIds) s.updateObject(id, { locked: true });
            s.clearSelection();
          });
        }},
        { label: "Unlock All", action: () => {
          const s = useStore.getState();
          s.withUndo("unlock", () => {
            for (const obj of s.objects) {
              if (obj.locked) s.updateObject(obj.id, { locked: false });
            }
          });
        }},
      ]} />
      <MenuButton label="Tools" items={[
        { label: "Boolean Union", action: () => useStore.getState().booleanUnion() },
        { label: "Boolean Difference", action: () => useStore.getState().booleanDifference() },
        { label: "Boolean Intersection", action: () => useStore.getState().booleanIntersection() },
        { label: "Boolean XOR", action: () => useStore.getState().booleanXor() },
        { type: "separator" },
        { label: "Offset Outward (+1mm)", action: () => useStore.getState().offsetPaths(1) },
        { label: "Offset Inward (-1mm)", action: () => useStore.getState().offsetPaths(-1) },
        { type: "separator" },
        { label: "Material Test Grid...", action: () => dialogState.openMaterialTest() },
        { type: "separator" },
        { label: "Trace Image...", action: () => {
          const s = useStore.getState();
          const selected = s.objects.filter(o => s.selectedIds.includes(o.id));
          if (selected.length === 1 && selected[0].type === "image") {
            dialogState.openImageTrace();
          } else {
            s.addConsoleLine("Select an image object to trace", "error");
          }
        }},
        { label: "QR Code Generator...", action: () => dialogState.openQrCode() },
        { type: "separator" },
        { label: "Machine Settings...", action: () => dialogState.openGrblSettings() },
        { label: "Preferences...", action: () => dialogState.openSettings() },
        { label: "Project Notes...", action: () => dialogState.openProjectNotes() },
      ]} />

      <div style={{ flex: 1 }} />
      <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
        {projectName}{isDirty ? " *" : ""}
      </span>
    </div>
  );
}

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
      const newObjects = clipboard.map((o) => ({
        ...o,
        id: `obj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        transform: { ...o.transform, x: o.transform.x + offset, y: o.transform.y + offset },
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

function MenuButton({ label, items }: { label: string; items: MenuItem[] }) {
  return (
    <div style={{ position: "relative" }} className="menu-button-wrap">
      <button
        style={{
          background: "none",
          border: "none",
          color: "var(--text-secondary)",
          padding: "4px 10px",
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
          fontSize: "13px",
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "none";
          const dropdown = e.currentTarget.nextElementSibling as HTMLElement;
          if (dropdown) dropdown.style.display = "none";
        }}
        onClick={(e) => {
          const dropdown = e.currentTarget.nextElementSibling as HTMLElement;
          if (dropdown) {
            dropdown.style.display = dropdown.style.display === "block" ? "none" : "block";
          }
        }}
      >
        {label}
      </button>
      <div
        style={{
          display: "none",
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
        onMouseEnter={(e) => (e.currentTarget.style.display = "block")}
        onMouseLeave={(e) => (e.currentTarget.style.display = "none")}
      >
        {items.map((item, i) =>
          item.type === "separator" ? (
            <div
              key={i}
              style={{
                height: "1px",
                background: "var(--border)",
                margin: "4px 0",
              }}
            />
          ) : (
            <button
              key={i}
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
              onClick={(e) => {
                item.action?.();
                const dropdown = e.currentTarget.parentElement;
                if (dropdown) (dropdown as HTMLElement).style.display = "none";
              }}
            >
              <span>{item.label}</span>
              {item.shortcut && (
                <span style={{ color: "var(--text-muted)", fontSize: "11px", marginLeft: "24px" }}>
                  {item.shortcut}
                </span>
              )}
            </button>
          )
        )}
      </div>
    </div>
  );
}
