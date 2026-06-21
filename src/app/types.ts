// Variable Text
export interface SerialConfig {
  start: number;
  increment: number;
  count: number;
  zeroPad: number;
  prefix: string;
  suffix: string;
}

export type VariableDataSource =
  | { type: "serial"; config: SerialConfig }
  | { type: "csv"; headers: string[]; rows: string[][]; fileName: string };

export interface VariableTextConfig {
  dataSource: VariableDataSource;
  templateObjectIds: string[];  // empty = all objects with {placeholders}
}

// Auto-Nesting
export type NestRotation = "none" | "90" | "bestFit";

export interface NestConfig {
  spacing: number;        // mm gap, default 2
  rotation: NestRotation;
  useSelection: boolean;
}

export interface NestResult {
  placed: Array<{ objectId: string; x: number; y: number; rotation: number }>;
  unplaced: string[];
  efficiency: number;     // 0-1
}

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
  removeBackground?: boolean;  // default false
  bgTolerance?: number;        // 0-50, default 20
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
  // Cut ordering: parent group ID for group affinity in cut planner
  groupId?: string;
  // Variable text template marker
  isTemplate?: boolean;
}

export type CutMode = "line" | "fill" | "offsetFill" | "fillLine";
// Internal-only mode used in toCutObjects and the Rust maskFill dispatch arm.
// NOT persisted to disk — never appears in saved project files or Layer.mode.
export type InternalCutMode = CutMode | "maskFill";
export type PowerMode = "constant" | "variable"; // M3 vs M4

/** Settings for the line-outline pass in a fillLine layer.
 *  interval is intentionally excluded: line mode ignores scan interval.
 *  Do not add interval here — it would create drift vs the fill-pass interval. */
export interface LineOverlay {
  power: number;     // 0-100
  powerMin: number;  // 0-100
  speed: number;     // mm/min
  passes: number;
  powerMode: PowerMode;
}

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
  speed: number; // mm/min
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
  // Newsprint dithering parameters
  newsprintCellSize?: number; // pixels, default 6
  newsprintAngle?: number;    // degrees, default 45
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
  // Fill+Line overlay settings (fillLine mode only)
  lineOverlay?: LineOverlay;
  // Material preset tracking
  activePreset?: string; // name of applied preset, undefined = custom settings
}

export interface MaterialPreset {
  id: string;
  name: string;
  material: string; // e.g. "Plywood", "Acrylic"
  thickness: string; // e.g. "3mm", "6mm"
  mode: CutMode;
  power: number;
  powerMin: number;
  speed: number; // mm/min
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

// Fix 4: Engrave-before-cut ordering (industry convention: engrave/score first
// so pieces stay in place while being engraved, cut last to release them).
export const DEFAULT_LAYERS: Layer[] = [
  { index: 0, name: "Engrave", color: "#e24a4a", mode: "fill", power: 50, speed: 6000, passes: 1, ...layerDefaults, airAssist: false },
  { index: 1, name: "Score", color: "#4ae28a", mode: "line", power: 30, speed: 3000, passes: 1, ...layerDefaults },
  { index: 2, name: "Cut", color: "#4a90e2", mode: "line", power: 100, speed: 1200, passes: 1, ...layerDefaults },
  { index: 3, name: "Custom 4", color: "#ff8000", mode: "line", power: 100, speed: 1200, passes: 1, ...layerDefaults },
  { index: 4, name: "Custom 5", color: "#e2e24a", mode: "line", power: 100, speed: 1200, passes: 1, ...layerDefaults },
  { index: 5, name: "Custom 6", color: "#4ae2e2", mode: "line", power: 100, speed: 1200, passes: 1, ...layerDefaults },
];

export type StartCorner = "bottomLeft" | "bottomRight" | "topLeft" | "topRight" | "center";

/**
 * Data-convention version of saved project/recovery files.
 *
 * undefined (absent) = legacy v0: geometry migrations run (flip bake, then
 *   points/transform sync + group-local re-base). Pre-W1b binaries.
 *
 * 1 = post-W1b geometry fix. Layer speeds stored in mm/s (old unit). Forward-
 *   incompat vs pre-W1b binaries (children render wrong).
 *
 * 2 = speed unit mm/s → mm/min. Load-time migration ×60 all speed fields.
 *   Forward-incompat vs v1 binaries: a v2 file re-read by a pre-switch binary
 *   would treat 1200 as 1200 mm/s (60× too fast — fire risk).
 *   BACKUP: the first save over a migrating file writes a .bak sibling.
 *
 * 3 = sub-layers removed; first-class fillLine mode added. Load-time migration
 *   converts Layer.subLayers[] → Layer.mode="fillLine" + Layer.lineOverlay.
 *   Forward-incompat vs v2 binaries: a v3 file won't open correctly in a v2
 *   binary (unknown mode "fillLine"). BACKUP: written whenever any migration
 *   runs (gate is < KERF_FORMAT_VERSION, not < 2).
 */
export const KERF_FORMAT_VERSION = 3;

export interface KerfProject {
  version: string;
  formatVersion?: number;
  name: string;
  objects: DesignObject[];
  layers: Layer[];
  camera: CameraState;
  workspaceWidth: number;
  workspaceHeight: number;
  notes?: string;
  materials?: MaterialPreset[];
  startCorner?: StartCorner;
  originTop?: boolean;
}
