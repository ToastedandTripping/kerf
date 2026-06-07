import { useStore } from "../../app/store";
import type { DesignObject, KerfProject } from "../../app/types";
import { DEFAULT_LAYERS } from "../../app/types";
import { DEFAULT_MATERIALS } from "../materials";
import { addRecentFile } from "../recentFiles";
import { clearRecoveryFile } from "../autoSave";
import { importDxfDirect } from "./dxfImport";
import { importImageData } from "./imageImport";
import { exportSvgContent } from "./svgExport";

export { importSvgContent, parsePathD } from "./svgImport";
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

export const fileOperations = {
  async newProject() {
    const canProceed = await checkUnsavedChanges();
    if (!canProceed) return;

    const store = useStore.getState();
    store.loadProject({
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
    store.setProjectPath(null);
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
        migrateFlipTransforms(project.objects);
        useStore.getState().loadProject(project);
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
      migrateFlipTransforms(project.objects);
      useStore.getState().loadProject(project);
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

function migrateFlipTransforms(objects: DesignObject[]) {
  for (const obj of objects) {
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
  }
}
