import type { DesignObject, NestRotation, NestResult } from "../app/types";

interface AABB {
  w: number;
  h: number;
}

interface SkylineSegment {
  x: number;
  y: number;
  width: number;
}

/**
 * Compute the axis-aligned bounding box dimensions for an object,
 * accounting for rotation by projecting corners.
 */
export function computeAABB(obj: DesignObject): { x: number; y: number; w: number; h: number } {
  const t = obj.transform;
  const w = t.width;
  const h = t.height;
  const rot = (t.rotation % 360 + 360) % 360;

  if (rot === 0) {
    return { x: t.x, y: t.y, w, h };
  }

  const rad = (rot * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const rotW = w * cos + h * sin;
  const rotH = w * sin + h * cos;

  // Center stays the same
  const cx = t.x + w / 2;
  const cy = t.y + h / 2;

  return {
    x: cx - rotW / 2,
    y: cy - rotH / 2,
    w: rotW,
    h: rotH,
  };
}

/**
 * Compute AABB dimensions for given width/height at a rotation angle.
 */
function rotatedDimensions(w: number, h: number, angleDeg: number): AABB {
  const rad = ((angleDeg % 360 + 360) % 360) * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return {
    w: w * cos + h * sin,
    h: w * sin + h * cos,
  };
}

/**
 * Find the lowest Y position where an item of given width can be placed
 * starting at the given x offset on the skyline.
 */
function findPlacementY(
  skyline: SkylineSegment[],
  itemW: number,
  startX: number,
  sheetW: number,
): number | null {
  if (startX + itemW > sheetW + 0.001) return null;

  let maxY = 0;
  let coveredWidth = 0;

  for (const seg of skyline) {
    const segRight = seg.x + seg.width;
    if (segRight <= startX) continue;
    if (seg.x >= startX + itemW) break;

    // This segment overlaps with our item's horizontal span
    maxY = Math.max(maxY, seg.y);
    coveredWidth += Math.min(segRight, startX + itemW) - Math.max(seg.x, startX);
  }

  // Make sure we fully covered the width
  if (coveredWidth < itemW - 0.001) return null;

  return maxY;
}

/**
 * Place an item on the skyline and update segments.
 */
function placeSkyline(
  skyline: SkylineSegment[],
  x: number,
  y: number,
  w: number,
  h: number,
): SkylineSegment[] {
  const newTop = y + h;
  const itemRight = x + w;
  const result: SkylineSegment[] = [];

  for (const seg of skyline) {
    const segRight = seg.x + seg.width;

    // Segment entirely to the left of placement
    if (segRight <= x) {
      result.push(seg);
      continue;
    }

    // Segment entirely to the right of placement
    if (seg.x >= itemRight) {
      result.push(seg);
      continue;
    }

    // Segment overlaps with placement — split if needed

    // Left portion that sticks out before placement
    if (seg.x < x) {
      result.push({ x: seg.x, y: seg.y, width: x - seg.x });
    }

    // Right portion that sticks out after placement
    if (segRight > itemRight) {
      result.push({ x: itemRight, y: seg.y, width: segRight - itemRight });
    }
  }

  // Insert the new raised segment
  result.push({ x, y: newTop, width: w });

  // Sort by x and merge adjacent segments with same y
  result.sort((a, b) => a.x - b.x);
  const merged: SkylineSegment[] = [result[0]];
  for (let i = 1; i < result.length; i++) {
    const last = merged[merged.length - 1];
    if (Math.abs(last.x + last.width - result[i].x) < 0.001 && Math.abs(last.y - result[i].y) < 0.001) {
      last.width += result[i].width;
    } else {
      merged.push(result[i]);
    }
  }

  return merged;
}

interface NestItem {
  id: string;
  w: number;
  h: number;
  originalRotation: number;
}

/**
 * Skyline Bottom-Left-Fill nesting algorithm.
 * Places items tallest-first, choosing the lowest available position.
 */
export function nestItems(
  items: NestItem[],
  sheetW: number,
  sheetH: number,
  spacing: number,
  rotation: NestRotation,
): NestResult {
  if (items.length === 0) {
    return { placed: [], unplaced: [], efficiency: 0 };
  }

  // Sort tallest-first for better packing
  const sorted = [...items].sort((a, b) => b.h - a.h);

  let skyline: SkylineSegment[] = [{ x: 0, y: 0, width: sheetW }];
  const placed: NestResult["placed"] = [];
  const unplaced: string[] = [];

  for (const item of sorted) {
    // Determine rotation candidates
    let rotations: number[];
    switch (rotation) {
      case "none":
        rotations = [0];
        break;
      case "90":
        rotations = [0, 90, 180, 270];
        break;
      case "bestFit":
        rotations = [0, 90, 180, 270];
        break;
    }

    let bestPlacement: { x: number; y: number; rot: number; dims: AABB } | null = null;

    for (const rot of rotations) {
      const dims = rotatedDimensions(item.w, item.h, rot);
      const paddedW = dims.w + spacing;
      const paddedH = dims.h + spacing;

      // Try each possible x position along the skyline
      // We try the start of each skyline segment
      const xCandidates = new Set<number>();
      for (const seg of skyline) {
        xCandidates.add(seg.x);
      }
      // Also try right after each segment's start
      for (const seg of skyline) {
        const right = seg.x + seg.width;
        if (right < sheetW) xCandidates.add(right);
      }

      for (const startX of xCandidates) {
        if (startX + paddedW > sheetW + 0.001) continue;

        const y = findPlacementY(skyline, paddedW, startX, sheetW);
        if (y === null) continue;
        if (y + paddedH > sheetH + 0.001) continue;

        if (!bestPlacement || y < bestPlacement.y || (y === bestPlacement.y && startX < bestPlacement.x)) {
          bestPlacement = { x: startX, y, rot, dims };
        }
      }

      // For "none" rotation, only try 0 degrees
      if (rotation === "none") break;
      // For "90" rotation, try all but don't optimize for best
      if (rotation === "90" && bestPlacement) break;
    }

    if (bestPlacement) {
      const paddedW = bestPlacement.dims.w + spacing;
      const paddedH = bestPlacement.dims.h + spacing;
      skyline = placeSkyline(skyline, bestPlacement.x, bestPlacement.y, paddedW, paddedH);
      placed.push({
        objectId: item.id,
        x: bestPlacement.x,
        y: bestPlacement.y,
        rotation: bestPlacement.rot,
      });
    } else {
      unplaced.push(item.id);
    }
  }

  // Compute efficiency: sum of item areas / sheet area
  const totalItemArea = items
    .filter((item) => placed.some((p) => p.objectId === item.id))
    .reduce((sum, item) => sum + item.w * item.h, 0);
  const sheetArea = sheetW * sheetH;
  const efficiency = sheetArea > 0 ? totalItemArea / sheetArea : 0;

  return { placed, unplaced, efficiency };
}
