/** Canonical display map for GRBL machine states — superset used by StatusBar and MachinePanel. */
export const MACHINE_STATE_COLORS: Record<string, string> = {
  idle: "var(--success)",
  run: "var(--accent)",
  hold: "var(--accent-warm)",
  alarm: "var(--danger)",
  check: "var(--accent)",
  door: "var(--accent-warm)",
  home: "var(--accent)",
  sleep: "var(--text-muted)",
  disconnected: "var(--text-muted)",
};

export const MACHINE_STATE_LABELS: Record<string, string> = {
  idle: "Ready",
  run: "Running",
  hold: "Paused",
  alarm: "Error",
  check: "Check Mode",
  door: "Door Open",
  home: "Homing",
  sleep: "Sleep",
  disconnected: "Disconnected",
};
