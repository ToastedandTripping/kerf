import { describe, it, expect } from "vitest";
import {
  measureDistance,
  measureAngleDeg,
  formatMeasureLabel,
  ellipseDiameter,
  findNearestSnapPoint,
  snapThresholdMm,
} from "../measure";
import type { DesignObject } from "../../app/types";

// --- Helper to build a minimal DesignObject for testing ---
function makeObj(
  type: DesignObject["type"],
  x: number,
  y: number,
  width: number,
  height: number,
  rotation = 0,
  visible = true
): DesignObject {
  return {
    id: "test",
    type,
    name: "test",
    transform: { x, y, width, height, rotation, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible,
    locked: false,
    fill: null,
    stroke: "#fff",
    strokeWidth: 1,
    opacity: 1,
  };
}

// ========================================
// measureDistance
// ========================================
describe("measureDistance", () => {
  it("3-4-5 right triangle returns 5", () => {
    expect(measureDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("identical points return 0, not NaN", () => {
    const result = measureDistance({ x: 7, y: 3 }, { x: 7, y: 3 });
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it("horizontal segment", () => {
    expect(measureDistance({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(10);
  });

  it("vertical segment", () => {
    expect(measureDistance({ x: 0, y: 0 }, { x: 0, y: 6 })).toBe(6);
  });
});

// ========================================
// measureAngleDeg
// ========================================
describe("measureAngleDeg", () => {
  it("right (+X) = 0°", () => {
    expect(measureAngleDeg({ x: 0, y: 0 }, { x: 5, y: 0 })).toBeCloseTo(0, 5);
  });

  it("up (−screen Y) = 90°", () => {
    // Screen Y is down, so p2 ABOVE p1 means p2.y < p1.y
    expect(measureAngleDeg({ x: 0, y: 5 }, { x: 0, y: 0 })).toBeCloseTo(90, 5);
  });

  it("left (−X) = 180°", () => {
    expect(measureAngleDeg({ x: 5, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(180, 5);
  });

  it("down (+screen Y) = 270°", () => {
    // p2 below p1 in screen coords
    expect(measureAngleDeg({ x: 0, y: 0 }, { x: 0, y: 5 })).toBeCloseTo(270, 5);
  });

  it("45° diagonal (right + up on screen) = 45°", () => {
    // right (+X) and up (-Y in screen)
    expect(measureAngleDeg({ x: 0, y: 5 }, { x: 5, y: 0 })).toBeCloseTo(45, 5);
  });

  it("SCREEN-Y-DOWN SIGN TEST: up-and-right reads ~30°, NOT 330°/−30°", () => {
    // Vector: dx = sqrt(3), dy_screen = -1 (p2 is up and to the right)
    // Math-CCW: up-right is in Q1 → should read between 0° and 90°.
    const p1 = { x: 0, y: 1 }; // baseline (screen Y=1)
    const p2 = { x: Math.sqrt(3), y: 0 }; // screen Y=0 → 1 unit above p1
    // dx = sqrt(3), negated_dy = -(0 - 1) = 1
    // math-CCW angle = atan2(1, sqrt(3)) = 30°
    const angle = measureAngleDeg(p1, p2);
    expect(angle).toBeCloseTo(30, 3);
    // Guard: must NOT be 330° (the wrong screen-Y sign)
    expect(angle).not.toBeCloseTo(330, 3);
  });
});

// ========================================
// formatMeasureLabel
// ========================================
describe("formatMeasureLabel", () => {
  it("formats distance and angle to one decimal with units", () => {
    expect(formatMeasureLabel(12.34, 45)).toBe("12.3 mm  ·  45.0°");
  });

  it("rounds each value to one decimal place", () => {
    expect(formatMeasureLabel(7.86, 30.04)).toBe("7.9 mm  ·  30.0°");
    expect(formatMeasureLabel(0, 0)).toBe("0.0 mm  ·  0.0°");
  });
});

// ========================================
// ellipseDiameter
// ========================================
describe("ellipseDiameter", () => {
  it("circle (w === h) returns Ø format", () => {
    const obj = makeObj("ellipse", 0, 0, 12, 12);
    expect(ellipseDiameter(obj)).toBe("Ø 12.0 mm");
  });

  it("near-circle (within 0.5 mm) returns Ø format", () => {
    const obj = makeObj("ellipse", 0, 0, 12, 12.3);
    expect(ellipseDiameter(obj)).toBe("Ø 12.0 mm");
  });

  it("ellipse (w ≠ h beyond 0.5) returns w × h format", () => {
    const obj = makeObj("ellipse", 0, 0, 12, 8);
    expect(ellipseDiameter(obj)).toBe("12.0 × 8.0 mm");
  });
});

// ========================================
// findNearestSnapPoint
// ========================================
describe("findNearestSnapPoint", () => {
  // A 10×10 mm rectangle at (0,0)
  const rect = makeObj("rectangle", 0, 0, 10, 10);
  const thresh = 3; // mm

  it("snaps to nearest corner when within threshold", () => {
    // Click near top-left corner (0,0)
    const pt = findNearestSnapPoint(0.5, 0.5, thresh, [rect]);
    expect(pt).not.toBeNull();
    expect(pt!.x).toBe(0);
    expect(pt!.y).toBe(0);
    expect(pt!.kind).toBe("corner");
  });

  it("snaps to center when closer to center", () => {
    // Click at exact center (5,5)
    const pt = findNearestSnapPoint(5, 5, thresh, [rect]);
    expect(pt).not.toBeNull();
    expect(pt!.x).toBe(5);
    expect(pt!.y).toBe(5);
    expect(pt!.kind).toBe("center");
  });

  it("returns null when cursor is beyond threshold from all snap points", () => {
    // Click far from the rectangle
    const pt = findNearestSnapPoint(50, 50, thresh, [rect]);
    expect(pt).toBeNull();
  });

  it("skips invisible objects", () => {
    const hidden = makeObj("rectangle", 0, 0, 10, 10, 0, false);
    const pt = findNearestSnapPoint(0, 0, thresh, [hidden]);
    expect(pt).toBeNull();
  });

  // ---- Ellipse axis-RIM test (the load-bearing hole-diameter case) ----
  it("snaps to ellipse axis-RIM point so a cross-hole click yields diameter, not bbox", () => {
    // Ellipse: center (50,50), width=20, height=10 → rx=10, ry=5
    // East rim: (60, 50), West rim: (40, 50), North rim: (50, 45), South rim: (50, 55)
    const hole = makeObj("ellipse", 40, 45, 20, 10);

    // Click near east rim (60, 50) — testing rim snap
    const ptEast = findNearestSnapPoint(60.5, 50, 2, [hole]);
    expect(ptEast).not.toBeNull();
    expect(ptEast!.kind).toBe("rim");
    expect(ptEast!.x).toBe(60); // east rim X = cx + rx = 50 + 10 = 60
    expect(ptEast!.y).toBe(50); // east rim Y = cy = 50

    // Click near west rim (40, 50)
    const ptWest = findNearestSnapPoint(39.5, 50, 2, [hole]);
    expect(ptWest).not.toBeNull();
    expect(ptWest!.kind).toBe("rim");
    expect(ptWest!.x).toBe(40); // west rim X = cx - rx = 50 - 10 = 40

    // Distance between east and west rim = the true diameter (20mm, not bbox diagonal ~22.4mm)
    const diameter = measureDistance(
      { x: ptWest!.x, y: ptWest!.y },
      { x: ptEast!.x, y: ptEast!.y }
    );
    expect(diameter).toBeCloseTo(20, 5); // should be exactly width, not the diagonal
  });

  // ---- Threshold clamp tests ----
  it("threshold clamps at 0.5 mm minimum (extreme zoom-in still snaps)", () => {
    // thresholdMm = 0 is below the 0.5 floor; snap at 0.3 mm away still finds the point
    // because effective threshold = 0.5 mm
    const pt = findNearestSnapPoint(0.3, 0.3, 0.0, [rect]);
    expect(pt).not.toBeNull();
    expect(pt!.kind).toBe("corner");
  });

  it("threshold clamps at 10 mm maximum (extreme zoom-out won't snap to distant objects)", () => {
    // Place object far away (200mm), pass a huge threshold (99) → clamped to 10mm → no snap
    const farObj = makeObj("rectangle", 200, 200, 10, 10);
    const pt = findNearestSnapPoint(0, 0, 99, [farObj]);
    expect(pt).toBeNull();
  });
});

// ========================================
// snapThresholdMm
// ========================================
describe("snapThresholdMm", () => {
  const PX_PER_MM = 3.78;

  it("zoom=1: ~8px / (1 * 3.78) ≈ 2.11 mm", () => {
    expect(snapThresholdMm(1, PX_PER_MM)).toBeCloseTo(8 / (1 * PX_PER_MM), 3);
  });

  it("extreme zoom-out clamps at 10 mm maximum", () => {
    // zoom=0.001 → 8/(0.001*3.78) ≈ 2116mm → clamped to 10
    expect(snapThresholdMm(0.001, PX_PER_MM)).toBe(10);
  });

  it("extreme zoom-in clamps at 0.5 mm minimum", () => {
    // zoom=100 → 8/(100*3.78) ≈ 0.021mm → clamped to 0.5
    expect(snapThresholdMm(100, PX_PER_MM)).toBe(0.5);
  });
});
