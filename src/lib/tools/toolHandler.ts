import { useStore, generateId } from "../../app/store";
import type { DesignObject, PathPoint, ToolType } from "../../app/types";
import { machineConnection } from "../machine/connection";

// Handle types for resize/rotate
export type HandleType =
  | "nw" | "n" | "ne"
  | "w" | "e"
  | "sw" | "s" | "se"
  | "rotate"
  | null;

interface DragState {
  startX: number;
  startY: number;
  isDragging: boolean;
  dragTarget: string | null;
  dragOffsetX: number;
  dragOffsetY: number;
  originalTransforms: Map<string, { x: number; y: number; width: number; height: number; rotation: number }>;
  // Marquee selection
  isMarquee: boolean;
  marqueeDirection: "ltr" | "rtl";
  // Handle resize/rotate
  activeHandle: HandleType;
  handleOriginal: { x: number; y: number; width: number; height: number } | null;
}

const drag: DragState = {
  startX: 0,
  startY: 0,
  isDragging: false,
  dragTarget: null,
  dragOffsetX: 0,
  dragOffsetY: 0,
  originalTransforms: new Map(),
  isMarquee: false,
  marqueeDirection: "ltr",
  activeHandle: null,
  handleOriginal: null,
};

// --- PEN TOOL STATE ---
const PEN_CLOSE_RADIUS = 8; // screen pixels
const NODE_HIT_RADIUS = 6; // screen pixels

const penState = {
  isDrawing: false,
  points: [] as PathPoint[],
  currentMouse: null as { x: number; y: number } | null,
  isDraggingHandle: false,
  objectId: "",
};

// --- NODE EDITOR STATE ---
const nodeDrag = {
  isDragging: false,
  nodeIndex: -1,
  target: null as "node" | "handleIn" | "handleOut" | null,
  startX: 0,
  startY: 0,
  originalPoints: [] as PathPoint[],
};

// Expose marquee state for Viewport rendering
export function getMarqueeState() {
  if (!drag.isMarquee || !drag.isDragging) return null;
  return {
    startX: drag.startX,
    startY: drag.startY,
    direction: drag.marqueeDirection,
  };
}

// Expose active handle for cursor changes
export function getActiveHandle(): HandleType {
  return drag.activeHandle;
}

export function handleViewportPointerDown(
  worldX: number,
  worldY: number,
  e: React.PointerEvent
) {
  const store = useStore.getState();
  const tool = store.activeTool;

  drag.startX = worldX;
  drag.startY = worldY;
  drag.isDragging = true;
  drag.isMarquee = false;
  drag.activeHandle = null;

  switch (tool) {
    case "select":
      handleSelectDown(worldX, worldY, e);
      break;
    case "rectangle":
    case "ellipse":
    case "line":
      handleShapeDown(worldX, worldY, tool);
      break;
    case "pen":
      handlePenDown(worldX, worldY, e);
      break;
    case "text":
      handleTextDown(worldX, worldY);
      break;
    case "node":
      handleNodeDown(worldX, worldY, e);
      break;
    case "positionLaser":
      handlePositionLaserDown(worldX, worldY);
      break;
  }
}

export function handleViewportPointerMove(
  worldX: number,
  worldY: number,
  _e: React.PointerEvent
) {
  const store = useStore.getState();
  const tool = store.activeTool;

  // Pen tool tracks mouse even without drag
  if (tool === "pen") {
    handlePenMove(worldX, worldY);
    return;
  }

  // Node tool tracks drag independently
  if (tool === "node") {
    if (nodeDrag.isDragging) {
      handleNodeMove(worldX, worldY);
    }
    return;
  }

  if (!drag.isDragging) return;

  switch (tool) {
    case "select":
      handleSelectMove(worldX, worldY, _e);
      break;
    case "rectangle":
    case "ellipse":
    case "line":
      handleShapeMove(worldX, worldY, tool);
      break;
  }
}

export function handleViewportPointerUp(
  worldX: number,
  worldY: number,
  _e: React.PointerEvent
) {
  if (!drag.isDragging) return;

  const store = useStore.getState();
  const tool = store.activeTool;

  switch (tool) {
    case "select":
      handleSelectUp(worldX, worldY);
      break;
    case "rectangle":
    case "ellipse":
    case "line":
      handleShapeUp();
      break;
    case "pen":
      handlePenUp();
      break;
    case "node":
      handleNodeUp();
      break;
  }

  drag.isDragging = false;
  drag.dragTarget = null;
  drag.isMarquee = false;
  drag.activeHandle = null;
  drag.handleOriginal = null;
  drag.originalTransforms.clear();
}

// --- SELECT TOOL ---

function hitTest(worldX: number, worldY: number): string | null {
  const { objects } = useStore.getState();
  // Test in reverse order (topmost first)
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (!obj.visible || obj.locked) continue;
    const t = obj.transform;
    const rot = (t.rotation || 0) * Math.PI / 180;

    if (obj.type === "line" && obj.points && obj.points.length >= 2) {
      const p1 = obj.points[0];
      const p2 = obj.points[1];
      if (rot !== 0) {
        // Rotate line endpoints, then test distance
        const cx = t.x + t.width / 2;
        const cy = t.y + t.height / 2;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const rp1 = { x: cx + (p1.x - cx) * cos - (p1.y - cy) * sin, y: cy + (p1.x - cx) * sin + (p1.y - cy) * cos };
        const rp2 = { x: cx + (p2.x - cx) * cos - (p2.y - cy) * sin, y: cy + (p2.x - cx) * sin + (p2.y - cy) * cos };
        const dist = pointToSegmentDist(worldX, worldY, rp1.x, rp1.y, rp2.x, rp2.y);
        if (dist < 3) return obj.id;
      } else {
        const dist = pointToSegmentDist(worldX, worldY, p1.x, p1.y, p2.x, p2.y);
        if (dist < 3) return obj.id;
      }
    } else {
      // Transform click point by inverse rotation before AABB test
      let testX = worldX;
      let testY = worldY;
      if (rot !== 0) {
        const cx = t.x + t.width / 2;
        const cy = t.y + t.height / 2;
        const cos = Math.cos(-rot);
        const sin = Math.sin(-rot);
        const dx = worldX - cx;
        const dy = worldY - cy;
        testX = cx + dx * cos - dy * sin;
        testY = cy + dx * sin + dy * cos;
      }
      if (
        testX >= t.x &&
        testX <= t.x + t.width &&
        testY >= t.y &&
        testY <= t.y + t.height
      ) {
        return obj.id;
      }
    }
  }
  return null;
}

// Hit test for resize/rotate handles around selected objects
export function hitTestHandle(worldX: number, worldY: number, zoom: number): HandleType {
  const store = useStore.getState();
  if (store.selectedIds.length === 0) return null;

  // Get bounding box of entire selection
  const bbox = getSelectionBBox();
  if (!bbox) return null;

  const handleSize = Math.max(12, 8) / zoom; // minimum 12 screen-pixel hit target
  const hs = handleSize / 2;

  // Rotation handle (above top center)
  const rotHandleY = bbox.y - 20 / zoom;
  if (Math.abs(worldX - (bbox.x + bbox.w / 2)) < hs * 2 &&
      Math.abs(worldY - rotHandleY) < hs * 2) {
    return "rotate";
  }

  // Corner handles
  const corners: [number, number, HandleType][] = [
    [bbox.x, bbox.y, "nw"],
    [bbox.x + bbox.w, bbox.y, "ne"],
    [bbox.x, bbox.y + bbox.h, "sw"],
    [bbox.x + bbox.w, bbox.y + bbox.h, "se"],
  ];
  for (const [cx, cy, handle] of corners) {
    if (Math.abs(worldX - cx) < hs && Math.abs(worldY - cy) < hs) {
      return handle;
    }
  }

  // Edge midpoint handles
  const edges: [number, number, HandleType][] = [
    [bbox.x + bbox.w / 2, bbox.y, "n"],
    [bbox.x + bbox.w / 2, bbox.y + bbox.h, "s"],
    [bbox.x, bbox.y + bbox.h / 2, "w"],
    [bbox.x + bbox.w, bbox.y + bbox.h / 2, "e"],
  ];
  for (const [cx, cy, handle] of edges) {
    if (Math.abs(worldX - cx) < hs && Math.abs(worldY - cy) < hs) {
      return handle;
    }
  }

  return null;
}

export function getSelectionBBox(): { x: number; y: number; w: number; h: number } | null {
  const store = useStore.getState();
  if (store.selectedIds.length === 0) return null;

  const selected = store.selectedIds
    .map((id) => store.objectsById.get(id))
    .filter((o): o is DesignObject => o != null);
  if (selected.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const obj of selected) {
    const t = obj.transform;
    const rot = (t.rotation || 0) * Math.PI / 180;
    if (rot !== 0) {
      // Compute AABB of rotated rectangle corners
      const cx = t.x + t.width / 2;
      const cy = t.y + t.height / 2;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const hw = t.width / 2;
      const hh = t.height / 2;
      for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as [number, number][]) {
        const rx = cx + dx * cos - dy * sin;
        const ry = cy + dx * sin + dy * cos;
        minX = Math.min(minX, rx);
        minY = Math.min(minY, ry);
        maxX = Math.max(maxX, rx);
        maxY = Math.max(maxY, ry);
      }
    } else {
      minX = Math.min(minX, t.x);
      minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x + t.width);
      maxY = Math.max(maxY, t.y + t.height);
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function pointToSegmentDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function handleSelectDown(worldX: number, worldY: number, e: React.PointerEvent) {
  const store = useStore.getState();

  // Check handle hit first (only if something is selected)
  if (store.selectedIds.length > 0) {
    const handle = hitTestHandle(worldX, worldY, store.camera.zoom);
    if (handle) {
      drag.activeHandle = handle;
      const bbox = getSelectionBBox()!;
      drag.handleOriginal = { x: bbox.x, y: bbox.y, width: bbox.w, height: bbox.h };
      // Store original transforms for all selected objects (P6: O(1) lookup)
      for (const id of store.selectedIds) {
        const obj = store.objectsById.get(id);
        if (obj) {
          drag.originalTransforms.set(id, {
            x: obj.transform.x,
            y: obj.transform.y,
            width: obj.transform.width,
            height: obj.transform.height,
            rotation: obj.transform.rotation,
          });
        }
      }
      return;
    }
  }

  // Normal object hit test
  const hitId = hitTest(worldX, worldY);

  if (hitId) {
    if (e.ctrlKey && e.shiftKey) {
      // Ctrl+Shift+click: remove from selection
      store.removeFromSelection(hitId);
    } else if (e.shiftKey) {
      // Shift+click: toggle in selection
      if (store.selectedSet.has(hitId)) {
        store.removeFromSelection(hitId);
      } else {
        store.addToSelection(hitId);
      }
    } else if (!store.selectedSet.has(hitId)) {
      store.setSelectedIds([hitId]);
    }
    drag.dragTarget = hitId;
    // Store original positions for all selected objects (P6: O(1) lookup)
    const selectedIds = useStore.getState().selectedIds;
    for (const id of selectedIds) {
      const obj = store.objectsById.get(id);
      if (obj) {
        drag.originalTransforms.set(id, {
          x: obj.transform.x,
          y: obj.transform.y,
          width: obj.transform.width,
          height: obj.transform.height,
          rotation: obj.transform.rotation,
        });
      }
    }
    drag.dragOffsetX = 0;
    drag.dragOffsetY = 0;
  } else {
    // Click on empty space - start marquee selection
    if (!e.shiftKey) {
      store.clearSelection();
    }
    drag.isMarquee = true;
    drag.marqueeDirection = "ltr";
  }
}

function handleSelectMove(worldX: number, worldY: number, e: React.PointerEvent) {
  // Handle resize/rotate
  if (drag.activeHandle && drag.handleOriginal) {
    handleResizeMove(worldX, worldY, e);
    return;
  }

  // Handle marquee selection
  if (drag.isMarquee) {
    drag.marqueeDirection = worldX >= drag.startX ? "ltr" : "rtl";
    // Update selection based on marquee box
    updateMarqueeSelection(worldX, worldY);
    return;
  }

  // Handle object dragging
  if (!drag.dragTarget) return;

  const store = useStore.getState();
  const dx = worldX - drag.startX;
  const dy = worldY - drag.startY;

  // Compute smart guides: find alignment with non-selected objects
  const SNAP_THRESHOLD = 2; // mm
  const guides: Array<{ type: "h" | "v"; pos: number }> = [];
  const otherObjects = store.objects.filter(
    (o) => !store.selectedSet.has(o.id) && o.visible && !o.locked
  );

  // Compute selected objects' bounding box (at new position)
  let selMinX = Infinity, selMinY = Infinity, selMaxX = -Infinity, selMaxY = -Infinity;
  for (const id of store.selectedIds) {
    const orig = drag.originalTransforms.get(id);
    if (!orig) continue;
    selMinX = Math.min(selMinX, orig.x + dx);
    selMinY = Math.min(selMinY, orig.y + dy);
    selMaxX = Math.max(selMaxX, orig.x + dx + orig.width);
    selMaxY = Math.max(selMaxY, orig.y + dy + orig.height);
  }
  const selCenterX = (selMinX + selMaxX) / 2;
  const selCenterY = (selMinY + selMaxY) / 2;

  let snapDx = 0, snapDy = 0;
  let snappedH = false, snappedV = false;

  for (const other of otherObjects) {
    const ot = other.transform;
    const oLeft = ot.x, oRight = ot.x + ot.width, oCenterX = ot.x + ot.width / 2;
    const oTop = ot.y, oBottom = ot.y + ot.height, oCenterY = ot.y + ot.height / 2;

    // Vertical guides (snap X positions)
    if (!snappedV) {
      const xEdges = [
        { sel: selMinX, ref: oLeft }, { sel: selMinX, ref: oRight }, { sel: selMinX, ref: oCenterX },
        { sel: selMaxX, ref: oLeft }, { sel: selMaxX, ref: oRight }, { sel: selMaxX, ref: oCenterX },
        { sel: selCenterX, ref: oCenterX },
      ];
      for (const { sel, ref } of xEdges) {
        if (Math.abs(sel - ref) < SNAP_THRESHOLD) {
          snapDx = ref - sel;
          guides.push({ type: "v", pos: ref });
          snappedV = true;
          break;
        }
      }
    }

    // Horizontal guides (snap Y positions)
    if (!snappedH) {
      const yEdges = [
        { sel: selMinY, ref: oTop }, { sel: selMinY, ref: oBottom }, { sel: selMinY, ref: oCenterY },
        { sel: selMaxY, ref: oTop }, { sel: selMaxY, ref: oBottom }, { sel: selMaxY, ref: oCenterY },
        { sel: selCenterY, ref: oCenterY },
      ];
      for (const { sel, ref } of yEdges) {
        if (Math.abs(sel - ref) < SNAP_THRESHOLD) {
          snapDy = ref - sel;
          guides.push({ type: "h", pos: ref });
          snappedH = true;
          break;
        }
      }
    }
  }

  // P2: Diff guides before writing to avoid unnecessary Zustand set() calls
  const currentGuides = store.guides;
  const guidesChanged = guides.length !== currentGuides.length ||
    guides.some((g, i) => g.type !== currentGuides[i]?.type || g.pos !== currentGuides[i]?.pos);
  if (guidesChanged) store.setGuides(guides);

  // P1: Batch all object updates into a single Zustand set() call
  const updates: Array<{ id: string; partial: Partial<DesignObject> }> = [];
  for (const id of store.selectedIds) {
    const original = drag.originalTransforms.get(id);
    if (!original) continue;
    const obj = store.objectsById.get(id); // P6: O(1) lookup
    if (!obj) continue;

    let newX = original.x + dx + snapDx;
    let newY = original.y + dy + snapDy;

    if (store.snapToGrid) {
      newX = Math.round(newX / store.gridSize) * store.gridSize;
      newY = Math.round(newY / store.gridSize) * store.gridSize;
    }

    updates.push({
      id,
      partial: {
        transform: { ...obj.transform, x: newX, y: newY },
      },
    });
  }
  if (updates.length > 0) store.updateObjects(updates);
}

function handleResizeMove(worldX: number, worldY: number, e: React.PointerEvent) {
  const store = useStore.getState();
  const handle = drag.activeHandle!;
  const orig = drag.handleOriginal!;
  const shiftKey = e.shiftKey;

  if (handle === "rotate") {
    // Rotation: angle from center of selection to cursor
    const cx = orig.x + orig.width / 2;
    const cy = orig.y + orig.height / 2;
    const startAngle = Math.atan2(drag.startY - cy, drag.startX - cx);
    const currentAngle = Math.atan2(worldY - cy, worldX - cx);
    let delta = ((currentAngle - startAngle) * 180) / Math.PI;

    // Snap to 15 degree increments with shift
    if (shiftKey) {
      delta = Math.round(delta / 15) * 15;
    }

    const rotUpdates: Array<{ id: string; partial: Partial<DesignObject> }> = [];
    for (const id of store.selectedIds) {
      const objOrig = drag.originalTransforms.get(id);
      if (!objOrig) continue;
      const obj = store.objectsById.get(id);
      if (!obj) continue;
      rotUpdates.push({
        id,
        partial: {
          transform: { ...obj.transform, rotation: ((obj.transform.rotation + delta) % 360 + 360) % 360 },
        },
      });
    }
    if (rotUpdates.length > 0) store.updateObjects(rotUpdates);
    // Reset start angle so rotation is incremental
    drag.startX = worldX;
    drag.startY = worldY;
    return;
  }

  // Resize: calculate new bbox based on handle drag
  let newX = orig.x;
  let newY = orig.y;
  let newW = orig.width;
  let newH = orig.height;

  const dx = worldX - drag.startX;
  const dy = worldY - drag.startY;

  switch (handle) {
    case "se": newW = orig.width + dx; newH = orig.height + dy; break;
    case "sw": newX = orig.x + dx; newW = orig.width - dx; newH = orig.height + dy; break;
    case "ne": newY = orig.y + dy; newW = orig.width + dx; newH = orig.height - dy; break;
    case "nw": newX = orig.x + dx; newY = orig.y + dy; newW = orig.width - dx; newH = orig.height - dy; break;
    case "n": newY = orig.y + dy; newH = orig.height - dy; break;
    case "s": newH = orig.height + dy; break;
    case "w": newX = orig.x + dx; newW = orig.width - dx; break;
    case "e": newW = orig.width + dx; break;
  }

  // Maintain aspect ratio with Shift
  if (shiftKey && ["nw", "ne", "sw", "se"].includes(handle)) {
    const aspect = orig.width / orig.height;
    if (Math.abs(dx) > Math.abs(dy)) {
      newH = newW / aspect;
      if (handle === "nw" || handle === "ne") {
        newY = orig.y + orig.height - newH;
      }
    } else {
      newW = newH * aspect;
      if (handle === "nw" || handle === "sw") {
        newX = orig.x + orig.width - newW;
      }
    }
  }

  // Prevent negative sizes
  if (newW < 1) { newW = 1; }
  if (newH < 1) { newH = 1; }

  // Scale each selected object proportionally (P1: batched, P6: O(1) lookup)
  const scaleUpdates: Array<{ id: string; partial: Partial<DesignObject> }> = [];
  for (const id of store.selectedIds) {
    const objOrig = drag.originalTransforms.get(id);
    if (!objOrig) continue;
    const obj = store.objectsById.get(id);
    if (!obj) continue;

    const relX = (objOrig.x - orig.x) / (orig.width || 1);
    const relY = (objOrig.y - orig.y) / (orig.height || 1);
    const relW = objOrig.width / (orig.width || 1);
    const relH = objOrig.height / (orig.height || 1);

    scaleUpdates.push({
      id,
      partial: {
        transform: {
          ...obj.transform,
          x: newX + relX * newW,
          y: newY + relY * newH,
          width: Math.max(1, relW * newW),
          height: Math.max(1, relH * newH),
        },
      },
    });
  }
  if (scaleUpdates.length > 0) store.updateObjects(scaleUpdates);
}

function updateMarqueeSelection(worldX: number, worldY: number) {
  const store = useStore.getState();
  const x1 = Math.min(drag.startX, worldX);
  const y1 = Math.min(drag.startY, worldY);
  const x2 = Math.max(drag.startX, worldX);
  const y2 = Math.max(drag.startY, worldY);

  const isLTR = worldX >= drag.startX;

  const hitIds: string[] = [];
  for (const obj of store.objects) {
    if (!obj.visible || obj.locked) continue;
    const t = obj.transform;
    const objLeft = t.x;
    const objRight = t.x + t.width;
    const objTop = t.y;
    const objBottom = t.y + t.height;

    if (isLTR) {
      // Left-to-right: fully contained
      if (objLeft >= x1 && objRight <= x2 && objTop >= y1 && objBottom <= y2) {
        hitIds.push(obj.id);
      }
    } else {
      // Right-to-left: intersecting
      if (objRight >= x1 && objLeft <= x2 && objBottom >= y1 && objTop <= y2) {
        hitIds.push(obj.id);
      }
    }
  }

  store.setSelectedIds(hitIds);
}

function handleSelectUp(_worldX: number, _worldY: number) {
  // Clear smart guides
  useStore.getState().setGuides([]);

  if (drag.activeHandle && drag.handleOriginal) {
    // Push undo command for resize/rotate
    const store = useStore.getState();
    const originalPositions = new Map(drag.originalTransforms);
    const finalPositions = new Map<string, { x: number; y: number; width: number; height: number; rotation: number }>();

    for (const id of store.selectedIds) {
      const obj = store.objectsById.get(id);
      if (obj) {
        finalPositions.set(id, {
          x: obj.transform.x, y: obj.transform.y,
          width: obj.transform.width, height: obj.transform.height,
          rotation: obj.transform.rotation,
        });
      }
    }

    let changed = false;
    for (const [id, orig] of originalPositions) {
      const final = finalPositions.get(id);
      if (final && (orig.x !== final.x || orig.y !== final.y ||
          orig.width !== final.width || orig.height !== final.height ||
          orig.rotation !== final.rotation)) {
        changed = true;
        break;
      }
    }

    if (changed) {
      store.pushCommand({
        type: "resize",
        undo: () => {
          for (const [id, pos] of originalPositions) {
            const obj = useStore.getState().objectsById.get(id);
            if (obj) {
              useStore.getState().updateObject(id, {
                transform: { ...obj.transform, ...pos },
              });
            }
          }
        },
        redo: () => {
          for (const [id, pos] of finalPositions) {
            const obj = useStore.getState().objectsById.get(id);
            if (obj) {
              useStore.getState().updateObject(id, {
                transform: { ...obj.transform, ...pos },
              });
            }
          }
        },
      });
    }
    return;
  }

  if (drag.isMarquee) {
    // Marquee selection is already applied live during drag
    return;
  }

  if (drag.dragTarget && drag.originalTransforms.size > 0) {
    const store = useStore.getState();
    const finalPositions = new Map<string, { x: number; y: number }>();
    const originalPositions = new Map<string, { x: number; y: number }>();

    for (const [id, orig] of drag.originalTransforms) {
      originalPositions.set(id, { x: orig.x, y: orig.y });
    }

    for (const id of store.selectedIds) {
      const obj = store.objectsById.get(id);
      if (obj) {
        finalPositions.set(id, { x: obj.transform.x, y: obj.transform.y });
      }
    }

    let moved = false;
    for (const [id, orig] of originalPositions) {
      const final = finalPositions.get(id);
      if (final && (orig.x !== final.x || orig.y !== final.y)) {
        moved = true;
        break;
      }
    }

    if (moved) {
      store.pushCommand({
        type: "move",
        undo: () => {
          for (const [id, pos] of originalPositions) {
            const obj = useStore.getState().objectsById.get(id);
            if (obj) {
              useStore.getState().updateObject(id, {
                transform: { ...obj.transform, x: pos.x, y: pos.y },
              });
            }
          }
        },
        redo: () => {
          for (const [id, pos] of finalPositions) {
            const obj = useStore.getState().objectsById.get(id);
            if (obj) {
              useStore.getState().updateObject(id, {
                transform: { ...obj.transform, x: pos.x, y: pos.y },
              });
            }
          }
        },
      });
    }
  }
}

// --- SHAPE TOOLS ---

function handleShapeDown(worldX: number, worldY: number, tool: string) {
  const store = useStore.getState();
  const layerColor = store.layers[store.activeLayerIndex]?.color || "#4a90e2";

  const baseObj: DesignObject = {
    id: generateId(),
    type: tool === "line" ? "line" : tool as "rectangle" | "ellipse",
    name: `${tool.charAt(0).toUpperCase() + tool.slice(1)} ${store.objects.length + 1}`,
    transform: {
      x: worldX,
      y: worldY,
      width: 0,
      height: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    },
    layerIndex: store.activeLayerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: layerColor,
    strokeWidth: 1,
    opacity: 1,
  };

  if (tool === "line") {
    baseObj.points = [
      { x: worldX, y: worldY },
      { x: worldX, y: worldY },
    ];
  }

  store.setDrawingObject(baseObj);
}

function handleShapeMove(worldX: number, worldY: number, tool: string) {
  const store = useStore.getState();
  const obj = store.drawingObject;
  if (!obj) return;

  let x = Math.min(drag.startX, worldX);
  let y = Math.min(drag.startY, worldY);
  let w = Math.abs(worldX - drag.startX);
  let h = Math.abs(worldY - drag.startY);

  if (store.snapToGrid) {
    x = Math.round(x / store.gridSize) * store.gridSize;
    y = Math.round(y / store.gridSize) * store.gridSize;
    w = Math.round(w / store.gridSize) * store.gridSize;
    h = Math.round(h / store.gridSize) * store.gridSize;
  }

  if (tool === "line") {
    let endX = worldX;
    let endY = worldY;
    if (store.snapToGrid) {
      endX = Math.round(endX / store.gridSize) * store.gridSize;
      endY = Math.round(endY / store.gridSize) * store.gridSize;
    }
    store.setDrawingObject({
      ...obj,
      points: [
        { x: drag.startX, y: drag.startY },
        { x: endX, y: endY },
      ],
      transform: {
        ...obj.transform,
        x: Math.min(drag.startX, endX),
        y: Math.min(drag.startY, endY),
        width: Math.abs(endX - drag.startX),
        height: Math.abs(endY - drag.startY),
      },
    });
  } else {
    store.setDrawingObject({
      ...obj,
      transform: {
        ...obj.transform,
        x,
        y,
        width: w,
        height: h,
      },
    });
  }
}

function handleShapeUp() {
  const store = useStore.getState();
  const obj = store.drawingObject;
  if (!obj) return;

  const t = obj.transform;
  if (t.width < 1 && t.height < 1 && obj.type !== "line") {
    store.setDrawingObject(null);
    return;
  }

  const newObj = { ...obj };
  store.setDrawingObject(null);
  store.addObject(newObj);
  store.setSelectedIds([newObj.id]);

  store.pushCommand({
    type: "add",
    undo: () => useStore.getState().removeObjects([newObj.id]),
    redo: () => useStore.getState().addObject(newObj),
  });
}

// --- PEN TOOL ---

function handlePenDown(worldX: number, worldY: number, _e: React.PointerEvent) {
  const store = useStore.getState();
  let x = worldX;
  let y = worldY;
  if (store.snapToGrid) {
    x = Math.round(x / store.gridSize) * store.gridSize;
    y = Math.round(y / store.gridSize) * store.gridSize;
  }

  if (!penState.isDrawing) {
    // Start new path
    penState.isDrawing = true;
    penState.objectId = generateId();
    penState.points = [{ x, y }];
    penState.isDraggingHandle = true;
    penState.currentMouse = { x, y };
    updatePenPreview();
    return;
  }

  // Check if clicking near first point to close
  const firstPt = penState.points[0];
  const zoom = store.camera.zoom;
  const dist = Math.hypot(x - firstPt.x, y - firstPt.y);
  if (penState.points.length >= 3 && dist < PEN_CLOSE_RADIUS / zoom) {
    commitPen(true);
    return;
  }

  // Add new anchor point
  penState.points.push({ x, y });
  penState.isDraggingHandle = true;
  updatePenPreview();
}

function handlePenMove(worldX: number, worldY: number) {
  penState.currentMouse = { x: worldX, y: worldY };

  if (penState.isDraggingHandle && drag.isDragging && penState.points.length > 0) {
    const lastIdx = penState.points.length - 1;
    const anchor = penState.points[lastIdx];
    // Set handleOut to cursor position (absolute coords)
    const handleOut = { x: worldX, y: worldY };
    // Mirror handleIn symmetrically around anchor
    const handleIn = {
      x: 2 * anchor.x - worldX,
      y: 2 * anchor.y - worldY,
    };
    penState.points[lastIdx] = {
      ...anchor,
      handleOut,
      handleIn,
    };
  }

  if (penState.isDrawing) {
    updatePenPreview();
  }
}

function handlePenUp() {
  penState.isDraggingHandle = false;
  if (penState.isDrawing) {
    updatePenPreview();
  }
}

function updatePenPreview() {
  const store = useStore.getState();
  if (penState.points.length === 0) return;

  const layerColor = store.layers[store.activeLayerIndex]?.color || "#4a90e2";

  // Build preview points: existing points + synthetic tail at cursor
  const previewPoints: PathPoint[] = [...penState.points];
  if (penState.currentMouse && !penState.isDraggingHandle) {
    previewPoints.push({ x: penState.currentMouse.x, y: penState.currentMouse.y });
  }

  // Compute bounding box from all points
  const xs = previewPoints.map((p) => p.x);
  const ys = previewPoints.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  const drawObj: DesignObject = {
    id: penState.objectId,
    type: "path",
    name: "Drawing path",
    transform: {
      x: minX,
      y: minY,
      width: maxX - minX || 1,
      height: maxY - minY || 1,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    },
    layerIndex: store.activeLayerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: layerColor,
    strokeWidth: 1,
    opacity: 1,
    points: previewPoints,
    closed: false,
  };

  store.setDrawingObject(drawObj);
}

function commitPen(closed: boolean) {
  if (penState.points.length < 2) {
    cancelPen();
    return;
  }

  const store = useStore.getState();
  const layerColor = store.layers[store.activeLayerIndex]?.color || "#4a90e2";
  const points = [...penState.points];

  // Compute bounding box
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  const obj: DesignObject = {
    id: penState.objectId,
    type: "path",
    name: `Path ${store.objects.length + 1}`,
    transform: {
      x: minX,
      y: minY,
      width: maxX - minX || 1,
      height: maxY - minY || 1,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    },
    layerIndex: store.activeLayerIndex,
    visible: true,
    locked: false,
    fill: null,
    stroke: layerColor,
    strokeWidth: 1,
    opacity: 1,
    points,
    closed,
  };

  store.setDrawingObject(null);
  resetPenState();

  store.withUndo("draw-path", () => {
    store.addObject(obj);
    store.setSelectedIds([obj.id]);
  });
}

function cancelPen() {
  if (penState.points.length >= 2) {
    commitPen(false);
    return;
  }
  useStore.getState().setDrawingObject(null);
  resetPenState();
}

function resetPenState() {
  penState.isDrawing = false;
  penState.points = [];
  penState.currentMouse = null;
  penState.isDraggingHandle = false;
  penState.objectId = "";
}

// --- NODE EDITOR ---

export function hitTestNodeHandles(
  worldX: number,
  worldY: number,
  zoom: number
): { index: number; target: "node" | "handleIn" | "handleOut" } | null {
  const store = useStore.getState();
  const { pathId } = store.nodeEditState;
  if (!pathId) return null;

  const obj = store.objects.find((o) => o.id === pathId);
  if (!obj || !obj.points) return null;

  const hitRadius = NODE_HIT_RADIUS / zoom;

  // Hit test handles first (they're on top visually)
  for (let i = 0; i < obj.points.length; i++) {
    const pt = obj.points[i];
    if (pt.handleOut) {
      const dist = Math.hypot(worldX - pt.handleOut.x, worldY - pt.handleOut.y);
      if (dist < hitRadius) return { index: i, target: "handleOut" };
    }
    if (pt.handleIn) {
      const dist = Math.hypot(worldX - pt.handleIn.x, worldY - pt.handleIn.y);
      if (dist < hitRadius) return { index: i, target: "handleIn" };
    }
  }

  // Hit test anchor points
  for (let i = 0; i < obj.points.length; i++) {
    const pt = obj.points[i];
    const dist = Math.hypot(worldX - pt.x, worldY - pt.y);
    if (dist < hitRadius) return { index: i, target: "node" };
  }

  return null;
}

function handleNodeDown(worldX: number, worldY: number, _e: React.PointerEvent) {
  const store = useStore.getState();

  // 1. Hit test nodes/handles on current path
  if (store.nodeEditState.pathId) {
    const hit = hitTestNodeHandles(worldX, worldY, store.camera.zoom);
    if (hit) {
      const obj = store.objects.find((o) => o.id === store.nodeEditState.pathId);
      if (obj && obj.points) {
        nodeDrag.isDragging = true;
        nodeDrag.nodeIndex = hit.index;
        nodeDrag.target = hit.target;
        nodeDrag.startX = worldX;
        nodeDrag.startY = worldY;
        nodeDrag.originalPoints = obj.points.map((p) => ({
          ...p,
          handleIn: p.handleIn ? { ...p.handleIn } : undefined,
          handleOut: p.handleOut ? { ...p.handleOut } : undefined,
        }));
        store.setNodeEditState({ pathId: store.nodeEditState.pathId, selectedNodeIndex: hit.index });
        store.beginPropertyEdit();
      }
      return;
    }
  }

  // 2. Hit test objects
  const hitId = hitTest(worldX, worldY);
  if (hitId) {
    const hitObj = store.objects.find((o) => o.id === hitId);
    if (hitObj && hitObj.type === "path") {
      // Enter node editing on this path
      store.setSelectedIds([hitId]);
      store.setNodeEditState({ pathId: hitId, selectedNodeIndex: null });
    } else {
      // Select non-path normally, clear node edit
      store.setSelectedIds([hitId]);
      store.setNodeEditState({ pathId: null, selectedNodeIndex: null });
    }
    return;
  }

  // 3. Empty space -- deselect node, keep path selected
  store.setNodeEditState({
    pathId: store.nodeEditState.pathId,
    selectedNodeIndex: null,
  });
}

function handleNodeMove(worldX: number, worldY: number) {
  if (!nodeDrag.isDragging) return;

  const store = useStore.getState();
  const { pathId } = store.nodeEditState;
  if (!pathId) return;

  const obj = store.objects.find((o) => o.id === pathId);
  if (!obj || !obj.points) return;

  const dx = worldX - nodeDrag.startX;
  const dy = worldY - nodeDrag.startY;
  const newPoints = nodeDrag.originalPoints.map((p) => ({
    ...p,
    handleIn: p.handleIn ? { ...p.handleIn } : undefined,
    handleOut: p.handleOut ? { ...p.handleOut } : undefined,
  }));

  const idx = nodeDrag.nodeIndex;
  const origPt = nodeDrag.originalPoints[idx];

  if (nodeDrag.target === "node") {
    // Move anchor + both handles together
    newPoints[idx] = {
      ...origPt,
      x: origPt.x + dx,
      y: origPt.y + dy,
      handleIn: origPt.handleIn
        ? { x: origPt.handleIn.x + dx, y: origPt.handleIn.y + dy }
        : undefined,
      handleOut: origPt.handleOut
        ? { x: origPt.handleOut.x + dx, y: origPt.handleOut.y + dy }
        : undefined,
    };
  } else if (nodeDrag.target === "handleOut") {
    const newHandleOut = {
      x: origPt.handleOut!.x + dx,
      y: origPt.handleOut!.y + dy,
    };
    newPoints[idx] = {
      ...origPt,
      handleOut: newHandleOut,
      // Mirror handleIn if it exists
      handleIn: origPt.handleIn
        ? { x: 2 * origPt.x - newHandleOut.x, y: 2 * origPt.y - newHandleOut.y }
        : undefined,
    };
  } else if (nodeDrag.target === "handleIn") {
    const newHandleIn = {
      x: origPt.handleIn!.x + dx,
      y: origPt.handleIn!.y + dy,
    };
    newPoints[idx] = {
      ...origPt,
      handleIn: newHandleIn,
      // Mirror handleOut if it exists
      handleOut: origPt.handleOut
        ? { x: 2 * origPt.x - newHandleIn.x, y: 2 * origPt.y - newHandleIn.y }
        : undefined,
    };
  }

  store.updateObject(pathId, { points: newPoints });
}

function handleNodeUp() {
  if (nodeDrag.isDragging) {
    useStore.getState().commitPropertyEdit();
    nodeDrag.isDragging = false;
    nodeDrag.nodeIndex = -1;
    nodeDrag.target = null;
    nodeDrag.originalPoints = [];
  }
}

export function deleteSelectedNode() {
  const store = useStore.getState();
  const { pathId, selectedNodeIndex } = store.nodeEditState;
  if (!pathId || selectedNodeIndex === null) return;

  const obj = store.objects.find((o) => o.id === pathId);
  if (!obj || !obj.points) return;

  if (obj.points.length <= 2) {
    // Deleting would leave < 2 points -- delete entire object
    store.withUndo("delete-path", () => {
      store.removeObjects([pathId]);
    });
    store.setNodeEditState({ pathId: null, selectedNodeIndex: null });
    return;
  }

  const newPoints = obj.points.filter((_, i) => i !== selectedNodeIndex);
  const newSelectedIdx = selectedNodeIndex >= newPoints.length ? newPoints.length - 1 : selectedNodeIndex;

  store.withUndo("delete-node", () => {
    store.updateObject(pathId, { points: newPoints });
  });
  store.setNodeEditState({ pathId, selectedNodeIndex: newSelectedIdx });
}

export function handleViewportDoubleClick(worldX: number, worldY: number) {
  const store = useStore.getState();
  const tool = store.activeTool;

  if (tool === "pen" && penState.isDrawing) {
    commitPen(false);
    return;
  }

  if (tool === "node" && store.nodeEditState.pathId) {
    const hit = hitTestNodeHandles(worldX, worldY, store.camera.zoom);
    if (hit && hit.target === "node") {
      const obj = store.objects.find((o) => o.id === store.nodeEditState.pathId);
      if (!obj || !obj.points) return;

      const pt = obj.points[hit.index];
      const newPoints = obj.points.map((p) => ({ ...p, handleIn: p.handleIn ? { ...p.handleIn } : undefined, handleOut: p.handleOut ? { ...p.handleOut } : undefined }));

      if (pt.handleIn || pt.handleOut) {
        // Has handles -> remove them (corner)
        newPoints[hit.index] = { x: pt.x, y: pt.y, handleIn: undefined, handleOut: undefined };
      } else {
        // No handles -> auto-generate smooth handles
        const pts = obj.points;
        const prevIdx = (hit.index - 1 + pts.length) % pts.length;
        const nextIdx = (hit.index + 1) % pts.length;
        const prev = pts[prevIdx];
        const next = pts[nextIdx];

        // Direction from prev to next
        const dirX = next.x - prev.x;
        const dirY = next.y - prev.y;
        const dirLen = Math.hypot(dirX, dirY) || 1;

        // Handle length = 1/3 distance to neighbors
        const distPrev = Math.hypot(pt.x - prev.x, pt.y - prev.y);
        const distNext = Math.hypot(pt.x - next.x, pt.y - next.y);
        const handleLenIn = distPrev / 3;
        const handleLenOut = distNext / 3;

        newPoints[hit.index] = {
          x: pt.x,
          y: pt.y,
          handleIn: {
            x: pt.x - (dirX / dirLen) * handleLenIn,
            y: pt.y - (dirY / dirLen) * handleLenIn,
          },
          handleOut: {
            x: pt.x + (dirX / dirLen) * handleLenOut,
            y: pt.y + (dirY / dirLen) * handleLenOut,
          },
        };
      }

      store.withUndo("toggle-smooth", () => {
        store.updateObject(store.nodeEditState.pathId!, { points: newPoints });
      });
      return;
    }
  }
}

// --- POSITION LASER ---

function handleTextDown(worldX: number, worldY: number) {
  const store = useStore.getState();
  const obj: DesignObject = {
    id: generateId(),
    type: "text",
    name: `Text ${store.objects.length + 1}`,
    transform: {
      x: worldX,
      y: worldY,
      width: 0,
      height: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    },
    layerIndex: store.activeLayerIndex,
    visible: true,
    locked: false,
    fill: "#e8e8e8",
    stroke: "#e8e8e8",
    strokeWidth: 0,
    opacity: 1,
    text: "Text",
    fontSize: 18,
    fontFamily: "sans-serif",
  };
  store.addObject(obj);
  store.setSelectedIds([obj.id]);
  store.setActiveTool("select");
}

function handlePositionLaserDown(worldX: number, worldY: number) {
  const store = useStore.getState();
  if (!store.machineConnected || store.machineState !== "idle") return;
  // Convert canvas Y (top-down) to GRBL Y (bottom-up)
  const machineY = store.workspaceHeight - worldY;
  machineConnection.jogTo(worldX, machineY);
}

// --- TOOL CHANGE ---

export function handleToolChange(newTool: ToolType, previousTool: ToolType) {
  if (previousTool === "pen" && penState.isDrawing) {
    cancelPen();
  }
  if (previousTool === "node") {
    nodeDrag.isDragging = false;
    nodeDrag.nodeIndex = -1;
    nodeDrag.target = null;
    nodeDrag.originalPoints = [];
    useStore.getState().setNodeEditState({ pathId: null, selectedNodeIndex: null });
  }
  if (newTool === "node") {
    // Auto-enter node editing if a path is selected
    const store = useStore.getState();
    if (store.selectedIds.length === 1) {
      const obj = store.objects.find((o) => o.id === store.selectedIds[0]);
      if (obj && obj.type === "path") {
        store.setNodeEditState({ pathId: obj.id, selectedNodeIndex: null });
      }
    }
  }
}

// --- VIEWPORT KEY HANDLER ---

export function handleViewportKeyDown(e: KeyboardEvent): boolean {
  const store = useStore.getState();
  const tool = store.activeTool;

  // Pen tool key intercepts
  if (tool === "pen" && penState.isDrawing) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitPen(false);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelPen();
      return true;
    }
  }

  // Node tool key intercepts
  if (tool === "node") {
    if ((e.key === "Delete" || e.key === "Backspace") && store.nodeEditState.selectedNodeIndex !== null) {
      e.preventDefault();
      deleteSelectedNode();
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (store.nodeEditState.selectedNodeIndex !== null) {
        store.setNodeEditState({ pathId: store.nodeEditState.pathId, selectedNodeIndex: null });
      } else {
        store.setNodeEditState({ pathId: null, selectedNodeIndex: null });
      }
      return true;
    }
  }

  return false;
}
