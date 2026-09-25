/**
 * R2 F3-F5 — placement of Pixi display objects, tested against REAL pixi.js
 * Container / Graphics / Sprite transforms under jsdom. `new Text()` needs
 * canvas text measurement, so text is modelled by a Container with the same
 * x and scale (the helpers only touch the transform fields both share).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Container, Graphics, Point, Sprite, Texture, TextureSource } from "pixi.js";
import type { DesignObject } from "../../../app/types";
import { PX_PER_MM } from "../../../lib/constants";
import { rotatePathPoint } from "../../../lib/geometry";
import {
  applyObjectRotation,
  applyTextImageTransform,
  renderImageObject,
  rotationPlacement,
} from "../renderHelpers";
import { clearTextures } from "../textureCache";

type T = DesignObject["transform"];

function mapLocal(c: Container, u: number, v: number): { x: number; y: number } {
  c.updateLocalTransform();
  const p = c.localTransform.apply(new Point(u, v));
  return { x: p.x, y: p.y };
}

/** World pixel position of mm point (x, y) rotated by `deg` about the transform centre. */
function rotatedPx(t: T, x: number, y: number, deg: number) {
  const r = rotatePathPoint({ x, y }, t.x + t.width / 2, t.y + t.height / 2, deg);
  return { x: r.x * PX_PER_MM, y: r.y * PX_PER_MM };
}

function expectClose(a: { x: number; y: number }, b: { x: number; y: number }, tol = 1e-6) {
  expect(Math.abs(a.x - b.x)).toBeLessThan(tol);
  expect(Math.abs(a.y - b.y)).toBeLessThan(tol);
}

function makeSprite(): Sprite {
  const source = new TextureSource({ width: 200, height: 100 });
  return new Sprite(new Texture({ source }));
}

const T30: T = { x: 10, y: 10, width: 50, height: 20, rotation: 30, scaleX: 1, scaleY: 1 };

describe("applyObjectRotation places every display type in its rotated box (R2 F3)", () => {
  it("text-like Container at (px, py): local origin lands on the rotated top-left", () => {
    const c = new Container();
    c.x = T30.x * PX_PER_MM;
    c.y = T30.y * PX_PER_MM;
    applyObjectRotation(c, T30);
    expectClose(mapLocal(c, 0, 0), rotatedPx(T30, 10, 10, 30));
  });

  it("flipped text-like Container: local origin lands on the rotated top-right", () => {
    const c = new Container();
    c.x = (T30.x + T30.width) * PX_PER_MM;
    c.y = T30.y * PX_PER_MM;
    c.scale.x = -1;
    const t = { ...T30, scaleX: -1 };
    applyObjectRotation(c, t);
    expectClose(mapLocal(c, 0, 0), rotatedPx(T30, 60, 10, 30));
  });

  it("Sprite: texture centre lands on the bbox centre, local origin on the rotated top-left", () => {
    const s = makeSprite();
    s.x = T30.x * PX_PER_MM;
    s.y = T30.y * PX_PER_MM;
    s.width = T30.width * PX_PER_MM;
    s.height = T30.height * PX_PER_MM;
    applyObjectRotation(s, T30);
    expectClose(mapLocal(s, 100, 50), { x: 35 * PX_PER_MM, y: 20 * PX_PER_MM });
    expectClose(mapLocal(s, 0, 0), rotatedPx(T30, 10, 10, 30));
  });

  it("Graphics at origin 0 (regression): world point rotates about the bbox centre", () => {
    const g = new Graphics();
    applyObjectRotation(g, T30);
    expectClose(mapLocal(g, T30.x * PX_PER_MM, T30.y * PX_PER_MM), rotatedPx(T30, 10, 10, 30));
  });

  it("is idempotent: applying twice gives the same placement", () => {
    const c = new Container();
    c.x = T30.x * PX_PER_MM;
    c.y = T30.y * PX_PER_MM;
    applyObjectRotation(c, T30);
    const once = { x: c.x, y: c.y, px: c.pivot.x, py: c.pivot.y, r: c.rotation };
    applyObjectRotation(c, T30);
    expect({ x: c.x, y: c.y, px: c.pivot.x, py: c.pivot.y, r: c.rotation }).toEqual(once);
    expectClose(mapLocal(c, 0, 0), rotatedPx(T30, 10, 10, 30));
  });

  it("back to 0: a Graphics placed at 30 then 0 is axis-aligned at origin 0", () => {
    const g = new Graphics();
    applyObjectRotation(g, T30);
    applyObjectRotation(g, { ...T30, rotation: 0 });
    expect(g.rotation).toBe(0);
    expect(g.pivot.x).toBe(0);
    expect(g.pivot.y).toBe(0);
    expect(g.x).toBe(0);
    expect(g.y).toBe(0);
  });
});

describe("rotationPlacement (pure)", () => {
  it("rotation 0 returns the recovered unrotated origin with zero pivot", () => {
    const r = rotationPlacement(
      { x: 150, y: 90, scaleX: 2, scaleY: -2, pivotX: 25, pivotY: 10 },
      { x: 0, y: 0, width: 10, height: 10, rotation: 0 }
    );
    expect(r).toEqual({ x: 100, y: 110, pivotX: 0, pivotY: 0, rotation: 0 });
  });

  it("scale 0 guard: pivot is 0 on the zero-scale axis, never Infinity or NaN", () => {
    const r = rotationPlacement(
      { x: 10, y: 10, scaleX: 0, scaleY: 0, pivotX: 0, pivotY: 0 },
      { x: 0, y: 0, width: 10, height: 10, rotation: 45 }
    );
    expect(r.pivotX).toBe(0);
    expect(r.pivotY).toBe(0);
    expect(r.x).toBeCloseTo(5 * PX_PER_MM, 9);
    expect(r.y).toBeCloseTo(5 * PX_PER_MM, 9);
    expect(r.rotation).toBeCloseTo(Math.PI / 4, 12);
  });

  it("non-zero rotation: pivot is (centre - origin) / scale, position is the centre", () => {
    const r = rotationPlacement(
      { x: 20, y: 30, scaleX: 0.5, scaleY: 2, pivotX: 0, pivotY: 0 },
      { x: 0, y: 0, width: 20, height: 40, rotation: 90 }
    );
    const cx = 10 * PX_PER_MM;
    const cy = 20 * PX_PER_MM;
    expect(r.x).toBeCloseTo(cx, 9);
    expect(r.y).toBeCloseTo(cy, 9);
    expect(r.pivotX).toBeCloseTo((cx - 20) / 0.5, 9);
    expect(r.pivotY).toBeCloseTo((cy - 30) / 2, 9);
  });
});

describe("flipped images keep their flip when moved (R2 F4)", () => {
  const IMG: T = { x: 10, y: 10, width: 50, height: 25, rotation: 0, scaleX: -1, scaleY: 1 };
  function imageObj(t: T): DesignObject {
    return {
      id: "img",
      type: "image",
      name: "img",
      transform: t,
      layerIndex: 0,
      visible: true,
      locked: false,
      fill: null,
      stroke: "#4a90e2",
      strokeWidth: 1,
      opacity: 1,
      imageData: "data:image/png;base64,AAAA",
    };
  }
  /** The creation path's placement: a fresh sprite placed for `t`. */
  function createdSprite(t: T): Sprite {
    const s = makeSprite();
    applyTextImageTransform(s, imageObj(t));
    return s;
  }

  it("a flipped image moved twice stays mirrored and fills its box", () => {
    const s = createdSprite(IMG);
    for (const x of [20, 35]) {
      const t = { ...IMG, x };
      applyTextImageTransform(s, imageObj(t));
      const px = x * PX_PER_MM;
      const py = t.y * PX_PER_MM;
      const pw = t.width * PX_PER_MM;
      expect(s.scale.x).toBeLessThan(0);
      expectClose(mapLocal(s, 0, 0), { x: px + pw, y: py });
      expectClose(mapLocal(s, 200, 0), { x: px, y: py });
    }
  });

  it("flipping back un-mirrors", () => {
    const s = createdSprite(IMG);
    applyTextImageTransform(s, imageObj({ ...IMG, scaleX: 1 }));
    expect(s.scale.x).toBeGreaterThan(0);
    expectClose(mapLocal(s, 0, 0), { x: IMG.x * PX_PER_MM, y: IMG.y * PX_PER_MM });
  });

  it("a vertically flipped image stays flipped when moved", () => {
    const t = { ...IMG, scaleX: 1, scaleY: -1 };
    const s = createdSprite(t);
    applyTextImageTransform(s, imageObj({ ...t, y: 30 }));
    expect(s.scale.y).toBeLessThan(0);
    expectClose(mapLocal(s, 0, 0), {
      x: t.x * PX_PER_MM,
      y: (30 + t.height) * PX_PER_MM,
    });
  });

  it("a template-text Container cannot be updated in place", () => {
    expect(applyTextImageTransform(new Container(), imageObj(IMG))).toBe(false);
  });

  it("a Sprite is updated in place", () => {
    expect(applyTextImageTransform(makeSprite(), imageObj(IMG))).toBe(true);
  });
});

describe("renderImageObject waits for decode (R2 F5)", () => {
  let decodes: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const originalDecode = HTMLImageElement.prototype.decode;
  const T_IMG: T = { x: 10, y: 10, width: 50, height: 25, rotation: 0, scaleX: -1, scaleY: 1 };
  function img(id: string): DesignObject {
    return {
      id,
      type: "image",
      name: id,
      transform: T_IMG,
      layerIndex: 0,
      visible: true,
      locked: false,
      fill: null,
      stroke: "#4a90e2",
      strokeWidth: 1,
      opacity: 0.5,
      imageData: "data:image/png;base64,AAAA",
    };
  }
  async function flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  beforeEach(() => {
    decodes = [];
    HTMLImageElement.prototype.decode = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          decodes.push({ resolve, reject });
        })
    );
    vi.spyOn(Texture, "from").mockImplementation(
      () => new Texture({ source: new TextureSource({ width: 200, height: 100 }) })
    );
    clearTextures();
  });

  afterEach(() => {
    clearTextures();
    HTMLImageElement.prototype.decode = originalDecode;
    vi.restoreAllMocks();
  });

  it("pending: returns null", () => {
    expect(renderImageObject(img("p"))).toBeNull();
  });

  it("ready: returns a Sprite placed by placeSprite (flip, box, alpha)", async () => {
    renderImageObject(img("r"));
    decodes[0].resolve();
    await flush();
    const el = renderImageObject(img("r"));
    expect(el).toBeInstanceOf(Sprite);
    const s = el as Sprite;
    expect(s.scale.x).toBeLessThan(0);
    expect(s.alpha).toBe(0.5);
    expectClose(mapLocal(s, 0, 0), { x: 60 * PX_PER_MM, y: 10 * PX_PER_MM });
    expectClose(mapLocal(s, 200, 100), { x: 10 * PX_PER_MM, y: 35 * PX_PER_MM });
  });

  it("failed: returns the placeholder wrapped in a Container that is not a Graphics", async () => {
    renderImageObject(img("f"));
    decodes[0].reject(new Error("bad"));
    await flush();
    const el = renderImageObject(img("f"));
    expect(el).toBeInstanceOf(Container);
    expect(el).not.toBeInstanceOf(Graphics);
    expect(el).not.toBeInstanceOf(Sprite);
    expect(el!.children).toHaveLength(1);
    expect(el!.children[0]).toBeInstanceOf(Graphics);
  });
});
