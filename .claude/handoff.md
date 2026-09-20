# Kerf — Hand-off

**What this file is:** the volatile layer. What is in flight, what is owed, what is waiting on
Lee, and a short log. It is safe to rewrite _because nothing permanent lives here any more._

Supersedes the dated `kerf-handoff-*.md` files in `~/marvin/state/` (tombstoned, pointing here).

**Where everything else went** (restructured 2026-08-21):

| You want…                                               | Read                                               |
| ------------------------------------------------------- | -------------------------------------------------- |
| Rulings, pins, operating constraints — anything decided | `.claude/DECISIONS.md` — **append-and-amend only** |
| Named work not yet scheduled                            | `ROADMAP.md` → **Parking Lot**                     |
| What shipped, and when                                  | `ROADMAP.md` → `shipped`                           |

**Read `.claude/DECISIONS.md` before proposing anything.** Most of what looks like a fresh idea
in this project has already been ruled on, usually for a reason that is not obvious from the code.

---

## Owed right now

- **Phase 2A implemented and reviewed (2026-08-29).** Relay
  `kerf-phase-2a-streaming` complete: Ted+Razor PASS (1 WARNING fixed —
  missing safety volley in buffered path). Character-counting pump, Tauri
  Channel streaming, TS mode dispatch all landed on
  `relay/kerf-phase-2a-streaming-r2`. Ships behind opt-in `streamingMode`
  toggle (default `perLine`). **Next gate: owner hardware A/B test**
  (session #1, ~30-45min: same dense-curve job in perLine vs buffered,
  compare burn quality). Gate D1c decides whether buffered becomes the
  default.

- **Limits relay: Razor post-ship PASS.** The kerf-limits-wiring relay
  (4a33dec) shipped in v0.8.26 before Razor ran. Post-ship cold-eyes
  review (Opus): PASS — 0 CRITICAL, 0 WARNING, 0 NOTE. All guards
  correctly wired, no bypass paths, tests non-tautological. Gate closed.

- **RELEASE BLOCKED — two hardware-confirmed safety defects (2026-09-05).** (1) The pause volley re-arms the beam: `0x9E` is a toggle and stock GRBL already stops the laser at hold-complete, so Kerf's byte undoes the firmware's own protection; the v0.8.28 `Hold:0` poll can never succeed during a job (the status query `try_lock`s the command lock the pump holds), so it times out at 3s and fires anyway. Owner-confirmed: both the 3s warning and `[MSG:Restoring spindle]` appear on a real pause. (2) Laser-switch wedge: intermittently the controller stops acking every line command after an `M3`/`M4` while still answering `?` with `Idle`, until `0x18`. Full record, ruled-out hypotheses, and fix direction: `ROADMAP.md` → `### Deferred from the 2026-09-05 pause/stop investigation`. **Nothing is fixed; no production code changed.**

- **OWNER HARDWARE TEST — superseded card, Part 0 first.** The test card artifact (https://claude.ai/code/artifact/f1df614c-7007-4609-afb6-a898aab06de1) was revised 2026-09-05: the investigation sits at the top and a new Part 0 (7 probe steps) runs before everything else. Steps 6, 7 and 20 (pause/resume, stop) are marked superseded and excluded from the progress count. `docs/test-card.md` in-repo has NOT been updated to match — do that when the pause path is rebuilt.

- **Phase 2A A/B test (gate D1c) is deferred behind both defects** and its premise is now in question: this controller reports a 127-block planner and 65536-byte RX buffer (`[OPT:VHL,127,65536]`), so per-line streaming may already keep it fed. Record that in the A/B result before buffered is considered for default.

- **OWED BY LEE: the scrap comparison cut (M4 default validation).** Cut a sharp-cornered square AND a perforated line on scrap at unchanged settings, then compare against a part cut on the previous build. Confirm `$32=1` first — at `$32=0` the controller treats M4 as M3 and the comparison is meaningless. This answers three questions at once: whether the corner over-burn was M3 (Lee reported the symptom independently), whether M4 under-powers short segments (Razor: a 1mm perforation dash reaches ~61% peak, ~40% mean at the app's 300 mm/s² fallback), and whether the new default is safe to keep. Nothing in the tree has ever emitted M4 for a vector line layer, so the first physical cut on the new default is unverified.

- **Four astra audits + a 20-batch remediation plan exist and are unread by any later session.** Reports at `~/marvin/state/audits/kerf-astra-2026-09-08/` — A1 firmware contract (7 findings), A2 test validity (5), A3 concurrency (8), A4 gcode/geometry (9), reconciled into 22 ranked items in `PLAN.md` (6 phases, 20 relay-sized batches, each written to be liftable into its own spec file). Read `PLAN.md` before proposing any remediation: it explicitly rejects several tempting fixes, including the ROADMAP's parked compare-position-and-resend recovery.

- **Batch 0.1 (native command-body trace harness) COMPLETE (2026-09-20).** Relay `remediation-batch-01`: Ted+Razor PASS (0 CRITICAL, 0 WARNING, 4 NOTE). Four command bodies extracted (`serial_connect_inner`, `serial_send_inner`, `serial_get_status_inner`, `serial_stream_job_inner`), ScriptedPort infrastructure, three invariant pins (PumpFlight, try_lock, $32=1 gate). Pin 4 (connect 0x18 count) unproven — needs port factory injection, routed to Tauri smoke. 260 Rust / 764 JS tests. **Batch 0.2** (test actual buttons + async continuations, TS side) is next and unblocked.

- **Batch 2.3 must be re-specified before anyone implements it.** It was written to enforce a RESTRICTED release envelope; Lee chose the full feature set, so its refusals have to become actual corrections (R8, R13, R18, R19). It will likely split into three or four batches. The M4 default flip already pre-empts part of R8.

- **Relay B (rapid gap traversal) COMPLETE (2026-09-19).** Relay `engrave-efficiency-b`: Ted+Razor PASS_WITH_WARNINGS (W1 fixed — vector path wiring gap). Acceleration-safe three-segment rapid gaps in the scanner, gated on 10% modeled savings. 251 Rust / 764 JS tests. On `relay-b-rapid-gaps` branch, not yet merged. Owner hardware coupon test recommended before calling production-validated.

- **Charter amendment needed.** The text tool (4 bundled fonts, auto-convert at G-code time) ships in v0.8.29 and contradicts the charter's explicit exclusion of built-in font rendering. Lee requested it directly. Neither CHARTER.md nor ROADMAP's 'What We're NOT Building' has been amended. A one-line amendment approved by Lee closes the contradiction.

- **Charter gap analysis at `.claude/plans/charter-gap-analysis.md`** — 293-line Fable audit of all 10 codebase areas vs the charter. None of the three 'done' conditions are met. Top gaps ranked. The fastest path to 'done' follows the existing remediation plan order.

## Open questions awaiting Lee

| Question                                                                                            | Why it matters                                                                        | Raised     |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------- |
| ~~Is the laser repaired and back in service?~~ **Confirmed 2026-08-27**                             | Constraint lifted. Hardware test and Phase 2 unblocked.                               | 2026-07-10 |
| Can you provide a sample Inkscape SVG that reproduces the path-coordinate drift?                    | Bug can't be fixed without a repro; the import code has been audited clean otherwise  | 2026-06-21 |
| Clipper2 dependency decision for Phase 4 (offsetFill compound correctness, kerf-offset-on-fillLine) (resolved 2026-09-10) | Gate D2 — changes real cut geometry output, needs your sign-off before Phase 4 starts | 2026-07-05 |
| v0.9 Camera & Rotary — do you have/plan to get the hardware?                                        | Gate D4 — the feature stays parked with no planning until confirmed                   | 2026-07-05 |
| streamingMode default: flip `perLine`→`buffered` after session #1's A/B?                            | Gate D1c — the rule is recorded in `DECISIONS.md`; you may override                   | 2026-07-05 |
| Given the controller's 127-block planner, is Phase 2A buffered streaming still worth shipping on this machine? | Phase 2A was built to cure stutter caused by stock GRBL's 15-block planner. This vendor fork has 127. The A/B test may show no difference, which would make gate D1c a decision to keep perLine permanently. | 2026-09-05 |
| Amend the charter to include the text tool? One line: 'built-in text from bundled fonts is in; font management and text-on-path stay out.' | The tree contradicts its own founding document. The ROADMAP parks text behind gate D3 (v1.0), which was skipped rather than opened. | 2026-09-19 |

---

## Log (newest first)

### 2026-09-19

**Session 1b2844: six relays, one audit, one release.**

Probe script ran (first attempt failed — DTR fix applied and pushed; second run completed, 40/40 laser-switch sequences PASS, pause re-arm confirmed on wire with [MSG:Restoring spindle]). Laser-switch wedge reported again Sep 16 during engrave (console: normal G1 ok ok then 'terminal lost'). Machine identity confirmed: ESP32-S3, CV50-MASTER-Release V3.0.4, 127-block planner, 65536B RX.

v0.8.29 tagged and pushed: pause safety ($32=1 gate, 0x9E removed, sim toggle + hold-complete auto-off), text tool (auto-convert at G-code time, 4 bundled fonts, font picker, multiline, alignment), color tracing (2-32 colors via vtracer, better presets, full-res preview). 748 JS + 235 Rust tests.

Relay A of engrave efficiency merged post-v0.8.29: grayscale pixel compression (merge equal-S into one G1), modal power hoist (M3/M4 once not per-row), modal field omission (F on first G1 only), overscan floor fix (3mm → kinematic minimum), layer speed warning for images on cut layers. 762 JS + 246 Rust tests.

Fable charter gap analysis completed (`.claude/plans/charter-gap-analysis.md`): none of the charter's three 'done' conditions met. Top gaps: unfixed wedge + abort order pin violation, laser-stops-firing (3 reports), incomplete $32 gate (material test bypasses), unqualifiable pause, silent Fill+Line rectangle drop. Text tool contradiction flagged. Process: v0.8.29 tagged while DECISIONS says RELEASE BLOCKED.

Relay B (rapid gap traversal) COMPLETE: Ted+Razor PASS_WITH_WARNINGS (W1 vector wiring gap fixed, N1 variable name fixed). ScanMotion metadata wired through both IPC paths, three-segment gap emission implemented with rotation fix (image-space ramp computation), 5 new Rust + 2 new TS tests. 251 Rust / 764 JS total.

New symptom: 'laser stops firing' mid-job (head keeps moving, laser dark). Reported 3 times (Sep 14 twice, Sep 16). Phase 1 spindle-drop diagnostic deployed in v0.8.29 — will capture FS: field data on next occurrence.

v0.8.30 tagged and pushed: engrave efficiency Relays A+B (pixel compression, modal hoist, overscan floor, layer warning, rapid gap traversal). 764 JS + 251 Rust tests. Cross-object scan merging parked in ROADMAP (owner-reported: duplicated pieces engrave one at a time instead of one continuous sweep).

Remediation batch 0.1 COMPLETE: four command bodies extracted, ScriptedPort infrastructure, three invariant pins. Razor PASS (0W/4N). 260 Rust tests.

Batch 0.2 (test buttons + async continuations) COMPLETE: unified recorder, STOP dispatch test (0x21→0x18 byte order), it.fails cross-job corruption (R4/R11), recorder self-test, deferred-callback test. Razor PASS (1W fixed, 3N). 768 JS tests (767 pass + 1 expected fail).

Next: Phase 0 exit — both harness batches done. Phase 1 (one owner, one stop, truthful observation) is next but BLOCKED on Decision "Abort policy" for batches 1.1/1.5. Charter amendment decision also pending.

### 2026-09-10

**Four independent astra audits of the codebase, a 20-batch remediation plan, seven owner decisions recorded, and one shipped fix.**

**The audits.** Four `gpt-6-astra` runs against a pinned clone of `c4bf29f`, briefed with the machine reality up front (Creality Falcon 2 40W, ESP32-S3 board, closed-source vendor firmware speaking GRBL 1.1 — so gnea/grbl source is evidence of intent, never proof about this machine). 29 findings. Reports in `~/marvin/state/audits/kerf-astra-2026-09-08/`. A first attempt on 2026-09-08 lost four concurrent runs to the Codex usage limit — clean exits, no artifacts, ~491K tokens — and the salvage came from interim narration in the logs. Re-run serially with incremental-write briefs; every one landed. Measured cost: one high-effort run is ~36% of the 5-hour window, so two fit and four never could have.

**Convergences, which is where the weight is.** The job-abort order appears in FOUR independent reports (A1 F1, A2 F1, A3 F1, A4 corroborating) — `jobStream.ts:273` and `:412` both `await send("M5")` before `softReset()`, violating the standing pin that the abort order must never contain an ack-awaited write. The `$32`/`$30` configuration-trust problem appears in THREE, from three different entry points. Neither was in any brief.

**The plan.** `PLAN.md`, 114KB, 6 phases, 20 relay-sized batches, 29 findings reconciled into 22 ranked by reachability rather than by the severity label the auditor typed. Its headline: an abort-order patch alone clears neither blocker. It argued with its own inputs — rejected three of the plan critic's claims, read the `serialport` crate source itself to check A3's stranded-reset claim, and rejected the ROADMAP's parked compare-position-and-resend recovery on the grounds that position cannot establish whether an M-code, dwell or repeated cut executed.

**Seven owner decisions**, recorded via an artifact docket (https://claude.ai/code/artifact/98faf585-7d7d-441f-a79d-7b37b375a2bb, choices stored in its db). Five as recommended, two overrides — full feature set rather than a restricted envelope, and status-only hardware evidence rather than an optical instrument.

**Shipped: `c8400de` — M4 becomes the default power mode.** Constant power (M3) was the default for every layer except Engrave, so nearly all cutting ran at constant power without anyone choosing it; Lee independently reported the predicted symptom (corners burning harder than the rest of the cut). Ted + Razor, three fix passes. Five distinct defects surfaced from one default flip: the `$32=0` warning didn't cover vector jobs; the legacy-file exclusion had a hole; min power could exceed commanded power (a layer at power 40 / powerMin 60 emitted S400 and would have emitted S600); the fix for the third introduced a mirror-image regression; and no build refused a file stamped newer than itself. Clamp ended up at the store's write doors rather than on four separate controls. 738 TS / 234 Rust green, verified by the orchestrator rather than taken on report.

**Four of those five defects were the same shape**: a correct fix applied to one instance and not its siblings. `emergencyStop` vs the two abort paths; `$32` gated on the buffered path but not the default one; M4 on engrave but not cuts; and the abort-order patch itself. The suite had encoded two of them as requirements. Lee named the pattern mid-session as general across all projects.

Next: the scrap comparison cut, the `probe-grbl.py` trace, then batch 0.1.

### 2026-09-05

**Pause/stop investigation — both halves of the 2026-09-02 double failure traced; a second, unrelated defect found.** No production code changed. Full verbatim record in `ROADMAP.md` → `### Deferred from the 2026-09-05 pause/stop investigation`.

**Defect 1, the pause re-arm — root-caused and owner-confirmed.** `DISABLE_LASER_DURING_HOLD` is default-enabled in stock GRBL 1.1, so with `$32=1` the firmware raises its own spindle-stop override at hold-complete and the laser is already off. `0x9E` is a toggle (`EXEC_SPINDLE_OVR_STOP`); arriving with the override already up it takes the RESTORE branch, emits `[MSG:Restoring spindle]`, and re-energizes the beam. The v0.8.28 fix (62c7c36) made it worse: its `Hold:0` poll `try_lock`s the command lock the pump holds for the whole job, so it always times out at the 3s cap and fires the toggle anyway — the owner's observed 2-3 second delay. That commit's stated premise ("GRBL ignores 0x9E during Hold:1") is not what the source says. It survived two reviews because `sim/grbl.rs` models `0x9E` as unconditional off and does not model the firmware's automatic hold-off, and the TS test mocks `getStatusReport` so it never meets the lock. Owner confirmed both the 3s warning and `[MSG:Restoring spindle]` on hardware.

**Defect 2, the laser-switch wedge — found, not diagnosed.** Intermittently the controller stops acking all line commands after an `M3`/`M4` while still answering `?` with `Idle`, until `0x18`. Surfaces as `terminal lost: GRBL reported Idle 3 consecutive times with no ok`; the watchdog behaves correctly. Console probes ruled out the failing coordinate itself and a laser command arriving mid-`G1` with polling active. Timing-dependent: same spot twice, then a clean run. Suspects left: the zero-length `G1 …F… S0` before the switch, and a switch arriving during a `G0` rapid.

**Controller identity.** Vendor GRBL fork, not stock: `[VER:1.1f.20220810:]`, "CV master-release 3.0.4", `[OPT:VHL,127,65536]` — 127-block planner, 65536-byte RX buffer (stock: 15 and 128). Stock source is evidence about intent, not proof about this machine.

**Shipped this session:** `scripts/probe-grbl.py` — a reproducer that drives the controller through eight laser-switch sequences at job speed (laser capped at 1%), reproduces Kerf's per-line protocol including the 1Hz `?` probe and 3-strike idle-stall rule, records whether the controller still answers `?` while wedged, and recovers with `0x18` between variants. Smoke-tested against a pty fake in healthy and wedging modes. **Next: Lee runs it and returns the log.**

### 2026-08-29

Phase 2A relay complete (kerf-phase-2a-streaming, relay/kerf-phase-2a-streaming-r2).
Stages 0-5 all done. Ted implemented the character-counting buffered pump (3 commits:
batch 1 + completion-check fix + safety-volley fix). Razor initial review
PASS_WITH_WARNINGS (1 WARNING: missing safety volley in buffered path); Ted fixed;
Razor re-review PASS. All three DECISIONS.md pins verified. 231 Rust / 721 TS tests
green. **Next:** owner hardware A/B test (gate D1c), then v0.8.27 tag.

### 2026-08-27

v0.8.26 release prepared. Contents: the full v0.8.25 comprehensive remediation
(which was tagged but never built — CI was red behind two P6-A breaks, now fixed),
PLUS the limits.rs wiring relay (image_gcode_gen.rs + tracer.rs + mask_fill.rs
allocator-abort guards, 4a33dec, 216 Rust tests). Laser confirmed back in service
by Lee; DECISIONS.md hardware constraint reversed. CI must go green before tag.

### 2026-08-26

Phase 2A plan gate cleared. The plan (`prancy-fluttering-wave.md`) had all four
prior critic must-fixes already folded (Intent section, line-too-long pre-validation,
worst-case physical outcome, STOP button sequence). Critic re-run on Opus (Fable
rate-limited, sanctioned fallback per rubric): 14 active dimensions, all PASS. Two
advisory items folded into the plan (channel.send failure policy, concurrent
serial_send note). Charter committed at `3d6ecc0`. Plan is ready for implementation
via relay, still blocked on the owner hardware test + laser confirmation.
**Next:** implementation waits on Lee confirming the laser is back in service.

### 2026-08-21

Hand-off restructured by lifetime, following the MARVIN convention and the Fern reference
implementation (`fern 91b4db1`): standing decisions extracted to `.claude/DECISIONS.md`,
deferrals indexed in the ROADMAP's Parking Lot, this file cut to the volatile layer. The
hand-off was untracked until now and held the project's only copy of the Phase 2 abort-order
pin. Hardware-identity and incident detail were deliberately not carried into the public
files; they stay in the private register.

**2026-07-10 — Audit remediation planning (post-fire).** The owner's laser was damaged during
a thick-cedar burn (slow/high power) — recovery guide + hardware test card sent; detail in the
private register. Separately, a
Fable-discovered/Opus-verified codebase audit landed 23 findings (21
confirmed, 2 plausible-low, 0 rejected) across 4 clusters: machine/laser
safety (pause deadlock, mid-job disconnect leaves beam on, FRAME ignores
STOP, material-test skips abort/has no bounds gate — 7 total), silent G-code
errors (ellipse-on-fill engraves nothing, grouped images dropped, rotation
bugs — 6), import/export integrity (PDF vector import dead, non-atomic save,
silent failures — 6), Rust robustness (unbounded alloc, OOM — 4). Safety-first
remediation plan (4 tranches, ~6 relays) written, dual-reviewed (critic +
Fable second pass, all must-fixes folded), and Lee approved sequencing.
**Resolved:** the entire plan shipped as v0.8.25 "Comprehensive Remediation"
on 2026-08-06 (6 phases, 10 relays, 922 tests) — see ROADMAP shipped log for
full detail. Only the owner hardware verification of that release remains open
(see Owed right now).

**2026-07-05 — Phase 2 (streaming rework) hand-off.** Phase 0 (deck-clearing,
v0.8.24) and Phase 1 (GRBL simulator + test spine, Rust 117→169 tests) done
on master. Phase 2 — the character-counting streaming rework — is next and
is the program's highest-risk phase (first one needing the owner's laser).
Design already locked: new `job_start`/`job_stop` Tauri Channel commands,
127-byte window accounting, pause/resume re-plumbed off today's
line-based F16 wraps.
Design decisions from this batch (abort order, `$32=1` gate, `streamingMode`
default, the 2A design-pass rule): see `DECISIONS.md` → Engineering pins and
Operating constraints.
**Status: still the next phase per ROADMAP; not started as of 2026-08-14.**

**2026-06-21 — Triage of 6 Lee-reported issues + maskFill ship.** maskFill
even-odd bitmap fill landed on master (letter-counter over-burn + H/N stroke
dropout fixed; physical test-burn was still owed). Six field-reported issues
captured with file pointers: (1) Save doesn't save, (2) move-vs-deform
inconsistent, (3) rotation handle dead, (4) no pan/hand tool, (5) material
tests unverified, (6) speed slider too coarse + no sane upper bound.
**Resolved:** all six shipped within days — Save (v0.8.11), move/rotate
handles (v0.8.10, resize/rotation rework), pan tool + measure + cursor
readout (v0.8.13, Viewport Tools), speed log-scale + machine-derived cap
(v0.8.12). Material-test verification (issue 5) was later subsumed into the
2026-07-10 audit's cluster A findings (bounds gate, abort-check skip) and
closed in v0.8.25.
