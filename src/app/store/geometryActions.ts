import polygonClipping from "polygon-clipping";
import opentype from "opentype.js";
import type { DesignObject, VariableTextConfig, NestConfig, NestResult } from "../types";
import type { StoreSet, StoreGet } from "./storeTypes";
import { generateId } from "./storeTypes";
import { applyObjects } from "./storeHelpers";
import { hasPlaceholders, extractPlaceholders, substitutePlaceholders, generateSerialValues } from "../../lib/variableText";
import { computeAABB, nestItems } from "../../lib/nesting";
import { offsetRingByDistance, movePartial, pointsBBox, buildGroupObject } from "../../lib/geometry";

// Module-level font cache to avoid reloading on every conversion
let cachedFont: opentype.Font | null = null;
let fontLoadPromise: Promise<opentype.Font> | null = null;

async function loadFont(): Promise<opentype.Font> {
  if (cachedFont) return cachedFont;
  if (fontLoadPromise) return fontLoadPromise;
  fontLoadPromise = opentype.load("/fonts/OpenSans-Regular.ttf").then((font) => {
    cachedFont = font;
    return font;
  }).catch((err) => {
    fontLoadPromise = null;
    throw err;
  });
  return fontLoadPromise;
}

/**
 * Convert a single text DesignObject into an array of path DesignObjects (one per glyph).
 * Standalone function — no store dependency.
 */
export async function textObjectToPaths(obj: DesignObject): Promise<DesignObject[]> {
  if (obj.type !== "text" || !obj.text) return [];

  const font = await loadFont();
  const fontSize = obj.fontSize || 12;
  const scale = fontSize / font.unitsPerEm;

  const glyphs = font.stringToGlyphs(obj.text);
  let xOffset = 0;
  const prepared: DesignObject[] = [];

  for (const glyph of glyphs) {
    const path = glyph.getPath(0, 0, font.unitsPerEm);
    const commands = path.commands;

    if (commands.length === 0) {
      xOffset += (glyph.advanceWidth || 0) * scale;
      continue;
    }

    // W1c (F20): split glyph CONTOURS at M commands — pre-fix they were
    // concatenated into one points array, so a glyph "O" bridged its hole
    // to its outline and the bridge was CUT through the workpiece.
    const contours: Array<Array<{ x: number; y: number; handleIn?: { x: number; y: number }; handleOut?: { x: number; y: number } }>> = [];
    let pathPoints: Array<{ x: number; y: number; handleIn?: { x: number; y: number }; handleOut?: { x: number; y: number } }> = [];
    let currentX = 0, currentY = 0;

    for (const cmd of commands) {
      switch (cmd.type) {
        case "M":
          if (pathPoints.length > 0) contours.push(pathPoints);
          pathPoints = [];
          currentX = cmd.x! * scale;
          currentY = cmd.y! * scale;
          pathPoints.push({ x: obj.transform.x + xOffset + currentX, y: obj.transform.y + fontSize + currentY });
          break;
        case "L":
          currentX = cmd.x! * scale;
          currentY = cmd.y! * scale;
          pathPoints.push({ x: obj.transform.x + xOffset + currentX, y: obj.transform.y + fontSize + currentY });
          break;
        case "C": {
          const prevPt = pathPoints[pathPoints.length - 1];
          if (prevPt) {
            prevPt.handleOut = {
              x: obj.transform.x + xOffset + cmd.x1! * scale,
              y: obj.transform.y + fontSize + cmd.y1! * scale,
            };
          }
          currentX = cmd.x! * scale;
          currentY = cmd.y! * scale;
          pathPoints.push({
            x: obj.transform.x + xOffset + currentX,
            y: obj.transform.y + fontSize + currentY,
            handleIn: {
              x: obj.transform.x + xOffset + cmd.x2! * scale,
              y: obj.transform.y + fontSize + cmd.y2! * scale,
            },
          });
          break;
        }
        case "Q": {
          const qPrev = pathPoints[pathPoints.length - 1];
          const qpx = qPrev ? qPrev.x : 0;
          const qpy = qPrev ? qPrev.y : 0;
          const cpx = cmd.x1! * scale;
          const cpy = cmd.y1! * scale;
          if (qPrev) {
            qPrev.handleOut = {
              x: qpx + (2 / 3) * (obj.transform.x + xOffset + cpx - qpx),
              y: qpy + (2 / 3) * (obj.transform.y + fontSize + cpy - qpy),
            };
          }
          currentX = cmd.x! * scale;
          currentY = cmd.y! * scale;
          const endX = obj.transform.x + xOffset + currentX;
          const endY = obj.transform.y + fontSize + currentY;
          pathPoints.push({
            x: endX,
            y: endY,
            handleIn: {
              x: endX + (2 / 3) * (obj.transform.x + xOffset + cpx - endX),
              y: endY + (2 / 3) * (obj.transform.y + fontSize + cpy - endY),
            },
          });
          break;
        }
        case "Z":
          break;
      }
    }

    if (pathPoints.length > 0) contours.push(pathPoints);

    // Surviving (≥2-point) contours become path objects; a multi-contour
    // glyph (O, A, B) groups per glyph so flatten cuts the hole as its own
    // ring (no bridge); single-contour glyphs stay FLAT — no behavior change.
    const contourObjects: DesignObject[] = contours
      .filter((pts) => pts.length > 1)
      .map((pts) => {
        const bb = pointsBBox(pts);
        return {
          ...obj,
          id: generateId(),
          type: "path" as const,
          text: undefined,
          fontSize: undefined,
          fontFamily: undefined,
          isTemplate: undefined,
          points: pts,
          closed: true,
          transform: {
            ...obj.transform,
            x: bb.x, y: bb.y,
            width: bb.width, height: bb.height,
          },
        };
      });

    if (contourObjects.length === 1) {
      prepared.push(contourObjects[0]);
    } else if (contourObjects.length > 1) {
      prepared.push(buildGroupObject(contourObjects, generateId(), obj.name, obj.layerIndex));
    }

    xOffset += (glyph.advanceWidth || 0) * scale;
  }

  return prepared;
}

// B4.2: single shared boolean implementation; four public actions are thin wrappers.
// clip signature matches polygonClipping.*: (subject, ...clippers) — preserves polys[0],...rest
// order so difference/xor (order-sensitive) behave identically to before.
type ClipFn = (subject: polygonClipping.Polygon, ...clippers: polygonClipping.Polygon[]) => polygonClipping.MultiPolygon;

function runBoolean(get: StoreGet, clip: ClipFn) {
  if (get().selectedIds.length < 2) return;
  get().withUndo("boolean", () => {
    const { selectedIds, objects, removeObjects, addObject, setSelectedIds } = get();
    const selected = objects.filter((o) => selectedIds.includes(o.id));
    const polys = selected.map(objectToPolygon).filter(Boolean) as polygonClipping.Polygon[];
    if (polys.length < 2) return;
    const result = clip(polys[0], ...polys.slice(1));
    removeObjects(selectedIds);
    const newIds = multiPolygonToObjects(result, selected[0]).map((obj) => { addObject(obj); return obj.id; });
    setSelectedIds(newIds);
  });
}

export function createGeometryActions(set: StoreSet, get: StoreGet) {
  return {
    alignObjects: (alignment: "left" | "right" | "top" | "bottom" | "hcenter" | "vcenter") => {
      if (get().selectedIds.length < 2) return;
      get().withUndo("align", () => {
        const { selectedIds, objects, updateObject } = get();
        const selected = objects.filter((o) => selectedIds.includes(o.id));
        const bounds = selected.map((o) => ({
          id: o.id,
          left: o.transform.x,
          right: o.transform.x + o.transform.width,
          top: o.transform.y,
          bottom: o.transform.y + o.transform.height,
          cx: o.transform.x + o.transform.width / 2,
          cy: o.transform.y + o.transform.height / 2,
        }));

        // W1b: every position write routes through movePartial so path/line
        // points travel with the transform.
        let target: number;
        switch (alignment) {
          case "left":
            target = Math.min(...bounds.map((b) => b.left));
            for (const b of bounds) {
              const obj = objects.find((o) => o.id === b.id)!;
              updateObject(b.id, movePartial(obj, target, obj.transform.y));
            }
            break;
          case "right":
            target = Math.max(...bounds.map((b) => b.right));
            for (const b of bounds) {
              const obj = objects.find((o) => o.id === b.id)!;
              updateObject(b.id, movePartial(obj, target - obj.transform.width, obj.transform.y));
            }
            break;
          case "top":
            target = Math.min(...bounds.map((b) => b.top));
            for (const b of bounds) {
              const obj = objects.find((o) => o.id === b.id)!;
              updateObject(b.id, movePartial(obj, obj.transform.x, target));
            }
            break;
          case "bottom":
            target = Math.max(...bounds.map((b) => b.bottom));
            for (const b of bounds) {
              const obj = objects.find((o) => o.id === b.id)!;
              updateObject(b.id, movePartial(obj, obj.transform.x, target - obj.transform.height));
            }
            break;
          case "hcenter": {
            const allLeft = Math.min(...bounds.map((b) => b.left));
            const allRight = Math.max(...bounds.map((b) => b.right));
            const center = (allLeft + allRight) / 2;
            for (const b of bounds) {
              const obj = objects.find((o) => o.id === b.id)!;
              updateObject(b.id, movePartial(obj, center - obj.transform.width / 2, obj.transform.y));
            }
            break;
          }
          case "vcenter": {
            const allTop = Math.min(...bounds.map((b) => b.top));
            const allBottom = Math.max(...bounds.map((b) => b.bottom));
            const center = (allTop + allBottom) / 2;
            for (const b of bounds) {
              const obj = objects.find((o) => o.id === b.id)!;
              updateObject(b.id, movePartial(obj, obj.transform.x, center - obj.transform.height / 2));
            }
            break;
          }
        }
      });
    },

    distributeObjects: (direction: "horizontal" | "vertical") => {
      if (get().selectedIds.length < 3) return;
      get().withUndo("distribute", () => {
        const { selectedIds, objects, updateObject } = get();
        const selected = objects.filter((o) => selectedIds.includes(o.id));

        if (direction === "horizontal") {
          const sorted = [...selected].sort((a, b) => a.transform.x - b.transform.x);
          const first = sorted[0].transform.x;
          const last = sorted[sorted.length - 1].transform.x + sorted[sorted.length - 1].transform.width;
          const totalWidth = sorted.reduce((s, o) => s + o.transform.width, 0);
          const gap = (last - first - totalWidth) / (sorted.length - 1);
          let x = first;
          for (const obj of sorted) {
            updateObject(obj.id, movePartial(obj, x, obj.transform.y));
            x += obj.transform.width + gap;
          }
        } else {
          const sorted = [...selected].sort((a, b) => a.transform.y - b.transform.y);
          const first = sorted[0].transform.y;
          const last = sorted[sorted.length - 1].transform.y + sorted[sorted.length - 1].transform.height;
          const totalHeight = sorted.reduce((s, o) => s + o.transform.height, 0);
          const gap = (last - first - totalHeight) / (sorted.length - 1);
          let y = first;
          for (const obj of sorted) {
            updateObject(obj.id, movePartial(obj, obj.transform.x, y));
            y += obj.transform.height + gap;
          }
        }
      });
    },

    flipObjects: (axis: "horizontal" | "vertical") => {
      if (get().selectedIds.length === 0) return;
      get().withUndo("flip", () => {
        const { selectedIds, objects, updateObject } = get();
        const selected = objects.filter((o) => selectedIds.includes(o.id));

        if (selected.length === 1) {
          const obj = selected[0];
          const t = obj.transform;
          const centerX = t.x + t.width / 2;
          const centerY = t.y + t.height / 2;

          if ((obj.type === "path" || obj.type === "line") && obj.points) {
            const flippedPoints = obj.points.map((p) => {
              const fp = { ...p };
              if (axis === "horizontal") {
                fp.x = 2 * centerX - p.x;
                if (p.handleIn) fp.handleIn = { x: 2 * centerX - p.handleIn.x, y: p.handleIn.y };
                if (p.handleOut) fp.handleOut = { x: 2 * centerX - p.handleOut.x, y: p.handleOut.y };
              } else {
                fp.y = 2 * centerY - p.y;
                if (p.handleIn) fp.handleIn = { x: p.handleIn.x, y: 2 * centerY - p.handleIn.y };
                if (p.handleOut) fp.handleOut = { x: p.handleOut.x, y: 2 * centerY - p.handleOut.y };
              }
              return fp;
            });
            updateObject(obj.id, { points: flippedPoints, transform: { ...t, scaleX: 1, scaleY: 1 } });
          } else if (obj.type === "image" || obj.type === "text") {
            if (axis === "horizontal") {
              updateObject(obj.id, { transform: { ...t, scaleX: t.scaleX * -1 } });
            } else {
              updateObject(obj.id, { transform: { ...t, scaleY: t.scaleY * -1 } });
            }
          } else {
            updateObject(obj.id, { transform: { ...t, scaleX: 1, scaleY: 1 } });
          }
        } else {
          const allLeft = Math.min(...selected.map((o) => o.transform.x));
          const allRight = Math.max(...selected.map((o) => o.transform.x + o.transform.width));
          const allTop = Math.min(...selected.map((o) => o.transform.y));
          const allBottom = Math.max(...selected.map((o) => o.transform.y + o.transform.height));

          // W1b: position-mirroring writes route through movePartial so paths
          // actually move. The geometry-mirroring defect itself (children are
          // repositioned but not mirrored) is F29 — Wave 4, scope-locked out.
          for (const obj of selected) {
            if (axis === "horizontal") {
              const newX = allRight - (obj.transform.x - allLeft) - obj.transform.width;
              updateObject(obj.id, movePartial(obj, newX, obj.transform.y));
            } else {
              const newY = allBottom - (obj.transform.y - allTop) - obj.transform.height;
              updateObject(obj.id, movePartial(obj, obj.transform.x, newY));
            }
          }
        }
      });
    },

    groupSelected: () => {
      if (get().selectedIds.length < 2) return;
      get().withUndo("group", () => {
        const { selectedIds, objects } = get();
        const selected = objects.filter((o) => selectedIds.includes(o.id));
        const remaining = objects.filter((o) => !selectedIds.includes(o.id));

        // W1c: group construction (bbox + W1b group-local points re-base via
        // pure movePartial) lives in lib/geometry's buildGroupObject — the ONE
        // builder shared with the compound-path importers.
        const groupId = generateId();
        const group = buildGroupObject(
          selected, groupId, `Group ${remaining.length + 1}`, selected[0].layerIndex,
        );

        const insertIdx = objects.findIndex((o) => o.id === selected[0].id);
        const newObjects = [...remaining];
        newObjects.splice(Math.min(insertIdx, newObjects.length), 0, group);

        set(applyObjects(newObjects, [groupId]));
      });
    },

    ungroupSelected: () => {
      get().withUndo("ungroup", () => {
        const { selectedIds, objects } = get();
        const newObjects: DesignObject[] = [];
        const newSelectedIds: string[] = [];

        for (const obj of objects) {
          if (selectedIds.includes(obj.id) && obj.type === "group" && obj.children) {
            for (const child of obj.children) {
              // W1b: add the group origin back to child POINTS alongside the
              // transform (pure — see groupSelected). Known pre-existing
              // limitation, unchanged here: ungrouping a ROTATED group drops
              // r_g (children land unrotated at their stored offsets).
              const expanded = {
                ...child,
                ...movePartial(child, child.transform.x + obj.transform.x, child.transform.y + obj.transform.y),
              };
              newObjects.push(expanded);
              newSelectedIds.push(expanded.id);
            }
          } else {
            newObjects.push(obj);
            if (selectedIds.includes(obj.id)) {
              newSelectedIds.push(obj.id);
            }
          }
        }

        set(applyObjects(newObjects, newSelectedIds));
      });
    },

    convertToPath: (id: string) => {
      const { objects } = get();
      const obj = objects.find((o) => o.id === id);
      if (!obj) return;
      get().withUndo("convert-to-path", () => {
        const { updateObject } = get();

        let points: Array<{ x: number; y: number; handleIn?: { x: number; y: number }; handleOut?: { x: number; y: number } }> = [];
        const t = obj.transform;

        switch (obj.type) {
          case "rectangle": {
            const r = obj.cornerRadius || 0;
            if (r > 0) {
              const w = t.width, h = t.height;
              const cr = Math.min(r, w / 2, h / 2);
              const k = 0.5522847498;
              points = [
                { x: cr, y: 0, handleIn: { x: cr - cr * k, y: 0 } },
                { x: w - cr, y: 0, handleOut: { x: w - cr + cr * k, y: 0 } },
                { x: w, y: cr, handleIn: { x: w, y: cr - cr * k } },
                { x: w, y: h - cr, handleOut: { x: w, y: h - cr + cr * k } },
                { x: w - cr, y: h, handleIn: { x: w - cr + cr * k, y: h } },
                { x: cr, y: h, handleIn: undefined, handleOut: { x: cr - cr * k, y: h } },
                { x: 0, y: h - cr, handleIn: { x: 0, y: h - cr + cr * k } },
                { x: 0, y: cr, handleOut: { x: 0, y: cr - cr * k } },
              ];
            } else {
              points = [
                { x: 0, y: 0 },
                { x: t.width, y: 0 },
                { x: t.width, y: t.height },
                { x: 0, y: t.height },
              ];
            }
            break;
          }
          case "ellipse": {
            const rx = t.width / 2;
            const ry = t.height / 2;
            const k = 0.5522847498;
            points = [
              { x: rx, y: 0, handleIn: { x: rx + rx * k, y: 0 }, handleOut: { x: rx - rx * k, y: 0 } },
              { x: 0, y: ry, handleIn: { x: 0, y: ry - ry * k }, handleOut: { x: 0, y: ry + ry * k } },
              { x: rx, y: ry * 2, handleIn: { x: rx - rx * k, y: ry * 2 }, handleOut: { x: rx + rx * k, y: ry * 2 } },
              { x: rx * 2, y: ry, handleIn: { x: rx * 2, y: ry + ry * k }, handleOut: { x: rx * 2, y: ry - ry * k } },
            ];
            break;
          }
          default:
            return;
        }

        const absolutePoints = points.map((p) => ({
          x: t.x + p.x,
          y: t.y + p.y,
          handleIn: p.handleIn ? { x: t.x + p.handleIn.x, y: t.y + p.handleIn.y } : undefined,
          handleOut: p.handleOut ? { x: t.x + p.handleOut.x, y: t.y + p.handleOut.y } : undefined,
        }));

        updateObject(id, { type: "path", points: absolutePoints, closed: true });
      });
    },

    convertTextToPath: async (id: string) => {
      const { objects } = get();
      const obj = objects.find((o) => o.id === id);
      if (!obj || obj.type !== "text" || !obj.text) return;

      try {
        const prepared = await textObjectToPaths(obj);

        get().withUndo("convert-to-path", () => {
          const { removeObjects, addObject, setSelectedIds } = get();
          const newIds: string[] = [];
          for (const newObj of prepared) {
            addObject(newObj);
            newIds.push(newObj.id);
          }
          removeObjects([id]);
          setSelectedIds(newIds);
        });
      } catch (e) {
        console.error("Text to path conversion failed:", e);
        get().withUndo("convert-to-path", () => {
          get().updateObject(id, {
            type: "path",
            points: [
              { x: obj.transform.x, y: obj.transform.y },
              { x: obj.transform.x + obj.transform.width, y: obj.transform.y },
              { x: obj.transform.x + obj.transform.width, y: obj.transform.y + obj.transform.height },
              { x: obj.transform.x, y: obj.transform.y + obj.transform.height },
            ],
            closed: true,
          });
        });
      }
    },

    rotate90: (direction: "cw" | "ccw") => {
      if (get().selectedIds.length === 0) return;
      get().withUndo("rotate", () => {
        const { selectedIds, objects, updateObject } = get();
        const angle = direction === "cw" ? 90 : -90;
        for (const id of selectedIds) {
          const obj = objects.find((o) => o.id === id);
          if (!obj) continue;
          updateObject(id, {
            transform: { ...obj.transform, rotation: ((obj.transform.rotation + angle) % 360 + 360) % 360 },
          });
        }
      });
    },

    gridArray: (rows: number, cols: number, spacingX: number, spacingY: number) => {
      if (get().selectedIds.length === 0) return;
      get().withUndo("grid-array", () => {
        const { selectedIds, objects, addObject, setSelectedIds } = get();
        const selected = objects.filter((o) => selectedIds.includes(o.id));
        const newIds: string[] = [...selectedIds];
        for (const obj of selected) {
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              if (r === 0 && c === 0) continue;
              const newId = generateId();
              // W1b: movePartial offsets path points with the cell AND breaks
              // the points-array aliasing between array copies.
              addObject({
                ...obj,
                id: newId,
                name: obj.name + ` [${r},${c}]`,
                ...movePartial(
                  obj,
                  obj.transform.x + c * (obj.transform.width + spacingX),
                  obj.transform.y + r * (obj.transform.height + spacingY),
                ),
              });
              newIds.push(newId);
            }
          }
        }
        setSelectedIds(newIds);
      });
    },

    circularArray: (count: number, radius: number, startAngle: number) => {
      if (get().selectedIds.length === 0) return;
      get().withUndo("circular-array", () => {
        const { selectedIds, objects, addObject, setSelectedIds } = get();
        const selected = objects.filter((o) => selectedIds.includes(o.id));
        const newIds: string[] = [...selectedIds];

        let cx = 0, cy = 0;
        for (const obj of selected) {
          cx += obj.transform.x + obj.transform.width / 2;
          cy += obj.transform.y + obj.transform.height / 2;
        }
        cx /= selected.length;
        cy /= selected.length;

        const angleStep = 360 / count;
        for (const obj of selected) {
          for (let i = 1; i < count; i++) {
            const angle = (startAngle + angleStep * i) * (Math.PI / 180);
            const newCx = cx + radius * Math.cos(angle);
            const newCy = cy + radius * Math.sin(angle);
            const newId = generateId();
            // W1b: movePartial for the position write (points move, aliasing
            // broken); the rotation field merges on top of the synced transform.
            const moved = movePartial(obj, newCx - obj.transform.width / 2, newCy - obj.transform.height / 2);
            addObject({
              ...obj,
              id: newId,
              name: obj.name + ` [${i}]`,
              ...moved,
              transform: {
                ...moved.transform,
                rotation: ((obj.transform.rotation + angleStep * i) % 360 + 360) % 360,
              },
            });
            newIds.push(newId);
          }
        }
        setSelectedIds(newIds);
      });
    },

    booleanUnion: () => runBoolean(get, polygonClipping.union),
    booleanDifference: () => runBoolean(get, polygonClipping.difference),
    booleanIntersection: () => runBoolean(get, polygonClipping.intersection),
    booleanXor: () => runBoolean(get, polygonClipping.xor),

    offsetPaths: (distance: number) => {
      if (get().selectedIds.length === 0) return;
      get().withUndo("offset", () => {
        const { selectedIds, objects, addObject, setSelectedIds } = get();
        const selected = objects.filter((o) => selectedIds.includes(o.id));
        const newIds: string[] = [];
        for (const obj of selected) {
          const poly = objectToPolygon(obj);
          if (!poly) continue;
          const ring = poly[0];
          const offsetRing = offsetRingByDistance(ring, distance);
          const newId = generateId();
          const xs = offsetRing.map((p) => p[0]);
          const ys = offsetRing.map((p) => p[1]);
          const minX = Math.min(...xs), minY = Math.min(...ys);
          const maxX = Math.max(...xs), maxY = Math.max(...ys);
          addObject({
            ...obj,
            id: newId,
            type: "path",
            points: offsetRing.map((p) => ({ x: p[0], y: p[1] })),
            closed: true,
            transform: { ...obj.transform, x: minX, y: minY, width: maxX - minX, height: maxY - minY },
          });
          newIds.push(newId);
        }
        setSelectedIds(newIds);
      });
    },

    generateVariableText: async (config: VariableTextConfig) => {
      const { objects } = get();

      // Find template objects: use specified IDs, or auto-detect all text objects with placeholders
      let templates: DesignObject[];
      if (config.templateObjectIds.length > 0) {
        templates = objects.filter((o) => config.templateObjectIds.includes(o.id));
      } else {
        templates = objects.filter((o) => o.type === "text" && hasPlaceholders(o));
      }

      if (templates.length === 0) return;

      // Build substitution rows from data source
      let rows: Record<string, string>[];
      if (config.dataSource.type === "serial") {
        const { count } = config.dataSource.config;
        if (!Number.isFinite(count) || count < 1) return;
        const values = generateSerialValues(config.dataSource.config);
        // Find the placeholder name from the first template
        const firstTemplate = templates.find((t) => t.text && hasPlaceholders(t));
        const placeholderNames = firstTemplate ? extractPlaceholders(firstTemplate.text!) : ["serial"];
        const primaryName = placeholderNames[0] || "serial";
        rows = values.map((v) => ({ [primaryName]: v }));
      } else {
        // CSV data source
        const { headers, rows: csvRows } = config.dataSource;
        rows = csvRows.map((row) => {
          const record: Record<string, string> = {};
          for (let i = 0; i < headers.length; i++) {
            record[headers[i]] = row[i] || "";
          }
          return record;
        });
      }

      if (rows.length === 0) return;

      // Cap rows to prevent runaway generation
      const data = rows.slice(0, 10000);
      rows = data;

      // Generate all instances
      const allNewObjects: DesignObject[] = [];
      for (const row of rows) {
        for (const template of templates) {
          if (!template.text) continue;
          const substitutedText = substitutePlaceholders(template.text, row);
          const cloned: DesignObject = {
            ...template,
            id: generateId(),
            text: substitutedText,
            isTemplate: undefined,
            name: `${template.name} [${Object.values(row)[0] || ""}]`,
          };
          // Convert text to paths
          try {
            const paths = await textObjectToPaths(cloned);
            allNewObjects.push(...paths);
          } catch {
            // If path conversion fails, add as text object
            allNewObjects.push(cloned);
          }
        }
      }

      if (allNewObjects.length === 0) return;

      // Add all generated objects in single undo snapshot
      get().withUndo("generate-variable-text", () => {
        const { addObject, setSelectedIds, updateObject } = get();
        const newIds: string[] = [];
        for (const obj of allNewObjects) {
          addObject(obj);
          newIds.push(obj.id);
        }
        setSelectedIds(newIds);

        // Mark template objects inside undo boundary
        for (const template of templates) {
          if (!template.isTemplate) {
            updateObject(template.id, { isTemplate: true });
          }
        }
      });

    },

    nestObjects: async (config: NestConfig): Promise<NestResult> => {
      const { objects, selectedIds, workspaceWidth, workspaceHeight } = get();

      // Clamp spacing to valid range
      const spacing = Math.max(0, Math.min(config.spacing, Math.min(workspaceWidth, workspaceHeight) / 2));

      // Select candidates: selected if useSelection + selection exists, else all visible/unlocked
      let candidates: DesignObject[];
      if (config.useSelection && selectedIds.length > 0) {
        candidates = objects.filter((o) => selectedIds.includes(o.id) && o.visible && !o.locked && !o.isTemplate);
      } else {
        candidates = objects.filter((o) => o.visible && !o.locked && !o.isTemplate);
      }

      if (candidates.length === 0) {
        return { placed: [], unplaced: [], efficiency: 0 };
      }

      // Compute AABB for each candidate
      const nestInput = candidates.map((obj) => {
        const aabb = computeAABB(obj);
        return {
          id: obj.id,
          w: aabb.w,
          h: aabb.h,
          originalRotation: obj.transform.rotation,
        };
      });

      // Run nesting algorithm
      const result = nestItems(
        nestInput,
        workspaceWidth,
        workspaceHeight,
        spacing,
        config.rotation,
      );

      // Apply placements in single undo snapshot
      if (result.placed.length > 0) {
        get().withUndo("auto-nest", () => {
          const { updateObject } = get();
          for (const placement of result.placed) {
            const obj = candidates.find((o) => o.id === placement.objectId);
            if (!obj) continue;

            // Calculate offset to center the object within its AABB at the placement position
            const newRotation = obj.transform.rotation + placement.rotation;
            const newAABB = computeAABB({
              ...obj,
              transform: { ...obj.transform, rotation: newRotation },
            });

            // W1b: movePartial for the placement write; rotation merges on top.
            const moved = movePartial(
              obj,
              placement.x + (newAABB.w - obj.transform.width) / 2,
              placement.y + (newAABB.h - obj.transform.height) / 2,
            );
            updateObject(placement.objectId, {
              ...moved,
              transform: {
                ...moved.transform,
                rotation: ((newRotation % 360) + 360) % 360,
              },
            });
          }
        });
      }

      return result;
    },
  };
}

function sampleBezierSegment(
  p0: { x: number; y: number },
  cp1: { x: number; y: number },
  cp2: { x: number; y: number },
  p1: { x: number; y: number },
  steps = 16,
): Array<polygonClipping.Pair> {
  const points: Array<polygonClipping.Pair> = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * mt * p0.x + 3 * mt * mt * t * cp1.x + 3 * mt * t * t * cp2.x + t * t * t * p1.x;
    const y = mt * mt * mt * p0.y + 3 * mt * mt * t * cp1.y + 3 * mt * t * t * cp2.y + t * t * t * p1.y;
    points.push([x, y]);
  }
  return points;
}

function objectToPolygon(obj: DesignObject): polygonClipping.Polygon | null {
  const t = obj.transform;
  switch (obj.type) {
    case "rectangle": {
      const ring: polygonClipping.Ring = [
        [t.x, t.y], [t.x + t.width, t.y],
        [t.x + t.width, t.y + t.height], [t.x, t.y + t.height],
        [t.x, t.y],
      ];
      return [ring];
    }
    case "ellipse": {
      const cx = t.x + t.width / 2, cy = t.y + t.height / 2;
      const rx = t.width / 2, ry = t.height / 2;
      const segments = 64;
      const ring: polygonClipping.Ring = [];
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        ring.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
      }
      return [ring];
    }
    case "path": {
      if (!obj.points || obj.points.length < 3) return null;
      const ring: polygonClipping.Ring = [[obj.points[0].x, obj.points[0].y]];
      for (let i = 1; i < obj.points.length; i++) {
        const prev = obj.points[i - 1];
        const pt = obj.points[i];
        if (prev.handleOut && pt.handleIn) {
          ring.push(...sampleBezierSegment(
            { x: prev.x, y: prev.y }, prev.handleOut, pt.handleIn, { x: pt.x, y: pt.y },
          ));
        } else {
          ring.push([pt.x, pt.y]);
        }
      }
      if (obj.closed && obj.points.length >= 2) {
        const last = obj.points[obj.points.length - 1];
        const first = obj.points[0];
        if (last.handleOut && first.handleIn) {
          ring.push(...sampleBezierSegment(
            { x: last.x, y: last.y }, last.handleOut, first.handleIn, { x: first.x, y: first.y },
          ));
        }
      }
      if (ring.length > 0 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
        ring.push([ring[0][0], ring[0][1]]);
      }
      return [ring];
    }
    default:
      return null;
  }
}

function multiPolygonToObjects(mp: polygonClipping.MultiPolygon, template: DesignObject): DesignObject[] {
  return mp.map((polygon) => {
    const ring = polygon[0];
    const points = ring.map((p) => ({ x: p[0], y: p[1] }));
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const maxX = Math.max(...xs), maxY = Math.max(...ys);
    return {
      ...template,
      id: generateId(),
      type: "path" as const,
      points, closed: true,
      transform: { ...template.transform, x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    };
  });
}

