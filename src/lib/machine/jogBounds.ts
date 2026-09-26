/**
 * S3: jog admission and clipping, pure. `jogBlockReason` holds every
 * precondition (one line per refusal); `clipJog` is the geometry. A jog is a
 * nudge: it may shrink toward zero, but never grows and never reverses.
 */

export const JOG_REASON_NOT_CONNECTED = "Machine not connected";
export const JOG_REASON_BED = "Confirm bed size before jogging — Machine panel, Set bed size";
export const JOG_REASON_ALARM = "Jog blocked: machine in alarm state — unlock ($X) first";
export const JOG_REASON_STALE =
  "Waiting for the machine to report its position — try again in a moment";
export const JOG_REASON_BUSY = "Wait for the machine to stop before jogging";
export const JOG_REASON_OFFSET =
  "Jogging is off while a work offset is set — Kerf can't tell where the bed edge is. Clear the offset first.";
export const JOG_REASON_PENDING = "The last jog is still moving — try again when it stops";
export const JOG_REASON_JOB = "A job is running — jogging is off until it finishes";
export const JOG_REASON_AXIS = "Kerf can only jog X and Y";
export const JOG_REASON_OUTSIDE =
  "The head is outside the bed Kerf knows about — home the machine first";
export const JOG_REASON_EDGE = "Already at the edge of the bed";
export const JOG_REASON_TARGET = "That spot is outside the bed";
export const JOG_REASON_NUMBER =
  "Kerf can't read the head position, bed size or jog step — try again in a moment";

export type JogAxis = "X" | "Y";

/** The scalars the gate reads; `useStore.getState()` satisfies it structurally. */
export interface JogGateState {
  machineConnected: boolean;
  machineState: string;
  jobRunning: boolean;
  statusStale: boolean;
  workspaceVerified: boolean;
  positionKind: "machine" | "work" | null;
  workCoordOffset: { x: number; y: number };
}

export type JogResult = { kind: "send"; distance: number } | { kind: "refuse"; reason: string };

const refuse = (reason: string): JogResult => ({ kind: "refuse", reason });

/** The machine-frame range an axis may occupy. Only Y flips (gcode_gen.rs rule). */
export function jogEnvelope(axis: JogAxis, bed: number, originTop: boolean): [number, number] {
  if (axis === "Y" && originTop) return [-bed, 0];
  return [0, bed];
}

/** First reason a jog must not be sent, or null. `mode` "by" is relative, "to" absolute. */
export function jogBlockReason(s: JogGateState, mode: "by" | "to"): string | null {
  if (!s.machineConnected) return JOG_REASON_NOT_CONNECTED;
  if (s.machineState === "alarm") return JOG_REASON_ALARM;
  if (s.jobRunning) return JOG_REASON_JOB;
  if (!s.workspaceVerified) return JOG_REASON_BED;
  if (s.statusStale || s.positionKind === null) return JOG_REASON_STALE;
  if (s.machineState !== "idle") return JOG_REASON_BUSY;
  const offsetSet = s.workCoordOffset.x !== 0 || s.workCoordOffset.y !== 0;
  if (offsetSet && (mode === "to" || s.positionKind === "work")) return JOG_REASON_OFFSET;
  return null;
}

/** Clip a relative jog toward zero so it ends inside the envelope. */
export function clipJog(req: {
  axis: JogAxis;
  distance: number;
  position: number;
  bed: number;
  originTop: boolean;
}): JogResult {
  const finite = [req.position, req.bed, req.distance].every(Number.isFinite);
  if (!finite) return refuse(JOG_REASON_NUMBER);
  const [lo, hi] = jogEnvelope(req.axis, req.bed, req.originTop);
  if (req.position < lo || req.position > hi) return refuse(JOG_REASON_OUTSIDE);
  const room = req.distance < 0 ? req.position - lo : hi - req.position;
  const magnitude = Math.min(Math.abs(req.distance), room);
  if (magnitude <= 0) return refuse(JOG_REASON_EDGE);
  return { kind: "send", distance: Math.sign(req.distance) * magnitude };
}

/** True when an absolute machine-frame target lies inside the bed. */
export function targetInEnvelope(
  x: number,
  y: number,
  w: number,
  h: number,
  originTop: boolean
): boolean {
  const [xLo, xHi] = jogEnvelope("X", w, originTop);
  const [yLo, yHi] = jogEnvelope("Y", h, originTop);
  return x >= xLo && x <= xHi && y >= yLo && y <= yHi;
}
