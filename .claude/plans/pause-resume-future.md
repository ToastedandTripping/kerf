# Plan: a Pause that really pauses (forward plan, documentation only)

**Status.** Forward plan. Nothing here is scheduled and no code changes with it. Written 2026-09-25.
**Ruling behind it.** Lee, 2026-09-25, relayed by the coordinator: "Leave the pause button for now
but ensure we have a plan to make it function in the future." The Pause button stays exactly as it
is today: same label, same place, same behaviour (it stops the job). This plan covers what it would
take to make it hold and resume on Lee's controller.
**Gate before any relay.** A separate critic review of this plan, plus the Lee decisions in §6.
Section 4 cannot start until the first of those decisions is made, because today's rulings
forbid the only evidence that could pass it.

Claim tags: **[S]** source-read (stock GRBL source as traced in DECISIONS/ROADMAP 2026-09-05, or
this tree as read 2026-09-25); **[C]** capture-observed in `scripts/probe-20260914-153729.log`
(line numbers given); **[U]** unverified: either nobody has measured it, or only the owner has
reported it with no instrument.

---

## 1. What the controller and firmware support for hold and resume

**Stock GRBL 1.1 (intent, not proof about this machine).**
- `!` (0x21) is feed hold: the head decelerates along the path, reporting `Hold:1` while it
  slows and `Hold:0` once it has stopped and is ready to resume. [S]
- `~` (0x7E) is cycle start/resume. Both bytes are realtime: they skip the line buffer and act
  even while the planner is full. [S]
- `DISABLE_LASER_DURING_HOLD` is enabled by default. With `$32=1` the firmware raises its own
  spindle-stop override when the hold completes, so the laser is already commanded off before
  the sender does anything. [S] (DECISIONS, "`0x9E` is a TOGGLE…")
- `0x9E` is a toggle, not an off switch. If the override is already up it takes the restore branch,
  prints `[MSG:Restoring spindle]`, and re-energizes the output. The only gate on it is being in
  Hold. [S] (same entry)
- On resume in laser mode, stock restores the modal spindle state as the cycle restarts. Under
  M4 the power scales with head speed, so it comes back from zero. Under M3 it comes back at the
  commanded power while the head is still accelerating from rest. [U] This is recalled from
  stock `protocol.c` and is not cited in DECISIONS. Re-read the source before relying on it.
- Under M4 at zero velocity, stock emits nothing (DECISIONS 2026-09-10, variable-power entry). [S]

**The owner's controller: a vendor GRBL fork** (DECISIONS 2026-09-05: `[VER:1.1f.20220810:]`,
127-block planner, 65536-byte RX buffer). Stock source is evidence about intent here, never proof.
What is actually evidenced:
- `!` produces `Hold:1` and then `Hold:0` about 550 ms after the byte at F300. [C] lines 852-856
- Under M3 S10, the reported spindle value is `FS:0,10` during `Hold:1` and `FS:0,0` at
  `Hold:0`. That is consistent with the firmware's own hold-off. [C] lines 854-856. It is status
  only: it shows what the firmware commanded, not what the beam emitted.
- `0x9E` sent at `Hold:0` answers `[MSG:Restoring spindle]`, and under M3 the reported value
  returns to `FS:0,10` for about 3 s on a parked head. [C] lines 869-872 onward. So the fork has
  the toggle and had the override raised at hold-complete. Whether light came back is [U] by
  instrument. The owner reported the beam relighting on a parked head on 2026-09-02 and
  confirmed `[MSG:Restoring spindle]` on 2026-09-05 (ROADMAP deferral). [U] owner-reported.
- Under M4 the same sequence reports `FS:0,0` throughout, including after the restore. [C]
  lines 916-934. This is the masking effect: M4 hides a re-arm at zero speed.
- **Resume (`~`) has never been sent to this controller under capture.** [C] Neither the capture
  nor the rewritten probe sends it; `hold-m4` ends with a designed reset (`probe-grbl.py` hold
  branch; qualification card §4). Every property of resume on the fork is [U].
- `A:S` is present whenever overrides are reported and absent otherwise, whatever the beam is
  doing (53/53 and 0/69). It is not a beam signal. [C] (Evidence correction 2026-09-25)
- A `0x18` failed to stop the beam once on 2026-09-02 (DECISIONS 2026-09-05, controller
  identity). [U] owner-reported. This matters because stop is the fallback for every failed hold.

## 2. Why Pause falls back to a stop today

1. **The re-arm incident (2026-09-02, diagnosed 2026-09-05).** Pause sent `!`, then polled for
   `Hold:0` for up to 3 s. That poll could never succeed during a job, because the pump held the
   command lock. So the timeout expired and Pause sent `0x9E` anyway. The firmware had already
   darkened the hold, so the toggle relit the beam on a parked head under M3. STOP then failed
   too, and the physical e-stop ended it. The simulator modelled `0x9E` as "off" and did not model
   the firmware's own hold-off, so the defect passed two reviews. (ROADMAP, "Deferred from the
   2026-09-05 pause/stop investigation"; DECISIONS evidence entries of 2026-09-05)
2. **The rulings.** "Pause is hold-only, and becomes stop wherever a dark hold has not been observed
   on hardware" (Lee, 2026-09-10) removed `0x9E` from pause and set stop as the fallback. It
   calls that fallback "effectively permanent for now", combined with the status-only ruling:
   Lee chose status-only evidence over an optical sensor or a camera, and that entry states
   "any claim that the beam went dark is unqualifiable, so hold-only pause cannot be qualified".
   The stop spine (merged 2026-09-22) then routed `pauseJob()` through `emergencyStop()`
   (`jobStream.ts` `pauseJob`; ARCHITECTURE "Pause becomes stop"). [S]
3. **`A:S` cannot rescue it.** The 2026-09-05 fix direction was to send `0x9E` only when `A:S`
   showed the beam still on. The 2026-09-25 correction struck that: on this controller `A:S`
   tracks override reporting, not the beam, and no code may treat it as beam state. [C]
4. **No resume evidence exists.** Even if hold were accepted, nothing has shown what `~` does on
   the fork (§1). [C]

## 3. What would have to change in Kerf

**Code paths (as read 2026-09-25) [S]**
- `src/lib/machine/jobStream.ts` `pauseJob()` stops the job today. Future version: send `!` on
  the realtime handle, then start a bounded hold watch. Stop via `emergencyStop()` if the watch
  times out, if any report during the hold shows a non-zero spindle value, or if
  `[MSG:Restoring spindle]` appears. Keep the job running only on an observed `Hold:0`.
  **Never send `0x9E`**, not even conditionally.
  `resumeJob()` already sends only `~`. It would need three gates first: the same job is still
  admitted, no stop is in flight, and the latest report is `Hold:0`.
- `src/lib/machine/connection.ts` `feedHold()` and `cycleResume()` set `machineState`
  optimistically from the button press. Nothing in production calls `feedHold()` now. The future
  version must drive `machineState` from observed reports. Two existing features block this:
  (a) status polling is off while `jobRunning`; (b) in per-line mode, in-pump reports update
  position only, never state, to avoid a stale `<Hold…>` wedging the loop's pause-wait. The
  watch should read the session snapshot (`serial_get_status` busy path: `?` goes out on the
  realtime handle and the pump publishes the reply with a monotonic epoch/seq). It must reject
  any snapshot older than the `!`.
- `src/components/panels/JobActionBar.tsx` `handlePauseResume` shows PAUSE or RESUME from
  `machineState === "hold"`. The label is untouched per the ruling. Once the state is observed,
  RESUME will appear only on a real `Hold:0`.
- `src-tauri/src/commands/serial_pump.rs`: the buffered pump already stops writing on `Hold` and
  resumes on `Run`/`Idle`. The idle-stall counter resets on any non-Idle state, so a long hold
  is not read as `terminal lost`. Per-line `run_pump` keeps the command lock while it waits for
  the in-flight line's `ok`. A spindle line (M3/M4/M5) parsed during a hold should be
  acknowledged only after resume [U on the fork]. That wait is expected, not a stall.
- `serial_stop` and `serial_session.rs` stay as they are.

**Pins that constrain the design**
- *Abort sends 0x18 immediately* (2026-09-20). STOP during a hold sends `0x18` with no feed hold,
  no M5 and no ack wait. The per-line hold-wait already exits on `jobRunning = false`, and that
  behaviour must survive. The hold watch's own fallback is the same `emergencyStop()`, never a
  line command.
- *Never an ack-awaited write in the abort path* (2026-07-05 pin; still stands). This covers
  every exit of the hold watch.
- *Admission critical section; one stop sends one reset* (2026-09-24). Pause must not take
  `submit` or close admission. It must not write lines during the hold, and it must not add a
  second reset. After a stop, resume is refused: admission is closed and the job id is dead. A
  stray `~` after a reset is harmless on an empty planner, but the button must not offer it.
- *`A:S` is not beam state* (2026-09-25). No pause, hold or resume logic reads `A:` in either
  direction.
- *Status-only evidence* (2026-09-10). Status reports may push Kerf toward a stop (a tripwire).
  They may never certify that the beam is dark.

**Simulator modelling needed (`src-tauri/src/sim/grbl.rs`) [S]**
E5 made the sim model: `0x9E` as a toggle in Hold only; the laser switched off at `!` when
`$32=1`; the `Captured127` sizes and `A:` pattern; the settings table; reject/ignore faults; the
laser-switch wedge. What pause/resume would still need:
1. Report `Hold:1` for a few ticks, then `Hold:0`, instead of a bare `Hold`. Move the laser-off
   from the arrival of `!` to hold-complete, and report `FS` spindle values the way the capture
   shows them.
2. Keep a separate override flag, apart from the modal spindle state. `0x9E` then prints
   `[MSG:Restoring spindle]`, and `~` restores the modal state as the cycle restarts. Today the
   sim leaves the spindle off after resume. That is kinder than stock intent and would hide a
   resume re-arm.
3. Spindle lines parsed in Hold wait for resume instead of tripping the strict-hold invariant,
   so a legitimate mid-job pause is not scored as the F13 deadlock.
4. Faults: a "hold does not darken" profile (the reported `FS` stays non-zero at `Hold:0`) to
   drive the tripwire; the parked "0x18 does not stop the beam" fixture (E5 deferral); the wedge
   landing during a hold.
Sim-green still certifies nothing about the fork (DECISIONS 2026-09-05 simulator entry).

**Probe.** `hold-m4` never sends `~`, and `stop-m4`/`hold-m4` refuse feeds above 600 mm/min
(E2 deferral). A `hold-resume` case, an M3 variant, and a longer segment at job feed each need
their own plan. The qualification card also says it has "no field for beam state… and none may
be added". That line changes only if §6 decision 1 changes the status-only ruling.

## 4. How it would be proven safely on hardware with the beam

**Plain statement.** Status reports cannot show that the beam is dark. `FS:0,0` at `Hold:0` is
the firmware saying what it commanded. So under the current rulings a dark hold cannot be
qualified, whatever the logs say. Qualification needs either evidence Lee has already declined
(an optical sensor or a camera) or an owner-observed procedure that he accepts as evidence. It
also needs an amendment to the status-only entry.

**Staged procedure (only after §6 decision 1 and the new probe case exist)**
0. *Preconditions.* The laser-switch wedge has a captured trigger. The fence hardware test has
   passed. The build is released. Lee is present with the physical stop in reach, wearing eyewear
   rated for the laser's wavelength, with the enclosure closed.
1. *Status-only, output isolated (S0).* Run hold-resume at S0. Record the `Hold:1`→`Hold:0`
   timing and every `[MSG:]` line. Confirm the position reaches the segment target after `~`.
   Proves protocol behaviour only.
2. *Low power, scrap, M4.* Run `hold-m4` and the new hold-resume case at the lowest marking power
   on a witness material: thermal paper or dark card, 3 invocations each. Under M4 a dark
   stationary head is expected whatever the hold logic does. This stage proves the combined
   result, not the firmware's hold-off.
3. *Low power, scrap, M3.* This is the stage that tells the difference, because M3 keeps
   commanded power on a stationary head. It is the mode of the 2026-09-02 relight. Run an M3
   hold with the same dwell as the positive control (below).
4. *Job-feed hold.* Repeat 2-3 at a real job feed on a longer segment (the E2 deferral), then
   run Kerf's own Pause and Resume on a small scrap job.

**What counts as "a dark hold observed".** All of these, on every repetition:
- **A positive control on the same material.** A deliberate stationary burn at the same power
  and dwell visibly marks the witness. Without it, a clean hold point proves nothing: the check
  could not have fired.
- **No mark at the hold point** beyond the path's normal line end, after a dwell of at least
  5 s (the probe's hold window).
- The log shows `Hold:0`, no `[MSG:Restoring spindle]`, and no non-zero spindle value during
  the hold. The log alone never counts.
- For resume: the line continues from the hold point with no extra dot or gap wider than a normal
  line start.

**Evidence options and what each costs** (effort estimates, not priced)
| Option | What it proves | Cost | Weakness |
|---|---|---|---|
| Witness material plus positive control, owner-inspected | Integrated emission above the material's marking threshold, over the whole dwell | Scrap and about an hour per stage; no parts | Blind to emission below the mark threshold; gives no timing |
| Optical sensor, time-correlated with the probe log | Emission versus time, so a relight at 2-3 s would show | Hobby parts plus a few hours to build and sync | Placement and filtering must be right; another thing to trust |
| Enclosed camera with a sync marker | Visible glow on a timeline | A camera plus sync effort | Frame rate and exposure limits; the weakest acceptance (DECISIONS 2026-09-10) |
| Owner watching through rated eyewear | Nothing durable | None | No record; attention-dependent; not recommended alone |

## 5. Risks

- **Worst case: the beam re-arms while the head is stationary.** Constant power lands on one spot
  for as long as the hold lasts: scorch, ignition, a fire in an enclosure the operator has paused
  so that they can walk away. Known routes: `0x9E` (banned); resume restoring M3 power when no
  motion follows [U]; a fork behaviour nobody has seen yet. Status cannot detect light, so this
  risk falls only as far as the §4 evidence reaches.
- **The fallback can fail.** Every hold failure ends in `0x18`, and one `0x18` has already failed
  to stop the beam on this fork (2026-09-02) [U]. Pause adds a second route into that single
  backstop.
- **M4 masking.** A test run under M4 passes whether or not the hold logic works (capture
  916-934). If the qualification skips M3, it certifies nothing about the hold logic.
- **Human factors.** A working Pause invites the operator to open the lid or step away. A
  stop-as-pause at least ends the job for certain.
- **Wedge interaction.** A hold straddling an M4 switch meets an undiagnosed defect whose trigger
  is timing-dependent.
- **Stale or borrowed status.** The re-arm began with a poll that could not see the machine. A
  snapshot older than the `!`, or the `A:` field, must never gate anything.
- **Sim overconfidence.** Green sim tests passed the original defect twice.
- **Position.** A failed hold that falls back to stop loses the job's place. Resuming a stopped
  job from a line is out of scope.

## 6. Decisions this needs from Lee

**Decision 1. What evidence would you accept that the laser stays dark while a job is paused?**
- *Answered 2026-09-25 (Lee, relayed by the coordinator):* the witness-card procedure with a control burn, optical sensor as the step-up (option b here). Written as an amendment to the status-only DECISIONS entry, with its limits. Nothing is scheduled from it; this plan stays parked until Lee schedules it.
- *Today:* Pause stops the job. You chose status-only evidence on 2026-09-10. That ruling says
  "any claim that the beam went dark is unqualifiable", so Pause can never become a real pause
  under it.
- *Tension:* On 2026-09-25 you asked for a plan to make Pause work. The machine's status reports
  say what the firmware commanded, never what the laser did. That gap is exactly how the
  2026-09-02 relight got past two reviews.
- *Options:*
  a. **Keep status-only.** Pause stays a stop indefinitely. Nothing to build and no risk, but
     Pause never works.
  b. **Witness-mark procedure:** low power, scrap card, a deliberate burn beside it as the
     control, you inspect. No parts, about an hour per stage. It misses emission too weak to mark
     and says nothing about timing.
  c. **Optical sensor**, the original recommendation. Small parts cost plus a few hours to build.
     It gives a timeline and catches a delayed relight. It adds hardware to maintain.
  d. **Camera with a sync marker.** Similar effort to (c), weaker proof.
- *Recommendation:* **(b), with (c) added if (b) ever shows a doubtful mark.** It needs no
  parts. The control burn proves that the test could have failed. It stays on scrap at low power.
  If it is wrong, a sub-threshold glow during a hold goes unseen: little energy on one spot, but
  not zero.
- *Reversibility and urgency:* This only amends a ruling, and it can be undone. Nothing is urgent:
  if you do nothing for a month, Pause keeps stopping jobs, which is safe.

**Decision 2. Once qualified, should Pause hold on every job, or only on jobs that use variable
power (M4) throughout?**
- *Today:* New layers default to M4, but projects on disk keep their stored mode. Constant power
  (M3) remains selectable.
- *Tension:* Under M4 a stopped head is dark for two separate reasons (the firmware's hold-off and
  zero speed), so one failure does not relight it. Under M3 only the firmware keeps it dark, and
  M3 is the mode of the 2026-09-02 relight.
- *Options:* (a) **M4-only:** Pause holds on all-M4 jobs and stops any job containing M3. It is
  simpler to qualify, but Pause behaves differently job to job. (b) **All jobs:** this needs the M3
  stage of §4 to pass, which is more scrap and more exposure.
- *Recommendation:* **(a) first.** It has the smaller single-failure risk. The cost of being
  wrong is a Pause that surprises you by stopping an M3 job, which is safe.
- *Reversibility and urgency:* This is a software gate, so it is reversible. It matters only
  after decision 1 is answered with anything other than (a).
