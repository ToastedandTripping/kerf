import { useStore, generateId } from "../../app/store";
import type { DesignObject } from "../../app/types";

export function importDxfDirect(content: string) {
  parseDxfManual(content);
}

/** Interpolate arc points between two vertices given a DXF bulge value.
 * Bulge = tan(included_angle / 4). Positive = CCW arc. */
function bulgeToArcPoints(
  x1: number, y1: number,
  x2: number, y2: number,
  bulge: number
): Array<{ x: number; y: number }> {
  if (Math.abs(bulge) < 1e-10) return [{ x: x2, y: y2 }];

  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-10) return [{ x: x2, y: y2 }];

  // Half-angle from bulge
  const alpha = 4 * Math.atan(bulge); // included angle
  const r = dist / (2 * Math.abs(Math.sin(alpha / 2)));

  // Center of the arc
  const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
  const d = r * Math.cos(alpha / 2); // distance from midpoint to center
  const perpX = -dy / dist, perpY = dx / dist;
  // Sign: positive bulge = CCW = center is to the left of the chord
  const sign = bulge > 0 ? 1 : -1;
  const cX = midX + sign * d * perpX;
  const cY = midY + sign * d * perpY;

  const startAngle = Math.atan2(y1 - cY, x1 - cX);

  let sweep = alpha; // positive bulge = CCW
  if (bulge < 0) sweep = -Math.abs(alpha);

  // Adaptive step count: same chord-deviation formula as svgImport
  const tolerance = 0.05;
  const thetaPerSeg = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / r)));
  const steps = Math.max(4, Math.min(360, Math.ceil(Math.abs(sweep) / thetaPerSeg)));

  const result: Array<{ x: number; y: number }> = [];
  for (let s = 1; s <= steps; s++) {
    const t = startAngle + sweep * (s / steps);
    result.push({ x: cX + r * Math.cos(t), y: cY + r * Math.sin(t) });
  }
  return result;
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

  // --- Scan HEADER for $INSUNITS ---
  let unitsScale = 1.0; // default: mm
  {
    let hi = 0;
    let inHeader = false;
    let foundInsunits = false;
    while (hi < lines.length - 1) {
      const code = parseInt(lines[hi]);
      const value = lines[hi + 1];
      hi += 2;
      if (code === 0 && value === "SECTION") {
        // peek at next pair to see if it's HEADER
      }
      if (code === 2 && value === "HEADER") { inHeader = true; continue; }
      if (inHeader && code === 0 && value === "ENDSEC") break;
      if (inHeader && code === 9 && value === "$INSUNITS") {
        foundInsunits = true;
        continue;
      }
      if (foundInsunits && code === 70) {
        const units = parseInt(value);
        // DXF $INSUNITS: 1=inches, 2=feet, 4=mm, 5=cm, 6=m
        switch (units) {
          case 1: unitsScale = 25.4; break;         // inches → mm
          case 2: unitsScale = 304.8; break;        // feet → mm
          case 4: unitsScale = 1.0; break;          // mm (no-op)
          case 5: unitsScale = 10.0; break;         // cm → mm
          case 6: unitsScale = 1000.0; break;       // m → mm
          default: unitsScale = 1.0; break;         // treat unknown as mm
        }
        break;
      }
    }
  }

  // --- Skip to ENTITIES section ---
  while (i < lines.length) {
    if (lines[i] === "ENTITIES") { i++; break; }
    i++;
  }

  // Track unsupported entity types for surfacing
  const unsupportedCounts = new Map<string, number>();

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
        if (p[0] === 10) x1 = parseFloat(p[1]) * unitsScale;
        if (p[0] === 20) y1 = parseFloat(p[1]) * unitsScale;
        if (p[0] === 11) x2 = parseFloat(p[1]) * unitsScale;
        if (p[0] === 21) y2 = parseFloat(p[1]) * unitsScale;
      }
      newObjects.push({
        id: generateId(), type: "line", name: `DXF Line ${newObjects.length + 1}`,
        transform: { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), rotation: 0, scaleX: 1, scaleY: 1 },
        layerIndex: store.activeLayerIndex, visible: true, locked: false,
        fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
        points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
      });
    }

    else if (code === 0 && value === "CIRCLE") {
      let cx = 0, cy = 0, r = 0;
      while (i < lines.length) {
        const p = nextPair();
        if (!p) break;
        if (p[0] === 0) { i -= 2; break; }
        if (p[0] === 10) cx = parseFloat(p[1]) * unitsScale;
        if (p[0] === 20) cy = parseFloat(p[1]) * unitsScale;
        if (p[0] === 40) r = parseFloat(p[1]) * unitsScale;
      }
      newObjects.push({
        id: generateId(), type: "ellipse", name: `DXF Circle ${newObjects.length + 1}`,
        transform: { x: cx - r, y: cy - r, width: r * 2, height: r * 2, rotation: 0, scaleX: 1, scaleY: 1 },
        layerIndex: store.activeLayerIndex, visible: true, locked: false,
        fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
      });
    }

    else if (code === 0 && value === "LWPOLYLINE") {
      const pts: Array<{ x: number; y: number }> = [];
      const bulges: number[] = [];
      let closed = false;
      let currentX = 0;
      let currentY: number;
      let pendingBulge = 0;
      let vertexCount = 0;
      while (i < lines.length) {
        const p = nextPair();
        if (!p) break;
        if (p[0] === 0) { i -= 2; break; }
        if (p[0] === 70) closed = (parseInt(p[1]) & 1) === 1;
        if (p[0] === 10) {
          currentX = parseFloat(p[1]) * unitsScale;
        }
        if (p[0] === 20) {
          currentY = parseFloat(p[1]) * unitsScale;
          // Each X (code 10) + Y (code 20) pair defines a vertex.
          // Store any pending bulge from previous vertex.
          if (vertexCount > 0) {
            bulges.push(pendingBulge);
          }
          pendingBulge = 0;
          pts.push({ x: currentX, y: currentY });
          vertexCount++;
        }
        if (p[0] === 42) pendingBulge = parseFloat(p[1]); // bulge at current vertex
      }
      // The last vertex's bulge (to the wrap-around first vertex if closed)
      bulges.push(pendingBulge);

      if (pts.length >= 2) {
        // Expand bulge arcs
        const expanded: Array<{ x: number; y: number }> = [pts[0]];
        for (let vi = 0; vi < pts.length - 1; vi++) {
          const b = bulges[vi] ?? 0;
          const arcPts = bulgeToArcPoints(pts[vi].x, pts[vi].y, pts[vi + 1].x, pts[vi + 1].y, b);
          expanded.push(...arcPts);
        }
        if (closed && pts.length > 0) {
          const lastBulge = bulges[pts.length - 1] ?? 0;
          const arcPts = bulgeToArcPoints(pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y, lastBulge);
          // Don't add the closing point (it's the same as pts[0])
          expanded.push(...arcPts.slice(0, -1));
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pt of expanded) {
          minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
          maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
        }
        newObjects.push({
          id: generateId(), type: "path", name: `DXF Polyline ${newObjects.length + 1}`,
          transform: { x: minX, y: minY, width: maxX - minX, height: maxY - minY, rotation: 0, scaleX: 1, scaleY: 1 },
          layerIndex: store.activeLayerIndex, visible: true, locked: false,
          fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
          points: expanded, closed,
        });
      }
    }

    else if (code === 0 && value === "ARC") {
      let cx = 0, cy = 0, r = 0, startAngle = 0, endAngle = 360;
      while (i < lines.length) {
        const p = nextPair();
        if (!p) break;
        if (p[0] === 0) { i -= 2; break; }
        if (p[0] === 10) cx = parseFloat(p[1]) * unitsScale;
        if (p[0] === 20) cy = parseFloat(p[1]) * unitsScale;
        if (p[0] === 40) r = parseFloat(p[1]) * unitsScale;
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
            transform: { x: minX, y: minY, width: maxX - minX, height: maxY - minY, rotation: 0, scaleX: 1, scaleY: 1 },
            layerIndex: store.activeLayerIndex, visible: true, locked: false,
            fill: null, stroke: layerColor, strokeWidth: 1, opacity: 1,
            points: pts, closed: false,
          });
        }
      }
    }

    else if (code === 0 && value !== "ENDSEC" && value !== "EOF" && value !== "SECTION" && value.length > 0) {
      // Unsupported entity — consume its pairs and track for warning
      while (i < lines.length) {
        const p = nextPair();
        if (!p) break;
        if (p[0] === 0) { i -= 2; break; }
      }
      unsupportedCounts.set(value, (unsupportedCounts.get(value) ?? 0) + 1);
    }
  }

  // --- Y-flip: DXF is Y-up, screen is Y-down ---
  // Compute bounding box of all Y values, then invert: y = maxY - (y - minY)
  if (newObjects.length > 0) {
    let allMinY = Infinity, allMaxY = -Infinity;

    function collectY(pts: Array<{ x: number; y: number }> | undefined, ty: number, th: number) {
      if (pts) { for (const p of pts) { allMinY = Math.min(allMinY, p.y); allMaxY = Math.max(allMaxY, p.y); } }
      allMinY = Math.min(allMinY, ty);
      allMaxY = Math.max(allMaxY, ty + th);
    }

    for (const obj of newObjects) {
      collectY(obj.points, obj.transform.y, obj.transform.height);
    }

    const flipY = (y: number) => allMaxY - (y - allMinY);

    for (const obj of newObjects) {
      if (obj.points) {
        const flipped = obj.points.map(p => ({ ...p, y: flipY(p.y) }));
        obj.points = flipped;
        // Recompute transform bbox from points
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of flipped) {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        }
        obj.transform = { ...obj.transform, x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      } else {
        // Ellipse / rectangle: flip the Y extent
        const t = obj.transform;
        obj.transform = { ...t, y: flipY(t.y + t.height) };
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

  // Surface unsupported entity warnings
  if (unsupportedCounts.size > 0) {
    const summary = Array.from(unsupportedCounts.entries())
      .map(([type, count]) => `${type} (×${count})`)
      .join(", ");
    console.warn(`DXF: skipped entities: ${summary}`);
    store.addConsoleLine(`DXF: skipped unsupported entities: ${summary}`, "info");
  }
}
