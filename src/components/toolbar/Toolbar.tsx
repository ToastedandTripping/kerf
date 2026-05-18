import { useStore } from "../../app/store";
import type { ToolType } from "../../app/types";

const tools: { type: ToolType; label: string; shortcut: string; icon: string }[] = [
  { type: "select", label: "Select", shortcut: "V", icon: "M6 2L2 8l4 6h2L4.5 8 8 2H6z" },
  { type: "rectangle", label: "Rectangle", shortcut: "R", icon: "" },
  { type: "ellipse", label: "Ellipse", shortcut: "E", icon: "" },
  { type: "line", label: "Line", shortcut: "L", icon: "" },
  { type: "pen", label: "Pen", shortcut: "P", icon: "" },
  { type: "text", label: "Text", shortcut: "T", icon: "" },
  { type: "node", label: "Node Edit", shortcut: "N", icon: "" },
];

export function Toolbar() {
  const activeTool = useStore((s) => s.activeTool);
  const setActiveTool = useStore((s) => s.setActiveTool);

  return (
    <div
      role="toolbar"
      aria-label="Drawing tools"
      style={{
        width: "var(--toolbar-width)",
        background: "var(--bg-panel)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: "8px",
        gap: "2px",
      }}
    >
      {tools.map((tool) => (
        <ToolButton
          key={tool.type}
          tool={tool}
          active={activeTool === tool.type}
          onClick={() => setActiveTool(tool.type)}
        />
      ))}
    </div>
  );
}

function ToolButton({
  tool,
  active,
  onClick,
}: {
  tool: (typeof tools)[number];
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={`${tool.label} (${tool.shortcut})`}
      style={{
        width: "36px",
        height: "36px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        borderRadius: "var(--radius-md)",
        background: active ? "var(--accent)" : "transparent",
        color: active ? "#fff" : "var(--text-secondary)",
        cursor: "pointer",
        transition: "background 0.1s, color 0.1s",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <ToolIcon type={tool.type} />
    </button>
  );
}

function ToolIcon({ type }: { type: ToolType }) {
  const size = 18;
  const s = { width: size, height: size };

  switch (type) {
    case "select":
      return (
        <svg {...s} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 2L4 14L7.5 10.5L11 15L13 14L9.5 9.5L14 9L4 2Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "rectangle":
      return (
        <svg {...s} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="4" width="12" height="10" rx="1" />
        </svg>
      );
    case "ellipse":
      return (
        <svg {...s} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
          <ellipse cx="9" cy="9" rx="6" ry="5" />
        </svg>
      );
    case "line":
      return (
        <svg {...s} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
          <line x1="3" y1="15" x2="15" y2="3" />
          <circle cx="3" cy="15" r="1.5" fill="currentColor" />
          <circle cx="15" cy="3" r="1.5" fill="currentColor" />
        </svg>
      );
    case "pen":
      return (
        <svg {...s} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 15Q6 8 9 9Q12 10 15 3" />
          <circle cx="3" cy="15" r="1.5" fill="currentColor" />
          <circle cx="15" cy="3" r="1.5" fill="currentColor" />
        </svg>
      );
    case "text":
      return (
        <svg {...s} viewBox="0 0 18 18" fill="currentColor">
          <text x="3" y="14" fontSize="14" fontWeight="bold" fontFamily="serif">T</text>
        </svg>
      );
    case "node":
      return (
        <svg {...s} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 14Q9 2 15 14" />
          <rect x="1" y="12" width="4" height="4" fill="currentColor" />
          <rect x="13" y="12" width="4" height="4" fill="currentColor" />
          <circle cx="9" cy="5" r="2" fill="none" stroke="currentColor" />
        </svg>
      );
  }
}
