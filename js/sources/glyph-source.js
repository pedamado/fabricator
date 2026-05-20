// ─── GlyphSource: the unified shape contract for the builder ───────────────
//
// builder.js used to read the samsa instance glyph + opentype font directly.
// That made it impossible to feed any non-font artwork through the same
// CSG pipeline. The GlyphSource is the abstraction: every parser (font,
// SVG, bitmap-traced) emits one of these and the builder treats them all
// identically.
//
// Two contour formats are supported:
//   • 'samsa'    — { points: [[x,y,flagByte],...], endPts: [..lastIdx..] }
//                  This is what the variable-font pipeline already produces;
//                  we keep it verbatim so the well-tested font path is
//                  byte-identical to v8.1.
//   • 'commands' — [ {type:'M', x, y}, {type:'L', x, y},
//                    {type:'Q', x1, y1, x, y},
//                    {type:'C', x1, y1, x2, y2, x, y},
//                    {type:'Z'} ]
//                  This matches opentype.js path command shape and is what
//                  the SVG / bitmap parsers emit.
//
// Coordinates are always in EM units, Y-up, origin at the typographic
// baseline (font glyphs) or at the bottom of the artwork bbox (graphics).

import { getSamsaFont } from '../font-parser.js';

// ─── Factory: font glyph ───────────────────────────────────────────────────
// Resolves the samsa instance for the requested axes and returns a source
// with samsa-format contours, so the builder's existing samsa walk runs
// against exactly the same data shape as in v8.1.
export function fromFontGlyph(activeGlyph, activeFont, axesValues) {
  let instanceGlyph = null;
  const sf = getSamsaFont();

  if (sf && Object.keys(axesValues).length > 0) {
    try {
      const fvs = {};
      sf.axes().forEach(axis => {
        const cleanTag = axis.axisTag.trim();
        const matchingKey = Object.keys(axesValues).find(k => k.trim() === cleanTag);
        fvs[axis.axisTag] = matchingKey ? axesValues[matchingKey] : axis.defaultValue;
      });
      const inst = sf.instance(fvs);

      let sGlyph = sf.glyphs[activeGlyph.index];
      if (!sGlyph && sf.loadGlyphById) sGlyph = sf.loadGlyphById(activeGlyph.index);

      if (sGlyph) {
        const ig = sGlyph.instantiate(inst);
        instanceGlyph = ig.numberOfContours < 0 ? ig.decompose() : ig;
      }
    } catch (e) {
      console.warn('Samsa glyph instantiation failed, falling back to opentype outline:', e);
      instanceGlyph = null;
    }
  }

  const os2 = activeFont.tables.os2;
  const capHeight = os2 && os2.sCapHeight ? os2.sCapHeight : activeFont.ascender;
  const xHeight   = os2 && os2.sxHeight   ? os2.sxHeight   : activeFont.unitsPerEm / 2;

  // Choose contour representation: samsa first, opentype fallback.
  let contours, bounds;
  if (instanceGlyph && instanceGlyph.endPts && instanceGlyph.endPts.length > 0 && instanceGlyph.points) {
    contours = {
      format: 'samsa',
      points: instanceGlyph.points,
      endPts: instanceGlyph.endPts,
    };
    bounds = boundsFromSamsa(instanceGlyph);
  } else if (activeGlyph.path && activeGlyph.path.commands && activeGlyph.path.commands.length > 0) {
    contours = {
      format: 'commands',
      commands: activeGlyph.path.commands.map(c => ({ ...c })),
    };
    bounds = {
      xMin: activeGlyph.xMin || 0, xMax: activeGlyph.xMax || 0,
      yMin: activeGlyph.yMin || 0, yMax: activeGlyph.yMax || 0,
    };
  } else {
    contours = null; // space-like glyph
    bounds = {
      xMin: activeGlyph.xMin || 0, xMax: activeGlyph.xMax || 0,
      yMin: activeGlyph.yMin || 0, yMax: activeGlyph.yMax || 0,
    };
  }

  return {
    kind: 'font-glyph',
    name: activeGlyph.name || String.fromCharCode(activeGlyph.unicode || 0) || `glyph_${activeGlyph.index}`,
    unitsPerEm: activeFont.unitsPerEm,
    metrics: {
      descender: activeFont.descender,
      ascender:  activeFont.ascender,
      capHeight, xHeight,
    },
    bounds,
    contours,
    meta: { unicode: activeGlyph.unicode },
  };
}

// ─── Factory: spacing quad (no contours, width-only) ───────────────────────
export function fromSpacingQuad(quad, activeFont) {
  const widthUnits = activeFont.unitsPerEm * quad.fraction;
  return {
    kind: 'spacing-quad',
    name: quad.name.replace(/\W+/g, '_'),
    unitsPerEm: activeFont.unitsPerEm,
    metrics: {
      descender: activeFont.descender,
      ascender:  activeFont.ascender,
      capHeight: activeFont.ascender,
      xHeight:   activeFont.ascender,
    },
    bounds: {
      xMin: 0,                xMax: widthUnits,
      yMin: activeFont.descender, yMax: activeFont.ascender,
    },
    contours: null,
    meta: { fraction: quad.fraction },
  };
}

// ─── Factory: command list (vector + bitmap pipelines) ─────────────────────
// `commands` is an opentype.js-style flat list. `name` is used for export.
// EM-unit space is normalized to 1000; metrics are synthetic so that the
// builder's vertical-bound heuristic resolves cleanly to 0..1000.
export function fromCommandList(commands, name, kind = 'vector', meta = {}) {
  const bounds = boundsFromCommands(commands);
  return {
    kind,
    name: (name || 'artwork').replace(/\W+/g, '_'),
    unitsPerEm: 1000,
    metrics: { descender: 0, ascender: 1000, capHeight: 1000, xHeight: 1000 },
    bounds,
    contours: { format: 'commands', commands },
    meta,
  };
}

// ─── Bounds helpers ────────────────────────────────────────────────────────
function boundsFromSamsa(instanceGlyph) {
  const lastIdx = instanceGlyph.endPts[instanceGlyph.endPts.length - 1];
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i <= lastIdx; i++) {
    const pt = instanceGlyph.points[i];
    if (!pt) continue;
    if (pt[0] < xMin) xMin = pt[0];
    if (pt[0] > xMax) xMax = pt[0];
    if (pt[1] < yMin) yMin = pt[1];
    if (pt[1] > yMax) yMax = pt[1];
  }
  if (!isFinite(xMin)) return { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
  return { xMin, xMax, yMin, yMax };
}

function boundsFromCommands(commands) {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  const consume = (x, y) => {
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
  };
  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
      case 'L':
        consume(cmd.x, cmd.y);
        break;
      case 'Q':
        consume(cmd.x1, cmd.y1);
        consume(cmd.x, cmd.y);
        break;
      case 'C':
        consume(cmd.x1, cmd.y1);
        consume(cmd.x2, cmd.y2);
        consume(cmd.x, cmd.y);
        break;
      case 'Z': default: break;
    }
  }
  if (!isFinite(xMin)) return { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
  return { xMin, xMax, yMin, yMax };
}
