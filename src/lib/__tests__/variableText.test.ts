import { describe, it, expect } from "vitest";
import {
  extractPlaceholders,
  substitutePlaceholders,
  generateSerialValues,
  hasPlaceholders,
  parseCsv,
} from "../variableText";
import type { DesignObject } from "../../app/types";

function makeTextObject(text: string): DesignObject {
  return {
    id: "test_1",
    type: "text",
    name: "Test",
    transform: { x: 0, y: 0, width: 100, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#ffffff",
    strokeWidth: 1,
    opacity: 1,
    text,
  };
}

describe("extractPlaceholders", () => {
  it("extracts a single placeholder", () => {
    expect(extractPlaceholders("Hello {name}")).toEqual(["name"]);
  });

  it("extracts multiple unique placeholders (deduplicates)", () => {
    expect(extractPlaceholders("{a} and {b} and {a}")).toEqual(["a", "b"]);
  });

  it("returns empty array for no placeholders", () => {
    expect(extractPlaceholders("no placeholders")).toEqual([]);
  });
});

describe("substitutePlaceholders", () => {
  it("substitutes a single placeholder", () => {
    expect(substitutePlaceholders("Hi {name}", { name: "Lee" })).toBe("Hi Lee");
  });

  it("substitutes multiple placeholders", () => {
    expect(substitutePlaceholders("{a}-{b}", { a: "X", b: "Y" })).toBe("X-Y");
  });
});

describe("generateSerialValues", () => {
  it("generates zero-padded serial values with prefix", () => {
    const result = generateSerialValues({
      start: 1,
      increment: 1,
      count: 3,
      zeroPad: 3,
      prefix: "SN-",
      suffix: "",
    });
    expect(result).toEqual(["SN-001", "SN-002", "SN-003"]);
  });
});

describe("parseCsv", () => {
  it("parses CSV text into headers and rows", () => {
    const result = parseCsv("name,city\nLee,Helsinki");
    expect(result.headers).toEqual(["name", "city"]);
    expect(result.rows).toEqual([["Lee", "Helsinki"]]);
  });
});

describe("hasPlaceholders", () => {
  it("returns true for object with placeholder text", () => {
    expect(hasPlaceholders(makeTextObject("{foo}"))).toBe(true);
  });

  it("returns false for object with plain text", () => {
    expect(hasPlaceholders(makeTextObject("plain"))).toBe(false);
  });
});
