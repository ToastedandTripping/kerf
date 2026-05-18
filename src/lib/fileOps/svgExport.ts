import { useStore } from "../../app/store";

export function exportSvgContent(): string {
  const store = useStore.getState();
  const { objects, workspaceWidth, workspaceHeight } = store;

  let elements = "";

  for (const obj of objects) {
    if (!obj.visible) continue;
    const t = obj.transform;
    const stroke = obj.stroke;
    const sw = obj.strokeWidth;
    const fill = obj.fill || "none";
    const opacity = obj.opacity < 1 ? ` opacity="${obj.opacity}"` : "";

    switch (obj.type) {
      case "rectangle": {
        const rx = obj.cornerRadius ? ` rx="${obj.cornerRadius}"` : "";
        elements += `  <rect x="${t.x}" y="${t.y}" width="${t.width}" height="${t.height}"${rx} fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${opacity}/>\n`;
        break;
      }
      case "ellipse": {
        const cx = t.x + t.width / 2;
        const cy = t.y + t.height / 2;
        elements += `  <ellipse cx="${cx}" cy="${cy}" rx="${t.width / 2}" ry="${t.height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${opacity}/>\n`;
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
          if (obj.closed) d += " Z";
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
          elements += `  <text x="${t.x}" y="${textY}" font-size="${fs}" font-family="${ff}" fill="${textFill}"${opacity}>${escaped}</text>\n`;
        }
        break;
      }
      case "image": {
        if (obj.imageData) {
          elements += `  <image x="${t.x}" y="${t.y}" width="${t.width}" height="${t.height}" href="${obj.imageData}"${opacity}/>\n`;
        }
        break;
      }
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${workspaceWidth}mm" height="${workspaceHeight}mm" viewBox="0 0 ${workspaceWidth} ${workspaceHeight}">
${elements}</svg>`;
}
