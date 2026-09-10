/**
 * W4, second door — powerMin is clamped against power at the STORE writer, not
 * only at the power inputs.
 *
 * The generation-side clamp (`clamp_power_min`, src-tauri/src/engine/gcode_gen.rs)
 * is the enforcement point for what the machine receives, but it does not
 * travel with the document. A file written with the invalid pair intact is read
 * by whatever build opens it next — including a shipped v0.8.28, which has no
 * clamp and emits `M4 S600` for a layer whose Power box reads 40.
 *
 * So the pair must be impossible to WRITE, through every door:
 *   1. the Power / Min Pwr inputs      (clamped before this fix)
 *   2. the Power Mode <select>          (the named defect)
 *   3. preset application, in both LayerPanel and MaterialLibrary
 * All three route through updateLayer, which is why the clamp lives there.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../index";
import { DEFAULT_LAYERS } from "../../types";

describe("W4 second door: powerMin clamped at the store writer", () => {
  beforeEach(() => {
    useStore.setState({ layers: DEFAULT_LAYERS.map((l) => ({ ...l })) });
  });

  it("flipping powerMode on a layer holding powerMin > power clamps powerMin", () => {
    // The exact defect. An old project can legally hold this pair: it was inert
    // while the layer was constant, because powerMin was unused.
    useStore.setState({
      layers: DEFAULT_LAYERS.map((l) =>
        l.index === 2 ? { ...l, power: 40, powerMin: 60, powerMode: "constant" as const } : l
      ),
    });

    // The Power Mode <select> writes only this partial — no power value at all.
    useStore.getState().updateLayer(2, { powerMode: "variable" });

    const layer = useStore.getState().layers[2];
    expect(layer.powerMode).toBe("variable");
    expect(layer.powerMin).toBe(40);
    expect(layer.power).toBe(40);
  });

  it("the invalid pair cannot reach a saved file through the mode flip", () => {
    // What actually matters: the document is what a different build reads.
    useStore.setState({
      layers: DEFAULT_LAYERS.map((l) =>
        l.index === 2 ? { ...l, power: 40, powerMin: 60, powerMode: "constant" as const } : l
      ),
    });
    useStore.getState().updateLayer(2, { powerMode: "variable" });

    const saved = useStore.getState().toProject();
    expect(saved.layers[2].powerMin).toBeLessThanOrEqual(saved.layers[2].power);
  });

  it("preset application cannot write an inverted pair", () => {
    // Door 3. Both LayerPanel.applyPreset and MaterialLibrary.applyPreset write
    // power and powerMin together from a preset. The 18 shipped presets are all
    // safe, but presets are user-creatable and user-importable.
    useStore.getState().updateLayer(2, { power: 30, powerMin: 90, speed: 1000 });

    const layer = useStore.getState().layers[2];
    expect(layer.powerMin).toBe(30);
  });

  it("lowering power drags a previously-valid powerMin down with it", () => {
    useStore.getState().updateLayer(2, { power: 80, powerMin: 50 });
    expect(useStore.getState().layers[2].powerMin).toBe(50);

    useStore.getState().updateLayer(2, { power: 20 });
    expect(useStore.getState().layers[2].powerMin).toBe(20);
  });

  it("a valid pair is passed through untouched, and powerMin: 0 is unaffected", () => {
    // W3 is the owner's call; the clamp only bounds from above and must never
    // disturb the current default of 0.
    useStore.getState().updateLayer(2, { power: 70, powerMin: 10 });
    expect(useStore.getState().layers[2].powerMin).toBe(10);

    useStore.getState().updateLayer(2, { power: 70, powerMin: 0 });
    expect(useStore.getState().layers[2].powerMin).toBe(0);
  });

  it("the line overlay writer clamps the same way", () => {
    useStore.getState().updateLineOverlay(0, { power: 40, powerMin: 60 });
    const ov = useStore.getState().layers[0].lineOverlay;
    expect(ov?.powerMin).toBe(40);
  });
});
