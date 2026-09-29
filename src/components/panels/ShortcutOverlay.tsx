import { useEffect } from "react";
import { useStore } from "../../app/store";

const SHORTCUT_GROUPS = [
  {
    title: "File",
    shortcuts: [
      { keys: "Ctrl+N", action: "New project" },
      { keys: "Ctrl+O", action: "Open file" },
      { keys: "Ctrl+S", action: "Save" },
      { keys: "Ctrl+Shift+S", action: "Save as" },
    ],
  },
  {
    title: "Tools",
    shortcuts: [
      { keys: "V", action: "Select" },
      { keys: "R", action: "Rectangle" },
      { keys: "E", action: "Ellipse" },
      { keys: "L", action: "Line" },
      { keys: "P", action: "Pen" },
      { keys: "T", action: "Text" },
      { keys: "N", action: "Node edit" },
      { keys: "M", action: "Measure" },
      { keys: "H", action: "Pan" },
    ],
  },
  {
    title: "Edit",
    shortcuts: [
      { keys: "Ctrl+Z", action: "Undo" },
      { keys: "Ctrl+Shift+Z", action: "Redo" },
      { keys: "Ctrl+C / X / V", action: "Copy / Cut / Paste" },
      { keys: "Alt+V", action: "Paste in place" },
      { keys: "Ctrl+D", action: "Duplicate" },
      { keys: "Del", action: "Delete" },
      { keys: "Ctrl+G", action: "Group" },
      { keys: "Ctrl+U", action: "Ungroup" },
      { keys: "Ctrl+Shift+C", action: "Convert to path" },
    ],
  },
  {
    title: "Selection",
    shortcuts: [
      { keys: "Ctrl+A", action: "Select all" },
      { keys: "Ctrl+Shift+I", action: "Invert selection" },
      { keys: "Tab / Shift+Tab", action: "Cycle objects" },
      { keys: "Esc", action: "Deselect" },
    ],
  },
  {
    title: "Layers",
    shortcuts: [{ keys: "1-6", action: "Assign selection to layer" }],
  },
  {
    title: "Transform",
    shortcuts: [
      { keys: "Arrow keys", action: "Nudge 1mm" },
      { keys: "Shift+Arrow", action: "Nudge 10mm" },
      { keys: "] / [", action: "Rotate 90 CW/CCW" },
      { keys: "Ctrl+Shift+H", action: "Flip horizontal" },
      { keys: "Ctrl+Shift+V", action: "Flip vertical" },
      { keys: "PgUp / PgDn", action: "Z-order up/down" },
      { keys: "Ctrl+PgUp/Dn", action: "Z-order front/back" },
    ],
  },
  {
    title: "Align",
    shortcuts: [{ keys: "Ctrl+Shift+Arrow", action: "Align left/right/top/bottom" }],
  },
  {
    title: "View",
    shortcuts: [
      { keys: "Ctrl++ / Ctrl+-", action: "Zoom in / out" },
      { keys: "Ctrl+0", action: "Zoom to fit all" },
      { keys: "Ctrl+Shift+A", action: "Zoom to selection" },
      { keys: "Space+drag", action: "Pan" },
      { keys: "G", action: "Toggle grid" },
      { keys: "S", action: "Toggle snap" },
    ],
  },
];

export function ShortcutOverlay() {
  // Open state lives in the store's openDialogs (so Help > Keyboard Shortcuts can open it).
  const visible = useStore((s) => s.openDialogs.has("shortcuts"));

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const s = useStore.getState();
      const isOpen = s.openDialogs.has("shortcuts");
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        if (isOpen) s.closeDialog("shortcuts");
        else s.openDialog("shortcuts");
      }
      if (e.key === "Escape" && isOpen) {
        s.closeDialog("shortcuts");
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (!visible) return null;

  return (
    <>
      <div
        onClick={() => useStore.getState().closeDialog("shortcuts")}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.6)",
          zIndex: 99998,
          backdropFilter: "blur(2px)",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-overlay-title"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-modal)",
          zIndex: 99999,
          padding: "24px 32px",
          maxHeight: "80vh",
          overflow: "auto",
          maxWidth: "720px",
          width: "90vw",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "20px",
          }}
        >
          <h2
            id="shortcut-overlay-title"
            style={{ margin: 0, fontSize: "16px", color: "var(--text-primary)", fontWeight: 600 }}
          >
            Keyboard Shortcuts
          </h2>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>Press ? to close</span>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "20px",
          }}
        >
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title}>
              <h3
                style={{
                  margin: "0 0 8px 0",
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                {group.title}
              </h3>
              {group.shortcuts.map((s, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "3px 0",
                    fontSize: "12px",
                  }}
                >
                  <span style={{ color: "var(--text-secondary)" }}>{s.action}</span>
                  <kbd
                    style={{
                      background: "var(--bg-input)",
                      border: "1px solid var(--border)",
                      borderRadius: "3px",
                      padding: "1px 6px",
                      fontSize: "10px",
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-primary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.keys}
                  </kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
