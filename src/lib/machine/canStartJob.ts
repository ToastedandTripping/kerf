/**
 * canStartJob.ts — pure job-gating predicate + moves-extents helpers (F15).
 *
 * Pre-flight bounds and FRAME both work from `gcodeResult.moves` — the ACTUAL
 * coordinates the machine will receive (rotation, overscan, lead-in/out, kerf
 * already applied by the generators) — not from rotation-blind object AABBs.
 *
 * Coordinate frame: `moves[]` is ALREADY machine-frame (Y-flip applied at
 * generation). Extents computed here need NO design→machine transform; the old
 * Frame code's `workspaceHeight - y` flip must never be reapplied on top.
 *
 * Empty moves: a non-null gcodeResult with `moves.length === 0` is reachable
 * (text-only design, all layers output-off). min/max over an empty set is
 * ±Infinity and `G0 XInfinity` earns GRBL error:33 — so empty moves are an
 * explicit gate here and an explicit no-op in frameTargets.
 */

interface MovesPoint {
  x: number;
  y: number;
}

interface MovesExtents {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding extents of the machine-frame move list; null when there are no moves. */
export function movesExtents(moves: ReadonlyArray<MovesPoint>): MovesExtents | null {
  if (moves.length === 0) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const m of moves) {
    if (m.x < minX) minX = m.x;
    if (m.y < minY) minY = m.y;
    if (m.x > maxX) maxX = m.x;
    if (m.y > maxY) maxY = m.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The five G0 targets tracing the job's true extents rectangle, in machine
 * frame (NO Y transform). Returns null when there is nothing to cut.
 */
export function frameTargets(moves: ReadonlyArray<MovesPoint>): MovesPoint[] | null {
  const e = movesExtents(moves);
  if (!e) return null;
  return [
    { x: e.minX, y: e.minY },
    { x: e.maxX, y: e.minY },
    { x: e.maxX, y: e.maxY },
    { x: e.minX, y: e.maxY },
    { x: e.minX, y: e.minY },
  ];
}

/**
 * Pure bounds predicate — shared by canStartJob and the FRAME gate.
 * Returns true when the extents rectangle fits within the declared bed.
 * Extracted so FRAME gets the same check that START uses (one source of truth).
 */
export function isWithinBounds(
  ext: MovesExtents,
  workspaceWidth: number,
  workspaceHeight: number,
  originTop?: boolean
): boolean {
  if (originTop) {
    return (
      ext.minX >= 0 && ext.maxX <= workspaceWidth && ext.maxY <= 0 && ext.minY >= -workspaceHeight
    );
  }
  return (
    ext.minX >= 0 && ext.minY >= 0 && ext.maxX <= workspaceWidth && ext.maxY <= workspaceHeight
  );
}

/**
 * Parse G-code text and extract the bounding extents of all G0/G1 move
 * coordinates. Used by MaterialTestDialog to bounds-check generated G-code
 * before sending. Returns null when no coordinates are found.
 */
export function gcodeExtents(gcode: string): MovesExtents | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let found = false;
  for (const line of gcode.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";")) continue;
    // Only parse G0/G1 lines (the ones that actually move the head)
    if (!/^(?:G[01]\b|[XYZMFS])/i.test(trimmed)) continue;
    const xMatch = trimmed.match(/X([-\d.]+)/i);
    const yMatch = trimmed.match(/Y([-\d.]+)/i);
    if (xMatch) {
      const x = parseFloat(xMatch[1]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      found = true;
    }
    if (yMatch) {
      const y = parseFloat(yMatch[1]);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      found = true;
    }
  }
  return found ? { minX, minY, maxX, maxY } : null;
}

export interface JobGateState {
  machineConnected: boolean;
  machineState?: string;
  jobRunning: boolean;
  gcodeResult: { moves: MovesPoint[] } | null;
  gcodeStale: boolean;
  workspaceWidth: number;
  workspaceHeight: number;
  originTop?: boolean;
  /** NOTE-1: fail-closed — undefined/missing is treated as unverified (not as verified). */
  workspaceVerified: boolean;
}

export interface JobGate {
  ok: boolean;
  reason?: string;
}

/** Pure START gate. Every blocking condition carries a user-facing reason.
 *
 *  Gate unification (P1-C): both START and FRAME require idle. The old START
 *  gate only checked for alarm, silently permitting hold/run/door — which let
 *  a user queue a new job while a pause was in progress. */
export function canStartJob(state: JobGateState): JobGate {
  if (!state.machineConnected) return { ok: false, reason: "Machine not connected" };
  if (state.machineState === "alarm")
    return { ok: false, reason: "Machine locked (ALARM) — Home ($H) or Unlock ($X) first" };
  // Gate unification: require idle — hold/run/door all block.
  if (state.machineState && state.machineState !== "idle") {
    return {
      ok: false,
      reason: `Machine is ${state.machineState} — wait for idle before starting`,
    };
  }
  if (state.jobRunning) return { ok: false, reason: "Job already running" };
  if (!state.gcodeResult) return { ok: false, reason: "Generate G-code first" };
  if (state.gcodeStale) return { ok: false, reason: "Design changed -- regenerate G-code" };
  // NOTE-1: fail-closed — any falsy value (false, undefined) blocks; only explicit true passes
  if (!state.workspaceVerified) {
    return { ok: false, reason: "Confirm bed size before starting — go to Machine Settings" };
  }
  const ext = movesExtents(state.gcodeResult.moves);
  if (!ext) return { ok: false, reason: "Nothing to cut -- no moves in the generated G-code" };
  if (!isWithinBounds(ext, state.workspaceWidth, state.workspaceHeight, state.originTop)) {
    return {
      ok: false,
      reason: "G-code extends outside workspace bounds. Move or resize the design to fit.",
    };
  }
  return { ok: true };
}
