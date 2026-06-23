import { describe, it, expect } from "vitest";
import {
  SPEED_FALLBACK_MAX,
  SPEED_SLIDER_FLOOR,
  safeNum,
  sliderPosToSpeed,
  speedToSliderPos,
  clampSpeed,
  effectiveMaxSpeed,
} from "../speedScale";

describe("speedScale", () => {
  // --- safeNum ---
  describe("safeNum", () => {
    it("returns finite positive values unchanged", () => {
      expect(safeNum(100)).toBe(100);
      expect(safeNum(1)).toBe(1);
    });
    it("coerces NaN to fallback", () => {
      expect(safeNum(NaN)).toBe(1);
      expect(safeNum(NaN, 5)).toBe(5);
    });
    it("coerces Infinity to fallback", () => {
      expect(safeNum(Infinity)).toBe(1);
      expect(safeNum(-Infinity)).toBe(1);
    });
    it("coerces 0 to fallback (0 is not positive)", () => {
      expect(safeNum(0)).toBe(1);
    });
    it("coerces negative to fallback", () => {
      expect(safeNum(-5)).toBe(1);
    });
  });

  // --- effectiveMaxSpeed ---
  describe("effectiveMaxSpeed", () => {
    it("returns min of both axes when both > 0", () => {
      expect(effectiveMaxSpeed(8000, 8000)).toBe(8000);
      expect(effectiveMaxSpeed(10000, 8000)).toBe(8000);
      expect(effectiveMaxSpeed(8000, 10000)).toBe(8000);
    });
    it("falls back to SPEED_FALLBACK_MAX when X is 0", () => {
      expect(effectiveMaxSpeed(0, 8000)).toBe(SPEED_FALLBACK_MAX);
    });
    it("falls back to SPEED_FALLBACK_MAX when Y is 0", () => {
      expect(effectiveMaxSpeed(8000, 0)).toBe(SPEED_FALLBACK_MAX);
    });
    it("falls back to SPEED_FALLBACK_MAX when both are 0 (disconnected)", () => {
      expect(effectiveMaxSpeed(0, 0)).toBe(SPEED_FALLBACK_MAX);
    });
  });

  // --- sliderPosToSpeed ---
  describe("sliderPosToSpeed", () => {
    const MAX = 8000;

    it("pos=0 maps to floor (or effectiveFloor when max<floor)", () => {
      const result = sliderPosToSpeed(0, MAX);
      expect(result).toBe(SPEED_SLIDER_FLOOR);
    });

    it("pos=1000 maps to max", () => {
      const result = sliderPosToSpeed(1000, MAX);
      expect(result).toBe(MAX);
    });

    it("is monotonically increasing from pos 0 to 1000", () => {
      let prev = sliderPosToSpeed(0, MAX);
      for (let pos = 1; pos <= 1000; pos += 10) {
        const cur = sliderPosToSpeed(pos, MAX);
        expect(cur).toBeGreaterThanOrEqual(prev);
        prev = cur;
      }
    });

    it("clamps pos below 0 to 0 (floor)", () => {
      expect(sliderPosToSpeed(-10, MAX)).toBe(sliderPosToSpeed(0, MAX));
    });

    it("clamps pos above 1000 to max", () => {
      expect(sliderPosToSpeed(1100, MAX)).toBe(MAX);
    });

    // Boundary: max=30, below the 50mm/min floor — effectiveFloor clamps to max
    it("max=30 (below floor): no inversion, all positions stay within [30,30]", () => {
      const at0 = sliderPosToSpeed(0, 30);
      const at500 = sliderPosToSpeed(500, 30);
      const at1000 = sliderPosToSpeed(1000, 30);
      // effectiveFloor = min(50, 30) = 30; logFloor=logMax → all positions → 30
      expect(at0).toBe(30);
      expect(at500).toBe(30);
      expect(at1000).toBe(30);
      // monotonic (trivially — all equal)
      expect(at0).toBeLessThanOrEqual(at500);
      expect(at500).toBeLessThanOrEqual(at1000);
    });
  });

  // --- speedToSliderPos ---
  describe("speedToSliderPos", () => {
    const MAX = 8000;

    it("speed at floor maps to pos 0", () => {
      expect(speedToSliderPos(SPEED_SLIDER_FLOOR, MAX)).toBe(0);
    });

    it("speed at max maps to pos 1000", () => {
      expect(speedToSliderPos(MAX, MAX)).toBe(1000);
    });

    it("is monotonically increasing with speed", () => {
      const speeds = [50, 100, 200, 500, 1000, 2000, 4000, 8000];
      let prev = speedToSliderPos(speeds[0], MAX);
      for (let i = 1; i < speeds.length; i++) {
        const cur = speedToSliderPos(speeds[i], MAX);
        expect(cur).toBeGreaterThanOrEqual(prev);
        prev = cur;
      }
    });

    // Boundary: speed below floor → pos 0 (number field authoritative)
    it("speed=20 (sub-floor) maps to pos 0", () => {
      expect(speedToSliderPos(20, MAX)).toBe(0);
    });

    it("speed=0 maps to pos 0", () => {
      expect(speedToSliderPos(0, MAX)).toBe(0);
    });

    it("NaN speed maps to pos 0 (coerced to effectiveFloor)", () => {
      expect(speedToSliderPos(NaN, MAX)).toBe(0);
    });
  });

  // --- round-trip ---
  describe("round-trip (sliderPosToSpeed → speedToSliderPos)", () => {
    const MAX = 8000;

    it("round-trips within ±1 position for typical speeds", () => {
      for (let pos = 0; pos <= 1000; pos += 50) {
        const speed = sliderPosToSpeed(pos, MAX);
        const posBack = speedToSliderPos(speed, MAX);
        // Rounding in sliderPosToSpeed means the inverse may be off by 1
        expect(Math.abs(posBack - pos)).toBeLessThanOrEqual(1);
      }
    });
  });

  // --- clampSpeed ---
  describe("clampSpeed", () => {
    it("clamps above max", () => {
      expect(clampSpeed(1e5, 30000)).toBe(30000);
    });

    it("clamps below 1", () => {
      expect(clampSpeed(0, 8000)).toBe(1);
    });

    it("clamps negative to 1", () => {
      expect(clampSpeed(-100, 8000)).toBe(1);
    });

    it("passes through valid speed unchanged", () => {
      expect(clampSpeed(500, 8000)).toBe(500);
      expect(clampSpeed(1, 8000)).toBe(1);
      expect(clampSpeed(8000, 8000)).toBe(8000);
    });

    it("speed=NaN clamps to 1 (no NaN leaks)", () => {
      expect(clampSpeed(NaN, 30000)).toBe(1);
    });
  });
});
