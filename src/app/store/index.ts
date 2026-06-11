import { create } from "zustand";
import type { DesignObject, SubLayer } from "../types";
import { DEFAULT_LAYERS } from "../types";
import { DEFAULT_MATERIALS } from "../../lib/materials";
import { createGeometryActions } from "./geometryActions";
import type { AppState } from "./storeTypes";
import { generateId } from "./storeTypes";
import { buildObjectsById, selectionPatch } from "./storeHelpers";
import { PX_PER_MM } from "../../lib/constants";

export type { AppState } from "./storeTypes";
export { generateId } from "./storeTypes";

// --- P3: Module-level dirty tracking (not in Zustand state to avoid triggering subscribers) ---
let dirtyObjectIds: Set<string> = new Set();
export const getDirtyObjectIds = () => dirtyObjectIds;
export const clearDirtyObjectIds = () => { dirtyObjectIds = new Set(); };

// --- P4: Module-level cursor position (removed from Zustand to avoid 60 set() calls/sec) ---
let _cursorPosition = { x: 0, y: 0 };
let _cursorListeners: Array<() => void> = [];

export function setCursorPosition(pos: { x: number; y: number }) {
  _cursorPosition = pos;
  for (const fn of _cursorListeners) fn();
}
export function getCursorPosition() { return _cursorPosition; }
export function subscribeCursorPosition(fn: () => void) {
  _cursorListeners.push(fn);
  return () => { _cursorListeners = _cursorListeners.filter((f) => f !== fn); };
}

// --- B4.1: Shared undo-strip machinery ---
// Callers resolve their own before/after; this helper owns strip/capture/restore/push.
function pushObjectsUndo(
  type: string,
  beforeObjects: DesignObject[],
  beforeSelectedIds: string[],
  afterObjects: DesignObject[],
  afterSelectedIds: string[],
  pushCmd: (cmd: import("./storeTypes").Command) => void,
  getObjects: () => DesignObject[],
  setState: import("./storeTypes").StoreSet,
) {
  const stripImageData = (objects: DesignObject[]): DesignObject[] =>
    objects.map((o) => o.imageData ? { ...o, imageData: "__UNDO_REF__" } : o);
  const beforeSnapshot = stripImageData(beforeObjects);
  const afterSnapshot = stripImageData(afterObjects);
  const capturedImages = new Map<string, string>();
  for (const o of beforeObjects) { if (o.imageData && o.imageData !== "__UNDO_REF__") capturedImages.set(o.id, o.imageData); }
  for (const o of afterObjects) { if (o.imageData && o.imageData !== "__UNDO_REF__") capturedImages.set(o.id, o.imageData); }
  const restoreImageData = (snapshot: DesignObject[]): DesignObject[] => {
    const live = getObjects();
    const imageMap = new Map<string, string>(capturedImages);
    for (const o of live) { if (o.imageData && o.imageData !== "__UNDO_REF__") imageMap.set(o.id, o.imageData); }
    return snapshot.map((o) => o.imageData === "__UNDO_REF__" ? { ...o, imageData: imageMap.get(o.id) } : o);
  };
  // F15: undo/redo restores must re-stale G-code — generate → undo a move →
  // START would otherwise cut the pre-undo design through a green gate.
  pushCmd({
    type,
    undo: () => {
      const restored = restoreImageData(beforeSnapshot);
      setState((state) => ({
        objects: restored,
        objectsById: buildObjectsById(restored),
        ...selectionPatch(beforeSelectedIds),
        isDirty: true,
        gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
      }));
    },
    redo: () => {
      const restored = restoreImageData(afterSnapshot);
      setState((state) => ({
        objects: restored,
        objectsById: buildObjectsById(restored),
        ...selectionPatch(afterSelectedIds),
        isDirty: true,
        gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
      }));
    },
  });
}

// --- B4.3: Shared z-order wrapper ---
// Owns withUndo + findIndex + its own INLINE objects patch (it does NOT route
// through applyObjects); caller supplies 1-2 lines of index math.
// mutate returns new array or null (null = no-op, withUndo guard ensures no command pushed).
// F15: z-order stales G-code via the explicit ternary below — array order feeds
// within-layer emission order (toCutObjects' stable sort), so reordering changes the cut.
function withZOrder(
  id: string,
  get: import("./storeTypes").StoreGet,
  set: import("./storeTypes").StoreSet,
  mutate: (objs: DesignObject[], idx: number) => DesignObject[] | null,
) {
  get().withUndo("z-order", () => {
    set((state) => {
      const idx = state.objects.findIndex((o) => o.id === id);
      const result = mutate([...state.objects], idx);
      if (result === null) return state;
      return {
        objects: result,
        objectsById: buildObjectsById(result),
        isDirty: true,
        gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
      };
    });
  });
}

export const useStore = create<AppState>((set, get) => ({
  // Tool
  activeTool: "select",
  setActiveTool: (tool) => set({ activeTool: tool }),

  // Objects
  objects: [],
  objectsById: new Map(),
  addObject: (obj) =>
    set((state) => {
      const newObjects = [...state.objects, obj];
      return {
        objects: newObjects,
        objectsById: buildObjectsById(newObjects),
        isDirty: true,
        gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
      };
    }),
  updateObject: (id, partial) => {
    dirtyObjectIds.add(id);
    // D3: if the target is a group, mark all its children dirty too so the Viewport re-renders them
    const existing = get().objectsById.get(id);
    if (existing && existing.type === "group" && existing.children) {
      for (const child of existing.children) {
        dirtyObjectIds.add(child.id);
        if (child.type === "group" && child.children) {
          for (const gc of child.children) dirtyObjectIds.add(gc.id);
        }
      }
    }
    set((state) => {
      const newObjects = state.objects.map((o) =>
        o.id === id ? { ...o, ...partial } : o
      );
      return {
        objects: newObjects,
        objectsById: buildObjectsById(newObjects),
        isDirty: true,
        gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
      };
    });
  },
  updateObjects: (updates) => {
    for (const u of updates) {
      dirtyObjectIds.add(u.id);
      // D3: mark group children dirty
      const existing = get().objectsById.get(u.id);
      if (existing && existing.type === "group" && existing.children) {
        for (const child of existing.children) {
          dirtyObjectIds.add(child.id);
          if (child.type === "group" && child.children) {
            for (const gc of child.children) dirtyObjectIds.add(gc.id);
          }
        }
      }
    }
    set((state) => {
      const updateMap = new Map(updates.map((u) => [u.id, u.partial]));
      const newObjects = state.objects.map((o) => {
        const partial = updateMap.get(o.id);
        return partial ? { ...o, ...partial } : o;
      });
      return {
        objects: newObjects,
        objectsById: buildObjectsById(newObjects),
        isDirty: true,
        gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
      };
    });
  },
  removeObjects: (ids) =>
    set((state) => {
      const newObjects = state.objects.filter((o) => !ids.includes(o.id));
      const newSelectedIds = state.selectedIds.filter((id) => !ids.includes(id));
      return {
        objects: newObjects,
        objectsById: buildObjectsById(newObjects),
        selectedIds: newSelectedIds,
        selectedSet: new Set(newSelectedIds),
        isDirty: true,
        gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
      };
    }),

  // Selection
  selectedIds: [],
  selectedSet: new Set(),
  setSelectedIds: (ids) => set(selectionPatch(ids)),
  addToSelection: (id) =>
    set((state) => {
      if (state.selectedSet.has(id)) return state;
      const newIds = [...state.selectedIds, id];
      return { selectedIds: newIds, selectedSet: new Set(newIds) };
    }),
  removeFromSelection: (id) =>
    set((state) => {
      const newIds = state.selectedIds.filter((i) => i !== id);
      return { selectedIds: newIds, selectedSet: new Set(newIds) };
    }),
  clearSelection: () => set({ selectedIds: [], selectedSet: new Set() }),

  // Layers
  layers: DEFAULT_LAYERS,
  activeLayerIndex: 0,
  setActiveLayerIndex: (index) => set({ activeLayerIndex: index }),
  // F15: layer params (power/speed/mode/passes…) feed G-code, so every layer
  // write stales it. Name/color edits over-trigger; accepted — safe direction,
  // not worth a field carve-out.
  updateLayer: (index, partial) =>
    set((state) => ({
      layers: state.layers.map((l) =>
        l.index === index ? { ...l, ...partial } : l
      ),
      gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
    })),
  reorderLayers: (fromIndex, toIndex) =>
    set((state) => {
      const newLayers = [...state.layers];
      const fromPos = newLayers.findIndex((l) => l.index === fromIndex);
      const toPos = newLayers.findIndex((l) => l.index === toIndex);
      if (fromPos === -1 || toPos === -1 || fromPos === toPos) return state;
      const [moved] = newLayers.splice(fromPos, 1);
      newLayers.splice(toPos, 0, moved);
      const indexMap = new Map<number, number>();
      const reindexed = newLayers.map((l, i) => {
        indexMap.set(l.index, i);
        return { ...l, index: i };
      });
      const objects = state.objects.map((o) => ({
        ...o,
        layerIndex: indexMap.get(o.layerIndex) ?? o.layerIndex,
      }));
      const activeLayerIndex = indexMap.get(state.activeLayerIndex) ?? state.activeLayerIndex;
      return {
        layers: reindexed,
        objects,
        objectsById: buildObjectsById(objects),
        activeLayerIndex,
        isDirty: true,
        gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
      };
    }),
  // F15: sub-layer writers do NOT route through updateLayer — each is a direct
  // generation-input writer and stales G-code itself.
  addSubLayer: (layerIndex) =>
    set((state) => ({
      layers: state.layers.map((l) => {
        if (l.index !== layerIndex) return l;
        const newSub: SubLayer = {
          id: `sub_${generateId()}`,
          mode: "line",
          power: 100,
          powerMin: 0,
          speed: 20,
          passes: 1,
          powerMode: "constant",
          interval: 0.1,
        };
        return { ...l, subLayers: [...(l.subLayers || []), newSub] };
      }),
      gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
    })),
  addSubLayers: (layerIndex, subs) =>
    set((state) => ({
      layers: state.layers.map((l) => {
        if (l.index !== layerIndex) return l;
        const newSubs: SubLayer[] = subs.map((s) => ({
          id: `sub_${generateId()}`,
          mode: s.mode ?? "line",
          power: s.power ?? 100,
          powerMin: s.powerMin ?? 0,
          speed: s.speed ?? 20,
          passes: s.passes ?? 1,
          powerMode: s.powerMode ?? "constant",
          interval: s.interval ?? 0.1,
        }));
        return { ...l, subLayers: [...(l.subLayers || []), ...newSubs] };
      }),
      gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
    })),
  removeSubLayer: (layerIndex, subLayerId) =>
    set((state) => ({
      layers: state.layers.map((l) => {
        if (l.index !== layerIndex) return l;
        const filtered = (l.subLayers || []).filter((s) => s.id !== subLayerId);
        return { ...l, subLayers: filtered.length > 0 ? filtered : undefined };
      }),
      gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
    })),
  updateSubLayer: (layerIndex, subLayerId, changes) =>
    set((state) => ({
      layers: state.layers.map((l) => {
        if (l.index !== layerIndex) return l;
        return {
          ...l,
          subLayers: (l.subLayers || []).map((s) =>
            s.id === subLayerId ? { ...s, ...changes } : s
          ),
        };
      }),
      gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
    })),

  // Camera
  camera: { x: 0, y: 0, zoom: 1 },
  setCamera: (camera) =>
    set((state) => ({ camera: { ...state.camera, ...camera } })),

  // Workspace
  workspaceWidth: 500,
  workspaceHeight: 300,
  // F15: workspace size is the Y-flip basis for G-code. Stales on VALUE CHANGE
  // only — queryGrblSettings re-sets it on every connect, and a same-value
  // write must not force a pointless regenerate.
  setWorkspaceSize: (w, h) =>
    set((state) => ({
      workspaceWidth: w,
      workspaceHeight: h,
      gcodeStale:
        (w !== state.workspaceWidth || h !== state.workspaceHeight) && state.gcodeResult !== null
          ? true
          : state.gcodeStale,
    })),
  gridVisible: true,
  setGridVisible: (v) => set({ gridVisible: v }),
  snapToGrid: true,
  setSnapToGrid: (v) => set({ snapToGrid: v }),
  gridSize: 10,
  setGridSize: (s) => set({ gridSize: s }),

  // Undo/Redo
  undoStack: [],
  redoStack: [],
  pushCommand: (cmd) =>
    set((state) => {
      const MAX_UNDO = 50;
      const newStack = [...state.undoStack, cmd];
      return {
        undoStack: newStack.length > MAX_UNDO ? newStack.slice(newStack.length - MAX_UNDO) : newStack,
        redoStack: [],
      };
    }),
  undo: () => {
    const { undoStack, redoStack } = get();
    if (undoStack.length === 0) return;
    const cmd = undoStack[undoStack.length - 1];
    cmd.undo();
    set({
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, cmd],
    });
  },
  redo: () => {
    const { undoStack, redoStack } = get();
    if (redoStack.length === 0) return;
    const cmd = redoStack[redoStack.length - 1];
    cmd.redo();
    set({
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, cmd],
    });
  },
  withUndo: (type, fn) => {
    const beforeObjects = get().objects;
    const beforeSelectedIds = get().selectedIds;
    fn();
    const afterObjects = get().objects;
    const afterSelectedIds = get().selectedIds;
    if (beforeObjects !== afterObjects) {
      pushObjectsUndo(type, beforeObjects, beforeSelectedIds, afterObjects, afterSelectedIds,
        get().pushCommand, () => get().objects, set);
    }
  },
  _propertyEditSnapshot: null,
  beginPropertyEdit: () => {
    if (!get()._propertyEditSnapshot) {
      set({ _propertyEditSnapshot: { objects: get().objects, selectedIds: get().selectedIds } });
    }
  },
  commitPropertyEdit: () => {
    const snapshot = get()._propertyEditSnapshot;
    if (snapshot && snapshot.objects !== get().objects) {
      const afterObjects = get().objects;
      const afterSelectedIds = get().selectedIds;
      pushObjectsUndo("property-edit", snapshot.objects, snapshot.selectedIds, afterObjects, afterSelectedIds,
        get().pushCommand, () => get().objects, set);
    }
    set({ _propertyEditSnapshot: null });
  },

  // Drawing
  drawingObject: null,
  setDrawingObject: (obj) => set({ drawingObject: obj }),

  // Project
  projectName: "Untitled",
  projectPath: null,
  isDirty: false,
  setProjectName: (name) => set({ projectName: name }),
  setProjectPath: (path) => set({ projectPath: path }),
  setDirty: (dirty) => set({ isDirty: dirty }),
  loadProject: (project) =>
    set({
      objects: project.objects,
      objectsById: buildObjectsById(project.objects),
      layers: project.layers.map(l => ({ ...l, output: l.output ?? true })),
      camera: project.camera,
      workspaceWidth: project.workspaceWidth,
      workspaceHeight: project.workspaceHeight,
      projectName: project.name,
      projectNotes: project.notes || "",
      materials: project.materials || DEFAULT_MATERIALS,
      startCorner: project.startCorner || "bottomLeft",
      isDirty: false,
      selectedIds: [],
      selectedSet: new Set(),
      undoStack: [],
      redoStack: [],
      gcodeResult: null,
      gcodeStale: false,
      projectPath: null,
      nodeEditState: { pathId: null, selectedNodeIndex: null },
    }),
  toProject: () => {
    const state = get();
    return {
      version: "0.6.0",
      name: state.projectName,
      objects: state.objects,
      layers: state.layers,
      camera: state.camera,
      workspaceWidth: state.workspaceWidth,
      workspaceHeight: state.workspaceHeight,
      notes: state.projectNotes,
      materials: state.materials,
      startCorner: state.startCorner,
    };
  },

  // Clipboard
  clipboard: [],
  setClipboard: (objects) => set({ clipboard: objects }),

  // Materials
  materials: DEFAULT_MATERIALS,
  addMaterial: (m) => set((state) => ({ materials: [...state.materials, m] })),
  removeMaterial: (id) => set((state) => ({ materials: state.materials.filter((m) => m.id !== id) })),
  updateMaterial: (id, partial) => set((state) => ({
    materials: state.materials.map((m) => m.id === id ? { ...m, ...partial } : m),
  })),

  // Machine connection
  machineConnected: false,
  machineState: "disconnected",
  machinePosition: { x: 0, y: 0, z: 0 },
  grblSValueMax: 1000,
  grblLaserMode: false,
  grblAccelX: 500,
  grblAccelY: 500,
  setMachineConnected: (connected) => set({ machineConnected: connected }),
  setMachineState: (state) => set({ machineState: state }),
  setMachinePosition: (pos) => set({ machinePosition: pos }),
  // F15: S-values are baked into generated G-code (different $30 machine =
  // stale). Value-change only — re-set on every connect by queryGrblSettings.
  setGrblSValueMax: (v) =>
    set((state) => ({
      grblSValueMax: v,
      gcodeStale:
        v !== state.grblSValueMax && state.gcodeResult !== null ? true : state.gcodeStale,
    })),
  setGrblLaserMode: (v) => set({ grblLaserMode: v }),
  setGrblAccel: (x, y) => set({ grblAccelX: x, grblAccelY: y }),

  // Console
  consoleLines: [],
  addConsoleLine: (text, type) => set((state) => ({
    consoleLines: [...state.consoleLines.slice(-500), { text, type }],
  })),
  clearConsole: () => set({ consoleLines: [] }),

  // G-code / Preview
  gcodeResult: null,
  gcodeStale: false,
  setGcodeResult: (result) => set({ gcodeResult: result, gcodeStale: false }),
  previewVisible: false,
  setPreviewVisible: (v) => set({ previewVisible: v }),
  jobRunning: false,
  jobProgress: 0,
  setJobRunning: (running) => set({ jobRunning: running }),
  setJobProgress: (p) => set({ jobProgress: p }),

  // Z-Order
  moveObjectForward: (id) => withZOrder(id, get, set, (objs, idx) => {
    if (idx < 0 || idx >= objs.length - 1) return null;
    [objs[idx], objs[idx + 1]] = [objs[idx + 1], objs[idx]];
    return objs;
  }),
  moveObjectBackward: (id) => withZOrder(id, get, set, (objs, idx) => {
    if (idx <= 0) return null;
    [objs[idx - 1], objs[idx]] = [objs[idx], objs[idx - 1]];
    return objs;
  }),
  moveObjectToFront: (id) => withZOrder(id, get, set, (objs, idx) => {
    if (idx < 0) return null;
    const [obj] = objs.splice(idx, 1);
    objs.push(obj);
    return objs;
  }),
  moveObjectToBack: (id) => withZOrder(id, get, set, (objs, idx) => {
    if (idx < 0) return null;
    const [obj] = objs.splice(idx, 1);
    objs.unshift(obj);
    return objs;
  }),

  // Geometry actions (align, flip, group, boolean, array, convert, offset)
  ...createGeometryActions(set, get),

  // Selection helpers
  invertSelection: () => {
    const { objects, selectedIds } = get();
    set(selectionPatch(objects.filter((o) => !selectedIds.includes(o.id) && o.visible && !o.locked).map((o) => o.id)));
  },
  selectByLayer: (layerIndex) => {
    const { objects } = get();
    set(selectionPatch(objects.filter((o) => o.layerIndex === layerIndex && o.visible && !o.locked).map((o) => o.id)));
  },
  selectNext: () => {
    const { objects, selectedIds } = get();
    const visible = objects.filter((o) => o.visible && !o.locked);
    if (visible.length === 0) return;
    if (selectedIds.length === 0) {
      set(selectionPatch([visible[0].id]));
      return;
    }
    const currentIdx = visible.findIndex((o) => o.id === selectedIds[selectedIds.length - 1]);
    const nextIdx = (currentIdx + 1) % visible.length;
    set(selectionPatch([visible[nextIdx].id]));
  },
  selectPrev: () => {
    const { objects, selectedIds } = get();
    const visible = objects.filter((o) => o.visible && !o.locked);
    if (visible.length === 0) return;
    if (selectedIds.length === 0) {
      set(selectionPatch([visible[visible.length - 1].id]));
      return;
    }
    const currentIdx = visible.findIndex((o) => o.id === selectedIds[selectedIds.length - 1]);
    const prevIdx = (currentIdx - 1 + visible.length) % visible.length;
    set(selectionPatch([visible[prevIdx].id]));
  },
  duplicateInPlace: () => {
    if (get().selectedIds.length === 0) return;
    get().withUndo("duplicate", () => {
      const { selectedIds, objects, addObject } = get();
      const selected = objects.filter((o) => selectedIds.includes(o.id));
      const newIds: string[] = [];
      for (const obj of selected) {
        const newId = generateId();
        addObject({ ...obj, id: newId, name: obj.name + " copy" });
        newIds.push(newId);
      }
      set(selectionPatch(newIds));
    });
  },

  // Zoom helpers
  zoomToFitSelection: () => {
    const { selectedIds, objects, workspaceWidth, workspaceHeight } = get();
    const selected = objects.filter((o) => selectedIds.includes(o.id));
    if (selected.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const obj of selected) {
      minX = Math.min(minX, obj.transform.x);
      minY = Math.min(minY, obj.transform.y);
      maxX = Math.max(maxX, obj.transform.x + obj.transform.width);
      maxY = Math.max(maxY, obj.transform.y + obj.transform.height);
    }

    const padding = 50;
    const viewW = (workspaceWidth * PX_PER_MM) || 800;
    const viewH = (workspaceHeight * PX_PER_MM) || 600;
    const objW = (maxX - minX) * PX_PER_MM;
    const objH = (maxY - minY) * PX_PER_MM;

    const zoom = Math.min((viewW - padding * 2) / objW, (viewH - padding * 2) / objH, 10);
    const cx = (minX + maxX) / 2 * PX_PER_MM;
    const cy = (minY + maxY) / 2 * PX_PER_MM;

    set({ camera: { zoom, x: viewW / 2 - cx * zoom, y: viewH / 2 - cy * zoom } });
  },
  zoomToFitAll: () => {
    const { objects, workspaceWidth, workspaceHeight } = get();

    if (objects.length === 0) {
      set({ camera: { x: 50, y: 50, zoom: 1 } });
      return;
    }

    let minX = 0, minY = 0;
    let maxX = workspaceWidth, maxY = workspaceHeight;
    for (const obj of objects) {
      minX = Math.min(minX, obj.transform.x);
      minY = Math.min(minY, obj.transform.y);
      maxX = Math.max(maxX, obj.transform.x + obj.transform.width);
      maxY = Math.max(maxY, obj.transform.y + obj.transform.height);
    }

    const padding = 50;
    const viewW = window.innerWidth * 0.7;
    const viewH = window.innerHeight * 0.8;
    const objW = (maxX - minX) * PX_PER_MM;
    const objH = (maxY - minY) * PX_PER_MM;

    const zoom = Math.min((viewW - padding * 2) / objW, (viewH - padding * 2) / objH, 10);
    const cx = (minX + maxX) / 2 * PX_PER_MM;
    const cy = (minY + maxY) / 2 * PX_PER_MM;

    set({ camera: { zoom, x: viewW / 2 - cx * zoom, y: viewH / 2 - cy * zoom } });
  },

  // Start corner
  startCorner: "bottomLeft",
  // F15: start corner feeds the G-code optimizer (cut order), so it stales.
  setStartCorner: (corner) =>
    set((state) => ({
      startCorner: corner,
      isDirty: true,
      gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale,
    })),

  // Project notes
  projectNotes: "",
  setProjectNotes: (notes) => set({ projectNotes: notes, isDirty: true }),

  // Smart guides
  guides: [],
  setGuides: (g) => set({ guides: g }),

  // UI
  showConsole: false,
  setShowConsole: (v) => set({ showConsole: v }),
  statusMessage: null,
  setStatusMessage: (msg) => {
    set({ statusMessage: msg });
    if (msg !== null) {
      setTimeout(() => {
        if (get().statusMessage === msg) set({ statusMessage: null });
      }, 3000);
    }
  },
  // Node editing
  nodeEditState: { pathId: null, selectedNodeIndex: null },
  setNodeEditState: (state) => set({ nodeEditState: state }),

  // Dialog state
  openDialogs: new Set(),
  openDialog: (name) => set((state) => {
    const next = new Set(state.openDialogs);
    next.add(name);
    return { openDialogs: next };
  }),
  closeDialog: (name) => set((state) => {
    const next = new Set(state.openDialogs);
    next.delete(name);
    return { openDialogs: next };
  }),
  dialogData: {
    svgContent: null,
    pendingImage: null,
    ditherPreviewObjectId: null,
    pendingPdf: null,
  },
  setDialogData: (data) => set((state) => ({
    dialogData: { ...state.dialogData, ...data },
  })),
}));
