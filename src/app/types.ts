export type ToolType =
  | "select"
  | "rectangle"
  | "ellipse"
  | "line"
  | "pen"
  | "text"
  | "node"
  | "measure";

export type ObjectType = "rectangle" | "ellipse" | "line" | "path" | "text" | "group" | "image";

export interface Transform {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // degrees
  scaleX: number;
  scaleY: number;
}

export interface PathPoint {
  x: number;
  y: number;
  handleIn?: { x: number; y: number };
  handleOut?: { x: number; y: number };
}

export interface DesignObject {
  id: string;
  type: ObjectType;
  name: string;
  transform: Transform;
  layerIndex: number;
  visible: boolean;
  locked: boolean;
  fill: string | null;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  // Type-specific
  cornerRadius?: number; // rectangle
  points?: PathPoint[]; // path / line
  closed?: boolean; // path
  text?: string; // text
  fontSize?: number; // text
  fontFamily?: string; // text
  // Image
  imageData?: string; // base64
  // Group
  children?: DesignObject[]; // group
}

export type CutMode = "line" | "fill" | "offsetFill";
export type PowerMode = "constant" | "variable"; // M3 vs M4

export interface Layer {
  index: number;
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
  // Cut settings
  mode: CutMode;
  power: number; // 0-100 max power
  powerMin: number; // 0-100 min power (for variable/grayscale)
  speed: number; // mm/s
  passes: number;
  powerMode: PowerMode;
  interval: number; // mm - line interval for fill mode
  airAssist: boolean;
  // Cut optimization
  cutInnerFirst: boolean;
  // Image engraving
  dither: "threshold" | "ordered" | "floydSteinberg" | "jarvis" | "stucki" | "grayscale";
  // Advanced cut settings (Phase G)
  overcut: number; // mm - extend past start point
  leadIn: number; // mm - lead-in distance
  leadOut: number; // mm - lead-out distance
  overscan: number; // mm - overscan for fill mode
  bidirectional: boolean; // bidirectional fill scanning
  crossHatch: boolean; // cross-hatch fill (scan both X and Y)
  scanningOffset: number; // mm - laser response delay compensation
  tabSpacing: number; // mm - 0 = no tabs, >0 = spacing between tabs
  tabWidth: number; // mm - width of each tab
}

export interface MaterialPreset {
  id: string;
  name: string;
  material: string; // e.g. "Plywood", "Acrylic"
  thickness: string; // e.g. "3mm", "6mm"
  mode: CutMode;
  power: number;
  powerMin: number;
  speed: number;
  passes: number;
  airAssist: boolean;
  interval: number;
}

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

const layerDefaults = {
  visible: true, locked: false, powerMin: 0, powerMode: "constant" as PowerMode,
  interval: 0.1, airAssist: true, cutInnerFirst: true, dither: "floydSteinberg" as const,
  overcut: 0, leadIn: 0, leadOut: 0, overscan: 2.5, bidirectional: true,
  crossHatch: false, scanningOffset: 0, tabSpacing: 0, tabWidth: 2,
};

export const DEFAULT_LAYERS: Layer[] = [
  { index: 0, name: "Cut", color: "#4a90e2", mode: "line", power: 100, speed: 20, passes: 1, ...layerDefaults },
  { index: 1, name: "Engrave", color: "#e24a4a", mode: "fill", power: 50, speed: 100, passes: 1, ...layerDefaults, airAssist: false },
  { index: 2, name: "Score", color: "#4ae28a", mode: "line", power: 30, speed: 50, passes: 1, ...layerDefaults },
  { index: 3, name: "Layer 3", color: "#ff8000", mode: "line", power: 100, speed: 20, passes: 1, ...layerDefaults },
  { index: 4, name: "Layer 4", color: "#e2e24a", mode: "line", power: 100, speed: 20, passes: 1, ...layerDefaults },
  { index: 5, name: "Layer 5", color: "#4ae2e2", mode: "line", power: 100, speed: 20, passes: 1, ...layerDefaults },
];

export interface KerfProject {
  version: string;
  name: string;
  objects: DesignObject[];
  layers: Layer[];
  camera: CameraState;
  workspaceWidth: number;
  workspaceHeight: number;
  notes?: string;
}
