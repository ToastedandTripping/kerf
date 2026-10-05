Critic: Fable (fallback, Codex 5h 94%), round 7, 2026-10-05

## Applicability

Project type: Complex desktop laser-control change (Tauri v2 / React / Rust): STOP reachability, asynchronous controller-state accounting, a native-dialog interlock for the dialog's whole lifetime, and a bridge-fallback watch. Reviewed revision 7 of `kerf-stop-reachability.md` (tree `marvin/kerf-gap` at e80313c) as an independent critic. The current design text, the authoritative transition table in Design D and the batch tests are normative, as the plan states; fold tables are history. Line references are to the plan unless a source file is named. Every load-bearing citation below was opened in the tree or in the installed Tauri bridge (`~/.cargo/registry/.../tauri-2.10.2/scripts/`, `node_modules/@tauri-apps/api`, `node_modules/@tauri-apps/plugin-dialog`). Lee's rulings D1 (the Stop keys, DECISIONS:118), D2 as amended (dialogs refused while output may be on, :123/:128) and D3 (the "Laser off (M5)" button, :130) are taken as given; nothing below faults the plan for following them.

- Core 1–10: all active [GATING].
- X1 fires [GATING]: operator controls dispatch controller resets, M5 and job admission; a native surface that takes the window while the laser runs leaves no software stop.
- X2 does not fire — N/A: no personal, health, child or client data is introduced or handled; project files are generic persistence outside this plan.
- X3 fires [GATING]: controller, bridge and tree facts are the evidence the safety closure rests on ("no other blocking dialog exists", "every fallback trigger is observed").
- X4 fires [ADVISORY]: operator copy and release notes; no money, legal term or signature.
- X5 fires [GATING] (X1-class): overlapping IPCs, late replies, re-entry, auto-connect timing and the native dialog's lifetime share one in-flight set.
- X6 fires [ADVISORY]: a released desktop app with auto-connect, a session-long guard after a bridge fallback, and owner recovery steps.
- X7 does not fire — N/A: Kerf's lint rules and tests are project gates, not MARVIN's hooks, skills or automation.
- X8 fires [ADVISORY]: STOP is latency-sensitive; a `window.fetch` wrapper sits on every IPC; no package is added.

## Round-6 closure check (F1–F4)

- **F1 (connect/reset under an open dialog): closed as specified.** Design D's admission column now refuses `serial_connect`, `serial_abort_job`, every `serial_send` (so `$H`, `$C`, `$RST=`, `$N…=`, `$SLP`), and every byte but `0x85`, `0x21`, `?` while a surface is open; STOP alone is immediate. Verified: `autoConnect()` awaits `listPorts()` then `connect()` (`connection.ts:461-473`); `list_serial_ports` is `serialport::available_ports()` (`serial.rs:231-234`), which opens no port, so no reset precedes the refused `serial_connect`; `connect()` posts `serial_connect` as its first statement and clears `connectingPromise` in `finally` (`:479-483`, `:591-594`), so a refusal does not wedge later connects; the native connect's DTR toggle and `0x18` (`serial.rs:342-366`) therefore never run under a dialog. "Not a hazard" is corrected everywhere (Design A, C, R1, R9, R13), D-10 is a prerequisite, and tests A1–A5, D1–D2 and browser (k), (l) exist. The STOP-under-dialog exception is Lee's design and is named with its consequence.
- **F2 (bridge lifetime): closed by withdrawal and replacement.** The installed `ipc-protocol.js` calls `fetch` as a free identifier at call time (`:37`), so a wrapper on `window.fetch` installed before the call sees it; the fallback handler (`:59-68`) runs only on a rejection from that `fetch`, from the first `.then` (whose body cannot throw on a real `Response`), or from `response.json()/text()/arrayBuffer()` (`:48-52`); after it fires, `customProtocolIpcFailed` stays true and every later call goes over `window.ipc.postMessage` with no retry (`:70-85`). Both observers the watch attaches cover every trigger the source has. CSP allows `ipc:` and `http://ipc.localhost` (`tauri.conf.json:26`), so a CSP-caused first-call fallback is not the expected case on this build; D-11 checks the owner's. Pins verified: `Cargo.lock:4581-4582` tauri 2.10.2, `@tauri-apps/api` 2.10.1. One implementation trap, not a defect: match the URL by string prefix, because `new URL("ipc://localhost/x").origin` is `"null"` for a non-special scheme; BW1 as written would catch a `.origin` implementation.
- **F3 (contradictory oracles): closed.** B1a overlap (h) expects "output still maybe on" after a confirmed reset; the W1–W7 reload tests are gone with the reload; every B4 baseline is reached through the real modules; ROADMAP Parking Lot lines 722 and 723 now carry the corrected wording ("until a clean `M5`"; the bridge line). Diagnosis 10's realtime-byte row lists only `0x21`, `0x85`, `?` as "no new on command".
- **F4 (reload timer): closed by removal.** `showWelcomeGuide` mounts the existing `OnboardingOverlay` (`OnboardingOverlay.tsx:33`, seen-flag at `:41-44`; mounted today at `App.tsx:174`, `:399`); no `confirm`, no navigation, no timer; the lint rules now ban `confirm` and `location` everywhere; G1–G4 cover it. Verified `MenuBar.tsx:432-441` is today's only `confirm`/`reload` site.

Round 6's four findings are genuinely closed. The next counterexample is below.

## Dimension verdicts

PASS — 1. Problem-fit [GATING]: the grilled-intent skip is written with its reason; the Summary targets the four STOP holes; D1–D3 are implemented as ruled and nothing in the plan contradicts a DECISIONS entry.
CONCERN — 2. Approach soundness [GATING]: the "one door" design is correct for plugin dialogs but assumes plugin dialogs are the only native surfaces the webview can raise; two HTML inputs raise native choosers outside the door (F1). Fix: close them in F1 and add the structural check that proves the set of native surfaces is complete.
FAIL — 3. Completeness [GATING]: `VariableTextDialog.tsx:402` (`<input type="file">`) and `PropertiesPanel.tsx:313` (`<input type="color">`) open native choosers that pass through no seam, no ledger flag and no quiescence check, reachable mid-job (F1). Fix: F1.
PASS — 4. Right-sizing & reuse [GATING]: one set, one wrapper, one door, verbatim moves, batch sizes and waivers stated, every deferral indexed in the ROADMAP Parking Lot (verified lines 712–723).
PASS — 5. Security [GATING]: no secret, permission or remote boundary added; the `window.fetch` wrapper forwards unchanged and reads only IPC-origin rejections; failsafe text via `textContent`; lint-rule edges disclosed.
PASS — 6. Failure modes [GATING]: every ledger and outcome failure ends refused or uncertain; the bridge watch fails closed when `fetch` is absent; a hung request is bounded by R11's recovery order. The one unnamed failure is advisory (X6).
PASS — 7. Change safety [GATING]: per-batch merge commits, named revert order, no persisted format or generated output changed, D-10 first with power isolated before any reset check.
PASS — 8. Data integrity & compatibility [GATING]: one in-flight set is the only source of truth for admission and clearance; the store holds a display copy only; the bridge watch pins the set untrustworthy rather than letting it drift.
FAIL — 9. Verifiability [GATING]: the claim "every door is covered by construction" (Design G) has no test that could have failed: the dialog lint rules and the modal registry scan `plugin-dialog` strings and `aria-modal` roots, never JSX inputs, so the two native choosers pass every B4 check (F1). Fix: a source scan over `src/**/*.tsx` for `type="file"|"color"|"date"|"time"|"datetime-local"|"month"|"week"` outside the seam, with the two sites as its positive control before they are closed.
PASS — 10. Maintainability [GATING]: fold history is labelled non-normative; the authoritative table is single; seams (`grblLine.ts`, `activityLedger.ts`, `blockingDialog.ts`) are the places the next change lands; docs commits are serialized and scoped.
FAIL — X1. Physical & human safety [GATING]: a job can be streaming while the operator clicks the stroke colour swatch or the CSV input and a native modal chooser takes the window, with STOP and both Stop keys behind it and nothing in Kerf aware a surface is open (F1). Fix: F1.
FAIL — X3. Evidence & source integrity [GATING]: Diagnosis 8 states "No other blocking dialog exists" and "Every native dialog in Kerf goes through `@tauri-apps/plugin-dialog`"; a grep of `src` for `type="file"` and `type="color"` falsifies both. The grep the plan ran (`confirm(`, `alert(`, `prompt(`, `location.reload`, `plugin:dialog`) could not have found them. Fix: correct Diagnosis 8 and name the sweep's exclusions.
CONCERN — X4. Audience, brand & money accuracy [ADVISORY]: the "Cost changes in revision 7, flagged for Lee" list omits one composition of D2's heading with its amendment: because output is maybe-on after every connect, Disconnect now sends the stop reset after every connect that was not followed by a clean M5, which the Rust comment at `serial.rs:446-448` records as wiping volatile G92 origins. Kerf's own connect already resets, so the practical cost is small, but it is a reset Lee did not see named. Fix: one sentence in the D2 section.
FAIL — X5. Concurrency & re-entrancy [GATING]: the lifetime exclusion is proven for surfaces the ledger knows about; a native chooser the ledger does not know about is open while the set is non-empty, so `tryBeginBlocking`'s mutual exclusion has nothing to exclude and every admission (job line, jog, connect) proceeds under it (F1). Fix: F1.
CONCERN — X6. Operability & observability [ADVISORY]: a guarded `open`/`save`/`message` whose promise never settles (a platform that never answers, a dialog destroyed with its parent) leaves the blocking flag set for the session: every connect, job and line is refused with the dialog-open text while no dialog is visible. R11 covers a hung ledger IPC but not this flag. Fix: name it in R11's recovery (restart is the exit) and in the owner card; do not add a timer, for the reason round 6 gave.
PASS — X8. Dependencies, performance & cost [ADVISORY]: no new package; the fetch wrapper adds one promise observer per IPC; retention is capped; 1,000 outstanding presses are measured.

## Findings and required corrections

### F1 — P0: two native choosers open outside the one door, while a job can be running

Design G: "`src/lib/blockingDialog.ts` (new, B4) is the only door … every door is covered by construction, not by naming each caller." Diagnosis 8: "No other blocking dialog exists." Physical failure outcomes, "Kerf's window cannot take input": "After B4, no native dialog opens unless the machine was proven idle … What remains: the webview's main thread hung; a native select menu (D-8); a motion that starts on the controller by itself."

The tree has two more:

- `src/components/panels/PropertiesPanel.tsx:313` — `<input type="color" value={obj.stroke} …>` in the Stroke group of the Properties panel, a sidebar panel (`App.tsx:313`) that is one toggle away at all times, including during a job.
- `src/components/panels/VariableTextDialog.tsx:402` — `<input type="file" accept=".csv,.txt" onChange={handleCsvUpload}>`, read with `FileReader` (`:91-94`), inside an in-page `aria-modal` dialog that nothing refuses while a job runs.

Clicking either asks the webview, not the plugin, to raise its native chooser. wry 0.54.1 (the installed runtime) has no `run-file-chooser` or colour-chooser handler under `src/webkitgtk/`, so WebKitGTK's defaults run: a GTK file chooser and a GTK colour chooser, modal to the toplevel. On macOS, WKWebView's open panel is a sheet on the window. Whether the window still takes STOP's clicks and the Stop keys under them is the same unverified platform question as D-5, but with the one difference that matters: D-5's dialog can only exist in a state the ledger proved quiescent, and these two can exist with a job streaming.

Schedule: START on a cut job; `serial_stream_job` is in flight (the set is non-empty, so every plugin door is refused, as designed); the operator opens Properties and clicks the stroke colour swatch; the GTK colour chooser takes the window. The head is moving and the beam is on. STOP is under a native modal, Ctrl+. and Shift+Esc go to the chooser, `tryBeginBlocking` was never called, `blockingOpen()` is false, and the ledger admits every further request. That is the exact state B4 exists to make impossible, reached by one click on a control that has nothing to do with files.

The structural checks cannot see it: the dialog lint rules match `plugin-dialog`/`plugin:dialog` strings, `confirm`/`alert`/`prompt`/`location` and global-object forms (Design G); the modal registry scans `aria-modal="true"` roots (B2); the seam scan counts `invoke` literals. None reads a JSX `type` attribute. So "covered by construction" is a claim with no instrument that could have failed, and the sweep in Diagnosis 8 (`confirm(`, `alert(`, `prompt(`, `location.reload`, `plugin:dialog`) did not declare that it excluded HTML form controls.

Required correction:
1. Route both through the door or remove the native surface. CSV import: the seam's `open()` plus `@tauri-apps/plugin-fs` `readTextFile`, so it is refused while not quiescent and holds the lifetime flag while open. Stroke colour: an in-page swatch grid or a `<input type="color">` replaced by a popover that opens no native chooser (the colour sits in a sidebar that must stay usable mid-job, so the quiescence refusal is the wrong fix there). Either way, no `<input type="file"|"color">` remains in `src` outside the seam.
2. Add the structural check that was missing: a source scan in `stopLayer.test.ts` or `blockingDialog.test.ts` over `src/**/*.tsx` outside tests for `type="file"`, `"color"`, `"date"`, `"time"`, `"datetime-local"`, `"month"`, `"week"` (native pickers on WebKitGTK), failing on any hit outside `blockingDialog.ts`, with a positive control that it finds the two sites at today's tree; plus an ESLint `no-restricted-syntax` rule on the JSXAttribute so a new one fails lint, with a fixture.
3. Correct Diagnosis 8 and the "what remains" list in Physical failure outcomes; name the sweep's exclusions (HTML form controls, `<select>`, drag-drop) so the next reader knows what was not searched.
4. Add an owner check beside D-5: with a job on scrap, open Properties and click the stroke swatch (at B4's parent, before the fix), record whether STOP and the keys reach Kerf; at head, confirm no native chooser opens from either control. Record `<select>` (D-8) in the same pass, since it is the remaining non-seam native surface.
5. Batch placement: `PropertiesPanel.tsx` and `VariableTextDialog.tsx` are dialog-adjacent files outside every TB1 batch and inside polish Track A's collision table; the orchestrator assigns them (B4 is at eight files) and the plan's Verification 1 scope rule is updated accordingly.

### F2 — P2: one undisclosed composition of the D2 ruling

B1b adds `|| outputMayBeOn()` to `disconnect()`'s `needsEstop` (`connection.ts:604-605`). With output maybe-on after every connect (Design D's table), every Disconnect that follows a connect with no clean M5 in between now sends `serial_stop` first. `serial.rs:446-448` records why the native side never resets on a clean disconnect: it wipes volatile G92 work origins. Kerf's own connect resets the controller anyway (`serial.rs:342-366`), so the origin would be lost at the next connect regardless, and under the plan's own model this reset runs the same startup blocks the "maybe on" was recording, so it clears nothing in the connect-only case. The behaviour follows D2's heading literally and is not a defect against the ruling; it is a consequence Lee has not seen named. One sentence in "Cost changes in revision 7" closes it.

### F3 — P2: a dialog promise that never settles has no recovery text

Design G holds the blocking flag across `await plugin.open(...)` and clears it in `finally`. If that promise never settles, the flag is held for the session and every admission, connect included, is refused with "A file dialog is open" while no dialog is visible. Safe direction, and the right one, but R11's recovery text covers a hung ledger IPC and not this flag. Add it to R11 and the owner card (restart is the exit; nothing else may clear the flag).

## Three stress tests

### Pre-mortem

Three months out, the type-specific worst case is the beam burning while STOP is unreachable.

1. A job is streaming. The operator opens Properties to check a width and clicks the colour swatch beside it. The GTK colour chooser takes the window; Ctrl+. and the STOP click go into the chooser; the cut runs on. We should have grepped `type="` as well as `plugin-dialog`, and we should have had a test that counted native-chooser inputs in the tree.
2. On the owner's platform the custom-protocol IPC fails once at startup (a WebKitGTK build that blocks the scheme). Every session is then guarded for its whole life: file dialogs refused while connected, every STOP "unconfirmed". The owner stops using the app connected. We should have run D-11 before shipping the watch, not after; the plan names it, and the risk is operational rather than physical.
3. A plugin dialog on some platform resolves only when its parent regains focus, and never does after a workspace switch. Kerf refuses every connect and job with the dialog-open text until restart; the owner reads it as a bug in the laser link. R11 should have said so.

### Load-bearing assumptions

- **Plugin dialogs and the Welcome Guide are the only native or blocking surfaces Kerf can raise — confidence: falsified.** `PropertiesPanel.tsx:313` and `VariableTextDialog.tsx:402`. Consequence: the B4 closure of safety finding 4 is not a closure. Resolve before implementation (F1).
- **A `window.fetch` wrapper sees every bridge fallback trigger — confidence: high, from the installed source.** `ipc-protocol.js:37-68` has exactly one fallback path, entered only by a rejection the wrapper or its body shadows observe; the first fallback disables the custom protocol for the page's life. Consequence if a Tauri upgrade changes the script: BW4 fails on the version pin, as designed.
- **`list_serial_ports` opens no port, so nothing before the refused `serial_connect` can reset the controller — confidence: high.** `serial.rs:231-234` is `serialport::available_ports()`. Consequence if a later probe opens ports to identify GRBL: an unledgered DTR reset; the port-write scan in `stopIdentityScan.test.ts` would catch a new write but not an open, so the B1b DECISIONS pin should name "opens a port" alongside "writes to the port".
- **The owner's startup lines command no output (D-10) — confidence: unknown until run.** Every STOP-under-dialog, accidental-reset and Disconnect-reset acceptance in the plan rests on it, and the plan says so. Consequence if wrong: Lee stops all owner checks, per the plan.

### Inversion

A whole-window input gate (refuse every native surface, HTML inputs included, through one interlock) wins over "one door for plugin dialogs" the moment a native surface exists that the door does not cover. That condition is already true in the tree (F1), and the honest fix is not a bigger door but the removal of the two surfaces plus a scan that proves the set is closed. A disconnected-only dialog rule (the alternative Lee declined) would not have helped here either: neither chooser is a file dialog Kerf opens. A native completion signal still wins over the bridge watch if a fallback ever turns out to be common on a supported platform (R18); D-11 is the measurement that decides it, and it should run early.

## Overall verdict

**FAIL — gate blocked.** Revision 7 closes every round-6 finding as specified: the dialog's lifetime now excludes connects, auto-connects and non-STOP resets; the bridge-lifetime claim is withdrawn and replaced by a watch that the installed source supports; the reload is gone; the oracles agree with the table. The design that remains is sound for the surfaces it knows about. It does not know about two: an HTML colour input in the always-available Properties panel and an HTML file input in the Variable Text dialog, each of which raises a native modal chooser with no seam, no flag and no quiescence check, reachable with a job streaming. That is a concrete schedule in which the beam is on and STOP is behind a native dialog, which is the state this plan exists to prevent, and the plan's structural checks could not have found it. The fix is small and well-defined; it belongs in the plan before a relay starts, together with the scan that proves no third surface exists.

Prioritized must-fix list:

1. **P0 — F1:** close the `type="color"` and `type="file"` native choosers (seam or in-page replacement), add the JSX native-input scan with its positive control and a lint rule, correct Diagnosis 8 and the "what remains" list, add the owner check, and place the two files in a batch.
2. **P2 — F2:** one sentence in the D2 cost list: Disconnect resets after every connect not followed by a clean M5.
3. **P2 — F3:** add the never-settling dialog promise to R11's recovery text and the owner card.
4. **P3 — note:** the bridge watch must match the IPC URL by string prefix, not `URL.origin` (which is `"null"` for `ipc:`); BW1 catches it, but say it in Design D so the implementer does not learn it from a failing test.
