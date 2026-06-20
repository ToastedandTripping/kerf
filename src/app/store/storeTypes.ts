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
  objectsById: Map<string, DesignObject>;
  addObject: (obj: DesignObject) => void;
  updateObject: (id: string, partial: Partial<DesignObject>) => void;
  updateObjects: (updates: Array<{ id: string; partial: Partial<DesignObject> }>) => void;
  moveObjectsToLayer: (ids: string[], layerIndex: number) => void;
  removeObjects: (ids: string[]) => void;

  // Selection
  selectedIds: string[];
  selectedSet: Set<string>;
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
  addSubLayers: (layerIndex: number, subs: Array<Partial<SubLayer>>) => void;
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
  // F19: "door" added to handle Door:n GRBL substates ($10=0 machines)
  machineState: "idle" | "run" | "hold" | "alarm" | "door" | "disconnected";
  machinePosition: { x: number; y: number; z: number };
  grblSValueMax: number;
  grblLaserMode: boolean;
  grblAccelX: number;
  grblAccelY: number;
  setMachineConnected: (connected: boolean) => void;
  setMachineState: (state: "idle" | "run" | "hold" | "alarm" | "door" | "disconnected") => void;
  setMachinePosition: (pos: { x: number; y: number; z: number }) => void;
  setGrblSValueMax: (v: number) => void;
  setGrblLaserMode: (v: boolean) => void;
  setGrblAccel: (x: number, y: number) => void;

  // Machine limit/homing flags (read from $20/$21/$22 on connect)
  grblSoftLimits: boolean;       // $20: soft limits enabled in firmware
  grblHardLimits: boolean;       // $21: hard limits enabled in firmware
  grblHoming: boolean;           // $22: homing cycle enabled (requires limit switches)
  machineHomed: boolean;         // true after a successful homing cycle this session
  setGrblSoftLimits: (v: boolean) => void;
  setGrblHardLimits: (v: boolean) => void;
  setGrblHoming: (v: boolean) => void;
  setMachineHomed: (v: boolean) => void;

  // Work coordinate offset (WCO from GRBL status reports)
  workCoordOffset: { x: number; y: number };
  setWorkCoordOffset: (offset: { x: number; y: number }) => void;

  // Workspace verification — true only when $130/$131 were both > 0
  workspaceVerified: boolean;
  setWorkspaceVerified: (v: boolean) => void;

  // Derived: soft limits are actually active (must be checked outside selector)
  // softLimitsActive = grblSoftLimits && grblHoming && machineHomed
  // Exposed as a plain field updated by setters so selectors can read it as a primitive
  softLimitsActive: boolean;

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
  gcodeStale: boolean;
  setGcodeResult: (result: AppState["gcodeResult"]) => void;
  previewVisible: boolean;
  setPreviewVisible: (v: boolean) => void;
  jobRunning: boolean;
  jobProgress: number;
  setJobRunning: (running: boolean) => void;
  setJobProgress: (p: number) => void;
  // F18: serialBusy flag — set by the material test loop; UI paths check before sending
  serialBusy: boolean;
  setSerialBusy: (busy: boolean) => void;

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

  // Device origin: true = Y=0 at top (common for diode/CO2 lasers), false = Y=0 at bottom (standard GRBL)
  originTop: boolean;
  setOriginTop: (v: boolean) => void;

  // Project notes
  projectNotes: string;
  setProjectNotes: (notes: string) => void;

  // Smart guides
  guides: Array<{ type: "h" | "v"; pos: number }>;
  setGuides: (g: Array<{ type: "h" | "v"; pos: number }>) => void;

  // UI
  showConsole: boolean;
  setShowConsole: (v: boolean) => void;
  statusMessage: string | null;
  setStatusMessage: (msg: string | null) => void;
  // Node editing
  nodeEditState: { pathId: string | null; selectedNodeIndex: number | null };
  setNodeEditState: (state: { pathId: string | null; selectedNodeIndex: number | null }) => void;

  // Dialog state
  openDialogs: Set<string>;
  openDialog: (name: string) => void;
  closeDialog: (name: string) => void;
  // Dialog data (payloads for dialogs that need them)
  dialogData: {
    svgContent: string | null;
    pendingImage: { data: string; name: string; width: number; height: number; widthMm?: number; heightMm?: number } | null;
    ditherPreviewObjectId: string | null;
    pendingPdf: { data: ArrayBuffer; name: string } | null;
  };
  setDialogData: (data: Partial<AppState["dialogData"]>) => void;

  // Variable text generation
  generateVariableText: (config: VariableTextConfig) => Promise<void>;

  // Auto-nesting
  nestObjects: (config: NestConfig) => Promise<NestResult>;
}

let idCounter = 0;
export function generateId(): string {
  return `obj_${Date.now()}_${++idCounter}`;
}
