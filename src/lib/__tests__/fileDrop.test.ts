/**
 * refresh-cut-vs-screen F3 — a dropped PNG uses its embedded pHYs DPI, like
 * File > Import Image, and a metadata failure never cancels the import.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

vi.mock("../../app/App", () => ({ openImageImport: vi.fn() }));

vi.mock("../fileOps/imageImport", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../fileOps/imageImport")>();
  return {
    ...orig,
    detectImageDpi: vi.fn((data: Uint8Array, ext: string) => orig.detectImageDpi(data, ext)),
  };
});

import { openImageImport } from "../../app/App";
import { detectImageDpi } from "../fileOps/imageImport";
import { handleFileDrop } from "../fileDrop";

/** Minimal PNG: signature + IHDR placeholder + optional pHYs + IDAT (lifted from
 *  fileOps/__tests__/imageImport.test.ts makePngWithPhys). */
function makePng(ppu: number | null): Uint8Array<ArrayBuffer> {
  const u32 = (n: number) => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  // prettier-ignore
  const bytes = [
    137, 80, 78, 71, 13, 10, 26, 10, // signature
    ...u32(13),
    73,
    72,
    68,
    82,
    ...new Array(13).fill(0),
    0,
    0,
    0,
    0,
  ];
  if (ppu !== null) {
    bytes.push(...u32(9), 112, 72, 89, 115, ...u32(ppu), ...u32(ppu), 1, 0, 0, 0, 0);
  }
  bytes.push(0, 0, 0, 0, 73, 68, 65, 84, 0, 0, 0, 0);
  return new Uint8Array(bytes);
}

class FakeImage {
  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    this.width = 1200;
    this.height = 600;
    queueMicrotask(() => this.onload?.());
  }
}

const drop = (file: File) => handleFileDrop([file] as unknown as FileList);
const mocked = vi.mocked(openImageImport);

beforeEach(() => {
  mocked.mockClear();
  vi.stubGlobal("Image", FakeImage);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("F3 — dropped image DPI", () => {
  it("600-DPI pHYs PNG passes detectedDpi ≈ 600 as arg 6", async () => {
    drop(new File([makePng(23622)], "a.png", { type: "image/png" }));
    await vi.waitFor(() => expect(mocked).toHaveBeenCalled());
    expect(mocked.mock.calls[0][6]).toBeCloseTo(600, 0);
    expect(Math.abs((mocked.mock.calls[0][6] as number) - 600)).toBeLessThanOrEqual(0.5);
    expect(mocked.mock.calls[0][2]).toBe(1200);
    expect(mocked.mock.calls[0][3]).toBe(600);
  });

  it("PNG without pHYs → arg 6 undefined", async () => {
    drop(new File([makePng(null)], "b.png", { type: "image/png" }));
    await vi.waitFor(() => expect(mocked).toHaveBeenCalled());
    expect(mocked.mock.calls[0][6]).toBeUndefined();
  });

  it(".jpg name with pHYs bytes → arg 6 undefined (PNG detector only)", async () => {
    drop(new File([makePng(23622)], "c.jpg", { type: "image/jpeg" }));
    await vi.waitFor(() => expect(mocked).toHaveBeenCalled());
    expect(mocked.mock.calls[0][6]).toBeUndefined();
  });

  it("read failure: arrayBuffer rejects → dialog still opens, dpi undefined", async () => {
    const file = new File([makePng(23622)], "d.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", {
      value: () => Promise.reject(new Error("read failed")),
    });
    drop(file);
    await vi.waitFor(() => expect(mocked).toHaveBeenCalled());
    expect(mocked.mock.calls[0][6]).toBeUndefined();
    expect(mocked.mock.calls[0][2]).toBe(1200);
    expect(mocked.mock.calls[0][3]).toBe(600);
  });

  it("detector throws → dialog still opens, dpi undefined", async () => {
    vi.mocked(detectImageDpi).mockImplementationOnce(() => {
      throw new Error("hostile chunk");
    });
    drop(new File([makePng(23622)], "e.png", { type: "image/png" }));
    await vi.waitFor(() => expect(mocked).toHaveBeenCalled());
    expect(mocked.mock.calls[0][6]).toBeUndefined();
    expect(mocked.mock.calls[0][2]).toBe(1200);
    expect(mocked.mock.calls[0][3]).toBe(600);
  });
});
