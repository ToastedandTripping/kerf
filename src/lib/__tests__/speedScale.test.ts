import { describe, it, expect } from "vitest";
import {
  SPEED_FALLBACK_MAX,
  SPEED_SLIDER_FLOOR,
  safeNum,
  sliderPosToSpeed,
  speedToSliderPos,
  clampSpeed,
  effectiveMaxSpeed,
  rasterMaxSpeed,
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

  // --- rasterMaxSpeed ---
  describe("rasterMaxSpeed", () => {
    it("returns X when both axes > 0 and X < Y (X wins, not min)", () => {
      expect(rasterMaxSpeed(8000, 12000)).toBe(8000);
    });
    it("returns X when both axes > 0 and X > Y (X wins, not min)", () => {
      expect(rasterMaxSpeed(12000, 8000)).toBe(12000);
    });
    it("returns X when both axes > 0 and X === Y", () => {
      expect(rasterMaxSpeed(8000, 8000)).toBe(8000);
    });
    it("falls back to Y when X is 0", () => {
      expect(rasterMaxSpeed(0, 8000)).toBe(8000);
    });
    it("falls back to SPEED_FALLBACK_MAX when both are 0", () => {
      expect(rasterMaxSpeed(0, 0)).toBe(SPEED_FALLBACK_MAX);
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

    it("round-trips within ±2 positions across every integer slider position", () => {
      // Step by 1 so the near-floor band (positions ~2–44, speeds ~51–63 mm/min)
      // is actually exercised — stepping by 50 skips every position where the
      // real error is 2.
      //
      // ±2 is the true maximum round-trip error: at very low speeds just above
      // the 50 mm/min floor, log-scale compression causes the double-rounding
      // (Math.round in both directions) to accumulate up to 2 positions of
      // discrepancy. This is a known, benign artifact — the number field is
      // authoritative for exact speeds, so a 2-position slider discrepancy at
      // ~51–56 mm/min has no practical effect.
      for (let pos = 0; pos <= 1000; pos++) {
        const speed = sliderPosToSpeed(pos, MAX);
        const posBack = speedToSliderPos(speed, MAX);
        expect(Math.abs(posBack - pos)).toBeLessThanOrEqual(2);
      }
    });

    it("endpoints are exact (pos=0 → floor → pos=0; pos=1000 → max → pos=1000)", () => {
      // Floor endpoint
      const speedAtFloor = sliderPosToSpeed(0, MAX);
      expect(speedAtFloor).toBe(SPEED_SLIDER_FLOOR);
      expect(speedToSliderPos(speedAtFloor, MAX)).toBe(0);
      // Max endpoint
      const speedAtMax = sliderPosToSpeed(1000, MAX);
      expect(speedAtMax).toBe(MAX);
      expect(speedToSliderPos(speedAtMax, MAX)).toBe(1000);
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
