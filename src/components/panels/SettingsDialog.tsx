import { useState, useRef, useEffect } from "react";
import { useStore } from "../../app/store";
import { useEscapeClose } from "../../lib/hooks/useEscapeClose";
import { useFocusTrap } from "../../lib/hooks/useFocusTrap";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: Props) {
  const workspaceWidth = useStore((s) => s.workspaceWidth);
  const workspaceHeight = useStore((s) => s.workspaceHeight);
  const gridSize = useStore((s) => s.gridSize);
  const setWorkspaceSize = useStore((s) => s.setWorkspaceSize);
  const setGridSize = useStore((s) => s.setGridSize);

  const [wWidth, setWWidth] = useState(workspaceWidth.toString());
  const [wHeight, setWHeight] = useState(workspaceHeight.toString());
  const [gSize, setGSize] = useState(gridSize.toString());

  // Re-sync local state from store whenever the dialog opens
  useEffect(() => {
    if (open) {
      setWWidth(workspaceWidth.toString());
      setWHeight(workspaceHeight.toString());
      setGSize(gridSize.toString());
    }
  }, [open, workspaceWidth, workspaceHeight, gridSize]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useEscapeClose(open, onClose);
  useFocusTrap(dialogRef, open);

  if (!open) return null;

  function handleSave() {
    const w = parseFloat(wWidth) || workspaceWidth;
    const h = parseFloat(wHeight) || workspaceHeight;
    const g = parseFloat(gSize) || gridSize;
    setWorkspaceSize(w, h);
    setGridSize(g);
    onClose();
  }

  const inputStyle: React.CSSProperties = {
    width: "80px",
    background: "var(--bg-input)",
    border: "1px solid var(--border)",
    color: "var(--text-primary)",
    padding: "4px 8px",
    borderRadius: "var(--radius-sm)",
    fontSize: "13px",
    fontFamily: "var(--font-mono)",
    textAlign: "right",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: "13px",
    color: "var(--text-primary)",
    minWidth: "140px",
  };

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 0",
    gap: "12px",
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 9999,
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        style={{
        position: "fixed",
        top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        width: "400px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-modal)",
        zIndex: 10000,
        padding: "20px",
      }}>
        <div id="settings-dialog-title" style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "16px" }}>
          Settings
        </div>

        {/* Workspace */}
        <div style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px" }}>
          Workspace
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Width</span>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <input
              value={wWidth}
              onChange={(e) => setWWidth(e.target.value)}
              style={inputStyle}
            />
            <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>mm</span>
          </div>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Height</span>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <input
              value={wHeight}
              onChange={(e) => setWHeight(e.target.value)}
              style={inputStyle}
            />
            <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>mm</span>
          </div>
        </div>

        <div style={{ height: "1px", background: "var(--border)", margin: "12px 0" }} />

        {/* Grid */}
        <div style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px" }}>
          Grid
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Grid Size</span>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <input
              value={gSize}
              onChange={(e) => setGSize(e.target.value)}
              style={inputStyle}
            />
            <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>mm</span>
          </div>
        </div>

        {/* Buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "20px" }}>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "1px solid var(--border)",
              color: "var(--text-secondary)", padding: "6px 16px",
              borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "13px",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={{
              background: "var(--accent-warm)", border: "none",
              color: "#fff", padding: "6px 16px",
              borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "13px",
            }}
          >
            Save
          </button>
        </div>
      </div>
    </>
  );
}
