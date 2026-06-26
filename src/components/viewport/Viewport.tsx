import { useEffect, useRef, useCallback, useState } from "react";
import { Application, Container, Graphics, Text, TextStyle, Sprite, Texture } from "pixi.js";
import { useShallow } from "zustand/shallow";
import { useStore } from "../../app/store";
import { getDirtyObjectIds, clearDirtyObjectIds, setCursorPosition } from "../../app/store";
import type { DesignObject } from "../../app/types";
import { hasPlaceholders } from "../../lib/variableText";
import { handleViewportPointerDown, handleViewportPointerMove, handleViewportPointerUp, getMarqueeState, getSelectionBBox, handleViewportDoubleClick, hitTestHandle, isDraggingRotateHandle, getActiveDragHandle, isPointerDragging, getMeasureState } from "../../lib/tools/toolHandler";
import { measureDistance, measureAngleDeg, formatMeasureLabel } from "../../lib/measure";

import { PX_PER_MM } from "../../lib/constants";
import { composeGroupChild, orientedHandlePoints } from "../../lib/geometry";

// Cache for GPU textures keyed by object ID (avoids retaining megabyte-sized base64 strings as Map keys)
const textureCache = new Map<string, Texture>();

// P8: Content hash cache keyed by display cache key (avoids rebuilding text/image when only transform changes)
const contentHashCache = new Map<string, string>();

function getOrCreateTexture(id: string, imageData: string): Texture {
  let tex = textureCache.get(id);
  if (tex) return tex;
  const img = new Image();
  img.src = imageData;
  tex = Texture.from(img);
  textureCache.set(id, tex);
  return tex;
}

export function Viewport() {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // R3: live rotation angle readout during rotate drag (null = not dragging rotate)
  const [rotationReadout, setRotationReadout] = useState<number | null>(null);
  // Measure tool: scalar tick counter bumped on every pointer-move while measure is active.
  // This is a scalar useState (NOT a new-object useStore selector) to avoid React Error 185.
  // Adding it to the selectionOverlay dep array causes the overlay to redraw with the live
  // measure preview. Mirrors the rotationReadout pattern exactly.
  const [measureTick, setMeasureTick] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const gridRef = useRef<Graphics | null>(null);
  const workspaceRef = useRef<Graphics | null>(null);
  const objectsContainerRef = useRef<Container | null>(null);
  const drawingLayerRef = useRef<Graphics | null>(null);
  const selectionOverlayRef = useRef<Graphics | null>(null);
  const isPanning = useRef(false);
  const lastPan = useRef({ x: 0, y: 0 });
  const spaceHeld = useRef(false);
  // P5: Camera ref for deferred pan writes
  const panCameraRef = useRef({ x: 0, y: 0, zoom: 1 });
  // Persistent display object cache: maps object ID to its Pixi Container
  const displayCacheRef = useRef<Map<string, Container>>(new Map());
  // Text editing: tracks whether a commit/cancel is already in-progress so onBlur
  // doesn't double-fire when Enter/Escape already handled the action.
  const textEditCommittingRef = useRef(false);
  // Stores the original text content when entering edit mode, for Escape-revert.
  const textEditOriginalRef = useRef<string>("");

  const camera = useStore((s) => s.camera);
  const setCamera = useStore((s) => s.setCamera);
  const objects = useStore((s) => s.objects);
  const layers = useStore((s) => s.layers);
  const drawingObject = useStore((s) => s.drawingObject);
  const gridVisible = useStore((s) => s.gridVisible);
  const gridSize = useStore((s) => s.gridSize);
  const workspaceWidth = useStore((s) => s.workspaceWidth);
  const workspaceHeight = useStore((s) => s.workspaceHeight);
  const activeTool = useStore((s) => s.activeTool);
  const nodeEditState = useStore((s) => s.nodeEditState);
  const setNodeEditState = useStore((s) => s.setNodeEditState);
  const guides = useStore((s) => s.guides);
  // Text editing — scalar selectors only (never return new objects/arrays from useStore)
  const textEditingId = useStore((s) => s.textEditingId);
  const setTextEditingId = useStore((s) => s.setTextEditingId);
  const updateObject = useStore((s) => s.updateObject);
  const removeObjects = useStore((s) => s.removeObjects);
  const setActiveTool = useStore((s) => s.setActiveTool);

  // P7: Derived slice -- re-renders selection overlay when selected objects change.
  // Returns original store references so useShallow's === comparison is stable.
  const selectedTransforms = useStore(useShallow((s) => {
    return s.selectedIds
      .map((id) => s.objectsById.get(id))
      .filter((x): x is DesignObject => x != null);
  }));

  // Initialize Pixi.js
  useEffect(() => {
    if (!canvasRef.current || appRef.current) return;

    const app = new Application();
    const initPromise = app.init({
      preference: 'webgl',
      resizeTo: canvasRef.current,
      background: 0x1a1a1a,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    }).then(() => {
      if (!canvasRef.current) return;
      canvasRef.current.appendChild(app.canvas as HTMLCanvasElement);
      appRef.current = app;

      const world = new Container();
      worldRef.current = world;
      app.stage.addChild(world);

      const workspace = new Graphics();
      workspaceRef.current = workspace;
      world.addChild(workspace);

      const grid = new Graphics();
      gridRef.current = grid;
      world.addChild(grid);

      const objectsContainer = new Container();
      objectsContainerRef.current = objectsContainer;
      world.addChild(objectsContainer);

      const drawingLayer = new Graphics();
      drawingLayerRef.current = drawingLayer;
      world.addChild(drawingLayer);

      const selectionOverlay = new Graphics();
      selectionOverlayRef.current = selectionOverlay;
      world.addChild(selectionOverlay);

      // Center workspace
      const cx = app.screen.width / 2;
      const cy = app.screen.height / 2;
      useStore.getState().setCamera({
        x: cx - (workspaceWidth * PX_PER_MM) / 2,
        y: cy - (workspaceHeight * PX_PER_MM) / 2,
        zoom: 1,
      });
    }).catch((err) => console.error("Pixi.js init failed:", err));

    return () => {
      initPromise.then(() => {
        app.destroy(true);
        appRef.current = null;
      }).catch((err) => console.error("Pixi.js destroy failed:", err));
    };
  }, []);

  // Update world transform when camera changes
  useEffect(() => {
    if (!worldRef.current) return;
    worldRef.current.x = camera.x;
    worldRef.current.y = camera.y;
    worldRef.current.scale.set(camera.zoom);
  }, [camera]);

  // Draw grid
  useEffect(() => {
    if (!gridRef.current) return;
    const g = gridRef.current;
    g.clear();
    if (!gridVisible) return;

    const w = workspaceWidth * PX_PER_MM;
    const h = workspaceHeight * PX_PER_MM;
    const step = gridSize * PX_PER_MM;

    // Minor grid
    g.setStrokeStyle({ width: 0.5, color: 0xffffff, alpha: 0.06 });
    for (let x = 0; x <= w; x += step) {
      g.moveTo(x, 0).lineTo(x, h).stroke();
    }
    for (let y = 0; y <= h; y += step) {
      g.moveTo(0, y).lineTo(w, y).stroke();
    }

    // Major grid (every 10)
    const majorStep = step * 10;
    g.setStrokeStyle({ width: 1, color: 0xffffff, alpha: 0.12 });
    for (let x = 0; x <= w; x += majorStep) {
      g.moveTo(x, 0).lineTo(x, h).stroke();
    }
    for (let y = 0; y <= h; y += majorStep) {
      g.moveTo(0, y).lineTo(w, y).stroke();
    }
  }, [gridVisible, gridSize, workspaceWidth, workspaceHeight]);

  // Draw workspace boundary
  useEffect(() => {
    if (!workspaceRef.current) return;
    const g = workspaceRef.current;
    g.clear();
    const w = workspaceWidth * PX_PER_MM;
    const h = workspaceHeight * PX_PER_MM;

    // Workspace background
    g.rect(0, 0, w, h).fill({ color: 0x222222, alpha: 1 });
    // Workspace border
    g.setStrokeStyle({ width: 1, color: 0xffffff, alpha: 0.15 });
    g.rect(0, 0, w, h).stroke();
  }, [workspaceWidth, workspaceHeight]);

  // Draw objects with persistent cache (diff against previous state)
  useEffect(() => {
    if (!objectsContainerRef.current) return;
    const container = objectsContainerRef.current;
    const cache = displayCacheRef.current;

    // P3: Dirty tracking -- only re-render changed objects during drag
    const dirty = getDirtyObjectIds();
    clearDirtyObjectIds();

    // Build set of IDs that should be visible this frame
    // For groups, we use composite keys: "groupId/childId"
    const activeIds = new Set<string>();

    function renderKey(obj: DesignObject, prefix?: string): string {
      return prefix ? `${prefix}/${obj.id}` : obj.id;
    }

    function ensureDisplayObject(key: string, obj: DesignObject) {
      activeIds.add(key);
      const existing = cache.get(key);
      if (existing) {
        // P3: If dirty set is non-empty and this object isn't dirty, skip re-render
        if (dirty.size > 0 && !dirty.has(obj.id)) {
          return;
        }
        // Update existing: clear and re-render (cheaper than full teardown/rebuild)
        if (existing instanceof Graphics) {
          (existing as Graphics).clear();
          renderObject(existing as Graphics, obj);
          applyObjectRotation(existing, obj.transform);
        } else {
          // P8: Content hash for text/image -- skip destroy+rebuild when only transform changed
          const hash = contentHash(obj);
          if (contentHashCache.get(key) === hash) {
            // Content unchanged -- just update transform position
            applyTextImageTransform(existing, obj);
            return;
          }
          // Content changed -- destroy and rebuild
          cache.delete(key);
          container.removeChild(existing);
          existing.destroy({ children: true });
          const newEl = obj.type === "text" ? renderTextObject(obj)
            : obj.type === "image" ? renderImageObject(obj) : null;
          if (newEl) {
            contentHashCache.set(key, hash);
            applyObjectRotation(newEl, obj.transform);
            container.addChild(newEl);
            cache.set(key, newEl);
          }
        }
      } else {
        // Create new display object
        let el: Container | null = null;
        if (obj.type === "text") {
          el = renderTextObject(obj);
          if (el) contentHashCache.set(key, contentHash(obj));
        } else if (obj.type === "image") {
          el = renderImageObject(obj);
          if (el) contentHashCache.set(key, contentHash(obj));
        } else {
          const g = new Graphics();
          renderObject(g, obj);
          el = g;
        }
        if (el) {
          applyObjectRotation(el, obj.transform);
          container.addChild(el);
          cache.set(key, el);
        }
      }
    }

    for (const obj of objects) {
      if (!obj.visible) continue;
      const objLayer = layers[obj.layerIndex];
      if (objLayer && !objLayer.visible) continue;
      if (obj.type === "group" && obj.children) {
        for (const child of obj.children) {
          // W1b: group composition (translation + rotation; path/line points are
          // GROUP-LOCAL) lives in lib/geometry's composeGroupChild — the ONE
          // function shared with gcodeGen's flatten, so screen and cut agree.
          // Note: nested groups are not rendered (this loop is single-level and
          // renderObject has no "group" case — pre-existing; the cut DOES
          // recurse). Do not add viewport recursion in this phase.
          ensureDisplayObject(renderKey(child, obj.id), composeGroupChild(child, obj));
        }
      } else {
        ensureDisplayObject(renderKey(obj), obj);
      }
    }

    // Remove stale entries
    for (const [key, displayObj] of cache) {
      if (!activeIds.has(key)) {
        container.removeChild(displayObj);
        displayObj.destroy({ children: true });
        cache.delete(key);
        contentHashCache.delete(key); // P8: clean up hash cache
      }
    }

    // Evict unused GPU textures (keyed by object ID)
    const activeImageIds = new Set<string>();
    for (const obj of objects) {
      if (obj.imageData) activeImageIds.add(obj.id);
      if (obj.type === "group" && obj.children) {
        for (const child of obj.children) {
          if (child.imageData) activeImageIds.add(child.id);
        }
      }
    }
    for (const [id, tex] of textureCache) {
      if (!activeImageIds.has(id)) {
        tex.destroy(true);
        textureCache.delete(id);
      }
    }
  }, [objects, layers]);

  // Draw temporary drawing object
  useEffect(() => {
    if (!drawingLayerRef.current) return;
    const g = drawingLayerRef.current;
    g.clear();
    if (drawingObject) {
      renderObject(g, drawingObject);
    }
  }, [drawingObject]);

  // Draw selection indicators + handles + marquee (P7: uses derived slice)
  useEffect(() => {
    if (!selectionOverlayRef.current) return;
    const g = selectionOverlayRef.current;
    g.clear();
    g.removeChildren();

    // Per-object selection outlines (color-coded by layer)
    const layers = useStore.getState().layers;
    for (const sel of selectedTransforms) {
      if (!sel) continue;
      const t = sel.transform;
      const px = t.x * PX_PER_MM;
      const py = t.y * PX_PER_MM;
      const pw = t.width * PX_PER_MM;
      const ph = t.height * PX_PER_MM;
      const rot = (t.rotation || 0) * Math.PI / 180;

      const layerColor = layers[sel.layerIndex]?.color || "#4a90e2";
      const selColor = parseInt(layerColor.replace("#", ""), 16);
      g.setStrokeStyle({ width: 1 / camera.zoom, color: selColor, alpha: 0.8 });
      if (rot !== 0) {
        // Draw rotated bounding box
        const cx = px + pw / 2;
        const cy = py + ph / 2;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const corners = [
          [-pw / 2, -ph / 2], [pw / 2, -ph / 2], [pw / 2, ph / 2], [-pw / 2, ph / 2],
        ].map(([dx, dy]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos] as [number, number]);
        g.moveTo(corners[0][0], corners[0][1]);
        for (let i = 1; i < 4; i++) g.lineTo(corners[i][0], corners[i][1]);
        g.closePath().stroke();
      } else {
        g.rect(px, py, pw, ph).stroke();
      }

      // Lock indicator
      if (sel.locked) {
        const lockSize = 10 / camera.zoom;
        const lx = px + pw - lockSize - 2 / camera.zoom;
        const ly = py + 2 / camera.zoom;
        g.rect(lx, ly, lockSize, lockSize).fill({ color: 0xff8000, alpha: 0.6 });
      }
    }

    // Group bounding box with handles (when anything is selected)
    if (selectedTransforms.length > 0) {
      const bbox = getSelectionBBox();
      if (bbox) {
        // Multi-selection bounding box
        if (selectedTransforms.length > 1) {
          const bx = bbox.x * PX_PER_MM;
          const by = bbox.y * PX_PER_MM;
          const bw = bbox.w * PX_PER_MM;
          const bh = bbox.h * PX_PER_MM;
          g.setStrokeStyle({ width: 1 / camera.zoom, color: 0x4a90e2, alpha: 0.4 });
          g.rect(bx, by, bw, bh).stroke();
        }

        const handleSize = 6 / camera.zoom;
        const hs = handleSize / 2;
        const edgeSize = 4 / camera.zoom;
        const ehs = edgeSize / 2;
        const rotateOffsetMm = 20 / camera.zoom;

        if (selectedTransforms.length === 1) {
          // R1b: single-select — draw handles on the ROTATED rectangle
          const sel = selectedTransforms[0];
          const t = sel.transform;
          const handles = orientedHandlePoints(t, rotateOffsetMm);

          // Helper: convert mm handle pos to px
          const toPx = (pt: { x: number; y: number }) => ({ x: pt.x * PX_PER_MM, y: pt.y * PX_PER_MM });

          // Corner handles
          for (const key of ["nw", "ne", "sw", "se"] as const) {
            const { x: cx, y: cy } = toPx(handles[key]);
            g.rect(cx - hs, cy - hs, handleSize, handleSize).fill({ color: 0xffffff });
            g.setStrokeStyle({ width: 1 / camera.zoom, color: 0x4a90e2, alpha: 1 });
            g.rect(cx - hs, cy - hs, handleSize, handleSize).stroke();
          }

          // Edge midpoint handles
          for (const key of ["n", "s", "w", "e"] as const) {
            const { x: cx, y: cy } = toPx(handles[key]);
            g.rect(cx - ehs, cy - ehs, edgeSize, edgeSize).fill({ color: 0xffffff });
            g.setStrokeStyle({ width: 0.5 / camera.zoom, color: 0x4a90e2, alpha: 1 });
            g.rect(cx - ehs, cy - ehs, edgeSize, edgeSize).stroke();
          }

          // Rotation handle — stem from top-center (handles.n) to rotate anchor
          const { x: nx, y: ny } = toPx(handles.n);
          const { x: rx, y: ry } = toPx(handles.rotate);
          const rotR = 4 / camera.zoom;
          g.setStrokeStyle({ width: 0.5 / camera.zoom, color: 0x4a90e2, alpha: 0.6 });
          g.moveTo(nx, ny).lineTo(rx, ry + rotR).stroke();
          g.circle(rx, ry, rotR).fill({ color: 0xffffff });
          g.setStrokeStyle({ width: 1 / camera.zoom, color: 0x4a90e2, alpha: 1 });
          g.circle(rx, ry, rotR).stroke();

        } else {
          // Multi-select: AABB-based handles (unchanged)
          const bx = bbox.x * PX_PER_MM;
          const by = bbox.y * PX_PER_MM;
          const bw = bbox.w * PX_PER_MM;
          const bh = bbox.h * PX_PER_MM;

          // Corner handles
          const corners = [
            [bx, by], [bx + bw, by],
            [bx, by + bh], [bx + bw, by + bh],
          ];
          for (const [cx, cy] of corners) {
            g.rect(cx - hs, cy - hs, handleSize, handleSize).fill({ color: 0xffffff });
            g.setStrokeStyle({ width: 1 / camera.zoom, color: 0x4a90e2, alpha: 1 });
            g.rect(cx - hs, cy - hs, handleSize, handleSize).stroke();
          }

          // Edge midpoint handles
          const edges = [
            [bx + bw / 2, by], [bx + bw / 2, by + bh],
            [bx, by + bh / 2], [bx + bw, by + bh / 2],
          ];
          for (const [cx, cy] of edges) {
            g.rect(cx - ehs, cy - ehs, edgeSize, edgeSize).fill({ color: 0xffffff });
            g.setStrokeStyle({ width: 0.5 / camera.zoom, color: 0x4a90e2, alpha: 1 });
            g.rect(cx - ehs, cy - ehs, edgeSize, edgeSize).stroke();
          }

          // Rotation handle
          const rotY = by - 20 / camera.zoom;
          const rotR = 4 / camera.zoom;
          g.setStrokeStyle({ width: 0.5 / camera.zoom, color: 0x4a90e2, alpha: 0.6 });
          g.moveTo(bx + bw / 2, by).lineTo(bx + bw / 2, rotY + rotR).stroke();
          g.circle(bx + bw / 2, rotY, rotR).fill({ color: 0xffffff });
          g.setStrokeStyle({ width: 1 / camera.zoom, color: 0x4a90e2, alpha: 1 });
          g.circle(bx + bw / 2, rotY, rotR).stroke();
        }
      }
    }
    // --- Node editing overlay ---
    if (activeTool === "node" && nodeEditState.pathId) {
      const pathObj = useStore.getState().objectsById.get(nodeEditState.pathId);
      if (!pathObj || !pathObj.points) {
        // Stale state -- path was deleted
        setNodeEditState({ pathId: null, selectedNodeIndex: null });
      } else {
        const pts = pathObj.points;
        const handleRadius = 4 / camera.zoom;
        const anchorSize = 6 / camera.zoom;
        const ahs = anchorSize / 2;

        for (let i = 0; i < pts.length; i++) {
          const pt = pts[i];
          const px = pt.x * PX_PER_MM;
          const py = pt.y * PX_PER_MM;

          // Draw handle lines and circles
          if (pt.handleIn) {
            const hx = pt.handleIn.x * PX_PER_MM;
            const hy = pt.handleIn.y * PX_PER_MM;
            g.setStrokeStyle({ width: 0.5 / camera.zoom, color: 0x888888, alpha: 0.8 });
            g.moveTo(px, py).lineTo(hx, hy).stroke();
            g.circle(hx, hy, handleRadius).fill({ color: 0x4a90e2, alpha: 1 });
          }
          if (pt.handleOut) {
            const hx = pt.handleOut.x * PX_PER_MM;
            const hy = pt.handleOut.y * PX_PER_MM;
            g.setStrokeStyle({ width: 0.5 / camera.zoom, color: 0x888888, alpha: 0.8 });
            g.moveTo(px, py).lineTo(hx, hy).stroke();
            g.circle(hx, hy, handleRadius).fill({ color: 0x4a90e2, alpha: 1 });
          }

          // Draw anchor square
          const isSelected = nodeEditState.selectedNodeIndex === i;
          if (isSelected) {
            g.rect(px - ahs, py - ahs, anchorSize, anchorSize).fill({ color: 0x4a90e2, alpha: 1 });
          } else {
            g.rect(px - ahs, py - ahs, anchorSize, anchorSize).fill({ color: 0xffffff, alpha: 1 });
            g.setStrokeStyle({ width: 1 / camera.zoom, color: 0x4a90e2, alpha: 1 });
            g.rect(px - ahs, py - ahs, anchorSize, anchorSize).stroke();
          }
        }
      }
    }
    // --- Measure overlay ---
    // Reads module-level measureState (NOT a useStore selector — Error-185-safe).
    // measureTick in the dep array forces this effect to re-run on every hover move.
    {
      const ms = getMeasureState();
      if (ms.active) {
        if (ms.diameterLabel !== null) {
          // Direct ellipse click: show diameter label at cursor center
          // (no line, just a text readout near the center of the screen)
          const labelStyle = new TextStyle({
            fontSize: 12,
            fill: 0xffd166,
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
          });
          const label = new Text({ text: ms.diameterLabel, style: labelStyle });
          // Position relative to the hoverPt if available, else center of canvas
          if (ms.hoverPt) {
            label.x = ms.hoverPt.x * PX_PER_MM + 8 / camera.zoom;
            label.y = ms.hoverPt.y * PX_PER_MM - 16 / camera.zoom;
          } else {
            label.x = 8 / camera.zoom;
            label.y = 8 / camera.zoom;
          }
          label.scale.set(1 / camera.zoom);
          g.addChild(label as unknown as Parameters<typeof g.addChild>[0]);
        } else if (ms.p1 !== null) {
          // Line measurement: draw segment from p1 to p2 (or hoverPt for live preview)
          const endPt = ms.p2 ?? ms.hoverPt;
          if (endPt) {
            const p1px = ms.p1.x * PX_PER_MM;
            const p1py = ms.p1.y * PX_PER_MM;
            const endpx = endPt.x * PX_PER_MM;
            const endpy = endPt.y * PX_PER_MM;

            // Draw measure line
            g.setStrokeStyle({ width: 1 / camera.zoom, color: 0xffd166, alpha: 0.9 });
            g.moveTo(p1px, p1py).lineTo(endpx, endpy).stroke();

            // Endpoint dots
            const dotR = 3 / camera.zoom;
            g.circle(p1px, p1py, dotR).fill({ color: 0xffd166, alpha: 1 });
            g.circle(endpx, endpy, dotR).fill({ color: 0xffd166, alpha: 1 });

            // Label at midpoint
            const midPx = (p1px + endpx) / 2;
            const midPy = (p1py + endpy) / 2;
            const dist = measureDistance(ms.p1, endPt);
            const angle = measureAngleDeg(ms.p1, endPt);
            const labelText = formatMeasureLabel(dist, angle);
            const labelStyle = new TextStyle({
              fontSize: 12,
              fill: 0xffd166,
              fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
            });
            const label = new Text({ text: labelText, style: labelStyle });
            label.x = midPx + 6 / camera.zoom;
            label.y = midPy - 16 / camera.zoom;
            label.scale.set(1 / camera.zoom);
            g.addChild(label as unknown as Parameters<typeof g.addChild>[0]);
          } else {
            // Only p1 set, no hover yet: draw p1 dot
            const p1px = ms.p1.x * PX_PER_MM;
            const p1py = ms.p1.y * PX_PER_MM;
            const dotR = 3 / camera.zoom;
            g.circle(p1px, p1py, dotR).fill({ color: 0xffd166, alpha: 1 });
          }
        }
      }
    }
  }, [selectedTransforms, camera.zoom, activeTool, nodeEditState, measureTick]);

  // Track marquee box for HTML overlay rendering
  const marqueeRef = useRef<{ x: number; y: number; w: number; h: number; dir: "ltr" | "rtl" } | null>(null);

  // Space key for pan mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space" && !e.repeat) {
        spaceHeld.current = true;
        if (canvasRef.current) canvasRef.current.style.cursor = "grab";
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceHeld.current = false;
        if (canvasRef.current) canvasRef.current.style.cursor = getCursor(activeTool);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [activeTool]);

  // Capture original text content when entering text edit mode (for Escape-revert)
  // and snapshot the store for undo.
  useEffect(() => {
    if (textEditingId) {
      const store = useStore.getState();
      const obj = store.objectsById.get(textEditingId);
      textEditOriginalRef.current = obj?.text ?? "";
      store.beginPropertyEdit();
    }
  }, [textEditingId]);

  // Zoom with scroll wheel
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.max(0.05, Math.min(50, camera.zoom * zoomFactor));

      // Zoom toward cursor
      const worldX = (mouseX - camera.x) / camera.zoom;
      const worldY = (mouseY - camera.y) / camera.zoom;

      setCamera({
        zoom: newZoom,
        x: mouseX - worldX * newZoom,
        y: mouseY - worldY * newZoom,
      });
    },
    [camera, setCamera]
  );

  // Mouse handlers for pan + tools
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Middle-button pan, spacebar-held pan, OR pan-tool left-drag all enter the same
      // isPanning / panCameraRef deferred-write path (no new camera math).
      const isPanTool = useStore.getState().activeTool === "pan";
      if (e.button === 1 || (e.button === 0 && spaceHeld.current) || (e.button === 0 && isPanTool)) {
        isPanning.current = true;
        lastPan.current = { x: e.clientX, y: e.clientY };
        // P5: Initialize pan camera ref from current camera state
        panCameraRef.current = { x: camera.x, y: camera.y, zoom: camera.zoom };
        if (canvasRef.current) canvasRef.current.style.cursor = "grabbing";
        return;
      }

      if (e.button === 0) {
        // If text editing is active, let the input's blur handler commit the edit.
        // Bail here to avoid processing a canvas action before blur fires.
        if (useStore.getState().textEditingId !== null) return;
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const worldX = (e.clientX - rect.left - camera.x) / camera.zoom / PX_PER_MM;
        const worldY = (e.clientY - rect.top - camera.y) / camera.zoom / PX_PER_MM;
        handleViewportPointerDown(worldX, worldY, e);
        // Jen-2: show grabbing cursor immediately on rotate-handle drag start
        if (canvasRef.current && getActiveDragHandle() === "rotate") {
          canvasRef.current.style.cursor = "grabbing";
        }
      }
    },
    [camera]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      if (isPanning.current) {
        // P5: Direct Pixi update during pan -- no Zustand writes until pointer-up
        const dx = e.clientX - lastPan.current.x;
        const dy = e.clientY - lastPan.current.y;
        lastPan.current = { x: e.clientX, y: e.clientY };
        panCameraRef.current = {
          x: panCameraRef.current.x + dx,
          y: panCameraRef.current.y + dy,
          zoom: panCameraRef.current.zoom,
        };
        if (worldRef.current) {
          worldRef.current.x = panCameraRef.current.x;
          worldRef.current.y = panCameraRef.current.y;
        }
        return;
      }

      const worldX = (e.clientX - rect.left - camera.x) / camera.zoom / PX_PER_MM;
      const worldY = (e.clientY - rect.top - camera.y) / camera.zoom / PX_PER_MM;
      setCursorPosition({ x: Math.round(worldX * 100) / 100, y: Math.round(worldY * 100) / 100 });
      handleViewportPointerMove(worldX, worldY, e);

      // Measure live-preview: bump the scalar tick so the selectionOverlay effect
      // re-runs with the updated hoverPt. This is a scalar useState (not a new-object
      // useStore selector) — Error-185-safe, mirrors the rotationReadout pattern.
      if (useStore.getState().activeTool === "measure") {
        setMeasureTick((t) => t + 1);
      }

      // R2: hover cursor — single-select, select tool, not panning, not marquee.
      // Written via direct DOM to avoid Error-185 (never return fresh object from useStore).
      if (canvasRef.current && !isPanning.current) {
        const store = useStore.getState();
        const dragging = isPointerDragging();
        const marqueeActive = getMarqueeState() !== null;
        if (
          store.activeTool === "select" &&
          store.selectedIds.length === 1 &&
          !dragging &&
          !marqueeActive
        ) {
          const rot = store.objectsById.get(store.selectedIds[0])?.transform.rotation || 0;
          const handle = hitTestHandle(worldX, worldY, store.camera.zoom);
          canvasRef.current.style.cursor = getHandleCursor(handle, rot);
        } else if (!dragging) {
          canvasRef.current.style.cursor = getCursor(store.activeTool);
        }
      }

      // Update marquee overlay
      const marquee = getMarqueeState();
      if (marquee) {
        const sx = Math.min(marquee.startX, worldX);
        const sy = Math.min(marquee.startY, worldY);
        const sw = Math.abs(worldX - marquee.startX);
        const sh = Math.abs(worldY - marquee.startY);
        marqueeRef.current = { x: sx, y: sy, w: sw, h: sh, dir: marquee.direction };
      } else {
        marqueeRef.current = null;
      }

      // R3: live rotation readout — only during a rotate handle drag (not resize)
      if (isDraggingRotateHandle()) {
        const curStore = useStore.getState();
        if (curStore.selectedIds.length === 1) {
          const obj = curStore.objectsById.get(curStore.selectedIds[0]);
          if (obj) {
            setRotationReadout(Math.round(obj.transform.rotation));
          } else {
            setRotationReadout(null);
          }
        } else {
          setRotationReadout(null);
        }
      } else {
        setRotationReadout(null);
      }
    },
    [camera, setCamera, setMeasureTick]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (isPanning.current) {
        // P5: Single sync to Zustand store when pan ends
        setCamera(panCameraRef.current);
        isPanning.current = false;
        if (canvasRef.current) {
          canvasRef.current.style.cursor = spaceHeld.current ? "grab" : getCursor(activeTool);
        }
        return;
      }

      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const worldX = (e.clientX - rect.left - camera.x) / camera.zoom / PX_PER_MM;
      const worldY = (e.clientY - rect.top - camera.y) / camera.zoom / PX_PER_MM;
      handleViewportPointerUp(worldX, worldY, e);
      marqueeRef.current = null;
      // R3: clear rotation readout on pointer-up
      setRotationReadout(null);
      // R2: reset cursor to tool default after drag ends
      if (canvasRef.current) {
        canvasRef.current.style.cursor = getCursor(activeTool);
      }
    },
    [camera, activeTool]
  );

  // Derive the object currently being text-edited (stable: objects array is already selected above)
  const textEditingObj = textEditingId != null
    ? objects.find((o) => o.id === textEditingId) ?? null
    : null;

  // Compute marquee screen rect for overlay
  const mq = marqueeRef.current;
  const marqueeStyle: React.CSSProperties | null = mq ? {
    position: "absolute",
    left: camera.x + mq.x * PX_PER_MM * camera.zoom,
    top: camera.y + mq.y * PX_PER_MM * camera.zoom,
    width: mq.w * PX_PER_MM * camera.zoom,
    height: mq.h * PX_PER_MM * camera.zoom,
    border: `1px solid ${mq.dir === "ltr" ? "rgba(74,144,226,0.8)" : "rgba(78,226,74,0.8)"}`,
    background: mq.dir === "ltr" ? "rgba(74,144,226,0.1)" : "rgba(78,226,74,0.1)",
    pointerEvents: "none",
    zIndex: 5,
  } : null;

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <div
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          cursor: getCursor(activeTool),
        }}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={(e) => {
          const rect = canvasRef.current?.getBoundingClientRect();
          if (!rect) return;
          const worldX = (e.clientX - rect.left - camera.x) / camera.zoom / PX_PER_MM;
          const worldY = (e.clientY - rect.top - camera.y) / camera.zoom / PX_PER_MM;
          handleViewportDoubleClick(worldX, worldY);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const store = useStore.getState();
          if (store.selectedIds.length > 0) {
            setContextMenu({ x: e.clientX, y: e.clientY });
          }
        }}
      />
      {marqueeStyle && <div style={marqueeStyle} />}
      {/* Right-click context menu */}
      {contextMenu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 100 }}
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
          <ContextMenuContent
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
          />
        </>
      )}
      {/* R3: Live rotation readout during rotate drag */}
      {rotationReadout !== null && (
        <div style={{
          position: "absolute",
          bottom: "12px",
          left: "50%",
          transform: "translateX(-50%)",
          background: "var(--bg-panel)",
          color: "var(--text-primary)",
          fontSize: "12px",
          padding: "4px 10px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border)",
          pointerEvents: "none",
          zIndex: 10,
          letterSpacing: "0.3px",
        }}>
          {rotationReadout}°
        </div>
      )}
      {/* Smart alignment guides */}
      {guides.map((g, i) =>
        g.type === "v" ? (
          <div key={`guide-${i}`} style={{
            position: "absolute",
            left: camera.x + g.pos * PX_PER_MM * camera.zoom,
            top: 0, width: "1px", height: "100%",
            background: "rgba(255, 100, 100, 0.6)",
            pointerEvents: "none", zIndex: 6,
          }} />
        ) : (
          <div key={`guide-${i}`} style={{
            position: "absolute",
            left: 0, width: "100%",
            top: camera.y + g.pos * PX_PER_MM * camera.zoom,
            height: "1px",
            background: "rgba(255, 100, 100, 0.6)",
            pointerEvents: "none", zIndex: 6,
          }} />
        )
      )}
      {/* Text editing HTML overlay — absolutely positioned over the canvas, not a Pixi object */}
      {textEditingObj && (() => {
        const fontSize = textEditingObj.fontSize ?? 16;
        const screenX = textEditingObj.transform.x * PX_PER_MM * camera.zoom + camera.x;
        const screenY = textEditingObj.transform.y * PX_PER_MM * camera.zoom + camera.y;

        const handleCommit = () => {
          const store = useStore.getState();
          const obj = store.textEditingId ? store.objectsById.get(store.textEditingId) : null;
          if (obj && (!obj.text || !obj.text.trim())) {
            removeObjects([obj.id]);
          }
          store.commitPropertyEdit();
          setTextEditingId(null);
          setActiveTool("select");
        };

        const handleCancel = () => {
          const store = useStore.getState();
          const obj = store.textEditingId ? store.objectsById.get(store.textEditingId) : null;
          if (obj) {
            const original = textEditOriginalRef.current;
            if (!original || !original.trim()) {
              removeObjects([obj.id]);
            } else {
              updateObject(obj.id, { text: original });
            }
          }
          store.commitPropertyEdit();
          setTextEditingId(null);
          setActiveTool("select");
        };

        return (
          <input
            key={textEditingObj.id}
            type="text"
            autoFocus
            value={textEditingObj.text ?? ""}
            style={{
              position: "absolute",
              left: screenX,
              top: screenY,
              fontSize: `${fontSize * camera.zoom}px`,
              fontFamily: textEditingObj.fontFamily ?? "sans-serif",
              color: textEditingObj.fill || "#e8e8e8",
              background: "transparent",
              border: "none",
              outline: "none",
              minWidth: "80px",
              zIndex: 20,
              pointerEvents: "all",
              padding: 0,
              margin: 0,
              lineHeight: 1,
            }}
            onChange={(e) => {
              const text = e.target.value;
              const fs = textEditingObj.fontSize ?? 16;
              updateObject(textEditingObj.id, {
                text,
                transform: {
                  ...textEditingObj.transform,
                  width: Math.max(fs * 2, text.length * fs * 0.6),
                  height: fs * 1.3,
                },
              });
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                textEditCommittingRef.current = true;
                handleCommit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                textEditCommittingRef.current = true;
                handleCancel();
              }
            }}
            onBlur={() => {
              if (textEditCommittingRef.current) {
                textEditCommittingRef.current = false;
                return;
              }
              handleCommit();
            }}
          />
        );
      })()}
    </div>
  );
}

/** P8: Content hash for text/image objects -- skip GPU texture rebuild when only transform changed */
function contentHash(obj: DesignObject): string {
  if (obj.type === "text") return `${obj.text}|${obj.fontSize}|${obj.fontFamily}|${obj.fill}|${obj.stroke}|${obj.opacity}|${obj.transform.width}`;
  if (obj.type === "image") return `${obj.imageData?.slice(0, 50)}|${obj.opacity}|${JSON.stringify(obj.imageAdjustments)}`;
  return "";
}

/** P8: Update position of text/image display object without destroying and rebuilding */
function applyTextImageTransform(displayObj: Container, obj: DesignObject) {
  const t = obj.transform;
  const px = t.x * PX_PER_MM;
  const py = t.y * PX_PER_MM;
  const pw = t.width * PX_PER_MM;
  const ph = t.height * PX_PER_MM;
  const rot = (t.rotation || 0) * Math.PI / 180;

  // Reset pivot/position/rotation first
  displayObj.pivot.set(0, 0);
  displayObj.position.set(0, 0);
  displayObj.rotation = 0;

  if (displayObj instanceof Sprite) {
    displayObj.x = px;
    displayObj.y = py;
    displayObj.width = pw;
    displayObj.height = ph;
    const sx = t.scaleX ?? 1;
    const sy = t.scaleY ?? 1;
    if (sx < 0) { displayObj.scale.x *= -1; displayObj.x += pw; }
    if (sy < 0) { displayObj.scale.y *= -1; displayObj.y += ph; }
  } else if (displayObj instanceof Text) {
    displayObj.x = px;
    displayObj.y = py;
    const sx = t.scaleX ?? 1;
    const sy = t.scaleY ?? 1;
    if (sx < 0) { displayObj.scale.x = -1; displayObj.x += pw; } else { displayObj.scale.x = 1; }
    if (sy < 0) { displayObj.scale.y = -1; displayObj.y += ph; } else { displayObj.scale.y = 1; }
  } else {
    // Container (template text) -- update child positions
    for (const child of displayObj.children) {
      if (child instanceof Text) {
        child.x = px;
        child.y = py;
      }
    }
  }

  // Re-apply rotation if needed
  if (rot !== 0) {
    applyObjectRotation(displayObj, t);
  }
}

/** Apply rotation transform to a Pixi display object around its bounding box center */
function applyObjectRotation(displayObj: Container, t: DesignObject["transform"]) {
  const rot = (t.rotation || 0) * Math.PI / 180;
  if (rot === 0) return;
  const cx = t.x * PX_PER_MM + (t.width * PX_PER_MM) / 2;
  const cy = t.y * PX_PER_MM + (t.height * PX_PER_MM) / 2;
  displayObj.pivot.set(cx, cy);
  displayObj.position.set(cx, cy);
  displayObj.rotation = rot;
}

function getCursor(tool: string): string {
  switch (tool) {
    case "select": return "default";
    case "pen": return "crosshair";
    case "node": return "default";
    case "text": return "text";
    case "measure": return "crosshair";
    case "pan": return "grab";
    default: return "crosshair";
  }
}

/**
 * R2: Map a handle type + object rotation to a CSS cursor.
 * For resize handles: pick the CSS resize direction nearest the handle's actual
 * screen orientation after applying the object's rotation.
 * For the rotate handle: "grab".
 * For null (no handle): "default".
 */
function getHandleCursor(handle: import("../../lib/tools/toolHandler").HandleType, rotationDeg: number): string {
  if (!handle) return "default";
  if (handle === "rotate") return "grab";

  // Base screen angle for each handle in an unrotated object (degrees, 0=east, CCW)
  const baseAngles: Record<string, number> = {
    e:  0,   w:  180,
    s:  270, n:  90,
    se: 315, nw: 135,
    ne: 45,  sw: 225,
  };
  const baseAngle = baseAngles[handle] ?? 0;
  // Actual screen angle after rotation
  const actualAngle = ((baseAngle + rotationDeg) % 360 + 360) % 360;

  // Snap to the 4 CSS resize cursor directions (each spans 45° either side)
  // 0°/180°=ew, 90°/270°=ns, 45°/225°=nesw, 135°/315°=nwse
  const snapped = Math.round(actualAngle / 45) * 45 % 180;
  switch (snapped) {
    case 0:   return "ew-resize";
    case 45:  return "nesw-resize";
    case 90:  return "ns-resize";
    case 135: return "nwse-resize";
    default:  return "ew-resize";
  }
}

function renderObject(g: Graphics, obj: DesignObject) {
  const t = obj.transform;
  const px = t.x * PX_PER_MM;
  const py = t.y * PX_PER_MM;
  const pw = t.width * PX_PER_MM;
  const ph = t.height * PX_PER_MM;

  const strokeColor = parseInt(obj.stroke.replace("#", ""), 16);
  const strokeWidth = obj.strokeWidth;

  g.setStrokeStyle({ width: strokeWidth, color: strokeColor, alpha: obj.opacity });

  if (obj.fill) {
    // Pre-set fill for shapes that use it below
  }

  switch (obj.type) {
    case "rectangle": {
      const r = obj.cornerRadius || 0;
      if (r > 0) {
        g.roundRect(px, py, pw, ph, r * PX_PER_MM);
      } else {
        g.rect(px, py, pw, ph);
      }
      if (obj.fill) {
        g.fill({ color: parseInt(obj.fill.replace("#", ""), 16), alpha: obj.opacity * 0.3 });
      }
      g.stroke();
      break;
    }
    case "ellipse": {
      g.ellipse(px + pw / 2, py + ph / 2, pw / 2, ph / 2);
      if (obj.fill) {
        g.fill({ color: parseInt(obj.fill.replace("#", ""), 16), alpha: obj.opacity * 0.3 });
      }
      g.stroke();
      break;
    }
    case "line": {
      if (obj.points && obj.points.length >= 2) {
        g.moveTo(obj.points[0].x * PX_PER_MM, obj.points[0].y * PX_PER_MM);
        g.lineTo(obj.points[1].x * PX_PER_MM, obj.points[1].y * PX_PER_MM);
        g.stroke();
      } else {
        g.moveTo(px, py);
        g.lineTo(px + pw, py + ph);
        g.stroke();
      }
      break;
    }
    case "path": {
      if (obj.points && obj.points.length >= 2) {
        g.moveTo(obj.points[0].x * PX_PER_MM, obj.points[0].y * PX_PER_MM);
        for (let i = 1; i < obj.points.length; i++) {
          const pt = obj.points[i];
          const prev = obj.points[i - 1];
          if (prev.handleOut && pt.handleIn) {
            g.bezierCurveTo(
              prev.handleOut.x * PX_PER_MM,
              prev.handleOut.y * PX_PER_MM,
              pt.handleIn.x * PX_PER_MM,
              pt.handleIn.y * PX_PER_MM,
              pt.x * PX_PER_MM,
              pt.y * PX_PER_MM
            );
          } else {
            g.lineTo(pt.x * PX_PER_MM, pt.y * PX_PER_MM);
          }
        }
        if (obj.closed && obj.points.length >= 2) {
          const lastPt = obj.points[obj.points.length - 1];
          const firstPt = obj.points[0];
          if (lastPt.handleOut && firstPt.handleIn) {
            g.bezierCurveTo(
              lastPt.handleOut.x * PX_PER_MM, lastPt.handleOut.y * PX_PER_MM,
              firstPt.handleIn.x * PX_PER_MM, firstPt.handleIn.y * PX_PER_MM,
              firstPt.x * PX_PER_MM, firstPt.y * PX_PER_MM
            );
          }
          g.closePath();
        }
        if (obj.fill) {
          g.fill({ color: parseInt(obj.fill.replace("#", ""), 16), alpha: obj.opacity * 0.3 });
        }
        g.stroke();
      }
      break;
    }
  }
}

function renderTextObject(obj: DesignObject): Container | null {
  if (!obj.text) return null;
  const t = obj.transform;
  const px = t.x * PX_PER_MM;
  const py = t.y * PX_PER_MM;

  const style = new TextStyle({
    fontFamily: obj.fontFamily || "-apple-system, BlinkMacSystemFont, sans-serif",
    fontSize: (obj.fontSize || 16) * PX_PER_MM,
    fill: obj.fill || obj.stroke || "#e8e8e8",
    wordWrap: t.width > 0,
    wordWrapWidth: t.width > 0 ? t.width * PX_PER_MM : undefined,
  });

  const isTemplate = hasPlaceholders(obj);

  // If template, wrap in container with indicator
  if (isTemplate) {
    const container = new Container();
    const text = new Text({ text: obj.text, style });
    text.x = px;
    text.y = py;
    text.alpha = obj.opacity;

    const sx = t.scaleX ?? 1;
    const sy = t.scaleY ?? 1;
    if (sx < 0) { text.scale.x *= -1; text.x += t.width * PX_PER_MM; }
    if (sy < 0) { text.scale.y *= -1; text.y += t.height * PX_PER_MM; }

    container.addChild(text);

    // Dashed border indicator for template text
    const pw = Math.max(t.width * PX_PER_MM, text.width);
    const ph = Math.max(t.height * PX_PER_MM, text.height);
    const indicator = new Graphics();
    // Warm accent tint at 10% opacity
    indicator.rect(px - 2, py - 2, pw + 4, ph + 4);
    indicator.fill({ color: 0xe8894a, alpha: 0.1 });
    indicator.setStrokeStyle({ width: 1, color: 0xe8894a, alpha: 0.5 });
    indicator.stroke();
    container.addChildAt(indicator, 0);

    return container;
  }

  const text = new Text({ text: obj.text, style });
  text.x = px;
  text.y = py;
  text.alpha = obj.opacity;

  // Apply flip (scaleX/scaleY from transform)
  const sx = t.scaleX ?? 1;
  const sy = t.scaleY ?? 1;
  if (sx < 0) { text.scale.x *= -1; text.x += t.width * PX_PER_MM; }
  if (sy < 0) { text.scale.y *= -1; text.y += t.height * PX_PER_MM; }

  return text;
}

function renderImageObject(obj: DesignObject): Container | null {
  if (!obj.imageData) return null;
  const t = obj.transform;
  const px = t.x * PX_PER_MM;
  const py = t.y * PX_PER_MM;
  const pw = t.width * PX_PER_MM;
  const ph = t.height * PX_PER_MM;

  try {
    const texture = getOrCreateTexture(obj.id, obj.imageData);
    const sprite = new Sprite(texture);
    sprite.x = px;
    sprite.y = py;
    sprite.width = pw;
    sprite.height = ph;
    sprite.alpha = obj.opacity;

    // Apply flip (scaleX/scaleY from transform)
    const sx = t.scaleX ?? 1;
    const sy = t.scaleY ?? 1;
    if (sx < 0) { sprite.scale.x *= -1; sprite.x += pw; }
    if (sy < 0) { sprite.scale.y *= -1; sprite.y += ph; }

    return sprite;
  } catch {
    // Fallback: draw a placeholder box
    const g = new Graphics();
    g.setStrokeStyle({ width: 1, color: 0x999999, alpha: 0.5 });
    g.rect(px, py, pw, ph).stroke();
    // X through the box
    g.moveTo(px, py).lineTo(px + pw, py + ph).stroke();
    g.moveTo(px + pw, py).lineTo(px, py + ph).stroke();
    return g;
  }
}

function ContextMenuContent({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const layers = useStore((s) => s.layers);
  const selectedIds = useStore((s) => s.selectedIds);

  function moveToLayer(layerIndex: number) {
    useStore.getState().moveObjectsToLayer(selectedIds, layerIndex);
    onClose();
  }

  const itemStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: "8px",
    padding: "6px 12px", fontSize: "12px", color: "var(--text-primary)",
    cursor: "pointer", border: "none", background: "none", width: "100%",
    textAlign: "left",
  };

  return (
    <div style={{
      position: "fixed", left: x, top: y, zIndex: 101,
      background: "var(--bg-panel)", border: "1px solid var(--border)",
      borderRadius: "var(--radius-sm)", boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      minWidth: "160px", padding: "4px 0",
    }}>
      <div style={{
        padding: "4px 12px 6px", fontSize: "10px", color: "var(--text-muted)",
        textTransform: "uppercase", letterSpacing: "0.5px",
      }}>
        Move to Layer
      </div>
      {layers.map((l) => (
        <button
          key={l.index}
          style={itemStyle}
          onClick={() => moveToLayer(l.index)}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "none"; }}
        >
          <div style={{
            width: "10px", height: "10px", borderRadius: "2px",
            background: l.color, flexShrink: 0,
          }} />
          <span>{l.name}</span>
        </button>
      ))}
      <div style={{ height: "1px", background: "var(--border)", margin: "4px 0" }} />
      <button
        style={itemStyle}
        onClick={() => {
          const store = useStore.getState();
          store.withUndo("delete", () => store.removeObjects(selectedIds));
          onClose();
        }}
        onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "none"; }}
      >
        <span style={{ color: "#e24a4a" }}>Delete</span>
      </button>
    </div>
  );
}
