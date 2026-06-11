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

export interface MovesPoint {
  x: number;
  y: number;
}

export interface MovesExtents {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding extents of the machine-frame move list; null when there are no moves. */
export function movesExtents(moves: ReadonlyArray<MovesPoint>): MovesExtents | null {
  if (moves.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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

export interface JobGateState {
  machineConnected: boolean;
  jobRunning: boolean;
  gcodeResult: { moves: MovesPoint[] } | null;
  gcodeStale: boolean;
  workspaceWidth: number;
  workspaceHeight: number;
}

export interface JobGate {
  ok: boolean;
  reason?: string;
}

/** Pure START gate. Every blocking condition carries a user-facing reason. */
export function canStartJob(state: JobGateState): JobGate {
  if (!state.machineConnected) return { ok: false, reason: "Machine not connected" };
  if (state.jobRunning) return { ok: false, reason: "Job already running" };
  if (!state.gcodeResult) return { ok: false, reason: "Generate G-code first" };
  if (state.gcodeStale) return { ok: false, reason: "Design changed -- regenerate G-code" };
  const ext = movesExtents(state.gcodeResult.moves);
  if (!ext) return { ok: false, reason: "Nothing to cut -- no moves in the generated G-code" };
  if (
    ext.minX < 0 || ext.minY < 0 ||
    ext.maxX > state.workspaceWidth || ext.maxY > state.workspaceHeight
  ) {
    return {
      ok: false,
      reason: "G-code extends outside workspace bounds. Move or resize the design to fit.",
    };
  }
  return { ok: true };
}
