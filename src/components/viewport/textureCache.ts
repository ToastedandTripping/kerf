/**
 * GPU textures for image objects, keyed by object id (R2 F5). Keyed by id, not
 * by data URL, to avoid retaining megabyte-sized base64 strings as Map keys
 * (which is also why pixi's URL-keyed Assets.load is not used).
 *
 * Decode-gated: a texture is handed out only after its image has decoded,
 * because a Pixi 8 ImageSource made from an undecoded image never gains
 * pixels. While a load is pending nothing is returned (the object draws
 * nothing); a failed decode is remembered so the caller draws the placeholder.
 *
 * Pending loads have no timeout: a decode that never settles leaves that id
 * blank until the next clearTextures() (app reload, or HMR in dev). Accepted
 * and stated in the R2 plan; it never blocks any other image.
 */
import { Texture } from "pixi.js";

const textureCache = new Map<string, Texture>();
const pending = new Set<string>();
const failed = new Set<string>();
// Bumped by clearTextures(): a load started under an older generation writes nothing.
let generation = 0;
let readyListener: (() => void) | null = null;

/** Register the one callback told when any load settles (success or failure). */
export function setTextureReadyListener(fn: (() => void) | null) {
  readyListener = fn;
}

/** The cached texture for `id`, or null while its load is pending or after it failed. */
export function getReadyTexture(id: string, dataUrl: string): Texture | null {
  const tex = textureCache.get(id);
  if (tex) return tex;
  if (pending.has(id) || failed.has(id)) return null;
  startLoad(id, dataUrl);
  return null;
}

/** True when the image for `id` could not be decoded. */
export function isTextureFailed(id: string): boolean {
  return failed.has(id);
}

function decodeImage(img: HTMLImageElement, dataUrl: string): Promise<void> {
  if (typeof img.decode === "function") {
    img.src = dataUrl;
    return img.decode();
  }
  return new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("image load failed"));
    img.src = dataUrl;
  });
}

function startLoad(id: string, dataUrl: string) {
  const gen = generation;
  pending.add(id);
  const img = new Image();
  decodeImage(img, dataUrl)
    // Chromium's decode() can reject for an image it will still display (a
    // very large source, for one); an image that loaded anyway is a success.
    .then(
      () => true,
      () => img.complete && img.naturalWidth > 0
    )
    .then((ok) => settle(id, gen, ok ? img : null));
}

function settle(id: string, gen: number, img: HTMLImageElement | null) {
  // Stale (cleared since) or evicted while pending: write nothing, notify no one.
  // clearTextures()/evictTextures() already dropped the pending mark. No
  // texture is created on this path, so there is nothing to destroy.
  if (gen !== generation || !pending.has(id)) return;
  pending.delete(id);
  let tex: Texture | null = null;
  if (img) {
    try {
      tex = Texture.from(img);
    } catch (err) {
      // Not silent: logged, and the id is marked failed so the placeholder draws.
      console.error("Image texture creation failed:", err);
    }
  }
  if (tex) {
    textureCache.set(id, tex);
  } else {
    // Not silent: the caller draws the crossed-box placeholder for a failed id.
    failed.add(id);
  }
  readyListener?.();
}

/** Destroy cached textures, and forget pending and failed ids, not in `activeIds`. */
export function evictTextures(activeIds: Set<string>) {
  for (const [id, tex] of textureCache) {
    if (!activeIds.has(id)) {
      tex.destroy(true);
      textureCache.delete(id);
    }
  }
  for (const id of pending) if (!activeIds.has(id)) pending.delete(id);
  for (const id of failed) if (!activeIds.has(id)) failed.delete(id);
}

/** Destroy every cached texture and forget every pending and failed id. */
export function clearTextures() {
  for (const tex of textureCache.values()) tex.destroy(true);
  textureCache.clear();
  pending.clear();
  failed.clear();
  generation++;
}
