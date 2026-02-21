import { useStore, generateId } from "../../app/store";
import type { DesignObject } from "../../app/types";

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
  originalTransforms: Map<string, { x: number; y: number; width: number; height: number }>;
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
  }
}

export function handleViewportPointerMove(
  worldX: number,
  worldY: number,
  _e: React.PointerEvent
) {
  if (!drag.isDragging) return;

  const store = useStore.getState();
  const tool = store.activeTool;

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

    if (obj.type === "line" && obj.points && obj.points.length >= 2) {
      const p1 = obj.points[0];
      const p2 = obj.points[1];
      const dist = pointToSegmentDist(worldX, worldY, p1.x, p1.y, p2.x, p2.y);
      if (dist < 3) return obj.id;
    } else {
      if (
        worldX >= t.x &&
        worldX <= t.x + t.width &&
        worldY >= t.y &&
        worldY <= t.y + t.height
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

  const handleSize = 8 / zoom; // handle size in world coords (mm)
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

  const selected = store.objects.filter((o) => store.selectedIds.includes(o.id));
  if (selected.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const obj of selected) {
    const t = obj.transform;
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + t.width);
    maxY = Math.max(maxY, t.y + t.height);
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
      // Store original transforms for all selected objects
      for (const id of store.selectedIds) {
        const obj = store.objects.find((o) => o.id === id);
        if (obj) {
          drag.originalTransforms.set(id, {
            x: obj.transform.x,
            y: obj.transform.y,
            width: obj.transform.width,
            height: obj.transform.height,
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
      if (store.selectedIds.includes(hitId)) {
        store.removeFromSelection(hitId);
      } else {
        store.addToSelection(hitId);
      }
    } else if (!store.selectedIds.includes(hitId)) {
      store.setSelectedIds([hitId]);
    }
    drag.dragTarget = hitId;
    // Store original positions for all selected objects
    const selectedIds = useStore.getState().selectedIds;
    for (const id of selectedIds) {
      const obj = store.objects.find((o) => o.id === id);
      if (obj) {
        drag.originalTransforms.set(id, {
          x: obj.transform.x,
          y: obj.transform.y,
          width: obj.transform.width,
          height: obj.transform.height,
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
    (o) => !store.selectedIds.includes(o.id) && o.visible && !o.locked
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

  store.setGuides(guides);

  for (const id of store.selectedIds) {
    const original = drag.originalTransforms.get(id);
    if (original) {
      let newX = original.x + dx + snapDx;
      let newY = original.y + dy + snapDy;

      if (store.snapToGrid) {
        newX = Math.round(newX / store.gridSize) * store.gridSize;
        newY = Math.round(newY / store.gridSize) * store.gridSize;
      }

      store.updateObject(id, {
        transform: {
          ...store.objects.find((o) => o.id === id)!.transform,
          x: newX,
          y: newY,
        },
      });
    }
  }
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

    for (const id of store.selectedIds) {
      const objOrig = drag.originalTransforms.get(id);
      if (!objOrig) continue;
      const obj = store.objects.find((o) => o.id === id);
      if (!obj) continue;
      store.updateObject(id, {
        transform: { ...obj.transform, rotation: (obj.transform.rotation + delta) % 360 },
      });
    }
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

  // Scale each selected object proportionally
  for (const id of store.selectedIds) {
    const objOrig = drag.originalTransforms.get(id);
    if (!objOrig) continue;
    const obj = store.objects.find((o) => o.id === id);
    if (!obj) continue;

    const relX = (objOrig.x - orig.x) / (orig.width || 1);
    const relY = (objOrig.y - orig.y) / (orig.height || 1);
    const relW = objOrig.width / (orig.width || 1);
    const relH = objOrig.height / (orig.height || 1);

    store.updateObject(id, {
      transform: {
        ...obj.transform,
        x: newX + relX * newW,
        y: newY + relY * newH,
        width: Math.max(1, relW * newW),
        height: Math.max(1, relH * newH),
      },
    });
  }
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
    const finalPositions = new Map<string, { x: number; y: number; width: number; height: number }>();

    for (const id of store.selectedIds) {
      const obj = store.objects.find((o) => o.id === id);
      if (obj) {
        finalPositions.set(id, {
          x: obj.transform.x, y: obj.transform.y,
          width: obj.transform.width, height: obj.transform.height,
        });
      }
    }

    let changed = false;
    for (const [id, orig] of originalPositions) {
      const final = finalPositions.get(id);
      if (final && (orig.x !== final.x || orig.y !== final.y ||
          orig.width !== final.width || orig.height !== final.height)) {
        changed = true;
        break;
      }
    }

    if (changed) {
      store.pushCommand({
        type: "resize",
        undo: () => {
          for (const [id, pos] of originalPositions) {
            const obj = useStore.getState().objects.find((o) => o.id === id);
            if (obj) {
              useStore.getState().updateObject(id, {
                transform: { ...obj.transform, ...pos },
              });
            }
          }
        },
        redo: () => {
          for (const [id, pos] of finalPositions) {
            const obj = useStore.getState().objects.find((o) => o.id === id);
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
      const obj = store.objects.find((o) => o.id === id);
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
            const obj = useStore.getState().objects.find((o) => o.id === id);
            if (obj) {
              useStore.getState().updateObject(id, {
                transform: { ...obj.transform, x: pos.x, y: pos.y },
              });
            }
          }
        },
        redo: () => {
          for (const [id, pos] of finalPositions) {
            const obj = useStore.getState().objects.find((o) => o.id === id);
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
