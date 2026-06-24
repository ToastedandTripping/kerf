/**
 * WS4: OS sleep-inhibitor subscription — keep the machine awake during laser jobs.
 *
 * Installs a single app-lifetime listener on `jobRunning` (a scalar boolean in
 * the Zustand store). Edge-triggers on false→true to acquire the OS sleep
 * inhibitor, and on true→false to release it.
 *
 * ## Coverage
 * The `jobRunning` flag is set by BOTH the main job loop (MachinePanel.tsx)
 * AND the material-test grid (MaterialTestDialog.tsx), so this single subscription
 * covers both job types automatically. If either writer is ever split into a
 * separate flag, keep-awake coverage for that path must be re-wired explicitly.
 *
 * ## Failure policy
 * A power-assertion failure (e.g. headless Linux without a D-Bus session) must
 * NEVER break a running job. Both invoke calls are wrapped in `.catch` that logs
 * a single warning and swallows the error.
 *
 * ## Laser safety
 * This module only acquires/releases an OS power assertion. It emits zero G-code,
 * zero motion commands, and zero serial commands.
 *
 * ## React Error 185 note
 * This module does NOT use `useStore(selector)` inside a React component. It uses
 * the vanilla `useStore.subscribe` API (identical to the pattern at connection.ts:118)
 * which subscribes to the full state and extracts the scalar. No new object or
 * array is returned — no re-render loop risk.
 */

import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../app/store";

let installed = false;

/**
 * Install the keep-awake subscription. Safe to call multiple times — only the
 * first call registers the listener; subsequent calls are no-ops. Call once at
 * app startup (see src/main.tsx).
 */
export function installKeepAwake(): void {
  if (installed) return;
  installed = true;

  let prevJobRunning = useStore.getState().jobRunning;

  useStore.subscribe((state) => {
    const next = state.jobRunning;
    if (next === prevJobRunning) return;

    const prev = prevJobRunning;
    prevJobRunning = next;

    if (!prev && next) {
      // false → true: job started, acquire sleep inhibitor
      invoke("keep_awake_acquire").catch((err: unknown) => {
        console.warn("[keepAwake] acquire failed (job continues):", err);
      });
    } else if (prev && !next) {
      // true → false: job ended (complete, Stop, alarm, or disconnect), release
      invoke("keep_awake_release").catch((err: unknown) => {
        console.warn("[keepAwake] release failed (assertion may persist until process exit):", err);
      });
    }
  });
}
