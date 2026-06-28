/**
 * Unit tests for computeFitZoomIndex — the pure helper that selects the
 * largest ZOOM_STEPS entry that fits the image inside the preview container.
 *
 * Plan verification §8: "computeFitZoomIndex — 1000×1000 in 580×360 → 25%;
 * 100×100 → largest step ≤ fit; exact-fit + tiny-image edges."
 */
import { describe, it, expect } from "vitest";
import { computeFitZoomIndex, ZOOM_STEPS } from "../ImageTraceDialog";

// ZOOM_STEPS = [25, 50, 100, 200, 400]
// Indices:       0   1   2    3    4

describe("computeFitZoomIndex", () => {
  const W = 580; // preview container width (dialog 580px, used as ref dimension)
  const H = 360; // preview container height

  it("1000×1000 image in 580×360 container → index 0 (25%)", () => {
    // fitPct = min(580/1000, 360/1000)*100 = 36
    // largest ZOOM_STEPS[i] ≤ 36 is 25 → index 0
    const idx = computeFitZoomIndex(W, H, 1000, 1000);
    expect(ZOOM_STEPS[idx]).toBe(25);
    expect(idx).toBe(0);
  });

  it("100×100 image in 580×360 container → index 3 (200%)", () => {
    // fitPct = min(580/100, 360/100)*100 = 360
    // largest ZOOM_STEPS[i] ≤ 360 is 200 → index 3
    const idx = computeFitZoomIndex(W, H, 100, 100);
    expect(ZOOM_STEPS[idx]).toBe(200);
    expect(idx).toBe(3);
  });

  it("tiny image (10×10) → index 4 (400%, maximum)", () => {
    // fitPct = min(580/10, 360/10)*100 = 3600
    // largest ZOOM_STEPS[i] ≤ 3600 is 400 → index 4
    const idx = computeFitZoomIndex(W, H, 10, 10);
    expect(ZOOM_STEPS[idx]).toBe(400);
    expect(idx).toBe(4);
  });

  it("landscape image fits at 50% (fitPct between 50 and 100)", () => {
    // 800×200 in 580×360: fitPct = min(580/800, 360/200)*100 = min(72.5, 180)*100 = 72.5
    // largest ZOOM_STEPS[i] ≤ 72.5 is 50 → index 1
    const idx = computeFitZoomIndex(W, H, 800, 200);
    expect(ZOOM_STEPS[idx]).toBe(50);
    expect(idx).toBe(1);
  });

  it("image exactly fits at 100% (fitPct == 100)", () => {
    // 540×360 in 540×360: fitPct = min(1, 1)*100 = 100
    // largest ZOOM_STEPS[i] ≤ 100 is 100 → index 2
    const idx = computeFitZoomIndex(540, 360, 540, 360);
    expect(ZOOM_STEPS[idx]).toBe(100);
    expect(idx).toBe(2);
  });

  it("image larger than container but < 2x → fits at 50%", () => {
    // 700×400 in 580×360: fitPct = min(580/700, 360/400)*100 = min(82.9, 90)*100 = 82.9
    // largest ZOOM_STEPS[i] ≤ 82.9 is 50 → index 1
    const idx = computeFitZoomIndex(W, H, 700, 400);
    expect(ZOOM_STEPS[idx]).toBe(50);
    expect(idx).toBe(1);
  });

  it("zero-width image → returns default index 2 (100%)", () => {
    const idx = computeFitZoomIndex(W, H, 0, 100);
    expect(idx).toBe(2);
  });

  it("zero-height image → returns default index 2 (100%)", () => {
    const idx = computeFitZoomIndex(W, H, 100, 0);
    expect(idx).toBe(2);
  });

  it("exact-fit at 25%: fitPct == 25 → index 0", () => {
    // Image 4× container in both dims: fitPct = 25
    // 25 ≤ 25 → index 0
    const idx = computeFitZoomIndex(580, 360, 2320, 1440);
    expect(ZOOM_STEPS[idx]).toBe(25);
    expect(idx).toBe(0);
  });

  it("image slightly larger than 25%-fit → still index 0 (capped at minimum)", () => {
    // Huge image: fitPct < 25 → best = 0 (fallback to minimum step)
    const idx = computeFitZoomIndex(W, H, 5000, 5000);
    expect(idx).toBe(0);
    expect(ZOOM_STEPS[idx]).toBe(25);
  });
});
