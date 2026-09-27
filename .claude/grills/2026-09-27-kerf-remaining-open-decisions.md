# Grill: clear up any remaining decisions on Kerf before getting back to the planned work

**Date:** 2026-09-27
**Goal:** every open Kerf question is either decided or knowingly parked, so the gap-pass relays (E1b, S3c, S4a/b/c, S5, E4, R3) run without stopping to ask.
**Status:** confirmed (gate: "Yes, this is it", 2026-09-27)
**Mode:** standalone

## Summary / key decisions
<!-- rewritten from scratch after every round -->
- Publish v0.8.31 publicly, carrying the rebuilt STOP, the fence, the jog/bed limits and the stray-burn fixes. (R1, Lee overrode the recommendation of a private build)
- Releases are no longer gated on the controller-freeze (laser-switch wedge) bug or on qualifying a dark beam. The wedge stays open, must still be captured and prevented, is never reported as fixed, and every release's notes name it. (R2, Lee overrode the recommendation of a one-release exception)
- The Min Pwr box shows only on image layers, where it actually works. (R1, recommended taken)
- Controller firmware strings in the public repo are accepted: the DECISIONS header rule is amended to allow them, and future diagnostic logs stay out of the repo. (R1, recommended taken)
- Buffered sending is settled by one comparison run on a dense job, on the published build; if there is no visible difference, it is removed. (R1, recommended taken)
- Camera and rotary stay parked; Lee has no hardware and no plan to get it. (R2, recommended taken)
- The Inkscape drift report is closed until it recurs with a saved file. (R2, recommended taken)

## Facts established
- Master is 1c41a89 (2026-09-27): the stop spine, the fence, S1, S3, engine-arm and engine-leadin are all merged and none are in a build. Lee's laser runs v0.8.30. -- source: `git log`, ROADMAP `current`
- A manual run of the build workflow (`workflow_dispatch`) builds the macOS and Linux installers as downloadable CI artifacts. The publish step runs only on a `v*` tag, so a manual run publishes nothing. -- source: `.github/workflows/build.yml:3-7, 159`
- Already decided, not re-asked: text tool in the charter (kerf-d7, Lee 2026-09-25), the air pump is switched by the controller (kerf-d10, Lee), warn before cutting plus a 1-2 day design study of the geometry library against fixing Kerf's own offset code (kerf-d9, delegated 2026-09-25; this also settles kerf-d3's "design pass first"), homing habit "always press home" (kerf-9, Lee 2026-09-26), jog bed confirmation and the material-test Y correction (kerf-10, written 2fefa32). -- source: `RESOLUTIONS-2026-09-25.json`, `.claude/DECISIONS.md`
- The "is the laser repaired?" question row (kerf-d1) was confirmed on 2026-08-27. Removing it is housekeeping, not a decision. -- source: `.claude/handoff.md`
- Open from the 2026-09-24 gap pass: kerf-d8 (build), kerf-d11 (Min Pwr), kerf-d12 (controller identity in the public repo), kerf-d5/d6 (buffered sending), kerf-d4 (camera/rotary), kerf-d2 (Inkscape drift). -- source: `~/marvin/state/audits/gap-2026-09-24/kerf/decisions.json`

## Rounds
### Round 1
- Q1 (kerf-d8): How should the merged safety work reach the laser? | Rec: Private build | Answered: Publish v0.8.31 | Flags: overrode-rec; conflicts with the 2026-09-10 wedge-before-release ruling and the status-only 'powered release stays blocked' ruling, so an amendment is owed (R2)
- Q2 (kerf-d11): Min Pwr box on non-image layers | Rec: Image layers only | Answered: Image layers only | Flags: none
- Q3 (kerf-d12): Controller identity in the public repo | Rec: Accept, fix rule | Answered: Accept, fix rule | Flags: none
- Q4 (kerf-d6/d5): Buffered sending | Rec: One comparison run | Answered: One comparison run | Flags: none; the run happens on the published build

### Round 2
- Q1: How do the Sept 10 release-blocking rulings change for v0.8.31? | Rec: Exception for 0.8.31 | Answered: Lift the release block | Flags: overrode-rec. Hardware risk flagged once in the question: the new STOP has never run on the machine, so run the owner test card on scrap first.
- Q2 (kerf-d4): Camera/rotary hardware | Rec: No, keep parked | Answered: No, keep parked | Flags: none
- Q3 (kerf-d2): Inkscape drift report | Rec: Close it | Answered: Close it | Flags: none

## Open flags -> owner
| Flag | Owner | Route |
|---|---|---|
| Owner test card on scrap before trusting the new STOP on a real job | Lee | v0.8.31 release notes + ROADMAP owner card |
| Buffered comparison run (one dense job both ways) | Lee | on v0.8.31; a removal relay follows if there's no difference |
| Geometry design study (library vs own offset code), kerf-d9 | session | unscheduled; not in the gap-pass carry-over |
| Min Pwr image-layers-only change | session | plan, critic, relay after E1b |

## Graduation (proposed)
Lee's gate answer ("Yes, this is it" on an option that said "I write the rulings, publish v0.8.31") was taken as approval for the first four moves below. They were applied on 2026-09-27.
- DECISIONS.md amend: the wedge entry now lifts the release gate; the wedge stays open and is named in every release. APPLIED
- DECISIONS.md amend: the status-only entry no longer blocks powered release; no dark-beam claims. APPLIED
- DECISIONS.md amend: streamingMode, where one comparison run decides and no difference means removal. The SVG drift entry: the report is closed until it recurs. APPLIED
- DECISIONS.md add: Min Pwr on image layers only; camera and rotary parked; controller strings publishable and no new raw logs committed. APPLIED
- Plan: the Min Pwr relay takes the product ruling as its goal. Release notes carry the wedge and Pause=stop disclosures.
- Still owed, not proposed here: the CHARTER.md text-tool wording (approved 2026-09-25, not yet edited) and the Ctrl+Shift+V DECISIONS entry (at R3's close).
