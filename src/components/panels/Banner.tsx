import type { AriaRole, MouseEventHandler, ReactNode } from "react";

/** Presentational notice (UI polish P2). It owns no state and no handlers:
 *  each action's onClick is bound directly as its button's DOM handler, so the
 *  caller's function receives exactly the click event. It renders no ARIA role
 *  unless the caller passes one (Material Test's refusal is the only alert in
 *  its dialog, and a second would break queryByRole("alert")). */
export type BannerTone = "warning" | "danger" | "success" | "info";

export interface BannerAction {
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
}

const TONES: Record<BannerTone, { bg: string; border: string; mark: string }> = {
  warning: { bg: "var(--warning-bg)", border: "var(--warning-border)", mark: "var(--warning)" },
  danger: { bg: "var(--danger-bg)", border: "var(--danger-border)", mark: "var(--danger)" },
  success: { bg: "var(--success-bg)", border: "var(--success-border)", mark: "var(--success)" },
  info: { bg: "var(--accent-bg)", border: "var(--accent-border)", mark: "var(--accent)" },
};

export function Banner({
  tone,
  title,
  body,
  actions,
  role,
  leftRule = false,
}: {
  tone: BannerTone;
  title?: ReactNode;
  body?: ReactNode;
  actions?: BannerAction[];
  role?: AriaRole;
  leftRule?: boolean;
}) {
  const t = TONES[tone];
  return (
    <div
      role={role}
      data-tone={tone}
      style={{
        padding: "8px 10px",
        borderRadius: "var(--radius-sm)",
        background: t.bg,
        borderStyle: "solid",
        borderWidth: leftRule ? "1px 1px 1px 3px" : "1px",
        // Per-side longhands: a var() inside a shorthand is not expanded by every
        // style engine (jsdom drops it), and the test reads each side.
        borderTopColor: t.border,
        borderRightColor: t.border,
        borderBottomColor: t.border,
        borderLeftColor: leftRule ? t.mark : t.border,
        color: "var(--text-primary)",
        fontSize: "var(--text-xs)",
        lineHeight: 1.4,
      }}
    >
      {title != null && (
        <div style={{ fontWeight: 600, marginBottom: body != null ? 2 : 0 }}>{title}</div>
      )}
      {body != null && <div style={{ color: "var(--text-secondary)" }}>{body}</div>}
      {actions && actions.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={a.onClick}
              style={{
                background: "transparent",
                border: "1px solid var(--border-control)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-primary)",
                padding: "3px 10px",
                fontSize: "var(--text-xs)",
                cursor: "pointer",
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
