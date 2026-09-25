/**
 * refresh-cut-vs-screen F1 — the canvas composes groups to any depth, exactly as
 * the cut does, and decides visibility per leaf by the cut's own rule.
 *
 * Parity pin: composedLeaves must deep-equal gcodeGen's flattenObjects (frozen
 * file, imported read-only) with groupId stripped. drawnLeaves must equal the
 * cut's per-leaf visibility filter (gcodeGen.ts:276-279) minus `output`.
 */
import { describe, it, expect } from "vitest";
import type { DesignObject, Layer, PathPoint } from "../../../app/types";
import { DEFAULT_LAYERS } from "../../../app/types";
import { buildGroupObject, composedLeaves, drawnLeaves, pointsBBox } from "../index";
import { flattenObjectsForTest } from "../../machine/gcodeGen";

function base(id: string, layerIndex = 0): Omit<DesignObject, "type" | "transform"> {
  return {
    id,
    name: id,
    layerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#e24a4a",
    strokeWidth: 1,
    opacity: 1,
  };
}

function makePath(id: string, points: PathPoint[], layerIndex = 0): DesignObject {
  const bb = pointsBBox(points);
  return {
    ...base(id, layerIndex),
    type: "path",
    closed: true,
    points,
    transform: {
      x: bb.x,
      y: bb.y,
      width: bb.width,
      height: bb.height,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    },
  };
}

function square(id: string, x: number, y: number, s: number, layerIndex = 0): DesignObject {
  return makePath(
    id,
    [
      { x, y },
      { x: x + s, y },
      { x: x + s, y: y + s },
      { x, y: y + s },
    ],
    layerIndex
  );
}

function rect(id: string, x: number, y: number, layerIndex = 0): DesignObject {
  return {
    ...base(id, layerIndex),
    type: "rectangle",
    transform: { x, y, width: 8, height: 6, rotation: 0, scaleX: 1, scaleY: 1 },
  };
}

function rotated(o: DesignObject, deg: number): DesignObject {
  return { ...o, transform: { ...o.transform, rotation: deg } };
}

/** (a) outer group of [inner group of [square path, hole path], rect] */
function fixtureA(opts: { innerRot?: number; outerRot?: number; holeLayer?: number } = {}) {
  let inner = buildGroupObject(
    [square("sq", 10, 10, 20), square("hole", 15, 15, 5, opts.holeLayer ?? 0)],
    "inner",
    "inner",
    0
  );
  if (opts.innerRot) inner = rotated(inner, opts.innerRot);
  let outer = buildGroupObject([inner, rect("rect", 40, 12)], "outer", "outer", 0);
  if (opts.outerRot) outer = rotated(outer, opts.outerRot);
  return outer;
}

function stripGroupId(objs: DesignObject[]): DesignObject[] {
  return objs.map((o) => {
    const { groupId: _g, ...rest } = o;
    return rest as DesignObject;
  });
}

const fixtures: Record<string, DesignObject> = {
  a: fixtureA(),
  b: fixtureA({ innerRot: 15, outerRot: 30 }),
  c: buildGroupObject([fixtureA(), rect("rect2", 70, 5)], "top", "top", 0),
  d: rect("plain", 3, 4),
};

describe("composedLeaves — parity with the cut's flattenObjects", () => {
  for (const [name, fx] of Object.entries(fixtures)) {
    it(`fixture (${name}) composes exactly as flattenObjects`, () => {
      expect(composedLeaves(fx).map((l) => l.obj)).toEqual(
        stripGroupId(flattenObjectsForTest([fx]))
      );
    });
  }

  it("keys are the full id path", () => {
    expect(composedLeaves(fixtures.a).map((l) => l.key)).toEqual([
      "outer/inner/sq",
      "outer/inner/hole",
      "outer/rect",
    ]);
    expect(composedLeaves(fixtures.d).map((l) => l.key)).toEqual(["plain"]);
  });

  it("depth-1 key format is unchanged (g/c)", () => {
    const g = buildGroupObject([rect("c", 0, 0)], "g", "g", 0);
    expect(composedLeaves(g).map((l) => l.key)).toEqual(["g/c"]);
  });

  it("(c) depth-3 yields every leaf", () => {
    expect(composedLeaves(fixtures.c).map((l) => l.key)).toEqual([
      "top/outer/inner/sq",
      "top/outer/inner/hole",
      "top/outer/rect",
      "top/rect2",
    ]);
  });
});

describe("drawnLeaves — the cut's per-leaf visibility rule, minus output", () => {
  // Layer index 2 hidden, layer index 1 output-off.
  const layers: Layer[] = DEFAULT_LAYERS.map((l) =>
    l.index === 2 ? { ...l, visible: false } : l.index === 1 ? { ...l, output: false } : l
  );

  // Oracle: copies gcodeGen.ts:276-279 (skip !visible; skip leaf whose layer by
  // l.index, falling back to layers[0], is hidden) — deliberately WITHOUT the
  // `output === false` half.
  function oracle(fx: DesignObject, ls: Layer[]): DesignObject[] {
    return stripGroupId(
      flattenObjectsForTest([fx]).filter(
        (o) => o.visible && (ls.find((l) => l.index === o.layerIndex) || ls[0]).visible
      )
    );
  }

  const e = fixtureA({ holeLayer: 2 });
  const f = buildGroupObject(
    [rect("shown", 0, 0), { ...rect("hidden", 10, 0), visible: false }],
    "f",
    "f",
    0
  );
  const g = buildGroupObject([rect("g1", 0, 0), rect("g2", 10, 0)], "g", "g", 2);
  const h = rect("h", 0, 0, 1);

  const all: Record<string, DesignObject> = { ...fixtures, e, f, g, h };
  for (const [name, fx] of Object.entries(all)) {
    it(`fixture (${name}) matches the cut's visibility oracle`, () => {
      expect(drawnLeaves(fx, layers).map((l) => l.obj)).toEqual(oracle(fx, layers));
    });
  }

  it("(e) omits the hole on the hidden layer, keeps its siblings", () => {
    const ids = drawnLeaves(e, layers).map((l) => l.obj.id);
    expect(ids).toEqual(["sq", "rect"]);
  });

  it("(f) omits the hidden child, keeps its sibling", () => {
    expect(drawnLeaves(f, layers).map((l) => l.obj.id)).toEqual(["shown"]);
  });

  it("(g) draws both children although the group's own layer is hidden", () => {
    expect(drawnLeaves(g, layers).map((l) => l.obj.id)).toEqual(["g1", "g2"]);
  });

  it("(h) draws an object on an output-off layer (reference geometry)", () => {
    expect(drawnLeaves(h, layers).map((l) => l.obj.id)).toEqual(["h"]);
  });

  it("(i) layers = [] never throws and draws every leaf", () => {
    expect(() => drawnLeaves(e, [])).not.toThrow();
    expect(drawnLeaves(e, []).map((l) => l.key)).toEqual(composedLeaves(e).map((l) => l.key));
    expect(drawnLeaves(e, []).length).toBe(3);
  });
  it("(j) orphan layerIndex falls back to layers[0]; layers are looked up by l.index, not position", () => {
    // Razor N2. layers[0] is hidden and its index (5) is not its position.
    const ls: Layer[] = [
      { ...DEFAULT_LAYERS[0], index: 5, visible: false },
      { ...DEFAULT_LAYERS[1], index: 0, visible: true },
      { ...DEFAULT_LAYERS[2], index: 1, visible: false },
    ];
    const grp = buildGroupObject(
      [
        rect("orphan", 0, 0, 99),
        rect("on0", 10, 0, 0),
        rect("on1", 20, 0, 1),
        rect("on5", 30, 0, 5),
      ],
      "j",
      "j",
      0
    );
    // orphan -> layers[0] (hidden); on0 -> index 0 (visible, stored at position 1);
    // on1 -> index 1 (hidden); on5 -> index 5 (hidden, stored at position 0).
    expect(drawnLeaves(grp, ls).map((l) => l.obj.id)).toEqual(["on0"]);
    expect(drawnLeaves(grp, ls).map((l) => l.obj)).toEqual(oracle(grp, ls));
  });
});
