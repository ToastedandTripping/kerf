# Kerf Code-Refresh — 2026-08-05

Recovered from crashed session-3b65b7 (same base, 5d76ab5). 20 committed +
1 uncommitted change salvaged, verified green, cherry-picked, and closed.

## Baseline → Result

| Metric         | Before | After | Delta                                          |
| -------------- | ------ | ----- | ---------------------------------------------- |
| JS tests       | 628    | 637   | +9                                             |
| Rust tests     | 169    | 167   | −2 (dead optimizer tests removed)              |
| tsc --noEmit   | clean  | clean | —                                              |
| clippy -D warn | clean  | clean | —                                              |
| npm audit high | 3      | 3     | — (upstream: brace-expansion, postcss, undici) |
| Files changed  | —      | 49    | +940/−551 lines                                |

## Applied (bucket A) — 21 changes, behavior-preserving

### Dead code / visibility (5)

- Removed dead exports with zero external call sites (ObjectType, RULER_SIZE,
  ParsedSubpath, GeometryPartial, MovesPoint/MovesExtents, MeasureState,
  KnownDevice/KNOWN_LASER_DEVICES/isKnownLaserDevice)
- Deleted superseded optimizer sort paths (sort_inner_first, multi_criteria_sort,
  bbox_contains — replaced by order_inner_first_nn in v0.8.23, carried #[allow(dead_code)] since)
- Dropped vestigial Rust locals and always-Ok Results in gcode_gen/mask_fill
- Folded empty file_io.rs placeholder into mod.rs comment
- Moved serde_json to dev-dependencies (all uses in #[cfg(test)])

### Geometry dedup (4)

- Shared 2×3 affine matrix helpers (multiplyMatrix2x3, applyMatrix2x3)
  replacing three identical copies across SvgImportDialog, pdfImport, svgImport
- Re-homed computeAABB from nesting.ts to geometry/index.ts; extracted
  rotatedExtents for the rotation math
- Replaced three inline DXF bbox loops with pointsBBox
- Moved assertPointsInvariant to a test-only helper file

### Test coverage (3)

- textToGcode characterization net (197 lines — covers text tool G-code path)
- 6 new golden G-code fixtures: offsetfill, perforation, tabs, lead-in/out,
  overcut, cross-hatch (generated through real generate_gcode, not hand-written)
- Golden corpus README

### CI hardening (3 + 1 uncommitted recovery)

- Release builds gated on the full test suite (build.yml)
- Tag vs package.json version-match assertion at release time
- Version-drift check extended to all 5 version files (Cargo.lock, package-lock)
- `--features sim` on cargo test and cargo clippy so CI actually compiles
  and lints the simulator module (was invisible to CI)

### Fixes / docs / a11y (4)

- Unknown layer mode now surfaces via eprintln + G-code comment instead of
  silent `_ => {}` (the one intentional non-equivalence)
- serialBusy store comments corrected to match actual semantics
- CollapsibleSection: aria-expanded attribute exposed for screen readers
- GRBL alarm description table hoisted to machineStateDisplay.ts (shared)

### Named constants (1)

- MM_PER_INCH, INCH_PER_MM, PT_PER_INCH, RAPID_SPEED_MM_MIN replacing
  magic numbers across 8 files

## Review gate

**Razor equivalence review: PASS** (0 CRITICAL, 0 WARNING, 0 SPEC_GAP).
All changes verified behavior-preserving. Zustand Error 185: no new
useStore selectors introduced. G-code output: byte-identical for all valid
layer modes (14 golden fixtures green). One acknowledged non-equivalence
(unknown layer mode handler) correctly identified as a deliberate fix.

## Declined / deferred

No items explicitly declined — the crashed session completed bucket-A
application but died before the review gate. No bucket-B items were
identified in the surviving work. A full re-audit for bucket-B candidates
would be a separate pass.

## Process notes

Session-3b65b7 crashed after committing 20 behavior-preserving changes but
before running the equivalence review or writing the report. Recovery:
cherry-picked the range into session-1431a3, applied the one uncommitted
CI fix, re-ran all four gates (tsc/vitest/cargo test/clippy), then ran a
fresh Razor equivalence review on the full diff. Zero rework needed.
