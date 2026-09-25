/**
 * Pixi display-state placement helpers for the viewport (R2): rotation,
 * flip and text/image placement. Moved out of Viewport.tsx so they can be
 * tested against real pixi.js display objects.
 */
import { Container, Sprite, Text } from "pixi.js";
import type { DesignObject } from "../../app/types";
import { PX_PER_MM } from "../../lib/constants";

/**
 * R2 F4: the one placement for an image sprite, used at creation and on every
 * move. Pixi 8's width/height setters keep the current sign of the scale, so
 * the flip sign is set absolutely afterwards rather than toggled.
 */
export function placeSprite(sprite: Sprite, t: DesignObject["transform"]) {
  const px = t.x * PX_PER_MM;
  const py = t.y * PX_PER_MM;
  const pw = t.width * PX_PER_MM;
  const ph = t.height * PX_PER_MM;
  const sx = t.scaleX ?? 1;
  const sy = t.scaleY ?? 1;
  sprite.pivot.set(0, 0);
  sprite.rotation = 0;
  sprite.width = pw;
  sprite.height = ph;
  sprite.scale.x = Math.abs(sprite.scale.x) * (sx < 0 ? -1 : 1);
  sprite.scale.y = Math.abs(sprite.scale.y) * (sy < 0 ? -1 : 1);
  sprite.x = px + (sx < 0 ? pw : 0);
  sprite.y = py + (sy < 0 ? ph : 0);
}

/**
 * P8: Update position of text/image display object without destroying and rebuilding.
 * R2 F4: returns false for any other Container (template text: a Text plus a
 * dashed indicator drawn in world coordinates), meaning "cannot update in
 * place"; the caller rebuilds it instead.
 */
export function applyTextImageTransform(displayObj: Container, obj: DesignObject): boolean {
  if (!(displayObj instanceof Sprite) && !(displayObj instanceof Text)) return false;
  const t = obj.transform;
  const px = t.x * PX_PER_MM;
  const py = t.y * PX_PER_MM;
  const pw = t.width * PX_PER_MM;
  const ph = t.height * PX_PER_MM;
  const rot = ((t.rotation || 0) * Math.PI) / 180;

  // Reset pivot/position/rotation first
  displayObj.pivot.set(0, 0);
  displayObj.position.set(0, 0);
  displayObj.rotation = 0;

  if (displayObj instanceof Sprite) {
    placeSprite(displayObj, t);
  } else {
    displayObj.x = px;
    displayObj.y = py;
    const sx = t.scaleX ?? 1;
    const sy = t.scaleY ?? 1;
    if (sx < 0) {
      displayObj.scale.x = -1;
      displayObj.x += pw;
    } else {
      displayObj.scale.x = 1;
    }
    if (sy < 0) {
      displayObj.scale.y = -1;
      displayObj.y += ph;
    } else {
      displayObj.scale.y = 1;
    }
  }

  // Re-apply rotation if needed
  if (rot !== 0) {
    applyObjectRotation(displayObj, t);
  }
  return true;
}

/**
 * R2 F3: where a display object must sit to draw its box rotated about the
 * box centre. Pixi maps local p to position + R*S*(p - pivot), with the pivot
 * in local (pre-scale) units, so pivot = (centre - unrotated origin) / scale
 * and position = centre. For Graphics and template Containers (origin 0,
 * scale 1) that is today's pivot = position = centre.
 *
 * The unrotated origin is recovered from the current position, pivot and
 * scale, so the result is correct on a fresh object, after an earlier
 * placement by this function, and at rotation 0 (which undoes a rotation).
 */
export function rotationPlacement(
  cur: { x: number; y: number; scaleX: number; scaleY: number; pivotX: number; pivotY: number },
  t: { x: number; y: number; width: number; height: number; rotation?: number }
): { x: number; y: number; pivotX: number; pivotY: number; rotation: number } {
  const x0 = cur.x - cur.pivotX * cur.scaleX;
  const y0 = cur.y - cur.pivotY * cur.scaleY;
  const deg = t.rotation || 0;
  if (deg === 0) return { x: x0, y: y0, pivotX: 0, pivotY: 0, rotation: 0 };
  const cx = t.x * PX_PER_MM + (t.width * PX_PER_MM) / 2;
  const cy = t.y * PX_PER_MM + (t.height * PX_PER_MM) / 2;
  return {
    x: cx,
    y: cy,
    pivotX: cur.scaleX === 0 ? 0 : (cx - x0) / cur.scaleX,
    pivotY: cur.scaleY === 0 ? 0 : (cy - y0) / cur.scaleY,
    rotation: (deg * Math.PI) / 180,
  };
}

/** Apply rotation transform to a Pixi display object around its bounding box center */
export function applyObjectRotation(displayObj: Container, t: DesignObject["transform"]) {
  const r = rotationPlacement(
    {
      x: displayObj.x,
      y: displayObj.y,
      scaleX: displayObj.scale.x,
      scaleY: displayObj.scale.y,
      pivotX: displayObj.pivot.x,
      pivotY: displayObj.pivot.y,
    },
    t
  );
  displayObj.pivot.set(r.pivotX, r.pivotY);
  displayObj.position.set(r.x, r.y);
  displayObj.rotation = r.rotation;
}
