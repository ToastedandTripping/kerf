# Kerf — Standing Decisions

**Write rule: APPEND AND AMEND. Never rewrite, never delete.**

A decision leaves this file only by being explicitly reversed, and a reversal is written
_into_ the entry it reverses — struck through, dated, with the reason. Nothing here is
removed because it looks stale, because a rewrite felt cleaner, or because the reader
doesn't recognise it. If an entry seems wrong, that is a reason to investigate it, not to
delete it.

**Why this file exists.** It was extracted from `.claude/handoff.md` on 2026-08-21 as part
of the fleet restructure after the Fern near-miss of 2026-08-16; this hand-off was
untracked and held the project's only copy of a safety-critical streaming pin. A hand-off
that is mostly permanent content is one rewrite away from losing that content silently.
Permanent content now lives here, where rewriting is not a thing anyone does.

**Scope.** Decisions and permanent operating constraints. Not work-in-flight (that is
`.claude/handoff.md`), not scheduled-or-parked work (that is `ROADMAP.md`).

**Public repo.** This repository is public. Anything that would publish new private detail
(hardware identity, incident narrative, account or contact information) is recorded here
only as a pointer; the detail stays in the private register.

---

## Product rulings

### streamingMode default: flip `perLine`→`buffered` only if buffered measurably wins
*2026-07-05*

Gate D1c — recommended default is "flip if buffered wins, keep perLine if no measurable
difference"; you may override.

---

## Engineering pins

### The Phase 2 abort order is safety-critical and must never contain an ack-awaited write
*2026-07-05*

safety-critical abort order (`!` → ~100ms settle → realtime `0x18` → conditional M5 —
never an ack-awaited write in between, that recreates the F13 deadlock).

### `$32=1` is hard-gated at job_start and `streamingMode` defaults to `perLine`
*2026-07-05*

`$32=1` hard-gated at job_start, JobEvents (Progress/Console/Status/Finished) coalesced
50-100ms, `streamingMode` localStorage rollback flag defaulting `perLine`.

> Status — whether Phase 2 has started — is tracked in `ROADMAP.md`, not here. This entry
> records only what was decided.

---

## Operating constraints

### Nothing hardware-gated proceeds until the owner's laser is confirmed back in service
*2026-07-10, reversed 2026-08-27*

The machine was damaged and its repair has never been confirmed (detail: see the private
hand-off register, not published here). This blocks BOTH the v0.8.25 owner hardware test
and Phase 2's owner laser session #1 — nothing hardware-gated can proceed until the
machine is confirmed back in service. The constraint lifts by confirmation, not by
assumption.

~~Nothing hardware-gated proceeds until the owner's laser is confirmed back in service~~ **Reversed, per Lee, 2026-08-27:** Laser confirmed back in operation by the owner (2026-08-27). The constraint is lifted. The v0.8.25 owner hardware test and Phase 2's owner laser session #1 are unblocked.

### Gate D2 (Phase 4 entry) is explicitly a "Lee + architect call"
*2026-07-05*

Clipper2-as-a-dependency call for offsetFill compound-shape correctness + the
kerf-offset-on-fillLine-perimeter design. Explicitly "Lee + architect call" — not yet
made. An implementer does not settle it in passing.

### Phase 2A gets a design/plan pass before Ted implements
*2026-07-05*

Recommended: a design/plan pass for 2A before Ted implements — not a straight jump to
implementation. It is the program's highest-risk phase and the first one that touches real
machine behaviour.

### The owner's controller is a vendor GRBL fork — stock GRBL source is evidence about intent, never proof about this machine
*2026-09-05*

Read from the machine 2026-09-05: `[VER:1.1f.20220810:]`, vendor string "CV master-release 3.0.4", `[OPT:VHL,127,65536]` — a 127-block planner and 65536-byte RX buffer against stock GRBL's 15 and 128. Two consequences. (a) Behaviours observed on this machine that stock source says are impossible are real and must be handled, not argued away: the intermittent laser-switch wedge (controller stops acking line commands after `M3`/`M4` while still answering `?` with `Idle`, until `0x18`) is one such, and a `0x18` that failed to stop the beam on 2026-09-02 is another. (b) Phase 2A's premise is questionable here — a 127-block planner means per-line streaming may already keep this controller fed, so the stutter buffered mode was built to cure may not exist on this hardware. Record the planner depth alongside any gate D1c A/B result.

---

## Evidence corrections

### The SVG path-coordinate drift is not an import/transform defect — that code was audited clean
*2026-06-21*

Import/transform code audited clean; needs a sample Inkscape SVG from Lee to reproduce.
Carried across all three prior hand-offs with no progress. Do not re-derive an
import/transform theory without a reproducing file.

### `0x9E` is a TOGGLE and GRBL already stops the laser itself at hold-complete — Kerf's pause volley re-arms the beam
*2026-09-05*

Traced to gnea/grbl source and confirmed on the owner's hardware 2026-09-05. `DISABLE_LASER_DURING_HOLD` is default-enabled in stock GRBL 1.1: with `$32=1` the firmware raises its OWN spindle-stop override the moment a feed hold completes, so the laser is already off before Kerf acts. `0x9E` is `EXEC_SPINDLE_OVR_STOP`, a toggle — arriving with the override already up it takes the `SPINDLE_STOP_OVR_RESTORE` branch, emits `[MSG:Restoring spindle]`, and re-energizes the beam. The v0.8.28 `Hold:0` poll (62c7c36) cannot mitigate this: `serial_get_status` `try_lock`s the command lock that the pump holds for the whole job, so the poll always returns the empty sentinel, times out at 3s, and fires the toggle anyway. That commit's premise — "GRBL ignores 0x9E during Hold:1" — is not what the source says; the only gate is `sys.state == STATE_HOLD`. Do not re-derive a fix that sends `0x9E` unconditionally on pause. The correct signal is the `A:` accessory field of the status report (`A:S` = spindle energized): send the byte only if the beam is still on after hold-complete.

### The GRBL simulator models `0x9E` as unconditional off and has no automatic laser-off at hold — its pause tests certify a protocol the hardware does not run
*2026-09-05*

`src-tauri/src/sim/grbl.rs` clears `spindle_on` when `0x9E` arrives in Hold, and never sets it in the first place at hold-complete. Both are wrong against stock GRBL 1.1. Consequently the whole green pause-volley suite (`pause_volley_hold_then_0x9e_clears_spindle_resume_keeps_it_off` and siblings) asserts a behaviour the real controller does not have, and it passed the beam-re-arm defect through two reviews. The TS side has the same hole from the other end: the v0.8.28 test mocks `getStatusReport`, so it never meets the command lock that makes the poll useless in production. Treat sim-green on any spindle/hold path as unproven until the simulator models the toggle and the firmware's own hold-off, and until the TS test exercises the real lock.
