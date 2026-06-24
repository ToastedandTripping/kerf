/** Collapsible panel section with a consistent header style.
 *  Extracted from App.tsx so MachinePanel (and others) can import it.
 *  Hover state mirrors LayerRow's onMouseEnter/Leave pattern (no CSS class needed).
 *  Collapse is INSTANT — no transition/animation.
 */
export function CollapsibleSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
        style={{
          width: "100%",
          padding: "8px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "none",
          border: "none",
          borderBottom: "1px solid var(--border)",
          color: "var(--text-secondary)",
          fontSize: "11px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span>{title}</span>
        <span style={{ fontSize: "10px", opacity: 0.6 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && children}
    </div>
  );
}
