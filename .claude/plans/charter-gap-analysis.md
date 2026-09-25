# Kerf — Charter Gap Analysis

**Date:** 2026-09-19
**Tree audited:** worktree `marvin/session-1b2844` at `84e2535`. `master`/`origin/master` are one commit ahead (`4da7d10`, the v0.8.29 version bump; tag `v0.8.29` exists and points at it). No source differs between the two.
**Measuring stick:** `.claude/CHARTER.md` (founded 2026-02-21). Nothing else. Not LightBurn, not the remediation plan's recommendations, not what would be nice.
**Method:** every file cited below was read, not listed. Four parallel readers covered Import, Trace+Layers, Preview+G-code geometry, and Drift+CI+tests; the send path, safety stack and simulator were read by the author. Line numbers are from this tree. Test counts are from runs in this worktree (237 Rust green with `--features sim`; 741 vitest green, two harness-only file failures from a symlinked `pdfjs-dist` path).

---

## The charter's "done", restated

1. The core loop **Import, Trace if raster, Assign to layers, Preview, Send** works end to end on Lee's machine with **no cut dying mid-job and no silent G-code error**.
2. The streaming and safety stack is **verified in CI by the GRBL simulator**, so a release no longer queues on the owner's hardware.
3. The hardening program's phases are shipped and the **owner hardware test card passes on a release build**.

## Headline

**None of the three "done" conditions is met, and the distance is not evenly spread.** The front half of the loop (Import, Trace, Layers, Preview) is in good shape: geometry from Illustrator, Figma or Inkscape lands correctly, the preview is drawn from the same `moves[]` the G-code came from, and the layer system does what the charter asks. The back half (Send, safety) is where the charter fails, and it fails on the owner's actual hardware, not in theory:

- Two hardware-confirmed defects still end jobs (the laser-switch wedge, and a newer "laser stops firing" symptom with three reports in the last week). Condition 1 fails on "no cut dying mid-job".
- One ordinary in-app shape (a sharp rectangle on a Fill+Line layer) is silently dropped from the G-code. Condition 1 fails on "no silent G-code error".
- The `$32=1` gate shipped in v0.8.29 covers START and FRAME in the action bar and nothing else; the material-test dialog streams without it. Pause is a resumable hold that the project's own ruling says cannot be qualified with the evidence standard Lee chose. Condition 1's "laser-safe" is not established.
- CI runs the simulator, but the simulator hardcodes `$32=1`, models stock buffers this controller does not have, cannot model the wedge, and the STOP tests never click STOP. Condition 2 is a sentence in the charter, not a property of the pipeline.
- The test card in the repo describes a pause protocol that no longer exists and has never passed on a release build. Condition 3 is open.

Two process facts sit underneath all of this. First, v0.8.29 was tagged and pushed while `DECISIONS.md` and `handoff.md` both say **RELEASE BLOCKED**; the tree's own rulings were not consulted before the release. Second, the v0.8.29 relay skipped the remediation plan's Phase 0 (the falsifiable test seam) and went straight to a production safety change, which is exactly the sequence the plan was written to prevent.

---

## Area 1 — Import (SVG, PNG, DXF, PDF, .kerf)

**Current state: works, and is the healthiest area in the loop.**

- SVG path parsing (`src/lib/fileOps/svgImport.ts:42-428`) handles every `d` command, relative/absolute, implicit lineto, SVGO-fused arc flags, S/T reflection; arcs tessellate at `CURVE_CHORD_TOLERANCE_MM` (`:506-515`). Transforms compose parent-first through nested groups (`SvgImportDialog.tsx:34-74`, `:644-646`), rotated rect/ellipse become world-space paths (`:747-766`, `:816-875`). Units: viewBox plus mm/cm/in/pt/pc, unitless at 96 dpi (`:544-575`). Color-to-layer mapping with per-color dropdowns (`:97-158`). Compound paths split into grouped per-subpath objects with no bridge cuts (`:940-988`). 25 tests.
- PNG: `pHYs` DPI read with a corrupt-chunk guard (`imageImport.ts:10-48`), 300 dpi assumed otherwise; drag-drop opens a dialog with layer pick, DPI override and a trace hand-off.
- DXF: LINE, CIRCLE, ARC, LWPOLYLINE with bulge arcs and closed flag; `$INSUNITS` scaling; Y-flip; unsupported entities counted and surfaced (`dxfImport.ts:141-430`).
- PDF: better than the ROADMAP claims. Vector extraction from the pdf.js operator list exists (`pdfImport.ts:40-397`) with raster fallback.
- `.kerf` save/load: atomic tmp+rename, `.bak` before a migrating save, ordered v0→v4 migrations, and the **forward-version refusal is implemented exactly as ruled** — not loaded, not stamped, not in Recent Files (`fileOps/index.ts:204-213`, callers `:322`, `:381`; `migration.test.ts:909`). 47 tests.
- The SVG coordinate-drift item (DECISIONS evidence correction, open since 2026-06-21): nothing in this tree contradicts "audited clean". Still needs Lee's reproducing file.

**Gaps.**

| Gap | Where | Severity |
|---|---|---|
| Hidden Inkscape layers (`<g style="display:none">`) import and cut; no `display`/`visibility` check anywhere in the element walk | `SvgImportDialog.tsx:634-682` | Degrades (wrong cut, silent) |
| `<use>` is treated as a container, never resolves `href`; Inkscape clones and Illustrator symbol instances vanish and are exempt from the "skipped" counter | `:658` | Degrades (silent geometry loss) |
| Presentation attributes on `<g>` are not inherited; Illustrator grouped `.cls-1,.cls-2{}` selectors miss; result is "0 colors found" and everything on the active layer | `:596-614`, `:143`, `:577-614` | Degrades (layer mapping fails, geometry intact) |
| No viewBox + physical `width="100mm"` returns scale 1 (should be px→mm) | `:547-552` | Degrades, rare |
| DXF: every entity stamped onto `activeLayerIndex`, no layer/color mapping, no dialog; SPLINE, ELLIPSE, old POLYLINE, INSERT/BLOCK, TEXT, HATCH unsupported; `$INSUNITS=0` silently read as mm | `dxfImport.ts:171,211,289,343`, `:113-115`; `fileOps/index.ts:298-300` | Degrades to **blocks for DXF specifically**: a blocks-based or spline-bearing DXF imports empty or flat |
| Two PNG routes disagree: File→Import honours pHYs DPI but skips the dialog; drag-drop shows the dialog but never runs `parsePngPhysDpi` | `fileOps/index.ts:308-310`; `fileDrop.ts:27-42`; `App.tsx:321` | Cosmetic |
| v2→v3 sub-layer migration defaults a missing line-sub `power` to **100** (Parking Lot item, line numbers moved) | `fileOps/index.ts:655`, `:690` | Degrades, low reach (third-party file only) |
| No 72-dpi override for legacy Illustrator exports | `:561`, `:574` | Cosmetic |

**Verdict:** SVG and PNG keep the charter's promise. DXF keeps it only for simple line/arc/polyline files. The two silent hazards (hidden layers, `<use>`) are the ones that produce a wrong cut with no console line.

---

## Area 2 — Trace

**Current state: binary tracing delivers the charter case.**

- Pipeline: grayscale → optional blur → near-binary auto-detect with midpoint threshold (`src-tauri/src/engine/tracer.rs:141-149`, `:186-195`) → morph open/close → foreground despeckle (`:322`) → interior white pinhole fill (`:419`) → vtracer Binary → shoelace area post-filter (`:274-280`). Both black specks and white pinholes are handled; the v0.8.21 fix stands.
- Preview/commit parity is real, not claimed: `filter_speckle` scales by s, `ignore_area` by s², floored to 1 (`:80-83`, `:316-319`), with tests at `:868` and `:913`. Dialog previews at adaptive scale, commits at 1.0, and a "Full res" button caches the 1.0 result for commit (`ImageTraceDialog.tsx:519-552`).
- Physical size is correct by construction: traced points map through the image object's existing mm transform (`:73-76`) from pHYs DPI or the 300 dpi assumption.
- Output goes to a chosen layer defaulting to active (`:331-347`, `:814-850`), one group per image, CCW winding normalized so fills behave (`:92-109`). Input capped at 24 Mpx via `limits.rs`.

**Gaps.**

| Gap | Where | Severity |
|---|---|---|
| **Color mode does not map colors to layers.** Every cluster lands on `effectiveLayerIndex`; the color survives only as a stroke color. `Hierarchical::Stacked` emits overlapping filled regions including the background cluster, so a fill layer engraves everything at one power and a line layer cuts every outline, background rectangle included. No select-by-color or split-by-color exists. | `ImageTraceDialog.tsx:557-565`, `:113-137`; `tracer.rs:117` | Degrades: shipped as a preview feature, not a loop step |
| Color mode ignores Threshold, Blur, Invert, Low Cutoff, Morph, Min Area (the whole pre-vtracer pipeline is skipped) but the dialog still shows the sliders | `tracer.rs:101-125`; dialog `:751-754`, `:769` | Cosmetic-to-degrades (controls visibly do nothing) |
| Color mode has no despeckle beyond vtracer's own; pinholes reach the cut | `tracer.rs` binary-only helpers | Degrades |
| `color_count` 2–32 maps to `ceil(log2 n)`, so 5–8 are all precision 3 | `tracer.rs:105` | Cosmetic |
| Centerline tracing absent (parked): line-art PNGs trace as stroke outlines, i.e. double cuts | Parking Lot | Degrades for line-art designs |

**Verdict:** Trace delivers for black-on-white artwork. Color tracing is scope that does not close the loop.

---

## Area 3 — Layers

**Current state: delivers the charter's "assign to layers" step.**

- Cut sequence is the panel order: drag-reorder reindexes layers and remaps every object (`src/app/store/index.ts:309-334`); `gcodeGen.ts:229`, `:610`, `:894` build order from array position and skip hidden/output-off layers. Position number shown as cut order (`LayerPanel.tsx:230-241`).
- Modes line / fill / fillLine / offsetFill dispatch (`gcodeGen.ts:288-407`, `:505-561`); fillLine emits fill then a line overlay with its own settings.
- Object→layer assignment handles single and mixed selections (`PropertiesPanel.tsx:113-164`); layer rows list their objects.
- M4 is the default for every new layer (`types.ts:245`, `:282-345`) per the 2026-09-10 ruling; M3 selectable per layer. The powerMin ≤ power clamp is at both store doors (`index.ts:10-13`, `:301-307`, `:341-350`) and mirrored in the controls, as ruled.
- 18 presets ship (`materials.ts`); apply/clear and MaterialLibrary import/export work.
- React Error 185 sweep across LayerPanel, PropertiesPanel, ActiveLayerStrip, MaterialLibrary, ImageTraceDialog: clean; the one derived array uses `useShallow` (`LayerPanel.tsx:154-156`).

**Gaps.**

| Gap | Where | Severity |
|---|---|---|
| **Air Assist toggle is inert.** Carried into `CutLayer` (`gcodeGen.ts:88`, `:124`; `gcode_gen.rs:63`) and never read; no `M7/M8/M9` anywhere in `src/` or `src-tauri/src/`. Presets set it, the chip shows it, the machine never hears it. Not recorded anywhere. | as cited | Degrades (a control that lies) |
| Min Pwr still presented as a live slider with a cap hint only; DECISIONS 2026-09-10 established it reaches no vector G-code and `$31` is the real control, which Kerf never touches | `LayerPanel.tsx:511-539`, `:912-940` | Degrades (recorded, unfixed in UI) |
| Presets carry no `powerMode`; applying a preset leaves M3/M4 as-is; preset numbers have no provenance for a 40 W machine | `types.ts:220-232`; `MaterialLibrary.tsx:69-79` | Degrades |
| Fixed six layers, names and colors not editable | no `updateLayer` caller writes name/color | Cosmetic |
| `MachinePanel.tsx:617` still says "M4 dynamic power active" (Parking Lot reword not done) | as cited | Cosmetic |

---

## Area 4 — Preview

**Current state: accurate, because it is not an estimate.**

- JobPreview draws `gcodeResult.moves` (`JobPreview.tsx:51`, `:157-215`), which the Rust engine emits alongside every G-code line (`gcode_gen.rs:243-284`, `:493-677`; `mask_fill.rs:277-420`). Layer order, passes, lead-in/out, tabs, perforation, overscan, kerf rings, fills and image raster all appear because they are all moves.
- FRAME traces `frameTargets(moves)` and START's bounds gate uses `movesExtents(moves)` (`JobActionBar.tsx:119-140`, `canStartJob.ts:31-51`): preview, frame and bounds are one source of truth.
- Stale detection is thorough: every mutator sets `gcodeStale` (`store/index.ts:103`, `:113`, `:160-367`, `:581`, `:803`, `:812`); START and FRAME refuse while stale.
- Text auto-conversion at generate time is inside `moves`, so JobPreview shows the actual glyph paths.
- Footer claim holds for `generateGcode`: `assembleGcode` always appends `M5 / G0 X0 Y0 / M2` (`gcodeGen.ts:800-815`). It does **not** hold for the material test, which hand-builds its own program (`MaterialTestDialog.tsx:102-256`).

**Gaps.**

| Gap | Where | Severity |
|---|---|---|
| Design canvas vs cut for text: Pixi positions by its own ascent/lineHeight; the cut places opentype glyphs at `transform.y + fontSize` with 1.3× pitch. Canvas and burn differ by a fraction of the font size vertically | `Viewport.tsx:1355-1362`; `geometryActions.ts:81`, `:145` | Degrades (JobPreview is exact; the canvas is not) |
| Time estimate: vector arm hardcodes 200 mm/s² (`gcode_gen.rs:996`) though `$120` is in the store; raster/mask arms ignore acceleration entirely (`mask_fill.rs:442`; `image_gcode_gen.rs:460-465`) | as cited | Cosmetic |
| Preview redraws every move every rAF (Phase 3 perf item) | `JobPreview.tsx:157-215`, `:257-281` | Cosmetic |
| `setGrblAccel` does not stale G-code though overscan derives from it | `store/index.ts:585`; `gcodeGen.ts:903` | Cosmetic |

---

## Area 5 — Send (G-code generation, streaming, job control)

**Current state: the per-line protocol is careful and the lock design is right. The controller it talks to is not the controller it was designed for, and the code has no answer for that yet.**

What works:
- Per-line loop with terminal classification (`ok`/`error:N`/`ALARM`/banner), pre-write drain so stale debris is never attributed to a new command, persistent reader and partial-line buffer (`serial_pump.rs:160-294`; `serial.rs:362-416`).
- The command/realtime lock split is real and tested non-tautologically: `!`, `~`, `0x18`, `?` reach the wire while a pump holds the command lock for minutes (`serial.rs:430-439`; test `:789`; sim test `:1396`).
- Every serial command runs in `spawn_blocking`; no mutex is held across an await.
- START gate: connected, `$32=1`, idle, not running, G-code present and fresh, workspace verified, moves non-empty and within bounds (`canStartJob.ts:144-183`). FRAME uses the same bounds gate (`JobActionBar.tsx:108-154`).
- Keep-awake acquires an OS sleep inhibitor on `jobRunning` (`keepAwake.ts`).
- Buffered (character-counting) pump exists behind an opt-in toggle, default `perLine` per the pin (`jobStream.ts:114-122`; `serial_pump.rs:456-645`).
- Golden corpus: 15 fixtures plus determinism, all through the real `generate_gcode` command (`commands/gcode.rs:536-899`); CI asserts `KERF_UPDATE_GOLDEN` is unset before `cargo test`.

**Gaps.**

| # | Gap | Where | Severity |
|---|---|---|---|
| S1 | **The laser-switch wedge ends the job and Kerf treats a live controller as a dead port.** After `M3`/`M4` the controller intermittently stops acking while still answering `?` with Idle. `run_pump` returns `Disconnected("terminal lost…")` after 3 Idle probes (~3 s) (`serial_pump.rs:186-196`); TS maps that to `error:disconnected`, sets `portDisconnected`, and tears the port down (`jobStream.ts:339-347`, `:415-421`). Recovery is a manual reconnect, which DTR-resets the controller and wipes any G92 origin. Trigger uncaptured; `scripts/probe-grbl.py` exists and a 2026-09-14 log is now in the repo. | as cited | **Blocks done (1)**: cuts die mid-job on the owner's machine |
| S2 | **Abort order still contains an ack-awaited write.** Both non-complete exits `await send("M5")` and only then `softReset()` (`jobStream.ts:257-265`, `:396-404`). In the wedge that M5 is itself unacked, so the reset is delayed by a second ~3 s stall window with the head stationary; under M3 the beam is on for it. This is the standing pin ("never an ack-awaited write") violated at both sites, and the 2026-09-10 ruling for one shared stop operation is not implemented. | as cited | **Blocks done (1)** (laser-safe) |
| S3 | **"Laser stops firing" mid-job** — head keeps moving, beam goes dark. Three reports (2026-09-14 ×2, 09-16). v0.8.29 added an `FS:` spindle-drop console warning (`connection.ts:59-63`, `:367-391`) — diagnostic only, and it has **no test** (`grep` for it finds only the production file). Root cause unknown. | as cited | **Blocks done (1)** |
| S4 | **A plain sharp rectangle on a Fill+Line layer is silently dropped** (remediation R16, verified real). No `points` on the primitive, `synthesizeFillContour` returns null at cornerRadius 0 (`gcodeGen.ts:166`, `:185`), `effectiveMode` stays `fillLine` (`:396-408`), the overlay is skipped (`:505-517`), and Rust has no `fillLine` arm (`gcode_gen.rs:405-978`) so the object hits `; unknown layer mode 'fillLine' — object skipped`. Only signal is a G-code comment and stderr. | as cited | **Blocks done (1)**: silent G-code error on ordinary input |
| S5 | `serial_stream_job` (buffered) writes `$32=1` unconditionally at job start (`serial.rs:552-560`). The 2026-09-10 ruling rejected "automatically enabling on START" because it mutates persistent machine configuration. Opt-in path only. | as cited | Degrades (ruling contradiction, not default) |
| S6 | Buffered progress schema mismatch (R22): `#[serde(rename_all = "camelCase")]` on the enum at `serial.rs:495` renames *variants*, not struct-variant *fields*, so `line_index` reaches TS as `line_index`; `jobStream.ts:151` reads `event.lineIndex`, computes `NaN`, and stores it. No serialization fixture test exists. | as cited | Degrades (buffered mode only) |
| S7 | `job_abort` is reset before the command lock is taken (`serial.rs:531`) — R3's "reset shared abort before ownership". Low reach from the UI today. | as cited | Degrades |
| S8 | Completion is last-ack plus a 30 s Idle poll that returns `complete` with a warning on timeout (`jobStream.ts:355-384`) — R12. | as cited | Degrades |
| S9 | fillLine gap crossing is `G1 S0`, not `G0` (`mask_fill.rs:319-333`). Safe, slow. Already on the ROADMAP as a Phase 4 item. | as cited | Cosmetic |
| S10 | Phase 2A buffered streaming was built to cure stutter from a 15-block planner; this controller reports 127 blocks and 64 KiB RX (`[OPT:VHL,127,65536]`, confirmed in the 2026-09-14 log). Gate D1c has never been run. The premise is unmeasured. | DECISIONS:124-127 | Cosmetic to the charter; a release that changed machine behaviour without a measured benefit |

---

## Area 6 — Safety stack (e-stop, pause, disconnect, `$32=1` gate)

**Current state: the e-stop primitive is correctly built; the policy around it is incomplete, and the newest gate protects one door out of three.**

What works:
- `emergencyStop`: `!` → 100 ms → `0x18` via the realtime handle → bounded re-poll → conditional `M5` only on a returned Idle/Run report (`connection.ts:535-641`). Honest failure reporting when neither byte was delivered, one retry of `0x18`.
- STOP flips `jobRunning` first so the loop exits and does not double-volley (`JobActionBar.tsx:103-106`; `jobStream.ts:308-318`).
- Disconnect during a job or motion state fires `emergencyStop` before teardown; Rust fires a pre-lock `0x18` when a pump is in flight or the frontend says a job is active (`connection.ts:225-261`; `serial.rs:338-357`).
- `0x9E` is gone from pause (`jobStream.ts:35-68`). Sim models the toggle and hold auto-off (`sim/grbl.rs:409-424`, `:575-585`); regression test `serial.rs:1512` proves the sim would now catch the old bug.
- A `$32=1` gate exists on START and FRAME (`canStartJob.ts:146-157`; `JobActionBar.tsx:172-180`).

**Gaps.**

| # | Gap | Where | Severity |
|---|---|---|---|
| F1 | **The `$32` gate does not cover the material test.** `MaterialTestDialog.tsx:411` (grid) and `:440` (frame) call `streamJob()` directly after checking only connected, not-running, and bounds (`:389-406`, `:417-435`). No idle-state check, no `grblLaserMode` check; the only `$32` signal is a banner when `powerMode === "M4"` (`:444`). The per-line path has no Rust gate. So a material test on a `$32=0` machine starts, PAUSE is hold-only, and the beam stays on a stationary head — the exact scenario the v0.8.29 commit says the gate prevents. Same shape as the four 2026-09-10 defects: one caller fixed, not the class. | as cited | **Blocks done (1)** |
| F2 | **The gate reads a store flag that goes stale.** `grblLaserMode` is set from `$$` at connect and by the Enable button; a `$32=0` typed in the console (`Console.tsx:36` just sends) leaves it `true`, so START passes on a machine whose firmware will not auto-stop at hold. `enableLaserMode` treats any `ok` as acceptance (`connection.ts:652`) with no readback; the 2026-09-10 ruling requires "written and read back matching". `gcodeGen.ts:923` already admits the staleness in a comment. | as cited | **Blocks done (1)** |
| F3 | **Pause is a resumable hold whose safety rests on a claim the rulings say cannot be qualified.** DECISIONS 2026-09-10: "Pause is hold-only, and becomes stop wherever a dark hold has not been observed on hardware", and with status-only evidence "hold-only pause cannot be qualified and powered release stays blocked". The shipped pause sends `!`, resumes with `~`, and never becomes stop. The evidence for the hold being dark is `FS:0,0` in a status report, which is the status-only evidence the ruling names as insufficient. | `jobStream.ts:35-80`; DECISIONS:44-47, :129-132 | **Blocks done (3)** by the project's own ruling |
| F4 | The retained "informational" Hold:0 poll can never succeed during a job: `serial_get_status` `try_lock`s the command lock the per-line pump holds for the whole hold (`serial.rs:450-461`). Every pause therefore prints `WARNING: Machine did not reach full Hold within 3s` after 3 s, unconditionally — a guaranteed false warning on every pause. The 2026-09-05 diagnosis explained this; the poll was kept anyway. | `jobStream.ts:38-67` | Degrades (operator learns to ignore warnings) |
| F5 | **Relative jog reverses direction on this machine's frame.** `jog()` clamps `dest` to `[0, bed]` with no `originTop` handling (`connection.ts:421-431`). The store defaults `originTop: true` (`store/index.ts:807`) and the Rust generator confirms that frame is `Y=0 top, Y=-height bottom` (`commands/gcode.rs:377`); the owner's own console shows `Y-248.913`. At Y=-248.913 a -1 mm jog becomes `$J=G91 Y248.913`: a 249 mm move at F1000 the operator did not ask for. `jogTo` has the same clamp (`:449-451`). Only active when `workspaceVerified`, which `$$` sets automatically. | as cited | Degrades → hazard (unexpected travel) |
| F6 | **The material test program is generated in positive Y and bounds-checked without `originTop`.** `generateMaterialTestGcode` starts at `G0 X0 Y0` then `startX/startY = 10+…` upward (`MaterialTestDialog.tsx:104-127`); `generateFrameGcode` likewise (`:261-273`). Its `isWithinBounds` calls omit the `originTop` argument (`:400`, `:429`), so `minY >= 0` passes. On an origin-top machine every Y is beyond home: a soft-limit ALARM if `$20=1`, otherwise the gantry drives into the end stop. Not recorded anywhere. | as cited | Degrades → hazard on the owner's frame |
| F7 | Idle disconnect after a manual laser-on skips the e-stop: `needsEstop` is `jobRunning || run || hold` (`connection.ts:232-233`) and Rust gates on `pump_in_flight || job_active`. A console `M3 S…` followed by Disconnect leaves the beam armed with the port closed (R9). The Fire button brackets its `M3` with `G4` and `M5` (`MachinePanel.tsx:894-904`) so it is low-reach; the console is not. | as cited | Degrades |
| F8 | One shared stop operation with a hold conditional on verified laser-off behaviour (ruling 2026-09-10) is not implemented: `emergencyStop` holds unconditionally, the two job-abort sites have their own M5-first sequence, and disconnect has a third. | `connection.ts:535`; `jobStream.ts:257`, `:396` | Degrades (ruling not implemented; see S2) |
| F9 | `connect()` seeds `machineState = "idle"` before the first real report (`connection.ts:125`); the ALARM window is closed by an immediate query, but "unknown" is never a state. Stale-status handling (R10) is untouched. | as cited | Degrades |
| F10 | `scripts/probe-grbl.py` still sends `0x9E` during its pause case (`:404`) and guesses axis signs; the 2026-09-14 log shows `[MSG:Restoring spindle]` twice from it. The diagnostic in the owner's hands repeats the unsafe behaviour it measures (PLAN batch 3.1). That log, with the vendor firmware string, is committed to a public repository (`scripts/probe-20260914-153729.log`) — DECISIONS says hardware identity stays in the private register. | as cited | Degrades (tooling) + a privacy slip |

---

## Area 7 — CI / simulator verification

**Current state: CI is well built as a gate; the thing it gates is not the property the charter names.**

What works (`.github/workflows/ci.yml`, `build.yml`, read in full):
- PR/push: 5-file version drift assert, `tsc --noEmit`, lint, vitest, Vite build, prettier check, `KERF_UPDATE_GOLDEN` asserted unset, `cargo test --features sim`, `clippy --all-targets -D warnings`.
- Tag `v*`: a `test` job re-runs tag-vs-package.json plus all of the above; `build-macos`/`build-linux` `needs: [test]`; `release` needs both. **A red test suite cannot ship installers.** This was not true in June (v0.8.21 shipped binaries one commit behind a fix); it is true now.
- The simulator is behind `#[cfg(any(test, feature="sim"))]`, and `sim_integration` drives the real `drain_startup_banner`, `run_pump`, `disconnect_inner`, `send_byte_inner` (`serial.rs:1087-1455`). The wedged-pump e-stop test is genuine.

**Gaps against "the streaming and safety stack is verified in CI by the GRBL simulator".**

| # | Gap | Where | Severity |
|---|---|---|---|
| C1 | The sim hardcodes `$32=1` in its `$$` dump (`sim/grbl.rs:510`), accepts every `$N=V` write as `ok` (`:515-519`), always reports `MPos:0,0,0` (`:571`), emits no `A:` accessory field, never rejects a line with `error:N`, and models stock 128 B / 15-block buffers while the owner's controller is 65536 / 127. It **cannot** represent the `$32=0` case the new gate exists for, a rejected settings write, a position-dependent bug, or the wedge (`dropped_ok_triggers_idle_stall_disconnect` at `:1139` drops one ok; the wedge drops all of them). | as cited | **Blocks done (2)** |
| C2 | The e-stop volley test writes `!` and `0x18` straight to the sim port (`serial.rs:1592-1622`); it never invokes the production `emergencyStop` body. It proves the sim resets, not that Kerf's stop path does. | as cited | Blocks done (2) |
| C3 | The TS STOP tests do not click STOP: they `useStore.setState({ jobRunning: false })` "to simulate what handleStop does" and then assert the volley did *not* fire (`machineJobLoop.test.tsx:187-229`). Deleting `handleStop`'s `emergencyStop` call fails no test. The `invoke` mock returns canned `<Idle>`/`<Hold:0>` flipped by a boolean (`:98-116`), so no test ever meets the command lock that defeated the v0.8.28 poll. A2's finding (R14) stands in full. | as cited | Blocks done (2) |
| C4 | PLAN.md Phase 0 (batch 0.1 `scripted_port.rs`, batch 0.2 unified recorder, click-through STOP) **does not exist**: `src-tauri/src/sim/` holds `grbl.rs` and `mod.rs` only. The v0.8.29 pause fix landed before the seam that would have made its tests falsifiable. | `ls src-tauri/src/sim/` | Blocks done (2) |
| C5 | Tests run on ubuntu only; macOS (the owner's OS, where DTR, serial timeouts and the sleep inhibitor live) is build-only. No Windows. | `ci.yml`, `build.yml` | Degrades |
| C6 | `KERF_UPDATE_GOLDEN` is `is_ok()` — any value, including `0`, rewrites fixtures locally (`gcode.rs:425`); CI guards it, a laptop does not. Goldens are "current behaviour, warts and all" and pin R13's over-burn as correct (`gcode_gen.rs:1389-1429`). | as cited | Degrades |
| C7 | `buffered_pump_pause_detection` (`serial_pump.rs:1237-1263`) asserts `Complete` and "≥2 status reports", not that sending was suppressed during Hold. | as cited | Degrades |

---

## Area 8 — Drift tripwires

Feature surface read from `MenuBar.tsx:108-420`, `CommandPalette.tsx:26-411`, `toolHandler.ts:166-266`, `types.ts:35-47`.

| Feature | Classification | Evidence |
|---|---|---|
| Import SVG/DXF/Image/PDF, Trace, layers, Frame, Start, Save G-code, Material Test, Material Library, Onboarding | On the path | `MenuBar.tsx:118-123`, `:388` |
| Select, rect, ellipse, line, pen, node edit, measure, pan | Minimal drawing tools the charter tolerates | `types.ts:35-45` |
| Boolean ops (`polygon-clipping`), Offset, Grid/Circular Array, align/distribute/flip | Beyond "minimal", short of CAD; predate the charter | `MenuBar.tsx:332-383` |
| **Text tool: four bundled TTFs (1.26 MB in `public/fonts/`), `opentype.js`, font picker, multiline + alignment, live font preview, auto text-to-path at G-code time** | **Named exclusion.** Charter: "built-in font rendering (trace from PNG instead)". ROADMAP:392: "Built-in font rendering — trace from PNG instead". ROADMAP also parks "Text" under v1.0 behind gate D3, which was never opened. | `geometryActions.ts:24-77`; `PropertiesPanel.tsx:10-19`; `Viewport.tsx:1016-1092`; `gcodeGen.ts:849-893`; shipped v0.8.29 |
| Variable Text (serial numbers, CSV merge via `papaparse`) | Depends on the text tool; ROADMAP Tier 3 "pro"; not on the loop | `VariableTextDialog.tsx` |
| QR Code generator (`qrcode` dep) | Design generation inside the app; not AI, not "design elsewhere" | `QrCodeDialog.tsx:13-23` |
| Auto-Nest (skyline bin-packing) | ROADMAP Tier 3; layout helper, not on the loop | `nesting.ts` |
| Color tracing | On the path (Trace), though it does not reach layers (Area 2) | v0.8.29 |

**Scope tripwire: fires.** The text tool is the charter's most explicit exclusion, in the charter's own words, shipped at Lee's direct request ("actually being able to add text"). The request is legitimate; the charter says it may be rewritten only with Lee's approval, and he has effectively given it — but **neither `CHARTER.md` nor the ROADMAP's "What We're NOT Building" was amended**, and the v1.0/D3 gate the ROADMAP puts text behind was skipped rather than opened. The tree now contradicts its own founding document. Also: SVG `<text>` import feeds the same auto-convert path, so imported text is cut in a substituted bundled font rather than skipped, and the design canvas and cut disagree on baseline (Area 4).

**Audience tripwire: clean.** No updater, telemetry, analytics, cloud, accounts; CSP is `connect-src 'self' ipc:`; the only `https://` in `src/` is the QR dialog placeholder. No Marlin/Smoothie/grblHAL/FluidNC strings anywhere. GRBL only.

**Built-for-the-builder: fires twice, lightly.** From `git log v0.8.24..v0.8.29`: v0.8.24 was pure tooling (justified by the June shipping mistake); v0.8.25/26 were cut safety; v0.8.27 shipped buffered streaming to cure a stutter this controller's 127-block planner may not have, unmeasured; v0.8.28 shipped a pause "fix" that made pause worse; v0.8.29 made pause safer and added the exclusion above. Two releases changed machine behaviour without a cut getting safer, more correct or easier.

---

## Area 9 — ROADMAP position vs the charter's phase arc

The charter's arc puts "here" at: Hardening Phase 0 (done, v0.8.24), Phase 1 simulator (done, 2026-07-04), v0.8.25 remediation (done), **gate: owner hardware test card passes and the laser is confirmed back in service**.

- Laser back in service: confirmed 2026-08-27 (DECISIONS reversal). Met.
- Test card passes on a release build: **never happened.** `docs/test-card.md` was last substantively edited 2026-07-10 (`66c2975`); it has no Part 0, no "superseded" marks, and step 6 still promises "the laser turns off immediately on Pause… picks back up cleanly on Resume". The handoff says the artifact card was revised 2026-09-05 and the in-repo copy was not; it has since also fallen behind the v0.8.29 pause change.
- Phase 2A (buffered streaming): implemented and shipped opt-in in v0.8.27; gate D1c (A/B on hardware) never run; premise questionable on this controller. Phase 2B (recovery UX): not started. Phase 3 (efficiency): not started. Phase 4 (geometry): gate D2 open and unmade. Phase 5, 6: not started.
- Meanwhile the project pulled "Text" forward from v1.0 (gate D3, "parked on Lee's go") without opening the gate.

ROADMAP hygiene: the `current:` field still says "Phase 1 COMPLETE … NEXT: Phase 2 streaming rework" (ROADMAP.md:3) while `next:` (line 4) is current as of 2026-09-10. Neither mentions v0.8.29 or that the owner's trace log has arrived (`scripts/probe-20260914-153729.log`), which closes one of the handoff's "OWED BY LEE" items; the handoff still lists it as owed.

---

## Area 10 — DECISIONS.md: unresolved blockers against "done"

Read in full. Blockers that stand between the tree and the charter's "done", by ruling:

1. **"Hardware evidence is status-only; optical shutdown cannot be qualified, and powered release stays blocked on that basis"** (2026-09-10). Consequence stated in the ruling itself: hold-only pause cannot be qualified; "if measurement never becomes available, the honest cost is a release that stays blocked". v0.8.29 was released anyway, with a resumable hold. Either the evidence ruling is revisited or the release contradicts it.
2. **"The laser-switch wedge requires a captured trigger and a prevention before release; a quiet run is not closure."** Trigger not captured (the 2026-09-14 log is in the repo and unanalysed against the tree; the probe still guesses signs and sends 0x9E).
3. **"Every abort routes through one shared stop operation"** — not implemented (S2, F8).
4. **"START refuses to run until laser mode and power scale are written and read back matching"** — partially: `$32` is gated at two of three doors from a flag that goes stale, with no readback; `$30` is not gated at all.
5. **"Pause is hold-only, and becomes stop wherever a dark hold has not been observed"** — hold-only half done; the "becomes stop" fallback absent.
6. **"The Phase 2 abort order must never contain an ack-awaited write"** — violated at `jobStream.ts:257`, `:396`.
7. **Gate D2** (Clipper2 / region offset) open and unmade; the geometry program is deferred with the full feature set kept, so R13/R18/R19 are "must be fixed before release" by Lee's own choice, and none is fixed.
8. Owed by Lee and still open: the scrap comparison cut validating the M4 default (nothing in the tree has ever emitted M4 for a vector line on this machine and had the cut compared).

The DECISIONS file is accurate and honest. What is missing is enforcement: nothing in the release path reads it.

---

## Ranked top 10 gaps (by impact on "done looks like")

| # | Gap | Blocks | What has to change | Scope | On ROADMAP / plan? |
|---|---|---|---|---|---|
| 1 | **Wedge kills the job, and the abort path delays the reset behind an unacked M5** (S1, S2, F8) | Done 1 | Capture the trigger from the 2026-09-14 log against the tree, then one shared stop operation that requests `0x18` without awaiting any line; treat "terminal lost" as a recoverable controller fault (reset, keep the port, offer restart) rather than a dead port | Large (PLAN Phases 1, 3, 4) | Yes: Parking Lot + PLAN.md R2/R4; nothing started |
| 2 | **"Laser stops firing" mid-job, three reports in a week, diagnostic only and untested** (S3) | Done 1 | Test the `FS:` drop detector; correlate the next occurrence's console with the emitted G-code; the stationary-arming block (R8) and the `$31`/powerMin question are the first suspects to rule in or out | Unknown until data; medium | Yes: Parking Lot entry, no batch |
| 3 | **`$32` gate covers START/FRAME only; material test bypasses it; the flag goes stale; no readback; buffered mode writes `$32=1` on START against the ruling** (F1, F2, S5) | Done 1 | Route all four entry points through one admission; invalidate `grblLaserMode`/`grblSValueMax` on any console `$` write; make Enable a write+readback transaction; remove the START-time write from `serial_stream_job` | Small–medium | Yes: PLAN 2.1/2.2 (acceptance 2 of 2.2 names exactly this); not applied |
| 4 | **Pause is a resumable hold that the evidence ruling says cannot be qualified; every pause prints a false 3 s warning** (F3, F4) | Done 3 | Either pause-means-stop (ruling's fallback, small) or Lee revisits the status-only evidence ruling explicitly; either way delete the poll that cannot succeed | Small (code) + a decision | Yes: PLAN 1.5/4.1; DECISIONS 2026-09-10 |
| 5 | **Sharp rectangle on Fill+Line silently dropped** (S4, R16) | Done 1 | Lower a pointless rectangle to an explicit perimeter through the same contour machinery as other shapes; make an unknown mode a hard generation error, never a comment; add the primitive-rectangle regression test | Small | Yes: PLAN 2.4 |
| 6 | **CI verifies a simulator that cannot represent this controller or the cases the gates exist for; STOP tests do not click STOP; Phase 0 seam absent** (C1–C4, C7) | Done 2 | PLAN batches 0.1 and 0.2 first (scripted port, click-through STOP, unified recorder); give the sim a tracked `$32`, rejected-writes, an `A:` field, a sustained-drop-ok fault, and a 127/65536 profile; make the e-stop test call `emergencyStop`'s body | Medium–large | Yes: PLAN Phase 0, batch 0.1 "next relay, unblocked" since 2026-09-10 |
| 7 | **Jog reverses on the origin-top frame; material test generates positive-Y and bounds-checks without `originTop`** (F5, F6) | Done 1 (hazard) | Jog: block when the frame is unknown, clip toward zero never past it, respect `originTop`; material test: generate in the store's frame and pass `originTop` to the bounds check | Small | Jog: PLAN 2.5. Material-test frame: **not recorded anywhere** |
| 8 | **Geometry output is wrong on ordinary settings**: angled fill over-burns (R13), kerf expands holes and Offset Fill drops split regions (R18), reversing Beziers become chords (R17), inner-first misses secondary outers (R19) | Done 1 ("correctly") | Lee chose the full feature set, so these are corrections, not refusals: rotate the hatch not the region; a region-aware offset (Gate D2 call); finite-chord flatness; contour-level containment | Large | Yes: Phase 4 / D2 / PLAN 2.3 (to be re-specified), 5.1, 5.2 |
| 9 | **Text tool contradicts the charter's named exclusion; charter and ROADMAP unamended; D3 gate skipped** (Area 8) | Charter integrity | A one-line charter amendment approved by Lee ("built-in text from bundled fonts is in; font management and text-on-path stay out"), the ROADMAP exclusion list updated, and the canvas-vs-cut baseline mismatch fixed | Decision (small); code small | The sub-deferrals are in the Parking Lot; the contradiction itself is not |
| 10 | **Silent import losses**: hidden SVG layers cut, `<use>` clones vanish, group styles not inherited; DXF has no layer mapping and drops INSERT/SPLINE/ELLIPSE | Done 1 (DXF), degrades (SVG) | Skip `display:none`/`visibility:hidden` subtrees; resolve `<use>` (or count it as skipped); inherit `<g>` presentation attributes; DXF layer/color mapping dialog and INSERT expansion | Small (SVG), medium (DXF) | DXF: Tier 2 gap, "never shipped". SVG items: **not recorded** |

**Just below the line, worth a Parking Lot entry each:** Air Assist toggle is inert (Area 3); color tracing does not reach layers (Area 2); buffered-mode progress is `NaN` (S6); idle disconnect after a console `M3` (F7); the probe script still sends `0x9E` and its log with the firmware identity is public (F10); Min Pwr shown live (recorded); sub-layer power defaults to 100 (recorded); the test card describes a dead protocol (Area 9).

---

## What works well, said plainly

- SVG import and the `.kerf` format are careful, tested, and follow the rulings to the letter (forward-version refusal, atomic save, backups).
- Binary tracing has real preview/commit parity and handles both speck polarities.
- The layer system is the cut sequence, visibly, and the powerMin clamp is enforced at both doors as ruled.
- The preview is the truth: it draws the same moves the machine will receive, and FRAME and the bounds gate use the same extents.
- The lock architecture in `serial.rs` is right, and the test that proves an e-stop byte reaches the wire past a wedged pump is a genuine proof, not a mock talking to itself.
- CI now refuses to ship installers on a red suite.

## What this means for the three "done" conditions

- **Condition 1 (loop works, no cut dies, no silent error):** fails on the owner's hardware today for two independent reasons (wedge; laser-stops-firing), plus one silent generator drop on ordinary input, plus a safety gate that covers one door in three.
- **Condition 2 (CI-verified stack):** the pipeline runs; the verification is of a model the hardware has already contradicted once, and the tests that matter (STOP, pause under the real lock, `$32=0`) either do not exist or cannot fail.
- **Condition 3 (phases shipped, test card passes on a release build):** Phase 2 is half-shipped on an unmeasured premise, Phases 2B–5 unstarted, and the card has never passed. By the project's own rulings, a powered release is blocked until the wedge trigger is captured and pause is qualified or made stop; v0.8.29 shipped regardless.

The order that gets to "done" fastest is the order the remediation plan already wrote down: make the safety tests falsifiable (6), close the gate class (3, 7), fix the silent drop (5), then use the hardware log to chase 1 and 2. Everything else in this document is real but secondary to a cut that finishes.
