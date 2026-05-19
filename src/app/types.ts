export type ToolType =
  | "select"
  | "rectangle"
  | "ellipse"
  | "line"
  | "pen"
  | "text"
  | "node"
  | "positionLaser";

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

export interface ImageAdjustments {
  brightness: number;  // -100 to 100, default 0
  contrast: number;    // -100 to 100, default 0
  gamma: number;       // 0.1 to 5.0, default 1.0
  invert: boolean;     // default false
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
  powerScale?: number; // 0-1, multiplier against layer power (default 1.0)
  // Type-specific
  cornerRadius?: number; // rectangle
  points?: PathPoint[]; // path / line
  closed?: boolean; // path
  text?: string; // text
  fontSize?: number; // text
  fontFamily?: string; // text
  // Image
  imageData?: string; // base64
  imageAdjustments?: ImageAdjustments; // image
  // Cut ordering
  priority?: number; // 0-99, higher = cut first, default 0
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
  output: boolean;
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
  dither: "threshold" | "ordered" | "floydSteinberg" | "jarvis" | "stucki" | "grayscale" | "newsprint";
  // Power curve: user-defined transfer function (input shade 0-255 → output power 0-100%)
  powerCurve?: Array<{ x: number; y: number }>;
  // Fill ordering
  fillOrder?: "sequential" | "flood"; // default "sequential"
  // Scan direction
  scanAngle: number; // degrees, 0 = horizontal
  angleIncrement: number; // degrees added per pass (0 = same angle every pass)
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
  // Precision cutting
  kerfOffset: number; // mm - positive = outward, negative = inward, 0 = none
  perforationCut: number; // mm - length of each cut segment, 0 = disabled
  perforationSkip: number; // mm - length of each skip segment
  // Sub-layers (Fill+Line workflows)
  subLayers?: SubLayer[];
}

export interface SubLayer {
  id: string;
  mode: CutMode;
  power: number;
  powerMin: number;
  speed: number;
  passes: number;
  powerMode: PowerMode;
  interval: number;
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
  visible: true, locked: false, output: true, powerMin: 0, powerMode: "constant" as PowerMode,
  interval: 0.1, airAssist: true, cutInnerFirst: true, dither: "floydSteinberg" as const,
  scanAngle: 0, angleIncrement: 0,
  overcut: 0, leadIn: 0, leadOut: 0, overscan: 2.5, bidirectional: true,
  crossHatch: false, scanningOffset: 0, tabSpacing: 0, tabWidth: 2,
  kerfOffset: 0, perforationCut: 0, perforationSkip: 0,
};

export const DEFAULT_LAYERS: Layer[] = [
  { index: 0, name: "Cut", color: "#4a90e2", mode: "line", power: 100, speed: 20, passes: 1, ...layerDefaults },
  { index: 1, name: "Engrave", color: "#e24a4a", mode: "fill", power: 50, speed: 100, passes: 1, ...layerDefaults, airAssist: false },
  { index: 2, name: "Score", color: "#4ae28a", mode: "line", power: 30, speed: 50, passes: 1, ...layerDefaults },
  { index: 3, name: "Layer 3", color: "#ff8000", mode: "line", power: 100, speed: 20, passes: 1, ...layerDefaults },
  { index: 4, name: "Layer 4", color: "#e2e24a", mode: "line", power: 100, speed: 20, passes: 1, ...layerDefaults },
  { index: 5, name: "Layer 5", color: "#4ae2e2", mode: "line", power: 100, speed: 20, passes: 1, ...layerDefaults },
];

export type StartCorner = "bottomLeft" | "bottomRight" | "topLeft" | "topRight" | "center";

export interface KerfProject {
  version: string;
  name: string;
  objects: DesignObject[];
  layers: Layer[];
  camera: CameraState;
  workspaceWidth: number;
  workspaceHeight: number;
  notes?: string;
  materials?: MaterialPreset[];
  startCorner?: StartCorner;
}
