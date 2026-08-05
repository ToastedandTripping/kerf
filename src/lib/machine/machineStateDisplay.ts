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

/** GRBL alarm code -> human description. Static protocol data, not UI state. */
export const GRBL_ALARM_DESCRIPTIONS: Record<string, string> = {
  "1": "Hard limit triggered",
  "2": "G-code motion target exceeds machine travel",
  "3": "Reset while in motion",
  "4": "Probe fail -- not cleared",
  "5": "Probe fail -- not contacted",
  "6": "Homing fail -- cycle not completed",
  "7": "Homing fail -- pulloff failed",
  "8": "Homing fail -- could not find limit switch",
  "9": "Homing fail -- search limit switch not found",
};
