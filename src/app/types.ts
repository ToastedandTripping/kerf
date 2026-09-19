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
  templateObjectIds: string[]; // empty = all objects with {placeholders}
}

// Auto-Nesting
export type NestRotation = "none" | "90" | "bestFit";

export interface NestConfig {
  spacing: number; // mm gap, default 2
  rotation: NestRotation;
  useSelection: boolean;
}

export interface NestResult {
  placed: Array<{ objectId: string; x: number; y: number; rotation: number }>;
  unplaced: string[];
  efficiency: number; // 0-1
}

export type ToolType =
  | "select"
  | "rectangle"
  | "ellipse"
  | "line"
  | "pen"
  | "text"
  | "node"
  | "positionLaser"
  | "measure"
  | "pan";

type ObjectType = "rectangle" | "ellipse" | "line" | "path" | "text" | "group" | "image";

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
  brightness: number; // -100 to 100, default 0
  contrast: number; // -100 to 100, default 0
  gamma: number; // 0.1 to 5.0, default 1.0
  invert: boolean; // default false
  removeBackground?: boolean; // default false
  bgTolerance?: number; // 0-50, default 20
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
  textAlign?: "left" | "center" | "right"; // text
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

/** W4 — minimum power can never exceed commanded power.
 *
 *  `power` and `power_min` clamp independently to 0-100 and nothing cross-clamps
 *  them. Under constant power that was inert; under variable power the s_min
 *  floor makes it live, so `power: 40, powerMin: 60` commands more than the
 *  number in the operator's Power box.
 *
 *  The generation-side enforcement is `clamp_power_min` in
 *  src-tauri/src/engine/gcode_gen.rs, and it is the authority for what the
 *  MACHINE receives. This one exists because that enforcement does not travel
 *  with the document: a file written with the invalid pair intact is read by
 *  whatever build opens it next, including a shipped build that has no clamp.
 *  So the pair is corrected before it can be written, not only before it is cut.
 */
export function clampPowerMin(power: number, powerMin: number): number {
  if (!Number.isFinite(power) || !Number.isFinite(powerMin)) return 0;
  return Math.max(0, Math.min(power, powerMin));
}

/** Settings for the line-outline pass in a fillLine layer.
 *  interval is intentionally excluded: line mode ignores scan interval.
 *  Do not add interval here — it would create drift vs the fill-pass interval. */
export interface LineOverlay {
  power: number; // 0-100
  powerMin: number; // 0-100
  speed: number; // mm/min
  passes: number;
  powerMode: PowerMode;
}

/** The single source of truth for a line overlay that has not been configured yet.
 *  Duplicated literals here previously lived in three places (the store's
 *  updateLineOverlay, the LayerPanel fallback, and gcodeGen's
 *  buildLineOverlayCutLayer). If the UI fallback and the generation fallback ever
 *  disagree, the operator sees one power mode and the machine receives another —
 *  so they share this constant instead.
 *
 *  NOTE: this is the default for NEW overlays only. The loader/importer in
 *  src/lib/fileOps deliberately falls back to "constant" for files that predate
 *  the variable-power default; see the comments there. */
export const LINE_OVERLAY_DEFAULTS: LineOverlay = {
  power: 100,
  powerMin: 0,
  speed: 1200,
  passes: 1,
  powerMode: "variable",
};

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
  dither:
    | "threshold"
    | "ordered"
    | "floydSteinberg"
    | "jarvis"
    | "stucki"
    | "grayscale"
    | "newsprint";
  // Power curve: user-defined transfer function (input shade 0-255 → output power 0-100%)
  powerCurve?: Array<{ x: number; y: number }>;
  // Newsprint dithering parameters
  newsprintCellSize?: number; // pixels, default 6
  newsprintAngle?: number; // degrees, default 45
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
  visible: true,
  locked: false,
  output: true,
  powerMin: 0,
  powerMode: "variable" as PowerMode,
  interval: 0.1,
  airAssist: true,
  cutInnerFirst: true,
  dither: "floydSteinberg" as const,
  scanAngle: 0,
  angleIncrement: 0,
  // Overscan default: 0.5 mm user minimum for newly created layers.
  // At generation time, max(user, kinematic minimum) is applied — the kinematic
  // rule (1.2 * v²/(2*a)) overrides when the layer speed demands more. The low
  // default lets new low-speed jobs benefit without a manual reduction; existing
  // saved projects keep their stored value. See computeOverscan() in overscan.ts.
  overcut: 0,
  leadIn: 0,
  leadOut: 0,
  overscan: 0.5,
  bidirectional: true,
  crossHatch: false,
  scanningOffset: 0,
  tabSpacing: 0,
  tabWidth: 2,
  kerfOffset: 0,
  perforationCut: 0,
  perforationSkip: 0,
};

// Fix 4: Engrave-before-cut ordering (industry convention: engrave/score first
// so pieces stay in place while being engraved, cut last to release them).
//
// Power mode: BOTH fill and line layers default to "variable" (M4) so GRBL
// scales laser power with the actual feed rate through acceleration and
// deceleration. Constant power (M3) holds the commanded watts regardless of
// head velocity, so every corner and direction change is over-exposed — the
// same energy landing on less travel. M4 keeps energy per millimetre roughly
// flat, and emits nothing while the head is stationary.
// Constant power remains selectable per layer; only the default changed.
// Saved projects carry their stored powerMode; this default only affects new layers.
export const DEFAULT_LAYERS: Layer[] = [
  {
    index: 0,
    name: "Engrave",
    color: "#e24a4a",
    mode: "fill",
    power: 50,
    speed: 6000,
    passes: 1,
    ...layerDefaults,
    airAssist: false,
    powerMode: "variable" as PowerMode,
  },
  {
    index: 1,
    name: "Score",
    color: "#4ae28a",
    mode: "line",
    power: 30,
    speed: 3000,
    passes: 1,
    ...layerDefaults,
  },
  {
    index: 2,
    name: "Cut",
    color: "#4a90e2",
    mode: "line",
    power: 100,
    speed: 1200,
    passes: 1,
    ...layerDefaults,
  },
  {
    index: 3,
    name: "Custom 4",
    color: "#ff8000",
    mode: "line",
    power: 100,
    speed: 1200,
    passes: 1,
    ...layerDefaults,
  },
  {
    index: 4,
    name: "Custom 5",
    color: "#e2e24a",
    mode: "line",
    power: 100,
    speed: 1200,
    passes: 1,
    ...layerDefaults,
  },
  {
    index: 5,
    name: "Custom 6",
    color: "#4ae2e2",
    mode: "line",
    power: 100,
    speed: 1200,
    passes: 1,
    ...layerDefaults,
  },
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
 *
 * 4 = fillLine layers always carry an explicit `lineOverlay` on save.
 *   No geometry or unit change, and no load-time migration of its own — the
 *   bump exists to make an ABSENCE unambiguous. Through v3, a missing
 *   `lineOverlay` could mean either "saved before the M4 default flip, cut as
 *   M3" or "saved after it, cut as M4, panel never opened". The loader must
 *   stamp the first as constant and must NOT touch the second, and it cannot
 *   tell them apart without this version. v3-and-below: materialise constant.
 *   v4: the file states its own mode, by construction.
 *   Backward-compatible with v3 binaries (an extra explicit key they already
 *   understand). BACKUP: a v3 file now trips the < KERF_FORMAT_VERSION gate on
 *   load and gains a .bak on first save over it — intended, since the load
 *   does rewrite its power modes.
 */
export const KERF_FORMAT_VERSION = 4;

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
