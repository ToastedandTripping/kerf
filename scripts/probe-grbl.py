#!/usr/bin/env python3
"""
probe-grbl.py — drive a GRBL-family controller through the command sequences
Kerf sends, at Kerf's speed, and record every byte on the wire.

Purpose: reproduce the "controller stops answering commands after a laser
switch, still answers '?' until reset" wedge seen on the owner's machine
(2026-09-05), and pin which sequence triggers it. Also (optional) records what
the firmware does on feed hold + spindle-stop override, byte by byte.

Usage (on the Mac, with Kerf CLOSED so the port is free):
    python3 -m pip install --user pyserial
    python3 probe-grbl.py                 # auto-picks the single /dev/cu.usb* port
    python3 probe-grbl.py --port /dev/cu.usbserial-1420
    python3 probe-grbl.py --reps 8        # more repetitions per variant
    python3 probe-grbl.py --pause         # also run the feed-hold experiment (beam at S10 on scrap)

Safety:
  - Laser power never exceeds --smax (default 10, i.e. ~1% of a 1000-scale S).
  - Every variant ends with M5. Any alarm/error aborts the run with M5 + reset.
  - Ctrl-C sends soft reset (0x18) then M5.
  - Moves stay inside a 60 mm box next to home. Put scrap under the head anyway.

Output: probe-YYYYMMDD-HHMMSS.log (full wire trace) + summary on stdout.
"""

import argparse
import glob
import queue
import re
import sys
import threading
import time
from datetime import datetime

try:
    import serial  # pyserial
except ImportError:
    sys.exit("pyserial is missing. Run:  python3 -m pip install --user pyserial")

# ---------------------------------------------------------------------------
# Wire layer: a reader thread timestamps every line; writes are logged too.
# ---------------------------------------------------------------------------

class Wire:
    def __init__(self, port, baud, logf):
        self.ser = serial.Serial(port, baud, timeout=0.05)
        # DTR toggle: Arduino/ESP32 boards reset the MCU on the DTR falling
        # edge (100nF cap to RESET).  Deassert first so the assert always
        # produces an edge, then wait for the bootloader to hand off to GRBL.
        # Without this, boards that don't auto-reset on port-open (ESP32-S3,
        # some CH340 adapters) never start their UART — verified on the
        # Creality Falcon 2 (2026-09-14).
        self.ser.dtr = False
        time.sleep(0.05)
        self.ser.dtr = True
        time.sleep(1.5)
        self.logf = logf
        self.q = queue.Queue()
        self.t0 = time.monotonic()
        self._stop = False
        self._buf = b""
        self.th = threading.Thread(target=self._reader, daemon=True)
        self.th.start()

    def ts(self):
        return f"{(time.monotonic() - self.t0) * 1000:9.1f}ms"

    def log(self, direction, text):
        line = f"{self.ts()} {direction} {text}"
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
        self._stop = True
        time.sleep(0.1)  # let the reader notice before the port goes away
        try:
            self.ser.close()
        except Exception:
            pass


STATE_RE = re.compile(r"^<([A-Za-z]+)(?::\d+)?\|")
POS_RE = re.compile(r"[MW]Pos:([-\d.]+),([-\d.]+)")
ACC_RE = re.compile(r"\|A:([A-Z]+)")


def state_of(report):
    m = STATE_RE.match(report)
    return m.group(1) if m else None


class Wedge(Exception):
    pass


class Alarm(Exception):
    pass


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

    def command(self, line):
        """Returns (ms until terminal, terminal). Raises Wedge / Alarm."""
        t_sent = time.monotonic()
        self.w.send_line(line)
        consecutive_idle = 0
        last_rx = time.monotonic()
        while True:
            try:
                text, t = self.w.q.get(timeout=0.05)
            except queue.Empty:
                now = time.monotonic()
                if now - t_sent > self.hard_timeout:
                    raise Wedge(f"no terminal after {self.hard_timeout:.0f}s for: {line}")
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

    def status(self):
        """One '?' and its report (or None)."""
        while not self.w.q.empty():
            try:
                self.w.q.get_nowait()
            except queue.Empty:
                break
        self.w.send_byte(ord("?"), "?")
        end = time.monotonic() + 1.0
        while time.monotonic() < end:
            try:
                text, _ = self.w.q.get(timeout=0.05)
            except queue.Empty:
                continue
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
# Controller bring-up
# ---------------------------------------------------------------------------

def reset_and_unlock(w, p, why):
    w.log("##", f"soft reset ({why})")
    w.send_byte(0x18, "RESET")
    lines = w.drain(2.5)
    banner = [l for l in lines if l.lower().startswith("grbl")]
    if not banner:
        w.log("##", "no banner after reset; continuing anyway")
    # Homing-enabled builds lock into Alarm after a reset; unlock keeps position.
    try:
        p.command("$X")
    except (Wedge, Alarm) as e:
        w.log("##", f"$X after reset: {e}")
    try:
        p.command("M5")
    except (Wedge, Alarm) as e:
        w.log("##", f"M5 after reset: {e}")


def read_settings(p):
    """Returns dict of $n -> value from $$."""
    settings = {}
    # $$ answers with many lines then ok; collect them via the queue.
    w = p.w
    while not w.q.empty():
        w.q.get_nowait()
    w.send_line("$$")
    end = time.monotonic() + 5.0
    while time.monotonic() < end:
        try:
            text, _ = w.q.get(timeout=0.05)
        except queue.Empty:
            continue
        m = re.match(r"^\$(\d+)=([-\d.]+)", text)
        if m:
            settings[int(m.group(1))] = float(m.group(2))
        elif text == "ok":
            break
    return settings


def read_build_info(p):
    w = p.w
    while not w.q.empty():
        w.q.get_nowait()
    w.send_line("$I")
    info = []
    end = time.monotonic() + 3.0
    while time.monotonic() < end:
        try:
            text, _ = w.q.get(timeout=0.05)
        except queue.Empty:
            continue
        if text == "ok":
            break
        info.append(text)
    return info


# ---------------------------------------------------------------------------
# The experiment matrix
# ---------------------------------------------------------------------------

def build_variants(sx, sy, smax, feed):
    """Each variant: (name, [lines], settle_ms_after_mcodes).
    Coordinates are inside a 60 mm box next to home; sx/sy carry the machine's
    sign convention (from $23) so 'toward the bed' is always correct."""
    def P(x, y):
        return f"X{sx * x:.3f} Y{sy * y:.3f}"

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


def run_variant(p, name, lines, settle_ms, rep, results):
    w = p.w
    w.log("##", f"--- variant {name} rep {rep} ---")
    timings = []
    try:
        for line in lines:
            if line == "@IDLE":
                p.wait_idle()
                continue
            ms, term = p.command(line)
            timings.append((line, ms, term))
            if term != "ok":
                results.append((name, rep, "ERROR", f"{term} for {line}"))
                w.log("##", f"error {term} for {line}; M5 + reset")
                reset_and_unlock(w, p, "error")
                return
            if settle_ms and line.startswith("M"):
                time.sleep(settle_ms / 1000)
        p.wait_idle()
        slow = [(l, ms) for (l, ms, _) in timings if ms > 500]
        results.append((name, rep, "PASS", f"slowest ok {max(ms for _, ms, _ in timings):.0f} ms"
                        + (f"; slow lines: {slow}" if slow else "")))
    except Wedge as e:
        results.append((name, rep, "WEDGE", str(e)))
        w.log("##", f"WEDGE: {e}")
        # Is the controller still answering '?' while ignoring lines? Record it.
        r = p.status()
        w.log("##", f"status while wedged: {r}")
        # Does it ignore a plain command too, or only laser ones?
        try:
            w.send_line("G4 P0")
            end = time.monotonic() + 3.0
            got = None
            while time.monotonic() < end:
                try:
                    text, _ = w.q.get(timeout=0.05)
                    if text == "ok" or text.startswith("error"):
                        got = text
                        break
                except queue.Empty:
                    pass
            w.log("##", f"plain command while wedged answered: {got}")
        except Exception:
            pass
        reset_and_unlock(w, p, "wedge")
    except Alarm as e:
        results.append((name, rep, "ALARM", str(e)))
        w.log("##", f"ALARM: {e}")
        reset_and_unlock(w, p, "alarm")


def run_pause_experiment(p, sx, sy, smax, mode, results):
    """Feed hold + spindle-stop override, observed through '?' (the A: field
    says whether the spindle output is energized) rather than eyes."""
    w = p.w
    name = f"pause_{mode}"
    w.log("##", f"--- {name} ---")
    def P(x, y):
        return f"X{sx * x:.3f} Y{sy * y:.3f}"
    try:
        p.command("M5")
        p.command(f"G0 {P(10, 10)}")
        p.wait_idle()
        p.command(f"{mode} S{smax}")
        # A slow crawl: ~70 mm at 300 mm/min = 14 s of motion to pause inside.
        p.command(f"G1 {P(60, 60)} F300 S{smax}")
        time.sleep(3.0)
        w.send_byte(0x21, "FEED_HOLD !")
        trace = []
        for _ in range(8):  # 2 s of reports at 250 ms
            time.sleep(0.25)
            r = p.status()
            trace.append(r)
        w.send_byte(0x9E, "SPINDLE_STOP_OVR 0x9E")
        for _ in range(12):  # 3 s more
            time.sleep(0.25)
            r = p.status()
            trace.append(r)
        # Anything the firmware said (e.g. [MSG:Restoring spindle]) is in the log.
        def acc(r):
            if not r:
                return "?"
            m = ACC_RE.search(r)
            return f"{state_of(r)}/A:{m.group(1) if m else '-'}"
        results.append((name, 1, "TRACE", " ".join(acc(r) for r in trace)))
    except (Wedge, Alarm) as e:
        results.append((name, 1, "FAIL", str(e)))
    finally:
        reset_and_unlock(w, p, "end of pause experiment")


# ---------------------------------------------------------------------------

def pick_port():
    cands = sorted(glob.glob("/dev/cu.usb*") + glob.glob("/dev/cu.wchusb*") + glob.glob("/dev/ttyUSB*") + glob.glob("/dev/ttyACM*"))
    if len(cands) == 1:
        return cands[0]
    if not cands:
        sys.exit("No serial port found. Is the laser plugged in and Kerf closed?")
    sys.exit("Several ports found, pass one with --port:\n  " + "\n  ".join(cands))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--reps", type=int, default=5)
    ap.add_argument("--smax", type=int, default=10, help="max S value ever sent (default 10)")
    ap.add_argument("--feed", type=int, default=12000)
    ap.add_argument("--pause", action="store_true", help="also run the feed-hold experiment")
    ap.add_argument("--no-home", action="store_true", help="skip $H (not recommended)")
    args = ap.parse_args()

    port = args.port or pick_port()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    logname = f"probe-{stamp}.log"
    logf = open(logname, "w")
    w = Wire(port, args.baud, logf)
    p = Probe(w)
    results = []

    print(f"port {port}, log {logname}")
    print("Ctrl-C at any time: sends reset + M5.")

    try:
        w.log("##", "open; waiting for banner")
        banner = w.drain(2.5)
        if not any(l.lower().startswith("grbl") for l in banner):
            w.send_byte(0x18, "RESET")
            banner = w.drain(2.5)
        w.log("##", f"banner: {banner}")
        try:
            p.command("$X")
        except (Wedge, Alarm) as e:
            w.log("##", f"$X: {e}")

        info = read_build_info(p)
        settings = read_settings(p)
        print("build:", " | ".join(info))
        for k in (20, 21, 22, 23, 30, 32, 110, 111, 120, 121, 130, 131):
            if k in settings:
                print(f"  ${k}={settings[k]:g}")
        w.log("##", f"settings: {settings}")

        # Sign convention from the homing direction mask: bit set = homes toward
        # the negative end, so the bed lies in +; clear = homes at the positive end, bed lies in -.
        mask = int(settings.get(23, 0))
        sx = 1 if (mask & 1) else -1
        sy = 1 if (mask & 2) else -1
        print(f"  bed lies toward X{'+' if sx > 0 else '-'} Y{'+' if sy > 0 else '-'} from home ($23={mask})")

        if not args.no_home and settings.get(22, 0) == 1:
            print("homing...")
            ms, term = p.command("$H")
            if term != "ok":
                sys.exit(f"homing failed: {term}")
        p.command("G21")
        p.command("G90")
        p.command("M5")
        # Sanity move: 10 mm into the bed. An alarm here means the sign guess is wrong.
        ms, term = p.command(f"G0 X{sx * 10:.3f} Y{sy * 10:.3f}")
        if term != "ok":
            sys.exit(f"sanity move refused: {term}. Check $23 / bed direction.")
        p.wait_idle()

        variants = build_variants(sx, sy, args.smax, args.feed)
        for rep in range(1, args.reps + 1):
            for name, lines, settle in variants:
                run_variant(p, name, lines, settle, rep, results)
                print(f"  [{rep}/{args.reps}] {name}: {results[-1][2]}")

        if args.pause:
            print("pause experiment (beam at S%d on scrap)..." % args.smax)
            run_pause_experiment(p, sx, sy, args.smax, "M3", results)
            run_pause_experiment(p, sx, sy, args.smax, "M4", results)

        p.command("M5")
        p.command(f"G0 X{sx * 0:.3f} Y{sy * 0:.3f}")
        p.wait_idle()

    except KeyboardInterrupt:
        print("\ninterrupted: reset + M5")
        try:
            reset_and_unlock(w, p, "Ctrl-C")
        except Exception:
            pass
    except Exception as e:
        w.log("!!", f"fatal: {e}")
        print("fatal:", e)
        try:
            reset_and_unlock(w, p, "fatal")
        except Exception:
            pass
    finally:
        # Summary
        print("\n=== SUMMARY ===")
        by = {}
        for name, rep, verdict, detail in results:
            by.setdefault(name, []).append((rep, verdict, detail))
        for name, rows in by.items():
            verdicts = [v for _, v, _ in rows]
            print(f"{name}: " + ", ".join(verdicts))
            for rep, v, d in rows:
                if v != "PASS":
                    print(f"    rep {rep} {v}: {d}")
        summary_lines = [f"{n}: {', '.join(v for _, v, _ in r)}" for n, r in by.items()]
        w.log("##", "SUMMARY " + " || ".join(summary_lines))
        for name, rep, verdict, detail in results:
            if verdict != "PASS":
                w.log("##", f"{name} rep {rep} {verdict}: {detail}")
        w.close()
        logf.close()
        print(f"\nfull trace: {logname}  (send me this file)")


if __name__ == "__main__":
    main()
