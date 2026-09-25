/**
 * Pixi display-state placement helpers for the viewport (R2): rotation,
 * flip and text/image placement. Moved out of Viewport.tsx so they can be
 * tested against real pixi.js display objects.
 */
import { Container, Sprite, Text } from "pixi.js";
import type { DesignObject } from "../../app/types";
import { PX_PER_MM } from "../../lib/constants";

/** P8: Update position of text/image display object without destroying and rebuilding */
export function applyTextImageTransform(displayObj: Container, obj: DesignObject) {
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
    displayObj.x = px;
    displayObj.y = py;
    displayObj.width = pw;
    displayObj.height = ph;
    const sx = t.scaleX ?? 1;
    const sy = t.scaleY ?? 1;
    if (sx < 0) {
      displayObj.scale.x *= -1;
      displayObj.x += pw;
    }
    if (sy < 0) {
      displayObj.scale.y *= -1;
      displayObj.y += ph;
    }
  } else if (displayObj instanceof Text) {
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
  } else {
    // Container (template text) -- update child positions
    for (const child of displayObj.children) {
      if (child instanceof Text) {
        child.x = px;
        child.y = py;
      }
    }
  }

  // Re-apply rotation if needed
  if (rot !== 0) {
    applyObjectRotation(displayObj, t);
  }
}

/** Apply rotation transform to a Pixi display object around its bounding box center */
export function applyObjectRotation(displayObj: Container, t: DesignObject["transform"]) {
  const rot = ((t.rotation || 0) * Math.PI) / 180;
  if (rot === 0) return;
  const cx = t.x * PX_PER_MM + (t.width * PX_PER_MM) / 2;
  const cy = t.y * PX_PER_MM + (t.height * PX_PER_MM) / 2;
  displayObj.pivot.set(cx, cy);
  displayObj.position.set(cx, cy);
  displayObj.rotation = rot;
}
