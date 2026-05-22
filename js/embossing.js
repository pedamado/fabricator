// ─── Embossing & Debossing pair generator ──────────────────────────────────
//
// One GlyphSource → { matrix, counter } — two independent THREE.Groups.
//
// v9.1.2 — Geometry strategy:
//
//   Cavity sides (matrix in embossing, counter in debossing) are built as
//   a single THREE.ExtrudeGeometry of a THREE.Shape whose .holes[] are the
//   glyph contours. *No CSG cuts the complex glyph geometry.* Earcut
//   triangulates the perimeter-with-holes case reliably even for letters
//   with counters (O, B, e, a, …) and for variable-font composites.
//
//   Convex sides (matrix in debossing, counter in embossing) keep the
//   Z-mirrored ExtrudeGeometry of the glyph as a raised mesh on top of
//   the body — that side never used CSG and rendered correctly after
//   the v9.1.1 winding fix.
//
//   Each half emits two or three separate meshes into its THREE.Group
//   (slug + cavity plate, or slug + raised relief). Touching coplanar
//   faces are intentional: STL/OBJ slicers merge them into one
//   contiguous print. No CSG union is attempted across the joint.
//
//   CSG is now restricted to the small, simple operations that have been
//   reliable for two years in the printing-matrix pipeline: foot
//   chamfers, the foot ID-nick, and the baseline nick — all rectangular
//   box subtractions on the slug body. The plate-with-cavity geometry
//   never touches CSG.
//
// Slope (the user's "inverted" slope for embossing/debossing):
//   • Cavity walls — wider at the top opening, narrower at the deep end.
//     Achieved by ExtrudeGeometry's `bevelSize` over `bevelThickness`.
//   • Raised relief — exact at the base, expanding toward the tip.
//     Achieved by makeReliefExtrudeGeometry(invertSlope: true).
//
// Paper tolerance is applied to the cavity HOLES via ExtrudeGeometry's
// `bevelOffset`, which uniformly expands every contour in the shape —
// outer perimeter and all holes. We pre-compensate by shrinking the
// outer plate outline by the same amount so the final plate matches the
// user's specified plate dimensions on its TOP face.

import * as THREE from 'three';
import { CSG } from 'three-csg-ts';
import polygonClipping from 'polygon-clipping';
import { makeReliefExtrudeGeometry, buildShapePath } from './builder.js';
import { getActiveFont } from './font-parser.js';
import { fromFontGlyph, fromSpacingQuad } from './sources/glyph-source.js';

const MATRIX_COLOR        = 0x9090a8;
const COUNTER_COLOR       = 0x70b8a0;
const RELIEF_TINT_MATRIX  = 0xb48afa;
const RELIEF_TINT_COUNTER = 0x64dfdf;

const DEFAULT_EMBOSS_OPTIONS = {
  enabled: false,
  mode: 'deboss',
  handEmbosser: false,
  paperTolerance: 0.10,
  slopeAngle: 12,
  matrixReliefHeight: 0.6,
  counterBaseHeight: 1.0,
  counterReliefHeight: 0.6,
  plateShape: 'glyph',
  plateWidth: 40,
  plateHeight: 40,
  lockAspect: true,
  glyphScale: 1.0,
  grayscaleLevels: 0,
};

export function resolveEmbossOptions(opt = {}) {
  const merged = { ...DEFAULT_EMBOSS_OPTIONS };
  for (const k of Object.keys(DEFAULT_EMBOSS_OPTIONS)) {
    if (opt[k] !== undefined && opt[k] !== null) merged[k] = opt[k];
  }
  return merged;
}

// ─── Public entry point ────────────────────────────────────────────────────
export async function buildEmbossingPair(source, slugOptions, embossOptions, {
  mirror = true, applyDraft = true,
} = {}) {
  if (!source) return null;

  const slugOpts   = { ...slugOptions };
  const embossOpts = resolveEmbossOptions(embossOptions);

  const BODY_SIZE_MM    = slugOpts.bodySizeMM ?? 54.14;
  const SLUG_HEIGHT     = slugOpts.slugHeight ?? 20.56;
  const MATRIX_RELIEF   = embossOpts.matrixReliefHeight;
  const COUNTER_BASE    = embossOpts.counterBaseHeight;
  const COUNTER_RELIEF  = embossOpts.counterReliefHeight;
  const PAPER_TOL       = Math.max(0, embossOpts.paperTolerance);
  const SLOPE_RAD       = (embossOpts.slopeAngle * Math.PI) / 180;
  const GLYPH_SCALE     = Math.max(0.1, embossOpts.glyphScale);
  const slopeEnabled    = applyDraft && embossOpts.slopeAngle > 0;

  // ─── Source → mm coordinate space + glyph bounds ────────────────────
  const u2mm = (BODY_SIZE_MM / source.unitsPerEm) * GLYPH_SCALE;
  const gBounds = source.bounds || { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
  const gMinY = gBounds.yMin * u2mm;
  const gMaxY = gBounds.yMax * u2mm;
  const glyphCy = (gMinY + gMaxY) / 2;
  const beardPct = slugOpts.beardEnabled ? (slugOpts.beardPercent ?? 2) : 0;
  const beard = (beardPct / 100) * source.unitsPerEm * u2mm;

  // ─── Two layouts: matrix uses the user's mirror flag; counter uses
  //                  the OPPOSITE. The counter is flipped face-down
  //                  when placed on the platen, so modeling it with
  //                  reversed X-mirror makes the two halves register
  //                  correctly under the press. ─────────────────────
  const computeLayout = (useMirror) => {
    const gMinX = useMirror ? -gBounds.xMax * u2mm : gBounds.xMin * u2mm;
    const gMaxX = useMirror ? -gBounds.xMin * u2mm : gBounds.xMax * u2mm;
    const glyphCx = (gMinX + gMaxX) / 2;
    let plateW, plateH, plateMinX, plateMinY;
    let plateIsRound = false;
    if (embossOpts.plateShape === 'rect' || embossOpts.plateShape === 'round') {
      plateW = embossOpts.plateWidth;
      plateH = embossOpts.plateHeight;
      plateMinX = glyphCx - plateW / 2;
      plateMinY = glyphCy - plateH / 2;
      plateIsRound = embossOpts.plateShape === 'round';
    } else {
      plateMinX = gMinX - beard;
      plateMinY = gMinY - beard;
      plateW = (gMaxX - gMinX) + beard * 2;
      plateH = (gMaxY - gMinY) + beard * 2;
    }
    return {
      gMinX, gMaxX,
      plateW, plateH, plateMinX, plateMinY, plateIsRound,
      plateCx: plateMinX + plateW / 2,
      plateCy: plateMinY + plateH / 2,
    };
  };
  const M = computeLayout(mirror);    // Matrix
  const C = computeLayout(!mirror);   // Counter — opposite mirror
  if (M.plateW <= 0.1 || M.plateH <= 0.1) return null;

  // ─── Build glyph contour shapes for the cavity (uses ShapePath.toShapes
  //     so earcut handles outer-vs-counter topology robustly even for
  //     composite / variable-font glyphs at extreme weights). Two sets:
  //     one per mirror state. ─────────────────────────────────────────
  const matrixGlyphShapes  = contoursToShapes(source.contours, u2mm, mirror);
  const counterGlyphShapes = contoursToShapes(source.contours, u2mm, !mirror);

  // Also keep the legacy ShapePath for the raised-relief side (which still
  // uses makeReliefExtrudeGeometry).
  const shapePath = new THREE.ShapePath();
  if (source.contours) {
    buildShapePath(shapePath, source.contours, u2mm);
  }
  const shapes = shapePath.toShapes(false);

  // Slope flare amount (horizontal, mm per side, over the relief height).
  const matrixSlopeBevel  = slopeEnabled ? Math.tan(SLOPE_RAD) * MATRIX_RELIEF  : 0;
  const counterSlopeBevel = slopeEnabled ? Math.tan(SLOPE_RAD) * COUNTER_RELIEF : 0;

  // Hand-embosser mode: skip the slug body entirely; matrix uses a 1mm
  // base just like the counter.
  const matrixBaseHeight = embossOpts.handEmbosser ? COUNTER_BASE : SLUG_HEIGHT;

  // ─── Build MATRIX ──────────────────────────────────────────────────────
  const matrixIsCavity = embossOpts.mode === 'emboss';
  const matrixGroup = new THREE.Group();
  matrixGroup.userData = { embossingRole: 'matrix' };

  // 1. Slug / base body — always slugHeight tall (or counterBase in hand mode).
  //    Built as a plain Box; CSG only for chamfers + nicks if applicable.
  let slugCSG = CSG.fromMesh(makePlateMesh(
    M.plateW, M.plateH, matrixBaseHeight,
    M.plateCx, M.plateCy, matrixBaseHeight / 2,
    M.plateIsRound,
  ));
  if (!embossOpts.handEmbosser && !M.plateIsRound) {
    slugCSG = applyChamferAndNicks(slugCSG, slugOpts, {
      plateMinX: M.plateMinX, plateMinY: M.plateMinY,
      plateW: M.plateW, plateH: M.plateH,
      plateCx: M.plateCx, plateCy: M.plateCy,
    });
  }
  const matrixSlugMesh = CSG.toMesh(slugCSG, new THREE.Matrix4());
  matrixSlugMesh.geometry.computeVertexNormals();
  matrixSlugMesh.material = new THREE.MeshStandardMaterial({
    color: MATRIX_COLOR, roughness: 0.5, metalness: 0.5,
  });
  matrixGroup.add(matrixSlugMesh);

  // 2. Glyph operation — cavity plate (shape-with-holes) or raised relief mesh.
  if (matrixGlyphShapes.length > 0 || shapes.length > 0) {
    if (matrixIsCavity) {
      // EMBOSSING: cavity plate + counter islands stacked on top of slug.
      const cavityGroup = buildCavityPlateGroup({
        plateW: M.plateW, plateH: M.plateH,
        plateCx: M.plateCx, plateCy: M.plateCy,
        plateIsRound: M.plateIsRound,
        glyphShapes: matrixGlyphShapes,
        depth: MATRIX_RELIEF,
        slopeBevel: matrixSlopeBevel,
        paperTolerance: PAPER_TOL,
        baseColor: MATRIX_COLOR,
      });
      cavityGroup.position.z = matrixBaseHeight;
      matrixGroup.add(cavityGroup);
    } else if (shapes.length > 0) {
      // DEBOSSING: raised positive glyph on top of slug. Inverted slope.
      const reliefGeo = makeReliefExtrudeGeometry(shapes, {
        reliefHeight: MATRIX_RELIEF,
        slopeBevelSize: matrixSlopeBevel,
        baseOffset: 0,
        invertSlope: true,
        beveled: slopeEnabled,
      });
      const reliefMesh = new THREE.Mesh(reliefGeo, new THREE.MeshStandardMaterial({
        color: RELIEF_TINT_MATRIX, roughness: 0.4, metalness: 0.2,
      }));
      reliefMesh.position.set(0, 0, matrixBaseHeight);
      if (mirror) reliefMesh.scale.x = -1;
      reliefMesh.updateMatrix();
      matrixGroup.add(reliefMesh);
    }
  }

  // ─── Build COUNTER ─────────────────────────────────────────────────────
  const counterIsCavity = embossOpts.mode === 'deboss';
  const counterGroup = new THREE.Group();
  counterGroup.userData = { embossingRole: 'counter' };

  // 1. Base layer — always 1mm flat plate. Uses counter layout (C.*).
  const counterBaseMesh = makePlateMesh(
    C.plateW, C.plateH, COUNTER_BASE,
    C.plateCx, C.plateCy, COUNTER_BASE / 2,
    C.plateIsRound,
  );
  counterBaseMesh.material = new THREE.MeshStandardMaterial({
    color: COUNTER_COLOR, roughness: 0.5, metalness: 0.5,
  });
  counterGroup.add(counterBaseMesh);

  // 2. Glyph operation — counter geometry is mirrored opposite to the
  //    matrix (X-inverted) so that when flipped face-down on the platen
  //    it registers correctly with the matrix below.
  if (counterGlyphShapes.length > 0 || shapes.length > 0) {
    if (counterIsCavity) {
      // DEBOSSING: cavity plate + counter islands stacked on top of base.
      // Paper tolerance applied to the cavity side.
      const cavityGroup = buildCavityPlateGroup({
        plateW: C.plateW, plateH: C.plateH,
        plateCx: C.plateCx, plateCy: C.plateCy,
        plateIsRound: C.plateIsRound,
        glyphShapes: counterGlyphShapes,
        depth: COUNTER_RELIEF,
        slopeBevel: counterSlopeBevel,
        paperTolerance: PAPER_TOL,
        baseColor: COUNTER_COLOR,
      });
      cavityGroup.position.z = COUNTER_BASE;
      counterGroup.add(cavityGroup);
    } else if (shapes.length > 0) {
      // EMBOSSING counter: raised positive glyph on the 1mm base. Inverted
      // slope. scale.x = -1 applied when !mirror — i.e., the *opposite* of
      // the matrix's mirror state.
      const reliefGeo = makeReliefExtrudeGeometry(shapes, {
        reliefHeight: COUNTER_RELIEF,
        slopeBevelSize: counterSlopeBevel,
        baseOffset: 0,
        invertSlope: true,
        beveled: slopeEnabled,
      });
      const reliefMesh = new THREE.Mesh(reliefGeo, new THREE.MeshStandardMaterial({
        color: RELIEF_TINT_COUNTER, roughness: 0.4, metalness: 0.2,
      }));
      reliefMesh.position.set(0, 0, COUNTER_BASE);
      if (!mirror) reliefMesh.scale.x = -1;
      reliefMesh.updateMatrix();
      counterGroup.add(reliefMesh);
    }
  }

  return {
    matrix: {
      group: matrixGroup,
      w: M.plateW, h: M.plateH,
      minX: M.plateMinX, minY: M.plateMinY,
      maxY: M.plateMinY + M.plateH,
    },
    counter: {
      group: counterGroup,
      w: C.plateW, h: C.plateH,
      minX: C.plateMinX, minY: C.plateMinY,
      maxY: C.plateMinY + C.plateH,
    },
    plateW: M.plateW, plateH: M.plateH,
  };
}

// ─── Cavity plate via shape-with-holes + counter islands (no CSG) ─────────
//
// Returns a THREE.Group containing:
//   • ONE plate mesh — extruded `THREE.Shape` whose outer perimeter is the
//     user's plate, and whose .holes[] are the OUTER outlines of every
//     glyph shape (one per character). The cavity goes from z=0 (bottom,
//     where it meets the slug/base layer below) up to z=depth (top, the
//     opening).
//   • N counter-island meshes — one per .holes[] entry of every glyph
//     shape. These are solid pillars sitting INSIDE the cavity holes,
//     representing the "filled" interior of letters with counters
//     (O, B, e, a, g, …). Without them the cavity would swallow the
//     counter and the embossed paper would lose the letterform.
//
// Why this design instead of CSG or even-odd holes:
//   • CSG of complex glyph cavities → non-manifold output, missing faces.
//   • Adding each subpath as a separate hole on the same plate Shape
//     relies on earcut's even-odd interpretation, which falls apart on
//     overlapping / composite variable-font sub-outlines (the v9.1.2
//     bug visible on `e`, `g`, `a` at heavy weights).
//   • `THREE.ShapePath.toShapes(false)` already does the containment
//     analysis the existing raised-relief code uses successfully —
//     reusing it here means the cavity inherits the same robustness.
//
// Slope: bevel on the extrusion flares both the plate's holes (cavity
// walls) and each island's outer (the counter sides) the same way, so
// matrix cavity and counter island taper consistently and the paper has
// a uniform gap to fold into.
//
// Paper tolerance: applied via the plate extrusion's `bevelOffset`
// (expands cavity holes outward). NOT applied to islands — the counter
// shape is exact so paper has full room around it.
function buildCavityPlateGroup({
  plateW, plateH, plateCx, plateCy, plateIsRound,
  glyphShapes, depth, slopeBevel, paperTolerance, baseColor,
}) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: baseColor, roughness: 0.5, metalness: 0.5,
  });

  // Pre-compensate the plate's outer outline so the TOP face matches the
  // user's specified plate dimensions after bevelOffset is applied.
  const shrink = paperTolerance;
  const plateShape = new THREE.Shape();
  if (plateIsRound) {
    plateShape.absellipse(
      plateCx, plateCy,
      Math.max(0.5, plateW / 2 - shrink),
      Math.max(0.5, plateH / 2 - shrink),
      0, Math.PI * 2, false, 0,
    );
  } else {
    const minX = plateCx - plateW / 2 + shrink;
    const maxX = plateCx + plateW / 2 - shrink;
    const minY = plateCy - plateH / 2 + shrink;
    const maxY = plateCy + plateH / 2 - shrink;
    plateShape.moveTo(minX, minY);
    plateShape.lineTo(maxX, minY);
    plateShape.lineTo(maxX, maxY);
    plateShape.lineTo(minX, maxY);
    plateShape.closePath();
  }

  // Each glyph shape's OUTER outline becomes a hole in the plate. We
  // strip its .holes (counters) so the plate doesn't try to nest them —
  // the counters become independent island meshes below.
  for (const gShape of glyphShapes) {
    const outerOnly = new THREE.Path();
    outerOnly.curves = gShape.curves.slice();
    plateShape.holes.push(outerOnly);
  }

  const useBevel = slopeBevel > 0 || paperTolerance > 0;
  const bThick = Math.min(slopeBevel || 0.001, depth * 0.49);

  // 1. Plate-with-cavities
  const plateGeo = new THREE.ExtrudeGeometry(plateShape, {
    depth: depth,
    bevelEnabled: useBevel,
    bevelSegments: 1,
    bevelThickness: bThick,
    bevelSize: slopeBevel,
    bevelOffset: paperTolerance,
    curveSegments: 16,
  });
  plateGeo.computeVertexNormals();
  group.add(new THREE.Mesh(plateGeo, material));

  // 2. Counter islands — one per counter (= .hole) of every glyph shape.
  for (const gShape of glyphShapes) {
    if (!gShape.holes || gShape.holes.length === 0) continue;
    for (const counterPath of gShape.holes) {
      const islandShape = pathToReversedShape(counterPath);
      if (!islandShape) continue;
      const islandGeo = new THREE.ExtrudeGeometry(islandShape, {
        depth: depth,
        bevelEnabled: useBevel,
        bevelSegments: 1,
        bevelThickness: bThick,
        bevelSize: slopeBevel,
        bevelOffset: 0, // exact counter — no paper-tolerance expansion
        curveSegments: 16,
      });
      islandGeo.computeVertexNormals();
      group.add(new THREE.Mesh(islandGeo, material));
    }
  }

  return group;
}

// Convert a THREE.Path (which had been a hole inside a Shape, so its
// winding is the "hole" direction) into a THREE.Shape whose OUTER outline
// is the reversed direction — i.e. proper "filled solid" winding.
// Implementation samples the path to a polyline; this loses Bézier
// smoothness but is fine for counters at 0.6 mm relief height, and is
// exactly the trick that lets us avoid vendoring a polygon-offset library.
function pathToReversedShape(path) {
  const pts = path.getPoints(48);
  // Strip a duplicate end vertex if the sampler emitted one.
  while (
    pts.length > 2 &&
    Math.abs(pts[0].x - pts[pts.length - 1].x) < 1e-5 &&
    Math.abs(pts[0].y - pts[pts.length - 1].y) < 1e-5
  ) {
    pts.pop();
  }
  if (pts.length < 3) return null;
  pts.reverse();
  const shape = new THREE.Shape();
  shape.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    shape.lineTo(pts[i].x, pts[i].y);
  }
  shape.closePath();
  return shape;
}

// ─── Source contours → THREE.Shape[] (with outer + counters separated) ────
// Funnels the glyph contours through THREE.ShapePath.toShapes(false), which
// uses containment analysis to identify which sub-contours are outer
// outlines and which are counters (inner holes). u2mm scaling and the
// mirror flag are baked into the X coordinates as we go.
function contoursToShapes(contours, u2mm, mirror) {
  if (!contours) return [];
  const sp = new THREE.ShapePath();
  const sx = mirror ? -1 : 1;
  const X = (x) => x * u2mm * sx;
  const Y = (y) => y * u2mm;

  if (contours.format === 'samsa') {
    let startPt = 0;
    contours.endPts.forEach(endPt => {
      const contourLen = endPt - startPt + 1;
      const contour = [];
      for (let p = startPt; p <= endPt; p++) {
        const pt = contours.points[p];
        const nextPt = contours.points[((p - startPt + 1) % contourLen) + startPt];
        contour.push(pt);
        if (!(pt[2] & 0x01 || nextPt[2] & 0x01)) {
          contour.push([(pt[0] + nextPt[0]) / 2, (pt[1] + nextPt[1]) / 2, 1]);
        }
      }
      if (!(contour[0][2] & 0x01)) contour.unshift(contour.pop());

      for (let p = 0; p < contour.length; p++) {
        const pt = contour[p];
        const x = X(pt[0]);
        const y = Y(pt[1]);
        if (p === 0) {
          sp.moveTo(x, y);
        } else if (pt[2] & 0x01) {
          sp.lineTo(x, y);
        } else {
          const nextPt = contour[(p + 1) % contour.length];
          sp.quadraticCurveTo(x, y, X(nextPt[0]), Y(nextPt[1]));
          p++;
        }
      }
      startPt = endPt + 1;
    });
  } else if (contours.format === 'commands') {
    for (const cmd of contours.commands) {
      switch (cmd.type) {
        case 'M': sp.moveTo(X(cmd.x), Y(cmd.y)); break;
        case 'L': sp.lineTo(X(cmd.x), Y(cmd.y)); break;
        case 'Q': sp.quadraticCurveTo(X(cmd.x1), Y(cmd.y1), X(cmd.x), Y(cmd.y)); break;
        case 'C': sp.bezierCurveTo(X(cmd.x1), Y(cmd.y1), X(cmd.x2), Y(cmd.y2), X(cmd.x), Y(cmd.y)); break;
      }
    }
  }

  const rawShapes = sp.toShapes(false);

  // ─── Polygon-union pass (v9.1.5) ─────────────────────────────────
  // Variable-font composite glyphs frequently ship with OVERLAPPING
  // sub-contours that ShapePath.toShapes() can't merge (containment
  // analysis alone identifies outer-vs-hole but doesn't resolve
  // overlaps). Run a Martinez polygon union via polygon-clipping to
  // flatten everything into clean disjoint shapes before extrusion.
  // The same step happens to fix self-intersecting SVG paths and the
  // occasional ImageTracer artifact.
  return unionShapes(rawShapes);
}

// ─── Boolean-union pass via polygon-clipping ──────────────────────────────
// Samples every contour to a polyline, runs Martinez union, then re-builds
// THREE.Shape objects with clean outer + holes. Bézier smoothness is lost
// in the process (everything becomes line segments) — at letterpress
// embossing scale (≤ 2 mm relief) this is invisible, and we keep the
// sample density high (64 samples per closed contour) so the polyline
// reads as a smooth curve in the viewport.
function unionShapes(shapes, sampleDivisions = 64) {
  if (!shapes || shapes.length === 0) return shapes;
  if (typeof polygonClipping === 'undefined' || !polygonClipping.union) {
    return shapes;
  }
  try {
    const inputPolys = shapes
      .map(s => shapeToPolygon(s, sampleDivisions))
      .filter(p => p && p[0] && p[0].length >= 3);
    if (inputPolys.length === 0) return shapes;

    // polygonClipping.union(geom1, geom2, …) → MultiPolygon
    const merged = polygonClipping.union(...inputPolys);
    if (!merged || merged.length === 0) return shapes;

    return merged.map(polygonToShape);
  } catch (e) {
    // Bad input (degenerate triangle, collinear vertices, etc.) → fall back
    // to the un-merged shapes. The earcut path inside ExtrudeGeometry can
    // usually cope; worst case is a visible artifact, never a crash.
    console.warn('Polygon union failed; using raw shapes:', e);
    return shapes;
  }
}

function shapeToPolygon(shape, divisions) {
  const ring = pathToRing(shape, divisions);
  if (!ring || ring.length < 3) return null;
  const polygon = [ring];
  if (shape.holes && shape.holes.length > 0) {
    for (const h of shape.holes) {
      const hr = pathToRing(h, divisions);
      if (hr && hr.length >= 3) polygon.push(hr);
    }
  }
  return polygon;
}

function pathToRing(path, divisions) {
  const pts = path.getPoints(divisions);
  // Drop duplicate closing vertex if the sampler emitted one.
  while (
    pts.length > 2 &&
    Math.abs(pts[0].x - pts[pts.length - 1].x) < 1e-5 &&
    Math.abs(pts[0].y - pts[pts.length - 1].y) < 1e-5
  ) {
    pts.pop();
  }
  if (pts.length < 3) return null;
  // polygon-clipping accepts either closed or open rings; close for safety.
  const ring = pts.map(p => [p.x, p.y]);
  ring.push([pts[0].x, pts[0].y]);
  return ring;
}

function polygonToShape(polygon) {
  const outer = polygon[0];
  const shape = new THREE.Shape();
  shape.moveTo(outer[0][0], outer[0][1]);
  for (let i = 1; i < outer.length; i++) {
    shape.lineTo(outer[i][0], outer[i][1]);
  }
  shape.closePath();
  for (let h = 1; h < polygon.length; h++) {
    const ring = polygon[h];
    const hole = new THREE.Path();
    hole.moveTo(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) {
      hole.lineTo(ring[i][0], ring[i][1]);
    }
    hole.closePath();
    shape.holes.push(hole);
  }
  return shape;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function makePlateMesh(w, h, thickness, cx, cy, cz, round) {
  if (round) {
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, thickness, 64));
    cyl.rotation.x = Math.PI / 2;
    cyl.scale.set(w / 2, h / 2, 1);
    cyl.position.set(cx, cy, cz);
    cyl.updateMatrix();
    return cyl;
  }
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, thickness));
  box.position.set(cx, cy, cz);
  box.updateMatrix();
  return box;
}

function applyChamferAndNicks(slugCSG, slugOpts, ctx) {
  const { plateMinX, plateMinY, plateW, plateH, plateCx, plateCy } = ctx;

  if (slugOpts.chamferEnabled && slugOpts.chamferSize > 0) {
    const chamf = slugOpts.chamferSize;
    const cut = (w, h, d, x, y, z, rotX, rotY) => {
      const c = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
      c.rotation.set(rotX, rotY, 0);
      c.position.set(x, y, z);
      c.updateMatrix();
      slugCSG = slugCSG.subtract(CSG.fromMesh(c));
    };
    cut(plateW + 2, chamf * 2, chamf * 2, plateCx, plateMinY, 0, Math.PI / 4, 0);
    cut(plateW + 2, chamf * 2, chamf * 2, plateCx, plateMinY + plateH, 0, Math.PI / 4, 0);
    cut(chamf * 2, plateH + 2, chamf * 2, plateMinX, plateCy, 0, 0, Math.PI / 4);
    cut(chamf * 2, plateH + 2, chamf * 2, plateMinX + plateW, plateCy, 0, 0, Math.PI / 4);
  }
  if (slugOpts.footNickEnabled && slugOpts.footNickRadius > 0) {
    const nick = new THREE.Mesh(
      new THREE.CylinderGeometry(slugOpts.footNickRadius, slugOpts.footNickRadius, plateW + 2, 24)
    );
    nick.rotation.z = Math.PI / 2;
    nick.position.set(plateCx, plateMinY, slugOpts.footNickRadius * 3);
    nick.updateMatrix();
    slugCSG = slugCSG.subtract(CSG.fromMesh(nick));
  }
  if (slugOpts.baselineNickEnabled && slugOpts.baselineNickRadius > 0 && plateMinY < -0.5) {
    const blNick = new THREE.Mesh(
      new THREE.CylinderGeometry(slugOpts.baselineNickRadius, slugOpts.baselineNickRadius, plateW + 2, 16)
    );
    blNick.rotation.z = Math.PI / 2;
    blNick.position.set(plateCx, 0, 0);
    blNick.updateMatrix();
    slugCSG = slugCSG.subtract(CSG.fromMesh(blNick));
  }
  return slugCSG;
}

// ─── Convenience: legacy-style buildBlock wrapper for the per-glyph loop ───
export async function buildEmbossingBlock(
  glyphIndex, category, glyphsList, axesValues,
  mirror, applyDraft, _variableSize, slugOptions, embossOptions
) {
  const activeFont = getActiveFont(axesValues);
  if (!activeFont) return null;
  const item = glyphsList[glyphIndex];
  if (!item) return null;
  const source = category === 'Spacing Quads'
    ? fromSpacingQuad(item, activeFont)
    : fromFontGlyph(item, activeFont, axesValues);
  return buildEmbossingPair(source, slugOptions, embossOptions, { mirror, applyDraft });
}
