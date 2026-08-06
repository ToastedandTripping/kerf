import { useState } from "react";
import { useStore } from "../../app/store";
import type { MaterialPreset } from "../../app/types";

// P3-B: Validate that an object has the minimum shape of a MaterialPreset.
// Returns true only if all required fields are present and have correct types.
function isValidPreset(obj: unknown): obj is MaterialPreset {
  if (typeof obj !== "object" || obj === null) return false;
  const p = obj as Record<string, unknown>;
  return (
    typeof p.id === "string" && p.id.length > 0 &&
    typeof p.name === "string" && p.name.length > 0 &&
    typeof p.material === "string" &&
    typeof p.thickness === "string" &&
    typeof p.mode === "string" &&
    typeof p.power === "number" && Number.isFinite(p.power) &&
    typeof p.speed === "number" && Number.isFinite(p.speed) &&
    typeof p.passes === "number" && Number.isFinite(p.passes)
  );
}

// Inline preset form field style
const fieldStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
  padding: "4px 8px",
  fontSize: "11px",
  width: "100%",
  boxSizing: "border-box",
};

export function MaterialLibrary() {
  const materials = useStore((s) => s.materials);
  const layers = useStore((s) => s.layers);
  const activeLayerIndex = useStore((s) => s.activeLayerIndex);
  const updateLayer = useStore((s) => s.updateLayer);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState(false);

  // P3-B: Inline form state replaces window.prompt (no-op in Tauri webviews).
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetMaterial, setPresetMaterial] = useState("");
  const [presetThickness, setPresetThickness] = useState("");

  const grouped = materials.reduce<Record<string, MaterialPreset[]>>((acc, m) => {
    const key = `${m.material} ${m.thickness}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(m);
    return acc;
  }, {});

  const filteredGroups = Object.entries(grouped).filter(
    ([key]) => !filter || key.toLowerCase().includes(filter.toLowerCase())
  );

  function applyPreset(preset: MaterialPreset) {
    updateLayer(activeLayerIndex, {
      mode: preset.mode,
      power: preset.power,
      powerMin: preset.powerMin,
      speed: preset.speed,
      passes: preset.passes,
      airAssist: preset.airAssist,
      interval: preset.interval,
    });
  }

  // P3-B: Replaced window.prompt flow with inline form submission.
  function handleSavePreset() {
    const layer = layers[activeLayerIndex];
    if (!layer || !presetName.trim()) return;

    const preset: MaterialPreset = {
      id: `custom_${Date.now()}`,
      name: presetName.trim(),
      material: presetMaterial.trim() || "Custom",
      thickness: presetThickness.trim() || "",
      mode: layer.mode,
      power: layer.power,
      powerMin: layer.powerMin,
      speed: layer.speed,
      passes: layer.passes,
      airAssist: layer.airAssist,
      interval: layer.interval,
    };
    useStore.getState().addMaterial(preset);
    setShowSaveForm(false);
    setPresetName("");
    setPresetMaterial("");
    setPresetThickness("");
  }

  function cancelSavePreset() {
    setShowSaveForm(false);
    setPresetName("");
    setPresetMaterial("");
    setPresetThickness("");
  }

  async function exportMaterials() {
    try {
      const dialog = await import("@tauri-apps/plugin-dialog");
      const fs = await import("@tauri-apps/plugin-fs");
      const path = await dialog.save({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: "kerf-materials.json",
      });
      if (!path) return;
      const json = JSON.stringify(materials, null, 2);
      await fs.writeTextFile(typeof path === "string" ? path : String(path), json);
    } catch (e) {
      useStore.getState().addConsoleLine(`Export materials failed: ${e}`, "error");
    }
  }

  async function importMaterials() {
    try {
      const dialog = await import("@tauri-apps/plugin-dialog");
      const fs = await import("@tauri-apps/plugin-fs");
      const path = await dialog.open({
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const content = await fs.readTextFile(typeof path === "string" ? path : String(path));
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        useStore.getState().addConsoleLine("Import failed: file is not a material preset array", "error");
        return;
      }
      // P3-B: Validate each entry before importing.
      const existing = new Set(materials.map((m) => m.id));
      let imported = 0;
      let skipped = 0;
      for (const entry of parsed) {
        if (!isValidPreset(entry)) {
          skipped++;
          continue;
        }
        if (!existing.has(entry.id)) {
          useStore.getState().addMaterial(entry);
          existing.add(entry.id);
          imported++;
        }
      }
      if (skipped > 0) {
        useStore.getState().addConsoleLine(
          `Imported ${imported} preset${imported !== 1 ? "s" : ""}, skipped ${skipped} invalid entr${skipped !== 1 ? "ies" : "y"}`,
          skipped > 0 && imported === 0 ? "error" : "warning",
        );
      } else if (imported > 0) {
        useStore.getState().addConsoleLine(`Imported ${imported} preset${imported !== 1 ? "s" : ""}`, "info");
      }
    } catch (e) {
      useStore.getState().addConsoleLine(`Import materials failed: ${e}`, "error");
    }
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(!expanded); } }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label="Material library"
        style={{
          padding: "8px 12px",
          fontSize: "11px",
          fontWeight: 600,
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>
          {expanded ? "▼" : "▶"}
        </span>
        Material Library
      </div>

      {expanded && (
        <div style={{ padding: "0 8px 8px" }}>
          {/* Search */}
          <div style={{ display: "flex", gap: "4px", marginBottom: "6px" }}>
            <input
              placeholder="Search materials..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{
                flex: 1,
                background: "var(--bg-input)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-primary)",
                padding: "4px 8px",
                fontSize: "11px",
              }}
            />
            <button
              onClick={() => setShowSaveForm(true)}
              title="Save current layer settings as preset"
              style={{
                background: "var(--bg-input)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-secondary)",
                padding: "4px 8px",
                fontSize: "11px",
                cursor: "pointer",
              }}
            >
              + Save
            </button>
            <button
              onClick={exportMaterials}
              title="Export materials to JSON"
              style={{
                background: "var(--bg-input)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-secondary)",
                padding: "4px 6px",
                fontSize: "10px",
                cursor: "pointer",
              }}
            >
              Export
            </button>
            <button
              onClick={importMaterials}
              title="Import materials from JSON"
              style={{
                background: "var(--bg-input)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-secondary)",
                padding: "4px 6px",
                fontSize: "10px",
                cursor: "pointer",
              }}
            >
              Import
            </button>
          </div>

          {/* P3-B: Inline save preset form (replaces window.prompt) */}
          {showSaveForm && (
            <div style={{
              padding: "8px",
              marginBottom: "6px",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              display: "flex",
              flexDirection: "column",
              gap: "4px",
            }}>
              <input
                placeholder="Preset name (e.g. Birch Plywood 3mm Cut)"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSavePreset(); if (e.key === "Escape") cancelSavePreset(); }}
                autoFocus
                style={fieldStyle}
              />
              <input
                placeholder="Material (e.g. Plywood)"
                value={presetMaterial}
                onChange={(e) => setPresetMaterial(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSavePreset(); if (e.key === "Escape") cancelSavePreset(); }}
                style={fieldStyle}
              />
              <input
                placeholder="Thickness (e.g. 3mm)"
                value={presetThickness}
                onChange={(e) => setPresetThickness(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSavePreset(); if (e.key === "Escape") cancelSavePreset(); }}
                style={fieldStyle}
              />
              <div style={{ display: "flex", gap: "4px", justifyContent: "flex-end" }}>
                <button
                  onClick={cancelSavePreset}
                  style={{
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--text-secondary)",
                    padding: "3px 10px",
                    fontSize: "10px",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSavePreset}
                  disabled={!presetName.trim()}
                  style={{
                    background: presetName.trim() ? "var(--accent)" : "var(--bg-input)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    color: presetName.trim() ? "#fff" : "var(--text-muted)",
                    padding: "3px 10px",
                    fontSize: "10px",
                    cursor: presetName.trim() ? "pointer" : "default",
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {/* Material groups */}
          <div style={{ maxHeight: "200px", overflow: "auto" }}>
            {filteredGroups.map(([group, presets]) => (
              <div key={group} style={{ marginBottom: "4px" }}>
                <div style={{
                  fontSize: "10px", color: "var(--text-muted)",
                  padding: "3px 4px", fontWeight: 600,
                  textTransform: "uppercase", letterSpacing: "0.3px",
                }}>
                  {group}
                </div>
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => applyPreset(preset)}
                    style={{
                      display: "flex",
                      width: "100%",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: "none",
                      border: "none",
                      color: "var(--text-primary)",
                      padding: "3px 8px",
                      fontSize: "11px",
                      cursor: "pointer",
                      borderRadius: "var(--radius-sm)",
                      textAlign: "left",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                  >
                    <span>{preset.mode === "fill" ? "Engrave" : "Cut"}</span>
                    <span style={{ fontSize: "9px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                      {preset.power}% {preset.speed}mm/min x{preset.passes}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
