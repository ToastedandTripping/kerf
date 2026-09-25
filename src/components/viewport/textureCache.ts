/**
 * GPU textures for image objects, keyed by object id (R2 F5). Keyed by id, not
 * by data URL, to avoid retaining megabyte-sized base64 strings as Map keys.
 */
import { Texture } from "pixi.js";

// Cache for GPU textures keyed by object ID (avoids retaining megabyte-sized base64 strings as Map keys)
const textureCache = new Map<string, Texture>();

export function getOrCreateTexture(id: string, imageData: string): Texture {
  let tex = textureCache.get(id);
  if (tex) return tex;
  const img = new Image();
  img.src = imageData;
  tex = Texture.from(img);
  textureCache.set(id, tex);
  return tex;
}

/** Destroy cached textures whose object id is not in `activeIds`. */
export function evictTextures(activeIds: Set<string>) {
  for (const [id, tex] of textureCache) {
    if (!activeIds.has(id)) {
      tex.destroy(true);
      textureCache.delete(id);
    }
  }
}

/** Destroy every cached texture (the GPU context they belong to is gone). */
export function clearTextures() {
  for (const tex of textureCache.values()) tex.destroy(true);
  textureCache.clear();
}
