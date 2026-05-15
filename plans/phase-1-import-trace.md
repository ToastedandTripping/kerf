# Phase 1: Import and Trace -- Implementation Plan

The front door of Kerf. If getting designs in is painful, nothing else matters.

---

## 1a. Image Trace Workflow Improvements

### 1a.1 Drag-and-drop PNG/JPG onto canvas

Currently images can only be imported via `File > Import Image...` which opens a Tauri file dialog (`fileOperations.importImage()` in `src/lib/fileOps.ts`). Need native drag-and-drop onto the viewport.

**Files to change:**

- `src/components/viewport/Viewport.tsx`
  - Add `onDragOver` and `onDrop` handlers to the outer `<div>` wrapper (the one at line 492 with `position: relative`)
  - `onDragOver`: call `e.preventDefault()`, set `e.dataTransfer.dropEffect = "copy"`, set a visual drop indicator state (border highlight)
  - `onDrop`: extract `e.dataTransfer.files`, filter for image MIME types (`image/png`, `image/jpeg`, `image/bmp`, `image/gif`, `image/webp`), convert each `File` to `Uint8Array` via `file.arrayBuffer()`, call the shared image import function
  - Add a drop zone visual state: when dragging over, show a subtle border/overlay ("Drop image to import")
  - Calculate drop position in mm from the mouse coordinates (same `(clientX - rect.left - camera.x) / camera.zoom / PX_PER_MM` math already used in pointer handlers)

- `src/lib/fileOps.ts`
  - Extract the core logic from `importImageData(data: Uint8Array, ext: string)` -- it's already a standalone function, but it always places images at `x:10, y:10`. Add an optional `position?: {x: number, y: number}` parameter so drag-and-drop can place the image at the drop location
  - Export `importImageData` so Viewport can call it directly (currently it's a module-private function)

**New state (optional):**
- Add `isDraggingOver: boolean` to a local `useState` in Viewport (no need for Zustand -- this is ephemeral UI state)

**Dependencies:** None. Can be implemented independently.

**Implementation notes:**
- Tauri v2 supports web-standard drag-and-drop for files dropped from the OS file manager. The `dataTransfer.files` API works as expected.
- The Tauri `fs` plugin is NOT needed here -- we're reading the file via web `File.arrayBuffer()`, not the Tauri filesystem API.
- For SVG and DXF files dropped on canvas, detect by extension and route to `importSvgContent` / `importDxfContent` respectively. This is a nice freebie.

---

### 1a.2 Inline trace preview with live threshold/detail sliders

The current `ImageTraceDialog` is a modal dialog at `src/components/panels/ImageTraceDialog.tsx`. It works but it's disconnected from the canvas -- you can't see the trace preview overlaid on the actual image. The plan: replace the modal with an inline panel that shows a live SVG preview directly on the canvas, overlaying the source image.

**Files to change:**

- `src/components/panels/ImageTraceDialog.tsx` -- **Major rewrite** (rename to `ImageTracePanel.tsx`)
  - Change from fixed-position modal to a docked side panel (slides in from the right, overlaying the properties panel area)
  - Remove the 200px preview `<img>` area
  - Keep all existing controls: mode selector, threshold, smoothness, min area, invert
  - Add a "Detail Level" slider (maps to `cornerThreshold` but with user-friendly labeling: low=more corners/detail, high=smoother)
  - Preview rendering moves to a canvas overlay (see Viewport changes below)
  - Wire sliders to trigger preview re-trace via the existing debounced `invoke("trace_image_command")` with `previewScale: 0.5` (bump from 0.25 for better visual feedback -- still fast enough)
  - Store the preview SVG string in a shared location so the Viewport overlay can render it

- `src/components/viewport/Viewport.tsx`
  - Add a trace preview overlay: when the trace panel is open and has preview SVG data, parse the SVG paths and render them as a Pixi.js `Graphics` overlay on top of the image object
  - The overlay should use the active layer color at ~60% opacity so the user sees exactly what vectors will be created
  - Scale the preview paths from SVG pixel coordinates to mm coordinates using the same math as `handleCommit()` in ImageTraceDialog (lines 169-186): `imgT.x + (p.x / result.widthPx) * imgT.width`

- `src/app/store.ts`
  - Add trace preview state to the store:
    ```typescript
    tracePreview: { svg: string; widthPx: number; heightPx: number; imageId: string } | null;
    setTracePreview: (preview: AppState["tracePreview"]) => void;
    ```
  - This is intentionally in the store rather than component state so the Viewport can reactively read it

- `src/app/App.tsx`
  - Change `ImageTraceDialog` from modal overlay to side panel rendering
  - The panel should appear when `traceOpen` is true AND a single image is selected
  - Auto-close the panel when selection changes away from an image

**Dependencies:** None, but pairs well with 1a.1 (drag-drop gives you images to trace).

**Implementation notes:**
- The existing `invoke("trace_image_command")` call is already async with debounce (300ms timeout, generation counter for stale cancellation). This mechanism is solid -- keep it.
- `previewScale: 0.5` is the sweet spot. At 0.25 (current), the preview is too coarse and misses thin details. At 1.0, traces over 2000x2000px take >500ms which makes sliders feel sluggish.
- The preview overlay MUST be a separate Graphics object in the Pixi container, NOT rendered into the main objects layer. It needs to be cleared independently when the panel closes.

---

### 1a.3 One-click trace to vectors on active layer

The current "Trace to Canvas" button in `ImageTraceDialog.handleCommit()` already does this. The improvement is to make it seamless with the new inline panel workflow.

**Files to change:**

- `src/components/panels/ImageTraceDialog.tsx` (now `ImageTracePanel.tsx`)
  - The "Trace" button commits the trace at full resolution (`previewScale: 1.0`)
  - After commit, clear the `tracePreview` store state
  - After commit, auto-select the new path objects
  - Add an "Undo + Re-trace" affordance: after committing, the panel stays open showing "Traced N paths" with an undo button
  - The existing `handleCommit()` logic (lines 132-243) is correct -- it parses the SVG output from vtracer, scales paths to mm coordinates, creates `DesignObject[]` of type `"path"`, and wraps mutations in `withUndo`. Keep this logic intact.

- `src/app/store.ts`
  - No additional changes beyond 1a.2

**Dependencies:** 1a.2 (inline panel must exist first).

**Implementation notes:**
- The full-resolution trace (`previewScale: 1.0`) can take 1-3 seconds for large images. Show a progress spinner on the button, disable controls during trace.
- The `withUndo("trace", ...)` wrapping is already correct. One undo step removes all traced paths.

---

### 1a.4 Trace quality presets

Add preset buttons that set optimal slider combinations for common use cases, replacing the need for users to understand threshold/corner/speckle values.

**Files to change:**

- `src/components/panels/ImageTraceDialog.tsx` (now `ImageTracePanel.tsx`)
  - Add a preset row above the sliders with 3-4 chip buttons:
    - **Fast** -- `threshold: 128, cornerThreshold: 90, filterSpeckle: 8, mode: "standard"` -- fewer paths, faster processing, good for simple logos
    - **Detailed** -- `threshold: 128, cornerThreshold: 45, filterSpeckle: 2, mode: "standard"` -- more paths, preserves fine detail
    - **Photo** -- `threshold: 100, cornerThreshold: 60, filterSpeckle: 4, mode: "sketch"` -- Canny edge detection mode, extracts contours from photographs
    - **Custom** -- automatically selected when any slider is manually adjusted
  - Add `preset` state: `"fast" | "detailed" | "photo" | "custom"`
  - Clicking a preset button sets all slider values and triggers a preview re-trace
  - Any manual slider change sets preset to `"custom"`

- `src-tauri/src/engine/tracer.rs`
  - No changes needed. The preset values are just frontend convenience -- they map to the existing `TraceParams` fields.

**Dependencies:** 1a.2 (inline panel).

**Implementation notes:**
- The preset values above are starting points. They should be tuned by testing against real-world images (logos, line art, photos with text).
- Consider persisting the last-used preset/settings in localStorage so they survive app restart.

---

### 1a.5 Keep source image as toggleable reference layer

After tracing, the source image should remain visible (dimmed) as a reference so the user can verify trace accuracy. It should NOT be included in G-code generation.

**Files to change:**

- `src/app/types.ts`
  - Add a `reference` boolean field to `DesignObject`:
    ```typescript
    reference?: boolean; // If true, object is visual-only, excluded from G-code generation
    ```
  - This is cleaner than adding a special "reference layer" because it keeps the layer system unchanged

- `src/components/panels/ImageTraceDialog.tsx` (now `ImageTracePanel.tsx`)
  - After trace commit, set the source image object to `reference: true` and `opacity: 0.3`
  - Add a checkbox: "Keep source image as reference" (default: checked)
  - If unchecked, remove the source image after tracing (current behavior)

- `src/components/viewport/Viewport.tsx`
  - In `renderImageObject()`, when `obj.reference === true`, render with reduced opacity and a subtle dashed border to visually distinguish reference images

- `src/components/panels/PropertiesPanel.tsx`
  - Show a "Reference" toggle in the properties panel when an image is selected
  - When toggled on, the object gets `reference: true`

- `src/lib/machine/gcodeGen.ts`
  - At the top of G-code generation, filter out objects with `reference: true`. Find the point where objects are collected for processing and add: `objects.filter(o => !o.reference)`

- `src-tauri/src/commands/gcode.rs`
  - If the Rust G-code generator receives objects directly (check the command interface), add the same `reference` filter. However, based on `gcodeGen.ts` existing in the frontend, this filtering likely happens before IPC.

- `src/lib/fileOps.ts`
  - In `exportSvgContent()` (line 1331), skip objects with `reference: true` to exclude them from SVG export

**Dependencies:** 1a.3 (trace commit logic).

**Implementation notes:**
- The `reference` field is a general mechanism. It could be applied to any object type (e.g., importing a PDF page as a reference), so don't restrict it to images in the type system.
- Reference objects should still be selectable and movable, just excluded from output.
- Consider a keyboard shortcut `R` to toggle reference on selected objects.

---

## 1b. SVG Import with Layer Mapping

### 1b.1 Import SVG preserving group structure

The current SVG import (`importSvgContent` in `src/lib/fileOps.ts`, line 538) flattens all SVG groups -- `walkElement()` recurses into `<g>` elements and produces flat `DesignObject[]`. Need to optionally preserve `<g>` as Kerf `group` objects.

**Files to change:**

- `src/lib/fileOps.ts`
  - Modify `walkElement()` (line 666) to handle `<g>` elements as potential groups:
    - When `tag === "g"`, recurse into children to get a `DesignObject[]`
    - If the children array has >1 element, create a `DesignObject` of type `"group"` with `children` set to the child objects (with transforms made relative to the group bounding box)
    - If the children array has exactly 1 element, skip the group wrapper (pointless nesting)
    - Apply the group's transform to the group object, not individually to each child (this is already partially handled by the transform matrix accumulation, but the group bounding box and relative child positions need computation)
  - New function `createGroupFromChildren(children: DesignObject[], name: string, layerIndex: number): DesignObject` -- calculates bounding box, adjusts child transforms to be relative, creates the group wrapper. Mirror the logic in `store.ts groupSelected()` (line 667).
  - Respect the SVG `<g>` `id` attribute as the group name if present

- `src/app/types.ts`
  - No changes needed. The `group` type with `children?: DesignObject[]` already exists.

**Dependencies:** None, but should be implemented before 1b.2 (layer mapping builds on the structure).

**Implementation notes:**
- Some SVGs (especially from Illustrator) have deeply nested groups that are purely structural. Consider a max nesting depth of 3 or flattening single-child groups.
- The existing transform accumulation via `multiplyMatrices(parentMatrix, localMatrix)` is correct for flattened output. When preserving groups, the group's own transform should be the identity (since children are already in absolute coordinates after matrix application) OR the matrix should be decomposed into position+rotation and applied to the group transform. The simpler approach: apply matrix to children (current behavior), then wrap in a group using absolute positions, then convert to relative positions for the group.

---

### 1b.2 Auto-map SVG colors to Kerf layers

Currently, all imported SVG objects go to `store.activeLayerIndex` (the currently selected layer). Instead, extract unique stroke/fill colors from the SVG and map them to the 6 Kerf layers by color similarity.

**Files to change:**

- `src/lib/fileOps.ts`
  - New function `extractSvgColorGroups(svg: SVGSVGElement, styleMap: Map<...>): ColorGroup[]`
    - Walk the SVG tree, collecting unique stroke colors (ignoring `"none"` and white/black fills)
    - For each color, track which elements use it and count them
    - Return `Array<{ color: string; elements: Element[]; count: number }>`
  - New function `findClosestLayer(color: string, layers: Layer[]): number`
    - Parse the hex color to RGB
    - Compare against each layer's `color` field using Euclidean distance in RGB space: `sqrt((r1-r2)^2 + (g1-g2)^2 + (b1-b2)^2)`
    - Return the `layerIndex` of the closest match
    - Tie-breaker: prefer layers with fewer objects assigned (distribute evenly)
  - Modify `parseSvgElement()` (line 702): instead of always using the passed `layerIndex`, accept an optional `colorLayerMap: Map<string, number>` that maps SVG colors to Kerf layer indices
  - Modify `walkElement()` to propagate the color-to-layer map

- `src/app/types.ts`
  - No changes needed.

**Dependencies:** None, but designed to feed into 1b.3 (the import dialog).

**Implementation notes:**
- Default layer colors from `DEFAULT_LAYERS`:
  - Cut: `#4a90e2` (blue)
  - Engrave: `#e24a4a` (red)
  - Score: `#4ae28a` (green)
  - Layer 3: `#ff8000` (orange)
  - Layer 4: `#e2e24a` (yellow)
  - Layer 5: `#4ae2e2` (cyan)
- Common SVG color conventions in laser cutting: red = cut, blue = engrave, green = score. The auto-mapping should respect this by proximity -- `#ff0000` is closest to Engrave (`#e24a4a`), `#0000ff` is closest to Cut (`#4a90e2`), `#00ff00` is closest to Score (`#4ae28a`). This happens naturally with Euclidean distance.
- Handle the case where the SVG uses only black strokes (common from Illustrator/Inkscape): default all to the active layer rather than splitting.

---

### 1b.3 Import dialog showing color groups with layer assignment dropdowns

When importing an SVG with multiple colors, show a dialog that lets the user review and adjust the automatic color-to-layer mapping before committing.

**Files to change:**

- `src/components/panels/SvgImportDialog.tsx` -- **New file**
  - Modal dialog triggered during SVG import when 2+ distinct colors are detected
  - Layout:
    - Title: "SVG Import -- Layer Mapping"
    - For each unique color found in the SVG:
      - Color swatch (the SVG color)
      - Count of elements with that color
      - Arrow icon
      - Layer dropdown (shows the 6 Kerf layers with their color swatches)
      - The dropdown defaults to the auto-mapped layer from `findClosestLayer()`
    - Preview area: show a simplified rendering of the SVG with color groups highlighted
    - Buttons: "Import" (commits with current mapping), "Import All to Active Layer" (ignores mapping), "Cancel"
  - State:
    ```typescript
    interface ColorMapping {
      svgColor: string;
      elementCount: number;
      assignedLayerIndex: number;
    }
    ```
  - On "Import": call `importSvgContent()` with the user-confirmed color-to-layer map
  - On "Import All to Active Layer": call `importSvgContent()` without mapping (current behavior)

- `src/app/App.tsx`
  - Add state and dialog rendering for `SvgImportDialog`:
    ```typescript
    const [svgImportData, setSvgImportData] = useState<{
      svgText: string;
      colorGroups: ColorMapping[];
    } | null>(null);
    ```
  - Add `dialogState.openSvgImport` function

- `src/lib/fileOps.ts`
  - Modify `importSvg()` and `openProject()` SVG paths to check for multiple colors before importing
  - If 2+ colors: instead of calling `importSvgContent()` directly, call `dialogState.openSvgImport(svgText, colorGroups)` to show the dialog
  - If 1 color or monochrome: import directly to active layer (no dialog, no friction)
  - Split `importSvgContent()` to accept an optional `colorLayerMap: Map<string, number>` parameter

**Dependencies:** 1b.2 (auto-mapping logic).

**Implementation notes:**
- The dialog should feel fast. Parse the SVG and extract colors synchronously -- DOMParser is fast for typical laser-cutting SVGs (usually <1MB).
- If the SVG has >8 unique colors, show the top 8 by element count and group the rest as "Other" mapped to the active layer.
- The dialog preview can reuse the SVG directly in an `<img>` tag (simpler than re-rendering in canvas).

---

### 1b.4 Handle viewBox normalization, transform flattening, stroke-to-path

The current SVG import already handles some of this. Here's what needs hardening.

**Files to change:**

- `src/lib/fileOps.ts`

  **viewBox normalization** -- Already partially handled by `computeGlobalScale()` (line 549). Issues to fix:
  - The `parseSvgLength()` function (line 597) returns `1` for all unit types instead of actually converting. Fix:
    ```typescript
    function parseSvgLength(val: string, defaultScale: number): number {
      const num = parseFloat(val);
      if (isNaN(num)) return defaultScale;
      // This function is only used for checking if units exist.
      // Actual conversion happens in parseSvgLengthToMm()
      return defaultScale;
    }
    ```
    This function is dead code -- `parseSvgLengthToMm()` does the real work. Remove `parseSvgLength()` to avoid confusion.
  - Handle `viewBox` with non-zero `min-x`/`min-y` (the offset values in `viewBox="minX minY width height"`). Currently `computeGlobalScale()` ignores the offset. Add:
    ```typescript
    const vbOffsetX = parts[0];
    const vbOffsetY = parts[1];
    ```
    And apply this offset as a translation in the initial matrix passed to `walkElement()`.

  **Transform flattening** -- Already handled by the `parseTransform()` and matrix multiplication system. Issues to fix:
  - `skewX` and `skewY` are parsed but the resulting sheared shapes will have distorted bounding boxes. This is acceptable for now -- true flattening would require decomposing the matrix, which is complex and rarely needed for laser-cutting SVGs.
  - Nested transforms on `<g>` elements are correctly accumulated via `multiplyMatrices(parentMatrix, localMatrix)`. No change needed.

  **Stroke-to-path conversion:**
  - New function `convertStrokeToPath(obj: DesignObject): DesignObject[]`
    - For objects with thick strokes (`strokeWidth > threshold`, e.g., 2mm), convert the stroke outline into a filled path
    - Uses the `offsetPaths()` logic already in `store.ts` (line 1272): offset the path outward and inward by `strokeWidth/2`, then combine the two outlines into a closed path
    - This is important for laser cutting because a 3mm-wide "stroke" in Illustrator should become a 3mm-wide cut band, not a hairline cut
  - Add a checkbox in the SVG import dialog: "Convert thick strokes to paths" (default: off, since most laser SVGs use hairline strokes)
  - Threshold: only convert strokes thicker than 1mm (below that, they're effectively hairlines)

**Dependencies:** 1b.1 (group structure), 1b.3 (import dialog for the checkbox).

**Implementation notes:**
- The viewBox offset fix is the highest priority here. SVGs from Figma frequently have non-zero viewBox offsets, causing all elements to be mispositioned.
- Stroke-to-path is a nice-to-have for Phase 1. It can be deferred if it proves complex.

---

### 1b.5 Text elements: convert to paths on import

Currently, SVG `<text>` elements are imported as Kerf `text` objects (see `parseSvgElement()` case `"text"`, line 891). The problem: the fonts used in the SVG won't be available on the user's system, so text renders incorrectly. Convert to paths during import.

**Files to change:**

- `src/lib/fileOps.ts`
  - In `parseSvgElement()`, case `"text"` (line 891): after creating the text `DesignObject`, immediately call `convertTextToPath()` from the store
  - Problem: `convertTextToPath()` is async (loads fonts), and the SVG import pipeline is synchronous. Two approaches:
    - **Approach A (recommended):** Import text as-is (current behavior), then post-process. After `importSvgContent()` returns all objects, identify text objects and batch-convert them. This keeps the import pipeline synchronous.
    - **Approach B:** Make `importSvgContent()` async. This is a larger change that ripples through `openProject()`, `importSvg()`, etc.
  - Implement Approach A:
    - New function `postProcessImportedText(objectIds: string[]): Promise<void>`
    - After import, find all text objects in the new batch and call `store.convertTextToPath(id)` for each
    - Show a brief notification: "Converting N text elements to paths..."

- `src/app/store.ts`
  - `convertTextToPath()` (line 830) uses OpenSans as the conversion font. This is acceptable since we don't have the original font -- the user will see path outlines in a generic font. Document this limitation.
  - No code changes needed in the store.

**Dependencies:** 1b.1 (must happen after basic import works).

**Implementation notes:**
- This is an imperfect solution because the converted paths use OpenSans, not the original font. The ROADMAP explicitly says "Built-in font rendering" is NOT being built, and the preferred workflow is "trace from PNG instead." This SVG text-to-path conversion is a fallback for users who don't follow that workflow.
- Consider showing a warning in the import dialog: "Text elements will be converted to paths using a substitute font. For accurate text, export as PNG from your design tool and use Image Trace."
- If the text-to-path conversion fails (font loading error), fall back to keeping the text object with a warning badge.

---

## 1c. DXF Import Cleanup

### 1c.1 Layer mapping from DXF colors/layers to Kerf layers

The current DXF import (`parseDxfManual()` in `src/lib/fileOps.ts`, line 253) ignores DXF layer information and color codes entirely -- everything goes to `store.activeLayerIndex`.

**Files to change:**

- `src/lib/fileOps.ts`
  - Modify `parseDxfManual()` to extract DXF layer and color information:
    - **DXF layer names** are in the TABLES section under LAYER entries. Parse the TABLES section before ENTITIES to build a map: `dxfLayerName -> { colorIndex, name }`
    - **Entity-level layer assignment** is group code `8` (present on every entity). Currently ignored.
    - **Entity-level color** is group code `62`. If present, overrides the layer color.
    - New parsing additions in the entity loop:
      ```
      if (p[0] === 8) entityLayer = p[1];   // DXF layer name
      if (p[0] === 62) entityColor = parseInt(p[1]); // ACI color index
      ```
  - New function `mapDxfColorToKerfLayer(aciColor: number, layers: Layer[]): number`
    - DXF uses AutoCAD Color Index (ACI), integers 0-255. Map common values:
      - 1 = red -> Engrave layer (index 1)
      - 2 = yellow -> Layer 4 (index 4)
      - 3 = green -> Score layer (index 2)
      - 4 = cyan -> Layer 5 (index 5)
      - 5 = blue -> Cut layer (index 0)
      - 6 = magenta -> Layer 3 (index 3)
      - 7 = white/black -> active layer
    - For other ACI values, convert ACI to RGB using a standard ACI lookup table, then use the same `findClosestLayer()` Euclidean distance function from 1b.2
  - New function `mapDxfLayerNameToKerfLayer(name: string, layers: Layer[]): number`
    - Fuzzy match DXF layer names to Kerf layer names:
      - "Cut", "CUT", "Cutting" -> Cut (index 0)
      - "Engrave", "ENGRAVE", "Raster" -> Engrave (index 1)
      - "Score", "SCORE", "Mark" -> Score (index 2)
    - Fallback: if no name match, use color-based mapping
  - Apply the mapping: each entity's `layerIndex` is determined by checking entity color first, then DXF layer color, then DXF layer name, then fallback to active layer. Also set the object's `stroke` color to the corresponding Kerf layer color.
  - The `dxf-parser` npm package is already in `package.json` but NOT currently used -- `parseDxfManual()` is a hand-rolled parser. Consider whether to switch to `dxf-parser` for better entity coverage, or keep the manual parser and extend it. Recommendation: **keep the manual parser** for now since it works and we control the code path. The `dxf-parser` library handles more entity types but adds a dependency we'd need to trust for correctness.

- `src/lib/dxfColors.ts` -- **New file**
  - Export a lookup table `ACI_TO_RGB: Record<number, [number, number, number]>` mapping all 256 ACI color indices to RGB values
  - This is a well-known static table (available in the DXF specification)
  - Keep it in a separate file because it's ~256 entries and would clutter fileOps.ts

**Dependencies:** 1b.2 (reuses `findClosestLayer()` color-matching function).

**Implementation notes:**
- DXF files from different CAD tools have wildly different conventions. Fusion 360 uses layer names meaningfully; AutoCAD uses color indices. CorelDRAW uses both. Support both paths.
- The ACI color table is a one-time constant. There are many open-source versions available; it doesn't need to be generated.

---

### 1c.2 Better arc/spline fidelity

The current arc handling (`parseDxfManual()` ARC entity, line 352) samples arcs at 1-degree intervals, which is fine for display but can produce hundreds of line segments for a full circle. Splines (SPLINE entity) are not handled at all.

**Files to change:**

- `src/lib/fileOps.ts`
  - **ARC improvements:**
    - Replace the line-segment sampling with cubic Bezier approximation. An arc segment up to 90 degrees can be represented by a single cubic Bezier with the standard approximation constant `k = 4/3 * tan(angle/4)`. This reduces a 360-degree circle from ~360 line segments to 4 Bezier curves.
    - New function `arcToBezierPoints(cx, cy, r, startAngle, endAngle): PathPoint[]`
      - Split the arc into segments of at most 90 degrees
      - For each segment, compute the two control points using the Bezier circle approximation
      - Return `PathPoint[]` with `handleIn` and `handleOut` set
    - Replace the current `pts.push({ x, y })` sampling loop with the Bezier output
    - Set `closed: false` for arcs (current behavior is correct)

  - **ELLIPSE entity support (new):**
    - DXF ELLIPSE entities define an ellipse by center, major axis endpoint, ratio of minor to major axis, and start/end parameter
    - Group codes: `10/20` = center, `11/21` = major axis endpoint (relative to center), `40` = ratio, `41` = start parameter, `42` = end parameter
    - New parsing block in the entity loop, similar to ARC
    - Convert to Kerf ellipse object (if full ellipse) or path with Bezier curves (if partial)

  - **SPLINE entity support (new):**
    - DXF SPLINE entities are defined by control points, knots, and degree
    - Group codes: `10/20` = control points, `40` = knot values, `71` = degree
    - For degree-3 (cubic) splines with clamped knots: convert directly to Bezier curves by extracting control point groups of 4
    - For other spline types: sample the spline using de Boor's algorithm at ~1mm intervals and create a polyline path
    - New function `parseSplineEntity(lines, i): { points: PathPoint[], closed: boolean }`
    - This is the most complex parsing addition. Recommend implementing basic cubic spline support first, then adding general B-spline evaluation later.

  - **POLYLINE/VERTEX entity support (new):**
    - Older DXF format uses POLYLINE + VERTEX + SEQEND instead of LWPOLYLINE
    - Group codes: POLYLINE flags in `70`, VERTEX coordinates in `10/20`, bulge in `42`
    - The existing LWPOLYLINE parser (line 321) ignores bulge values (group code `42`), which encode arcs between vertices. Add bulge-to-arc conversion:
      - `bulge = tan(arcAngle/4)` -- convert back to arc parameters
      - Generate Bezier curves for bulge segments instead of straight lines

- `src-tauri/src/engine/tracer.rs`
  - No changes needed. DXF parsing is entirely in the frontend.

**Dependencies:** None. Can be implemented independently.

**Implementation notes:**
- SPLINE support is the most requested missing feature for DXF import. Fusion 360, SolidWorks, and AutoCAD all export splines heavily.
- The bulge handling in LWPOLYLINE is critical for accurate arc import from Inkscape DXF export, which uses bulge values for curves.
- Testing: use DXF files exported from Fusion 360, Inkscape, CorelDRAW, and AutoCAD to verify all entity types render correctly.

---

## Implementation Order

The sub-phases have internal dependencies. Here's the recommended sequence:

```
Week 1: Foundation
  1a.1  Drag-and-drop onto canvas          (independent, high-impact)
  1c.1  DXF layer/color mapping            (independent, hardening)
  1b.2  SVG auto-color-to-layer mapping    (shared utility: findClosestLayer)
  1c.2  DXF arc Bezier + SPLINE basics     (independent, fidelity)

Week 2: Trace Workflow
  1a.2  Inline trace panel + canvas overlay (largest change, core UX)
  1a.3  One-click trace refinement          (builds on 1a.2)
  1a.4  Trace quality presets               (builds on 1a.2)

Week 3: SVG + Polish
  1b.1  SVG group preservation              (independent)
  1b.3  SVG import dialog with dropdowns    (builds on 1b.2)
  1b.4  viewBox fix, stroke-to-path         (hardening)
  1b.5  Text-to-path on SVG import          (builds on 1b.1)
  1a.5  Reference image layer               (builds on 1a.3)
```

## File Change Summary

| File | Changes |
|------|---------|
| `src/components/viewport/Viewport.tsx` | Drag-and-drop handlers, trace preview overlay |
| `src/components/panels/ImageTraceDialog.tsx` | Rewrite as inline panel, presets, reference toggle |
| `src/components/panels/SvgImportDialog.tsx` | **New** -- color-to-layer mapping dialog |
| `src/components/panels/PropertiesPanel.tsx` | Reference object toggle |
| `src/lib/fileOps.ts` | Export `importImageData`, position param, SVG color extraction, group preservation, viewBox fix, text post-process, DXF layer/color parsing, arc Bezier, SPLINE/ELLIPSE/bulge |
| `src/lib/dxfColors.ts` | **New** -- ACI color index lookup table |
| `src/app/types.ts` | Add `reference?: boolean` to `DesignObject` |
| `src/app/store.ts` | Add `tracePreview` state |
| `src/app/App.tsx` | SVG import dialog state, trace panel rendering changes |
| `src/lib/machine/gcodeGen.ts` | Filter out `reference` objects |
| `src-tauri/src/engine/tracer.rs` | No changes |
| `src-tauri/src/commands/image_trace.rs` | No changes |
| `src-tauri/Cargo.toml` | No changes |

## Testing Checklist

- [ ] Drag PNG from file manager onto canvas -- image appears at drop position
- [ ] Drag JPG from file manager onto canvas -- same behavior
- [ ] Drag SVG from file manager onto canvas -- vectors imported (not image)
- [ ] Drag DXF from file manager onto canvas -- entities imported
- [ ] Open trace panel with image selected -- preview renders on canvas
- [ ] Adjust threshold slider -- preview updates within 500ms
- [ ] Click "Fast" preset -- sliders update, preview re-renders
- [ ] Click "Trace" -- paths created on active layer, source image becomes reference
- [ ] Undo after trace -- paths removed, image restored to normal
- [ ] Reference image not included in G-code generation
- [ ] Reference image not included in SVG export
- [ ] Import multi-color SVG -- dialog appears with color groups
- [ ] Change layer assignment in dialog -- objects import to correct layers
- [ ] Import SVG with groups -- Kerf groups match SVG structure
- [ ] Import SVG with non-zero viewBox offset -- elements positioned correctly
- [ ] Import SVG with text -- text converted to paths with warning
- [ ] Import DXF with ACI colors -- objects mapped to correct layers
- [ ] Import DXF with named layers (Cut/Engrave) -- mapped by name
- [ ] Import DXF with arcs -- smooth Bezier curves, not jagged line segments
- [ ] Import DXF with SPLINE entities -- curves imported (not silently dropped)
- [ ] Import DXF with LWPOLYLINE bulge arcs -- arcs render as curves
