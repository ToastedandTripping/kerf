# Golden G-code corpus

This directory holds committed, byte-for-byte snapshots of the **exact
`gcode: String`** emitted by the real Kerf generator (`commands::gcode::generate_gcode`
/ `commands::gcode::generate_image_gcode`) for a fixed set of fixture designs.

## What these are — and are not

- These files capture **current generator behavior**, warts and all. They are
  **not** a hand-verified "this is correct G-code" oracle. If a golden looks
  geometrically wrong, that's a note for Phase 4 (geometry correctness work),
  not something to silently "fix" by hand-editing the file.
- They exist so later phases can prove things mechanically instead of by eye:
  - **Phase 3** (IPC payload compaction) must keep every one of these
    byte-identical — a golden diff of zero lines is the proof.
  - **Phase 4** (deliberate geometry changes) is expected to change some of
    these. The safety net there is a **reviewed git diff** against this
    corpus, not a mystery regression discovered on the laser.

## Fixtures

| File                                               | Covers                                                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01_simple_rect_cut.gcode`                         | Simple rectangle vector cut ("line" mode)                                                                                                             |
| `02_compound_holes_inner_first.gcode`              | Compound path (outer perimeter + hole sub-path), `cut_inner_first` sub-contour ordering                                                               |
| `03_fill_layer.gcode`                              | Raster fill layer ("fill" mode, AABB scan lines)                                                                                                      |
| `04_fillline_mixed_layer.gcode`                    | Mixed fillLine layer: maskFill (hole-aware raster) + perimeter line overlay sharing one `layer_index`, verifying the fill-before-line (A4b) partition |
| `05_image_engrave.gcode`                           | Image engrave pipeline (decode → dither → scan-line G-code)                                                                                           |
| `06_rotated_object.gcode`                          | Rotated vector cut (30°)                                                                                                                              |
| `07_multilayer_priority_order.gcode`               | Multiple `layer_index` groups — arrival-order-of-first-appearance must dominate nearest-neighbor travel distance                                      |
| `08a_origin_bottom.gcode` / `08b_origin_top.gcode` | Same design, `originTop` false vs true (Y-flip convention)                                                                                            |
| `09_offsetfill.gcode`                              | `offsetFill` mode — concentric inward rings, laser enabled per-ring (M5 before each inter-ring G0)                                                    |
| `10_perforation.gcode`                             | Perforated cut — 3mm cut / 2mm skip alternating along the contour                                                                                     |
| `11_tabs.gcode`                                    | Holding tabs — 8mm spacing / 2mm tab, laser off across each bridge                                                                                    |
| `12_lead_in_out.gcode`                             | 3mm lead-in approach and 2mm lead-out exit on a closed contour                                                                                        |
| `13_overcut.gcode`                                 | 2.5mm overcut past the closed contour's start point                                                                                                   |
| `14_cross_hatch.gcode`                             | Fill layer with `cross_hatch` — horizontal pass plus a vertical second pass                                                                           |

Fixture-construction code (and the exact input parameters for each) lives in
`src/commands/gcode.rs`, `#[cfg(test)] mod golden_tests`.

## Regenerating

Never hand-edit these files. To regenerate deliberately (e.g. after a Phase 4
geometry change):

```sh
cd src-tauri
KERF_UPDATE_GOLDEN=1 cargo test golden_tests
cargo test golden_tests   # confirm the just-written files now compare equal
git diff tests/golden/    # review every changed line before committing
```

If a diff appears anywhere you did NOT intend to change generator behavior
(e.g. during Phase 3's IPC work), that's a regression — stop and investigate
before regenerating over it.

## Format

Each file is the raw `gcode` string with one added trailing newline (for
normal text-file hygiene). The comparison strips that single trailing
newline before asserting equality, so the committed files stay diffable in
a normal editor/git without affecting the byte-for-byte check itself.
