import { useState, useRef, useEffect } from "react";
import QRCode from "qrcode";
import { useStore, generateId } from "../../app/store";

interface Props {
  open: boolean;
  onClose: () => void;
}

type QrMode = "text" | "url" | "wifi";

export function QrCodeDialog({ open, onClose }: Props) {
  const [mode, setMode] = useState<QrMode>("text");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("https://");
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPass, setWifiPass] = useState("");
  const [wifiEncryption, setWifiEncryption] = useState<"WPA" | "WEP" | "nopass">("WPA");
  const [size, setSize] = useState(30); // mm
  const [errorLevel, setErrorLevel] = useState<"L" | "M" | "Q" | "H">("M");
  const previewRef = useRef<HTMLCanvasElement>(null);

  const content = mode === "text" ? text
    : mode === "url" ? url
    : `WIFI:T:${wifiEncryption};S:${wifiSsid};P:${wifiPass};;`;

  useEffect(() => {
    if (!open || !previewRef.current || !content) return;
    QRCode.toCanvas(previewRef.current, content || " ", {
      width: 150,
      margin: 1,
      errorCorrectionLevel: errorLevel,
      color: { dark: "#ffffff", light: "#1a1a2e" },
    }).catch(() => {});
  }, [open, content, errorLevel]);

  if (!open) return null;

  async function handleGenerate() {
    if (!content) return;

    // Generate QR code as matrix of modules
    const qr = QRCode.create(content, { errorCorrectionLevel: errorLevel });
    const modules = qr.modules;
    const moduleCount = modules.size;
    const moduleSize = size / moduleCount; // mm per module

    const store = useStore.getState();

    // Create rectangle objects for each filled module run (run-length encoding for efficiency)
    store.withUndo("qr-code", () => {
      for (let row = 0; row < moduleCount; row++) {
        let colStart = -1;
        for (let col = 0; col <= moduleCount; col++) {
          const filled = col < moduleCount && modules.get(row, col);
          if (filled && colStart === -1) {
            colStart = col;
          } else if (!filled && colStart !== -1) {
            // Create rect for this run
            const x = colStart * moduleSize;
            const y = row * moduleSize;
            const w = (col - colStart) * moduleSize;
            const h = moduleSize;

            store.addObject({
              id: generateId(),
              type: "rectangle",
              name: `QR module`,
              transform: {
                x: 10 + x, y: 10 + y,
                width: w, height: h,
                rotation: 0, scaleX: 1, scaleY: 1,
              },
              layerIndex: store.activeLayerIndex,
              visible: true, locked: false,
              fill: null,
              stroke: store.layers[store.activeLayerIndex].color,
              strokeWidth: 0.1,
              opacity: 1,
            });
            colStart = -1;
          }
        }
      }
    });

    onClose();
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "var(--bg-input)",
    border: "1px solid var(--border)",
    color: "var(--text-primary)",
    padding: "6px 10px",
    borderRadius: "var(--radius-sm)",
    fontSize: "13px",
    outline: "none",
  };

  const chipStyle = (active: boolean): React.CSSProperties => ({
    background: active ? "var(--accent-warm)" : "var(--bg-input)",
    border: "1px solid " + (active ? "var(--accent-warm)" : "var(--border)"),
    color: active ? "#fff" : "var(--text-secondary)",
    padding: "4px 12px",
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    fontSize: "12px",
  });

  return (
    <>
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999,
      }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="qr-code-dialog-title"
        style={{
        position: "fixed", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        width: "420px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-modal)",
        zIndex: 10000,
        padding: "20px",
      }}>
        <div id="qr-code-dialog-title" style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "16px" }}>
          Generate QR Code
        </div>

        {/* Mode selector */}
        <div style={{ display: "flex", gap: "6px", marginBottom: "12px" }}>
          <button style={chipStyle(mode === "text")} onClick={() => setMode("text")}>Text</button>
          <button style={chipStyle(mode === "url")} onClick={() => setMode("url")}>URL</button>
          <button style={chipStyle(mode === "wifi")} onClick={() => setMode("wifi")}>WiFi</button>
        </div>

        {/* Content inputs */}
        {mode === "text" && (
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Enter text..."
            style={inputStyle}
          />
        )}
        {mode === "url" && (
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            style={inputStyle}
          />
        )}
        {mode === "wifi" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <input
              value={wifiSsid}
              onChange={(e) => setWifiSsid(e.target.value)}
              placeholder="Network name (SSID)"
              style={inputStyle}
            />
            <input
              value={wifiPass}
              onChange={(e) => setWifiPass(e.target.value)}
              placeholder="Password"
              type="password"
              style={inputStyle}
            />
            <div style={{ display: "flex", gap: "6px" }}>
              <button style={chipStyle(wifiEncryption === "WPA")} onClick={() => setWifiEncryption("WPA")}>WPA</button>
              <button style={chipStyle(wifiEncryption === "WEP")} onClick={() => setWifiEncryption("WEP")}>WEP</button>
              <button style={chipStyle(wifiEncryption === "nopass")} onClick={() => setWifiEncryption("nopass")}>None</button>
            </div>
          </div>
        )}

        {/* Settings row */}
        <div style={{ display: "flex", gap: "16px", marginTop: "12px", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Size:</span>
            <input
              value={size}
              onChange={(e) => setSize(parseFloat(e.target.value) || 30)}
              style={{ ...inputStyle, width: "50px", textAlign: "right" }}
            />
            <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>mm</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Error:</span>
            <select
              value={errorLevel}
              onChange={(e) => setErrorLevel(e.target.value as "L" | "M" | "Q" | "H")}
              style={{
                background: "var(--bg-input)", border: "1px solid var(--border)",
                color: "var(--text-primary)", padding: "4px 8px",
                borderRadius: "var(--radius-sm)", fontSize: "12px",
              }}
            >
              <option value="L">Low (7%)</option>
              <option value="M">Medium (15%)</option>
              <option value="Q">Quartile (25%)</option>
              <option value="H">High (30%)</option>
            </select>
          </div>
        </div>

        {/* Preview */}
        <div style={{ display: "flex", justifyContent: "center", margin: "16px 0" }}>
          <canvas ref={previewRef} style={{ borderRadius: "var(--radius-sm)" }} />
        </div>

        {/* Buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "1px solid var(--border)",
              color: "var(--text-secondary)", padding: "6px 16px",
              borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "13px",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={!content}
            style={{
              background: content ? "var(--accent-warm)" : "var(--bg-input)",
              border: "none",
              color: content ? "#fff" : "var(--text-muted)",
              padding: "6px 16px",
              borderRadius: "var(--radius-sm)",
              cursor: content ? "pointer" : "default",
              fontSize: "13px",
            }}
          >
            Generate
          </button>
        </div>
      </div>
    </>
  );
}
