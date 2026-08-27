/**
 * CHARACTERIZATION tests for textToGcode.
 *
 * textGcode.ts emits G-code that goes to a laser and had no test coverage at
 * all. These tests pin CURRENT behavior exactly — they are a net, not a
 * specification. Nothing here asserts that the current output is *desirable*;
 * it asserts that a refactor did not change it. If a deliberate behavior change
 * is made later, these expectations are meant to be updated alongside it.
 *
 * textObjectToPaths is mocked: the real one fetches
 * /fonts/OpenSans-Regular.ttf, which does not resolve under jsdom, and the
 * glyph outlines it returns are a font-version detail rather than something
 * this module owns. The mock returns hand-built path objects so the emit logic
 * (offsets, ordering, laser on/off framing) is what is under test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DesignObject, PathPoint } from "../../../app/types";

const textObjectToPaths = vi.fn();

vi.mock("../../../app/store/geometryActions", () => ({
  textObjectToPaths: (obj: DesignObject) => textObjectToPaths(obj),
}));

import { textToGcode } from "../textGcode";

/** Minimal path DesignObject with literal anchor points (no bezier handles). */
function makePath(id: string, points: PathPoint[], closed: boolean): DesignObject {
  return {
    id,
    type: "path",
    name: id,
    transform: { x: 0, y: 0, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#ffffff",
    strokeWidth: 0,
    opacity: 1,
    points,
    closed,
  } as DesignObject;
}

/** Group whose children's points are local to the group's transform origin. */
function makeGroup(id: string, gx: number, gy: number, children: DesignObject[]): DesignObject {
  return {
    id,
    type: "group",
    name: id,
    transform: { x: gx, y: gy, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#ffffff",
    strokeWidth: 0,
    opacity: 1,
    children,
  } as DesignObject;
}

beforeEach(() => {
  textObjectToPaths.mockReset();
});

describe("textToGcode — emitted sequence", () => {
  it("frames an open contour as header, G0, power-on, G1 stream, M5", async () => {
    textObjectToPaths.mockResolvedValue([
      makePath(
        "c0",
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 2 },
        ],
        false
      ),
    ]);

    const lines = await textToGcode("A", 10, 20, 3, 800, 1500, "M4");

    expect(lines).toEqual([
      '; Label: "A"',
      "G0 X10.000 Y20.000",
      "M4 S800",
      "G1 X11.000 Y20.000 F1500 S800",
      "G1 X11.000 Y22.000 F1500 S800",
      "M5",
    ]);
  });

  it("appends a return-to-start G1 for a closed contour, before M5", async () => {
    textObjectToPaths.mockResolvedValue([
      makePath(
        "c0",
        [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 2, y: 2 },
        ],
        true
      ),
    ]);

    const lines = await textToGcode("A", 0, 0, 3, 500, 1000, "M3");

    // Closing move repeats the first sampled point, then the laser goes off.
    expect(lines.slice(-2)).toEqual(["G1 X0.000 Y0.000 F1000 S500", "M5"]);
    expect(lines[1]).toBe("G0 X0.000 Y0.000");
    expect(lines[2]).toBe("M3 S500");
  });

  it("emits one G0/power-on/M5 cycle per contour", async () => {
    textObjectToPaths.mockResolvedValue([
      makePath(
        "c0",
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
        false
      ),
      makePath(
        "c1",
        [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
        ],
        false
      ),
    ]);

    const lines = await textToGcode("AB", 0, 0, 3, 500, 1000, "M4");

    expect(lines.filter((l) => l === "M5")).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("G0 "))).toHaveLength(2);
    // Header is emitted once, not per contour.
    expect(lines.filter((l) => l.startsWith("; Label:"))).toHaveLength(1);
  });

  it("coordinates are fixed to 3 decimals", async () => {
    textObjectToPaths.mockResolvedValue([
      makePath(
        "c0",
        [
          { x: 0.12345, y: 0.98765 },
          { x: 1, y: 1 },
        ],
        false
      ),
    ]);

    const lines = await textToGcode("A", 0, 0, 3, 500, 1000, "M4");

    expect(lines[1]).toBe("G0 X0.123 Y0.988");
  });
});

describe("textToGcode — empty inputs", () => {
  it("returns no lines when the font produces no paths", async () => {
    textObjectToPaths.mockResolvedValue([]);
    expect(await textToGcode(" ", 0, 0, 3, 500, 1000, "M4")).toEqual([]);
  });

  it("returns no lines when every path is below the 2-point minimum", async () => {
    // collectPathLeaves requires points.length >= 2, so a 1-point path yields
    // no leaves at all and the header is never emitted.
    textObjectToPaths.mockResolvedValue([makePath("c0", [{ x: 0, y: 0 }], false)]);
    expect(await textToGcode(".", 0, 0, 3, 500, 1000, "M4")).toEqual([]);
  });
});

describe("textToGcode — group composition", () => {
  /**
   * Multi-contour glyphs (O, 0, 8, 9, %) arrive as a group whose children's
   * points are local to the group's transform origin. Composition is PURE
   * TRANSLATION: the group's x/y are added to each child point.
   *
   * ROTATION IS NOT COMPOSED. collectPathLeaves reads only transform.x and
   * transform.y — a non-zero group rotation is silently ignored, so callers
   * must not hand this function a rotated group. That is a caller-enforced
   * precondition, not something this module validates. This test documents
   * that gap rather than endorsing it.
   */
  it("adds group x/y to child points as pure translation, ignoring group rotation", async () => {
    const child = makePath(
      "inner",
      [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
      false
    );
    const group = makeGroup("glyph_O", 10, 20, [child]);
    // A rotation the composition does not apply — proving it is dropped.
    group.transform.rotation = 90;

    textObjectToPaths.mockResolvedValue([group]);

    const lines = await textToGcode("O", 100, 200, 3, 500, 1000, "M4");

    // Pure translation: point + group offset + label origin.
    //   x: 1 + 10 + 100 = 111,  y: 1 + 20 + 200 = 221
    // A real 90-degree rotation about the group origin would NOT produce these.
    expect(lines[1]).toBe("G0 X111.000 Y221.000");
    expect(lines[3]).toBe("G1 X112.000 Y221.000 F1000 S500");
  });

  it("accumulates offsets through nested groups", async () => {
    const child = makePath(
      "inner",
      [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
      false
    );
    const inner = makeGroup("inner_group", 5, 5, [child]);
    const outer = makeGroup("outer_group", 10, 10, [inner]);

    textObjectToPaths.mockResolvedValue([outer]);

    const lines = await textToGcode("O", 0, 0, 3, 500, 1000, "M4");

    // 1 + 5 + 10 = 16 on both axes.
    expect(lines[1]).toBe("G0 X16.000 Y16.000");
  });

  it("passes the caller's text and fontSize through to the path builder", async () => {
    textObjectToPaths.mockResolvedValue([
      makePath(
        "c0",
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
        false
      ),
    ]);

    await textToGcode("HELLO", 0, 0, 2.5, 500, 1000, "M4");

    const arg = textObjectToPaths.mock.calls[0][0] as DesignObject;
    expect(arg.text).toBe("HELLO");
    expect(arg.fontSize).toBe(2.5);
    // The synthetic object is built at the origin; the label position is applied
    // during emit, not via the transform.
    expect(arg.transform.x).toBe(0);
    expect(arg.transform.y).toBe(0);
    expect(arg.transform.rotation).toBe(0);
  });
});
