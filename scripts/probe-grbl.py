#!/usr/bin/env python3
"""
probe-grbl.py — drive a GRBL-family controller through the command sequences
Kerf sends, one named case per invocation, and record every byte on the wire.

Purpose: capture the "controller stops answering commands after a laser
switch, still answers '?' until reset" wedge, and record status-only evidence
of what the controller reports around a feed hold, a stop and a completion.
The procedure lives in docs/qualification-card.md. Read it before a live run.

Usage (with Kerf CLOSED so the port is free):
    python3 -m pip install --user pyserial     # live runs only
    python3 probe-grbl.py --case wedge --dry-run --home --origin-x 20 --origin-y 20 \\
        --x-dir 1 --y-dir -1                   # print the matrix, open nothing
    python3 probe-grbl.py --case settings --port PORT --log-file PATH
    python3 probe-grbl.py --case direction --home --x-dir 1 --y-dir -1 \\
        --port PORT --log-file PATH

Rules:
  - --case is required; there is no default case.
  - --port and --log-file are required for live runs. An existing log file is
    refused. No log is ever written to a default name.
  - --home is required for every motion case (direction, wedge, hold-m4,
    stop-m4, completion-m4) and refused for settings. The probe homes at the
    start of the invocation and at no other time. It never sends $X.
  - --smax defaults to 0. Positive power is only ever an explicit choice.
  - Every powered case refuses before motion unless the controller reported
    $32=1 and $30; the boxed cases also need $130, $131, a zero G54/G92 offset
    and a box that fits the bed.
  - --pause is retired (it sent 0x9E, which re-arms the beam). The probe
    never sends 0x9E and never sends '~'.
  - A fault or Ctrl-C sends the realtime reset (0x18) first, then only a
    capture and one '?'. No M5, no $X, no $H, no next variant.

Exit codes: 0 RESULT COMPLETE; 1 RESULT INCOMPLETE; 2 the command line was
refused (no port opened, no log written); 3 RESULT REFUSED (no case line sent).
A log is complete only if its last line is "RESULT COMPLETE".
"""

import argparse
import os
import queue
import re
import sys
import threading
import time

# ---------------------------------------------------------------------------
# Constants. Timing constants are module-level so tests can patch them.
# Tests never patch TIMING_MARGIN_S or SEGMENT_MM.
# ---------------------------------------------------------------------------

DTR_SETTLE_S = 1.5
BANNER_WAIT_S = 2.5
PROBE_EVERY_S = 1.0
IDLE_TICKS = 3
HARD_TIMEOUT_S = 90.0
HOME_TIMEOUT_S = 60.0
CLEANUP_CAPTURE_S = 2.5
HOLD_DELAY_S = 1.0
HOLD_OBSERVE_S = 5.0
STOP_DELAY_S = 1.0
READER_JOIN_S = 1.0
STATUS_WAIT_S = 1.0
QUERY_TIMEOUT_S = 5.0
COMPLETION_TIMEOUT_S = 30.0
OBSERVE_EVERY_S = 0.25

SEGMENT_MM = 20
TIMING_MARGIN_S = 1.0
POSITION_TOL_MM = 5.0
BOX_FLOOR_M4_MM = 30.0

CASES = ("settings", "direction", "wedge", "hold-m4", "stop-m4", "completion-m4")
MOTION_CASES = ("direction", "wedge", "hold-m4", "stop-m4", "completion-m4")
BOXED_CASES = ("wedge", "hold-m4", "stop-m4", "completion-m4")
M4_CASES = ("hold-m4", "stop-m4", "completion-m4")
ONE_REP_CASES = ("hold-m4", "stop-m4")
POWERED_CASES = ("wedge", "hold-m4", "stop-m4", "completion-m4")
STARTUP_STATES = ("Idle", "Alarm")
BOXED_PREAMBLE = ["G21", "G90", "M5"]


def open_serial(port, baud):
    """The only place pyserial is imported, so --help and --dry-run work
    without it."""
    import serial  # pyserial

    return serial.Serial(port, baud, timeout=0.05)


# ---------------------------------------------------------------------------
# Wire layer: a reader thread timestamps every line; writes are logged too.
# ---------------------------------------------------------------------------

class Wire:
    def __init__(self, port, baud, logf):
        self.ser = open_serial(port, baud)
        # DTR toggle: Arduino/ESP32 boards reset the MCU on the DTR falling
        # edge (100nF cap to RESET).  Deassert first so the assert always
        # produces an edge, then wait for the bootloader to hand off to GRBL.
        # Without this, boards that don't auto-reset on port-open (ESP32-S3,
        # some CH340 adapters) never start their UART — verified on the
        # Creality Falcon 2 (2026-09-14).
        self.ser.dtr = False
        time.sleep(0.05)
        self.ser.dtr = True
        time.sleep(DTR_SETTLE_S)
        self.logf = logf
        self.q = queue.Queue()
        self.t0 = time.monotonic()
        self._stop = False
        self._buf = b""
        self._log_lock = threading.Lock()
        self.th = threading.Thread(target=self._reader, daemon=True)
        self.th.start()

    def ts(self):
        return f"{(time.monotonic() - self.t0) * 1000:9.1f}ms"

    def log(self, direction, text):
        line = f"{self.ts()} {direction} {text}"
        with self._log_lock:
            if self.logf.closed:  # a reader that outlived the join: drop the line, no traceback
                return
            self.logf.write(line + "\n")
            self.logf.flush()

    def _reader(self):
        while not self._stop:
            try:
                data = self.ser.read(256)
            except Exception as e:  # port gone (or closed by us)
                if not self._stop:
                    self.log("!!", f"read error: {e}")
                    self.q.put(("__EOF__", time.monotonic()))
                return
            if not data:
                continue
            self._buf += data
            while b"\n" in self._buf:
                raw, self._buf = self._buf.split(b"\n", 1)
                text = raw.decode("utf-8", "replace").strip("\r").strip()
                if text == "":
                    continue
                self.log("<-", text)
                self.q.put((text, time.monotonic()))

    def send_line(self, text):
        self.log("->", text)
        self.ser.write((text + "\n").encode("ascii"))
        self.ser.flush()

    def send_byte(self, b, name):
        self.log("->", f"<{name} 0x{b:02X}>")
        self.ser.write(bytes([b]))
        self.ser.flush()

    def drain(self, seconds):
        end = time.monotonic() + seconds
        lines = []
        while time.monotonic() < end:
            try:
                lines.append(self.q.get(timeout=0.05)[0])
            except queue.Empty:
                pass
        return lines

    def close(self):
        """Stops and JOINS the reader before the port closes, so no reader
        line can be logged after the caller's last line. Returns False if the
        reader did not stop within READER_JOIN_S."""
        self._stop = True
        self.th.join(READER_JOIN_S)
        joined = not self.th.is_alive()
        try:
            self.ser.close()
        except Exception as e:  # already closed or port gone: nothing left to do
            self.log("!!", f"close: {e}")
        return joined


STATE_RE = re.compile(r"^<([A-Za-z]+)(?::\d+)?\|")
MPOS_RE = re.compile(r"MPos:([-\d.]+),([-\d.]+)")
WCO_RE = re.compile(r"WCO:([-\d.]+),([-\d.]+)")
OFFSET_RE = re.compile(r"^\[(G5[4-9]|G28|G30|G92):([-\d.]+),([-\d.]+)")
SETTING_RE = re.compile(r"^\$(\d+)=([-\d.]+)")
XY_WORD_RE = re.compile(r"([XY])(-?[\d.]+)")
S_WORD_RE = re.compile(r"S(-?[\d.]+)")


def state_of(report):
    if not report:
        return None
    m = STATE_RE.match(report)
    return m.group(1) if m else None


def xy_of(regex, report):
    if not report:
        return None
    m = regex.search(report)
    return (float(m.group(1)), float(m.group(2))) if m else None


class Wedge(Exception):
    pass


class Alarm(Exception):
    pass


class Fault(Exception):
    """A case fault that is neither a wedge nor an alarm (an error: reply)."""


class Refused(Exception):
    """A controller check failed after the port opened. Nothing more is sent."""


class Incomplete(Exception):
    """The run cannot continue, without a fault to clean up after."""


class Probe:
    """Kerf's per-line protocol: write a line, wait for ok/error, and while
    waiting send '?' every second of silence. Three consecutive Idle replies
    with no ok = the wedge Kerf reports as 'terminal lost'."""

    def __init__(self, wire, idle_ticks=3, probe_every=1.0, hard_timeout=90.0):
        self.w = wire
        self.idle_ticks = idle_ticks
        self.probe_every = probe_every
        self.hard_timeout = hard_timeout
        self.last_report = None

    def command(self, line, timeout=None):
        """Returns (ms until terminal, terminal). Raises Wedge / Alarm."""
        hard_timeout = self.hard_timeout if timeout is None else timeout
        t_sent = time.monotonic()
        self.w.send_line(line)
        consecutive_idle = 0
        last_rx = time.monotonic()
        while True:
            try:
                text, t = self.w.q.get(timeout=0.05)
            except queue.Empty:
                now = time.monotonic()
                if now - t_sent > hard_timeout:
                    raise Wedge(f"no terminal after {hard_timeout:.0f}s for: {line}")
                if now - last_rx >= self.probe_every:
                    self.w.send_byte(ord("?"), "?")
                    last_rx = now  # one probe per silent second, like Kerf
                continue
            last_rx = t
            if text == "__EOF__":
                raise Wedge("port closed")
            if text.startswith("<"):
                self.last_report = text
                if state_of(text) == "Idle":
                    consecutive_idle += 1
                    if consecutive_idle >= self.idle_ticks:
                        raise Wedge(
                            f"Idle x{consecutive_idle} with no ok for: {line}  (last report {text})"
                        )
                else:
                    consecutive_idle = 0
                continue
            consecutive_idle = 0
            if text == "ok":
                return (time.monotonic() - t_sent) * 1000, "ok"
            if text.startswith("error:"):
                return (time.monotonic() - t_sent) * 1000, text
            if text.startswith("ALARM"):
                raise Alarm(f"{text} after: {line}")
            if text.startswith("Grbl") or text.startswith("GRBL"):
                raise Wedge(f"unexpected reset banner while waiting for: {line}")
            # [MSG:...] and other chatter: keep waiting

    def status(self, timeout=None):
        """One '?' and its report (or None)."""
        wait = STATUS_WAIT_S if timeout is None else timeout
        while not self.w.q.empty():
            try:
                self.w.q.get_nowait()
            except queue.Empty:
                break
        self.w.send_byte(ord("?"), "?")
        end = time.monotonic() + wait
        while time.monotonic() < end:
            try:
                text, _ = self.w.q.get(timeout=0.05)
            except queue.Empty:
                continue
            if text == "__EOF__":
                raise Wedge("port closed")
            if text.startswith("<"):
                self.last_report = text
                return text
        return None

    def wait_idle(self, timeout=60.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            r = self.status()
            if r and state_of(r) == "Idle":
                return r
            time.sleep(0.2)
        raise Wedge("machine never returned to Idle")


# ---------------------------------------------------------------------------
# Controller queries (raw, recorded in the log by the reader)
# ---------------------------------------------------------------------------

def query(p, line):
    """Sends a $ query and collects its reply lines. Returns (lines, error),
    where error is None on ok, the error: text, or "no reply"."""
    w = p.w
    while not w.q.empty():
        try:
            w.q.get_nowait()
        except queue.Empty:
            break
    w.send_line(line)
    lines = []
    end = time.monotonic() + QUERY_TIMEOUT_S
    while time.monotonic() < end:
        try:
            text, _ = w.q.get(timeout=0.05)
        except queue.Empty:
            continue
        if text == "__EOF__":
            raise Wedge("port closed")
        if text == "ok":
            return lines, None
        if text.startswith("error:"):
            return lines, text
        if text.startswith("<"):
            continue
        lines.append(text)
    return lines, "no reply"


def parse_settings(lines):
    settings = {}
    for text in lines:
        m = SETTING_RE.match(text)
        if m:
            settings[int(m.group(1))] = float(m.group(2))
    return settings


def parse_offsets(lines):
    offsets = {}
    for text in lines:
        m = OFFSET_RE.match(text)
        if m:
            offsets[m.group(1)] = (float(m.group(2)), float(m.group(3)))
    return offsets


# ---------------------------------------------------------------------------
# Pure checks
# ---------------------------------------------------------------------------

def segment_outlasts(feed, delay):
    """True when the SEGMENT_MM move at `feed` mm/min lasts longer than the
    hold/stop delay plus margin, so the event lands during motion."""
    return SEGMENT_MM * 60 / feed > delay + TIMING_MARGIN_S


def box_fits(origin, box, bed):
    return 0 <= origin and origin + box <= bed


def position_in_bed(mpos, x_dir, y_dir, bed, tol):
    return all(-tol <= d * m <= b + tol for m, d, b in zip(mpos, (x_dir, y_dir), bed))


def nonzero(xy):
    return abs(xy[0]) > 1e-6 or abs(xy[1]) > 1e-6


def active_wcs(gcode_lines):
    """The active work coordinate system (G54-G59) from a $G reply, or None."""
    for text in gcode_lines:
        if text.startswith("[GC:"):
            for word in text[4:].rstrip("]").split():
                if word in ("G54", "G55", "G56", "G57", "G58", "G59"):
                    return word
    return None


def preflight(case, args, settings, status, offsets, gcode=None):
    """Every reason the case must not run. Pure. `status` is the startup
    report; `offsets` is the parsed $# reply, or None when $# is unsupported;
    `gcode` is the $G reply lines, or None when $G is unsupported."""
    reasons = []
    startup_state = state_of(status)
    if case in MOTION_CASES and startup_state not in STARTUP_STATES:
        reasons.append(f"startup state is {startup_state or 'unknown'}, not one of {', '.join(STARTUP_STATES)}")
    if case in MOTION_CASES and settings.get(22) != 1:
        reasons.append("$22 (homing) is absent or not 1; the home step needs homing enabled")
    s30 = settings.get(30)
    if s30 is None:
        reasons.append("$30 (max spindle/power scale) is absent; there is no default ceiling")
    elif args.smax > s30:
        reasons.append(f"--smax {args.smax} exceeds $30={s30:g}")
    if case in POWERED_CASES and settings.get(32) != 1:
        reasons.append(
            "$32 (laser mode) is absent or not 1; without laser mode GRBL keeps the "
            "beam energised through rapids, so the traverse would run with the beam on"
        )
    if case in BOXED_CASES:
        bed_x = settings.get(130)
        bed_y = settings.get(131)
        if bed_x is None:
            reasons.append("$130 (X travel) is absent")
        elif not box_fits(args.origin_x, args.box_mm, bed_x):
            reasons.append(f"box on X ({args.origin_x:g} + {args.box_mm:g} mm) does not fit $130={bed_x:g}")
        if bed_y is None:
            reasons.append("$131 (Y travel) is absent")
        elif not box_fits(args.origin_y, args.box_mm, bed_y):
            reasons.append(f"box on Y ({args.origin_y:g} + {args.box_mm:g} mm) does not fit $131={bed_y:g}")
        if gcode is not None:
            wcs = active_wcs(gcode)
            if wcs != "G54":
                reasons.append(f"active coordinate system is {wcs or 'not reported'} ($G); it must be G54")
        if offsets is not None and gcode is not None:
            g54 = offsets.get("G54")
            if g54 is None or nonzero(g54):
                reasons.append(f"G54 work offset is {g54 if g54 is not None else 'not reported'}; it must be zero on X and Y")
            g92 = offsets.get("G92")
            if g92 is None or nonzero(g92):
                reasons.append(f"G92 offset is {g92 if g92 is not None else 'not reported'}; it must be zero on X and Y")
        else:
            wco = xy_of(WCO_RE, status)
            if wco is None:
                reasons.append("work offset unreadable: $# is unsupported and the status report carries no WCO: field")
            elif nonzero(wco):
                reasons.append(f"WCO work offset is {wco}; it must be zero on X and Y")
    return reasons


# ---------------------------------------------------------------------------
# The case plans. One builder; the dry run prints it and the live run executes it.
# ---------------------------------------------------------------------------

class Step:
    """kind: home | line | idle | byte | mark | window | reset | poll | variant | variant_end | rep"""

    def __init__(self, kind, text="", value=None, delay=0.0, seconds=0.0, settle_ms=0, rep=0):
        self.kind = kind
        self.text = text
        self.value = value
        self.delay = delay
        self.seconds = seconds
        self.settle_ms = settle_ms
        self.rep = rep

    def __repr__(self):
        return f"Step({self.kind!r}, {self.text!r})"


def line(text):
    return Step("line", text)


def byte_step(value, label, delay):
    return Step("byte", label, value=value, delay=delay)


def mark(what):
    return Step("mark", what)


def build_variants(P, smax, feed):
    """Each variant: (name, [lines], settle_ms_after_mcodes). P(u, v) maps the
    0-60 frame into the operator's box and signs."""
    S = smax
    V = []
    # 1. The exact job preamble Kerf sends (zero-length feed move with F/S0, then M4).
    V.append(("preamble_zero_length_then_M4", [
        "M5", f"G0 {P(40, 40)}", f"G1 {P(40, 40)} F{feed} S0", f"M4 S{S}", "M5"], 0))
    # 2. Same, but M4 arrives while the rapid is still in flight (job timing).
    V.append(("rapid_in_flight_then_M4", [
        "M5", f"G0 {P(10, 10)}", f"G0 {P(60, 60)}", f"M4 S{S}", "M5"], 0))
    # 3. Preamble without the zero-length line.
    V.append(("rapid_then_M4_no_zero_length", [
        "M5", f"G0 {P(10, 10)}", f"G0 {P(40, 40)}", f"M4 S{S}", "M5"], 0))
    # 4. Ring pattern, M4 (variable): M5, rapid to ring start, M4, first cut with F+S, more cuts, M5.
    V.append(("ring_M4", [
        "M5", f"G0 {P(20, 20)}", f"M4 S{S}", f"G1 {P(40, 20)} F{feed} S{S}",
        f"G1 {P(40, 40)}", f"G1 {P(20, 40)}", f"G1 {P(20, 20)}", "M5"], 0))
    # 5. Ring pattern, M3 (constant) — the mode the Sep 2 and first failures ran in.
    V.append(("ring_M3", [
        "M5", f"G0 {P(20, 20)}", f"M3 S{S}", f"G1 {P(40, 20)} F{feed} S{S}",
        f"G1 {P(40, 40)}", f"G1 {P(20, 40)}", f"G1 {P(20, 20)}", "M5"], 0))
    # 6. Two rings back to back (M5 -> G0 -> M3 -> cut, repeated) — per-ring switching at speed.
    V.append(("two_rings_M3", [
        "M5", f"G0 {P(20, 20)}", f"M3 S{S}", f"G1 {P(30, 20)} F{feed} S{S}", f"G1 {P(30, 30)}", "M5",
        f"G0 {P(45, 45)}", f"M3 S{S}", f"G1 {P(55, 45)} F{feed} S{S}", f"G1 {P(55, 55)}", "M5"], 0))
    # 7. Candidate fix: 30 ms breath after every M3/M4/M5 before the next line.
    V.append(("ring_M4_settle30ms", [
        "M5", f"G0 {P(20, 20)}", f"M4 S{S}", f"G1 {P(40, 20)} F{feed} S{S}",
        f"G1 {P(40, 40)}", f"G1 {P(20, 40)}", f"G1 {P(20, 20)}", "M5"], 30))
    # 8. Candidate fix: wait for Idle before any laser switch.
    V.append(("ring_M4_wait_idle_before_switch", [
        "M5", f"G0 {P(20, 20)}", "@IDLE", f"M4 S{S}", f"G1 {P(40, 20)} F{feed} S{S}",
        f"G1 {P(40, 40)}", f"G1 {P(20, 40)}", f"G1 {P(20, 20)}", "@IDLE", "M5"], 0))
    return V


def resolved_reps(args):
    if args.reps is not None:
        return args.reps
    return 1 if args.case in ONE_REP_CASES else 5


def build_case_plan(case, args, x_dir, y_dir):
    """The whole ordered step list for one case. Pure."""
    steps = []
    if case == "settings":
        return steps
    steps.append(Step("home"))
    if case == "direction":
        for text in ["G21", "G91", "M5"]:
            steps.append(line(text))
        steps.append(line(f"G1 X{x_dir * 1:.3f} F300"))
        steps.append(line(f"G1 X{-x_dir * 1:.3f} F300"))
        steps.append(line(f"G1 Y{y_dir * 1:.3f} F300"))
        steps.append(line(f"G1 Y{-y_dir * 1:.3f} F300"))
        steps.append(line("G90"))
        steps.append(Step("idle", seconds=60.0))
        return steps

    box = args.box_mm
    ox, oy = args.origin_x, args.origin_y

    def P(u, v):
        return f"X{x_dir * (ox + u * box / 60):.3f} Y{y_dir * (oy + v * box / 60):.3f}"

    def Q(dx, dy):
        return f"X{x_dir * (ox + dx):.3f} Y{y_dir * (oy + dy):.3f}"

    for text in BOXED_PREAMBLE:
        steps.append(line(text))
    smax, feed = args.smax, args.feed
    reps = resolved_reps(args)

    if case == "wedge":
        variants = build_variants(P, smax, feed)
        for rep in range(1, reps + 1):
            steps.append(Step("rep", rep=rep))
            for name, lines, settle in variants:
                steps.append(Step("variant", name, settle_ms=settle, rep=rep))
                for text in lines:
                    if text == "@IDLE":
                        steps.append(Step("idle", seconds=60.0))
                    else:
                        steps.append(line(text))
                steps.append(Step("idle", seconds=60.0))
                steps.append(Step("variant_end", name, rep=rep))
        return steps

    # The three M4 cases: an unscaled SEGMENT_MM segment from Q(5, 5) to Q(25, 5).
    for rep in range(1, reps + 1):
        steps.append(Step("rep", rep=rep))
        steps.append(line(f"G0 {Q(5, 5)}"))
        steps.append(Step("idle", seconds=60.0))
        steps.append(line(f"M4 S{smax}"))
        steps.append(line(f"G1 {Q(5 + SEGMENT_MM, 5)} F{feed} S{smax}"))
        steps.append(mark("last ack"))
        if case == "hold-m4":
            steps.append(byte_step(0x21, "FEED_HOLD !", HOLD_DELAY_S))
            steps.append(mark("hold"))
            steps.append(Step("window", seconds=HOLD_OBSERVE_S))
            steps.append(Step("reset", "designed reset after hold", delay=0.0))
        elif case == "stop-m4":
            steps.append(Step("reset", "stop", delay=STOP_DELAY_S))
        else:
            steps.append(line("M5"))
            steps.append(Step("poll", seconds=COMPLETION_TIMEOUT_S))
            steps.append(mark("completion"))
    return steps


def format_plan(steps):
    out = []
    for s in steps:
        if s.kind == "home":
            out += ["[home] M5 (only if the controller reports Idle)", "[home] $H",
                    "[home] wait for Idle, then check state and position"]
        elif s.kind == "line":
            out.append(s.text)
        elif s.kind == "idle":
            out.append("[wait for Idle]")
        elif s.kind == "byte":
            out.append(f"[after {s.delay:g} s] <{s.text} 0x{s.value:02X}>")
        elif s.kind == "mark":
            out.append(f"## OBSERVE {s.text}: note whether motion ceased")
        elif s.kind == "window":
            out.append(f"[observe: '?' every {OBSERVE_EVERY_S * 1000:.0f} ms for {s.seconds:g} s]")
        elif s.kind == "reset":
            out.append(f"[after {s.delay:g} s] <RESET 0x18> (designed: {s.text}), then capture + one '?'")
        elif s.kind == "poll":
            out.append(f"[poll '?' until Idle, max {s.seconds:g} s]")
        elif s.kind == "variant":
            out.append(f"--- variant {s.text} rep {s.rep} ---")
        elif s.kind == "rep":
            out.append(f"[rep {s.rep}: '?' must report Idle]")
    return out


# ---------------------------------------------------------------------------
# Cleanup: the one fault path. Reset first, nothing after but a capture.
# ---------------------------------------------------------------------------

def cleanup(wire, reason):
    if wire is not None:
        try:
            wire.log("##", f"cleanup ({reason}): realtime reset first")
            wire.send_byte(0x18, "RESET")
            wire.drain(CLEANUP_CAPTURE_S)
            wire.send_byte(ord("?"), "?")
            wire.drain(CLEANUP_CAPTURE_S)
        except Exception as exc:  # a dead port must still reach the RESULT line
            try:
                wire.log("!!", f"cleanup: {exc}")
            except Exception:  # the log itself failed; the RESULT line is still returned
                pass
    return f"RESULT INCOMPLETE: {reason}"


def designed_reset_capture(p):
    lines = p.w.drain(CLEANUP_CAPTURE_S)
    p.w.send_byte(ord("?"), "?")
    lines += p.w.drain(CLEANUP_CAPTURE_S)
    reports = [text for text in lines if text.startswith("<")]
    return reports[-1] if reports else None


def observe(p, text):
    p.w.log("##", f"OBSERVE {text}: note whether motion ceased")
    print(f"## OBSERVE {text}: note whether motion ceased")


# ---------------------------------------------------------------------------
# The live runner
# ---------------------------------------------------------------------------

def run_home(p, args, results):
    before = p.status()
    if state_of(before) == "Idle":
        _, term = p.command("M5")
        if term != "ok":
            raise Fault(f"home step: {term} for M5")
    _, term = p.command("$H", timeout=HOME_TIMEOUT_S)
    if term != "ok":
        raise Fault(f"home step: {term} for $H")
    end = time.monotonic() + HOME_TIMEOUT_S
    report = p.status()
    while state_of(report) != "Idle" and time.monotonic() < end:
        time.sleep(0.2)
        report = p.status()
    home_state = state_of(report)
    reasons = []
    if home_state != "Idle":
        reasons.append(f"state after homing is {home_state or 'unreported'}, not Idle")
    if args.case in BOXED_CASES and home_state == "Idle":
        mpos = xy_of(MPOS_RE, report)
        bed = (p.settings.get(130, 0.0), p.settings.get(131, 0.0))
        if mpos is None:
            reasons.append("post-home status report carries no MPos")
        elif not position_in_bed(mpos, args.x_dir, args.y_dir, bed, POSITION_TOL_MM):
            reasons.append(
                f"post-home position MPos {mpos[0]:g},{mpos[1]:g} lies outside the bed on "
                f"--x-dir {args.x_dir} --y-dir {args.y_dir} (tolerance {POSITION_TOL_MM:g} mm)"
            )
    if reasons:
        raise Refused("; ".join(reasons))
    results.append(("home", 1, "OK", report))


def execute_step(wire, p, args, step, ctx, results):
    kind = step.kind
    if kind == "home":
        run_home(p, args, results)
    elif kind == "line":
        _, term = p.command(step.text)
        if term != "ok":
            raise Fault(f"{term} for {step.text}")
        if ctx["settle_ms"] and step.text.startswith("M"):
            time.sleep(ctx["settle_ms"] / 1000)
    elif kind == "idle":
        p.wait_idle(step.seconds)
    elif kind == "byte":
        time.sleep(step.delay)
        wire.send_byte(step.value, step.text)
    elif kind == "mark":
        observe(p, step.text)
    elif kind == "window":
        end = time.monotonic() + step.seconds
        trace = []
        while time.monotonic() < end:
            time.sleep(OBSERVE_EVERY_S)
            trace.append(state_of(p.status()) or "?")
        results.append((args.case, ctx["rep"], "TRACE", " ".join(trace)))
    elif kind == "reset":
        time.sleep(step.delay)
        wire.send_byte(0x18, "RESET designed")
        if step.text == "stop":
            observe(p, "stop")
        capture = designed_reset_capture(p)
        results.append((args.case, ctx["rep"], "RESET",
                        f"state after designed reset: {state_of(capture) or 'no report'} ({capture})"))
    elif kind == "poll":
        end = time.monotonic() + step.seconds
        while True:
            report = p.status()
            if state_of(report) == "Idle":
                break
            if time.monotonic() >= end:
                raise Wedge(f"no Idle within {step.seconds:g} s of completion")
            time.sleep(OBSERVE_EVERY_S)
    elif kind == "variant":
        ctx["variant"] = step.text
        ctx["settle_ms"] = step.settle_ms
        wire.log("##", f"--- variant {step.text} rep {step.rep} ---")
    elif kind == "variant_end":
        results.append((step.text, step.rep, "PASS", "all lines acknowledged"))
        print(f"  [{step.rep}] {step.text}: PASS")
        ctx["variant"] = None
        ctx["settle_ms"] = 0
    elif kind == "rep":
        ctx["rep"] = step.rep
        rep_state = state_of(p.status())
        if rep_state != "Idle":
            raise Incomplete(f"controller not Idle before rep {step.rep} (the probe never unlocks); state {rep_state}")


def run_steps(wire, p, args, settings, steps, results):
    ctx = {"variant": None, "settle_ms": 0, "rep": 1}
    for step in steps:
        try:
            execute_step(wire, p, args, step, ctx, results)
        except Refused as r:
            return f"RESULT REFUSED: {r}", 3
        except Incomplete as i:
            return f"RESULT INCOMPLETE: {i}", 1
        except (Wedge, Alarm, Fault) as e:
            label = type(e).__name__.upper()
            where = f" in {ctx['variant']} rep {ctx['rep']}" if ctx["variant"] else ""
            results.append((ctx["variant"] or args.case, ctx["rep"], label, str(e)))
            wire.log("##", f"{label}{where}: {e}")
            fault_result = cleanup(wire, f"{label.lower()}{where}: {e}")
            return fault_result, 1
    return "RESULT COMPLETE", 0


def run_live(wire, args, results):
    p = Probe(wire, IDLE_TICKS, PROBE_EVERY_S, HARD_TIMEOUT_S)
    wire.log("##", "open; draining for banner")
    wire.drain(BANNER_WAIT_S)
    # Ask before resetting: a controller that reports a state is never reset.
    startup_report = p.status(BANNER_WAIT_S)
    if startup_report is None:
        wire.log("##", "no status report; one startup reset")
        wire.send_byte(0x18, "RESET startup")
        wire.drain(BANNER_WAIT_S)
        startup_report = p.status(BANNER_WAIT_S)
        if startup_report is None:
            return "RESULT INCOMPLETE: controller not answering", 1
    wire.log("##", f"startup state: {state_of(startup_report)} ({startup_report})")
    results.append(("startup", 1, state_of(startup_report) or "?", startup_report))

    info, _ = query(p, "$I")
    results.append(("$I", 1, "OK", f"{len(info)} line(s)"))
    settings_lines, s_err = query(p, "$$")
    settings = parse_settings(settings_lines)
    p.settings = settings
    wire.log("##", f"settings: {settings}")
    unsupported = []
    replies = {}
    for q in ("$G", "$#"):
        q_lines, q_err = query(p, q)
        replies[q] = q_lines
        if q_err is not None:
            unsupported.append(q)
            wire.log("##", f"{q} unsupported ({q_err})")
            results.append((q, 1, "UNSUPPORTED", q_err))
        else:
            results.append((q, 1, "OK", " ".join(q_lines)))
    if args.case == "settings":
        return "RESULT COMPLETE", 0

    offsets = None if "$#" in unsupported else parse_offsets(replies["$#"])
    gcode = None if "$G" in unsupported else replies["$G"]
    reasons = preflight(args.case, args, settings, startup_report, offsets, gcode)
    if reasons:
        return "RESULT REFUSED: " + "; ".join(reasons), 3

    live_steps = build_case_plan(args.case, args, args.x_dir, args.y_dir)
    return run_steps(wire, p, args, settings, live_steps, results)


def finish(wire, logf, result, code, results):
    """Summary, then join the reader, then the RESULT line last, from this thread."""
    summary = [f"{name} rep {rep} {verdict}: {detail}" for name, rep, verdict, detail in results]
    print("\n=== SUMMARY ===")
    for text in summary:
        print(text)
    if wire is not None:
        wire.log("##", "SUMMARY " + " || ".join(summary))
        if not wire.close():
            result, code = "RESULT INCOMPLETE: reader thread did not stop", 1
    else:
        logf.write("## SUMMARY " + " || ".join(summary) + "\n")
    logf.write(result + "\n")
    logf.close()
    print(result)
    return code


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------

def refuse_args(message):
    print(f"probe-grbl: refused: {message}", file=sys.stderr)


def parse_args(argv):
    ap = argparse.ArgumentParser(
        description="GRBL probe. Procedure: docs/qualification-card.md",
        epilog="Exit codes: 0 complete, 1 incomplete, 2 command line refused, 3 refused by controller checks.",
    )
    ap.add_argument("--case", required=True, choices=CASES)
    ap.add_argument("--dry-run", action="store_true", help="print the matrix; open no port")
    ap.add_argument("--port", help="serial port (required unless --dry-run)")
    ap.add_argument("--log-file", help="new log path (required unless --dry-run; must not exist)")
    ap.add_argument("--origin-x", type=float, help="box origin X in mm (boxed cases)")
    ap.add_argument("--origin-y", type=float, help="box origin Y in mm (boxed cases)")
    ap.add_argument("--x-dir", type=int, choices=(-1, 1), help="sign of X toward the bed (never inferred)")
    ap.add_argument("--y-dir", type=int, choices=(-1, 1), help="sign of Y toward the bed (never inferred)")
    ap.add_argument("--box-mm", type=float, default=60.0)
    ap.add_argument("--home", action="store_true", help="home first; required for every motion case")
    ap.add_argument("--smax", type=int, default=0, help="max S value ever sent (default 0)")
    ap.add_argument("--feed", type=int, default=12000)
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--reps", type=int, default=None)
    ap.add_argument("--stop-on-fault", action="store_true", help="accepted; a fault always ends the run")
    ap.add_argument("--pause", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--no-home", action="store_true", help=argparse.SUPPRESS)
    return ap.parse_args(argv)


def check_args(args):
    """Returns 2 for a refused command line, else None. Prints the reason."""
    if args.pause:
        refuse_args("--pause is retired: it sent 0x9E, which re-arms the beam. Use --case hold-m4.")
        return 2
    if args.no_home:
        refuse_args("--no-home is retired: the probe never homes on its own; motion cases require --home.")
        return 2
    if args.case == "settings" and args.home:
        refuse_args("--home is refused for --case settings, which never moves.")
        return 2
    if args.case in MOTION_CASES and not args.home:
        refuse_args(f"--home is required for --case {args.case}: every motion case starts from a fresh home.")
        return 2
    if not args.dry_run and not args.port:
        refuse_args("--port is required for a live run.")
        return 2
    if not args.dry_run and not args.log_file:
        refuse_args("--log-file is required for a live run.")
        return 2
    if not args.dry_run and os.path.exists(args.log_file):
        refuse_args(f"--log-file {args.log_file} already exists; logs are never overwritten.")
        return 2
    if args.case != "settings" and (args.x_dir is None or args.y_dir is None):
        refuse_args(f"--x-dir and --y-dir are required for --case {args.case}; directions are never inferred.")
        return 2
    if args.case in BOXED_CASES and (args.origin_x is None or args.origin_y is None):
        refuse_args(f"--origin-x and --origin-y are required for --case {args.case}.")
        return 2
    if args.box_mm <= 0:
        refuse_args("--box-mm must be greater than 0.")
        return 2
    if args.case in M4_CASES and args.box_mm < BOX_FLOOR_M4_MM:
        refuse_args(f"--box-mm must be at least {BOX_FLOOR_M4_MM:g} for --case {args.case}.")
        return 2
    if args.smax < 0:
        refuse_args("--smax must be 0 or more.")
        return 2
    if args.feed <= 0:
        refuse_args("--feed must be greater than 0.")
        return 2
    if args.reps is not None and args.reps < 1:
        refuse_args("--reps must be at least 1.")
        return 2
    if args.case in ONE_REP_CASES and args.reps is not None and args.reps > 1:
        refuse_args(f"--reps {args.reps} is refused for --case {args.case}: one repetition per invocation, each from a fresh home.")
        return 2
    if args.case in ONE_REP_CASES:
        delay = HOLD_DELAY_S if args.case == "hold-m4" else STOP_DELAY_S
        if not segment_outlasts(args.feed, delay):
            refuse_args(
                f"--feed {args.feed} is too fast for --case {args.case}: the {SEGMENT_MM} mm segment "
                f"would end before the event is sent. Use --feed 300."
            )
            return 2
    return None


def header_lines(args):
    origin = f"{args.origin_x:g},{args.origin_y:g}" if args.origin_x is not None and args.origin_y is not None else "-"
    dirs = f"{args.x_dir},{args.y_dir}" if args.x_dir is not None and args.y_dir is not None else "-"
    out = [
        f"probe-grbl case={args.case} reps={resolved_reps(args)} smax={args.smax} feed={args.feed} "
        f"origin={origin} dirs={dirs} box={args.box_mm:g} home={'yes' if args.home else 'no'}",
        'A run is complete only if its last line is "RESULT COMPLETE". Any other ending, including no RESULT line, is INCOMPLETE.',
    ]
    if args.smax == 0 or args.dry_run:
        out.append("This run cannot establish positive-power behaviour (S0 or dry run).")
    return out


def main(argv=None):
    raw = sys.argv[1:] if argv is None else argv
    if "--pause" in raw:
        refuse_args("--pause is retired: it sent 0x9E, which re-arms the beam. Use --case hold-m4.")
        return 2
    try:
        args = parse_args(argv)
    except SystemExit as e:  # argparse: --help (0) or a malformed command line (2)
        return e.code if isinstance(e.code, int) else 2
    refused = check_args(args)
    if refused is not None:
        return refused

    header = header_lines(args)
    if args.dry_run:
        for text in header:
            print(f"## {text}")
        for text in format_plan(build_case_plan(args.case, args, args.x_dir, args.y_dir)):
            print(text)
        return 0

    try:
        logf = open(args.log_file, "x")
    except OSError as e:
        refuse_args(f"--log-file {args.log_file} cannot be created: {e}")
        return 2
    for text in header:
        logf.write(f"## {text}\n")
    logf.flush()
    print(f"port {args.port}, log {args.log_file}")
    print("Ctrl-C at any time: realtime reset (0x18) first, nothing after it.")

    result = "RESULT INCOMPLETE: ended before a result was reached"
    code = 1
    wire = None
    results = []
    try:
        wire = Wire(args.port, args.baud, logf)
        result, code = run_live(wire, args, results)
    except KeyboardInterrupt:
        print("\ninterrupted: realtime reset")
        result = cleanup(wire, "interrupted (Ctrl-C)")
        code = 1
    except Exception as e:
        if wire is not None:
            wire.log("!!", f"fatal: {e}")
        print("fatal:", e)
        result = cleanup(wire, f"fatal: {e}")
        code = 1
    finally:
        code = finish(wire, logf, result, code, results)
    return code


if __name__ == "__main__":
    sys.exit(main())
