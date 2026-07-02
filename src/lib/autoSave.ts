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
      // Ensure the appData directory exists before the first write — a missing
      // dir would silently fail without this (the parent path must exist for
      // writeTextFile to succeed).
      if (appDataDir) {
        try {
          await fs.mkdir(appDataDir, { recursive: true });
        } catch {
          // "already exists" throws on some platforms — ignore, proceed to write
        }
      }
      const project = store.toProject();
      const json = JSON.stringify(project, null, 2);
      await fs.writeTextFile(recoveryPath, json);
    } catch (e) {
      // Do not toast every 60s — log once so it's diagnosable without pestering the user
      console.error("[Kerf] Auto-save recovery write failed:", e);
    }
    // The interval must stay alive on error — a transient failure must not
    // disable the recovery safety net for the rest of the session.
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
    // F26: no 24h expiry — recovery files persist until the user explicitly
    // dismisses them. An overnight crash should still offer recovery the next day.
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
  } catch {
    // Best-effort cleanup — recovery file may already be gone, non-critical, ignore
  }
}
