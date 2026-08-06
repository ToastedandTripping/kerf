import { useState, useEffect } from "react";
import { machineConnection } from "../../lib/machine/connection";
import { useStore } from "../../app/store";

// Standard GRBL setting descriptions
const GRBL_SETTINGS: Record<number, { label: string; unit: string }> = {
  0: { label: "Step pulse time", unit: "microseconds" },
  1: { label: "Step idle delay", unit: "milliseconds" },
  2: { label: "Step port invert mask", unit: "" },
  3: { label: "Direction port invert mask", unit: "" },
  4: { label: "Step enable invert", unit: "boolean" },
  5: { label: "Limit pins invert", unit: "boolean" },
  6: { label: "Probe pin invert", unit: "boolean" },
  10: { label: "Status report mask", unit: "" },
  11: { label: "Junction deviation", unit: "mm" },
  12: { label: "Arc tolerance", unit: "mm" },
  13: { label: "Report inches", unit: "boolean" },
  20: { label: "Soft limits", unit: "boolean" },
  21: { label: "Hard limits", unit: "boolean" },
  22: { label: "Homing cycle", unit: "boolean" },
  23: { label: "Homing direction invert mask", unit: "" },
  24: { label: "Homing feed rate", unit: "mm/min" },
  25: { label: "Homing seek rate", unit: "mm/min" },
  26: { label: "Homing debounce", unit: "milliseconds" },
  27: { label: "Homing pull-off", unit: "mm" },
  30: { label: "Max laser power (S-value max)", unit: "" },
  31: { label: "Min spindle speed", unit: "RPM" },
  32: { label: "Laser mode", unit: "boolean" },
  100: { label: "X steps/mm", unit: "steps/mm" },
  101: { label: "Y steps/mm", unit: "steps/mm" },
  102: { label: "Z steps/mm", unit: "steps/mm" },
  110: { label: "X max rate", unit: "mm/min" },
  111: { label: "Y max rate", unit: "mm/min" },
  112: { label: "Z max rate", unit: "mm/min" },
  120: { label: "X acceleration", unit: "mm/sec²" },
  121: { label: "Y acceleration", unit: "mm/sec²" },
  122: { label: "Z acceleration", unit: "mm/sec²" },
  130: { label: "X max travel", unit: "mm" },
  131: { label: "Y max travel", unit: "mm" },
  132: { label: "Z max travel", unit: "mm" },
};

interface GrblSetting {
  key: number;
  value: string;
  label: string;
  unit: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function GrblSettingsDialog({ open, onClose }: Props) {
  const [settings, setSettings] = useState<GrblSetting[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingKey, setEditingKey] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [firmware, setFirmware] = useState("");

  useEffect(() => {
    if (open) {
      loadSettings();
    }
  }, [open]);

  async function loadSettings() {
    setLoading(true);
    try {
      // Query GRBL settings
      const responses = await machineConnection.send("$$");
      const parsed: GrblSetting[] = [];
      for (const line of responses) {
        const match = line.match(/^\$(\d+)=([\d.]+)/);
        if (match) {
          const key = parseInt(match[1]);
          const info = GRBL_SETTINGS[key] || { label: `Setting $${key}`, unit: "" };
          parsed.push({ key, value: match[2], label: info.label, unit: info.unit });
        }
        // Capture firmware version
        if (line.startsWith("Grbl") || line.startsWith("[VER:")) {
          setFirmware(line);
        }
      }
      // Also query version if not already captured
      if (!firmware) {
        const verResp = await machineConnection.send("$I");
        for (const line of verResp) {
          if (line.startsWith("[VER:") || line.startsWith("Grbl")) {
            setFirmware(line);
          }
        }
      }
      parsed.sort((a, b) => a.key - b.key);
      setSettings(parsed);
    } catch (e) {
      console.error("Failed to load GRBL settings:", e);
    }
    setLoading(false);
  }

  async function saveSetting(key: number, value: string) {
    if (!/^\d+(\.\d+)?$/.test(value)) {
      setEditError("Value must be a number (digits and decimal point only)");
      return;
    }
    setEditError(null);
    await machineConnection.send(`$${key}=${value}`);
    // C4: sync store for settings Kerf uses internally so G-code stays consistent
    const store = useStore.getState();
    if (key === 30) {
      store.setGrblSValueMax(Number(value));
    } else if (key === 32) {
      store.setGrblLaserMode(Number(value) === 1);
    } else if (key === 120 || key === 121) {
      const x = key === 120 ? Number(value) : store.grblAccelX;
      const y = key === 121 ? Number(value) : store.grblAccelY;
      store.setGrblAccel(x, y);
    } else if (key === 110 || key === 111) {
      const x = key === 110 ? Number(value) : store.grblMaxFeedRateX;
      const y = key === 111 ? Number(value) : store.grblMaxFeedRateY;
      store.setGrblMaxFeedRate(x, y);
    }
    setEditingKey(null);
    // Reload settings to verify
    await loadSettings();
  }

  if (!open) return null;

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
        role="dialog"
        aria-modal="true"
        aria-labelledby="grbl-settings-dialog-title"
        style={{
        position: "fixed",
        top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        width: "560px",
        maxHeight: "70vh",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-modal)",
        zIndex: 10000,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div>
            <span id="grbl-settings-dialog-title" style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>
              GRBL Machine Settings
            </span>
            {firmware && (
              <span style={{ fontSize: "11px", color: "var(--text-muted)", marginLeft: "12px" }}>
                {firmware}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={loadSettings}
              style={{
                background: "var(--bg-input)", border: "1px solid var(--border)",
                color: "var(--text-secondary)", padding: "4px 10px",
                borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "12px",
              }}
            >
              Refresh
            </button>
            <button
              onClick={onClose}
              style={{
                background: "none", border: "none",
                color: "var(--text-muted)", cursor: "pointer", fontSize: "16px",
              }}
            >
              x
            </button>
          </div>
        </div>

        {/* Settings list */}
        <div style={{ overflow: "auto", flex: 1, padding: "8px 0" }}>
          {loading && (
            <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
              Loading settings...
            </div>
          )}
          {!loading && settings.length === 0 && (
            <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
              No settings received. Is the machine connected?
            </div>
          )}
          {settings.map((s) => (
            <div
              key={s.key}
              style={{
                display: "flex", alignItems: "center", padding: "4px 16px",
                fontSize: "13px", gap: "8px",
              }}
            >
              <span style={{ width: "40px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "11px" }}>
                ${s.key}
              </span>
              <span style={{ flex: 1, color: "var(--text-primary)" }}>{s.label}</span>
              {editingKey === s.key ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => { setEditValue(e.target.value); setEditError(null); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveSetting(s.key, editValue);
                      if (e.key === "Escape") { setEditingKey(null); setEditError(null); }
                    }}
                    onBlur={() => { setEditingKey(null); setEditError(null); }}
                    style={{
                      width: "80px", background: "var(--bg-input)",
                      border: `1px solid ${editError ? "var(--danger)" : "var(--accent-warm)"}`,
                      color: "var(--text-primary)", padding: "2px 6px",
                      borderRadius: "3px", fontSize: "12px", fontFamily: "var(--font-mono)",
                      textAlign: "right",
                    }}
                  />
                  {editError && (
                    <span style={{ fontSize: "9px", color: "var(--danger)", marginTop: "2px" }}>{editError}</span>
                  )}
                </div>
              ) : (
                <span
                  onClick={() => { setEditingKey(s.key); setEditValue(s.value); }}
                  style={{
                    width: "80px", textAlign: "right", cursor: "pointer",
                    color: "var(--text-primary)", fontFamily: "var(--font-mono)",
                    fontSize: "12px", padding: "2px 6px",
                    borderRadius: "3px", background: "var(--bg-input)",
                  }}
                  title="Click to edit"
                >
                  {s.value}
                </span>
              )}
              {s.unit && (
                <span style={{ width: "70px", color: "var(--text-muted)", fontSize: "11px" }}>
                  {s.unit}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
