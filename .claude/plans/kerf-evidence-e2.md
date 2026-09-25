# Kerf evidence E2: the probe can no longer re-arm the beam or run powered without a laser-mode readback, and a qualification card says how to use it

**Lifted from:** `/home/leesalo/marvin/state/audits/gap-2026-09-24/kerf/PLAN-silent-drop-and-evidence.md` §E2 (critic `PLAN-silent-drop-and-evidence-critic.md`, CONCERN, folded).

**Lineage:** `.claude/plans/kerf-relay-plan.md` §C1 (critic `kerf-relay-plan-critic.md`, must-fix 6 restored), astra `~/marvin/state/audits/kerf-astra-2026-09-08/PLAN.md` §3.1 (acceptance 1-4) and the §3.2 card steps it feeds. Where this file and a relay-plan body differ, this file wins. On anything this file does not cover, the parent wins. Where this file departs from the parent, the departure is named under "Departures from the parent".

**Citations:** re-read at `a6ddc3a` on session branch `marvin/kerf-gap` (source = master `caa0dcc`; `git diff --stat caa0dcc HEAD -- scripts docs` is empty) on 2026-09-25.

- **Relay id:** `kerf-evidence-e2`
- **Branch:** `relay/kerf-evidence-e2`
- **Tier:** Standard. 3 files, two roots (`scripts/`, `docs/`). **Waiver (two roots):** the card documents the script's CLI and refusal rules and is reviewed against it as one unit; splitting them would let the card describe a CLI that does not exist.
- **Size, stated honestly:** `probe-grbl.py` is rewritten, not patched. Today 547 lines; expect roughly 650-800 after the rewrite (case builders, preflight, cleanup, testability seams). `test_probe_grbl.py` is new, roughly 450-600 lines (a scripted fake serial peer plus 20 battery ids). The card is roughly 100-150 lines of Markdown.

## Intent (grilled)

Grill skipped. The intent is the parent's Intent, which cites CHARTER "Done looks like" (3) and these DECISIONS entries: 2026-09-10 "The laser-switch wedge requires a captured trigger and a prevention before release"; 2026-09-10 "Hardware evidence for this program is status-only"; 2026-09-20 "Abort sends 0x18 immediately — no feed hold, no M5, no ack wait"; 2026-09-05 "`0x9E` is a TOGGLE ... Kerf's pause volley re-arms the beam"; 2026-09-05 "The owner's controller is a vendor GRBL fork"; the "Public repo" header rule.

Summary for this batch:
- Release is blocked until the wedge's trigger is captured on the owner's machine, and the probe is the only tool for capturing it.
- Today the probe still sends the byte proven to re-arm the beam, guesses bed direction from a homing setting, homes and unlocks the machine by itself, sends `M5` and `$X` lines before its reset after a fault, and never checks that laser mode is on before firing.
- After this batch: every powered case refuses before motion unless the controller reported `$32=1`, `$30`, `$130` and `$131`; coordinates and directions come from the operator; a fault or Ctrl-C sends the realtime reset first and nothing else; and a log that does not end in `RESULT COMPLETE` is incomplete by construction.
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

None of them edits `scripts/` or `docs/`. `grep -l 'probe-grbl\|qualification-card\|test_probe_grbl'` over every plan above hits only the parent, the relay plan and the two critics, all of which this file lifts from. The parent's E4 (`docs/test-card.md`) points at the card this batch creates and dispatches only after this batch merges. The Stage 0 re-check repeats this inventory.

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
- There is no `scripts/test_probe_grbl.py` and no `docs/qualification-card.md`.

**What the committed capture shows (read only for its settings, no identity copied):** the `$$` block carries `$22=1`, `$23=1`, `$30=1000.000`, `$32=1`, `$130=400.000`, `$131=415.000` (`scripts/probe-20260914-153729.log:27-43`). Status reports carry `WCO:0.000,0.000,0.000`. So the preflight below can pass on this controller.

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
| `--box-mm` | Default 60. Must be > 0. For the three M4 cases it must be ≥ 30 (the 20 mm segment below). |
| `--smax` | Integer ≥ 0. **Default 0**, so positive power is only ever an explicit operator choice. |
| `--feed`, `--reps`, `--baud` | Kept, same defaults (12000, 5, 115200). |
| `--stop-on-fault` | Accepted, and the only behaviour: a fault always ends the run (astra 3.1 acceptance 2). The flag stays so the astra 3.2 command lines keep working. |
| `--pause` | Exits 2 before anything else: "--pause is retired: it sent 0x9E, which re-arms the beam. Use --case hold-m4." |
| `--no-home` | Removed. The probe never homes. |

**Coordinates.** `P(u, v)` returns `X{x_dir*(origin_x + u*box/60)} Y{y_dir*(origin_y + v*box/60)}`, with `u` and `v` in the existing 0-60 frame. At the default `--box-mm 60` this reproduces today's variant geometry exactly. Absolute moves use `G90`, and every case emits `G21` first.

**Cases.** Each case is a pure builder, `build_case_plan(case, args, x_dir, y_dir) -> list[Step]`. A `Step` is a line, a realtime byte, a wait-for-Idle, or an observe window. Both the dry-run path and the live path call it with `args.x_dir, args.y_dir` passed explicitly, so the live call site is the one place a direction is chosen (and the one place E2-M5 mutates). Dry-run prints exactly this list, and the live runner executes exactly this list.
- **`settings`:** `?`, `$I`, `$$`, `$G`, `$#`, each recorded raw. No motion, no M-code. An `error:` reply to `$G` or `$#` is recorded as "unsupported" in the log and the summary, never as success.
- **`direction`:** `G21`, `G91`, `M5`, then `G0` 5 mm steps +X, −X, +Y, −Y (signed by `--x-dir`/`--y-dir`), then `G90`. No `M3`, no `M4`, no `S` word anywhere. This is the beam-off direction check the card requires before any powered case. It is not a powered case, so it does not need `$32=1`.
- **`wedge`:** the eight existing sequences (`:299-327`), with their names and order unchanged, × `--reps`.
- **`hold-m4`:** `G21`, `G90`, `M5`, a `G0` lead to box point (5, 5), `M4 S{smax}`, `G1` to (25, 5) with explicit `F{feed} S{smax}`. After `HOLD_DELAY_S` it sends realtime `!` and observes with `?` every 250 ms for `HOLD_OBSERVE_S` (5 s). Then it sends realtime `0x18`. **It never sends `~` and never sends `0x9E`.** The status-only ruling makes a dark hold unqualifiable, so a resume is never offered.
- **`stop-m4`:** the same segment. After `STOP_DELAY_S` it sends realtime `0x18` during motion and captures the reply for `CLEANUP_CAPTURE_S`. No recovery follows.
- **`completion-m4`:** the same segment, then `M5`. It polls `?` until Idle (bounded at 30 s), recording every report.

**Observe markers.** At the moment of a hold, a stop, the last ack and completion, the probe logs and prints `## OBSERVE <what>: note whether motion ceased`. The operator's paper note then ties to a log timestamp. The marker never says anything about the beam.

**Preflight (live only, before any motion line).** In order:
1. Open the port and wait for the banner; send `0x18` if none arrives (as today at `:457-460`).
2. Send `?`. If the state is `Alarm`, refuse: "controller in Alarm; clear it yourself (the probe never unlocks) and re-run".
3. Record `$I`, `$$`, `$G`, `$#` raw.
4. Refuse, listing every reason, if any of these fails:
   - `$30` absent. There is no default ceiling.
   - `--smax` > `$30`.
   - For `wedge`, `hold-m4`, `stop-m4` and `completion-m4` (`POWERED_CASES`): `$32` absent or not `1`. The message says that without laser mode GRBL keeps the beam energised through rapids, so the traverse would run with the beam on. **No override flag** (parent Critic fold, rejected item 1).
   - For the boxed cases: `$130` or `$131` absent.
   - For the boxed cases: the box does not fit, i.e. `box_fits(origin, box, bed)` fails on either axis. That check is `0 <= origin` and `origin + box <= bed`.
   - For the boxed cases: `$#` reports a non-zero `G54` X or Y. The bounds check assumes the work frame's zero is at home.
   - The state is not `Idle`.
5. A refusal writes `RESULT REFUSED: <reasons>` as the last log line and exits 3. Nothing after step 3 is sent.
6. **Before every repetition** the runner sends `?` and requires `Idle`. After a `stop-m4` or `hold-m4` reset the controller may be in Alarm. The run then ends `RESULT INCOMPLETE: controller not Idle before rep N (the probe never unlocks)`. So those two cases are effectively one repetition per invocation, and the card says so.

**Cleanup (one function, every exit path).** `cleanup(wire, reason)`:
1. `wire.send_byte(0x18, "RESET")` is the **first write**. No line and no `?` goes before it.
2. It drains for `CLEANUP_CAPTURE_S`, then sends one `?` and records the reply.
3. It writes `RESULT INCOMPLETE: <reason>` and returns a non-zero exit code.
4. **No `M5`, no `$X`, no `$H`, no replay, no next variant.**

Callers:
- the `error:` reply, wedge, alarm and unexpected-banner paths inside a case;
- `KeyboardInterrupt`;
- any other exception.

`reset_and_unlock` and the wedge path's `?` + `G4 P0` diagnostic (`:357-374`) are deleted. The three or more consecutive Idle replies that raise the wedge are already in the log before cleanup runs.

**Log format.** The existing `Wire.log` format is kept (monotonic ms, direction, text; `:66-72`). The header lines are:
- `probe-grbl case=… reps=… smax=… feed=… origin=… dirs=… box=…`
- `A run is complete only if its last line is "RESULT COMPLETE". Any other ending, including no RESULT line, is INCOMPLETE.` A crashed process cannot rewrite its own header, so the rule reads the absence of the terminal line as incomplete. See Departures.
- When `--smax 0` or `--dry-run`: `This run cannot establish positive-power behaviour (S0 or dry run).`

**Testability seams (required, so the tests reach production code):**
- `main(argv: list[str] | None = None) -> int`, with `sys.exit(main())` under `__main__`.
- `open_serial(port, baud)` does the `import serial` lazily and returns `serial.Serial(port, baud, timeout=0.05)`. `Wire.__init__` calls it at the line that is `:47` today. `--help` and `--dry-run` therefore work without pyserial.
- Module-level timing constants that tests patch: `DTR_SETTLE_S` (used by the `time.sleep(1.5)` at `:57`; lines `:48-53` are untouched), `BANNER_WAIT_S`, `PROBE_EVERY_S`, `IDLE_TICKS`, `HARD_TIMEOUT_S`, `CLEANUP_CAPTURE_S`, `HOLD_DELAY_S`, `HOLD_OBSERVE_S`, `STOP_DELAY_S`.
- `POWERED_CASES` is a module-level set. `preflight(case, args, settings, status, offsets) -> list[str]` is pure.

**Must not change:** the eight sequence names, their line order and their settle/@IDLE behaviour, and lines `:48-53`. The rewrite also adds no controller vendor or model name, no firmware string, and no `[VER:` or `[OPT:` text (DECISIONS "Public repo").

### 2. `scripts/test_probe_grbl.py` (new, `unittest`)

- Load the script with `importlib.util.spec_from_file_location("probe_grbl", <path>)`, because the hyphen blocks `import`.
- Put a stub `serial` module in `sys.modules`, or patch `open_serial`, so the tests never need pyserial and never touch a device. **No test opens a real port.**
- The `FakeSerial` peer records every write in order and answers from a scripted table:
  - `?` → `<Idle|MPos:…|FS:0,0>`, or `<Run|…>` while a scripted motion runs.
  - `$$` → a settings list the test chooses.
  - `$I` → a **synthetic** reply such as `[SIM:synthetic build info]` then `ok`. Never a `[VER:`/`[OPT:` line and never a real identity.
  - `$G` → `error:3` or a `[GC:…]` line, as the test chooses.
  - `$#` → `[G54:…]` then `ok`.
  - motion lines → `ok`.
  - `0x18` → the stock banner `Grbl 1.1f ['$' for help]`.
  - a wedge mode: after the next `M3`/`M4`, no `ok` until `0x18`, and `?` answers Idle.
- Every test patches the timing constants to small values and writes its `--log-file` under `tempfile.TemporaryDirectory()`. Nothing is written in `scripts/`: the battery reports untracked files as stray.

### 3. `docs/qualification-card.md` (new; public, procedure only)

Sections, in order:
1. **Prerequisites.**
   - Kerf closed, so the port is free.
   - Output isolated by the owner's established procedure for the S0 runs.
   - The independent physical stop within reach.
   - `--case settings` run and `$30`, `$32`, `$130`, `$131` and the `G54` offset noted.
   - `--case direction` run, and the observed direction of each 5 mm step recorded, with how the direction case keeps the beam off stated in one sentence: `M5` first, and no `M3`, `M4` or `S` word.
   - A low-power ceiling chosen at or below `$30`.
2. **Print and review the dry run.** The exact `--dry-run` command for the planned case, and a check that every coordinate lies inside the box.
3. **Cases in order:** `settings` → `direction` → `wedge` at `--smax 0` (output isolated) → `stop-m4` → `hold-m4` → `completion-m4`, the last three one repetition per invocation. Each positive-power step is an explicit operator choice.
4. **What to record per case:**
   - the log's monotonic timestamps at each `## OBSERVE` marker;
   - the TX/RX lines around it;
   - the status state;
   - "motion ceased: y/n", written by hand.
   There is no field for beam state.
5. **The INCOMPLETE rule:** only a log ending `RESULT COMPLETE` counts. A `RESULT REFUSED` or `RESULT INCOMPLETE` log is kept as evidence of what happened, never as a pass.
6. **Where logs go:** pass `--log-file` pointing into the private evidence register, whose location is held outside this repository. **No path, no firmware string and no incident narrative is written in the card.**

## Tests and mutants

**Battery spec `kerf-evidence-e2`:**
- `test_command`: `["python3","-m","unittest","discover","-s","scripts","-p","test_probe_grbl.py"]`.
- **The battery can run it.** `normaliseSpec` accepts any non-empty argv (`~/marvin/scripts/mutation-battery.mjs:1540-1553`), and `runTest` spawns it in the copy with the inherited environment minus `GIT_*` (`:1328-1340`, `scrubbedEnv` `:790-796`).
- On this host Python is 3.12.3, where a discover that finds no tests **exits 5** (measured). A mis-pointed pattern therefore makes the baseline red and the battery refuses, rather than scoring a vacuous green.
- `__pycache__/` is gitignored (`.gitignore:37-39`), so compiled bytecode is not a stray path.
- `per_mutant_timeout_ms: 120000`; `total_timeout_ms` default.

**Rules:**
- Each id is one contiguous find/replace whose `find` occurs exactly once in `scripts/probe-grbl.py` (`MUTANT_ANCHOR_AMBIGUOUS`, `mutation-battery.mjs:1773-1780`). No mutant is stacked. Ted records each exact `find` in the spec.
- A control (C) is a test that is green at baseline, whose named wrong variant turns it red. It appears in the journal as `killed` like any other id.
- Every M and C id must be `killed`. `survived`, `errored` and `CONTROL_RED` must all be 0.

**How each test goes red:** all of them run `probe.main([...])` against `FakeSerial`, or call the pure builder or preflight, and assert on the recorded write sequence, the exit code, or the log's last line. No mutant is caught only by an argparse error or an import failure. The wrong variants below all keep the module importable.

| Id | Test | Wrong variant (one edit) |
|---|---|---|
| E2-M1 | Wedge mode during `--case wedge`: in the write sequence, no line (`M5`, `$X`, `$H`, `G…`, `G4 P0`) appears between the unacked line and the first `0x18` after it | In `cleanup`, replace the `send_byte(0x18, …)` statement with `wire.send_line("M5")` followed by it |
| E2-M2 | A fault in rep 1 of `wedge`: no line of any later variant or rep is written after the cleanup's `0x18`; exit code non-zero | Replace the runner's fault `return`/`break` with `continue` |
| E2-M3a | Across every case's `build_case_plan` output, and the whole write sequence of a live `hold-m4` run, byte `0x9E` never appears | Append a `0x9E` byte step after the `!` step in the `hold-m4` builder |
| E2-M3b | `main(["--pause", …])` returns non-zero before `open_serial` is called, and the message names `--case hold-m4` | Replace the `--pause` refusal's `return 2` with `pass` |
| E2-M4 | `$$` without `$30`: `RESULT REFUSED` names `$30`; no `G0`/`G1`/`M3`/`M4` line is written | `s30 = settings.get(30)` → `s30 = settings.get(30, 1000.0)` |
| E2-M5 | `$$` with `$23=1` and `--x-dir -1`: every X target in the written stream is ≤ 0 | At the live `build_case_plan` call site, replace the `args.x_dir` argument with `(1 if int(settings.get(23, 0)) & 1 else -1)` |
| E2-M6 | `--dry-run` for every case: `open_serial` is never called, exit 0, and stdout equals `format_plan(build_case_plan(case, args, args.x_dir, args.y_dir))`; independently, for the four boxed cases every X/Y in the printed matrix lies inside `origin .. origin+box` with the given sign, and in every case every `S` value is ≤ `--smax` | Replace the `if args.dry_run:` guard around the early return with `if False:` (the test passes `--port` and `--log-file` so the live path would reach `open_serial`) |
| E2-M7 | `--origin-x 380 --box-mm 60` with `$130=400`: refused before motion. The same on Y with `$131` | Replace `box_fits`'s return expression with `True` |
| E2-M8 | `--case hold-m4` with `$32=0`, and separately with no `$32` line: `RESULT REFUSED` names `$32` and laser mode; no `M4` and no motion line is written | Replace the `$32` refusal condition with `False` |
| E2-M9 | A faulted run's log ends with a line starting `RESULT INCOMPLETE` and naming the reason | In `cleanup`, change the written `"RESULT INCOMPLETE"` token to `"RESULT COMPLETE"` |
| E2-M10 | `--case direction`: the plan and the live write sequence start with `G21`, contain `M5` before any `G0`, and contain no `M3`/`M4` and no `S` word | Insert `f"M4 S{smax}"` after `"M5"` in the direction builder |
| E2-M11 | `--case settings` with `$G` → `error:3`: the log and the summary record `$G` as unsupported | Replace the settings case's `error:` branch condition with `False` |
| E2-M12 | Wedge-mode fault: no `$X` line is written anywhere after the fault | In `cleanup`, add `wire.send_line("$X")` after the `0x18` |
| E2-M13 | `KeyboardInterrupt` raised from the fake mid-case: the next write is `0x18` and the last log line starts `RESULT INCOMPLETE` | Replace the `except KeyboardInterrupt:` handler's `cleanup(...)` call with `pass` |
| E2-M14 | `$#` reporting `G54:10.000,0.000,0.000` for a boxed case: refused before motion | Replace the `G54` refusal condition with `False` |
| E2-M15 | `--smax 20` with `$30=10`: refused before motion | Replace the `smax > s30` refusal condition with `False` |
| E2-M16 | A full `--case wedge` run with `$22=1`: no `$H` and no `$X` line is written anywhere | Insert `if settings.get(22) == 1: probe.command("$H")` before the first case step |
| E2-M17 | `--dry-run --smax 0`: the header contains "cannot establish positive-power behaviour" | Replace that header line's condition with `False` |
| E2-C1 | (control) `$32=1`, `$30=1000`, `$130=400`, `$131=415`, `G54` zero, Idle: `hold-m4` reaches its first `G0` | Invert the `$32` check (`!= 1` → `== 1`) |
| E2-C2 | (control) `--case direction` with a `$$` showing `$32=0` is **not** refused, and it runs its steps | Add `"direction"` to `POWERED_CASES` |
| E2-C3 | (control) The `wedge` plan lists the eight existing names in their existing order | Delete the `ring_M4_settle30ms` variant from the builder |

## Verification

- `python3 -m unittest discover -s scripts -p 'test_probe_grbl.py'`: green, with the count of tests run reported.
- `python3 scripts/probe-grbl.py --help`: works. Also run once with pyserial hidden (`python3 -c` inserting `sys.modules['serial'] = None` before `runpy`), to prove lazy import.
- `python3 scripts/probe-grbl.py --case wedge --dry-run --origin-x 20 --origin-y 20 --x-dir 1 --y-dir -1 --box-mm 60 --smax 0 --feed 1000`: prints the header and matrix and opens no port. Also run for each other case. **Razor signs the printed matrices** in the review; that signature is what Lee runs against.
- Battery journal: every E2-M* and E2-C* id `killed`; `survived`, `errored` and `CONTROL_RED` all 0.
- **Vendor-identity grep (Razor), on added lines only:** `git diff -U0 master...relay/kerf-evidence-e2 -- scripts docs | grep '^+' | grep -niE 'falcon|creality|\[VER:|\[OPT:|CV master'`. Must be empty. Pre-existing `:53` is `kerf-d12`'s and is excluded by construction, because it is not an added line; the rewrite must not touch it.
- **No agent runs the probe without `--dry-run`, and no agent opens a real serial port.**
- No browser step: the script is not part of the app.

**Hardware-only (named, not closable here; the owner's session A):**
- The physical direction each `--case direction` step moves.
- That the owner's live `$$` still carries `$30`, `$32=1`, `$130`, `$131`, and whether `$G` and `$#` are supported (the capture carries the four settings; `$G`/`$#` were never sent).
- Whether `0x18` during motion leaves this controller in Alarm (which decides the one-rep-per-invocation note).
- That the dry-run matrix matches where the head actually goes.

## Departures from the parent (each checked against the tree or a named source)

1. **`--stop-on-fault` is always on.** The parent's E2-M2 wording ("continue after fault with `--stop-on-fault`") implies the run continues without the flag. Astra 3.1 acceptance 2 says no next variant follows a fault at all. The flag is kept as a no-op.
2. **INCOMPLETE is read from the last line, not rewritten into the header.** A crashed process cannot rewrite its own header, so the header states the rule instead and a missing `RESULT COMPLETE` is incomplete.
3. **Startup `$X` and `$H` are removed**, not only in cleanup. Astra 3.1 "Files explicitly OUT of scope" forbids auto-home, and a startup unlock would bypass the Alarm a homing-required controller boots into.
4. **`--smax` defaults to 0, and `--log-file` and `--port` are required for live runs.** These are fail-closed defaults. The log rule keeps new logs out of the public tree without waiting on `kerf-d12`.
5. **A `G54` refusal and a `$#` read are added.** The bounds check is meaningless under a non-zero work offset, and soft limits are off on the owner's controller (`$20=0`, capture `:25`).

## What E2 does not satisfy

- **Any claim about the beam.** The status-only ruling means no log or card field says the beam went dark.
- **Capturing the wedge.** That is Lee's session (astra 3.2). This batch only makes it runnable.
- **Astra 3.2 steps 5-6** (app fault scripts, `$32` settings transactions through the app). Those are app-side and not in the probe.
- **One diagnostic datum is lost on purpose.** The old wedge path's "does a plain command also go unanswered" (`G4 P0`, `:361`) was a line written before the reset; the 2026-09-20 ruling forbids that order. The consecutive Idle replies that define the wedge are still logged.
- **The M3 sequences.** `ring_M3` and `two_rings_M3` fire a stationary beam at `S{smax}` for one ack round trip between `M3` and the first `G1` (`:313-319`). They are kept because astra 3.1 says keep all eight; the card orders them at S0 first. Named, not changed.
- **The committed probe log and the `:53` comment** belong to `kerf-d12`.

## Stage 3.5 obligations (orchestrator)

- **ROADMAP:** a `shipped` entry for E2 stating the new CLI contract and refusals. **Do not edit** the verbatim deferred section whose "Tooling" paragraph (`ROADMAP.md:607-612`) describes the old probe ("recovers with `0x18` between variants"). Instead, append one Parking Lot index line: `- **Probe contract changed (E2)** — the Tooling paragraph under the 2026-09-05 deferred section describes the pre-E2 probe; the current contract is in docs/qualification-card.md.`
- **Parking Lot line:** `- **Wedge diagnostic "plain command while wedged" retired (E2)** — the probe no longer writes a line before its reset; if session A needs that datum, it needs a new plan that writes the probe line with output isolated only.`
- **ARCHITECTURE.md:** no delta. It does not describe `scripts/` or `docs/` (verified by grep: no `scripts/` or `docs/` entry).

## Risks and rollback

- **A wrong matrix sends the head somewhere unexpected.** Mitigations: Razor signs every dry-run matrix; the card requires `direction` first; every boxed case refuses without `$130`/`$131`, on a non-zero `G54`, or with a box that does not fit; the default power is S0.
- **The preflight could be too strict for the owner's firmware.** If `$G` or `$#` is unsupported, that is recorded and not a refusal. Only a missing `$30`/`$32`/`$130`/`$131` or a non-zero `G54` refuses, and the capture shows the four settings present. If a live run refuses anyway, that is the evidence, and nothing is weakened.
- **Rollback:** revert the relay merge commit. Nothing else depends on E2 except E4's pointer.
- **Irreversible steps:** none. No agent runs the probe against a port. No setting is written by the probe in any case (there is no `$N=` step anywhere).
