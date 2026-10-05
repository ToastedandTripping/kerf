import type { ReactNode } from "react";
import { Chevron } from "./Chevron";

/** Collapsible panel section with a consistent header style.
 *  Extracted from App.tsx so MachinePanel (and others) can import it.
 *  Hover state mirrors LayerRow's onMouseEnter/Leave pattern (no CSS class needed).
 *  Collapse is INSTANT — no transition/animation.
 *
 *  A11y: a native <button> already carries role=button and Enter/Space
 *  activation, so this matches MachinePanel's hand-rolled header by adding
 *  aria-expanded. The chevron is decorative and hidden from the accessible
 *  name, which comes from the title and meta text.
 *
 *  `meta` is sentence-case trailing text (a unit, a count) that the caps
 *  title must not uppercase: "10 mm step" stays "mm", never "MM" (P50).
 *  The header is edge to edge, so its focus ring sits inside it (-3px, P3a). */
export function CollapsibleSection({
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  title: string;
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={open}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "none";
        }}
        style={{
          width: "100%",
          padding: "8px 12px",
          display: "flex",
          justifyContent: "flex-start",
          alignItems: "center",
          gap: "6px",
          background: "none",
          border: "none",
          borderBottom: "1px solid var(--border)",
          color: "var(--text-secondary)",
          fontSize: "var(--text-xs)",
          fontWeight: 600,
          letterSpacing: "0.5px",
          cursor: "pointer",
          textAlign: "left",
          outlineOffset: "-3px",
        }}
      >
        <Chevron open={open} />
        <span style={{ textTransform: "uppercase" }}>{title}</span>
        {meta != null && (
          <span
            style={{
              textTransform: "none",
              color: "var(--text-muted)",
              fontWeight: 400,
              letterSpacing: 0,
            }}
          >
            {meta}
          </span>
        )}
      </button>
      {open && children}
    </div>
  );
}
