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
- `imagetracerjs@1.2.6` (UMD bundle, loaded globally) powers the bitmap →
  vector pipeline. Two-colour palette is forced via tracing options; the
  resulting SVG is post-processed to strip the white "paper" layer before
  it is handed to the in-house SVG parser.

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
                             from a GlyphSource + slugOptions.
                             buildSlugFromSource(source, …) is the real
                             entry point; buildBlock(idx, category, …) is
                             a thin font-only shim that constructs a source
                             via the factories and delegates.
  ui.js                    — DOM wiring, three dropzones (font / vector /
                             bitmap), axis sliders, instance dropdown,
                             advanced-panel state, sessionStorage persistence,
                             activeGraphicSource state + replace-on-drop
  exporter.js              — STL/OBJ writers + batch ZIP

  sources/
    glyph-source.js        — the GlyphSource contract + factories:
                             fromFontGlyph(activeGlyph, activeFont, axes),
                             fromSpacingQuad(quad, activeFont),
                             fromCommandList(commands, name, kind, meta)
    svg-parser.js          — parseSVG(svgText, name) → vector GlyphSource.
                             Custom path-d parser (M/L/H/V/C/S/Q/T/A/Z),
                             CTM flattening, Y-flip, height-normalized to
                             1000 EM units
    bitmap-tracer.js       — traceBitmap(fileOrBlob, name) → bitmap GlyphSource.
                             ImageTracer.js + 2-colour palette, white layer
                             stripped, reuses svg-parser for commands
    index.js               — barrel export

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

The real entry point is now
`buildSlugFromSource(source, mirror, applyDraft, variableSize, slugOptions)`,
where `source` is a `GlyphSource` (see §12). The legacy
`buildBlock(glyphIndex, category, glyphsList, axesValues, …)` is kept as a
thin font-only shim that constructs a source via
`fromFontGlyph(...)` / `fromSpacingQuad(...)` and delegates — no behaviour
change for the font path.

Both entry points return `{ group, w, h, minX, minY, maxY }`. The geometry
function has four explicit steps:

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

- **v9.0 (May 2026)** — Graphic-source pipelines. The builder was
  refactored around a unified `GlyphSource` contract (`js/sources/`) so the
  same engine accepts font glyphs, SVG vector artwork, and bitmap images.
  Two new dropzones in the sidebar (vector + bitmap) sit under the existing
  font dropzone with replace-on-drop semantics. SVG: custom path-d parser,
  CTM flattening, Y-flip, height-normalized to 1000 EM units. Bitmap:
  ImageTracer.js with a 2-colour palette and the white background filtered
  out, then fed through the same SVG parser. Font-only panels (Instance /
  Axes / Glyph Selection) auto-hide when a graphic source is active.
  PDF/AI ship next in v9.1.
- **v8.1 (May 2026)** — Internal support walls for large hollow sorts.
  When a cavity exceeds 4 × wall thickness it is subdivided into an MxN
  cell grid (each cell ≤ 15 mm by default, configurable) with one drain
  hatch per row and per column.
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

## 12. The Graphic Sources Pipeline (v9.0)

The builder used to read samsa + opentype directly. v9.0 introduces a
unified `GlyphSource` so the same CSG engine accepts font glyphs, SVG paths,
and bitmap-traced contours through a single contract.

### The contract (`js/sources/glyph-source.js`)

```js
{
  kind: 'font-glyph' | 'spacing-quad' | 'vector' | 'bitmap',
  name: string,
  unitsPerEm: number,           // 1000 for graphics; font UPM for fonts
  metrics: { descender, ascender, capHeight, xHeight },
  bounds: { xMin, xMax, yMin, yMax } | null,
  contours: {
    format: 'samsa' | 'commands',
    points?:  [[x, y, flagByte], ...],
    endPts?:  [...lastIdx],
    commands?: [{type:'M'|'L'|'Q'|'C'|'Z', ...}],
  },
  meta: { /* optional UI / export metadata */ }
}
```

Two contour formats are intentionally kept side-by-side:

- **`samsa`** — verbatim points/endPts from the variable-font pipeline.
  Keeping it untouched means the font path is byte-identical to v8.1.
- **`commands`** — opentype.js-style command list (`M`/`L`/`Q`/`C`/`Z`),
  which is what the SVG parser emits and what the bitmap tracer
  ultimately yields (via the SVG parser).

`buildSlugFromSource(source, ...)` is source-agnostic; it dispatches on
`contours.format` inside the relief-extraction helper.

### Factories

- `fromFontGlyph(activeGlyph, activeFont, axesValues)` — runs the same
  samsa instantiation that used to live in builder.js. Returns
  `kind:'font-glyph'` with samsa-format contours when possible,
  command-format fallback to opentype's `path.commands` otherwise.
- `fromSpacingQuad(quad, activeFont)` — bounds-only source, no contours.
- `fromCommandList(commands, name, kind='vector', meta)` — the entry point
  for graphic sources; defaults `unitsPerEm = 1000` and synthesizes metrics
  so STEP 4 of the builder collapses cleanly to `bY1 = 0, bY2 = 1000`.

### SVG parser (`js/sources/svg-parser.js`)

`parseSVG(svgText, name)`:

1. `DOMParser` → `<svg>` document. Catch `<parsererror>` and rethrow.
2. Walk the tree, accumulating a CTM down to each leaf shape (matrix
   multiplication implemented manually since DOM `getCTM()` isn't
   available off-screen). Supports `<path>`, `<polygon>`, `<polyline>`,
   `<rect>` (sharp corners; rx/ry deferred to v9.1), `<circle>`,
   `<ellipse>`, `<line>`.
3. `<path>`'s `d` attribute is parsed by a custom tokenizer + state
   machine that handles M/L/H/V/C/S/Q/T/A/Z + relatives, implicit command
   continuation, smooth control reflection (S/T), and arc → cubic
   conversion for A.
4. Compose all commands into a flat stream, compute bbox, **flip Y**
   (SVG Y-down → font Y-up), scale uniformly so artwork height = 1000 EM
   units, translate so bbox bottom-left is (0, 0).
5. Return a `kind:'vector'` source via `fromCommandList(...)`.

### Bitmap tracer (`js/sources/bitmap-tracer.js`)

`traceBitmap(fileOrBlob, name)`:

1. Read file → dataURL → `ImageTracer.imageToSVG(...)` with a **forced
   2-colour palette** (black ink + white paper). The 2-colour quantization
   gives the cleanest letterpress-style outlines.
2. Strip the white "paper" layer from the resulting SVG (regex on
   `fill="rgb(255,255,255)"` paths) — without this, the bitmap's full
   canvas would shadow the actual artwork in the relief extrusion.
3. Hand the ink-only SVG to `parseSVG(...)`, override `kind` to `bitmap`,
   stamp `meta.tracedFrom` with the detected image format.

Tracing options are tuned in `TRACE_OPTIONS` at the top of the module —
adjust `ltres`/`qtres` for tighter / looser fits, `blurradius` for more or
less smoothing of anti-aliased edges.

### UI routing (`js/ui.js`)

- Three dropzones: `#dropzone` (font), `#vector-dropzone`,
  `#bitmap-dropzone`. The two new ones use `.dropzone-secondary` styling.
- `activeGraphicSource` holds the current non-font source. When set,
  `setFontOnlyPanelsVisible(false)` toggles `.hidden` on every
  `.font-only` panel (Instance / Axes / Glyph Selection).
- **Replace-on-drop**: dropping a font calls `clearActiveGraphicSource()`;
  loading a vector or bitmap clears font-side state (`glyphsList = []`,
  `activeGlyphIndices.clear()`). One active source at a time.
- `generate3D()` short-circuits: if `activeGraphicSource` is set, it calls
  `buildSlugFromSource(...)` directly (one sort, centred on plate / origin)
  instead of iterating `activeGlyphIndices`.
- ZIP button branches to `handleSingleGraphicZip()` for graphic sources
  (packages one STL); STL/OBJ buttons traverse the rendered group
  unchanged.

### Pitfalls / gotchas

- SVG `<defs>` content is skipped during the walk — it's usually
  `<use>`-referenced and would otherwise produce phantom shapes. If a
  source relies on `<use>` references we'll need to resolve them in a
  future revision.
- ImageTracer is loaded as a UMD global (`window.ImageTracer`) via
  `<script src=>`; if it fails to load `traceBitmap` throws a clean error.
  Don't try to ES-import it — it doesn't ship a module build.
- Graphic-source metrics are synthetic (`descender = 0, ascender =
  capHeight = xHeight = 1000`). Don't add font-specific heuristics that
  assume real cap-height < ascender.

— Pedro Amado, FBAUP / i2ADS, Type Design course, MDGPE.
   Code by Gemini Pro 3.1 and Claude Code Opus 4.7.
