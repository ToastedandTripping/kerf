---
status: active
current: v0.7 — Camera & Rotary
next: v0.8 — Profiles, Text & Community
testing: null
pinned: true
shipped:
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

## v0.7 — Camera & Rotary (Current)

- [ ] Camera alignment (USB webcam, calibration wizard, overlay)
- [ ] Print-and-cut registration (two-point alignment)
- [ ] Rotary axis support (chuck + roller, Y-axis substitution)

---

## v0.8 — Profiles, Text & Community (Next)

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
