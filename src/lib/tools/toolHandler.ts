import { useStore, generateId } from "../../app/store";
import type { DesignObject, PathPoint, ToolType } from "../../app/types";
import { machineConnection } from "../machine/connection";
import { movePartial, scalePartial, pointsPartial, pointsBBox, POINTS_EPSILON, orientedHandlePoints } from "../geometry";
import { computeAABB } from "../nesting";
import { findNearestSnapPoint, snapThresholdMm, ellipseDiameter } from "../measure";
import { PX_PER_MM } from "../constants";

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

// Click tolerance (mm): line segment distance AND the hit-band that keeps
// degenerate (zero-width/height collinear) paths click-selectable — without
// it, a pure AABB containment test on a 0-height path hits only at the exact
// float y, i.e. never. Same constant on purpose.
const SEGMENT_HIT_TOLERANCE_MM = 3;

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

// --- MEASURE TOOL STATE ---
// Module-level (NOT a Zustand store field) to avoid Error-185.
// The only React state added for measure is a scalar measureTick useState in Viewport.
export interface MeasureState {
  p1: { x: number; y: number } | null;
  p2: { x: number; y: number } | null;
  hoverPt: { x: number; y: number } | null;
  active: boolean;
  // When the user clicks an ellipse directly, we store the diameter label here
  // instead of starting a segment.
  diameterLabel: string | null;
}

export const measureState: MeasureState = {
  p1: null,
  p2: null,
  hoverPt: null,
  active: false,
  diameterLabel: null,
};

function resetMeasureState() {
  measureState.p1 = null;
  measureState.p2 = null;
  measureState.hoverPt = null;
  measureState.active = false;
  measureState.diameterLabel = null;
}

/** Snap worldX/worldY to nearest snap point, falling back to raw cursor. */
function snapMeasurePoint(worldX: number, worldY: number): { x: number; y: number } {
  const store = useStore.getState();
  const thresh = snapThresholdMm(store.camera.zoom, PX_PER_MM);
  const snapped = findNearestSnapPoint(worldX, worldY, thresh, store.objects);
  return snapped ? { x: snapped.x, y: snapped.y } : { x: worldX, y: worldY };
}

/** Hit-test for an ellipse object (needed for diameter-readout on click). */
function hitTestEllipse(worldX: number, worldY: number): DesignObject | null {
  const { objects } = useStore.getState();
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (!obj.visible || obj.locked || obj.type !== "ellipse") continue;
    const t = obj.transform;
    if (
      worldX >= t.x && worldX <= t.x + t.width &&
      worldY >= t.y && worldY <= t.y + t.height
    ) {
      return obj;
    }
  }
  return null;
}

// Expose marquee state for Viewport rendering
export function getMarqueeState() {
  if (!drag.isMarquee || !drag.isDragging) return null;
  return {
    startX: drag.startX,
    startY: drag.startY,
    direction: drag.marqueeDirection,
  };
}

/** Returns a snapshot of the current measure state for overlay rendering. */
export function getMeasureState(): MeasureState {
  return measureState;
}

// R2/R3: expose drag state so Viewport can gate cursor/readout logic without
// needing access to the private drag object.
export function isDraggingHandle(): boolean {
  return drag.isDragging && drag.activeHandle !== null;
}

// Jen-2/Jen-3: expose rotate-specific drag state.
export function isDraggingRotateHandle(): boolean {
  return drag.isDragging && drag.activeHandle === "rotate";
}

export function getActiveDragHandle(): HandleType {
  return drag.activeHandle;
}

export function isPointerDragging(): boolean {
  return drag.isDragging;
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
    case "measure":
      handleMeasureDown(worldX, worldY);
      break;
    case "pan":
      // Pan tool left-button drag: handled entirely in Viewport's handlePointerDown
      // using the isPanning / panCameraRef deferred-write mechanism.
      // No toolHandler action needed on down for pan.
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

  // Measure tool tracks hover even without drag
  if (tool === "measure") {
    handleMeasureMove(worldX, worldY);
    return;
  }

  // Pan tool: handled in Viewport's handlePointerMove via isPanning.
  if (tool === "pan") return;

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
    case "measure":
      // No up-action; down-handler already committed the measurement.
      break;
    case "pan":
      // Pan up: handled entirely in Viewport's handlePointerUp (P5 mechanism).
      break;
    case "positionLaser":
    case "text":
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
        if (dist < SEGMENT_HIT_TOLERANCE_MM) return obj.id;
      } else {
        const dist = pointToSegmentDist(worldX, worldY, p1.x, p1.y, p2.x, p2.y);
        if (dist < SEGMENT_HIT_TOLERANCE_MM) return obj.id;
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
      // W1b: sub-ε-dim paths (collinear imports — common in DXF/PDF) get a hit
      // band on the degenerate axis; their true bbox is 0-thick now that the
      // ||1 creator clamps are gone, and exact containment would never hit.
      const bandX = obj.type === "path" && t.width < POINTS_EPSILON ? SEGMENT_HIT_TOLERANCE_MM : 0;
      const bandY = obj.type === "path" && t.height < POINTS_EPSILON ? SEGMENT_HIT_TOLERANCE_MM : 0;
      if (
        testX >= t.x - bandX &&
        testX <= t.x + t.width + bandX &&
        testY >= t.y - bandY &&
        testY <= t.y + t.height + bandY
      ) {
        return obj.id;
      }
    }
  }
  return null;
}

// Hit test for resize/rotate handles around selected objects
// R1c: for single-select, test against orientedHandlePoints (rotated anchors).
// Multi-select: keep the existing getSelectionBBox() AABB path unchanged.
export function hitTestHandle(worldX: number, worldY: number, zoom: number): HandleType {
  const store = useStore.getState();
  if (store.selectedIds.length === 0) return null;

  const handleSize = Math.max(12, 8) / zoom; // minimum 12 screen-pixel hit target
  const hs = handleSize / 2;
  const rotateOffset = 20 / zoom; // mm above top-center in local-y

  // --- Single-select: use oriented (rotated) handle anchors ---
  if (store.selectedIds.length === 1) {
    const obj = store.objectsById.get(store.selectedIds[0]);
    if (!obj) return null;
    const t = obj.transform;
    const handles = orientedHandlePoints(t, rotateOffset);

    // Rotation handle first (larger hit target)
    if (Math.hypot(worldX - handles.rotate.x, worldY - handles.rotate.y) < hs * 2) {
      return "rotate";
    }

    // Corners
    const corners: [keyof typeof handles, HandleType][] = [
      ["nw", "nw"], ["ne", "ne"], ["sw", "sw"], ["se", "se"],
    ];
    for (const [key, handle] of corners) {
      const h = handles[key];
      if (Math.abs(worldX - h.x) < hs && Math.abs(worldY - h.y) < hs) {
        return handle;
      }
    }

    // Edges
    const edges: [keyof typeof handles, HandleType][] = [
      ["n", "n"], ["s", "s"], ["w", "w"], ["e", "e"],
    ];
    for (const [key, handle] of edges) {
      const h = handles[key];
      if (Math.abs(worldX - h.x) < hs && Math.abs(worldY - h.y) < hs) {
        return handle;
      }
    }

    return null;
  }

  // --- Multi-select: unchanged AABB path ---
  const bbox = getSelectionBBox();
  if (!bbox) return null;

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

  // P1: Batch all object updates into a single Zustand set() call.
  // Fix 3 (group snap): snap applies to each TOP-LEVEL selected object — groups
  // are selected as a single unit (group.id in selectedIds, children are NOT).
  // movePartial on a group moves the group transform; children maintain relative
  // positions inside the group. Individual child paths never receive independent
  // snap, so traced-image groups move without letter-scatter.
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

    // W1b: route through movePartial so path/line points move WITH the transform
    // (a raw transform x/y write here is exactly the F1 defect).
    updates.push({ id, partial: movePartial(obj, newX, newY) });
  }
  if (updates.length > 0) store.updateObjects(updates);
}

function handleResizeMove(worldX: number, worldY: number, e: React.PointerEvent) {
  const store = useStore.getState();
  const handle = drag.activeHandle!;
  const orig = drag.handleOriginal!;
  const shiftKey = e.shiftKey;

  if (handle === "rotate") {
    // Rotation: cumulative angle from drag start to current cursor, about
    // the selection center captured at drag start (orig.x/y/width/height).
    const cx = orig.x + orig.width / 2;
    const cy = orig.y + orig.height / 2;
    const startAngle = Math.atan2(drag.startY - cy, drag.startX - cx);
    const currentAngle = Math.atan2(worldY - cy, worldX - cx);
    // delta is incremental (startX/Y reset each tick below)
    let delta = ((currentAngle - startAngle) * 180) / Math.PI;

    // Snap to 15 degree increments with shift
    if (shiftKey) {
      delta = Math.round(delta / 15) * 15;
    }

    const rotUpdates: Array<{ id: string; partial: Partial<DesignObject> }> = [];

    if (store.selectedIds.length > 1) {
      // R4: multi-select orbit — compute cumulative angle from original snapshot
      // (critic must-fix #3): the rotate branch resets drag.startX/Y each tick
      // for incremental single-object rotation. For multi-select orbit we can't
      // use per-tick delta to reposition centers (drift accumulates). Instead:
      // cumulative angle = (current stored rotation − original rotation) + this delta.
      // This reads the tick's increment (delta) and adds it to the already-applied
      // total (stored rotation − original rotation), giving the correct cumulative
      // without needing to store extra state. Apply rotation=original+cumulative
      // and center=rotate(originalCenter about selectionCenter by cumulative) — pure
      // snapshot arithmetic, invariant-safe.
      const selCx = orig.x + orig.width / 2;
      const selCy = orig.y + orig.height / 2;

      for (const id of store.selectedIds) {
        const objOrig = drag.originalTransforms.get(id);
        if (!objOrig) continue;
        const obj = store.objectsById.get(id);
        if (!obj) continue;

        // Cumulative angle from original: the math is correct via trig periodicity —
        // cos/sin only see the angle mod 360, and the stored rotation is also mod 360,
        // so the two cancel cleanly. prevApplied + delta is the right running delta.
        const prevApplied = obj.transform.rotation - objOrig.rotation;
        const cumulativeAngle = prevApplied + delta;

        // Orbit the object's ORIGINAL center about the selection center
        const origCx = objOrig.x + objOrig.width / 2;
        const origCy = objOrig.y + objOrig.height / 2;
        const cumRad = cumulativeAngle * Math.PI / 180;
        const cosCum = Math.cos(cumRad);
        const sinCum = Math.sin(cumRad);
        const dx0 = origCx - selCx;
        const dy0 = origCy - selCy;
        const newCx = selCx + dx0 * cosCum - dy0 * sinCum;
        const newCy = selCy + dx0 * sinCum + dy0 * cosCum;
        const newX = newCx - objOrig.width / 2;
        const newY = newCy - objOrig.height / 2;
        const newRot = ((objOrig.rotation + cumulativeAngle) % 360 + 360) % 360;

        // W1b: route through scalePartial to keep points in sync
        const partial = scalePartial(obj, { x: newX, y: newY, width: objOrig.width, height: objOrig.height });
        rotUpdates.push({
          id,
          partial: {
            ...partial,
            transform: { ...partial.transform, rotation: newRot },
          },
        });
      }
    } else {
      // Single-object rotation: incremental (unchanged path)
      for (const id of store.selectedIds) {
        const obj = store.objectsById.get(id);
        if (!obj) continue;
        rotUpdates.push({
          id,
          partial: {
            transform: { ...obj.transform, rotation: ((obj.transform.rotation + delta) % 360 + 360) % 360 },
          },
        });
      }
    }

    if (rotUpdates.length > 0) store.updateObjects(rotUpdates);
    // Reset start angle so rotation is incremental (for both single and multi)
    drag.startX = worldX;
    drag.startY = worldY;
    return;
  }

  // --- Resize ---

  // R1d: Local-axis resize for a single rotated object.
  // Gate: only fires when selectedIds.length === 1 AND rotation !== 0.
  // At rot=0 or multi-select: fall through to the unchanged screen-axis code below.
  // Axis-aligned safety is BY THE GATE — the new code never runs at rot=0.
  if (store.selectedIds.length === 1) {
    const id = store.selectedIds[0];
    const objOrig = drag.originalTransforms.get(id);
    const obj = store.objectsById.get(id);
    if (objOrig && obj) {
      const rot = objOrig.rotation || 0;
      if (rot !== 0) {
        const rad = rot * Math.PI / 180;
        const cosR = Math.cos(rad);
        const sinR = Math.sin(rad);
        const ow = objOrig.width;
        const oh = objOrig.height;

        // World delta from drag start (drag.startX/Y is the drag origin for
        // the resize branch — it does NOT get reset each tick like the rotate
        // branch does; confirmed: only the rotate branch resets it)
        const dxw = worldX - drag.startX;
        const dyw = worldY - drag.startY;

        // Project world delta into local frame
        const dlx = dxw * cosR + dyw * sinR;
        const dly = -dxw * sinR + dyw * cosR;

        // Per-handle: new local size and which local corner is fixed (the opposite edge)
        let nlw = ow;
        let nlh = oh;
        // Fixed-corner signs in local frame (used to reconstruct the anchor world pos)
        // fixSx/fixSy: sign of the FIXED corner's offset from center (+1 or -1)
        let fixSx = 0; // for edge-only handles the other axis is centered
        let fixSy = 0;

        switch (handle) {
          case "se": nlw = ow + dlx; nlh = oh + dly; fixSx = -1; fixSy = -1; break;
          case "sw": nlw = ow - dlx; nlh = oh + dly; fixSx =  1; fixSy = -1; break;
          case "ne": nlw = ow + dlx; nlh = oh - dly; fixSx = -1; fixSy =  1; break;
          case "nw": nlw = ow - dlx; nlh = oh - dly; fixSx =  1; fixSy =  1; break;
          case "e":  nlw = ow + dlx;                 fixSx = -1; fixSy =  0; break;
          case "w":  nlw = ow - dlx;                 fixSx =  1; fixSy =  0; break;
          case "s":                  nlh = oh + dly; fixSx =  0; fixSy = -1; break;
          case "n":                  nlh = oh - dly; fixSx =  0; fixSy =  1; break;
        }

        // Shift aspect-lock compares LOCAL deltas (critic must-fix #3)
        if (shiftKey && ["nw", "ne", "sw", "se"].includes(handle)) {
          const aspect = ow / oh;
          if (Math.abs(dlx) > Math.abs(dly)) {
            nlh = nlw / aspect;
          } else {
            nlw = nlh * aspect;
          }
        }

        // Clamp BEFORE anchor solve (critic must-fix #2: use clamped extents)
        nlw = Math.max(1, nlw);
        nlh = Math.max(1, nlh);

        // Anchor corner: the FIXED corner in world space (computed from original transform)
        // The fixed corner in LOCAL frame is at offset (fixSx * ow/2, fixSy * oh/2)
        const origCx = objOrig.x + objOrig.width / 2;
        const origCy = objOrig.y + objOrig.height / 2;
        const origFixLocalX = fixSx * ow / 2;
        const origFixLocalY = fixSy * oh / 2;
        const anchorWorldX = origCx + origFixLocalX * cosR - origFixLocalY * sinR;
        const anchorWorldY = origCy + origFixLocalX * sinR + origFixLocalY * cosR;

        // The same corner on the NEW rect has local offset (fixSx * nlw/2, fixSy * nlh/2)
        // using CLAMPED half-extents — so the fixed corner doesn't drift at the 1mm floor
        const newFixLocalX = fixSx * nlw / 2;
        const newFixLocalY = fixSy * nlh / 2;

        // Solve for new center: anchorWorld = newCenter + rotated(newFixLocal)
        // newCx = anchorWorldX − (newFixLocalX·cos − newFixLocalY·sin)
        // newCy = anchorWorldY − (newFixLocalX·sin + newFixLocalY·cos)
        const newCx = anchorWorldX - (newFixLocalX * cosR - newFixLocalY * sinR);
        const newCy = anchorWorldY - (newFixLocalX * sinR + newFixLocalY * cosR);
        const newX = newCx - nlw / 2;
        const newY = newCy - nlh / 2;

        // scalePartial contract unchanged — we supply the new AABB rect + preserve rotation
        const partial = scalePartial(obj, { x: newX, y: newY, width: nlw, height: nlh });
        store.updateObjects([{
          id,
          partial: {
            ...partial,
            transform: { ...partial.transform, rotation: rot },
          },
        }]);
        return;
      }
    }
  }

  // --- Screen-axis resize (rot=0 or multi-select — UNCHANGED from original) ---
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

    // W1b: scalePartial maps path/line anchors+handles through the bbox→bbox
    // affine alongside the transform write — REGARDLESS of rotation (a rotation
    // guard here would re-manufacture the transform/points desync; the rotated-
    // resize cursor-frame UX quirk is F30 and applies to primitives identically).
    scaleUpdates.push({
      id,
      partial: scalePartial(obj, {
        x: newX + relX * newW,
        y: newY + relY * newH,
        width: Math.max(1, relW * newW),
        height: Math.max(1, relH * newH),
      }),
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
    // F30: use rotation-aware AABB for marquee selection of rotated objects
    const aabb = computeAABB(obj);
    const objLeft = aabb.x;
    const objRight = aabb.x + aabb.w;
    const objTop = aabb.y;
    const objBottom = aabb.y + aabb.h;

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
      // W1b: delta-restore through scalePartial — restoring TRANSFORM-ONLY
      // snapshots would snap the transform back while path points stay put
      // (visual no-op + re-manufactured desync). Whole-object snapshots are
      // not used here on purpose: they'd bypass pushObjectsUndo's image-strip
      // machinery and balloon the undo stack on image-bearing selections.
      const restoreTo = (positions: Map<string, { x: number; y: number; width: number; height: number; rotation: number }>) => {
        for (const [id, pos] of positions) {
          const obj = useStore.getState().objectsById.get(id);
          if (obj) {
            const partial = scalePartial(obj, pos);
            useStore.getState().updateObject(id, {
              ...partial,
              transform: { ...partial.transform, rotation: pos.rotation },
            });
          }
        }
      };
      store.pushCommand({
        type: "resize",
        undo: () => restoreTo(originalPositions),
        redo: () => restoreTo(finalPositions),
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
      // W1b: delta-restore through movePartial (transform + points partials) —
      // see the resize closure above for why transform-only restore is wrong.
      const restoreTo = (positions: Map<string, { x: number; y: number }>) => {
        for (const [id, pos] of positions) {
          const obj = useStore.getState().objectsById.get(id);
          if (obj) {
            useStore.getState().updateObject(id, movePartial(obj, pos.x, pos.y));
          }
        }
      };
      store.pushCommand({
        type: "move",
        undo: () => restoreTo(originalPositions),
        redo: () => restoreTo(finalPositions),
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

  // W1b: anchors-only loop bbox; no ||1 clamp — a collinear pen path is born
  // with its true (zero-thickness) bbox and the invariant holds at birth.
  const bb = pointsBBox(previewPoints);

  const drawObj: DesignObject = {
    id: penState.objectId,
    type: "path",
    name: "Drawing path",
    transform: {
      x: bb.x,
      y: bb.y,
      width: bb.width,
      height: bb.height,
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

  // W1b: anchors-only loop bbox; no ||1 clamp (see updatePenPreview)
  const bb = pointsBBox(points);

  const obj: DesignObject = {
    id: penState.objectId,
    type: "path",
    name: `Path ${store.objects.length + 1}`,
    transform: {
      x: bb.x,
      y: bb.y,
      width: bb.width,
      height: bb.height,
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

  // W1b: pointsPartial keeps transform ≡ pointsBBox while nodes move
  store.updateObject(pathId, pointsPartial(obj, newPoints));
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
    // W1b: deleting a node can shrink the bbox — keep the transform synced
    store.updateObject(pathId, pointsPartial(obj, newPoints));
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

  // Double-click on a text object in select mode: enter text edit
  if (tool === "select") {
    const hitId = hitTest(worldX, worldY);
    if (hitId) {
      const hitObj = store.objectsById.get(hitId);
      if (hitObj && hitObj.type === "text") {
        store.setTextEditingId(hitId);
        return;
      }
    }
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
        // W1b: handle changes don't move anchors, but pointsPartial keeps the
        // invariant maintained at every points writer uniformly (anchors-only
        // bbox — handle overshoot never changes the transform).
        store.updateObject(store.nodeEditState.pathId!, pointsPartial(obj, newPoints));
      });
      return;
    }
  }
}

// --- POSITION LASER ---

function handleTextDown(worldX: number, worldY: number) {
  const store = useStore.getState();
  const fontSize = 18;
  const obj: DesignObject = {
    id: generateId(),
    type: "text",
    name: `Text ${store.objects.length + 1}`,
    transform: {
      x: worldX,
      y: worldY,
      width: fontSize * 4,
      height: fontSize * 1.3,
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
    text: "",
    fontSize,
    fontFamily: "sans-serif",
  };
  store.addObject(obj);
  store.setSelectedIds([obj.id]);
  store.setTextEditingId(obj.id);
}

function handlePositionLaserDown(worldX: number, worldY: number) {
  const store = useStore.getState();
  if (!store.machineConnected || store.machineState !== "idle") return;
  // Convert canvas Y (top-down) to GRBL Y (bottom-up)
  const machineY = store.workspaceHeight - worldY;
  machineConnection.jogTo(worldX, machineY);
}

// --- MEASURE TOOL ---

function handleMeasureDown(worldX: number, worldY: number) {
  // Reset on re-entry when already frozen (p1+p2 both set): start fresh.
  if (measureState.p1 !== null && measureState.p2 !== null) {
    resetMeasureState();
  }

  // Decision tree (explicit precedence per plan):
  // 1. No p1 pending AND click hits an ellipse -> show diameter, don't start segment.
  // 2. No p1 -> set p1 (snapped).
  // 3. Has p1 -> set p2 (snapped) and freeze.
  if (measureState.p1 === null) {
    // Check for direct ellipse hit first
    const ellipseObj = hitTestEllipse(worldX, worldY);
    if (ellipseObj) {
      resetMeasureState();
      measureState.diameterLabel = ellipseDiameter(ellipseObj);
      measureState.active = true;
      // Store the click position as hoverPt so the overlay can position the label.
      measureState.hoverPt = { x: worldX, y: worldY };
      return;
    }
    // No ellipse hit: set p1
    resetMeasureState();
    measureState.p1 = snapMeasurePoint(worldX, worldY);
    measureState.active = true;
  } else {
    // Set p2 and freeze
    measureState.p2 = snapMeasurePoint(worldX, worldY);
    measureState.hoverPt = null;
  }
}

function handleMeasureMove(worldX: number, worldY: number) {
  if (measureState.diameterLabel !== null) {
    // Update label position as cursor moves after an ellipse click
    measureState.hoverPt = { x: worldX, y: worldY };
  } else if (measureState.p1 !== null && measureState.p2 === null) {
    // Live preview: update snap-aware hover point
    measureState.hoverPt = snapMeasurePoint(worldX, worldY);
  }
  // Note: the viewport bumps measureTick to trigger a redraw.
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
  // Clear measure state whenever leaving the measure tool OR entering it fresh.
  if (previousTool === "measure" || newTool === "measure") {
    resetMeasureState();
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

  // Measure tool: Esc clears the current measurement without switching tools.
  if (tool === "measure" && e.key === "Escape") {
    if (measureState.active) {
      e.preventDefault();
      resetMeasureState();
      return true;
    }
  }

  return false;
}

// Test-only exports — pure helpers exposed for unit testing without changing behavior.
// Not imported anywhere in production code.
export { pointToSegmentDist as _testPointToSegmentDist, hitTest as _testHitTest };
