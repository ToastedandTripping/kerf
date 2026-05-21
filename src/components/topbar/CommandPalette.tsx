import { useState, useEffect, useRef } from "react";
import { useStore } from "../../app/store";
import { fileOperations } from "../../lib/fileOps";
import { dialogState } from "../../app/App";

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  category: string;
  action: () => void;
}

function getCommands(): Command[] {
  const s = useStore.getState;
  return [
    // File
    { id: "file-new", label: "New Project", shortcut: "Ctrl+N", category: "File", action: () => fileOperations.newProject() },
    { id: "file-open", label: "Open Project", shortcut: "Ctrl+O", category: "File", action: () => fileOperations.openProject() },
    { id: "file-save", label: "Save", shortcut: "Ctrl+S", category: "File", action: () => fileOperations.saveProject() },
    { id: "file-saveas", label: "Save As", shortcut: "Ctrl+Shift+S", category: "File", action: () => fileOperations.saveProjectAs() },
    { id: "file-import-svg", label: "Import SVG", category: "File", action: () => fileOperations.importSvg() },
    { id: "file-import-dxf", label: "Import DXF", category: "File", action: () => fileOperations.importDxf() },
    { id: "file-import-image", label: "Import Image", category: "File", action: () => fileOperations.importImage() },
    { id: "file-export-svg", label: "Export SVG", category: "File", action: () => fileOperations.exportSvg() },
    { id: "file-export-gcode", label: "Save G-code", category: "File", action: () => fileOperations.exportGcode() },

    // Edit
    { id: "edit-undo", label: "Undo", shortcut: "Ctrl+Z", category: "Edit", action: () => s().undo() },
    { id: "edit-redo", label: "Redo", shortcut: "Ctrl+Shift+Z", category: "Edit", action: () => s().redo() },
    { id: "edit-selectall", label: "Select All", shortcut: "Ctrl+A", category: "Edit", action: () => s().setSelectedIds(s().objects.filter(o => o.visible && !o.locked).map(o => o.id)) },
    { id: "edit-invert", label: "Invert Selection", shortcut: "Ctrl+Shift+I", category: "Edit", action: () => s().invertSelection() },
    { id: "edit-duplicate", label: "Duplicate", shortcut: "Ctrl+D", category: "Edit", action: () => s().duplicateInPlace() },
    { id: "edit-delete", label: "Delete Selected", shortcut: "Del", category: "Edit", action: () => s().removeObjects(s().selectedIds) },
    { id: "edit-convert-path", label: "Convert to Path", shortcut: "Ctrl+Shift+C", category: "Edit", action: () => {
      const store = s();
      for (const id of store.selectedIds) {
        const obj = store.objects.find(o => o.id === id);
        if (obj?.type === "text") { store.convertTextToPath(id); } else { store.convertToPath(id); }
      }
    }},

    // Tools
    { id: "tool-select", label: "Select Tool", shortcut: "V", category: "Tools", action: () => s().setActiveTool("select") },
    { id: "tool-rect", label: "Rectangle Tool", shortcut: "R", category: "Tools", action: () => s().setActiveTool("rectangle") },
    { id: "tool-ellipse", label: "Ellipse Tool", shortcut: "E", category: "Tools", action: () => s().setActiveTool("ellipse") },
    { id: "tool-line", label: "Line Tool", shortcut: "L", category: "Tools", action: () => s().setActiveTool("line") },
    { id: "tool-pen", label: "Pen Tool", shortcut: "P", category: "Tools", action: () => s().setActiveTool("pen") },
    { id: "tool-text", label: "Text Tool", shortcut: "T", category: "Tools", action: () => s().setActiveTool("text") },
    { id: "tool-node", label: "Node Edit Tool", shortcut: "N", category: "Tools", action: () => s().setActiveTool("node") },

    // View
    { id: "view-grid", label: "Toggle Grid", shortcut: "G", category: "View", action: () => s().setGridVisible(!s().gridVisible) },
    { id: "view-snap", label: "Toggle Snap to Grid", category: "View", action: () => s().setSnapToGrid(!s().snapToGrid) },
    { id: "view-fit", label: "Zoom to Fit", shortcut: "Ctrl+0", category: "View", action: () => s().zoomToFitAll() },
    { id: "view-frame", label: "Frame Selection", shortcut: "Ctrl+Shift+A", category: "View", action: () => s().zoomToFitSelection() },

    // Arrange
    { id: "arr-group", label: "Group", shortcut: "Ctrl+G", category: "Arrange", action: () => s().groupSelected() },
    { id: "arr-ungroup", label: "Ungroup", shortcut: "Ctrl+U", category: "Arrange", action: () => s().ungroupSelected() },
    { id: "arr-align-left", label: "Align Left", category: "Arrange", action: () => s().alignObjects("left") },
    { id: "arr-align-right", label: "Align Right", category: "Arrange", action: () => s().alignObjects("right") },
    { id: "arr-align-top", label: "Align Top", category: "Arrange", action: () => s().alignObjects("top") },
    { id: "arr-align-bottom", label: "Align Bottom", category: "Arrange", action: () => s().alignObjects("bottom") },
    { id: "arr-align-hcenter", label: "Align H-Center", category: "Arrange", action: () => s().alignObjects("hcenter") },
    { id: "arr-align-vcenter", label: "Align V-Center", category: "Arrange", action: () => s().alignObjects("vcenter") },
    { id: "arr-dist-h", label: "Distribute Horizontal", category: "Arrange", action: () => s().distributeObjects("horizontal") },
    { id: "arr-dist-v", label: "Distribute Vertical", category: "Arrange", action: () => s().distributeObjects("vertical") },
    { id: "arr-flip-h", label: "Flip Horizontal", shortcut: "Ctrl+Shift+H", category: "Arrange", action: () => s().flipObjects("horizontal") },
    { id: "arr-flip-v", label: "Flip Vertical", category: "Arrange", action: () => s().flipObjects("vertical") },
    { id: "arr-rot90cw", label: "Rotate 90 CW", category: "Arrange", action: () => s().rotate90("cw") },
    { id: "arr-rot90ccw", label: "Rotate 90 CCW", category: "Arrange", action: () => s().rotate90("ccw") },
    { id: "arr-front", label: "Bring to Front", shortcut: "Ctrl+PgUp", category: "Arrange", action: () => { for (const id of s().selectedIds) s().moveObjectToFront(id); } },
    { id: "arr-back", label: "Send to Back", shortcut: "Ctrl+PgDn", category: "Arrange", action: () => { for (const id of [...s().selectedIds].reverse()) s().moveObjectToBack(id); } },
    { id: "arr-lock", label: "Lock Selected", category: "Arrange", action: () => { for (const id of s().selectedIds) s().updateObject(id, { locked: true }); s().clearSelection(); } },

    // Boolean / Tools
    { id: "bool-union", label: "Boolean Union", category: "Tools", action: () => s().booleanUnion() },
    { id: "bool-diff", label: "Boolean Difference", category: "Tools", action: () => s().booleanDifference() },
    { id: "bool-intersect", label: "Boolean Intersection", category: "Tools", action: () => s().booleanIntersection() },
    { id: "bool-xor", label: "Boolean XOR", category: "Tools", action: () => s().booleanXor() },
    { id: "tool-offset-out", label: "Offset Outward (+1mm)", category: "Tools", action: () => s().offsetPaths(1) },
    { id: "tool-offset-in", label: "Offset Inward (-1mm)", category: "Tools", action: () => s().offsetPaths(-1) },
    { id: "tool-qrcode", label: "QR Code Generator", category: "Tools", action: () => dialogState.openQrCode() },
    { id: "tool-grbl", label: "Machine Settings", category: "Tools", action: () => dialogState.openGrblSettings() },
    { id: "tool-settings", label: "Preferences", category: "Tools", action: () => dialogState.openSettings() },
    { id: "tool-notes", label: "Project Notes", category: "Tools", action: () => dialogState.openProjectNotes() },
    { id: "tool-variable-text", label: "Variable Text", category: "Tools", action: () => dialogState.openVariableText() },
    { id: "tool-auto-nest", label: "Auto-Nest", category: "Tools", action: () => dialogState.openNesting() },
  ];
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Listen for Ctrl+K / Cmd+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
        setQuery("");
        setSelectedIndex(0);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const commands = getCommands();
  const filtered = query.length === 0
    ? commands
    : commands.filter((c) => {
        const q = query.toLowerCase();
        return c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q);
      });

  const handleSelect = (cmd: Command) => {
    setOpen(false);
    cmd.action();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIndex]) handleSelect(filtered[selectedIndex]);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={() => setOpen(false)}
        style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 9999,
        }}
      />
      {/* Palette */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        style={{
          position: "fixed",
          top: "20%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "480px",
          maxHeight: "400px",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-modal)",
          zIndex: 10000,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Search input */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <span id="command-palette-title" className="sr-only" style={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0,0,0,0)" }}>Command Palette</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Search commands..."
            style={{
              width: "100%",
              background: "none",
              border: "none",
              color: "var(--text-primary)",
              fontSize: "14px",
            }}
          />
        </div>

        {/* Results */}
        <div style={{ overflow: "auto", maxHeight: "320px" }}>
          {filtered.length === 0 && (
            <div style={{ padding: "16px", color: "var(--text-muted)", textAlign: "center", fontSize: "13px" }}>
              No matching commands
            </div>
          )}
          {filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              onClick={() => handleSelect(cmd)}
              onMouseEnter={() => setSelectedIndex(i)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 16px",
                cursor: "pointer",
                background: i === selectedIndex ? "var(--bg-hover)" : "transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{
                  fontSize: "9px", color: "var(--text-muted)", minWidth: "48px",
                  textTransform: "uppercase", letterSpacing: "0.3px",
                }}>
                  {cmd.category}
                </span>
                <span style={{ fontSize: "13px", color: "var(--text-primary)" }}>{cmd.label}</span>
              </div>
              {cmd.shortcut && (
                <span style={{
                  fontSize: "11px", color: "var(--text-muted)",
                  background: "var(--bg-input)", padding: "2px 6px",
                  borderRadius: "3px", fontFamily: "var(--font-mono)",
                }}>
                  {cmd.shortcut}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
