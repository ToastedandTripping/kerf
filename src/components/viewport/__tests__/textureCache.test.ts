/**
 * R2 F5 — decode-gated image textures. Nothing is returned until the image
 * has decoded; a failed decode is remembered so the caller can draw the
 * placeholder; clearTextures and eviction never leave an id stuck pending.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Texture, TextureSource } from "pixi.js";
import {
  clearTextures,
  evictTextures,
  getReadyTexture,
  isTextureFailed,
  setTextureReadyListener,
} from "../textureCache";

interface Deferred {
  img: HTMLImageElement;
  resolve: () => void;
  reject: (e: unknown) => void;
}

const URL_A = "data:image/png;base64,AAAA";
let decodes: Deferred[] = [];
let created: Texture[] = [];
let listener: ReturnType<typeof vi.fn<() => void>>;
const originalDecode = HTMLImageElement.prototype.decode;

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  decodes = [];
  created = [];
  HTMLImageElement.prototype.decode = vi.fn(function (this: HTMLImageElement) {
    return new Promise<void>((resolve, reject) => {
      decodes.push({ img: this, resolve, reject });
    });
  });
  vi.spyOn(Texture, "from").mockImplementation(() => {
    const t = new Texture({ source: new TextureSource({ width: 200, height: 100 }) });
    vi.spyOn(t, "destroy");
    created.push(t);
    return t;
  });
  clearTextures();
  listener = vi.fn<() => void>();
  setTextureReadyListener(listener);
});

afterEach(() => {
  setTextureReadyListener(null);
  clearTextures();
  HTMLImageElement.prototype.decode = originalDecode;
  vi.restoreAllMocks();
});

describe("textureCache (R2 F5)", () => {
  it("returns null while pending, then the same Texture once decoded", async () => {
    expect(getReadyTexture("a", URL_A)).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(getReadyTexture("a", URL_A)).toBeNull();
    decodes[0].resolve();
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    const tex = getReadyTexture("a", URL_A);
    expect(tex).toBeInstanceOf(Texture);
    expect(getReadyTexture("a", URL_A)).toBe(tex);
    expect(decodes).toHaveLength(1);
  });

  it("a rejected decode of an incomplete image marks the id failed and notifies", async () => {
    getReadyTexture("a", URL_A);
    decodes[0].reject(new Error("EncodingError"));
    await flush();
    expect(isTextureFailed("a")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getReadyTexture("a", URL_A)).toBeNull();
    expect(decodes).toHaveLength(1);
  });

  it("a rejected decode of an image that is still displayable counts as success", async () => {
    getReadyTexture("a", URL_A);
    const img = decodes[0].img;
    Object.defineProperty(img, "complete", { value: true, configurable: true });
    Object.defineProperty(img, "naturalWidth", { value: 200, configurable: true });
    decodes[0].reject(new Error("EncodingError"));
    await flush();
    expect(isTextureFailed("a")).toBe(false);
    expect(getReadyTexture("a", URL_A)).toBeInstanceOf(Texture);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a load that settles after clearTextures writes nothing and does not notify", async () => {
    getReadyTexture("a", URL_A);
    clearTextures();
    decodes[0].resolve();
    await flush();
    expect(listener).not.toHaveBeenCalled();
    for (const t of created) expect(t.destroy).toHaveBeenCalled();
    expect(isTextureFailed("a")).toBe(false);
  });

  it("after clearTextures the next request starts a fresh load (no stuck pending mark)", async () => {
    getReadyTexture("a", URL_A);
    clearTextures();
    decodes[0].resolve();
    await flush();
    expect(getReadyTexture("a", URL_A)).toBeNull();
    expect(decodes).toHaveLength(2);
    decodes[1].resolve();
    await flush();
    expect(getReadyTexture("a", URL_A)).toBeInstanceOf(Texture);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("an id evicted while pending is not cached and loads afresh next time", async () => {
    getReadyTexture("a", URL_A);
    evictTextures(new Set());
    decodes[0].resolve();
    await flush();
    for (const t of created) expect(t.destroy).toHaveBeenCalled();
    expect(getReadyTexture("a", URL_A)).toBeNull();
    expect(decodes).toHaveLength(2);
  });

  it("eviction forgets a failed id; an active id keeps its texture", async () => {
    getReadyTexture("a", URL_A);
    getReadyTexture("b", URL_A);
    decodes[0].reject(new Error("bad"));
    decodes[1].resolve();
    await flush();
    const b = getReadyTexture("b", URL_A);
    expect(isTextureFailed("a")).toBe(true);
    evictTextures(new Set(["b"]));
    expect(isTextureFailed("a")).toBe(false);
    expect(getReadyTexture("b", URL_A)).toBe(b);
    expect(b!.destroy).not.toHaveBeenCalled();
  });

  it("a stale load settling after a fresh load for the same id started changes nothing", async () => {
    getReadyTexture("a", URL_A);
    clearTextures();
    expect(getReadyTexture("a", URL_A)).toBeNull();
    expect(decodes).toHaveLength(2);
    decodes[0].resolve();
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(getReadyTexture("a", URL_A)).toBeNull();
    expect(decodes).toHaveLength(2);
    decodes[1].resolve();
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getReadyTexture("a", URL_A)).toBeInstanceOf(Texture);
  });

  it("eviction destroys a cached texture whose id is no longer active", async () => {
    getReadyTexture("c", URL_A);
    decodes[0].resolve();
    await flush();
    const c = getReadyTexture("c", URL_A)!;
    evictTextures(new Set());
    expect(c.destroy).toHaveBeenCalled();
    expect(getReadyTexture("c", URL_A)).toBeNull();
    expect(decodes).toHaveLength(2);
  });

  it("clearTextures destroys every cached texture", async () => {
    getReadyTexture("a", URL_A);
    decodes[0].resolve();
    await flush();
    const a = getReadyTexture("a", URL_A)!;
    clearTextures();
    expect(a.destroy).toHaveBeenCalled();
  });
});
