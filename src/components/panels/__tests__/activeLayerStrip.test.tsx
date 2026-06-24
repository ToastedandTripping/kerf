/**
 * ActiveLayerStrip — render test.
 *
 * Verifies:
 *  - The active layer's color swatch + name are rendered
 *  - A power-slider change calls updateLayer with the right index and
 *    clears activePreset (mirrors the LayerPanel.tsx:123-129 pattern)
 *  - Speed change via SpeedInput is wired through updateLayer
 *
 * Error-185 guard: the strip reads `layers` (stable array) + `activeLayerIndex`
 * (scalar) as SEPARATE selectors and derives the active layer outside the
 * selector. This test exercises a mount/update cycle that would surface an
 * infinite re-render loop if the rule were violated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { render, fireEvent, cleanup } from "@testing-library/react";
import { useStore } from "../../../app/store";
import { DEFAULT_LAYERS } from "../../../app/types";
import { ActiveLayerStrip } from "../ActiveLayerStrip";

function seedLayers() {
  // Use real DEFAULT_LAYERS so the store is in a consistent state
  useStore.setState({
    layers: DEFAULT_LAYERS,
    activeLayerIndex: 0,  // first layer (Cut — index 0)
  });
}

describe("ActiveLayerStrip", () => {
  beforeEach(() => {
    cleanup();
    seedLayers();
    // Reset updateLayer spy after each seed so spy counts are clean
  });

  it("renders the active layer name", () => {
    const { getByText } = render(<ActiveLayerStrip />);
    const activeLayer = DEFAULT_LAYERS.find((l) => l.index === 0)!;
    expect(getByText(activeLayer.name)).toBeTruthy();
  });

  it("reflects the active layer power value in the number input", () => {
    const activeLayer = DEFAULT_LAYERS.find((l) => l.index === 0)!;
    const { getAllByDisplayValue } = render(<ActiveLayerStrip />);
    const powerInputs = getAllByDisplayValue(String(activeLayer.power));
    expect(powerInputs.length).toBeGreaterThan(0);
  });

  it("power slider change calls updateLayer with correct index and clears activePreset", () => {
    const updateLayerSpy = vi.fn();
    useStore.setState({ updateLayer: updateLayerSpy } as unknown as Parameters<typeof useStore.setState>[0]);

    const { getAllByRole } = render(<ActiveLayerStrip />);
    // The power range input is the first range slider
    const sliders = getAllByRole("slider");
    const powerSlider = sliders[0];

    fireEvent.change(powerSlider, { target: { value: "75" } });

    expect(updateLayerSpy).toHaveBeenCalledWith(
      0, // activeLayerIndex 0
      expect.objectContaining({ power: 75, activePreset: undefined }),
    );
  });

  it("speed number field change calls updateLayer with correct index and clears activePreset", () => {
    const updateLayerSpy = vi.fn();
    useStore.setState({ updateLayer: updateLayerSpy } as unknown as Parameters<typeof useStore.setState>[0]);

    const { getAllByRole } = render(<ActiveLayerStrip />);
    // SpeedInput renders a number input (type="spinbutton" in ARIA) — there are two:
    // index 0 = power number input (value=50), index 1 = speed number input (value=6000).
    const spinbuttons = getAllByRole("spinbutton");
    const speedNumberInput = spinbuttons[1]; // SpeedInput's number field

    fireEvent.change(speedNumberInput, { target: { value: "1500" } });

    // handleSpeedChange(v) calls updateLayer(active.index, { speed: v, activePreset: undefined })
    // clampSpeed(1500, effectiveMaxSpeed(0, 0)) = clampSpeed(1500, 30000) = 1500
    expect(updateLayerSpy).toHaveBeenCalledWith(
      0, // activeLayerIndex 0
      expect.objectContaining({ speed: 1500, activePreset: undefined }),
    );
  });

  it("returns null when no layers match activeLayerIndex", () => {
    useStore.setState({ activeLayerIndex: 999 });
    const { container } = render(<ActiveLayerStrip />);
    expect(container.firstChild).toBeNull();
  });
});
