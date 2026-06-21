---
status: active
current: Versions consolidated (2026-06-21, owner decision) — v0.8.6 / v0.8.7 / v0.8.8 plus the previously-unreleased hole-aware mask-fill were squashed back into a single v0.8.6 release to regain version headroom before the next 0.8 push. The history since the v0.8.5 tag is collapsed to one commit; the three superseded tags + GitHub releases were deleted and re-cut as one v0.8.6. No code dropped — v0.8.6 now bundles everything: (a) hole-aware bitmap-mask fill (mask-fill Phases 0-2 — fixes letter-counter over-burn + H/N stroke dropout; 86 Rust + 451 JS green); (b) machine-limit / motor-protection hardening (soft-limit $20 awareness + guided switch-aware enable/disable, WCO/work-offset awareness, FRAME + jog + Home travel guards, unverified-bed gate, mid-job ALARM auto-stop); and (c) speed unit → mm/min + S-Value Max ($30) calibration. Shipped without on-hardware verification per owner decision (sole user, off-Mac); a physical burn (O/H/N) is still recommended for the cut-affecting mask-fill geometry, and the machine-limit firmware enable flow + guards should be verified on the laser before relying on them.
next: Fill plan Phases 3-5 (even-engraving parity — line interval/overscan/bidi scan-offset surfaced + cross-hatch + per-pass angle; offset-fill compound correctness; Fix-2 winding hygiene); layer-model rethink (replace sub-layers with a LightBurn-style Fill+Line layer mode — design item, owner decision 2026-06-21; would also retire the grouped-fill sub-layer-drop limitation rather than patch it); then v0.9 — Camera & Rotary
testing: null
pinned: true
shipped:
  - date: 2026-06-21
    item: "Version consolidation (owner decision) — v0.8.6 / v0.8.7 / v0.8.8 plus the previously-unreleased hole-aware mask-fill were squashed back into a single v0.8.6 release to regain version-number headroom before the next 0.8 push. All commits since the v0.8.5 tag were collapsed into one squashed commit (master force-pushed); the v0.8.6/0.8.7/0.8.8 git tags + GitHub releases were deleted and re-cut as one fresh v0.8.6 (CI-built .dmg/.AppImage/.deb). Pre-squash master tip preserved at the local backup ref backup/pre-squash-20260621 (= old 40567c1) for recovery. Zero code change vs the old master tip — verified the squashed commit diffs only the version strings (0.8.8→0.8.6 in package.json / tauri.conf.json / Cargo.toml / Cargo.lock kerf entry; package-lock was already 0.8.6) and this ROADMAP. The detailed per-feature shipped entries below are retained as the work log; their original v0.8.7 / v0.8.8 version labels are now historical (those releases were folded into v0.8.6)."
  - date: 2026-06-20
    item: "Hole-aware bitmap-mask fill — Phases 0-2 (relay kerf-maskfill-p0-p2; released in the consolidated v0.8.6; physical verify recommended). Fixes TWO visible symptoms with ONE root cause: traced/filled letters were auto-routed to offsetFill (winding-dependent concentric rings), which (1) filled letter counters so the inside of an O / hole in an e burned ~2× through, and (2) dropped one whole thin concave stroke per glyph (H right vertical, N left) when the inward offset self-intersected and remove_self_intersections kept only the larger loop. Diagnosed from source + a deep /research pass on how LightBurn / MeerK40t / Rayforge / LaserGRBL / K40 Whisperer do it — the universal answer is compute the fill region as outer-minus-holes and apply ONE even-odd rule across all contours at once (a counter stays unburned because its two edges flip the scanline parity). Implemented as a tiny-skia even-odd bitmap MASK scanned by the EXISTING image raster engine (reuse, not a new active-edge-table): a pixel mask has no winding dependence (dropout gone), no thin-stroke ring collapse (dropout gone), and native even-odd holes (over-burn gone). Phase 0: tiny-skia 0.12 behind a fail-fast even-odd probe; extracted the image scanner's inner loop into ONE shared scan_mask_to_gcode (binary + grayscale) that BOTH the image-engrave command and mask fill now use — no duplicate scan loop. Phase 1: group-aware fill coalesces a glyph's contours into one CutObject (union bbox feeding the optimizer), including the PDF-import grouping-before-split fix. Phase 2: maskFill dispatch arm; retired the fill→offsetFill auto-route for closed shapes (rectangles keep the AABB fast path); removed the now-moot double-energy warning. Quality story worth keeping: plan critic-reviewed (0 FAIL, 5 must-fixes folded pre-implementation). Razor first returned SPEC_GAP (the scanner extraction had been deferred — required now, since reuse-not-duplicate is the whole reason this architecture beat the vector AET); the delta re-review then caught a CRITICAL the green tests missed — the extraction had introduced a grayscale bidirectional reverse-row regression (used the run's start index where the F4 fix needs the end). Circuit-breaker independent root-cause audit confirmed it was a single isolated line in an otherwise byte-faithful extraction and that the real defect was a false-green test net (two tests asserted any X≥4, satisfied by the forward row alone; the 'golden' test asserted no byte-identity). Fixed with the one-token change PLUS exact-X reverse-row characterization tests in both scanner layers (fail-first proven) and a frozen byte-identity golden snapshot. A separate tsc-only build break (a widened CutMode left buildCutLayer's sub.mode typed string) was caught by the production gate and fixed. Tests 70→86 Rust + 451 JS; tsc/build/lint all clean, full vite build green. Deferred to later PRs: Phase 3 even-engraving parity (interval/overscan/bidi-offset surfaced + cross-hatch + per-pass angle), Phase 4 offset-fill compound correctness (Clipper2-as-a-unit), Phase 5 Fix-2 winding hygiene. Research report + implementation brief: ~/marvin/research/laser-engrave-fill-firing-pattern-holes-20260620/report.md. KNOWN LIMITATION (parked by owner as a design item, not a bug to patch): grouped/traced fill shapes are coalesced into one maskFill object, so sub-layer passes on that layer (e.g. a Fill+Line cut-out) are currently dropped — deferred pending the sub-layers → Fill+Line layer-mode rethink. Does-less, never does-wrong; surfaced by the final pre-merge review."
  - date: 2026-06-20
    item: "Machine-limit / motor-protection hardening (relay kerf-machine-limits) — released as v0.8.8; shipped without on-hardware verification per owner decision (sole user, off-Mac). Closes the failure mode that breaks hardware (head crashing the frame / steppers grinding from out-of-travel moves). Audit found the START gate already blocks out-of-bounds designs (true extents over moves[]), so this pass closes the paths that bypass it. Native-first: lean on GRBL soft limits ($20) as the firmware backstop, with Kerf-side guards as the PRIMARY protection for the large switchless ($22=0) population. Seven workstreams: (A) read $20/$21/$22, track homed-this-session, derive softLimitsActive ($20 && $22 && homed — the ONLY 'protected' signal; $20=1 alone never reads safe), three-state banner + guided switch-aware enable/disable (warns the $22=1 power-on-homing-lockout consequence, requires a limit-switch affirmation, reversible); (B) parse WCO from status + surface work-offset warning + honest Set Origin/Clear-offset (warn-only — the $23 machine-space sign math was deliberately deferred as a coin-flip without 2-config hardware); (C) FRAME reuses START's extracted isWithinBounds; (D) jog travel-clamp + alarm refusal (skips clamp on unverified/WPos machines to avoid mis-clamp); (E) workspaceVerified (set only when $130/$131 actually written) blocks START/FRAME against the fictional 500×300 default, with a first-class confirm-bed-size escape hatch; (F) mid-job ALARM auto-stops the job via the send()-response/unsolicited path (the status poll is suspended during jobs); (G) Home button gated on $22. Plan critic-reviewed (CONCERN → 7 fixes folded incl. the false-safety banner, switchless handling, F-trigger correction, fail-closed gate). Razor PASS after a SPEC_GAP (the guided enable/disable flow was missing) + 2 WARNINGs (FRAME unverified-bed gate, jog WPos mis-clamp) were fixed and a focused re-review confirmed the mid-job ALARM auto-stop fires on both paths with no leak. Jen: 5 cosmetic concerns applied (incl. distinguishing the two amber warning states for safety legibility). Tests 408→448 JS (all pure-logic; $23 sign correctness is hardware-only, out of scope), tsc/build clean. No Zustand Error-185 selectors in the new MachinePanel UI."
  - date: 2026-06-20
    item: "Speed unit → mm/min canonical + S-Value Max ($30) calibration (relay kerf-speed-mmmin) — released as v0.8.7; shipped without on-hardware verification per owner decision (sole user, off-Mac). Root cause (verified on real hardware, not a bug): Kerf stored speed in mm/s, so typing LightBurn's proven 480 mm/min ran the head at 480 mm/s = 28,800 mm/min — 60× too fast and therefore 1/60th the energy per mm (energy/mm = power÷speed), which read as both 'too fast' and 'too weak'. Hard-switched the canonical unit to mm/min everywhere: removed the input ×60 at the three boundary sites (vector gcode_gen, image_gcode_gen, MaterialTest) while deliberately KEEPING the output-side /60 in the time estimator (operates on mm/min moves for accel math — a trap two independent readers tripped on); ×60'd all defaults (DEFAULT_LAYERS, ~18 material presets, sub-layer seeds, and the two hardcoded store addSubLayer/addSubLayers speed:20 defaults the plan-critic caught as a 60×-too-slow char/fire risk), relabelled all UI + G-code comments mm/s→mm/min, raised input ranges. Saved-file safety is the spine: KERF_FORMAT_VERSION 1→2 with the load-time migration restructured into PER-STEP version gates (geometry bake stays <1 so it never re-runs and re-corrupts v1 files; new guarded, can-not-throw migrateSpeedToMmMin runs <2 and ×60s layer/sub-layer/material speeds; formatVersion stamped only after it returns; one-time .bak of the original bytes on first migrating save; speed forward-incompat documented). S-Value Max surfaced: persisted to localStorage and hydrated at store-init (closes the silent default-1000 4×-overpower window before connect), firmware $30 still wins on connect (logs the diff), new editable MachinePanel field, and the GRBL dialog now syncs the store on $30/$32 writes with a laser-correct label. Tests 392→408 JS + 67→70 Rust (incl. the explicit 480 mm/min → F480 LightBurn-parity case, migration double-convert/skip guards, and a rebuilt non-tautological geometry-gate test proven by gate-widening). Plan critic-reviewed (CONCERN → 5 must-fixes folded pre-implementation). Razor PASS after fixing 3 WARNINGs it caught (image-engrave time estimate was 60× off post-switch, silently disabling the >30min job warning; two stale mm/s G-code comments; one tautological test). Jen: 3 cosmetic concerns applied."
  - date: 2026-06-18
    item: "Layer-change root-cause fix + fluid movement + top-left origin defaults (relay kerf-layer-snap-defaults): moving a traced group (or a nested letter) to another layer now actually propagates. The earlier c70b37a recursion collected child ids correctly, but the shared writers updateObjects/updateObject mapped only the TOP-LEVEL objects array, silently dropping every nested partial — so letters kept their engrave color on canvas AND the cut preview still engraved them (each leaf is rendered/gcoded by its own stroke/layerIndex). Both writers now route through one recursive applyPartialsDeep (reference-identity-preserving for unchanged subtrees; applies a partial ONLY to explicitly-mapped ids, so it never cascades a group's write onto children — drag/rotate/scale hot path provably unaffected); moveObjectsToLayer's id-collector made unbounded-depth to match. Grid snapping now defaults OFF (fluid movement; Snap toggle retained in View menu / status bar) and new projects default to origin top-left + start-corner top-left (load fallbacks deliberately left at bottomLeft/false so existing saved projects load at the origin they were designed with — only fresh sessions get the new default). Tests 383→392 JS (incl. a non-tautological initial-defaults assertion). Razor PASS (0 CRITICAL/WARNING/SPEC_GAPS; 2 NOTE, 1 fixed). Plan critic-reviewed (CONCERN → 3 must-fixes folded pre-implementation: fixed both shallow writers not just the plural, recursive collector, corrected test-sweep enumeration)."
  - date: 2026-06-14
    item: "Fortification W4 — re-audit fixes + editing correctness (relay kerf-fortify-w4-editing, W4a: originTop serialization, rotated image binary Y, locked images, MaterialTest S-value/errors, powerScale images, power_min vector; W4b: F28/F29/F30 — booleans on rotated shapes with hole preservation, flip mirrors geometry, rotation-aware align/distribute/marquee). Tests 351→369 JS. Razor PASS_WITH_WARNINGS (0 CRITICAL)."
  - date: 2026-06-14
    item: "Fortification W3b — machine robustness + work-loss prevention (relay kerf-fortify-w3b-robustness, F18/F19/F26 from the cut-path audit): serial port gated to one sender during active jobs — Console, Set Origin, and Material Test blocked while streaming (was: unguarded concurrent sends including G92 mid-job); job-complete now waits for machine Idle state, status regex handles WPos/$10=0 machines and Hold/Door substates, poll interval cleanup prevents stacking on disconnect (was: complete on last-ack with head still moving, WPos machines showed no position, poll leaked); Open-Recent checks unsaved changes, crash recovery has no arbitrary 24h expiry, corrupt project files surface errors (was: one-click work loss, overnight recovery deleted, corrupt files silent no-op). Tests 340→351 JS. Razor PASS."
  - date: 2026-06-14
    item: "Fortification W3a — G-code safety + machine interlocks (relay kerf-fortify-w3a-safety, F8/F9/F10/F11/F16 from the cut-path audit): offsetFill turns laser off between concentric rings (was: single M3 before all rings — G0 rapids fired the laser with $32=0); image G-code includes its own G21/G90/M5 preamble (was: emitted before the vector preamble, inheriting stale modal state); scan angle rotates the scan direction within the shape with full corner coverage (was: rotated the AABB — 45° on a square missed corners); locked objects now included in G-code with info message (was: silently excluded); pause sends M5 to prevent beam dwell, Frame prepends M5, e-stop reports honestly on send failure. Tests 338→340 JS, 53→56 Rust. Razor PASS_WITH_WARNINGS (0 CRITICAL, 2 WARNING: M3/M4 resume awareness, missing F16 unit tests)."
  - date: 2026-06-14
    item: "Fortification W2b — import fidelity (relay kerf-fortify-w2b-imports, F21/F22/F23/F25/tokenizer/F7-carryover from the cut-path audit): PDF imports at correct physical size regardless of render DPI (was: 156% at 150 DPI); PNG reads embedded pHYs DPI metadata (was: hardcoded 96 DPI — 300 DPI scans imported 3.1× too large); rotated SVG rect/ellipse import as path objects preserving their geometry (was: collapsed to axis-aligned AABB — 45° rect became a square); DXF Y-axis flipped to match screen coordinates, $INSUNITS scaling applied, LWPOLYLINE bulge converted to arc points, unsupported entities surfaced (was: mirrored, unscaled, chords, silent drops); SVG arc tessellation adapts to radius for smooth curves at any scale (was: fixed 11.25°/seg); SVGO concatenated arc-flag parsing fixed; Z-after-number tokenizer infinite loop fixed; containment-based inner-first replaces area heuristic for cut ordering. Tests 319→338 JS, 49→53 Rust. Razor PASS_WITH_WARNINGS (0 CRITICAL, 2 WARNING)."
  - date: 2026-06-14
    item: "Fortification W2a — G-code pipeline correctness (relay kerf-fortify-w2a-gcode, F3/F4/F5/F6/F7 from the cut-path audit): fill mode on non-rectangular shapes auto-routes to offset fill with a warning (was: scanned the AABB — an ellipse burned a solid rectangle); grayscale bidirectional reverse rows now place pixels at correct X positions (was: offset by the full run width, burning left of the image); image rotation and mirror transforms now reach the G-code (was: rotation accepted but unused, mirror never sent — back-of-acrylic workflow burned unmirrored); kerf offset direction is winding-independent with correct miter scaling at corners, and applies to rect/ellipse (was: direction inverted for CW winding, corners under-offset ~29%, primitives bypassed); cut ordering respects user-set layer sequence (was: fills always before cuts regardless of layer order). Known deferred: containment-based inner-first (area heuristic retained). Tests 308→319 JS, 43→49 Rust. Razor PASS_WITH_WARNINGS (0 CRITICAL, 2 WARNING)."
  - date: 2026-06-14
    item: "v0.7.1 — macOS 12 compatibility (deployment target 10.13, WebGL force, CSP unsafe-eval, safari15 build target, error boundary), layer-object discoverability (Properties panel layer dropdown, LayerPanel object counts + objects list, shared moveObjectsToLayer action, keyboard 1-6 stroke fix), group resize (scalePartial recurses into children), device origin top-left (negated G-code Y for machines homing top-left, preview match, bounds check). Tested on physical laser — cutting confirmed. Two Zustand useShallow selector infinite-loop fixes (React Error 185)."
  - date: 2026-06-12
    item: "Fortification W1c — cut geometry fidelity (relay kerf-fortify-w1-geometry, F2/F20/F12 from the cut-path audit): curves now cut as curves — bezier paths adaptively sampled to a 0.05mm chord tolerance at G-code time, closing segments included (was: handles stripped, every curve cut as straight chords — a 4-anchor circle cut as a diamond); compound SVG paths (donuts, text glyphs, traced shapes) import as grouped per-contour objects via an in-parser state-preserving subpath split, so cuts contain no bridge segments through the workpiece (legacy concatenated imports: re-import to repair — boundaries aren't recoverable); the silent JS G-code fallback is deleted per decision — Rust-engine failure now surfaces loudly and blocks START/FRAME instead of cutting degraded physics; svgExport flattens groups (compound imports no longer vanish on export) and serializes closing curves. Known Wave-2 handoffs: fill mode scans per-object bboxes, so split compound shapes receive 2x energy in hole regions (warned at generation) until hole-aware fill (F3); kerf direction on split hole rings is winding-dependent until F6. Tests 270→308 JS. Plan critic-looped 3 rounds; Razor PASS, fixture tripwire mutation-verified."
  - date: 2026-06-11
    item: "Fortification W1b — path positioning (relay kerf-fortify-w1-position, F1 from the cut-path audit): imported/traced artwork can now actually be moved — drag, nudge, numeric X/Y, paste, align, distribute, arrays, auto-nest, and group-move all move path/line geometry on screen AND in the cut (was: transform-only writes that neither renderer nor G-code read; a day-one defect masked for primitives, with silent model corruption on every attempt). Pure move/scale invariant helpers (transform bbox ≡ anchors-only points bbox) wired through every writer including undo closures; group child points made group-local with ONE shared compose function for Viewport+G-code; resize joins the invariant (incl. rotated paths + zero-target clamp); versioned load-time migration repairs corrupted project/recovery files through a single wrapper over all four loaders, preserving exactly what the user saw (nested legacy groups rebased by composed world origin). Tests 180→270 JS. Plan critic-looped 3 rounds (11 blocking corrections); Razor PASS + delta re-review PASS, mutation checks verified empirically."
  - date: 2026-06-11
    item: "Fortification W1a — machine-control trust spine (relay kerf-fortify-w1-machine, from the 2026-06-09 cut-path audit): GRBL streaming now survives real jobs — wait-for-terminal read pump with per-second liveness probing replaces the 1s-timeout-treated-as-ack that desynced any cut segment >1s (RX-overflow/dropped-character risk with laser firing); all serial commands async with a dedicated non-blocking realtime port handle (e-stop can never queue behind an in-flight line; resequenced hold→reset→verified-M5); persistent reader ends swallowed ALARMs, ALARM now a recognized terminal that stops jobs without an error volley; classified pre-write drain kills the stale-ack class; autoConnect reads $30/$32/$120-131 identically to manual connect (was: silent defaults — 4x overpower risk on $30=255 machines); stale-G-code gate completed (layer/sub-layer/workspace/start-corner/S-max/undo/z-order edits all stale, START+FRAME block until regenerate) and pre-flight+Frame validate true G-code extents from moves[] (rotation/overscan/lead-in included; Frame Y-flip bug fixed, empty-moves guarded). Tests 127→180 JS + 25→43 Rust. Plan critic-looped 3 rounds (18 folded corrections); Razor PASS + delta re-review PASS with empirical mutation testing."
  - date: 2026-06-06
    item: "Code-refresh Phase 3b — SVG-parser dedup via delete-only (relay kerf-refresh-p3b-components): the duplication existed only because svgImport.ts's importSvgContent parser was dead code (the dialog's parser is the live one). Deleted the dead parser + its 17-symbol exclusive call-graph (−535 lines), kept parsePathD + chain; live import path byte-identical. Zero behavior change. Scope chosen via a 3-round critic loop that caught an inverted premise (round 1), a false-confidence characterization-test input + barrel landmine (round 2), then the proportionality insight that delete-only reaches the same end-state as full extraction at zero risk (round 3). Full lib-extraction deferred."
  - date: 2026-06-06
    item: "Code-refresh Phase 3a — store/logic refactors (relay kerf-refresh-p3a-store): unified object/selection mutation through one applyObjects helper in a new leaf storeHelpers.ts (structurally prevents the selectedSet-desync class), deduped the undo image-strip machinery (pushObjectsUndo), collapsed the four boolean ops (runBoolean) and four z-order actions (withZOrder). Behavior-preserving — proven by 16 new characterization tests (z-order had zero coverage before), which Razor mutation-tested to confirm non-tautological. 127 JS tests."
  - date: 2026-06-06
    item: "Code-refresh Phase 2 — cleanups (relay kerf-refresh-p2-cleanups): removed dead code (optimize_cut_order, previewProgress, setObjects, getActiveHandle, Toolbar icon, importDxfContent dup); ARCHITECTURE.md doc-sync (offsetFill 3rd mode, pdfImport.ts, store field count); shared machine-state display constants (MachinePanel now colors check/door/home/sleep); paste IDs via generateId; typed the pdf.js ref; added eslint + prettier with a passing lint gate (0 errors, 51 warnings as a tracked backlog). Behavior-preserving."
  - date: 2026-06-06
    item: "Code-refresh Phase 1 — correctness + safety net (relay kerf-refresh-p1-correctness): D4 loadProject leaked the prior project's undo stack / G-code / path; D5 convertToPath distorted rounded-rect corners (spurious bezier handles on straight edges); D6 svgExport dropped rotation; D7 parsePathD smooth-curve reflection used a stale control point. Plus first-ever regression coverage for the two biggest untested files (gcode_gen.rs Y-flip/perforation/tabs/lead-in, toolHandler geometry helpers), connection.ts GRBL parsing/auto-disconnect/e-stop, and the undo image-strip invariant. 46 new tests (111 JS + 25 Rust)."
  - date: 2026-06-05
    item: "Bugfix (code-refresh audit, relay kerf-bugfix-d1-d3) — D2 group rotation now composed into children in G-code AND preview (was silently dropped; cut-affecting); D1 selectedSet kept in sync with selectedIds (was stale, broke hit-testing); D3 group children re-render live during transform. Known limitations: asymmetric path with its OWN rotation inside a rotated group has a bounded few-mm pivot offset (preview==cut, not a mismatch); group RESIZE not propagating to children is a separate deferred bug."
  - date: 2026-06-01
    item: v0.6 — Variable Text + Auto-Nesting — template serialization, CSV merge, skyline bin-packing; plus perf pass (drag/pan/render loop), competitive polish (preset quick-apply, connection state, frame promotion, job timer, layer shortcuts, error guidance), code-health refactor (released as v0.6.0)
  - date: 2026-05-19
    item: v0.5 — Advanced Engraving — power curve editor, newsprint dither, dither preview, offset fill, flood fill, multi-criteria cut ordering, start corner, PDF import
  - date: 2026-05-18
    item: v0.4 — Production-Ready Core — layer reorder, power scale, scan angle, auto-save, onboarding, production audit (27 tests, ARIA, Pixi cache, undo fix)
  - date: 2026-05-15
    item: Phase 1-3 — Drag-drop import, SVG layer mapping, image import dialog, trace preprocessing pipeline, connection auto-detect, job progress
  - date: 2026-05-15
    item: Phase 4 (partial) — Keyboard shortcut overlay, zoom presets, security hardening, animated cut preview (play/pause/scrub/speed), object snap guides (edge/center alignment)
  - date: 2026-05-14
    item: CI/CD — GitHub Actions build pipeline, .dmg/.deb/.AppImage releases
  - date: 2026-02-22
    item: Safety hardening — emergency stop, GRBL settings, S-value scaling, pre-flight checks
  - date: 2026-02-22
    item: Optimizer ordering, DXF ARC import, text tool placement, rotated fill engraving
  - date: 2026-02-20
    item: Initial CAD/CAM core — G-code engine, engraving pipeline, image tracing (vtracer)
---

# Kerf v2 — Roadmap

Free, open-source laser cutter app. Import your design, organize it
onto layers, connect your laser, and send. Three steps, zero friction.

## Philosophy

**Do fewer things perfectly.** Every OSS laser tool that tried to
replicate LightBurn's breadth either died (LaserWeb, 2018) or became
a cluttered mess. Kerf's advantage is focus: a clean workflow for
people who design in other tools and need to get that design onto
material with a laser.

**The core loop:**

```
Import (SVG/PNG/DXF) → Trace if raster → Assign to layers → Preview → Send
```

**Not building:** parametric CAD, AI generation, 3D modeling, CNC
milling, or anything that dilutes the core loop. The drawing tools
that exist (rectangle, ellipse, pen, text) stay for quick additions
-- they don't need to become Illustrator.

## Gap Analysis vs LightBurn (May 2026)

LightBurn ($99 Core / $199 Pro) is the commercial benchmark. Their moat
is not any single feature but 14 years of integration polish. Kerf's
moat is free, modern stack, cross-platform, focused.

**Architecture-complete (data model ready, UI needs work):**
Overcut, lead-in/out, overscan, bidirectional, cross-hatch, scanning
offset, tabs, kerf offset, perforation, sub-layers, material library,
dithering (6 algorithms + grayscale), image adjustments, node editing,
Boolean ops, array tools.

**Tier 1 gaps (workflow-blocking):**
- Animated cut preview (can't verify order before burning material)
- Object snapping (no snap to edges/centers of other objects)
- Auto-read workspace from GRBL $130/$131
- Recent files + auto-save recovery
- Layer reorder (controls cut sequence = safety-critical)

**Tier 2 gaps (productivity/quality):**
- ~~Offset Fill mode~~ (v0.5)
- Scan angle + rotation between passes
- ~~Cut planner: multi-criteria ordering, flood fill, choose corner~~ (v0.5)
- ~~Power Scale per shape~~ (v0.4)
- ~~Grayscale power curve~~ (v0.5)
- ~~PDF import~~ (v0.5, raster; vector extraction pending)
- Material library UX (export/share/merge, ship defaults)

**Tier 3 gaps (advanced/pro — post-v0.5):**
- Camera system (overlay + calibration + print-and-cut)
- Variable text / serialization (CSV merge, serial numbers)
- Rotary axis (chuck + roller, Y-axis substitution)
- Multiple machine profiles
- Text on path
- Auto-nesting (bin-packing)
- Network streaming

**Quality/polish gap:**
- Feedback density (state communication throughout UI)
- Error recovery (guided resolution from GRBL alarms, USB disconnect)
- Documentation (zero user-facing docs currently)
- Onboarding (no first-launch guide)
- Time estimation accuracy (doesn't account for acceleration curves)

## Competitive Position

Based on landscape research (May 2026):

| Tool | Status | Stack | Laser-first? |
|------|--------|-------|-------------|
| LightBurn | Commercial ($104-$209) | Native C++ | Yes |
| Rayforge | Active (201 stars) | Python/GTK4 | Yes |
| LaserGRBL | Active | C#/.NET, Windows-only | Raster only |
| MeerK40t | Maintenance mode | Python/wxPython | Yes, K40-focused |
| LaserWeb4 | Dead since 2018 | JS/Electron | Was |
| bCNC | Active (1.7k stars) | Python/Tkinter | No (CNC) |
| Candle | Active (1.6k stars) | C++/Qt | No (CNC) |
| **Kerf** | **Active** | **Rust/Tauri/React/Pixi.js** | **Yes** |

Kerf's stack (Tauri + Pixi.js) is the only modern native-performance
architecture in the OSS space. Rayforge is the nearest competitor but
GTK4 feels non-native on macOS. Everyone else is either dead,
CNC-first, platform-locked, or maintenance-mode.

**The gap nobody has filled:** a laser app that feels like a real
macOS/Windows/Linux app, not a hobby project. That's the opportunity.

---

## Phase 1 — Import & Trace

*Get designs into Kerf reliably. This is the front door.*

### 1a. Image Trace Workflow
The preferred workflow: export PNG from design tools (preserves custom
fonts perfectly), trace to vectors in Kerf.

- [ ] Drag-and-drop PNG/JPG onto canvas (not just file dialog)
- [ ] Inline trace preview: live threshold/detail sliders over the image
- [ ] One-click trace to vectors on active layer
- [ ] Trace quality presets (fast/detailed/photo)
- [ ] Keep source image as reference layer (toggleable, non-cutting)

### 1b. SVG Import with Layer Mapping
For vector workflows where tracing isn't needed.

- [ ] Import SVG preserving group structure
- [ ] Auto-map SVG colors to Kerf layers (match by color)
- [ ] Import dialog: show color preview, let user assign each color group to a layer
- [ ] Handle common SVG issues: viewBox normalization, transform flattening, stroke-to-path
- [ ] Text elements: convert to paths on import (fonts won't be available)

### 1c. DXF Import Cleanup
Already exists but needs hardening.

- [ ] Layer mapping from DXF colors/layers to Kerf layers
- [ ] Better arc/spline fidelity

---

## Phase 2 — Layer Workflow

*Assigning objects to layers should be instant and obvious.*

### 2a. Layer UX Overhaul
The layer system exists but needs to feel effortless.

- [ ] Drag objects between layers in the layer panel
- [ ] Right-click → "Move to Layer" context menu on canvas
- [ ] Color-coded selection handles match layer color
- [ ] Layer visibility/lock toggle directly on layer rows
- [ ] Layer reordering (drag to change cut order)
- [ ] "Output" toggle per layer (disable without deleting)

### 2b. Layer Settings
Already comprehensive in the data model. Needs better UX.

- [ ] Inline speed/power/passes controls on each layer row (no dialog)
- [ ] Material preset dropdown per layer: pick a preset, settings populate
- [ ] Visual indicator when settings differ from preset ("modified")

### 2c. Material Library
Exists in data model. Needs to be usable.

- [ ] Save current layer settings as new preset
- [ ] Organize by material type → thickness
- [ ] Import/export presets as JSON (share with community)
- [ ] Ship with sensible defaults for common materials (3mm ply, 3mm acrylic, cardboard)

---

## Phase 3 — Send & Control

*Connect, preview, run. Machine panel already works -- make it solid.*

### 3a. Connection Polish
Serial connection exists. Needs to be bulletproof.

- [ ] Auto-detect common laser USB serial devices
- [ ] Remember last-used port and auto-reconnect
- [ ] Connection status always visible in status bar
- [ ] Graceful recovery from USB disconnect mid-job

### 3b. Job Preview
- [ ] Estimated time display before sending
- [ ] Bounding box preview: show laser head path on workspace
- [ ] "Frame" button: trace the job boundary on the machine without firing
- [ ] Cut order visualization (animate path sequence)

### 3c. Job Execution
- [ ] Progress bar with estimated time remaining
- [ ] Pause/resume (GRBL hold/resume)
- [ ] Emergency stop always accessible (exists, verify UX)
- [ ] Job complete notification

---

## v0.4 — Production-Ready Core

*Thesis: close every Tier 1 gap so a user with GRBL can do real paid
work without hitting a wall. Cherry-pick highest-leverage Tier 2 items.*

### 4.1 Animated Cut Preview
The single most important gap. Users will not trust their material to
software that can't show what's about to happen.
- [ ] Playback animation of G-code moves (play/pause/speed control)
- [ ] Time scrubber: drag to any point in the job
- [ ] Color-code by type: cut = layer color, travel = gray dashed
- [ ] Layer visibility toggles in preview
- [ ] Estimated time display accounting for acceleration

### 4.2 Object Snapping
Precise layout without typing coordinates.
- [ ] Snap to grid (exists — verify working)
- [ ] Snap to edges/centers of other objects
- [ ] Snap to workspace bounds
- [ ] Visual snap indicators (guide lines appear on snap)
- [ ] Hold modifier key to temporarily disable snap

### 4.3 Workspace Auto-Configuration
- [ ] On connect, read GRBL $130/$131 and set workspace size
- [ ] Display machine limits as workspace boundary
- [ ] Warn if design exceeds machine bed

### 4.4 File Persistence
- [ ] Recent files list (last 10, displayed on launch/File menu)
- [ ] Auto-save to recovery location every 60s
- [ ] Crash recovery: detect recovery file on launch, offer restore

### 4.5 Layer Reorder + Cut Sequence
Safety-critical: controls what gets cut in what order.
- [ ] Drag layers to reorder (changes G-code output sequence)
- [ ] Visual cut order numbers on layer rows
- [ ] "Move to Layer" context menu on canvas objects

### 4.6 Scan Angle Control
Minimal code, huge engraving flexibility.
- [ ] `scanAngle` field per layer (0-360 degrees)
- [ ] `angleIncrement` per layer (auto-rotate between passes)
- [ ] Wire through Rust engine (rotation_rad already exists)

### 4.7 Power Scale Per Shape
Gradient depth effects without multiple layers.
- [ ] `powerScale` property on DesignObject (0-100%, default 100%)
- [ ] Editable in Properties panel when shape selected
- [ ] Multiplied against layer power at G-code generation time
- [ ] Visual indicator on canvas (opacity matches power scale)

### 4.8 Material Library Polish
Data model is complete — make it usable.
- [ ] Ship 10-15 defaults (3mm ply, 6mm ply, 3mm/6mm acrylic,
      cardboard, leather, anodized aluminum, MDF, cork, fabric)
- [ ] Export/import as .json
- [ ] Quick-apply from library to active layer
- [ ] "Save current settings" button on layer panel

### 4.9 First-Launch Onboarding
Not a manual — just enough to make the core loop obvious.
- [ ] 3-4 step walk-through: import → assign layer → connect → send
- [ ] Show only once (localStorage flag)
- [ ] "Show again" option in Help menu
- [ ] Contextual tooltips on first use of key panels

### 4.10 Polish & Quality
- [ ] Smooth zoom to cursor position
- [ ] Precise position/size input fields in Properties panel
- [ ] GRBL alarm state recovery (guided steps to unlock)
- [ ] USB disconnect mid-job: pause, alert, offer reconnect
- [ ] Status bar: always show connection state + machine position

---

## v0.5 — Advanced Engraving (Shipped 2026-05-19)

*Make photo/image engraving competitive with LightBurn output quality.*

- [x] Offset Fill mode (concentric paths following shape contour)
- [x] Flood Fill (proximity-based non-sequential scanning)
- [x] Grayscale power curve editor (non-linear per-shade mapping)
- [x] Newsprint / halftone dithering algorithm
- [x] Image engraving preview (show dither result before sending)
- [x] Cut planner: multi-criteria ordering (layer → group → priority)
- [x] Cut planner: choose corner (consistent start point)
- [x] PDF import (raster via pdf.js; vector extraction planned for v0.6)

---

## v0.6 — Production Features (Shipped 2026-06-01 as v0.6.0)

*Shipped the first two milestone items. Camera, rotary, and the
remaining items moved to v0.7 and v0.8.*

- [x] Variable text / serialization (serial numbers, CSV merge, template workflow)
- [x] Auto-nesting (skyline bin-packing for material efficiency)

Also landed in this release: a performance pass on the
drag/pan/render loop (batched updates, dirty tracking, object map,
content-hash reflow) and competitive polish (preset quick-apply,
connection state, frame promotion, job timer, layer shortcuts,
guided error recovery), plus a code-health refactor.

---

## v0.7 — Fortification (Current; v0.7.0 = Wave 1, released 2026-06-12)

*Reliability over features: the 2026-06-09 cut-path audit found 31 defects between
"design on screen" and "laser moves." Four waves, each critic-looped + Razor-gated.*

- [x] Wave 1 — trust spine: streaming protocol, e-stop isolation, autoConnect settings,
      stale-G-code gate (W1a); path positioning + corrupt-file migration (W1b); curve
      sampling, compound-path splitting, JS-fallback deletion (W1c) — **v0.7.0**
- [x] Wave 2a — G-code pipeline: fill-shape interim (F3), grayscale-bidi (F4), image
      rotation/mirror (F5), kerf direction/winding/primitives (F6), cut ordering (F7)
- [x] Wave 2b — import fidelity: SVG rotated primitives (F22), DXF Y-flip/units/bulge (F23),
      PDF/image DPI (F21), sampler flatness hardening (F25), tokenizer loop,
      containment-based inner-first (F7 carryover)
- [x] Wave 3a — G-code safety + interlocks: offsetFill per-ring M5 (F8), image preamble (F9),
      scan angle rotated boundaries (F10), locked objects included (F11), pause/frame/e-stop
      safety (F16)
- [x] Wave 3b — robustness + work-loss: single-sender gate (F18), state truth (F19),
      work-loss cluster (F26)
- [x] Wave 4 — re-audit fixes (originTop, rotated image Y, locked images, MaterialTest,
      powerScale images, power_min) + editing correctness: booleans (F28), flip (F29),
      rotation-aware bounds (F30)
- [x] Final re-audit + production pass — PASSED 2026-06-15 (0 blockers, 8 LOW residuals)

---

## v0.8 — Fortification (Released 2026-06-15)

*Reliability over features: the 2026-06-09 cut-path audit found 31 defects between
"design on screen" and "laser moves." Four waves, 9 relays, 36 total fixes.
Final production audit PASSED with 0 blockers. Tests 127→369 JS, 25→56 Rust.*

---

## v0.9 — Camera & Rotary (Next)

- [ ] Camera alignment (USB webcam, calibration wizard, overlay)
- [ ] Print-and-cut registration (two-point alignment)
- [ ] Rotary axis support (chuck + roller, Y-axis substitution)

---

## v1.0 — Profiles, Text & Community

- [ ] Multiple machine profiles (switch between setups)
- [ ] Text on path (arbitrary curve following)
- [ ] Community material library (online preset sharing)

---

## What We're NOT Building

These are deliberate exclusions, not oversights:

- **Full CAD/parametric design** — use Illustrator/Figma/Inkscape
- **AI-generated designs** — gimmick, not workflow
- **3D modeling or simulation** — laser cutting is 2D
- **CNC milling support** — different tool, different workflow
- **Multi-firmware support** — GRBL only, do it well
- **Built-in font rendering** — trace from PNG instead

## Architecture

```
┌─────────────────────────────────────┐
│  React + Pixi.js (frontend)        │
│  Zustand store, Tailwind CSS       │
│  Canvas rendering, UI panels       │
├─────────────────────────────────────┤
│  Tauri IPC bridge                   │
├─────────────────────────────────────┤
│  Rust backend                       │
│  - Serial/GRBL communication        │
│  - G-code generation + optimizer    │
│  - Image tracing (vtracer)          │
│  - Dithering engine                 │
│  - File I/O                         │
└─────────────────────────────────────┘
```

## Reference

- Repo: github.com/ToastedandTripping/kerf (public, master branch)
- Stack: Tauri v2 / React 18 / Pixi.js 8 / Rust / Zustand
- License: (to be determined — recommend MIT for maximum adoption)
- Research: landscape analysis conducted May 2026
