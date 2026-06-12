import { useStore } from "../../app/store";
import type { DesignObject, KerfProject } from "../../app/types";
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

let dialogModule: typeof import("@tauri-apps/plugin-dialog") | null = null;
let fsModule: typeof import("@tauri-apps/plugin-fs") | null = null;

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
    await fileOperations.saveProject();
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
  if (project.formatVersion === undefined || project.formatVersion < KERF_FORMAT_VERSION) {
    migrateFlipTransforms(project.objects);
    migratePointsTransformSync(project.objects, 0, 0);
    project.formatVersion = KERF_FORMAT_VERSION;
  }
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
      const pathStr = typeof path === "string" ? path : (path as any).path ?? String(path);
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
        const project = JSON.parse(content) as KerfProject;
        loadProjectWithMigrations(project);
        useStore.getState().setProjectPath(pathStr);
        addRecentFile(pathStr);
      }
    }
  },

  async saveProject() {
    const store = useStore.getState();
    if (store.projectPath) {
      await saveToPath(store.projectPath);
      addRecentFile(store.projectPath);
      clearRecoveryFile();
    } else {
      await fileOperations.saveProjectAs();
    }
  },

  async saveProjectAs() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.save({
        filters: [{ name: "Kerf Project", extensions: ["kerf"] }],
        defaultPath: `${useStore.getState().projectName}.kerf`,
      });
      if (!path) return;
      const pathStr = typeof path === "string" ? path : String(path);
      await saveToPath(pathStr);
      useStore.getState().setProjectPath(pathStr);
      addRecentFile(pathStr);
      clearRecoveryFile();
      const name = pathStr.split("/").pop()?.replace(".kerf", "") || "Untitled";
      useStore.getState().setProjectName(name);
    }
  },

  async openRecentFile(filePath: string) {
    const hasTauri = await ensureTauri();
    if (!hasTauri || !fsModule) return;
    try {
      const content = await fsModule.readTextFile(filePath);
      const project = JSON.parse(content) as KerfProject;
      loadProjectWithMigrations(project);
      useStore.getState().setProjectPath(filePath);
      addRecentFile(filePath);
    } catch (e) {
      console.error("Failed to open recent file:", e);
    }
  },

  async importSvg() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.open({
        filters: [{ name: "SVG", extensions: ["svg"] }],
      });
      if (!path) return;
      const pathStr = typeof path === "string" ? path : (path as any).path ?? String(path);
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
      await fsModule.writeTextFile(pathStr, svg);
    }
  },

  async importDxf() {
    const hasTauri = await ensureTauri();
    if (hasTauri && dialogModule && fsModule) {
      const path = await dialogModule.open({
        filters: [{ name: "DXF", extensions: ["dxf"] }],
      });
      if (!path) return;
      const pathStr = typeof path === "string" ? path : (path as any).path ?? String(path);
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
      const pathStr = typeof path === "string" ? path : (path as any).path ?? String(path);
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
      const pathStr = typeof path === "string" ? path : (path as any).path ?? String(path);
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
      await fsModule.writeTextFile(pathStr, store.gcodeResult.gcode);
      store.addConsoleLine(`G-code exported: ${pathStr}`, "info");
    }
  },
};

async function saveToPath(path: string) {
  if (!fsModule) return;
  const project = useStore.getState().toProject();
  await fsModule.writeTextFile(path, JSON.stringify(project, null, 2));
  useStore.getState().setDirty(false);
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
