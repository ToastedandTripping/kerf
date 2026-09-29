/**
 * Motion trust, TS consumer (relay kerf-safety-motion-trust, B2+B3).
 * T-C1 stale results, T-C2 the gate from snapshot scalars, T-C3 positive
 * control for the suite-wide interception, T-C4 refusal surfacing, T-C6
 * homed only from snapshots, T-C7 provisional invalidation, T-C8 settings
 * generation on disconnect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../../app/store";
import {
  machineConnection,
  _testConnId,
  _testResetJogAndBedState,
  _testResetPollFailures,
  _testSettingsGeneration,
} from "../connection";
import {
  JOG_REASON_HOME,
  JOG_REASON_MOTION,
  JOG_REASON_NO_HOMING,
  JOG_REASON_UNITS,
  jogBlockReason,
} from "../jogBounds";
import { resetStatusConsumer } from "../machineStatus";
import { callsMissingConn } from "./setupConnInvoke";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

type Deferred = {
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};
function deferred(): Deferred {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let seq = 1000;
/** A native status outcome. `trust` fields default to "homed, mm, idle,
 *  observed at this frame's seq". */
function status(
  x: number,
  opts: {
    state?: string;
    connId?: number;
    observedSeq?: number | null;
    homed?: boolean;
    unitsMm?: boolean;
    motionPending?: boolean;
    kind?: string;
  } = {}
) {
  seq++;
  const state = opts.state ?? "Idle";
  const raw = `<${state}|MPos:${x.toFixed(3)},0.000,0.000|FS:0,0>`;
  const observedSeq = opts.observedSeq === undefined ? seq : opts.observedSeq;
  return {
    status: raw,
    events: [],
    kind: opts.kind ?? "report",
    connId: opts.connId ?? _testConnId(),
    snapshot: {
      epoch: 1,
      seq,
      state: state.toLowerCase(),
      positionKind: "MPos",
      position: [x, 0, 0],
      wco: null,
      feed: 0,
      spindle: 0,
      accessory: "Unknown",
      units: "Mm",
      raw,
      unknownFields: [],
      homed: opts.homed ?? true,
      unitsMm: opts.unitsMm ?? true,
      motionPending: opts.motionPending ?? false,
      observedSeq,
      observedPos: observedSeq === null ? null : [x, 0, 0],
    },
  };
}

const SETTINGS = ["$13=0", "$22=1", "$32=1", "$130=205", "$131=300", "ok"];

/** Handlers per command; the default machine answers everything. */
let handlers: Record<string, (args: Record<string, unknown>) => unknown>;
let nextConnId = 1;

function defaultHandlers() {
  handlers = {
    serial_connect: () => ({ banner: "Grbl 1.1h ['$' for help]", connId: nextConnId++ }),
    serial_send: (a) =>
      a.command === "$$"
        ? { responses: SETTINGS, drained: [], connId: a.conn }
        : { responses: ["ok"], drained: [], connId: a.conn },
    serial_get_status: () => status(200),
    serial_send_byte: () => undefined,
    serial_disconnect: () => undefined,
    serial_stop: () => ({ outcome: "confirmed", messages: [] }),
  };
}

async function connect() {
  const p = machineConnection.connect("/dev/ttyUSB0", 115200);
  await vi.advanceTimersByTimeAsync(0);
  await p;
}

function sends(): Array<Record<string, unknown>> {
  return mockInvoke.mock.calls
    .filter((c) => c[0] === "serial_send")
    .map((c) => c[1] as Record<string, unknown>);
}

function jogSends() {
  return sends().filter((a) => String(a.command).startsWith("$J="));
}

function consoleTexts(): string[] {
  return useStore.getState().consoleLines.map((l) => l.text);
}

beforeEach(async () => {
  vi.useFakeTimers(); // no 250 ms poller
  _testResetPollFailures();
  _testResetJogAndBedState();
  resetStatusConsumer();
  mockInvoke.mockReset();
  localStorage.clear();
  nextConnId = 1;
  defaultHandlers();
  mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const h = handlers[cmd];
    return h ? h(args ?? {}) : undefined;
  });
  useStore.setState({
    consoleLines: [],
    machineConnected: false,
    jobRunning: false,
    workCoordOffset: { x: 0, y: 0 },
    originTop: false,
  });
  await connect();
  useStore.setState({ consoleLines: [] });
});

afterEach(async () => {
  await machineConnection.disconnect();
  vi.useRealTimers();
});

// ── T-C1: stale results ───────────────────────────────────────────────────

describe("T-C1: a result or rejection from an earlier connection is discarded", () => {
  async function reconnect() {
    await machineConnection.disconnect();
    await connect();
    expect(_testConnId()).toBe(2);
  }

  it("a late send result writes nothing", async () => {
    const d = deferred();
    handlers.serial_send = () => d.promise;
    const late = machineConnection.send("$G");
    defaultHandlers();
    await reconnect();
    useStore.setState({ consoleLines: [] });
    d.resolve({ responses: ["ALARM:1"], drained: ["ALARM:9"], connId: 1 });
    expect(await late).toEqual([]);
    expect(consoleTexts()).toEqual([]);
  });

  it("control: the same result on the current connection is surfaced", async () => {
    handlers.serial_send = (a) => ({ responses: ["ALARM:1"], drained: [], connId: a.conn });
    expect(await machineConnection.send("$G")).toEqual(["ALARM:1"]);
    expect(consoleTexts()).toContain("ALARM:1");
  });

  it("a result whose connId is not the connection it was sent on is discarded", async () => {
    handlers.serial_send = () => ({ responses: ["ALARM:1"], drained: [], connId: 99 });
    expect(await machineConnection.send("$G")).toEqual([]);
    expect(consoleTexts()).not.toContain("ALARM:1");
    expect(consoleTexts()).toContain("$G"); // positive sibling: the send was logged
  });

  it("a late poll result writes nothing", async () => {
    const d = deferred();
    handlers.serial_get_status = () => d.promise;
    const late = machineConnection.pollStatus();
    defaultHandlers();
    await reconnect();
    const before = useStore.getState().machineState;
    expect(before).toBe("idle");
    d.resolve(status(5, { state: "Alarm", connId: 1 }));
    await late;
    expect(useStore.getState().machineState).toBe("idle");
    expect(useStore.getState().machinePosition.x).toBe(200);
  });

  it("three late poll rejections do not disconnect the new connection", async () => {
    const ds = [deferred(), deferred(), deferred()];
    let i = 0;
    handlers.serial_get_status = () => ds[i++].promise;
    const polls = [
      machineConnection.pollStatus(),
      machineConnection.pollStatus(),
      machineConnection.pollStatus(),
    ];
    defaultHandlers();
    await reconnect();
    for (const d of ds) d.reject("disconnected: port closed");
    await Promise.all(polls);
    expect(useStore.getState().machineConnected).toBe(true);
    expect(consoleTexts().some((t) => t.includes("Connection lost"))).toBe(false);
  });

  it("control: three current-connection poll rejections do disconnect", async () => {
    handlers.serial_get_status = () => Promise.reject("disconnected: port closed");
    for (let k = 0; k < 3; k++) await machineConnection.pollStatus();
    expect(consoleTexts().some((t) => t.includes("Connection lost"))).toBe(true);
  });

  it("a late settings write's finally does not touch the new connection's laser mode", async () => {
    const d = deferred();
    handlers.serial_send = (a) =>
      a.command === "$100=80" ? d.promise : { responses: ["ok"], drained: [], connId: a.conn };
    const late = machineConnection.send("$100=80");
    defaultHandlers();
    await reconnect();
    expect(useStore.getState().grblLaserMode).toBe(true); // the new $$ read $32=1
    d.resolve({ responses: ["ok"], drained: [], connId: 1 });
    await late;
    expect(useStore.getState().grblLaserMode).toBe(true);
  });
});

// ── T-C2: the gate from snapshot scalars ──────────────────────────────────

describe("T-C2: the gate reads native's scalars and the clip reads the basis", () => {
  it("basis X=200, bed 205: +10 sends X5.000 with jogBasis = the observation's seq", async () => {
    const barrier = status(200);
    handlers.serial_get_status = () => barrier;
    await machineConnection.pollStatus();
    const basisSeq = barrier.snapshot.observedSeq;
    expect(useStore.getState().basisSeq).toBe(basisSeq);
    await machineConnection.jog("X", 10);
    expect(jogSends()).toEqual([
      { command: "$J=G21 G91 X5.000 F1000", conn: 1, jogBasis: basisSeq },
    ]);
  });

  it("a later ordinary snapshot (new seq, same observedSeq) keeps the arrows and the basis", async () => {
    const barrier = status(200);
    const basisSeq = barrier.snapshot.observedSeq!;
    handlers.serial_get_status = () => barrier;
    await machineConnection.pollStatus();
    handlers.serial_get_status = () => status(200, { observedSeq: basisSeq });
    await machineConnection.pollStatus();
    const st = useStore.getState();
    expect(st.basisSeq).toBe(basisSeq);
    expect(jogBlockReason(st, "by")).toBeNull();
    await machineConnection.jog("X", 1);
    expect(jogSends()[0].jogBasis).toBe(basisSeq);
  });

  it("the clip reads the basis position, never a later frame's position", async () => {
    const barrier = status(200);
    const basisSeq = barrier.snapshot.observedSeq!;
    handlers.serial_get_status = () => barrier;
    await machineConnection.pollStatus();
    // TS-side property only: native (Razor b23 W2) ends the observation on a
    // frame at a different position, so it never sends this pairing; if it
    // did, TS would still clip from the observation it names, never from the
    // frame. A later frame at the SAME position keeps the basis (test above).
    // A frame at X=0 that still names the X=200 observation as current.
    const later = status(0, { observedSeq: basisSeq });
    later.snapshot.observedPos = [200, 0, 0];
    handlers.serial_get_status = () => later;
    await machineConnection.pollStatus();
    expect(useStore.getState().machinePosition.x).toBe(0);
    await machineConnection.jog("X", 10);
    expect(jogSends()[0].command).toBe("$J=G21 G91 X5.000 F1000");
  });

  it.each([
    ["observedSeq null", { observedSeq: null }, JOG_REASON_MOTION],
    ["motion pending", { motionPending: true }, JOG_REASON_MOTION],
    ["not homed", { homed: false }, JOG_REASON_HOME],
    ["units not mm", { unitsMm: false }, JOG_REASON_UNITS],
  ] as const)("%s disables the arrows with its reason and zero invokes", async (_l, o, reason) => {
    handlers.serial_get_status = () => status(100, o);
    await machineConnection.pollStatus();
    expect(jogBlockReason(useStore.getState(), "by")).toBe(reason);
    mockInvoke.mockClear();
    await machineConnection.jog("X", 1);
    await machineConnection.jogTo(10, 10);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(consoleTexts().filter((t) => t === reason)).toHaveLength(2);
  });

  it("$22=0 refuses with NO_HOMING, zero invokes", async () => {
    await machineConnection.pollStatus();
    useStore.getState().setGrblHoming(false);
    mockInvoke.mockClear();
    await machineConnection.jog("X", 1);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(consoleTexts()).toContain(JOG_REASON_NO_HOMING);
  });

  it("control: a fully trusted snapshot admits", async () => {
    await machineConnection.pollStatus();
    expect(jogBlockReason(useStore.getState(), "by")).toBeNull();
    await machineConnection.jog("X", 1);
    expect(jogSends()).toHaveLength(1);
  });
});

// ── T-C3 positive control ─────────────────────────────────────────────────

describe("T-C3: the suite-wide interception", () => {
  it("names a conn-carrying call that lacks conn, and passes one that has it", () => {
    expect(
      callsMissingConn([
        ["serial_send", { command: "$G" }],
        ["serial_send_byte", { byte: 24 }],
        ["serial_get_status", undefined],
        ["serial_send", { command: "$G", conn: 3 }],
        ["serial_stop", {}],
      ])
    ).toHaveLength(3);
    expect(callsMissingConn([["serial_get_status", { conn: 0 }]])).toEqual([]);
  });

  it("every production invoke in this file carried conn (sendByte, getStatusReport too)", async () => {
    await machineConnection.sendByte(0x21);
    await machineConnection.getStatusReport();
    await machineConnection.readbackGrblSettings();
    expect(callsMissingConn(mockInvoke.mock.calls as unknown[][])).toEqual([]);
    const byte = mockInvoke.mock.calls.find((c) => c[0] === "serial_send_byte");
    expect(byte?.[1]).toEqual({ conn: 1, byte: 0x21 });
  });
});

// ── T-C4: a native refusal is a plain reason, not retried ─────────────────

describe("T-C4: native refusals", () => {
  it("a jog refusal prints its plain reason once and is not retried", async () => {
    await machineConnection.pollStatus();
    handlers.serial_send = () =>
      Promise.reject(
        "refused: not-homed: Home the machine ($H) before jogging. Kerf jogs only from a completed Home."
      );
    await machineConnection.jog("X", 1);
    expect(jogSends()).toHaveLength(1);
    expect(consoleTexts()).toContain(
      "Not sent: Home the machine ($H) before jogging. Kerf jogs only from a completed Home."
    );
    expect(consoleTexts().some((t) => t.startsWith("Send failed"))).toBe(false);
    // Provisional revoke: the arrows show HOME at once.
    expect(jogBlockReason(useStore.getState(), "by")).toBe(JOG_REASON_HOME);
  });

  it("a malformed refusal reads as advice, and whitespace around a command is trimmed first", async () => {
    await machineConnection.send("  $G\t\n");
    expect(sends()[sends().length - 1]?.command).toBe("$G");
    handlers.serial_send = () =>
      Promise.reject("refused: malformed: control byte (0x09). Nothing was sent. Retype it.");
    await machineConnection.send("G0\tX1");
    expect(consoleTexts()).toContain("Not sent: Control byte (0x09). Nothing was sent. Retype it.");
  });
});

// ── T-C6: homed only from snapshots ───────────────────────────────────────

describe("T-C6: setMachineHomed does not exist", () => {
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) sourceFiles(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }

  // Razor b23 N4: the walk takes ~30 ms alone but >5 s under a concurrent
  // cargo build; an explicit generous timeout keeps a battery "kill" from
  // being a timeout.
  it("no source file calls or defines it", () => {
    const needle = ["setMachine", "Homed("].join("");
    const files = sourceFiles(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThan(50);
    const hits = files.filter((f) => readFileSync(f, "utf8").includes(needle));
    expect(hits).toEqual([]);
    // Positive sibling: the alias exists and follows the native scalar.
    useStore.getState().setTrust({ trustHomed: true });
    expect(useStore.getState().machineHomed).toBe(true);
    useStore.getState().setTrust({ trustHomed: false });
    expect(useStore.getState().machineHomed).toBe(false);
  }, 60_000);
});

// ── T-C7: provisional invalidation ────────────────────────────────────────

describe("T-C7: TS makes the display more conservative at once", () => {
  it("emergencyStop disables the arrows (HOME) with no snapshot; a homed:false snapshot keeps them off", async () => {
    await machineConnection.pollStatus();
    expect(jogBlockReason(useStore.getState(), "by")).toBeNull();
    handlers.serial_stop = () => new Promise(() => {}); // never settles
    void machineConnection.emergencyStop();
    expect(jogBlockReason(useStore.getState(), "by")).toBe(JOG_REASON_HOME);
    handlers.serial_get_status = () => status(100, { homed: false });
    await machineConnection.pollStatus();
    expect(jogBlockReason(useStore.getState(), "by")).toBe(JOG_REASON_HOME);
  });

  it("softReset disables the arrows at once", async () => {
    await machineConnection.pollStatus();
    handlers.serial_send_byte = () => new Promise(() => {});
    void machineConnection.softReset();
    expect(jogBlockReason(useStore.getState(), "by")).toBe(JOG_REASON_HOME);
  });

  it("a motion send shows MOTION at its entry, before native answers", async () => {
    await machineConnection.pollStatus();
    const d = deferred();
    handlers.serial_send = () => d.promise;
    const p = machineConnection.send("G91 G0 X1");
    expect(jogBlockReason(useStore.getState(), "by")).toBe(JOG_REASON_MOTION);
    d.resolve({ responses: ["ok"], drained: [], connId: 1 });
    await p;
  });

  it("control: a non-motion send does not", async () => {
    await machineConnection.pollStatus();
    const d = deferred();
    handlers.serial_send = () => d.promise;
    const p = machineConnection.send("$G");
    expect(jogBlockReason(useStore.getState(), "by")).toBeNull();
    d.resolve({ responses: ["ok"], drained: [], connId: 1 });
    await p;
  });
});

// ── T-C8: settings generation on disconnect ───────────────────────────────

describe("T-C8", () => {
  it("disconnect bumps the settings generation", async () => {
    const g = _testSettingsGeneration();
    await machineConnection.disconnect();
    expect(_testSettingsGeneration()).toBe(g + 1);
    expect(_testConnId()).toBe(0);
  });
});

// ── Fix pass (Razor b23 N1): the remaining stale and provisional sites ────

describe("Razor b23 N1 pins", () => {
  async function reconnect() {
    await machineConnection.disconnect();
    await connect();
  }

  it("tz1: a late send() rejection on the new connection is dropped whole", async () => {
    await machineConnection.pollStatus();
    const d = deferred();
    handlers.serial_send = () => d.promise;
    const late = machineConnection.send("$G");
    defaultHandlers();
    await reconnect();
    await machineConnection.pollStatus();
    useStore.setState({ consoleLines: [] });
    d.reject("disconnected: port closed");
    expect(await late).toEqual([]);
    expect(consoleTexts()).toEqual([]);
    expect(useStore.getState().trustHomed).toBe(true); // no provisional revoke
  });

  it("tz11: a plain (non-refused) rejection on the current connection revokes homed", async () => {
    await machineConnection.pollStatus();
    handlers.serial_send = () => Promise.reject("disconnected: port closed");
    expect(await machineConnection.send("$G")).toEqual(["error:disconnected"]);
    expect(jogBlockReason(useStore.getState(), "by")).toBe(JOG_REASON_HOME);
  });

  it("tz9: jogTo sends { command, conn, jogBasis: basisSeq }", async () => {
    const barrier = status(100);
    handlers.serial_get_status = () => barrier;
    await machineConnection.pollStatus();
    await machineConnection.jogTo(10, 20);
    expect(jogSends()).toEqual([
      {
        command: "$J=G21 G90 X10.000 Y20.000 F3000",
        conn: 1,
        jogBasis: barrier.snapshot.observedSeq,
      },
    ]);
  });

  it("tz8: a snapshot without motionPending reads as pending (MOTION)", async () => {
    const s = status(100) as { snapshot: Record<string, unknown> };
    delete s.snapshot.motionPending;
    handlers.serial_get_status = () => s;
    await machineConnection.pollStatus();
    expect(useStore.getState().motionPending).toBe(true);
    expect(jogBlockReason(useStore.getState(), "by")).toBe(JOG_REASON_MOTION);
  });

  it("tz5/tz10: a late $32=1 neither settles the new connection's laser mode nor reads back", async () => {
    const d = deferred();
    handlers.serial_send = (a) =>
      a.command === "$32=1" ? d.promise : { responses: SETTINGS, drained: [], connId: a.conn };
    const late = machineConnection.enableLaserMode();
    defaultHandlers();
    await reconnect();
    expect(useStore.getState().grblLaserMode).toBe(true);
    const readbacksBefore = sends().filter((a) => a.command === "$$").length;
    d.resolve({ responses: ["ok"], drained: [], connId: 1 });
    expect(await late).toBe(false);
    expect(useStore.getState().grblLaserMode).toBe(true);
    expect(sends().filter((a) => a.command === "$$").length).toBe(readbacksBefore);
  });

  it("tz2: a connect init poll for another connection writes nothing", async () => {
    await machineConnection.disconnect();
    handlers.serial_get_status = () => status(5, { state: "Alarm", connId: 99 });
    await connect();
    expect(useStore.getState().machineState).toBe("idle");
    expect(consoleTexts().some((t) => t.includes("ALARM state"))).toBe(false);
  });

  it("tz3: a readback result for another connection is dropped", async () => {
    useStore.getState().setGrblLaserMode(false);
    handlers.serial_send = () => ({ responses: SETTINGS, drained: [], connId: 99 });
    expect(await machineConnection.readbackGrblSettings()).toBe(false);
    expect(useStore.getState().grblLaserMode).toBe(false);
  });

  it("tz4: a late readback rejection does not clear the new connection's laser mode", async () => {
    const d = deferred();
    handlers.serial_send = () => d.promise;
    const late = machineConnection.readbackGrblSettings();
    defaultHandlers();
    await reconnect();
    expect(useStore.getState().grblLaserMode).toBe(true);
    useStore.setState({ consoleLines: [] });
    d.reject("disconnected: port closed");
    expect(await late).toBe(false);
    expect(useStore.getState().grblLaserMode).toBe(true);
    expect(consoleTexts()).toEqual([]);
  });

  it("tz6: getStatusReport drops a result for another connection", async () => {
    handlers.serial_get_status = () => status(5, { connId: 99 });
    expect(await machineConnection.getStatusReport()).toBe("");
    handlers.serial_get_status = () => status(5);
    expect(await machineConnection.getStatusReport()).toMatch(/^<Idle/);
  });
});
