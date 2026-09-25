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

### Variable power (M4) is the default for every new layer; constant power (M3) exists for the stationary beam, not for cutting.
*2026-09-10, Lee*

Constant power was the default for every shipped layer except Engrave, so nearly all cutting ran at M3 without anyone selecting it. M3 holds commanded power regardless of head velocity, so wherever the head decelerates the same energy lands on less travel and the material is overexposed; Lee independently reported the predicted symptom, corners burning harder than the rest of the cut. Fix B1 flipped fill and raster layers to M4 for exactly this reason in an earlier pass and left line layers behind with a comment asserting through-cuts did not need it. M4 also darkens a stationary head, which matters while the pause re-arm and the laser-switch wedge are open. Constant power remains selectable and is still correct where the beam must fire with the head stationary — framing, test fire, setting focus — because M4 at zero velocity emits nothing. Projects already on disk keep their stored mode. Shipped as c8400de.

### The next release keeps the full feature set rather than visibly disabling the unqualified features.
*2026-09-10, Lee*

The remediation plan recommended a restricted envelope — constant-power and Fire, Offset Fill, non-zero kerf and the affected compound ordering shown as unavailable until qualified — on the grounds that explicit refusal removes exposure without putting a new geometry engine on the safety-critical path. Lee chose to preserve every feature instead, accepting a larger program and a longer road to clearing both blockers. The consequence is that the geometry corrections move from refused-at-the-boundary to must-be-fixed-before-release, and plan batch 2.3 must be re-specified from a gate into a set of corrections.

### Pause is hold-only, and becomes stop wherever a dark hold has not been observed on hardware.
*2026-09-10, Lee*

Pause currently sends 0x9E after waiting for a full hold, including when that wait times out, and that byte is the one confirmed to re-arm the beam. The accessory-flag alternative was rejected as the primary because the flag may describe modal enable rather than emitted light, and a toggle sent on stale information restores output. Hold-only removes the known restoring action from the ordinary pause path immediately rather than gating it on a flag whose meaning is still unverified. Explicit fallback: where a resumable dark hold cannot be qualified, pause means stop. Combined with the status-only evidence ruling, that fallback is effectively permanent for now.

### The geometry and topology program is deferred; the region-offset dependency decision stays open and unmade.
*2026-09-10, Lee*

Kerf compensation expands holes without accounting for which side is waste, and Offset Fill closes open paths and discards split regions. Patching the single-ring algorithm in place was rejected as high risk of the next hole, split or collapse defect. Approving a region-offset engine was deferred rather than refused: it is a program of its own, it changes cut dimensions, and it is entirely independent of the live stopping failures, so mixing them slows the part that matters. The standing Gate D2 architect call is unchanged by this and remains open.

### The built-in text tool is in scope; the charter's exclusion of built-in font rendering is amended to allow it.
*2026-09-25, Lee*

The text tool (four bundled fonts, converted to paths at G-code time) shipped in v0.8.29 at Lee's direct request while the charter still listed built-in font rendering as a non-goal and the ROADMAP parked text behind gate D3. Lee resolved the contradiction in favour of the tree rather than removing the feature. The amendment put to him read: built-in text from bundled fonts is in; font management and text-on-path stay out. A drift review must not flag the text tool as a reintroduced exclusion. The CHARTER.md wording itself is changed only in an edit Lee approves, per the charter's own rule.

---

## Engineering pins

### The Phase 2 abort order is safety-critical and must never contain an ack-awaited write
*2026-07-05, reversed 2026-09-22*

safety-critical abort order (`!` → ~100ms settle → realtime `0x18` → conditional M5 —
never an ack-awaited write in between, that recreates the F13 deadlock).

~~The abort sequence ! then ~100ms settle then realtime 0x18 then conditional M5.~~ **Reversed, per Lee, 2026-09-22:** Superseded by Lee's 2026-09-20 ruling (Abort sends 0x18 immediately — no feed hold, no M5, no ack wait). The prohibition on any ack-awaited write in the abort path stands; the hold-first sequence and the M5 do not. Implemented by the Phase 1 stop spine (serial_stop), merged 2026-09-22.

### `$32=1` is hard-gated at job_start and `streamingMode` defaults to `perLine`
*2026-07-05, amended 2026-09-10*

`$32=1` hard-gated at job_start, JobEvents (Progress/Console/Status/Finished) coalesced
50-100ms, `streamingMode` localStorage rollback flag defaulting `perLine`.

> Status — whether Phase 2 has started — is tracked in `ROADMAP.md`, not here. This entry
> records only what was decided.

**Amended, Lee, 2026-09-10:** The `$32=1` half of this entry describes behaviour the code has never had. Verified against the tree 2026-09-10: `gcodeGen.ts:888` is a console warning, not a gate, and it fires only when the job contains a fill or raster layer — so a cut-only job, a Frame, or a material test can run with `$32=0` and no warning at all. The Rust buffered streaming path does gate on it (`serial.rs:552`), but `perLine` is the default and has no gate anywhere. This entry has been asserting a completeness that does not exist, and this session's first remediation plan trusted it and was failed by its critic for doing so. The `streamingMode` defaults to `perLine` half of the entry stands. Making the gate real is plan batches 2.1 and 2.2.

### Every abort routes through one shared stop operation, whose feed hold is conditional on verified laser-off behaviour.
*2026-09-10, Lee, reversed 2026-09-22*

A narrow reorder of the two job-abort sites was rejected: it would have fixed one path and left manual STOP, writer cancellation and completion inconsistent with it, duplicating the stop policy a third time. The plan critic also established that delegating blindly to emergencyStop is unsafe, because that function opens with a feed hold whose laser-off behaviour depends on $32=1, which nothing enforces. So the shared operation skips the hold wherever the darkening behaviour is unverified. The single strongest reason for one shared stop: every abort must remain able to request a reset when the line channel cannot answer, which is exactly the state the known wedge produces.

~~The shared stop operation opens with a feed hold wherever laser-off behaviour under that hold has been verified.~~ **Reversed, per Lee, 2026-09-22:** Superseded by Lee's 2026-09-20 ruling: the shared stop sends 0x18 immediately with no feed hold in any case. The single shared stop operation stands and is serial_stop, which every abort and emergency path now calls.

### START refuses to run until laser mode and power scale are written and read back matching.
*2026-09-10, Lee*

Automatically enabling on START was rejected because it makes pressing start mutate persistent machine configuration, and can fail after the operator has committed to running. A warning with an override was rejected as insufficient for a release. The operator must know that the configuration the job was generated against is the configuration the machine is actually running: a controller that acknowledges a settings write is not a controller that accepted it, and a stale power scale silently multiplies output.

### Minimum power can never exceed commanded power, and the rule is enforced both at generation and at the store's write doors.
*2026-09-10, Razor W4, Lee*

powerMin was editable and completely inert on constant-power layers, so a layer left at power 40 with powerMin 60 was legal on disk. Under variable power the floor at gcode_gen.rs computed s_max.max(s_min) and emitted S600 — fifty per cent above the number in the Power box, on a layer the operator did not knowingly change. The double enforcement looks redundant and is not: the Rust clamp is the authority for what the machine receives, but generation-side enforcement does not travel with a document that a different build may open, and a shipped v0.8.28 has no clamp at all. The store-side clamp stops the invalid pair from ever being written to the file. Do not remove either as duplication. The same defect existed in the grayscale ramp, where an inverted pair also reversed the ramp; both derivations share one helper.

### A project file stamped newer than the running build is refused, never loaded and silently re-stamped downward.
*2026-09-10, Razor W6, Lee*

No build read formatVersion on the way in: every migration gate was false for a future version, which is arithmetic landing correctly rather than a decision, and the stamp was then unconditionally rewritten down to the running build's version. What has kept that survivable is a property nobody had written down — the downgrade is self-limiting because a build stamps to its own version and gates every migration strictly below it, so the only migrations that re-run on return are ones the older build never had. That fails the moment a non-idempotent migration meets a file an older build edited in between, and migrateSpeedToMmMin already multiplies by 60. Refuse outright: not loaded, not stamped, not added to Recent Files.

### Abort sends 0x18 immediately — no feed hold, no M5, no ack wait
*2026-09-20, Lee, per research*

The host-side abort sequence is: send 0x18 (soft reset) as a realtime byte, then clear host state and wait for the reset banner with a bounded timeout. No feed hold (0x21) first — unnecessary delay for lasers, does not guarantee beam-off, and hold-then-reset causes ~10mm position displacement (gnea/grbl #810). No M5 before reset — M5 is a line-protocol command that blocks behind the planner queue while the laser fires; this is the ack-awaited write the standing pin forbids. No waiting for any acknowledgement before sending 0x18 — realtime characters bypass the serial buffer and execute in the ISR regardless of controller state. Retain the 0x18 write-failure retry (the A6 fix). Evidence: GRBL source (mc_reset unconditionally calls spindle_stop at the hardware PWM level), four established senders (LightBurn, LaserGRBL, UGS, bCNC all send 0x18 immediately with no M5), and Kerf hardware testing (0x18 confirmed working on the Falcon for recovery). Research report: ~/marvin/research/grbl-abort-policy-laser-20260920/report.md.

### Job-line admission and its write are one critical section shared with the stop's admission close; one stop sends one reset and nothing re-sends it.
*2026-09-24, Lee*

Job-line admission and the job-line write are one critical section: a writer takes the `submit` lock, checks admission, writes the line with one `write_all`, and releases it; the stop takes the same lock to close admission (`close_admission` requires the held guard), releases it, and only then sends its single `0x18`. The flush (`tcdrain`), the drain and the response wait stay outside the lock. The earlier design detected a line that slipped in after the reset and sent a second `0x18` to repair it; Lee rejected that as designing around the race, and this makes the race impossible instead. The bound: the stop waits for at most one `write(2)` after `POLLOUT`, which is at most the 1000 ms port timeout and in practice microseconds. The premise: both serial handles are dup'd file descriptors of one tty (serialport `try_clone` is `F_DUPFD_CLOEXEC`), so they share one output queue, and job lines are small. It never waits on the controller, an acknowledgement, or transmission. This does not breach the 2026-09-20 ruling that abort sends 0x18 immediately: the reset could not reach the wire any sooner than line bytes already in the queue ahead of it, so the lock only fixes which side of the reset a line falls on. Removing the lock, narrowing it to a barrier, or reintroducing a second reset reopens the laser-after-STOP race. Relay kerf-fence-single-reset, plan .claude/plans/fence-single-reset.md.

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

### Hardware evidence for this program is status-only; optical shutdown cannot be qualified, and powered release stays blocked on that basis.
*2026-09-10, Lee*

A time-correlated optical sensor was recommended and an enclosed camera with a synchronised marker offered as a weaker fallback with an explicitly limited acceptance criterion. Lee chose status-only. The consequence is stated rather than hidden: a status report says what the software commanded and never what the beam emitted, and that gap is precisely what let two reviews pass a defect that re-arms the laser. Most of the program is unaffected — the wedge trigger comes off a serial trace, and Phases 0 through 2 close on tests — but any claim that the beam went dark is unqualifiable, so hold-only pause cannot be qualified and powered release stays blocked. If measurement never becomes available, the honest cost is a release that stays blocked, not confidence that was invented.

### The laser-switch wedge requires a captured trigger and a prevention before release; a quiet run is not closure.
*2026-09-10, Lee*

Accepting containment on a restricted workflow was available and was rejected; shipping after a short non-reproduction was rejected outright. The defect has already demonstrated it can hit the same spot twice and then vanish for a whole run, so a session that sees nothing cannot distinguish a fixed intermittent failure from one that did not occur that day. Containment remains a possible fallback but must never be reported as the wedge being fixed, and taking it would require expressly redefining the blocker and stating the limitation to the operator.

### The owner's laser controller switches the air-assist pump, so Air Assist stays and must actually drive it.
*2026-09-25, Lee*

Asked whether the Air Assist switch should be removed because nothing might be listening to it, Lee stated as fact that his controller does switch the air pump. So the control is not decorative on this machine: removing it is refused, and any gap between the switch and the command the controller receives is a defect to fix, not a reason to drop the feature. Recorded because a future audit that finds the switch weakly wired could otherwise propose deleting it.

---

## Evidence corrections

### The SVG path-coordinate drift is not an import/transform defect — that code was audited clean
*2026-06-21*

Import/transform code audited clean; needs a sample Inkscape SVG from Lee to reproduce.
Carried across all three prior hand-offs with no progress. Do not re-derive an
import/transform theory without a reproducing file.

### `0x9E` is a TOGGLE and GRBL already stops the laser itself at hold-complete — Kerf's pause volley re-arms the beam
*2026-09-05, amended 2026-09-25*

Traced to gnea/grbl source and confirmed on the owner's hardware 2026-09-05. `DISABLE_LASER_DURING_HOLD` is default-enabled in stock GRBL 1.1: with `$32=1` the firmware raises its OWN spindle-stop override the moment a feed hold completes, so the laser is already off before Kerf acts. `0x9E` is `EXEC_SPINDLE_OVR_STOP`, a toggle — arriving with the override already up it takes the `SPINDLE_STOP_OVR_RESTORE` branch, emits `[MSG:Restoring spindle]`, and re-energizes the beam. The v0.8.28 `Hold:0` poll (62c7c36) cannot mitigate this: `serial_get_status` `try_lock`s the command lock that the pump holds for the whole job, so the poll always returns the empty sentinel, times out at 3s, and fires the toggle anyway. That commit's premise — "GRBL ignores 0x9E during Hold:1" — is not what the source says; the only gate is `sys.state == STATE_HOLD`. Do not re-derive a fix that sends `0x9E` unconditionally on pause. The correct signal is the `A:` accessory field of the status report (`A:S` = spindle energized): send the byte only if the beam is still on after hold-complete.

**Amended, per coordinator (delegated), 2026-09-25:** The sentence ~~The correct signal is the `A:` accessory field of the status report (`A:S` = spindle energized): send the byte only if the beam is still on after hold-complete.~~ is struck. On the owner's controller `A:S` tracks the presence of override values, not the beam (53/53 with overrides incl. Idle after an acked `M5`; 69/69 without, incl. Run mid-cut). See Evidence corrections, 2026-09-25: "The `A:S` accessory flag does not report whether the beam is on". The rest of this entry (the `0x9E` toggle, `DISABLE_LASER_DURING_HOLD`, never send `0x9E` unconditionally on pause) stands.

### The GRBL simulator models `0x9E` as unconditional off and has no automatic laser-off at hold — its pause tests certify a protocol the hardware does not run
*2026-09-05*

`src-tauri/src/sim/grbl.rs` clears `spindle_on` when `0x9E` arrives in Hold, and never sets it in the first place at hold-complete. Both are wrong against stock GRBL 1.1. Consequently the whole green pause-volley suite (`pause_volley_hold_then_0x9e_clears_spindle_resume_keeps_it_off` and siblings) asserts a behaviour the real controller does not have, and it passed the beam-re-arm defect through two reviews. The TS side has the same hole from the other end: the v0.8.28 test mocks `getStatusReport`, so it never meets the command lock that makes the poll useless in production. Treat sim-green on any spindle/hold path as unproven until the simulator models the toggle and the firmware's own hold-off, and until the TS test exercises the real lock.

### `powerMin` reaches no G-code on any vector path in either power mode; the real minimum-power control is `$31`, which Kerf never touches.
*2026-09-10, Razor, traced*

In gcode_gen.rs, s_min has exactly one consumer, s_max.max(s_min). ScanLineParams has no s_min field at all, and FillParams.s_min is hardcoded 0.0 at every non-test call site. With the W4 clamp in place effective_s_max equals s_max unconditionally, so powerMin affects nothing generated for line, fill, offsetFill or fillLine, under M3 or M4 — constant power already used bare s_max. It is live only for image raster, through the grayscale ramp. The UI nevertheless presents Min Pwr as a working setting with a live cap. GRBL's actual minimum-power control under dynamic scaling is $31, which appears nowhere in src/. This matters beyond tidiness: it removes the assumed remedy for M4 under-powering short segments, so a non-zero default is not a one-line change — it needs $31 or per-move S.

### The `A:S` accessory flag does not report whether the beam is on; nothing may treat it as beam-on or beam-off.
*2026-09-25, per coordinator (delegated under Lee's 2026-09-25 technical delegation)*

On the owner's controller, `A:S` was present on every status report that carried override values (53 of 53 in the 2026-09-14 capture), including Idle reports after an acknowledged `M5` (capture lines 70 and 83). It was absent on every report without override values (69 of 69), including 10 Run reports mid-cut with a non-zero spindle speed in `FS:`. It therefore cannot be read as beam-on or beam-off on this controller. **Consequence:** no Kerf code may treat `A:S` (or its absence) as a beam-state signal. That includes any pause, hold, resume, stop or beam-safety logic, and the simulator's `A:` field, which models this observed pattern, not a beam state. This corrects the 2026-09-05 entry on `0x9E`. Evidence, re-countable: `scripts/probe-20260914-153729.log` (captured 2026-09-14), counted 2026-09-25 with `python3 -c "import re;t=open('scripts/probe-20260914-153729.log').read();r=re.findall(r'<[A-Za-z:0-9]+\|[^>]*>',t);ov=[x for x in r if '|Ov:' in x];nv=[x for x in r if '|Ov:' not in x];print(len(ov),sum(bool(re.search(r'\|A:[A-Z]*S',x)) for x in ov),len(nv),sum('|A:' in x for x in nv))"`, which prints `53 53 69 0` (122 status reports total).
