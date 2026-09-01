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

- OWNER HARDWARE TEST IN PROGRESS (v0.8.28). Pause bug (laser-on during pause) found and fixed in v0.8.28 (poll for Hold:0 before 0x9E). Lee is testing. Streaming A/B results still pending. Test card artifact: https://claude.ai/code/artifact/f1df614c-7007-4609-afb6-a898aab06de1

## Open questions awaiting Lee

| Question                                                                                            | Why it matters                                                                        | Raised     |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------- |
| ~~Is the laser repaired and back in service?~~ **Confirmed 2026-08-27**                             | Constraint lifted. Hardware test and Phase 2 unblocked.                               | 2026-07-10 |
| Can you provide a sample Inkscape SVG that reproduces the path-coordinate drift?                    | Bug can't be fixed without a repro; the import code has been audited clean otherwise  | 2026-06-21 |
| Clipper2 dependency decision for Phase 4 (offsetFill compound correctness, kerf-offset-on-fillLine) | Gate D2 — changes real cut geometry output, needs your sign-off before Phase 4 starts | 2026-07-05 |
| v0.9 Camera & Rotary — do you have/plan to get the hardware?                                        | Gate D4 — the feature stays parked with no planning until confirmed                   | 2026-07-05 |
| streamingMode default: flip `perLine`→`buffered` after session #1's A/B?                            | Gate D1c — the rule is recorded in `DECISIONS.md`; you may override                   | 2026-07-05 |

---

## Log (newest first)

### 2026-09-01

v0.8.27 released (Phase 2A character-counting streaming pump + full relay). v0.8.28
released same day (safety fix: pause 0x9E must poll for Hold:0, not use a fixed 100ms
timer — hardware-confirmed that GRBL ignores 0x9E during Hold:1 deceleration, leaving
the laser on). Both tags pushed, CI built .dmg/.AppImage/.deb. Interactive test card
artifact created for the hardware test session. Lee began testing; pause bug was the
first finding. Prettier formatting fixed across the relay's files.

**Next:** Lee completes the hardware test card (baseline + remediation + streaming A/B).
Gate D1c (flip default to buffered?) depends on the A/B results.

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
