# Phase 4: UX & Polish -- Implementation Plan

Make Kerf feel like a real app, not a prototype. Every interaction
should feel intentional. The user should never have to think about the
tool -- only the work.

Prerequisite: Phases 1-3 are functional. This phase is about
refinement, not new capability.

---

## 4a. Canvas & Viewport

### 4a.1 Smooth Zoom-to-Cursor

**Status:** Partially implemented. `handleWheel` in `Viewport.tsx` already
zooms toward cursor using the correct world-coordinate math. The issue
is that it feels steppy -- discrete zoom factor `1.1/0.9` with no easing.

**Files:**
- `src/components/viewport/Viewport.tsx` (handleWheel, lines ~378-401)
- `src/app/store.ts` (camera state, setCamera)

**Implementation:**
- [ ] Replace discrete zoom with animated zoom using `requestAnimationFrame`
  - On wheel event, compute target zoom and target camera position
  - Lerp from current camera to target over ~120ms (6-8 frames at 60fps)
  - Use a ref (`zoomAnimRef`) to track the animation; new wheel events
    update the target, so rapid scrolling stays responsive
  - Cancel animation on pan start or pointer down
- [ ] Add trackpad pinch-zoom support (detect `e.ctrlKey` on wheel events,
  which is how browsers report pinch gestures)
  - Already works partially since wheel fires, but sensitivity needs
    adjustment -- pinch delta is much smaller than scroll delta
  - Multiply pinch zoom factor by ~3x compared to scroll
- [ ] Clamp zoom range to `[0.05, 50]` (already done, keep)
- [ ] Add zoom level indicator to StatusBar (`src/components/bottom/StatusBar.tsx`)
  - Display as percentage: "100%", clickable to type exact value
  - Preset zoom buttons: Fit All, 100%, Fit Selection

**Notes:**
The zoom math itself is already correct (zoom toward cursor preserves
world point under mouse). The improvement is purely about feel. Don't
change the math, add animation on top.

### 4a.2 Minimap

**Files:**
- New: `src/components/viewport/Minimap.tsx`
- `src/components/viewport/Viewport.tsx` (mount minimap as sibling)
- `src/app/store.ts` (read camera, objects, workspace size)

**Implementation:**
- [ ] Create `Minimap.tsx` component
  - Position: bottom-right of viewport area, 160x120px, `position: absolute`
  - Background: `rgba(0,0,0,0.6)` with `backdrop-filter: blur(8px)`
  - Border: `1px solid var(--border)`, rounded corners
  - Render using a plain `<canvas>` (not Pixi -- too heavyweight for a
    thumbnail). Draw directly with Canvas2D:
    1. Scale all coordinates to fit workspace into minimap rect
    2. Draw workspace outline (white rectangle)
    3. Draw each object as a filled rect in its layer color
    4. Draw viewport frustum as a translucent blue rectangle showing
       what's currently visible
- [ ] Click-to-navigate: clicking the minimap sets camera position to
  center the viewport on that world coordinate
- [ ] Drag the frustum rectangle to pan the viewport
- [ ] Toggle visibility with `M` key (add to `src/lib/shortcuts.ts`)
- [ ] Store minimap visibility in Zustand as `minimapVisible: boolean`
- [ ] Hide minimap when workspace is fully visible (frustum covers entire
  minimap -- minimap adds no value)

**Design notes:**
Keep it unobtrusive. It should feel like a HUD element, not a panel.
Opacity 0.7 idle, 1.0 on hover. Fade in/out with CSS transition.

### 4a.3 Workspace Matches Machine Bed

**Files:**
- `src/app/store.ts` (workspaceWidth, workspaceHeight, GRBL settings)
- `src/components/panels/SettingsDialog.tsx` (workspace size controls)
- `src/lib/machine/connection.ts` (GRBL `$$` settings parser)
- `src/components/panels/GrblSettingsDialog.tsx`

**Implementation:**
- [ ] When machine connects and `$$` settings are read, extract:
  - `$130` = X max travel (mm)
  - `$131` = Y max travel (mm)
  - Store as `machineBedWidth` / `machineBedHeight` in Zustand
- [ ] In SettingsDialog, add a "Match Machine Bed" button that sets
  workspace size to machine bed dimensions
  - Only visible when machine dimensions are known
  - Show current machine dimensions as hint text
- [ ] Add machine profile concept to store:
  ```typescript
  interface MachineProfile {
    name: string;
    bedWidth: number;   // mm
    bedHeight: number;  // mm
    maxSpeed: number;   // mm/min
    sValueMax: number;
  }
  ```
  - For now, single profile derived from connected machine
  - Phase 5 adds multiple profiles
- [ ] Pre-flight check: warn if any objects extend beyond workspace bounds
  - Already have pre-flight checks in the safety hardening
  - Add bounds check: compare object bounding boxes against workspace rect

### 4a.4 Object Snapping

**Status:** Grid snap exists (`snapToGrid` in store). No object-to-object
snapping.

**Files:**
- `src/lib/tools/toolHandler.ts` (move/resize handlers)
- `src/app/store.ts` (snap settings, guides)
- `src/components/viewport/Viewport.tsx` (guide rendering, lines ~515-534)
- New: `src/lib/snap.ts`

**Implementation:**
- [ ] Create `src/lib/snap.ts` with snap engine:
  ```typescript
  interface SnapResult {
    x: number;
    y: number;
    guides: Array<{ type: "h" | "v"; pos: number }>;
  }

  function computeSnap(
    movingBBox: { x: number; y: number; w: number; h: number },
    otherObjects: DesignObject[],
    workspaceSize: { w: number; h: number },
    gridSize: number,
    options: { snapGrid: boolean; snapObjects: boolean; snapWorkspace: boolean },
    threshold: number = 3, // mm
  ): SnapResult
  ```
- [ ] Snap points for each object: left, center, right, top, middle, bottom
  (6 snap points per bounding box)
- [ ] Snap targets:
  - Grid lines (existing, refactor into snap engine)
  - Other objects' edges and centers
  - Workspace edges (0, 0, workspaceWidth, workspaceHeight)
  - Workspace center lines (workspaceWidth/2, workspaceHeight/2)
- [ ] Priority: exact match > grid > object edge > workspace edge
- [ ] Visual feedback: render snap guides as thin colored lines
  - Already have `guides` array in store and rendering in Viewport
  - Change color: snap guides = `rgba(255, 50, 50, 0.5)` (red, existing)
  - Object snap guides = `rgba(50, 200, 255, 0.5)` (cyan)
  - Add distance labels on guides when snapping to show gap value
- [ ] Add snap settings to store:
  ```typescript
  snapToObjects: boolean;    // default true
  snapToWorkspace: boolean;  // default true
  snapThreshold: number;     // mm, default 3
  ```
- [ ] Toggle shortcuts: keep existing `snapToGrid` toggle on `S` key
  - Add Ctrl+Shift+; or similar for "snap to objects" toggle
  - Add these to CommandPalette commands list

---

## 4b. Selection & Manipulation

### 4b.1 Multi-Select Bounding Box with Transform Handles

**Status:** Already implemented. The selection overlay in `Viewport.tsx`
(lines ~209-303) draws per-object selection outlines, group bounding
box with corner handles, edge midpoint handles, and rotation handle.
`getSelectionBBox()` from `toolHandler.ts` computes the group bbox.

**What needs improvement:**
- [ ] Resize handles should be interactive (currently decorative)
  - In `toolHandler.ts`, detect pointer-down on handle positions
  - Handle positions are in screen space: compute from bbox + camera
  - Corner handles: scale proportionally (maintain aspect ratio unless
    Shift is held, then freeform)
  - Edge handles: scale in one axis only
  - Implement as a `handleType` state in the tool handler:
    `"none" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate"`
  - On pointer-down, check if cursor is within handle hit area (use
    generous hit target: 8px / camera.zoom radius)
  - During drag, compute new transform based on handle type and delta
- [ ] Rotation handle should work
  - Detect pointer on rotation circle (top-center, 20px above bbox)
  - During drag: compute angle from bbox center to cursor
  - Apply rotation delta to all selected objects
  - Snap to 15-degree increments when Shift is held
  - Show angle tooltip during rotation
- [ ] Cursor should change on handle hover:
  - Corner handles: `nwse-resize`, `nesw-resize`
  - Edge handles: `ns-resize`, `ew-resize`
  - Rotation handle: custom rotate cursor (or `grab`)
  - Detect in `handlePointerMove` by checking distance to handle positions

**Files:**
- `src/lib/tools/toolHandler.ts` (primary -- all handle interaction logic)
- `src/components/viewport/Viewport.tsx` (cursor changes, handle rendering)
- `src/app/store.ts` (update transforms)

### 4b.2 Align/Distribute Tools

**Status:** Already implemented in store (`alignObjects`, `distributeObjects`).
Already in CommandPalette and keyboard shortcuts (Ctrl+Shift+Arrow).

**What needs improvement:**
- [ ] Add align/distribute toolbar that appears when 2+ objects are selected
  - Position: floating above selection, or in a top context bar
  - Preferred: horizontal strip below MenuBar, only visible during
    multi-selection (context toolbar pattern)
  - File: new `src/components/toolbar/AlignToolbar.tsx`
  - Mount in `App.tsx` between MenuBar and main content area
  - Show only when `selectedIds.length >= 2`
  - Icons for each alignment: 6 align icons + 2 distribute icons
  - For distribute, require 3+ objects (already enforced in store)
- [ ] Add "Align to Workspace" option:
  - When a single object is selected, align buttons align to workspace
    edges instead of to other objects
  - New store methods: `alignToWorkspace(alignment)` -- positions
    object(s) relative to workspace rect `(0, 0, w, h)`
- [ ] Add spacing input for distribute:
  - "Distribute with gap: ___mm" input field
  - Currently distributes evenly within bounding box
  - Add `distributeWithGap(direction, gap)` to store

### 4b.3 Group/Ungroup

**Status:** Already implemented (`groupSelected`, `ungroupSelected` in store).
Ctrl+G / Ctrl+U shortcuts work. Groups render correctly with child offset.

**What needs improvement:**
- [ ] Double-click to enter group editing mode
  - Currently double-click triggers `handleViewportDoubleClick` in
    toolHandler (enters node editing for paths)
  - Add: if double-clicked object is a group, enter "group isolation"
    mode: only group children are selectable/editable
  - Visual: dim all non-group objects (reduce opacity to 0.2)
  - Escape exits group isolation mode
  - Store state: `isolatedGroupId: string | null`
- [ ] Nested groups: allow groups inside groups
  - Already works at the data level (children can include groups)
  - Verify rendering handles nested transforms correctly
- [ ] Group indicator in LayerPanel
  - Show group as collapsible tree node
  - Children indented under group

### 4b.4 Precise Position/Size Input

**Status:** PropertiesPanel (`src/components/panels/PropertiesPanel.tsx`)
exists and shows transform fields. Already has X, Y, Width, Height,
Rotation inputs.

**What needs improvement:**
- [ ] Support math expressions in input fields:
  - e.g., typing `100/2` in the width field should set it to 50
  - Parse with simple eval: support `+`, `-`, `*`, `/`, parentheses
  - Helper function: `src/lib/mathEval.ts`
  - Apply to all numeric inputs in PropertiesPanel
- [ ] Constrain proportions toggle (lock icon between W and H)
  - When locked, changing width auto-updates height to maintain ratio
  - Store aspect ratio on first lock
- [ ] Reference point selector (9-point grid: TL, T, TR, L, C, R, BL, B, BR)
  - Currently X/Y is always top-left corner of bounding box
  - Reference point changes what X/Y refers to
  - E.g., setting reference to "center" and X to 250 centers the
    object at X=250 on the workspace
  - Visual: 3x3 grid of radio dots, similar to Illustrator/Figma
- [ ] Add position inputs to the context toolbar (AlignToolbar from 4b.2)
  - Quick X, Y, W, H fields visible without opening Properties panel
  - Only for single selection (multi-select shows align tools instead)

---

## 4c. Visual Design

### 4c.1 Dark Mode & Theme System

**Status:** Already dark mode by default. Colors use CSS custom properties
(`var(--bg-app)`, `var(--text-primary)`, etc.).

**Files:**
- CSS/styling: likely in `src/index.css` or a global stylesheet
- All component files use `var(--*)` properties

**Implementation:**
- [ ] Audit all hardcoded colors in components
  - `Viewport.tsx`: `0x1a1a1a` (background), `0x222222` (workspace),
    `0x4a90e2` (selection blue) -- these are Pixi hex values, can't
    use CSS variables directly
  - Create a theme constants file: `src/lib/theme.ts`
    ```typescript
    export const THEME = {
      canvas: { bg: 0x1a1a1a, workspace: 0x222222, grid: 0xffffff },
      selection: { primary: 0x4a90e2, handle: 0xffffff },
      guides: { snap: 0xff3232, object: 0x32c8ff },
    } as const;
    ```
  - Replace hardcoded hex values in Viewport.tsx with theme constants
- [ ] Ensure all text is readable at all sizes (check contrast ratios)
- [ ] Add subtle texture/grain to canvas background to differentiate
  from panels (not flat black -- slightly warm dark gray)

### 4c.2 Minimal Chrome

**Implementation:**
- [ ] Reduce toolbar width from current `var(--toolbar-width)` to 40px
  - Tool buttons already 36x36, so 40px gives 2px breathing room
- [ ] Collapsible right panel
  - Double-click panel divider to collapse/expand
  - Keyboard shortcut: `\` (backslash) to toggle right panel
  - Remember collapsed state in localStorage
  - When collapsed, show thin strip with expand arrow
- [ ] Collapsible console
  - Already has `showConsole` state in store
  - Default: collapsed (just status bar visible)
  - Drag handle to resize console height
  - Double-click status bar to toggle console
- [ ] Clean up StatusBar
  - Left: cursor position (already shown)
  - Center: workspace dimensions, zoom level
  - Right: connection status indicator (green/red dot + port name)
  - Remove any redundant info

### 4c.3 Keyboard Shortcut Overlay

**Files:**
- New: `src/components/panels/ShortcutOverlay.tsx`
- `src/lib/shortcuts.ts` (shortcut definitions)
- `src/app/App.tsx` (mount overlay)

**Implementation:**
- [ ] Press `?` (Shift+/) to show shortcut reference overlay
  - Full-screen overlay with `backdrop-filter: blur(12px)` background
  - Organized by category: Tools, File, Edit, View, Arrange, Machine
  - Two-column layout showing key combos and descriptions
  - Press any key or click backdrop to dismiss
- [ ] Data source: derive from the same shortcut definitions used by
  `useKeyboardShortcuts()` and `CommandPalette`
  - Create a shared shortcut registry: `src/lib/shortcutRegistry.ts`
    ```typescript
    interface ShortcutDef {
      key: string;
      modifiers: ("ctrl" | "shift" | "alt")[];
      label: string;
      category: string;
    }
    ```
  - Both shortcuts.ts and CommandPalette.tsx import from this registry
  - ShortcutOverlay renders the registry
  - Single source of truth eliminates drift between actual shortcuts
    and displayed shortcuts
- [ ] Show shortcut hints on toolbar buttons (already has title tooltip)
  - Consider adding small shortcut badge below each tool icon
  - Subtle: `fontSize: 8px`, `color: var(--text-muted)`

### 4c.4 First-Launch Onboarding

**Files:**
- New: `src/components/panels/OnboardingOverlay.tsx`
- `src/app/App.tsx` (conditional mount)

**Implementation:**
- [ ] Detect first launch: check `localStorage.getItem("kerf-onboarding-done")`
- [ ] Multi-step overlay (not a modal wizard -- highlight actual UI elements):
  1. **Welcome** -- "Kerf is a laser cutter tool. Import a design to get started."
     Highlight the File menu / Import buttons
  2. **Layers** -- "Assign objects to layers. Each layer has its own cut settings."
     Highlight the Layer panel
  3. **Connect** -- "Connect your laser and send the job."
     Highlight the Machine panel
  4. **Done** -- "Press Ctrl+K for the command palette. Press ? for shortcuts."
- [ ] Each step: spotlight the relevant UI area (darken everything else),
  show tooltip with text and "Next" / "Skip" buttons
- [ ] Set `localStorage.setItem("kerf-onboarding-done", "1")` on completion
  or skip
- [ ] Re-trigger from Help menu or CommandPalette: "Show Onboarding"
- [ ] Keep it brief. Three screens max. Users who need a laser cutter
  tool already know what they're doing -- they just need to know
  where things are in this particular app.

---

## 4d. File Operations

### 4d.1 Recent Files List

**Files:**
- `src/lib/fileOps.ts` (file open/save operations)
- `src/components/topbar/MenuBar.tsx` (File menu)
- New state or localStorage for recent files list

**Implementation:**
- [ ] Track recent files in `localStorage`:
  ```typescript
  interface RecentFile {
    path: string;
    name: string;
    lastOpened: number; // timestamp
  }
  ```
  - Key: `"kerf-recent-files"`
  - Max 10 entries, FIFO
- [ ] Update recent list on:
  - `openProject()` -- after successful load
  - `saveProject()` / `saveProjectAs()` -- after successful save
- [ ] Display in MenuBar under File > Recent Files
  - Show file name + path
  - Click to open (with unsaved changes check)
  - "Clear Recent Files" at bottom
- [ ] Display on empty/new project screen:
  - When no objects exist and project is "Untitled", show a centered
    welcome area with recent files list and "Open File" / "Import" buttons
  - File: new `src/components/viewport/WelcomeScreen.tsx`
  - Render over the viewport when `objects.length === 0 && projectPath === null`
- [ ] Wire into Tauri's `recent_document` API if available for OS-level
  recent files integration (macOS Dock, Windows Jump List)

### 4d.2 Auto-Save Recovery

**Files:**
- `src/lib/fileOps.ts` (save mechanism)
- `src/app/store.ts` (isDirty flag, project serialization)
- New: `src/lib/autoSave.ts`

**Implementation:**
- [ ] Auto-save to a recovery file every 60 seconds when `isDirty === true`
  - Recovery file path: Tauri `appDataDir` + `/recovery/autosave.kerf`
  - Use Tauri's `@tauri-apps/plugin-fs` to write
  - Only write if dirty flag is set (don't write clean state)
  - Reset a timer on each save -- don't auto-save if user just saved
- [ ] On app launch, check for recovery file:
  - If exists and is newer than last saved project, show dialog:
    "Kerf found an unsaved project from [timestamp]. Recover?"
  - Yes: load recovery file, set project as dirty
  - No: delete recovery file, proceed normally
- [ ] Delete recovery file on successful manual save
- [ ] Handle crash recovery:
  - Register a `beforeunload` handler that writes recovery if dirty
  - Tauri `on_window_close_requested` hook in Rust to trigger save
  - In `src-tauri/src/main.rs`, add close handler
- [ ] Store auto-save interval as a preference (default 60s, min 10s)
  - Add to SettingsDialog

### 4d.3 Export G-code to File

**Status:** Already implemented in `fileOperations.exportGcode()` in
`src/lib/fileOps.ts` (lines 188-206). Uses Tauri save dialog with
`.gcode`, `.gc`, `.nc` extensions.

**What needs improvement:**
- [ ] Add export confirmation with summary:
  - Before save dialog, show a summary: line count, estimated time,
    cut distance, travel distance
  - Use data from `store.gcodeResult`
  - Option to copy to clipboard instead of file
- [ ] Add "Export and Send to Machine" workflow:
  - One-click: generate G-code + save to file + start job
  - Only available when machine is connected
- [ ] G-code export options:
  - Include header comments (machine settings, date, project name)
  - Already exists in gcodeGen.ts -- verify it's included
  - Option to strip comments (some controllers don't like them)
- [ ] SD card workflow:
  - Detect removable drives (Tauri `app` API or custom Rust command)
  - "Export to SD Card" button that saves directly to removable media
  - Show drive selector if multiple removable drives found

---

## Implementation Order

Priority is by user impact per effort:

1. **4a.4 Object Snapping** -- biggest daily-use improvement
2. **4b.1 Interactive Transform Handles** -- fundamental manipulation
3. **4a.1 Smooth Zoom** -- feel improvement, moderate effort
4. **4d.1 Recent Files** -- small effort, big convenience
5. **4b.2 Align Toolbar UI** -- surfaces existing capability
6. **4c.2 Minimal Chrome** -- collapsible panels, cleaner layout
7. **4d.2 Auto-Save Recovery** -- safety net
8. **4b.4 Precise Input** -- math expressions, reference point
9. **4c.3 Shortcut Overlay** -- discoverability
10. **4a.2 Minimap** -- nice-to-have for large workspaces
11. **4b.3 Group Isolation Mode** -- nice-to-have
12. **4c.4 Onboarding** -- last, once everything else is stable
13. **4a.3 Workspace=Machine Bed** -- mostly wiring, do after connection polish
14. **4d.3 G-code Export Polish** -- already works, just refinement
15. **4c.1 Theme Audit** -- ongoing, do alongside other work

---

## Testing Checklist

Each sub-item should be verified with these scenarios:

- [ ] Single object: select, move, resize, rotate, snap
- [ ] Multi-select (2-3 objects): align, distribute, group, resize
- [ ] Large project (50+ objects): performance check on snap engine,
  minimap rendering, selection overlay
- [ ] Keyboard-only workflow: can a user import, assign layers, and
  send without touching the mouse? (Ctrl+K command palette is the
  escape hatch)
- [ ] Empty project: welcome screen appears, recent files work
- [ ] Crash recovery: force-quit during edit, relaunch, verify recovery
- [ ] Machine connected: workspace auto-size, pre-flight bounds check
