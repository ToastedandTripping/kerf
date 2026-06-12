import { useStore, generateId } from "../../app/store";
import type { DesignObject } from "../../app/types";

export function importDxfDirect(content: string) {
  parseDxfManual(content);
}

function parseDxfManual(content: string) {
  const store = useStore.getState();
  const layerColor = store.layers[store.activeLayerIndex]?.color || "#4a90e2";
  const newObjects: DesignObject[] = [];

  const lines = content.split("\n").map((l) => l.trim());
  let i = 0;

  function nextPair(): [number, string] | null {
    if (i >= lines.length - 1) return null;
    const code = parseInt(lines[i]);
    const value = lines[i + 1];
    i += 2;
    return [code, value];
  }

  while (i < lines.length) {
    if (lines[i] === "ENTITIES") { i++; break; }
    i++;
  }

  while (i < lines.length) {
    const pair = nextPair();
    if (!pair) break;
    const [code, value] = pair;

    if (code === 0 && value === "ENDSEC") break;

    if (code === 0 && value === "LINE") {
      let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
      while (i < lines.length) {
        const p = nextPair();
        if (!p) break;
        if (p[0] === 0) { i -= 2; break; }
        if (p[0] === 10) x1 = parseFloat(p[1]);
        if (p[0] === 20) y1 = parseFloat(p[1]);
        if (p[0] === 11) x2 = parseFloat(p[1]);
        if (p[0] === 21) y2 = parseFloat(p[1]);
      }
      newObjects.push({
        id: generateId(), type: "line", name: `DXF Line ${newObjects.length + 1}`,
        transform: { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), rotation: 0, scaleX: 1, scaleY: 1 },
        layerIndex: store.activeLayerIndex, visible: true, locked: false,
        fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
        points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
      });
    }

    if (code === 0 && value === "CIRCLE") {
      let cx = 0, cy = 0, r = 0;
      while (i < lines.length) {
        const p = nextPair();
        if (!p) break;
        if (p[0] === 0) { i -= 2; break; }
        if (p[0] === 10) cx = parseFloat(p[1]);
        if (p[0] === 20) cy = parseFloat(p[1]);
        if (p[0] === 40) r = parseFloat(p[1]);
      }
      newObjects.push({
        id: generateId(), type: "ellipse", name: `DXF Circle ${newObjects.length + 1}`,
        transform: { x: cx - r, y: cy - r, width: r * 2, height: r * 2, rotation: 0, scaleX: 1, scaleY: 1 },
        layerIndex: store.activeLayerIndex, visible: true, locked: false,
        fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
      });
    }

    if (code === 0 && value === "LWPOLYLINE") {
      const pts: Array<{ x: number; y: number }> = [];
      let closed = false;
      let currentX = 0, currentY = 0;
      while (i < lines.length) {
        const p = nextPair();
        if (!p) break;
        if (p[0] === 0) { i -= 2; break; }
        if (p[0] === 70) closed = (parseInt(p[1]) & 1) === 1;
        if (p[0] === 10) { currentX = parseFloat(p[1]); }
        if (p[0] === 20) {
          currentY = parseFloat(p[1]);
          pts.push({ x: currentX, y: currentY });
        }
      }
      if (pts.length >= 2) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pt of pts) {
          minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
          maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
        }
        newObjects.push({
          id: generateId(), type: "path", name: `DXF Polyline ${newObjects.length + 1}`,
          transform: { x: minX, y: minY, width: maxX - minX, height: maxY - minY, rotation: 0, scaleX: 1, scaleY: 1 },
          layerIndex: store.activeLayerIndex, visible: true, locked: false,
          fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
          points: pts, closed,
        });
      }
    }

    if (code === 0 && value === "ARC") {
      let cx = 0, cy = 0, r = 0, startAngle = 0, endAngle = 360;
      while (i < lines.length) {
        const p = nextPair();
        if (!p) break;
        if (p[0] === 0) { i -= 2; break; }
        if (p[0] === 10) cx = parseFloat(p[1]);
        if (p[0] === 20) cy = parseFloat(p[1]);
        if (p[0] === 40) r = parseFloat(p[1]);
        if (p[0] === 50) startAngle = parseFloat(p[1]);
        if (p[0] === 51) endAngle = parseFloat(p[1]);
      }
      if (r > 0 && startAngle !== endAngle) {
        let sweep = endAngle - startAngle;
        if (sweep <= 0) sweep += 360;
        const steps = Math.min(Math.ceil(Math.abs(sweep)), 360);
        const pts: Array<{ x: number; y: number }> = [];
        for (let s = 0; s <= steps; s++) {
          const angle = (startAngle + (sweep * s) / steps) * Math.PI / 180;
          pts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
        }
        if (pts.length >= 2) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const pt of pts) {
            minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
            maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
          }
          newObjects.push({
            id: generateId(), type: "path", name: `DXF Arc ${newObjects.length + 1}`,
            // W1b: no ||1 clamp — true bbox at birth (invariant), degenerate
            // axis-parallel geometry stays clickable via the hitTest ε band
            transform: { x: minX, y: minY, width: maxX - minX, height: maxY - minY, rotation: 0, scaleX: 1, scaleY: 1 },
            layerIndex: store.activeLayerIndex, visible: true, locked: false,
            fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
            points: pts, closed: false,
          });
        }
      }
    }
  }

  if (newObjects.length > 0) {
    store.withUndo("dxf-import", () => {
      newObjects.forEach(store.addObject);
      store.setSelectedIds(newObjects.map((o) => o.id));
    });
    store.addConsoleLine(`DXF imported: ${newObjects.length} objects`, "info");
  } else {
    store.addConsoleLine("DXF import: no supported entities found", "error");
  }
}
