"""Tests for probe-grbl.py against a scripted fake serial peer.

No test opens a real port: open_serial is patched to return FakeSerial, and
pyserial is never imported. Run with:
    python3 -m unittest discover -s scripts -p test_probe_grbl.py
"""

import contextlib
import importlib.util
import io
import os
import re
import tempfile
import threading
import time
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("probe_grbl", os.path.join(HERE, "probe-grbl.py"))
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)

DEFAULT_SETTINGS = {10: 3, 21: 1, 22: 1, 23: 1, 30: 1000, 32: 1, 130: 400, 131: 415}
REALTIME_BANNER = "Grbl 1.1f ['$' for help]"

FAST = {
    "DTR_SETTLE_S": 0.0,
    "BANNER_WAIT_S": 0.05,
    "PROBE_EVERY_S": 0.15,
    "IDLE_TICKS": 3,
    "HARD_TIMEOUT_S": 5.0,
    "HOME_TIMEOUT_S": 0.4,
    "CLEANUP_CAPTURE_S": 0.05,
    "HOLD_DELAY_S": 0.05,
    "HOLD_OBSERVE_S": 0.3,
    "STOP_DELAY_S": 0.05,
    "READER_JOIN_S": 1.0,
    "STATUS_WAIT_S": 0.3,
    "QUERY_TIMEOUT_S": 1.0,
    "COMPLETION_TIMEOUT_S": 1.0,
    "OBSERVE_EVERY_S": 0.05,
}


class FakeSerial:
    """A scripted GRBL peer. Records every write in order as ("line", text)
    or ("byte", value) and answers from its script."""

    def __init__(self, settings=None, startup_state="Idle"):
        self.cond = threading.Condition()
        self.out = bytearray()
        self.writes = []
        self.dtr = True
        self.closed = False
        self.settings = dict(DEFAULT_SETTINGS if settings is None else settings)
        self.state = startup_state
        self.mpos = (0.0, 0.0, 0.0)
        self.post_home_state = "Idle"
        self.post_home_mpos = (0.0, 0.0, 0.0)
        self.after_reset_state = "Idle"
        self.g_reply = ["[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]"]
        self.offsets_reply = ["[G54:0.000,0.000,0.000]", "[G92:0.000,0.000,0.000]"]
        self.wco = True
        self.wco_value = "0.000,0.000,0.000"
        self.use_wpos = False
        self.home_error = None
        self.wedge_mode = False
        self.wedged = False
        self.silent = False
        self.state_script = []
        self.line_hooks = []
        self.fail = None
        self.counts = {}

    # -- pyserial surface --------------------------------------------------
    def write(self, data):
        if len(data) == 1 and data != b"\n":
            item = ("byte", data[0])
        else:
            item = ("line", data.decode("ascii").rstrip("\n"))
        self.writes.append(item)
        if self.fail is not None:
            exc = self.fail(item)
            if exc is not None:
                raise exc
        if item[0] == "byte":
            self._realtime(item[1])
        else:
            self._line(item[1])
        return len(data)

    def flush(self):
        pass

    def read(self, n):
        with self.cond:
            if not self.out:
                self.cond.wait(0.02)
            chunk = bytes(self.out[:n])
            del self.out[:n]
            return chunk

    def close(self):
        self.closed = True

    # -- script ------------------------------------------------------------
    def emit(self, *lines):
        with self.cond:
            for text in lines:
                self.out += (text + "\r\n").encode()
            self.cond.notify_all()

    def report(self, state):
        x, y, z = self.mpos
        wco = f"|WCO:{self.wco_value}" if self.wco else ""
        field = "WPos" if self.use_wpos else "MPos"
        return f"<{state}|{field}:{x:.3f},{y:.3f},{z:.3f}|FS:0,0{wco}>"

    def _realtime(self, b):
        if b == 0x3F:  # '?'
            if self.silent:
                return
            state = self.state_script.pop(0) if self.state_script else self.state
            self.emit(self.report(state))
        elif b == 0x18:
            self.silent = False
            self.wedged = False
            self.state = self.after_reset_state
            self.emit(REALTIME_BANNER)

    def _line(self, text):
        self.counts[text] = self.counts.get(text, 0) + 1
        if self.silent or self.wedged:
            pass
        elif text == "$$":
            self.emit(*[f"${k}={v:g}" for k, v in sorted(self.settings.items())], "ok")
        elif text == "$I":
            self.emit("[SIM:synthetic build info]", "ok")
        elif text == "$G":
            self.emit(*(self.g_reply if isinstance(self.g_reply, list) else [self.g_reply]))
            if isinstance(self.g_reply, list):
                self.emit("ok")
        elif text == "$#":
            if isinstance(self.offsets_reply, list):
                self.emit(*self.offsets_reply, "ok")
            else:
                self.emit(self.offsets_reply)
        elif text == "$H" and self.home_error:
            self.emit(self.home_error)
        elif text == "$H":
            self.emit(self.report("Home"))
            self.state = self.post_home_state
            self.mpos = self.post_home_mpos
            self.emit("ok")
        elif self.wedge_mode and (text.startswith("M3") or text.startswith("M4")):
            self.wedged = True
        else:
            self.emit("ok")
        for pred, action in list(self.line_hooks):
            if pred(text, self):
                action(self)

    # -- views -------------------------------------------------------------
    def lines(self):
        return [v for k, v in self.writes if k == "line"]

    def index_of_line(self, text):
        for i, (k, v) in enumerate(self.writes):
            if k == "line" and v == text:
                return i
        return -1


class Harness:
    def __init__(self, test):
        self.test = test
        self.tmp = tempfile.TemporaryDirectory()
        test.addCleanup(self.tmp.cleanup)
        self.log_path = os.path.join(self.tmp.name, "run.log")
        self.open_calls = []
        self.fake = FakeSerial()
        self.open_error = None

    def open_serial(self, port, baud):
        self.open_calls.append((port, baud))
        if self.open_error is not None:
            raise self.open_error
        return self.fake

    def run(self, argv, **patch):
        saved = {}
        values = dict(FAST)
        values.update(patch)
        values["open_serial"] = self.open_serial
        for k, v in values.items():
            saved[k] = getattr(probe, k)
            setattr(probe, k, v)
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = probe.main(argv)
        finally:
            for k, v in saved.items():
                setattr(probe, k, v)
        self.stdout, self.stderr = out.getvalue(), err.getvalue()
        return code

    def log_lines(self):
        with open(self.log_path) as f:
            return [ln.rstrip("\n") for ln in f if ln.strip()]

    def last_line(self):
        return self.log_lines()[-1]


def live_args(h, case, *extra, feed=None):
    argv = ["--case", case, "--port", "FAKE", "--log-file", h.log_path]
    if case != "settings":
        argv += ["--home", "--x-dir", "1", "--y-dir", "-1"]
    if case in probe.BOXED_CASES:
        argv += ["--origin-x", "20", "--origin-y", "20"]
    if case in ("hold-m4", "stop-m4", "completion-m4"):
        argv += ["--feed", str(feed or 300)]
    elif feed is not None:
        argv += ["--feed", str(feed)]
    return argv + list(extra)


def plan_args(case, **kw):
    ns = types.SimpleNamespace(
        case=case, origin_x=20.0, origin_y=20.0, box_mm=60.0, smax=5, feed=300, reps=None,
        x_dir=1, y_dir=-1,
    )
    for k, v in kw.items():
        setattr(ns, k, v)
    return ns


MOTION_PREFIX = ("G0", "G1", "M3", "M4")


def motion_lines(fake):
    return [ln for ln in fake.lines() if ln.startswith(MOTION_PREFIX)]


def after_home(fake):
    i = fake.index_of_line("$H")
    return [v for k, v in fake.writes[i + 1:] if k == "line"] if i >= 0 else []


class ArgumentRefusals(unittest.TestCase):
    def assert_refused(self, h, code, flag):
        self.assertEqual(code, 2)
        self.assertEqual(h.open_calls, [])
        self.assertIn(flag, h.stderr)
        self.assertFalse(os.path.exists(h.log_path))

    def test_pause_retired_E2_M3b(self):
        h = Harness(self)
        code = h.run(live_args(h, "hold-m4") + ["--pause"])
        self.assert_refused(h, code, "--case hold-m4")
        self.assertIn("--pause is retired", h.stderr)

    def test_home_required_E2_M20(self):
        h = Harness(self)
        argv = [a for a in live_args(h, "wedge") if a != "--home"]
        code = h.run(argv)
        self.assert_refused(h, code, "--home")

    def test_reps_refused_for_stop_E2_M24(self):
        h = Harness(self)
        code = h.run(live_args(h, "stop-m4", "--reps", "3"))
        self.assert_refused(h, code, "--reps")

    def test_feed_timing_E2_M27(self):
        h = Harness(self)
        code = h.run(live_args(h, "stop-m4", feed=12000))
        self.assert_refused(h, code, "--feed")
        self.assertTrue(probe.segment_outlasts(300, 1.0))
        self.assertFalse(probe.segment_outlasts(12000, 1.0))

    def test_home_refused_for_settings(self):
        h = Harness(self)
        code = h.run(live_args(h, "settings") + ["--home"])
        self.assert_refused(h, code, "--home")

    def test_existing_log_refused(self):
        h = Harness(self)
        open(h.log_path, "w").close()
        code = h.run(live_args(h, "settings"))
        self.assertEqual(code, 2)
        self.assertEqual(h.open_calls, [])
        self.assertIn("--log-file", h.stderr)


class DryRun(unittest.TestCase):
    def test_every_case_opens_nothing_and_stays_in_box_E2_M6(self):
        for case in probe.CASES:
            with self.subTest(case=case):
                h = Harness(self)
                argv = live_args(h, case) + ["--dry-run", "--smax", "5"]
                code = h.run(argv)
                self.assertEqual(code, 0)
                self.assertEqual(h.open_calls, [])
                self.assertFalse(os.path.exists(h.log_path))
                printed = [ln for ln in h.stdout.splitlines() if not ln.startswith(("#", "[", "-"))]
                for ln in printed:
                    for s in re.findall(r"S(-?[\d.]+)", ln):
                        self.assertLessEqual(float(s), 5)
                if case in probe.BOXED_CASES:
                    self.assertTrue(printed)
                    for ln in printed:
                        for axis, val in re.findall(r"([XY])(-?[\d.]+)", ln):
                            v = float(val)
                            if axis == "X":
                                self.assertTrue(20 <= v <= 80, ln)
                            else:
                                self.assertTrue(-80 <= v <= -20, ln)

    def test_s0_header_E2_M17(self):
        h = Harness(self)
        code = h.run(live_args(h, "wedge") + ["--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("cannot establish positive-power behaviour", h.stdout)
        self.assertIn("[home] $H", h.stdout)

    def test_m4_feed_12000_refused_in_dry_run(self):
        for case in ("hold-m4", "stop-m4"):
            h = Harness(self)
            code = h.run(live_args(h, case, feed=12000) + ["--dry-run"])
            self.assertEqual(code, 2)


class Plans(unittest.TestCase):
    def test_no_rearm_or_resume_byte_E2_M3a_M3c(self):
        for case in probe.CASES:
            steps = probe.build_case_plan(case, plan_args(case), 1, -1)
            for s in steps:
                self.assertNotIn(s.value, (0x9E, 0x7E), f"{case}: {s}")
                if s.kind == "line":
                    self.assertNotIn("~", s.text)
        h = Harness(self)
        code = h.run(live_args(h, "hold-m4"))
        self.assertEqual(code, 0, h.last_line())
        bytes_written = [v for k, v in h.fake.writes if k == "byte"]
        self.assertIn(0x21, bytes_written)
        self.assertNotIn(0x9E, bytes_written)
        self.assertNotIn(0x7E, bytes_written)

    def test_direction_plan_E2_M10(self):
        steps = probe.build_case_plan("direction", plan_args("direction"), 1, -1)
        self.assertEqual(steps[0].kind, "home")
        lines = [s.text for s in steps if s.kind == "line"]
        self.assertEqual(lines[:3], ["G21", "G91", "M5"])
        self.assertEqual(lines[-1], "G90")
        moves = lines[3:-1]
        self.assertEqual(len(moves), 4)
        for mv in moves:
            self.assertTrue(re.fullmatch(r"G1 [XY]-?1\.000 F300", mv), mv)
        for ln in lines:
            self.assertFalse(ln.startswith(("G0", "M3", "M4")), ln)
            self.assertNotRegex(ln, r"S\d")
        h = Harness(self)
        code = h.run(live_args(h, "direction"))
        self.assertEqual(code, 0, h.last_line())
        self.assertEqual(after_home(h.fake), lines)

    def test_boxed_preamble_E2_M23(self):
        for case in probe.BOXED_CASES:
            steps = probe.build_case_plan(case, plan_args(case), 1, -1)
            self.assertEqual(steps[0].kind, "home")
            self.assertEqual([s.text for s in steps[1:4]], ["G21", "G90", "M5"])

    def test_wedge_names_control_E2_C3(self):
        steps = probe.build_case_plan("wedge", plan_args("wedge", reps=1), 1, -1)
        names = [s.text for s in steps if s.kind == "variant"]
        self.assertEqual(names, [
            "preamble_zero_length_then_M4", "rapid_in_flight_then_M4",
            "rapid_then_M4_no_zero_length", "ring_M4", "ring_M3", "two_rings_M3",
            "ring_M4_settle30ms", "ring_M4_wait_idle_before_switch",
        ])

    def test_pure_checks(self):
        self.assertTrue(probe.box_fits(20, 60, 400))
        self.assertFalse(probe.box_fits(380, 60, 400))
        self.assertFalse(probe.box_fits(-1, 60, 400))
        self.assertTrue(probe.position_in_bed((0, 0), 1, -1, (400, 415), 5))
        self.assertFalse(probe.position_in_bed((-50, 0), 1, -1, (400, 415), 5))


class Preflight(unittest.TestCase):
    def assert_refused_before_motion(self, h, code, *needles):
        self.assertEqual(code, 3, h.last_line())
        last = h.last_line()
        self.assertTrue(last.startswith("RESULT REFUSED"), last)
        for n in needles:
            self.assertIn(n, last)
        self.assertEqual(motion_lines(h.fake), [])

    def test_missing_s30_E2_M4(self):
        h = Harness(self)
        del h.fake.settings[30]
        code = h.run(live_args(h, "wedge", "--reps", "1"))
        self.assert_refused_before_motion(h, code, "$30")

    def test_box_does_not_fit_E2_M7(self):
        h = Harness(self)
        argv = live_args(h, "wedge", "--reps", "1")
        argv[argv.index("--origin-x") + 1] = "380"
        code = h.run(argv)
        self.assert_refused_before_motion(h, code, "X")
        self.assertEqual(h.fake.counts.get("$H", 0), 0)
        h = Harness(self)
        argv = live_args(h, "wedge", "--reps", "1")
        argv[argv.index("--origin-y") + 1] = "380"
        code = h.run(argv)
        self.assert_refused_before_motion(h, code, "$131")

    def test_laser_mode_required_E2_M8(self):
        for value in (0, None):
            with self.subTest(s32=value):
                h = Harness(self)
                if value is None:
                    del h.fake.settings[32]
                else:
                    h.fake.settings[32] = value
                code = h.run(live_args(h, "hold-m4"))
                self.assert_refused_before_motion(h, code, "$32", "laser mode")

    def test_nonzero_g54_E2_M14(self):
        h = Harness(self)
        h.fake.offsets_reply = ["[G54:10.000,0.000,0.000]", "[G92:0.000,0.000,0.000]"]
        code = h.run(live_args(h, "wedge", "--reps", "1"))
        self.assert_refused_before_motion(h, code, "G54")

    def test_nonzero_g92_E2_M28(self):
        h = Harness(self)
        h.fake.offsets_reply = ["[G54:0.000,0.000,0.000]", "[G92:0.000,10.000,0.000]"]
        code = h.run(live_args(h, "completion-m4"))
        self.assert_refused_before_motion(h, code, "G92")

    def test_unreadable_offset_E2_M36(self):
        h = Harness(self)
        h.fake.offsets_reply = "error:3"
        h.fake.wco = False
        code = h.run(live_args(h, "hold-m4"))
        self.assert_refused_before_motion(h, code, "work offset unreadable")

    def test_unsupported_offsets_fall_back_to_wco(self):
        h = Harness(self)
        h.fake.offsets_reply = "error:3"
        code = h.run(live_args(h, "completion-m4"))
        self.assertEqual(code, 0, h.last_line())

    def test_smax_above_s30_E2_M15(self):
        h = Harness(self)
        h.fake.settings[30] = 10
        code = h.run(live_args(h, "wedge", "--reps", "1", "--smax", "20"))
        self.assert_refused_before_motion(h, code, "--smax 20")

    def test_homing_disabled_E2_M21(self):
        h = Harness(self)
        h.fake.settings[22] = 0
        code = h.run(live_args(h, "wedge", "--reps", "1"))
        self.assert_refused_before_motion(h, code, "$22")
        self.assertEqual(h.fake.counts.get("$H", 0), 0)

    def test_hold_reaches_first_g0_control_E2_C1(self):
        h = Harness(self)
        code = h.run(live_args(h, "hold-m4"))
        self.assertEqual(code, 0, h.last_line())
        self.assertTrue(any(ln.startswith("G0") for ln in h.fake.lines()))

    def test_direction_not_powered_control_E2_C2(self):
        h = Harness(self)
        h.fake.settings[32] = 0
        code = h.run(live_args(h, "direction"))
        self.assertEqual(code, 0, h.last_line())
        self.assertEqual(h.last_line(), "RESULT COMPLETE")
        self.assertIn("G91", h.fake.lines())


class Homing(unittest.TestCase):
    def test_one_home_no_unlock_E2_M16(self):
        h = Harness(self)
        code = h.run(live_args(h, "wedge", "--reps", "1"))
        self.assertEqual(code, 0, h.last_line())
        lines = h.fake.lines()
        self.assertEqual(lines.count("$H"), 1)
        self.assertNotIn("$X", lines)
        i = lines.index("$H")
        self.assertEqual(lines[i - 1], "M5")
        first_motion = min(j for j, ln in enumerate(lines) if ln.startswith(("G0", "G1")))
        self.assertLess(i, first_motion)

    def test_position_outside_bed_E2_M18(self):
        h = Harness(self)
        h.fake.post_home_mpos = (-50.0, 0.0, 0.0)
        code = h.run(live_args(h, "hold-m4"))
        self.assertEqual(code, 3)
        self.assertTrue(h.last_line().startswith("RESULT REFUSED"))
        self.assertIn("position", h.last_line())
        self.assertEqual(after_home(h.fake), [])

    def test_not_idle_after_home_E2_M25(self):
        h = Harness(self)
        h.fake.post_home_state = "Alarm"
        code = h.run(live_args(h, "wedge", "--reps", "1"))
        self.assertEqual(code, 3)
        self.assertTrue(h.last_line().startswith("RESULT REFUSED"))
        self.assertIn("Alarm", h.last_line())
        self.assertEqual(after_home(h.fake), [])

    def test_startup_alarm_homes_control_E2_C4(self):
        h = Harness(self)
        h.fake.state = "Alarm"
        code = h.run(live_args(h, "wedge", "--reps", "1"))
        self.assertEqual(code, 0, h.last_line())
        lines = h.fake.lines()
        before = lines[:lines.index("$H")]
        self.assertNotIn("M5", before)
        self.assertNotIn("$X", before)
        self.assertEqual(lines[lines.index("$H") + 1], "G21")


class Startup(unittest.TestCase):
    def test_answering_controller_not_reset_E2_M19(self):
        h = Harness(self)
        code = h.run(live_args(h, "settings"))
        self.assertEqual(code, 0, h.last_line())
        self.assertNotIn(("byte", 0x18), h.fake.writes)
        self.assertIn(("line", "$I"), h.fake.writes)
        h = Harness(self)
        h.fake.silent = True
        code = h.run(live_args(h, "settings"))
        self.assertEqual(code, 0, h.last_line())
        self.assertLess(h.fake.writes.index(("byte", 0x18)), h.fake.writes.index(("line", "$I")))

    def test_settings_unsupported_G_E2_M11(self):
        h = Harness(self)
        h.fake.g_reply = "error:3"
        code = h.run(live_args(h, "settings"))
        self.assertEqual(code, 0)
        self.assertEqual(h.last_line(), "RESULT COMPLETE")
        self.assertTrue(any("$G unsupported" in ln for ln in h.log_lines()))
        self.assertIn("$G rep 1 UNSUPPORTED", h.stdout)

    def test_settings_runs_in_alarm(self):
        h = Harness(self)
        h.fake.state = "Alarm"
        code = h.run(live_args(h, "settings"))
        self.assertEqual(code, 0)
        self.assertEqual(motion_lines(h.fake), [])


class Faults(unittest.TestCase):
    def wedge_run(self, h, *extra):
        h.fake.wedge_mode = True
        return h.run(live_args(h, "wedge", "--reps", "2", *extra))

    def test_reset_is_first_write_after_fault_E2_M1_M2_M12(self):
        h = Harness(self)
        code = self.wedge_run(h)
        self.assertNotEqual(code, 0)
        w = h.fake.writes
        stuck = next(i for i, (k, v) in enumerate(w) if k == "line" and v.startswith(("M3", "M4")))
        reset = w.index(("byte", 0x18))
        self.assertLess(stuck, reset)
        self.assertEqual([x for x in w[stuck + 1:reset] if x[0] == "line"], [])
        self.assertEqual([x for x in w[reset + 1:] if x[0] == "line"], [])
        self.assertNotIn("$X", h.fake.lines())

    def test_fault_log_ends_incomplete_E2_M9(self):
        h = Harness(self)
        self.wedge_run(h)
        last = h.last_line()
        self.assertTrue(last.startswith("RESULT INCOMPLETE"), last)
        self.assertIn("wedge", last)

    def test_ctrl_c_resets_first_E2_M13(self):
        h = Harness(self)
        target = "G0 X60.000 Y-60.000"

        def fail(item):
            if item == ("line", target):
                return KeyboardInterrupt()
            return None

        h.fake.fail = fail
        code = h.run(live_args(h, "wedge", "--reps", "1"))
        self.assertEqual(code, 1)
        w = h.fake.writes
        i = w.index(("line", target))
        self.assertEqual(w[i + 1], ("byte", 0x18))
        self.assertTrue(h.last_line().startswith("RESULT INCOMPLETE"))

    def test_dead_port_during_cleanup_E2_M29(self):
        h = Harness(self)
        h.fake.fail = lambda item: OSError("port gone") if item == ("byte", 0x18) else None
        code = self.wedge_run(h)
        self.assertEqual(code, 1)
        last = h.last_line()
        self.assertTrue(last.startswith("RESULT INCOMPLETE"), last)
        self.assertIn("wedge", last)
        h = Harness(self)
        h.open_error = OSError("no such port FAKE")
        code = h.run(live_args(h, "settings"))
        self.assertEqual(code, 1)
        self.assertIn("no such port FAKE", h.last_line())
        self.assertTrue(h.last_line().startswith("RESULT INCOMPLETE"))

    def test_designed_reset_completes_E2_M22(self):
        h = Harness(self)
        h.fake.after_reset_state = "Alarm"
        code = h.run(live_args(h, "hold-m4"))
        self.assertEqual(code, 0, h.last_line())
        w = h.fake.writes
        self.assertEqual(w.count(("byte", 0x18)), 1)
        reset = w.index(("byte", 0x18))
        self.assertEqual([x for x in w[reset + 1:] if x[0] == "line"], [])
        self.assertEqual(h.last_line(), "RESULT COMPLETE")
        self.assertTrue(any("OBSERVE hold" in ln for ln in h.log_lines()))

    def test_stop_designed_reset_completes(self):
        h = Harness(self)
        code = h.run(live_args(h, "stop-m4"))
        self.assertEqual(code, 0, h.last_line())
        self.assertEqual(h.fake.writes.count(("byte", 0x18)), 1)
        self.assertTrue(any("OBSERVE stop" in ln for ln in h.log_lines()))

    def test_rep_gate_E2_M26(self):
        h = Harness(self)
        steps = probe.build_case_plan("wedge", plan_args("wedge", reps=2, smax=0, feed=12000), 1, -1)
        rep2 = next(i for i, s in enumerate(steps) if s.kind == "rep" and s.rep == 2)
        m5_rep1 = 1 + sum(1 for s in steps[:rep2] if s.kind == "line" and s.text == "M5")

        def arm(fake):
            fake.state_script[:] = ["Idle", "Hold"]

        h.fake.line_hooks.append((lambda text, f: text == "M5" and f.counts["M5"] == m5_rep1, arm))
        code = h.run(live_args(h, "wedge", "--reps", "2"))
        self.assertEqual(code, 1)
        last = h.last_line()
        self.assertTrue(last.startswith("RESULT INCOMPLETE"), last)
        self.assertIn("rep 2", last)
        rep1_lines = [s.text for s in steps[:rep2] if s.kind == "line"]
        self.assertEqual(after_home(h.fake), rep1_lines)


class RazorFixes(unittest.TestCase):
    def refused(self, h, code, needle):
        self.assertEqual(code, 3, h.last_line())
        self.assertTrue(h.last_line().startswith("RESULT REFUSED"), h.last_line())
        self.assertIn(needle, h.last_line())
        self.assertEqual(motion_lines(h.fake), [])

    def test_active_wcs_must_be_g54_E2_M37(self):
        h = Harness(self)
        h.fake.g_reply = ["[GC:G0 G55 G17 G21 G90 G94 M5 M9 T0 F0 S0]"]
        code = h.run(live_args(h, "hold-m4", "--smax", "5"))
        self.refused(h, code, "G55")
        self.assertEqual(h.fake.counts.get("$H", 0), 0)

    def test_g_unsupported_uses_wco(self):
        h = Harness(self)
        h.fake.g_reply = "error:3"
        h.fake.wco_value = "100.000,50.000,0.000"
        code = h.run(live_args(h, "hold-m4"))
        self.refused(h, code, "WCO")

    def test_m4_box_floor_E2_F1(self):
        h = Harness(self)
        code = h.run(live_args(h, "hold-m4", "--box-mm", "20"))
        self.assertEqual(code, 2)
        self.assertEqual(h.open_calls, [])
        self.assertIn("--box-mm", h.stderr)

    def test_home_error_goes_to_cleanup_E2_F2(self):
        h = Harness(self)
        h.fake.home_error = "error:9"
        code = h.run(live_args(h, "wedge", "--reps", "1"))
        self.assertEqual(code, 1)
        self.assertTrue(h.last_line().startswith("RESULT INCOMPLETE"), h.last_line())
        self.assertIn("error:9", h.last_line())
        self.assertIn(("byte", 0x18), h.fake.writes)
        self.assertEqual(after_home(h.fake), [])

    def test_completion_timeout_not_done_E2_F3(self):
        h = Harness(self)
        seg = "G1 X45.000 Y-25.000 F300 S0"

        def run_forever(fake):
            fake.state = "Run"

        h.fake.line_hooks.append((lambda text, f: text == seg, run_forever))
        code = h.run(live_args(h, "completion-m4"), COMPLETION_TIMEOUT_S=0.3)
        self.assertEqual(code, 1)
        self.assertTrue(h.last_line().startswith("RESULT INCOMPLETE"), h.last_line())
        self.assertIn(("byte", 0x18), h.fake.writes)

    def test_completion_sends_m5_E2_F4(self):
        h = Harness(self)
        code = h.run(live_args(h, "completion-m4"))
        self.assertEqual(code, 0, h.last_line())
        lines = after_home(h.fake)
        self.assertTrue(lines[-2].startswith("G1 "), lines)
        self.assertEqual(lines[-1], "M5")
        self.assertTrue(any("OBSERVE completion" in ln for ln in h.log_lines()))

    def test_startup_state_gate_E2_F5(self):
        h = Harness(self)
        h.fake.state = "Hold"
        code = h.run(live_args(h, "wedge", "--reps", "1"))
        self.refused(h, code, "Hold")
        self.assertEqual(h.fake.counts.get("$H", 0), 0)

    def test_nonzero_wco_fallback_E2_F6(self):
        h = Harness(self)
        h.fake.offsets_reply = "error:3"
        h.fake.wco_value = "10.000,0.000,0.000"
        code = h.run(live_args(h, "hold-m4"))
        self.refused(h, code, "WCO")

    def test_missing_g54_line_E2_F7(self):
        h = Harness(self)
        h.fake.offsets_reply = ["[G92:0.000,0.000,0.000]"]
        code = h.run(live_args(h, "wedge", "--reps", "1"))
        self.refused(h, code, "G54 work offset is not reported")

    def test_post_home_no_mpos_E2_F8(self):
        h = Harness(self)
        h.fake.use_wpos = True
        code = h.run(live_args(h, "hold-m4"))
        self.assertEqual(code, 3, h.last_line())
        self.assertIn("no MPos", h.last_line())
        self.assertEqual(after_home(h.fake), [])

    def test_idle_after_lead_before_m4_E2_F9(self):
        h = Harness(self)
        lead = "G0 X25.000 Y-25.000"

        def moving(fake):
            fake.state_script[:] = ["Run", "Run", "Idle"]

        h.fake.line_hooks.append((lambda text, f: text == lead, moving))
        code = h.run(live_args(h, "hold-m4"))
        self.assertEqual(code, 0, h.last_line())
        w = h.fake.writes
        between = w[w.index(("line", lead)) + 1:w.index(("line", "M4 S0"))]
        self.assertGreaterEqual(between.count(("byte", 0x3F)), 3)

    def test_pause_without_case_E2_F10(self):
        h = Harness(self)
        code = h.run(["--pause", "--port", "FAKE", "--log-file", h.log_path])
        self.assertEqual(code, 2)
        self.assertEqual(h.open_calls, [])
        self.assertIn("--pause is retired", h.stderr)
        self.assertNotIn("--case is required", h.stderr)
        self.assertFalse(os.path.exists(h.log_path))


class LiveMatchesDryRun(unittest.TestCase):
    def test_signs_come_from_operator_E2_M5(self):
        h = Harness(self)
        argv = live_args(h, "wedge", "--reps", "1")
        argv[argv.index("--x-dir") + 1] = "-1"
        code = h.run(argv)
        self.assertEqual(code, 0, h.last_line())
        xs = [float(v) for ln in h.fake.lines() for v in re.findall(r"X(-?[\d.]+)", ln)]
        self.assertTrue(xs)
        for x in xs:
            self.assertLessEqual(x, 0)
        live = after_home(h.fake)
        d = Harness(self)
        dargv = list(argv)
        dargv[dargv.index("--log-file") + 1] = d.log_path
        self.assertEqual(d.run(dargv + ["--dry-run"]), 0)
        printed = [ln for ln in d.stdout.splitlines() if not ln.startswith(("#", "[", "-"))]
        self.assertEqual(printed, live)


if __name__ == "__main__":
    unittest.main()
