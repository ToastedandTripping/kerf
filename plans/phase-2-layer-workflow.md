# Phase 2 -- Layer Workflow Implementation Plan

**Goal:** Make layer assignment and settings effortless. Three sub-phases
covering UX overhaul, settings inline editing, and material library.

**Stack context:** Tauri v2, React 18, Pixi.js 8, Zustand 5, Radix UI
primitives (context-menu, dialog, dropdown-menu, slider, tooltip).

---

## Phase 2a -- Layer UX Overhaul

### 2a.1 -- "Output" toggle per layer

The cheapest, highest-value item. Disable a layer from G-code generation
without hiding it visually or deleting objects.

**Why first:** Every subsequent feature benefits from the output concept
existing. It also unblocks Phase 3 preview work (show non-output layers
dimmed in preview).

- [ ] Add `output: boolean` to the `Layer` type
- [ ] Add `output` toggle icon to each layer row
- [ ] Filter non-output layers in G-code generation
- [ ] Dim non-output layers visually on canvas (reduced opacity)

#### Files and changes

**`src/app/types.ts`**
```ts
// Add to Layer interface, after `locked: boolean`:
output: boolean; // true = include in G-code output

// Add to layerDefaults:
output: true,
```
Also add `output: true` to each entry in `DEFAULT_LAYERS`.

Add `output` to `KerfProject` layer serialization -- already handled
implicitly since `loadProject` spreads layers directly, but verify
backwards compat: when loading a project saved before this field exists,
`output` will be `undefined`. The `layerDefaults` spread in
`DEFAULT_LAYERS` handles new projects, but loaded projects bypass
defaults. Fix: in `loadProject`, merge each loaded layer with defaults:
```ts
layers: project.layers.map(l => ({ ...layerDefaults, ...l })),
```

**`src/components/panels/LayerPanel.tsx`**
Add an `IconButton` next to the visibility eye icon in `LayerRow`.
Use a "power" or "target" icon (SVG inline, same pattern as the eye
icon). When `output` is false, show the icon struck-through and apply
`opacity: 0.5` to the entire layer row.

```tsx
// In the header row, after the visibility IconButton:
<IconButton
  onClick={() => onUpdate({ output: !layer.output })}
  title={layer.output ? "Disable output" : "Enable output"}
  active={layer.output}
>
  {/* Circle/target icon, ~12x12 SVG */}
</IconButton>
```

**`src/lib/machine/gcodeGen.ts`**
In `toCutObjects`, add layer output check:
```ts
const layer = layers.find((l) => l.index === obj.layerIndex) || layers[0];
if (!layer.output) continue; // <-- add this line
```

**`src/components/viewport/Viewport.tsx`**
In the object rendering loop, check the layer's output state and apply
reduced opacity for non-output layers:
```ts
const layer = layers.find(l => l.index === obj.layerIndex);
if (layer && !layer.output) {
  // Apply 0.3 alpha multiplier to the rendered graphic
}
```
This requires subscribing to `layers` in the Viewport. Currently it does
not. Add: `const layers = useStore((s) => s.layers);` and include
`layers` in the dependency array for the object-rendering `useEffect`.

**Dependencies:** None. Start here.

---

### 2a.2 -- Layer visibility/lock toggles on layer rows

These already exist but only partially. The visibility toggle is present
but the lock toggle is buried inside the expanded settings area as a
`ToggleChip`. Move it to the header row.

- [ ] Add lock icon toggle to each layer header row
- [ ] Locked layer objects cannot be selected or moved (already enforced
      by `hitTest` checking `obj.locked`, but layer-level `locked`
      currently only sets `obj.locked` -- verify this is consistent)

#### Files and changes

**`src/components/panels/LayerPanel.tsx`**
Add a lock `IconButton` in the `LayerRow` header, between the output
toggle and the visibility toggle:
```tsx
<IconButton
  onClick={() => onUpdate({ locked: !layer.locked })}
  title={layer.locked ? "Unlock layer" : "Lock layer"}
  active={!layer.locked}
>
  {/* Lock/unlock SVG icon */}
</IconButton>
```

Remove the `Lock` `ToggleChip` from the expanded settings area (it's
now redundant).

**`src/lib/tools/toolHandler.ts`**
The `hitTest` function already skips `obj.locked` objects. However,
layer-level `locked` and object-level `locked` are independent. Verify:
when a layer is locked, should all its objects be unselectable? Currently
the layer's `locked` field is a display property but does not propagate
to `obj.locked`. Two approaches:

**Option A (recommended):** Keep them independent. Layer `locked` means
"don't render selection handles, skip in hit test" without mutating
object data. Modify `hitTest` to also check `layer.locked`:
```ts
const layer = store.layers.find(l => l.index === obj.layerIndex);
if (layer && layer.locked) continue;
```

**Option B:** Propagate layer lock to all objects when toggled. This
mutates object data and is harder to undo. Not recommended.

Go with Option A. Also apply the layer lock check in `updateMarqueeSelection`.

**Dependencies:** None. Can be done in parallel with 2a.1.

---

### 2a.3 -- Right-click "Move to Layer" context menu on canvas

- [ ] Add context menu to the Viewport with "Move to Layer" submenu
- [ ] Submenu shows all layers with their color swatches
- [ ] Clicking a layer reassigns selected objects' `layerIndex` and
      updates their `stroke` color to the target layer's color

#### Files and changes

**`src/components/viewport/Viewport.tsx`**
Wrap the viewport `<div>` with Radix `ContextMenu.Root` and
`ContextMenu.Trigger`. The app already has `@radix-ui/react-context-menu`
installed (in `package.json`).

```tsx
import * as ContextMenu from "@radix-ui/react-context-menu";

// In the return:
<ContextMenu.Root>
  <ContextMenu.Trigger asChild>
    <div ref={canvasRef} ... onContextMenu={undefined}>
      {/* existing canvas content */}
    </div>
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content className="context-menu">
      {/* Move to Layer submenu */}
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>Move to Layer</ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          {layers.map(layer => (
            <ContextMenu.Item
              key={layer.index}
              onSelect={() => moveSelectedToLayer(layer.index)}
            >
              <span style={{ display: "inline-block", width: 10, height: 10,
                borderRadius: 2, background: layer.color, marginRight: 8 }} />
              {layer.name}
            </ContextMenu.Item>
          ))}
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
      {/* Additional context items: Delete, Group, etc. */}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
```

Remove the existing `onContextMenu={(e) => e.preventDefault()}` on the
canvas div -- Radix handles this.

**`src/app/store.ts`**
Add a `moveObjectsToLayer` action:
```ts
moveObjectsToLayer: (ids: string[], layerIndex: number) => void;

// Implementation:
moveObjectsToLayer: (ids, layerIndex) => {
  const layer = get().layers.find(l => l.index === layerIndex);
  if (!layer) return;
  get().withUndo("move-to-layer", () => {
    set((state) => ({
      objects: state.objects.map(o =>
        ids.includes(o.id)
          ? { ...o, layerIndex, stroke: layer.color }
          : o
      ),
      isDirty: true,
    }));
  });
},
```

Also add to the `AppState` interface.

**CSS for context menu:** Add styles to `index.html` or a CSS file for
`.context-menu` to match the existing panel styling (dark theme, same
border radius, same font sizes). Use CSS variables already defined in
the app: `--bg-panel`, `--border`, `--text-primary`, etc.

**Contextual items:** Only show "Move to Layer" when `selectedIds.length > 0`.
Add other common items:
- Delete (with shortcut display)
- Duplicate
- Group/Ungroup
- Bring Forward / Send Backward
- separator
- Move to Layer submenu

**Dependencies:** 2a.1 (for the `layers` subscription in Viewport) but
can technically be done independently.

---

### 2a.4 -- Color-coded selection handles matching layer color

- [ ] Selection outlines use the layer color instead of hardcoded `0x4a90e2`
- [ ] Handle fill remains white for contrast; handle stroke matches layer color

#### Files and changes

**`src/components/viewport/Viewport.tsx`**
In the selection overlay `useEffect` (the one that draws selection
indicators, handles, rotation handle), look up each selected object's
layer color:

```ts
for (const id of selectedIds) {
  const obj = objects.find((o) => o.id === id);
  if (!obj) continue;
  const layer = layers.find(l => l.index === obj.layerIndex);
  const selColor = layer ? parseInt(layer.color.replace("#", ""), 16) : 0x4a90e2;
  // ...use selColor instead of hardcoded 0x4a90e2
}
```

For the group bounding box (multi-select), use the color of the first
selected object's layer, or a neutral color (keep `0x4a90e2`) if
objects span multiple layers.

Replace all instances of hardcoded `0x4a90e2` in that `useEffect` with
the dynamic color. The handle fills stay `0xffffff` (white squares).

Add `layers` to the dependency array of this `useEffect` (it already
depends on `objects` which includes `layerIndex`, but we also need to
re-render when layer colors change).

**Dependencies:** Needs `layers` subscription added in Viewport
(same as 2a.1 and 2a.3). Do these together.

---

### 2a.5 -- Drag objects between layers in the layer panel

- [ ] Show objects assigned to each layer as a nested list when layer
      is expanded
- [ ] Drag objects from one layer to another
- [ ] Drop target highlights during drag

#### Files and changes

**`src/components/panels/LayerPanel.tsx`**
Major rework of the `LayerRow` component. When expanded, show two
sections:

1. **Objects list** -- objects where `layerIndex === layer.index`
2. **Settings** -- the existing cut settings (moved into a sub-accordion)

For the objects list, render a compact row per object:
```tsx
const layerObjects = objects.filter(o => o.layerIndex === layer.index);

{layerObjects.map(obj => (
  <div
    key={obj.id}
    draggable
    onDragStart={(e) => {
      e.dataTransfer.setData("kerf/object-id", obj.id);
      e.dataTransfer.effectAllowed = "move";
    }}
    onClick={() => setSelectedIds([obj.id])}
    style={{
      padding: "2px 8px 2px 28px",
      fontSize: "10px",
      color: selectedIds.includes(obj.id) ? "var(--text-primary)" : "var(--text-muted)",
      background: selectedIds.includes(obj.id) ? "var(--bg-active)" : "transparent",
      cursor: "grab",
    }}
  >
    {obj.name}
  </div>
))}
```

Add `onDragOver` and `onDrop` handlers to each `LayerRow`:
```tsx
onDragOver={(e) => {
  e.preventDefault();
  e.currentTarget.style.outline = `2px solid ${layer.color}`;
}}
onDragLeave={(e) => {
  e.currentTarget.style.outline = "none";
}}
onDrop={(e) => {
  e.currentTarget.style.outline = "none";
  const objId = e.dataTransfer.getData("kerf/object-id");
  if (objId) {
    moveObjectsToLayer([objId], layer.index);
  }
}}
```

Multi-select drag: if the dragged object is part of the current
selection, move all selected objects. Check `selectedIds.includes(objId)`
in the drop handler and pass `selectedIds` if true.

**Store subscriptions needed:** `objects`, `selectedIds`, `setSelectedIds`
-- add these to the `LayerPanel` component (currently only subscribes
to `layers`, `activeLayerIndex`, `setActiveLayerIndex`, `updateLayer`).

**`src/app/store.ts`**
Uses `moveObjectsToLayer` from 2a.3. No additional store changes.

**Dependencies:** 2a.3 (for `moveObjectsToLayer` action).

---

### 2a.6 -- Layer reordering via drag

- [ ] Drag layer rows to reorder them
- [ ] Layer order determines cut order (first layer cuts first)
- [ ] Update `layer.index` values after reorder to maintain consistency

#### Files and changes

**`src/app/store.ts`**
Add `reorderLayers` action:
```ts
reorderLayers: (fromIndex: number, toIndex: number) => void;

// Implementation:
reorderLayers: (fromIndex, toIndex) => {
  set((state) => {
    const layers = [...state.layers];
    const [moved] = layers.splice(fromIndex, 1);
    layers.splice(toIndex, 0, moved);
    // Reassign index values to match array position
    const reindexed = layers.map((l, i) => ({ ...l, index: i }));
    // Update all objects that referenced the old indices
    const indexMap = new Map<number, number>();
    state.layers.forEach((l, i) => {
      const newPos = reindexed.findIndex(r => r === layers[i] || (r.name === l.name && r.color === l.color));
      // simpler: build map from old index to new index
    });
    // Better approach: track by identity
    const oldToNew = new Map<number, number>();
    layers.forEach((l, newI) => oldToNew.set(l.index, newI));
    const finalLayers = layers.map((l, i) => ({ ...l, index: i }));
    const updatedObjects = state.objects.map(o => ({
      ...o,
      layerIndex: oldToNew.get(o.layerIndex) ?? o.layerIndex,
    }));
    return { layers: finalLayers, objects: updatedObjects, isDirty: true };
  });
},
```

Note: This is tricky because `layer.index` is used as both an identity
and a position. The cleanest approach: layers are always ordered by
array position, and `layer.index` always equals the array index. After
reorder, rebuild indices and remap all objects.

Add to `AppState` interface.

**`src/components/panels/LayerPanel.tsx`**
Add drag handles to each `LayerRow`. Use HTML5 drag-and-drop on the
layer header row (similar to the object drag, but with a different
data type):

```tsx
// On the LayerRow wrapper div:
draggable
onDragStart={(e) => {
  e.dataTransfer.setData("kerf/layer-index", String(layer.index));
  e.dataTransfer.effectAllowed = "move";
}}
onDragOver={(e) => {
  const data = e.dataTransfer.types.includes("kerf/layer-index");
  if (data) {
    e.preventDefault();
    // Show insertion indicator (top or bottom border)
  }
}}
onDrop={(e) => {
  const fromIdx = parseInt(e.dataTransfer.getData("kerf/layer-index"));
  if (!isNaN(fromIdx) && fromIdx !== layer.index) {
    reorderLayers(fromIdx, layer.index);
  }
}}
```

Add a drag handle icon (6-dot grip) at the left edge of each layer row,
before the expand toggle.

**G-code impact:** `gcodeGen.ts` iterates objects grouped by layer. The
current implementation in `generateGcode` sorts by layer index. After
reordering, the indices reflect the new order, so G-code generation
order changes automatically. Verify this is the case.

**Dependencies:** None, but should be done after 2a.5 to avoid drag
event conflicts (both object drag and layer drag in the same panel).

---

## Phase 2b -- Layer Settings UX

### 2b.1 -- Inline speed/power/passes controls on collapsed layer rows

- [ ] Show compact power/speed/passes controls directly on each layer
      row without expanding
- [ ] Use Radix Slider for power and speed (more touch-friendly than
      bare `<input type="range">`)
- [ ] Clicking the mode badge toggles between line/fill

#### Files and changes

**`src/components/panels/LayerPanel.tsx`**
Redesign the `LayerRow` header to include inline editing. The current
header shows: expand toggle, color swatch, name, mode badge, compact
readout (`85% 200mm/s`), visibility icon. Replace the compact readout
with interactive micro-controls.

New header layout:
```
[grip] [expand] [swatch] [name]  [mode] [pwr] [spd] [passes] [out] [lock] [eye]
```

Where `[pwr]`, `[spd]`, `[passes]` are tiny inline number inputs
(same `inputStyle` already used, but narrower -- 32px width):

```tsx
<input
  type="number" min={0} max={100}
  value={layer.power}
  onChange={(e) => onUpdate({ power: clamp(Number(e.target.value), 0, 100) })}
  onClick={(e) => e.stopPropagation()} // prevent layer selection
  style={{ ...inputStyle, width: "32px", textAlign: "right" }}
  title="Power %"
/>
<input
  type="number" min={1} max={10000}
  value={layer.speed}
  onChange={(e) => onUpdate({ speed: Math.max(1, Number(e.target.value)) })}
  onClick={(e) => e.stopPropagation()}
  style={{ ...inputStyle, width: "40px", textAlign: "right" }}
  title="Speed mm/s"
/>
<input
  type="number" min={1} max={100}
  value={layer.passes}
  onChange={(e) => onUpdate({ passes: Math.max(1, Number(e.target.value)) })}
  onClick={(e) => e.stopPropagation()}
  style={{ ...inputStyle, width: "24px", textAlign: "right" }}
  title="Passes"
/>
```

The mode badge becomes clickable to toggle:
```tsx
<button
  onClick={(e) => {
    e.stopPropagation();
    onUpdate({ mode: layer.mode === "line" ? "fill" : "line" });
  }}
  style={/* existing badge style */}
  title="Toggle line/fill mode"
>
  {layer.mode}
</button>
```

The expanded section still shows the full settings (min power, power
mode, dither, advanced, sub-layers). The inline controls are the quick
80% case; expand for the remaining 20%.

**Panel width concern:** The right panel width is `var(--panel-width)`.
Check what this is set to. If it's too narrow for all these inline
controls, consider a two-row layout for the header:
```
Row 1: [grip] [swatch] [name]                [out] [lock] [eye]
Row 2:        [mode] [pwr %] [spd mm/s] [x passes]
```
This keeps the header compact vertically (two rows at 20px each = 40px
total, vs current single row at ~24px).

**Dependencies:** None. Can be done independently.

---

### 2b.2 -- Material preset dropdown per layer

- [ ] Add a material preset dropdown to each layer's expanded settings
- [ ] Selecting a preset applies its settings to the layer
- [ ] Track which preset (if any) a layer was set from

#### Files and changes

**`src/app/types.ts`**
Add to `Layer` interface:
```ts
materialPresetId?: string; // ID of applied preset, null if custom
```

**`src/app/store.ts`**
Modify `updateLayer` to clear `materialPresetId` when any setting that
the preset controls is manually changed:
```ts
updateLayer: (index, partial) =>
  set((state) => ({
    layers: state.layers.map((l) => {
      if (l.index !== index) return l;
      // If changing a preset-controlled field, clear the preset link
      const presetFields = ["mode", "power", "powerMin", "speed", "passes", "airAssist", "interval"];
      const clearPreset = presetFields.some(f => f in partial);
      return {
        ...l,
        ...partial,
        ...(clearPreset && !("materialPresetId" in partial) ? { materialPresetId: undefined } : {}),
      };
    }),
  })),
```

Add `applyPresetToLayer` action:
```ts
applyPresetToLayer: (layerIndex: number, presetId: string) => void;

// Implementation:
applyPresetToLayer: (layerIndex, presetId) => {
  const preset = get().materials.find(m => m.id === presetId);
  if (!preset) return;
  get().updateLayer(layerIndex, {
    mode: preset.mode,
    power: preset.power,
    powerMin: preset.powerMin,
    speed: preset.speed,
    passes: preset.passes,
    airAssist: preset.airAssist,
    interval: preset.interval,
    materialPresetId: presetId,
  });
},
```

**`src/components/panels/LayerPanel.tsx`**
Add a dropdown at the top of the expanded settings section:
```tsx
const materials = useStore(s => s.materials);
const applyPresetToLayer = useStore(s => s.applyPresetToLayer);

// In expanded section, before Mode:
<SettingRow label="Material">
  <select
    value={layer.materialPresetId || ""}
    onChange={(e) => {
      if (e.target.value) applyPresetToLayer(layer.index, e.target.value);
    }}
    style={selectStyle}
  >
    <option value="">Custom</option>
    {materials.map(m => (
      <option key={m.id} value={m.id}>{m.name}</option>
    ))}
  </select>
</SettingRow>
```

Group the options by material type using `<optgroup>`:
```tsx
{Object.entries(groupedMaterials).map(([material, presets]) => (
  <optgroup key={material} label={material}>
    {presets.map(m => (
      <option key={m.id} value={m.id}>
        {m.thickness} {m.mode === "fill" ? "Engrave" : "Cut"}
      </option>
    ))}
  </optgroup>
))}
```

**Dependencies:** None, but logically follows 2b.1.

---

### 2b.3 -- Visual indicator when settings differ from preset

- [ ] Show "modified" badge when layer settings don't match applied preset
- [ ] Click badge to reset to preset values

#### Files and changes

**`src/components/panels/LayerPanel.tsx`**
Add a comparison function:
```ts
function isPresetModified(layer: Layer, materials: MaterialPreset[]): boolean {
  if (!layer.materialPresetId) return false;
  const preset = materials.find(m => m.id === layer.materialPresetId);
  if (!preset) return false;
  return (
    layer.mode !== preset.mode ||
    layer.power !== preset.power ||
    layer.powerMin !== preset.powerMin ||
    layer.speed !== preset.speed ||
    layer.passes !== preset.passes ||
    layer.airAssist !== preset.airAssist ||
    layer.interval !== preset.interval
  );
}
```

Show a "Modified" chip next to the material dropdown when modified:
```tsx
{isPresetModified(layer, materials) && (
  <button
    onClick={() => applyPresetToLayer(layer.index, layer.materialPresetId!)}
    title="Reset to preset values"
    style={{
      fontSize: "9px", padding: "1px 4px", borderRadius: "3px",
      background: "rgba(255, 165, 0, 0.2)", color: "#ffaa55",
      border: "none", cursor: "pointer", fontWeight: 600,
    }}
  >
    MODIFIED
  </button>
)}
```

**Dependencies:** 2b.2 (needs `materialPresetId`).

---

## Phase 2c -- Material Library UX

### 2c.1 -- Save current layer settings as new preset (improved UX)

- [ ] Replace `prompt()` dialogs with a proper modal form
- [ ] Auto-populate material and thickness from the preset dropdown
      if one is selected
- [ ] Validate that name is unique

#### Files and changes

**`src/components/panels/MaterialLibrary.tsx`**
Replace the `saveCurrentAsPreset` function that uses `prompt()` with a
state-driven inline form. When the user clicks "+ Save", expand an
inline form below the search bar:

```tsx
const [isAdding, setIsAdding] = useState(false);
const [newPreset, setNewPreset] = useState({ name: "", material: "", thickness: "" });

// Replace the saveCurrentAsPreset button with:
<button onClick={() => setIsAdding(true)} ...>+ Save</button>

{isAdding && (
  <div style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "4px 0" }}>
    <input placeholder="Preset name" value={newPreset.name}
      onChange={e => setNewPreset(p => ({ ...p, name: e.target.value }))}
      style={inputStyle} autoFocus />
    <div style={{ display: "flex", gap: "4px" }}>
      <input placeholder="Material" value={newPreset.material}
        onChange={e => setNewPreset(p => ({ ...p, material: e.target.value }))}
        style={{ ...inputStyle, flex: 1 }} />
      <input placeholder="Thickness" value={newPreset.thickness}
        onChange={e => setNewPreset(p => ({ ...p, thickness: e.target.value }))}
        style={{ ...inputStyle, width: "60px" }} />
    </div>
    <div style={{ display: "flex", gap: "4px" }}>
      <button onClick={handleSavePreset} style={...}>Save</button>
      <button onClick={() => setIsAdding(false)} style={...}>Cancel</button>
    </div>
  </div>
)}
```

The `handleSavePreset` function builds a `MaterialPreset` from the
active layer's current settings (same as existing logic but no `prompt()`).

**Dependencies:** None. Independent.

---

### 2c.2 -- Organize by material type then thickness

- [ ] Two-level hierarchy: Material > Thickness > [Cut, Engrave]
- [ ] Collapsible material groups

#### Files and changes

**`src/components/panels/MaterialLibrary.tsx`**
The current grouping key is `${m.material} ${m.thickness}` which
produces flat groups like "Plywood 3mm", "Plywood 6mm", "Acrylic 3mm".
Change to a two-level structure:

```ts
// Level 1: group by material
const byMaterial = materials.reduce<Record<string, MaterialPreset[]>>((acc, m) => {
  if (!acc[m.material]) acc[m.material] = [];
  acc[m.material].push(m);
  return acc;
}, {});

// Level 2: within each material, group by thickness
// Render:
{Object.entries(byMaterial)
  .filter(([material]) => !filter || material.toLowerCase().includes(filter.toLowerCase()))
  .map(([material, presets]) => {
    const byThickness = groupBy(presets, p => p.thickness);
    return (
      <MaterialGroup key={material} material={material}>
        {Object.entries(byThickness).map(([thickness, items]) => (
          <ThicknessGroup key={thickness} thickness={thickness}>
            {items.map(preset => <PresetRow ... />)}
          </ThicknessGroup>
        ))}
      </MaterialGroup>
    );
  })}
```

Each `MaterialGroup` is a collapsible section with the material name
as header. `ThicknessGroup` is a sub-header showing the thickness.

**Dependencies:** None. Independent.

---

### 2c.3 -- Import/export presets as JSON

- [ ] "Export" button saves all (or selected) presets to a `.json` file
- [ ] "Import" button loads presets from a `.json` file and merges
- [ ] Handle ID conflicts on import (generate new IDs)

#### Files and changes

**`src/components/panels/MaterialLibrary.tsx`**
Add import/export buttons in the header area:

```tsx
<div style={{ display: "flex", gap: "4px" }}>
  <button onClick={exportPresets} title="Export presets">Export</button>
  <button onClick={importPresets} title="Import presets">Import</button>
</div>
```

**Export implementation:**
```ts
async function exportPresets() {
  const hasTauri = await ensureTauri();
  if (!hasTauri) return;
  const path = await dialogModule!.save({
    filters: [{ name: "Kerf Material Presets", extensions: ["json"] }],
    defaultPath: "kerf-materials.json",
  });
  if (!path) return;
  const data = JSON.stringify(materials, null, 2);
  await fsModule!.writeTextFile(path, data);
}
```

**Import implementation:**
```ts
async function importPresets() {
  const hasTauri = await ensureTauri();
  if (!hasTauri) return;
  const path = await dialogModule!.open({
    filters: [{ name: "Kerf Material Presets", extensions: ["json"] }],
  });
  if (!path || typeof path !== "string") return;
  const raw = await fsModule!.readTextFile(path);
  const imported = JSON.parse(raw) as MaterialPreset[];
  // Validate and deduplicate
  for (const preset of imported) {
    // Generate new ID to avoid conflicts
    preset.id = `imported_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    useStore.getState().addMaterial(preset);
  }
}
```

Will need the Tauri dialog and fs module imports. Follow the same
lazy-import pattern used in `src/lib/fileOps.ts`.

**Validation:** Check that imported data has required fields (`name`,
`material`, `thickness`, `mode`, `power`, `speed`, `passes`). Skip
invalid entries and log warnings to console.

**Dependencies:** None. Independent.

---

### 2c.4 -- Ship with sensible defaults for common materials

- [ ] Expand the default materials list in `src/lib/materials.ts`
- [ ] Add missing common materials with reasonable starting values
- [ ] Values are starting points -- users MUST test on their machines

#### Files and changes

**`src/lib/materials.ts`**
The existing defaults cover: Plywood (3mm, 6mm), MDF (3mm), Acrylic
(3mm, 6mm), Leather (2mm), Cardboard (2mm), Paper, Fabric, Cork (3mm).
This is already a solid set. Add:

```ts
// Hardboard / HDF
{ id: "hdf-3-cut", name: "Hardboard 3mm Cut", material: "Hardboard", thickness: "3mm",
  mode: "line", power: 95, powerMin: 0, speed: 6, passes: 1, airAssist: true, interval: 0.1 },
{ id: "hdf-3-engrave", name: "Hardboard 3mm Engrave", material: "Hardboard", thickness: "3mm",
  mode: "fill", power: 35, powerMin: 10, speed: 250, passes: 1, airAssist: false, interval: 0.1 },

// Plywood 5mm (very common)
{ id: "ply-5-cut", name: "Plywood 5mm Cut", material: "Plywood", thickness: "5mm",
  mode: "line", power: 100, powerMin: 0, speed: 6, passes: 1, airAssist: true, interval: 0.1 },

// Acrylic 5mm
{ id: "acrylic-5-cut", name: "Acrylic 5mm Cut", material: "Acrylic", thickness: "5mm",
  mode: "line", power: 100, powerMin: 0, speed: 4, passes: 1, airAssist: true, interval: 0.1 },

// Bamboo
{ id: "bamboo-3-cut", name: "Bamboo 3mm Cut", material: "Bamboo", thickness: "3mm",
  mode: "line", power: 90, powerMin: 0, speed: 8, passes: 1, airAssist: true, interval: 0.1 },
{ id: "bamboo-3-engrave", name: "Bamboo 3mm Engrave", material: "Bamboo", thickness: "3mm",
  mode: "fill", power: 35, powerMin: 10, speed: 250, passes: 1, airAssist: false, interval: 0.1 },

// EVA Foam
{ id: "foam-3-cut", name: "EVA Foam 3mm Cut", material: "EVA Foam", thickness: "3mm",
  mode: "line", power: 35, powerMin: 0, speed: 15, passes: 1, airAssist: false, interval: 0.1 },

// Veneer
{ id: "veneer-cut", name: "Wood Veneer Cut", material: "Veneer", thickness: "0.6mm",
  mode: "line", power: 20, powerMin: 0, speed: 25, passes: 1, airAssist: false, interval: 0.1 },
```

Note in comments that all values are calibrated for a typical 40W CO2
laser and will vary by machine. Users should run test grids
(Material Test Grid tool already exists).

**Dependencies:** None. Can be done first as a quick win.

---

## Implementation Order

The items above are ordered by dependency and value. Recommended
execution sequence:

```
Batch 1 (independent, do in parallel):
  2a.1  Output toggle per layer
  2a.2  Visibility/lock toggles on header
  2b.1  Inline speed/power/passes controls
  2c.4  Expand default materials

Batch 2 (depends on Viewport layers subscription from 2a.1):
  2a.3  Right-click "Move to Layer" context menu
  2a.4  Color-coded selection handles

Batch 3 (depends on 2a.3 for moveObjectsToLayer):
  2a.5  Drag objects between layers in panel

Batch 4 (independent but after panel changes settle):
  2a.6  Layer reordering via drag

Batch 5 (settings UX, independent):
  2b.2  Material preset dropdown per layer
  2b.3  Visual "modified" indicator
  2c.1  Save preset improved UX
  2c.2  Two-level material grouping
  2c.3  Import/export presets
```

**Estimated scope:** ~8-12 relay stages. Each batch is 1-3 stages.
The biggest single item is 2a.5 (drag objects between layers) due to
the panel restructuring and drag-and-drop state management.

---

## Store Changes Summary

New fields on `Layer` type:
- `output: boolean` (default `true`)
- `materialPresetId?: string` (optional)

New actions on store:
- `moveObjectsToLayer(ids: string[], layerIndex: number)`
- `reorderLayers(fromIndex: number, toIndex: number)`
- `applyPresetToLayer(layerIndex: number, presetId: string)`

Modified actions:
- `updateLayer` -- clears `materialPresetId` when preset-controlled
  fields change
- `loadProject` -- merges loaded layers with `layerDefaults` for
  backwards compatibility

---

## Backwards Compatibility

Projects saved before Phase 2 will not have `output` or
`materialPresetId` on their layers. The `loadProject` function must
merge each layer with defaults:

```ts
loadProject: (project) =>
  set({
    ...existingFields,
    layers: project.layers.map(l => ({
      ...layerDefaults,
      output: true,
      ...l,
    })),
  }),
```

This ensures old projects load cleanly with `output: true` on all layers
and no `materialPresetId`.

The `KerfProject.version` field is currently `"0.1.0"`. Bump to
`"0.2.0"` when Phase 2 lands. The version field is informational only
(no migration logic exists), but it documents when schema changed.

---

## Testing Checklist

- [ ] Create objects on different layers, toggle output, generate G-code
      -- verify non-output layers are excluded
- [ ] Lock a layer -- verify objects can't be selected or moved
- [ ] Right-click canvas -- verify "Move to Layer" submenu appears with
      all layers, and moving works
- [ ] Selection handles -- verify they change color per layer
- [ ] Drag object from one layer to another in panel -- verify layerIndex
      and stroke color update
- [ ] Drag layer to reorder -- verify cut order changes in G-code
- [ ] Apply material preset to layer -- verify settings populate
- [ ] Modify a setting after applying preset -- verify "Modified" badge
- [ ] Save preset from current layer settings -- verify it appears in library
- [ ] Export presets to JSON -- verify file contents
- [ ] Import presets from JSON -- verify they merge without duplicating IDs
- [ ] Load a pre-Phase-2 project -- verify no errors, output defaults to true
- [ ] Undo/redo for: move to layer, reorder layers, preset application
