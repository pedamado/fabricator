# Computational Design Letterpress Fabricator

**Live Tool:** [http://typedesign.fba.up.pt/letterpress-fabricator/](http://typedesign.fba.up.pt/letterpress-fabricator/)

A browser-only tool that turns a user-supplied variable font (`.ttf` / `.otf`) into 3D-printable letterpress sorts (slugs) ready for SLA or FDM. Designed for the FBAUP Type Design course so students with no 3D background can take their digital type straight to the school's fablab and print on the workshop's letterpress presses.

![Computational Design Letterpress Fabricator — main interface](./Screenshot%202026-05-18%20at%2021.46.27.png)

## Description

This app streamlines the fabrication of custom variable fonts designed digitally in the Type Design course of the Master in Graphic Design and Editorial Projects at FBAUP. It is aimed at students with no prior knowledge of 3D modelling software — drop a font, click a few glyphs, export STL.

The geometry is standardized to the same typographic measurements as the workshop's existing metal and wood type, so the printed sorts mix straight back into the Printmaking Workshop's composing sticks and presses.

## Features

- **Variable Font Parsing.** Drop any TrueType (`.ttf`) or OpenType (`.otf`) variable font — the app reads `fvar`, axes, named instances and outlines directly in the browser via `opentype.js` and a bundled `samsa-core` ES module. Variation-aware geometry: every change to a font axis (wdth / wght / etc.) or to a named instance rebuilds both the printed eye *and* the underlying slug body from the live variated outline.
- **True letterpress metrics.** Sorts are output at a configurable typographic height with presets for Continental (23.56 mm), Anglo-American (20.32 mm shoulder), Italian (21.60 mm) and Dutch (21.85 mm), so they mix with the existing FBAUP workshop type.
- **Parametric Sort Generation.** Solid slugs by default, switching to hollow shells with internal walls plus SLA drain hatches once a sort passes the minimum-width threshold. Every sort gets foot chamfers, a foot ID-nick, a baseline marker nick (where appropriate) and a 12° reinforced neck (slope) on the relief.
- **Internal Support Walls for large sorts.** When a hollow cavity exceeds 4 × wall thickness, the cavity is automatically subdivided into a grid of cells with internal vertical and horizontal support walls. Each cell stays within a configurable maximum span (15 mm by default), and each row / column gets its own drain hatch — preventing unsupported spans across the top of the letter on tall point-sizes (SLA sag, FDM bridging failure).
- **Advanced Customization Panel.** A full second-tier accordion exposes every slug parameter: font size (10–288 didot pt), type-height presets and overrides, hollow toggle, wall thickness, support-wall toggle and cell span, drain toggle and diameter, foot chamfer size, foot-nick and baseline-nick radii, beard tolerance (% of EM, per side), and reinforced-neck slope angle. Every change is persisted across the session in `sessionStorage`, and a single "Reset Advanced Defaults" button restores the workshop preset.
- **Bulk glyph selection.** Filter glyphs by category (Uppercase / Lowercase / Figures / Punctuation / Spacing Quads) or type a custom string. Select all / Clear buttons handle bulk selection.
- **Direct-to-Plate Layouts.** Free floating layout or predefined physical plates (20 × 20 cm, 9 × 12 cm) with automatic row wrapping.
- **Exporting.** Single or bulk export via high-fidelity ASCII STL, Wavefront OBJ, or batch ZIP archives with one STL per glyph.

## How it works (technical summary)

- No bundler — everything runs as ES modules from `<script type="module">`.
- `three@0.160.0` + `three-csg-ts@3.1.11` drive the boolean geometry: each slug body is built as a Box, then individual cells, drains and nicks are subtracted via CSG.
- `samsa-core` (vendored locally under `src/samsa-core.js`) is the source of truth for variable-instance glyph outlines, because `opentype.js`'s `gvar` support is unreliable for variation outlines. The samsa instance is tag-keyed (`{wght: 800, wdth: 75}`) and the resulting `SamsaGlyph` is reused both for bounds calculation and for shape extraction so the slug width/height always tracks the currently variated outline.
- `opentype.js@1.3.4` is retained for font metrics, glyph-list discovery and a fallback outline path for non-variable fonts.
- `jszip@3.10.1` (UMD) packages the batch export.

## Credits & Links

Designed by **Pedro Amado**, [FBAUP](https://www.up.pt/fbaup/) / [i2ADS](https://i2ads.up.pt/), within the context of the Type Design course of the [MDGPE](https://mdgpe.fba.up.pt/) master program at FBAUP, and the [Ligatures SIG](https://ligatures.fba.up.pt/) from the i2ADS.

Coded by **Gemini Pro 3.1** and **Claude Code Opus 4.7**. Version **8.1**, May 2026.

More information and code available at the project's [GitHub repository](https://github.com/pedamado/fabricator).

## Changelog

- **v8.1 (May 2026)** — Internal support walls for large hollow sorts. When a cavity exceeds 4 × wall thickness, it is subdivided into an MxN cell grid (each cell ≤ 15 mm by default, configurable) with one drain hatch per row and per column. New advanced controls: Internal Support Walls toggle + Max cell span slider.
- **v8 (May 2026)** — Advanced Customization accordion with full slug-shape parameter set; `sessionStorage` persistence; Reset Advanced Defaults button; Select all / Clear bulk-selection buttons.
- **v7.1 (May 2026)** — Fixed variable-instance outline pipeline (samsa wired as ES module, axis-tag-keyed `sf.instance(...)`, instance glyph reused for both bounds and shape; slug width/height now derived from the variated outline's actual on-curve + Bézier-control bounds).
