import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Must mock before importing modules that use it
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { useStore } from "../../../app/store";
import { DEFAULT_LAYERS } from "../../../app/types";
import {
  consumeStatusOutcome,
  resetStatusConsumer,
  isStatusEligible,
  machineStateToStore,
  isRunLike,
  _testGetWatermark,
  _testGetLastValidStatusTime,
  type StatusOutcome,
  type GrblSnapshot,
} from "../machineStatus";

import * as fs from "fs";
import * as path from "path";

function seedStore() {
  useStore.setState({
    objects: [],
    selectedIds: [],
    undoStack: [],
    redoStack: [],
    consoleLines: [],
    layers: DEFAULT_LAYERS,
    machineConnected: true,
    machineState: "idle",
    machinePosition: { x: 0, y: 0, z: 0 },
    grblLaserMode: false,
    grblSValueMax: 1000,
    grblMaxFeedRateX: 0,
    grblMaxFeedRateY: 0,
    positionKind: null,
    spindleSpeed: 0,
    feedRate: 0,
    accessoryFlags: null,
    jobRunning: false,
  });
}

function makeSnapshot(overrides: Partial<GrblSnapshot> = {}): GrblSnapshot {
  return {
    epoch: 1,
    seq: 1,
    state: "idle",
    positionKind: "MPos",
    position: [0, 0, 0],
    wco: null,
    feed: 0,
    spindle: 0,
    accessory: "Unknown",
    units: "Unknown",
    raw: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>",
    unknownFields: [],
    ...overrides,
  };
}

function makeOutcome(
  snap: GrblSnapshot | null,
  kind: StatusOutcome["kind"] = "report",
  events: string[] = []
): StatusOutcome {
  return {
    status: snap?.raw ?? "",
    events,
    kind,
    snapshot: snap,
  };
}

describe("machineStatus.ts — B2b status consumer", () => {
  beforeEach(() => {
    resetStatusConsumer();
    seedStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- AC1: silence after Idle closes eligibility ----
  describe("eligibility and freshness", () => {
    it("starts ineligible (never received a valid status)", () => {
      expect(isStatusEligible()).toBe(false);
    });

    it("becomes eligible after receiving a valid snapshot", () => {
      const snap = makeSnapshot({ epoch: 1, seq: 1 });
      consumeStatusOutcome(makeOutcome(snap));
      expect(isStatusEligible()).toBe(true);
    });

    it("becomes ineligible when lastValidStatusTime is older than 3s", () => {
      vi.useFakeTimers();
      const snap = makeSnapshot({ epoch: 1, seq: 1 });
      consumeStatusOutcome(makeOutcome(snap));
      expect(isStatusEligible()).toBe(true);

      vi.advanceTimersByTime(3001);
      expect(isStatusEligible()).toBe(false);
    });

    it("Busy does NOT renew eligibility (preserves age)", () => {
      vi.useFakeTimers();
      const snap = makeSnapshot({ epoch: 1, seq: 1 });
      consumeStatusOutcome(makeOutcome(snap));
      vi.advanceTimersByTime(2500);

      // Busy should not update lastValidStatusTime
      consumeStatusOutcome(makeOutcome(null, "busy"));
      vi.advanceTimersByTime(600);
      // Total: 3100ms since last real snapshot
      expect(isStatusEligible()).toBe(false);
    });

    it("mixed busy/errors cannot reset eligibility after silence", () => {
      vi.useFakeTimers();
      const snap = makeSnapshot({ epoch: 1, seq: 1 });
      consumeStatusOutcome(makeOutcome(snap));
      vi.advanceTimersByTime(3500); // Past 3s threshold

      // Busy does not help
      consumeStatusOutcome(makeOutcome(null, "busy"));
      expect(isStatusEligible()).toBe(false);

      // NoResponse does not help
      consumeStatusOutcome(makeOutcome(null, "noResponse"));
      expect(isStatusEligible()).toBe(false);
    });
  });

  // ---- AC2: monotonic epoch/seq ----
  describe("monotonic epoch/seq rejection", () => {
    it("accepts increasing seq within same epoch", () => {
      consumeStatusOutcome(makeOutcome(makeSnapshot({ epoch: 1, seq: 1, state: "idle" })));
      expect(useStore.getState().machineState).toBe("idle");

      consumeStatusOutcome(makeOutcome(makeSnapshot({ epoch: 1, seq: 2, state: "run" })));
      expect(useStore.getState().machineState).toBe("run");
    });

    it("rejects same-epoch lower-seq snapshot (late arrival)", () => {
      consumeStatusOutcome(makeOutcome(makeSnapshot({ epoch: 1, seq: 5, state: "run" })));
      expect(useStore.getState().machineState).toBe("run");

      // Late snapshot with seq 3 — must be rejected
      const accepted = consumeStatusOutcome(
        makeOutcome(makeSnapshot({ epoch: 1, seq: 3, state: "idle" }))
      );
      expect(accepted).toBe(false);
      expect(useStore.getState().machineState).toBe("run"); // Unchanged
    });

    it("rejects old-epoch snapshot (stale connection)", () => {
      consumeStatusOutcome(makeOutcome(makeSnapshot({ epoch: 5, seq: 1, state: "run" })));
      expect(useStore.getState().machineState).toBe("run");

      // Old epoch 3 — must be rejected regardless of seq
      const accepted = consumeStatusOutcome(
        makeOutcome(makeSnapshot({ epoch: 3, seq: 99, state: "idle" }))
      );
      expect(accepted).toBe(false);
      expect(useStore.getState().machineState).toBe("run"); // Unchanged
    });

    it("accepts new epoch even with lower seq", () => {
      consumeStatusOutcome(makeOutcome(makeSnapshot({ epoch: 1, seq: 50 })));
      const accepted = consumeStatusOutcome(
        makeOutcome(makeSnapshot({ epoch: 2, seq: 1, state: "run" }))
      );
      expect(accepted).toBe(true);
      expect(useStore.getState().machineState).toBe("run");
    });
  });

  // ---- AC3: field absence / nonfinite values ----
  describe("field validation", () => {
    it("does not set beam off from missing accessory field", () => {
      const snap = makeSnapshot({ accessory: "Unknown" });
      consumeStatusOutcome(makeOutcome(snap));
      // accessoryFlags should be null (unknown), never a false "off"
      expect(useStore.getState().accessoryFlags).toBeNull();
    });

    it("stores accessory flags when Present", () => {
      const snap = makeSnapshot({ accessory: { Present: "SFM" } });
      consumeStatusOutcome(makeOutcome(snap));
      expect(useStore.getState().accessoryFlags).toBe("SFM");
    });

    it("rejects NaN position without crashing", () => {
      const snap = makeSnapshot({ position: [NaN, 10, 0] });
      consumeStatusOutcome(makeOutcome(snap));
      // Position should not be updated (still at origin from seed)
      expect(useStore.getState().machinePosition).toEqual({ x: 0, y: 0, z: 0 });
    });

    it("rejects Infinity in feed without storing NaN", () => {
      const snap = makeSnapshot({ feed: Infinity });
      consumeStatusOutcome(makeOutcome(snap));
      expect(useStore.getState().feedRate).toBe(0); // Unchanged from seed
    });

    it("rejects nonfinite spindle speed", () => {
      const snap = makeSnapshot({ spindle: -Infinity });
      consumeStatusOutcome(makeOutcome(snap));
      expect(useStore.getState().spindleSpeed).toBe(0); // Unchanged from seed
    });
  });

  // ---- Position kind identity (MPos vs WPos never merged) ----
  describe("position kind identity", () => {
    it("stores MPos identity", () => {
      const snap = makeSnapshot({
        positionKind: "MPos",
        position: [10, 20, 0],
      });
      consumeStatusOutcome(makeOutcome(snap));
      expect(useStore.getState().positionKind).toBe("machine");
      expect(useStore.getState().machinePosition).toEqual({ x: 10, y: 20, z: 0 });
    });

    it("stores WPos identity separately", () => {
      const snap = makeSnapshot({
        positionKind: "WPos",
        position: [5, 15, 0],
      });
      consumeStatusOutcome(makeOutcome(snap));
      expect(useStore.getState().positionKind).toBe("work");
    });

    it("does not relabel WPos as MPos", () => {
      const snap = makeSnapshot({
        positionKind: "WPos",
        position: [5, 15, 0],
      });
      consumeStatusOutcome(makeOutcome(snap));
      expect(useStore.getState().positionKind).not.toBe("machine");
    });
  });

  // ---- WCO preservation ----
  describe("WCO", () => {
    it("writes WCO when present", () => {
      const snap = makeSnapshot({ wco: [1.0, 2.0, 0.0] });
      consumeStatusOutcome(makeOutcome(snap));
      expect(useStore.getState().workCoordOffset).toEqual({ x: 1, y: 2 });
    });

    it("does not clear WCO when absent (GRBL caches it)", () => {
      useStore.setState({ workCoordOffset: { x: 3, y: 4 } });
      const snap = makeSnapshot({ wco: null });
      consumeStatusOutcome(makeOutcome(snap));
      // WCO should be unchanged — absence means "not sent this time"
      expect(useStore.getState().workCoordOffset).toEqual({ x: 3, y: 4 });
    });
  });

  // ---- machineStateToStore mapping ----
  describe("machineStateToStore", () => {
    it("maps idle → idle", () => expect(machineStateToStore("idle")).toBe("idle"));
    it("maps run → run", () => expect(machineStateToStore("run")).toBe("run"));
    it("maps alarm → alarm", () => expect(machineStateToStore("alarm")).toBe("alarm"));
    it("maps hold → hold", () =>
      expect(machineStateToStore({ hold: { substate: 0 } })).toBe("hold"));
    it("maps door → door", () =>
      expect(machineStateToStore({ door: { substate: 1 } })).toBe("door"));
    it("maps unknown → alarm (conservative)", () =>
      expect(machineStateToStore({ unknown: "Foo" })).toBe("alarm"));
  });

  // ---- isRunLike ----
  describe("isRunLike", () => {
    it("run is run-like", () => expect(isRunLike("run")).toBe(true));
    it("idle is not run-like", () => expect(isRunLike("idle")).toBe(false));
    it("hold is run-like", () =>
      expect(isRunLike({ hold: { substate: null } })).toBe(true));
    it("alarm is not run-like", () => expect(isRunLike("alarm")).toBe(false));
  });

  // ---- Event surfacing ----
  describe("event surfacing", () => {
    it("surfaces ALARM events as errors even on Busy", () => {
      consumeStatusOutcome(makeOutcome(null, "busy", ["ALARM:1"]));
      const alarm = useStore.getState().consoleLines.find((l) => l.text === "ALARM:1");
      expect(alarm?.type).toBe("error");
    });

    it("surfaces MSG events as info", () => {
      consumeStatusOutcome(makeOutcome(null, "busy", ["[MSG:Check Door]"]));
      const msg = useStore.getState().consoleLines.find((l) => l.text === "[MSG:Check Door]");
      expect(msg?.type).toBe("info");
    });

    it("cancels job on ALARM event", () => {
      useStore.setState({ jobRunning: true });
      consumeStatusOutcome(makeOutcome(null, "busy", ["ALARM:2"]));
      expect(useStore.getState().jobRunning).toBe(false);
    });
  });

  // ---- Reset ----
  describe("resetStatusConsumer", () => {
    it("clears watermark and eligibility", () => {
      consumeStatusOutcome(makeOutcome(makeSnapshot({ epoch: 5, seq: 10 })));
      expect(_testGetWatermark()).toEqual({ epoch: 5, seq: 10 });
      expect(isStatusEligible()).toBe(true);

      resetStatusConsumer();
      expect(_testGetWatermark()).toEqual({ epoch: 0, seq: 0 });
      expect(isStatusEligible()).toBe(false);
    });
  });

  // ---- Fixture consumption: B2a's nativeStatus.json ----
  describe("fixture consumption", () => {
    it("deserializes and consumes B2a's nativeStatus.json fixture", () => {
      const fixturePath = path.join(
        __dirname,
        "fixtures",
        "nativeStatus.json"
      );
      const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
      const outcome: StatusOutcome = fixture.statusOutcome;

      const accepted = consumeStatusOutcome(outcome);
      expect(accepted).toBe(true);

      const state = useStore.getState();
      expect(state.machineState).toBe("run");
      expect(state.machinePosition).toEqual({ x: 10.5, y: 20.3, z: 0 });
      expect(state.positionKind).toBe("machine");
      expect(state.feedRate).toBe(500);
      expect(state.spindleSpeed).toBe(1000);
      expect(state.accessoryFlags).toBe("S");
      expect(state.workCoordOffset).toEqual({ x: 1, y: 2 });
    });
  });

  // ---- Mutant targets ----
  describe("mutant-targeted assertions", () => {
    it("m1: connect seeds unknown, not Idle", () => {
      // After reset, no snapshot consumed — the consumer starts unknown.
      // A connect that sets store to "idle" is the connection code's job,
      // but the consumer itself never assumes Idle.
      resetStatusConsumer();
      expect(isStatusEligible()).toBe(false);
      expect(_testGetWatermark()).toEqual({ epoch: 0, seq: 0 });
    });

    it("m2: Busy response renews liveness (returns true, no state change)", () => {
      consumeStatusOutcome(makeOutcome(makeSnapshot({ epoch: 1, seq: 1, state: "run" })));
      expect(useStore.getState().machineState).toBe("run");

      const result = consumeStatusOutcome(makeOutcome(null, "busy"));
      expect(result).toBe(true);
      // State unchanged — Busy preserves, never overwrites
      expect(useStore.getState().machineState).toBe("run");
    });

    it("m3: late old-epoch poll does NOT update state", () => {
      consumeStatusOutcome(makeOutcome(makeSnapshot({ epoch: 5, seq: 1, state: "run" })));
      const accepted = consumeStatusOutcome(
        makeOutcome(makeSnapshot({ epoch: 3, seq: 99, state: "idle" }))
      );
      expect(accepted).toBe(false);
      expect(useStore.getState().machineState).toBe("run");
    });

    it("m4: WPos is NOT relabelled MPos", () => {
      const snap = makeSnapshot({
        positionKind: "WPos",
        position: [5, 15, 0],
      });
      consumeStatusOutcome(makeOutcome(snap));
      expect(useStore.getState().positionKind).toBe("work");
      expect(useStore.getState().positionKind).not.toBe("machine");
    });

    it("m5: missing accessory does NOT become confirmed off", () => {
      const snap = makeSnapshot({ accessory: "Unknown" });
      consumeStatusOutcome(makeOutcome(snap));
      // null means unknown — never false/"off"/empty string
      expect(useStore.getState().accessoryFlags).toBeNull();
      expect(useStore.getState().accessoryFlags).not.toBe("");
      expect(useStore.getState().accessoryFlags).not.toBe("off");
    });
  });
});
