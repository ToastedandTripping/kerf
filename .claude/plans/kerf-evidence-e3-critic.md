# Critic — Kerf evidence E3 (`kerf-evidence-e3.md`)

**Date:** 2026-09-25. **Critic:** Fable, separate subagent (the author cannot self-certify). **Rubric:** `~/marvin/rules/plan-critic-rubric.md` v2, read in full. **Tree read:** worktree `kerf-gap` at `10be8a2` (`git diff --stat caa0dcc HEAD -- src src-tauri` is empty, so every code citation is against the tree the plan cites at `a6ddc3a`). Branch `relay/kerf-safety-s1` read for the overlap claims (merge-base `a6ddc3a`). Read-only: no build, test, install or git state change. **Also read:** parent `PLAN-silent-drop-and-evidence.md` (§E3, Verification, Risks, Critic fold) and its critic; `.claude/DECISIONS.md` in full (25 entries); `CHARTER.md`; sibling critic `kerf-evidence-e1a-critic.md` for format; `scripts/probe-20260914-153729.log` at every line the plan cites; `~/marvin/scripts/mutation-battery.mjs` `:1549-1560`, `:1770-1779`.

**Scope note from the caller.** The plan ends in a decision for Lee (whether the spindle-drop line should report during jobs). This review covers the plan as written, whether each option is described correctly, and whether the plan is implementable under its recommended option (a). The decision framing is reviewed under X3, because the brief is a factual claim meant to inform a decision and is the thing Lee will actually act on.

## Applicability block

**Project type:** desktop laser-cutter controller; this batch is the host-side status path (`connection.ts`, `jobStream.ts`), a new pure module, and two vitest files. Standard tier, 5 files, one root. Public repository. The batch also carries a decision brief.

| Dim | Fires? | Tag | Why |
|---|---|---|---|
| X1 Physical & human safety | **Yes** | **GATING** | The change adds code inside `send()`'s response loop, which is the per-line job path, and inside the drain poll. Nothing it adds sends a byte, but a defect there can end a job through the stop. |
| X2 Privacy & data stewardship | No | — | No personal, health, child or client data. |
| X3 Evidence & source integrity | **Yes** | **GATING** | The batch is an evidence instrument (its console line is what the next "laser stopped" report will carry), and the plan ends in a decision brief whose cost and benefit statements are factual claims Lee decides on. |
| X4 Audience, brand & money | No | — | No client- or public-facing output; the console line is operator-facing and covered by X3. |
| X5 Concurrency & re-entrancy | Yes | ADVISORY | Module state (`prevSpindleSpeed`, the last-sent record) fed from three paths; a job is long-running. |
| X6 Operability & observability | Yes | ADVISORY | The console line is the only field evidence the batch produces, and the console is where ALARM and disconnect lines also land. |
| X7 Self-modification safety | No | — | No MARVIN gate, hook, skill or automation changes; the battery is used as it stands. |
| X8 Dependencies, performance & cost | No | — | No package or service; one regex per status report, which already arrives at most a few times a second. |

## Citations verified against the tree

| # | Plan claim | Tree | Verdict |
|---|---|---|---|
| 1 | Check lives in `pollStatus` (`connection.ts:395-416`) | block `:392-417` (`if (accepted && outcome.snapshot)` at `:395`), `pollStatus` at `:362` | ✓ |
| 2 | `pollStatus` returns early on `jobPollingSuspended` (`:372`); `connect()` wires it to `jobRunning` (`:173-175`) | `:372` `if (jobPollingSuspended) return;`; subscribe at `:173-175` with the comment at `:170-172` | ✓ |
| 3 | `jobRunning` set true at `JobActionBar.tsx:80`, `:167`, `MaterialTestDialog.tsx:413`, `:445`; no other door | `grep -rn "setJobRunning(true)" src` (non-test) hits exactly those four | ✓ |
| 4 | Stays true through draining (`jobSession.ts:113-178`) | `drain` at `:123-181`; `jobRunning` is released by `session.end`, called after drain (`jobStream.ts:299` buffered, `:436` per-line) | ✓ (span imprecise by a few lines) |
| 5 | In-pump reports in `send()` used for position only (`:295-322`) | `:295-301` collects the latest `<…>` into `lastStatusReport`, `:312-322` position only, comment `:309-311` | ✓ |
| 6 | Buffered `status` events position-only (`jobStream.ts:177-189`) | `:177-189` | ✓ |
| 7 | Drain polls `getStatusReport()` (`jobSession.ts:136`, `:156`; `connection.ts:356-360`), raw string, checks nothing | `:136`, `:156`; `getStatusReport` `:356-360` surfaces events and returns `outcome.status` | ✓. `getStatusReport` has no other production caller (`grep -rn getStatusReport src`, non-test: the definition and the two drain sites). |
| 8 | Tests drive `pollStatus` without `connect()` (`connection.test.ts:117-148`) | `describe("pollStatus — status regex")` at `:117`; no test file calls `.connect(` (grep over `__tests__`) | ✓ |
| 9 | Capture: `<Run\|MPos:20.000,-37.650,…\|FS:0,0>` at `:216`, `-20.038` at `:218`, inside `ring_M4_wait_idle_before_switch`; repeats at `:370`, `:522`, `:676`, `:830` | `:216`, `:218` exact; variant headers at `:192/:346/:498/:652/:806`, each drop line inside its rep; `:214` is `FS:7657,6` (prev > 0), so the plan's condition would fire on `:216`. All four G1 lines of the ring were acked by `:207` before the first `?`, so "the last G1 is executing" is consistent with `MPos` moving from `-37.65` toward `-20` | ✓ |
| 10 | Store holds only `jobProgress`, a fraction (`storeTypes.ts:183`) | `:183 jobProgress: number` | ✓ |
| 11 | Per-line loop has `lines[i]` (`jobStream.ts:352`); filter at `:326` does not trim before the `;` test | `:352`; `:326` `filter((l) => l.trim() && !l.startsWith(";"))` | ✓ |
| 12 | Buffered `lineIndex` from throttled progress events (`:161-166`; throttle 50 ms `serial_pump.rs:440-447`); Rust filter trims then drops empty and `;` (`serial.rs:826-830`) | `:161-166`; `progress_throttle_ms: 50` at `:446`; `serial.rs:825-830` | ✓ — and the throttle emits the **final** line unconditionally (`serial_pump.rs:617-619`, `\|\| send_cursor == lines.len() - 1`), so the record can lag by up to 50 ms of lines mid-job and is exact at the end. The plan does not say this. |
| 13 | `prevSpindleSpeed` module state (`:78`), reset only on connect (`:136`), comment `:75-77` stale | `:78`; `:136`; `:75-77` says "retained for the send() in-pump position-only path", which never reads it | ✓ |
| 14 | `grep -rn "stopped firing" src` → `connection.ts:408,411` only | exact | ✓ |
| 15 | `_testResetPollFailures` at `:784` | `:784` | ✓ |
| 16 | S1 inserts ~130 lines after `let prevSpindleSpeed` (hunk at `:82`) | hunk is `@@ -84,0 +85,130 @@`: after `:84`, the blank following `connectingPromise` (`:83`), six lines below `prevSpindleSpeed` | ~ (two lines off; the "do not edit `:75-81`" rule still holds, but see core 10) |
| 17 | S1 adds two statements before `send()`'s `invoke` (`:289-292`) and one after the position block (`:320`) | `@@ -289,0 +420,5 @@` (five lines before `:292`) and `@@ -322,0 +458 @@` (one line after `:322`) | ✓ (E3's edit at `:296-300` sits between them with 7 and 22 lines of clearance) |
| 18 | S1 changes `connection.test.ts` import block (`:8-14`) and appends after `:712` | `@@ -11 +11 @@` (one import line) and `@@ -714,0 +715,130 @@` | ✓ |
| 19 | S1 touches no `jobStream.ts` / `jobStream.test.ts` | `git diff --stat` on those two paths is empty | ✓ |
| 20 | "Placed directly after the `machineConnection` object", away from S1 | the object closes at `:711`; S1's last hunk inserts a method after `:710` (`queryGrblSettings`, 9 lines), i.e. immediately inside the closing brace | ~ (after S1 merges, "after `};`" is unambiguous; before it, the two insertions are one line apart) |
| 21 | Per-line in-pump reports only on read-timeout ticks (`serial_pump.rs:153-158`); drain 200 ms (`jobSession.ts:79`) | doc comment `:153-158`; `DRAIN_POLL_MS = 200` at `:79`; port timeout 1000 ms (`serial.rs:384`) | ✓ |
| 22 | Battery: one contiguous `find` per id, unique in file (`mutation-battery.mjs:1773-1780`) | `MUTANT_ANCHOR_AMBIGUOUS` at `:1774-1779`; one `{id,path,find,replace}` per mutant `:1553-1559` | ✓ |
| 23 | ROADMAP Parking Lot entry `:486-489` | `:486-489` "Laser-stops-firing root cause … blocked on that data" | ✓ |
| 24 | `jobStream.test.ts` can capture the `Channel` from `serial_stream_job` args | `MockChannel` with `onmessage` at `:5-10`; existing tests already use `recorder.getRecordIndex("serial_stream_job")` | ✓ |
| 25 | Snapshot has `state`, `feed`, `spindle`; `state` is `"run"` as a string or an object for hold/door | `machineStatus.ts:40-53` (`GrblSnapshot`), `MachineState` union `:18-28` | ✓ (the plan's `typeof snap.state === "string"` guard is right) |

Twenty-five claims: 22 exact, 3 imprecise (4, 16, 20), none wrong. The plan's reading of the tree is accurate. What it did not read is Kerf's own G-code generator, which is where the decision brief goes wrong (X3).

## Universal core (all gating)

### 1. Problem-fit — **CONCERN**
`## Intent (grilled)` present with a written skip line; the Summary is checkable. No DECISIONS entry is contradicted: the wording is status-only per 2026-09-10; nothing touches the stop, the fence, or the submit lock (2026-09-24); no interlock is added; no controller identity is added (public-repo rule). The plan correctly overturns the parent's premise (the check cannot fire during a job) and says so at the top, which is the right way to lift a batch whose parent was wrong.

The concern is that the Summary's first line — "the next 'laser stopped' report must arrive with console data: what the controller reported" — is met by option (a) only in **one of two fault shapes**. If the controller's reported spindle went to 0, the line fires. If the beam went dark while the controller went on reporting `FS:…,S>0` — which is exactly the gap the 2026-09-10 ruling names ("a status report says what the software commanded and never what the beam emitted") — this instrument prints nothing, and the next report arrives with no line. That is not a defect of the design; it is a limit that the plan's "What E3 does not satisfy" section must state, so nobody reads "no line" as "the controller kept firing". Fix under X3.

### 2. Approach soundness — **PASS**
One function, three feeds, is right: the three routes a report takes during a job (in-pump responses, buffered `status` events, drain polls) all exist as the plan says and none runs the check today (claims 5-7). Record-before-send is right and verified: in-pump reports are returned inside the awaited `send(lines[i])` (`:292-301`), so a record written after `:352` would name `i-1`. The buffered helper following Rust's filter is right (claim 12). Anchoring edits on text, not lines, is right given S1 inserts 130 lines above everything.

### 3. Completeness — **CONCERN**
(a) **How often the line fires on Kerf's own jobs is not stated, and the answer is "at every sampled turnaround or transit".** Kerf's generator commands the spindle off between every burn: the scanline emitter ends each scan with `M5` (`gcode_gen.rs:323`) and `G1 … S0` overscan (`:290`, `:336`) and rapids `G0` to the next line (`:270`); the vector emitter transits with `M5` + `G0` (`:693-700`) and `G0` between paths (`:586`, `:622`). A raster fill of N scan lines therefore commands N spindle-to-zero transitions **in Run state**, and every one the sampler lands in satisfies `run && prev > 0 && spindle === 0`. The capture already shows Run + `FS:0,0` at every M5/G0 in the probe (`:68`, `:845`, `:909`, `:972`, all immediately after an `M5` then `G0`). The plan's diagnosis 2 found the M4-ring case and called it "an ordinary cut"; the general case is far larger. (b) The second fault shape (S stays > 0, no line) is missing from "What E3 does not satisfy" — see core 1. (c) `prevSpindleSpeed` is not reset at job start; only the last-sent record is. In practice the 250 ms idle poll between jobs lands an `Idle|FS:0,0` and sets `prev = 0`, and the brief drain for FRAME returns on the first `<Idle` (`jobSession.ts:137`), so a stale `prev > 0` crossing into a new job is unlikely; but "unlikely" is an assumption where a one-line `resetSpindleDrop()` at `streamJob` start (beside `resetLastSentLine()`) would make it structural and would make E3-M6's cross-job test a true within-job invariant. (d) Buffered record lag: up to 50 ms of lines mid-job, exact at the end (claim 12). Say so in the "does not satisfy" list; the message's "(the controller may still be executing earlier lines)" covers the planner, not the throttle. (e) Nothing else missing: `$H`, jog and console sends also pass through `send()`, but their reports carry `Home`/`Jog`/`Idle` states, so the `run` guard keeps them silent; `Hold:0` parses to `hold`.

### 4. Right-sizing & reuse — **PASS**
Five files, one root, waiver carried from the parent (new module keeps R1 and S4b's store files untouched). Standard tier with the S1 dependency declared and the overlap hunks named from the branch, not guessed. Out-of-scope items named with a Parking Lot index line for Stage 3.5 and the parent's filter-divergence line left standing. The decision to not quote planner depth as a number is right for a public repo.

### 5. Security — **PASS**
No secrets, auth, network or file writes. No controller vendor, model, firmware or `[VER:`/`[OPT:` string is added; the plan quotes one status report from the log and no identity line. The console line reveals nothing beyond what the DRO already shows.

### 6. Failure modes — **CONCERN**
**The new per-line call sits inside `send()`'s `try`.** If `parseReportSample` or `noteSpindleSample` ever throws (a malformed `<…>` line, a future refactor), `send()`'s `catch` (`:324-339`) returns `["error:disconnected"]`; the per-line loop reads that as `error:` (`jobStream.ts:381-390`), sets `machineConnected=false`, marks `portDisconnected`, breaks, routes through `emergencyStop` and then `disconnect()` (`:301-307` and the post-loop). A diagnostic bug would end a job and drop the port mid-cut. The physical outcome is safe (`0x18` → beam off), the part is ruined, and the report Lee files says "Kerf disconnected mid-job". A regex over a string and a store write are unlikely to throw, but a diagnostic must be unable to change the job path's return value **by construction**, not by luck. **Fix:** wrap the call at the `send()` site in its own `try { … } catch (e) { console.error(…) }` (or make `noteSpindleSample` total and say so in its doc comment), and add a test: a report that would break the parser leaves `send()`'s return and the store's `machineConnected` unchanged. The drain site is benign (a throw lands in drain's `catch` and the poll continues, `jobSession.ts:166-168`); the buffered site is a `Channel` callback, where a throw is swallowed by the Tauri bridge — say so.

### 7. Change safety — **PASS**
No irreversible step. The suspension at `:372` / `:173-175` is left untouched, and the plan says why (it keeps `?` off the wire during job lines). Rollback is the merge commit; nothing depends on E3. Rebase discipline against S1 is stated ("keep both sides").

### 8. Data integrity & compatibility — **PASS**
No store field, no file format, no settings write. Saved projects are untouched.

### 9. Verifiability (incl. testing the tests) — **PASS** (residuals below)
Every mutant is one contiguous edit at one site, each traced red: M1 (`false` → the drop test's single warning never appears), M2 (Idle drop warns → "no warning" fails), M3 (deleting `prevSpindleSpeed = spindle;` leaves `prev` null forever → **zero** warnings, so "exactly one" fails — red for a different reason than the parent's "warns twice"; still a kill), M4/M5/M12 (template edits with distinct anchors), M6 (traced: Idle poll sets `prev=0`; first job report `Run|FS:0,0`; without the `> 0` guard it warns), M7 (trim removed → `"  ; note"` survives), M8/M9/M10 (each call site deleted; the three call expressions differ, so anchors are distinct), M11 (`i-1` → `#1` instead of `#2`), M13 (stale text from the previous job). C1 is a real control under the plan's own definition (green at baseline; `spindle < prev` makes 500→300 warn). The M4 per-line fixture works: the mocked `serial_send` returns `responses` with `<Run|…>` lines, which `send()` consumes in order (`:295-301`). The M10 fixture works through `getStatusReport()` with `outcome.status` set. The buffered fixtures work with the existing `MockChannel` (claim 24). The browser step is reachable: `connection.ts` imports without a Tauri host because `invoke` is only called, never at import, and `noteSpindleSample` writes the store directly.

Residuals (none gating): (a) **Razor's check cites `:372` and `:173-175`**, which move by ~130 lines once S1 lands; anchor it on the text (`if (jobPollingSuspended) return;` and the `useStore.subscribe` block). (b) **Anchor uniqueness:** the old block at `:400-404` uses `currentSpindle === 0`, not `spindle === 0`, so after the move `spindle === 0` is unique — as long as the new tests do not also contain that literal in `connection.ts` (they live in the test file, fine). (c) The plan mandates a **separate `import` statement** from `../connection` in `connection.test.ts` to stay out of S1's hunk at `:11`; if the project's ESLint config enables `import/no-duplicates`, `npm run lint` gains a warning, which the plan's own verification forbids. Since E3 dispatches after S1 merges, extend the existing import instead and drop the separate-statement rule. (d) The E3-M3 row should say the kill is "no warning at all", so the journal reader is not looking for two.

### 10. Maintainability — **CONCERN** (minor)
The comment at `:75-77` is stale today and becomes actively wrong after E3 (`send()` will feed the variable it says is unused there). The plan forbids editing `:75-81` because "S1's hunk abuts", but S1's hunk is after `:84` (claim 16) and E3 dispatches after S1 merges anyway, so the reason is moot. **Fix:** rewrite the comment to name `noteSpindleSample` and its three feeds. The ARCHITECTURE delta and Parking Lot line are named for Stage 3.5, good. Clean seams otherwise: one exported function, one parser, one pure module.

## Conditional dimensions

### X1. Physical & human safety — **PASS** [GATING]
No control path changes. Nothing added sends a byte; the `?` suspension during jobs is untouched, so the 2026-07-05 interleaving hazard is not reopened; no stop, fence or submit-lock code is touched (2026-09-24). Every failure path ends in a safe state: the one new way to end a job (core 6, a throw inside `send()`) goes through `emergencyStop` → `0x18` (2026-09-20), beam off — a ruined part, never an energised beam. The message makes no beam claim (2026-09-10). Hardware-only checks are named and routed to E4's card, not skipped. **Worst case per failure path, named:** diagnostic throws mid-cut → job stops and disconnects, beam off (closed by the core-6 guard); wrong line named → an operator correlates the wrong line, no physical effect; line fires on every transit → the operator learns to ignore console warnings, which is where ALARM and "Connection lost" also land (X6). That last one is the only safety-adjacent cost, and it is a real one.

### X3. Evidence & source integrity — **FAIL** [GATING]
The decision brief is what Lee will act on, and two of its load-bearing statements are wrong or overstated:

1. **Option (a)'s cost, "some lines on ordinary jobs", is wrong.** Kerf's own generator commands spindle-off at every scan-line end and every path transit (`gcode_gen.rs:270`, `:290`, `:323`, `:336`, `:586`, `:622`, `:693-700`), so Run-state spindle 0 is the normal signature of every turnaround and every travel, and the line fires at each one the sampler lands in — for a raster fill, potentially hundreds per job. The capture the plan cites shows the same shape at every `M5`+`G0` in the probe (`:68`, `:845`, `:909`, `:972`). The plan's own diagnosis 2 saw a piece of this (one M4 ring) and priced it as "some". The consequence is not noise for its own sake: the one line that matters is buried among identical ones, and "Lee learns to skim past it" — named in the brief as a risk — becomes the expected outcome, not a risk. The brief's mitigation ("the wording and the line number make it checkable") does not cure volume.

2. **Option (a)'s benefit, "the only one that produces data from real jobs", is overstated.** It produces a line only when the controller's reported S dropped. If the beam died while the controller kept reporting S > 0 (the gap the evidence ruling exists to name), there is no line. The brief must say that the absence of a line is itself the datum in that case, and E4's card must ask the owner to note "no spindle-0 line printed" alongside the time he saw the beam go dark.

3. **Options (b) and (c) are described correctly.** (b): tests and a line number on a message that cannot appear during a job; "nothing visible"; the next incident has no data — all true. (c): removes the only in-app instrument and the false "may have stopped firing" text with it; the probe is Lee-run and cannot sit inside a real job — true.

4. **Option (d) is priced too high and is the only listed option that copes with the volume.** "A larger change, with a new place to show it" — a job-end summary can be console lines (count of transitions, first and last, the last-sent line at each), no new UI. It should be priced as such.

5. **A fifth option is missing, and it is the one I would recommend:** (a′) — (a) with volume control. Keep the per-sample check and the last-sent line; print the **first** drop of each job at `warning` and every later one at `info`, and at job end one `info` line: "N spindle-0 reports during Run this job; first at line #a, last at line #b". Both directions could also be logged (0 → > 0 at `info`) so a dark beam with S reported 0 shows as a drop **without a recovery** before the next cut line. Same five files, no store field, no UI. The mutant table gains two rows (first-vs-later level; job-end count) and loses nothing.

**Fix:** rewrite item 4 of the brief with the frequency stated from `gcode_gen.rs`, the second fault shape stated, (d) repriced, and (a′) added; the recommendation then stands on true costs. The battery of this plan is otherwise sound; this is a defect of the brief, not of the code.

### X5. Concurrency & re-entrancy — **PASS** [ADVISORY]
Three feeds share `prevSpindleSpeed`, but they cannot interleave: `pollStatus` is suspended for the whole job; per-line `send()` is awaited serially; the drain runs after the pump returns; buffered `status` events and the drain are sequential by the same `await`. Two overlapping jobs are already prevented by the session fence. The one residual is the cross-job stale `prev` (core 3c) — reset it at job start.

### X6. Operability & observability — **CONCERN** [ADVISORY]
Under (a) as written, the console — the same panel that carries ALARM, "Connection lost", and the stop's lines — gains a `warning` at every sampled transit. That degrades the signal of every other warning Kerf prints. The (a′) shape above keeps one `warning` per job and a summary. Either way, the message's text is good: status-only, previous value, feed, last line sent with the planner caveat.

### X2, X4, X7, X8 — N/A
X2: no personal data. X4: nothing client- or public-facing. X7: no gate, hook or skill touched. X8: no package or service; one regex per report at the existing report rate.

## Stress tests

### Pre-mortem — three months out, this failed
1. **A raster job printed four hundred "spindle 0 during Run" warnings; Lee hid the console; the next dark-beam incident had no usable line.** The line was correct every time and useless as a whole, because Kerf commands spindle-off at every scan-line end. What we should have seen: `gcode_gen.rs:323` and `:290` — the plan read the controller log and the streaming code but not the generator that writes the job.
2. **The beam went dark, the controller kept reporting S > 0, nothing printed, and a session concluded "the diagnostic saw nothing, so the controller did not stop the spindle".** That is a beam inference from silence. What we should have seen: the 2026-09-10 ruling names exactly this gap, and the brief did not tell Lee the instrument is blind to it.
3. **A vendor status line with an unexpected `FS:` shape made the parser throw inside `send()`; the job stopped and the port dropped mid-cut; the bug report said "Kerf disconnected".** What we should have seen: the call site is inside `send()`'s `try`, whose `catch` returns the disconnect sentinel.

### Load-bearing assumptions
1. **Polling is suspended for the whole of every job, so no existing path runs the check during one.** Verified (`:372`, `:173-175`, four doors, `session.end` after drain). High confidence.
2. **In-pump reports arrive inside the awaited `send(lines[i])`, so the record must precede the send.** Verified (`:292-301`). High confidence.
3. **Run-state spindle 0 is rare on ordinary jobs.** **False** on Kerf's own G-code (`gcode_gen.rs` transit and scan-end emission). This is the assumption the brief's cost line rests on. Resolve before Lee decides.
4. **The fault manifests as a reported spindle drop.** Unknown; the two 2026-09-14 reports had no console data, which is why this batch exists. The brief presents (a) as if this were true. State it as the assumption it is.

### Inversion — when would a rejected alternative win?
- **(d) job-end trail** wins if the per-transit volume is high enough that live warnings drown the one that matters. It is (assumption 3), so (d)'s core idea — summarise — belongs in the recommendation, which is what (a′) does without a new surface.
- **(c) remove the check** wins if the probe could capture a real job. It cannot; the probe is a separate Lee-run tool with its own program. Not true.
- **(b) as the parent wrote it** wins if the check could fire during a job. Verified it cannot. Not true.
- **A store field instead of `lastSentLine.ts`** wins if nothing else were editing the store. R1 and S4b are. Not true; the module is right.

## Overall verdict

**FAIL, on X3 (the decision brief) alone.** The code plan is sound: the diagnosis that the check has never been able to fire during a job is verified line by line, the three-feed design is right, the record-before-send ordering is right, every mutant is a single-site kill I could trace, and the S1 overlap is read from the branch rather than assumed. It is implementable as written under option (a), with one guard (the per-line call must sit in its own `try`, because `send()`'s `catch` turns any throw into a mid-job disconnect) and one text-anchored Razor check. What blocks the gate is that the brief prices option (a) at "some lines" when Kerf's own generator commands the spindle off at every scan-line end and every transit, so the line fires at every sampled one and buries itself; and it sells (a) as the option that "produces data" without saying it is blind to the fault shape the evidence ruling was written about. Lee would be choosing on a wrong cost and an overstated benefit. Rewrite item 4 of the brief with the frequency from the generator, the second fault shape, (d) repriced, and an (a′) that keeps one warning per job plus a job-end count; fold the `send()` guard and the job-start `prev` reset; then this passes and the decision can go to Lee.

## Must-fix, prioritised

1. **X3 / brief item 4 (gating):** state option (a)'s real cost — the line fires at every sampled scan-line end and path transit, because Kerf emits `M5` / `G1 … S0` / `G0` between burns (`gcode_gen.rs:270`, `:290`, `:323`, `:336`, `:586`, `:622`, `:693-700`); for a raster fill, hundreds per job. Replace "some lines" and "Lee learns to skim past it" with that.
2. **X3 / core 1:** state that the instrument prints nothing when the controller keeps reporting S > 0 while the beam is dark, that "no line" is the datum in that case, and route "note whether a spindle-0 line printed" to E4's card. Add it to "What E3 does not satisfy".
3. **X3 / options:** reprice (d) as console-only (no new UI); add (a′): first drop per job at `warning`, later drops at `info`, one job-end `info` count naming first and last line; optionally log the 0 → > 0 recovery at `info`. Recommend (a′) or say why (a) still wins at the true cost. Two mutant rows for the level and the count.
4. **Core 6 / X1:** wrap the `send()`-site call in its own `try/catch` (console.error only) or make `noteSpindleSample` provably total and say so; add a test that a parser-breaking report leaves `send()`'s return and `machineConnected` unchanged. Note the buffered site is a Channel callback (throw swallowed) and the drain site lands in drain's own catch.
5. **Core 3c / X5:** reset `prevSpindleSpeed` at `streamJob` start (export a production `resetSpindleDrop()` beside the test hook; call it next to `resetLastSentLine()`), so a drop is a within-job transition by construction.
6. **Core 9a:** Razor's unchanged-lines check must be anchored on text (`if (jobPollingSuspended) return;`, the `useStore.subscribe` block), not `:372` / `:173-175`, which move ~130 lines after S1.
7. **Core 3d:** say the buffered record lags by up to 50 ms of lines mid-job and is exact at the end (`serial_pump.rs:617-619`).
8. **Core 9c:** drop the "separate `import` statement" rule (E3 lands after S1; extending `:11` is safe, and a duplicate import may trip lint); core 9d: E3-M3's kill is "no warning", not "twice".
9. **Core 10:** rewrite the stale comment at `:75-77` to name `noteSpindleSample` and its feeds; delete the "must not edit `:75-81`" rule (S1's hunk is after `:84` and E3 follows S1). Citation nits: S1's hunk is at `:84/85`; the drain span is `:123-181`; after S1 the object's last method is `queryGrblSettings`, so "after `};`" is the anchor.
