import { create } from "zustand";
import type { SubLayer } from "../types";
import { DEFAULT_LAYERS } from "../types";
import { DEFAULT_MATERIALS } from "../../lib/materials";
import { createGeometryActions } from "./geometryActions";
import type { AppState } from "./storeTypes";

export type { AppState } from "./storeTypes";
export { generateId } from "./storeTypes";

export const useStore = create<AppState>((set, get) => ({
  // Tool
  activeTool: "select",
  setActiveTool: (tool) => set({ activeTool: tool }),

  // Objects
  objects: [],
  addObject: (obj) =>
    set((state) => ({
      objects: [...state.objects, obj],
      isDirty: true,
    })),
  updateObject: (id, partial) =>
    set((state) => ({
      objects: state.objects.map((o) =>
        o.id === id ? { ...o, ...partial } : o
      ),
      isDirty: true,
    })),
  removeObjects: (ids) =>
    set((state) => ({
      objects: state.objects.filter((o) => !ids.includes(o.id)),
      selectedIds: state.selectedIds.filter((id) => !ids.includes(id)),
      isDirty: true,
    })),
  setObjects: (objects) => set({ objects }),

  // Selection
  selectedIds: [],
  setSelectedIds: (ids) => set({ selectedIds: ids }),
  addToSelection: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds
        : [...state.selectedIds, id],
    })),
  removeFromSelection: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.filter((i) => i !== id),
    })),
  clearSelection: () => set({ selectedIds: [] }),

  // Layers
  layers: DEFAULT_LAYERS,
  activeLayerIndex: 0,
  setActiveLayerIndex: (index) => set({ activeLayerIndex: index }),
  updateLayer: (index, partial) =>
    set((state) => ({
      layers: state.layers.map((l) =>
        l.index === index ? { ...l, ...partial } : l
      ),
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
      return { layers: reindexed, objects, activeLayerIndex, isDirty: true };
    }),
  addSubLayer: (layerIndex) =>
    set((state) => ({
      layers: state.layers.map((l) => {
        if (l.index !== layerIndex) return l;
        const newSub: SubLayer = {
          id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
    })),
  removeSubLayer: (layerIndex, subLayerId) =>
    set((state) => ({
      layers: state.layers.map((l) => {
        if (l.index !== layerIndex) return l;
        const filtered = (l.subLayers || []).filter((s) => s.id !== subLayerId);
        return { ...l, subLayers: filtered.length > 0 ? filtered : undefined };
      }),
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
    })),

  // Camera
  camera: { x: 0, y: 0, zoom: 1 },
  setCamera: (camera) =>
    set((state) => ({ camera: { ...state.camera, ...camera } })),

  // Workspace
  workspaceWidth: 500,
  workspaceHeight: 300,
  setWorkspaceSize: (w, h) =>
    set({ workspaceWidth: w, workspaceHeight: h }),
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
    // Strip imageData from snapshots to avoid duplicating large base64 strings in undo history
    const stripImageData = (objects: import("../types").DesignObject[]): import("../types").DesignObject[] =>
      objects.map((o) => o.imageData ? { ...o, imageData: "__UNDO_REF__" } : o);
    const beforeObjects = get().objects;
    const beforeSelectedIds = get().selectedIds;
    const beforeSnapshot = stripImageData(beforeObjects);
    fn();
    const afterObjects = get().objects;
    const afterSelectedIds = get().selectedIds;
    if (beforeObjects !== afterObjects) {
      const afterSnapshot = stripImageData(afterObjects);
      // Restore live imageData from current objects array when applying undo/redo
      const restoreImageData = (snapshot: import("../types").DesignObject[]): import("../types").DesignObject[] => {
        const live = get().objects;
        const imageMap = new Map<string, string>();
        for (const o of live) { if (o.imageData && o.imageData !== "__UNDO_REF__") imageMap.set(o.id, o.imageData); }
        // Also check the before/after objects we captured at command creation time
        for (const o of beforeObjects) { if (o.imageData && o.imageData !== "__UNDO_REF__") imageMap.set(o.id, o.imageData); }
        for (const o of afterObjects) { if (o.imageData && o.imageData !== "__UNDO_REF__") imageMap.set(o.id, o.imageData); }
        return snapshot.map((o) => o.imageData === "__UNDO_REF__" ? { ...o, imageData: imageMap.get(o.id) } : o);
      };
      get().pushCommand({
        type,
        undo: () => set({ objects: restoreImageData(beforeSnapshot), selectedIds: beforeSelectedIds, isDirty: true }),
        redo: () => set({ objects: restoreImageData(afterSnapshot), selectedIds: afterSelectedIds, isDirty: true }),
      });
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
      const after = { objects: get().objects, selectedIds: get().selectedIds };
      get().pushCommand({
        type: "property-edit",
        undo: () => set({ objects: snapshot.objects, selectedIds: snapshot.selectedIds, isDirty: true }),
        redo: () => set({ objects: after.objects, selectedIds: after.selectedIds, isDirty: true }),
      });
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
      layers: project.layers.map(l => ({ ...l, output: l.output ?? true })),
      camera: project.camera,
      workspaceWidth: project.workspaceWidth,
      workspaceHeight: project.workspaceHeight,
      projectName: project.name,
      projectNotes: project.notes || "",
      materials: project.materials || DEFAULT_MATERIALS,
      isDirty: false,
      selectedIds: [],
    }),
  toProject: () => {
    const state = get();
    return {
      version: "0.3.1",
      name: state.projectName,
      objects: state.objects,
      layers: state.layers,
      camera: state.camera,
      workspaceWidth: state.workspaceWidth,
      workspaceHeight: state.workspaceHeight,
      notes: state.projectNotes,
      materials: state.materials,
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
  setGrblSValueMax: (v) => set({ grblSValueMax: v }),
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
  setGcodeResult: (result) => set({ gcodeResult: result }),
  previewVisible: false,
  setPreviewVisible: (v) => set({ previewVisible: v }),
  previewProgress: 0,
  setPreviewProgress: (p) => set({ previewProgress: p }),
  jobRunning: false,
  jobProgress: 0,
  setJobRunning: (running) => set({ jobRunning: running }),
  setJobProgress: (p) => set({ jobProgress: p }),

  // Z-Order
  moveObjectForward: (id) => {
    get().withUndo("z-order", () => {
      set((state) => {
        const idx = state.objects.findIndex((o) => o.id === id);
        if (idx < 0 || idx >= state.objects.length - 1) return state;
        const objs = [...state.objects];
        [objs[idx], objs[idx + 1]] = [objs[idx + 1], objs[idx]];
        return { objects: objs, isDirty: true };
      });
    });
  },
  moveObjectBackward: (id) => {
    get().withUndo("z-order", () => {
      set((state) => {
        const idx = state.objects.findIndex((o) => o.id === id);
        if (idx <= 0) return state;
        const objs = [...state.objects];
        [objs[idx - 1], objs[idx]] = [objs[idx], objs[idx - 1]];
        return { objects: objs, isDirty: true };
      });
    });
  },
  moveObjectToFront: (id) => {
    get().withUndo("z-order", () => {
      set((state) => {
        const idx = state.objects.findIndex((o) => o.id === id);
        if (idx < 0) return state;
        const objs = [...state.objects];
        const [obj] = objs.splice(idx, 1);
        objs.push(obj);
        return { objects: objs, isDirty: true };
      });
    });
  },
  moveObjectToBack: (id) => {
    get().withUndo("z-order", () => {
      set((state) => {
        const idx = state.objects.findIndex((o) => o.id === id);
        if (idx < 0) return state;
        const objs = [...state.objects];
        const [obj] = objs.splice(idx, 1);
        objs.unshift(obj);
        return { objects: objs, isDirty: true };
      });
    });
  },

  // Geometry actions (align, flip, group, boolean, array, convert, offset)
  ...createGeometryActions(set, get),

  // Selection helpers
  invertSelection: () => {
    const { objects, selectedIds } = get();
    set({ selectedIds: objects.filter((o) => !selectedIds.includes(o.id) && o.visible && !o.locked).map((o) => o.id) });
  },
  selectByLayer: (layerIndex) => {
    const { objects } = get();
    set({ selectedIds: objects.filter((o) => o.layerIndex === layerIndex && o.visible && !o.locked).map((o) => o.id) });
  },
  selectNext: () => {
    const { objects, selectedIds } = get();
    const visible = objects.filter((o) => o.visible && !o.locked);
    if (visible.length === 0) return;
    if (selectedIds.length === 0) {
      set({ selectedIds: [visible[0].id] });
      return;
    }
    const currentIdx = visible.findIndex((o) => o.id === selectedIds[selectedIds.length - 1]);
    const nextIdx = (currentIdx + 1) % visible.length;
    set({ selectedIds: [visible[nextIdx].id] });
  },
  selectPrev: () => {
    const { objects, selectedIds } = get();
    const visible = objects.filter((o) => o.visible && !o.locked);
    if (visible.length === 0) return;
    if (selectedIds.length === 0) {
      set({ selectedIds: [visible[visible.length - 1].id] });
      return;
    }
    const currentIdx = visible.findIndex((o) => o.id === selectedIds[selectedIds.length - 1]);
    const prevIdx = (currentIdx - 1 + visible.length) % visible.length;
    set({ selectedIds: [visible[prevIdx].id] });
  },
  duplicateInPlace: () => {
    if (get().selectedIds.length === 0) return;
    get().withUndo("duplicate", () => {
      const { selectedIds, objects, addObject } = get();
      const selected = objects.filter((o) => selectedIds.includes(o.id));
      const newIds: string[] = [];
      for (const obj of selected) {
        const newId = `obj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        addObject({ ...obj, id: newId, name: obj.name + " copy" });
        newIds.push(newId);
      }
      set({ selectedIds: newIds });
    });
  },

  // Zoom helpers
  zoomToFitSelection: () => {
    const { selectedIds, objects, workspaceWidth, workspaceHeight } = get();
    const PX_PER_MM = 3.78;
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
    const PX_PER_MM = 3.78;

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

  // Project notes
  projectNotes: "",
  setProjectNotes: (notes) => set({ projectNotes: notes, isDirty: true }),

  // Smart guides
  guides: [],
  setGuides: (g) => set({ guides: g }),

  // UI
  showConsole: false,
  setShowConsole: (v) => set({ showConsole: v }),
  cursorPosition: { x: 0, y: 0 },
  setCursorPosition: (pos) => set({ cursorPosition: pos }),

  // Node editing
  nodeEditState: { pathId: null, selectedNodeIndex: null },
  setNodeEditState: (state) => set({ nodeEditState: state }),
}));
