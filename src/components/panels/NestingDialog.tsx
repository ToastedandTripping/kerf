import { useState, useEffect, useMemo } from "react";
import { useStore } from "../../app/store";
import type { NestRotation, NestResult } from "../../app/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function NestingDialog({ open, onClose }: Props) {
  const objects = useStore((s) => s.objects);
  const selectedIds = useStore((s) => s.selectedIds);
  const nestObjects = useStore((s) => s.nestObjects);

  const [spacing, setSpacing] = useState(2);
  const [rotation, setRotation] = useState<NestRotation>("bestFit");
  const [result, setResult] = useState<NestResult | null>(null);
  const [nesting, setNesting] = useState(false);

  // Escape key dismisses dialog
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Reset result when dialog opens
  useEffect(() => {
    if (open) setResult(null);
  }, [open]);

  // Determine scope
  const scope = useMemo(() => {
    if (selectedIds.length > 0) {
      const count = objects.filter(
        (o) => selectedIds.includes(o.id) && o.visible && !o.locked
      ).length;
      return { count, label: `Nesting ${count} selected object${count !== 1 ? "s" : ""}` };
    }
    const count = objects.filter((o) => o.visible && !o.locked).length;
    return { count, label: `Nesting ${count} visible object${count !== 1 ? "s" : ""}` };
  }, [objects, selectedIds]);

  if (!open) return null;

  async function handleNest() {
    setNesting(true);
    try {
      const nestResult = await nestObjects({
        spacing,
        rotation,
        useSelection: selectedIds.length > 0,
      });
      setResult(nestResult);
    } finally {
      setNesting(false);
    }
  }

  const rotationOptions: Array<{ value: NestRotation; label: string }> = [
    { value: "none", label: "None" },
    { value: "90", label: "90° Steps" },
    { value: "bestFit", label: "Best Fit" },
  ];

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999 }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="nesting-dialog-title"
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          width: "420px", background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-modal)", zIndex: 10000,
          padding: "20px",
        }}
      >
        <div id="nesting-dialog-title" style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "16px" }}>
          Auto-Nest
        </div>

        {/* Scope display */}
        <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "16px" }}>
          {scope.label}
        </div>

        {/* Spacing control */}
        <div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: "6px" }}>
            Spacing (mm)
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <input
              type="range"
              min={0}
              max={20}
              step={0.5}
              value={spacing}
              onChange={(e) => setSpacing(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <input
              type="number"
              min={0}
              max={20}
              step={0.5}
              value={spacing}
              onChange={(e) => setSpacing(Math.max(0, Math.min(20, Number(e.target.value))))}
              style={{
                width: "56px", background: "var(--bg-input)", border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)", fontSize: "11px", padding: "3px 6px",
                color: "var(--text-primary)", textAlign: "center",
              }}
            />
          </div>
        </div>

        {/* Rotation control */}
        <div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: "6px" }}>
            Rotation
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {rotationOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setRotation(opt.value)}
                style={{
                  padding: "5px 14px", fontSize: "11px", borderRadius: "var(--radius-sm)",
                  border: rotation === opt.value ? "none" : "1px solid var(--border)",
                  background: rotation === opt.value ? "var(--accent, #4a90e2)" : "transparent",
                  color: rotation === opt.value ? "#fff" : "var(--text-secondary)",
                  fontWeight: rotation === opt.value ? 600 : 400,
                  cursor: "pointer",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Results bar */}
        {result && (
          <div style={{
            marginBottom: "16px", padding: "8px 12px",
            background: result.unplaced.length > 0 ? "rgba(230, 150, 50, 0.1)" : "rgba(80, 180, 100, 0.1)",
            border: `1px solid ${result.unplaced.length > 0 ? "rgba(230, 150, 50, 0.3)" : "rgba(80, 180, 100, 0.3)"}`,
            borderRadius: "var(--radius-sm)",
            fontSize: "12px",
            color: result.unplaced.length > 0 ? "var(--accent-warm, #e69632)" : "var(--text-primary)",
          }}>
            {result.unplaced.length > 0
              ? `Placed ${result.placed.length}/${result.placed.length + result.unplaced.length} (${result.unplaced.length} didn't fit) at ${Math.round(result.efficiency * 100)}% efficiency`
              : `Placed ${result.placed.length}/${result.placed.length} at ${Math.round(result.efficiency * 100)}% efficiency`}
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button onClick={onClose} style={{
            background: "none", border: "1px solid var(--border)",
            color: "var(--text-secondary)", padding: "6px 16px",
            borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "13px",
          }}>Cancel</button>
          <button
            onClick={handleNest}
            disabled={scope.count === 0 || nesting}
            style={{
              background: scope.count > 0 ? "var(--accent, #4a90e2)" : "var(--bg-input)",
              border: "none",
              color: scope.count > 0 ? "#fff" : "var(--text-muted)",
              padding: "6px 16px", borderRadius: "var(--radius-sm)",
              cursor: scope.count > 0 ? "pointer" : "not-allowed",
              fontSize: "13px", fontWeight: 600,
            }}
          >{nesting ? "Nesting..." : "Nest"}</button>
        </div>
      </div>
    </>
  );
}
