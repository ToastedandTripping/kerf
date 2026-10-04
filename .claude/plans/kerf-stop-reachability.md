# Kerf: STOP is covered by every open dialog, there is no Stop key, and a stop's outcome shows only in the closed console (UI polish TB1)

Revision 1, 2026-10-04. Critic owed before any relay. This is follow-on plan TB1 from `.claude/plans/kerf-ui-polish.md` (revision 3, critic PASS), and that entry's "Requirements its plan must satisfy" and "Acceptance evidence" are binding here, quoted in full under `## The requirement`. Tier: Complex (X1 fires: this changes how the operator reaches the laser's stop).

Tree: `marvin/kerf-gap` at 4daa50d. `git diff --stat 70cdfa1 4daa50d` lists only plan files, `.claude/handoff.md` and one ROADMAP Parking Lot line, so every source citation below was opened at 4daa50d and holds at 70cdfa1. motion-trust is merged (1ed239e). Polish A1 is built and in review; A7 (the job bar) is next; A2 and A3 have not started.

## Intent (grilled)

Grill: skipped, with this reason. Lee approved the order on 2026-10-02 (hand-off: "NEXT, in Lee's agreed order: (1) UI polish Track B TB3 ... and TB1, STOP reachability"), and the coordinator relayed his go on 2026-10-04 ("get him working on the active projects"). He delegated technical calls on 2026-09-29 ("I defer to your judgement and research"). The requirement is already written, in the round-1 critic's words, in the polish plan. The one product call it leaves open, which key stops the machine, is D1 under `## Decisions for Lee`, and nothing waits on it.

**Summary.** Today a click on STOP while any dialog is open lands on that dialog's full-screen backdrop. On thirteen dialogs, the ? sheet, the palette and the canvas context menu that first click only closes the overlay. On the onboarding overlay and the recovery prompt it does nothing at all. No key reaches the stop, because every global shortcut is inert while a modal is mounted. When a stop is unconfirmed or fails, the only record is a console line, and the console is closed by default. This plan makes STOP clickable above every overlay and gives it a key that works in every dialog and every text box. The stop's outcome then shows in the job bar the moment STOP is pressed, and it is replaced when the controller answers. Nothing is added ahead of the reset byte.

**Key decisions.**
1. **STOP is raised in place, not portalled.** The STOP button and its outcome line get `position: relative` and `zIndex: STOP_LAYER_Z` (1,000,000, one exported constant). No dialog file is edited. A source scan plus a runtime walk make every other z-index stay below it, and they ban the browser top layer. This needs no A3.
2. **One operator stop function.** `operatorStop()` holds `handleStop`'s three statements, moved verbatim (`JobActionBar.tsx:110-112`). The button, the Stop key and a new STOP on the crash screen all call it.
3. **The Stop key is Ctrl+. (⌘. on macOS)** (D1 recommendation). It is a window capture-phase listener installed at module load in `main.tsx`, so it keeps working after a React crash replaces the UI. It ignores auto-repeat. It is a no-op exactly when the button is disabled (`!machineConnected`).
4. **The stop outcome is written after the stop is dispatched, never before.** `beginStopAttempt` runs on the statement after `invoke("serial_stop")`. Outcomes are grouped into episodes. An episode settles only when every request in it has answered, and it shows the least-confirmed answer. It is bound to the connection it was sent on, and a "confirmed" that predates the episode counts as unconfirmed. A 7 s watchdog, keyed to the episode, escalates the wording. There are three strings, all true under the status-only ruling.
5. **STOP looks live in every state where motion is possible.** A7's solid rule is extended with `motionPending` (the jog window before the first status report) and with any stop that is pending or unconfirmed.
6. **No native change.** `serial_stop`, the fence, the submit lock and the single-reset contract are untouched. Every statement that runs before the dispatch today stays byte-identical, and so does their order.
7. **Three batches.** B1 (outcome core) and B2 (the stop function, the key, the crash screen) share no file and can run in parallel. B3 (the raised STOP and the outcome line) waits on A7. No TB1 batch edits a file that any polish batch edits.

## The requirement (verbatim from the polish plan, TB1)

- STOP reachable across "every modal, jog, stale/unknown state", with "keyboard and pointer dispatch to the single stop path", proved by "an uncertain-state/modal/input matrix and actual dispatch checks" (every dialog in principle 6, plus the ? sheet, palette, onboarding and recovery prompt; states run, hold, door, alarm, unknown, stale, and the jog window before the first status report, which motion-trust's `motionPending` can expose). `elementFromPoint` alone is not evidence: it "proves neither click dispatch nor keyboard access".
- "Pending/unconfirmed physical-stop guidance that never delays serial_stop": nothing is added before `invoke("serial_stop")`; the guidance shows at once on press and is replaced when the outcome lands; when confirmation is unavailable it "always exposes physical-stop guidance".
- "Connection/request identity on the stop outcome", with "guarded completion writes and replacement-safe timers", "testing repeated STOP, reconnect-before-resolution" and "adversarial promise-ordering tests", "without modifying the single-reset transport contract" (DECISIONS 2026-09-24).
- Evaluate both a raised in-place STOP and a portal STOP surface: "it cannot reject that implementation categorically" until the focus-trap interaction is tested.
- Name "physical failure outcomes and the hardware checks required before relying on this UI"; "software cannot certify beam extinction".
- Acceptance: vitest with real DOM pointer and keyboard events through every modal in every state; controlled IPC (deferred `invoke` promises resolved out of order, a stop resolving after reconnect, two stops); the browser with invoke mocked; owner desktop: Preferences open mid-job on scrap, one click on STOP stops the job; an owner hardware STOP during a jog with the laser isolated. Copy: "Kerf couldn't confirm the stop. Press the machine's emergency stop button now." and "Stopped. The controller was reset. Kerf can't see the laser itself, so check that it's off."

Rulings that bind this plan (DECISIONS): "Abort sends 0x18 immediately — no feed hold, no M5, no ack wait" (2026-09-20). The single-reset fence, "one stop sends one reset and nothing re-sends it" (2026-09-24, amended 2026-10-02: "No reset is ever refused or delayed beyond one in-progress write"). The status-only evidence entry ("a status report says what the software commanded and never what the beam emitted"; amended 2026-09-27: "No release note, test or claim may say the beam goes dark on stop or pause unless a witness-card test shows it"). "Jog admission is native" (2026-10-02; TS "may refuse earlier ... but must never admit what native would refuse"; TB1 admits nothing). Pause stays as it is (2026-09-25: "A future session must not relabel, remove or re-wire Pause outside that plan"; TB1 does not touch Pause). The 2026-10-02 UI rulings (one blue, paper wells, Score default, status-bar tint, layer colour) are untouched; TB1 uses only A1's danger and warning tokens.

## Diagnosis (verified on marvin/kerf-gap at 4daa50d)

### 1. Every overlay that covers STOP

Every one but the file-drop veil is `position: fixed; inset: 0` in the root stacking context, so each covers the whole window, sidebar included. Today the source holds 46 numeric z-index literals and no CSS `z-index`, `showModal(` or `popover=`.

| surface | backdrop (element, z, click) | panel (z, `aria-modal`) | first click at STOP's position |
|---|---|---|---|
| Settings ("Preferences…") | `SettingsDialog.tsx:74-80`, z 9999, `onClick={onClose}` :75 | :98 z 10000, :86 | closes the dialog |
| GRBL Machine Settings | `GrblSettingsDialog.tsx:133-139`, z 9999, :134 | :157, :144 | closes |
| Project Notes | `ProjectNotesDialog.tsx:37-43`, z 9999, :38 | :61, :49 | closes |
| QR code | `QrCodeDialog.tsx:126-132`, z 9999, :127 | :150, :138 | closes |
| Trace (no image selected) | `ImageTraceDialog.tsx:463-465`, z 9999, :464 | :481, :469 | closes |
| Trace | `ImageTraceDialog.tsx:670-672`, z 9999, :671 | :691, :677 | closes |
| Material Test | `MaterialTestDialog.tsx:295-307`, z 2000, closes when `e.target === e.currentTarget` (:305-307); the panel is the backdrop's child | no z, :312 | closes (STOP's position is backdrop, not panel) |
| SVG import | `SvgImportDialog.tsx:242-244`, z 9999, :243 | :264, :249 | closes |
| Image import | `ImageImportDialog.tsx:110-112`, z 9999, :111 | :129, :117 | closes |
| PDF import | `PdfImportDialog.tsx:260-269`, z 9999, closes when the target is the backdrop (:262-263) | :290, :276 | closes |
| Variable Text | `VariableTextDialog.tsx:154-156`, z 9999, :155 | :173, :161 | closes |
| Nesting | `NestingDialog.tsx:84-86`, z 9999, :85 | :103, :91 | closes |
| Dither preview | `DitherPreviewDialog.tsx:80-86`, z 9999, :81 | :105, :93 | closes |
| Power Curve | `PowerCurveEditor.tsx:329-335`, z 9999, :330 | :354, :342 | closes |
| ? sheet | `ShortcutOverlay.tsx:120-126`, z 99998, :121 | :144 z 99999, :133 | closes |
| Command palette | `CommandPalette.tsx:500-506`, z 9999, :501 | :526, :513 | closes |
| Onboarding | `OnboardingOverlay.tsx:49-57`, z 10000, **no click handler** | :63 | **nothing happens, on every click** |
| Recovery prompt | `App.tsx:403-411`, z 9999, **no click handler** | :417 | **nothing happens, on every click** |
| Canvas context menu (not modal) | `Viewport.tsx:903-905`, transparent, z 100, closes the menu (:905) | menu `:1377` z 101 | closes the menu |
| File-drop veil | `App.tsx:235-239`, `position: absolute` over the App root, z 99999, `pointerEvents: "none"` | n/a | passes through (only during a drag) |

The menubar dropdown (`MenuBar.tsx:529-538`, z 1000, absolute) has no backdrop and never reaches the job bar. Native dialogs are a separate class, under Physical failure outcomes.

### 2. Sidebar and job bar stacking

STOP paints at `z-index: auto` in the root stacking context. Nothing between it and the root creates a stacking context. The App root is `position: relative` with no z-index (`App.tsx:221-233`, :231). The main row is `display: flex; overflow: hidden` (:263). The sidebar is a flex column with `overflow: hidden` and no position (:284-292). The job bar's root sets only `flexShrink` and a border (`JobActionBar.tsx:173`). The STOP button has no position (:277-293). Its `disabled={!machineConnected}` (:279) is the only enable condition. Its cursor and opacity key off `jobRunning` (:286, :289), which A7 fixes. Two consequences follow. Any `position: fixed` element with z > 0 covers STOP. A z-index on STOP itself, with `position: relative`, competes in that same root context, so a single number can lift it over every overlay in the table, provided no ancestor gains a stacking context later.

The minimum window is 1000 × 600 (`src-tauri/tauri.conf.json:18-19`) and the sidebar is 300 px (`--panel-width`, `src/index.css:37`). A centred dialog reaches the sidebar when its width exceeds the window width minus 600 px. At 1280 the widest dialog (Dither, 640) ends at x 960, before the sidebar at 980. At 1000 every dialog over 400 px reaches it, and the ? sheet's `width: 90vw; maxWidth: 720px` (`ShortcutOverlay.tsx:148-149`) does too.

### 3. The global shortcut guard (F7) and the Tab fallback

- `useKeyboardShortcuts` is one bubble-phase `window` keydown listener (`shortcuts.ts:65-67`, :396). Its first act is `document.querySelector('[aria-modal="true"]')`. If any modal root is mounted it runs `containTab` for Tab and returns (`:73-87`), so every global shortcut is inert under a modal (refresh-editing-shortcuts F7, pinned by `src/lib/__tests__/shortcutsModal.test.tsx`). The comment at :71-72 names the two deliberate exceptions, `?` and Ctrl+K: "separate listeners, not this handler. Do not 'fix' that."
- The central Tab fallback `containTab` (`:41-63`) moves focus back into the modal when it is outside (`:53-55`) and wraps at the edges. It runs only if the dialog's own trap did not handle the edge (`:42`).
- `useFocusTrap` (`src/lib/hooks/useFocusTrap.ts:24-99`) is keyboard-only. It focuses `initialFocus` or the first focusable element on open (`:59-67`), it handles only Tab on the dialog element itself (`:69-97`, listener at :94), and it restores focus on close only if focus is on body or still inside the dialog (`:35-41`). It does not block pointer input anywhere. The backdrops do that.
- Every other keydown listener is bubble-phase on `window`: `useEscapeClose` (`useEscapeClose.ts:13`), five dialogs' own Escape handlers (`PdfImportDialog.tsx:231`, `VariableTextDialog.tsx:48`, `PowerCurveEditor.tsx:316`, `NestingDialog.tsx:27`, `DitherPreviewDialog.tsx:45`), the palette (`CommandPalette.tsx:453`, which `stopImmediatePropagation`s its own Escape at :449), the ? sheet (`ShortcutOverlay.tsx:108`, the same at :104), and Viewport's Space-pan (`Viewport.tsx:655-656`). None uses capture.
- **A bubble-phase Stop key would die in the canvas text editor.** Its React `onKeyDown` calls `e.stopPropagation()` first (`Viewport.tsx:1078-1079`). React 18 dispatches from the root container, so the native event never reaches a `window` bubble listener. A capture listener on `window` runs before the root container and before every listener above.
- **No binding uses "."** A grep of every `e.key` and `e.code` comparison in `src` outside tests finds Escape (18), Enter (11), arrows, Tab, Space, Delete, Backspace, PageUp and PageDown, letters, digits 0-6, `[ ] ? / = - +`, and none for ".". Modifier users are `shortcuts.ts`, `toolHandler.ts` (:538, Ctrl+Shift) and `CommandPalette.tsx` (Ctrl+K).

### 4. The stop path, end to end

1. **JobActionBar** `handleStop` (`JobActionBar.tsx:105-113`): `stopActiveSession()` (not awaited), `setJobRunning(false)`, `await machineConnection.emergencyStop()`. The comment at :106-109 calls the order safety-critical.
2. `stopActiveSession` (`jobSession.ts:243-262`) runs synchronously up to `await session.settled`: `cancel()` and a new `stoppingPromise`.
3. `setJobRunning(false)` notifies zustand subscribers synchronously. One of them is keep-awake's (`keepAwake.ts:47-65`), which on true→false calls `invoke("keep_awake_release")` (:59-63). **So on every STOP during a job the first IPC posted is `keep_awake_release`, and `serial_stop` is second.** `keep_awake_release` is an async command that does its work in `spawn_blocking` (`src-tauri/src/commands/power.rs:75-87`), so the stop is not queued behind it. The other subscriber is connection.ts's poll-suspend flag (`connection.ts:531-533`).
4. `emergencyStop` (`connection.ts:960-994`): `provisionalRevoke()` (store write, :962, body :86-88), `addConsoleLine("Emergency stop initiated")` (:963), then `invoke("serial_stop")` (:966-973). `@tauri-apps/api` 2.10.1's `invoke` is an async function whose body calls `window.__TAURI_INTERNALS__.invoke` synchronously (`node_modules/@tauri-apps/api/core.js:201-203`). The IPC is therefore posted before `emergencyStop` first yields, and before React re-renders anything. `serial_stop` takes no `conn` by design (`setupConnInvoke.ts:9` lists the conn-carrying commands; motion trust exempts `0x18`).
5. Native `serial_stop` (`src-tauri/src/commands/serial.rs:1587-1592`) runs `serial_stop_inner` (`:1393-1582`) in `spawn_blocking`. The steps are: single-flight `StopGuard` (`:1398`); close admission under `submit` (`:1432-1437`); invalidate the snapshot and set `job_abort`; clear `banner_observed`; write `0x18` on the realtime handle with one retry (`:1455-1482`); wait up to 3 s for a banner (`:1504-1537`).
6. Outcomes (`StopResult`, `serial_session.rs:129-146`, serde tag `outcome`): `confirmed {epochBefore, epochAfter, messages}` (banner seen; epoch incremented; phase Idle by CAS, `serial.rs:1539-1554`); `submittedUnconfirmed {epoch, messages}` (no banner in 3 s, or a concurrent disconnect moved the phase; phase Unknown, `:1555-1577`); `submissionFailed {epoch, error, messages}` (both writes failed or no port; phase Unknown, `:1484-1497`). Every message says beam state is unqualified.
7. TS (`connection.ts:978-993`): each message goes to the console, as an error on `submissionFailed` and a warning otherwise. On `submissionFailed`, `setMachineState("alarm")` (:983-985). On an IPC rejection, `setMachineState("alarm")` plus "E-stop send failed: … use the machine's physical stop." (:986-993). **Neither write checks the connection**, so a late failure from an earlier connection sets alarm on the current one.
8. Other callers of `emergencyStop`: `pauseJob` (`jobStream.ts:47-57`; Pause is stop), the stream's error and abort paths (`jobStream.ts:318`, :456), and `disconnect()` with a job or a run/hold state (`connection.ts:604-614`, awaited before teardown). Native also stops on its own inside `disconnect_inner_with_job` (`serial.rs:487`), on a sink failure (`:1291`) and in `serial_abort_job` (`:1375`, no TS caller). TS never sees the results of those three.

**The joiner can report an earlier stop.** A second `serial_stop` while one is in flight is a joiner. It polls for up to 3 s (`serial.rs:1403-1408`), then `take()`s `last_stop` (`:1409-1413`), or falls back to `submittedUnconfirmed` "joined existing stop operation". `last_stop` is written at the end of every stop (`:1494`, `:1579`) and never cleared at the start of one. It lives in the one `SerialSession` the app keeps for its whole run (`serial.rs:180`; `serial_session.rs:202`, :237). An owner whose banner wait runs the full 3 s (the unconfirmed case) outlasts a joiner that arrived within a few ms of it. That joiner then returns the previous stop's result as its own: possibly `confirmed`, possibly from an earlier connection. TB1 handles this in TS (the episode rule and the epoch floor, below) without touching native, and parks the native fix.

### 5. What the operator sees today

The console is closed by default (`store/index.ts:886`). The Machine panel is open by default (`MachinePanel.tsx:110`).

| outcome | console (closed) | in view |
|---|---|---|
| `confirmed` | "Emergency stop initiated", "STOP: 0x18 sent", "STOP: reset confirmed. Controller reset confirmed. Beam state unqualified — verify visually." (warnings) | nothing about the stop. The progress row disappears with `jobRunning` (`JobActionBar.tsx:175`). STOP keeps its pre-A7 dimmed look whenever no job runs (:289) |
| `submittedUnconfirmed` | "STOP: 0x18 sent", "STOP: unconfirmed — use the machine's physical stop before reconnecting. …" (warnings) | nothing. Native is now in phase Unknown, so the next START is refused by `serial_job_begin` (`serial.rs:1617-1622`) and reported only as a console line (`jobSession.ts:57-63`) |
| `submissionFailed` | "STOP failed: could not send reset. Use the machine's physical emergency stop. …" (error) | `machineState` alarm. The Machine panel's banner (`MachinePanel.tsx:473-534`) reads "Machine in ALARM state" (:496) and "A limit switch was triggered or motion was lost. Unlock and re-home to resume." (:499-500), an explanation that is wrong for a failed stop. The status bar label for alarm is "Error" (`machineStateDisplay.ts:19`) |
| IPC rejection | "E-stop send failed: … Beam state unqualified — use the machine's physical stop." (error) | as `submissionFailed` |

### 6. Stored states and STOP today

`machineStateToStore` maps jog and home to `run` and GRBL's unknown to `alarm` (`machineStatus.ts:99`, :103, :107; unreachable fallback `alarm` at :109). Check and sleep map to idle. A new connection starts stale (`store/index.ts:674`). `motionPending` defaults false (:204). It is set provisionally on every motion send, consoled moves included (`connection.ts:668`, :83-85; `isMotionCommand`, `jogBounds.ts:121-131`), and then mirrored from native snapshots (`machineStatus.ts:251`). A stationary Fire (`M3 S…`, `G4 P0.5`, `M5`) is not a motion command. So the store can read idle while the head moves (the jog window) or while the beam is commanded on (Fire). That is the reason, below, for raising STOP whenever it is enabled rather than only in states Kerf classifies as motion.

### 7. Polish-plan citations that moved with motion-trust

The polish plan's TB1 entry cites, at 958d22b: `shortcuts.ts:78-87`, now :73-87; `connection.ts:887-918`, now :960-994; `serial_session.rs:98-109`, now :129-146; `MachinePanel.tsx:455`, now :499; `store/index.ts:865`, now :886. The backdrop citations (`SettingsDialog.tsx:74-80`, `GrblSettingsDialog.tsx:133-139`, `MaterialTestDialog.tsx:295-307`) and the sidebar range hold (`App.tsx:262-292`, which now reads 263-319 to include `<JobActionBar />` at :318).

## Design

### A. Raised in-place STOP or a portal STOP surface

| criterion | raised in place (chosen) | portal surface |
|---|---|---|
| what it is | STOP and its outcome line in the job bar get `position: relative; zIndex: STOP_LAYER_Z` | a STOP rendered with `createPortal` into `document.body` at a top z: (i) always, positioned over the job-bar slot by measuring it; or (ii) a second STOP only while a modal is open |
| controls in the DOM | one STOP, one handler, A7's presentation reused | (i) one, plus a measured placeholder in A7's flex row; (ii) two STOPs while a modal is open, sharing a handler and presentation |
| focus-trap contract | `useFocusTrap` traps Tab only, on the dialog element, so it does not stop a pointer reaching STOP. `onMouseDown` preventDefault on STOP keeps focus where it was, so a click on STOP never moves focus out of the open dialog. Tab still cannot reach STOP from inside a modal (the dialog trap, then `containTab`), and the Stop key is the keyboard path | the same. A portal *inside* the dialog (a STOP in ModalShell) was also considered and rejected: it puts STOP into every dialog's Tab cycle and initial-focus order, which A3 fixed and TB9 owns, and it would miss the five surfaces A3 does not migrate (? sheet, palette, recovery, onboarding, GRBL) |
| A3 (ModalShell) | not needed. No dialog is edited. The stacking seam is STOP's own constant, and the scan reads both today's `zIndex: 9999` literals and A3's `backdropZIndex={9999}` props | not needed either |
| A7 (job bar) | edits `JobActionBar.tsx` after A7 merges (B3) | (i) edits it too (placeholder); (ii) duplicates A7's `stopPresentation` in a new file |
| failure mode | an ancestor that gains a stacking context (a `transform`, `isolation`, `filter`, `opacity < 1`, or a z-index with position) caps STOP below the backdrops. Closed by an ancestor tripwire test and by the browser's real hit-test | (i) a stale measurement leaves STOP drawn where the pointer does not land; (ii) tests and assistive tech meet two STOP buttons |
| top layer (`<dialog>.showModal()`, `popover`) | defeats it; banned by the scan | defeats it too; no z-index escapes the top layer |
| overlap with a large dialog at small windows | STOP sits over the dialog's bottom-right corner (§2) | identical: any surface above every dialog occupies that corner |

**Chosen: raised in place.** It is the smallest change that keeps one control, one handler and A7's presentation. Its one structural risk, an ancestor stacking context, is detectable both by a test and by a real hit-test, which the browser check runs at B3's base and head. The portal is not rejected categorically. It wins if the browser check finds a stacking context on STOP's ancestors that cannot be removed (for example a WebKit-specific compositing rule), or if a future surface must use the top layer. In either case B3 stops, and the portal (ii) is the fallback, re-planned and re-critiqued. Under every design the focus contract is identical, as the row above shows: pointer access to STOP is never a focus-trap question, because the traps are keyboard-only, and keyboard access is the Stop key.

**Raised whenever enabled, not only in motion states.** A conditional raise ("only while running, held, stale…") would make reachability depend on Kerf classifying the machine's state correctly. That classification is exactly what is uncertain here: Fire is not a motion command, a consoled move sits in the jog window, and a stale status reads idle. The z-index is unconditional. The cost is the corner overlap at windows narrower than about 1240 px. There STOP covers part of a large dialog's bottom-right corner, and a click meant for that corner can reset the controller (a lost job or lost homing, not a hazard). The browser check measures it at 1000 × 600, and the Parking Lot carries the follow-up.

### B. Sequencing with polish A1, A3 and A7

- **Assumed merged before B3:** A1 (tokens: `--danger-strong`, `--danger-text`, `--danger-bg`, `--danger-border`, `--warning`, `--warning-bg`, `--warning-border`, `--text-primary`) and A7 (`JobActionBar.tsx` presentation, `jobBarPresentation.ts` with `stopPresentation`, its test file). The hand-off records that A7 must merge before TB1 edits `JobActionBar.tsx`. Only B3 edits it.
- **Not assumed: A3.** TB1 edits no dialog, so A3's "one stacking seam" is not needed. If A3 lands mid-TB1, nothing in TB1 changes: the z-index scan reads ModalShell's props, and the modal registry (B2) mounts each dialog through its component and its unchanged `open`/`onClose` props. If A3 never lands, nothing changes either.
- **B1 and B2 do not wait on A7.** They share no file with any polish batch (`## Dependency graph and file ownership`). If the orchestrator prefers the hand-off's stricter reading ("A7 MUST merge before TB1 is implemented"), holding B1 and B2 costs nothing but time.
- **If A7 is dropped or reshaped:** B3 does not absorb A7's Track A items. The orchestrator re-briefs B3 against whatever `JobActionBar.tsx` is then, and the critic re-reads that brief.

### C. One stop function and the Stop key

**`src/lib/machine/operatorStop.ts` (new, B2):**

```ts
/** The operator's STOP: the button, the Stop key and the crash screen call this and nothing else.
 *  The three statements are JobActionBar.handleStop's, moved verbatim (order is safety-critical,
 *  DECISIONS 2026-09-20). Nothing may be added before emergencyStop(). */
export async function operatorStop(): Promise<void> {
  stopActiveSession(); // fire-and-forget: session settles after e-stop
  useStore.getState().setJobRunning(false);
  await machineConnection.emergencyStop();
}
```

`useStore.getState().setJobRunning` is the same function the component's selector returned (`JobActionBar.tsx:28`; zustand actions are stable). B3 replaces `handleStop`'s body with this call (`onClick={operatorStop}`). Until B3 merges, B2's equivalence test pins the key's IPC sequence and store-write sequence to the button's.

**`src/lib/stopKey.ts` (new, B2):**
- `isStopChord(e)`: `(e.ctrlKey || e.metaKey) && e.key === "."` and `!e.isComposing`. Shift is ignored, because "." needs Shift on AZERTY, and on US layouts Shift+. is ">" and so never matches. Alt is ignored.
- `installStopKey()`: idempotent. It adds one `window` keydown listener with `{ capture: true }` and returns an uninstall function for tests. `main.tsx` calls it beside `installKeepAwake()` (`main.tsx:11`), before React renders, so it is the first `window` keydown capture listener the app registers.
- The handler, for a stop chord only: `preventDefault()` and `stopImmediatePropagation()`, then return if `e.repeat`, then return if `!useStore.getState().machineConnected` (the button's `disabled`, `JobActionBar.tsx:279`), then `void operatorStop()`. It writes nothing, posts nothing and moves no focus before `operatorStop`. Every other key passes through untouched.
- Why it cannot conflict: no binding uses "." (§3). A Ctrl/⌘ chord inserts no text in an input, textarea, select or contenteditable. Capture phase runs before the canvas text editor's `stopPropagation`, before every dialog's Escape handler, and before F7's modal guard, which this listener does not change (it is a separate listener, the way `?` and Ctrl+K are, `shortcuts.ts:71-72`). It starts nothing: the polish plan's rule "no key or palette row starts motion or a burn" holds, and its declined list says "Stop gets a key in TB1". On macOS, ⌘. is the platform's long-standing cancel and interrupt chord ([Apple Developer Forums](https://developer.apple.com/forums/thread/53664); in Terminal "Command-Period (.) is equivalent to entering Control-C", [MacRumors thread](https://forums.macrumors.com/threads/ctrl-c-break-key-for-mac.917696/)). Whether WKWebView also turns it into a cancel action is an owner desktop check (D-3), and stop-first ordering holds either way.
- The listener survives a React crash: `main.tsx`'s `AppErrorBoundary` (:13-75) replaces the whole tree, job bar included, while the job loop keeps running outside React. The module-level listener and `operatorStop` do not depend on any component.

**Crash-screen STOP (B2).** `AppErrorBoundary` moves verbatim to `src/app/AppErrorBoundary.tsx`. Its crash screen gains a STOP button, rendered by a small function component that reads `machineConnected` through a scalar selector for `disabled` and calls `operatorStop`. Under it sits one static line (Copy ledger). The Parking Lot already records a malformed `gcodeResult` crashing the job bar. Today that crash leaves no STOP on screen while the stream continues.

**The ? sheet (B2)** gains a "Machine" group with one row: keys "Ctrl+. / ⌘.", action "STOP (sends a controller reset)" (`ShortcutOverlay.tsx`'s `SHORTCUT_GROUPS`, data only). **STOP's title (B3)** appends " Keyboard: Ctrl+. (⌘. on macOS)." to A7's title, and STOP gets `aria-keyshortcuts="Control+. Meta+."`.

### D. The stop outcome

**Where it is written.** Only in `emergencyStop`, so every stop shows: the button, the key, the crash screen, Pause, the stream's own abort, and `disconnect()`. The target shape (B1) changes nothing before the dispatch:

```ts
async emergencyStop(): Promise<void> {
  const store = useStore.getState();                                    // unchanged
  provisionalRevoke();                                                  // unchanged
  store.addConsoleLine("Emergency stop initiated", "warning");          // unchanged
  let attempt = 0;                                                      // a binding, no work
  try {
    const reply = invoke<StopResultWire>("serial_stop");                // dispatch, unchanged position
    attempt = beginStopAttempt(connId);                                 // TB1: first statement after dispatch
    const result = await reply;
    for (const msg of result.messages) { /* unchanged console lines */ }
    const current = settleStopAttempt(attempt, connId, result);
    if (result.outcome === "submissionFailed" && current) store.setMachineState("alarm");
  } catch (e) {
    const current = attempt ? settleStopAttempt(attempt, connId, { rejected: String(e) }) : true;
    if (current) store.setMachineState("alarm");
    store.addConsoleLine(`E-stop send failed: ${String(e)}. …`, "error");   // unchanged text
  }
}
```

No other JS runs between the `invoke(...)` call and `beginStopAttempt(connId)`, so `connId` there is the connection the dispatch was made on. `beginStopAttempt` is total: it has no throwing path, and it is wrapped so a fault falls back to "no view". A presentation bug can therefore never be reported as a send failure. `current` is true when the connection is unchanged since dispatch (equal ids; both 0 when disconnected, as in the existing tests). It guards the alarm write, which is today's §4 step 7 defect.

**`src/lib/machine/stopOutcome.ts` (new, B1)**, a module-level state machine. Its view lives in the store as `stopOutcome: StopOutcomeView | null` (runtime only: `toProject()` does not read it, `fileOps/index.ts:507`, `autoSave.ts:40`):

```ts
type StopPhase = "pending" | "confirmed" | "uncertain";
interface StopOutcomeView { readonly episode: number; readonly connId: number; readonly phase: StopPhase; readonly overdue: boolean; }
```

- **Episode.** `beginStopAttempt(conn)` returns a new attempt id. If the current view is `pending`, not yet overdue, and on the same `conn`, the attempt joins that episode. Otherwise a new episode starts: view `pending`, `floor` sampled (below), and the watchdog armed. A press after the watchdog has fired therefore starts a new episode, so one request that never answers cannot hold every later answer hostage.
- **Settle when all have answered, least-confirmed wins.** `settleStopAttempt(attempt, connNow, result)` records the attempt's classified result. The view leaves `pending` only when every attempt of the episode has answered. It then shows the minimum (`uncertain` < `confirmed`). So a joiner's stale `confirmed` that lands first can never show "Stopped" while the owner's answer is outstanding, and the owner's later `submittedUnconfirmed` decides.
- **Classification.** `confirmed` only if `outcome === "confirmed"`, `epochAfter` is a finite number, and `epochAfter > floor`. Everything else is `uncertain`: `submittedUnconfirmed`, `submissionFailed`, an IPC rejection, an unknown outcome string, a malformed reply, and a replay. `floor` is the highest native session epoch TS had seen when the episode began: the max of every `confirmed` `epochAfter` received (dropped ones included) and the last accepted status-snapshot epoch (`machineStatus.ts:191`, through a new one-line getter). Snapshots and stop results share `session.epoch` (`grbl_status.rs:100-102`; `serial.rs:1395`; `serial_session.rs:275-277`), and it only ever increments. So a fresh stop's `epochAfter` always exceeds the floor, and a replayed earlier result never does. A joined copy of the same stop carries the same `epochAfter`, which is above the floor sampled at that episode's start.
- **Connection identity.** A result whose dispatch `conn` differs from the current `connId` changes neither the view nor `machineState`. Its console lines still append, and its `epochAfter` still raises the floor. A result for an attempt outside the current episode (a newer stop has started since) changes nothing.
- **Lifetime.** `stopConnectionEnded(conn)` is called from `disconnect()` right after `connId = 0` (`connection.ts:636`), with the old id. A `pending` view on that connection becomes `uncertain`, its watchdog is cleared, and its outstanding attempts are abandoned. `stopConnectionStarted(conn)` is called from `connect()` right after `connId = connected.connId` (`:488`). It clears any view, pending or settled, from another connection, and abandons that view's outstanding attempts: the operator has acted on the machine by reconnecting, and the console keeps the record. `stopJobBegan()` is called from `beginJobSession` after a session is created (`jobSession.ts:65-66`; the only door for job, frame, material test and its frame, `JobActionBar.tsx:72`, :143, `MaterialTestDialog.tsx:240`, :263). It clears a settled view and never a pending one. A newer stop replaces the view. Loading a project or New (`loadProject`) does not touch it: the outcome belongs to the machine connection, not the project.
- **Watchdog, replacement-safe.** `STOP_OVERDUE_MS = 7000`. That exceeds native's own worst case: at most one in-progress `write(2)` under `submit` (bounded by the 1000 ms port timeout, DECISIONS 2026-09-24), two `0x18` attempts each bounded by that timeout, the 3000 ms banner wait (`serial.rs:1504`) and its last 50 ms sleep, about 6.05 s. One timer per episode, holding the episode id. When it fires it writes only if the view is still that episode and still `pending`, and then it sets `overdue: true`. Settling, clearing, a new episode and a connection end all clear it. A late answer for the same episode and connection still replaces an overdue view, because truth wins. With no other timer in TB1, auto-hiding is not a thing: the view stays until replaced or cleared as above.
- **Store rule.** JobActionBar reads `useStore((s) => s.stopOutcome)`, a whole-object reference that is replaced only on change (CLAUDE.md, React error 185), plus the scalar `motionPending`.

### E. States: STOP enabled, raised and visibly live

| state (as stored) | STOP enabled | presentation (A7 rule, plus TB1) | raised above overlays | key |
|---|---|---|---|---|
| disconnected | no (`!machineConnected`) | disabled, opacity 0.4 | yes (inert) | no-op |
| connected, idle, fresh, nothing pending | yes | outline | yes | stops |
| run (job, jog, home) | yes | solid | yes | stops |
| hold, door, alarm (GRBL unknown stores as alarm) | yes | solid | yes | stops |
| stale (`statusStale`, incl. the first interval after connect) | yes | solid | yes | stops |
| idle stored but `motionPending` (the jog window before the first report) | yes | **solid (TB1)** | yes | stops |
| idle stored, `jobRunning` true (poll off during a job) | yes | solid (A7) | yes | stops |
| a stop pending or uncertain (native may be in phase Unknown) | yes | **solid (TB1)** | yes | stops (joins or starts an episode) |
| React crash screen | crash-screen STOP, enabled when connected | static | n/a | stops |

`stopPresentation` (A7, `jobBarPresentation.ts`) gains two inputs, `motionPending` and `stopUncertain` (view phase `pending` or `uncertain`). Either one forces "solid" while connected. "Disabled" stays exactly `!machineConnected`.

### F. The outcome line

The line sits in the job bar above A7's refusal and "Not in the G-code" lines. It is raised with STOP (`position: relative; zIndex: STOP_LAYER_Z`) so it can be read above a dialog's dim. It has `data-testid="stop-outcome"` and `role="status"`, with `aria-live` set to polite for pending and confirmed and assertive for uncertain. It never uses `role="alert"`, because `machineJobLoop.test.tsx` reads Material Test's single alert with `queryByRole("alert")`. The look uses A1 tokens: 12 px/600 `--text-primary` with a 6 px dot. Pending sits on `--warning-bg` with a `--warning` dot and a 1 px `--warning-border`. Uncertain (and overdue) sits on `--danger-bg` with a `--danger` dot and a 2 px `--danger` left rule. Confirmed sits on `--bg-input` with a `--text-secondary` dot. It has no button, and the text never equals "STOP" (`machineJobLoop.test.tsx:420` finds the button with `getByText("STOP")`).

## Copy ledger

Every string TB1 adds or changes, with its basis: a code fact, a DECISIONS entry, or command description only. None says the beam went dark, and none states a movement or an emission. Advice is conditional or imperative.

| where | string | basis |
|---|---|---|
| outcome, `pending` | "Stopping. Kerf is sending a controller reset. If the laser is still running, press the machine's emergency stop button." | code fact: the view is written right after `invoke("serial_stop")` is dispatched and before its answer (§D); `serial_stop` writes `0x18` (`serial.rs:1455-1482`). The second sentence is conditional advice, not a claim |
| outcome, `uncertain` and `overdue` | "Kerf couldn't confirm the stop. Press the machine's emergency stop button now." † | the polish plan's string. True in every case it shows: no fresh `confirmed` answered this episode (rejection, `submittedUnconfirmed`, `submissionFailed`, replay, connection closed, or 7 s with no answer). The console keeps native's specific message |
| outcome, `confirmed` | "Stopped. The controller was reset. Kerf can't see the laser itself, so check that it's off." † | the polish plan's string. `confirmed` means a reset banner was seen (`serial_session.rs:131`, `serial.rs:1539-1554`). "Stopped" names Kerf's own action: the job ended (`jobRunning` false) and admission closed (`serial.rs:1432-1437`). Status-only ruling: the beam is named only as something to check |
| crash screen | button "STOP"; line "If a job was running, it may still be running. STOP sends a controller reset (keyboard: Ctrl+. or ⌘.). This screen can't show whether the stop was confirmed, so also press the machine's emergency stop button." † | code fact: the job loop is module code awaited by handlers, not part of the React tree (`JobActionBar.tsx:79-83`, `jobStream.ts`); the crash screen renders no outcome |
| STOP title (appended to A7's) | " Keyboard: Ctrl+. (⌘. on macOS)." †; `aria-keyshortcuts="Control+. Meta+."` | code fact: `stopKey.ts` |
| ? sheet | group "Machine", row "Ctrl+. / ⌘." → "STOP (sends a controller reset)" | code fact: the key calls `operatorStop`, which ends in `serial_stop` (DECISIONS 2026-09-20) |

† asserted verbatim by the named tests. Existing console strings are unchanged.

## Batches

Every batch runs vitest (full suite, `--cache=false` as the worktrees require), `tsc --noEmit`, lint and prettier, plus the scope check in Verification 1. New tests are mutation-verified through `scripts/mutation-battery.mjs` with the ids listed. Every batch is reviewed by Razor: protected statements byte-identical; the React error 185 check on every `useStore` call; nothing added before the dispatch. B3 is also reviewed by Jen at Stage 3 against polish principles 1-4. No batch edits anything under `src-tauri/`.

**B1. Stop outcome core (identity, episodes, watchdog).**
- Files (8): new `src/lib/machine/stopOutcome.ts`; `src/lib/machine/connection.ts` (`emergencyStop` post-dispatch only, and the two connection hooks); `src/lib/machine/jobSession.ts` (one `stopJobBegan()` call); `src/lib/machine/machineStatus.ts` (one exported getter for the accepted snapshot epoch); `src/app/store/storeTypes.ts` and `src/app/store/index.ts` (the `stopOutcome` field, default null, and `setStopOutcome`); new `src/lib/machine/__tests__/stopOutcome.test.ts`; new `src/lib/machine/__tests__/stopOutcomeIpc.test.ts`.
- Protected (byte-identical): `connection.ts:960-965` and the dispatch expression (:966-973); the console-message loop (:978-981); the rejection console text (:989-992); `provisionalRevoke`, `connect()` and `disconnect()` except the two one-line hook calls placed after the `connId` assignments; `beginJobSession`'s refusals and `stopActiveSession`; `consumeStatusOutcome`'s logic.
- Tests, `stopOutcome.test.ts` (pure, fake timers): the classification table (each outcome; a missing, non-finite or ≤-floor `epochAfter`; an unknown outcome string); join and settle-all (two attempts, either answering order, view `pending` until both have answered, then the minimum); a newer episode ignores an older episode's late answer; `stopConnectionEnded` turns a pending view uncertain and leaves a settled one alone; `stopConnectionStarted` clears another connection's view; `stopJobBegan` clears settled and keeps pending; the watchdog fires once at 7000 ms, does nothing if settled first, does not mark a later episode (two episodes back to back with the first timer still queued), and a late same-episode `confirmed` replaces `overdue`; after the watchdog fires on a hung attempt, a second press starts a new episode and its `confirmed` shows.
- Tests, `stopOutcomeIpc.test.ts`, through the real `machineConnection.emergencyStop()` with `invoke` mocked so each `serial_stop` returns a deferred promise the test resolves:
  - **Not before dispatch.** The mock snapshots `useStore.getState().stopOutcome` and the ordered list of store keys written since the call. At the instant `serial_stop` is invoked, `stopOutcome` is unchanged and the written keys are exactly the base ones (the trust fields from `provisionalRevoke`, then `consoleLines`).
  - **At once.** Immediately after `emergencyStop()` returns its promise (no `await`, no microtask), `stopOutcome.phase === "pending"`.
  - **Two stops out of order.** A then B. B first resolves with a replayed `confirmed` (`epochAfter` at the floor), then A with `submittedUnconfirmed`. Every view transition is recorded: no `confirmed` ever appears, and the final view is `uncertain`. In the reverse case, a fresh `confirmed` for both resolved in either order ends `confirmed` only after the second.
  - **Repeated STOP after a settled stop** starts a new episode, and the old one's duplicate answer is ignored.
  - **Reconnect before resolution.** A is dispatched on conn 1. `disconnect()` makes the view uncertain. `connect()` (mock returns `connId` 2) clears the view. A then resolves `submissionFailed`: `machineState` is whatever conn 2's status set (not alarm), the view stays null, and A's console lines are present. Rejection variant: the same, with no alarm.
  - **Hung IPC.** A never resolves. At 7000 ms the view is overdue (fake timers). A later `confirmed` replaces it.
  - **Existing behaviour.** `connection.test.ts`'s emergencyStop block (:476-565) passes unmodified, including `calls` exactly `["serial_stop"]` and alarm on `submissionFailed` with connId 0 at both ends.
- Mutations (ids): SR-01 `beginStopAttempt` moved above the `invoke` (fails "not before dispatch"); SR-02 moved below the `await` (fails "at once"); SR-03 the view shows the last answer instead of the minimum; SR-04 the episode settles on its first answer; SR-05 the connection check dropped from `settleStopAttempt`; SR-06 the alarm write unguarded; SR-07 the floor check removed; SR-08 the watchdog callback without its episode check; SR-09 the watchdog not cleared on settle; SR-10 `stopConnectionEnded` a no-op; SR-11 `stopJobBegan` clears pending; SR-12 `stopConnectionStarted` a no-op; SR-13 a press joins an overdue episode (fails the hung-attempt case). Test command: the two new files plus `connection.test.ts`, `jobStream.test.ts`, `motionTrust.test.ts`.
- Depends: none. Parallel with B2.
- Risk: medium. It edits `connection.ts`, after the dispatch only. Razor diffs `:960-973` against the base byte for byte.

**B2. One stop function, the Stop key, the crash-screen STOP.**
- Files (8): new `src/lib/machine/operatorStop.ts`; new `src/lib/stopKey.ts`; new `src/app/AppErrorBoundary.tsx` (the class from `main.tsx:13-75`, moved verbatim, plus `CrashScreenStop`); `src/main.tsx` (import it, call `installStopKey()`); `src/components/panels/ShortcutOverlay.tsx` (one data row); new `src/lib/__tests__/stopKey.test.tsx`; new `src/lib/__tests__/modalRegistry.tsx` (test helper); new `src/app/__tests__/crashScreenStop.test.tsx`.
- Protected: `operatorStop`'s three statements equal `JobActionBar.tsx:110-112` in order. The crash screen's existing markup, copy and Retry stay. `installKeepAwake()` stays first in `main.tsx`. `ShortcutOverlay`'s listener (`:88-110`) is untouched.
- `modalRegistry.tsx`: it source-scans every `.tsx` that renders `aria-modal="true"`, the same walk as `modalFocusContainment.test.tsx`, and requires a registry entry for each one, giving the props that mount it open (Trace contributes two entries). It also requires that mounting each entry yields an `[aria-modal="true"]` element. Positive control: at least 17 files, including `SettingsDialog.tsx`, `ShortcutOverlay.tsx` and `App.tsx` (recovery, mounted as `appRecoveryFocus.test.tsx` mounts it; `vi.mock` is per file, so each test file that uses the App entry declares that file's module mocks, with JobActionBar left real where the test needs it). A new modal without an entry fails the suite.
- Tests, `stopKey.test.tsx`: real `KeyboardEvent`s dispatched at the focused element (bubbling, through the DOM's dispatch, React and every listener), with `invoke` mocked:
  - **Matrix (full product):** every registry surface plus "none" × the states in §E (disconnected, idle-fresh, run, hold, door, alarm, stale, `motionPending`, `jobRunning`) × focus on the surface's first text input (or its root if it has none). Ctrl+. invokes `serial_stop` exactly once when connected and never when disconnected. The surface is still mounted afterwards, the input's value is unchanged, the event is `defaultPrevented`, and a bubble-phase `window` spy saw nothing.
  - **Focus and key variants** on the no-modal, Settings, palette, Material Test and recovery surfaces: body, textarea, select, contenteditable, a React textarea whose `onKeyDown` calls `stopPropagation` (the canvas text editor's shape, `Viewport.tsx:1078-1079`), and the Console input. Keys: Ctrl+., Meta+., Ctrl+Shift+. (stop); plain "." (types a period, no stop); Alt+. (no stop); Ctrl+. with `repeat: true` (no second stop).
  - **Same path as the button.** For each state, the ordered `invoke` command list and store-write keys from key press to `serial_stop` equal those from a click on JobActionBar's STOP, with `installKeepAwake()` installed: `["keep_awake_release", "serial_stop"]` when a job was running, `["serial_stop"]` otherwise. That is today's order.
  - **Idempotent install:** two installs, one press, one `serial_stop`.
- Tests, `crashScreenStop.test.tsx`: a child that throws inside `AppErrorBoundary` shows the crash screen with STOP and the exact line. A click invokes `serial_stop`. It is disabled when disconnected. Ctrl+. still stops while the crash screen shows.
- Mutations: SR-21 the listener in bubble phase (fails the `stopPropagation` textarea case); SR-22 the modifier check dropped (fails "plain period"); SR-23 the connected check dropped (fails disconnected); SR-24 `repeat` not ignored; SR-25 `operatorStop`'s statements reordered (`emergencyStop` before `setJobRunning`; fails the write-order equality); SR-26 an extra `invoke("serial_get_status")` before `emergencyStop` in `operatorStop`; SR-27 the install not idempotent; SR-28 the crash-screen STOP not wired; SR-29 `stopImmediatePropagation` removed (the bubble spy sees the chord); SR-30 a registry entry mounted with `open={false}` (fails the positive control).
- Depends: none. Parallel with B1.
- Risk: low to medium. A global capture listener is new. It acts only on one chord and changes nothing else (the spy tests).

**B3. STOP above every overlay, the outcome line, live presentation (after A7).**
- Files (7): `src/components/panels/JobActionBar.tsx`; `src/components/panels/jobBarPresentation.ts` (`STOP_LAYER_Z`, `stopPresentation`'s two inputs, `stopOutcomeText(view)`); `src/components/panels/__tests__/jobBarPresentation.test.tsx` (A7's; cases added, the STOP title expectation updated); new `src/components/panels/__tests__/stopReach.test.tsx`; new `src/lib/__tests__/stopLayer.test.ts`; new `scripts/ui-audit/tauri-mock.js`; new `scripts/ui-audit/stop-reach.js`.
- `JobActionBar.tsx` changes: `onClick={operatorStop}` (handleStop's body moved out in B2); STOP's style adds `position: "relative"`, `zIndex: STOP_LAYER_Z` and `onMouseDown={(e) => e.preventDefault()}`; the title suffix and `aria-keyshortcuts`; the outcome line. Protected: every other handler, `disabled=` and `title=` expression A7 left, the elapsed-timer effect, and START/FRAME/PAUSE untouched. STOP's `disabled={!machineConnected}` is byte-identical.
- Tests, `jobBarPresentation.test.tsx`: `stopPresentation` over connected × job × every stored state × stale × `motionPending` × stop phase. The result is "disabled" exactly when disconnected, and "solid" for every connected combination with `motionPending` or a pending or uncertain stop. `stopOutcomeText` exact strings per phase and for overdue. The exact STOP title.
- Tests, `stopReach.test.tsx`, with JobActionBar mounted beside each registry surface (B2's helper) in every §E state:
  - A pointer sequence (`pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`) dispatched at STOP invokes `serial_stop` once when connected. The surface stays mounted. The `mousedown` is `defaultPrevented`. `operatorStop` is the function called (the module is mocked; the key test calls the same mock). STOP and the outcome line carry `zIndex` equal to `STOP_LAYER_Z` and `position: relative`.
  - Every element in the mounted surface has an inline z-index below `STOP_LAYER_Z` (a runtime walk that catches computed values a source scan misses).
  - The outcome line shows each exact string, and pending shows synchronously after the click.
  - Honest scope: jsdom has no layout or hit-testing. This file proves the handler, focus and stacking styles. It cannot prove a pointer reaches STOP over a backdrop, and it would pass at the base for that reason. The browser half below is the reachability evidence, and it fails at the base.
- Tests, `stopLayer.test.ts`:
  - A source scan of `src/**/*.{ts,tsx,css}` outside tests for `zIndex: N`, `[A-Za-z]*ZIndex={N}`, `[A-Za-z]*ZIndex = N` and `z-index: N`. Every literal is below `STOP_LAYER_Z`. Positive control: at least 40 literals found (46 today), including 99999 (`App.tsx`) and 2000 (`MaterialTestDialog.tsx`).
  - No `showModal(`, `popover=` or `requestFullscreen(` anywhere in `src`.
  - Ancestor tripwire: render `App` with the `appRecoveryFocus.test.tsx` mocks but the real JobActionBar, and walk from STOP to the root. No ancestor has an inline `zIndex` together with a position, or a `transform`, `filter`, `isolation`, `willChange`, `contain` or `opacity` below 1.
- Browser scripts (dependency-free, committed beside A1's `contrast-walk.js`):
  - `tauri-mock.js`, installed with `evaluateOnNewDocument` as `window.__TAURI_INTERNALS__`. It ports the motion-trust evaluator's mock (shapes from the serde structs only) and adds `serial_stop` modes `confirmed`, `unconfirmed`, `failed`, `reject` and `hold` (deferred; `__kerfMock.releaseStop(i, outcome, epochAfter)`), plus an IPC log `[seq, ts, cmd, args]`.
  - `stop-reach.js`: in-page helpers to open each surface (store `openDialog`, the Help menu for onboarding, the mock's recovery-file answer for the recovery prompt), to return STOP's centre and the outcome line's rect, to log `pointerdown` targets with a `window` capture logger, and to walk computed z-indexes and `:modal` / `:popover-open` matches.
- Mutations: SR-41 STOP's `zIndex` removed; SR-42 `STOP_LAYER_Z` set to 9999; SR-43 `zIndex: 2000000` added to `SettingsDialog.tsx`'s backdrop; SR-44 `zIndex: 0` added to the sidebar div in `App.tsx`; SR-45 `onMouseDown` removed; SR-46 STOP's `onClick` bound to a local copy of the three statements; SR-47 `stopPresentation` ignores `motionPending`; SR-48 it ignores the stop phase; SR-49 the uncertain and confirmed strings swapped; SR-50 the outcome line's `zIndex` removed; SR-51 the `stopOutcome` selector returns `{ ...s.stopOutcome }` (the render test must fail with React's update-depth error). Test command: the three test files plus `machineJobLoop.test.tsx` and `gcodeFailureLoud.test.tsx`.
- Depends: A1 and A7 merged; B1; B2. Not A3.
- Risk: medium. This is the visible change on the stop control. Jen reviews the line and the raised STOP over a dim. Razor diffs every `onClick=` and `disabled=` in the file against A7's merge.

## Dependency graph and file ownership

| batch | depends on | parallel with | files (exclusive to the batch) |
|---|---|---|---|
| B1 | none | B2; any polish batch | `stopOutcome.ts` (new), `connection.ts`, `jobSession.ts`, `machineStatus.ts`, `storeTypes.ts`, `store/index.ts`, `stopOutcome.test.ts` (new), `stopOutcomeIpc.test.ts` (new) |
| B2 | none | B1; any polish batch | `operatorStop.ts` (new), `stopKey.ts` (new), `AppErrorBoundary.tsx` (new), `main.tsx`, `ShortcutOverlay.tsx`, `stopKey.test.tsx` (new), `modalRegistry.tsx` (new), `crashScreenStop.test.tsx` (new) |
| A7 (polish) | A1 | | `JobActionBar.tsx`, `jobBarPresentation.ts`, `jobBarPresentation.test.tsx`, `layerContents.ts`, `layerContents.test.ts` |
| B3 | A1, A7 merged; B1; B2 | polish batches other than A7 | `JobActionBar.tsx`, `jobBarPresentation.ts`, `jobBarPresentation.test.tsx` (all three after A7), `stopReach.test.tsx` (new), `stopLayer.test.ts` (new), `scripts/ui-audit/tauri-mock.js` (new), `scripts/ui-audit/stop-reach.js` (new) |

**Against the polish batches.** Track A never edits `src/app/store/**` or `src/lib/machine/**`, except A12's `machineStateDisplay.ts`, which TB1 does not touch. No polish batch lists `main.tsx`, `ShortcutOverlay.tsx` (the ? sheet is "not migrated", principle 6), `jobSession.ts`, `machineStatus.ts` or the new files. A2 edits `App.tsx` and TB1 does not: `AppErrorBoundary.tsx` is a new file beside it, and SR-44 mutates `App.tsx` only inside the battery's disposable copy. A3, A4, A5 and A11 edit the dialogs, and TB1 edits none. A1 creates `scripts/ui-audit/contrast-walk.js`, and TB1 adds two other files in that directory. The only shared files are A7's three, and B3 edits them strictly after A7 merges. No file is edited by TB1 and a concurrent polish batch. Among Track B plans, TB6 also edits `JobActionBar.tsx` and runs after TB1, per the polish order.

**Batch rule.** Each batch is at most 8 files. Each spans more than one directory: B1 `src/lib/machine` plus `src/app/store`; B2 `src/lib`, `src/app`, `src/components/panels` and `src/main.tsx`; B3 panels, `src/lib/__tests__` and `scripts/ui-audit`. Waiver for "one subsystem root", in the polish plan's form: each batch is one seam (the outcome core; the operator stop entry points; the job bar's stop surface) plus its tests, its files are exclusive to it, and a reviewer reads it as one unit.

## Verification

1. **Scope.** `git diff --name-only <base>...HEAD` lists only the batch's files. Nothing under `src-tauri/` or `src-tauri/tests/golden/` appears, and no dialog file does (`*Dialog.tsx`, `CommandPalette.tsx`, `OnboardingOverlay.tsx`, `PowerCurveEditor.tsx`, `App.tsx`). `gcodeGen.ts`, `materialTestGcode.ts`, `jogBounds.ts`, `canStartJob.ts` and `jobStream.ts` are untouched. The Rust suite is not re-run per batch, because rule 1 proves `src-tauri/` unchanged; CI runs it on master (`.github/workflows/ci.yml:84-85`).
2. **Nothing before the dispatch.** Razor confirms that `JobActionBar.tsx:110-112` (moved to `operatorStop`) and `connection.ts:960-973` are byte-identical in order and content, apart from the declared `let attempt = 0;` binding. B1's "not before dispatch" test and B2's "same path as the button" test are the executable form, and SR-01, SR-25 and SR-26 prove they can fail.
3. **Unmodified suites.** These pass with no edit: `connection.test.ts`, `machineJobLoop.test.tsx` (STOP click at :368-432; `getByText("STOP")` at :420), `jobStream.test.ts`, `motionTrust.test.ts` (it never settles a stop at :423 and mocks `confirmed` without `epochAfter` at :114, and neither path asserts the view), `keepAwake.test.ts`, `shortcutsModal.test.tsx`, `shortcutDispatchOrder.test.tsx`, `shortcutsWriters.test.tsx`, `modalFocusContainment.test.tsx`, `useFocusTrap.test.tsx`, `nestingDialogFocus.test.tsx`, `appRecoveryFocus.test.tsx`, `appPdfWiring.test.tsx`, `gcodeFailureLoud.test.tsx`. The only pre-existing test TB1 edits is A7's `jobBarPresentation.test.tsx` (B3, named above).
4. **The matrix, in jsdom (B2 keyboard, B3 pointer wiring).** Real DOM events through the DOM's dispatch, React and every listener, over every registry surface × every §E state × focus. The jsdom pointer half is wiring only, stated in B3.
5. **The matrix, in a real browser (B3; CLAUDE.md Testing SOP).** The relay serves its own worktree with `npm run dev` on its own port, never killing a server by port. A private headful Chrome is driven by puppeteer over CDP, as the motion-trust evaluator did. `scripts/ui-audit/tauri-mock.js` is installed before load, with `kerf-last-port` set so the app auto-connects to the mock (the evaluator's quirk). `page.mouse.click(x, y)` and `page.keyboard` send trusted input through real hit-testing.
   - Surfaces: the 18 registry surfaces, the canvas context menu, and none. States: idle-fresh, run (a held `serial_stream_job`), hold, door, alarm, unknown (mock state `unknown`), stale (mock stops answering status), `motionPending` (a held jog), and stop pending (a held `serial_stop`). Dispatch: a pointer click at STOP's centre, and Ctrl+. with focus in the surface's first input. Viewports 1440 × 900 and 1280 × 800.
   - Per case: exactly one new `serial_stop` in the IPC log; `[aria-modal="true"]` (or the context menu) still present; `document.activeElement` unchanged; for the key, the input's value unchanged; for the pointer, the capture logger's `pointerdown` target is STOP. The IPC commands between press and `serial_stop` equal the base recording. No element other than STOP and its line has computed z-index ≥ `STOP_LAYER_Z`, and nothing matches `:modal` or `:popover-open`. A `document.elementFromPoint` reading is recorded as a supplement only.
   - At 1000 × 600, pointer only: the same assertions, plus the intersection of STOP's rect with each surface's panel. Any intersection is listed with the controls under it.
   - **Base run (falsifiability).** The same script at B3's base (A7 merged, no TB1): the pointer case must show no `serial_stop` and the surface closed (or, for onboarding and recovery, still open with no stop), and the key case no `serial_stop`. A base run that stops is a broken script.
   - Outcomes: each mock mode's line text recorded; `hold` past 7 s shows the overdue wording, and release `confirmed` then shows confirmed. Two held stops: release the second as a replayed `confirmed` (low `epochAfter`), then the first `unconfirmed`. A `MutationObserver` on the line must never record the confirmed text. Reconnect: hold a stop, Disconnect, Connect, release `failed`; the status bar is not Alarm and the line is absent. Crash: force a render error (inject a malformed `gcodeResult`, the parked crash); the crash screen's STOP and Ctrl+. each log `serial_stop`.
   - Evidence: shots at both sizes for each outcome and for STOP over a dimmed Preferences, Material Test, onboarding and recovery, plus the per-case JSON log and a `manifest.json`, all under `~/marvin/state/relay/<relay-id>/evidence/` and named in the relay pack.
6. **Owner desktop checks** (release build; no laser motion or burn; logged in ROADMAP `next` at Stage 3.5 with steps):
   - D-1 (Linux WebKitGTK): connected and idle, open Preferences. STOP is drawn above the dim. One click: Preferences stays open, the job bar shows the pending line ("Stopping. …") and then the confirmed line. This resets the controller and clears homing, as any STOP does.
   - D-2: the same with Ctrl+. and focus in Preferences' width field. The field's value is unchanged.
   - D-3 (macOS, if available): ⌘. as D-2. Record whether the dialog also closes (a WKWebView cancel action). Either result is accepted. The stop must happen.
   - D-4: Ctrl+. while editing text on the canvas.
   - D-5: with File > Open's native dialog open, record whether STOP or Ctrl+. reach Kerf. Expected not (see Physical failure outcomes). This records a limit and does not fail the relay.
7. **Owner hardware checks** (Lee at the machine, fire precautions as on the cards; evidence is status-only and the owner's own observation, never a claim about the beam):
   - H-1, folded into the fence card (ROADMAP `next`, RF-15 FENCE WIRING), as step 1b after step 1. Frame a design, open Preferences mid-frame, and click STOP once. Then, as step 3b with step 3's short low-power job on scrap, open Preferences mid-job and click STOP once. Expected: the head stops, Preferences stays open, the console shows step 1's lines, and the job bar shows the pending line and then an outcome line. Record which line showed. If it is the uncertain line, press the e-stop and record it.
   - H-2, folded into the JOG TRUST CARD (laser power isolated, homed, bed confirmed). Select the 50 mm jog step (`MachinePanel.tsx:1095`), which is about 3 s at the panel's jog feed, and jog. While it moves, open the palette (Ctrl+K) and press Ctrl+. once. Repeat with a click on STOP over the open palette. Repeat with no dialog and focus in the console input. Expected each time: the head stops early, the palette stays open, and the outcome line shows.
   - Neither check, nor anything else in this plan, shows the beam is off. That needs the witness-card procedure (DECISIONS status-only entry, amended 2026-09-25), and TB1 claims nothing that needs it.

### Physical failure outcomes (software cannot certify beam extinction)

Kerf's best evidence is that the controller printed a reset banner after Kerf wrote `0x18`. That is what "confirmed" means, and no software state proves the beam is dark. Named failure outcomes, each with what Kerf shows:
- **The reset reaches the controller and the beam or motion does not stop.** DECISIONS 2026-09-05 records a `0x18` that failed to stop the beam on 2026-09-02 on the owner's vendor fork. Kerf may even show "confirmed". The confirmed line therefore tells the operator to check, and only the machine's e-stop is the stop.
- **The reset never reaches the wire.** A wedged USB adapter (`POLLOUT` reported, URBs not completing; Parking Lot, the stop's Step 5 `tcdrain`), a pulled cable, or a dead port. The result is `submissionFailed`, `submittedUnconfirmed` after 3 s, or a hang past 7 s: the uncertain line.
- **The controller keeps executing what it already holds.** Up to the 127-block planner, and the 65,536-byte receive buffer in buffered mode (`[OPT:VHL,127,65536]`, DECISIONS 2026-09-05). The one admitted job line before the stop may run (ARCHITECTURE, Admission fence residuals). Console, Fire and settings writes are not phase-gated and can land after a stop (ARCHITECTURE residuals; Parking Lot).
- **The laser-switch wedge** (open, DECISIONS 2026-09-10 as amended 2026-09-27): the controller stops acking lines but answers `?`, and `0x18` is the recovery. A stop there may be unconfirmed if the banner read is lost (Parking Lot: the drain can discard a stop's banner, with "a false 'unconfirmed, use the physical stop' message after 3 s").
- **Kerf's window cannot take input.** A native file or message dialog is open (Open, Save, Import and Material Library's save and open: `fileOps/index.ts:81`, :281, :346, :393, :407, :428, :441, :458, :477; `MaterialLibrary.tsx:117`, :133). Or the welcome-guide `confirm()` (`MenuBar.tsx:436`) is open, which blocks the JS thread itself. Or the webview's main thread is hung. STOP, the key and the crash screen are all unreachable. Only the machine's e-stop works.
- **The app process exits.** Nothing is sent. Whether the port closing resets the controller is unknown for the vendor fork.
- **A native select menu is open.** Its first click may only dismiss the menu (platform behaviour, unverified here). The key is unaffected.

## Risks and rollback

- **R1, corner overlap below about 1240 px width** (§2): an unwanted reset (lost job or homing), not a hazard. It is measured at 1000 × 600 and parked with a follow-up.
- **R2, a future overlay at or above `STOP_LAYER_Z`, or a top-layer dialog:** `stopLayer.test.ts` fails in CI. The browser walk catches computed values.
- **R3, an ancestor gains a stacking context** (A2 restyles the sidebar): the tripwire test fails. If it cannot be removed, B3's fallback is the portal (Design A).
- **R4, a platform swallows the chord** (WKWebView or a desktop shortcut): the button still works. D-2 and D-3 record it, and D1's answer can add a second chord.
- **R5, misleading outcomes from late or duplicate answers:** the episode, minimum, connection and floor rules, with B1's out-of-order tests and SR-03 to SR-07; a hung request is bounded by the watchdog and SR-13.
- **R6, a second press:** a joiner sends no byte (native single-flight). A press that arrives after native finished but before TS heard is a new stop with its own `0x18`, exactly as two clicks are today.
- **R7, the job bar grows by one or two lines:** the sidebar's middle region scrolls and STOP stays pinned (polish Preserve: the three-region sidebar).
- **R8, the capture listener interfering with typing:** only the Ctrl/⌘+"." chord is touched (spy tests; SR-22, SR-29).
- **Rollback.** Each batch merges into `marvin/kerf-gap` as one merge commit, and `git revert -m 1 <merge>` undoes it. TB1 changes no saved format, no persisted value and no generated output, and `stopOutcome` is runtime-only. Reverting B1 or B2 needs B3 reverted first (B3 reads `stopOutcome` and calls `operatorStop`). Reverting B3 alone restores A7's job bar and leaves the key and the outcome core working, with the outcome then invisible as today.

## Docs at each batch's Stage 3.5

- ARCHITECTURE.md, Machine Communication → Stop: the outcome episode, its identity and floor, and the after-dispatch rule (B1); `operatorStop`, the Stop key in capture phase and the crash-screen STOP (B2); `STOP_LAYER_Z` and the top-layer ban, added to Conventions (B3).
- ROADMAP: a shipped line per batch with one "Release notes:" sentence. B3's says STOP now works above open dialogs, and Ctrl+. (⌘.) stops from anywhere, with nothing about beam state. The owner checks D-1 to D-5 and the H-1 and H-2 steps go into `next`. At B3's merge the TB1 index line (ROADMAP.md:683) is marked shipped.
- The Parking Lot lines below are appended by the orchestrator in the plan commit.

## Deferrals

Exact one-line index entries for `ROADMAP.md` under `## Parking Lot — every deferral, one index`, appended after the last index line:

```
- **Native stop joiner can report an earlier stop's result as its own** — the joiner waits at most 3 s (`serial.rs:1403-1408`) then `take()`s `last_stop` (`:1409-1413`), which no stop clears and which lives for the app's whole run (`serial_session.rs:202`, `:237`); an owner whose 3 s banner wait runs out (`serial.rs:1504`) outlasts a near-simultaneous joiner, which then returns the previous stop's outcome, possibly `confirmed`, possibly from an earlier connection. UI polish TB1 masks it in TS (an episode settles on all answers as the least confirmed; a `confirmed` at or below the epoch floor counts as unconfirmed); the native fix (the joiner accepts only a result written after it joined) edits the stop and needs its own plan. See `.claude/plans/kerf-stop-reachability.md` → Diagnosis 4.
- **Work ahead of `serial_stop` on a STOP press** — `setJobRunning(false)` runs before `emergencyStop()` (`JobActionBar.tsx:110-112`, `jobStream.ts:55-56`), so keep-awake posts `keep_awake_release` first (`keepAwake.ts:59-63`), and `emergencyStop` writes the store twice before dispatch (`connection.ts:962-963`). Microseconds, and the release runs in `spawn_blocking`, so TB1 keeps both byte-identical; moving them after the dispatch is a stop-path change for a plan with a native timing measurement. See `.claude/plans/kerf-stop-reachability.md` → Diagnosis 4.
- **START after an unconfirmed or failed stop is refused only in the closed console** — native leaves phase Unknown (`serial.rs:1493`, `:1569`) so `serial_job_begin` refuses (`:1617-1622`) and `beginJobSession` prints the reason to the console (`jobSession.ts:57-63`). Belongs with UI polish TB6 or TB7 (a visible refusal). See `.claude/plans/kerf-stop-reachability.md` → Diagnosis 5.
- **Native file and message dialogs and `window.confirm` take the whole window, STOP and the Stop key included** — Open, Save and Import (`fileOps/index.ts:81`, `:281` and siblings; `MaterialLibrary.tsx:117`, `:133`) and the welcome-guide `confirm()` (`MenuBar.tsx:436`, which blocks the JS thread). Candidate guard: refuse those menu items while a job runs, with UI polish TB4. Owner desktop check D-5 records the behaviour. See `.claude/plans/kerf-stop-reachability.md` → Physical failure outcomes.
- **No error boundary below the app root** — a render error anywhere in the sidebar replaces the whole app with the crash screen (`main.tsx:13-75`, moved to `AppErrorBoundary.tsx` by TB1); TB1 gives that screen a STOP and keeps the Stop key alive, but a boundary that keeps the job bar itself rendering is unbuilt (see also the parked malformed-`gcodeResult` job-bar crash). See `.claude/plans/kerf-stop-reachability.md` → Design C.
- **Raised STOP over a dialog corner on small windows** — at the 1000 × 600 minimum (`tauri.conf.json:18-19`) every dialog wider than about 400 px reaches the 300 px sidebar, so STOP can sit over its bottom-right corner; TB1's browser check lists each overlap. If a primary button is under STOP, ModalShell (UI polish TB9) keeps panels clear of the job bar. See `.claude/plans/kerf-stop-reachability.md` → Design A.
- **Screen readers and STOP under a modal** — `aria-modal` can hide STOP from a screen reader while a dialog is open; the Stop key is the non-pointer path, and whether WebKit announces the outcome line from outside the modal is unverified. See `.claude/plans/kerf-stop-reachability.md` → Design F.
- **UI polish TB1, declined with reasons** — Escape as the Stop key (it closes dialogs, so closing Preferences would end a job); a STOP inside every dialog (it changes the shell's Tab order owned by TB9 and misses five surfaces); a palette row for Stop (slower than the key or the button); raising STOP only in motion states (reachability would depend on Kerf classifying an uncertain state); a dismiss button or auto-hide timer for the outcome line (it clears on the next stop, job or connection). See `.claude/plans/kerf-stop-reachability.md` → Design.
```

## Proposed DECISIONS entries (written at merge through `scripts/update-decisions.mjs`, never by hand)

- Engineering pin, B3, decided under Lee's 2026-09-29 delegation: "STOP sits above every overlay: no element may use a z-index at or above STOP_LAYER_Z, and no surface may use the browser top layer." Reason: a backdrop over STOP made the first click on STOP close the dialog. The stacking seam is STOP's own constant, so a new dialog cannot silently cover it. Enforced by `stopLayer.test.ts`.
- Engineering pin, B1, same delegation: "A stop's on-screen outcome is written only after serial_stop is dispatched, settles only when every stop of its episode has answered, shows the least confirmed of them, and never crosses a connection change." Reason: the native joiner can return an earlier stop's result. A newest-wins display would then show "Stopped" for a stop that was never confirmed.
- Product ruling, B2, on Lee's D1 answer: the Stop key.

## Decisions for Lee

**D1. Which keyboard shortcut should stop the machine?**
- **Today:** none. The only stop in Kerf is the STOP button, and while any dialog is open the first click on it only closes the dialog.
- **Where it lands:** one shortcut that works everywhere in Kerf, with a dialog open or while typing in a box. It sends the same reset as the STOP button. It is listed in the ? sheet and in STOP's tooltip.
- **The tension:** the polish plan promised "Stop gets a key in TB1", and no other key may start motion. The key must be impossible to press by accident while typing, must not be Escape (which closes dialogs), and must not collide with anything Kerf already uses. You chose LightBurn's binding for Ctrl+Shift+V on 2026-09-22, so parity is a fair option here too.
- **Options:**
  - (a) **Ctrl+. (⌘. on a Mac).** Nothing in Kerf uses it, it types nothing in a text box, and ⌘. is the Mac's long-standing "cancel" keystroke. It uses two keys, usually with the right hand. Cost: none beyond B2.
  - (b) **(a), plus Ctrl+Break, LightBurn's Stop** (Pause is Break; per LightBurn staff, [forum](https://forum.lightburnsoftware.com/t/keyboard-shortcuts-for-laser-commands-pause-stop-start/39135)). Parity on keyboards that have a Break key, which most laptops do not (LightBurn's own advice is Ctrl+Fn+B or Ctrl+Delete on some laptops). Whether the Linux and Mac webviews deliver Ctrl+Break is unchecked, so it adds an owner check.
  - (c) **Escape while a job runs.** It is the key people reach for, but Escape also closes dialogs, so closing Preferences mid-job would end the job.
- **Recommendation:** (a). It cannot be typed by accident and works the same in every dialog and text box. If it is wrong, changing it is one line.
- **Reversible:** yes. If you say nothing for a month, (a) ships with B2 and nothing waits. (b) can be added later as a one-line change with one owner check.

## Requirement trace

| requirement | where met | evidence |
|---|---|---|
| reachable across every modal, jog, stale and unknown state | Design A, C, E; B2, B3 | jsdom matrix (keyboard B2, wiring B3); browser matrix with trusted input; base run fails; SR-21, SR-41 to SR-44 |
| keyboard and pointer to the single stop path | Design C; B2, B3 | the key and STOP both call the mocked `operatorStop`; IPC and write-order equality; SR-25, SR-26, SR-46 |
| works with a modal open and focus in an input | Design C | matrix focus variants including the `stopPropagation` textarea; D-2, D-4 |
| nothing before `invoke("serial_stop")` | Design D; Verification 2 | B1 "not before dispatch"; SR-01; Razor byte check |
| pending at once, replaced on the answer, physical guidance whenever unconfirmed | Design D, F; Copy ledger | B1 "at once"; B3 strings; overdue watchdog |
| connection and request identity; guarded writes; replacement-safe timers | Design D | B1 reconnect, out-of-order, two-stop and watchdog tests; SR-03 to SR-13 |
| single-reset contract untouched | Verification 1, 2 | no `src-tauri/` diff; native single-flight unchanged |
| raised vs portal, against the focus trap and A3/A7 | Design A, B | the table and the fallback condition |
| physical failure outcomes; hardware checks; no beam claim | Physical failure outcomes; Verification 7 | H-1, H-2; status-only wording |
| tests, battery, browser with invoke mocked, owner checks | Batches; Verification 4-7 | as listed |
| ≤8 files per batch, graph, ownership, deferrals, decisions | Batches; Dependency graph; Deferrals; D1 | |
