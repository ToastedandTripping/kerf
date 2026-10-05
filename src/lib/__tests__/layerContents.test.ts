import { describe, it, expect } from "vitest";
import type { DesignObject, Layer } from "../../app/types";
import { DEFAULT_LAYERS } from "../../app/types";
import { layerLeaves, layerHasImage, layerHasObjects, excludedLayers } from "../layerContents";

function obj(
  id: string,
  type: DesignObject["type"],
  layerIndex: number,
  extra: Partial<DesignObject> = {}
): DesignObject {
  return {
    id,
    type,
    name: id,
    transform: { x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#000",
    strokeWidth: 1,
    opacity: 1,
    ...extra,
  };
}

function group(id: string, children: DesignObject[], layerIndex = 0): DesignObject {
  return obj(id, "group", layerIndex, { children });
}

function layers(patch: Record<number, Partial<Layer>>): Layer[] {
  return DEFAULT_LAYERS.map((l) => ({ ...l, ...(patch[l.index] ?? {}) }));
}

describe("layerContents", () => {
  it("layerLeaves expands nested groups to their leaves", () => {
    const tree = [
      group("g", [obj("a", "rectangle", 1), group("h", [obj("b", "image", 2)])]),
      obj("c", "path", 0),
    ];
    expect(
      layerLeaves(tree)
        .map((o) => o.id)
        .sort()
    ).toEqual(["a", "b", "c"]);
  });

  it("a top-level image counts for its own layer only", () => {
    const objs = [obj("i", "image", 2)];
    expect(layerHasImage(2, objs)).toBe(true);
    expect(layerHasImage(0, objs)).toBe(false);
  });

  it("grouped and nested images count for the leaf's layer, not the group's", () => {
    const objs = [group("g", [group("h", [obj("i", "image", 3)])], 0)];
    expect(layerHasImage(3, objs)).toBe(true);
    expect(layerHasImage(0, objs)).toBe(false);
  });

  it("a hidden image still counts", () => {
    expect(layerHasImage(1, [obj("i", "image", 1, { visible: false })])).toBe(true);
  });

  it("no image is false", () => {
    expect(layerHasImage(1, [obj("r", "rectangle", 1), obj("t", "text", 1)])).toBe(false);
    expect(layerHasImage(1, [])).toBe(false);
  });

  it("layerHasObjects sees nested leaves and ignores other layers", () => {
    const objs = [group("g", [obj("r", "rectangle", 4)], 0)];
    expect(layerHasObjects(4, objs)).toBe(true);
    expect(layerHasObjects(5, objs)).toBe(false);
  });

  it("excludedLayers names output-off and hidden layers that hold objects, in layer order", () => {
    const ls = layers({ 1: { output: false }, 3: { visible: false } });
    const objs = [obj("a", "path", 3), obj("b", "path", 1), obj("c", "path", 0)];
    expect(excludedLayers(ls, objs)).toEqual([
      { name: "Score", reason: "output off" },
      { name: "Custom 4", reason: "hidden" },
    ]);
  });

  it("excludedLayers ignores empty excluded layers and included layers", () => {
    const ls = layers({ 1: { output: false }, 3: { visible: false } });
    expect(excludedLayers(ls, [obj("c", "path", 0)])).toEqual([]);
  });

  it("output off is reported when a layer is both off and hidden", () => {
    const ls = layers({ 2: { output: false, visible: false } });
    expect(excludedLayers(ls, [obj("c", "path", 2)])).toEqual([
      { name: "Cut", reason: "output off" },
    ]);
  });

  it("a layer holding only a grouped leaf is excluded", () => {
    const ls = layers({ 5: { visible: false } });
    expect(excludedLayers(ls, [group("g", [obj("x", "path", 5)], 0)])).toEqual([
      { name: "Custom 6", reason: "hidden" },
    ]);
  });
});
