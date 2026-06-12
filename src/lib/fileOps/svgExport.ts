import { useStore } from "../../app/store";
import { composeGroupChild } from "../geometry";
import type { DesignObject } from "../../app/types";

export function exportSvgContent(): string {
  const store = useStore.getState();
  const { objects, workspaceWidth, workspaceHeight } = store;

  let elements = "";

  function emitObject(obj: DesignObject): void {
    if (!obj.visible) return;

    // W1c (Fix 4): groups flatten through the ONE shared composition
    // (composeGroupChild — same function as the Viewport and gcodeGen) so
    // children export world-frame instead of silently vanishing. Child
    // `visible` is honored per child. Group semantics themselves do NOT
    // survive the round-trip (children come back top-level unless a
    // multi-subpath re-import re-groups them) — by design, minimal fix.
    if (obj.type === "group" && obj.children) {
      for (const child of obj.children) {
        emitObject(composeGroupChild(child, obj));
      }
      return;
    }

    const t = obj.transform;
    const stroke = obj.stroke;
    const sw = obj.strokeWidth;
    const fill = obj.fill || "none";
    const opacity = obj.opacity < 1 ? ` opacity="${obj.opacity}"` : "";

    // Emit rotate transform for rotated primitives (rect, ellipse, text, image).
    // Center = AABB center (x+w/2, y+h/2), consistent with D2 rotation-center convention.
    // path/line emit raw points — standalone rotated path/line still exports unrotated
    // (pre-existing limitation; tracked as a separate issue). Flattened group
    // children of type path/line inherit the same limitation for their OWN
    // r_c (the group's rotation r_g IS baked into the composed points).
    const rotation = t.rotation || 0;
    const rotTransform = Math.abs(rotation) > 0.001
      ? ` transform="rotate(${rotation}, ${t.x + t.width / 2}, ${t.y + t.height / 2})"`
      : "";

    switch (obj.type) {
      case "rectangle": {
        const rx = obj.cornerRadius ? ` rx="${obj.cornerRadius}"` : "";
        elements += `  <rect x="${t.x}" y="${t.y}" width="${t.width}" height="${t.height}"${rx} fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${opacity}${rotTransform}/>\n`;
        break;
      }
      case "ellipse": {
        const cx = t.x + t.width / 2;
        const cy = t.y + t.height / 2;
        elements += `  <ellipse cx="${cx}" cy="${cy}" rx="${t.width / 2}" ry="${t.height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${opacity}${rotTransform}/>\n`;
        break;
      }
      case "line": {
        if (obj.points && obj.points.length >= 2) {
          elements += `  <line x1="${obj.points[0].x}" y1="${obj.points[0].y}" x2="${obj.points[1].x}" y2="${obj.points[1].y}" stroke="${stroke}" stroke-width="${sw}"${opacity}/>\n`;
        }
        break;
      }
      case "path": {
        if (obj.points && obj.points.length >= 2) {
          let d = `M${obj.points[0].x},${obj.points[0].y}`;
          for (let i = 1; i < obj.points.length; i++) {
            const pt = obj.points[i];
            const prev = obj.points[i - 1];
            if (prev.handleOut && pt.handleIn) {
              d += ` C${prev.handleOut.x},${prev.handleOut.y} ${pt.handleIn.x},${pt.handleIn.y} ${pt.x},${pt.y}`;
            } else {
              d += ` L${pt.x},${pt.y}`;
            }
          }
          if (obj.closed) {
            // W1c (Fix 4): serialize the CLOSING curve's handles — Z alone
            // closes with a straight chord, silently degrading the closing
            // curve the cut pipeline now (F2) executes faithfully. Same
            // condition as the Viewport's closing-segment render.
            const last = obj.points[obj.points.length - 1];
            const first = obj.points[0];
            if (last.handleOut && first.handleIn) {
              d += ` C${last.handleOut.x},${last.handleOut.y} ${first.handleIn.x},${first.handleIn.y} ${first.x},${first.y}`;
            }
            d += " Z";
          }
          elements += `  <path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${opacity}/>\n`;
        }
        break;
      }
      case "text": {
        if (obj.text) {
          const fs = obj.fontSize || 16;
          const ff = obj.fontFamily || "sans-serif";
          const textFill = obj.fill || obj.stroke || "#e8e8e8";
          const textY = t.y + fs;
          const escaped = obj.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          elements += `  <text x="${t.x}" y="${textY}" font-size="${fs}" font-family="${ff}" fill="${textFill}"${opacity}${rotTransform}>${escaped}</text>\n`;
        }
        break;
      }
      case "image": {
        if (obj.imageData) {
          elements += `  <image x="${t.x}" y="${t.y}" width="${t.width}" height="${t.height}" href="${obj.imageData}"${opacity}${rotTransform}/>\n`;
        }
        break;
      }
    }
  }

  for (const obj of objects) emitObject(obj);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${workspaceWidth}mm" height="${workspaceHeight}mm" viewBox="0 0 ${workspaceWidth} ${workspaceHeight}">
${elements}</svg>`;
}
