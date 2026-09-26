import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../app/store";
import { sortPortsByPriority } from "./knownDevices";
import { noteSpindleSample, resetSpindleDrop } from "./lastSentLine";
import {
  consumeStatusOutcome,
  resetStatusConsumer,
  machineStateToStore,
  isStatusEligible,
  type GrblSnapshot,
} from "./machineStatus";
import {
  JOG_REASON_AXIS,
  JOG_REASON_PENDING,
  JOG_REASON_TARGET,
  clipJog,
  jogBlockReason,
  targetInEnvelope,
} from "./jogBounds";

interface PortInfo {
  name: string;
  portType: string;
  vid: number | null;
  pid: number | null;
  manufacturer: string | null;
  product: string | null;
}

/** Mirror of Rust `SendOutcome`: the command's own response lines plus
 * console-meaningful lines drained from the buffer BEFORE the command was
 * written (stale banner/ALARM debris — never attributed to this command). */
interface SendOutcome {
  responses: string[];
  drained: string[];
}

/** Mirror of Rust `StatusOutcome` (B2a extended). `kind` and `snapshot` are
 * additive — `status` and `events` remain for backward compatibility.
 * `status` is `""` when the command lock was busy or the bounded read expired. */
interface StatusOutcome {
  status: string;
  events: string[];
  kind: "report" | "busy" | "noResponse" | "transportError";
  snapshot: GrblSnapshot | null;
}

/** Surface an unsolicited protocol line (drained debris or status junk-skip)
 * with honest styling: an idle-time hard-limit ALARM must reach the console
 * (and thus the alarm panel's code parser) — never silently vanish. */
function surfaceUnsolicited(line: string): void {
  const store = useStore.getState();
  if (line.startsWith("ALARM")) {
    store.addConsoleLine(line, "error");
    // Mid-job ALARM via drained/unsolicited path: flip jobRunning so the job
    // loop exits on its next iteration. The loop checks jobRunning before each
    // send and surfaces "Job cancelled" — that's the right exit message for an
    // externally-triggered alarm. The job loop already surfaces the ALARM line
    // it received directly; this path handles ALARMs that arrived as debris.
    if (store.jobRunning) {
      store.setJobRunning(false);
    }
  } else if (line.startsWith("[MSG:")) {
    store.addConsoleLine(line, "info");
  } else {
    store.addConsoleLine(line, "received");
  }
}

/** RF-15: stable prefix of a job-line refusal from the backend admission
 * fence (Rust `REFUSED_PREFIX`). Matched with `startsWith`, never `includes`:
 * Tauri rejects an `Err(String)` with the raw string, so `String(e)` is the
 * bare contract text. Only a job line (one sent with `jobEpoch`) can be
 * refused. */
export const PERMIT_REFUSED_PREFIX = "refused:";

const LAST_PORT_KEY = "kerf-last-port";
const LAST_BAUD_KEY = "kerf-last-baud";
let statusPollInterval: ReturnType<typeof setInterval> | null = null;
let jobPollingSuspended = false;
let unsubscribeJobRunning: (() => void) | null = null;
let consecutivePollFailures = 0;

/** A7: in-flight connect promise for re-entrancy coalescing. If a connect()
 *  is already running (StrictMode double-mount, rapid clicks), subsequent
 *  callers get the same promise instead of racing a second connection. */
let connectingPromise: Promise<string> | null = null;

/**
 * S1: settings generation. Bumped by every settings write; a readback only
 * counts when no write landed between its capture and its parse. Module-level,
 * not store state (no selector churn).
 */
let settingsGeneration = 0;

/** Normalize as GRBL 1.1's line reader does before it executes the line:
 *  drop ( ... ) comments, cut at ';', delete every char <= 0x20 and every '/',
 *  upper-case. (S3: extracted verbatim from isGrblSettingsWrite.) */
function normalizeGrblLine(cmd: string): string {
  return (
    cmd
      .replace(/\([^)]*\)?/g, "")
      .split(";")[0]
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x20/]/g, "")
      .toUpperCase()
  );
}

/** S1: true for commands that change a controller setting ($N=, $Nx=, $RST=).
 *  A startup block ($N0=...) runs after every reset, so it counts as a write. */
export function isGrblSettingsWrite(cmd: string): boolean {
  const c = normalizeGrblLine(cmd);
  return /^\$\d+=/.test(c) || /^\$N\d*=/.test(c) || /^\$RST=/.test(c);
}

/** S1: a settings write happened — laser mode is unknown until read back. */
function invalidateGrblSettings(): void {
  invalidateGrblSettingsSilently();
  useStore
    .getState()
    .addConsoleLine(
      "Settings changed -- laser mode must be re-verified (Enable Laser Mode, $$ in the console, or reconnect) before starting a job",
      "warning"
    );
}

/** S1 W1: second-side invalidate after a write settles (no warning). A readback
 *  that began before the write reached the wire must not count. */
function invalidateGrblSettingsSilently(): void {
  settingsGeneration++;
  useStore.getState().setGrblLaserMode(false);
}

/**
 * S1: the ONLY code that sets `grblLaserMode` true. True iff the readback
 * carried `$32=1` AND no settings write landed since the readback began.
 * Every other outcome (no $32 line, $32=0, rejected readback, stale
 * generation) ends false.
 */
function applyLaserModeReadback(responses: string[], genAtStart: number): void {
  const store = useStore.getState();
  const readOne = responses.some((l) => /^\$32=1(\.0+)?\s*$/.test(l.trim()));
  const fresh = genAtStart === settingsGeneration;
  store.setGrblLaserMode(readOne && fresh);
  const line32 = responses.find((l) => /^\$32=/.test(l.trim()));
  if (line32) {
    const m = line32.trim().match(/^\$32=([\d.]+)/);
    const value = m ? parseFloat(m[1]) : NaN;
    const verdict =
      readOne && fresh
        ? "enabled"
        : readOne
          ? "readback stale -- a settings write overlapped it; re-verify"
          : "disabled";
    store.addConsoleLine(`$32=${value} (laser mode ${verdict})`, "info");
  }
}

// ---------------------------------------------------------------------------
// S3: bed memory (kerf-f1 b). A bed size the operator confirmed is remembered
// per machine, keyed by the port plus the six settings that define the frame.
// ---------------------------------------------------------------------------

export type BedSource = "machine" | "remembered" | "confirmed" | "session" | null;

const BED_CONFIRMATIONS_KEY = "kerf-bed-confirmations";
const BED_CONFIRMATIONS_CAP = 8;
const BED_KEY_SETTINGS = [3, 23, 100, 101, 130, 131] as const;
const BED_WRITE_RE = /^\$(3|23|100|101|130|131)=|^\$N\d*=|^\$RST=/;

let connectedPort: string | null = null;
let bedKey: string | null = null;
let bedSource: BedSource = null;
const bedSourceListeners = new Set<() => void>();

function markBed(s: BedSource): void {
  bedSource = s;
  for (const cb of bedSourceListeners) cb();
}

/** useSyncExternalStore subscribe for the bed's source. */
export function subscribeBedSource(cb: () => void): () => void {
  bedSourceListeners.add(cb);
  return () => {
    bedSourceListeners.delete(cb);
  };
}

/** useSyncExternalStore snapshot: who set the current bed size. */
export function getBedSource(): BedSource {
  return bedSource;
}

function bedKeyFrom(port: string | null, geo: Map<number, number>): string | null {
  if (port === null || !geo.has(100) || !geo.has(101)) return null;
  const portPart = `port=${port}`;
  return [portPart, ...BED_KEY_SETTINGS.map((k) => `$${k}=${geo.get(k) ?? "-"}`)].join("|");
}

function touchesBedKey(cmd: string): boolean {
  return BED_WRITE_RE.test(normalizeGrblLine(cmd));
}

/** A key-setting write since the last full parse: a confirm is session-only until re-read. */
function forgetBedKeyAfterWrite(): void {
  bedKey = null;
}

/** Disconnect: nothing about this connection's bed survives it. */
function forgetConnectionBed(): void {
  bedKey = null;
}

interface BedEntry {
  key: string;
  w: number;
  h: number;
}

function validBedSize(w: unknown, h: unknown): boolean {
  return (
    typeof w === "number" &&
    typeof h === "number" &&
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    w > 0 &&
    h > 0
  );
}

/** Read every call (never cached): malformed data reads as no entries. */
function readBedEntries(): BedEntry[] {
  try {
    const raw = localStorage.getItem(BED_CONFIRMATIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is BedEntry =>
        e !== null && typeof e === "object" && typeof e.key === "string" && validBedSize(e.w, e.h)
    );
  } catch {
    // Storage unavailable or corrupt JSON: treat as nothing remembered (fail-closed:
    // the operator is asked to confirm).
    return [];
  }
}

function readRememberedBed(key: string): { w: number; h: number } | null {
  const hit = readBedEntries().find((e) => e.key === key);
  return hit ? { w: hit.w, h: hit.h } : null;
}

/** Returns false when storage refused the write; the caller says so (N6). */
function writeRememberedBed(key: string, w: number, h: number): boolean {
  try {
    const rest = readBedEntries().filter((e) => e.key !== key);
    const next = [{ key, w, h }, ...rest].slice(0, BED_CONFIRMATIONS_CAP);
    localStorage.setItem(BED_CONFIRMATIONS_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/** S3 fold 3: a status Kerf has not yet seen is unknown, never fresh. */
function markStatusUnknown(): void {
  const st = useStore.getState();
  st.setStatusStale(true);
  st.setPositionKind(null);
}

// S3 D1: one jog in flight. jogTick moves at submit and at acknowledgement so a
// poll in flight across either edge cannot count as "after the jog".
let jogPending = false;
let jogTick = 0;

async function sendJogLine(line: string): Promise<void> {
  if (jogPending) {
    useStore.getState().addConsoleLine(JOG_REASON_PENDING, "info");
    return;
  }
  jogPending = true;
  jogTick++;
  const responses = await machineConnection.send(line);
  jogTick++;
  if (!responses.includes("ok")) jogPending = false;
}

/**
 * S1: parse a `$$` response set (parse-only; sends nothing). Applies
 * $20-22, $30, $110/111, $120/121, $130/131 as the connect parse always has;
 * $32 is decided by applyLaserModeReadback. Returns true when at least one
 * `$N=V` line parsed.
 */
function parseSettingsResponses(responses: string[], gen: number): boolean {
  const store = useStore.getState();
  let parsedAny = false;
  let accelX = 0,
    accelY = 0;
  let maxFeedRateX = 0,
    maxFeedRateY = 0;
  let maxTravelX = 0,
    maxTravelY = 0;
  const geo = new Map<number, number>();
  for (const line of responses) {
    const match = line.match(/^\$(\d+)=([\d.]+)/);
    if (match) {
      parsedAny = true;
      const key = parseInt(match[1], 10);
      const value = parseFloat(match[2]);
      geo.set(key, value);
      if (key === 20) {
        store.setGrblSoftLimits(value === 1);
        store.addConsoleLine(
          `$20=${value} (soft limits ${value === 1 ? "enabled" : "disabled"})`,
          "info"
        );
      } else if (key === 21) {
        store.setGrblHardLimits(value === 1);
        store.addConsoleLine(
          `$21=${value} (hard limits ${value === 1 ? "enabled" : "disabled"})`,
          "info"
        );
      } else if (key === 22) {
        store.setGrblHoming(value === 1);
        store.addConsoleLine(
          `$22=${value} (homing cycle ${value === 1 ? "enabled" : "disabled"})`,
          "info"
        );
      } else if (key === 30) {
        // C2: firmware always wins (safety); log when it differs from the persisted value
        const prev = store.grblSValueMax;
        if (value !== prev) {
          store.addConsoleLine(`S-value max updated from machine: ${prev} → ${value}`, "info");
        }
        store.setGrblSValueMax(value);
        store.addConsoleLine(`$30=${value} (S-value max)`, "info");
      } else if (key === 110) {
        maxFeedRateX = value;
      } else if (key === 111) {
        maxFeedRateY = value;
      } else if (key === 120) {
        accelX = value;
      } else if (key === 121) {
        accelY = value;
      } else if (key === 130) {
        maxTravelX = value;
      } else if (key === 131) {
        maxTravelY = value;
      }
    }
  }
  // $32: always decided here, so a readback with no $32 line clears the flag.
  applyLaserModeReadback(responses, gen);
  if (accelX > 0 || accelY > 0) {
    store.setGrblAccel(accelX || 500, accelY || 500);
    store.addConsoleLine(`Acceleration: X=${accelX} Y=${accelY} mm/s²`, "info");
  }
  if (maxFeedRateX > 0 && maxFeedRateY > 0) {
    store.setGrblMaxFeedRate(maxFeedRateX, maxFeedRateY);
    store.addConsoleLine(`Max feed rate: X=${maxFeedRateX} Y=${maxFeedRateY} mm/min`, "info");
  }
  bedKey = parsedAny ? bedKeyFrom(connectedPort, geo) : null;
  if (maxTravelX > 0 && maxTravelY > 0) {
    store.setWorkspaceSize(maxTravelX, maxTravelY);
    store.setWorkspaceVerified(true);
    markBed("machine");
    store.addConsoleLine(
      `Workspace set to ${maxTravelX}×${maxTravelY}mm from machine settings`,
      "info"
    );
  } else if (bedKey) {
    const remembered = readRememberedBed(bedKey);
    if (remembered) {
      store.setWorkspaceSize(remembered.w, remembered.h);
      store.setWorkspaceVerified(true);
      markBed("remembered");
      store.addConsoleLine(
        `Using the bed size you confirmed for this machine before: ${remembered.w} × ${remembered.h} mm. Change it in the Machine panel if that's wrong.`,
        "info"
      );
    }
  }
  return parsedAny;
}

export const machineConnection = {
  async listPorts(): Promise<PortInfo[]> {
    try {
      const ports = await invoke<PortInfo[]>("list_serial_ports");
      return sortPortsByPriority(ports);
    } catch (e) {
      console.error("Failed to list ports:", e);
      return [];
    }
  },

  getLastPort(): { name: string; baudRate: number } | null {
    try {
      const name = localStorage.getItem(LAST_PORT_KEY);
      const baud = localStorage.getItem(LAST_BAUD_KEY);
      if (name) return { name, baudRate: baud ? parseInt(baud) : 115200 };
    } catch {
      // localStorage unavailable (private browsing, disabled storage) — non-critical, ignore
    }
    return null;
  },

  async autoConnect(): Promise<boolean> {
    const last = this.getLastPort();
    if (!last) return false;
    const ports = await this.listPorts();
    const exists = ports.find((p) => p.name === last.name);
    if (!exists) return false;
    try {
      await this.connect(last.name, last.baudRate);
      return true;
    } catch {
      return false;
    }
  },

  async connect(portName: string, baudRate: number = 115200): Promise<string> {
    // A7: re-entrancy guard — StrictMode double-mount or rapid button clicks
    // coalesce onto the existing in-flight connect instead of racing a second.
    if (connectingPromise) return connectingPromise;

    const doConnect = async (): Promise<string> => {
      const store = useStore.getState();
      try {
        const response = await invoke<string>("serial_connect", {
          portName,
          baudRate,
        });
        store.setMachineConnected(true);
        connectedPort = portName;
        markStatusUnknown();
        // Reset spindle-drop diagnostic state so a stale value from a previous
        // connection doesn't produce a spurious warning on the first poll.
        resetSpindleDrop();
        // B2b: reset the snapshot consumer's epoch/seq watermark so stale
        // snapshots from a previous connection are not silently accepted.
        resetStatusConsumer();
        // NOTE: machineState is set below after a real status query (companion fix
        // for BUG 3). We set "idle" here as a safe initial value so the UI is never
        // left in "disconnected" while the status query is in-flight.
        store.setMachineState("idle");
        store.addConsoleLine(response, "received");

        try {
          localStorage.setItem(LAST_PORT_KEY, portName);
          localStorage.setItem(LAST_BAUD_KEY, String(baudRate));
        } catch {
          // localStorage unavailable (private browsing, disabled storage) — non-critical, ignore
        }

        // DTR hardware-reset + 0x18 soft-reset now happen in Rust during
        // serial_connect, before it returns. No TS-side reset needed.

        // A7: clear any leaked intervals/subscriptions from a prior connect
        // (e.g. reconnect after a 3-strike disconnect) BEFORE reassigning.
        if (statusPollInterval) {
          clearInterval(statusPollInterval);
          statusPollInterval = null;
        }
        if (unsubscribeJobRunning) {
          unsubscribeJobRunning();
          unsubscribeJobRunning = null;
        }

        // Start status polling
        statusPollInterval = setInterval(() => this.pollStatus(), 250);

        // Suspend polling automatically when a job is running to prevent
        // the status '?' query from interleaving with G-code commands on
        // the shared serial port mutex, which causes garbled responses.
        unsubscribeJobRunning = useStore.subscribe((state) => {
          jobPollingSuspended = state.jobRunning;
        });

        // F14: the post-connect settings sequence lives HERE so it is structurally
        // impossible to connect without it. autoConnect used to skip it entirely:
        // sValueMax stayed 1000 on a $30=255 machine (4x overpower), no laser-mode
        // warning, default workspace. Both entry paths now produce identical output.
        const settingsVerified = await this.queryGrblSettings();

        // BUG 3 companion fix: query the real machine state immediately after
        // connect so the UI reflects ALARM (or any other state) before the first
        // 250ms poll fires. This closes the window where the UI shows "idle" while
        // the machine is actually locked.
        try {
          const initOutcome = await invoke<StatusOutcome>("serial_get_status");
          // consumeStatusOutcome handles event surfacing — no separate loop
          // to avoid double surfacing.
          consumeStatusOutcome(initOutcome);
          if (initOutcome.snapshot) {
            const storeState = machineStateToStore(initOutcome.snapshot.state);
            if (storeState === "alarm") {
              store.addConsoleLine(
                "Machine is in ALARM state — Home ($H) or Unlock ($X) before starting a job.",
                "warning"
              );
            }
          }
        } catch {
          // Non-fatal: pollStatus will correct the state within 250ms.
        }

        if (settingsVerified) {
          // $32 warning ONLY on a successful $$ parse: grblLaserMode defaults
          // false, so warning off the default after a failed query would be a
          // spurious alarm.
          if (!useStore.getState().grblLaserMode) {
            store.addConsoleLine(
              "GRBL laser mode ($32) is disabled. Laser will not auto-zero at speed changes. Run $32=1 in the console to enable.",
              "warning"
            );
          }
        } else {
          store.addConsoleLine(
            "Machine settings unverified -- using defaults. Run $$ in the console to retry.",
            "warning"
          );
        }

        return response;
      } catch (e) {
        const msg = String(e);
        store.addConsoleLine(`Connection failed: ${msg}`, "error");
        throw categorizeConnectionError(msg);
      }
    }; // end doConnect

    // A7: set the coalescing promise; clear on settle (success or failure).
    connectingPromise = doConnect().finally(() => {
      connectingPromise = null;
    });
    return connectingPromise;
  },

  async disconnect(): Promise<void> {
    const store = useStore.getState();

    // A2: disconnect beam-on safety — if a job is active or the machine is in
    // a motion state, fire emergencyStop BEFORE teardown so the laser is
    // de-energized. setJobRunning(false) first so the streaming loop exits
    // on its next iteration and skips its own safety volley (we handle it).
    const needsEstop =
      store.jobRunning || store.machineState === "run" || store.machineState === "hold";
    if (needsEstop) {
      store.setJobRunning(false);
      try {
        await this.emergencyStop();
      } catch {
        // E-stop failed (port already gone) — proceed with teardown.
        // emergencyStop already logged the failure to the console.
      }
    }

    try {
      if (statusPollInterval) {
        clearInterval(statusPollInterval);
        statusPollInterval = null;
      }
      if (unsubscribeJobRunning) {
        unsubscribeJobRunning();
        unsubscribeJobRunning = null;
      }
      jobPollingSuspended = false;
      // S1 N3: a previous controller's laser-mode TRUE never survives.
      store.setGrblLaserMode(false);
      // S3: nor does its bed, its status freshness, or a jog in flight.
      store.setWorkspaceVerified(false);
      markStatusUnknown();
      connectedPort = null;
      forgetConnectionBed();
      markBed(null);
      jogPending = false;
      await invoke("serial_disconnect", { jobActive: needsEstop });
      store.setMachineConnected(false);
      // Tail clear: a job-running flag must never outlive the connection,
      // whatever set it while the teardown was in progress.
      store.setJobRunning(false);
      store.setMachineState("disconnected");
      resetStatusConsumer();
      store.addConsoleLine("Disconnected", "info");
    } catch (e) {
      store.setJobRunning(false);
      console.error("Disconnect error:", e);
    }
  },

  /**
   * Send one line and pump to its terminal. `opts.jobEpoch` marks a JOB line:
   * the backend admits it only while that job is admitted (RF-15). Console,
   * `$H`, jog and settings writes omit it and are unchanged on the wire.
   * A refusal returns `[<refusal string>]` (never `error:disconnected`).
   */
  async send(command: string, opts?: { jobEpoch?: number }): Promise<string[]> {
    const store = useStore.getState();
    try {
      store.addConsoleLine(command, "sent");
      // S1: the one settings-write chokepoint — invalidate before the write.
      const isWrite = isGrblSettingsWrite(command);
      if (isWrite) invalidateGrblSettings();
      if (isWrite && touchesBedKey(command)) forgetBedKeyAfterWrite();
      // S1: a `$$` re-verifies; capture the generation BEFORE the invoke.
      const isReadback = command.trim() === "$$";
      const readbackGen = settingsGeneration;
      const args =
        opts?.jobEpoch === undefined ? { command } : { command, jobEpoch: opts.jobEpoch };
      let outcome: SendOutcome;
      try {
        outcome = await invoke<SendOutcome>("serial_send", args);
      } finally {
        // S1 W1: invalidate again once the write has settled.
        if (isWrite) invalidateGrblSettingsSilently();
      }
      for (const d of outcome.drained) surfaceUnsolicited(d);
      let lastStatusReport: string | null = null;
      for (const r of outcome.responses) {
        if (r.startsWith("<")) {
          // In-pump status reports: filter from console (a 60s segment would
          // flood it at ~1/sec) — keep the most recent for the DRO below.
          noteSpindleSample(r);
          lastStatusReport = r;
          continue;
        }
        // F17 Fix 2.2: ALARM lines are protocol errors, not "received" chatter.
        const type =
          r.startsWith("error:") || r.startsWith("ALARM")
            ? ("error" as const)
            : ("received" as const);
        store.addConsoleLine(r, type);
      }
      // In-pump reports refresh POSITION ONLY — never machineState: a stale
      // <Hold…> consumed after resume would re-arm the job loop's pause-wait
      // with polling suspended (permanently wedged job).
      if (lastStatusReport) {
        // F19: accept both MPos and WPos for $10=0 machines
        const m = lastStatusReport.match(/[MW]Pos:([-\d.]+),([-\d.]+),([-\d.]+)/);
        if (m) {
          store.setMachinePosition({
            x: parseFloat(m[1]),
            y: parseFloat(m[2]),
            z: parseFloat(m[3]),
          });
        }
      }
      // S1 W3: a console/dialog `$$` applies the $32 readback only; the full
      // settings parse runs only via queryGrblSettings().
      if (isReadback) applyLaserModeReadback(outcome.responses, readbackGen);
      return outcome.responses;
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith(PERMIT_REFUSED_PREFIX)) {
        // RF-15: an admission refusal is not a dead port. Not-admitted lines
        // were never written; any other `refused:` string is unknown to the
        // contract and is logged verbatim.
        if (msg.startsWith(`${PERMIT_REFUSED_PREFIX} not-admitted:`)) {
          store.addConsoleLine(`Not sent: ${msg}`, "error");
        } else {
          store.addConsoleLine(msg, "error");
        }
        return [msg];
      }
      store.addConsoleLine(`Send failed: ${msg}`, "error");
      return ["error:disconnected"];
    }
  },

  async sendByte(byte: number): Promise<void> {
    try {
      await invoke("serial_send_byte", { byte });
    } catch (e) {
      console.error("Send byte error:", e);
      // Re-throw so callers (e.g. feedHold, cycleResume) can detect failures
      // and surface an honest warning instead of degrading silently.
      throw e;
    }
  },

  /** One bounded status query. Returns the raw `<…>` report, or `""` when the
   * command lock was busy or the bounded read expired (Ok-typed sentinel from
   * Rust — never a thrown error, so it can never feed the 3-strike counter). */
  async getStatusReport(): Promise<string> {
    const outcome = await invoke<StatusOutcome>("serial_get_status");
    for (const e of outcome.events) surfaceUnsolicited(e);
    if (outcome.status.startsWith("<")) noteSpindleSample(outcome.status);
    return outcome.status;
  },

  async pollStatus(): Promise<void> {
    const store = useStore.getState();
    // F19: guard against stacking — if disconnected, clear the interval and bail.
    if (!store.machineConnected) {
      if (statusPollInterval) {
        clearInterval(statusPollInterval);
        statusPollInterval = null;
      }
      return;
    }
    if (jobPollingSuspended) return;

    const tickAtInvoke = jogTick;
    try {
      const outcome = await invoke<StatusOutcome>("serial_get_status");
      // Busy/none sentinel included: the strike counter RESETS on it — the
      // command lock being held (e.g. a 30s $H pump) proves the port path is
      // alive; a genuinely dead port surfaces as a write failure (rejection).
      consecutivePollFailures = 0;

      // B2b: delegate to the validated snapshot consumer. It handles:
      // - Monotonic epoch/seq rejection
      // - State/position/WCO/spindle/feed/accessory writes to the store
      // - Event surfacing (ALARM, MSG)
      // - Nonfinite value rejection
      const accepted = consumeStatusOutcome(outcome);

      // B2b: update the statusStale store field from isStatusEligible().
      // This drives the canStartJob gate (3s eligibility rule).
      store.setStatusStale(!isStatusEligible());

      // S3 D1: only a real Idle report from a poll begun after the jog's
      // acknowledgement releases it. Busy/no-response writes no state, so the
      // store's machineState is never consulted here.
      const noJogOverlap = tickAtInvoke === jogTick;
      const realReport = outcome.kind === "report" && outcome.snapshot !== null;
      const reportedIdle = realReport && machineStateToStore(outcome.snapshot!.state) === "idle";
      if (accepted && jogPending && noJogOverlap && reportedIdle) jogPending = false;

      // Spindle-drop evidence (status only); fed here when no job is running.
      if (accepted && outcome.snapshot) {
        const snap = outcome.snapshot;
        noteSpindleSample({
          state: typeof snap.state === "string" ? snap.state : null,
          feed: snap.feed,
          spindle: snap.spindle,
        });
      }
    } catch {
      consecutivePollFailures++;
      if (consecutivePollFailures >= 3) {
        store.setMachineConnected(false);
        store.setMachineState("disconnected");
        store.addConsoleLine("Connection lost — check USB cable", "error");
        if (store.jobRunning) {
          store.setJobRunning(false);
          store.addConsoleLine("Job aborted due to disconnect", "error");
        }
        this.disconnect();
        consecutivePollFailures = 0;
      }
    }
  },

  async jog(axis: string, distance: number, feedRate: number = 1000): Promise<void> {
    const store = useStore.getState();
    const blocked = jogBlockReason(store, "by");
    if (blocked) {
      store.addConsoleLine(blocked, "warning");
      return;
    }
    const ax = axis.toUpperCase();
    if (ax !== "X" && ax !== "Y") {
      store.addConsoleLine(JOG_REASON_AXIS, "warning");
      return;
    }
    const clip = clipJog({
      axis: ax,
      distance,
      position: ax === "X" ? store.machinePosition.x : store.machinePosition.y,
      bed: ax === "X" ? store.workspaceWidth : store.workspaceHeight,
      originTop: store.originTop,
    });
    if (clip.kind === "refuse") {
      store.addConsoleLine(clip.reason, "warning");
      return;
    }
    await sendJogLine(`$J=G21 G91 ${ax}${clip.distance.toFixed(3)} F${feedRate}`);
  },

  async jogTo(x: number, y: number, feedRate: number = 3000): Promise<void> {
    const store = useStore.getState();
    const blocked = jogBlockReason(store, "to");
    if (blocked) {
      store.addConsoleLine(blocked, "warning");
      return;
    }
    if (!targetInEnvelope(x, y, store.workspaceWidth, store.workspaceHeight, store.originTop)) {
      store.addConsoleLine(JOG_REASON_TARGET, "warning");
      return;
    }
    await sendJogLine(`$J=G21 G90 X${x.toFixed(3)} Y${y.toFixed(3)} F${feedRate}`);
  },

  /** Cooperative cancel for a buffered streaming job. Sets the Rust-side abort
   * flag which the pump checks on each iteration. This is NOT the e-stop path. */
  async abortJob(): Promise<void> {
    try {
      await invoke("serial_abort_job");
    } catch (e) {
      console.error("Abort job error:", e);
    }
  },

  async home(): Promise<void> {
    const responses = await this.send("$H");
    // A successful homing cycle returns "ok"; ALARM/error responses leave machineHomed false.
    const success = responses.some((r) => r === "ok");
    if (success) {
      useStore.getState().setMachineHomed(true);
    }
  },

  async setOrigin(): Promise<void> {
    const responses = await this.send("G92 X0 Y0");
    const store = useStore.getState();
    const { workCoordOffset } = store;
    const offsetKnown = Number.isFinite(workCoordOffset.x) && Number.isFinite(workCoordOffset.y);
    if (offsetKnown && (workCoordOffset.x !== 0 || workCoordOffset.y !== 0)) {
      store.addConsoleLine(
        `Work origin set. Previous offset was X${workCoordOffset.x.toFixed(3)} Y${workCoordOffset.y.toFixed(3)}. Run G92.1 to clear offset.`,
        "info"
      );
    }
    // No ok: the controller did not take the G92, so the known offset stands.
    if (!responses.includes("ok")) return;
    // N5: only a fresh machine-frame report gives the exact MPos. Otherwise the
    // offset is unknown (NaN, never 0) until the next WCO: field, so jogTo's
    // offset refusal applies instead of a zero it cannot vouch for.
    const trusted = !store.statusStale && store.positionKind === "machine";
    if (!trusted) {
      store.setWorkCoordOffset({ x: NaN, y: NaN });
      return;
    }
    const mpos = store.machinePosition;
    store.setWorkCoordOffset({ x: mpos.x, y: mpos.y }); // S3: G92 X0 Y0 makes WCO equal to MPos
  },

  async softReset(): Promise<void> {
    try {
      await this.sendByte(0x18); // Ctrl+X
    } catch {
      useStore.getState().addConsoleLine("Soft reset send failed", "error");
      return;
    }
    const store = useStore.getState();
    store.addConsoleLine("Soft reset sent", "info");
    await this.pollStatus();
  },

  async feedHold(): Promise<void> {
    try {
      await this.sendByte(0x21); // '!'
    } catch {
      useStore.getState().addConsoleLine("Feed hold send failed", "error");
      return;
    }
    useStore.getState().setMachineState("hold");
  },

  async cycleResume(): Promise<void> {
    try {
      await this.sendByte(0x7e); // '~'
    } catch {
      useStore.getState().addConsoleLine("Cycle resume send failed", "error");
      return;
    }
    useStore.getState().setMachineState("run");
  },

  /**
   * Emergency stop — invokes B1's native `serial_stop` (2026-09-20 DECISIONS ruling).
   *
   * `serial_stop` sends `0x18` immediately: no feed hold, no M5, no ack wait.
   * The Rust side handles single-flight coalescing, cooperative abort, session
   * bookkeeping, and banner observation. This TS wrapper surfaces the result
   * messages to the console and updates the store.
   *
   * The old sequence (`!` → settle → `0x18` → re-poll → conditional M5) is
   * deleted per the ruling: "Abort sends 0x18 immediately — no feed hold,
   * no M5, no ack wait."
   */
  async emergencyStop(): Promise<void> {
    const store = useStore.getState();
    store.addConsoleLine("Emergency stop initiated", "warning");

    try {
      const result = await invoke<{
        outcome: string;
        messages: string[];
        epochBefore?: number;
        epochAfter?: number;
        epoch?: number;
        error?: string;
      }>("serial_stop");

      // Surface every message from the native stop. All messages carry
      // "Beam state unqualified" per the Rust side — honest about what
      // the TS layer cannot know.
      for (const msg of result.messages) {
        const isError = result.outcome === "submissionFailed";
        store.addConsoleLine(msg, isError ? "error" : "warning");
      }

      if (result.outcome === "submissionFailed") {
        store.setMachineState("alarm");
      }
    } catch (e) {
      // invoke rejected — Tauri IPC failure, port already gone, etc.
      store.setMachineState("alarm");
      store.addConsoleLine(
        `E-stop send failed: ${String(e)}. Beam state unqualified — use the machine's physical stop.`,
        "error"
      );
    }
  },

  /** Send $32=1 to enable GRBL laser mode, then read it back. The flag is
   * set only by the readback (applyLaserModeReadback). Returns the flag. */
  async enableLaserMode(): Promise<boolean> {
    const store = useStore.getState();
    try {
      // S1: this write bypasses send(), so invalidate explicitly.
      invalidateGrblSettings();
      store.addConsoleLine("$32=1", "sent");
      let outcome: SendOutcome;
      try {
        outcome = await invoke<SendOutcome>("serial_send", { command: "$32=1" });
      } finally {
        // S1 W1: invalidate again once the write has settled.
        invalidateGrblSettingsSilently();
      }
      for (const d of outcome.drained) surfaceUnsolicited(d);
      await this.readbackGrblSettings({ laserModeOnly: true });
      const enabled = useStore.getState().grblLaserMode;
      if (enabled) {
        store.addConsoleLine("$32=1 — laser mode enabled", "info");
      } else {
        store.addConsoleLine(
          `$32=1 may not have been accepted. Re-check with $$ in the console. Response: ${outcome.responses.join(", ")}; readback did not show $32=1`,
          "warning"
        );
      }
      return enabled;
    } catch (e) {
      store.addConsoleLine(`Failed to enable laser mode: ${e}`, "error");
      return false;
    }
  },

  /** S1: send `$$` and parse it. Does NOT reset homing. A readback that never
   * returned clears laser mode (fail-closed). Returns true when the response
   * parsed as settings. `laserModeOnly` (W3) applies $32 and nothing else. */
  async readbackGrblSettings(opts?: { laserModeOnly?: boolean }): Promise<boolean> {
    const store = useStore.getState();
    const gen = settingsGeneration;
    try {
      store.addConsoleLine("$$", "sent");
      const outcome = await invoke<SendOutcome>("serial_send", { command: "$$" });
      for (const d of outcome.drained) surfaceUnsolicited(d);
      if (opts?.laserModeOnly) {
        applyLaserModeReadback(outcome.responses, gen);
        return outcome.responses.some((l) => /^\$\d+=/.test(l));
      }
      return parseSettingsResponses(outcome.responses, gen);
    } catch (e) {
      applyLaserModeReadback([], gen);
      store.addConsoleLine(`Failed to query GRBL settings: ${e}`, "error");
      return false;
    }
  },

  /** S3 kerf-f1 (b): the operator's bed confirmation, the only writer of the
   *  memory. Returns false (and says why) when the size is refused. */
  confirmBedSize(w: number, h: number): boolean {
    const store = useStore.getState();
    if (!validBedSize(w, h)) {
      store.addConsoleLine(
        "Bed size not set — enter a width and height in mm, both above 0.",
        "error"
      );
      return false;
    }
    store.setWorkspaceSize(w, h);
    store.setWorkspaceVerified(true);
    if (bedKey && writeRememberedBed(bedKey, w, h)) {
      markBed("confirmed");
      store.addConsoleLine(
        `Bed size ${w} × ${h} mm confirmed. Kerf will remember it for this machine.`,
        "info"
      );
    } else if (bedKey) {
      markBed("session");
      store.addConsoleLine(
        `Bed size ${w} × ${h} mm confirmed for this session. Kerf couldn't save it for next time, so it will ask again next time you connect.`,
        "warning"
      );
    } else {
      markBed("session");
      store.addConsoleLine(
        `Bed size ${w} × ${h} mm confirmed for this session. Kerf couldn't read this machine's settings, so it will ask again next time you connect.`,
        "info"
      );
    }
    return true;
  },

  /** Query $$ and apply $30/$32/$120-131. Returns true when the response
   * parsed as settings (at least one `$N=V` line) — the $32 warning and the
   * "unverified" fallback in connect() key off this. */
  async queryGrblSettings(): Promise<boolean> {
    // New connection: machineHomed resets — must home again this session for soft limits
    useStore.getState().setMachineHomed(false);
    return this.readbackGrblSettings();
  },
};

export interface ConnectionError {
  message: string;
  suggestions: string[];
}

function categorizeConnectionError(raw: string): ConnectionError {
  const lower = raw.toLowerCase();

  if (lower.includes("permission") || lower.includes("access denied") || lower.includes("eacces")) {
    return {
      message: "Permission denied on serial port",
      suggestions: [
        "Close other programs using the port (e.g. Arduino IDE)",
        "Check your user has permission to access serial devices",
        "Try unplugging and reconnecting the USB cable",
      ],
    };
  }

  if (
    lower.includes("not found") ||
    lower.includes("no such file") ||
    lower.includes("does not exist")
  ) {
    return {
      message: "Serial port not found",
      suggestions: [
        "Verify USB cable is connected",
        "Try a different USB port",
        "Click Refresh to rescan available ports",
        "Check if the device driver is installed",
      ],
    };
  }

  if (lower.includes("busy") || lower.includes("in use") || lower.includes("resource")) {
    return {
      message: "Port is busy or in use",
      suggestions: [
        "Close other programs using this port (Arduino IDE, PuTTY, etc.)",
        "Unplug and reconnect the USB cable",
        "Try restarting the application",
      ],
    };
  }

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      message: "Connection timed out",
      suggestions: [
        "Verify baud rate is 115200 (standard for GRBL)",
        "Check that the controller is powered on",
        "Try unplugging and reconnecting the USB cable",
      ],
    };
  }

  // Generic fallback
  return {
    message: `Connection failed: ${raw}`,
    suggestions: [
      "Check COM port selection",
      "Verify baud rate (115200 for GRBL)",
      "Confirm USB cable is connected",
      "Try unplugging and reconnecting",
    ],
  };
}

// Test-only reset for the module-level failure counter.
// Not imported anywhere in production code.
export function _testResetPollFailures(): void {
  consecutivePollFailures = 0;
}

// S3 test-only reset: module-level jog-in-flight and bed-memory state would
// otherwise leak between tests that share this module instance.
// Not imported anywhere in production code.
export function _testResetJogAndBedState(): void {
  jogPending = false;
  jogTick = 0;
  connectedPort = null;
  bedKey = null;
  bedSource = null;
}
