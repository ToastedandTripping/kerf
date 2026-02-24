import { create } from "zustand";
import * as polygonClipping from "polygon-clipping";
import opentype from "opentype.js";
import type {
  ToolType,
  DesignObject,
  Layer,
  SubLayer,
  CameraState,
  KerfProject,
  MaterialPreset,
} from "./types";
import { DEFAULT_LAYERS } from "./types";
import { DEFAULT_MATERIALS } from "../lib/materials";

// --- Undo/Redo Command Pattern ---
interface Command {
  type: string;
  undo: () => void;
  redo: () => void;
}

// --- Store State ---
interface AppState {
  // Tool
  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;

  // Objects
  objects: DesignObject[];
  addObject: (obj: DesignObject) => void;
  updateObject: (id: string, partial: Partial<DesignObject>) => void;
  removeObjects: (ids: string[]) => void;
  setObjects: (objects: DesignObject[]) => void;

  // Selection
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  addToSelection: (id: string) => void;
  removeFromSelection: (id: string) => void;
  clearSelection: () => void;

  // Layers
  layers: Layer[];
  activeLayerIndex: number;
  setActiveLayerIndex: (index: number) => void;
  updateLayer: (index: number, partial: Partial<Layer>) => void;
  addSubLayer: (layerIndex: number) => void;
  removeSubLayer: (layerIndex: number, subLayerId: string) => void;
  updateSubLayer: (layerIndex: number, subLayerId: string, changes: Partial<SubLayer>) => void;

  // Camera
  camera: CameraState;
  setCamera: (camera: Partial<CameraState>) => void;

  // Workspace
  workspaceWidth: number;
  workspaceHeight: number;
  setWorkspaceSize: (w: number, h: number) => void;
  gridVisible: boolean;
  setGridVisible: (v: boolean) => void;
  snapToGrid: boolean;
  setSnapToGrid: (v: boolean) => void;
  gridSize: number;
  setGridSize: (s: number) => void;

  // Undo/Redo
  undoStack: Command[];
  redoStack: Command[];
  pushCommand: (cmd: Command) => void;
  undo: () => void;
  redo: () => void;
  withUndo: (type: string, fn: () => void) => void;
  _propertyEditSnapshot: { objects: DesignObject[]; selectedIds: string[] } | null;
  beginPropertyEdit: () => void;
  commitPropertyEdit: () => void;

  // Drawing state (temp state while drawing a shape)
  drawingObject: DesignObject | null;
  setDrawingObject: (obj: DesignObject | null) => void;

  // Project
  projectName: string;
  projectPath: string | null;
  isDirty: boolean;
  setProjectName: (name: string) => void;
  setProjectPath: (path: string | null) => void;
  setDirty: (dirty: boolean) => void;
  loadProject: (project: KerfProject) => void;
  toProject: () => KerfProject;

  // Clipboard
  clipboard: DesignObject[];
  setClipboard: (objects: DesignObject[]) => void;

  // Materials
  materials: MaterialPreset[];
  addMaterial: (m: MaterialPreset) => void;
  removeMaterial: (id: string) => void;
  updateMaterial: (id: string, partial: Partial<MaterialPreset>) => void;

  // Machine connection
  machineConnected: boolean;
  machineState: "idle" | "run" | "hold" | "alarm" | "disconnected";
  machinePosition: { x: number; y: number; z: number };
  setMachineConnected: (connected: boolean) => void;
  setMachineState: (state: "idle" | "run" | "hold" | "alarm" | "disconnected") => void;
  setMachinePosition: (pos: { x: number; y: number; z: number }) => void;

  // Console
  consoleLines: Array<{ text: string; type: "sent" | "received" | "info" | "error" }>;
  addConsoleLine: (text: string, type: "sent" | "received" | "info" | "error") => void;
  clearConsole: () => void;

  // G-code / Preview
  gcodeResult: {
    gcode: string;
    moves: Array<{ x: number; y: number; moveType: string; speed: number; power: number }>;
    totalDistance: number;
    cutDistance: number;
    travelDistance: number;
    estimatedTimeSecs: number;
    lineCount: number;
  } | null;
  setGcodeResult: (result: AppState["gcodeResult"]) => void;
  previewVisible: boolean;
  setPreviewVisible: (v: boolean) => void;
  previewProgress: number; // 0-1 for animation scrubber
  setPreviewProgress: (p: number) => void;
  jobRunning: boolean;
  jobProgress: number; // 0-1 for job send progress
  setJobRunning: (running: boolean) => void;
  setJobProgress: (p: number) => void;

  // Z-Order
  moveObjectForward: (id: string) => void;
  moveObjectBackward: (id: string) => void;
  moveObjectToFront: (id: string) => void;
  moveObjectToBack: (id: string) => void;

  // Alignment
  alignObjects: (alignment: "left" | "right" | "top" | "bottom" | "hcenter" | "vcenter") => void;
  distributeObjects: (direction: "horizontal" | "vertical") => void;

  // Flip
  flipObjects: (axis: "horizontal" | "vertical") => void;

  // Group
  groupSelected: () => void;
  ungroupSelected: () => void;

  // Convert to Path
  convertToPath: (id: string) => void;
  convertTextToPath: (id: string) => Promise<void>;

  // Rotate 90
  rotate90: (direction: "cw" | "ccw") => void;

  // Array tools
  gridArray: (rows: number, cols: number, spacingX: number, spacingY: number) => void;
  circularArray: (count: number, radius: number, startAngle: number) => void;

  // Selection helpers
  invertSelection: () => void;
  selectByLayer: (layerIndex: number) => void;
  selectNext: () => void;
  selectPrev: () => void;
  duplicateInPlace: () => void;

  // Zoom helpers
  zoomToFitSelection: () => void;
  zoomToFitAll: () => void;

  // Boolean operations
  booleanUnion: () => void;
  booleanDifference: () => void;
  booleanIntersection: () => void;
  booleanXor: () => void;
  offsetPaths: (distance: number) => void;

  // Project notes
  projectNotes: string;
  setProjectNotes: (notes: string) => void;

  // Smart guides
  guides: Array<{ type: "h" | "v"; pos: number }>;
  setGuides: (g: Array<{ type: "h" | "v"; pos: number }>) => void;

  // UI
  showConsole: boolean;
  setShowConsole: (v: boolean) => void;
  cursorPosition: { x: number; y: number };
  setCursorPosition: (pos: { x: number; y: number }) => void;

  // Node editing
  nodeEditState: { pathId: string | null; selectedNodeIndex: number | null };
  setNodeEditState: (state: { pathId: string | null; selectedNodeIndex: number | null }) => void;
}

let idCounter = 0;
export function generateId(): string {
  return `obj_${Date.now()}_${++idCounter}`;
}

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
  workspaceWidth: 500, // mm
  workspaceHeight: 300, // mm
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
    set((state) => ({
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
    })),
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
    const before = { objects: get().objects, selectedIds: get().selectedIds };
    fn();
    const after = { objects: get().objects, selectedIds: get().selectedIds };
    if (before.objects !== after.objects) {
      get().pushCommand({
        type,
        undo: () => set({ objects: before.objects, selectedIds: before.selectedIds, isDirty: true }),
        redo: () => set({ objects: after.objects, selectedIds: after.selectedIds, isDirty: true }),
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
      layers: project.layers,
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
      version: "0.1.0",
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
  setMachineConnected: (connected) => set({ machineConnected: connected }),
  setMachineState: (state) => set({ machineState: state }),
  setMachinePosition: (pos) => set({ machinePosition: pos }),

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

  // Alignment
  alignObjects: (alignment) => {
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

      let target: number;
      switch (alignment) {
        case "left":
          target = Math.min(...bounds.map((b) => b.left));
          for (const b of bounds) {
            const obj = objects.find((o) => o.id === b.id)!;
            updateObject(b.id, { transform: { ...obj.transform, x: target } });
          }
          break;
        case "right":
          target = Math.max(...bounds.map((b) => b.right));
          for (const b of bounds) {
            const obj = objects.find((o) => o.id === b.id)!;
            updateObject(b.id, { transform: { ...obj.transform, x: target - obj.transform.width } });
          }
          break;
        case "top":
          target = Math.min(...bounds.map((b) => b.top));
          for (const b of bounds) {
            const obj = objects.find((o) => o.id === b.id)!;
            updateObject(b.id, { transform: { ...obj.transform, y: target } });
          }
          break;
        case "bottom":
          target = Math.max(...bounds.map((b) => b.bottom));
          for (const b of bounds) {
            const obj = objects.find((o) => o.id === b.id)!;
            updateObject(b.id, { transform: { ...obj.transform, y: target - obj.transform.height } });
          }
          break;
        case "hcenter": {
          const allLeft = Math.min(...bounds.map((b) => b.left));
          const allRight = Math.max(...bounds.map((b) => b.right));
          const center = (allLeft + allRight) / 2;
          for (const b of bounds) {
            const obj = objects.find((o) => o.id === b.id)!;
            updateObject(b.id, { transform: { ...obj.transform, x: center - obj.transform.width / 2 } });
          }
          break;
        }
        case "vcenter": {
          const allTop = Math.min(...bounds.map((b) => b.top));
          const allBottom = Math.max(...bounds.map((b) => b.bottom));
          const center = (allTop + allBottom) / 2;
          for (const b of bounds) {
            const obj = objects.find((o) => o.id === b.id)!;
            updateObject(b.id, { transform: { ...obj.transform, y: center - obj.transform.height / 2 } });
          }
          break;
        }
      }
    });
  },
  distributeObjects: (direction) => {
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
          updateObject(obj.id, { transform: { ...obj.transform, x } });
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
          updateObject(obj.id, { transform: { ...obj.transform, y } });
          y += obj.transform.height + gap;
        }
      }
    });
  },

  // Flip
  flipObjects: (axis) => {
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
          // Bake flip into geometry: mirror point coordinates through center
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
          // Keep scale on transform -- renderer handles it
          if (axis === "horizontal") {
            updateObject(obj.id, { transform: { ...t, scaleX: t.scaleX * -1 } });
          } else {
            updateObject(obj.id, { transform: { ...t, scaleY: t.scaleY * -1 } });
          }
        } else {
          // Symmetric primitives (rect, ellipse): flip is visual no-op, reset scale
          updateObject(obj.id, { transform: { ...t, scaleX: 1, scaleY: 1 } });
        }
      } else {
        // Flip group around collective center
        const allLeft = Math.min(...selected.map((o) => o.transform.x));
        const allRight = Math.max(...selected.map((o) => o.transform.x + o.transform.width));
        const allTop = Math.min(...selected.map((o) => o.transform.y));
        const allBottom = Math.max(...selected.map((o) => o.transform.y + o.transform.height));

        for (const obj of selected) {
          if (axis === "horizontal") {
            const newX = allRight - (obj.transform.x - allLeft) - obj.transform.width;
            updateObject(obj.id, { transform: { ...obj.transform, x: newX } });
          } else {
            const newY = allBottom - (obj.transform.y - allTop) - obj.transform.height;
            updateObject(obj.id, { transform: { ...obj.transform, y: newY } });
          }
        }
      }
    });
  },

  // Group
  groupSelected: () => {
    if (get().selectedIds.length < 2) return;
    get().withUndo("group", () => {
      const { selectedIds, objects } = get();
      const selected = objects.filter((o) => selectedIds.includes(o.id));
      const remaining = objects.filter((o) => !selectedIds.includes(o.id));

      // Calculate group bounding box
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const obj of selected) {
        minX = Math.min(minX, obj.transform.x);
        minY = Math.min(minY, obj.transform.y);
        maxX = Math.max(maxX, obj.transform.x + obj.transform.width);
        maxY = Math.max(maxY, obj.transform.y + obj.transform.height);
      }

      // Adjust children transforms to be relative to group origin
      const children = selected.map((o) => ({
        ...o,
        transform: {
          ...o.transform,
          x: o.transform.x - minX,
          y: o.transform.y - minY,
        },
      }));

      const groupId = `obj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const group: DesignObject = {
        id: groupId,
        type: "group",
        name: `Group ${remaining.length + 1}`,
        transform: {
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
        },
        layerIndex: selected[0].layerIndex,
        visible: true,
        locked: false,
        fill: null,
        stroke: "#ffffff",
        strokeWidth: 0,
        opacity: 1,
        children,
      };

      // Insert group at position of first selected object
      const insertIdx = objects.findIndex((o) => o.id === selected[0].id);
      const newObjects = [...remaining];
      newObjects.splice(Math.min(insertIdx, newObjects.length), 0, group);

      set({ objects: newObjects, selectedIds: [groupId], isDirty: true });
    });
  },
  ungroupSelected: () => {
    get().withUndo("ungroup", () => {
      const { selectedIds, objects } = get();
      const newObjects: DesignObject[] = [];
      const newSelectedIds: string[] = [];

      for (const obj of objects) {
        if (selectedIds.includes(obj.id) && obj.type === "group" && obj.children) {
          // Expand children back to absolute positions
          for (const child of obj.children) {
            const expanded = {
              ...child,
              transform: {
                ...child.transform,
                x: child.transform.x + obj.transform.x,
                y: child.transform.y + obj.transform.y,
              },
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

      set({ objects: newObjects, selectedIds: newSelectedIds, isDirty: true });
    });
  },

  // Convert to Path
  convertToPath: (id) => {
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
          // Rounded rectangle as path
          const w = t.width, h = t.height;
          const cr = Math.min(r, w / 2, h / 2);
          const k = 0.5522847498; // bezier circle approximation
          points = [
            { x: cr, y: 0, handleIn: { x: cr - cr * k, y: 0 } },
            { x: w - cr, y: 0, handleOut: { x: w - cr + cr * k, y: 0 } },
            { x: w, y: cr, handleIn: { x: w, y: cr - cr * k }, handleOut: { x: w, y: cr + (h - 2 * cr) > 0 ? cr : cr } },
            { x: w, y: h - cr, handleOut: { x: w, y: h - cr + cr * k } },
            { x: w - cr, y: h, handleIn: { x: w - cr + cr * k, y: h }, handleOut: { x: w - cr - (w - 2 * cr > 0 ? 0 : 0), y: h } },
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
        // Approximate ellipse with 4 cubic bezier curves
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
        return; // Can't convert lines/paths/text/images this way
    }

    // Offset points by transform origin
    const absolutePoints = points.map((p) => ({
      x: t.x + p.x,
      y: t.y + p.y,
      handleIn: p.handleIn ? { x: t.x + p.handleIn.x, y: t.y + p.handleIn.y } : undefined,
      handleOut: p.handleOut ? { x: t.x + p.handleOut.x, y: t.y + p.handleOut.y } : undefined,
    }));

    updateObject(id, {
      type: "path",
      points: absolutePoints,
      closed: true,
    });
    });
  },

  convertTextToPath: async (id) => {
    const { objects } = get();
    const obj = objects.find((o) => o.id === id);
    if (!obj || obj.type !== "text" || !obj.text) return;

    try {
      // Load font locally first (works offline in Tauri), fall back to CDN
      let font: opentype.Font;
      try {
        font = await opentype.load("/fonts/OpenSans-Regular.ttf");
      } catch {
        font = await opentype.load("https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/opensans/OpenSans%5Bwdth%2Cwght%5D.ttf");
      }

      const fontSize = obj.fontSize || 12;
      // Convert mm font size to font units (opentype uses unitsPerEm)
      // We work in mm, so we need to scale the font path to mm
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

        // Convert opentype path commands to KERF PathPoints
        const pathPoints: Array<{ x: number; y: number; handleIn?: { x: number; y: number }; handleOut?: { x: number; y: number } }> = [];
        let currentX = 0, currentY = 0;

        for (const cmd of commands) {
          switch (cmd.type) {
            case "M":
              // If we have accumulated points, flush them as a sub-path
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
              // Cubic bezier - the previous point gets a handleOut, and the new point gets a handleIn
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
              // Quadratic bezier - convert to cubic approximation
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
              // Close path - points array is already closed enough
              break;
          }
        }

        if (pathPoints.length > 1) {
          // Calculate bounding box
          const xs = pathPoints.map(p => p.x);
          const ys = pathPoints.map(p => p.y);
          const minX = Math.min(...xs);
          const minY = Math.min(...ys);
          const maxX = Math.max(...xs);
          const maxY = Math.max(...ys);

          prepared.push({
            ...obj,
            id: generateId(),
            type: "path",
            text: undefined,
            fontSize: undefined,
            fontFamily: undefined,
            points: pathPoints,
            closed: true,
            transform: {
              ...obj.transform,
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY,
            },
          });
        }

        xOffset += (glyph.advanceWidth || 0) * scale;
      }

      // Wrap all mutations in a single undo entry
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
      // Fallback: just convert the bounding box to a rectangle path
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

  // Rotate 90
  rotate90: (direction) => {
    if (get().selectedIds.length === 0) return;
    get().withUndo("rotate", () => {
      const { selectedIds, objects, updateObject } = get();
      const angle = direction === "cw" ? 90 : -90;

      for (const id of selectedIds) {
        const obj = objects.find((o) => o.id === id);
        if (!obj) continue;
        updateObject(id, {
          transform: {
            ...obj.transform,
            rotation: (obj.transform.rotation + angle) % 360,
          },
        });
      }
    });
  },

  // Array tools
  gridArray: (rows, cols, spacingX, spacingY) => {
    if (get().selectedIds.length === 0) return;
    get().withUndo("grid-array", () => {
      const { selectedIds, objects, addObject, setSelectedIds } = get();
      const selected = objects.filter((o) => selectedIds.includes(o.id));
      const newIds: string[] = [...selectedIds];

      for (const obj of selected) {
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (r === 0 && c === 0) continue; // skip original
            const newId = `obj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            addObject({
              ...obj,
              id: newId,
              name: obj.name + ` [${r},${c}]`,
              transform: {
                ...obj.transform,
                x: obj.transform.x + c * (obj.transform.width + spacingX),
                y: obj.transform.y + r * (obj.transform.height + spacingY),
              },
            });
            newIds.push(newId);
          }
        }
      }
      setSelectedIds(newIds);
    });
  },
  circularArray: (count, radius, startAngle) => {
    if (get().selectedIds.length === 0) return;
    get().withUndo("circular-array", () => {
      const { selectedIds, objects, addObject, setSelectedIds } = get();
      const selected = objects.filter((o) => selectedIds.includes(o.id));
      const newIds: string[] = [...selectedIds];

      // Calculate center of selection
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
          const newId = `obj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${i}`;
          addObject({
            ...obj,
            id: newId,
            name: obj.name + ` [${i}]`,
            transform: {
              ...obj.transform,
              x: newCx - obj.transform.width / 2,
              y: newCy - obj.transform.height / 2,
              rotation: (obj.transform.rotation + angleStep * i) % 360,
            },
          });
          newIds.push(newId);
        }
      }
      setSelectedIds(newIds);
    });
  },

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

    const padding = 50; // px
    const viewW = (workspaceWidth * PX_PER_MM) || 800; // approximate viewport
    const viewH = (workspaceHeight * PX_PER_MM) || 600;
    const objW = (maxX - minX) * PX_PER_MM;
    const objH = (maxY - minY) * PX_PER_MM;

    const zoom = Math.min((viewW - padding * 2) / objW, (viewH - padding * 2) / objH, 10);
    const cx = (minX + maxX) / 2 * PX_PER_MM;
    const cy = (minY + maxY) / 2 * PX_PER_MM;

    set({
      camera: {
        zoom,
        x: viewW / 2 - cx * zoom,
        y: viewH / 2 - cy * zoom,
      },
    });
  },
  zoomToFitAll: () => {
    const { objects, workspaceWidth, workspaceHeight } = get();
    const PX_PER_MM = 3.78;

    if (objects.length === 0) {
      // Fit workspace
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
    const viewW = window.innerWidth * 0.7; // approximate viewport width
    const viewH = window.innerHeight * 0.8;
    const objW = (maxX - minX) * PX_PER_MM;
    const objH = (maxY - minY) * PX_PER_MM;

    const zoom = Math.min((viewW - padding * 2) / objW, (viewH - padding * 2) / objH, 10);
    const cx = (minX + maxX) / 2 * PX_PER_MM;
    const cy = (minY + maxY) / 2 * PX_PER_MM;

    set({
      camera: {
        zoom,
        x: viewW / 2 - cx * zoom,
        y: viewH / 2 - cy * zoom,
      },
    });
  },

  // Boolean operations
  booleanUnion: () => {
    if (get().selectedIds.length < 2) return;
    get().withUndo("boolean", () => {
      const { selectedIds, objects, removeObjects, addObject, setSelectedIds } = get();
      const selected = objects.filter((o) => selectedIds.includes(o.id));
      const polys = selected.map(objectToPolygon).filter(Boolean) as polygonClipping.Polygon[];
      if (polys.length < 2) return;
      const result = polygonClipping.union(polys[0], ...polys.slice(1));
      removeObjects(selectedIds);
      const newIds = multiPolygonToObjects(result, selected[0]).map((obj) => {
        addObject(obj);
        return obj.id;
      });
      setSelectedIds(newIds);
    });
  },

  booleanDifference: () => {
    if (get().selectedIds.length < 2) return;
    get().withUndo("boolean", () => {
      const { selectedIds, objects, removeObjects, addObject, setSelectedIds } = get();
      const selected = objects.filter((o) => selectedIds.includes(o.id));
      const polys = selected.map(objectToPolygon).filter(Boolean) as polygonClipping.Polygon[];
      if (polys.length < 2) return;
      const result = polygonClipping.difference(polys[0], ...polys.slice(1));
      removeObjects(selectedIds);
      const newIds = multiPolygonToObjects(result, selected[0]).map((obj) => {
        addObject(obj);
        return obj.id;
      });
      setSelectedIds(newIds);
    });
  },

  booleanIntersection: () => {
    if (get().selectedIds.length < 2) return;
    get().withUndo("boolean", () => {
      const { selectedIds, objects, removeObjects, addObject, setSelectedIds } = get();
      const selected = objects.filter((o) => selectedIds.includes(o.id));
      const polys = selected.map(objectToPolygon).filter(Boolean) as polygonClipping.Polygon[];
      if (polys.length < 2) return;
      const result = polygonClipping.intersection(polys[0], ...polys.slice(1));
      removeObjects(selectedIds);
      const newIds = multiPolygonToObjects(result, selected[0]).map((obj) => {
        addObject(obj);
        return obj.id;
      });
      setSelectedIds(newIds);
    });
  },

  booleanXor: () => {
    if (get().selectedIds.length < 2) return;
    get().withUndo("boolean", () => {
      const { selectedIds, objects, removeObjects, addObject, setSelectedIds } = get();
      const selected = objects.filter((o) => selectedIds.includes(o.id));
      const polys = selected.map(objectToPolygon).filter(Boolean) as polygonClipping.Polygon[];
      if (polys.length < 2) return;
      const result = polygonClipping.xor(polys[0], ...polys.slice(1));
      removeObjects(selectedIds);
      const newIds = multiPolygonToObjects(result, selected[0]).map((obj) => {
        addObject(obj);
        return obj.id;
      });
      setSelectedIds(newIds);
    });
  },

  offsetPaths: (distance) => {
    if (get().selectedIds.length === 0) return;
    get().withUndo("offset", () => {
      const { selectedIds, objects, addObject, setSelectedIds } = get();
      const selected = objects.filter((o) => selectedIds.includes(o.id));
      const newIds: string[] = [];
      for (const obj of selected) {
        const poly = objectToPolygon(obj);
        if (!poly) continue;
        // Simple offset by expanding/contracting each point along its normal
        const ring = poly[0];
        const offsetRing = offsetRingByDistance(ring, distance);
        const newId = `obj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

// --- Boolean operation helpers ---

/** Sample a cubic bezier segment using de Casteljau's algorithm */
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
        [t.x, t.y],
        [t.x + t.width, t.y],
        [t.x + t.width, t.y + t.height],
        [t.x, t.y + t.height],
        [t.x, t.y], // close
      ];
      return [ring];
    }
    case "ellipse": {
      const cx = t.x + t.width / 2;
      const cy = t.y + t.height / 2;
      const rx = t.width / 2;
      const ry = t.height / 2;
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
      // Sample bezier curves to preserve shape during boolean ops
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
      // Handle closing curve
      if (obj.closed && obj.points.length >= 2) {
        const last = obj.points[obj.points.length - 1];
        const first = obj.points[0];
        if (last.handleOut && first.handleIn) {
          ring.push(...sampleBezierSegment(
            { x: last.x, y: last.y }, last.handleOut, first.handleIn, { x: first.x, y: first.y },
          ));
        }
      }
      // Close the ring
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
    const ring = polygon[0]; // outer ring
    const points = ring.map((p) => ({ x: p[0], y: p[1] }));
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const maxX = Math.max(...xs), maxY = Math.max(...ys);
    return {
      ...template,
      id: `obj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "path" as const,
      points,
      closed: true,
      transform: {
        ...template.transform,
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      },
    };
  });
}

function offsetRingByDistance(ring: polygonClipping.Ring, distance: number): polygonClipping.Ring {
  const result: polygonClipping.Ring = [];
  const n = ring.length;
  if (n < 3) return ring;
  // Close the ring if not already closed
  const closed = ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring;
  const len = pts.length;

  for (let i = 0; i < len; i++) {
    const prev = pts[(i - 1 + len) % len];
    const curr = pts[i];
    const next = pts[(i + 1) % len];

    // Edge normals
    const dx1 = curr[0] - prev[0], dy1 = curr[1] - prev[1];
    const dx2 = next[0] - curr[0], dy2 = next[1] - curr[1];
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
    const nx1 = -dy1 / len1, ny1 = dx1 / len1;
    const nx2 = -dy2 / len2, ny2 = dx2 / len2;

    // Average normal
    const nx = nx1 + nx2, ny = ny1 + ny2;
    const nlen = Math.sqrt(nx * nx + ny * ny) || 1;

    result.push([
      curr[0] + (nx / nlen) * distance,
      curr[1] + (ny / nlen) * distance,
    ]);
  }
  // Close
  if (result.length > 0) result.push([result[0][0], result[0][1]]);
  return result;
}
