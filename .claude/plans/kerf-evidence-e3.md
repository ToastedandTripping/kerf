# Kerf evidence E3: the spindle-drop check runs during jobs, says only what the controller reported, and names the last line sent

**Lifted from:** `/home/leesalo/marvin/state/audits/gap-2026-09-24/kerf/PLAN-silent-drop-and-evidence.md` §E3 (critic `PLAN-silent-drop-and-evidence-critic.md`, CONCERN, folded).

**Lineage:** `.claude/plans/kerf-relay-plan.md` §C2 (tests 1-4); critic `kerf-relay-plan-critic.md` (store collision note). Where this file and a relay-plan body differ, this file wins. On anything this file does not cover, the parent wins.

**This lift changes the parent's premise.** The parent assumes the check can fire during a job. It cannot, as read below. The change here is therefore wider than "the `FS:` block only". It needs the answer to the decision at the end before Stage 1.

**Citations:** re-read at `a6ddc3a` on session branch `marvin/kerf-gap` (source = master `caa0dcc`; `git diff --stat caa0dcc HEAD -- src` is empty) on 2026-09-25.

- **Relay id:** `kerf-evidence-e3`
- **Branch:** `relay/kerf-evidence-e3`
- **Tier:** Standard. 5 files, one root (`src/`). No UI render change, so no Jen pass. The parent's five-file note stands: the new module keeps the change out of the store files that R1 and safety S4b edit.

## Intent (grilled)

Grill skipped. The intent comes from the parent's Intent and from ROADMAP Parking Lot "Laser-stops-firing root cause" (`ROADMAP.md:486-489`): "Head keeps moving but laser goes dark mid-job ... root cause investigation blocked on that data." It is bound by DECISIONS 2026-09-10 "Hardware evidence for this program is status-only".

Summary:
- The next "laser stopped" report must arrive with console data: what the controller reported and which job line had most recently been sent.
- The line must say only what the controller reported. It must not suggest what the beam did.
- No stop, no interlock, no new store field, no new store subscription.

## Existing plans reviewed

Checked 2026-09-25 with `ls`:
- Primary `.claude/plans/`: 23 files plus `archive/` (3).
- Session branch: 28 files plus `archive/`.
- Audit directory: 9 files.

**Relays in flight:**
- `kerf-refresh-cut-vs-screen` (R1): viewport, geometry, store, fileOps, `App`, `svgExport`, `geometryActions`. No overlap: E3 edits no store file.
- `kerf-evidence-e1a`: `gcodeGen.ts` and its test. No overlap.
- **`kerf-safety-s1`**: `canStartJob.ts`, `MaterialTestDialog.tsx`, `JobActionBar.tsx`, `GrblSettingsDialog.tsx`, `connection.ts` (`send` / `enableLaserMode` / settings readback), `canStartJob.test.ts`, `connection.test.ts`, `machineJobLoop.test.tsx`. **This overlaps E3 in two files.** S1's branch (`relay/kerf-safety-s1`, read 2026-09-25) changes three regions of `connection.ts`:
  - it inserts ~130 lines of helpers after `let prevSpindleSpeed` (hunk at `:82`);
  - it adds two statements before `send()`'s `invoke` (`:289-292`);
  - it adds one statement after `send()`'s position block (`:320`).

  S1 also changes the import block (`:8-14`) of `connection.test.ts` and appends a `describe` at its end (`:712+`).

**Rebase expectation:** E3 dispatches **after S1 merges** and branches from the merged tree. If it must start earlier, it rebases on S1 before Stage 2.
- Every E3 edit below is anchored on text, not line numbers. The anchors are the `if (r.startsWith("<")) {` block inside `send()`'s response loop, the body of `getStatusReport`, and the `// Spindle-drop diagnostic` block in `pollStatus`.
- E3 must not edit `:75-81`, the declaration S1's hunk abuts.
- The new test `describe` goes **immediately before** `describe("connection.send — RF-15 job epoch and refusal"` (`connection.test.ts:681`), not at the end of the file, and imports through a separate `import` statement, so neither lands in S1's hunks.

The safety plan's later batches S1b, S2 and S4c edit other lines of `jobStream.ts`/`jobStream.test.ts` and are not in flight. The Stage 0 re-check repeats this inventory.

## Diagnosis (verified)

1. **The check cannot fire during a job.**
   - It lives in `pollStatus` (`connection.ts:395-416`).
   - `pollStatus` returns early when `jobPollingSuspended` is true (`:372`), and `connect()` wires that flag to `jobRunning` (`:173-175`, "Suspend polling automatically when a job is running").
   - `jobRunning` is set true by every job door: `JobActionBar.tsx:80` (START), `:167` (FRAME), `MaterialTestDialog.tsx:413`, `:445`. It stays true through draining (`jobSession.ts:113-178`).

   So during every job the status reports arrive by other routes, none of which runs the check:
   - **Per-line:** in-pump reports come back in `send()`'s responses. They are used for position only (`connection.ts:295-322`).
   - **Buffered:** channel `status` events are used for position only (`jobStream.ts:177-189`).
   - **Draining:** `session.drain` polls `getStatusReport()` (`jobSession.ts:136`, `:156`; `connection.ts:356-360`), which returns the raw string and checks nothing.

   A test driven through `pollStatus` (the parent's "pattern at `connection.test.ts:117-148`") would pass in vitest, because no test calls `connect()`, so the suspension flag stays false. But it would certify a path that production never takes during a job. **The parent's statement "warns once when `FS:` spindle speed drops to 0 during Run" is true only outside jobs.**
2. **On the owner's controller the condition occurs on an ordinary cut.** In the committed capture:
   - During `ring_M4_wait_idle_before_switch`, M4 is active, the last `G1` of the ring is executing, and the controller reports `<Run|MPos:20.000,-37.650,…|FS:0,0>` while the position keeps advancing to `-20.038` (`scripts/probe-20260914-153729.log:216-218`).
   - The same happens in each of the five repetitions (`:216`, `:370`, `:522`, `:676`, `:830`, each inside that variant, verified).
   - Feed reads 0 too, while the head moves.

   So a live check will print on ordinary jobs, and the existing text ("laser may have stopped firing", `connection.ts:407-411`) states a beam inference the status-only ruling forbids. **The parent did not consider this.**
3. **What the store and the streamers hold.**
   - The store holds only `jobProgress`, a fraction (`storeTypes.ts:183`).
   - The per-line loop has `lines[i]` in hand (`jobStream.ts:352`).
   - The buffered path gets `event.lineIndex` from throttled progress events (`jobStream.ts:161-166`; throttle 50 ms, `serial_pump.rs:440-447`). That index counts lines after Rust's filter, which trims and then drops empty and `;`-leading lines (`serial.rs:826-830`). The per-line TS filter does not trim before its `;` test (`jobStream.ts:326`).
4. **The per-line record must precede the send.** In-pump reports arrive while `send(lines[i])` is waiting. A record written after the send (the parent's "after the per-line send at `:352`") would name line `i-1` in the check that runs inside that send.
5. `prevSpindleSpeed` is module state (`:78`). It is reset only on connect (`:136`), and its comment (`:75-77`, "Managed by the snapshot consumer now") is stale. No test mentions the check (`grep -rn "stopped firing" src` hits only `connection.ts:408,411`).

## Change (assuming option (a) of the decision below)

### 1. `src/lib/machine/lastSentLine.ts` (new, no store access)

- `setLastSentLine(index: number, text: string)`, `getLastSentLine(): { index: number; text: string } | null`, and `resetLastSentLine()` over module state.
- `bufferedJobLines(gcode: string): string[]` is `gcode.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith(";"))`. It mirrors `serial.rs:826-830`, so a buffered `lineIndex` maps to the text Rust sent.

### 2. `src/lib/machine/connection.ts`

- **One check, three feeds.** Move the body of the `// Spindle-drop diagnostic` block into an exported module function, `noteSpindleSample(state: string | null, feed: number | null, spindle: number | null): void`, placed directly after the `machineConnection` object (away from S1's hunk at `:82`). Its condition is today's, unchanged:

  ```
  state === "run" && prevSpindleSpeed !== null && prevSpindleSpeed > 0 && spindle === 0
  ```

  It ends with `prevSpindleSpeed = spindle` whenever `spindle` is finite.
- **`parseReportSample(report: string)`** returns `{ state, feed, spindle }` from a raw `<…>` report. `state` is the lowercase token before the first `|` or `:`; feed and spindle come from `FS:f,s`, and are `null` when absent.
- **Call sites:**
  - `pollStatus`: the existing block becomes `noteSpindleSample(typeof snap.state === "string" ? snap.state : null, snap.feed, snap.spindle)`, still under `accepted && outcome.snapshot`.
  - `send()`: inside the `if (r.startsWith("<")) {` branch of the response loop, **before** `lastStatusReport = r;`, call `noteSpindleSample(...parseReportSample(r))`, once per report and in order. This is the per-line job path.
  - `getStatusReport()`: after the events loop, if `outcome.status` starts with `<`, call it on that string. This is the drain path, and it adds no `jobSession.ts` edit.
- **The line it prints:** one console line of type `warning`, with the same text passed to `console.warn`:
  > `Controller reported spindle 0 during Run (previous report ${prev}, feed ${feed ?? "unknown"}). Status only: this is what the controller reported, not whether the beam emitted. Last job line sent: ${where}.`

  `${where}` is `#${last.index + 1} "${last.text}" (the controller may still be executing earlier lines)`, or `none recorded for this job`.
  - The old text is removed. It is "laser may have stopped firing" at `:408` and `:411`.
  - Planner depth is deliberately not quoted as a number. The owner's is 127, stock is 15, and the host does not know which it is talking to.
- **Test hook:** `export function _testResetSpindleDrop(): void` sets `prevSpindleSpeed = null`. It sits beside `_testResetPollFailures` (`:784`), which is not edited.
- **Untouched:** everything outside the three call sites, the new function, the parser and the test hook. The suspension at `:372`/`:173-175` stays exactly as it is, because it exists to keep `?` from interleaving with job lines.

### 3. `src/lib/machine/jobStream.ts`

- **In `streamJob`, before the mode dispatch** (`:315-318`): `resetLastSentLine()`. This covers both paths.
- **Per-line:** immediately **before** `const responses = await machineConnection.send(lines[i], …)` (`:352`), call `setLastSentLine(i, lines[i])`.
- **Buffered:**
  - compute `const sentLines = bufferedJobLines(gcode)` once at the top of `streamJobBuffered`;
  - in the `progress` case, call `setLastSentLine(event.lineIndex!, sentLines[event.lineIndex!] ?? "")`;
  - in the `status` case, call `noteSpindleSample(...parseReportSample(event.report))` before the existing position update.
- No other line changes.

### 4. Tests

- **`src/lib/machine/__tests__/connection.test.ts`:** a new `describe("spindle-drop evidence (E3)")`, placed as stated above. Its `beforeEach` also calls `_testResetSpindleDrop()`.
- **`src/lib/machine/__tests__/jobStream.test.ts`:** a new `describe` block only, whose `beforeEach` calls `_testResetSpindleDrop()` and `resetLastSentLine()`.
  - Per-line jobs mock `serial_send` responses carrying in-pump `<Run|…|FS:…>` lines.
  - Buffered jobs capture the `Channel` from the `serial_stream_job` invoke args and call `channel.onmessage` with `progress` and `status` events before resolving.

## Tests and mutants

**Battery spec `kerf-evidence-e3`:**
- `test_command`: `["npx","vitest","run","src/lib/machine/__tests__/connection.test.ts","src/lib/machine/__tests__/jobStream.test.ts"]`.
- The baseline must be green; the battery refuses a red one.
- Each id is one contiguous find/replace whose `find` occurs exactly once in its file (`mutation-battery.mjs:1773-1780`). No mutant is stacked.
  - E3-M1 and E3-C1 share the natural anchor `spindle === 0`. Each is its own single-edit mutant, run separately, and the anchor must be unique in the file.
  - E3-M4, E3-M5 and E3-M12 edit the same template literal, each with a distinct `find`.
- A control is a test that is green at baseline, whose named wrong variant turns it red. It appears in the journal as `killed`.

**How each goes red:** every test drives a production entry point: `pollStatus`, `send`, `getStatusReport`, or `streamJob` in both modes. Each asserts on `useStore.getState().consoleLines`. No mutant is caught by a type error.

| Id | Test | Wrong variant (one edit) |
|---|---|---|
| E3-M1 | `pollStatus` with `<Run|…|FS:1000,500>` then `<Run|…|FS:1000,0>` (no job): exactly one warning line containing "spindle 0 during Run" | Replace `spindle === 0` in the condition with `false` |
| E3-M2 | `pollStatus` with `<Run|…|FS:1000,500>` then `<Idle|…|FS:0,0>`: no warning | Delete `state === "run" && ` |
| E3-M3 | After the drop, two more `FS:1000,0` Run reports: still exactly one warning | Delete `prevSpindleSpeed = spindle;` |
| E3-M4 | Per-line job of three lines; line 2's in-pump reports are `FS:1000,500` then `FS:1000,0`: the warning contains `#2` | Delete `#${last.index + 1} ` from the template |
| E3-M5 | Same job: the warning contains line 2's text verbatim | Delete `"${last.text}" ` from the template |
| E3-M6 | `pollStatus` Idle `FS:0,0` (prev becomes 0), then a per-line job whose first in-pump report is `<Run|…|FS:0,0>`: no warning | Delete `prevSpindleSpeed > 0 && ` |
| E3-M7 | `bufferedJobLines("G0 X0\n  ; note\n\nG1 X1 S500\nG1 X2")` equals `["G0 X0","G1 X1 S500","G1 X2"]`; and a buffered job with that program, a `progress` event at `lineIndex 2` and a drop `status` pair names `"G1 X2"` | Delete `.map((l) => l.trim())` |
| E3-M8 | Per-line job with in-pump drop reports: one warning (the job path is live) | Delete the `noteSpindleSample(...)` call in `send()`'s response loop |
| E3-M9 | Buffered job with `status` events `FS:1000,500` then `FS:1000,0`: one warning | Delete the `noteSpindleSample(...)` call in the buffered `status` case |
| E3-M10 | `getStatusReport()` answering `<Run|…|FS:1000,500>` then `<Run|…|FS:1000,0>`: one warning (the drain path) | Delete the `noteSpindleSample(...)` call in `getStatusReport` |
| E3-M11 | The E3-M4 job: the warning names `#2`, not `#1` (the record precedes the send) | Replace `setLastSentLine(i, lines[i])` with `setLastSentLine(i - 1, lines[i - 1])` |
| E3-M12 | The warning contains "Status only" and does not contain "may have stopped firing" | Replace the template's first sentence with the old `Laser may have stopped firing.` text |
| E3-M13 | A per-line job completes, then a buffered job receives a drop `status` pair before any `progress` event: the warning says "none recorded for this job" and does not contain the previous job's text | Delete `resetLastSentLine();` in `streamJob` |
| E3-C1 | (control) Steady cutting (`FS:1000,500`, then `FS:1000,300`, then `FS:1000,500`) through `send()` never warns | Replace `spindle === 0` with `spindle < prevSpindleSpeed` |

## Verification

- `npx vitest run src/lib/machine/__tests__/connection.test.ts src/lib/machine/__tests__/jobStream.test.ts`
- `npx tsc --noEmit`
- `npm test`: the baseline measured at relay start plus the new tests, none weakened.
- `npm run lint` with no new warnings, and `npm run format:check`.
- Battery journal: every E3-M* and E3-C* id `killed`; `survived`, `errored` and `CONTROL_RED` all 0.
- Razor reads the three call sites and confirms that `:372` and `:173-175` are unchanged.

**Browser** (`npm run dev` + Chrome DevTools MCP):
- In `evaluate_script`, `const c = await import('/src/lib/machine/connection.ts')`.
- Call `c.noteSpindleSample("run", 1000, 500)`, then `c.noteSpindleSample("run", 1000, 0)`.
- Screenshot the console panel showing the new line with "none recorded for this job".
- The job paths are not browser-reachable, because the dev server cannot reach `invoke`. State that.

**Hardware-only (named; lands on the owner's card through E4):**
- On the next job that "goes dark", the console shows the line with a line number and text.
- Expect the line on ordinary M4 jobs too (Diagnosis 2). The line is evidence to correlate, not an alarm.

## What E3 does not satisfy

- **The root cause of "laser stops firing."** This batch only adds data.
- **Any statement about the beam.** The status-only ruling forbids it.
- **Sampling is sparse.**
  - Per-line in-pump reports exist only when a line waits through a read-timeout tick, because a `?` is sent per tick (`serial_pump.rs:153-158`).
  - Drain polls run every 200 ms (`jobSession.ts:79`).
  - A drop between samples is not seen.
- **"Last line sent" is not "line executing."** The controller may be many lines behind. The text says so.
- **The per-line and buffered filters still differ** (`jobStream.ts:326` vs `serial.rs:826-830`). The helper follows Rust for the buffered index only. The divergence is the parent's Parking Lot lead.

## Stage 3.5 obligations (orchestrator)

- **ROADMAP:** the Parking Lot entry "Laser-stops-firing root cause" (`:486-489`) gains no edit to its text. Append a new index line: `- **Spindle-drop line now fires during jobs (E3)** — before E3 the diagnostic ran only when no job was running (polling is suspended during jobs); on the owner's controller Run+FS:0,0 occurs on ordinary M4 cuts (capture 2026-09-14), so the line is evidence to correlate, not a failure signal.`
- **ARCHITECTURE.md:** one line under the `connection.ts` entry: the spindle-drop check is `noteSpindleSample`, fed from `pollStatus` (no job), `send()` in-pump reports (per-line), `getStatusReport` (drain) and buffered `status` events. Status only.
- **Parent Parking Lot lines** (written by E1a's 3.5): the per-line/buffered filter divergence line stands.

## Risks and rollback

- **Operator-visible:** warning lines now appear during jobs, including ordinary M4 jobs on the owner's machine. That is the point of the decision below. The wording disclaims any beam inference.
- **Merge:** S1 overlaps two files. Rebase on S1, and keep both sides of any conflict, never dropping either.
- **Module state:** `prevSpindleSpeed` and the last-sent record are module-level. Both are reset in tests. The record is reset at every job start (E3-M13).
- **Rollback:** revert the relay merge commit. Nothing depends on E3.
- **Irreversible steps:** none.

## Decision needed before Stage 1

1. **Should the spindle-drop line run during jobs, and what should it say?**
2. **What exists today:** the console can print "WARNING: Spindle speed dropped to 0 during active job — laser may have stopped firing", but only when no job is running. Status polling pauses for the whole of every job, so the line has never been able to appear during one. Lee's Parking Lot entry says the root-cause work is blocked on exactly this data.
3. **Tension:** the audit plan would add a line number and text to a message that cannot appear. Making it live shows it on ordinary jobs on Lee's machine: his 14 Sep trace has the controller reporting spindle 0 and feed 0 while the head is still moving along a normal cut, in all five repetitions. His 2026-09-10 ruling says: "a status report says what the software commanded and never what the beam emitted."
4. **Options:**
   - **(a) Live during jobs, reworded to status-only, with the last line sent** (this plan).
     - Changes: the line appears during jobs when it happens, and says what the controller reported.
     - Costs: some lines on ordinary jobs.
     - Risks: Lee learns to skim past it. The wording and the line number make it checkable instead.
   - **(b) The audit plan as written.**
     - Changes: tests and a line number, but the message still never appears during a job.
     - Costs: nothing visible.
     - Risks: the next incident again arrives with no data.
   - **(c) Remove the check** and rely on the probe's wire logs from session A.
     - Changes: less console noise.
     - Makes impossible: any in-app data from a real job.
   - **(d) Live, but kept as a job trail shown only at job end.**
     - Costs: a larger change, with a new place to show it.
     - Changes: less noise during the job.
5. **Recommendation: (a).** It is the only one that produces data from real jobs, which is what the Parking Lot entry is waiting on. If this is wrong, the cost is some console lines that one revert removes.
6. **Reversibility and urgency:** fully reversible. If nothing is decided for a month, E3 waits and nothing else blocks on it. The orchestrator may treat (a) as plumbing under the 2026-09-10 status-only ruling; if it does, it records that in the Ted brief.
