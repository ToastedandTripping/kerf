import { useState } from "react";

const ONBOARDING_KEY = "kerf-onboarding-seen";

const steps = [
  {
    title: "Import Your Design",
    description: "Drag and drop SVG, DXF, or image files onto the canvas. Or use File > Open to browse.",
    icon: "M4 4h16v2H4zm0 4h10v2H4zm0 4h16v2H4zm0 4h10v2H4z",
  },
  {
    title: "Assign to Layers",
    description: "Each layer has its own cut settings (speed, power, passes). Drag layers to set cut order. Fill mode engraves, Line mode cuts.",
    icon: "M3 3h18v2H3zm0 6h18v2H3zm0 6h18v2H3z",
  },
  {
    title: "Connect Your Laser",
    description: "Plug in via USB. Kerf auto-detects GRBL devices and reads your machine dimensions. Use the Machine panel to jog and frame.",
    icon: "M12 2L2 7l10 5 10-5zm0 7l-10 5 10 5 10-5z",
  },
  {
    title: "Preview & Send",
    description: "Generate G-code, preview the cut path with the animated playback, then hit Start. Use Pause and E-Stop if anything looks wrong.",
    icon: "M8 5v14l11-7z",
  },
];

export function OnboardingOverlay({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);

  function finish() {
    localStorage.setItem(ONBOARDING_KEY, "1");
    onClose();
  }

  const current = steps[step];

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000,
    }}>
      <div style={{
        background: "var(--bg-panel)", border: "1px solid var(--border)",
        borderRadius: "12px", padding: "32px", maxWidth: "400px", width: "90%",
        textAlign: "center",
      }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #4a90e2)" strokeWidth="1.5" style={{ marginBottom: "16px" }}>
          <path d={current.icon} />
        </svg>

        <h2 style={{ margin: "0 0 8px", fontSize: "18px", color: "var(--text-primary)", fontWeight: 600 }}>
          {current.title}
        </h2>
        <p style={{ margin: "0 0 24px", fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {current.description}
        </p>

        {/* Step indicator */}
        <div style={{ display: "flex", justifyContent: "center", gap: "6px", marginBottom: "20px" }}>
          {steps.map((_, i) => (
            <div key={i} style={{
              width: "8px", height: "8px", borderRadius: "50%",
              background: i === step ? "var(--accent, #4a90e2)" : "var(--border)",
            }} />
          ))}
        </div>

        {/* Navigation */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button
            onClick={finish}
            style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: "12px", cursor: "pointer" }}
          >
            Skip
          </button>
          <div style={{ display: "flex", gap: "8px" }}>
            {step > 0 && (
              <button
                onClick={() => setStep(step - 1)}
                style={{ padding: "6px 14px", fontSize: "12px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "6px", color: "var(--text-primary)", cursor: "pointer" }}
              >
                Back
              </button>
            )}
            <button
              onClick={() => step < steps.length - 1 ? setStep(step + 1) : finish()}
              style={{ padding: "6px 14px", fontSize: "12px", background: "var(--accent, #4a90e2)", border: "none", borderRadius: "6px", color: "#fff", cursor: "pointer" }}
            >
              {step < steps.length - 1 ? "Next" : "Get Started"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function shouldShowOnboarding(): boolean {
  return !localStorage.getItem(ONBOARDING_KEY);
}

export function resetOnboarding(): void {
  localStorage.removeItem(ONBOARDING_KEY);
}
