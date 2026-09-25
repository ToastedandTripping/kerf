# Kerf evidence E3: the spindle-drop check runs during jobs, says only what the controller reported, names the last line sent, and tallies every job

**Lifted from:** `/home/leesalo/marvin/state/audits/gap-2026-09-24/kerf/PLAN-silent-drop-and-evidence.md` §E3 (critic `PLAN-silent-drop-and-evidence-critic.md`, CONCERN, folded).

**Lineage:** `.claude/plans/kerf-relay-plan.md` §C2 (tests 1-4); critic `kerf-relay-plan-critic.md` (store collision note). Where this file and a relay-plan body differ, this file wins. On anything this file does not cover, the parent wins.

**This lift changes the parent's premise.** The parent assumes the check can fire during a job. It cannot, as read below. The change here is therefore wider than "the `FS:` block only". It needs the answer to the decision at the end before Stage 1. The implementation sections are written for the recommended option; "Under the other options" at the end of §Change says what changes for each of the others.

**Citations:** first read at `a6ddc3a`; re-read for the critic fold at `10be8a2` on session branch `marvin/kerf-gap` (`git diff --stat caa0dcc HEAD -- src src-tauri` is empty) on 2026-09-25. **Line numbers are orientation only.** S1 inserts 130 lines into `connection.ts` after `connectingPromise` (`@@ -84,0 +85,130 @@` on `relay/kerf-safety-s1`), so every `connection.ts` line number below `:84` moves once S1 lands. Every edit, mutant anchor and review check in this plan is anchored on quoted text, not on a line number.

- **Relay id:** `kerf-evidence-e3`
- **Branch:** `relay/kerf-evidence-e3`
- **Tier:** Standard. 5 files, one root (`src/`). No UI render change, so no Jen pass. The parent's five-file note stands: the new module keeps the change out of the store files that R1 and safety S4b edit. The module keeps the parent's name, `lastSentLine.ts`, because the parent's `/goal` done condition checks for that path. It now also holds the drop detector's state and the per-job tally, and its header comment says so.

## Intent (grilled)

Grill skipped. The intent comes from the parent's Intent and from ROADMAP Parking Lot "Laser-stops-firing root cause" (`ROADMAP.md:486-489`): "Head keeps moving but laser goes dark mid-job ... root cause investigation blocked on that data." It is bound by DECISIONS 2026-09-10 "Hardware evidence for this program is status-only".

Summary:
- The next "laser stopped" report must arrive with console data: what the controller reported, when (wall-clock time), and which job line had most recently been sent.
- The line must say only what the controller reported. It must not suggest what the beam did.
- It must not bury itself or Kerf's other warnings. Reported spindle 0 is routine on Kerf's own jobs (Diagnosis 3), so the check must not add warning-level lines on ordinary jobs.
- Silence must be recorded. Every job ends with one tally line, including a zero, so "the controller reported no drop" is written down and does not have to be inferred from a missing line.
- No stop, no interlock, no new store field, no new store subscription.

## Existing plans reviewed

Checked 2026-09-25 with `ls`:
- Primary `.claude/plans/`: 23 files plus `archive/` (3).
- Session branch at `10be8a2`: 34 files plus `archive/` (the E2, E3 and E5 plans and their critics have landed since the first read).
- Audit directory: 9 files.

**Relays in flight:**
- `kerf-refresh-cut-vs-screen` (R1): viewport, geometry, store, fileOps, `App`, `svgExport`, `geometryActions`. No overlap: E3 edits no store file.
- `kerf-evidence-e1a`: `gcodeGen.ts` and its test. No overlap.
- `kerf-evidence-e2` (`scripts/`, `docs/`) and `kerf-evidence-e5` (`src-tauri/`): no overlap.
- **`kerf-safety-s1`**: `canStartJob.ts`, `MaterialTestDialog.tsx`, `JobActionBar.tsx`, `GrblSettingsDialog.tsx`, `connection.ts`, `canStartJob.test.ts`, `connection.test.ts`, `machineJobLoop.test.tsx`. **This overlaps E3 in two files.** S1's branch (`relay/kerf-safety-s1`, head `df437ce`, merge-base `a6ddc3a`, read 2026-09-25) changes these regions of `connection.ts`:
  - it inserts 130 lines of helpers after `let connectingPromise …` (`@@ -84,0 +85,130 @@`);
  - it adds five lines before `send()`'s `invoke` and one after `send()`'s position block;
  - it rewrites the settings region (`enableLaserMode`, the readback, `@@ -592` to `@@ -710`) and adds `queryGrblSettings` as the object's last method.

  In `connection.test.ts` it changes the `from "../connection"` import line (`:11`) and appends a `describe` after `:714`. E3 touches none of those lines. Its `send()` edit sits between S1's two `send()` hunks, and the anchors are still present on S1's branch (`if (r.startsWith("<")) {`, `lastStatusReport = r;`).

**Rebase expectation:** E3 dispatches **after S1 merges** and branches from the merged tree. If it must start earlier, it rebases on S1 before Stage 2.
- Every E3 edit is anchored on text: the `if (r.startsWith("<")) {` block inside `send()`'s response loop, the body of `getStatusReport`, the `// Spindle-drop diagnostic` block in `pollStatus`, the `prevSpindleSpeed` declaration with its doc comment, and `prevSpindleSpeed = null;` in `connect()`.
- The new test `describe` goes **immediately before** `describe("connection.send — RF-15 job epoch and refusal"`. The `from "../connection"` import is extended in place, which is safe once S1 has merged.

The safety plan's later batches S1b, S2 and S4c edit other lines of `jobStream.ts`/`jobStream.test.ts` and are not in flight. The Stage 0 re-check repeats this inventory.

## Diagnosis (verified)

1. **The check cannot fire during a job.**
   - It lives in `pollStatus`, in the block commented `// Spindle-drop diagnostic` (`connection.ts:392-417` at `10be8a2`).
   - `pollStatus` returns early on `if (jobPollingSuspended) return;`, and `connect()` wires that flag to `jobRunning` in the `useStore.subscribe((state) => { jobPollingSuspended = state.jobRunning; })` block ("Suspend polling automatically when a job is running").
   - `jobRunning` is set true by every job door: `JobActionBar.tsx:80` (START), `:167` (FRAME), `MaterialTestDialog.tsx:413`, `:445`. All four run through `streamJob`. It stays true through draining (`jobSession.ts:123-181`). `session.end` releases it after the drain (`jobStream.ts:299` buffered, `:436` per-line).

   So during every job the status reports arrive by other routes, none of which runs the check:
   - **Per-line:** in-pump reports come back in `send()`'s responses. They are used for position only.
   - **Buffered:** channel `status` events are used for position only (`jobStream.ts:177-189`).
   - **Draining:** `session.drain` polls `getStatusReport()` (`jobSession.ts:136`, `:156`), which returns the raw string and checks nothing. It has no other production caller.

   A test driven through `pollStatus` (the parent's "pattern at `connection.test.ts:117-148`") passes in vitest because the `pollStatus` tests never set `jobRunning` true while a `connect()` subscription is live. It certifies a path that production never takes during a job. **The parent's statement "warns once when `FS:` spindle speed drops to 0 during Run" is true only outside jobs.** Correction to the critic's claim 8: the test file does call `connect()` (`connection.test.ts:358`, `:387`, `:401`, `:433`, `:658`). The subscription such a test leaves behind would suspend `pollStatus` for any later test that sets `jobRunning` true, so the E3 `describe` seeds `jobRunning: false` explicitly.
2. **On the owner's controller the condition occurs on an ordinary cut.** In the committed capture:
   - During `ring_M4_wait_idle_before_switch`, M4 is active, the last `G1` of the ring is executing, and the controller reports `<Run|MPos:20.000,-37.650,…|FS:0,0>` while the position keeps advancing to `-20.038` (`scripts/probe-20260914-153729.log:216-218`). The previous report is `FS:7657,6` (`:214`), so today's condition would fire.
   - The same happens in each of the five repetitions (`:216`, `:370`, `:522`, `:676`, `:830`, each inside that variant, verified).
   - Feed reads 0 too, while the head moves.
   - Those reports carry `Bf:127`. On this 127-block planner that means the queue is empty. The controller reports spindle 0 and feed 0 while its final queued move is still executing. Every job ends by emptying the queue, so the drain's polls can land in exactly this state at the end of any job.
   - Under M4 the reported spindle follows head speed. `M4 S10` at `F12000` reports `FS:3208,3`, `FS:4034,3`, `FS:7657,6` (`:210`, `:212`, `:214`). A slow corner at low power can therefore report 0 while power is commanded. This is inferred from three reports, not measured at a corner.

   So a live check prints on ordinary jobs. The existing text ("laser may have stopped firing") states a beam inference that the status-only ruling forbids. **The parent did not consider this.**
3. **Kerf's own G-code commands spindle 0 between every burn** (critic X3.1, verified in `src-tauri/src/engine/gcode_gen.rs`).
   - Scan lines: every line emits `G0` to its overscan start (`:270`), a `G1 … S0` acceleration overscan (`:290`), the burn, `M5` (`:323`), and a `G1 … S0` deceleration overscan (`:336`).
   - Vector paths: `M5` after every path (`:879`), then `G0` to the next one (`:586` with lead-in, `:622` without).
   - Perforation and tab gaps add `M5` then `G0` inside a path (`:693-700`, `:775`). Fill paths do the same at `:1084` and `:1150`. (The critic cited `:693-700` for general transits. That is the perforation branch; the general per-path `M5` is `:879`.)

   A raster fill of N scan lines therefore commands N spindle-to-zero transitions in Run state, and a vector job commands one per path. The capture shows Run with `FS:0,0` during probed rapids after `M5` (`:68`, `:845`, `:909`, `:972`). **Reported spindle 0 during Run is the normal rhythm of a Kerf job, not a fault signature.**
4. **How often Kerf asks, which bounds how often the line can print.** Both streaming paths send `?` only on a read-timeout tick, after a full second with no byte from the controller. That is the timeout branch of `run_pump` and of the buffered loop in `src-tauri/src/commands/serial_pump.rs`; the port timeout is 1000 ms (`serial.rs:384`).
   - While the planner is full, the wire goes quiet only while a single move takes over a second. Streaming samples therefore land about once a second, inside long moves: long burns (S > 0) and long travels (S 0). Short scan-line turnarounds are rarely sampled while streaming.
   - During the drain, `getStatusReport` polls every 200 ms for up to 30 s (`jobSession.ts:79-81`). That is where turnarounds and the queue-empty report get sampled.
   - A drop needs two samples, one with S > 0 and then one with S 0. So the tree bounds a print-every-drop design at one line per two samples: under about 0.5 a second while streaming and about 2.5 a second in the drain.
   - The ceiling for a 20-minute job is several hundred lines. **The actual count on Lee's jobs has never been measured.** The critic's "hundreds per job" is this ceiling, not an expected figure. The design below does not depend on which it is.
5. **The console keeps 501 lines, and per-line jobs fill it.**
   - `addConsoleLine` keeps the last 500 lines plus the new one (`src/app/store/index.ts:635`).
   - In per-line mode (the default), `send()` echoes every job line as `sent` (`store.addConsoleLine(command, "sent")`) and every `ok` as `received`. So the console holds roughly the last 250 job lines.
   - A mid-job line is on screen when it happens and when STOP is pressed right after. It is gone a few hundred job lines later. A line printed at job end is the only one guaranteed to be on screen once the job is over.
   - Buffered mode echoes no job lines, so there the drop lines would make up most of the console.
6. **What the store and the streamers hold.**
   - The store holds only `jobProgress`, a fraction (`storeTypes.ts:183`).
   - The per-line loop has `lines[i]` in hand (`jobStream.ts:352`).
   - The buffered path gets `event.lineIndex` from throttled progress events (`jobStream.ts:161-166`; throttle 50 ms, `serial_pump.rs:446`). The final line's event is sent unconditionally (`serial_pump.rs:617-619`, `|| send_cursor == lines.len() - 1`). The index counts lines after Rust's filter, which trims and then drops empty and `;`-leading lines (`serial.rs:825-830`). The per-line TS filter does not trim before its `;` test (`jobStream.ts:326`).
7. **The per-line record must precede the send.** In-pump reports arrive while `send(lines[i])` is awaited. A record written after the send (the parent's "after the per-line send at `:352`") would name line `i-1` in the check that runs inside that send.
8. **A throw inside `send()`'s `try` ends the job.** `send()`'s `catch` turns any exception into `["error:disconnected"]`. The per-line loop reads that as a dead port: it marks `portDisconnected`, routes through `emergencyStop`, then `disconnect()`s (`jobStream.ts:380-390` and the post-loop). A diagnostic that throws inside `send()` would stop the job and drop the port mid-cut (critic core 6, verified). The drain site is benign: a throw lands in drain's own `catch` and polling continues (`jobSession.ts:166-168`).
9. `prevSpindleSpeed` is module state in `connection.ts`. It is reset only on connect, and its doc comment ("Managed by the snapshot consumer now; … retained for the send() in-pump position-only path") is stale. No test mentions the check (`grep -rn "stopped firing" src` hits only the two lines in `pollStatus`).

## Change (option B of the decision below: quiet drop lines plus a job tally)

### 1. `src/lib/machine/lastSentLine.ts` (new; imports only `useStore`)

**Header comment:** "Per-job evidence for the spindle-drop check: the last job line sent, the drop detector's previous sample, and the job's tally. Status only: nothing here says what the beam did."

**Module state:**
- `prevSpindleSpeed: number | null`
- `lastSent: { index: number; text: string } | null`
- `tally: { samples: number; drops: number; first: DropMark | null; last: DropMark | null }`, where `DropMark = { time: string; line: string }`

**Functions:**
- `setLastSentLine(index: number, text: string)` and `getLastSentLine()`.
- `bufferedJobLines(gcode: string): string[]` is `gcode.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith(";"))`. It mirrors `serial.rs:825-830`, so a buffered `lineIndex` maps to the text Rust sent.
- `parseReportSample(report: string): SpindleSample` returns `{ state, feed, spindle }`. `state` is the lowercase token before the first `|` or `:`. Feed and spindle come from `FS:f,s` and are `null` when absent.
- `resetSpindleDrop(): void` sets `prevSpindleSpeed = null`. It is a production function, called by `connect()` and by `startJobEvidence()`.
- `startJobEvidence(): void`. Its body is exactly two statements, `resetSpindleDrop();` then `clearJobRecord();`, where `clearJobRecord()` empties `lastSent` and the tally. It is called once per job by `streamJob`. The job-start reset of `prevSpindleSpeed` makes a drop a within-job transition by construction (critic core 3c, X5).
- `endJobEvidence(label: string): void` builds the tally line, prints it with `useStore.getState().addConsoleLine(summary, "info");`, then calls `clearJobRecord();` on the next line. A no-job drop after the job therefore never names the finished job's line.
- `noteSpindleSample(input: string | SpindleSample): void` is **total by construction** (critic core 6). Its whole body, including parsing a raw string, sits inside one `try { … } catch (e) { console.error("Spindle-drop evidence failed:", e); }`. It returns nothing and never throws, so no caller's control flow can depend on it. Body, in order:
  1. `const s = typeof input === "string" ? parseReportSample(input) : input;` Return if `s.spindle` is null or not finite.
  2. `if (s.state === "run") tally.samples += 1;`
  3. The drop condition is today's, unchanged: `s.state === "run" && prevSpindleSpeed !== null && prevSpindleSpeed > 0 && s.spindle === 0`.
  4. On a drop: `tally.drops += 1`. Build the line reference **once**, `const ref = lastSent ? `#${lastSent.index + 1} "${lastSent.text}"` : null;`. Both the mark and the drop line's `where` use `ref`, so the template literal occurs exactly once in the file and E3-M4/M5 have unique anchors (round-2 residual 4). The mark is `{ time: clock(), line: ref ?? "none" }`. Set `tally.first ??= mark; tally.last = mark;`. Then `console.info(text)` **before** `useStore.getState().addConsoleLine(text, "info")`.
  5. It ends with `prevSpindleSpeed = s.spindle;`.
- `clock()` returns local wall-clock `HH:MM:SS`, built from `getHours`/`getMinutes`/`getSeconds` with zero padding. It uses no locale formatting, so tests are deterministic under `vi.setSystemTime`.
- `_testResetJobEvidence(): void` is for tests only. It assigns all three pieces of state directly, without going through `startJobEvidence`, so a mutant inside `startJobEvidence` cannot also weaken the test reset.

**The drop line** (console type `info`, one per drop):
> `Controller reported spindle 0 during Run at ${time} (previous report S${prev}, feed ${feed ?? "unknown"}). Status only: this is what the controller reported, not whether the beam emitted. Last job line sent: ${where}.`

`${where}` is `${ref} (the controller may still be executing earlier lines)` when `ref` is set, or `no job line recorded`. It never rebuilds the `#n "text"` literal.

**The job tally** (console type `info`, exactly one per job, on every exit that returns, including zero):
> `${label}: ${drops} of ${samples} status reports during Run showed spindle 0 (status only, not beam output).`

When `drops > 0` it continues: ` First at ${first.time}, last line sent ${first.line}. Last at ${last.time}, last line sent ${last.line}.`

**Why `info` and not `warning`:** by Diagnosis 2 to 4, reported spindle 0 happens on ordinary jobs. Kerf's own spindle-off commands occur on every job. The queue-empty report was measured in all five repetitions of one M4 program, and every job ends by emptying its queue, so it is likely near the end of many jobs, though that was not measured beyond that program. A warning would likely turn yellow on most jobs, including the "first drop only" variant the critic proposed. That degrades the channel that also carries "Connection lost" and ALARM (critic X6). The text, the time and the tally carry the evidence, not the colour. Changing it is one word (E3-M19) if Lee picks otherwise.

- The old text is removed. It is "laser may have stopped firing", in both the `console.warn` and the `addConsoleLine` call in `pollStatus`.
- Planner depth is deliberately not quoted as a number. The owner's is 127, stock is 15, and the host does not know which it is talking to.

### 2. `src/lib/machine/connection.ts`

- Import `{ noteSpindleSample, resetSpindleDrop }` from `./lastSentLine`.
- **Delete the `prevSpindleSpeed` declaration with its stale doc comment.** That is the block from `/** Track previous spindle speed for drop-to-zero diagnostic.` through `let prevSpindleSpeed: number | null = null;`. The state now lives in `lastSentLine.ts`, so the stale comment goes with it (critic core 10). The block sits above `connectingPromise`, and S1's insertion begins after `connectingPromise`'s declaration, so they do not touch. The parent's "must not edit `:75-81`" rule is withdrawn: S1's hunk is after `:84`, and E3 follows S1 anyway.
- `connect()`: `prevSpindleSpeed = null;` becomes `resetSpindleDrop();`. The comment above it stays.
- `pollStatus`: under `if (accepted && outcome.snapshot)`, the `// Spindle-drop diagnostic` block's body becomes one call, `noteSpindleSample({ state: typeof snap.state === "string" ? snap.state : null, feed: snap.feed, spindle: snap.spindle })`. The block comment is reworded to "Spindle-drop evidence (status only); fed here when no job is running". The `typeof` guard is needed because hold and door states are objects (`machineStatus.ts:18-28`).
- `send()`: inside the `if (r.startsWith("<")) {` branch of the response loop, **before** `lastStatusReport = r;`, add `noteSpindleSample(r);`. It runs once per report, in order. This is the per-line job path. Because the function is total, nothing it does can reach `send()`'s `catch` (Diagnosis 8).
- `getStatusReport()`: after the events loop, add `if (outcome.status.startsWith("<")) noteSpindleSample(outcome.status);`. This is the drain path, and it needs no `jobSession.ts` edit.
- **Untouched:** everything else. `if (jobPollingSuspended) return;` and the `useStore.subscribe((state) => { jobPollingSuspended = state.jobRunning; })` block are not edited, because they keep `?` off the wire between job lines. `_testResetPollFailures` is not edited. No test hook is added to this file.

### 3. `src/lib/machine/jobStream.ts`

- Import from `./lastSentLine`.
- **`streamJob`, immediately before `const mode = getStreamingMode();`:** add `startJobEvidence();`. This covers both paths.
- **Per-line:** immediately **before** `const responses = await machineConnection.send(lines[i], …)`, add `setLastSentLine(i, lines[i]);`.
- **Buffered:**
  - compute `const sentLines = bufferedJobLines(gcode);` once at the top of `streamJobBuffered`;
  - in the `progress` case, add `setLastSentLine(event.lineIndex!, sentLines[event.lineIndex!] ?? "");`;
  - in the `status` case, inside `if (event.report)` and before the position update, add `noteSpindleSample(event.report);`.
- **Job end:** add one line immediately before each of the two `// B3: the session handles cleanup.` comments.
  - Buffered: `endJobEvidence(opts.label); // E3: buffered job end`
  - Per-line: `endJobEvidence(opts.label); // E3: per-line job end`

  The trailing comments give each call a unique mutation anchor. Both paths reach these lines on every exit that returns (complete, cancelled, alarm, error, refusal, disconnect). They come after the drain, so the drain's reports are counted, and before `session.end` releases `jobRunning`, so `pollStatus` cannot interleave. Verified: no existing test asserts the exact console contents of a job. A grep of `consoleLines` and `texts()` with `toEqual`/`toHaveLength` across the job test files finds nothing, so the added tally line does not red the baseline. Stage 1 confirms this with the baseline run.
- No other line changes.

### 4. Tests

- **`src/lib/machine/__tests__/connection.test.ts`:** a new `describe("spindle-drop evidence (E3)")`, placed immediately before `describe("connection.send — RF-15 job epoch and refusal"`.
  - It extends the existing `from "../connection"` import in place (E3 lands after S1). It adds one `import … from "../lastSentLine"`, which is a different module, not a duplicate. No duplicate-import rule is configured in `eslint.config.js` either way.
  - `beforeEach` seeds the store with `jobRunning: false` explicitly (Diagnosis 1) and calls `_testResetJobEvidence()`.
- **`src/lib/machine/__tests__/jobStream.test.ts`:** a new `describe` block only. Its `beforeEach` calls `_testResetJobEvidence()`.
  - Per-line jobs mock `serial_send` outcomes whose `responses` carry in-pump `<Run|…|FS:…>` lines before the `ok`.
  - Buffered jobs set `localStorage.streamingMode = "buffered"`, capture the `Channel` from the `serial_stream_job` invoke args, and call `channel.onmessage` with `progress` and `status` events before resolving.
  - Drains are answered with `<Idle|…>`.
- **`pollStatus` calls in `jobStream.test.ts` carry a snapshot** (round-2 residual 5). That file's existing `serial_get_status` mocks return `{ status, events }` with no `snapshot` (for example `jobStream.test.ts:231-236`). `pollStatus` samples only under `accepted && outcome.snapshot`, so such a fixture would make E3-M13, M15 and M16 survive.
  - The new `describe` defines a local helper in the `makeStatusOutcome` shape (`connection.test.ts:45-95`, which is not exported): `{ status, events: [], kind: "report", snapshot: { epoch: 1, seq: ++seq, state, positionKind, position, wco: null, feed, spindle, accessory: "Unknown", units: "Unknown", raw, unknownFields: [] } }`.
  - Its `beforeEach` calls `resetStatusConsumer()` (from `../machineStatus`), so epoch and seq restart monotonic. It also seeds `machineConnected: true`, `spindleSpeed: 0`.
  - Every one of these tests proves its `pollStatus` fixture was accepted. E3-M13 and E3-M16 assert that the between-jobs drop line printed. E3-M15 asserts `useStore.getState().spindleSpeed === 500` after its `pollStatus` call. The consumer writes it only for an accepted snapshot (`machineStatus.ts:210-214`).
- Tests that assert a time use `vi.useFakeTimers({ toFake: ["Date"] })` and `vi.setSystemTime(new Date(2026, 8, 25, 9, 3, 7))`, then `vi.useRealTimers()`. Only `Date` is faked, so the drain's `setTimeout` still runs.

### Under the other options (what changes if Lee does not pick B)

- **A (every drop at warning, no tally):**
  - `noteSpindleSample` prints at `warning`, and E3-M19 flips to assert `warning`.
  - `endJobEvidence`, its two call sites and the tally state are dropped. `startJobEvidence` keeps the prev reset and the record clear.
  - Rows E3-M13, M16, M17, M18 and M21 are dropped, along with the tally lines in Verification. Everything else stands.
- **C (tally only):**
  - `noteSpindleSample` tallies but prints nothing.
  - Rows E3-M4, M5, M11, M12 and M20 re-point at the tally's first/last fields. E3-M19 asserts that no drop line appears during the job.
  - The browser check shows only the tally.
- **D (keep it out of jobs):**
  - E3 shrinks to `connection.ts` and `connection.test.ts`. Either the `pollStatus` text is reworded to status-only with tests through `pollStatus` (the audit plan as written), or the block and `prevSpindleSpeed` are deleted.
  - There is no new module, no `jobStream.ts` edit, and no battery row that needs a job.
  - The Stage 3.5 ROADMAP line then says the check still cannot fire during jobs. The parent's `/goal` done condition names `lastSentLine.ts`, so under D the parent's done condition is amended.

## Tests and mutants

**Battery spec `kerf-evidence-e3`:**
- `test_command`: `["npx","vitest","run","src/lib/machine/__tests__/connection.test.ts","src/lib/machine/__tests__/jobStream.test.ts"]`.
- The baseline must be green; the battery refuses a red one.
- Each id is one contiguous find/replace whose `find` occurs exactly once in its file (`mutation-battery.mjs:1773-1780`). A `find` may span adjacent lines. No mutant is stacked. The spec takes the exact post-`prettier` text.
  - E3-M1 and E3-C1 share the anchor `s.spindle === 0`. E3-M13 and E3-M15 share `startJobEvidence`'s two-statement body as their `find`, with different replacements. Each is its own single-edit mutant, run separately.
  - E3-M4 and E3-M5 edit the `ref` template, which is built once and reused by the mark and by `where`, so each `find` occurs once. E3-M12 and E3-M20 edit the drop template. Each of the four has a distinct `find`.
  - E3-M17 and E3-M18 each `find` their full line, including its `// E3:` comment.
  - E3-M16's `find` spans the tally's `addConsoleLine(summary, "info");` and the `clearJobRecord();` that follows it. E3-M19's `find` is `addConsoleLine(text, "info")`. The two do not overlap.
- A control is a test that is green at baseline, whose named wrong variant turns it red. It appears in the journal as `killed`.

**How each goes red:** every test drives a production entry point: `pollStatus`, `send`, `getStatusReport`, `streamJob` in both modes, or the module's exported functions (E3-M7's pure half only). Each asserts on `useStore.getState().consoleLines` or on `send()`'s return value. No mutant is caught by a type error.

| Id | Test | Wrong variant (one edit) |
|---|---|---|
| E3-M1 | `pollStatus` with Run `FS:1000,500` then Run `FS:1000,0` (no job): exactly one line containing "spindle 0 during Run" | Replace `s.spindle === 0` in the condition with `false` |
| E3-M2 | `pollStatus` with Run `FS:1000,500` then Idle `FS:0,0`: no drop line | Delete `s.state === "run" && ` from the drop condition (the occurrence followed by `prevSpindleSpeed !== null`) |
| E3-M3 | After the drop, two more Run `FS:1000,0`: still exactly one drop line | Delete `prevSpindleSpeed = s.spindle;`. The kill shows as **no drop line at all** (prev stays null), not as two |
| E3-M4 | Per-line job of three lines; line 2's in-pump reports are `FS:1000,500` then `FS:1000,0`: the drop line contains `#2` | Delete `#${lastSent.index + 1} ` from the `ref` template (built once) |
| E3-M5 | Same job: the drop line contains line 2's text verbatim | Delete ` "${lastSent.text}"` from the `ref` template |
| E3-M6 | Per-line job whose in-pump reports are Run `FS:0,0` on line 1 and Run `FS:0,0` on line 2: no drop line (0 to 0 is not a drop) | Delete `prevSpindleSpeed > 0 && ` |
| E3-M7 | `bufferedJobLines("G0 X0\n  ; note\n\nG1 X1 S500\nG1 X2")` equals `["G0 X0","G1 X1 S500","G1 X2"]`; and a buffered job with that program, a `progress` event at `lineIndex 2` and a drop `status` pair names `"G1 X2"` | Delete `.map((l) => l.trim())` |
| E3-M8 | Per-line job with in-pump drop reports: one drop line (the job path is live) | Delete `noteSpindleSample(r);` in `send()` |
| E3-M9 | Buffered job with `status` events `FS:1000,500` then `FS:1000,0`: one drop line | Delete `noteSpindleSample(event.report);` |
| E3-M10 | `getStatusReport()` answering Run `FS:1000,500` then Run `FS:1000,0`: one drop line (the drain path) | Delete `noteSpindleSample(outcome.status);` |
| E3-M11 | The E3-M4 job: the drop line names `#2`, not `#1` (the record precedes the send) | Replace `setLastSentLine(i, lines[i])` with `setLastSentLine(i - 1, lines[i - 1])` |
| E3-M12 | The drop line contains "Status only" and does not contain "may have stopped firing" | Replace `Status only: this is what the controller reported, not whether the beam emitted.` with `Laser may have stopped firing.` |
| E3-M13 | A per-line job completes; then `pollStatus` (no job, snapshot-carrying fixture) sees Run `FS:1000,500` then Run `FS:1000,0`, and the test asserts the between-jobs drop line printed with `no job line recorded`; then a second per-line job with no in-pump reports: its tally reads `0 of 0` | In `startJobEvidence`, replace the two-statement body with `resetSpindleDrop();` alone. The tally then carries `1 of 2` |
| E3-M14 | (guard) `console.info` is spied to throw for text containing "spindle 0"; `send()` whose mocked responses carry Run `FS:1000,500`, Run `FS:1000,0` and `ok` returns exactly those responses, and no console line starts "Send failed" | Replace `console.error("Spindle-drop evidence failed:", e);` with `throw e;` |
| E3-M15 | `pollStatus` (no job, snapshot-carrying fixture) sees Run `FS:1000,500`, and the store's `spindleSpeed` reads 500 (fixture accepted); then a per-line job whose first in-pump report is Run `FS:1000,0`: no drop line, and the tally reads `0 of 1` | In `startJobEvidence`, replace the two-statement body with `clearJobRecord();` alone (the job-start prev reset is gone) |
| E3-M16 | After a per-line job whose last line is `G1 X2 S500`, `pollStatus` (no job, snapshot-carrying fixture) sees a drop: the drop line prints and says `no job line recorded` and does not contain `G1 X2` | In `endJobEvidence`, delete the `clearJobRecord();` that follows the tally's `addConsoleLine` |
| E3-M17 | Per-line job (label `Job`) with reports Run `FS:1000,500` (line 1), Run `FS:1000,0` (line 2), Run `FS:1000,0` (line 3): exactly one tally line, starting `Job: 1 of 3 status reports during Run` | Delete `endJobEvidence(opts.label); // E3: per-line job end` |
| E3-M18 | Buffered job with `status` events `FS:1000,500` then `FS:1000,0`: exactly one tally line containing `1 of 2` | Delete `endJobEvidence(opts.label); // E3: buffered job end` |
| E3-M19 | (level) The E3-M8 job: the drop line's type is `info`, and no line of type `warning` contains "spindle" | Replace `addConsoleLine(text, "info")` with `addConsoleLine(text, "warning")` |
| E3-M20 | (time) With the system time set to 09:03:07, the E3-M8 job's drop line contains `at 09:03:07` and its tally contains `First at 09:03:07` | Delete ` at ${time}` from the drop template |
| E3-M21 | (denominator) The E3-M17 job: the tally reads `1 of 3`, not `1 of 0` | Delete `tally.samples += 1;` |
| E3-C1 | (control) Steady cutting (`FS:1000,500`, then `FS:1000,300`, then `FS:1000,500`) through `send()` never prints a drop line | Replace `s.spindle === 0` with `s.spindle < prevSpindleSpeed` |

## Verification

- `npx vitest run src/lib/machine/__tests__/connection.test.ts src/lib/machine/__tests__/jobStream.test.ts`
- `npx tsc --noEmit`
- `npm test`: the baseline measured at relay start plus the new tests, none weakened.
- `npm run lint` with no new warnings, and `npm run format:check`.
- Battery journal: every E3-M* and E3-C* id `killed`; `survived`, `errored` and `CONTROL_RED` all 0.
- **Razor, by text and not by line number** (the lines move about 130 after S1):
  - `if (jobPollingSuspended) return;` and the `useStore.subscribe((state) => { jobPollingSuspended = state.jobRunning; })` block have no hunk in `git diff <merge-base>..relay/kerf-evidence-e3 -- src/lib/machine/connection.ts`.
  - `noteSpindleSample`'s entire body, including the parse, is inside its `try`.
  - The four feeds are the only callers (`grep -rn "noteSpindleSample(" src`, non-test).
  - `grep -rn "stopped firing" src` is empty.
  - No added line carries a controller identity string.

**Browser** (`npm run dev` + Chrome DevTools MCP):
- In `evaluate_script`, run `const e = await import('/src/lib/machine/lastSentLine.ts')`.
- Call `e.noteSpindleSample("<Run|MPos:0,0,0|FS:1000,500>")`, then `e.noteSpindleSample("<Run|MPos:0,0,0|FS:1000,0>")`, then `e.endJobEvidence("Test")`.
- Screenshot the console panel. It should show one grey drop line with a time and "no job line recorded", then `Test: 1 of 2 status reports during Run showed spindle 0 …`.
- The job paths are not browser-reachable, because the dev server cannot reach `invoke`. State that.

**Hardware-only (named; lands on the owner's card through E4):**
- On the next job that "goes dark", the owner notes the wall-clock time he saw it. After the job he copies the job's tally line and any drop line within a minute of that time.
- A tally of `0 of N` is recorded as such. It means the controller reported no drop at N sampled moments. It does not mean the beam kept firing, and it does not mean the beam stopped.
- Expect drop lines and a non-zero tally on ordinary jobs too (Diagnosis 2 and 3). They are evidence to correlate, not an alarm.

## What E3 does not satisfy

- **The root cause of "laser stops firing."** This batch only adds data.
- **Any statement about the beam.** The status-only ruling forbids it.
- **The second fault shape.** If the beam goes dark while the controller keeps reporting S > 0, which is the gap the 2026-09-10 ruling names, E3 prints no drop line. The tally's `0 of N` records that the controller reported no drop at the moments sampled. It says nothing about the beam, and nobody may read it as "the controller kept firing" or "the laser was fine".
- **The fault may not show as a reported drop at all.** Nothing yet shows that it does. The two 2026-09-14 reports had no console data, which is why this batch exists.
- **Sampling is sparse and biased.**
  - While streaming, a sample is taken only after a second of wire silence, so it lands inside moves longer than a second (`serial_pump.rs` timeout branches, 1000 ms port timeout). Short turnarounds are rarely seen.
  - During the drain, samples come every 200 ms (`jobSession.ts:79`) for up to 30 s.
  - A drop between samples is not seen.
- **"Last line sent" is not "line executing."** The controller may be many lines behind. The text says so.
- **The buffered record lags.** Mid-job it trails by up to 50 ms of sent lines, because of the progress throttle. It is exact at the final line (`serial_pump.rs:617-619`).
- **Mid-job lines scroll away.** The console keeps 501 lines, and per-line jobs echo about two per job line, so a mid-job drop line survives only about 250 job lines. The tally survives because it is printed last.
- **Under M4 a drop can be a slow corner at low power** (Diagnosis 2), not a spindle-off command.
- **The per-line and buffered filters still differ** (`jobStream.ts:326` vs `serial.rs:825-830`). The helper follows Rust for the buffered index only. The divergence is the parent's Parking Lot lead.
- **Frames and material tests get a tally line too.** One `info` line per run, by design (every job exit, one rule).

## Stage 3.5 obligations (orchestrator)

- **ROADMAP:** the Parking Lot entry "Laser-stops-firing root cause" (`:486-489`) gains no edit to its text. Append a new index line: `- **Spindle-drop evidence now recorded during jobs (E3)** — before E3 the diagnostic ran only when no job was running (polling is suspended during jobs). Kerf's own G-code commands spindle 0 at every scan-line end and path transit, and on the owner's controller Run+FS:0,0 also appeared when the queue emptied (capture 2026-09-14, five repetitions of one M4 program). So drops print at info with time and last line sent, and every job ends with a tally ("N of M status reports during Run showed spindle 0"). Evidence to correlate, not a failure signal; blind to a beam that goes dark while S stays > 0.`
- **ARCHITECTURE.md:** one line under the `connection.ts` entry: "The spindle-drop check is `noteSpindleSample` in `lastSentLine.ts` (total, status only). It is fed from `pollStatus` (no job), `send()` in-pump reports (per-line), `getStatusReport` (drain) and buffered `status` events, reset per job by `startJobEvidence`, and summarised per job by `endJobEvidence`."
- **E4's lift** (the owner test card, not yet lifted) must carry the Hardware-only steps above: the wall-clock time, copying the tally and nearby drop lines, and reading a zero tally as "no reported drop", never as a beam statement.
- **Parent Parking Lot lines** (written by E1a's 3.5): the per-line/buffered filter divergence line stands.

## Risks and rollback

- **Operator-visible:**
  - One `info` tally line at the end of every job, frame and material test.
  - One `info` drop line per sampled drop. Expect at least one on many jobs; the count is unmeasured, with a ceiling in the hundreds on long jobs (Diagnosis 4).
  - The check no longer prints any `warning`. The no-job case also moves from warning to info.
  - The wording disclaims any beam inference.
- **Failure of the check itself:** `noteSpindleSample` is total. A bug in it logs one `console.error` to devtools and changes nothing else: no job ends, no port drops (E3-M14).
- **Merge:** S1 overlaps two files. Rebase on S1, and keep both sides of any conflict, never dropping either. Anchors are text.
- **Module state:** all of it lives in `lastSentLine.ts`. `prevSpindleSpeed` is reset at connect and at every job start (E3-M15). The record and tally are reset at job start (E3-M13) and cleared after the tally prints (E3-M16). Tests reset through `_testResetJobEvidence`.
- **Rollback:** revert the relay merge commit. Nothing depends on E3 except E4's card text.
- **Irreversible steps:** none.

## Decision needed before Stage 1

1. **The decision.** Should Kerf record, during jobs, each moment the controller reports laser power at zero, and if so, how loudly?

2. **What exists today.** Kerf has a check that prints "WARNING: Spindle speed dropped to 0 during active job — laser may have stopped firing". It has never been able to print during a job. Kerf stops its regular status questions for the whole of every job, and the check only looks at those. When the laser went dark on 14 September, the console had nothing to show. Your parked "laser stops firing" item says the investigation is blocked on exactly this data.

3. **The tension.** Doing nothing new leaves the next incident as empty as the last. The audit plan as written would only add a line number to a message that still can't appear. But switching the check on runs into how Kerf writes its own jobs. Kerf sets laser power to zero at the end of every engraving line and before every travel move between shapes, and the controller reports that faithfully. So "power at zero" is the normal rhythm of every job, not a fault. Your 14 September trace adds a second source: the controller reported zero power and zero speed while the head was still finishing a move, at the moment its queue ran empty. That was measured on one test program, run five times, and it happened in all five. Every job ends by emptying its queue, so it probably happens at the end of many real jobs too, but nobody has measured that. Separately, your 10 September ruling says "a status report says what the software commanded and never what the beam emitted", so the old "laser may have stopped firing" wording has to go whatever you choose.

4. **Options.**
   - **(A) A yellow warning at every reported drop**, reworded to say it is only what the controller reported, with the last job line sent.
     - What changes: the check works during jobs.
     - Cost: a small build. The volume depends on how often Kerf asks the controller for status: about once a second during a job, five times a second while the machine finishes. Each warning needs two of those answers. On a long raster engraving that could reach several hundred yellow lines; on a short cut, a handful. Nobody has counted it on a real job.
     - Risk: the one warning that matters is buried among identical ones, and yellow stops meaning anything, including for "Connection lost" and alarms, which land in the same console. Mid-job lines also scroll off: the console keeps the last 500 lines, and a normal job already prints about two per job line.
     - Makes impossible later: nothing technically, but it trains you to ignore yellow.
   - **(B) The same record, kept quiet, plus a tally at the end of every job.**
     - What changes: each drop prints as a grey information line with the clock time and the last job line sent. When the job ends, however it ends, one line sums it up, for example "Job: 3 of 41 status reports during Run showed spindle 0", with the time and line of the first and last. A job with none says "0 of 41". This check prints no yellow at all.
     - Cost: the same five files as (A), plus one more function (the end-of-job summary and its counter), one added line at each of the two places a job ends, and five more automated checks than (A) needs. Also one extra grey line after every job and every frame.
     - Risk: the mid-job grey lines are as many as (A)'s yellow ones, just quieter. Grey can read as "nothing to see". The times and the tally are what you would compare against the moment you saw the laser go dark.
     - Makes impossible later: nothing. Grey to yellow, or dropping the mid-job lines, is a one-line change.
   - **(C) The tally only.**
     - What changes: nothing prints during the job. The end-of-job line gives the count and the first and last drop.
     - Cost: slightly less than (B). Console only, no new screen.
     - Risk: if the laser goes dark mid-job and you press STOP, nothing near that moment is on screen. Only the first and last drop are kept, so the one next to your incident is lost unless it happened to be one of those two.
     - Makes impossible later: matching a mid-job incident to a specific drop.
   - **(D) Keep it out of jobs:** either the audit plan as written (tests and a line number on a message that still cannot appear during a job) or delete the check.
     - What changes: nothing visible, or slightly less code.
     - Cost: the least.
     - Risk: the next "laser stopped" report again arrives with nothing from Kerf. The only data would come from the separate probe tool, which cannot run inside a real job.
     - Makes impossible later: in-app evidence from real jobs.

   None of the four can say whether the beam fired. If the laser goes dark while the controller keeps reporting normal power, none of them prints a drop. With (B) or (C), the tally at least writes down "0 drops", which tells you the controller never reported one. That is a fact about the controller, not about the beam.

5. **Recommendation: (B).** Its strongest advantage is that it keeps both kinds of evidence without turning yellow into noise: a line next to the moment you would press STOP, and a summary still on screen after the job. If it is wrong, the cost is some grey lines you do not read and one extra line per job. One revert removes it, and moving to (A) or (C) is a small edit.

6. **Reversibility and urgency.** Fully reversible: revert one merge. If nothing is decided for a month, this batch waits and nothing else waits on it. But any laser-dark incident in that month arrives with no console data, as the 14 September ones did. The decision is yours; the batch does not start until you choose.

## Critic fold (2026-09-25)

Critic: `kerf-evidence-e3-critic.md` (Fable). Verdict FAIL on X3 (the decision brief), with CONCERN on core 1, 3, 6 and 10 and on X6. The code plan was judged sound. Every must-fix was checked against the tree at `10be8a2` (and S1's branch at `df437ce`) before folding.

1. **Option (a)'s cost.** Verified in `gcode_gen.rs`: `G0` `:270`, `G1 … S0` `:290`/`:336` and `M5` `:323` per scan line; `M5` `:879` after every vector path, then `G0` `:586`/`:622`. Correction: `:693-700` is the perforation branch, not the general transit. Folded as Diagnosis 3, and the brief now prices (A) from it. Also verified what bounds the count: the pump asks only after a second of wire silence, and the drain every 200 ms. Diagnosis 4 states "hundreds" as the ceiling on a long job, never counted, rather than as an expected figure. The recommendation does not depend on the difference.
2. **The second fault shape.** Added to Intent, "does not satisfy", Hardware-only, the E4 obligation in Stage 3.5, and the brief (the paragraph after the options). The tally prints `0 of N` so the absence is written down. Also added: the fault may not show as a reported drop at all (critic assumption 4).
3. **Options repriced, (a′) added.** (D) is now priced as console-only. The critic's (a′) is option (B) and is recommended. Implementation, mutants and Verification are written for it, with a section on what changes under each other option. Rows E3-M13 and M15 to M21 were added (the critic asked for two: level and count). Beyond the critic, verified and folded as Diagnosis 5: the console's 501-line cap (`store/index.ts:635`) and the per-line echo of every sent line and `ok`. That is why the tally, not a mid-job line, is what survives a job.
4. **The `send()` guard.** Verified: `send()`'s `catch` returns `error:disconnected`, and the per-line loop then stops and disconnects. `noteSpindleSample` is made total instead of wrapping one call site, so one guard covers all four feeds. Parsing moved inside the guard: the function takes the raw string. Added E3-M14. With the guard inside the function, the buffered channel and drain notes are moot. Both are recorded in Diagnosis 8.
5. **Job-start reset of the previous sample.** Folded as `startJobEvidence()` → `resetSpindleDrop()`, and added E3-M15. E3-M6's fixture was rewritten: with the reset in place, the old cross-job fixture would survive the mutant. It now tests 0 to 0 inside one job.
6. **Razor's check by text.** Verification now names `if (jobPollingSuspended) return;` and the `useStore.subscribe` block, and checks them by diff hunk, not by line. The Citations note says all line numbers are orientation only.
7. **Buffered record lag.** Verified at `serial_pump.rs:617-619`. Added to Diagnosis 6 and to "does not satisfy".
8. **Import rule and E3-M3.** The separate-import rule is dropped, and the `../connection` import is extended in place. The critic's lint reason does not hold: `eslint.config.js` enables no duplicate-import rule. The change stands on the other reason, that E3 follows S1. E3-M3's kill now reads "no drop line at all".
9. **Stale comment.** Removed rather than rewritten: `prevSpindleSpeed` moves into the new module, so its doc comment goes with it. The "must not edit `:75-81`" rule is withdrawn. Citation nits verified and applied: S1's hunk is `@@ -84,0 +85,130 @@`, the drain spans `:123-181`, and on S1's branch the object's last method is `queryGrblSettings`. The "after the object" placement is also moot, since the function now lives in the new module.

Also corrected while re-reading:
- The critic's claim 8 ("no test calls `connect()`") is wrong: `connection.test.ts:358`, `:387`, `:401`, `:433`, `:658`. Diagnosis 1 now says so, and the E3 `describe` seeds `jobRunning: false`.
- S1 touches more of `connection.ts` than the first read listed (the settings region), and E3 touches none of it.
- The module keeps the name `lastSentLine.ts`, because the parent's `/goal` done condition checks that path.

Rejected:
- **The critic's warning level for the first drop per job.** Kerf's own spindle-off commands occur on every job, and the queue-empty report appeared in all five repetitions of the one measured M4 program. So the first drop would likely be yellow on most jobs. That is the X6 harm the critic names. All drop lines are `info`. The brief tells Lee it is a one-line change.
- **The optional 0 to >0 recovery lines.** They would double the volume, and the drop line's last-line text already shows the commanded `S`, so a drop against a line that commands power is visible without them.
- **The critic's primary fix for 6 (wrap the call inside `send()`).** It was offered with "or make `noteSpindleSample` total" as the alternative, which covers every feed with one guard and needs no call-site edit.

**Round 2 residuals** (critic CONCERN, no gating FAIL; all five folded):
1. **Self-authorisation struck.** Brief item 6 no longer lets the orchestrator treat (B) as plumbing. The 10 September ruling (`DECISIONS.md:148-151`) is about what hardware evidence can qualify, not about who decides console output. Item 6 now says the decision is Lee's and the batch waits for it.
2. **Queue-empty claim hedged.** Verified that the capture holds one M4 ring program run five times (`:216`, `:370`, `:522`, `:676`, `:830`). The brief's item 3, the "Why `info`" paragraph, the ROADMAP line and the first rejection now claim only that, and call the end-of-every-job case likely but unmeasured.
3. **Counted cost.** (B) over (A) is one exported function plus the tally state (`endJobEvidence`), two call lines (one per job end) and five battery rows (E3-M13, M16, M17, M18, M21, the rows dropped under A in "Under the other options"). The critic's figure of seven counted every row the fold added, but E3-M15, M19 and M20 are needed under A as well.
4. **`ref` built once.** Verified that the risk was real: writing `#${…index + 1} "${…text}"` in both the mark and `where` would put the literal in the file twice and make both anchors ambiguous. Step 4 of `noteSpindleSample` now builds `ref` once, and `where` and the mark reuse it. The E3-M4/M5 rows and the anchor note are updated.
5. **Snapshot-carrying fixtures.** Verified: `jobStream.test.ts` status mocks have no `snapshot` (`:231-236`); `makeStatusOutcome` is local to `connection.test.ts` (`:45-95`, not exported); `pollStatus` samples only under `accepted && outcome.snapshot`; the consumer writes `spindleSpeed` only on an accepted snapshot (`machineStatus.ts:210-214`). §Tests now specifies a local helper of that shape, with `resetStatusConsumer()` in `beforeEach`. E3-M13 and M16 assert the between-jobs drop line printed, and E3-M15 asserts `spindleSpeed === 500`, so a rejected fixture cannot pass at baseline.
