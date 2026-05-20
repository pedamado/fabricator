# Computational Design Letterpress Fabricator

**Live Tool:** [http://typedesign.fba.up.pt/letterpress-fabricator/](http://typedesign.fba.up.pt/letterpress-fabricator/)

A browser-only tool that turns a user-supplied **variable font** (`.ttf` / `.otf`), **SVG vector artwork**, or **bitmap image** into 3D-printable letterpress sorts (slugs) ready for SLA or FDM. Designed for the FBAUP Type Design course so students with no 3D background can take their digital type — and now their logotypes, icons, and engravings — straight to the school's fablab and print on the workshop's letterpress presses.

![Computational Design Letterpress Fabricator — main interface](./Screenshot%202026-05-18%20at%2021.46.27.png)

## Description

This app streamlines the fabrication of custom variable fonts and one-off graphics designed digitally in the Type Design course of the Master in Graphic Design and Editorial Projects at FBAUP. It is aimed at students with no prior knowledge of 3D modelling software — drop a font (or an SVG, or even a photo of a sketch), click a few glyphs (or just the artwork), export STL.

The geometry is standardized to the same typographic measurements as the workshop's existing metal and wood type, so the printed sorts mix straight back into the Printmaking Workshop's composing sticks and presses.

## Features

- **Variable Font Parsing.** Drop any TrueType (`.ttf`) or OpenType (`.otf`) variable font — the app reads `fvar`, axes, named instances and outlines directly in the browser via `opentype.js` and a bundled `samsa-core` ES module. Variation-aware geometry: every change to a font axis (wdth / wght / etc.) or to a named instance rebuilds both the printed eye *and* the underlying slug body from the live variated outline.
- **NEW · Graphic Sources (v9.0).** Two additional dropzones sit under the font dropzone:
  - **Vector dropzone** — drop an `.svg` file (logotype, icon, illustration). The canvas is treated as a 1000-unit EM square; bounding box, scale, and Y-flip are handled automatically so the artwork lands on the typographic baseline. (PDF / AI ship in v9.1 — export as SVG from Illustrator for now.)
  - **Bitmap dropzone** — drop any common image (JPG, PNG, TIFF, HEIF, WebP, GIF). The image is traced through `ImageTracer.js` with a forced 2-colour palette and the resulting contours feed the same builder pipeline. **Tip:** use maximum-contrast black-and-white images (≥ 600 × 600 px) for the cleanest trace.
  - All sources flow through one builder, so every feature below applies whether you started from a font, a vector, or a bitmap.
- **True letterpress metrics.** Sorts are output at a configurable typographic height with presets for Continental (23.56 mm), Anglo-American (20.32 mm shoulder), Italian (21.60 mm) and Dutch (21.85 mm), so they mix with the existing FBAUP workshop type.
- **Parametric Sort Generation.** Solid slugs by default, switching to hollow shells with internal walls plus SLA drain hatches once a sort passes the minimum-width threshold. Every sort gets foot chamfers, a foot ID-nick, a baseline marker nick (where appropriate) and a 12° reinforced neck (slope) on the relief.
- **Internal Support Walls for large sorts (v8.1).** When a hollow cavity exceeds 4 × wall thickness, the cavity is automatically subdivided into a grid of cells with internal vertical and horizontal support walls. Each cell stays within a configurable maximum span (15 mm by default), and each row / column gets its own drain hatch — preventing unsupported spans across the top of the letter on tall point-sizes (SLA sag, FDM bridging failure).
- **Advanced Customization Panel.** A full second-tier accordion exposes every slug parameter: font size (10–288 didot pt), type-height presets and overrides, hollow toggle, wall thickness, support-wall toggle and cell span, drain toggle and diameter, foot chamfer size, foot-nick and baseline-nick radii, beard tolerance (% of EM, per side), and reinforced-neck slope angle. Every change is persisted across the session in `sessionStorage`, and a single "Reset Advanced Defaults" button restores the workshop preset.
- **Bulk glyph selection.** Filter glyphs by category (Uppercase / Lowercase / Figures / Punctuation / Spacing Quads) or type a custom string. Select all / Clear buttons handle bulk selection. (Hidden automatically when a vector / bitmap source is active.)
- **Direct-to-Plate Layouts.** Free floating layout or predefined physical plates (20 × 20 cm, 9 × 12 cm) with automatic row wrapping.
- **Exporting.** Single or bulk export via high-fidelity ASCII STL, Wavefront OBJ, or batch ZIP archives with one STL per glyph (or a single STL bundle for a graphic source).

## How it works (technical summary)

- No bundler — everything runs as ES modules from `<script type="module">`.
- `three@0.160.0` + `three-csg-ts@3.1.11` drive the boolean geometry: each slug body is built as a Box, then individual cells, drains and nicks are subtracted via CSG.
- A unified `GlyphSource` contract (see `js/sources/glyph-source.js`) sits between the parsers and the builder, so the same engine handles font glyphs, SVG paths and bitmap-traced contours. The builder's public entry point is `buildSlugFromSource(source, mirror, applyDraft, variableSize, slugOptions)`; the legacy `buildBlock(...)` is a thin font-specific shim.
- `samsa-core` (vendored locally under `src/samsa-core.js`) is the source of truth for variable-instance glyph outlines, because `opentype.js`'s `gvar` support is unreliable for variation outlines. The samsa instance is tag-keyed (`{wght: 800, wdth: 75}`) and the resulting `SamsaGlyph` is reused both for bounds calculation and for shape extraction so the slug width/height always tracks the currently variated outline.
- `opentype.js@1.3.4` is retained for font metrics, glyph-list discovery and a fallback outline path for non-variable fonts.
- `imagetracerjs@1.2.6` (CDN, UMD) powers the bitmap-tracing pipeline with a 2-colour palette; the resulting SVG is filtered to drop the white "paper" layer and parsed by the in-house SVG parser.
- `jszip@3.10.1` (UMD) packages the batch export.

## Credits & Links

Designed by **Pedro Amado**, [FBAUP](https://www.up.pt/fbaup/) / [i2ADS](https://i2ads.up.pt/), within the context of the Type Design course of the [MDGPE](https://mdgpe.fba.up.pt/) master program at FBAUP, and the [Ligatures SIG](https://ligatures.fba.up.pt/) from the i2ADS.

Coded by **Gemini Pro 3.1** and **Claude Code Opus 4.7**. Version **9.0**, May 2026.

More information and code available at the project's [GitHub repository](https://github.com/pedamado/fabricator).

## Changelog

- **v9.0 (May 2026)** — New Graphic Source pipelines: drop an `.svg` vector file or any bitmap image (`.jpg`/`.png`/`.heif`/`.tif`/`.webp`/`.gif`) and the same builder produces a letterpress sort. SVG parsing is direct (custom path parser, full d-attribute grammar, CTM flattening, Y-flip, height-normalized to 1000 EM units). Bitmaps are traced via `ImageTracer.js` with a forced 2-colour palette and the white background filtered out. The builder was refactored around a modular `GlyphSource` contract (`js/sources/`) so the font, vector, and bitmap pipelines all feed one engine. Two new dropzones in the sidebar; font-only panels (Instance / Axes / Glyph Selection) auto-hide when a graphic source is active. PDF / AI parsing ships next in v9.1.
- **v8.1 (May 2026)** — Internal support walls for large hollow sorts. When a cavity exceeds 4 × wall thickness, it is subdivided into an MxN cell grid (each cell ≤ 15 mm by default, configurable) with one drain hatch per row and per column. New advanced controls: Internal Support Walls toggle + Max cell span slider.
- **v8 (May 2026)** — Advanced Customization accordion with full slug-shape parameter set; `sessionStorage` persistence; Reset Advanced Defaults button; Select all / Clear bulk-selection buttons.
- **v7.1 (May 2026)** — Fixed variable-instance outline pipeline (samsa wired as ES module, axis-tag-keyed `sf.instance(...)`, instance glyph reused for both bounds and shape; slug width/height now derived from the variated outline's actual on-curve + Bézier-control bounds).
