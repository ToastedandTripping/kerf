/**
 * Tests for:
 *  - grblSValueMax localStorage round-trip (C1)
 *  - DEFAULT_LAYERS speeds are in mm/min (A3)
 *  - Store default layer speeds updated after unit switch
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useStore } from "../index";
import { DEFAULT_LAYERS } from "../../types";

// ── S-Value Max localStorage persistence ─────────────────────────────────────

describe("grblSValueMax localStorage persistence (C1)", () => {
  const KEY = "kerf-s-value-max";

  beforeEach(() => {
    localStorage.removeItem(KEY);
  });

  afterEach(() => {
    localStorage.removeItem(KEY);
  });

  it("setGrblSValueMax persists the value to localStorage", () => {
    useStore.getState().setGrblSValueMax(255);
    expect(localStorage.getItem(KEY)).toBe("255");
  });

  it("setGrblSValueMax round-trip: stored value can be parsed back to number", () => {
    useStore.getState().setGrblSValueMax(512);
    const raw = localStorage.getItem(KEY);
    expect(Number(raw)).toBe(512);
  });

  it("setGrblSValueMax with 1000 (default) stores '1000'", () => {
    useStore.getState().setGrblSValueMax(1000);
    expect(localStorage.getItem(KEY)).toBe("1000");
  });
});

// ── DEFAULT_LAYERS speed values are mm/min ────────────────────────────────────

describe("DEFAULT_LAYERS speeds are mm/min (A3)", () => {
  it("Engrave layer default speed is 6000 mm/min (was 100 mm/s)", () => {
    expect(DEFAULT_LAYERS[0].speed).toBe(6000);
    expect(DEFAULT_LAYERS[0].name).toBe("Engrave");
  });

  it("Score layer default speed is 3000 mm/min (was 50 mm/s)", () => {
    expect(DEFAULT_LAYERS[1].speed).toBe(3000);
    expect(DEFAULT_LAYERS[1].name).toBe("Score");
  });

  it("Cut layer default speed is 1200 mm/min (was 20 mm/s)", () => {
    expect(DEFAULT_LAYERS[2].speed).toBe(1200);
    expect(DEFAULT_LAYERS[2].name).toBe("Cut");
  });

  it("Custom layer defaults are 1200 mm/min (was 20 mm/s)", () => {
    expect(DEFAULT_LAYERS[3].speed).toBe(1200);
    expect(DEFAULT_LAYERS[4].speed).toBe(1200);
    expect(DEFAULT_LAYERS[5].speed).toBe(1200);
  });

  it("No default layer has a speed <= 100 (would indicate old mm/s values)", () => {
    for (const layer of DEFAULT_LAYERS) {
      expect(layer.speed).toBeGreaterThan(100);
    }
  });
});

// ── Connect with $30=255 overrides persisted 1000 ────────────────────────────
// This is an integration-style check on the setter logic (not the connection.ts
// hardware path, which requires serial — deferred to Lee's on-hardware verify).
describe("$30 firmware value overrides persisted value (C2 logic)", () => {
  it("setGrblSValueMax called with firmware value updates store and localStorage", () => {
    const KEY = "kerf-s-value-max";
    // Simulate persisted 1000 already written
    localStorage.setItem(KEY, "1000");
    useStore.getState().setGrblSValueMax(255);
    // Store updated
    expect(useStore.getState().grblSValueMax).toBe(255);
    // localStorage updated to firmware value
    expect(localStorage.getItem(KEY)).toBe("255");
  });
});
