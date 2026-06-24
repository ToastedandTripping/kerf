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

  // Clamp at minimum: very low speed → raw < 3, should return 3
  it("clamps at minimum 3 mm", () => {
    // v = 5 mm/s, a = 500: raw = 1.2 * 25 / 1000 = 0.03 → clamp to 3
    expect(computeOverscan(5 * 60, 500)).toBe(3);
  });

  // Clamp at maximum: very high speed or very low accel → raw > 50, should return 50
  it("clamps at maximum 50 mm", () => {
    // v = 500 mm/s, a = 500: raw = 1.2 * 250000 / 1000 = 300 → clamp to 50
    expect(computeOverscan(500 * 60, 500)).toBe(50);
  });

  // Fallback when accelX = 0: uses 300 mm/s² internally
  // v = 100 mm/s, a = 300: raw = 1.2 * 10000 / 600 = 20 mm
  it("accelX=0 falls back to 300 mm/s²", () => {
    expect(computeOverscan(100 * 60, 0)).toBeCloseTo(20, 6);
  });

  // NaN / non-positive speed guard → return min clamp (3)
  it("NaN speed → 3", () => {
    expect(computeOverscan(NaN, 500)).toBe(3);
  });

  it("speed=0 → 3", () => {
    expect(computeOverscan(0, 500)).toBe(3);
  });

  it("negative speed → 3", () => {
    expect(computeOverscan(-100, 500)).toBe(3);
  });

  it("Infinity speed → 3 (non-finite guard)", () => {
    expect(computeOverscan(Infinity, 500)).toBe(3);
  });
});
