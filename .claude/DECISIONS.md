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

---

## Evidence corrections

### The SVG path-coordinate drift is not an import/transform defect — that code was audited clean
*2026-06-21*

Import/transform code audited clean; needs a sample Inkscape SVG from Lee to reproduce.
Carried across all three prior hand-offs with no progress. Do not re-derive an
import/transform theory without a reproducing file.
