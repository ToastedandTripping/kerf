# Kerf safety S2: the material test never arms a stationary beam

**Lifted from:** `/home/leesalo/marvin/state/audits/gap-2026-09-24/kerf/PLAN-safety-gate-class.md` §S2 (critic `PLAN-safety-gate-class-critic.md`, CONCERN, folded). The parent also put the Pause button in S2. Under Lee's 2026-09-25 ruling (Fold notes), only the generator half is kept.

**Lineage:** astra RF-1 (`/home/leesalo/marvin/state/audits/kerf-astra-2026-09-08/PLAN.md` addendum). The parent plan wins wherever this file is silent, except on the Pause button, where Lee's ruling wins.

**Citations:** re-read at `8c60666` on session branch `marvin/kerf-gap` (2026-09-25). S1 is merged (`df8883a`); S1b is not (no `relay/kerf-safety-s1b` branch).

- **Relay id:** `kerf-safety-s2`
- **Branch:** `relay/kerf-safety-s2`
- **Tier:** Standard. 5 files in one root (`src/`). One `.tsx` is touched (`MaterialTestDialog.tsx`), but only in its imports and by deleting the moved generator, so there is no visual change. If the relay's Jen trigger fires on any `.tsx`, Jen does a no-spec CONCERN pass that confirms no visual diff.

## Fold notes (critic `kerf-safety-s2-critic.md`, Fable, FAIL on core 3; X1 and X5 CONCERN)

**Lee ruled directly on 2026-09-25: "Leave the pause button for now but ensure we have a plan to make it function in the future."**

That ruling governs this fold.

- **What is removed.** The relabel ("STOP (no resume)"), every change to the Pause button, `handlePauseResume`, `pauseJob`, the proposed `handlePauseStop` and tooltip, the console string "Paused jobs cannot resume ...", and the `resumeJob` docs.
- **Where that work lives now.** The forward plan `.claude/plans/pause-resume-future.md`, which already quotes the ruling.
- **What S2 is now.** The generator half only:
  - `S0` on every mode line;
  - positive `S` only on `G1` motion words;
  - the border follows the chosen mode;
  - the pure-module move.
- **Decision `kerf-f2`** (relabel or remove) is overtaken by the ruling. Neither option ships. Stage 3.5 records it as answered, and proposes (never auto-writes) the ruling as a DECISIONS entry. The proposal is for the orchestrator to put to Lee.

**Critic must-fixes, as folded:**
1. **Make "same as STOP" true (core 3, X5): falls away.** S2 no longer touches the button.
   - The defect it found exists **today** on the unchanged Pause button, and is not fixed here. `pauseJob` (`jobStream.ts:47-57`) never calls `stopActiveSession()`, while `handleStop` (`JobActionBar.tsx:110`) does.
   - So a Pause press during the drain window is reported as an alarm stop (the owner's controller has `$22=1`) or as "Job complete" (a `$22=0` controller), not as cancelled.
   - Parked with its fix and mutant under Deferrals, owned by `pause-resume-future.md`.
2. **Correct the RESUME narrative: folded** into the facts only ("The Pause button today").
3. **Engine Parking Lot line: folded.** It is stated as an X1-class hazard on every M3 layer, with its own batch and golden-regeneration discipline.
4. **Commit-1 residue: folded** (Change §1, and Verification).
5. **String rule: falls away** (no button change).
6. **Console wording: falls away** (the string stays, per the ruling).
7. **Docs.** The relabel parts fall away: no "same as STOP" wording is written anywhere, no pause ARCHITECTURE delta, no test-card rewrite. The rest is kept:
   - the stale hold-wait comment at `jobStream.ts:348-354` is parked, not edited;
   - one Parking Lot line covers labels silently lost when the font fails to load.
8. **Nits: folded.** There are 42 plan files at fold time (39 when the critic counted, and 36 at first write). The synthetic-hold note is moot, because no button test remains.

**Mutants:** ids that survive keep their numbers. S2-M4 and S2-M7 are **dropped (Lee 2026-09-25 Pause ruling)**. The critic's S2-M8 is not added to S2: it moves to the Deferrals entry.

## Intent (grilled)

Grill skipped. The intent is taken from the parent's Intent, which cites:
- CHARTER "Done looks like" (1): "no cut dying mid-job and no silent G-code error"
- DECISIONS 2026-09-10: "Variable power (M4) is the default for every new layer; constant power (M3) exists for the stationary beam, not for cutting."

Summary for this batch:
- The material test is a cutting job, so nothing in it may fire the beam while the head stands still.
- Every `M3`/`M4` line it emits carries `S0`. Power appears only as the `S` word of a `G1` motion line.
- The border follows the power mode the operator picked, as the cells do. Today it is hard-coded to `M3` at full power.
- The Pause button is out of scope by Lee's 2026-09-25 ruling.

## Existing plans reviewed

**Inventory, checked with `ls` at fold time:** `.claude/plans/` holds 42 `.md` files plus `archive/` (3 files); the audit directory holds 9.

**Plans that name this batch's files** (a grep of every plan for `MaterialTestDialog`, `textGcode`, `materialTestGcode`):
- **Merged, so their edits are in this tree:** the fence plans, `kerf-evidence-e1a/e2/e3/e5`, `kerf-safety-s1`, `refresh-cut-vs-screen`.
- **`refresh-canvas-display.md` (in flight):** lists `MaterialTestDialog` as untouched. `git diff --name-only HEAD...relay/kerf-refresh-canvas-display` touches none of S2's 5 files. It does edit `src/lib/geometry/index.ts`, which `textGcode.ts` imports `sampleBezierPath` from, but not that function (its hunk starts at `:391`; the function is at `:669`). S2's tests assert no coordinates in any case.
- **`refresh-editing-shortcuts.md`:** "MaterialTestDialog and GrblSettingsDialog are covered by F7 without being edited" (`:367`).
- **`kerf-safety-s1b.md`:** edits `jobStream.ts` only. S2 no longer touches `jobStream.ts`, so the two share no file.
- **`pause-resume-future.md`:** documentation only. It now owns the Pause work, and the drain-window deferral below.
- **No plan names `textGcode` or `materialTestGcode`.**
- **The parent's later batches** S3 (mirroring) and S4c (verified scale) edit the generator after this one. See "Compatibility with S3 and S4c".

## What exists today (verified at `8c60666`)

### The material-test generator (`src/components/panels/MaterialTestDialog.tsx`)

S1 edited the dialog's handlers and buttons. The generator region is unchanged, so the parent's generator line citations still hold.

| What | Where | Today |
|---|---|---|
| Types | `:16` `PowerMode`, `:18-32` `MaterialTestOptions` | Module-private. `PRESETS` (`:34-95`) sets `powerMode: "M3"` on Quick Cut (`:46`) and Full Cut (`:76`). |
| `generateMaterialTestGcode(opts, sValueMax)` | `:97-260`, not exported | Preamble `G21 G90 M5 G0 X0 Y0` (`:102-106`). |
| Labels | `:132-171` | `labelS = round(sValueMax * 0.12)` (`:133`). Calls `textToGcode(..., labelS, 3000, opts.powerMode)` (`:141-149`, `:158-166`). |
| Cut cell | `:186-200` | `G0` to the corner (`:188`), then **`${opts.powerMode} S${sValue}`** alone on its line (`:189`), four `G1 ... S${sValue}`, then `M5`. |
| Fill cell | `:201-228` | Lead-in `G0` (`:210`), then **`${opts.powerMode} S${sValue}`** (`:211`), the `G1 ... S${sValue}` sweep, then `M5`. |
| Border | `:234-253` | `borderS = sValueMax` (`:242`). `G0` (`:245`), then **`M3 S${borderS}`** (`:246`) whatever mode was chosen, four `G1 ... S${borderS}` at F200, then `M5`. |
| `generateFrameGcode(w, h)` | `:262-275`, not exported | `G21 G90 M5`, then `G0`/`G1 F3000` around the outline from literal `X10 Y10`. No `M3`/`M4`, no `S`. |
| Call sites | `handleGenerate` `:386-403`; `handleFrame` `:443`; the display gate `:482` | All pass the dialog's state in. The generator reads no store. |

### The label emitter (`src/lib/machine/textGcode.ts`)

- `textToGcode(text, x, y, fontSize, sValue, feedRate, powerMode)` (`:53-120`) has one caller, the material test (grep of `src/` and `src-tauri/src`).
- Per glyph contour it emits `G0` (`:103`), then **`${powerMode} S${sValue}`** (`:104`), then `G1 ... F${feedRate} S${sValue}` (`:108`, closing move `:113`), then `M5` (`:116`).
- If the font fails to load, it returns `[]` (`:82`, `:85`), so the labels silently vanish from the burn. This is pre-existing and parked.
- `src/lib/machine/__tests__/textGcode.test.ts` is a characterisation net that pins the positive-S mode line: `"M4 S800"` at `:88` and `"M3 S500"` at `:113`. Its header (`:4-9`) says the expectations "are meant to be updated alongside" a deliberate change.

### The Pause button today (facts only; S2 does not change it, per Lee's ruling)

- **The button:** `JobActionBar.tsx:260-276`. Its label is `{machineState === "hold" ? "RESUME" : "PAUSE"}` (`:275`). The handler `handlePauseResume` (`:90-103`) calls `resumeJob()` (sends `~`) in `hold`, and `pauseJob()` otherwise.
- **What `pauseJob` does** (`jobStream.ts:47-57`): prints "Paused jobs cannot resume ...", clears `jobRunning`, and calls `emergencyStop()`.
- **RESUME is unreachable while the button is enabled** (critic Verified 2, re-checked):
  - `machineState` is written from a status report only by `consumeStatusOutcome` → `machineStatus.ts:184`.
  - That is reached at connect, and from `pollStatus`. `pollStatus` returns early while `jobPollingSuspended` (`connection.ts:535`), and that flag mirrors `jobRunning` (`:318`).
  - The drain's `getStatusReport` writes no state. `feedHold()` has no caller.
  - START requires `idle`.
  - So while a job runs, the store cannot read `"hold"`, and the button always shows PAUSE.
- **A hold the controller causes mid-job** is invisible to Kerf. The stream keeps sending until the planner fills and `send()` blocks. STOP is the recovery.
- **The hold-wait in `streamJob`** (`jobStream.ts:348-354`) is therefore dead code, and its comment cites an "emergencyStop's re-poll" that no longer exists. It is parked.
- **Pause is not the same as STOP in the drain window** (critic Verified 1, re-checked):
  - `handleStop` calls `stopActiveSession()` (`JobActionBar.tsx:110`). That calls `session.cancel()` (`jobSession.ts:243-248`), the only thing that makes a drain return `"cancelled"`.
  - `pauseJob` does not call it.
  - After the last line acks, `streamJob` drains (`jobStream.ts:413`) with `jobRunning` still true, so the Pause button is live. A Pause press stops the beam with `0x18`, but the next drain poll reads the post-reset state.
  - On the owner's controller (`$22=1`) that reads as `alarm`, reported as "machine alarm". On a `$22=0` controller it reads as `complete`, reported as "Job complete".
  - Parked under Deferrals.

### The same class outside S2 (found, not in scope)

The Rust engine arms every real job the same way. It emits `{power_cmd} S{s}` on a line of its own before the first `G1` (`src-tauri/src/engine/gcode_gen.rs:303, 595, 632, 708, 747, 827, 858, 1104`). Under M4 that line is dark while the head is stationary. On any layer the operator sets to M3, it fires a stationary beam at every path start. The parent scoped S2 to the material test only. See Deferrals.

### Parent claims that no longer hold

1. **The labels are in a different file.** The parent says S2 edits "`MaterialTestDialog.tsx` (generator only)" and promises "every mode command in the grid, **labels** and border ... with `S0`". The labels' mode line is `textGcode.ts:104`, and `textGcode.test.ts:88,113` pin it. Both files are added.
2. **The Pause half is withdrawn** by Lee's 2026-09-25 ruling. That takes `JobActionBar.tsx`, `jobStream.ts`, `machineJobLoop.test.tsx` and `jobStream.test.ts` out of the file list, and parent mutant S2-M4 out of the battery.
3. **The test path moves.** The parent names `src/components/panels/__tests__/materialTestGcode.test.ts`. The generator moves to `src/lib/machine/` (Change §1), so the test is `src/lib/machine/__tests__/materialTestGcode.test.ts`. S3's lift must use the new paths.
4. **Line numbers S1 moved:**
   - `MaterialTestDialog.tsx:106-128` (`startX/startY`) is now `:127-129`.
   - `:261-273` (`generateFrameGcode`) is now `:262-275`.
   - `:389-416` and `:419-447` (the hand-rolled door checks) are gone. S1 replaced them with `canStartJob` at `:422` and `:445`.
5. **Still true as cited:** `:189`, `:211` and `:242-246`.
6. **The verification assertion is tightened.** The parent's "no line whose only motion-free words are `M3`/`M4` with positive S" becomes "every `M3`/`M4` line carries exactly `S0`", which is what the parent's Change says.

## Change

Two commits. The move is reviewed apart from the arming change.

### 1. `src/lib/machine/materialTestGcode.ts` (new) and `src/components/panels/MaterialTestDialog.tsx` (commit 1: move, no behaviour change)

- **The move:** move `PowerMode`, `MaterialTestOptions`, `generateMaterialTestGcode` and `generateFrameGcode` (dialog `:16-32` and `:97-275`) verbatim into the new module, and export all four. The `textToGcode` import moves with them.
- **The dialog:** imports the four back. `PRESETS`, the component and every call site stay, unchanged.
- **Why move rather than export in place:**
  - The test imports a pure module, not a component that pulls in the store, `jobStream`, `jobSession` and `@tauri-apps/api/core`.
  - The generator sits beside the other G-code producers (`textGcode.ts`, `gcodeGen.ts`).
  - S3 and S4c edit it next.
- **Expected residue in the diff** (critic must-fix 4). Under `git show -M --color-moved=dimmed-zebra`, exactly these lines show as edits. Everything else shows as moved.
  - four `export` prefixes on the moved declarations;
  - the `textToGcode` import leaving the dialog and appearing in the module;
  - one new import line in the dialog.
  - Razor checks for that residue and nothing else.
- `npm test` is green after this commit, with no test edits.

### 2. `src/lib/machine/materialTestGcode.ts` (commit 2: arming)

Three one-line edits. Coordinates, feed words, `M5` lines and the `G1` `S` words are unchanged.

- **Cut cell** (was dialog `:189`): the line after the corner `G0` becomes `` lines.push(`${opts.powerMode} S0`); ``.
- **Fill cell** (was `:211`): the line after the lead-in `G0` becomes `` lines.push(`${opts.powerMode} S0`); ``.
- **Border** (was `:246`): `` lines.push(`M3 S${borderS}`); `` becomes `` lines.push(`${opts.powerMode} S0`); ``. `borderS` stays, because the border's `G1` words use it.
- **Comments:** one short explanatory comment each, citing DECISIONS 2026-09-10, placed **above** the `G0` line, never between the `G0` and the mode line. The mutant anchors depend on the two lines being adjacent.

### 3. `src/lib/machine/textGcode.ts` and `src/lib/machine/__tests__/textGcode.test.ts` (commit 2)

- **`textGcode.ts:104`:** `` lines.push(`${powerMode} S${sValue}`); `` becomes `` lines.push(`${powerMode} S0`); ``.
  - The `sValue` parameter stays, because the `G1` words (`:108`, `:113`) use it.
  - The doc comment's "laser on" (`:45`) becomes "mode set at S0; power on the G1 words".
- **`textGcode.test.ts`:**
  - `:88` `"M4 S800"` becomes `"M4 S0"`.
  - `:113` `"M3 S500"` becomes `"M3 S0"`.
  - One header line notes that the `S0` mode line is deliberate (S2, DECISIONS 2026-09-10).
  - No other expectation changes. `:89-90` still pin positive S on the `G1` words.

### 4. `src/lib/machine/__tests__/materialTestGcode.test.ts` (new, commit 2)

**Setup:**
- Imports the real `generateMaterialTestGcode` and `generateFrameGcode`.
- Mocks only the font **file** load: `vi.mock("opentype.js", ...)` with the synthetic square-glyph font, copied from `src/lib/__tests__/creatorInvariants.test.ts:59-85`. So real `textObjectToPaths` and real `textToGcode` run.
- Mocks `@tauri-apps/api/core` only if a transitive import needs it (as `creatorInvariants.test.ts:24-26` does).
- Mocking `materialTestGcode.ts`, `textGcode.ts` or `geometryActions` is forbidden.

**Parser:** strip `;` comments, skip blank lines, and read words with `/([A-Z])\s*(-?\d*\.?\d+)/g`.

**Fixture:**
- `sValueMax = 1000`.
- 3 power steps (20 to 80); 2 speed steps (500 to 1500).
- 5 x 1 mm cells, gap 2.
- `labels: true`, `cutBorder: true`.
- Run once for each of `mode` ∈ {cut, fill} × `powerMode` ∈ {M3, M4}: four programs.

| Test | Asserts |
|---|---|
| I1 | Every line with an `M3` or `M4` word has an `S` word equal to 0. |
| I2 | Every line with `S > 0` contains `G1` and an `X` or `Y` word. |
| I3 | Every `M3`/`M4` word in the program equals `opts.powerMode`, across cells, labels and border. |
| I4 (anti-vacuity) | There are at least (cells + 1) `M3`/`M4` lines, and a mode line follows the `G0` after `; --- Cut border`. |
| P1 (control) | In each `; Cell P{p}% ...` block, every `G1` has `S === round(p/100*1000)`, which is > 0; each block has at least one `G1`. |
| P2 (control) | In each `; Label:` block, every `G1` has `S === 120`; there is at least one. The square glyph is a closed contour, so an empty label set reds the baseline rather than passing vacuously. |
| F1 | `generateFrameGcode(30, 20)` has no `M3`/`M4` word and no `S` word. |

No test asserts a literal coordinate or the sign of Y (see "Compatibility with S3 and S4c").

## Tests and mutants

Battery spec `kerf-safety-s2`.
- `test_command`: `["npx","vitest","run","--cache=false","src/lib/machine/__tests__/materialTestGcode.test.ts","src/lib/machine/__tests__/textGcode.test.ts"]`. The baseline must be green.
- Every live id below must be **killed**.
- A control (C) is a test that is green at baseline and whose named wrong variant turns it red. It is journalled as a killed mutant.

| Id | File | Killed by | Wrong variant |
|---|---|---|---|
| S2-M1 | `materialTestGcode.ts` | I1, I3 (M4 runs) | Restore `M3 S${borderS}` on the border |
| S2-M2 | `materialTestGcode.ts` | I1 (cut runs) | Restore `${opts.powerMode} S${sValue}` on the cut cell |
| S2-M3 | `materialTestGcode.ts` | I3 (M4 runs) | Hard-code the border to `M3 S0` |
| S2-M4 | — | — | **Dropped (Lee 2026-09-25 Pause ruling)** |
| S2-M5 | `materialTestGcode.ts` | I1 (fill runs) | Restore `${opts.powerMode} S${sValue}` on the fill cell |
| S2-M6 | `textGcode.ts` | I1; `textGcode.test.ts:88` | Restore `${powerMode} S${sValue}` on the label mode line |
| S2-M7 | — | — | **Dropped (Lee 2026-09-25 Pause ruling)** |
| S2-C1 | `materialTestGcode.ts` | P1 | Zero every cell's power (`const sValue = 0;`) |
| S2-C2 | `textGcode.ts` | P2; `textGcode.test.ts:89` | Zero the label `G1` power |

The spec carries seven mutants: S2-M1, M2, M3, M5, M6, C1 and C2. Dropped ids are not in it.

**Spec strings.** Each mutant is one contiguous find/replace. `\n` is a newline in the JSON; indentation is exact.

- **S2-M1**
  - find: `` "    lines.push(`G0 X${bx.toFixed(3)} Y${by.toFixed(3)}`);\n    lines.push(`${opts.powerMode} S0`);" ``
  - replace: the same first line, then `` "\n    lines.push(`M3 S${borderS}`);" ``
- **S2-M3**
  - find: the same as S2-M1.
  - replace: the same first line, then `` "\n    lines.push(`M3 S0`);" ``
- **S2-M2**
  - find: `` "        lines.push(`G0 X${cx.toFixed(3)} Y${cy.toFixed(3)}`);\n        lines.push(`${opts.powerMode} S0`);" ``
  - replace: the same first line, then `` "\n        lines.push(`${opts.powerMode} S${sValue}`);" ``
- **S2-M5**
  - find: `` "        lines.push(`G0 X${cx.toFixed(3)} Y${y.toFixed(3)}`);\n        lines.push(`${opts.powerMode} S0`);" ``
  - replace: the same first line, then `` "\n        lines.push(`${opts.powerMode} S${sValue}`);" ``
- **S2-C1**
  - find: `"      const sValue = Math.round((power / 100) * sValueMax);"`
  - replace: `"      const sValue = 0;"`
- **S2-M6**
  - find: `` "lines.push(`${powerMode} S0`);" ``
  - replace: `` "lines.push(`${powerMode} S${sValue}`);" ``
- **S2-C2**
  - find: `` "G1 X${toX(pt.x)} Y${toY(pt.y)} F${feedRate} S${sValue}" ``
  - replace: `` "G1 X${toX(pt.x)} Y${toY(pt.y)} F${feedRate} S0" ``

**Anchor uniqueness, checked by `grep -cF` at `8c60666`.** A find is unique if its first line is unique, or if the whole find is a string introduced once by this plan.

| Anchor | Count at `8c60666` | Count after S2 |
|---|---|---|
| `G0 X${bx.toFixed(3)} Y${by.toFixed(3)}` (M1, M3) | 1 in the dialog | 1, moved verbatim |
| `G0 X${cx.toFixed(3)} Y${cy.toFixed(3)}` (M2) | 1 | 1 |
| `G0 X${cx.toFixed(3)} Y${y.toFixed(3)}` (M5) | 1 | 1 |
| `const sValue = Math.round((power / 100) * sValueMax);` (C1) | 1 | 1 |
| `${opts.powerMode} S0` | 0 | 3, each paired with a distinct `G0` line above it |
| `textGcode.ts` `${powerMode} S${sValue}` | 1 | 0 (replaced) |
| `textGcode.ts` `${powerMode} S0` (M6) | 0 | 1 |
| `textGcode.ts` `G1 X${toX(pt.x)} Y${toY(pt.y)} F${feedRate} S${sValue}` (C2) | 1 | 1; the closing move at `:113` uses `first`, not `pt` |

- The battery refuses an ambiguous anchor (`MUTANT_ANCHOR_AMBIGUOUS`, `mutation-battery.mjs:1773-1779`) before writing anything. So a violation shows up as a refusal, never as a false kill.
- Ted re-runs the same `grep -cF` against the finished files before the battery, and records the counts.

## Verification

- The two-file `test_command` above.
- `npx vitest run src/components/panels/__tests__/machineJobLoop.test.tsx`: unchanged and green. S1's material-test door tests import the dialog, and so exercise the moved generator.
- `npx tsc --noEmit`.
- `npm test`: the baseline measured at relay start plus the new tests, none weakened. The two `textGcode.test.ts` expectations are the only changed ones.
- `npm run lint`: no new warnings.
- `npm run format:check`.
- Commit 1 shows exactly the residue listed in Change §1, and no other edited line.
- Battery journal: S2-M1, M2, M3, M5, M6, C1 and C2 all **killed**, with zero survived, errored or CONTROL_RED.

**Done condition:**
- `relay/kerf-safety-s2` is an ancestor of `marvin/kerf-gap`.
- `/home/leesalo/marvin/state/relay/kerf-safety-s2-razor-review-b1.md` (or its latest recheck) reports PASS with 0 CRITICAL.
- The `kerf-safety-s2` battery journal under `~/.local/state/marvin/mutation-battery/` records those seven ids killed.
- The Stage 3.5 obligations below are in the merged tree.

**Browser (`npm run dev` + Chrome DevTools MCP; Playwright MCP only if DevTools cannot connect, and the report says which was used):**
1. Open the Material Test dialog and stub `navigator.clipboard.writeText` to capture its argument.
2. With M4, cut, labels and border on, click Copy G-code. The captured program must have:
   - every `M3`/`M4` line reading `S0`;
   - positive `S` only on `G1` lines;
   - `M4` on the border.
3. Repeat with M3 and fill.
4. The real font loads in the browser, so this is the one run with real glyph outlines. Screenshot the dialog to show it has no visual change.
5. The serial send itself is not reachable from the browser. S1's door tests cover admission.

**Hardware-only (named, not skipped; goes on the owner's next card via evidence E4).** Burn a material test card with M4, cut, labels and border on, and check:
- there is no dot or pit at any cell or label start;
- each cell and label still burns;
- the border still cuts through. It now runs in the selected mode (M4 by default) instead of forced M3, so corner energy is lower.

Evidence is status-only (DECISIONS 2026-09-10). This check is visual, on the material, and does not qualify beam-off behaviour.

## Compatibility with S3 and S4c

S3 mirrors Y in the same generator when `originTop` is set. S2 is built so that S3 changes coordinates only and S2 changes mode lines only.

- **The generator stays pure.** It takes every input as an argument (`opts`, `sValueMax`) and reads no store. S3 adds `originTop` as a new trailing argument to `generateMaterialTestGcode` and `generateFrameGcode`, threaded from the dialog's existing `originTop` selector (`MaterialTestDialog.tsx:322`). S2 fixes the export names and the module path S3 builds on.
- **S2 touches no coordinate expression.** S3 touches no mode line.
- **S2's invariants never assert a coordinate or a Y sign.** They parse words only (I1-I4, P1, P2, F1), so they stay valid under mirroring. S3 should parametrise them over `originTop ∈ {false, true}` rather than write a second set.
- **S2's mutant anchors are spent by S2's battery.** They include the `G0` lines S3 rewrites, so S3's spec writes its own.
- **Labels:** `textToGcode` places glyphs at `py + wy + y` (`textGcode.ts:100`). Mirroring labels needs a Y mapping inside `textToGcode`, or a post-map of its output. S2's `textGcode.ts` edit is only the mode line at `:104`, which is disjoint from either.
- **S3's lift must re-derive its file list.** `src/lib/machine/materialTestGcode.ts` joins it. Its test is `src/lib/machine/__tests__/materialTestGcode.test.ts`. `MaterialTestDialog.tsx` stays for the call sites. That makes 7 files, or 8 if `textGcode.ts` carries the label mirror.
- **S4c** changes what the dialog passes as `sValueMax`. That is already an argument, so S4c edits call sites, not the arming.

## What S2 does not satisfy

- **The Pause button:** unchanged, by Lee's ruling. The forward plan is `pause-resume-future.md`.
- **The engine's own mode lines.** A stationary beam on every M3 layer of every real job is out of scope. See Deferrals.
- **Origin-top geometry:** S3. Until S3 lands, S1 correctly refuses the positive-Y grid on an origin-top machine. The parent's Authority notes require S1 and S3 to ship in the same build.
- **A verified power scale:** S4b/S4c. The material test still scales by a `grblSValueMax` that may come from localStorage.
- **The `M3` presets:** after S2 they no longer arm stationary, but they still cut at constant power. That is a product call; see Deferrals.

## Deferrals (each goes to `ROADMAP.md -> ## Parking Lot` at Stage 3.5, in the existing `- **Title** — detail.` shape)

1. **The engine arms every job with positive S on standalone mode lines. This is an X1-class hazard on every M3 layer of every real job.**
   - Where: `src-tauri/src/engine/gcode_gen.rs:303, 595, 632, 708, 747, 827, 858, 1104`.
   - What happens: on a layer set to M3, the beam fires with the head stationary at every path start. It is the same class S2 closes for the material test.
   - It needs **its own batch**. The engine is remediation-frozen, and the golden fixtures change, so it needs `env -u KERF_UPDATE_GOLDEN` discipline: regenerate once, deliberately, reviewing every changed golden line as a mode-line `S0`.
   - The close report raises it to the coordinator as a gap in the parent plan.
2. **Pause during the drain window is reported as an alarm or a completion, not as cancelled.**
   - Owner: `.claude/plans/pause-resume-future.md`.
   - This is today's behaviour of the unchanged Pause button: `pauseJob` (`jobStream.ts:47-57`) never calls `stopActiveSession()`.
   - The one-line fix: `pauseJob` calls `stopActiveSession()` fire-and-forget before `store.setJobRunning(false)`, in `handleStop`'s B3 order and with its comment (`JobActionBar.tsx:106-111`).
   - Its mutant, in the style of the critic's S2-M8: delete that call. It must go red on a test that seeds a real session via `beginJobSession` (with `serial_job_begin` mocked to return `1`), clicks Pause, and asserts `getActiveSession()?.cancelled === true`.
   - The existing `pauseJob` tests (`machineJobLoop.test.tsx:716-775`) stay green: with no active session, `stopActiveSession` returns at once.
3. **Dead hold-wait with a stale comment.**
   - Owner: `pause-resume-future.md`.
   - `jobStream.ts:348-354` can never see `"hold"` while `jobRunning` is true, and its comment cites an `emergencyStop` re-poll that B4 removed. It should be fixed or deleted with the pause work.
4. **Owner test card step 6 ("Pause / resume", `docs/test-card.md:57-63`) instructs a Resume that does not exist.**
   - Owner: `pause-resume-future.md`, which rewrites it when the button's behaviour is settled.
5. **The material-test cut presets default to M3** (`MaterialTestDialog.tsx:46`, `:76`). This sits against the 2026-09-10 M4 ruling ("not for cutting"). It is a product call.
6. **Labels vanish silently when the font fails to load.** `textToGcode` returns `[]` (`textGcode.ts:82`, `:85`), so the card burns with no labels and no warning.

## Stage 3.5 obligations (orchestrator)

- **ROADMAP:**
  - a `shipped` entry for S2;
  - the card-burn check added to the owner hardware card bullets in `next`;
  - Parking Lot lines 1-6 above.
- **ARCHITECTURE.md delta:**
  - `:117`: add `materialTestGcode.ts` beside `textGcode.ts`.
  - `:306-310` (G-code producer 3): it moves to `src/lib/machine/materialTestGcode.ts`. Every mode line it and `textToGcode` emit is `S0`, with power on `G1` words only.
  - No pause-related delta.
- **Hand-off:**
  - Record `kerf-f2` as answered by Lee's 2026-09-25 ruling (via `update-handoff.mjs`, `resolved_questions`).
  - Propose a DECISIONS entry for the ruling. Do not auto-write it; it is written only on Lee's yes.

## Risks and rollback

- **The burned card changes (intended).** There is no stationary dot at cell and label starts. The border burns in the selected mode (M4 by default), so it may cut shallower at its corners than the old forced-M3 border. The owner card checks this.
- **`M3 S0` on the vendor fork.**
  - In stock GRBL 1.1, `M3 S0` resolves to PWM-off. On the fork, that is intent evidence, not proof (DECISIONS 2026-09-05).
  - If the fork lights a minimum PWM at `S0`, a dot persists at M3 starts. That is no worse than today, and the card burn is the instrument that shows it.
  - The `G1` lines are byte-identical to what this generator has always sent the owner's controller. Every one of them already carries its own `S` word.
  - The Rust engine's shipped jobs also put `S` words on `G1` lines (`gcode_gen.rs:290`, `:336`).
- **The zero-everything mistake:** controls S2-C1 and S2-C2 exist to catch it.
- **Merge interaction:** S2 shares no file with S1b. S3 rebases onto S2 and re-derives its paths.
- **Rollback:** revert the relay merge commit. If S3 has merged on top, revert S3 first, because it depends on the module path.
- **Irreversible steps:** none. No controller setting is written, and nothing is tagged or released.
