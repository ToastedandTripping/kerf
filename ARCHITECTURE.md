# Kerf Architecture

## Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | React 18 + Pixi.js 8 | UI panels + WebGL canvas |
| State | Zustand | Single store with action factory slices |
| Styling | CSS custom properties + inline styles | Dark mode, design tokens |
| Backend | Rust (Tauri v2) | Serial/GRBL, G-code gen, image tracing, dithering |
| Build | Vite | Frontend bundling |
| CI | GitHub Actions | macOS + Linux builds, tests |
| Desktop | Tauri v2 | Native window, file dialogs, serial port access |

## Directory Structure

```
src/
  app/
    App.tsx                  — Root component, dialog wiring, auto-save, onboarding
    types.ts                 — DesignObject, Layer, SubLayer, MaterialPreset, KerfProject
    store/
      index.ts               — Zustand store creation, CRUD, selection, layers, undo,
                               z-order, zoom, machine, project, UI (~460 lines)
      geometryActions.ts     — Align, flip, group, boolean, array, convert, offset
                               (~740 lines, uses polygon-clipping + opentype)
      storeTypes.ts          — AppState interface, Command, generateId, type aliases
      __tests__/             — Store and geometry action tests

  components/
    bottom/
      Console.tsx            — GRBL serial console (send/receive)
      JobPreview.tsx         — Animated G-code preview (Canvas 2D, rAF playback)
      StatusBar.tsx          — Connection state, object count, cursor position
    panels/
      LayerPanel.tsx         — Cut layers with drag reorder, inline settings, sub-layers
      PropertiesPanel.tsx    — Object transform, opacity, power scale, image adjustments
      MachinePanel.tsx       — Serial connect, jog, frame, generate, start/pause/stop
      MaterialLibrary.tsx    — Browse/search/apply/save/export/import presets
      [8 dialog components]  — Settings, GRBL, QR, trace, material test, SVG import, etc.
    toolbar/
      Toolbar.tsx            — Drawing tool selection (select, rect, ellipse, line, pen, text, node)
    topbar/
      MenuBar.tsx            — File/Edit/View/Arrange/Tools/Help menus, recent files
      CommandPalette.tsx     — Ctrl+K fuzzy command search
    viewport/
      Viewport.tsx           — Pixi.js 8 WebGL canvas, persistent display cache, selection handles
      Rulers.tsx             — mm rulers along canvas edges

  lib/
    fileOps/
      index.ts               — fileOperations object, Tauri dialog routing, project I/O
      svgImport.ts           — SVG parser, matrix transforms, path parser (~840 lines)
      dxfImport.ts           — DXF LINE/CIRCLE/ARC/LWPOLYLINE parser
      imageImport.ts         — Image byte→base64→canvas import
      svgExport.ts           — Design objects→SVG XML export
      __tests__/             — SVG and DXF import tests
    machine/
      connection.ts          — Serial port connect/disconnect, GRBL status polling,
                               settings query ($30/$32/$120-131), jog, e-stop
      gcodeGen.ts            — Frontend G-code orchestrator, calls Rust backend via
                               Tauri invoke, JS fallback, layer-order sorting
      knownDevices.ts        — USB VID/PID table for auto-detect priority sorting
      __tests__/             — G-code generation tests
    tools/
      toolHandler.ts         — Pointer event state machines for all tools, snap guides
    autoSave.ts              — 60s periodic save to Tauri appDataDir, crash recovery
    fileDrop.ts              — Drag-and-drop file handler (SVG/DXF/image detection)
    materials.ts             — 18 default MaterialPreset entries
    recentFiles.ts           — localStorage-backed recent file list
    shortcuts.ts             — Keyboard shortcut registration

src-tauri/src/
  commands/
    serial.rs                — Serial port open/close/send/status, mutex-guarded state
    gcode.rs                 — Tauri command: generate_gcode (calls engine)
    image_trace.rs           — Tauri command: trace_image (calls engine)
    file_io.rs               — Empty (filesystem handled by tauri-plugin-fs)
  engine/
    gcode_gen.rs             — G-code generation: line mode (vector cut with lead-in/out,
                               tabs, perforation, overcut) + fill mode (scan lines with
                               overscan, bidirectional, cross-hatch, scan angle)
    image_gcode_gen.rs       — Image→G-code: dither then scan lines
    dither.rs                — 7 dithering algorithms (threshold, ordered, Floyd-Steinberg,
                               Jarvis, Stucki, Atkinson, grayscale pass-through)
    optimizer.rs             — Nearest-neighbor path ordering, inner-first sorting
    tracer.rs                — vtracer-based image→SVG vectorization with preprocessing
                               (adaptive threshold, morphological ops, blur)
```

## Data Flow

### Core Loop: Import → Layer → Preview → Send

```
1. Import (SVG/DXF/Image)
   svgImport.ts / dxfImport.ts / imageImport.ts
   → store.addObject() → objects[]

2. Assign to Layers
   LayerPanel.tsx → store.updateLayer()
   Objects have layerIndex, layers have cut settings

3. Generate G-code
   MachinePanel "Generate" → gcodeGen.ts
   → toCutObjects() sorts by layer order
   → invoke("generate_gcode") → Rust engine
   → store.setGcodeResult()

4. Preview
   JobPreview.tsx reads gcodeResult.moves[]
   Canvas 2D animation with rAF playback

5. Send to Machine
   MachinePanel "Start" → line-by-line serial send
   → connection.ts → serial.rs → GRBL controller
```

### State Architecture

Single Zustand store with 38 state fields and 62 actions. The `geometryActions.ts`
slice is extracted as a factory function (`createGeometryActions(set, get)`) that
spreads into the main `create()` call. All cross-slice references use lazy `get()`.

Undo/redo uses a command pattern with snapshot capture. Image data (base64) is
stripped from undo snapshots and restored from live objects. Stack capped at 50.

### Rendering

Viewport uses Pixi.js 8 with a persistent display object cache (`Map<id, Container>`).
On state change, existing objects are updated in place; only additions/removals create
or destroy Pixi objects. Image textures are cached by content to avoid GPU re-uploads.

Selection overlay and drawing layer are separate Pixi containers on top of the
objects container.

### Machine Communication

Serial connection via Tauri's serialport crate. Status polling at 250ms (suspended
during active jobs). GRBL settings ($30, $32, $120-131) read on connect. Workspace
dimensions auto-set from $130/$131 (max travel).

## Conventions

- GRBL only (no other firmware)
- Coordinates in mm, origin bottom-left in G-code (Y-flipped from screen)
- 6 default layers: Cut, Engrave, Score + 3 custom
- Layer order = G-code output order (drag to reorder)
- Dark mode only, Apple-esque design (CSS custom properties)
- TypeScript strict mode, zero ts-ignore
