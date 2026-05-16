# Kerf -- Project Instructions

Laser cutter CAD/CAM desktop app. Tauri v2 / React / Pixi.js / Rust.

## Architecture
- Frontend: React 18 + Pixi.js 8 + Zustand + Tailwind
- Backend: Rust (Tauri v2) -- serial/GRBL, G-code gen, image tracing
- Build: Vite, GitHub Actions CI for macOS/Linux releases

## Key files
- `src/app/store.ts` -- Zustand store, all state
- `src/app/types.ts` -- DesignObject, Layer, MaterialPreset types
- `src/lib/fileOps.ts` -- SVG/DXF/image import/export
- `src/lib/machine/connection.ts` -- GRBL serial connection
- `src/lib/machine/gcodeGen.ts` -- G-code generation
- `src-tauri/src/engine/` -- Rust: tracer, dithering, gcode, optimizer

## Conventions
- GRBL only (no other firmware)
- Coordinates in mm
- Layers are color-coded, 6 default (Cut, Engrave, Score + 3)
- Dark mode, minimal chrome, Apple-esque design
