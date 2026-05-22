import type { StoreApi } from "zustand";
import type {
  ToolType,
  DesignObject,
  Layer,
  SubLayer,
  CameraState,
  KerfProject,
  MaterialPreset,
  StartCorner,
  VariableTextConfig,
  NestConfig,
  NestResult,
} from "../types";

export type StoreSet = StoreApi<AppState>["setState"];
export type StoreGet = StoreApi<AppState>["getState"];

export interface Command {
  type: string;
  undo: () => void;
  redo: () => void;
}

export interface AppState {
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
  reorderLayers: (fromIndex: number, toIndex: number) => void;
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

  // Drawing state
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
  grblSValueMax: number;
  grblLaserMode: boolean;
  grblAccelX: number;
  grblAccelY: number;
  setMachineConnected: (connected: boolean) => void;
  setMachineState: (state: "idle" | "run" | "hold" | "alarm" | "disconnected") => void;
  setMachinePosition: (pos: { x: number; y: number; z: number }) => void;
  setGrblSValueMax: (v: number) => void;
  setGrblLaserMode: (v: boolean) => void;
  setGrblAccel: (x: number, y: number) => void;

  // Console
  consoleLines: Array<{ text: string; type: "sent" | "received" | "info" | "error" | "warning" }>;
  addConsoleLine: (text: string, type: "sent" | "received" | "info" | "error" | "warning") => void;
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
  previewProgress: number;
  setPreviewProgress: (p: number) => void;
  jobRunning: boolean;
  jobProgress: number;
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

  // Start corner for cut ordering
  startCorner: StartCorner;
  setStartCorner: (corner: StartCorner) => void;

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

  // Variable text generation
  generateVariableText: (config: VariableTextConfig) => Promise<void>;

  // Auto-nesting
  nestObjects: (config: NestConfig) => Promise<NestResult>;
}

let idCounter = 0;
export function generateId(): string {
  return `obj_${Date.now()}_${++idCounter}`;
}
