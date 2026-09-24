# Relay plan: Canvas display fixes (code refresh 2026-09-22, group "Canvas display")

## Intent (grilled)

**Summary:** Canvas display bug fixes. After this relay:
- The bed outline and grid appear as soon as the app opens.
- The rulers come back when the grid is toggled off and on.
- Rotated text and images stay inside their selection boxes instead of jumping toward the top-left corner.
- A flipped image stays flipped when it is moved.
- Images from a project file or recovery appear instead of staying blank.
- The rotate handle is clickable when several objects are selected, and small objects can be dragged by their middle.
- The node editor puts its dots on the curve you actually see, even after the path has been rotated.

What reaches the laser does not change.
- F1-F6 do not touch stored geometry.
- F7 never changes a path's rotation. A no-op node selection leaves the generator's input byte-identical, and a test pins that.
- A real node edit changes only the node the operator moved. Every other node keeps its position on screen and in the cut, and the hatch stays relative to the part.

The canvas simply stops misrepresenting the cut.

**Skip note:** Intent derived from the 2026-09-22 code-refresh findings (core-2, core-3, core-6, core-7, core-9, core-10, core-11, core-16, core-17) and Lee's selection of this bug group the same day; no grill session.

**Key decisions:**
- **Rotation placement uses one formula for every kind of display object (core-2).** The formula is: pivot = (bbox centre − unrotated origin) / scale, and position = bbox centre. It gives today's exact result for Graphics and template-text Containers, where the origin is 0 and the scale is 1. It also becomes correct for Text and Sprite. The alternative was a separate branch per display type. That would have been four copies of the same idea, so it was rejected.
- **The rotation helper normalises itself.** It works out the unrotated origin from the current position, pivot and scale before placing the object. So calling it again, or calling it with rotation 0, is always correct. This also fixes a sibling defect found while re-verifying (see F3). The alternative was to require every caller to reset first. That gives the next caller a way to forget, so it was rejected.
- **Node editing on a rotated path is display-only (core-7, orchestrator direction round 2).** Nodes are drawn and hit-tested through the object's rotation, about the same centre gcode_gen.rs uses. Drag deltas are mapped back into the path's own frame with the inverse rotation. `transform.rotation` is never written by a node edit. When an edit changes the anchor bbox, all stored points get one uniform translation t = (I − R)(c₀ − c′). That keeps every untouched node exactly where it was on screen and in the cut, while the W1b invariant (transform equals the anchor bbox) still holds. Two alternatives were rejected:
  - Folding the rotation into the points (the round-1 design): on fill, fillLine and maskFill layers it changed the hatch from relative to the part to relative to the machine, so a node edit changed what gets engraved.
  - Editing in the local frame without the recentring translation: every edit that moves the bbox shifts the rotation centre, and the untouched nodes jump. Round 1 wrongly claimed this had no closed-form cure; t is that cure.
- **Images wait for decode, and nothing is drawn while an image is pending (core-10).** A decode failure shows the existing crossed-box placeholder. `Assets.load` was rejected because it caches by URL, and a data URL is megabytes long. Avoiding that was the explicit reason for the id-keyed cache (see the comment at Viewport.tsx:32).
- **All screen-pixel sizes go through one conversion, `screenPxToMm(px, zoom)` (core-6).** The rotate-handle offset becomes a shared constant used by both the drawing code and the hit test, so they cannot drift apart again. The operator-visible side effect is that the single-select rotate handle moves from about 75 px above the object to 20 px. That is the distance the code comments always intended, and it matches the multi-select handle.
- **The rotated-rectangle duplication (core-16) is collapsed only in Viewport's per-object selection outline.** That code sits in the same selection-overlay loop that F6 edits. `getSelectionBBox` and `hitTest`'s inverse rotation are not touched by any fix in this plan, so they stay. The group brief allows the collapse only where a fix touches the code.
- **Template-text fast path (found while verifying core-3): template text is rebuilt instead of moved in place.** Template texts are rare, and a rebuild is what every text did before P8. Updating the child positions correctly would mean rewriting the dashed-indicator geometry in two places.

## Context

These nine findings are one class of problem: DesignObject state that is translated wrongly into Pixi display state, or effects that miss the moment when their Pixi target appears. Each one makes the canvas disagree with the design, and so with the cut. The charter's core loop ends in Preview → Send. A preview that draws rotated text somewhere other than where it will be engraved (core-2) breaks the operator's only visual check before sending.

Files and overlaps:
- `src/components/viewport/Viewport.tsx` is shared by F1, F3, F4, F5, F6 and F7. To keep the diff to this file small, the testable logic moves into two new modules:
  - `src/components/viewport/renderHelpers.ts`, covering placement, flip and rotation.
  - `src/components/viewport/textureCache.ts`, covering decode-gated textures.

  Inside Viewport.tsx the edits are call-site swaps, dependency lists and a few added lines.
- **Expected overlap with the cut-vs-screen relay, which runs first and adds recursive nested-group rendering to Viewport.tsx.**
  - That relay rewrites the group loop in the objects effect (today at lines 308-325). It will probably also make the texture-eviction id collection (lines 337-346) recursive, and it may add a `group` case to `renderObject`.
  - This plan touches the same effect in four places:
    - the early-return guard (line 232)
    - the Graphics re-render branch inside `ensureDisplayObject` (lines 257-260, one line)
    - the fast-path branch (lines 262-268, a returned boolean)
    - the final eviction loop (lines 347-352, replaced by a single `evictTextures(activeImageIds)` call; the id-collection loop is left alone)

    It also adds to the dependency list (line 353).
  - The critic read refresh-cut-vs-screen.md and found the two plans' hunks disjoint, but only if that relay lands first. Its F1 replaces the loop body in Viewport.tsx, including today's top-level `visible` and `layers[obj.layerIndex]` checks, with `for (const leaf of drawnLeaves(obj, layers)) ensureDisplayObject(leaf.key, leaf.obj);`. It deletes `renderKey`, and replaces the texture-id walk with a recursive `collectImageIds`. `composedLeaves` and `drawnLeaves` both land in `geometry/index.ts`; only `drawnLeaves` is called from Viewport.tsx. None of this touches a line this plan edits.
  - **No hunk in this plan touches the `drawnLeaves` loop.** The per-leaf visibility rule and the layer lookup inside it belong to cut-vs-screen and stay as it left them. When re-reading moved line numbers, never paste the old top-level loop or its visibility checks back. `collectImageIds` walks every object regardless of visibility, so a hidden pending image is never evicted, and it loads the moment its layer is shown. `evictTextures(activeImageIds)` still fits after `collectImageIds` builds the set.
  - **Precondition, checked before F1. This relay runs strictly after cut-vs-screen has merged into `marvin/session-8b2728`; there is no separate branch to rebase onto.** Run `grep -nE 'composedLeaves|drawnLeaves' src/lib/geometry/index.ts` and `grep -n drawnLeaves src/components/viewport/Viewport.tsx`. Both must hit. If cut-vs-screen renamed the symbol while implementing, grep for the name it actually merged, found by reading the merged Viewport.tsx loop, and record the substitution in the Ted report. **If it does not, stop and report. Do not start on a base without it.** For this pair of relays, this rule supersedes the cut-vs-screen plan's "whichever lands second rebases".
  - Once the precondition passes, re-read every line number in this plan against the current files. The numbers here are from `67115ca`. The critic confirmed they still hold at `bc87e45`, but cut-vs-screen will move the objects effect.
- `src/lib/tools/toolHandler.ts` is shared by F6 and F7. The edits are limited to line-level changes in `hitTestHandle`, `handlePenDown`, `hitTestNodeHandles` and the four node-edit writers. **Do not split or restructure toolHandler.ts; that refactor was declined (core-18).**
- `src/lib/constants.ts` gains `screenPxToMm` and `ROTATE_HANDLE_OFFSET_PX`.
- `src/lib/geometry/index.ts` gains `pathPointsToWorld`, `worldDeltaToLocal` and `pointsPartialKeepingPlacement`. Commit `bc87e45` has since un-exported `composeGroupChildTransform` and `OrientedHandles`. This plan imports neither. It uses only helpers that are still exported: `orientedHandlePoints`, `rotatePathPoint`, `pointsBBox` and `pointsPartial`. cut-vs-screen will also add `composedLeaves` and `drawnLeaves` to this file. Add the three new helpers beside those additions without disturbing them.
- None of the remediation-owned files are needed. toolHandler imports `machine/connection`, but this plan does not edit it. Nothing was dropped for that reason.

## Fixes

### F1. Bed outline, grid and pre-existing objects are blank at launch (core-9)

**Diagnosis (re-verified):**
- `Viewport.tsx:109-174` runs `app.init()` asynchronously. Its `.then` creates the refs and calls only `setCamera` (line 154).
- Three draw effects run at mount, find their ref null and return:
  - grid (lines 185-186)
  - workspace (lines 216-217)
  - objects (lines 231-232)

  Their dependency lists (lines 213, 228, 353) do not contain anything that init changes, so they never run again.
- The only other writers of workspace size are the settings dialog, the Machine panel and `connection.ts:668` when a controller reports max travel. So on a fresh launch the bed stays blank until one of those fires.
- The drawing-object effect (lines 356-363) and the selection overlay (lines 366-635) have the same gap. The overlay reruns on `camera.zoom`, but init sets zoom to 1, which is usually unchanged.
- A second problem surfaced while designing the fix. main.tsx:78 renders under `React.StrictMode`, so in dev the init effect mounts twice. The cleanup of the first run is chained to `initPromise`, so app #1's `.then` still assigns every ref before app #1 is destroyed.
  - A naive ready flag would therefore fire effects against a destroyed app.
  - Cleanup also sets `appRef.current = null` without checking that the ref still points at the app being destroyed.

**Fix:**
1. Add `const [pixiReady, setPixiReady] = useState(false)`. It is a scalar, so it is safe from Error 185.
2. In the init effect:
   - declare `let disposed = false`
   - in `.then`, return immediately if `disposed || !canvasRef.current`, so app #1 in StrictMode never appends a canvas or assigns refs
   - call `setPixiReady(true)` as the last line of the setup
3. In the cleanup:
   - set `disposed = true` synchronously
   - inside the existing chained `.then`, always call `app.destroy(true)`
   - everything else in that `.then` goes inside one guard, `if (appRef.current === app) { … }`, so only the app that owned the state can clear it:
     - `appRef.current = null`
     - `displayCacheRef.current.clear()`, because its containers belong to the destroyed app
     - `contentHashCache.clear()`
     - `clearTextures()` (after F5; until F5 lands, the existing texture-cache clear)

   A StrictMode app that never went live therefore touches nothing that belongs to the surviving app. Today this is safe only because the two inits resolve in creation order; the guard removes that dependence.
4. Add `if (!pixiReady || !xRef.current) return;` and put `pixiReady` in the dependency list of these effects:
   - camera (lines 177-182)
   - grid
   - workspace
   - objects
   - drawing-object
   - selection overlay

   Referencing `pixiReady` inside each effect keeps `react-hooks/exhaustive-deps` quiet.

**Test:** New file `src/components/viewport/__tests__/viewportInit.test.tsx`.
- Use `vi.mock("pixi.js")` with a fake built the same way as F2's 2D context, so it does not break on the next call Viewport gains:
  - `Application`: each instance's `init()` returns its own deferred promise that the test resolves. It has `screen {width: 800, height: 600}`, `canvas` set to a real `<canvas>`, `stage` set to a fake Container, and a `destroy` spy. Instances are recorded in creation order.
  - `Container`, `Graphics`, `Sprite`, `Text` and `TextStyle`: each constructs a `Proxy` whose property reads return a cached spy per key.
    - Every spy returns the proxy itself, so calls chain.
    - Property writes are stored.
    - `children` is a real array maintained by `addChild`, `addChildAt`, `removeChild` and `removeChildren`.
    - `position`, `pivot` and `scale` are objects with a `set` spy.
    - Every constructed instance is recorded, with the Application whose `stage` subtree it was added to.
  - `Texture`: a stub with a `from` spy.
- Also apply the usual mocks: `@tauri-apps/api/core` (see toolHandler.test.ts:4) and `opentype.js` if the import chain needs it (see src/lib/__tests__/creatorInvariants.test.ts:62).
- Case 1: render `<Viewport/>`, then `await act(async () => resolveInit())`. Assert that the first Graphics created (the workspace) received `rect(0, 0, 500*PX_PER_MM, 300*PX_PER_MM)`, and that the grid Graphics received at least one `moveTo`.
- Case 2: render inside `<React.StrictMode>` and resolve both inits in order. Assert:
  - the first Application's canvas was never appended to the DOM
  - exactly one canvas is present
  - the live (second) app's workspace Graphics received the `rect` call
- **Case 3, out-of-order resolution. This is the only case that can see the `appRef.current === app` guard.** Case 2's in-order resolution runs app#1's cleanup before app#2 has drawn anything, so it passes with or without the guard.
  - Render inside `<React.StrictMode>` and resolve **init#2 first**.
  - `act` an `addObject` of one rectangle, so app#2 has one display object and a populated display cache.
  - Then resolve init#1 and flush its chained cleanup.
  - Then `act` an `updateObject` on the rectangle.
  - Assert:
    - app#2's `destroy` spy was never called
    - app#1's `destroy` was called once
    - app#2's objects container holds exactly one child for that rectangle's key, with no duplicate, which proves the display cache was not wiped out from under the live app
    - no Graphics that app#2 owns was destroyed
- **Red first:**
  - Run the test on today's code: Case 1 fails with zero `rect` calls.
  - After the fix, remove the `appRef.current === app` guard temporarily and run Case 3. It must fail with a duplicate child, or with app#2's objects container emptied. Record that output in the Ted report, then restore the guard.

**Risk:**
- Every canvas effect gains a dependency. `pixiReady` flips once, so each effect runs one extra time at startup and never again.
- The `disposed` guard changes behaviour only for a Pixi app that is already being unmounted.
- Chesterton: `git log -S"initPromise"` shows the cleanup chaining was added so that destroy waits for init. That is kept; this fix only adds the guard.

### F2. Rulers blank after a grid toggle (core-11)

**Diagnosis (re-verified):**
- `Rulers.tsx:206` returns null when `!gridVisible`, so pressing G twice unmounts and remounts both canvases.
- The draw effect (lines 180-183) depends on `[camera, drawHorizontal, drawVertical]`, and the resize-observer effect (lines 186-203) on the two callbacks. Neither dependency changes on a toggle.
- As a result the new canvases are never painted, and the ResizeObserver keeps watching the parents that were removed.

**Fix:** Add `gridVisible` to both effects' dependency lists and begin each with `if (!gridVisible) return;`. This is two lines per effect.

**Test:** New file `src/components/viewport/__tests__/rulers.test.tsx`.
- Stub `globalThis.ResizeObserver` with a class whose `observe` and `disconnect` are no-ops.
- Stub `HTMLCanvasElement.prototype.getContext` with a function that adds `this` to a `Set` of painted canvases and returns a fake 2D context built as a `Proxy`:
  - reading any property returns a cached `vi.fn()` for that key, so every method (`scale`, `fillRect`, `beginPath`, `moveTo`, `lineTo`, `stroke`, `fillText`, `save`, `restore`, `translate`, `rotate`, and whatever Rulers calls next) exists automatically
  - writing a property stores the value, so `fillStyle`, `font` and the rest can be assigned

  Do not enumerate the methods: an enumerated list breaks the next time Rulers gains a call.
- Render `<Rulers/>` with `gridVisible: true`, then use `act(() => useStore.setState({ gridVisible: false }))` followed by `act(() => useStore.setState({ gridVisible: true }))`.
- Assert that both canvases now in the DOM are in the painted set.
- **Red first:** the new canvases are absent from the set on today's code.

**Risk:** Rulers has a single consumer (App.tsx:259). There are no store writes.

### F3. Rotated text and images drawn at the wrong position, and a Graphics set back to 0° stays rotated (core-2, plus a sibling)

**Diagnosis (re-verified):**
- `applyObjectRotation` (Viewport.tsx:1185-1193) sets `pivot = position = (cx, cy)` in world pixels.
- Pixi maps local point p to `position + R·S·(p − pivot)`, where the pivot is in local units before scaling.
  - For Graphics and template-text Containers the geometry is in world coordinates at origin 0, so this is correct.
  - For a Text object (origin at `text.x = px`) or a Sprite (origin at px, scale = pw / texture width), the call overwrites `x`, and the object's local origin lands at c − R·c.
- Reproduced with the repo's pixi 8.16.0 under vitest jsdom (plan-writer probe, 2026-09-22). A 50×20 px text at (100, 100) rotated 1° draws its origin at (1.94, −2.16).
- Every rotation path hits this for text and images: the rotate handle, `]`/`[`, circular array, and nesting with rotation.

**Sibling defect, same function, found while re-verifying:**
- `applyObjectRotation` returns early when rotation is 0 (line 1187).
- The Graphics re-render path (lines 257-260) calls `clear()`, `renderObject()` and then `applyObjectRotation()` without resetting pivot, position or rotation.
- So a rectangle or path at 30° whose Rotation field is typed back to 0 (PropertiesPanel.tsx:297-300 writes `rotation: v`) keeps drawing at the old 30° about the old centre until a full rebuild.
- This is code-verified. The browser step below confirms it.

**Fix:**
1. Create `src/components/viewport/renderHelpers.ts`. The first commit is a pure move: `applyObjectRotation` and `applyTextImageTransform` move verbatim from Viewport.tsx and are imported back.
2. Add a pure, Pixi-free function to that module:
   ```ts
   export function rotationPlacement(
     cur: { x: number; y: number; scaleX: number; scaleY: number; pivotX: number; pivotY: number },
     t: { x: number; y: number; width: number; height: number; rotation?: number }
   ): { x: number; y: number; pivotX: number; pivotY: number; rotation: number }
   ```
   - The unrotated origin is `x0 = cur.x − cur.pivotX·cur.scaleX`, and likewise for y. This recovers the origin both when the pivot is 0 and after an earlier placement by this same function.
   - When rotation is 0, return `{x: x0, y: y0, pivotX: 0, pivotY: 0, rotation: 0}`.
   - Otherwise, with c the bbox centre in pixels, return `pivotX = (cx − x0) / scaleX` (0 if scaleX is 0), likewise for y, `x = cx`, `y = cy`, and rotation in radians.
3. Rewrite `applyObjectRotation(displayObj, t)` as a thin adapter. It reads x, y, scale and pivot from the display object, calls `rotationPlacement`, and writes the result back. It **no longer returns early at 0**.

No call site changes. The Graphics re-render branch becomes correct because the helper now normalises itself.

**Test:** New file `src/components/viewport/__tests__/renderHelpers.test.ts`.
- It imports real `Container`, `Graphics`, `Sprite`, `Texture`, `TextureSource` and `Point` from `pixi.js`. The probe confirmed that these construct and compute transforms under jsdom. `new Text()` does not, because it needs canvas text measurement, so text is modelled by a Container with the same x and scale.
- Helper for assertions: `c.updateLocalTransform(); c.localTransform.apply(new Point(u, v))`.
- **Text-like case:** Container at `x = px, y = py`, scale 1. Transform: 50×20 mm at (10, 10), rotation 30. Assert that local (0, 0) maps to the bbox top-left rotated 30° about the bbox centre, within 1e-6. Expected values come from `rotatePathPoint` in lib/geometry.
- **Flipped text-like case:** x = px + pw, scale.x = −1. Local (0, 0) maps to the rotated top-right corner.
- **Sprite case:** 200×100 `TextureSource`, `sprite.width = pw`, `sprite.height = ph`. The texture-space centre (100, 50) maps to the bbox centre, and local (0, 0) maps to the rotated top-left.
- **Graphics regression case:** the Graphics stays at origin 0, and world point (px, py) maps to its rotated position. This already passes today; it proves Graphics is unchanged.
- **Idempotence:** apply twice and get the same result.
- **Back to 0:** a Graphics placed at 30° and then placed at 0° ends with rotation 0, pivot (0, 0) and position (0, 0).
- **Pure tests of `rotationPlacement`:** the scale 0 guard, and rotation 0 returning the recovered origin.
- **Red first:** after the move commit (step 1) and before step 2, the text-like, flipped, sprite and back-to-0 cases fail. The Graphics case passes.

**Risk:**
- Callers are `ensureDisplayObject` (Viewport.tsx:260, 281, 301) and `applyTextImageTransform`.
- G-code has its own rotation math (gcode_gen.rs:1328-1338 rotates about `x + width/2`, the same centre), so the cut is unaffected.
- Chesterton: `applyObjectRotation` dates from the founding commit 36aed44 (2026-02-23). At that point only Graphics were rotated. Text and Sprite reached it later without the frame being revisited.

### F4. Moving a flipped image un-flips it; moving a template text leaves its frame behind (core-3, plus a sibling)

**Diagnosis (re-verified):**
- `applyTextImageTransform`, Sprite branch (Viewport.tsx:1136-1150): it writes `displayObj.width = pw`, then applies `scale.x *= -1` when `scaleX < 0`.
- Pixi 8's width setter keeps the current sign of `scale.x`.
- Reproduced under vitest jsdom with pixi 8.16.0. After a flip the scale is −0.5; the fast path's width write keeps −0.5, and `*= -1` makes it +0.5, which is un-mirrored and shifted by +pw.
- Flipping *back* also fails. With `scaleX` at +1 the branch skips its toggle, so the sprite stays mirrored.
- This path runs on every drag, nudge, align and flip of an image, because `contentHash` (line 1117) excludes the transform.

**Sibling defect, same function:**
- The template-text Container branch (lines 1168-1176) sets every Text child's position to `(px, py)`:
  - it ignores the flip offset that `renderTextObject` applied (lines 1381-1390)
  - it never moves the dashed indicator Graphics (lines 1397-1403), which is drawn at world coordinates

  So moving template text such as `{serial}` leaves its orange frame at the old position, and a flipped template jumps by −pw.
- Code-verified. The browser step confirms it.

**Fix:** In renderHelpers.ts:
1. Add `placeSprite(sprite, t)`:
   - reset pivot and rotation
   - set `width = pw` and `height = ph`
   - then set the sign absolutely: `sprite.scale.x = Math.abs(sprite.scale.x) * (sx < 0 ? -1 : 1)`, likewise for y
   - set `x = px + (sx < 0 ? pw : 0)`, likewise for y
2. Call `placeSprite` from both `applyTextImageTransform`'s Sprite branch and `renderImageObject` (which moves into renderHelpers.ts in F5). This gives one placement path for creation and moves.
3. Change `applyTextImageTransform` to return `boolean`: `true` for Sprite and Text, and `false` for any other Container, meaning "cannot update in place".
4. In `ensureDisplayObject` (Viewport.tsx:264-268), take the fast path only when it returns `true`. Otherwise fall through to the existing destroy-and-rebuild code.

**Test:** In `renderHelpers.test.ts`:
- **Flipped image, moved twice:**
  - Create a sprite through the create path with `scaleX: -1`, then call `applyTextImageTransform` twice with new x values.
  - After each call assert that `scale.x < 0`, that local (0, 0) maps to (px + pw, py), and that local (texW, 0) maps to (px, py).
- **Flip back:** `scaleX: -1` followed by `scaleX: 1` gives `scale.x > 0`.
- **Template container:** `applyTextImageTransform(new Container(), obj)` returns `false`. On today's code it returns `undefined`, so `toBe(false)` fails.
- **Red first:** after the F3 move commit and before this fix, the moved-twice and flip-back cases fail.

**Risk:**
- `applyTextImageTransform` has one caller (Viewport.tsx:266).
- Template text now rebuilds on move. That costs one Text rasterisation per drag frame, but only for template texts; ordinary text and images keep the fast path.
- Chesterton: the P8 fast path, ebe621b (2026-05-23), was a performance change. It is kept for the display types it handles correctly.

### F5. Images whose data URL was not yet decoded stay blank for the object's lifetime (core-10)

**Diagnosis (re-verified):**
- `getOrCreateTexture` (Viewport.tsx:38-46) does `new Image(); img.src = data; Texture.from(img)` synchronously and caches the result by object id.
- Pixi 8's `ImageSource` (node_modules/pixi.js/lib/rendering/renderers/shared/texture/sources/ImageSource.mjs) has no load listener, so a texture made from an image that has not loaded never gains pixels. Every later render reuses the cached empty texture.
- The import dialog escapes this because its preview `<img>` decodes the same URL first.
- The cases that go blank:
  - opening a .kerf file
  - restoring from recovery
  - undo that brings back a deleted image
  - HMR
- Also, the `catch` fallback in `renderImageObject` (lines 1458-1471) returns a bare `Graphics`. The next render sends it down the vector branch (`existing instanceof Graphics`, line 257), and `renderObject` has no `image` case, so the placeholder is wiped blank.

**Fix:**
1. Create `src/components/viewport/textureCache.ts`. The first commit is a behaviour-preserving move, and it must compile. `textureCache` is iterated directly in two places outside `getOrCreateTexture`: the eviction loop (Viewport.tsx:347-352) and the init cleanup (lines 168-169). So the move commit ships:
   - `getOrCreateTexture`, unchanged
   - `evictTextures(activeIds)`, with the exact body of today's eviction loop
   - `clearTextures()`, with the exact body of today's cleanup clear

   It switches both Viewport call sites to those two functions in the same commit. The `Map` itself stays module-private. The F5 red-first proof then runs against a compiling tree whose behaviour is identical to today's.
2. Then replace it with a decode-gated API:
   - `getReadyTexture(id, dataUrl): Texture | null`
     - Returns the cached texture if there is one.
     - Returns null if a load for this id is pending or has failed.
     - Otherwise it starts a load and returns null. The load uses `img.decode()`, falling back to an `onload`/`onerror` promise when `decode` is missing. On success it caches `Texture.from(img)` and calls the ready listener. On rejection, check `img.complete && img.naturalWidth > 0` first. Chromium's `decode()` can reject for an image it will still display, such as a very large source. If that check is true, treat the load as a success. Only otherwise record the id in a `failed` set; either way, call the listener.
   - `isTextureFailed(id)`
   - `setTextureReadyListener(fn | null)`
   - `evictTextures(activeIds: Set<string>)`, which destroys cached textures and forgets pending and failed ids not in the set
   - `clearTextures()`, which destroys every cached texture, **forgets every pending and failed id**, and bumps a generation counter

   Lifecycle rules for pending marks. Without them, an id can be stuck returning null forever. HMR is exactly that path: `textureCache.ts` keeps its module instance while Viewport.tsx reloads and calls `clearTextures()` with loads in flight.
   - Each load captures the generation it started under.
   - A load that resolves or rejects under an old generation destroys its texture, if any, and does nothing else. It does not write to the cache, the pending set or the failed set; `clearTextures()` has already cleared its pending mark. It does not call the listener.
   - A load whose id was evicted while it was pending (no longer in the pending set when it resolves) destroys its texture and does not cache it.
   - Only a current-generation load that is still pending writes a result, and it deletes its own pending mark first.
   - Net effect: after `clearTextures()` or eviction, the next `getReadyTexture` for that id always starts a fresh load.
3. Move `renderImageObject` into renderHelpers.ts:
   - if `getReadyTexture` gives a texture, build a Sprite and call `placeSprite`
   - if `isTextureFailed(id)`, return the crossed-box placeholder **wrapped in a `Container`**, so later renders take the hash path and do not wipe it
   - otherwise return `null`, so nothing is drawn while pending and nothing is cached. The existing `if (el)` guards at Viewport.tsx:279 and 300 already handle null.
4. In Viewport:
   - add `const [textureTick, setTextureTick] = useState(0)`, a scalar
   - add an effect `useEffect(() => { setTextureReadyListener(() => setTextureTick((n) => n + 1)); return () => setTextureReadyListener(null); }, [])`, **declared above the objects effect**. React runs effects in declaration order, so the listener is guaranteed to be in place before the first objects render can start a load. The guarantee then comes from position rather than from timing (today it also holds because the objects effect waits on `pixiReady`).
   - add `textureTick` to the objects effect's dependency list
   - replace the eviction loop at lines 347-352 with `evictTextures(activeImageIds)`
   - replace the cleanup's cache clear at lines 168-169 with `clearTextures()`

**Test:** New file `src/components/viewport/__tests__/textureCache.test.ts`.
- Stub `HTMLImageElement.prototype.decode` with `vi.fn()` returning a deferred promise that the test controls, and restore it afterwards.
- **Pending then ready:**
  - `getReadyTexture("a", url)` returns null and the listener has not been called
  - resolve the decode and flush microtasks
  - the listener has been called once, `getReadyTexture("a", url)` returns a `Texture`, and a second call returns the same instance
  - `decode` was called once, so there is no duplicate load
- **Failure:** reject the decode with the image not complete; `isTextureFailed("a")` is true and the listener was called.
- **Rejected but displayable:** reject the decode after stubbing `complete` as true and `naturalWidth` as 200 on the instance. `isTextureFailed("a")` is false, and `getReadyTexture("a", url)` returns a `Texture`.
- **Stale generation:** start a load, call `clearTextures()`, then resolve. The cache stays empty, the texture made by the stale load (if any) was destroyed, and the listener was not called.
- **New load after `clearTextures()`:**
  - start a load for "a", call `clearTextures()`, resolve that first decode and flush
  - `getReadyTexture("a", url)` returns null and starts a **new** load: `decode` has now been called twice
  - resolve the second decode; `getReadyTexture("a", url)` returns a `Texture`
  - this is the test that catches a stuck pending mark
- **Evicted while pending:** start a load for "a", call `evictTextures(new Set())`, resolve. The cache stays empty, and the next `getReadyTexture("a", url)` starts a new load.
- In `renderHelpers.test.ts`, test `renderImageObject` in three states:
  - pending returns null
  - ready returns a Sprite placed by `placeSprite`
  - failed returns a `Container` that is not a `Graphics`
- If `Texture.from` of a jsdom image misbehaves, `vi.spyOn(Texture, "from")` and return a `Texture` built on a 200×100 `TextureSource`.
- **Red first:** after the move commit, "returns null before decode resolves" fails, because the old function returns a texture synchronously.

**Risk:**
- The only caller is `renderImageObject`.
- A newly added image is invisible for the few milliseconds its decode takes. In the import-dialog path the URL is already decoded, so the gap is effectively zero.
- Each finished decode reruns the objects effect once. With an empty dirty set that redraws every Graphics once per image load, which is acceptable at that frequency.
- **Pending has no timeout.** A `decode()` that never settles leaves that id blank, drawn as nothing, until the next `clearTextures()`: an app reload, or an HMR in dev. This is accepted, given how rarely a data-URL decode would hang, and it is stated here so that it is known behaviour rather than a surprise. A hung decode never blocks other images or any other part of the canvas.
- Adjacent issue observed and **not** fixed here: the texture cache is keyed only by object id, and `contentHash` samples only the first 50 characters of the data URL. So replacing an object's `imageData` in place under the same id would not refresh the texture. No current writer is known to do that. Out of scope.

### F6. Select-tool handle hit sizes, the rotate-handle offset, pen close and node hit radii are screen pixels treated as millimetres (core-6, with the core-16 outline collapse)

**Diagnosis (re-verified):**
- The tool handlers receive world coordinates in **mm**; Viewport divides by `PX_PER_MM` at lines 732, 766 and 844.
- Yet these sizes are only divided by zoom, which makes them 3.78× their intended screen size:
  - toolHandler.ts:351: `handleSize = 12/zoom`, with the comment "12 screen-pixel hit target"
  - line 353: `rotateOffset = 20/zoom`, with the comment "mm"
  - line 403: `rotHandleY = bbox.y − 20/zoom`
  - line 1343: `PEN_CLOSE_RADIUS / zoom`, with the comment "screen pixels" at line 49
  - line 1506: `NODE_HIT_RADIUS / zoom`, with the comment "screen pixels" at line 50
- Viewport draws the multi-select rotate circle 20 **px** above the bbox (line 509), but the hit test looks 20 **mm** (75.6 px) above it. A click on the visible circle lands within ±6 mm of the top edge and returns `"n"`, which starts a vertical resize.
- Corner hit boxes are ±6 mm, so every selected object smaller than about 12 mm at zoom 1 is covered by corner zones and cannot be moved by its body.
- The single-select rotate handle is consistent only because Viewport line 434 passes the same mm value to `orientedHandlePoints`, so it is drawn 75 px out.
- Chesterton: 3c0e40f (2026-05-23) changed `Math.max(6, 8/zoom)` to `Math.max(12, 8)/zoom`. Its intent was screen pixels. The unit slip goes back to the founding commit.
- Sweep of `/ zoom` sites outside Viewport:
  - **Excluded:** measure.ts `snapThresholdMm`, which is already correct at `8/(zoom·PX_PER_MM)`.
  - **Excluded:** `SEGMENT_HIT_TOLERANCE_MM`, which is millimetres by design (documented at toolHandler.ts:52-55).
  - **Not audited:** the canvas-2D line widths in JobPreview.tsx, which have their own transform and are outside this finding.

**Fix:**
1. In `src/lib/constants.ts` add:
   - `export const ROTATE_HANDLE_OFFSET_PX = 20;`
   - `export function screenPxToMm(px: number, zoom: number): number { return px / (zoom * PX_PER_MM); }`
2. In toolHandler.ts:
   - `handleSize = screenPxToMm(12, zoom)`. This replaces the whole expression `Math.max(12, 8) / zoom` at line 351; a search for `12 / zoom` will not find it.
   - `rotateOffset = screenPxToMm(ROTATE_HANDLE_OFFSET_PX, zoom)`
   - multi-select `rotHandleY = bbox.y − rotateOffset`
   - pen close: `dist < screenPxToMm(PEN_CLOSE_RADIUS, zoom)`
   - node hit: `hitRadius = screenPxToMm(NODE_HIT_RADIUS, zoom)`
3. In Viewport.tsx:
   - line 434: `rotateOffsetMm = screenPxToMm(ROTATE_HANDLE_OFFSET_PX, camera.zoom)`
   - line 509: `rotY = by − ROTATE_HANDLE_OFFSET_PX / camera.zoom`, which is in pixels and unchanged in value but now uses the named constant
4. **core-16 collapse, in this same overlay loop:** replace the per-object rotated-outline corner math (lines 386-402) with `orientedHandlePoints(t, 0)`. Convert its `nw`, `ne`, `se` and `sw` to pixels and stroke the closed polygon. The unrotated `g.rect` branch stays.

**Test:** New file `src/lib/tools/__tests__/screenUnits.test.ts`. Mock `@tauri-apps/api/core` and reset the store as toolHandler.test.ts:4-6 and 41-51 do, with camera zoom 1.
- **Multi-select rotate is clickable:**
  - two rects, both selected
  - `hitTestHandle(bbox.x + bbox.w/2, bbox.y − screenPxToMm(20, 1), 1)` returns `"rotate"`
  - today it returns `"n"`
- **Small object body is a move target:**
  - one 5×5 mm rect at (0, 0), selected
  - `hitTestHandle(2.5, 2.5, 1)` returns `null`
  - today it returns `"nw"`
- **Single-select rotate at its drawn position:**
  - `orientedHandlePoints(t, screenPxToMm(ROTATE_HANDLE_OFFSET_PX, z)).rotate` hits `"rotate"` for z = 0.5, 1 and 4
  - also, a point 20 mm above the top centre at zoom 1 returns `null`
- **Zoom invariance:** at zoom 4, a point 5 screen px from the `se` corner (`screenPxToMm(5, 4)` mm) hits `"se"`. A point 8 screen px away does not.
- **Pen close:**
  - drive the pen through `handleViewportPointerDown`/`Up` at (10,10), (40,10) and (40,30), as src/lib/__tests__/creatorInvariants.test.ts:701-713 does
  - a click at (14, 10), which is 4 mm or 15 px away, must **not** close: the store has no objects yet
  - a click at (11, 10) then closes it: one object, `closed: true`
  - today the 4 mm click closes
- **Node hit:**
  - path (10,10), (40,10), (40,40) with `nodeEditState.pathId` set
  - `hitTestNodeHandles(14, 10, 1)` returns `null`; today it returns index 0
  - `hitTestNodeHandles(11, 10, 1)` returns index 0
- **Red first:** write the file before the fix and run it. The multi-select, small-object, single-select-rotate, zoom-invariance, pen and node cases fail.
- Existing tests affected:
  - toolHandler.test.ts:161-221 still passes: the `se` hit is exact, and the multi-select check is at (50, 50).
  - **pathWriters.test.ts:252-266 must be updated.** "Undo after rotate restores the rotation field" presses the rotate handle at `(20, -10)`, which is 20 mm above the top of a bbox whose top edge is at y = 10. That position encodes the defect. Change the press point to `(20, 10 - screenPxToMm(ROTATE_HANDLE_OFFSET_PX, 1))` and fix the comment on line 257. The test's assertions stay unchanged.
  - pathWriters.test.ts:302 and 404 pass `rotateOffset` 20 to `orientedHandlePoints` but read only `e`, `w` and the corners, which do not depend on the offset. Only the comments on those lines are stale; correct them.
  - Any other failure in the full suite that traces to a rotate-handle, handle-hit or pen-close position is the same encoded defect. Fix it the same way (a position change only, never a weakened assertion) and list it in the Ted report.

**Risk:**
- `hitTestHandle` has two callers: the cursor hover (Viewport.tsx:791) and `handleSelectDown` (toolHandler.ts:506).
- Handles become harder to grab at very low zoom, but that is the intended size: a 12 px target.
- The single-select rotate handle moves closer to the object on screen. This is visible to the operator and is called out in Intent.
- A rotated object's selection outline must still coincide with its handles. It does by construction, since both now come from `orientedHandlePoints`.

### F7. Node editor ignores rotation: nodes drawn and hit-tested off the visible curve, and the shape shifts while editing (core-7)

**Diagnosis (re-verified):**
- Rotating a single object writes `transform.rotation` for paths (toolHandler.ts:785-798). The canvas rotates the Graphics about the transform centre, and so does the cut (gcode_gen.rs:1328-1338 for outlines). The fill and maskFill arms (gcode_gen.rs:882-975 and 1152-1190) also add `obj.rotation` to the hatch angle, so the hatch runs relative to the part.
- The node overlay draws raw `obj.points` (Viewport.tsx:528-563), and `hitTestNodeHandles` tests raw points (toolHandler.ts:1509-1526). On a rotated path the dots float where the unrotated path would be.
- The node writers apply the world-frame mouse delta directly to the stored points, which are in the unrotated local frame. They then call `pointsPartial(obj, newPoints)`, which keeps the rotation but recomputes the bbox. The four writers are:
  - move (line 1645)
  - delete (lines 1674-1677)
  - toggle-smooth (lines 1753-1757)
  - `handleNodeDown`'s `originalPoints` snapshot (lines 1543-1547)

  Two things go wrong on a rotated path:
  - the dragged node moves in the wrong direction on screen, because the delta is never rotated into the local frame
  - recomputing the bbox moves the rotation centre, so every other node jumps
- Node editing can be entered from `handleNodeDown` (line 1567), `handleToolChange` (line 1883) and double-click. The fix below does not depend on how it was entered.

**Design: display-only (orchestrator direction, round 2).** `transform.rotation` is never changed by a node edit, and the stored points are never re-expressed in another frame.
- **Why not fold the rotation into the points.** The round-1 plan folded the rotation into the points at the first edit. Round 2 showed that this changes the cut on fill, fillLine and maskFill layers: with rotation 0 the hatch becomes relative to the machine instead of the part. A node edit must not change what gets engraved, so the fold is dropped.
- **Drawing and hit-testing** map the stored points forward through the object's rotation, about the same centre gcode_gen.rs uses.
- **Writing** maps world deltas back into the local frame with the inverse rotation.
- **One required addition: a uniform recentring translation.** Some edits change the bbox of the anchors: a node move, or a delete. That moves the rotation centre from c₀ to c′, and every untouched node would jump by (I − R)(c′ − c₀) on screen and in the cut. That jump is the second symptom of core-7. The fix translates all stored points by one vector, t = (I − R)(c₀ − c′), where R is the object's rotation, c₀ is the bbox centre before the edit, and c′ is the bbox centre of the edited points.
  - Translating every point by t moves the new bbox centre by exactly t. So after it, every untouched node's world position is exactly what it was before the edit, and the dragged node lands at its old world position plus the world delta.
  - The formula is closed-form. The round-1 plan wrongly said no closed form existed; that claim is withdrawn.
  - When the rotation is 0, or the anchor bbox does not change (handle drags, toggle-smooth), t is exactly 0, and the write is identical to today's `pointsPartial`.
  - Checked numerically at plan time: 30°, world drag (25, −7) on node 2 of the F7 fixture. Untouched nodes moved at most 7.1e-15 mm; the dragged node landed within 1.0e-14 mm of target.
- **Feasibility: display-only is feasible.** Stored points still change by one uniform translation t on top of the edit itself. This is not a re-basing: the frame, the rotation and the relative geometry of the untouched nodes are all preserved. It is the only way to keep the W1b invariant (transform equals the anchor bbox, asserted by `assertPointsInvariant`) while the rest of the shape stays still. Pinning the bbox to the old centre instead would break that invariant, which is a standing W1b rule, so it was not considered.

**Fix:**
1. In `src/lib/geometry/index.ts`, add three pure functions beside `rotatePathPoint`:
   - `pathPointsToWorld(obj: DesignObject): PathPoint[]`
     - returns `obj.points` itself when `rotation` is 0 or there are no points
     - otherwise returns every anchor and handle mapped through `rotatePathPoint` about `(t.x + t.width/2, t.y + t.height/2)`
     - display and hit-testing only; never written back
   - `worldDeltaToLocal(dx: number, dy: number, rotationDeg: number): { x: number; y: number }`: the inverse rotation of a vector
   - `pointsPartialKeepingPlacement(obj: DesignObject, points: PathPoint[], centreBefore: { x: number; y: number }): GeometryPartial`
     - computes c′ from `pointsBBox(points)` and t = (I − R)(centreBefore − c′)
     - translates every anchor and handle by t, then returns `pointsPartial(obj, translated)`
     - `pointsPartial` spreads `obj.transform`, so the rotation is carried through unchanged
     - at rotation 0, t is exactly (0, 0) and the result deep-equals `pointsPartial(obj, points)`
2. Viewport node overlay (line 528): `const pts = pathPointsToWorld(pathObj);`.
3. `hitTestNodeHandles`: iterate `pathPointsToWorld(obj)`. Indices are unchanged, because the mapping preserves order and length.
4. `handleNodeDown`:
   - keep snapshotting `originalPoints` from the stored local `obj.points`, as today
   - also store `nodeDrag.centreBefore` = the transform centre at drag start
   - also store `nodeDrag.rotation` = `obj.transform.rotation`
5. `handleNodeMove`:
   - compute the world delta as today, then `const d = worldDeltaToLocal(dx, dy, nodeDrag.rotation)`
   - apply `d` wherever the code applies `dx, dy` today: to the anchor and both handles for a node drag, or to the dragged handle for a handle drag
   - handle mirroring stays in the local frame, which is correct because a reflection through the anchor commutes with rotation
   - write `pointsPartialKeepingPlacement(obj, newPoints, nodeDrag.centreBefore)`
   - every frame is computed from `originalPoints` and `centreBefore`, so nothing accumulates across frames
6. `deleteSelectedNode`: filter the stored points as today, then write `pointsPartialKeepingPlacement(obj, filtered, currentCentre)`.
7. Double-click toggle-smooth: generate handles from the stored local points as today. Handle generation is rotation-equivariant, since it uses only neighbour directions and distances. Write through `pointsPartialKeepingPlacement(obj, newPoints, currentCentre)`; t is 0 here because anchors do not move, and routing through one helper keeps the four writers uniform.

Every write stays inside the writer's existing undo boundary: `beginPropertyEdit` for a drag, `withUndo` for delete and toggle. `transform.rotation` is never written, so undo and redo can never produce a mixed state.

**Test:**
- In `src/lib/geometry/__tests__/pointsGeometry.test.ts` (existing file), add a `describe("node edit on rotated paths (F7)")` block:
  - `pathPointsToWorld` returns the same reference at rotation 0. At 30° it equals `rotatePathPoint` of every anchor and handle about the transform centre, with expected values computed inline from that function.
  - `worldDeltaToLocal(dx, dy, 30)` rotated forward by 30° returns (dx, dy) within 1e-12.
  - **Same change as in the unrotated frame (orchestrator requirement).** Fixture: path (10,10), (40,10) with `handleOut: (60, −20)`, (40,40), at 30°. Node 1's `handleOut` deliberately overshoots the anchor bbox, which spans 10-40 on each axis. Apply world drag Δ = (25, −7) to node 2, which is large enough to change the bbox.

    The overshooting handle is load-bearing. Round-3 critic measurement: an implementation that computed c′ from a bbox including the handles would displace node 0 by 4.7 mm in world space. A handle-free fixture cannot tell that from the correct anchors-only centre, because for it the two bboxes are identical. With the handle present, both that failure and the "every anchor and handle" clause below become testable. Let L = `worldDeltaToLocal(Δ, 30)` and U be the unrotated-frame result: the same points with node 2 moved by L. Assert that the stored result equals U plus one uniform translation, and nothing else:
    - `result[i] − U[i]` is the same vector for every anchor and handle, within 1e-12
    - that vector equals (I − R)(c₀ − bboxCentre(U)) within 1e-12, where `bboxCentre` is the anchors-only centre from `pointsBBox`, never a handle-inclusive one
    - node 1's `handleOut`, mapped to world, is unchanged within 1e-9, so the handle rides along with its anchor
    - **Tolerance provenance, written as a comment above these assertions:**
      - measured at plan time: the formula's own error on this kind of fixture is at most 7.1e-15 mm (world, untouched anchors and handle; round-3 critic run)
      - 1e-12 is asserted on stored-frame differences, a margin of about three orders of magnitude
      - 1e-9 is asserted on world positions, a margin of about six orders of magnitude, to absorb the extra forward rotation
      - none of these is a guess; tightening either is fine, but loosening it needs a measurement

    Why not exact equality with U: identical stored points would require the rotation centre not to move, which contradicts the W1b invariant. The uniform translation is the only difference, and the test pins its exact value.
  - **World placement:** mapped through `pathPointsToWorld`, the untouched nodes of the result sit exactly where they sat before (within 1e-9), and node 2 sits at its old world position + Δ.
  - At rotation 0, `pointsPartialKeepingPlacement(obj, pts, c)` deep-equals `pointsPartial(obj, pts)`.
- New file `src/lib/tools/__tests__/nodeEditRotation.test.ts`:
  - Set up the store as in the harness at `src/lib/__tests__/creatorInvariants.test.ts:846-930`: copy its store reset and path factory. Import `assertPointsInvariant` from the shared helper `src/lib/geometry/__tests__/pointsInvariant.ts`, as creatorInvariants already does; that shared helper is the exemption to "do not import across directories".
  - Fixture: path (10,10), (40,10), (40,40) with a synced transform and rotation 30°. Visible positions come from `pathPointsToWorld(obj)`. Use 30° rather than 90°: at 90° a rotated node coincides with a different raw node, which would mask the defect.
  - `hitTestNodeHandles(visible0)` returns index 0. Today it returns `null`.
  - **Drag:**
    - pointer-down at visible2, move by world (+5, +3), then up
    - afterwards: `transform.rotation` is still exactly 30
    - through `pathPointsToWorld`, node 2 is at visible2 + (5, 3), and nodes 0 and 1 are at visible0 and visible1 within 1e-9
    - `assertPointsInvariant` passes
    - one `undo()` restores the original object deep-equal
  - **Delete:** select node 2 and call `deleteSelectedNode()`. Rotation stays 30, and the remaining nodes, mapped to world, are at visible0 and visible1.
  - **Toggle-smooth:** double-click at visible1. Node 1 gains handles, its world anchor stays at visible1, rotation stays 30, and the stored anchors are unchanged.
  - **Handle drag.** Without this case, the handle-drag writer (inverse-rotated delta, mirror in the path's own frame, t = 0) would be covered only by a browser step.
    - Continue from the toggle-smooth case.
    - Press on node 1's world-space `handleOut`, taken from `pathPointsToWorld(obj)[1].handleOut`, move by world (5, 3), and release.
    - Assert that `handleOut`'s world position moved by exactly (5, 3), within 1e-9.
    - Assert that `handleIn`'s world position is the reflection of `handleOut` through node 1's world anchor, `2·anchor − handleOut`, within 1e-9.
    - Assert that all three anchors, in both world and stored coordinates, are unchanged within 1e-9, and that rotation stays 30.
    - Red on today's code: the stored handle moves by the un-rotated delta, so its world position is off by about 3 mm for this drag.
- **G-code byte-identity after a no-op node selection**, in the same file. Use the Rust-contract mock pattern from `src/lib/machine/__tests__/gcodeGen.test.ts:8-60`, which mocks `invoke` and captures the `generate_gcode` arguments.
  - Put the 30° fixture on a **fill** layer.
  - Call `generateGcode()` and capture the complete `generate_gcode` argument object as `JSON.stringify(args)`.
  - Enter the Node tool, press on visible1, move by (0, 0), release. Call `generateGcode()` again and capture the arguments again.
  - Assert the two strings are identical.
  - Honest scope: this proves the input to the Rust generator is byte-identical. The G-code bytes come from deterministic Rust given that input, and running Rust from vitest is not possible. State it that way in the test comment.
  - A second assertion in the same test, after a real drag of node 2: the object in the payload still carries `rotation: 30`. The hatch therefore stays relative to the part, and the orchestrator's concern (hatch turning machine-relative) cannot arise.
- **Red first:** write both test files before the fix.
  - The new geometry functions do not exist yet. For the red run, stub them with today's behaviour: `pathPointsToWorld` returns `obj.points`, `worldDeltaToLocal` returns the input unchanged, and `pointsPartialKeepingPlacement` calls `pointsPartial`.
  - With those stubs, these cases fail: the unrotated-frame test, the world-placement test, the hit test, node drag, handle drag, delete and toggle-smooth.
  - The no-op G-code test passes today and must keep passing. It guards against a regression that folds the rotation or re-bases the points, and it was confirmed green, not red, before the fix.

**Risk:**
- The three helpers are new, and their only callers are listed above.
- At rotation 0 every path through them is identical to today (t = 0, identity reference), so the existing unrotated node tests (`src/lib/__tests__/creatorInvariants.test.ts:872-929`) are unaffected.
- `transform.rotation` is never written by node edits, so:
  - the fill, fillLine and maskFill hatch stays relative to the part
  - the Rotation field keeps its value
  - the selection box and click target keep their rotated frame

  There is no operator-visible side effect beyond the fix.
- Worst physical case: none. Untouched geometry keeps its world position to floating-point precision, as the world-placement test pins. The rotation and hatch are unchanged, as the payload test pins. The edited node goes where the operator dragged it, as it does on an unrotated path today.

### core-17 (test net), covered inside F1-F7

No separate fix is needed. The helpers the fixes change are extracted, and every one has a test:
- `rotationPlacement`, `applyObjectRotation`, `placeSprite`, `applyTextImageTransform` and `renderImageObject` in renderHelpers.ts
- the texture lifecycle in textureCache.ts
- the init wiring through a mocked-Pixi component test
- the Rulers remount

`renderObject`, `renderTextObject` and `contentHash` stay in Viewport.tsx and remain untested:
- `renderObject` is likely to change in the cut-vs-screen relay.
- `new Text()` cannot run under jsdom.
- No fix touches `contentHash`.

## Browser verification

Setup:
- Run `npm run dev`, then open http://localhost:1420 in Chrome through the Chrome DevTools MCP.
- Where a step needs an object that the UI cannot create in a browser (image import uses a Tauri dialog), use `evaluate_script`. Vite serves the same module instance, so this reaches the live store:
  ```js
  const { useStore } = await import('/src/app/store/index.ts');
  ```
- For an image the page has **never decoded**, generate a fresh data URL:
  ```js
  const c = document.createElement('canvas'); c.width = 200; c.height = 100;
  const x = c.getContext('2d'); x.fillStyle = '#' + Math.floor(Math.random()*0xffffff).toString(16).padStart(6,'0');
  x.fillRect(0,0,200,100); x.fillStyle = '#fff'; x.fillRect(0,0,60,30);
  const url = c.toDataURL();
  ```
  Then call `useStore.getState().addObject({...})` with type `image`, a 50×25 mm transform, `imageData: url`, a unique id, `layerIndex: 0` and the other required DesignObject fields. Copy the shape from `makeRect` in toolHandler.test.ts:17-38.
- Take a screenshot at every "expect".

**F1, bed at launch:**
- Hard-reload the page 3 times.
- Expect the dark bed rectangle with its border, and the grid, on first paint, without touching any control.
- Confirm there is exactly one `<canvas>` under the viewport div (`document.querySelectorAll('canvas')`, excluding the ruler canvases).

**F2, rulers:**
- Press G twice.
- Expect both rulers to show tick marks and labels immediately, before any pan or zoom.
- Resize the window. The rulers repaint.

**F3, rotation placement:**
- Text tool: click the bed, type `KERF`, press Shift+Enter, then switch to the Select tool.
  - Drag the rotate handle about 30°. Expect the text centred inside its rotated selection outline.
  - Press `]`. Expect it still centred, at 120°.
- Add a never-decoded image (setup above), select it and press `]`. Expect the image exactly filling its rotated outline.
- Draw a rectangle and set Rotation to 30 in the Properties panel, then set it to 0. Expect the rectangle axis-aligned again. This is the sibling defect.

**F4, flip:**
- Select the image and choose Arrange → Flip Horizontal. Expect it mirrored: the white block moves to the top-right.
- Nudge with the arrow keys 3 times, then drag it. Expect it mirrored and inside its outline after every move.
- Flip Horizontal again. Expect it un-mirrored.
- Template text: create text `Part {serial}` and drag it. Expect the orange dashed frame to travel with the text.
- Flip Horizontal on the template and drag again. Expect text and frame together.

**F5, image decode:**
- The never-decoded image from setup must appear within a moment of `addObject`, never as an empty outline.
- Add a second image with `imageData: 'data:image/png;base64,AAAA'`. Expect a crossed-box placeholder that survives a drag.
- Owner desktop test required, because the Tauri file dialog is not reachable in a browser: in the built app, save a project that contains an image, quit, relaunch and open it through File → Open. Expect the image visible immediately. Repeat with the recovery prompt: force-quit with unsaved image work, relaunch and choose Restore.

**F6, handles:**
- Zoom 100%, two shapes selected.
  - Click the small rotate circle above the group box and drag. Expect rotation, with a live readout, and no vertical resize.
- Draw a 4×4 mm rectangle (type W/H 4 in Properties) at zoom 100%.
  - Select it, then drag from its centre. Expect the object to move, not resize.
  - Hover its corner. Expect a resize cursor only within about 6 px of the corner.
- Single select on a 40 mm rectangle. Expect the rotate handle about 20 px above the top edge, and clickable there.
- Repeat the rotate and small-object checks at zoom 400% and 25%.
- Pen tool:
  - click three points, then click about 15 px from the first point. Expect a new point, not a close.
  - then click on the first point. Expect the path to close.
- Node tool on a path: a click about 15 px from a node does not select it; a click on the node does.

**F7, node editor on a rotated path:**
- Draw a pen path with 4 points, select it, rotate it 30° with the handle, then press the Node tool shortcut or choose it from the toolbar.
  - Expect the node squares sitting on the visible curve.
  - Drag one node. Expect it to follow the cursor exactly, and only that node and its segments to move; the rest of the shape stays still.
  - The Rotation field in Properties still reads 30, and the selection box keeps its rotated frame.
  - Drag a Bézier handle. Expect it to follow the cursor, with its mirrored twin moving opposite.
  - Press Ctrl+Z once. Expect the original rotated path back.
- Delete a node on a rotated path (select it, press Delete). Expect the remaining nodes to stay put.

Hardware: F1-F6 send nothing different to the machine. F7 never changes a path's rotation. Its no-op-selection payload test pins the input to the generator as byte-identical, and after a real edit only the moved node changes. **No owner hardware test is required.** The one owner-run step is the desktop file-open check in F5.

## Dependency Graph

Commit order, one commit per step and each with its own red-first proof:

1. F1
2. F2
3. F3, move commit
4. F3, fix
5. F4
6. F5, move commit
7. F5, fix
8. F6
9. F7

What depends on what:
- **F1 and F2 are independent** of every other fix and of each other. F1's cleanup calls `clearTextures()` only once F5 lands; until then it keeps the existing texture-cache clear, inside the same ownership guard.
- **F3 → F4 → F5 run in sequence in `renderHelpers.ts`.** F3's move commit creates the module. F4 adds `placeSprite` and changes `applyTextImageTransform`. F5 moves `renderImageObject` in, which calls `placeSprite`.
- **F6 → F7 run in sequence in `toolHandler.ts`.** Both edit `hitTestNodeHandles`: F6 changes the radius and F7 changes the points iterated. Doing F6 first keeps F7's hit tests on the corrected radius.
- F6 and F7 are independent of F3-F5, except that each edits Viewport.tsx: F6 the overlay handle and outline block, F7 the node-overlay line. These are disjoint hunks.

**Batch waiver (one relay, not split):** this is one subsystem, the translation of DesignObject state into Pixi display state and screen-space hit-testing. Splitting it would leave `renderHelpers.ts` half-moved between relays. It would also make two relays edit the same Viewport.tsx objects effect, which the sequencing precondition exists to avoid.

## Deferrals

Named deferrals from this plan. At relay-design 3.5, add each line below verbatim to the index in `ROADMAP.md -> ## Parking Lot — every deferral, one index`:

- **Image texture refresh on in-place `imageData` replacement** — the texture cache is keyed by object id, and `contentHash` samples only the first 50 characters of the data URL, so an image replaced under the same id would not redraw. No current writer does this. Source: refresh-canvas-display.md F5 Risk.
- **JobPreview screen-pixel sizes not unit-audited** — the canvas-2D line widths, dash lengths and head-marker radii in `JobPreview.tsx` divide by zoom and were outside the core-6 sweep. Source: refresh-canvas-display.md F6.
- **core-16 remainder: rotated-rectangle math still copied in `getSelectionBBox` and `hitTest`** — collapse to `computeAABB` / `orientedHandlePoints` when a fix next touches either; `getSelectionBBox` has tests at toolHandler.test.ts:74-120. Source: refresh-canvas-display.md Intent.
- **core-17 remainder: `renderObject`, `renderTextObject` and `contentHash` have no tests** — `new Text()` cannot run under jsdom, and `renderObject` belonged to the cut-vs-screen relay. Source: refresh-canvas-display.md core-17 note.

Not deferrals:
- The ARCHITECTURE.md delta for `renderHelpers.ts` and `textureCache.ts` is scheduled for the next `/save` J.2 pass.
- The toolHandler split (core-18) was declined in triage, not deferred.

## Files

**In scope:**
- `src/components/viewport/Viewport.tsx`:
  - init guard, ready flag and dependency lists (F1)
  - call-site swaps to renderHelpers and textureCache (F3-F5)
  - rotate offset and outline collapse (F6)
  - node overlay points (F7)
- `src/components/viewport/Rulers.tsx` (F2)
- `src/components/viewport/renderHelpers.ts`, **new**: `rotationPlacement`, `applyObjectRotation`, `placeSprite`, `applyTextImageTransform`, `renderImageObject`
- `src/components/viewport/textureCache.ts`, **new**
- `src/lib/tools/toolHandler.ts`, line-level changes only:
  - `hitTestHandle` (F6)
  - pen close (F6)
  - `hitTestNodeHandles`, `handleNodeDown`, `handleNodeMove`, `deleteSelectedNode` and the toggle-smooth branch of `handleViewportDoubleClick` (F6, F7)
- `src/lib/geometry/index.ts`: add `pathPointsToWorld`, `worldDeltaToLocal` and `pointsPartialKeepingPlacement` (F7)
- `src/lib/constants.ts`: add `ROTATE_HANDLE_OFFSET_PX` and `screenPxToMm` (F6)
- New tests:
  - `src/components/viewport/__tests__/{viewportInit.test.tsx, rulers.test.tsx, renderHelpers.test.ts, textureCache.test.ts}`
  - `src/lib/tools/__tests__/{screenUnits.test.ts, nodeEditRotation.test.ts}`
  - new cases added to the existing `src/lib/geometry/__tests__/pointsGeometry.test.ts` (F7)
- `src/lib/tools/__tests__/pathWriters.test.ts`: the rotate-handle press point at line 256 and the stale comments at lines 257, 302 and 404 (F6).

**Explicitly out of scope:**
- Splitting or restructuring toolHandler.ts (core-18 was declined).
- `getSelectionBBox` and `hitTest`'s inverse rotation (core-16 copies not touched by any fix).
- `renderObject`, `renderTextObject` and the group loop in Viewport.tsx, which belong to the cut-vs-screen relay.
- `contentHash` sampling and the image-replace refresh noted in F5 Risk.
- JobPreview.tsx line widths.
- The fileOps load migration, which folds rotation into points for transforms that have drifted out of sync. It is untouched; it runs at load, not during node edits.
- ARCHITECTURE.md, which a concurrent agent is editing. The delta for the two new modules goes in at the next /save J.2 pass.
- Every remediation-owned file:
  - serial*.rs, grbl_status.rs
  - connection.ts, jobStream.ts, jobSession.ts, machineStatus.ts, gcodeGen.ts
  - gcode_gen.rs, limits.rs, image_gcode_gen.rs
  - MachinePanel, JobActionBar, MaterialTestDialog, GrblSettingsDialog

## Done when

- [ ] The precondition passed before F1 began: `composedLeaves|drawnLeaves` hit in `src/lib/geometry/index.ts`, and `drawnLeaves` hit in `src/components/viewport/Viewport.tsx`, and every line number in this plan was re-read against that base.
- [ ] Each fix's red-first proof is recorded in the Ted report: the failing test output before the fix and the passing output after, per F1-F7.
- [ ] `npm test` is fully green: the JS count measured at relay start plus every new test listed above, with no existing test weakened. The critic ran 823 JS tests green at `bc87e45`; cut-vs-screen will add more, so the count measured at start is the gate. The pathWriters change is limited to the rotate-handle press point and comments (F6).
- [ ] `cargo test` is green at the Rust count measured at relay start (310 at `bc87e45`). No Rust changes are expected; this is a regression check.
- [ ] `npx tsc --noEmit` is clean, with zero `@ts-ignore` or `@ts-expect-error` added.
- [ ] `npm run lint` shows no new warnings compared with the count measured at relay start.
- [ ] `npx prettier --check` passes on touched files, and `cargo fmt --check` is clean.
- [ ] No `useStore` selector returns a new object or array. `pixiReady` and `textureTick` are `useState` scalars.
- [ ] Browser verification F1-F7 is done in `npm run dev` with screenshots, under StrictMode (the dev default).
- [ ] The owner desktop file-open check in F5 is logged in the ROADMAP `next` section with its steps.
- [ ] The four `## Deferrals` lines are in the ROADMAP Parking Lot index.
