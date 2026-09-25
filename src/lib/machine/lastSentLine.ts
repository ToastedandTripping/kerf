/**
 * Per-job evidence for the spindle-drop check: the last job line sent, the
 * drop detector's previous sample, and the job's tally. Status only: nothing
 * here says what the beam did.
 *
 * Fed from four places (E3): `pollStatus` (no job running), `send()` in-pump
 * reports (per-line jobs), `getStatusReport` (the drain), and buffered
 * `status` events. `startJobEvidence` resets it per job; `endJobEvidence`
 * prints one tally line per job, including a zero.
 */
import { useStore } from "../../app/store";

export interface SpindleSample {
  state: string | null;
  feed: number | null;
  spindle: number | null;
}

interface DropMark {
  time: string;
  line: string;
}

interface Tally {
  samples: number;
  drops: number;
  first: DropMark | null;
  last: DropMark | null;
}

let prevSpindleSpeed: number | null = null;
let lastSent: { index: number; text: string; approximate: boolean } | null = null;
let tally: Tally = { samples: 0, drops: 0, first: null, last: null };

/** `approximate` is true in buffered mode: Rust reports progress at most every
 *  50 ms, so the recorded line can lag the line actually sent. */
export function setLastSentLine(index: number, text: string, approximate = false): void {
  lastSent = { index, text, approximate };
}

export function getLastSentLine(): { index: number; text: string; approximate: boolean } | null {
  return lastSent;
}

/** Mirrors the Rust buffered pump's filter (`serial.rs`): trim, then drop
 *  empty and `;`-leading lines, so a buffered `lineIndex` maps to the text
 *  Rust actually sent. */
export function bufferedJobLines(gcode: string): string[] {
  return gcode
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith(";"));
}

function parseNumber(s: string | undefined): number | null {
  if (s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse a raw `<State|...|FS:f,s>` report into a sample. */
export function parseReportSample(report: string): SpindleSample {
  const body = report.replace(/^</, "").replace(/>\s*$/, "");
  const stateMatch = body.match(/^([^|:]*)/);
  const stateToken = stateMatch ? stateMatch[1].trim().toLowerCase() : "";
  const fs = body.match(/(?:^|\|)FS:([^,|]*),([^,|]*)/);
  return {
    state: stateToken === "" ? null : stateToken,
    feed: fs ? parseNumber(fs[1]) : null,
    spindle: fs ? parseNumber(fs[2]) : null,
  };
}

function clearJobRecord(): void {
  lastSent = null;
  tally = { samples: 0, drops: 0, first: null, last: null };
}

export function resetSpindleDrop(): void {
  prevSpindleSpeed = null;
}

/** Called once per job by `streamJob`. The prev-sample reset makes a drop a
 *  within-job transition by construction. */
export function startJobEvidence(): void {
  resetSpindleDrop();
  clearJobRecord();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local wall-clock HH:MM:SS, no locale formatting. */
function clock(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Prints the job's tally (always, including zero), then clears the record so a
 *  no-job drop afterwards never names the finished job's line. */
export function endJobEvidence(label: string): void {
  let summary =
    `${label}: ${tally.drops} of ${tally.samples} status reports during Run ` +
    `showed spindle 0 (status only, not beam output).`;
  if (tally.drops > 0 && tally.first && tally.last) {
    summary +=
      ` First at ${tally.first.time}, last line sent ${tally.first.line}.` +
      ` Last at ${tally.last.time}, last line sent ${tally.last.line}.`;
  }
  useStore.getState().addConsoleLine(summary, "info");
  clearJobRecord();
}

/** Total by construction: never throws, returns nothing. A throw here would
 *  reach `send()`'s catch and end a job as a dead port, so every failure is
 *  logged to devtools and swallowed. */
export function noteSpindleSample(input: string | SpindleSample): void {
  try {
    const s = typeof input === "string" ? parseReportSample(input) : input;
    if (s.spindle === null || !Number.isFinite(s.spindle)) return;
    if (s.state === "run") tally.samples += 1;
    // The tally counts every Run report showing spindle 0 (its wording is the
    // contract); the drop line below fires only on a positive-to-0 transition.
    const zeroInRun = s.state === "run" && s.spindle === 0;
    const base = lastSent ? `#${lastSent.index + 1} "${lastSent.text}"` : null;
    const ref = base && lastSent?.approximate ? `${base} (approximate in buffered mode)` : base;
    const time = clock();
    if (zeroInRun) {
      tally.drops += 1;
      const mark: DropMark = { time, line: ref ?? "none" };
      tally.first ??= mark;
      tally.last = mark;
    }
    if (s.state === "run" && prevSpindleSpeed !== null && prevSpindleSpeed > 0 && s.spindle === 0) {
      const where = ref
        ? `${ref} (the controller may still be executing earlier lines)`
        : "no job line recorded";
      const text =
        `Controller reported spindle 0 during Run at ${time} ` +
        `(previous report S${prevSpindleSpeed}, feed ${s.feed ?? "unknown"}). ` +
        `Status only: this is what the controller reported, not whether the beam emitted. ` +
        `Last job line sent: ${where}.`;
      console.info(text);
      useStore.getState().addConsoleLine(text, "info");
    }
    prevSpindleSpeed = s.spindle;
  } catch (e) {
    // Deliberately swallowed (logged): a diagnostic must never end a job.
    console.error("Spindle-drop evidence failed:", e);
  }
}

/** Tests only: resets all state directly, bypassing startJobEvidence. */
export function _testResetJobEvidence(): void {
  prevSpindleSpeed = null;
  lastSent = null;
  tally = { samples: 0, drops: 0, first: null, last: null };
}
