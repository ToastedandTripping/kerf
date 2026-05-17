import { useStore } from "../app/store";

let autoSaveInterval: ReturnType<typeof setInterval> | null = null;
let appDataDir: string | null = null;

const RECOVERY_FILENAME = "recovery.kerf";

async function getRecoveryPath(): Promise<string | null> {
  try {
    const path = await import("@tauri-apps/api/path");
    if (!appDataDir) {
      appDataDir = await path.appDataDir();
    }
    return `${appDataDir}${RECOVERY_FILENAME}`;
  } catch {
    return null;
  }
}

export async function startAutoSave(intervalMs: number = 60000): Promise<void> {
  stopAutoSave();
  autoSaveInterval = setInterval(async () => {
    const store = useStore.getState();
    if (!store.isDirty) return;
    try {
      const recoveryPath = await getRecoveryPath();
      if (!recoveryPath) return;
      const fs = await import("@tauri-apps/plugin-fs");
      const project = store.toProject();
      const json = JSON.stringify(project, null, 2);
      await fs.writeTextFile(recoveryPath, json);
    } catch {}
  }, intervalMs);
}

export function stopAutoSave(): void {
  if (autoSaveInterval) {
    clearInterval(autoSaveInterval);
    autoSaveInterval = null;
  }
}

export async function checkRecoveryFile(): Promise<{ project: ReturnType<typeof useStore.getState>["toProject"] extends () => infer R ? R : never; timestamp: number } | null> {
  try {
    const recoveryPath = await getRecoveryPath();
    if (!recoveryPath) return null;
    const fs = await import("@tauri-apps/plugin-fs");
    const stat = await fs.stat(recoveryPath);
    if (!stat || !stat.mtime) return null;
    const age = Date.now() - new Date(stat.mtime).getTime();
    if (age > 24 * 60 * 60 * 1000) {
      await fs.remove(recoveryPath);
      return null;
    }
    const content = await fs.readTextFile(recoveryPath);
    const project = JSON.parse(content);
    return { project, timestamp: new Date(stat.mtime).getTime() };
  } catch {
    return null;
  }
}

export async function clearRecoveryFile(): Promise<void> {
  try {
    const recoveryPath = await getRecoveryPath();
    if (!recoveryPath) return;
    const fs = await import("@tauri-apps/plugin-fs");
    await fs.remove(recoveryPath);
  } catch {}
}
