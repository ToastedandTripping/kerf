---
status: active
current: Phase 1 — Import & Trace
next: Phase 2 — Layer Workflow
testing: null
pinned: true
shipped:
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

## Phase 4 — UX & Polish

*Make it feel like a real app, not a prototype.*

### 4a. Canvas & Viewport
- [ ] Smooth zoom to cursor (Pixi.js viewport)
- [ ] Minimap for large workspaces
- [ ] Workspace size matches machine bed (from GRBL settings)
- [ ] Object snapping: to grid, to other objects, to workspace edges

### 4b. Selection & Manipulation
- [ ] Multi-select with bounding box
- [ ] Align tools (left/center/right/top/middle/bottom, distribute)
- [ ] Group/ungroup
- [ ] Precise position/size input fields

### 4c. Visual Design
- [ ] Dark mode by default (already matches Lee's preference)
- [ ] Clean, minimal chrome: content-first layout
- [ ] Keyboard shortcut overlay (? key)
- [ ] Onboarding: first-launch guide covering import → layer → send

### 4d. File Operations
- [ ] Recent files list
- [ ] Auto-save recovery
- [ ] Export G-code to file (for SD card workflow)

---

## Phase 5 — Advanced (Post-Launch)

*Only after Phases 1-4 are solid.*

- [ ] Camera alignment (USB webcam, calibration wizard)
- [ ] Rotary axis support
- [ ] Multiple machine profiles
- [ ] Plugin/extension system
- [ ] Auto-nesting (bin-packing for material efficiency)
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
- Research: ~/marvin/research/open-source-laser-cadcam-landscape-20260514/
