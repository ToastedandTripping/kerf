/**
 * SpeedInput — shared log-scale slider + number field for speed (mm/min).
 *
 * Reads grblMaxFeedRateX and grblMaxFeedRateY as TWO SEPARATE scalar selectors
 * (never a single object selector — React Error 185 guard) and computes the
 * effective cap internally. Parents pass only value+onChange; no cap threading.
 *
 * NumberField from PropertiesPanel.tsx was not reused: it is an unexported
 * local function with a mandatory label prop and its own flex wrapper, which
 * conflicts with the inline slider+number row layout already used by LayerPanel.
 * A standalone <input type="number"> matches the existing pattern exactly.
 */

import { useStore } from "../../app/store";
import {
  sliderPosToSpeed,
  speedToSliderPos,
  clampSpeed,
  effectiveMaxSpeed,
  rasterMaxSpeed,
} from "../../lib/speedScale";

// Matches the existing inputStyle in LayerPanel.tsx for visual parity.
const numInputStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
  padding: "3px 6px",
  fontSize: "11px",
  width: "50px",
  textAlign: "right",
};

interface SpeedInputProps {
  value: number;
  onChange: (v: number) => void;
  raster?: boolean;
}

export function SpeedInput({ value, onChange, raster = false }: SpeedInputProps) {
  // TWO SEPARATE scalar selectors — never a single object selector (Error 185).
  const mx = useStore((s) => s.grblMaxFeedRateX);
  const my = useStore((s) => s.grblMaxFeedRateY);
  const effectiveMax = raster ? rasterMaxSpeed(mx, my) : effectiveMaxSpeed(mx, my);

  const sliderPos = speedToSliderPos(value, effectiveMax);

  function handleSlider(e: React.ChangeEvent<HTMLInputElement>) {
    const pos = Number(e.target.value);
    onChange(sliderPosToSpeed(pos, effectiveMax));
  }

  function handleNumber(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = Number(e.target.value);
    onChange(clampSpeed(raw, effectiveMax));
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "4px", width: "100%" }}>
      <input
        type="range"
        min="0"
        max="1000"
        step="1"
        value={sliderPos}
        onChange={handleSlider}
        style={{ flex: 1, accentColor: "var(--accent)" }}
      />
      <input
        type="number"
        min="1"
        max={effectiveMax}
        value={value}
        onChange={handleNumber}
        style={numInputStyle}
      />
      <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>mm/min</span>
    </div>
  );
}
