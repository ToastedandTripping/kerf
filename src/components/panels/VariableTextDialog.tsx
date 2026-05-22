import { useState, useMemo, useEffect } from "react";
import { useStore } from "../../app/store";
import type { VariableTextConfig, VariableDataSource, SerialConfig } from "../../app/types";
import { extractPlaceholders, generateSerialValues, hasPlaceholders, parseCsv } from "../../lib/variableText";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Mode = "serial" | "csv";

export function VariableTextDialog({ open, onClose }: Props) {
  const objects = useStore((s) => s.objects);
  const generateVariableText = useStore((s) => s.generateVariableText);
  const nestObjects = useStore((s) => s.nestObjects);

  const [mode, setMode] = useState<Mode>("serial");

  // Serial config state
  const [start, setStart] = useState(1);
  const [increment, setIncrement] = useState(1);
  const [count, setCount] = useState(10);
  const [zeroPad, setZeroPad] = useState(3);
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");

  // CSV state
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [csvFileName, setCsvFileName] = useState("");

  // Auto-nest after generation
  const [autoNest, setAutoNest] = useState(false);
  const [nestStatus, setNestStatus] = useState<string | null>(null);

  // Escape key dismisses dialog
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Find template objects (text objects with placeholders)
  const templateObjects = useMemo(
    () => objects.filter((o) => o.type === "text" && hasPlaceholders(o)),
    [objects]
  );

  // Detected placeholders from templates
  const placeholders = useMemo(() => {
    const all = new Set<string>();
    for (const obj of templateObjects) {
      if (obj.text) {
        for (const p of extractPlaceholders(obj.text)) {
          all.add(p);
        }
      }
    }
    return Array.from(all);
  }, [templateObjects]);

  // Preview of first 3 serial values
  const serialPreview = useMemo(() => {
    if (mode !== "serial") return [];
    const config: SerialConfig = { start, increment, count: Math.min(count, 3), zeroPad, prefix, suffix };
    return generateSerialValues(config);
  }, [mode, start, increment, count, zeroPad, prefix, suffix]);

  if (!open) return null;

  function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const { headers, rows } = parseCsv(text);
      setCsvHeaders(headers);
      setCsvRows(rows);
      setCsvFileName(file.name);
    };
    reader.readAsText(file);
  }

  async function handleGenerate() {
    try {
      let dataSource: VariableDataSource;
      if (mode === "serial") {
        dataSource = {
          type: "serial",
          config: { start, increment, count, zeroPad, prefix, suffix },
        };
      } else {
        dataSource = {
          type: "csv",
          headers: csvHeaders,
          rows: csvRows,
          fileName: csvFileName,
        };
      }

      const config: VariableTextConfig = {
        dataSource,
        templateObjectIds: templateObjects.map((o) => o.id),
      };

      await generateVariableText(config);

      if (autoNest) {
        const nestResult = await nestObjects({
          spacing: 2,
          rotation: "bestFit",
          useSelection: true,
        });
        setNestStatus(
          `Nested ${nestResult.placed.length}/${nestResult.placed.length + nestResult.unplaced.length} at ${Math.round(nestResult.efficiency * 100)}% efficiency`
        );
        // Brief delay so user can see the status before dialog closes
        await new Promise((r) => setTimeout(r, 1200));
      }

      onClose();
    } catch (err) {
      console.error("Variable text generation failed:", err);
      onClose();
    }
  }

  const canGenerate =
    templateObjects.length > 0 &&
    (mode === "serial" ? count > 0 : csvRows.length > 0);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999 }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="variable-text-dialog-title"
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          width: "540px", background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-modal)", zIndex: 10000,
          padding: "20px",
        }}
      >
        <div id="variable-text-dialog-title" style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "16px" }}>
          Variable Text
        </div>

        {/* Template info */}
        <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "12px" }}>
          {templateObjects.length === 0
            ? "No template objects found. Add text with {placeholder} syntax to use variable text."
            : `${templateObjects.length} template object${templateObjects.length > 1 ? "s" : ""} detected (placeholders: ${placeholders.join(", ")})`}
        </div>

        {/* Mode chips */}
        <div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: "6px" }}>
            Data Source
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {(["serial", "csv"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  padding: "5px 14px", fontSize: "11px", borderRadius: "var(--radius-sm)",
                  border: mode === m ? "none" : "1px solid var(--border)",
                  background: mode === m ? "var(--accent-warm)" : "transparent",
                  color: mode === m ? "#fff" : "var(--text-secondary)",
                  fontWeight: mode === m ? 600 : 400,
                  cursor: "pointer",
                }}
              >
                {m === "serial" ? "Serial Numbers" : "CSV Data"}
              </button>
            ))}
          </div>
        </div>

        {/* Serial mode */}
        {mode === "serial" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px", marginBottom: "16px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase" }}>Start</span>
              <input
                type="number" value={start} onChange={(e) => setStart(Number(e.target.value))}
                style={{ background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "11px", padding: "3px 6px", color: "var(--text-primary)" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase" }}>Increment</span>
              <input
                type="number" value={increment} onChange={(e) => setIncrement(Number(e.target.value))}
                style={{ background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "11px", padding: "3px 6px", color: "var(--text-primary)" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase" }}>Count</span>
              <input
                type="number" value={count} min={1} max={9999} onChange={(e) => setCount(Number(e.target.value))}
                style={{ background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "11px", padding: "3px 6px", color: "var(--text-primary)" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase" }}>Zero Pad</span>
              <input
                type="number" value={zeroPad} min={0} max={10} onChange={(e) => setZeroPad(Number(e.target.value))}
                style={{ background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "11px", padding: "3px 6px", color: "var(--text-primary)" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase" }}>Prefix</span>
              <input
                type="text" value={prefix} onChange={(e) => setPrefix(e.target.value)}
                style={{ background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "11px", padding: "3px 6px", color: "var(--text-primary)" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase" }}>Suffix</span>
              <input
                type="text" value={suffix} onChange={(e) => setSuffix(e.target.value)}
                style={{ background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "11px", padding: "3px 6px", color: "var(--text-primary)" }}
              />
            </label>
          </div>
        )}

        {/* CSV mode */}
        {mode === "csv" && (
          <div style={{ marginBottom: "16px" }}>
            <input
              type="file"
              accept=".csv,.txt"
              onChange={handleCsvUpload}
              style={{ fontSize: "11px", color: "var(--text-secondary)", marginBottom: "8px" }}
            />
            {csvHeaders.length > 0 && (
              <div style={{
                background: "var(--bg-input)", border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)", padding: "8px", maxHeight: "120px", overflow: "auto",
              }}>
                <div style={{ fontSize: "10px", color: "var(--text-muted)", marginBottom: "4px" }}>
                  {csvFileName} -- {csvRows.length} rows, {csvHeaders.length} columns
                </div>
                <table style={{ width: "100%", fontSize: "10px", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {csvHeaders.map((h, i) => (
                        <th key={i} style={{ textAlign: "left", padding: "2px 4px", color: "var(--text-secondary)", borderBottom: "1px solid var(--border)" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {csvRows.slice(0, 5).map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td key={ci} style={{ padding: "2px 4px", color: "var(--text-primary)" }}>
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {csvRows.length > 5 && (
                  <div style={{ fontSize: "10px", color: "var(--text-muted)", marginTop: "4px" }}>
                    ... and {csvRows.length - 5} more rows
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Preview */}
        {mode === "serial" && serialPreview.length > 0 && (
          <div style={{ marginBottom: "16px" }}>
            <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: "4px" }}>
              Preview
            </div>
            <div style={{ fontSize: "11px", color: "var(--text-primary)", fontFamily: "monospace" }}>
              {serialPreview.join(", ")}{count > 3 ? `, ... (${count} total)` : ""}
            </div>
          </div>
        )}

        {/* Auto-nest option */}
        <label style={{
          display: "flex", alignItems: "center", gap: "6px",
          marginBottom: nestStatus ? "8px" : "16px", cursor: "pointer", fontSize: "12px", color: "var(--text-secondary)",
        }}>
          <input type="checkbox" checked={autoNest} onChange={(e) => setAutoNest(e.target.checked)} />
          Auto-nest after generation
        </label>

        {/* Nest status */}
        {nestStatus && (
          <div style={{
            marginBottom: "16px", fontSize: "11px", color: "var(--text-muted)",
            padding: "4px 8px", background: "rgba(80, 180, 100, 0.1)",
            borderRadius: "var(--radius-sm)",
          }}>
            {nestStatus}
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
            onClick={handleGenerate}
            disabled={!canGenerate}
            style={{
              background: canGenerate ? "var(--accent-warm)" : "var(--bg-input)",
              border: "none",
              color: canGenerate ? "#fff" : "var(--text-muted)",
              padding: "6px 16px", borderRadius: "var(--radius-sm)",
              cursor: canGenerate ? "pointer" : "not-allowed",
              fontSize: "13px", fontWeight: 600,
            }}
          >Generate</button>
        </div>
      </div>
    </>
  );
}
