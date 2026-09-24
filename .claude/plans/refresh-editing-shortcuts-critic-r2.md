# Critic Review (round 2) — Refresh: Editing and Shortcuts

**Plan:** `.claude/plans/refresh-editing-shortcuts.md` (revised after round 1)
**Round 1:** `refresh-editing-shortcuts-critic-r1.md` — not re-confirmed here; this round hunts what the
round-1 folds introduced and what round 1 never reached.
**Reviewed against:** worktree `session-8b2728` at `0a0e689`. Every citation below was opened in the
tree. Baselines were measured, not copied: `npx vitest run` = 51 files, **823 passed**;
`cargo test` = **310 passed** (`~/.cargo/bin/cargo`, not on the default PATH).
**Reviewer:** separate Fable critic, read-only except this file.

## Verdict: APPROVE WITH CHANGES

The design survived round 1 intact and the folds are correct where they matter (the decision block,
the batch waiver, the seven Parking Lot lines, the positive controls in F1/F2/F6/F7.2/F7.3). Three
things must be folded before relay, none of them a design change: the Ctrl+Shift+V switch ships two
branches that no test will ever execute, the Rust done-when number is wrong, and the new test files
will inherit a store singleton whose `openDialogs` set is never reset. The rest is advisory.

---

## Applicability

**Project type:** desktop CAD/CAM app (Tauri/React), UI, dispatch and undo layer. No Rust, serial or
G-code generation touched.

| Dim | Fires? | Tag | Why |
|---|---|---|---|
| X1 Physical safety | **Fires, narrowly (F9)** | GATING | F9 writes `layer.speed`; nothing else reaches the machine. |
| X2 Privacy | Does not fire | N/A | No personal, client or health data in scope. |
| X3 Evidence | Does not fire | N/A | No research or public claims; the two shortcut-table sources were verified in round 1. |
| X4 Audience/brand | Does not fire | N/A | Nothing client- or public-facing. |
| X5 Concurrency | Fires | ADVISORY | Several window keydown listeners stack; F7 changes which one acts. |
| X6 Operability | Fires | ADVISORY | Released app; F7's guard now has a dev warning whose semantics need stating. |
| X7 Self-modification | Does not fire | N/A | No MARVIN gates, hooks or skills. |
| X8 Deps/perf/cost | Does not fire | N/A | No packages; one `querySelector` per keydown. |

---

## Core dimensions

### 1. Problem-fit — PASS
`## Intent (grilled)` present with a written skip line; Summary matches the goal. The
`## Decision pending Lee` block is in the six-part shape and the default it builds (A) is the one it
recommends. No `.claude/DECISIONS.md` entry is touched: every ruling there is streaming, abort, power
mode, file-version or geometry, and this plan leaves `updateLayer`'s write door as it is.

### 2. Approach soundness — PASS
**Import cycle (orchestrator probe):** none new. `editCommands.ts` will import `useStore` from
`app/store`, `deepCloneObject` from `app/store/storeTypes`, `movePartial` from `lib/geometry` and
`PASTE_OFFSET_MM` from `lib/constants`. The store already imports `lib/constants`, `lib/materials`,
`lib/nesting` and `lib/geometry` (`index.ts:1-10`, `geometryActions.ts:1-14`); none of those imports
anything under `lib/shortcuts`, `lib/editCommands` or `components/`, and `storeTypes.ts` imports only
types (`:1-14`). Consumers are `shortcuts.ts`, `MenuBar.tsx`, `CommandPalette.tsx` (leaves). The
pre-existing `shortcuts -> fileOps -> App -> shortcuts` loop is dynamic (`fileOps/index.ts:296,304,399,448`
use `await import`) and unchanged. F5's new `CommandPalette -> toolHandler` edge is safe: toolHandler
imports store, geometry, measure, constants and the machine connection only (`toolHandler.ts:1-14`).

**The `as` cast (orchestrator probe):** it hides narrowing, not an error, and the plan's reason is
correct. Reproduced with the repo's `tsc` 5.9.3 on the plan's exact shape: the annotation form
`const X: B = "flipVertical"` fails **TS2367** at the `PASTE_IN_PLACE_LABEL` line (`X === "pasteInPlace"`
has no overlap after declaration narrowing); the `as` form compiles, and a second module importing
`X` and comparing it to the other two literals also compiles (cross-module uses the declared type). The
literal is a member of the union, so the cast widens; nothing is being forced past the checker. What
the cast does *not* do is make the other branches run — see dimension 9.

### 3. Completeness — PASS
All paste, delete and import entry points as in round 1. One wording defect: F1 says "remove
`generateId`/`movePartial` from shortcuts.ts" and in the next sentence that `movePartial` stays for
the nudge branch (it does, `:281`). Only `generateId` becomes unused (A6).

### 4. Right-sizing & reuse — PASS
Batch waiver present and reasoned; Batch 2 declared independent; seven verbatim Parking Lot lines
under `## Deferrals` with the target heading spelled as `rules/project-docs.md` prescribes.

### 5. Security — PASS
Unchanged from round 1.

### 6. Failure modes — PASS
Module early-returns cover empty selection and empty clipboard. F7's failure modes are named on both
sides (missing attribute, stray attribute).

### 7. Change safety — PASS
Session branch, no migrations, no destructive steps. F7's two behavior changes are named for the
ROADMAP entry.

### 8. Data integrity & compatibility — PASS
No file-format or store-shape change. `openDialogs` is `Set<string>` (`storeTypes.ts:269`), so
adding `"shortcuts"` and `"commandPalette"` needs no type edit and keeps `storeTypes.ts` out of
scope as the plan promises.

### 9. Verifiability — CONCERN
Three defects, each cheap, each one that would let the relay report "done" on something unproven.

**(a) Two of three `CTRL_SHIFT_V` branches never execute.** Under the shipped default,
`runCtrlShiftV`'s `pasteInPlace` arm, `FLIP_VERTICAL_LABEL`'s `undefined` arm,
`PASTE_IN_PLACE_LABEL`'s long-form arm, the ShortcutOverlay conditional row and the test file's own
`pasteInPlace` / `none` branches are all dead. The plan tells Lee "any ruling is a one-line change"
and "every label and test follows from it": the one-line change would activate code and assertions
that have never run red or green. That is exactly the "displaced, not closed" pattern the critic
exists to catch. **B1.**

**(b) The Rust done-when count is wrong.** `cargo test` at HEAD is 310 passed; the plan says 305.
**B2.**

**(c) Store singleton leaks between tests.** F4 moves palette and sheet open state into `useStore`,
a module singleton that survives testing-library cleanup. No existing test resets `openDialogs`
(grep across `__tests__`: zero hits) and the harness `beforeEach` in `shortcutsWriters.test.tsx:58-70`
resets objects, selection, undo, clipboard and tool only. A test that ends with the sheet or palette
open poisons the next: `?` then *closes* instead of opening (F4 test 2, F7 test 5), and "Ctrl+K puts
`commandPalette` in `openDialogs`" passes vacuously. **B3.**

**Positive controls (orchestrator probe).** Present and sufficient in F1.3, F2's keyboard path,
F3 (plain Ctrl+V), F6 (S before Shift+S), F7.2 (nudge before the dialog), F7.3 (Tab after unmount),
F8 (stack grows by one). Still missing: F2's *menu* Edit > Delete empty case has its positive control
on the keyboard path, so a dead or mis-labelled menu item passes; F7.1 is only falsifiable if it is
the same `it` as F7.4; F7.5 "selection and activeTool unchanged" has no action that proves the Escape
branch was reachable. **A3.**

**Order of Batch 1 (orchestrator probe).** Traced each later fix against each earlier test: F4 does
not change what F1-F3 dispatch; F5's `switchTool` rewrite of the tool and Escape branches keeps the
observable behavior F3/F6 assert; F6's new branches sit before the tool branch and `s`/`[`/`]` collide
with nothing (`toolShortcuts` is v r e l p t n m h); F7's guard cannot suppress F1's MenuBar-driven
tests (the dropdown is `role="menu"`, `MenuBar.tsx:546`, not `aria-modal`) or F4/F5's palette keys
(the palette handles its own Enter/Arrow on the input). No inversion found. The only ordering hazard
is (c) above, which is not about order but about reset.

**Existing suite under F7.** Only two existing test files dispatch keyboard events
(`shortcutDispatchOrder`, `shortcutsWriters`); neither renders a dialog or `<App />`, so the guard
breaks nothing in the 823.

### 10. Maintainability — CONCERN
F4 says to "reset `query`/`selectedIndex` in the existing on-open effect". That effect
(`CommandPalette.tsx:438-443`) only focuses the input; adding `setQuery("")` / `setSelectedIndex(0)`
there trips `react-hooks/set-state-in-effect`, which is on as `warn` (`eslint.config.js`), and the
plan's own done-when forbids new warnings. Today those resets live in the Ctrl+K handler (`:425-427`);
leave them there. **A1.** Otherwise clean seams; `_testClipboardOp` dies with its consumer migrated;
ARCHITECTURE line named.

---

## Conditional dimensions

### X1 Physical & human safety — PASS
F9 as verified in round 1; re-checked `clampSpeed` (`speedScale.ts:57-60`, floor 1, non-finite to 1),
`effectiveMaxSpeed`/`rasterMaxSpeed` (`:65-80`) and `SPEED_FALLBACK_MAX = 30000` (`:15`), which is the
number the browser step expects. Store keys `grblMaxFeedRateX/Y` exist (`storeTypes.ts:118-119`).
Worst physical case unchanged: a cleared field commits 1 mm/min, visible in the box, parity with
LayerPanel.

### X5 Concurrency & re-entrancy — PASS
The DOM is read at event time; React commits after the event, so the same keydown that closes a
dialog is still suppressed. `?` and Ctrl+K stay on their own listeners, and the comment says so.

### X6 Operability — CONCERN (advisory)
The dev warning fires on the first suppressed key of **every** modal, stuck or not, because
`document.querySelector` cannot tell the two apart. `warnedModals` is keyed by element identity and
React mounts a fresh root per open, so the browser check "exactly one line per dialog" is really one
per *opening* (and ImageTraceDialog has two roots, `:469` and `:677`). Vitest runs with
`import.meta.env.DEV` true, so every modal test will also print it. Harmless, but the plan should say
what the line means and the done-when should not promise "per dialog". **A2.**

---

## Stress tests

### Pre-mortem — three months out
1. **Lee ruled B; the flip landed broken.** The implementer changed the initializer, the
   `pasteInPlace` test branch ran for the first time, and either it or the label arm was wrong; nobody
   noticed because the plan had said the change was one line. Should have seen: all three bindings
   exercised on day one (B1).
2. **A green relay with a rotten test file.** A test left the palette in `openDialogs`; the next
   test's "opens" assertion held because it was already open; a later refactor broke opening and the
   file stayed green. Should have seen: `openDialogs: new Set()` in every `beforeEach` (B3).
3. **"Keyboard is dead" in dev, warning ignored.** Every dialog printed the suppression line since
   day one, so the one time a hidden `aria-modal` root stuck around, the same line meant nothing.
   Type-specific worst case for this plan is not the beam; it is silent loss of Ctrl+S. Mitigation A2.

### Load-bearing assumptions
- **`as CtrlShiftVBinding` compiles all three arms.** Verified with tsc 5.9.3. High confidence.
- **No existing test renders a modal while dispatching keys.** Verified (two files, harness only).
  High confidence; new files must keep that discipline.
- **Nothing reads `openDialogs` by iteration or size.** Verified: every reader is `.has(name)`
  (`App.tsx:304-382`). High confidence.
- **The store singleton is reset per test.** *Not true today for `openDialogs`* — B3.

### Inversion
- *Pin the binding as a runtime setting instead of a constant* wins if Lee wants both habits. He
  has not said so; a constant with all three arms tested (B1) keeps that door open for free.
- *Warn only on hidden modals* wins if the warning is meant as a stuck-modal detector. That is what
  round 1 asked for; the current shape is a general "suppressed" trace. Either is defensible once
  named (A2).
- *Store-based guard* still loses: three surfaces keep state outside the store after F4.

---

## Findings

### Blocking (fold before relay)

**B1. Exercise every `CTRL_SHIFT_V` arm.** Make dispatch and labels pure functions of the binding —
`resolveCtrlShiftV(binding)` (or `runCtrlShiftV(binding = CTRL_SHIFT_V)`) and
`ctrlShiftVLabels(binding)` returning `{ flipVertical?: string; pasteInPlace: string }` — and in
`editCommands.test.tsx` call them for all three values against the real store: `flipVertical`
mirrors and adds nothing; `pasteInPlace` adds one object with the clipboard's transform;
`none` leaves objects deep-equal and labels `{ flipVertical: undefined, pasteInPlace: "Alt+V" }`.
Keep `CTRL_SHIFT_V` as the single input (the `as` cast stays) and keep the end-to-end keyboard test
under the shipped value only. Then "one-line change" is a true sentence.

**B2. Done-when: `cargo test` 310, not 305.** Measured at `0a0e689`.

**B3. Reset `openDialogs` in every new `beforeEach`.** `editCommands.test.tsx`,
`commandSurfaces.test.tsx` and `shortcutsModal.test.tsx` each add `openDialogs: new Set()` to the
store reset, and F4 test 3 asserts the name is absent *before* Ctrl+K.

### Advisory (should fold)

**A1. Keep the palette's `query`/`selectedIndex` resets in the Ctrl+K handler**, not in the focus
effect; the effect form adds a `react-hooks/set-state-in-effect` warning the done-when forbids.

**A2. State what the dev warning means.** "One line per opening of a modal, in dev and in vitest";
change the done-when and browser wording from "per dialog". Optional: gate on
`modal.checkVisibility?.() === false` so it fires only for a mounted-but-hidden root, which is the
case round 1 wanted surfaced and which also silences it under jsdom.

**A3. Three more positive controls.** F2: run the menu-path empty case, then select B and delete via
the *menu*. F7: make .1 and .4 one test (suppressed, unmount, deletes). F7.5: after the sheet closes,
press Escape again and assert the selection clears.

**A4. F6 "each is one undo step" applies to `]` and `[` only.** `setSnapToGrid` is a plain `set`
(`index.ts:374`); an implementer who asserts `undoStack +1` after S gets a red test for a reason the
plan did not state.

**A5. Name the `deepCloneObject` import path.** `app/store/index.ts` re-exports only `generateId`
and `AppState` (`:21-22`); the module imports `deepCloneObject` from `../app/store/storeTypes`, as
`App.tsx:37` does for `generateId`. A `bc87e45`-style export trim would otherwise be a surprise.

**A6. Fix the F1 import sentence.** Only `generateId` becomes unused in shortcuts.ts; `movePartial`
stays for the nudge.

**A7. First-launch in the browser check.** A fresh Chrome profile shows the onboarding overlay,
under which F7 makes every shortcut inert by design; the tester dismisses it before F1.

---

## Overall

Round 1's folds hold: the decision goes to Lee in the right shape, the waiver and deferrals exist,
the empty-selection assertions have live controls, the module creates no cycle, and every `useStore`
selector the plan names returns a boolean or a scalar. What round 1 did not reach is the switch it
asked for: the `as` cast is right, but a switch whose other positions have never been run is not a
one-line change, it is a one-line gamble. Fold B1, correct the Rust count, reset `openDialogs` per
test, and this is ready for relay.

**Prioritized must-fix:** B1, B3, B2, then A1, A3, A2.
