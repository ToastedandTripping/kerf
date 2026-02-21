import { useState, useEffect, useRef } from "react";
import { useStore } from "../../app/store";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ProjectNotesDialog({ open, onClose }: Props) {
  const projectNotes = useStore((s) => s.projectNotes);
  const setProjectNotes = useStore((s) => s.setProjectNotes);
  const [notes, setNotes] = useState(projectNotes);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setNotes(projectNotes);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [open, projectNotes]);

  if (!open) return null;

  function handleSave() {
    setProjectNotes(notes);
    onClose();
  }

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
      <div style={{
        position: "fixed",
        top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        width: "480px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-modal)",
        zIndex: 10000,
        padding: "20px",
      }}>
        <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "12px" }}>
          Project Notes
        </div>
        <textarea
          ref={textareaRef}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add notes about this project..."
          style={{
            width: "100%",
            height: "200px",
            background: "var(--bg-input)",
            border: "1px solid var(--border)",
            color: "var(--text-primary)",
            padding: "10px",
            borderRadius: "var(--radius-sm)",
            fontSize: "13px",
            fontFamily: "inherit",
            resize: "vertical",
            outline: "none",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "12px" }}>
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
