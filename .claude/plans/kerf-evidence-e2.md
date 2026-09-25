# Kerf evidence E2: the probe can no longer re-arm the beam or run powered without a laser-mode readback, and a qualification card says how to use it

**Lifted from:** `/home/leesalo/marvin/state/audits/gap-2026-09-24/kerf/PLAN-silent-drop-and-evidence.md` §E2 (critic `PLAN-silent-drop-and-evidence-critic.md`, CONCERN, folded).

**Lineage:** `.claude/plans/kerf-relay-plan.md` §C1 (critic `kerf-relay-plan-critic.md`, must-fix 6 restored), astra `~/marvin/state/audits/kerf-astra-2026-09-08/PLAN.md` §3.1 (acceptance 1-4) and the §3.2 card steps it feeds. Where this file and a relay-plan body differ, this file wins. On anything this file does not cover, the parent wins. Where this file departs from the parent, the departure is named under "Departures from the parent".

**Citations:** re-read at `a6ddc3a` on session branch `marvin/kerf-gap` (source = master `caa0dcc`; `git diff --stat caa0dcc HEAD -- scripts docs` is empty) on 2026-09-25. Critic-fold citations re-read at `10be8a2` (same `scripts/` and `docs/` content).

- **Relay id:** `kerf-evidence-e2`
- **Branch:** `relay/kerf-evidence-e2`
- **Tier:** Standard. 3 files, two roots (`scripts/`, `docs/`). **Waiver (two roots):** the card documents the script's CLI and refusal rules and is reviewed against it as one unit; splitting them would let the card describe a CLI that does not exist.
- **Size, stated honestly:** `probe-grbl.py` is rewritten, not patched. Today 547 lines; expect roughly 700-850 after the rewrite (case builders, preflight, home step, cleanup, testability seams). `test_probe_grbl.py` is new, roughly 600-800 lines (a scripted fake serial peer plus 35 battery ids after the critic fold: 31 mutants and 4 controls). The card is roughly 100-150 lines of Markdown.

## Intent (grilled)

Grill skipped. The intent is the parent's Intent, which cites CHARTER "Done looks like" (3) and these DECISIONS entries: 2026-09-10 "The laser-switch wedge requires a captured trigger and a prevention before release"; 2026-09-10 "Hardware evidence for this program is status-only"; 2026-09-20 "Abort sends 0x18 immediately — no feed hold, no M5, no ack wait"; 2026-09-05 "`0x9E` is a TOGGLE ... Kerf's pause volley re-arms the beam"; 2026-09-05 "The owner's controller is a vendor GRBL fork"; the "Public repo" header rule.

Summary for this batch:
- Release is blocked until the wedge's trigger is captured on the owner's machine, and the probe is the only tool for capturing it.
- Today the probe still sends the byte proven to re-arm the beam, guesses bed direction from a homing setting, homes and unlocks the machine by itself, sends `M5` and `$X` lines before its reset after a fault, and never checks that laser mode is on before firing.
- After this batch: every powered case refuses before motion unless the controller reported `$32=1`, `$30`, `$130` and `$131`; coordinates and directions come from the operator; the probe never unlocks, never resets a controller that answers `?`, and homes only because the operator typed `--home` (which every motion case requires, so each invocation starts from a fresh home); a fault or Ctrl-C sends the realtime reset first and nothing else; and a log that does not end in `RESULT COMPLETE` is incomplete by construction.
- Evidence stays status-only: the log records what was sent, what the controller reported, and markers for when the operator should note whether motion stopped. It never records or implies that the beam went dark.

## Existing plans reviewed

Checked 2026-09-25 with `ls` (so untracked files show):
- Primary `/home/leesalo/Projects/kerf/.claude/plans/`: 23 files plus `archive/` (3 files).
- Session branch `.claude/plans/`: 28 files plus `archive/` (the primary's 23, plus `charter-gap-analysis.md`, `kerf-evidence-e1a.md` and critic, `kerf-safety-s1.md` and critic).
- Audit directory `~/marvin/state/audits/gap-2026-09-24/kerf/`: 9 files.

**Relays in flight and the files they edit:**
- `kerf-refresh-cut-vs-screen` (R1): viewport, geometry, store, fileOps, `App`, `svgExport`, `geometryActions`.
- `kerf-evidence-e1a`: `gcodeGen.ts` and its test.
- `kerf-safety-s1`: `canStartJob.ts`, `MaterialTestDialog.tsx`, `JobActionBar.tsx`, `GrblSettingsDialog.tsx`, `connection.ts` (send / `enableLaserMode` / settings readback only), `canStartJob.test.ts`, `connection.test.ts`, `machineJobLoop.test.tsx`.

None of them edits `scripts/` or `docs/`. `grep -l 'probe-grbl\|qualification-card\|test_probe_grbl'` over every plan above hits only the parent, the relay plan and the two critics, all of which this file lifts from. **Refreshed at `10be8a2`:** the session branch now holds 34 files plus `archive/` (the E2, E3 and E5 plans and their critics landed since). The same grep also hits `charter-gap-analysis.md` (S1 and F10 cite the probe and its log as evidence), `kerf-evidence-e5.md` and its critic (they cite the capture's status grammar). None of the three edits `scripts/` or `docs/`. The parent's E4 (`docs/test-card.md`) points at the card this batch creates and dispatches only after this batch merges. The Stage 0 re-check repeats this inventory.

## Diagnosis (verified, read at `a6ddc3a`)

`scripts/probe-grbl.py`, 547 lines:
- **Re-arm byte.** `run_pause_experiment` sends `0x9E` after the feed hold (`:404`). DECISIONS 2026-09-05 says that byte re-arms the beam.
- **Direction guessed.** `main` infers X/Y sign from `$23` (`:475-480`) and makes a "sanity move" into the bed on that guess (`:490-493`). The builder's docstring says so (`:292-293`).
- **Automatic homing and unlock.** `main` sends `$X` at startup (`:462-465`) and `$H` when `$22=1` unless `--no-home` (`:482-486`). Astra 3.1 forbids both ("Do not ... auto-home, auto-unlock after a fault").
- **Cleanup is not realtime-first.** `reset_and_unlock` sends `0x18`, then `$X`, then an awaited `M5` (`:228-243`). There are **six** callers: the `error:` reply path (`:345`), the wedge path (`:375`), the alarm path (`:379`), the pause experiment's `finally` (`:419`), Ctrl-C (`:514`), and any fatal exception (`:521`).
- **A line is written between the fault and the reset.** The wedge path sends `?` (`:357`) and then the line `G4 P0` (`:361`), and waits up to 3 s for its answer, before it calls `reset_and_unlock` (`:375`). The parent's Context names the wedge path but not this line.
- **After a fault the run continues** with the next variant (`:497-500`), which astra 3.1 acceptance 2 forbids.
- **No settings check.** `read_settings` (`:246-265`) parses `$$`, but nothing reads `$30` or `$32`. `--smax` defaults to 10, and the comment assumes a 1000 scale (`:19`, `:438`). The M3/M4 variants (`:299-327`) and the pause experiment (`:394`) fire at `S{smax}` regardless.
- **Log lands in the working directory.** `probe-{stamp}.log` is written to the current directory (`:445-447`), which is how `scripts/probe-20260914-153729.log` came to be committed (decision `kerf-d12`).
- **pyserial is required even to print help.** `import serial` runs at module load and exits if it is missing (`:36-39`).
- **CLI today:** `--port --baud --reps --smax --feed --pause --no-home` (`:435-441`).
- **The controller model is named in a comment** (`:53`), inside the DTR-toggle comment block (`:48-53`). That is pre-existing and belongs to `kerf-d12`. This batch must not edit, move or re-indent `:48-53`, so the Razor grep of added lines stays meaningful.
- **The absolute-mode preamble lives outside the variants.** `main` sends `G21`, `G90`, `M5` once before the matrix (`:487-489`). The variant lines are absolute targets (`G0 X40…`) and carry no `G90` of their own (`:299-327`).
- **`Wire.close()` does not join the reader** (`:114-120`). It sets `_stop`, sleeps 0.1 s and closes the port. The reader thread logs every received line (`:91`), so a late line can land after anything the main thread writes last.
- **The old pause experiment crawled on purpose:** "~70 mm at 300 mm/min = 14 s of motion to pause inside" (`:395-396`).
- **The module docstring `:3-25` documents the old CLI** (auto-picked port, `--pause`, "default 10", "Ctrl-C sends soft reset (0x18) then M5").
- **The `:235` comment says "Homing-enabled builds lock into Alarm after a reset".** That is stock-GRBL knowledge. Nothing in the capture confirms or refutes it for this fork (see below).
- There is no `scripts/test_probe_grbl.py` and no `docs/qualification-card.md`.

**What the committed capture shows (read only for its settings, no identity copied):** the `$$` block carries `$22=1`, `$23=1`, `$30=1000.000`, `$32=1`, `$130=400.000`, `$131=415.000` (`scripts/probe-20260914-153729.log:27-43`). Status reports carry `WCO:0.000,0.000,0.000`. So the preflight below can pass on this controller. Also, re-read at `10be8a2`:
- **Hard limits are on:** `$21=1` (`:26`). This is the controller-enforced backstop if a frame is wrong: a move into a rail trips a limit switch and the controller alarms.
- **On this board the old probe's startup reset was the normal path.** The DTR toggle produced no banner within the 2.5 s wait. The `0x18` at `:2` did (`:3-4`).
- **The state a reset leaves is not recorded.** `$X` after each reset answered a bare `ok` (`:6`, `:899-900`, `:963-964`), and no `<Alarm` report appears anywhere. But no `?` was ever sent between a reset and its `$X`, so this suggests Idle and proves nothing.
- **The frame on that day:** after `$H` (`:57-58`), `G0 X10.000 Y-10.000` settled at `MPos:10.000,-10.000` (`:66-70`). Home was machine zero, and the bed lay toward +X, −Y. That is the basis for the `--x-dir 1 --y-dir -1` used under Verification.

## Change

### 1. `scripts/probe-grbl.py` (rewrite)

**CLI contract.**

| Flag | Rule |
|---|---|
| `--case {settings,direction,wedge,hold-m4,stop-m4,completion-m4}` | Required. No default case. |
| `--dry-run` | Opens no port and globs no port. Prints the header and the full command matrix, then exits 0. |
| `--port` | Required unless `--dry-run`. `pick_port` (`:424-430`) is deleted. |
| `--log-file` | Required unless `--dry-run`. Refuses an existing path. No log is ever written to a default name in the working directory. |
| `--origin-x`, `--origin-y` (mm) | Required for `wedge`, `hold-m4`, `stop-m4`, `completion-m4`. |
| `--x-dir`, `--y-dir` (`-1` or `1`) | Required for every case except `settings`. No default, never inferred. |
| `--box-mm` | Default 60. Must be > 0. For the three M4 cases it must be ≥ 30 (the unscaled 25 mm reach of the segment below, plus margin). |
| `--home` | **Required for `direction` and the four boxed cases; exits 2 for `settings`**, which never moves. It adds a home step before any case line: `M5` (only if the controller reports Idle; GRBL refuses G-code lines in Alarm), then `$H`, then a bounded wait for Idle (`HOME_TIMEOUT_S`). Refused in preflight unless `$22=1`. The step is printed in the dry-run matrix like every other step. See Departures 3. |
| `--smax` | Integer ≥ 0. **Default 0**, so positive power is only ever an explicit operator choice. |
| `--feed`, `--baud` | Kept, same defaults (12000, 115200). **For `hold-m4` and `stop-m4` the feed must pass the timing check below**, so the default refuses and the card writes `--feed 300`. |
| `--reps` | Default 5 for `wedge` and `completion-m4`, 1 for `hold-m4` and `stop-m4`. **An explicit `--reps` > 1 with `hold-m4` or `stop-m4` exits 2** before any port is opened: their designed reset may leave Alarm, and each repetition needs its own fresh home. See Departures 6. |
| `--stop-on-fault` | Accepted, and the only behaviour: a fault always ends the run (astra 3.1 acceptance 2). The flag stays so the astra 3.2 command lines keep working. |
| `--pause` | Exits 2 before anything else: "--pause is retired: it sent 0x9E, which re-arms the beam. Use --case hold-m4." |
| `--no-home` | Removed. The probe never homes on its own; `--home` is the explicit operator request that replaces it. |

**Argument refusals (exit 2, before the log is opened and before `open_serial`)**, each with a message naming the flag: a missing required flag, a retired flag, `--home` with `settings`, `--reps` > 1 with `hold-m4`/`stop-m4`, a box below its floor, and the timing check. The timing check is a pure `segment_outlasts(feed, delay) -> bool`: `SEGMENT_MM * 60 / feed > delay + TIMING_MARGIN_S`, with `delay` = `HOLD_DELAY_S` for `hold-m4` and `STOP_DELAY_S` for `stop-m4`. With `SEGMENT_MM = 20`, both delays 1.0 s and `TIMING_MARGIN_S = 1.0`, the fastest admitted feed is 600 mm/min. F300 gives 4 s of motion, and the hold or stop lands at about 1 s. The default F12000 finishes in 0.1 s and is refused, which is the point: a hold or stop sent after motion has ended observes an Idle controller and records a trivially true "motion ceased".

**Coordinates.** For the wedge sequences, `P(u, v)` returns `X{x_dir*(origin_x + u*box/60)} Y{y_dir*(origin_y + v*box/60)}`, with `u` and `v` in the existing 0-60 frame. At the default `--box-mm 60` this reproduces today's variant geometry exactly. **The three M4 cases do not scale:** `Q(dx, dy)` returns `X{x_dir*(origin_x + dx)} Y{y_dir*(origin_y + dy)}` with `dx`, `dy` in millimetres, so their segment is 20 mm at any box size, and the box floor of 30 keeps its far end (25 mm) inside the checked box. Absolute moves use `G90`.

**Cases.** Each case is a pure builder, `build_case_plan(case, args, x_dir, y_dir) -> list[Step]`. A `Step` is a line, a realtime byte, a home step, a wait-for-Idle, an observe window, or a designed reset. Both the dry-run path and the live path call it with `args.x_dir, args.y_dir` passed explicitly, so the live call site is the one place a direction is chosen (and the one place E2-M5 mutates). Dry-run prints exactly this list, and the live runner executes exactly this list. **Every motion case starts with the home step** (`--home` is required for them), then its preamble. The four boxed cases share one module constant, `BOXED_PREAMBLE = ["G21", "G90", "M5"]`, so absolute mode never depends on what an earlier, interrupted invocation left modal (a `direction` run killed mid-way leaves `G91`).
- **`settings`:** `?`, `$I`, `$$`, `$G`, `$#`, each recorded raw. No motion, no M-code, no home. An `error:` reply to `$G` or `$#` is recorded as "unsupported" in the log and the summary, never as success. **It runs in Alarm as well as Idle** (these are `$` queries, not motion), so the owner can record the state the controller is in after the probe opens the port.
- **`direction`:** home step, then `G21`, `G91`, `M5`, then four `G1` 1 mm steps at `F300` (+X, −X, +Y, −Y, signed by `--x-dir`/`--y-dir`), then `G90`. No `G0`, no `M3`, no `M4`, no `S` word anywhere. This matches astra 3.2 step 2 ("four explicit 1 mm relative G21 jogs ... at F300"). It is the beam-off direction check the card requires before any powered case. It is not a powered case, so it does not need `$32=1`.
- **`wedge`:** home step, `BOXED_PREAMBLE`, then the eight existing sequences (`:299-327`), with their names and order unchanged, × `--reps`.
- **`hold-m4`:** home step, `BOXED_PREAMBLE`, a `G0` lead to `Q(5, 5)`, `M4 S{smax}`, `G1` to `Q(25, 5)` with explicit `F{feed} S{smax}`. After `HOLD_DELAY_S` it sends realtime `!` and observes with `?` every 250 ms for `HOLD_OBSERVE_S` (5 s). Then comes a **designed reset step**: realtime `0x18`, then a capture of the reply and one `?` for `CLEANUP_CAPTURE_S`. **It never sends `~` and never sends `0x9E`.** The status-only ruling makes a dark hold unqualifiable, so a resume is never offered.
- **`stop-m4`:** the same lead and segment. After `STOP_DELAY_S` comes the designed reset step, during motion. No recovery follows.
- **`completion-m4`:** the same lead and segment, then `M5`. It polls `?` until Idle (bounded at 30 s), recording every report.

**A designed reset is a step, not a fault.** It is part of the plan, it is printed in the dry run, and its capture reads with `drain`, so the reset banner is expected there and does not trip the unexpected-banner fault (that check lives only in `Probe.command`, `:191-192`). A run whose designed reset and capture both finish ends **`RESULT COMPLETE`**, whatever state the capture records (Alarm included). Only faults go through `cleanup`.

**Observe markers.** At the moment of a hold, a stop, the last ack and completion, the probe logs and prints `## OBSERVE <what>: note whether motion ceased`. The operator's paper note then ties to a log timestamp. The marker never says anything about the beam.

**Preflight (live only, before any motion line).** In order:
1. Open the port (the DTR toggle at `:54-57` is unchanged) and drain for `BANNER_WAIT_S`, recording any banner.
2. **Ask before resetting.** Send `?` and wait up to `BANNER_WAIT_S` for a status report. **If any report arrives, the probe does not reset**: a controller that reports a state is never reset at startup. Only if nothing at all answers does it send `0x18` once, drain, and send `?` again. If that also goes unanswered, the run ends `RESULT INCOMPLETE: controller not answering`. This replaces today's reset-on-no-banner (`:457-460`), which on this board fired every run (Diagnosis) and could have put a homing-locked fork into Alarm that the probe then refused forever.
3. Record the startup state, then `$I`, `$$`, `$G`, `$#` raw. For `settings` the case ends here, `RESULT COMPLETE`, in Idle or in Alarm.
4. Refuse, listing every reason, if any of these fails. **These run before the home step, so a refusal here moves nothing:**
   - For the motion cases: the startup state is not `Idle` or `Alarm` (for example `Hold`, `Run`, `Door`, `Jog`). The accepted set is one tuple, `STARTUP_STATES = ("Idle", "Alarm")`. Alarm is accepted only because `$H` is GRBL's own way out of the homing lock and the next step homes. The probe still never sends `$X`.
   - For the motion cases: `$22` absent or not `1` (the home step needs homing enabled).
   - `$30` absent. There is no default ceiling.
   - `--smax` > `$30`.
   - For `wedge`, `hold-m4`, `stop-m4` and `completion-m4` (`POWERED_CASES`): `$32` absent or not `1`. The message says that without laser mode GRBL keeps the beam energised through rapids, so the traverse would run with the beam on. **No override flag** (parent Critic fold, rejected item 1).
   - For the boxed cases: `$130` or `$131` absent.
   - For the boxed cases: the box does not fit, i.e. `box_fits(origin, box, bed)` fails on either axis. That check is `0 <= origin` and `origin + box <= bed`.
   - For the boxed cases: `$#` reports a non-zero `G54` **or `G92`** X or Y. The bounds check assumes the work frame is the machine frame, and `G92` shifts it exactly as `G54` does.
   - For the boxed cases: `$#` is unsupported (an `error:` reply) **and** the post-home `?` report carries no `WCO:` field. A work offset that cannot be read refuses; it is never assumed zero. When `$#` is unsupported but `WCO:` is present, a non-zero `WCO` X or Y refuses exactly as a non-zero `G54`/`G92` does (the capture reports `WCO:` in status). Battery id E2-M36: `$#` answering `error:3` and a status report with no `WCO:` for a boxed case: refused before motion; wrong variant: treat the unreadable offset as zero.
5. **Home step** (every motion case): `M5` if the state is Idle, then `$H` through `Probe.command`, bounded by `HOME_TIMEOUT_S`. An `error:` or `ALARM` reply to `$H` is a fault and goes to `cleanup`. Then send `?` and refuse if either fails:
   - The state after homing is not `Idle`.
   - For the boxed cases, the reported `MPos` lies outside the bed on the operator's signs: the pure `position_in_bed(mpos, x_dir, y_dir, bed, tol)` requires `-tol <= dir * mpos <= bed + tol` on X and Y, with `tol = POSITION_TOL_MM` (5). A report without `MPos` refuses. This catches a home that did not land where the operator's signs say the bed is. On the capture, home was `MPos` 0,0 (Diagnosis).
6. A refusal writes `RESULT REFUSED: <reasons>` as the last log line and exits 3. Nothing after the refusal is sent, and no case line was sent before it. The backstop if all of this is wrong on the day is `$21=1`, hard limits, on the capture (`:26`).
7. **Before every repetition** the runner sends `?` and requires `Idle`. If the controller is not Idle, the run ends `RESULT INCOMPLETE: controller not Idle before rep N (the probe never unlocks)`. `hold-m4` and `stop-m4` are one repetition per invocation by argument rule, and each invocation homes again, which is what GRBL asks for after an abort during motion.

**Cleanup (one function, every fault path).** `cleanup(wire, reason) -> str`:
1. `wire.send_byte(0x18, "RESET")` is the **first write**. No line and no `?` goes before it.
2. It drains for `CLEANUP_CAPTURE_S`, then sends one `?` and records the reply.
3. Steps 1-2 sit inside one `try` whose `except Exception` logs `!! cleanup: <error>` and never re-raises, so a dead port (the reader's `__EOF__`, or a write that raises) still reaches step 4. If `wire` is `None` (the fault came before `open_serial` returned), steps 1-2 are skipped.
4. It returns `f"RESULT INCOMPLETE: {reason}"`. The caller stores it as the run's result, with exit code 1.
5. **No `M5`, no `$X`, no `$H`, no replay, no next variant.**

Callers (each does `result = cleanup(wire, reason)`):
- the `error:` reply, wedge, alarm and unexpected-banner paths inside a case, and a failed home step;
- `KeyboardInterrupt`;
- any other exception, including one raised by `open_serial`.

`reset_and_unlock` and the wedge path's `?` + `G4 P0` diagnostic (`:357-374`) are deleted. The three or more consecutive Idle replies that raise the wedge are already in the log before cleanup runs.

**The RESULT line (one writer, written last).** `main` sets `result = "RESULT INCOMPLETE: ended before a result was reached"` and exit code 1 before opening the port. Only three things change it: the success path of a case (`RESULT COMPLETE`, 0), a refusal (`RESULT REFUSED: …`, 3), and `cleanup` (above, 1). `main`'s outermost `finally` calls `finish(wire, logf, result)`, which logs the summary, then calls `wire.close()`, then writes `result` from the main thread as the file's last line, then closes the file. **`Wire.close()` joins the reader thread** (bounded by `READER_JOIN_S`, 1 s; the reader's read timeout is 0.05 s, `:47`) before it closes the port, replacing the `time.sleep(0.1)` at `:116`. So no reader line can land after the RESULT line. If the join times out, `finish` replaces the result with `RESULT INCOMPLETE: reader thread did not stop`.

**Exit codes:** 0 `RESULT COMPLETE`; 1 `RESULT INCOMPLETE`; 2 argument refusal or retired flag (no port opened, no log written); 3 `RESULT REFUSED` (no case line sent). The card lists them.

**Log format.** The existing `Wire.log` format is kept (monotonic ms, direction, text; `:66-72`). The header lines are:
- `probe-grbl case=… reps=… smax=… feed=… origin=… dirs=… box=… home=…`
- `A run is complete only if its last line is "RESULT COMPLETE". Any other ending, including no RESULT line, is INCOMPLETE.` A crashed process cannot rewrite its own header, so the rule reads the absence of the terminal line as incomplete. See Departures.
- When `--smax 0` or `--dry-run`: `This run cannot establish positive-power behaviour (S0 or dry run).`

**Module docstring `:3-25` is rewritten** to the new CLI: `--case` required, `--port` and `--log-file` required for live runs, `--home` required for motion cases, `--smax` default 0, no `--pause`, the cleanup order (reset first, nothing after), the exit codes, and a pointer to `docs/qualification-card.md`. It names no controller vendor or model, as today.

**Testability seams (required, so the tests reach production code):**
- `main(argv: list[str] | None = None) -> int`, with `sys.exit(main())` under `__main__`.
- `open_serial(port, baud)` does the `import serial` lazily and returns `serial.Serial(port, baud, timeout=0.05)`. `Wire.__init__` calls it at the line that is `:47` today. `--help` and `--dry-run` therefore work without pyserial.
- Module-level timing constants that tests patch: `DTR_SETTLE_S` (used by the `time.sleep(1.5)` at `:57`; lines `:48-53` are untouched), `BANNER_WAIT_S`, `PROBE_EVERY_S`, `IDLE_TICKS`, `HARD_TIMEOUT_S`, `HOME_TIMEOUT_S`, `CLEANUP_CAPTURE_S`, `HOLD_DELAY_S`, `HOLD_OBSERVE_S`, `STOP_DELAY_S`, `READER_JOIN_S`. **Tests never patch `TIMING_MARGIN_S` or `SEGMENT_MM`**, so the timing check keeps its meaning under patched delays (F300 passes, F12000 refuses).
- `POWERED_CASES`, `STARTUP_STATES` and `BOXED_PREAMBLE` are module-level constants. `preflight(case, args, settings, status, offsets) -> list[str]`, `segment_outlasts(feed, delay) -> bool`, `box_fits(...)` and `position_in_bed(...)` are pure.

**Must not change:** the eight sequence names, their line order and their settle/@IDLE behaviour, and lines `:48-53`. The rewrite also adds no controller vendor or model name, no firmware string, and no `[VER:` or `[OPT:` text (DECISIONS "Public repo").

### 2. `scripts/test_probe_grbl.py` (new, `unittest`)

- Load the script with `importlib.util.spec_from_file_location("probe_grbl", <path>)`, because the hyphen blocks `import`.
- Put a stub `serial` module in `sys.modules`, or patch `open_serial`, so the tests never need pyserial and never touch a device. **No test opens a real port.**
- The `FakeSerial` peer records every write in order and answers from a scripted table:
  - `?` → `<Idle|MPos:…|FS:0,0>`, or `<Run|…>` while a scripted motion runs.
  - `$$` → a settings list the test chooses.
  - `$I` → a **synthetic** reply such as `[SIM:synthetic build info]` then `ok`. Never a `[VER:`/`[OPT:` line and never a real identity.
  - `$G` → `error:3` or a `[GC:…]` line, as the test chooses.
  - `$#` → `[G54:…]`, `[G92:…]`, then `ok`.
  - `$H` → one or more `<Home|…>` reports, then `ok`, then a scripted post-home position (default `MPos:0.000,0.000,0.000`).
  - motion lines → `ok`.
  - `0x18` → the stock banner `Grbl 1.1f ['$' for help]`.
  - a wedge mode: after the next `M3`/`M4`, no `ok` until `0x18`, and `?` answers Idle.
  - a per-query script: the Nth `?` can answer a chosen state (for the startup state, the post-home state and the per-rep gate).
  - a silent mode (no banner and no answer to `?` until `0x18`), a write-failure mode (a chosen write raises `OSError`), and an `open_serial` that raises.
- Every motion-case test, live or dry-run, passes `--home`, and every live one scripts `$22=1`, unless it is testing that refusal. The M4 tests pass `--feed 300`.
- Every test patches the timing constants to small values and writes its `--log-file` under `tempfile.TemporaryDirectory()`. Nothing is written in `scripts/`. (The battery copies untracked files into its disposable tree, `mutation-battery.mjs:1131-1145`, and reports as stray any path whose `git status --porcelain` entry changes under the test command, `:1845`, `:1877-1879`, `diffStatus` `:1921`. A log written in `scripts/` would be such a path; `__pycache__/` is gitignored and porcelain without `--ignored` never lists it.)

### 3. `docs/qualification-card.md` (new; public, procedure only)

Sections, in order:
1. **Prerequisites.**
   - Kerf closed, so the port is free.
   - Output isolated by the owner's established procedure for the S0 runs.
   - The independent physical stop within reach.
   - `--case settings` run and `$21`, `$22`, `$30`, `$32`, `$130`, `$131`, the `G54` and `G92` offsets and the reported state noted.
   - `--case direction --home` run, and the observed direction of each 1 mm step recorded, with how the direction case keeps the beam off stated in one sentence: `M5` first, and no `M3`, `M4` or `S` word.
   - A low-power ceiling chosen at or below `$30`.
2. **Homing.** Every motion case is run with `--home`. The probe homes at the start of each invocation and at no other time; it never unlocks. If the controller is in Alarm, `--home` is how it leaves it. If the home step fails, the run ends `RESULT INCOMPLETE`: stop there and keep the log. Because each invocation homes, the position a `hold-m4` or `stop-m4` reset leaves behind is never trusted by the next run.
3. **Print and review the dry run.** The exact `--dry-run` command for the planned case, and a check that every coordinate lies inside the box.
4. **Cases in order:** `settings` → `direction` → `wedge` at `--smax 0` (output isolated) → `stop-m4` → `hold-m4` → `completion-m4`. Each positive-power step is an explicit operator choice. `stop-m4` and `hold-m4` are one repetition per invocation (the probe refuses more), so three repetitions are three invocations, each with a fresh log. Their command lines carry `--feed 300`: the probe refuses any feed at which the 20 mm segment would end before the hold or stop is sent (above 600 mm/min).
5. **What to record per case:**
   - the log's monotonic timestamps at each `## OBSERVE` marker;
   - the TX/RX lines around it;
   - the status state (a marker beside an `Idle` report means motion had already ended, and the observation proves nothing);
   - "motion ceased: y/n", written by hand.
   There is no field for beam state.
6. **The INCOMPLETE rule and the exit codes:** only a log ending `RESULT COMPLETE` counts. A `RESULT REFUSED` or `RESULT INCOMPLETE` log is kept as evidence of what happened, never as a pass. Exit codes: 0 complete, 1 incomplete, 2 the command line was refused (nothing opened), 3 refused by the controller checks (nothing moved except, at most, the home).
7. **Where logs go:** pass `--log-file` pointing into the private evidence register, whose location is held outside this repository. **No path, no firmware string and no incident narrative is written in the card.**

## Tests and mutants

**Battery spec `kerf-evidence-e2`:**
- `test_command`: `["python3","-m","unittest","discover","-s","scripts","-p","test_probe_grbl.py"]`.
- **The battery can run it.** `normaliseSpec` accepts any non-empty argv (`~/marvin/scripts/mutation-battery.mjs:1540-1553`), and `runTest` spawns it in the copy with the inherited environment minus `GIT_*` (`:1328-1340`, `scrubbedEnv` `:790-796`).
- On this host Python is 3.12.3, where a discover that finds no tests **exits 5** (measured). A mis-pointed pattern therefore makes the baseline red and the battery refuses, rather than scoring a vacuous green.
- `__pycache__/` and `*.pyc` are gitignored (`.gitignore:39-40`), so compiled bytecode never shows in `git status --porcelain` and is not a stray path.
- `per_mutant_timeout_ms: 120000`; `total_timeout_ms` default.

**Rules:**
- Each id is one contiguous find/replace whose `find` occurs exactly once in `scripts/probe-grbl.py` (`MUTANT_ANCHOR_AMBIGUOUS`, `mutation-battery.mjs:1773-1780`). No mutant is stacked. Ted records each exact `find` in the spec. **Known repeats that need a whole-statement anchor:** `RESULT INCOMPLETE` occurs at least three times (`main`'s initial result, `cleanup`'s return, the per-rep gate), so E2-M9's `find` is `cleanup`'s whole `return` statement. `return 2` occurs once per argument refusal, so E2-M3b, E2-M20 and E2-M24 each anchor on their refusal's message line plus the `return 2` after it. E2-M3a and E2-M3c may share an anchor text: they are separate mutants, never stacked.
- A control (C) is a test that is green at baseline, whose named wrong variant turns it red. It appears in the journal as `killed` like any other id.
- Every M and C id must be `killed`. `survived`, `errored` and `CONTROL_RED` must all be 0.

**How each test goes red:** all of them run `probe.main([...])` against `FakeSerial`, or call the pure builder or preflight, and assert on the recorded write sequence, the exit code, or the log's last line. No mutant is caught only by an argparse error or an import failure. The probe's own argument refusals (E2-M3b, E2-M20, E2-M24, E2-M27) are asserted three ways: exit 2, `open_serial` never called, and the message naming the flag. The wrong variants below all keep the module importable.

**Not battery-covered, by design:** the reader join in `Wire.close()` (MF2 of the fold). A test that could see a late reader line overtake the RESULT line would depend on thread timing, and a flaky baseline is worse than none. The join is a design requirement, and Razor verifies it by reading `close()` and `finish()`.

| Id | Test | Wrong variant (one edit) |
|---|---|---|
| E2-M1 | Wedge mode during `--case wedge`: in the write sequence, no line (`M5`, `$X`, `$H`, `G…`, `G4 P0`) appears between the unacked line and the first `0x18` after it | In `cleanup`, replace the `send_byte(0x18, …)` statement with `wire.send_line("M5")` followed by it |
| E2-M2 | A fault in rep 1 of `wedge`: no line of any later variant or rep is written after the cleanup's `0x18`; exit code non-zero | Replace the runner's fault `return`/`break` with `continue` |
| E2-M3a | Across every case's `build_case_plan` output, and the whole write sequence of a live `hold-m4` run, neither byte `0x9E` nor byte `0x7E` (`~`) ever appears | Append a `0x9E` byte step after the `!` step in the `hold-m4` builder |
| E2-M3c | The same test as E2-M3a | Append a `0x7E` (`~`) byte step after the `!` step in the `hold-m4` builder |
| E2-M3b | `main(["--pause", …])` returns non-zero before `open_serial` is called, and the message names `--case hold-m4` | Replace the `--pause` refusal's `return 2` with `pass` |
| E2-M4 | `$$` without `$30`: `RESULT REFUSED` names `$30`; no `G0`/`G1`/`M3`/`M4` line is written | `s30 = settings.get(30)` → `s30 = settings.get(30, 1000.0)` |
| E2-M5 | `$$` with `$23=1` and `--x-dir -1`: every X target in the written stream is ≤ 0 | At the live `build_case_plan` call site, replace the `args.x_dir` argument with `(1 if int(settings.get(23, 0)) & 1 else -1)` |
| E2-M6 | `--dry-run` for every case: `open_serial` is never called and exit is 0. Independently of the builder, for the four boxed cases every X/Y in the printed matrix lies inside `origin .. origin+box` with the given sign, and in every case every `S` value is ≤ `--smax`. (The earlier clause "stdout equals `format_plan(build_case_plan(...))`" compared the builder with itself and is dropped. In its place, a separate assertion in the E2-M5 test checks that the printed matrix's lines equal, in order, the lines a live run with the same arguments writes to the fake.) | Replace the `if args.dry_run:` guard around the early return with `if False:` (the test passes `--port` and `--log-file` so the live path would reach `open_serial`) |
| E2-M7 | `--origin-x 380 --box-mm 60` with `$130=400`: refused before motion. The same on Y with `$131` | Replace `box_fits`'s return expression with `True` |
| E2-M8 | `--case hold-m4` with `$32=0`, and separately with no `$32` line: `RESULT REFUSED` names `$32` and laser mode; no `M4` and no motion line is written | Replace the `$32` refusal condition with `False` |
| E2-M9 | A faulted run's log ends with a line starting `RESULT INCOMPLETE` and naming the reason | In `cleanup`'s `return` statement, change `"RESULT INCOMPLETE` to `"RESULT COMPLETE` (the `find` is that whole statement) |
| E2-M10 | `--case direction`: after the home step, the plan and the live write sequence start `G21`, `G91`, `M5`; every move is a `G1` of 1 mm with `F300`; there is no `G0`, no `M3`/`M4` and no `S` word; the last line is `G90` | Insert `f"M4 S{smax}"` after `"M5"` in the direction builder |
| E2-M11 | `--case settings` with `$G` → `error:3`: the log and the summary record `$G` as unsupported | Replace the settings case's `error:` branch condition with `False` |
| E2-M12 | Wedge-mode fault: no `$X` line is written anywhere after the fault | In `cleanup`, add `wire.send_line("$X")` after the `0x18` |
| E2-M13 | `KeyboardInterrupt` raised from the fake mid-case: the next write is `0x18` and the last log line starts `RESULT INCOMPLETE` | Replace the `except KeyboardInterrupt:` handler's `result = cleanup(...)` statement with `pass` |
| E2-M14 | `$#` reporting `G54:10.000,0.000,0.000` for a boxed case: refused before motion | Replace the `G54` refusal condition with `False` |
| E2-M15 | `--smax 20` with `$30=10`: refused before motion | Replace the `smax > s30` refusal condition with `False` |
| E2-M16 | A full `--case wedge --home` run with `$22=1`: exactly one `$H` is written, it is the home step's (after `M5`, before any `G0`/`G1`), and no `$X` line is written anywhere | Insert `if settings.get(22) == 1: probe.command("$H")` before the first case step |
| E2-M17 | `--dry-run --smax 0`: the header contains "cannot establish positive-power behaviour" | Replace that header line's condition with `False` |
| E2-M18 | `--case hold-m4 --x-dir 1` with the post-home report `MPos:-50.000,0.000,0.000`: `RESULT REFUSED` names the position; no case line after `$H` | Replace `position_in_bed`'s return expression with `True` |
| E2-M19 | The fake answers `?` at once and sends no banner: no `0x18` is written before `$I`, and none in the whole preflight | Replace the "no report arrived" condition guarding the startup reset with `True` |
| E2-M20 | `main(["--case", "wedge", …])` without `--home` returns 2 and `open_serial` is never called; the message names `--home` | Replace the missing-`--home` refusal's `return 2` with `pass` |
| E2-M21 | `--case wedge --home` with `$22=0`: `RESULT REFUSED` names `$22`; no `$H` and no motion line is written | Replace the `$22` refusal condition with `False` |
| E2-M22 | A clean `hold-m4` run: exactly one `0x18` is written (the designed one), no line follows it, and the last log line is `RESULT COMPLETE`, even when the capture reports Alarm | In the runner's designed-reset branch, replace the capture call with `raise Wedge("designed reset")` |
| E2-M23 | For each boxed case, the first three lines after the home step are `G21`, `G90`, `M5` | Delete `"G90", ` from `BOXED_PREAMBLE` |
| E2-M24 | `main(["--case", "stop-m4", "--reps", "3", …])` returns 2 before `open_serial`; the message names `--reps` | Replace the `--reps` refusal's `return 2` with `pass` |
| E2-M25 | The fake reports `Alarm` after `$H`'s `ok`: `RESULT REFUSED` names the state; no case line is written | Replace the post-home Idle refusal condition with `False` |
| E2-M26 | `--case wedge --reps 2` with no fault, and the fake answering `Hold` to the per-rep `?` before rep 2: the last line starts `RESULT INCOMPLETE` and names rep 2; no rep-2 line is written | Replace the per-rep gate's condition with `False` |
| E2-M27 | `main(["--case", "stop-m4", "--feed", "12000", …])` returns 2 before `open_serial`; the message names the feed | Replace `segment_outlasts`'s return expression with `True` |
| E2-M28 | `$#` reporting `G92:0.000,10.000,0.000` for a boxed case: refused before motion | Replace the `G92` refusal condition with `False` |
| E2-M29 | A wedge whose cleanup `0x18` write raises `OSError`: `main` returns 1 (it does not raise), and the last log line starts `RESULT INCOMPLETE` and names the wedge. Also, separately: `open_serial` raising gives exit 1 and a last line naming the open error | In `cleanup`, replace `except Exception as e:` with `except KeyboardInterrupt as e:` |
| E2-C1 | (control) `$32=1`, `$30=1000`, `$130=400`, `$131=415`, `G54` zero, Idle: `hold-m4` reaches its first `G0` | Invert the `$32` check (`!= 1` → `== 1`) |
| E2-C2 | (control) `--case direction` with a `$$` showing `$32=0` is **not** refused, and it runs its steps | Add `"direction"` to `POWERED_CASES` |
| E2-C3 | (control) The `wedge` plan lists the eight existing names in their existing order | Delete the `ring_M4_settle30ms` variant from the builder |
| E2-C4 | (control) The fake answers `<Alarm|…>` at startup and `--case wedge --home` is given: the probe writes `$H` (and no `M5` or `$X` before it), then proceeds to `G21` | Replace `STARTUP_STATES = ("Idle", "Alarm")` with `STARTUP_STATES = ("Idle",)` |

## Verification

- `python3 -m unittest discover -s scripts -p 'test_probe_grbl.py'`: green, with the count of tests run reported.
- `python3 scripts/probe-grbl.py --help`: works. Also run once with pyserial hidden (`python3 -c` inserting `sys.modules['serial'] = None` before `runpy`), to prove lazy import.
- `python3 scripts/probe-grbl.py --case wedge --dry-run --home --origin-x 20 --origin-y 20 --x-dir 1 --y-dir -1 --box-mm 60 --smax 0 --feed 1000`: prints the header and matrix, with the home step first, and opens no port. Also run for each other case; the `hold-m4` and `stop-m4` dry runs use `--feed 300`, and the same commands at `--feed 12000` must exit 2. The signs `--x-dir 1 --y-dir -1` were checked against the capture, where `G0 X10.000 Y-10.000` after `$H` settled at `MPos:10.000,-10.000` (`scripts/probe-20260914-153729.log:66-70`). That is the stated basis for Razor's signature, and it is that day's frame, which `--case direction` re-checks on the day. **Razor signs the printed matrices** in the review; that signature is what Lee runs against.
- **Razor reads `Wire.close()` and `finish()`** and confirms the reader is joined before the RESULT line is written, and that the RESULT line is the only thing written after the join (no battery id; see Tests).
- Battery journal: every E2-M* and E2-C* id `killed` (E2-M1 to E2-M29 with E2-M3a, E2-M3b and E2-M3c, and E2-C1 to E2-C4); `survived`, `errored` and `CONTROL_RED` all 0.
- **Vendor-identity grep (Razor), on added lines only:** `git diff -U0 master...relay/kerf-evidence-e2 -- scripts docs | grep '^+' | grep -niE 'falcon|creality|\[VER:|\[OPT:|CV master'`. Must be empty. Pre-existing `:53` is `kerf-d12`'s and is excluded by construction, because it is not an added line; the rewrite must not touch it.
- **No agent runs the probe without `--dry-run`, and no agent opens a real serial port.**
- No browser step: the script is not part of the app.

**Hardware-only (named, not closable here; the owner's session A):**
- The physical direction each `--case direction` step moves.
- That the owner's live `$$` still carries `$30`, `$32=1`, `$130`, `$131`, and whether `$G` and `$#` are supported (the capture carries the four settings; `$G`/`$#` were never sent).
- Whether `0x18` during motion leaves this controller in Alarm. (The one-rep-per-invocation rule no longer depends on it; the answer is recorded, not needed.)
- That the dry-run matrix matches where the head actually goes.
- **The state after the probe opens the port**, and after a soft reset: whether `?` answers after the DTR toggle without a reset, and whether the controller reports Idle or Alarm. `--case settings` records it, and it runs in either state. The capture never sent `?` between a reset and `$X`, so this is unknown today.
- Whether this fork accepts `$H` from Alarm (stock GRBL does), and whether home lands within `POSITION_TOL_MM` of `MPos` 0,0 as on the capture.
- That status reports carry `MPos` (the capture's `$10=3` does; `position_in_bed` refuses without it).

## Departures from the parent (each checked against the tree or a named source)

1. **`--stop-on-fault` is always on.** The parent's E2-M2 wording ("continue after fault with `--stop-on-fault`") implies the run continues without the flag. Astra 3.1 acceptance 2 says no next variant follows a fault at all. The flag is kept as a no-op.
2. **INCOMPLETE is read from the last line, not rewritten into the header.** A crashed process cannot rewrite its own header, so the header states the rule instead and a missing `RESULT COMPLETE` is incomplete.
3. **Startup `$X` is removed, and the automatic startup `$H` is replaced by an explicit `--home`** that every motion case requires. Astra 3.1 "Files explicitly OUT of scope" forbids auto-home and auto-unlock after a fault, and 3.2 step 12 says "never automatically unlock/home or restart after a fault". It does not forbid an operator-requested home before a case: 3.2 step 4 makes "recovery/restart ... an explicit operator action after checking settings and position again", and step 2 puts the frame on the operator. `--home` is typed by the operator, printed in the dry-run matrix, refused unless `$22=1`, and never runs after a fault within a run. It is required rather than optional so the bounds check always rests on a home made by this invocation, not on one made earlier by another program across a DTR toggle. (Critic fold, must-fix 1.)
4. **`--smax` defaults to 0, and `--log-file` and `--port` are required for live runs.** These are fail-closed defaults. The log rule keeps new logs out of the public tree without waiting on `kerf-d12`.
5. **A `G54` and `G92` refusal and a `$#` read are added.** The bounds check is meaningless under a non-zero work offset, and soft limits are off on the owner's controller (`$20=0`, capture `:25`). Hard limits are on (`$21=1`, `:26`), and that is the backstop, not the check.
6. **`hold-m4` and `stop-m4` refuse `--reps` > 1.** Astra 3.2 step 8 runs `stop-m4 ... --reps 3`, and step 9 asks for three `hold-m4` repetitions. Here those are three invocations, each homed. A second repetition inside one invocation would start from the position a reset during motion left, which GRBL itself does not vouch for, and DECISIONS 2026-09-20 records ~10 mm displacement from hold-then-reset.
7. **The astra 3.2 command lines gain `--home`, and the `stop-m4`/`hold-m4` lines lose `--reps 3`.** The card carries the corrected lines. `--feed 300` stays as astra wrote it.
8. **The startup reset is conditional.** The old probe reset whenever no banner arrived. This one asks with `?` first and resets only a controller that answers nothing, so the probe cannot create the Alarm it would then have to handle.

## What E2 does not satisfy

- **Any claim about the beam.** The status-only ruling means no log or card field says the beam went dark.
- **Capturing the wedge.** That is Lee's session (astra 3.2). This batch only makes it runnable.
- **Astra 3.2 steps 5-6** (app fault scripts, `$32` settings transactions through the app). Those are app-side and not in the probe.
- **One diagnostic datum is lost on purpose.** The old wedge path's "does a plain command also go unanswered" (`G4 P0`, `:361`) was a line written before the reset; the 2026-09-20 ruling forbids that order. The consecutive Idle replies that define the wedge are still logged.
- **The M3 sequences.** `ring_M3` and `two_rings_M3` fire a stationary beam at `S{smax}` for one ack round trip between `M3` and the first `G1` (`:313-319`). They are kept because astra 3.1 says keep all eight; the card orders them at S0 first. Named, not changed.
- **The committed probe log and the `:53` comment** belong to `kerf-d12`.
- **Astra 3.2's "then admitted job feed" for `stop-m4` and `hold-m4`** (steps 8-9). Inside a 60 mm box the 20 mm segment lasts 1 s or less at any feed above 1200 mm/min, and the probe refuses above 600 mm/min so that a hold or stop always lands during motion. Stop and hold at job feed need a longer segment and therefore a larger checked region, which is a new plan. Parked (Stage 3.5).

## Stage 3.5 obligations (orchestrator)

- **ROADMAP:** a `shipped` entry for E2 stating the new CLI contract and refusals. **Do not edit** the verbatim deferred section whose "Tooling" paragraph (`ROADMAP.md:607-612`) describes the old probe ("recovers with `0x18` between variants"). Instead, append one Parking Lot index line: `- **Probe contract changed (E2)** — the Tooling paragraph under the 2026-09-05 deferred section describes the pre-E2 probe; the current contract is in docs/qualification-card.md.`
- **Parking Lot line:** `- **Wedge diagnostic "plain command while wedged" retired (E2)** — the probe no longer writes a line before its reset; if session A needs that datum, it needs a new plan that writes the probe line with output isolated only.`
- **Parking Lot line:** `- **Stop and hold at job feed (E2)** — the probe's hold-m4/stop-m4 refuse feeds above 600 mm/min so the event lands inside a 20 mm segment; astra 3.2 steps 8-9 "then admitted job feed" needs a longer segment and a larger checked region, in a new plan.`
- **ARCHITECTURE.md:** no delta. It does not describe `scripts/` or `docs/` (verified by grep: no `scripts/` or `docs/` entry).

## Risks and rollback

- **A wrong matrix sends the head somewhere unexpected.** Mitigations: Razor signs every dry-run matrix; the card requires `direction` first; every boxed case refuses without `$130`/`$131`, on a non-zero `G54` or `G92`, or with a box that does not fit; the default power is S0.
- **The bounds check runs in an unhomed frame.** This was the critic's main finding: the first draft removed the startup home and put nothing in its place. Now every motion invocation homes first (`--home`, required), and after homing a boxed case refuses if the reported position lies outside the bed on the operator's signs. The worst case if both are somehow wrong is a move into a rail at low power with `M4` modal. On the capture's settings that ends in a hard-limit alarm (`$21=1`, `:26`). In stock GRBL a limit alarm also stops the spindle; on this fork that is stock intent, not proof (DECISIONS 2026-09-05).
- **The probe cannot start on a controller in Alarm.** The first draft refused Alarm and reset on every start, and on this board that reset was the normal path. Now the probe resets only a silent controller, accepts Alarm at startup for motion cases because `--home` leaves it, and `settings` runs in Alarm. If this fork refuses `$H` from Alarm, the run ends INCOMPLETE at the home step. That is on the hardware-only list, and the card says to stop and keep the log.
- **Good captures read as INCOMPLETE.** Two causes are closed. A late reader line cannot overtake the RESULT line, because the reader is joined first. A designed reset ends COMPLETE, and `hold-m4`/`stop-m4` never attempt a second repetition.
- **A hold or stop lands after motion ended and "passes".** The feed refusal closes this for the probe's own segment. The card's "record the status state" is the second defence.
- **The preflight could be too strict for the owner's firmware.** If `$G` is unsupported, that is recorded and not a refusal. An unsupported `$#` is recorded and falls back to the status `WCO:` field; a boxed case refuses only when neither can be read. Only a missing `$22`/`$30`/`$32`/`$130`/`$131`, a non-zero `G54` or `G92`, a failed home or an out-of-bed position refuses, and the capture shows those settings present, `WCO:0.000,0.000,0.000` and home at 0,0 (`$#` itself was never sent). If a live run refuses anyway, that is the evidence, and nothing is weakened.
- **Rollback:** revert the relay merge commit. Nothing else depends on E2 except E4's pointer.
- **Irreversible steps:** none. No agent runs the probe against a port. No setting is written by the probe in any case (there is no `$N=` step anywhere).

## Critic fold (2026-09-25)

Critic: `kerf-evidence-e2-critic.md` (Fable), verdict CONCERN, with X1, X3 and X5 CONCERN (all gating) and core 3, 6 and 9 CONCERN. The design, the departures and every script citation were judged correct. Every must-fix below was checked against the tree at `10be8a2` before folding.

1. **Startup and frame.** Verified: the capture's startup reset at `:2` was the normal path (no banner after the DTR toggle); no `?` was ever sent between a reset and `$X` (`:6`, `:899-900`, `:963-964`); `$21=1` at `:26`; `$22=1`. Folded into Preflight steps 2, 4, 5 and 7, the CLI table, Departures 3 and 8, the card's new Homing section, Risks and the hardware-only list. **Pick: an explicit `--home`, required for every motion case**, not the card prerequisite "home through Kerf, then run the probe". Reasons: the probe's own port open toggles DTR (`:54-57`), and `charter-gap-analysis.md` S1 says a Kerf reconnect DTR-resets this controller, so a home made by another program is not guaranteed to survive into the probe. A required flag means the operator decides nothing new: the card writes it, and every invocation, including each `hold-m4`/`stop-m4` repetition, starts from its own fresh home. `$H` is refused unless `$22=1`. `M5` is sent before it only when the controller reports Idle, because GRBL refuses G-code lines in Alarm. The critic's `?`-before-reset is folded as written. Its position refusal is folded as `position_in_bed` with a 5 mm tolerance. `$21=1` is cited as the backstop. Adds E2-M18 to E2-M21, E2-M25 and E2-C4. Because homing is GRBL's own way out of the homing lock, a startup Alarm is now accepted for motion cases, not refused. `settings` runs in Alarm too, so the owner can record the "state after soft reset" item now on the hardware-only list.
2. **RESULT line.** Verified: `Wire.close()` sleeps 0.1 s and never joins (`:114-120`). `close()` now joins the reader, and `finish()` writes the RESULT line last, from the main thread. The designed reset in `hold-m4`/`stop-m4` is a step and ends `RESULT COMPLETE`; only faults go through `cleanup` (E2-M22). The join itself has no battery id, as the critic said it must be carried by the design. Razor verifies it by reading (Verification).
3. **M4 timing and segment geometry.** Verified: `:395-396` (the F300 crawl) and astra 3.2 steps 8-9 (`--feed 300`, "then admitted job feed"). The M4 segment is now unscaled (`Q(dx, dy)`, 20 mm at any box), which makes "20 mm" and the box floor of 30 consistent. The pure `segment_outlasts` refuses `hold-m4`/`stop-m4` above 600 mm/min (E2-M27). The card's M4 lines carry `--feed 300`. The admitted job feed is named under "What E2 does not satisfy" and parked.
4. **Preambles.** Verified: `:487-489`, where the old `G90` lived outside the variants. The boxed cases share `BOXED_PREAMBLE = ["G21", "G90", "M5"]` (E2-M23). `direction` now uses four 1 mm `G1` steps at F300, which matches astra 3.2 step 2 exactly, so there is no departure to name (E2-M10 updated).
5. **Reps.** `--reps` > 1 with `hold-m4`/`stop-m4` exits 2, and their default is 1 (E2-M24). This departs from astra 3.2 step 8 and is named as Departure 6. Departure 7 covers the corrected command lines.
6. **Missing ids.** `~` joins E2-M3a's forbidden set, with its own variant (E2-M3c). The not-Idle refusal is E2-M25 (the old startup Alarm refusal no longer exists; C4 guards its replacement), and the per-rep gate is E2-M26. E2-M9's anchor is `cleanup`'s whole `return` statement, and the Rules line lists every known repeat. The critic's advisory on E2-M6 is also folded: the self-comparison clause is dropped, and the live-versus-dry-run line equality moves into the E2-M5 test.
7. **Cleanup without a wire or with a dead port.** `cleanup` guards steps 1-2 with `except Exception` and skips them when there is no wire. `main` starts from an INCOMPLETE result, so no path can end COMPLETE by accident (E2-M29).
8. **Offsets, exit codes, docstring.** Folded: a `G92` refusal (E2-M28), exit codes 0/1/2/3 in the script and on the card, and a rewrite of the module docstring `:3-25`.
9. **Citations.** Folded: `.gitignore:39-40`; the battery copies untracked files (`:1131-1145`), and "stray" means a porcelain-status change under the test command (`:1845`, `:1877-1879`, `:1921`); the plans inventory is now 34, with the extra grep hits named; and the `--x-dir 1 --y-dir -1` basis is the capture's `MPos:10.000,-10.000` (`:66-70`).

Rejected: none of the nine. Two places deliberately differ from the critic's wording. First, `M5` before `$H` is sent only in Idle, not always (reason under 1). Second, the reader join gets no battery id, because a timing-dependent test would make the baseline flaky (under 2, in line with the critic's own "in the design, not the test").

Open for Lee: none. Stop and hold at job feed is parked for a later plan. It is not decided here.

**Orchestrator addendum (2026-09-25):** the fold agent flagged that an unsupported `$#` would let a boxed case run with its offset check silently skipped. Folded fail-closed: fall back to the status `WCO:` field, refuse when neither reads (E2-M36, above). The capture carries `WCO:` in status, so this does not bite on the owner's controller.
