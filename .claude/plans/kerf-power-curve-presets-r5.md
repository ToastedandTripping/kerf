# Kerf: the S-Curve and Posterize power-curve presets burn a raster as a negative; fix the presets and the blank editor (UI polish TB3)

Revision 5, 2026-10-04. Revisions 1-4 FAILED astra rounds 1-4 (`-critic-r1.md` to `-critic-r4.md`, plans `-r1.md` to `-r4.md`). Round 4 failed on the publication guard only: it missed project replacement and the power-scale raiser, and it misread the material-test dialog. This revision rebuilds the guard around the generator's actual inputs (Design 5). Round 5 is the cap. The fold tables are at the end. This is a correctness bug. It is follow-on plan TB3 from `.claude/plans/kerf-ui-polish.md` (revision 3, critic PASS), and that entry's "Requirements" and "Acceptance evidence" are binding here.

## Intent (grilled)

Grill: skipped, with this reason. The defect is unambiguous and no choice in it depends on Lee's preference. Lee ruled the order on 2026-10-02 ("All recs", then "Kick off the relay"), and the coordinator relayed his go on 2026-10-04 ("get him working on the active projects"). Everything below is technical, decided under Lee's 2026-09-29 delegation ("I defer to your judgement and research").

**Summary / key decisions.**
- **The bug.** Two of the three presets in the Power Curve editor (S-Curve, Posterize) map black (shade 0) to 0% power and white to 100%. A photo engraved with either burns as its negative, and nothing warns.
- **The fix.** Give both presets the direction Linear already has: shade 0 at 100%, falling to 0% at shade 255.
- **The editor.** It draws its curve when it opens, instead of staying blank until first hovered.
- **Saved projects.** Stored curves are never rewritten. A layer saved with the old points keeps generating exactly what it generated before; the release note tells the owner how to re-pick.
- **The publication guard** (batch `tb3-guard`, landing first). Apply-then-Generate is TB3's own workflow, so the pre-existing race that could show an older G-code result as current is closed here. A result finishing after any of its inputs changed is published as out of date. A result from a replaced project, or superseded by a newer generation, is discarded.

## Diagnosis (verified on marvin/kerf-gap at 70cdfa1)

- **The point convention.** `CurvePoint` is `x` = input shade 0-255, `y` = output power 0-100% (`src/components/panels/PowerCurveEditor.tsx:4-7`). The engine builds a 256-entry LUT from the points with monotone cubic (Fritsch-Carlson) interpolation, then maps power back to shade: power 100% = shade 0 (full burn), power 0% = shade 255 (no burn) (`src-tauri/src/engine/image_gcode_gen.rs:225-230`, `build_power_curve_lut` at :230). The LUT is applied to every pixel before dithering (`:141-149`). `power_curve_linear_is_identity` (`:534-552`) confirms that Linear `[{0,100},{255,0}]` is the identity.
- **The inverted presets** (`PowerCurveEditor.tsx:9-31`). Both rise with shade, so black gets 0%:
  - S-Curve: `[{0,0},{64,10},{128,50},{192,90},{255,100}]`.
  - Posterize: `[{0,0},{84,0},{85,33},{169,33},{170,66},{254,66},{255,100}]`.
- **How a preset reaches the laser.**
  - A preset button copies its points into the editor (`:481`, `setPoints([...pts])`).
  - Apply writes them to the layer (`LayerPanel.tsx:831-839`, `onManualUpdate({ powerCurve: pts })`).
  - Saving serialises the store with `useStore.getState().toProject()` and `JSON.stringify` (`src/lib/fileOps/index.ts:507-508`).
  - Opening parses with `parseAndValidateProject` (`:26`) and loads with `loadProjectWithMigrations` (`:174`).
  - At Generate, `generateGcode()` (`src/lib/machine/gcodeGen.ts:905`, exported) reads the store once and builds each image request. The raster request carries `powerCurve: layer.powerCurve?.map(p => [p.x, p.y])` into `invoke("generate_image_gcode", …)` (`:697-729`).
  - The command wraps `image_gcode_gen::generate(&ImageEngraveRequest)` (`src-tauri/src/commands/gcode.rs:220-224`, engine `:166`).
  - A project stores raw points, never a preset name.
- **The highlight.** The selected-preset highlight matches the current points against `PRESETS` (`:310`). After the fix, a layer holding the old S-Curve points matches no preset, which is accurate.
- **The blank editor.**
  - The draw effect is `useEffect(() => { draw(); }, [draw])` (`:221-223`). `draw` changes only when `points`, `dragIndex` or `hoverIndex` change, and the canvas mounts only after `if (!open) return null` (`:324`). So opening the editor with the same points reference draws nothing.
  - `draw` returns early when there is no canvas (`:142`) or no 2D context (`:144`). It draws the grid lines and a dashed diagonal first, then the curve, then one `arc` per control point (`:197`). Only the control-point arcs are specific to the curve.
- **The generation snapshot, and a pre-existing publication race that `tb3-guard` closes.** (Re-verified on marvin/kerf-gap at d09fe12.)
  - **What generation reads.** `generateGcode()` reads the store once, synchronously, before its first `await` (`gcodeGen.ts:906`); nothing it calls reads the store again (`textObjectToPaths` reads fonts, not the store). Across `:905-1196` it reads exactly twelve state fields: `objects`, `layers`, `workspaceWidth`, `workspaceHeight`, `originTop`, `startCorner`, `grblSValueMax`, `grblLaserMode`, `grblAccelX`, `grblAccelY`, `grblMaxFeedRateX`, `grblMaxFeedRateY`. It also calls `addConsoleLine`, a method rather than an input. A single generation never mixes state.
  - **Completion clears the flag unconditionally:** `setGcodeResult: (result) => set({ gcodeResult: result, gcodeStale: false })` (`store/index.ts:692`), whose only production caller is the Generate handler (`MachinePanel.tsx:386`). So if any of those twelve fields changes while a generation is in flight, the older result is published as current. When no result existed at the start, the edit does not set the flag at all, because every raiser is conditional on `gcodeResult !== null`.
  - **Project replacement is the same race, and worse.** `loadProject` (`store/index.ts:505-527`) is the single replacement path: Open, Open Recent, New (`fileOps/index.ts:249-258`, a fresh empty project) and autosave recovery (`App.tsx:470`) all reach it through `loadProjectWithMigrations` (`fileOps/index.ts:174`, `:244`). It replaces the design and sets `gcodeResult: null, gcodeStale: false`. A generation started in project A that resolves after B is loaded is therefore published as current in B. If A and B share bed size and origin, nothing marks it stale.
  - **The staleness raisers as they are today** (post-publication only):
    - 12 sites in `store/index.ts` use `gcodeStale: state.gcodeResult !== null ? true : state.gcodeStale` (`:71, :137, :147, :194, :225, :239, :257, :301, :351, :388, :865, :874`);
    - `setWorkspaceSize` (`:401-409`) when the size changes;
    - `applyObjects` (`storeHelpers.ts:44`) on every objects write;
    - `setGrblSValueMax` (`:614-626`) when the value changes.
  - **Generation inputs with no raiser at all:** `setGrblLaserMode`, `setGrblAccel` and `setGrblMaxFeedRate` (`:628-630`). A result generated before connecting, with the default acceleration 500 (`:597`), stays current after the connect-time settings read replaces it, even though acceleration feeds the scan motion and overscan (`gcodeGen.ts:953-966`, overscan at `:716`). This is a post-publication gap, found while re-verifying for this revision; the guard closes it structurally (Design 5).
  - **Concurrency of the handler.** The Generate and Preview buttons are disabled while the component-local `generating` flag is set (`MachinePanel.tsx:111`, `:1237`, `:1267`). Two generations therefore overlap only across a remount of the panel, whose fresh instance starts with `generating` false. A project replacement needs no overlap at all.
  - **What is not a publication.** `MaterialTestDialog.tsx:273-294` builds a local `displayGate` argument for `canStartJob` with `gcodeResult: null, gcodeStale: false`. That is a display-only predicate input and no store write. The dialog's own generation (`handleGenerate`, `:192`) awaits `generateMaterialTestGcode` and streams its local program through its own admission. It never touches `gcodeResult`, so it is outside this guard and unchanged. Revision 4 called it a publisher; that was wrong.
  - **Export.** `exportGcode` (`fileOps/index.ts:469-489`) writes `gcodeResult.gcode` to a file without consulting `gcodeStale`. It is pre-existing, it is a file rather than a laser path, and it is parked (Deferrals).

## Design

1. **New preset points.** Each is monotone non-increasing and maps shade 0 to its maximum:
   - S-Curve `[{0,100},{64,90},{128,50},{192,10},{255,0}]`. This is the old curve mirrored about 50% power: the same gentle ends and steep mid-tones, in the right direction.
   - Posterize `[{0,100},{84,100},{85,67},{169,67},{170,34},{254,34},{255,0}]`. That is three power bands of 100%, 67% and 34%, over shades 0-84, 85-169 and 170-254, plus pure white (shade 255) at 0%. Monotone cubic interpolation keeps each band flat, because both tangents inside a flat segment are 0.
   - Linear is unchanged.
2. **Draw on open.** The draw effect becomes `useEffect(() => { if (open) draw(); }, [open, draw])`.
   - The early returns at `:142` and `:144` stay as they are: with no context, the editor shows no plot.
   - Apply, Cancel, Escape and the focus trap are unchanged. Nothing is applied or generated as a side effect of drawing or of a failed draw.
3. **No migration.** Saved `layer.powerCurve` points are never rewritten. The file holds raw points, which cannot be told apart from a deliberate custom curve, so a migration would change a saved job's output without the owner's choice.
4. **The release-note line.** The release session owes it, and the ROADMAP shipped entry carries the text: "Fixed: the S-Curve and Posterize power-curve presets were inverted, so they burned an image as its negative. Layers that already used them keep their old curve until you change it: open the layer's power curve, pick the preset, press Apply, then save the project. Also fixed: a G-code result that finished generating after you changed the design or the machine settings was shown as up to date; it is now marked out of date, so START asks you to generate again. A result that finishes after you open or start a different project is now thrown away instead of appearing in the new one."

5. **The publication guard** (batch `tb3-guard`). One protocol with three identities, all held in the store, plus one structural raiser. It replaces revision 4's hand-incremented `designRevision`, whose correctness depended on an inventory of edit sites that was incomplete twice over.
   - **The input set is the compiler's inventory, not a list of edit sites.** A new module, `src/app/store/generationInputs.ts`, exports:
     - `GENERATION_INPUT_KEYS`, the twelve fields in the Diagnosis, `as const`;
     - `type GenerationInputs = Pick<AppState, (typeof GENERATION_INPUT_KEYS)[number]>`;
     - `selectGenerationInputs(state)`, which copies those twelve references (no cloning);
     - `inputsChanged(a, b)`, which is true when any key differs under `Object.is`.

     `generateGcode` gains a parameter, `generateGcode(inputs: GenerationInputs = selectGenerationInputs(useStore.getState()))`, and its local `store` becomes that `inputs` object. Its six `store.addConsoleLine` calls go through `useStore.getState().addConsoleLine`. From then on, a new state read inside `generateGcode` that is not in the key set is a `tsc` error, so the set cannot silently fall behind the generator. The store's updates are immutable (the Zustand selector rule in CLAUDE.md relies on that already), so a changed array or a changed number is always a changed reference.
   - **Identities, all in the store and never reset:**
     - `projectEpoch: number`, starting at 0 and incremented by `loadProject`. That covers Open, Open Recent, New and autosave recovery, which all reach it. `loadProject` becomes the `set((state) => …)` form so it can read the old value.
     - `generationSeq: number`, the sequence number of the most recently started generation. `loadProject` does not reset it, and neither does a remount, because it does not live in the component.
     - The ticket, `{ seq, epoch, inputs }`, which `beginGeneration()` returns. That store action increments `generationSeq` and captures `projectEpoch` and `selectGenerationInputs(get())` in one synchronous step.

     Neither counter is in `toProject` or `KerfProject`, so neither is ever saved or loaded, and the T5 round trip shows the file format is unchanged.
   - **Publication, in one synchronous store action.** `publishGeneration(ticket, result)` reads the current state once and returns its outcome:
     1. If `ticket.epoch !== projectEpoch`, the result is **discarded** (`"discarded-project"`) and the store is unchanged. A result from another project is never published, as current or as stale.
     2. Otherwise, if `ticket.seq !== generationSeq`, the result is **discarded** (`"discarded-superseded"`): a newer generation was started, whichever finishes first. The store is unchanged.
     3. Otherwise the result is **published**, with `gcodeStale: inputsChanged(ticket.inputs, selectGenerationInputs(state))`. The outcome is `"published"` or `"published-stale"`.

     Because the check and the write happen in one synchronous call, no state change can fall between them.
   - **`setGcodeResult` is removed** from `AppState`, and `publishGeneration` replaces it. With no unconditional publisher left, `tsc` rejects any future caller. Its one existing test (`gcodeStale.test.ts:211`) is rewritten to the same assertion through `publishGeneration`: a current publish clears staleness. Test seeding writes state through `useStore.setState`, as it does today.
   - **Post-publication staleness, one structural raiser.** Directly after `create`, `store/index.ts` registers one `useStore.subscribe((state, prev) => …)`. It sets `gcodeStale: true` when all of these hold:
     - a result exists;
     - `state.gcodeResult === prev.gcodeResult`. A write that sets a result together with inputs states that pair itself, so the raiser leaves it alone. Test seeding does exactly that, in one `setState`, and so does any publication. `loadProject` leaves no result, so it never fires there;
     - `!state.gcodeStale`;
     - `inputsChanged(prev, state)`.

     This covers every writer of every input, present and future, including the three machine setters that raise nothing today. The 15 existing raisers stay as they are, now redundant and harmless; removing them is churn and is left to TB6. The same pattern exists already (`connection.ts:531`, `keepAwake.ts:47`). Zustand 5 notifies subscribers synchronously inside `set`, so no reader can observe the gap between an input change and the flag.
   - **The handler, every duty specified** (`MachinePanel.tsx` `handleGenerateGcode`):
     - **Before:** `setSparseImageWarning(false)`, then `setGenerating(true)`, then `const ticket = beginGeneration()`, then `await generateGcode(ticket.inputs)`. The generator reads exactly the inputs the ticket holds.
     - **On resolve:** `const outcome = publishGeneration(ticket, result)`. Then:
       - `"published"`: today's info line, today's sparse-image check, return `true`. The check reads `ticket.inputs.objects`, not live state.
       - `"published-stale"`: a warning line, "G-code generated, but the design or machine settings changed while it ran. Regenerate before START." No sparse-image check. Return `true`: a result exists, Preview may show it, and the Generate button already reads "Regenerate G-code".
       - `"discarded-project"`: one info line, "Discarded a G-code generation started in a different project." Nothing else; return `false`.
       - `"discarded-superseded"`: one info line, "Discarded an earlier G-code generation; a newer one is running." Nothing else; return `false`.

       A discarded call writes no status message, raises no warning, and changes neither `gcodeResult` nor `gcodeStale`.
     - **On reject:** unchanged. Today's error line and status message, the result left untouched, return `false`. A failure in a superseded or other-project call still reports, because it is a real failure and touches nothing.
     - **Finally:** `setGenerating(false)` on this component instance, unchanged. `generating` is per instance and both buttons are disabled while it is set, so the only way to start a newer call is a fresh instance. An older call therefore never clears a newer call's busy state; G6 proves it across a remount.
   - **What START and FRAME see.** They keep reading `gcodeResult` and `gcodeStale` through `canStartJob` (`canStartJob.ts:193-194`), unchanged. The guard's whole job is to make those two fields true to the current project and inputs. G1-G5 prove the refusal through `JobActionBar` with the real store state, not through the flag alone.
   - **What it does not change:** the generator's output for unchanged inputs (every golden stays byte-identical), the stop path, `canStartJob`, the material-test path, any existing raiser, and the file format.

## Batches, tier and dependencies

Standard tier, two batches in one relay. `tb3-guard` lands first; `tb3` follows on top.

| batch | files | depends on |
|---|---|---|
| `tb3-guard` | `src/app/store/generationInputs.ts` (new), `src/app/store/index.ts`, `src/app/store/storeTypes.ts`, `src/lib/machine/gcodeGen.ts` (the signature and the `store`/log lines of `generateGcode` only), `src/components/panels/MachinePanel.tsx` (`handleGenerateGcode` only), `src/app/store/__tests__/gcodeStale.test.ts` (the one `setGcodeResult` test, rewritten), `src/components/panels/__tests__/generationGuard.test.tsx` (new) | none |
| `tb3` | the table below | `tb3-guard` |

**`tb3-guard` size and roots.** Seven files, all under `src`, so it is within the eight-file cap and the single-root rule as the rubric defines a root. It still crosses three directories (store, lib/machine, panels), and on purpose: the ticket is created in the store, threaded through the generator's signature, and consumed by the handler. Splitting any of the three out would leave a commit where the generator reads inputs the handler did not capture, or where publication has no guard. Nothing outside these seven files changes, and none of TB6 is pulled in (Deferrals lists what stays there).

**File ownership against concurrent work.**
- `MachinePanel.tsx` belongs to UI polish A12, which has not started; `tb3-guard` must merge before A12 is briefed.
- `gcodeGen.ts` and the store files are in no current polish batch.
- ROADMAP.md is edited at Stage 3.5 by both this relay and polish A1, which is in review now. Both edits are additive (shipped entries, Parking Lot lines). The orchestrator merges the relays one at a time into marvin/kerf-gap and resolves any ROADMAP conflict by keeping both sides, as it did for R3 and motion-trust. The two relays are independent in code, not in that one document.

### Batch `tb3`

| file | root | change |
|---|---|---|
| `src/components/panels/PowerCurveEditor.tsx` | `src` | the two preset arrays; the draw effect's dependencies and its `open` guard |
| `src/components/panels/__tests__/powerCurveEditor.test.tsx` (new) | `src` | T1-T6 |
| `src-tauri/src/engine/image_gcode_gen.rs` | `src-tauri` | tests only, inside the existing `mod tests`; no production line changes |
| `src-tauri/tests/golden/tb3_legacy_s_curve.gcode`, `tb3_legacy_posterize.gcode`, `tb3_linear.gcode` (new) | `src-tauri` | N3's pinned-base goldens, captured at the base commit |
| `docs/owner-cards/tb3-legacy-s-curve.kerf` (new) | `docs` | the bounded legacy project for owner card step 3 |
| `ROADMAP.md` (Stage 3.5) | root | shipped entry with the release note; the owner card in `next` |

**Waiver for the multi-root rule** (8 files over `src`, `src-tauri` and `docs`, all exclusive to this batch). This is one defect: a value table in TS whose meaning lives in the Rust LUT. The Rust edits are tests that pin that meaning, with no production change. Splitting the batch would ship a preset fix with nothing pinning what its numbers do.

**Dependencies.**
- `tb3` depends on `tb3-guard`, for the Apply-then-Generate workflow.
- `tb3` must merge before UI polish batch A4, which restyles `PowerCurveEditor.tsx` (the polish plan's collision table: "TB3 first").
- In code, `tb3` and `tb3-guard` share no file with polish A1 (`src/index.css`, its contrast test, its walker); ROADMAP integration is serialised as above.

## Tests

### The guard (`generationGuard.test.tsx`)

Harness: the production `MachinePanel` and `JobActionBar`, rendered as `gcodeFailureLoud.test.tsx` does, with `invoke` mocked and `generate_image_gcode` / `generate_vector_gcode` returning deferred promises that the test resolves explicitly. One image object and one rectangle are seeded, so both invoke paths are pending. The machine state is seeded as eligible: connected, Idle, workspace verified, laser mode on, status fresh. That way, the stale or missing result is the ONLY reason START and FRAME can refuse, and each test asserts that reason verbatim. Every test reads real store state, never a mock of it.

- **G1, an edit in flight, no prior result.** Press Generate. Before it resolves, `updateLayer` (a curve Apply). Resolve. `gcodeResult` is set, `gcodeStale` is true, the console has the stale warning line, and START and FRAME both refuse with "Design changed -- regenerate G-code". Red today: the result is published current.
- **G2, the same with an existing result.** It is seeded current. The edit stales it immediately (the existing raiser). After resolve, the new result is published stale, and START and FRAME refuse.
- **G3, project replaced in flight.** Four cases: Open (`loadProjectWithMigrations` with project B, which has the same bed size and origin as A, so no other field differs) and New (`fileOperations.newProject()`), each with A's result slot empty and with it holding a current result. Press Generate in A, replace the project, then resolve. In every case the outcome is `"discarded-project"`: `gcodeResult` is null, as `loadProject` left it, and `gcodeStale` is false. START refuses with "Generate G-code first". The console has the discard line. `projectEpoch` went up by exactly 1 per replacement. Red today: A's result is published current in B.
- **G4, power scale changed in flight.** No prior result. Press Generate, call `setGrblSValueMax(255)` (from 1000), then resolve: the result is published stale and START refuses. Repeat with an existing result. Red today.
- **G5, every input, both phases, table-driven.** There is one row per key in `GENERATION_INPUT_KEYS`, each a real store action that changes that key: `applyObjects`/`updateObject` for objects, `updateLayer` for layers, `setWorkspaceSize`, `setOriginTop`, `setStartCorner`, `setGrblSValueMax`, `setGrblLaserMode`, `setGrblAccel`, and `setGrblMaxFeedRate`. Where one action sets two keys, the row lists both.
  - **The meta-assertion:** the union of the rows' keys equals `GENERATION_INPUT_KEYS` exactly. A key added without a row fails, and so does a row for a key that is not an input.
  - **In flight, per row:** Generate, apply the action, resolve: `"published-stale"`.
  - **After publication, per row:** publish current, apply the action: `gcodeStale` is true, and START refuses. The accel, feed-rate and laser-mode rows are red today.
  - **A no-op per row, where the action takes a value:** setting the same value leaves a current result current. This proves the subscription compares values and does not fire on every write.
- **G6, supersession and remount.** Press Generate (A). Unmount and remount `MachinePanel`. The fresh instance's button is enabled, and that is the real overlap path. Press Generate (B). Then two orders:
  - resolve A first: `"discarded-superseded"`, nothing published, and the new instance still shows "Generating...", because A's `finally` ran on the unmounted instance. Then resolve B: published current.
  - resolve B first: published current, then A is discarded and does not overwrite B.

  In both orders `generationSeq` is the value B's ticket holds. Red today: in the second order A overwrites B.
- **G7, identities are not reused.** Take a ticket, then `loadProject` twice and start a new generation. The new ticket's `seq` is the old one plus 1, never reset by the loads, and its `epoch` is the old one plus 2. Publishing the old ticket after that is `"discarded-project"`. With two generations in one epoch, the older ticket is `"discarded-superseded"` even when no edit happened.
- **G8, positive controls.** With no edit, resolve: published current, and START is admitted (not refused for staleness). One `setState` that writes a current result together with new objects leaves it current (the subscription's same-result clause). With a failure (the generator rejects): today's error line and status message, the result untouched, `false` returned, and the Preview not opened. `gcodeFailureLoud.test.tsx` stays green unchanged.
- **G9, a discarded call does nothing else.** For both discard kinds: no status message, `setSparseImageWarning` never set true (with a sparse image and a fake long result that would otherwise trigger it), Preview not opened, and exactly one console line.
- **G10, the input set is enforced by the compiler.** This is a gate, not a vitest case. Inside `generateGcode`, a read of a state field outside the key set (for example `store.camera`) fails `npx tsc --noEmit`. It is proven by battery mutant m14.

### TS (`powerCurveEditor.test.tsx`)

- **T1, direction.** `PRESETS` is exported for the test (a named export; the component's behaviour is unchanged). For every preset:
  - the point at `x` 0 has the preset's maximum `y`;
  - `y` never rises as `x` increases;
  - the point at `x` 255 has `y` 0.

  This is red today for S-Curve and Posterize.
- **T2, source sync with the Rust fixtures.** Read `src-tauri/src/engine/image_gcode_gen.rs` as text and extract the literal arrays `TB3_S_CURVE` and `TB3_POSTERIZE`. The extraction must fail the test if either is missing or appears more than once. Assert each equals its TS preset, point for point.
- **T3, draw on open, curve-specific.**
  - Stub `HTMLCanvasElement.prototype.getContext` to return a recording context. jsdom has no canvas.
  - Render with `open={false}`, then rerender with `open={true}` and the same `points` reference.
  - Assert the curve stroke itself: after open, the recording contains the curve path, a `moveTo` at the first point's canvas coordinates (`shadeToCanvasX(x)`, `powerToCanvasY(y)`, exported or recomputed from the component's constants), followed by the curve's segments and a `stroke` in the curve's own `strokeStyle`. Assert the control-point `arc` calls too. Grid strokes and the dashed diagonal alone do not pass.
  - Clear the recording, Cancel, reopen with different incoming points, and assert the curve path now starts at the new first point.
  - This is red today. Mutation: removing `open` from the dependencies must fail it.
- **T4, Apply writes once.**
  - Pick S-Curve, press Apply, and assert `onApply` is called exactly once with the new S-Curve points.
  - Cancel after picking a preset: `onApply` is not called.
  - With `getContext` returning null, Apply still works and no plot is drawn. No crash, and nothing applied implicitly.
  - **Failed regeneration after Apply** (in the MachinePanel generate path, with `invoke` mocked). Start with an existing result, then Apply a new curve (the result goes stale), then make `generate_image_gcode` reject. The old result stays flagged stale, the existing failure message shows, and no job is dispatched. This pins today's failure behaviour; the in-flight cases are G1-G9.
- **T5, the saved-project round trip, both legacy arrays.**
  - Put one image object on a raster layer whose `powerCurve` is the OLD S-Curve, and a second layer with the OLD Posterize.
  - Serialise with `toProject()` and `JSON.stringify`, as `saveToPath` does (`fileOps/index.ts:507-508`).
  - Parse with `parseAndValidateProject`, load with `loadProjectWithMigrations`, then call `generateGcode()` with `invoke` mocked.
  - Assert the captured `generate_image_gcode` payloads carry `powerCurve` deep-equal to the legacy pairs, in order. Both new presets get the same through Apply, then save/reopen, then generate.
  - This pins no-migration on the real save, open and raster-request path.
- **T6, the highlight.** Opening with the old S-Curve points highlights no preset; opening with the new ones highlights S-Curve.

### Native (`image_gcode_gen.rs`, `mod tests` only)

Constants:
- `TB3_S_CURVE` and `TB3_POSTERIZE`: literal copies of the new presets, with a comment naming `PowerCurveEditor.tsx` and T2;
- `TB3_OLD_S_CURVE` and `TB3_OLD_POSTERIZE`: the legacy arrays, for the delta and the legacy golden.

The ramp request, used by N2 and N3:
- `image_data`: a 256x1 8-bit grayscale PNG with pixel i = shade i, built in the test;
- `width` 25.6 and `height` 0.1, with `interval` 0.1, so one pixel is 0.1 mm;
- `power` 100, `power_min` 0, `s_value_max` 1000, `power_mode` "variable", `dither` "grayscale";
- `bidirectional` false, `overscan` 0, `scanning_offset` 0;
- `brightness` 0, `contrast` 0, `gamma` 1.0, `invert` false, `rotation` 0, `scale_x` and `scale_y` 1.0, `origin_top` true, `remove_background` false;
- `x` and `y` 0, `speed` 1000, `passes` 1.

The tests:
- **N1, LUT direction.**
  - For each new preset: `lut[0] == 0` (black stays full burn), `lut[255] == 255` (white stays no burn), and `lut` non-decreasing in its input.
  - For each OLD preset: `lut[0] == 255`, which documents the defect.
  - Posterize's three bands come out as exact levels: `lut` over shades 0-84 equals `255 - round(255 × 1.00)`; over 85-169, `255 - round(255 × 0.67)`; over 170-254, `255 - round(255 × 0.34)`; and shade 255 maps to 255. Compute these with the LUT's own rounding rule, read from `build_power_curve_lut`.
- **N2, the spatial before/after.**
  - Decode the G-code from `generate(&req)` into a power map over the 256 pixel columns. Walk the moves in order, tracking X and the modal S. Each `G1` with a positive S from X0 to X1 assigns that S to every column whose centre lies in [X0, X1). A column no burning move covers (a `G0` travel, an `S0` span, or no move at all) gets S0. This handles the scanner merging equal S values into one move (`mask_fill.rs:684-718`) and white pixels emitting nothing.
  - The independent oracle is the LUT, not the G-code: the expected S per column is `round(s_value_max × (255 - lut[i]) / 255)` under the grayscale scanner's mapping. Read the exact mapping from the scanner and cite it in the test; allow ±1 count only for its rounding.
  - With `TB3_S_CURVE`: column 0 at the maximum S, column 255 at S0, never rising. With `TB3_OLD_S_CURVE`: the reverse. Posterize: three flat plateaus and S0 at column 255.
- **N3, the pinned-base legacy golden.**
  - Before any production edit, the implementer runs the ramp through `generate` with `TB3_OLD_S_CURVE`, `TB3_OLD_POSTERIZE` and Linear on the base commit. They write the three full G-code strings under `src-tauri/tests/golden/` (for example `tb3_legacy_s_curve.gcode`, `tb3_legacy_posterize.gcode`, `tb3_linear.gcode`), following the existing golden convention and the `env -u KERF_UPDATE_GOLDEN` discipline.
  - N3 asserts byte equality at HEAD. Since no Rust production line changes, this pins that legacy and Linear output is untouched now, and that a later engine change cannot alter it silently.
  - The report quotes the base commit sha and the command used to capture.
- **The existing tests stand unchanged:** `power_curve_linear_is_identity`, `power_curve_step_produces_binary` and `power_curve_lut_serialization_roundtrip`.

### Mutation battery (`~/marvin/scripts/mutation-battery.mjs`)

Every `find` must have `grep -cF` equal to 1, the journal is at the standard path, and the battery restores by construction (a disposable copy).
- **m1:** S-Curve's first point back to `{ x: 0, y: 0 }`. Kills T1 and T2.
- **m2:** Posterize's first point back to `{ x: 0, y: 0 }`. Kills T1 and T2.
- **m3:** `[open, draw]` back to `[draw]`. Kills T3.
- **m4:** the `arc` loop removed from `draw`. Kills T3.
- **m7:** only the curve-rendering block removed from `draw`, with the grid, the diagonal and the arcs kept. Kills T3 and proves it checks the curve stroke, not just the handles.
- **m8, the decoder's own teeth:** in the N2 test's expected-G-code path, displace one powered segment's X by 0.5 mm, and separately corrupt its S token. N2 itself must fail on each, independently of T1, T2 and N1. This proves the spatial oracle checks placement and power. Applied as a test-input mutant: a fixture-transform hook in the test, toggled by the battery.
- **m9:** `loadProject` no longer increments `projectEpoch`. Kills G3 and G7.
- **m10:** `publishGeneration` skips the epoch comparison. Kills G3 and G7.
- **m11:** `publishGeneration` skips the sequence comparison. Kills G6 and G7.
- **m12:** publish with `gcodeStale: false` hard-coded. Kills G1, G2, G4 and G5's in-flight rows.
- **m13:** the post-publication subscription removed. Kills G5's post-publication rows for accel, feed rate and laser mode, the fields with no other raiser.
- **m15:** `grblSValueMax` removed from `GENERATION_INPUT_KEYS`. Kills G5's meta-assertion. With that key gone, the generator's read of it would be a `tsc` error, and m14 shows the compiler catches it.
- **m16:** the subscription's `state.gcodeResult === prev.gcodeResult` clause removed. Kills G8's seeding control: one `setState` that writes a current result together with new objects must leave it current.
- **m14, in a second battery spec whose `test_command` is `npx tsc --noEmit`:** add `void store.camera;` inside `generateGcode`. tsc must fail, which proves G10. The control, the unmutated tree, passes tsc.
- **m5:** a `loadProjectWithMigrations` mutant that rewrites `powerCurve`, for example replacing the old S-Curve with the new one. Kills T5.
- **m6:** `TB3_S_CURVE`'s first literal flipped in Rust. Kills T2.

The control: Linear stays byte-identical under N3, and the controls must stay green.

## Verification

- **Gates:**
  - `npx vitest run --cache=false` (full);
  - `npx tsc --noEmit`;
  - `npm run -s lint`;
  - `npm run -s format:check`;
  - `cargo test --manifest-path src-tauri/Cargo.toml --features sim` with `CARGO_TARGET_DIR=$HOME/.cache/kerf-engine-arm-target` and `env -u KERF_UPDATE_GOLDEN`;
  - clippy `--all-targets --features sim -- -D warnings`;
  - `cargo fmt --check`;
  - the battery twice: the vitest spec (m1-m13, m15, m16) and the tsc spec (m14).

  Every existing golden is unchanged; the only new goldens are N3's.
- **Browser** (dev server, puppeteer; the Chrome DevTools MCP is disconnected):
  - open a raster layer's power curve editor; the curve and its points are drawn on first open, with no hover;
  - pick each preset; S-Curve and Posterize fall from top left to bottom right, as Linear does;
  - Cancel, reopen: still drawn.

  Screenshots go in the relay log.
- **Recorded status.** The ROADMAP shipped entry says "implementation merged to the session branch; owner card pending; not physically qualified". It is not a release gate: the release rulings in DECISIONS (2026-09-27) are unchanged.
  - **The evidence record** (written into the hand-off log when the card is run):
    - the build version and commit;
    - the controller as shown in Kerf;
    - the material;
    - the exact Max power and speed used;
    - a photo of each burn;
    - PASSED, FAILED or INCONCLUSIVE per step.
  - **What "qualified" means:** only that the corrected presets produce the expected tonal direction on this machine and material. It is no general claim about laser safety.
- **Owner card** (`next`; Lee runs it, owner only, in the release build). Evidence is the visible mark on the material, and nothing about the beam beyond it (status-only ruling, DECISIONS 2026-09-10 as amended):
  - **Setup:**
    - scrap card or a 3 mm plywood offcut, on the bed with nothing under it that can burn;
    - the extraction or air assist the owner normally uses;
    - the machine's physical power switch or E-stop within reach;
    - the owner stays at the machine for the whole run.
  - **The recipe** (fixed; confirm every value on screen before each job):
    - material: scrap card;
    - image: a 40 × 10 mm black-to-white horizontal gradient;
    - power mode: Variable (M4); Max power 15%; Min power 0;
    - speed 3000 mm/min;
    - dither: Grayscale; interval 0.1 mm;
    - image adjustments neutral: brightness 0, contrast 0, gamma 1.0, invert off, background removal off;
    - passes: 1; only this layer enabled for output.

    The single permitted adjustment: if step 1 leaves no visible mark at all, raise Max power to 20%, regenerate, frame, and repeat once. Never above 20%, never slower than 3000 mm/min, and nothing else changes. If 20% still leaves no mark, record INCONCLUSIVE and stop. The material test is not part of this card.
  - **Frame first:** press FRAME and watch the head trace the bounding box.
  - **Before every burn:** press Generate after the last Apply, and make no edit while it generates. The guard marks such a result stale, but the card does not lean on it. Confirm that the button reads "Generate G-code", not "Regenerate G-code", before going on. Then press FRAME and watch the head trace the bounding box.
  - **Worst cases this card guards against:** a flame on the material; marking outside the framed box; marking that continues after the job ends; Kerf not responding to STOP.
  - **Before the card:**
    - identify, by tracing the wiring, the switch or plug that removes power from the laser module itself (expected: the machine's main power inlet, which feeds the controller and the module). If it cannot be identified with confidence, do not run the card;
    - have a fire extinguisher or fire blanket within reach;
    - the owner stays at the machine for every burn.
  - **Abort procedure:** on any worst case, press STOP, then cut the laser-module supply identified above. Kerf cannot confirm the beam is off; only that physical disconnect does. Note what happened, and do not re-run until it is understood.
  - **Steps:**
    1. Select the new S-Curve, then press Apply. Engrave. Pass: the black end is darkest, the white end unmarked, and darkness falls smoothly between them.
    2. The same, with Posterize. Pass: three distinct bands from dark to light, and the white end unmarked.
    3. **Legacy check, bounded.** Open `docs/owner-cards/tb3-legacy-s-curve.kerf`, which the relay commits with exactly the fixed recipe (15% Max power, 3000 mm/min, the other values above, and the old S-Curve points) on one 40 × 10 mm gradient, on one raster layer. If step 1 needed 20%, use 20% here too; that is the only allowed change. Do not open an arbitrary older project for this step. Before generating, re-check every recipe value on screen against the list above; if any differs, stop and do not run. Do not re-pick the preset. Generate, frame, engrave. Pass: it burns the old way (the white end darkest). That confirms nothing was migrated.
  - **Outcome:** PASSED, FAILED (a fix relay), or INCONCLUSIVE (any abort).

## Risks and rollback

- **Someone may rely on the inverted look.** They can draw it as a custom curve, and saved layers keep it anyway.
- **The structural raiser marks a result stale where nothing marked it before.** That happens only when an acceleration, feed-rate or laser-mode value actually changes after publication; usually it is the first connect after generating while disconnected. That result really was built from other values, so asking for a regeneration is correct, and the cost is one extra press. The G5 no-op rows prove that re-setting the same value on every connect does not stale anything.
- **Commit structure.** Each batch is its own commits on the relay branch: `tb3-guard` first, then `tb3` on top. They reach marvin/kerf-gap in one merge commit.
- **Rollback, three cases:**
  - **The preset fix only.** Revert `tb3`'s commits. That touches only `PowerCurveEditor.tsx`, its test, the Rust tests and goldens, the owner-card fixture and ROADMAP. It restores the old preset definitions and leaves the guard in place. Projects whose owner re-picked a corrected preset and saved keep the corrected raw points, because stored data is never rewritten in either direction. Those layers simply match no preset, so no highlight shows.
  - **Both batches.** `git revert -m 1 <merge>`.
  - **The guard alone.** First revert `tb3` (it depends on the guard), then `tb3-guard`. Reverting the guard restores `setGcodeResult` and the old handler, and removes `generationInputs.ts`, the two counters, the subscription and `generateGcode`'s parameter. The counters are runtime state and never saved, so no project file is affected either way. The race returns with it, so the Parking Lot line would be reopened.
- **No stored data in any direction.** `toProject`, `KerfProject` and the migrations are untouched. T5 and the N3 goldens pin that.

## Deferrals

The Parking Lot index line below was added with revision 3. At Stage 3.5 it becomes "(shipped …, kerf-power-curve-presets)", but only if G1-G9 pass and the battery kills m9-m16. Here is exactly what `tb3-guard` closes: a generation in flight while any of its twelve inputs changes, or while the project is replaced or a newer generation starts, can no longer publish as current; and a change to any input after publication marks the result stale. The line as indexed:

- **A generation that finishes after an edit publishes an outdated result as current** — `setGcodeResult` clears `gcodeStale` unconditionally (`store/index.ts:692`; called from `MachinePanel.tsx:386`), so an edit made during an in-flight generation leaves the older G-code looking current, and with no prior result the edit does not mark staleness at all. Pre-existing, not curve-specific; owned by UI polish TB6 (revision identity, stale-result handling, edit-during-generation). Found by astra on the TB3 plan, 2026-10-04. See `.claude/plans/kerf-power-curve-presets.md` → Diagnosis.

**TB6 keeps** the Preview regeneration and job-outcome work, plus removing the 15 now-redundant raisers. Stage 3.5 adds one new Parking Lot line, under TB6:

- **Export G-code writes a stale result without warning** — `exportGcode` (`fileOps/index.ts:469-489`) checks only that a result exists, so a file exported after an edit carries the older program. Pre-existing; a file, not a laser path in Kerf. Found re-verifying the TB3 plan, 2026-10-04. Owner: UI polish TB6.

UI polish A4 later restyles this editor (presentation only).

## Decisions

None for Lee. Everything here is technical, and the release-note wording is plain and true.

## Fold table: critic round 1 (astra, FAIL)

| finding | verdict | where addressed |
|---|---|---|
| 3 Completeness: Posterize and the Apply-to-raster path untested | FAIL | T4 Apply; T5 both legacy arrays plus both new presets through save/reopen/generate; N1/N2 Posterize levels |
| 4 Right-sizing: tier, graph and waiver | CONCERN | "Batch, tier and dependencies" (Standard, one batch, a written waiver, TB3 before A4, beside A1) |
| 6 Failure modes: null context, failed generation | CONCERN | Design 2 and T4 (null context: no plot, nothing applied); the generation snapshot is cited in the Diagnosis |
| 7 Change safety: rollback wording | CONCERN | Risks and rollback, rewritten |
| 8 Data integrity: parse-only check, private helper | FAIL | T5 on the real seams (`toProject` + JSON, `parseAndValidateProject`, `loadProjectWithMigrations`, exported `generateGcode`, the mocked invoke payload); N3 pinned-base goldens |
| 9 Verifiability: a grid-only stroke passes; the S-per-pixel oracle ignores compression | FAIL | T3 asserts arcs at the control points (m4 proves it); N2 spatial decoding with the LUT as an independent oracle; N3 captured at base and committed |
| 10 Maintainability: a non-exported helper, unspecified mutation targets | CONCERN | exported seams only; T2 fails on a missing or duplicate array; m1-m6 specified |
| X1 Physical safety: an unbounded owner burn | FAIL | the owner card: setup, ≤20% power, frame first, abort procedure, evidence limits, PASSED/FAILED/INCONCLUSIVE |
| X4 Copy: "four bands"; "pick again" omitted Apply | CONCERN | Design 1 (three bands plus white); the release note says pick, Apply, save |
| X5 Reopen, Cancel, Apply, generation snapshot | CONCERN | T3 reopen with changed points; T4 Cancel and Apply-once; the snapshot and `gcodeStale` cited in the Diagnosis |
| X6 Status: shipped vs pending vs qualified | CONCERN | Verification, "Recorded status" |

## Fold table: critic round 2 (astra, FAIL on X5 and X1)

| finding | verdict | where addressed |
|---|---|---|
| X5: a false claim that an older result is never published as current | FAIL | Diagnosis: the claim is corrected, and the `setGcodeResult` race is cited (store/index.ts:692, MachinePanel.tsx:386) as pre-existing; owned by TB6, with a new Parking Lot line. The owner card's prerequisite is Generate after Apply, with no edits during generation. TB3 adds no publication path. |
| X1: the legacy step could inherit arbitrary saved settings | FAIL | Owner card step 3 uses a dedicated bounded fixture (`docs/owner-cards/tb3-legacy-s-curve.kerf`) and re-checks every value on screen; the worst cases and physical isolation (the controller power switch) are named. |
| 3: the owner recipe was not reproducible | CONCERN | The Design bullet gives the full recipe (mode, max and min power, grayscale, interval, neutral adjustments, passes, speed source, one layer enabled) and regeneration before each burn. |
| 4: the file table omitted the goldens | CONCERN | The table lists all 8 files; the waiver covers the actual roots. |
| 6: the failed-regeneration path was untested | CONCERN | T4: an existing result, then Apply, then a rejected generate; it stays stale, shows the failure and dispatches nothing. |
| 9: arcs prove the handles, not the curve | CONCERN | T3 asserts the curve path and stroke and clears between opens; m7 removes only the curve block. |

## Fold table: critic round 3 (astra, FAIL on X1 and X5) — historical; revision 5 replaced the `designRevision` design below

| finding | verdict | where addressed |
|---|---|---|
| X5: a deferral instead of an enforced guard | FAIL | Design 5 and batch `tb3-guard`: a store `designRevision` raised at every existing staleness site, capture plus sequence at Generate, publication stale on mismatch and dropped when superseded; G1 to G5 cover no prior result, an existing result, out-of-order overlap and the source scan; m9 to m11 |
| X1: the material-test fallback escaped the cap; controller-switch isolation was asserted | FAIL | The owner card has a fixed recipe (15%, 3000 mm/min, scrap card) with one bounded adjustment to 20% and no material test. The laser-module supply disconnect is identified by wiring before the card. The card needs fire-suppression readiness. "Kerf cannot confirm the beam is off" |
| 3: the fixture recipe was owner-dependent | CONCERN | The committed fixture carries the exact fixed recipe, and the one allowed change is named |
| 4: shared ROADMAP integration | CONCERN | "File ownership against concurrent work": serialised merges, additive resolution |
| 9: the N2 oracle had no falsification check | CONCERN | m8 displaces or re-powers one segment, and N2 must fail on each |
| X4: the known issue was missing from the release notes | CONCERN | The race is now fixed, and the release-note line says so |
| X6: no evidence record | CONCERN | Verification, "The evidence record", and the scope of "qualified" |

## Fold table: critic round 4 (astra, FAIL on 2, 3, 8, 9, X1, X3, X5)

| finding | verdict | where addressed |
|---|---|---|
| 2: `setGrblSValueMax` missing from the raiser inventory | FAIL | The guard no longer depends on an inventory of edit sites. At publication it compares the twelve fields the generator actually reads (Design 5), and the compiler enforces that set (G10, m14). Power scale is G4 and a G5 row. |
| 3: `loadProject` replacement not invalidated | FAIL | `projectEpoch`, incremented by `loadProject` (the single path for Open, Open Recent, New and recovery); cross-project results are discarded (G3, m9, m10) |
| 4: `tb3-guard` roots without a waiver | CONCERN | "`tb3-guard` size and roots": 7 files, one `src` root, with the cross-directory atomicity stated; no TB6 work pulled in |
| 6: handler duties beyond publication unspecified | CONCERN | Design 5, "The handler, every duty specified": return value, console, sparse check, status, finally, per outcome; G6, G8, G9 |
| 7: "one commit" rollback not true for two batches | CONCERN | Risks and rollback: commit structure and the three revert cases, in dependency order |
| 8: an old project's result attached to the new one | FAIL | Discard on epoch mismatch: never published, current or stale (G3) |
| 9: the regex-count exhaustiveness claim | FAIL | G5 dropped. Replaced by deferred-promise behavioural tests per input key, in both phases, with a meta-assertion over `GENERATION_INPUT_KEYS`; the project replacement cases; remount and both completion orders; START and FRAME refusal through `JobActionBar`; mutants m9-m16 |
| 10: TB3 vs TB6 wording contradictory | CONCERN | T4 and the owner card no longer defer to TB6; Deferrals says exactly what closes and what TB6 keeps |
| X1: START/FRAME admit a cross-project or power-scale-stale result | FAIL | G1-G5 assert the refusal reason through `JobActionBar` with an otherwise eligible machine; G3 asserts "Generate G-code first" after replacement |
| X3: MaterialTestDialog misread as a publisher | FAIL | Diagnosis, "What is not a publication": a display-only predicate input; its generation is a local program with its own admission; no allowlist exists any more |
| X4: release note overclaims | CONCERN | Design 4's note now names design, machine settings and project replacement, and is written to the ROADMAP only after the guard tests pass |
| X5: counter lifetime and identity unspecified | FAIL | Both counters live in the store and are never reset or saved; one synchronous publication action; G6 and G7 cover remount, both orders and non-reuse |
| X6: closing the Parking Lot item against an incomplete guard | CONCERN | Deferrals: closed only when G1-G9 pass and m9-m16 are killed; discard and stale outcomes each get a console line (G9); export parked as a new TB6 line |
