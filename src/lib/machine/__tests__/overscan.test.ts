import { describe, it, expect } from "vitest";
import { computeOverscan } from "../overscan";

describe("computeOverscan", () => {
  // v = 100 mm/s, a = 500 mm/s²
  // raw = 1.2 * (100^2) / (2 * 500) = 1.2 * 10000 / 1000 = 12 mm
  it("v=100 mm/s ($120=500) → 12 mm", () => {
    expect(computeOverscan(100 * 60, 500)).toBeCloseTo(12, 6);
  });

  // v = 200 mm/s, a = 500 mm/s²
  // raw = 1.2 * (200^2) / (2 * 500) = 1.2 * 40000 / 1000 = 48 mm
  it("v=200 mm/s ($120=500) → 48 mm", () => {
    expect(computeOverscan(200 * 60, 500)).toBeCloseTo(48, 6);
  });

  // Floor at 0.5 mm: very low speed → raw < 0.5, should return 0.5
  it("floors at 0.5 mm", () => {
    // v = 5 mm/s, a = 500: raw = 1.2 * 25 / 1000 = 0.03 → floor to 0.5
    expect(computeOverscan(5 * 60, 500)).toBe(0.5);
  });

  // No upper clamp: very high speed or very low accel → raw > 50 passes through
  it("no upper clamp (raw > 50 passes through)", () => {
    // v = 500 mm/s, a = 500: raw = 1.2 * 250000 / 1000 = 300
    expect(computeOverscan(500 * 60, 500)).toBe(300);
  });

  // 1000/300 → 0.555556 mm (owner's machine at low speed)
  it("1000 mm/min, 300 mm/s² → ~0.556 mm", () => {
    // v = 1000/60 ≈ 16.667, raw = 1.2 * 16.667^2 / (2*300) = 1.2*277.78/600 ≈ 0.5556
    expect(computeOverscan(1000, 300)).toBeCloseTo(0.5556, 3);
  });

  // 6000/1000 → 6 mm
  it("6000 mm/min, 1000 mm/s² → 6 mm", () => {
    // v = 100, raw = 1.2 * 10000 / 2000 = 6
    expect(computeOverscan(6000, 1000)).toBeCloseTo(6, 6);
  });

  // Fallback when acceleration = 0: uses 300 mm/s² internally
  // v = 100 mm/s, a = 300: raw = 1.2 * 10000 / 600 = 20 mm
  it("acceleration=0 falls back to 300 mm/s²", () => {
    expect(computeOverscan(100 * 60, 0)).toBeCloseTo(20, 6);
  });

  // NaN / non-positive speed guard → return floor (0.5)
  it("NaN speed → 0.5", () => {
    expect(computeOverscan(NaN, 500)).toBe(0.5);
  });

  it("speed=0 → 0.5", () => {
    expect(computeOverscan(0, 500)).toBe(0.5);
  });

  it("negative speed → 0.5", () => {
    expect(computeOverscan(-100, 500)).toBe(0.5);
  });

  it("Infinity speed → 0.5 (non-finite guard)", () => {
    expect(computeOverscan(Infinity, 500)).toBe(0.5);
  });

  // Acceleration edge cases
  it("NaN acceleration falls back to 300 mm/s²", () => {
    expect(computeOverscan(100 * 60, NaN)).toBeCloseTo(20, 6);
  });

  it("negative acceleration falls back to 300 mm/s²", () => {
    expect(computeOverscan(100 * 60, -100)).toBeCloseTo(20, 6);
  });

  it("Infinity acceleration falls back to 300 mm/s²", () => {
    expect(computeOverscan(100 * 60, Infinity)).toBeCloseTo(20, 6);
  });

  // Above-50 values pass through (no upper clamp)
  it("values above 50 mm are not clamped", () => {
    // v = 300 mm/s, a = 300: raw = 1.2 * 90000 / 600 = 180
    expect(computeOverscan(300 * 60, 300)).toBe(180);
  });
});
