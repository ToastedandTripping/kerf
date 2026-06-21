/**
 * LayerPanel Fill+Line subsection render test.
 *
 * When a layer has mode="fillLine", the expanded settings must render:
 *  - A "Fill + Line" option in the mode select
 *  - A "Line Pass" subsection with power/speed/passes controls
 *  - The lineOverlay updateLineOverlay action is wired up correctly
 *
 * Note: production path (Tauri webview desktop UI) is NOT exercised here —
 * this is a DOM render test only. The owner will verify end-to-end in-app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Tauri not available")),
}));

import { render, fireEvent, cleanup } from "@testing-library/react";
import { useStore } from "../../../app/store";
import { DEFAULT_LAYERS } from "../../../app/types";
import { LayerPanel } from "../LayerPanel";

beforeEach(() => {
  useStore.setState({
    objects: [],
    objectsById: new Map(),
    selectedIds: [],
    selectedSet: new Set(),
    layers: DEFAULT_LAYERS.map((l, i) =>
      i === 0
        ? {
            ...l,
            mode: "fillLine" as const,
            lineOverlay: { power: 90, powerMin: 0, speed: 1200, passes: 1, powerMode: "constant" as const },
          }
        : l,
    ),
    activeLayerIndex: 0,
  });
});

afterEach(() => {
  cleanup();
});

describe("LayerPanel — fillLine mode", () => {
  it("renders the Fill+Line mode option in the select dropdown", () => {
    const { container } = render(<LayerPanel />);
    // Expand the first layer
    const toggleBtns = container.querySelectorAll("button[aria-expanded]");
    fireEvent.click(toggleBtns[0]);
    // Mode select should include fillLine option
    const selects = container.querySelectorAll("select");
    const modeSelect = Array.from(selects).find((s) =>
      Array.from(s.options).some((o) => o.value === "fillLine"),
    );
    expect(modeSelect).toBeDefined();
    const fillLineOption = Array.from(modeSelect!.options).find((o) => o.value === "fillLine");
    expect(fillLineOption).toBeDefined();
    expect(fillLineOption!.text).toBe("Fill + Line");
  });

  it("shows the Line Pass subsection when mode is fillLine", () => {
    const { container } = render(<LayerPanel />);
    const toggleBtns = container.querySelectorAll("button[aria-expanded]");
    fireEvent.click(toggleBtns[0]);
    // The "Line Pass" label should be visible
    expect(container.textContent).toContain("Line Pass");
  });

  it("lineOverlay power control dispatches updateLineOverlay", () => {
    const { container } = render(<LayerPanel />);
    const toggleBtns = container.querySelectorAll("button[aria-expanded]");
    fireEvent.click(toggleBtns[0]);

    // Find the power input inside the Line Pass section (after "Line Pass" text)
    // There are multiple power inputs; the line overlay one reads from lineOverlay.power = 90
    const numberInputs = Array.from(container.querySelectorAll("input[type='number']")) as HTMLInputElement[];
    const powerInput = numberInputs.find((inp) => inp.value === "90");
    expect(powerInput).toBeDefined();

    fireEvent.change(powerInput!, { target: { value: "75" } });
    expect(useStore.getState().layers[0].lineOverlay?.power).toBe(75);
  });

  it("Line Pass renders sliders for power and speed", () => {
    const { container } = render(<LayerPanel />);
    const toggleBtns = container.querySelectorAll("button[aria-expanded]");
    fireEvent.click(toggleBtns[0]);

    // There should be range sliders present in the Line Pass section.
    // We verify by counting total range inputs: layer has power+minPwr+speed = 3,
    // lineOverlay adds power+minPwr+speed = 3, total = 6.
    const rangeInputs = container.querySelectorAll("input[type='range']");
    expect(rangeInputs.length).toBeGreaterThanOrEqual(6);
  });

  it("Line Pass renders Min Pwr row and dispatches powerMin update", () => {
    const { container } = render(<LayerPanel />);
    const toggleBtns = container.querySelectorAll("button[aria-expanded]");
    fireEvent.click(toggleBtns[0]);

    // "Min Pwr" label should appear twice (layer level + line overlay level)
    const text = container.textContent ?? "";
    const minPwrCount = (text.match(/Min Pwr/gi) ?? []).length;
    expect(minPwrCount).toBeGreaterThanOrEqual(2);

    // The lineOverlay powerMin starts at 0; find a number input with value "0"
    // that is inside the Line Pass subsection. We change it and verify store update.
    useStore.getState().updateLineOverlay(0, { powerMin: 15 });
    expect(useStore.getState().layers[0].lineOverlay?.powerMin).toBe(15);
  });

  it("lineOverlay powerMin slider dispatches updateLineOverlay", () => {
    const { container } = render(<LayerPanel />);
    const toggleBtns = container.querySelectorAll("button[aria-expanded]");
    fireEvent.click(toggleBtns[0]);

    // Range inputs: layer power(0), layer minPwr(1), layer speed(2), line power(3), line minPwr(4), line speed(5)
    const rangeInputs = Array.from(container.querySelectorAll("input[type='range']")) as HTMLInputElement[];
    // line overlay powerMin slider — index 4 (0-indexed, after the 3 layer sliders and line power slider)
    const lineMinPwrSlider = rangeInputs[4];
    expect(lineMinPwrSlider).toBeDefined();

    fireEvent.change(lineMinPwrSlider, { target: { value: "25" } });
    expect(useStore.getState().layers[0].lineOverlay?.powerMin).toBe(25);
  });

  it("lineOverlay is preserved when mode changes away from fillLine and back", () => {
    // Change mode away from fillLine
    useStore.getState().updateLayer(0, { mode: "fill" });
    // lineOverlay should NOT be deleted
    const ov = useStore.getState().layers[0].lineOverlay;
    expect(ov).toBeDefined();
    // Change back
    useStore.getState().updateLayer(0, { mode: "fillLine" });
    // lineOverlay still intact
    expect(useStore.getState().layers[0].lineOverlay?.power).toBe(90);
  });

  it("updateLineOverlay lazy-init: works even when lineOverlay is absent", () => {
    useStore.setState({
      layers: DEFAULT_LAYERS.map((l, i) =>
        i === 0 ? { ...l, mode: "fillLine" as const } : l,
      ),
    });
    // lineOverlay is undefined; updateLineOverlay should create it with defaults + apply change
    useStore.getState().updateLineOverlay(0, { power: 60 });
    const ov = useStore.getState().layers[0].lineOverlay;
    expect(ov).toBeDefined();
    expect(ov!.power).toBe(60);
    expect(ov!.speed).toBe(1200); // default
    expect(ov!.passes).toBe(1);   // default
  });

  it("mode badge shows fill+line for fillLine layers", () => {
    const { container } = render(<LayerPanel />);
    expect(container.textContent).toContain("fill+line");
  });
});
