/**
 * Safety S2: the material test never arms a stationary beam.
 *
 * DECISIONS 2026-09-10: constant power (M3) exists for the stationary beam, not
 * for cutting. The material test is a cutting job, so every M3/M4 mode line it
 * emits carries S0, and positive power appears only as the S word of a G1
 * motion line. The border follows the operator's chosen mode like the cells.
 *
 * Real generateMaterialTestGcode, real textToGcode and real textObjectToPaths
 * run. Only the font FILE load (opentype.load, which fetches) is substituted
 * with a synthetic square glyph, so labels produce real closed contours.
 *
 * Assertions parse G-code words only; no coordinate or Y sign is asserted, so
 * these stay valid when S3 mirrors Y. S3 runs every invariant under both
 * originTop values, and adds A3-7/A3-8 (the mirror itself).
 */
import { describe, it, expect, vi } from "vitest";

// Synthetic font: a 500x700-unit square glyph per character (copied from
// src/lib/__tests__/creatorInvariants.test.ts).
vi.mock("opentype.js", () => {
  const makeFont = () => ({
    unitsPerEm: 1000,
    getAdvanceWidth: (text: string, fontSize: number) => text.length * 500 * (fontSize / 1000),
    stringToGlyphs: (text: string) =>
      text.split("").map(() => ({
        advanceWidth: 500,
        getPath: () => ({
          commands: [
            { type: "M", x: 0, y: 0 },
            { type: "L", x: 500, y: 0 },
            { type: "L", x: 500, y: -700 },
            { type: "L", x: 0, y: -700 },
            { type: "Z" },
          ],
        }),
      })),
  });
  return {
    default: {
      load: vi.fn().mockImplementation(() => Promise.resolve(makeFont())),
    },
  };
});

import {
  generateFrameGcode,
  generateMaterialTestGcode,
  type MaterialTestOptions,
  type PowerMode,
} from "../materialTestGcode";

const S_MAX = 1000;

type Words = Map<string, number[]>;

/** Strip `;` comments and parse letter/number words. Null for blank lines. */
function parseLine(raw: string): Words | null {
  const code = raw.split(";")[0].trim();
  if (code === "") return null;
  const words: Words = new Map();
  for (const m of code.matchAll(/([A-Z])\s*(-?\d*\.?\d+)/g)) {
    const list = words.get(m[1]) ?? [];
    list.push(Number(m[2]));
    words.set(m[1], list);
  }
  return words;
}

const has = (w: Words, letter: string, value?: number) =>
  (w.get(letter) ?? []).some((v) => value === undefined || v === value);
const isMode = (w: Words) => has(w, "M", 3) || has(w, "M", 4);

function makeOpts(mode: "cut" | "fill", powerMode: PowerMode): MaterialTestOptions {
  return {
    powerMin: 20,
    powerMax: 80,
    powerSteps: 3,
    speedMin: 500,
    speedMax: 1500,
    speedSteps: 2,
    cellWidth: 5,
    cellHeight: 1,
    cellGap: 2,
    mode,
    powerMode,
    labels: true,
    cutBorder: true,
  };
}

/** Group raw lines under the most recent comment-only header line. */
function blocks(program: string, prefix: string): string[][] {
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const raw of program.split("\n")) {
    const t = raw.trim();
    if (t.startsWith(";")) {
      current = t.startsWith(prefix) ? [t] : null;
      if (current) out.push(current);
      continue;
    }
    if (current) current.push(raw);
  }
  return out;
}

const RUNS: Array<["cut" | "fill", PowerMode, boolean]> = [];
for (const originTop of [false, true]) {
  for (const mode of ["cut", "fill"] as const) {
    for (const pm of ["M3", "M4"] as const) RUNS.push([mode, pm, originTop]);
  }
}

describe.each(RUNS)(
  "material test program (mode=%s, powerMode=%s, originTop=%s)",
  (mode, powerMode, originTop) => {
    const opts = makeOpts(mode, powerMode);
    const cells = opts.powerSteps * opts.speedSteps;
    const program = () => generateMaterialTestGcode(opts, S_MAX, originTop);
    const parsed = async () =>
      (await program())
        .split("\n")
        .map(parseLine)
        .filter((w): w is Words => w !== null);

    it("I1: every M3/M4 line carries S equal to 0", async () => {
      const modeLines = (await parsed()).filter(isMode);
      expect(modeLines.length).toBeGreaterThan(0);
      for (const w of modeLines) {
        expect(w.get("S")).toEqual([0]);
      }
    });

    it("I2: every line with S > 0 is a G1 with an X or Y word", async () => {
      const powered = (await parsed()).filter((w) => (w.get("S") ?? []).some((v) => v > 0));
      expect(powered.length).toBeGreaterThan(0);
      for (const w of powered) {
        expect(has(w, "G", 1)).toBe(true);
        expect(has(w, "X") || has(w, "Y")).toBe(true);
      }
    });

    it("I3: every M3/M4 word equals the chosen power mode", async () => {
      const want = powerMode === "M3" ? 3 : 4;
      for (const w of (await parsed()).filter(isMode)) {
        for (const m of w.get("M") ?? []) {
          if (m === 3 || m === 4) expect(m).toBe(want);
        }
      }
    });

    it("I4: anti-vacuity: enough mode lines, and the border has one after its G0", async () => {
      const lines = await parsed();
      expect(lines.filter(isMode).length).toBeGreaterThanOrEqual(cells + 1);
      const border = blocks(await program(), "; --- Cut border");
      expect(border).toHaveLength(1);
      const body = border[0]
        .slice(1)
        .map(parseLine)
        .filter((w): w is Words => w !== null);
      expect(has(body[0], "G", 0)).toBe(true);
      expect(isMode(body[1])).toBe(true);
    });

    it("P1 (control): every cell G1 carries the cell's positive power", async () => {
      const cellBlocks = blocks(await program(), "; Cell P");
      expect(cellBlocks).toHaveLength(cells);
      for (const [header, ...body] of cellBlocks) {
        const p = Number(/P(\d+)%/.exec(header)![1]);
        const want = Math.round((p / 100) * S_MAX);
        expect(want).toBeGreaterThan(0);
        const g1 = body.map(parseLine).filter((w): w is Words => w !== null && has(w, "G", 1));
        expect(g1.length).toBeGreaterThan(0);
        for (const w of g1) expect(w.get("S")).toEqual([want]);
      }
    });

    it("P2 (control): every label G1 carries the label power", async () => {
      const labelBlocks = blocks(await program(), "; Label:");
      expect(labelBlocks.length).toBeGreaterThan(0);
      const g1 = labelBlocks
        .flatMap((b) => b.slice(1))
        .map(parseLine)
        .filter((w): w is Words => w !== null && has(w, "G", 1));
      expect(g1.length).toBeGreaterThan(0);
      for (const w of g1) expect(w.get("S")).toEqual([Math.round(S_MAX * 0.12)]);
    });
  }
);

describe.each([false, true])("frame trace (originTop=%s)", (originTop) => {
  it("F1: generateFrameGcode has no M3/M4 word and no S word", () => {
    const lines = generateFrameGcode(30, 20, originTop)
      .split("\n")
      .map(parseLine)
      .filter((w): w is Words => w !== null);
    expect(lines.length).toBeGreaterThan(0);
    for (const w of lines) {
      expect(isMode(w)).toBe(false);
      expect(w.has("S")).toBe(false);
    }
  });
});

// --- S3: the mirror (A3-7, A3-8) ---

/** All Y values outside comments, in program order. */
function yValues(program: string): number[] {
  const out: number[] = [];
  for (const raw of program.split("\n")) {
    const w = parseLine(raw);
    if (w) out.push(...(w.get("Y") ?? []));
  }
  return out;
}

/** The program with every Y word's number blanked: what must NOT change. */
function withoutY(program: string): string[] {
  return program.split("\n").map((raw) => {
    const cut = raw.indexOf(";");
    const code = cut === -1 ? raw : raw.slice(0, cut);
    return code.replace(/Y-?\d*\.?\d+/g, "Y#") + (cut === -1 ? "" : raw.slice(cut));
  });
}

/** Y words negate one-for-one (with -0 read as 0) and nothing else changes. */
function expectMirrorOf(top: string, bottom: string) {
  expect(withoutY(top)).toEqual(withoutY(bottom));
  const a = yValues(top);
  const b = yValues(bottom);
  expect(a.length).toBe(b.length);
  expect(a.some((v) => v !== 0)).toBe(true);
  a.forEach((v, i) => expect(v + 0).toBe(-b[i] + 0));
}

describe("S3 — material test mirrored on origin-top", () => {
  const BED = 415;
  const opts: MaterialTestOptions = { ...makeOpts("fill", "M4"), cellHeight: 3 };

  it("A3-7: origin-top grid (labels and border on) lies in [-bed, 0] and is the Y-mirror", async () => {
    const top = await generateMaterialTestGcode(opts, S_MAX, true);
    const bottom = await generateMaterialTestGcode(opts, S_MAX, false);
    const ys = yValues(top);
    expect(ys.some((v) => v < 0)).toBe(true);
    for (const v of ys) {
      expect(v).toBeLessThanOrEqual(0);
      expect(v).toBeGreaterThanOrEqual(-BED);
    }
    expectMirrorOf(top, bottom);
  });

  it("A3-7 control: origin-bottom grid keeps positive Y, exactly S2's layout", async () => {
    const bottom = await generateMaterialTestGcode(opts, S_MAX, false);
    const ys = yValues(bottom);
    expect(ys.some((v) => v > 0)).toBe(true);
    for (const v of ys) expect(v).toBeGreaterThanOrEqual(0);
    // S2's first cell lead-in (labels on: startX = startY = 15).
    expect(bottom).toContain("G0 X15.000 Y15.000");
    expect(bottom).not.toContain("Y-");
  });

  it("A3-8: origin-top frame lies in [-bed, 0] and is the Y-mirror", () => {
    const top = generateFrameGcode(30, 20, true);
    const bottom = generateFrameGcode(30, 20, false);
    for (const v of yValues(top)) {
      expect(v).toBeLessThanOrEqual(0);
      expect(v).toBeGreaterThanOrEqual(-BED);
    }
    expect(top).toContain("G0 X10 Y-10");
    expect(bottom).toContain("G0 X10 Y10");
    expectMirrorOf(top, bottom);
  });
});
