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
