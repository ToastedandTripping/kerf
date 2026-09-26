# Kerf Architecture

## Stack

| Layer    | Technology                            | Purpose                                                    |
| -------- | ------------------------------------- | ---------------------------------------------------------- |
| Frontend | React 18 + Pixi.js 8                  | UI panels + WebGL canvas                                   |
| State    | Zustand                               | Single store; one extracted action factory (geometry)      |
| Styling  | CSS custom properties + inline styles | Dark mode, design tokens                                   |
| Backend  | Rust (Tauri v2)                       | Serial/GRBL, G-code gen, raster scan, tracing, dithering   |
| Build    | Vite                                  | Frontend bundling                                          |
| CI       | GitHub Actions                        | macOS + Linux builds, tests                                |
| Desktop  | Tauri v2                              | Native window, file dialogs, serial port access            |

## Directory Structure

Line counts are `wc -l` at the time of writing and include inline test modules.

```
src/
  main.tsx                   — React root + error boundary; calls installKeepAwake() once
  app/
    App.tsx                  — Root component, dialog wiring, auto-save, onboarding;
                               mounts ActiveLayerStrip and JobActionBar
    types.ts                 — DesignObject, Layer, SubLayer, MaterialPreset, KerfProject
    store/
      index.ts               — Zustand store creation, CRUD, selection, layers, undo,
                               z-order, zoom, machine, project, UI (~880 lines);
                               module-level dirtyObjectIds + cursor-position pub/sub
      geometryActions.ts     — Align, flip, group, boolean, array, convert, offset
                               (~1200 lines, uses polygon-clipping + opentype)
      storeHelpers.ts        — buildObjectsById, selectionPatch
      storeTypes.ts          — AppState interface, Command, generateId, type aliases
      __tests__/             — Store and geometry action tests

  components/
    bottom/
      Console.tsx            — GRBL serial console (send/receive)
      JobPreview.tsx         — Animated G-code preview (Canvas 2D, rAF playback)
      StatusBar.tsx          — Connection state, object count, cursor position
    panels/
      ActiveLayerStrip.tsx   — Pinned-top strip: active layer colour, name, power, speed
      JobActionBar.tsx       — Pinned-bottom START / FRAME / PAUSE / STOP + progress and
                               elapsed time; the main job entry point (see Data Flow)
      LayerPanel.tsx         — Cut layers with drag reorder, inline settings, sub-layers
      PropertiesPanel.tsx    — Object transform, opacity, power scale, image adjustments
      MachinePanel.tsx       — Serial connect, alarm/unlock/home, limits and laser-mode
                               controls, jog, set origin, Generate G-code
      MaterialLibrary.tsx    — Browse/search/apply/save/export/import presets
      SvgImportDialog.tsx    — SVG colour-to-layer dialog AND the live SVG importer
                               (~1030 lines): importSvgWithLayers, transform attr, units,
                               embedded CSS cascade, element walker. No other SVG
                               importer exists; tests reach it via _testImportSvgWithLayers
      ImageImportDialog.tsx  — Drag-and-drop image import (layer choice, auto-trace option)
      [11 other dialogs]     — Settings, GRBL settings, QR, image trace, material test,
                               PDF import, power curve, dither preview, variable text,
                               nesting, project notes
      OnboardingOverlay.tsx  — First-run walkthrough
      ShortcutOverlay.tsx    — Keyboard shortcut reference
      SpeedInput.tsx         — Log-scale speed slider + field, capped by $110/$111
      CollapsibleSection.tsx — Shared collapsible panel section
      __tests__/             — Panel, job-loop and SVG import tests
    toolbar/
      Toolbar.tsx            — Tool selection (select, rect, ellipse, line, pen, text, node,
                               measure, pan)
    topbar/
      MenuBar.tsx            — File/Edit/View/Arrange/Tools/Help menus, recent files
      CommandPalette.tsx     — Ctrl+K fuzzy command search
    viewport/
      Viewport.tsx           — Pixi.js 8 WebGL canvas, persistent display cache, selection handles
      renderHelpers.ts       — placeSprite / applyTextImageTransform / rotationPlacement /
                               applyObjectRotation / renderImageObject: one placement rule for
                               rotated and flipped text, images and Graphics (pivot at centre)
      textureCache.ts        — module-private image texture cache: getReadyTexture (decode,
                               then a pending/failed state; never an empty outline),
                               isTextureFailed (crossed-box placeholder), evictTextures,
                               clearTextures (generation bump), setTextureReadyListener
      Rulers.tsx             — mm rulers along canvas edges

  lib/
    fileOps/
      index.ts               — fileOperations object, Tauri dialog routing, project I/O,
                               project-load migrations
      svgImport.ts           — parsePathD only (~530 lines): SVG path `d` parser returning
                               subpaths, incl. arc flattening. Used by SvgImportDialog and
                               ImageTraceDialog. It is NOT the SVG importer (see above)
      dxfImport.ts           — DXF LINE/CIRCLE/ARC/LWPOLYLINE parser (importDxfDirect)
      imageImport.ts         — Image byte→base64→canvas import, PNG pHYs DPI
      svgExport.ts           — Design objects→SVG XML export
      pdfImport.ts           — PDF vector extraction via pdf.js (paths, lines, rectangles)
      __tests__/             — dxfImport, svgImport, svgExport, imageImport, migration,
                               savefix, fileSafety
    machine/
      connection.ts          — machineConnection: connect/disconnect, $$ settings parse,
                               250ms status poll + 3-strike disconnect, send, jog, home,
                               emergencyStop (invokes serial_stop)
                               The spindle-drop check is `noteSpindleSample` in
                               `lastSentLine.ts` (total, status only), fed from
                               `pollStatus` (no job), `send()` in-pump reports
                               (per-line), `getStatusReport` (drain) and buffered
                               `status` events. It is reset per job by `startJobEvidence`
                               and summarised per job by `endJobEvidence`.
      jobStream.ts           — streamJob: shared streaming loop for every G-code send;
                               dispatches on streamingMode (perLine default | buffered);
                               pauseJob (= stop) / resumeJob
      jobSession.ts          — JobSession: job lifetime from serial_job_begin through
                               drain to serial_job_end; module-level single active session
      machineStatus.ts       — Status consumer: GrblSnapshot mirror types, monotonic
                               epoch/seq rejection, store writes, 3s eligibility
      canStartJob.ts         — The one admission for all four powered doors (START,
                               main FRAME, material-test Send and Frame): canStartJob
                               (state, ext?); ext supplied = locally generated program
                               (skips gcodeResult/gcodeStale, bounds from ext with
                               originTop). Plus moves extents, frameTargets,
                               isWithinBounds, gcodeExtents (text G-code)
      gcodeGen.ts            — Frontend G-code orchestrator, calls Rust backend via
                               Tauri invoke (hard-fail on engine error — no JS
                               fallback), bezier sampling at serialization,
                               layer-order sorting, assembleGcode
      overscan.ts            — computeOverscan: acceleration-derived fill overscan
      keepAwake.ts           — jobRunning subscription → keep_awake_acquire/release
      machineStateDisplay.ts — State colours/labels, GRBL alarm descriptions
      knownDevices.ts        — USB VID/PID table for auto-detect priority sorting
      textGcode.ts           — textToGcode: text → G-code lines (font outline extraction)
      materialTestGcode.ts   — generateMaterialTestGcode / generateFrameGcode (pure, no store)
      __tests__/             — G-code, connection, streaming, status, gate, keep-awake and
                               safety tests; serialTraceHarness.ts
    tools/
      toolHandler.ts         — Pointer event state machines for all tools, snap guides
    hooks/
      useEscapeClose.ts      — Escape-to-close for modal dialogs
      useFocusTrap.ts        — Keyboard focus trap for modal dialogs
    autoSave.ts              — 60s periodic save to Tauri appDataDir, crash recovery
    constants.ts             — Shared constants (PX_PER_MM, MM_PER_INCH, zoom limits, formatTime)
    fileDrop.ts              — Drag-and-drop file handler (SVG/DXF/image/PDF detection)
    geometry/
      index.ts               — Shared geometry utilities: 2x3 affine helpers,
                               composeGroupChild(Transform), buildGroupObject,
                               composedLeaves/drawnLeaves (render = cut composition),
                               matrixMaxStretch (SVG arc tolerance in real mm),
                               computeAABB/rotatedExtents/pointsBBox, move/scale/points
                               partials, orientedHandlePoints, offsetRingByDistance,
                               adaptive bezier sampler + CURVE_CHORD_TOLERANCE_MM
    materials.ts             — 18 default MaterialPreset entries
    measure.ts               — Pure helpers for the Measure tool
    nesting.ts               — Skyline Bottom-Left-Fill bin-packing algorithm
    recentFiles.ts           — localStorage-backed recent file list
    shortcuts.ts             — Keyboard shortcut registration (includes 1-6 layer assignment)
    speedScale.ts            — Speed-to-display scaling utilities
    variableText.ts          — Template placeholder parser, serial number generator, CSV import
    __tests__/               — Cross-module tests (creator invariants, image pipeline, ...)

src-tauri/src/
  lib.rs                     — Tauri builder, managed state, command registration
  commands/
    mod.rs                   — Module list (file I/O is tauri-plugin-fs; no custom commands)
    serial.rs                — Tauri serial commands: list/connect/disconnect/send/send_byte/
                               get_status/stream_job/abort_job/stop/job_begin/job_end.
                               Two-mutex (command + realtime) state, stop operation,
                               buffered stream wrapper; tests + sim_integration module
    serial_session.rs        — Session-level admission fence: epoch, phase transitions,
                               permit generation, StopResult enum, StopGuard RAII,
                               status snapshot slot (monotonic epoch/seq)
    serial_pump.rs           — Line-protocol pumps: run_pump (wait-for-terminal, `?`
                               liveness probing, idle-stall detector, line classification
                               ok/error/ALARM/banner), drain_classified, read_status_bounded,
                               run_buffered_pump (127-byte RX budget character counting)
    grbl_status.rs           — parse_status_frame: `<…>` report → GrblSnapshot (state,
                               MPos/WPos, WCO, FS, accessory, unknown fields)
    gcode.rs                 — Tauri commands: generate_gcode, generate_image_gcode,
                               preview_image_dither; golden_tests module
    image_trace.rs           — Tauri command: trace_image_command (calls engine)
    power.rs                 — keep-awake acquire/release (OS sleep inhibitor during jobs)
  sim/                       — Test infrastructure, #[cfg(any(test, feature = "sim"))] only
    grbl.rs                  — Virtual GRBL 1.1 controller implementing serialport::SerialPort:
                               shared Arc<Mutex> brain, two-stage RX→planner buffer with
                               ok-on-accept, fault injection, strict-hold (M3/M4/M5-in-Hold)
                               invariant. The CI backbone for the streaming stack.
                               `$$` is a settings table and `$32` is tracked (non-zero
                               integer part = laser mode, stored as 1/0): the hold
                               auto-off applies only under `$32=1`. `set_reject_setting`
                               (error:3, not applied); `set_ignore_setting` (ok, not
                               applied: the START ruling's acknowledged-but-not-accepted
                               case). Writes are accepted in every state (stock error:8
                               outside Idle/Alarm is not modelled), and 0x18 always
                               clears the spindle. `set_wedge_after_spindle_cmd` arms when
                               the M3/M4 line is parsed: from then until 0x18 every line
                               not yet acked, parked ones sent before it included, is
                               accepted and executed but never acked; `?` answers.
                               Non-finite setting values answer error:2.
                               `SimProfile::{Stock, Captured127}` (128/15 vs 65535/127).
                               `A:` field per profile: Stock `A:S` while the sim's spindle
                               flag is set (stock-source intent); Captured127 `A:S` on every
                               report (the 2026-09-14 capture shows it only on reports
                               carrying overrides). Not a beam signal under either
                               profile (DECISIONS 2026-09-25). Host/model evidence only;
                               never certifies the owner's controller.
    scripted_port.rs         — Deterministic test double with scripted read steps,
                               ordered I/O trace, hold points, session-event observer
  engine/
    gcode_gen.rs             — G-code generation per CutObject mode: line (vector cut with
                               lead-in/out, tabs, perforation, overcut); fill (scan lines
                               over the AABB — accepts only primitives or a single closed
                               4-point path, other paths emit "; fill skipped");
                               offsetFill (inward polygon rings); maskFill (delegates to
                               mask_fill.rs). maskFill is internal-only, assigned by
                               gcodeGen.ts for non-rectangular/compound fills
                               The TS generator never sends `fillLine` to Rust: it lowers
                               it to maskFill plus a `line` overlay (a sharp rectangle gets
                               a synthesized 4-corner contour), and `assertNoFillLine`
                               throws otherwise.
                               Every mode line is `{M3|M4} S0`; power rides only on `G1`
                               words that carry X or Y (safety engine-arm, 2026-09-26).
                               Every line path starts `G0` then `{M3|M4} S0`; every burning
                               vector `G1` goes through `CutPen`, which refuses a move under one
                               motor step (0.0125 mm per axis, as written); a mask fill ends `M5`
                               (safety engine-leadin). Raster and TS emitters are not covered.
    mask_fill.rs             — The one shared raster scanner (~1170 lines + tests):
                               scan_mask_to_gcode (MaskScanParams; binary or grayscale S)
                               used by image engrave and maskFill; fill_compound_mask
                               rasterizes compound contours even-odd via tiny-skia
    image_gcode_gen.rs       — Image→G-code: decode, adjustments, power-curve LUT,
                               background removal, dither, then delegates the scan to
                               mask_fill::scan_mask_to_gcode. Also holds the run-finders
                               and time estimator that mask_fill.rs imports
    coords.rs                — to_grbl_coords: rotation about centre + Y-flip; shared by
                               gcode_gen, mask_fill and image_gcode_gen
    limits.rs                — Resource caps + EngineError: scan-interval floor, raster /
                               move / trace caps, KERF_MAX_* env overrides
    dither.rs                — 8 dithering algorithms (threshold, ordered, Floyd-Steinberg,
                               Jarvis, Stucki, Atkinson, grayscale, newsprint halftone)
    offset.rs                — Polygon inward offset (convex/concave, self-intersection cleanup)
    optimizer.rs             — Cut ordering: layer-index arrival, fill-before-line partition,
                               inner-first rank (containment DAG), NN within rank bands;
                               flood fill segment reordering, start corner selection
    tracer.rs                — vtracer-based image→SVG vectorization with preprocessing
                               (adaptive threshold, morphological ops, blur)

src-tauri/tests/
  golden/*.gcode             — Frozen G-code snapshots (compared in gcode.rs golden_tests).
                               Phase 3 proves output byte-identical; Phase 4 reviews geometry
                               diffs. Regenerate with KERF_UPDATE_GOLDEN=1 (CI guards it unset).
  golden/stop_result_fixture.json — StopResult serde shapes. No test reads this file (Razor N3):
                               serial.rs b1_stop_result_fixture_round_trip round-trips
                               in-memory variants only, and no TS test loads it.
```

## Data Flow

### Core Loop: Import → Layer → Preview → Send

```
1. Import
   SVG   → SvgImportDialog (importSvgWithLayers, parsePathD) → store.withUndo → addObject
   DXF   → dxfImport.ts importDxfDirect → store.withUndo → addObject
   PDF   → PdfImportDialog (pdfImport.ts extraction) → App onImportVector → addObject
   Image → menu: imageImport.ts importImageData → addObject
           drop: ImageImportDialog → addObject

2. Assign to Layers
   LayerPanel.tsx → store.updateLayer()
   Objects have layerIndex, layers have cut settings

3. Generate G-code
   MachinePanel "Generate" → gcodeGen.ts generateGcode()
   → text converted to paths, toCutObjects() (flattens groups, routes
     non-rect/compound fills to maskFill, applies computeOverscan)
   → per layer position: invoke("generate_image_gcode") per image,
     then invoke("generate_gcode") for the vector objects → Rust engine
   → assembleGcode() (one preamble, one footer, M5 at every seam)
   → store.setGcodeResult()

4. Preview
   JobPreview.tsx reads gcodeResult.moves[]
   Canvas 2D animation with rAF playback

5. Send to Machine
   JobActionBar START → canStartJob(store) gate
   → jobSession.beginJobSession() → invoke("serial_job_begin")
   → setJobRunning(true) → jobStream.streamJob(gcode, { waitForIdle: true, session })
   → getStreamingMode() reads localStorage "streamingMode" (default "perLine"):
       perLine  — TS loop: machineConnection.send(line) per line
                  → invoke("serial_send") → run_pump waits for ok/error/ALARM/banner
       buffered — invoke("serial_stream_job", Channel) → refuses unless laserModeVerified
                  (the readback-set flag), writes no setting,
                  then run_buffered_pump; Progress/Console/Status/Finished JobEvents
   → session.drain() → session.end() → invoke("serial_job_end")
```

JobActionBar FRAME, MaterialTestDialog "Send" and MaterialTestDialog "Frame" take the same
path (beginJobSession → streamJob) without `waitForIdle`. All four doors pass `canStartJob`
first (kerf-safety-s1): FRAME with no `ext`, so `gcodeStale` still applies; the material
test with `ext = gcodeExtents(grid)`. A refusal prints the reason verbatim to the console
and, in the material test, also as an in-dialog alert; the buttons' disabled state comes
from the same gate.

**Laser-mode flag (`grblLaserMode`).** Only `applyLaserModeReadback` in `connection.ts`
sets it true: a `$$` response carrying `$32=1`, and only if no settings write happened
after that readback began (module-level `settingsGeneration`). Every settings write
(`$n=`, `$Nn=`, `$RST=`, normalized the way GRBL reads a line) is detected in
`machineConnection.send()`. The write invalidates the flag before its invoke and again
after it settles. `enableLaserMode` invalidates explicitly, because its write bypasses
`send()`. A console `$$` re-verifies `$32` only. The full settings parse runs only from
`queryGrblSettings` (on connect, and the soft-limit requery). A failed readback and
`disconnect()` both leave the flag false. The buffered command `serial_stream_job` receives the flag as `laserModeVerified` (a
plain `bool`, so a missing key is rejected by Tauri before the body runs) and refuses
before any serial I/O when it is false; it no longer writes `$32=1` (kerf-safety-s1b). A
`0x18` does not clear the flag (S4a), and per-line mode has no Rust-side gate (S4a).

**Jog admission and bed trust (kerf-safety-s3).** Every jog passes `jogBlockReason` and
`clipJog` (pure, `src/lib/machine/jogBounds.ts`): refused while not connected, in alarm, in a
job, stale, not idle, in a work frame or with a work offset set or unknown, or while the
previous jog is still moving (one jog in flight, `jogPending`, cleared only by a fresh post-ack
report); otherwise the distance is clipped toward zero at the bed edge, never reversed or
enlarged, and non-finite input refuses. `jogTo` (Position Laser) refuses an out-of-envelope
target; canvas Y maps to machine Y by the generator's rule (`originTop ? -y : H - y`). Every
`$J=` carries `G21`. Bed verification has three sources: the controller's `$130/$131`, an
operator confirmation remembered per machine (keyed by port plus `$3/$23/$100/$101/$130/$131`,
re-applied only on a full settings read, forgotten on a key-setting write, a changed key, a
failed read or Change), and a this-session confirmation; all are cleared on disconnect. A new
connection starts stale, and a stale status displays as "Stale" in grey, never a green
Idle/Ready. `setOrigin` records WCO = MPos after `G92 X0 Y0` only from a fresh machine-frame
position; otherwise the offset is NaN (unknown) and `jogTo` refuses. The material-test program
is mirrored in Y on origin-top machines. Known residuals (MPos 0 trusted as the bed corner;
a jog racing Home) are queued as S3c.

**Job-session lifetime (`jobSession.ts`).** One module-level active session. `beginJobSession`
refuses while another session is active or a stop is settling, and when `serial_job_begin`
rejects. After the last line, `drain(waitForIdle)` polls `getStatusReport()` every 200ms:
with `waitForIdle` it returns on `<Idle`/`<Alarm`, and after 30s returns `unknown`; without
it, it polls for up to 5s and returns `complete` either way. `end(outcome)` calls
`serial_job_end` and, unless the outcome is `unknown`, clears `jobRunning` and
`jobProgress`. An `unknown` outcome leaves `jobRunning` true (keep-awake held, STOP
available). `stopActiveSession()` cancels the session, wakes the drain, and blocks new
sessions until the old one settles. Callbacks from a cancelled session are discarded.

**G-code producers.** G-code comes from three places:
1. The Rust engine via `gcodeGen.ts` (`generate_gcode`, `generate_image_gcode`), joined by
   `assembleGcode` under its laser-safety contract.
2. JobActionBar FRAME: an M5-bracketed G0 program built from `frameTargets(moves)`.
3. The material test: `src/lib/machine/materialTestGcode.ts` (`generateMaterialTestGcode`,
   `generateFrameGcode`, pure and store-free, called by `MaterialTestDialog.tsx`) writes its
   own preamble and footer and computes S as `(power / 100) * grblSValueMax`; labels come
   from `textGcode.ts` `textToGcode`, which emits its own G0 / mode / G1 / M5 per glyph
   contour. Every `M3`/`M4` mode line both emit carries `S0`; positive S appears only on `G1`
   words with motion, so the material test never arms a stationary beam (safety S2,
   2026-09-25). The border follows the chosen power mode. This output does not pass through
   the Rust engine, `limits.rs`, `assembleGcode` or the golden fixtures, and the Rust
   engine's mode lines carry `S0` as well (safety engine-arm, 2026-09-26).

### Serial Lock Order

| Order | Lock | Held by | Duration |
|-------|------|---------|----------|
| leaf  | `session.admitted_job`, `session.last_stop`, `session.observer`, `session.snapshot` | admission/stop/test, snapshot publish/read | Microseconds |
| 2     | `realtime` | `send_byte_inner`, `serial_stop_inner`, `disconnect_inner_with_job` | Microseconds |
| 2.5   | `session.submit` | `admit_and_write` (admission check + one `write()` of a job line), `serial_stop_inner` Step 2 (admission close) | Microseconds; at most one `write(2)` enqueue, bounded by the port timeout (1000 ms) |
| 3     | `command` | `serial_send_inner`, `serial_stream_job_inner`, `serial_connect_inner`, `disconnect_inner_with_job`; `try_lock` only in `serial_get_status_inner` and the stop's banner read | Seconds to minutes |

Connect is the one nesting exception: acquires `command` then `realtime` to install both
handles atomically. Job-line order is `command` → `submit` → `admitted_job`; nothing takes
`submit` while holding `realtime` or `admitted_job`, and `submit` is never held across a read,
flush, drain, pump wait or emit. The stop operation takes `submit` → `admitted_job`, releases
both, then takes `realtime` (never `command`);
after `0x18` it may `try_lock` `command` (never wait) for a banner read. The canonical table
is the module doc at the top of `serial.rs`.

### State Architecture

Single Zustand store with 60 state fields and 99 actions, counted from the `AppState`
interface in `storeTypes.ts` (members whose type is a function are actions; the rest are
state). Dialog state managed via `openDialogs: Set<string>` with `openDialog`/`closeDialog`
actions (no module-level state).
The `geometryActions.ts` slice is the only factory extracted as `createGeometryActions(set, get)`;
all other actions are inline in the main `create()` call. All cross-slice references use lazy `get()`.

Two pieces of UI state live outside the store, in module scope in `store/index.ts`:
`dirtyObjectIds` (see Rendering) and the canvas cursor position. The cursor position never
enters the store: Viewport calls `setCursorPosition`, and StatusBar reads it through
`useSyncExternalStore(subscribeCursorPosition, getCursorPosition)`.

Undo/redo uses a command pattern with snapshot capture (`pushObjectsUndo`). Image data
(base64) is replaced by a placeholder in undo snapshots; the originals are kept in a
per-command map keyed by object id, and restore uses that map with live objects taking
precedence. Stack capped at 50.

**Nested groups render to any depth** (kerf-refresh-cut-vs-screen F1). The Viewport draws
`drawnLeaves(obj, layers)` for each top-level object. That is `composedLeaves` (the same
recursion and `composeGroupChild` as `gcodeGen.ts` `flattenObjects`, keyed by id path
`outer/inner/leaf`), filtered by the cut's own per-leaf rule: it skips `!leaf.visible` and
a leaf whose layer (by `l.index`, falling back to `layers[0]`) is hidden. Unlike the cut,
it does NOT skip `output === false`: output-off objects stay drawn as reference. Texture
eviction walks image ids at any depth.

**Layer reorder is one undo command** (F6/F7). `reorderLayers` remaps `layerIndex` through
every descendant (`remapLayerIndexDeep`) and pushes a `reorder-layers` command whose
undo and redo apply the inverse or forward index permutation to LIVE state
(`applyLayerIndexMap`). It never restores a layers or objects snapshot, so edits that
are not commands (layer power and speed, imports) are kept across undo.

### Rendering

Viewport uses Pixi.js 8 with a persistent display object cache (`Map<id, Container>`).
Dirty tracking (`dirtyObjectIds` set) ensures only modified objects are re-rendered per
frame — unrelated object changes skip the render loop. Text/image display objects use
content hashing to avoid GPU texture re-uploads when only transforms change.

Batch updates (`updateObjects`) consolidate N per-object state writes into a single
Zustand `set()` call during drag. The pan camera is held in a ref during a pan and written
to the store with `setCamera` on pointer-up. `objectsById` Map and `selectedSet` Set
provide O(1) lookups in hot paths.

Both mutation primitives (`updateObject`, `updateObjects`) apply partials through one
recursive `applyPartialsDeep` helper that descends into `group.children` and writes a
partial to ANY id present in the update map, at any depth — preserving reference identity
for unchanged subtrees (so the per-frame drag path doesn't rebuild the tree). It only
touches explicitly-mapped ids, so a group write never cascades onto its children
(move/rotate/scale pass top-level ids only; children ride along via render-time
composition). `objectsById` is deliberately a TOP-LEVEL-only index — `.get(nestedId)`
returns undefined by design; callers needing a nested object walk `children`.

Selection overlay and drawing layer are separate Pixi containers on top of the
objects container.

### Machine Communication

**Connect.** `serial_connect_inner` opens the port, toggles DTR, reads the startup banner
through the one persistent reader, sends a fallback `0x18`, installs the command and
realtime handles, increments the session epoch and sets phase Idle. `connection.ts`
`connect()` then starts the status poll, runs `queryGrblSettings()` (`$$`) and one
`serial_get_status`.

**Settings read on connect** (`queryGrblSettings`; the only full parse. A console or dialog `$$` and the Enable Laser Mode readback apply `$32` only):

| Setting | Store field | Read by |
|---|---|---|
| `$20` / `$21` / `$22` | `grblSoftLimits` / `grblHardLimits` / `grblHoming` | MachinePanel (`grblHardLimits`: no reader) |
| `$30` | `grblSValueMax` (firmware wins over the persisted value) | gcodeGen.ts, MaterialTestDialog, MachinePanel |
| `$32` | `grblLaserMode` | canStartJob, JobActionBar FRAME gate, gcodeGen.ts ($32=0 warning), MaterialTestDialog (M4 warning), MachinePanel |
| `$110` / `$111` | `grblMaxFeedRateX/Y` | SpeedInput cap, gcodeGen.ts scan motion, MaterialTestDialog, GrblSettingsDialog |
| `$120` / `$121` | `grblAccelX/Y` | gcodeGen.ts (`computeOverscan`, scan motion), GrblSettingsDialog |
| `$130` / `$131` | `workspaceWidth/Height` + `workspaceVerified = true` | canStartJob, FRAME, jogBlockReason/clipJog |

**Status polling.** `pollStatus()` runs every 250ms and is skipped while `jobRunning` is true.
`serial_get_status` `try_lock`s the command mutex: when a pump holds it, it writes `?` on the
realtime handle and returns kind `busy` with the last snapshot; otherwise it reads one `<…>`
report (bounded at `STATUS_MAX_TICKS`). `<…>` frames read by the status query, by
`serial_send`'s pump and by the buffered pump are published to the session snapshot slot
(`grbl_status.rs` parse, monotonic epoch/seq).
`machineStatus.ts` `consumeStatusOutcome` rejects stale epoch/seq, writes state, position
(MPos/WPos kind kept), WCO, spindle, feed and accessory flags, and `setStatusStale` is set
from `isStatusEligible()` (last valid report under 3s old), which `canStartJob` reads.
A rejected `serial_get_status` invoke counts a strike; `busy`/no-response sentinels reset the
count. Three consecutive strikes set disconnected, clear `jobRunning` and call `disconnect()`.

During a job the poll is off. In perLine mode the `<…>` reports collected by each line's pump
update position only, never `machineState`. In buffered mode `Status` JobEvents update
position. `JobSession.drain()` polls `getStatusReport()` directly.

**Stop.** JobActionBar STOP calls `stopActiveSession()` (not awaited), `setJobRunning(false)`,
then `machineConnection.emergencyStop()` → `serial_stop`. Per the DECISIONS ruling of
2026-09-20 ("Abort sends 0x18 immediately — no feed hold, no M5, no ack wait"),
`serial_stop_inner`:
1. Single-flights via `StopGuard`; a concurrent caller waits up to 3s and returns `last_stop`.
2. Closes admission under `submit` then `admitted_job`: phase Stopping, `admitted_job`
   cleared; releases both; invalidates the snapshot; sets `job_abort`.
3. Writes `0x18` on the realtime handle, retrying once on write failure.
4. Waits up to 3s for a reset banner, seen by any pump or status body or by its own
   `try_lock`ed read.
Result: `confirmed` (epoch incremented, phase Idle via a Stopping→Idle compare-and-swap),
`submittedUnconfirmed` (phase Unknown) or `submissionFailed` (phase Unknown; TS sets
`machineState` to alarm). Every message says beam state is unqualified. One stop sends one
reset; `serial_stop_inner` is the only production writer of an abort `0x18`. A concurrent stop call is a joiner: it waits, returns `last_stop`, and sends no byte. Job
error/abort outcomes in `jobStream.ts` and `disconnect()` with a job active route through the
same `emergencyStop()`; Rust `disconnect_inner_with_job` calls `serial_stop_inner` before
teardown when a pump or job is active.

**Pause becomes stop.** `pauseJob()` logs that paused jobs cannot resume until a dark hold is
qualified on hardware, clears `jobRunning` and calls `emergencyStop()` (DECISIONS 2026-09-10,
"Pause is hold-only, and becomes stop wherever a dark hold has not been observed on
hardware"). `resumeJob()` sends only `~`.

**Admission fence** (`serial_session.rs`, RF-15). Phase: Disconnected → Idle (connect) →
Active (`serial_job_begin`) → Stopping (stop) → Idle (confirmed) or Unknown (unconfirmed or
failed stop). `serial_job_begin` succeeds only from Idle and returns the epoch as the job id;
`serial_job_end` requires that id and moves Active→Idle only (a CAS: ending a job never
overwrites Unknown). After an unconfirmed or failed stop, no job can begin until a later stop
is confirmed by a reset banner or the port is reconnected. That later stop is the recovery the
operator's live STOP button reaches: its Step 2 stores Stopping unconditionally, and a banner
lets the CAS move Stopping→Idle.

Every job line carries the admitted epoch: `serial_send` takes `jobEpoch` (absent for console,
`$H`, jog and settings writes, which are not phase-gated) and `serial_stream_job` requires it.
**Every job-epoch write goes through `SerialSession::admit_and_write`**: it takes `submit`,
checks admission, makes the line's single `write()` and drops `submit`; the flush (`tcdrain`)
follows outside the lock. The sites are the `serial_send` job line and
the buffered pump's Phase A (`SubmissionGate::admit_write` in `serial_pump.rs`, implemented by
`JobPermit`, independently of the shared `job_abort` flag). `permit_precheck` before the
command-lock wait and `try_permit_begin` under `command` before the drain are
non-authoritative fast-fails that spare a refused line the drain. The stop closes admission
under the same `submit` lock, so a job line is either queued before the stop's single `0x18`
or refused with nothing written; no interleaving puts job bytes after the reset. The premise
(both handles are one tty with one output queue; a job line of at most 127 bytes is one
`write(2)` that returns on enqueue, so the stop waits at most one enqueue, bounded by the port
timeout, and never on the controller, an acknowledgement or transmission) is in the
`serial_session.rs` module doc. The stream body never clears `job_abort` (`serial_job_begin`
is its only clearer). The buffered pump publishes the reset banner it reads while a stop is in flight, as
`serial_send` does, so a STOP during a buffered job still confirms.

The only refusal is `refused: not-admitted: …` (nothing written), carried in the existing
`Err(String)` / outcome contracts. `connection.send()` returns a refusal as `[<string>]`,
never `error:disconnected`. `jobStream` checks it first:

| Backend answer | `endState` | `jobRunning` after | TS sends anything? |
|---|---|---|---|
| `not-admitted` (or any other `refused:` string) | `cancelled` | false | No |

A refusal is never `complete` and never triggers a stop from TS. The buffered path defaults to
`unknown` (RF-8). `disconnect()` clears `jobRunning` at its tail, so no job-running flag
outlives the connection.

Residuals: the one line admitted just before STOP can execute before the reset arrives (beam
state unqualified); `None`-epoch writes (console, Test Fire, settings) are not phase-gated and
can land after STOP (Parking Lot: phase policy for manual writes); a future job-write site
added without `admit_and_write` would reopen the race.

**Idle-stall disconnect.** Both pumps count consecutive `<Idle…>` reports with no terminal in
between. At `DEFAULT_IDLE_STALL_TICKS` (3) they conclude the ack was lost and return a
disconnected result ("terminal lost"); `run_buffered_pump` applies it only while lines are in
flight. Separately, 60 zero-byte probe ticks (`DEFAULT_LIVENESS_TICKS`) is a dead port. In
perLine mode the failure reaches `connection.send()` as a rejection, which returns
`["error:disconnected"]`; `streamJob` marks the port disconnected, calls `emergencyStop()`
if `jobRunning` is still true, ends the session and calls `disconnect()`. The buffered path
does the same on a `disconnected:` outcome.

**Keep-awake.** `keepAwake.ts` acquires the OS sleep inhibitor on `jobRunning` false→true and
releases it on true→false.

## Conventions

- GRBL only (no other firmware)
- Coordinates in mm, origin bottom-left in G-code (Y-flipped from screen)
- 6 default layers: Cut, Engrave, Score + 3 custom
- Layer order = G-code output order (drag to reorder)
- Dark mode only, Apple-esque design (CSS custom properties)
- TypeScript strict mode, zero ts-ignore
