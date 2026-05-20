# Computational Letterpress Fabricator — Project Notes for Claude

A browser-only tool that turns a user-supplied variable font (.ttf / .otf) into
3D-printable letterpress sorts (slugs) ready for SLA/FDM. Designed for FBAUP's
Type Design course so students with no 3D background can take their digital
type straight to the school's fablab and print on the workshop's letterpress
presses.

Live deployment: <http://typedesign.fba.up.pt/letterpress-fabricator/>
Companion app (reference for variable-font outline rendering):
<https://typedesign.fba.up.pt/varplay/>

---

## 1. Objectives

1. **Drop-in workflow.** Drag a `.ttf` onto the page; the app reads `fvar`,
   axes, instances, and outlines — no install, no CLI.
2. **Variation-aware geometry.** Every change to a font axis (wdth / wght /
   etc.) or to an `fvar` named instance must rebuild *both* the printed eye
   *and* the underlying slug body. The slug width/height must come from the
   currently variated outline, not the default master.
3. **True letterpress metrics.** Sorts come out at a configurable typographic
   height (Continental 23.56 mm by default, with Anglo-American / Italian /
   Dutch presets) so the sorts mix with the existing FBAUP workshop type.
4. **Print-ready bodies.** Build solid slugs by default; switch to hollow
   shells with internal walls + SLA drain hatches once they pass a minimum
   width threshold. Always include foot chamfers, a foot ID-nick, and a
   baseline marker nick. Apply a 12° reinforced neck (slope) on the relief by
   default.
5. **Single + batch export.** STL / OBJ for the on-screen selection; ZIP of
   per-glyph STLs for the whole set.

## 2. Tech Stack & External Deps (CDN-loaded via importmap)

- `three@0.160.0` (module build) + `three-csg-ts@3.1.11` for boolean ops.
- `opentype.js@1.3.4` for shaping/metrics, glyph-list discovery, and the
  *fallback* outline path. **Note:** opentype.js's gvar support for outline
  variation is unreliable; we use samsa-core for the variated outlines.
- `samsa-core` v2.0 alpha bundled locally at `src/samsa-core.js`, imported as
  a real ES module from `js/font-parser.js`. It does the heavy lifting for
  `fvar` axes/instances and variable-instance glyph outlines.
- `jszip@3.10.1` (loaded via `<script src=>` because it's a UMD bundle) for
  batch ZIP export.

No bundler. Everything runs as ES modules from `<script type="module">`.

## 3. File Layout

```
index.html                 — single-page UI (sidebar + viewport)
style.css                  — dark/light theme via CSS vars, accordion styles
src/samsa-core.js          — vendored variable-font library (ES module)

js/
  main.js                  — bootstraps scene + UI
  font-parser.js           — opentype + samsa parsing; exposes getFont(),
                             getSamsaFont(), getAxes(), getInstances(),
                             getActiveFont(axesValues), getGlyphsByCategory(...)
  scene.js                 — three.js scene, camera, plate, mesh group helpers
  builder.js               — *the* geometry engine: builds slug + extruded eye
                             from a glyph index + axesValues + slugOptions
  ui.js                    — DOM wiring, axis sliders, instance dropdown,
                             advanced-panel state, sessionStorage persistence
  exporter.js              — STL/OBJ writers + batch ZIP

AnekLatin-VariableFont_wdth,wght.ttf  — example font for testing
_varplay-app-reference/    — copy of varplay for cross-referencing
noordzij-render-example/   — outline-rendering reference snippets
```

## 4. Core Workflow

1. **Font load.** `parseFont(arrayBuffer)` in font-parser.js produces both an
   opentype.js font *and* a `SamsaFont`. The samsa instance is the source of
   truth for variable outlines.
2. **UI population.** ui.js reads `getAxes()` and `getInstances()`, builds
   one slider per axis and a dropdown of named instances. CSS
   `font-variation-settings` is also pushed onto the glyph-grid preview
   buttons via a `FontFace` registered against the dropped buffer, so the
   preview UI updates live.
3. **Glyph selection.** A `getGlyphsByCategory` filter (Uppercase / Lowercase /
   Figures / Punctuation / Spacing Quads / Custom text) populates the grid.
   The user clicks glyphs to add/remove them from `activeGlyphIndices`. The
   Select all / Clear buttons toggle the whole grid.
4. **3D regeneration.** Any change to axes, instance, glyph selection,
   options, or advanced controls calls `generate3D()` (debounced 100 ms),
   which loops the selection and calls `buildBlock(...)` per glyph.
5. **Export.** STL/OBJ traverse the on-screen group; ZIP rebuilds each glyph
   from scratch at the origin and packages them with the same `slugOptions`.

## 5. The Geometry Engine — `js/builder.js`

`buildBlock(glyphIndex, category, glyphsList, axesValues,
            mirror, applyDraft, variableSize, slugOptions)` returns
`{ group, w, h, minX, minY, maxY }`. The function has four explicit steps:

**STEP 1 — Instantiate the variable glyph.** Build a samsa instance from
`axesValues` keyed by axis tag (samsa expects `{wght: 800, wdth: 75}`, NOT
a tuple array). Pull the glyph via `sf.glyphs[id]` or `sf.loadGlyphById(id)`,
call `sGlyph.instantiate(inst)`, then `decompose()` it if it's composite.
Cache the result as `instanceGlyph` — it's used twice (bounds + draw).

**STEP 2 — Bounds from the instance.** Walk
`instanceGlyph.points[0 .. endPts[last]]` (skipping samsa's phantom
trailing points) and take the min/max of `pt[0]` and `pt[1]`. These bounds
include all on-curve nodes *and* off-curve Bézier control points — that's
intentional, both because the convex hull of control points contains the
curve and because students think in terms of "the leftmost/rightmost point".
If samsa instantiation fails or there are no contours (space-like glyph),
fall back to `activeGlyph.xMin/xMax/yMin/yMax` from opentype.

**STEP 3 — Apply mirror + beard.** Mirror flips X by negate-and-swap. Beard
is `(beardPercent / 100) × unitsPerEm × u2mm`, added to each side. With
`beardEnabled = false`, beard collapses to 0.

**STEP 4 — Vertical metric heuristics.** Detects whether the glyph reaches
into descender / above x-height / above cap-height (using a 2 %·EM threshold
to avoid noise) and sets `bY1` (foot) and `bY2` (head) to descender / 0 /
x-height / capHeight / ascender accordingly. The "Variable Slug Size" toggle
forces bY1 = descender and bY2 = ascender to give all sorts the same body.

The rest of the function:

- Builds a Box for the slug body.
- Subtracts four foot chamfers (when `chamferEnabled`).
- Subtracts a hollow Box + two perpendicular drain cylinders **only when**
  hollow is on *and* `min(blockW, blockH) ≥ hollowMinWidth` *and* there is
  room for the walls. Drains are conditional on hollow being present.
- Subtracts a foot nick cylinder (the long groove across the foot of the
  slug, `footNickRadius`).
- Subtracts a baseline nick cylinder at `y = 0, z = 0` when there's a
  descender — used to identify the baseline visually on the printed sort.
- Builds the relief by walking `instanceGlyph` again, this time into a
  `THREE.ShapePath` with quadratic curves, then `ExtrudeGeometry` with
  bevel-enabled when slope is on. **Slope angle is calculated correctly:**
  `bevelSize = tan(slopeAngle) × reliefHeight`. The old hardcoded 0.638 was
  exactly `tan(12°) × 3`.

### Conversion constants

- `u2mm = bodySizeMM / unitsPerEm` — sub-em coordinate scale.
- `bodySizeMM = fontSizePt × 0.376065` — Didot points → mm (continental).
  144 dt ≈ 54.15 mm, which is the historical default body for this app.

## 6. The Variable Font Pipeline (this is the bit you'll get wrong twice)

opentype.js's `font.getVariation({wght: 800, wdth: 75})` returns a font where
HVAR/MVAR are applied but **glyph outlines are not reliably variated**.
That's why the slug width was permanently stuck on the default master for
weeks. Use samsa for outlines.

samsa-core's API to remember:

```
const sf       = getSamsaFont();                 // a SamsaFont
const inst     = sf.instance({wght: 800, wdth: 75});  // tag-keyed object!
let   sGlyph   = sf.glyphs[glyphId] || sf.loadGlyphById(glyphId);
const variated = sGlyph.instantiate(inst);       // SamsaGlyph
const final    = variated.numberOfContours < 0
                  ? variated.decompose()
                  : variated;
// final.points is [[x, y, flagByte], ...]; on-curve = (flag & 0x01).
// final.endPts is the index of the last point of each contour.
```

Pitfalls:

- `sf.axes` is a **function** (`SamsaFont.prototype.axes`), call it.
- `sf.instance(tuple_array)` silently fails because the constructor calls
  `axisSettings[axis.axisTag]` — an array indexed by a string returns
  `undefined`, so every axis defaults. Pass an **object keyed by tag**.
- Don't load `samsa-core.js` via `<script src>`; it ends with `export {...}`
  and the file is invalid in a script context, so `SamsaFont` is never
  global. Import it as an ES module from `font-parser.js`.

## 7. The Advanced Customization Panel (v8)

A `<details>` accordion injected between Options and Export. Every value
listed below is in `slugOptions` (defined in `ui.js`) and is passed as the
8th argument to `buildBlock`. State is persisted to `sessionStorage` under
`fabricator.slugOptions.v8` after every change, and the accordion's
open/closed state under `fabricator.advPanelOpen`.

| Section            | Controls                                                                    | Default        |
|--------------------|------------------------------------------------------------------------------|----------------|
| Font size          | Number input ↔ slider (10–288 didot pt) + live mm readout                    | 144 pt / 54.15 mm |
| Type height        | Preset dropdown (Continental/Anglo-American/Italian/Dutch/Custom), slug-height slider, relief slider, total readout | 20.56 + 3.0 = 23.56 mm |
| Hollow core        | Toggle, min-slug-width slider (8–32 mm), wall-thickness slider (5–15 mm; max value auto-toggles hollow off) | on, 24, 8     |
| Drains             | Toggle, diameter slider (0–10 mm; 0 auto-toggles off)                        | on, 5 mm       |
| Foot chamfer       | Toggle, size slider (0–5 mm)                                                | on, 1.083 mm   |
| Foot nick          | Toggle, radius slider (0–5 mm)                                              | on, 2 mm       |
| Baseline nick      | Toggle, radius slider (0–5 mm)                                              | on, 1 mm       |
| Beard tolerance    | Toggle, percent slider (0–25 % EM, per side)                                | on, 2 %        |
| Neck slope         | Toggle, angle slider (0–45°). Mirrors the simple Options-panel toggle.       | on, 12°        |
| Reset              | "↺ Reset Advanced Defaults" button restores DEFAULT_SLUG_OPTIONS             | —              |

The simple Options panel (Mirror X, Apply Slope, Variable Slug Size) was kept
as master switches. The advanced Slope toggle and the simple Apply Slope
toggle are kept in sync. The other two top-level toggles are not duplicated
in the advanced panel.

## 8. Conventions

- **Coordinate units:** font-unit space (samsa points are in EM units) is
  converted by `u2mm` only when emitting Three.js geometry. Bounds in STEP 2
  stay in font units (`gxMinUnits` etc.).
- **Mirror:** the slug body uses negated/swapped bounds (`-gxMaxUnits` ↔
  `-gxMinUnits`); the eye geometry is drawn at its true coordinates and the
  mesh's `scale.x = -1` is applied at the end. Don't try to "fix" this — the
  shape path is fed into a `THREE.ShapePath` which is winding-order
  sensitive, and flipping after extrusion is the only reliable approach with
  this version of three.
- **Z conventions:** the slug sits in Z = 0 .. SLUG_HEIGHT; the eye is added
  on top with `eyeMesh.position.set(0, 0, SLUG_HEIGHT)`. Baseline nick sits
  at Z = 0; foot nick at Z = `footNickRadius * 3` up from the foot.
- **All CSG ops:** mesh → `updateMatrix()` → `CSG.fromMesh` → `subtract`.
  The matrix update step has bitten me — without it the boolean uses the
  wrong transform.
- **Hollow guard:** even if hollow is on, slugs narrower than
  `hollowMinWidth` stay solid. This is a deliberate safety so 1-em-wide
  letters (W, M at heavy weight) don't get walls so thin they crack.

## 9. Known Quirks / Future Work

- opentype.js's `getVariation` is still used in the *fallback* outline
  path. It works for non-variable fonts and for samsa-failure recovery, but
  it's not visually identical to the samsa path for variable fonts.
- The glyph grid uses CSS `font-variation-settings` for the preview, which
  is what the browser renders — independent of the 3D outline. They'll
  match for most fonts but if you see drift, suspect renderer rounding, not
  the geometry engine.
- The "Apply Slope" toggle keeps a 0.001 mm flat back face on the relief
  because three's ExtrudeGeometry refuses to bevel without one. That's fine
  visually and prints fine.
- Composite glyphs are decomposed at instance time via
  `iglyph.decompose()`. Deeply nested composites work; transforms on
  components are respected.

## 10. Recent Major Work (changelog highlights)

- **v8 (May 2026)** — Advanced Customization accordion with full slug-shape
  parametrisation; session-storage persistence; Reset Advanced Defaults
  button; Select all / Clear bulk-selection buttons.
- **v7.1** — Fixed variable-instance outline pipeline (samsa wired as ES
  module, axis-tag-keyed `sf.instance(...)`; reused `instanceGlyph` for
  both bounds and shape; slug width/height now derive from the variated
  outline's actual on-curve + Bézier-control bounds).

## 11. Working with this code

- The workspace is the project root. Edit in place — no build step.
- Open `index.html` from any local server (or `python -m http.server`) for
  testing; CDN imports require a real origin.
- The `outputs/` scratchpad (mounted under the Cowork session) is for
  Claude's temp files; ship final changes to the project root.
- Don't restructure the `samsa-core.js` vendored library. If you must
  upgrade, drop the new ES-module build in place and re-test the
  `sGlyph.instantiate(...)` → `decompose()` → `points/endPts` path.

— Pedro Amado, FBAUP / i2ADS, Type Design course, MDGPE.
   Code by Gemini Pro 3.1 and Claude Code Opus 4.7.
