# Phase 5: Advanced (Post-Launch) -- Implementation Plan

Future work. Only after Phases 1-4 are solid and Kerf is being used
for real jobs. These features are the difference between "usable
tool" and "tool I'd pay for."

Each section sketches the architecture and key decisions but doesn't
specify every file change -- this is future work and the codebase
will have evolved by the time we get here.

---

## 5a. Camera Alignment (USB Webcam + Calibration Wizard)

### Why

The number one pain point for laser users: "I can't see where my
material is." Camera overlay lets you place designs visually on the
actual workpiece, eliminating test cuts and wasted material.

LightBurn's camera feature is frequently cited as the reason people
pay $100+ for it. This is the single highest-value feature Kerf
could add.

### Architecture

```
┌──────────────────────────────────────────┐
│  Frontend (React/Pixi.js)                │
│  - Camera feed as texture under objects   │
│  - Calibration wizard UI                  │
│  - Camera settings panel                  │
└──────────────┬───────────────────────────┘
               │ Tauri IPC
┌──────────────┴───────────────────────────┐
│  Rust Backend                             │
│  - USB camera capture (nokhwa or v4l2)    │
│  - Lens distortion correction             │
│  - Perspective transform (homography)     │
│  - Frame streaming via shared memory      │
└──────────────────────────────────────────┘
```

### Key Decisions

- [ ] **Camera library:** Use `nokhwa` (Rust, cross-platform USB camera).
      Supports Linux (v4l2), macOS (AVFoundation), Windows (MediaFoundation).
      Alternatively, capture in JS via `getUserMedia` and skip the Rust
      layer -- simpler but less control over resolution/exposure.
      Decision: start with `getUserMedia` for v1 (simpler), move to Rust
      `nokhwa` if we need exposure/gain control or better performance.

- [ ] **Calibration method:** 4-point perspective transform (homography).
      User places material with 4 known markers (printed calibration card),
      clicks each marker in the camera view, system computes the 3x3
      transform matrix. Store matrix per camera+mount combo.

- [ ] **Lens correction:** Most cheap USB cameras have barrel distortion.
      Offer a lens calibration step: user holds up a checkerboard pattern,
      system detects grid intersections, computes distortion coefficients.
      This is a solved problem (OpenCV `calibrateCamera`). Since we don't
      want to ship OpenCV in Rust, either:
  - Use a lightweight Rust lens correction crate
  - Do lens calibration once in a helper script, store coefficients
  - Ship a few presets for common cameras (Logitech C920, etc.)

- [ ] **Frame streaming:** Camera captures frames at ~15fps. Don't
      push full frames over IPC -- use shared memory or a temporary file.
      In the JS-first approach (`getUserMedia`), the browser handles
      everything and we just draw the `<video>` element as a Pixi texture.

### Calibration Wizard (UI)

1. Mount camera above the bed (lid-mounted or separate stand)
2. Place calibration card on the bed (downloadable PDF, 4 circle targets)
3. "Capture" freezes the frame
4. Click each of the 4 targets in order (TL, TR, BR, BL)
5. System computes homography, shows corrected overlay
6. "Test" button: user marks a point on screen, laser fires test dot
7. If dot matches marked point within ~1mm, calibration is good
8. Save calibration profile (camera ID + matrix + lens coefficients)

### Implementation Phases

- [ ] Phase 5a.1: `getUserMedia` camera feed as canvas underlay
- [ ] Phase 5a.2: 4-point calibration wizard, homography math
- [ ] Phase 5a.3: Live overlay -- camera feed mapped under design objects
- [ ] Phase 5a.4: Lens distortion correction (optional refinement)
- [ ] Phase 5a.5: Camera settings panel (exposure, flip, rotation)

---

## 5b. Rotary Axis Support

### Why

Rotary attachments let you engrave on cylindrical objects (cups, pens,
bottles). Most laser owners buy a rotary eventually. GRBL supports
it natively by remapping the Y axis.

### Architecture

The rotary is conceptually simple: the Y axis becomes a rotation axis.
The G-code doesn't change -- what changes is:

1. Steps-per-mm on the Y axis (depends on roller diameter)
2. The "workspace" in Y becomes circumference of the object
3. Objects need to wrap correctly (preview should show unwrapped cylinder)

### Key Decisions

- [ ] **Rotary type:** Support both roller and chuck rotary.
  - Roller: Y steps = (motor steps per rev \* microstepping) / (roller circumference)
  - Chuck: Y steps = (motor steps per rev _ microstepping _ gear ratio) / (object circumference)
  - User inputs: roller/chuck diameter, object diameter, steps per rev

- [ ] **GRBL configuration:** Rotary mode temporarily overrides:
  - `$101` (Y steps/mm) -- recalculated for rotary
  - `$111` (Y max rate) -- may need reduction
  - `$131` (Y max travel) -- set to object circumference
  - On exit, restore original values

- [ ] **Preview:** Show cylindrical preview:
  - Unwrapped flat view (default, same as current canvas)
  - 3D cylindrical preview (nice-to-have, uses Three.js or basic CSS 3D)
  - Wrap guide lines at object circumference boundaries

### Store Additions

```typescript
interface RotaryConfig {
  enabled: boolean;
  type: "roller" | "chuck";
  rollerDiameter: number; // mm
  objectDiameter: number; // mm
  stepsPerRev: number; // motor steps per revolution
  gearRatio: number; // for chuck type
  testMode: boolean; // single rotation test
}
```

### Implementation Phases

- [ ] Phase 5b.1: Rotary settings panel with diameter/steps calculator
- [ ] Phase 5b.2: Automatic Y-axis recalculation and GRBL override
- [ ] Phase 5b.3: Workspace auto-resize to object circumference
- [ ] Phase 5b.4: "Test Rotation" button (single Y-axis revolution)
- [ ] Phase 5b.5: Cylindrical preview (nice-to-have)

---

## 5c. Multiple Machine Profiles

### Why

Users upgrade machines, have multiple machines, or share files with
others who have different setups. Currently Kerf stores one implicit
machine configuration.

### Architecture

```typescript
interface MachineProfile {
  id: string;
  name: string; // "K40", "xTool D1 Pro", etc.
  bedWidth: number; // mm
  bedHeight: number; // mm
  maxSpeedX: number; // mm/min
  maxSpeedY: number; // mm/min
  sValueMax: number; // S parameter max
  laserMode: boolean; // GRBL $32
  serialPort?: string; // last-used port
  firmwareType: "grbl"; // future: "grbl-hal", "marlin"
  materialPresets: MaterialPreset[]; // per-machine presets
}
```

### Key Decisions

- [ ] **Storage:** Profiles saved in Tauri `appDataDir` as
      `machines/<id>.json`. Loaded on startup, selectable from a dropdown.

- [ ] **Active profile:** One profile is active at a time. Switching
      profiles updates workspace size, speed limits, and S-value scaling.

- [ ] **Material presets per machine:** The same material needs
      different settings on different machines. Presets are scoped to
      machine profile but can be copied between profiles.

- [ ] **Auto-detection:** When connecting to a machine, read `$$`
      settings and try to match to an existing profile by S-value max,
      bed size, etc. Offer to create new profile if no match.

### Implementation Phases

- [ ] Phase 5c.1: Machine profile data model and JSON persistence
- [ ] Phase 5c.2: Profile selector in Machine panel
- [ ] Phase 5c.3: Profile editor dialog (bed size, speeds, etc.)
- [ ] Phase 5c.4: Auto-detection on connect
- [ ] Phase 5c.5: Per-machine material presets

---

## 5d. Plugin/Extension System

### Why

Kerf can't and shouldn't do everything. A plugin system lets the
community add capabilities without bloating the core: custom
importers, novel generators (gear generators, living hinges), machine
integrations, post-processors.

### Architecture

```
┌────────────────────────────────────────┐
│  Plugin Host (sandboxed)               │
│  - JS/TS plugins run in Web Worker     │
│  - WASM plugins for compute-heavy      │
│  - Declarative manifest.json           │
├────────────────────────────────────────┤
│  Plugin API Surface                    │
│  - objects: add, remove, query         │
│  - UI: register panel, menu item       │
│  - commands: register command palette  │
│  - layers: read settings               │
│  - events: selection, tool change      │
│  - NO: file system, network, serial    │
└────────────────────────────────────────┘
```

### Key Decisions

- [ ] **Runtime:** Web Workers for JS plugins (sandboxed, can't crash
      main thread). Communication via `postMessage` with a structured
      API. No direct store access -- plugins go through an API proxy.

- [ ] **API surface:** Start extremely small. First version:
  - `kerf.objects.add(obj)` -- add a design object
  - `kerf.objects.selected()` -- get current selection
  - `kerf.objects.remove(ids)` -- remove objects
  - `kerf.commands.register(id, label, callback)` -- add to palette
  - `kerf.ui.showPanel(html)` -- render custom HTML in a panel
  - That's it. Expand based on what plugin authors actually need.

- [ ] **Discovery:** Plugins are folders in `~/.kerf/plugins/<name>/`
      with a `manifest.json`:

  ```json
  {
    "name": "gear-generator",
    "version": "1.0.0",
    "entry": "index.js",
    "commands": [{ "id": "generate-gear", "label": "Generate Gear" }]
  }
  ```

- [ ] **Security:** Plugins run in Workers with no DOM access, no
      filesystem access, no network access. They can only interact with
      the design through the API proxy. This is the firewall.

- [ ] **No plugin store for v1.** Users install plugins by dropping
      folders into the plugins directory. A plugin browser/installer is
      Phase 6+.

### Example Plugin: Gear Generator

```javascript
// ~/.kerf/plugins/gear-generator/index.js
kerf.commands.register("gear", "Generate Spur Gear", async () => {
  const teeth = await kerf.ui.prompt("Number of teeth:", "24");
  const module = await kerf.ui.prompt("Module (mm):", "2");
  const points = generateGearProfile(parseInt(teeth), parseFloat(module));
  kerf.objects.add({
    type: "path",
    points,
    closed: true,
    name: `Gear ${teeth}T`,
  });
});
```

### Implementation Phases

- [ ] Phase 5d.1: Plugin loader -- scan directory, parse manifests
- [ ] Phase 5d.2: Worker sandbox with message-passing API
- [ ] Phase 5d.3: Core API (objects.add, objects.selected, commands.register)
- [ ] Phase 5d.4: UI API (panels, prompts, notifications)
- [ ] Phase 5d.5: Ship 2-3 example plugins (gear generator, living hinge, box maker)

---

## 5e. Auto-Nesting (Bin-Packing)

### Why

Material waste is real money. A good nesting algorithm can reduce
material usage by 15-30% on typical laser jobs. LightBurn charges
extra for this. Every commercial laser tool has it. The open-source
space doesn't.

### Architecture

Nesting is a 2D bin-packing problem with rotation. The objects are
irregular polygons (not just rectangles), so this is harder than
standard bin-packing.

```
Input: list of object outlines (convex hulls or exact boundaries)
Constraints: workspace rectangle, minimum spacing between objects
Output: new positions and rotations for each object
```

### Key Decisions

- [ ] **Algorithm:** NFP (No-Fit Polygon) approach.
  1. Compute the NFP for each pair of objects -- the region where one
     object cannot be placed relative to another without overlap
  2. Use bottom-left-fill heuristic: place objects one at a time,
     choosing the position that wastes the least material
  3. Try multiple rotations per object (0, 90, 180, 270 -- or
     finer increments for non-rectangular shapes)

- [ ] **Compute location:** This is CPU-intensive. Two options:
  - Rust backend via Tauri command (preferred -- can use rayon for
    parallelism, faster than JS)
  - WASM module compiled from Rust (also fast, runs in the browser)
  - Decision: Rust backend. The bin-packing computation takes 100ms-2s
    depending on complexity, and we already have the Tauri bridge.

- [ ] **Object representation:** Convert each design object to a
      polygon outline for nesting purposes:
  - Rectangles/ellipses: use bounding box (fast) or actual outline
  - Paths: use the path boundary
  - Groups: use the group's bounding box
  - Add configurable spacing/margin around each object (default 2mm)

- [ ] **Nesting modes:**
  - "Pack tight" -- minimize bounding area
  - "Sheet fill" -- fill worksheet efficiently, may leave gaps
  - "Linear" -- arrange in rows (simpler, predictable)

### Store Additions

```typescript
interface NestingConfig {
  spacing: number; // mm between objects
  rotationSteps: number; // 4 = 90-degree increments, 8 = 45-degree
  mode: "tight" | "sheet" | "linear";
}
```

### Implementation Phases

- [ ] Phase 5e.1: Object-to-polygon conversion (convex hull computation)
- [ ] Phase 5e.2: Bottom-left-fill rectangle packing (simple version)
- [ ] Phase 5e.3: NFP computation for irregular shapes
- [ ] Phase 5e.4: Rotation search and multi-start optimization
- [ ] Phase 5e.5: UI -- "Auto-Nest" button, spacing controls, preview
- [ ] Phase 5e.6: Undo support (nest is a single undo-able operation)

### Rust Implementation Notes

New module: `src-tauri/src/engine/nesting.rs`

Tauri command:

```rust
#[tauri::command]
fn auto_nest(
    objects: Vec<NestableObject>,
    workspace: (f64, f64),
    spacing: f64,
    rotation_steps: u32,
) -> Result<Vec<NestResult>, String>
```

Where `NestResult` contains the new `(x, y, rotation)` for each object.

---

## 5f. Community Material Library

### Why

Every laser user re-discovers the same settings for 3mm plywood.
A shared library eliminates this trial-and-error, especially for
beginners. It's also a community-building feature that drives
adoption.

### Architecture

```
┌──────────────────────────────────────┐
│  Local Material Library               │
│  (existing, stored in project/store)  │
├──────────────────────────────────────┤
│  Community Library (read-only cache)  │
│  - Fetched from GitHub repo/CDN       │
│  - Cached locally in appDataDir       │
│  - User can "favorite" presets        │
└──────────────────────────────────────┘
```

### Key Decisions

- [ ] **Data source:** GitHub repository with a `materials.json` file.
      No server infrastructure needed. Community contributes via PRs.
      Kerf fetches the latest version periodically (daily, or on-demand).

- [ ] **Data format:**

  ```json
  {
    "presets": [
      {
        "id": "community-3mm-plywood-cut",
        "name": "Cut",
        "material": "Plywood (Birch)",
        "thickness": "3mm",
        "machine_class": "diode_5w",
        "mode": "line",
        "power": 100,
        "speed": 5,
        "passes": 2,
        "notes": "Works with xTool D1 Pro 5W. Two passes for clean cut.",
        "author": "username",
        "votes": 47
      }
    ]
  }
  ```

- [ ] **Machine class tagging:** Settings vary wildly between a 5W
      diode and a 60W CO2. Presets are tagged with machine class:
  - `diode_5w`, `diode_10w`, `diode_20w`
  - `co2_40w`, `co2_60w`, `co2_80w`, `co2_100w`
  - User sets their machine class in profile (5c); library filters
    to show relevant presets

- [ ] **No user accounts.** Contributions go through GitHub PRs.
      Voting/ranking can be done via GitHub reactions on issues, or
      just by PR merge count. Keep it simple.

- [ ] **Offline-first.** The library works entirely offline using the
      last-cached version. Network fetch is opportunistic, never blocking.

### UI Integration

- [ ] Extend the existing MaterialLibrary panel
      (`src/components/panels/MaterialLibrary.tsx`)
- [ ] Add a "Community" tab alongside "My Presets"
- [ ] Search/filter by material name, thickness, machine class
- [ ] "Add to My Library" copies a community preset into local storage
- [ ] "Contribute" button opens the GitHub PR template with the
      user's preset pre-filled

### Implementation Phases

- [ ] Phase 5f.1: Define JSON schema and seed with 20-30 common presets
- [ ] Phase 5f.2: GitHub repo setup, fetch/cache mechanism
- [ ] Phase 5f.3: Community tab UI in MaterialLibrary panel
- [ ] Phase 5f.4: Machine class tagging and filtering
- [ ] Phase 5f.5: Contribution workflow (export preset, link to PR template)

---

## Priority & Dependencies

```
                    ┌─────────────────┐
                    │ 5c. Machine     │
                    │    Profiles     │
                    └──────┬──────────┘
                           │
              ┌────────────┼────────────┐
              v            v            v
     ┌────────────┐  ┌──────────┐  ┌──────────────┐
     │ 5a. Camera │  │ 5b.Rotary│  │ 5f. Community│
     │ Alignment  │  │  Axis    │  │  Materials   │
     └────────────┘  └──────────┘  └──────────────┘

     ┌────────────┐  ┌──────────┐
     │ 5d. Plugin │  │ 5e. Auto │
     │  System    │  │ Nesting  │
     └────────────┘  └──────────┘
     (independent)   (independent)
```

**Recommended order:**

1. **5c Machine Profiles** -- foundational, needed by 5a/5b/5f
2. **5b Rotary Axis** -- low complexity, high value for users who have rotaries
3. **5e Auto-Nesting** -- independent, high value, the Rust engine is a clean project
4. **5f Community Materials** -- independent, good community engagement
5. **5a Camera Alignment** -- highest value but most complex
6. **5d Plugin System** -- design carefully, ship last

---

## What Stays Out of Scope

Even in the "advanced" phase, these remain excluded:

- **Multi-firmware support** (Marlin, GRBL-HAL) -- GRBL only, do it well
- **Parametric/generative design** -- plugins can add generators
- **Cloud sync / collaboration** -- this is a single-user desktop tool
- **Marketplace / paid plugins** -- keep it open, community-driven
- **AI anything** -- no AI-generated designs, no AI material suggestions
- **3D / simulation** -- laser cutting is fundamentally 2D
