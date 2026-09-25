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

- **OWNER HARDWARE TEST — superseded card, Part 0 first.** The test card artifact (https://claude.ai/code/artifact/f1df614c-7007-4609-afb6-a898aab06de1) was revised 2026-09-05: the investigation sits at the top and a new Part 0 (7 probe steps) runs before everything else. Steps 6, 7 and 20 (pause/resume, stop) are marked superseded and excluded from the progress count. `docs/test-card.md` in-repo has NOT been updated to match — do that when the pause path is rebuilt.

- **Phase 2A A/B test (gate D1c) is deferred behind both defects** and its premise is now in question: this controller reports a 127-block planner and 65536-byte RX buffer (`[OPT:VHL,127,65536]`), so per-line streaming may already keep it fed. Record that in the A/B result before buffered is considered for default.

- **OWED BY LEE: the scrap comparison cut (M4 default validation).** Cut a sharp-cornered square AND a perforated line on scrap at unchanged settings, then compare against a part cut on the previous build. Confirm `$32=1` first — at `$32=0` the controller treats M4 as M3 and the comparison is meaningless. This answers three questions at once: whether the corner over-burn was M3 (Lee reported the symptom independently), whether M4 under-powers short segments (Razor: a 1mm perforation dash reaches ~61% peak, ~40% mean at the app's 300 mm/s² fallback), and whether the new default is safe to keep. Nothing in the tree has ever emitted M4 for a vector line layer, so the first physical cut on the new default is unverified.

- **Batch 2.3 must be re-specified before anyone implements it.** It was written to enforce a RESTRICTED release envelope; Lee chose the full feature set, so its refusals have to become actual corrections (R8, R13, R18, R19). It will likely split into three or four batches. The M4 default flip already pre-empts part of R8.

- **Charter gap analysis at `.claude/plans/charter-gap-analysis.md`** — 293-line Fable audit of all 10 codebase areas vs the charter. None of the three 'done' conditions are met. Top gaps ranked. The fastest path to 'done' follows the existing remediation plan order.

- **Two owner-reported regressions (Lee, 2026-09-24) parked, need console text from a recurrence:** the first-Start-of-session bug (fixed v0.8.18) is back, surfacing as a disconnect; disconnect/reconnect often hangs. ROADMAP Parking Lot → `### Deferred from kerf-fence-single-reset (2026-09-24)`. The first touches charter gate 1.

- **One DECISIONS proposal owed to Lee:** Ctrl+Shift+V = Flip Vertical, Alt+V = Paste in Place (Lee ruled 2026-09-22; entry wording in the editing plan's F3 implementer note; propose at that relay's close). The single-reset fence pin was approved and written 2026-09-24.

- **Laser-switch wedge still open (hardware-confirmed 2026-09-05).** Intermittently the controller stops acking line commands after an M3/M4 while still answering ? with Idle, until 0x18. Record and fix direction: ROADMAP.md → ### Deferred from the 2026-09-05 pause/stop investigation. The other half of the old RELEASE BLOCKED item is fixed: d046bad removed the blind 0x9E and 6e1f507 made pause stop the job.

- **Phase 2A buffered streaming is merged (0a83e69), opt-in behind streamingMode (default perLine).** Only the owner A/B test (gate D1c) remains; see the Phase 2A A/B bullet.

- **Fence single-reset is on master (caa0dcc, 2026-09-24) and in no build.** The owner 4-step hardware test in ROADMAP next is still owed; whether and when a build is cut is Lee's call.

- **Charter text-tool amendment approved by Lee 2026-09-25 (DECISIONS, Product rulings); CHARTER.md wording not yet edited.** The Non-goals sentence and the fonts drift tripwire still name built-in font rendering as excluded. The edit is Lee-approved content only.

- **Three relays implemented, awaiting Stage 2 (Razor) — none merged.** Each is on its own branch/worktree under ~/.local/share/marvin/worktrees/kerf/, state in ~/marvin/state/relay/<id>-pack.json (`next_action` says what is left): (1) `kerf-refresh-cut-vs-screen` (R1, 8 commits F1-F7, 882 JS, battery 19/19) — Razor, then behavioral + Jen fidelity vs the jen-spec, then Stage 3.5 (7 Deferrals lines, owner-test steps into ROADMAP next, ARCHITECTURE delta); R2 canvas-display and R3 editing-shortcuts follow it in order. (2) `kerf-evidence-e1a` (Fill+Line sharp rectangle, 09935e4, 847 JS, battery 10/10) — Razor, Stage 3.5. (3) `kerf-safety-s1` (four-door admission, readback-only laser flag, 859 JS, battery 18/18) — Razor must check the modified existing test machineJobLoop.test.tsx:468 is not weakened; Jen CONCERN pass; S1 and S3 ship in the same build.

- **Lifted plans without a critic yet:** `.claude/plans/kerf-evidence-e2.md`, `-e3.md`, `-e5.md` (committed b7b7540). Each needs a Fable critic (reviewer valve reads `fable`) before its relay. E3 is also blocked on Lee's answer (open questions). S1b (buffered START checks, not writes, $32) is next in the safety chain after S1 merges; not yet lifted.

## Open questions awaiting Lee

| Question                                                                                            | Why it matters                                                                        | Raised     |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------- |
| ~~Is the laser repaired and back in service?~~ **Confirmed 2026-08-27**                             | Constraint lifted. Hardware test and Phase 2 unblocked.                               | 2026-07-10 |
| Can you provide a sample Inkscape SVG that reproduces the path-coordinate drift?                    | Bug can't be fixed without a repro; the import code has been audited clean otherwise  | 2026-06-21 |
| Clipper2 dependency decision for Phase 4 (offsetFill compound correctness, kerf-offset-on-fillLine) (resolved 2026-09-10) | Gate D2 — changes real cut geometry output, needs your sign-off before Phase 4 starts | 2026-07-05 |
| v0.9 Camera & Rotary — do you have/plan to get the hardware?                                        | Gate D4 — the feature stays parked with no planning until confirmed                   | 2026-07-05 |
| streamingMode default: flip `perLine`→`buffered` after session #1's A/B?                            | Gate D1c — the rule is recorded in `DECISIONS.md`; you may override                   | 2026-07-05 |
| Given the controller's 127-block planner, is Phase 2A buffered streaming still worth shipping on this machine? | Phase 2A was built to cure stutter caused by stock GRBL's 15-block planner. This vendor fork has 127. The A/B test may show no difference, which would make gate D1c a decision to keep perLine permanently. | 2026-09-05 |
| Amend the charter to include the text tool? One line: 'built-in text from bundled fonts is in; font management and text-on-path stay out.' (resolved 2026-09-25) | The tree contradicts its own founding document. The ROADMAP parks text behind gate D3 (v1.0), which was skipped rather than opened. | 2026-09-19 |
| Clipper2 dependency for Phase 4 (gate D2) is STILL OPEN. The row above marked resolved 2026-09-10 is wrong: DECISIONS 2026-09-10 deferred it and says Gate D2 remains open. | Gate D2 — changes real cut geometry output, needs your sign-off before Phase 4 starts | 2026-07-05 |
| Should the 'laser stopped firing' warning report during jobs, reworded to say only what the controller reported (spindle speed 0 while Run) and naming the last line sent, knowing it will appear on ordinary M4 cuts? Today it can never fire during a job: status polling is paused while a job runs (connection.ts:372). On your controller the condition appears on normal M4 cuts (probe capture, all five reps). Options: (a) yes, status-only wording, fed from the three job status paths (recommended: it is the only in-job evidence the status-only ruling allows); (b) keep it off during jobs and drop E3; (c) only when the drop persists for N reports. Reversible. If ignored, E3 stays parked; nothing else waits on it. | Plan kerf-evidence-e3 cannot run until this is chosen; the parent plan assumed a check that is dead code during jobs | 2026-09-25 |
| Correct the 2026-09-05 evidence entry that says A:S means the spindle is energised? In the committed capture every status report carrying override values also carries A:S, including Idle reports after an acknowledged M5 (log lines 70, 83), so on your controller A:S does not mean the beam is on. Options: (a) amend the entry with that evidence (recommended: it stops a future fix from keying the pause/beam logic off A:S); (b) leave it until a live session confirms. Reversible (append-and-amend). If ignored, E5's simulator models both readings, labelled. | DECISIONS is the one place a future pause/beam fix will read; an evidence entry the capture contradicts is a trap | 2026-09-25 |
| REPLACES the spindle-drop row above, which priced option (a) wrong. During jobs, should Kerf record each moment the controller reports laser power at zero, and how loudly? Today the check can never print during a job, so the 14 Sept laser-dark incidents left no console data. Kerf itself sets power to zero at every engraving line end and every move between shapes, so drops are the normal rhythm: a yellow warning each time could reach several hundred lines on a long raster. Options: (A) yellow warning per drop: noisy, buries Connection lost and alarms; (B) grey line per drop with time and last line sent, plus one end-of-job tally such as 3 of 41 reports showed zero, including 0 of N (recommended: keeps a line beside the moment you press STOP and a summary that survives the job, without making yellow meaningless; cost if wrong is grey clutter, one revert); (C) tally only: quietest, loses the line near an incident; (D) keep it out of jobs: next incident again has no data. None of these can prove the beam fired. Fully reversible; nothing else waits on it, but any laser-dark incident before you answer arrives with no data. Full brief: .claude/plans/kerf-evidence-e3.md, Decision needed before Stage 1. | Plan kerf-evidence-e3 cannot start until chosen. The earlier row said (a) would warn on some lines; the round-1 critic showed it fires at every scan-line turnaround. | 2026-09-25 |

---

## Log (newest first)

### 2026-09-25 (gap pass resumed: Razor on three relays, E2/E3/E5 critics)

Stage 2 Razor on the three held relays. S1: WARNING 0C/3W (in-flight write race, un-normalized write classifier, every $$ re-parsing the bed size); fixed (acd7fae, 3634ac0), re-check CLOSED; W3 ruled by the orchestrator: full settings parse only on connect/requery. E1a: CRITICAL - a rotated sharp Fill+Line rectangle lowered to fill would burn up to 6.7 mm outside its cut line (Razor measured through the Rust engine); fix in progress, ruled: lower to maskFill. R1: WARNING 0C/4W; missing F5 tests added (cd9bbb0), re-check CLOSED; rotated text/image off-box and flip-lost-on-move are pre-existing canvas defects routed to R2. Critics: E2 CONCERN folded (plus orchestrator addendum: unreadable work offset refuses), E5 CONCERN folded (sim can ack-without-apply), E3 FAIL then round 2 CONCERN, decision repriced (new question row). Next: S1 behavioral + Jen + merge; E1a re-check; R1 behavioral + Jen + merge.

### 2026-09-25 (gap pass: three relays implemented, plans lifted)

Driven session kerf-gap. R0 done (2579bb1, e48dfac; Lee approved the hand-off/DECISIONS writer after the classifier blocked it). Relays through Stage 1, not reviewed or merged: kerf-refresh-cut-vs-screen (R1), kerf-evidence-e1a, kerf-safety-s1 — all DONE (R1 and S1 with observational concerns recorded in their packs), tests re-run by the orchestrator (882 / 847 / 859 JS), batteries all killed. Lifted with Fable critics: kerf-safety-s1 (round 1 FAIL: a second laser-mode setter in GrblSettingsDialog; round 2 CONCERN, folded), kerf-evidence-e1a (round 1 FAIL on verifiability, round 2 PASS). Lifted without critic: evidence E2, E3, E5 (b7b7540); the lift found the parent's E3 detector cannot fire during a job and that A:S appears on Idle reports in the capture. Stopped at Lee's request for a window restart; no new stages started. The coordinator was briefly unreachable mid-session and has the override line.

Next: Stage 2 Razor on the three relays (packs' next_action), then Fable critics on E2/E3/E5.

### 2026-09-25 — state reconciliation (R0)

Driven session kerf-gap, plan gap-2026-09-24/kerf/PLAN-refresh-sequence.md batch R0. Plan inventory checked: 25 files + archive/ (3, from 259fa20) in the primary's .claude/plans, 9 in the audit dir; no new/changed plan, nothing overlapping. Restored and force-added kerf-relay-plan.md, kerf-relay-plan-critic.md (from the primary, untracked) and charter-gap-analysis.md (from worktree salvage session-1b2844); identity grep found only the already-public [OPT:] line in charter-gap-analysis.md:151 (the other hits are the $I command name and DXF $INSUNITS). Removed five stale owed items (limits post-ship PASS, Phase 2A implemented, the RELEASE BLOCKED pair, the unread astra audits, fence single-reset) and replaced their still-true halves; replaced the charter-amendment owed item after Lee approved it 2026-09-25. Clipper2 row: the (resolved 2026-09-10) mark is wrong, a correcting row was added (the writer cannot edit or delete a row). Recorded Lee's two 2026-09-25 rulings (text tool; air pump is controller-switched) in DECISIONS. Fixed ROADMAP current: and the missing hardening-program pointer, and ARCHITECTURE's stop-result golden line. Next: relay kerf-refresh-cut-vs-screen.

### 2026-09-24 (fence single-reset)

**Lee rejected the fence-reopen relay's second reset as designing around the race.** Plan `fence-single-reset` (Fable critic r1: approve with changes, all folded) replaced it with a `submit` lock around admission check + one `write(2)`; both serial handles are dup'd fds of one tty (serialport `try_clone` = `F_DUPFD_CLOEXEC`), so a line enqueued before admission closes precedes the stop's single 0x18. Relay `kerf-fence-single-reset`: Ted DONE (10 files, +578/-800), Razor WARNING W1 (a take-and-drop barrier in the stop passed every test), Ted fix f785143 (`close_admission` requires the held guard + cfg(test) held-lock assertion; X2 replays killed), Razor re-check PASS. Also fixed: the `$32=1` pump now publishes the reset banner it consumes. Merged into the session branch as fd311af. Lee reported two regressions mid-relay (first-Start disconnect back; disconnect/reconnect hangs); parked with leads.

### 2026-09-24 (fence relay close)

**Relay `kerf-fence-reopen` resumed at Stage 2 and closed.** Fresh Razor (the paused one had written only its gates section): PASS, 0C/0W/4N. Razor judged Ted's three flagged mutants by removing the earlier-firing assertions and re-running: R3 and R6 are killed by the plan-named assertion; T1 refused-branch is not (the plan named its assertions before refusals stopped mapping to disconnected) but is killed by T2 `endState` and five others, ruled killed. Gate re-run in the relay worktree: all green. Merged into `marvin/session-8b2728` as 66c950a; the one conflict was ROADMAP `next` (relay side taken, both Parking Lots kept). Ledger status `merged`; pack stamped for ingest.

### 2026-09-24

**Session 8b2728: code refresh, Phase 1 merged, CI green, fence gap found, four relay plans.**

Whole-repo code refresh (report `.refresh/2026-09-22.md`, gitignored). Found master CI red 13 runs since 2026-09-11 on Prettier, which skipped every Rust CI step (cargo test, clippy, fmt, golden guard) for 11 days. Found the Phase 1 stop spine (batches 1.1-1.5, each Razor PASS) stranded unmerged on relay branches; per Lee, merged it (6e1f507). Formatted the tree (301ff47), added a pre-commit format check (67115ca), a clippy fix for Rust 1.98 (229398f); master fast-forwarded and pushed at 229398f, CI green end to end. Bucket A cleanups: PDF constructPath tests, dither characterization tests, pointsBBox at two sites, dead snap branch, six un-exports, keepAwake comments. ARCHITECTURE.md reconciled with the tree (b7f4c41). Per Lee, struck the 2026-07-05 and 2026-09-10 abort rulings as superseded by 2026-09-20 (c08527d).

The Relay B and Phase B owed items are discharged: Relay B shipped in v0.8.30 and its branch is an ancestor of master; the Phase B stack is merged.

Audit found ~25 real defects (5 readers + cross-cut; 91 findings). Machine-side ones went to the remediation PLAN.md addendum as RF-1..RF-16 (marvin cad6bd45, 9404236c), including RF-15: the admission fence was never wired to production. Lee: fix it next. Fence plan passed 3 critic rounds (each round found a real defect: TOCTOU permit check, STOP disabled on resend failure, STOP re-arm never taking effect); Ted implemented it; Razor was paused at Lee's request. Three bug-group relay plans are final (cut-vs-screen found two more cut defects in planning: flipped/rotated text cut wrong, layer reorder and its undo move grouped parts to the wrong layer).

Next: resume the fence relay at Stage 2 (Razor), then cut-vs-screen, canvas, editing.

### 2026-09-22

**B4 Razor PASS — Phase B stop spine complete.** B4 (shared abort/disconnect + pause containment): Razor PASS, 0 CRITICAL, 0 WARNING, 4 NOTE (stale comments only). 11/11 spec items covered. emergencyStop calls serial_stop (0x18 immediately), both abort sites in jobStream.ts route through it, Hold:0 poll deleted, pause becomes stop. All four CRITICAL checks confirmed: no M5 in any abort path, no 0x21/feedHold, no 0x9E on pause, serial_stop is the sole stop mechanism. Combined across Phase B: B1 Razor PASS (2W fixed), B2a Razor PASS (1W fixed), B2b Razor PASS (1C+2W fixed), B3 Razor PASS (1C+2W fixed), B4 Razor PASS (0 findings). The 0x18 abort patch is implemented, reviewed, and ready for merge + owner hardware verification.

**Phase B stop spine — 4 relay batches.** B1 Razor PASS (2W fixed). B2a Razor PASS (1W fixed). B2b Razor PASS (1C fixed — serde case mismatch). B3 Razor PASS (1C fixed — stop deadlock). B4 Ted DONE, Razor NOT yet run (session quota 97%). All abort sites rewritten: 0x18 immediately, no M5, no hold, pause becomes stop. Next: B4 Razor review.

### 2026-09-20

**Session 1b2844 continued: v0.8.30 released, Phase 0 complete, abort policy decided.**

v0.8.30 tagged and released (CI green after two clippy fixes for Rust 1.98 on CI): engrave efficiency Relays A+B (pixel compression, modal hoist, overscan floor, layer warning, rapid gap traversal). 764 JS + 251 Rust tests.

Remediation Phase 0 complete — both harness batches done:
- Batch 0.1 (Rust): four command bodies extracted (serial_connect_inner, serial_send_inner, serial_get_status_inner, serial_stream_job_inner), ScriptedPort infrastructure, three invariant pins (PumpFlight, try_lock, $32=1 gate). Razor PASS.
- Batch 0.2 (TS): unified ordered recorder, STOP dispatch test (0x21→0x18 byte order through real production code), it.fails cross-job corruption (R4/R11), deferred-callback seam. Razor PASS.
260 Rust + 768 JS tests (767 pass + 1 expected fail).

Cross-object scan merging parked in ROADMAP — owner-reported: duplicated engrave pieces generate separate raster passes instead of one continuous sweep.

Abort policy research (scan tier, 13 sources): send 0x18 immediately, no feed hold, no M5, no ack wait. Decision recorded in DECISIONS.md. Phase 1 batches 1.1 and 1.5 unblocked.

Owner hardware photos: v0.8.30 engrave quality confirmed good on birch plywood SSC signs.

Next: Phase 1 batch 1.1 (backend admission fence + reset submission). Pause policy decision needed for batch 1.5 but can be deferred until 1.1-1.4 are done.

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
