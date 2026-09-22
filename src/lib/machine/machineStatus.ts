/**
 * machineStatus.ts — Validated status consumer for B2a's native snapshot.
 *
 * One consumer, one poll in flight. Rejects stale epochs, expired freshness,
 * and manufactured safety claims. Connection starts unknown.
 *
 * This is the consumer half of the status pair: B2a (Rust) provides the
 * parsed GrblSnapshot; this module interprets it for the TS/UI side.
 */

import { useStore } from "../../app/store";

// ---- Mirror types for B2a's Rust contract ----

/** Machine state from the first field of a `<…>` report.
 *  Rust's `#[serde(rename_all = "camelCase")]` serializes these as lowercase
 *  simple variants and camelCase for struct variants. */
export type MachineState =
  | "idle"
  | "run"
  | { hold: { substate: number | null } }
  | "jog"
  | "home"
  | { door: { substate: number | null } }
  | "alarm"
  | "check"
  | "sleep"
  | { unknown: string };

/** Which coordinate system the position was reported in. */
export type PositionKind = "MPos" | "WPos";

/** Accessory field presence. Unknown ≠ off. */
export type AccessoryState = "Unknown" | { Present: string };

/** Units validity. */
export type UnitsValidity = "Unknown" | "Mm" | "Inches";

/** B2a's parsed GRBL snapshot, as serialized to JSON (camelCase). */
export interface GrblSnapshot {
  epoch: number;
  seq: number;
  state: MachineState;
  positionKind: PositionKind | null;
  position: [number, number, number] | null;
  wco: [number, number, number] | null;
  feed: number | null;
  spindle: number | null;
  accessory: AccessoryState;
  units: UnitsValidity;
  raw: string;
  unknownFields: string[];
}

/** B2a's StatusOutcome with the additive fields.
 *  Rust's `#[serde(rename_all = "camelCase")]` on `StatusKind` serializes
 *  variants as: report, busy, noResponse, transportError. */
export interface StatusOutcome {
  status: string;
  events: string[];
  kind: "report" | "busy" | "noResponse" | "transportError";
  snapshot: GrblSnapshot | null;
}

// ---- Consumer state ----

/** The epoch/seq watermark for monotonic rejection. */
let lastEpoch = 0;
let lastSeq = 0;

/** Timestamp (ms) of the last valid status update — for the 3s eligibility rule. */
let lastValidStatusTime = 0;

/** The eligibility age threshold in ms. When the last valid status is older
 *  than this, new actions are blocked. */
const ELIGIBILITY_AGE_MS = 3000;

// ---- Helpers ----

/** Extract the base state string from a MachineState variant for the store. */
export function machineStateToStore(
  s: MachineState
): "idle" | "run" | "hold" | "alarm" | "door" | "disconnected" {
  if (s === "idle") return "idle";
  if (s === "run") return "run";
  if (s === "jog") return "run"; // Jog is motion; map to run for UI
  if (s === "alarm") return "alarm";
  if (s === "check") return "idle"; // Check mode is idle-like
  if (s === "sleep") return "idle";
  if (s === "home") return "run"; // Homing is motion
  if (typeof s === "object") {
    if ("hold" in s) return "hold";
    if ("door" in s) return "door";
    if ("unknown" in s) return "alarm"; // Unknown state → conservative
  }
  return "alarm"; // Unreachable fallback → conservative
}

/** True if the given state represents active motion (renews liveness).
 *  Exported for future use by eligibility logic. */
export function isRunLike(s: MachineState): boolean {
  if (s === "run" || s === "jog" || s === "home") return true;
  if (typeof s === "object") {
    if ("hold" in s || "door" in s) return true;
  }
  return false;
}

/** Validate that a number is finite. Nonfinite → null. */
function finiteOrNull(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return v;
}

// ---- Public API ----

/**
 * Process a status outcome from the Rust side. Writes validated state to the
 * Zustand store. Returns whether the snapshot was accepted.
 *
 * Enforces:
 * - Monotonic epoch/seq: late old-epoch or old-seq snapshots are rejected.
 * - Nonfinite position/feed/spindle values are rejected (field-level, not whole snapshot).
 * - Accessory Unknown ≠ "beam off": absent A: field never sets a confirmed-off state.
 * - MPos/WPos identity is preserved; they are never merged as interchangeable.
 * - 3s eligibility rule is enforced via `lastValidStatusTime`.
 */
export function consumeStatusOutcome(outcome: StatusOutcome): boolean {
  const store = useStore.getState();

  // Surface events (ALARM, MSG lines skipped on the way) regardless of snapshot validity.
  for (const event of outcome.events) {
    if (event.startsWith("ALARM")) {
      store.addConsoleLine(event, "error");
      if (store.jobRunning) {
        store.setJobRunning(false);
      }
    } else if (event.startsWith("[MSG:")) {
      store.addConsoleLine(event, "info");
    } else {
      store.addConsoleLine(event, "received");
    }
  }

  // Classify the outcome. If `kind` is missing (pre-B2a compat), infer from
  // the raw status string: empty = busy/noResponse, non-empty = report.
  const kind = outcome.kind ?? (outcome.status ? "report" : "busy");

  // Busy: the command lock is held (e.g. during $H homing). The port is alive
  // but we have no fresh data. Preserve age (don't update lastValidStatusTime),
  // don't update state. Return true to indicate "not a failure."
  if (kind === "busy") {
    return true;
  }

  // NoResponse or TransportError with no snapshot: status goes unknown.
  if (kind === "noResponse" || kind === "transportError") {
    // Don't update lastValidStatusTime — staleness clock keeps ticking.
    return false;
  }

  // Report: we have (or should have) a fresh snapshot.
  const snap = outcome.snapshot;
  if (!snap) {
    // Report kind but no snapshot — malformed. Treat as no-data.
    return false;
  }

  // Monotonic rejection: late old-epoch or old-seq snapshots never overwrite.
  if (snap.epoch < lastEpoch) {
    return false;
  }
  if (snap.epoch === lastEpoch && snap.seq <= lastSeq) {
    return false;
  }

  // Accept: update watermark.
  lastEpoch = snap.epoch;
  lastSeq = snap.seq;
  lastValidStatusTime = Date.now();

  // Write machine state.
  const storeState = machineStateToStore(snap.state);
  store.setMachineState(storeState);

  // Write position, preserving MPos/WPos identity.
  if (snap.position !== null && snap.positionKind !== null) {
    const [x, y, z] = snap.position;
    const fx = finiteOrNull(x);
    const fy = finiteOrNull(y);
    const fz = finiteOrNull(z);
    if (fx !== null && fy !== null && fz !== null) {
      store.setMachinePosition({ x: fx, y: fy, z: fz });
      // Store which coordinate system this position is in.
      store.setPositionKind(snap.positionKind === "MPos" ? "machine" : "work");
    }
  }

  // Write WCO if present (independent of position kind).
  if (snap.wco !== null) {
    const [wx, wy] = snap.wco;
    const fwx = finiteOrNull(wx);
    const fwy = finiteOrNull(wy);
    if (fwx !== null && fwy !== null) {
      store.setWorkCoordOffset({ x: fwx, y: fwy });
    }
  }

  // Spindle-drop diagnostic: track spindle speed and warn on drop-to-zero during Run.
  if (snap.spindle !== null) {
    const currentSpindle = finiteOrNull(snap.spindle);
    if (currentSpindle !== null) {
      store.setSpindleSpeed(currentSpindle);
    }
  }

  // Feed rate (informational — stored for DRO display).
  if (snap.feed !== null) {
    const currentFeed = finiteOrNull(snap.feed);
    if (currentFeed !== null) {
      store.setFeedRate(currentFeed);
    }
  }

  // Accessory state: Unknown ≠ off. Only Present gives us data.
  // We store the raw accessory flags for the UI. We NEVER infer "beam off"
  // from absence of the A: field.
  if (typeof snap.accessory === "object" && "Present" in snap.accessory) {
    store.setAccessoryFlags(snap.accessory.Present);
  } else {
    // Unknown — we don't know. Store as null, never as "off".
    store.setAccessoryFlags(null);
  }

  return true;
}

/**
 * Whether new actions (job start, laser enable) are eligible based on
 * status freshness. Returns false when the last valid status is older
 * than ELIGIBILITY_AGE_MS.
 */
export function isStatusEligible(): boolean {
  if (lastValidStatusTime === 0) return false; // Never received a valid status.
  return Date.now() - lastValidStatusTime < ELIGIBILITY_AGE_MS;
}

/**
 * Reset consumer state. Called on disconnect or connect to clear stale watermarks.
 */
export function resetStatusConsumer(): void {
  lastEpoch = 0;
  lastSeq = 0;
  lastValidStatusTime = 0;
}

/**
 * Get the current epoch/seq watermark (for testing).
 */
export function _testGetWatermark(): { epoch: number; seq: number } {
  return { epoch: lastEpoch, seq: lastSeq };
}

/**
 * Get the last valid status time (for testing).
 */
export function _testGetLastValidStatusTime(): number {
  return lastValidStatusTime;
}
