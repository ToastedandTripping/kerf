import { textObjectToPaths } from "../../app/store/geometryActions";
import { sampleBezierPath } from "../geometry";
import type { DesignObject } from "../../app/types";

type PathLeaf = { pathObj: DesignObject; wx: number; wy: number };

/**
 * Flatten the output of textObjectToPaths into leaf path objects with their
 * accumulated world-space offsets. textObjectToPaths may return group objects
 * for multi-contour glyphs (O, 0, 8, 9, %, etc.); those groups have children
 * whose points are local to the group's bounding-box origin, not world-space.
 * This function adds the group's transform back so downstream callers always
 * work with a single (wx, wy) world offset per contour.
 */
function collectPathLeaves(objs: DesignObject[], wx = 0, wy = 0): PathLeaf[] {
  const leaves: PathLeaf[] = [];
  for (const obj of objs) {
    if (obj.type === "group" && obj.children) {
      // Group children's points are local to the group's origin. Accumulate.
      for (const leaf of collectPathLeaves(obj.children, wx + obj.transform.x, wy + obj.transform.y)) {
        leaves.push(leaf);
      }
    } else if (obj.type === "path" && obj.points && obj.points.length >= 2) {
      leaves.push({ pathObj: obj, wx, wy });
    }
  }
  return leaves;
}

/**
 * Convert a text string to a G-code line array for laser engraving.
 *
 * Font: /fonts/OpenSans-Regular.ttf (cached after first call)
 * Coordinates: mm, absolute (G90)
 * x, y: top-left corner of the text label in machine coordinates.
 * fontSize: glyph cap-height in mm (2-3mm is typically readable on a test card).
 * sValue: raw S-value (0..grblSValueMax) for the label pass.
 * feedRate: mm/min.
 * powerMode: "M3" or "M4"
 *
 * Each glyph contour is emitted as: G0 (rapid to start) → laser on → G1 stream
 * → M5 (laser off). Multi-contour glyphs (0, 6, 8, 9, O, %) emit one pass per
 * contour. The returned array is suitable for joining with "\n" or splicing into
 * a larger G-code buffer.
 *
 * The function is PURE from the store's perspective — it does not read or write
 * any Zustand state. Font loading is internally cached in geometryActions.
 */
export async function textToGcode(
  text: string,
  x: number,
  y: number,
  fontSize: number,
  sValue: number,
  feedRate: number,
  powerMode: string,
): Promise<string[]> {
  // Build a synthetic DesignObject for textObjectToPaths.
  // ID is a throwaway — this object never enters the store.
  const obj: DesignObject = {
    id: "_label_tmp",
    type: "text",
    name: "label",
    transform: { x: 0, y: 0, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#ffffff",
    strokeWidth: 0,
    opacity: 1,
    text,
    fontSize,
    fontFamily: "sans-serif",
  };

  const paths = await textObjectToPaths(obj);
  if (paths.length === 0) return [];

  const leaves = collectPathLeaves(paths);
  if (leaves.length === 0) return [];

  const lines: string[] = [];
  lines.push(`; Label: "${text}"`);

  for (const { pathObj, wx, wy } of leaves) {
    // Flatten bezier curves to a G1-ready polyline (adaptive de Casteljau, 0.05mm tolerance)
    const sampled = sampleBezierPath(pathObj.points!, pathObj.closed ?? false);
    if (sampled.length < 2) continue;

    // Offset to target label position.
    // pathObj.points are in the coordinate space of the original obj.transform (0,0),
    // shifted by the glyph xOffset. wx/wy add back any group rebasing offset.
    // x/y is the user-supplied world position for this label.
    const toX = (px: number) => (px + wx + x).toFixed(3);
    const toY = (py: number) => (py + wy + y).toFixed(3);

    const first = sampled[0];
    lines.push(`G0 X${toX(first.x)} Y${toY(first.y)}`);
    lines.push(`${powerMode} S${sValue}`);

    for (let i = 1; i < sampled.length; i++) {
      const pt = sampled[i];
      lines.push(`G1 X${toX(pt.x)} Y${toY(pt.y)} F${feedRate} S${sValue}`);
    }

    // Close the contour (return to start point) if the path is a closed loop.
    if (pathObj.closed && sampled.length > 2) {
      lines.push(`G1 X${toX(first.x)} Y${toY(first.y)} F${feedRate} S${sValue}`);
    }

    lines.push("M5");
  }

  return lines;
}
