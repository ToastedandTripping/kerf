import { useStore } from "../../app/store";
import type { DesignObject, KerfProject, Layer, MaterialPreset, LineOverlay } from "../../app/types";
import { DEFAULT_LAYERS, KERF_FORMAT_VERSION } from "../../app/types";
import { pointsBBox, rotatePathPoint, POINTS_EPSILON } from "../geometry";
import { DEFAULT_MATERIALS } from "../materials";
import { addRecentFile } from "../recentFiles";
import { clearRecoveryFile } from "../autoSave";
import { importDxfDirect } from "./dxfImport";
import { importImageData } from "./imageImport";
import { exportSvgContent } from "./svgExport";

export { parsePathD } from "./svgImport";
export { importDxfDirect } from "./dxfImport";

type TauriDialogPath = string | { path: string };
function resolvePath(path: TauriDialogPath): string {
  return typeof path === "string" ? path : path.path;
}

let dialogModule: typeof import("@tauri-apps/plugin-dialog") | null = null;
let fsModule: typeof import("@tauri-apps/plugin-fs") | null = null;

// Tracks original file content after a migrating load so saveToPath can write
// a .bak sibling before overwriting. Cleared after first use.
let _pendingBakContent: string | null = null;
let _pendingBakPath: string | null = null;

async function ensureTauri() {
  if (dialogModule && fsModule) return true;
  try {
    dialogModule = await import("@tauri-apps/plugin-dialog");
    fsModule = await import("@tauri-apps/plugin-fs");
    return true;
  } catch {
    return false;
  }
}

async function checkUnsavedChanges(): Promise<boolean> {
  const store = useStore.getState();
  if (!store.isDirty) return true;

  const hasTauri = await ensureTauri();
  if (!hasTauri || !dialogModule) return true;

  const result = await dialogModule.message(
    `Save changes to "${store.projectName}"?`,
    {
      title: "Unsaved Changes",
      kind: "warning",
      buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
    }
  );

  if (result === "Cancel") return false;

  if (result === "Yes" || result === "Save") {
    const saved = await fileOperations.saveProject();
    // If save failed, abort the destructive New/Open — unsaved work would be lost
    if (!saved) return false;
  }

  return true;
}

/**
 * THE single project-load entry point (W1b). Applies all geometry migrations,
 * stamps the format version, and hands off to store.loadProject. EVERY loader
 * — openProject, openRecentFile, the crash-recovery restore (App.tsx), and
 * newProject — must route through here; no code path may call
 * store.loadProject directly. The wrapper boundary is migrate → loadProject
 * ONLY: per-caller bookkeeping (setProjectPath, addRecentFile, unsaved-changes
 * checks) stays at the call sites.
 *
 * Migration ORDER is load-bearing — flip FIRST, then transform-sync:
 * migrateFlipTransforms bakes legacy negative scales into points, reproducing
 * what the current binary RENDERS; the transform-sync then derives bboxes from
 * those final points. Reversed, the sync would snapshot pre-bake points and
 * the flip bake would desync them again.
 *
 * This is the ONE permitted in-place mutation context (fresh-parsed JSON,
 * pre-store — nothing aliases it yet). The purity mandate applies to
 * everything post-store.
 *
 * NOTE: the first save after a migrating load overwrites the original file in
 * the new convention, and the rot≠0 desync repair bakes the rotation FIELD to
 * 0 (a user's 45° reads 0° afterwards — visually exact, lossy on the field).
 */
export function loadProjectWithMigrations(project: KerfProject): void {
  const v = project.formatVersion; // undefined => legacy v0
  if (v === undefined || v < 1) {  // geometry: ONLY legacy v0 files
    migrateFlipTransforms(project.objects);
    migratePointsTransformSync(project.objects, 0, 0);
  }
  if (v === undefined || v < 2) {  // speed mm/s → mm/min
    migrateSpeedToMmMin(project);
  }
  if (v === undefined || v < 3) {  // sub-layers → fillLine
    migrateSubLayersToFillLine(project);
  }
  // Stamp AFTER migration completes successfully; a throw leaves version
  // unstamped so the file re-migrates on next load (never seal over partial state).
  project.formatVersion = KERF_FORMAT_VERSION;
  useStore.getState().loadProject(project);
}

export const fileOperations = {
  async newProject() {
    const canProceed = await checkUnsavedChanges();
    if (!canProceed) return;

    // Fresh empty literal: the migrations are no-ops, but newProject routes
    // through the wrapper anyway — the no-exceptions rule is the point.
    loadProjectWithMigrations({
      version: "0.1.0",
      name: "Untitled",
      objects: [],
      layers: DEFAULT_LAYERS,
      camera: { x: 0, y: 0, zoom: 1 },
      workspaceWidth: 500,
      workspaceHeight: 300,
      notes: "",
      materials: DEFAULT_MATERIALS,
    });
    useStore.getState().setProjectPath(null);
  },

  async openProject() {
    const canProceed = await checkUnsavedChanges();
    if (!canProceed) return;

    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.open({
        filters: [
          { name: "Kerf Project", extensions: ["kerf"] },
          { name: "SVG", extensions: ["svg"] },
          { name: "DXF", extensions: ["dxf"] },
          { name: "PDF", extensions: ["pdf"] },
          { name: "Images", extensions: ["png", "jpg", "jpeg", "bmp", "gif", "webp"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (!path) return;
      const pathStr = resolvePath(path);
      const ext = pathStr.split(".").pop()?.toLowerCase() || "";
      if (ext === "svg") {
        const content = await fsModule.readTextFile(pathStr);
        const { openSvgImport } = await import("../../app/App");
        openSvgImport(content);
      } else if (ext === "dxf") {
        const content = await fsModule.readTextFile(pathStr);
        importDxfDirect(content);
      } else if (ext === "pdf") {
        const data = await fsModule.readFile(pathStr);
        const { pdfBytesToArrayBuffer } = await import("./pdfImport");
        const { openPdfImport } = await import("../../app/App");
        const arrayBuffer = pdfBytesToArrayBuffer(data);
        const fileName = pathStr.split("/").pop() || "document.pdf";
        openPdfImport(arrayBuffer, fileName);
      } else if (["png", "jpg", "jpeg", "bmp", "gif", "webp"].includes(ext)) {
        const data = await fsModule.readFile(pathStr);
        importImageData(data, ext);
      } else {
        const content = await fsModule.readTextFile(pathStr);
        // F26: surface corrupt file errors clearly
        let project: KerfProject;
        try {
          project = JSON.parse(content) as KerfProject;
        } catch {
          const store = useStore.getState();
          store.setStatusMessage("Project file is corrupted and could not be loaded");
          store.addConsoleLine(`Failed to load "${pathStr}": file is corrupted or not a valid Kerf project`, "error");
          return;
        }
        // Track original content for .bak if any migration will run
        if (project.formatVersion === undefined || project.formatVersion < KERF_FORMAT_VERSION) {
          _pendingBakContent = content;
          _pendingBakPath = pathStr;
        }
        loadProjectWithMigrations(project);
        useStore.getState().setProjectPath(pathStr);
        addRecentFile(pathStr);
      }
    }
  },

  async saveProject(): Promise<boolean> {
    const store = useStore.getState();
    if (store.projectPath) {
      const ok = await saveToPath(store.projectPath);
      if (ok) {
        addRecentFile(store.projectPath);
        clearRecoveryFile();
      }
      return ok;
    } else {
      return fileOperations.saveProjectAs();
    }
  },

  async saveProjectAs(): Promise<boolean> {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.save({
        filters: [{ name: "Kerf Project", extensions: ["kerf"] }],
        defaultPath: `${useStore.getState().projectName}.kerf`,
      });
      if (!path) return false;
      const pathStr = typeof path === "string" ? path : String(path);
      const ok = await saveToPath(pathStr);
      if (ok) {
        useStore.getState().setProjectPath(pathStr);
        addRecentFile(pathStr);
        clearRecoveryFile();
        const name = pathStr.split("/").pop()?.replace(".kerf", "") || "Untitled";
        useStore.getState().setProjectName(name);
      }
      return ok;
    }
    return false;
  },

  async openRecentFile(filePath: string) {
    // F26: check for unsaved changes before discarding current project
    const canProceed = await checkUnsavedChanges();
    if (!canProceed) return;

    const hasTauri = await ensureTauri();
    if (!hasTauri || !fsModule) return;
    try {
      const content = await fsModule.readTextFile(filePath);
      // F26: wrap JSON.parse in try/catch — surface corrupt file errors instead of
      // letting them throw uncaught or silently fall through to an empty state.
      let project: KerfProject;
      try {
        project = JSON.parse(content) as KerfProject;
      } catch {
        const store = useStore.getState();
        store.setStatusMessage("Project file is corrupted and could not be loaded");
        store.addConsoleLine(`Failed to load "${filePath}": file is corrupted or not a valid Kerf project`, "error");
        return;
      }
      // Track original content for .bak if any migration will run
      if (project.formatVersion === undefined || project.formatVersion < KERF_FORMAT_VERSION) {
        _pendingBakContent = content;
        _pendingBakPath = filePath;
      }
      loadProjectWithMigrations(project);
      useStore.getState().setProjectPath(filePath);
      addRecentFile(filePath);
    } catch (e) {
      console.error("Failed to open recent file:", e);
      useStore.getState().addConsoleLine(`Failed to open recent file: ${e}`, "error");
    }
  },

  async importSvg() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.open({
        filters: [{ name: "SVG", extensions: ["svg"] }],
      });
      if (!path) return;
      const pathStr = resolvePath(path);
      const content = await fsModule.readTextFile(pathStr);
      const { openSvgImport } = await import("../../app/App");
      openSvgImport(content);
    }
  },

  async exportSvg() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.save({
        filters: [{ name: "SVG", extensions: ["svg"] }],
        defaultPath: `${useStore.getState().projectName}.svg`,
      });
      if (!path) return;
      const pathStr = typeof path === "string" ? path : String(path);
      const svg = exportSvgContent();
      try {
        await fsModule.writeTextFile(pathStr, svg);
        useStore.getState().addConsoleLine(`SVG exported: ${pathStr}`, "info");
      } catch (e) {
        const store = useStore.getState();
        store.setStatusMessage("SVG export failed — check permissions or disk space");
        store.addConsoleLine(`SVG export failed for "${pathStr}": ${e}`, "error");
      }
    }
  },

  async importDxf() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.open({
        filters: [{ name: "DXF", extensions: ["dxf"] }],
      });
      if (!path) return;
      const pathStr = resolvePath(path);
      const content = await fsModule.readTextFile(pathStr);
      importDxfDirect(content);
    }
  },

  async importPdf() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.open({
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!path) return;
      const pathStr = resolvePath(path);
      const data = await fsModule.readFile(pathStr);
      const { pdfBytesToArrayBuffer } = await import("./pdfImport");
      const { openPdfImport } = await import("../../app/App");
      const arrayBuffer = pdfBytesToArrayBuffer(data);
      const fileName = pathStr.split("/").pop() || "document.pdf";
      openPdfImport(arrayBuffer, fileName);
    }
  },

  async importImage() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.open({
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "bmp", "gif", "webp"] }],
      });
      if (!path) return;
      const pathStr = resolvePath(path);
      const ext = pathStr.split(".").pop()?.toLowerCase() || "png";
      const data = await fsModule.readFile(pathStr);
      importImageData(data, ext);
    }
  },

  async exportGcode() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const store = useStore.getState();
      if (!store.gcodeResult) {
        store.addConsoleLine("Generate G-code first before exporting", "error");
        return;
      }
      const path = await dialogModule.save({
        filters: [{ name: "G-code", extensions: ["gcode", "gc", "nc"] }],
        defaultPath: `${store.projectName}.gcode`,
      });
      if (!path) return;
      const pathStr = typeof path === "string" ? path : String(path);
      try {
        await fsModule.writeTextFile(pathStr, store.gcodeResult.gcode);
        store.addConsoleLine(`G-code exported: ${pathStr}`, "info");
      } catch (e) {
        store.setStatusMessage("G-code export failed — check permissions or disk space");
        store.addConsoleLine(`G-code export failed for "${pathStr}": ${e}`, "error");
      }
    }
  },
};

async function saveToPath(path: string): Promise<boolean> {
  const hasTauri = await ensureTauri();
  if (!hasTauri || !fsModule) return false;
  // Write .bak before overwriting if this path has a pending backup from migration
  if (_pendingBakPath === path && _pendingBakContent !== null) {
    const content = _pendingBakContent;
    _pendingBakContent = null;
    _pendingBakPath = null;
    await writeBakIfMissing(path, content);
  }
  const project = useStore.getState().toProject();
  try {
    await fsModule.writeTextFile(path, JSON.stringify(project, null, 2));
    useStore.getState().setDirty(false);
    return true;
  } catch (e) {
    const store = useStore.getState();
    store.setStatusMessage("Save failed — check permissions or disk space");
    store.addConsoleLine(`Save failed for "${path}": ${e}`, "error");
    // Do NOT setDirty(false) — the project is still unsaved
    return false;
  }
}

/**
 * Speed-unit migration (v1 → v2): multiply all stored speed fields by 60
 * to convert the legacy mm/s convention to the canonical mm/min unit.
 *
 * ATOMICITY: each field is guarded by `typeof === "number"` before mutation,
 * and all array access is optional-chained so this helper CANNOT throw under
 * any well-typed input. The formatVersion stamp in the caller is written only
 * after this function returns normally; an unexpected throw therefore leaves
 * the version unstamped and the file re-migrates on next load (never seals
 * v2 over a half-converted state).
 *
 * NOTE: exported materials (.json without a version wrapper) are NOT covered
 * by this migration — they have no formatVersion. A pre-switch exported file
 * re-imported after this release will have its speeds treated as mm/min
 * already (which will be 60× too slow). Users should re-export presets after
 * upgrading. In-project materials[] ARE migrated via this gate.
 */
export function migrateSpeedToMmMin(project: KerfProject): void {
  // Migrate layers and (legacy) sub-layers — sub-layers are a v2 concept removed
  // in v3, but the v2→v3 migration has not run yet at this point in the load
  // sequence, so we must still handle subLayers here.
  if (Array.isArray(project.layers)) {
    for (const layer of project.layers) {
      if (typeof (layer as Layer).speed === "number") {
        (layer as Layer).speed *= 60;
      }
      const legacyLayer = layer as Layer & { subLayers?: Array<{ speed?: number }> };
      if (Array.isArray(legacyLayer.subLayers)) {
        for (const sub of legacyLayer.subLayers) {
          if (typeof sub.speed === "number") {
            sub.speed *= 60;
          }
        }
      }
    }
  }
  // Migrate in-project material presets
  if (Array.isArray(project.materials)) {
    for (const mat of project.materials) {
      if (typeof (mat as MaterialPreset).speed === "number") {
        (mat as MaterialPreset).speed *= 60;
      }
    }
  }
}

/**
 * Sub-layer migration (v2 → v3): convert Layer.subLayers[] into the new
 * first-class fillLine mode + LineOverlay model.
 *
 * Per layer with subLayers:
 *  - Clean fill+line (exactly one fill-ish sub + one line sub, any order):
 *    → layer.mode = "fillLine"; copy fill-sub settings onto layer fill fields;
 *      set layer.lineOverlay from the line sub.
 *  - Single sub:
 *    → flatten — copy its settings onto the layer, set layer.mode = sub.mode.
 *  - Pathological 3+ / two-fills / two-lines (UI-reachable via addSubLayer):
 *    → collapse to fillLine using first fill-ish sub + first line sub;
 *      console.warn a loud one-time notice. Recoverable via .bak (must-fix #1).
 *
 * ATOMICITY: per-layer try/catch — a malformed layer logs and passes through.
 * Version stamp in the caller is written only after this returns normally.
 */
export function migrateSubLayersToFillLine(project: KerfProject): void {
  if (!Array.isArray(project.layers)) return;

  for (const layer of project.layers) {
    try {
      const l = layer as Layer & { subLayers?: Array<{ id?: string; mode?: string; power?: number; powerMin?: number; speed?: number; passes?: number; powerMode?: string; interval?: number }> };
      if (!Array.isArray(l.subLayers) || l.subLayers.length === 0) continue;

      const subs = l.subLayers;
      const isFillIsh = (m?: string) => m === "fill" || m === "offsetFill";
      const fillSubs = subs.filter((s) => isFillIsh(s.mode));
      const lineSubs = subs.filter((s) => s.mode === "line");

      if (subs.length === 1) {
        // Single sub: flatten onto layer
        const sub = subs[0];
        if (typeof sub.mode === "string") l.mode = sub.mode as import("../../app/types").CutMode;
        if (typeof sub.power === "number") l.power = sub.power;
        if (typeof sub.powerMin === "number") l.powerMin = sub.powerMin;
        if (typeof sub.speed === "number") l.speed = sub.speed;
        if (typeof sub.passes === "number") l.passes = sub.passes;
        if (typeof sub.powerMode === "string") l.powerMode = sub.powerMode as import("../../app/types").PowerMode;
        if (typeof sub.interval === "number") l.interval = sub.interval;
      } else if (fillSubs.length === 1 && lineSubs.length === 1) {
        // Clean fill+line: convert to fillLine
        const fillSub = fillSubs[0];
        const lineSub = lineSubs[0];
        l.mode = "fillLine";
        if (typeof fillSub.power === "number") l.power = fillSub.power;
        if (typeof fillSub.powerMin === "number") l.powerMin = fillSub.powerMin;
        if (typeof fillSub.speed === "number") l.speed = fillSub.speed;
        if (typeof fillSub.passes === "number") l.passes = fillSub.passes;
        if (typeof fillSub.powerMode === "string") l.powerMode = fillSub.powerMode as import("../../app/types").PowerMode;
        if (typeof fillSub.interval === "number") l.interval = fillSub.interval;
        const overlay: LineOverlay = {
          power: typeof lineSub.power === "number" ? lineSub.power : 100,
          powerMin: typeof lineSub.powerMin === "number" ? lineSub.powerMin : 0,
          speed: typeof lineSub.speed === "number" ? lineSub.speed : 1200,
          passes: typeof lineSub.passes === "number" ? lineSub.passes : 1,
          powerMode: (typeof lineSub.powerMode === "string" ? lineSub.powerMode : "constant") as import("../../app/types").PowerMode,
        };
        l.lineOverlay = overlay;
      } else {
        // Pathological: 3+ subs, two fills, two lines, etc.
        // Collapse to fillLine using first fill-ish + first line sub; warn loudly.
        const fillSub = fillSubs[0];
        const lineSub = lineSubs[0];
        console.warn(
          `[Kerf migration v3] Layer "${l.name}" had ${subs.length} sub-layers (${subs.map((s) => s.mode).join(", ")}) — ` +
          "collapsed to fillLine using first fill-ish + first line sub. Extra passes lost. " +
          "A .bak backup was written before this save — restore it to recover.",
        );
        l.mode = "fillLine";
        if (fillSub) {
          if (typeof fillSub.power === "number") l.power = fillSub.power;
          if (typeof fillSub.powerMin === "number") l.powerMin = fillSub.powerMin;
          if (typeof fillSub.speed === "number") l.speed = fillSub.speed;
          if (typeof fillSub.passes === "number") l.passes = fillSub.passes;
          if (typeof fillSub.powerMode === "string") l.powerMode = fillSub.powerMode as import("../../app/types").PowerMode;
          if (typeof fillSub.interval === "number") l.interval = fillSub.interval;
        }
        const overlay: LineOverlay = {
          power: lineSub && typeof lineSub.power === "number" ? lineSub.power : 100,
          powerMin: lineSub && typeof lineSub.powerMin === "number" ? lineSub.powerMin : 0,
          speed: lineSub && typeof lineSub.speed === "number" ? lineSub.speed : 1200,
          passes: lineSub && typeof lineSub.passes === "number" ? lineSub.passes : 1,
          powerMode: (lineSub && typeof lineSub.powerMode === "string" ? lineSub.powerMode : "constant") as import("../../app/types").PowerMode,
        };
        l.lineOverlay = overlay;
      }

      delete l.subLayers;
    } catch (e) {
      console.error("Kerf migration v3: skipping malformed layer", (layer as { name?: string } | null)?.name, e);
    }
  }
}

/**
 * Write a one-time .bak sibling of the original file on the first save
 * after a migrating load. Called from saveToPath when migration occurred.
 * Silently skips if the .bak already exists or on any fs error.
 */
async function writeBakIfMissing(originalPath: string, content: string): Promise<void> {
  if (!fsModule) return;
  const bakPath = `${originalPath}.bak`;
  try {
    // Check existence: readTextFile throws if missing, which is what we want
    await fsModule.readTextFile(bakPath);
    // .bak exists — do nothing
  } catch {
    // .bak does not exist — write it
    try {
      await fsModule.writeTextFile(bakPath, content);
    } catch (e) {
      // Best-effort; do not toast (non-critical), but log so it's diagnosable
      console.warn(`[Kerf] Failed to write .bak for "${originalPath}":`, e);
    }
  }
}

/**
 * W1b migration: repair the points/transform desync in legacy files and
 * convert group-child points from the old world-absolute convention to
 * group-local, preserving exactly what the CURRENT binary renders.
 *
 * Per object (every level of the tree):
 *  - Legacy group children stored points world-absolute while their transform
 *    was already parent-local. Re-base points by the parent's COMPOSED WORLD
 *    origin, accumulated through this recursion — inner-group transforms are
 *    ancestor-local, so a depth-2+ grandchild must subtract the SUM of
 *    ancestor origins, not the immediate parent's local x/y (critic R3:
 *    the depth-1 rebase silently shifts every deeper grandchild on load).
 *    No extra bake is needed for legacy ROTATED groups: the flatten rotates
 *    about the group's world center at render time either way, so the plain
 *    rebase alone preserves rendered truth. That equivalence is exact only at
 *    depth 1 — for a grandchild at depth ≥ 2 under a ROTATED outer group, this
 *    translation-only ancestor-origin accumulation is an approximation, because
 *    the new flatten composes inner-group origins THROUGH the outer rotation
 *    (mitigated: nested groups are invisible in today's Viewport, so the legacy
 *    population is near-nil; a fixture lands in a later wave).
 *  - rotation == 0: transform := pointsBBox (zero visual change; repairs the
 *    desync every failed legacy move left behind). Idempotent.
 *  - rotation ≠ 0 AND desynced beyond ε: bake the rotation into the points
 *    about the OLD transform center — render and cut both pivot there, so the
 *    bake preserves the rendered appearance exactly — then rotation := 0 and
 *    transform := new pointsBBox. Lossy on the rotation FIELD only.
 *  - rotation ≠ 0 and coherent: leave untouched (already coherent).
 *
 * Robustness: per-object try/catch — one malformed legacy object logs and
 * passes through un-migrated; it must not abort a load that succeeds today.
 * In-place mutation is permitted HERE ONLY (fresh-parsed JSON, pre-store).
 */
function migratePointsTransformSync(
  objects: DesignObject[],
  parentWorldX: number,
  parentWorldY: number,
): void {
  for (const obj of objects) {
    try {
      if (obj.type === "group" && obj.children) {
        migratePointsTransformSync(
          obj.children,
          parentWorldX + obj.transform.x,
          parentWorldY + obj.transform.y,
        );
        continue;
      }
      if ((obj.type !== "path" && obj.type !== "line") || !obj.points || obj.points.length === 0) {
        continue;
      }
      const t = obj.transform;

      // (1) world-absolute → parent-local re-base (no-op at top level)
      if (parentWorldX !== 0 || parentWorldY !== 0) {
        for (const p of obj.points) {
          p.x -= parentWorldX;
          p.y -= parentWorldY;
          if (p.handleIn) { p.handleIn.x -= parentWorldX; p.handleIn.y -= parentWorldY; }
          if (p.handleOut) { p.handleOut.x -= parentWorldX; p.handleOut.y -= parentWorldY; }
        }
      }

      // (2) transform-sync / rotation bake
      const bb = pointsBBox(obj.points);
      const rot = t.rotation || 0;
      if (rot === 0) {
        t.x = bb.x; t.y = bb.y; t.width = bb.width; t.height = bb.height;
      } else {
        const desynced =
          Math.abs(t.x - bb.x) > POINTS_EPSILON ||
          Math.abs(t.y - bb.y) > POINTS_EPSILON ||
          Math.abs(t.width - bb.width) > POINTS_EPSILON ||
          Math.abs(t.height - bb.height) > POINTS_EPSILON;
        if (desynced) {
          const cx = t.x + t.width / 2;
          const cy = t.y + t.height / 2;
          obj.points = obj.points.map((p) => rotatePathPoint(p, cx, cy, rot));
          t.rotation = 0;
          const nb = pointsBBox(obj.points);
          t.x = nb.x; t.y = nb.y; t.width = nb.width; t.height = nb.height;
        }
      }
    } catch (e) {
      console.error("Kerf migration: skipping malformed object", (obj as { id?: string } | null)?.id, e);
    }
  }
}

function migrateFlipTransforms(objects: DesignObject[]) {
  for (const obj of objects) {
    try {
      const t = obj.transform;
      if (obj.type === "group" && obj.children) {
        migrateFlipTransforms(obj.children);
      }
      if ((obj.type === "path" || obj.type === "line") && obj.points && (t.scaleX < 0 || t.scaleY < 0)) {
        const centerX = t.x + t.width / 2;
        const centerY = t.y + t.height / 2;
        for (const p of obj.points) {
          if (t.scaleX < 0) {
            p.x = 2 * centerX - p.x;
            if (p.handleIn) p.handleIn.x = 2 * centerX - p.handleIn.x;
            if (p.handleOut) p.handleOut.x = 2 * centerX - p.handleOut.x;
          }
          if (t.scaleY < 0) {
            p.y = 2 * centerY - p.y;
            if (p.handleIn) p.handleIn.y = 2 * centerY - p.handleIn.y;
            if (p.handleOut) p.handleOut.y = 2 * centerY - p.handleOut.y;
          }
        }
        t.scaleX = 1;
        t.scaleY = 1;
      } else if (obj.type === "rectangle" || obj.type === "ellipse") {
        t.scaleX = 1;
        t.scaleY = 1;
      }
    } catch (e) {
      // per-object robustness (W1b): a malformed legacy object must not abort
      // a load — log, skip, and let the rest of the file migrate normally.
      console.error("Kerf migration: skipping malformed object", (obj as { id?: string } | null)?.id, e);
    }
  }
}
