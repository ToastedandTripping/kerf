# Kerf -- Project Instructions

Laser cutter CAD/CAM desktop app. Tauri v2 / React / Pixi.js / Rust.

## Architecture

- Frontend: React 18 + Pixi.js 8 + Zustand + Tailwind
- Backend: Rust (Tauri v2) -- serial/GRBL, G-code gen, image tracing
- Build: Vite, GitHub Actions CI for macOS/Linux releases

## Key files

- `src/app/store/index.ts` + `src/app/store/storeTypes.ts` -- Zustand store, all state
- `src/app/types.ts` -- DesignObject, Layer, MaterialPreset types
- `src/lib/fileOps/index.ts` -- SVG/DXF/image import/export, save/load
- `src/lib/machine/connection.ts` -- GRBL serial connection
- `src/lib/machine/gcodeGen.ts` -- G-code generation
- `src-tauri/src/engine/` -- Rust: tracer, dithering, gcode, optimizer

## Conventions

- GRBL only (no other firmware)
- Coordinates in mm
- Layers are color-coded, 6 default (Cut, Engrave, Score + 3)
- Dark mode, minimal chrome, Apple-esque design

## Testing SOP (mandatory)

Every relay and fix MUST be verified in the running app before declaring complete.

**Dev server:** `npm run dev` starts the Vite dev server. Open in Chrome and visually
confirm the change works (golden path + edge cases). Use Chrome DevTools MCP for
interaction testing (click, drag, type, screenshot).

**What's testable in-browser:** All UI interactions, tool behavior, rendering,
drag/drop, text editing, panel layout, keyboard shortcuts, Pixi.js canvas behavior.

**What's NOT testable (hardware-only):** Serial/GRBL communication, file system dialogs
(Tauri plugin), keep-awake, actual laser operation. For these, explicitly flag
"owner hardware test required" with specific test steps.

**When:** After implementation (before review), and again after review fixes. Never
declare a relay stage complete based only on `tsc --noEmit` + test pass.

**Tracking:** Any feature that can't be browser-tested gets logged in the ROADMAP
`next` section with explicit owner-test steps. Nothing gets silently skipped.

## Critical: Zustand Selector Rules (React Error 185)

**NEVER** return a new object/array from a `useStore` selector. This causes infinite re-render loops (React Error 185) that crash the app with a blank screen. This bug has appeared 3 times.

BAD (creates new object every render → infinite loop):

```typescript
const { a, b } = useStore((s) => ({ a: s.a, b: s.b }));
const filtered = useStore((s) => s.items.filter(...));
```

GOOD (stable references):

```typescript
const a = useStore((s) => s.a);
const b = useStore((s) => s.b);
const items = useStore((s) => s.items);
const filtered = items.filter(...); // derive outside the selector
```

Razor MUST check every `useStore` call in reviewed diffs for this pattern.
