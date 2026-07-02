const RECENT_FILES_KEY = "kerf-recent-files";
const MAX_RECENT = 10;

export function getRecentFiles(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FILES_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

export function addRecentFile(path: string): void {
  try {
    const current = getRecentFiles();
    const filtered = current.filter((p) => p !== path);
    filtered.unshift(path);
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(filtered.slice(0, MAX_RECENT)));
  } catch {
    // localStorage unavailable (private browsing, disabled storage) — non-critical, ignore
  }
}

export function clearRecentFiles(): void {
  try {
    localStorage.removeItem(RECENT_FILES_KEY);
  } catch {
    // localStorage unavailable (private browsing, disabled storage) — non-critical, ignore
  }
}
