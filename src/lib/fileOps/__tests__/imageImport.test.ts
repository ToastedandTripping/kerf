import { describe, it, expect } from "vitest";
import { parsePngPhysDpi } from "../imageImport";

/**
 * Build a minimal PNG-like byte array with a pHYs chunk.
 * Only includes enough structure for parsePngPhysDpi to work:
 * signature + IHDR placeholder + pHYs chunk.
 */
function makePngWithPhys(ppu: number, unit: number): Uint8Array {
  // PNG signature
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];

  // Minimal IHDR chunk (13 bytes data) — just a placeholder so pHYs isn't first
  const ihdrType = [73, 72, 68, 82]; // "IHDR"
  const ihdrData = new Array(13).fill(0);
  const ihdrLen = [0, 0, 0, 13];
  const ihdrCrc = [0, 0, 0, 0]; // dummy CRC

  // pHYs chunk: 9 bytes data (4B x-ppu, 4B y-ppu, 1B unit)
  const physType = [112, 72, 89, 115]; // "pHYs"
  const physLen = [0, 0, 0, 9];
  const physData = [
    (ppu >> 24) & 0xff,
    (ppu >> 16) & 0xff,
    (ppu >> 8) & 0xff,
    ppu & 0xff, // x-ppu
    (ppu >> 24) & 0xff,
    (ppu >> 16) & 0xff,
    (ppu >> 8) & 0xff,
    ppu & 0xff, // y-ppu
    unit,
  ];
  const physCrc = [0, 0, 0, 0]; // dummy CRC

  // IDAT chunk (signals end of pre-data chunks for the parser)
  const idatType = [73, 68, 65, 84]; // "IDAT"
  const idatLen = [0, 0, 0, 0];
  const idatCrc = [0, 0, 0, 0];

  const bytes = [
    ...sig,
    ...ihdrLen,
    ...ihdrType,
    ...ihdrData,
    ...ihdrCrc,
    ...physLen,
    ...physType,
    ...physData,
    ...physCrc,
    ...idatLen,
    ...idatType,
    ...idatCrc,
  ];
  return new Uint8Array(bytes);
}

describe("parsePngPhysDpi — F21 PNG pHYs DPI extraction", () => {
  it("returns null for non-PNG data", () => {
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(parsePngPhysDpi(data)).toBeNull();
  });

  it("returns null for PNG without pHYs chunk", () => {
    // Just the signature
    const data = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 68, 65, 84, 0, 0, 0, 0,
    ]);
    expect(parsePngPhysDpi(data)).toBeNull();
  });

  it("300 DPI PNG: ppu = round(300 × 39.3701) = 11811 → DPI ≈ 300", () => {
    const ppu300 = Math.round(300 * 39.3701); // 11811
    const data = makePngWithPhys(ppu300, 1); // unit=1 (meter)
    const dpi = parsePngPhysDpi(data);
    expect(dpi).not.toBeNull();
    expect(dpi!).toBeCloseTo(300, 0);
  });

  it("96 DPI PNG: ppu = round(96 × 39.3701) = 3780 → DPI ≈ 96", () => {
    const ppu96 = Math.round(96 * 39.3701); // 3780
    const data = makePngWithPhys(ppu96, 1);
    const dpi = parsePngPhysDpi(data);
    expect(dpi).not.toBeNull();
    expect(dpi!).toBeCloseTo(96, 0);
  });

  it("unit=0 (unknown): returns null (cannot derive DPI without unit specifier)", () => {
    const data = makePngWithPhys(3780, 0); // unit=0 = aspect ratio only
    expect(parsePngPhysDpi(data)).toBeNull();
  });

  it("returns null for too-short data", () => {
    expect(parsePngPhysDpi(new Uint8Array([137, 80, 78]))).toBeNull();
    expect(parsePngPhysDpi(new Uint8Array([]))).toBeNull();
  });
});
