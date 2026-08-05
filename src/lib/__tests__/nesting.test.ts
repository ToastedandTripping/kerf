import { describe, it, expect } from "vitest";
import { nestItems } from "../nesting";
import { computeAABB } from "../geometry";
import type { DesignObject } from "../../app/types";

function makeObject(id: string, x: number, y: number, w: number, h: number, rotation = 0): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Object ${id}`,
    transform: { x, y, width: w, height: h, rotation, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#ffffff",
    strokeWidth: 1,
    opacity: 1,
  };
}

describe("computeAABB", () => {
  it("returns original dimensions for 0 rotation", () => {
    const obj = makeObject("a", 10, 20, 50, 30, 0);
    const aabb = computeAABB(obj);
    expect(aabb.x).toBeCloseTo(10);
    expect(aabb.y).toBeCloseTo(20);
    expect(aabb.w).toBeCloseTo(50);
    expect(aabb.h).toBeCloseTo(30);
  });

  it("swaps w/h for 90 degree rotation", () => {
    const obj = makeObject("a", 0, 0, 50, 30, 90);
    const aabb = computeAABB(obj);
    expect(aabb.w).toBeCloseTo(30);
    expect(aabb.h).toBeCloseTo(50);
  });
});

describe("nestItems", () => {
  it("places a single item at origin", () => {
    const items = [{ id: "a", w: 10, h: 10, originalRotation: 0 }];
    const result = nestItems(items, 100, 100, 0, "none");
    expect(result.placed).toHaveLength(1);
    expect(result.placed[0].objectId).toBe("a");
    expect(result.placed[0].x).toBe(0);
    expect(result.placed[0].y).toBe(0);
    expect(result.unplaced).toHaveLength(0);
  });

  it("places two items side-by-side without overlap", () => {
    const items = [
      { id: "a", w: 40, h: 20, originalRotation: 0 },
      { id: "b", w: 40, h: 20, originalRotation: 0 },
    ];
    const result = nestItems(items, 100, 100, 0, "none");
    expect(result.placed).toHaveLength(2);
    expect(result.unplaced).toHaveLength(0);

    // Verify no overlap
    const placements = result.placed.map((p) => {
      const item = items.find((i) => i.id === p.objectId)!;
      return { x: p.x, y: p.y, w: item.w, h: item.h };
    });
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const a = placements[i];
        const b = placements[j];
        const overlap =
          a.x < b.x + b.w && a.x + a.w > b.x &&
          a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap).toBe(false);
      }
    }
  });

  it("puts item larger than sheet in unplaced", () => {
    const items = [{ id: "big", w: 200, h: 200, originalRotation: 0 }];
    const result = nestItems(items, 100, 100, 0, "none");
    expect(result.placed).toHaveLength(0);
    expect(result.unplaced).toEqual(["big"]);
  });

  it("respects spacing between adjacent items", () => {
    const items = [
      { id: "a", w: 40, h: 40, originalRotation: 0 },
      { id: "b", w: 40, h: 40, originalRotation: 0 },
    ];
    const spacing = 5;
    const result = nestItems(items, 100, 100, spacing, "none");
    expect(result.placed).toHaveLength(2);

    // The second item should be offset by at least item width + spacing
    const aPlacement = result.placed.find((p) => p.objectId === "a")!;
    const bPlacement = result.placed.find((p) => p.objectId === "b")!;
    const xDist = Math.abs(bPlacement.x - aPlacement.x);
    const yDist = Math.abs(bPlacement.y - aPlacement.y);
    // Either horizontally or vertically separated by at least item size + spacing
    const separated = xDist >= 40 + spacing || yDist >= 40 + spacing;
    expect(separated).toBe(true);
  });

  it("rotation '90' allows tall item to fit when rotated", () => {
    // Item is 80 tall, 20 wide. Sheet is 100 wide, 50 tall.
    // Without rotation it won't fit vertically. With 90 rotation it becomes 20 tall, 80 wide.
    const items = [{ id: "tall", w: 20, h: 80, originalRotation: 0 }];
    const result = nestItems(items, 100, 50, 0, "90");
    expect(result.placed).toHaveLength(1);
    // Should be rotated by 90 or 270
    expect([90, 270]).toContain(result.placed[0].rotation);
  });

  it("computes efficiency correctly", () => {
    // A single 50x50 item on a 100x100 sheet = 25% efficiency
    const items = [{ id: "a", w: 50, h: 50, originalRotation: 0 }];
    const result = nestItems(items, 100, 100, 0, "none");
    expect(result.efficiency).toBeCloseTo(0.25);
  });

  it("returns empty result for empty input", () => {
    const result = nestItems([], 100, 100, 0, "none");
    expect(result.placed).toHaveLength(0);
    expect(result.unplaced).toHaveLength(0);
    expect(result.efficiency).toBe(0);
  });

  it("places 100 small items without overlap", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: `item_${i}`,
      w: 5,
      h: 5,
      originalRotation: 0,
    }));
    // 100 items of 5x5 = 2500 area. Sheet 100x100 = 10000. Should all fit.
    const result = nestItems(items, 100, 100, 0, "none");
    expect(result.placed).toHaveLength(100);
    expect(result.unplaced).toHaveLength(0);

    // Verify no overlaps
    const placements = result.placed.map((p) => ({
      x: p.x, y: p.y, w: 5, h: 5,
    }));
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const a = placements[i];
        const b = placements[j];
        const overlap =
          a.x < b.x + b.w && a.x + a.w > b.x &&
          a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap).toBe(false);
      }
    }
  });
});
