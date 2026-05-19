import * as THREE from 'three';
import { CSG } from 'three-csg-ts';
import { getActiveFont, getSamsaFont } from './font-parser.js';

// ─── Defaults (every value is overridable via the slugOptions object) ───
const DEFAULTS = {
  bodySizeMM: 54.14,        // 144 didot pt
  slugHeight: 20.56,        // Continental shoulder height
  reliefHeight: 3.0,        // printing eye

  hollow: true,
  hollowMinWidth: 24,       // mm
  wallThickness: 8,         // mm

  drainEnabled: true,
  drainSize: 5,             // mm DIAMETER

  chamferEnabled: true,
  chamferSize: 1.083,       // mm (≈ 2% of body)

  footNickEnabled: true,
  footNickRadius: 2.0,      // mm

  baselineNickEnabled: true,
  baselineNickRadius: 1.0,  // mm

  beardEnabled: true,
  beardPercent: 2.0,        // % of EM, per side

  slopeEnabled: true,
  slopeAngle: 12,           // degrees
};

function resolveOptions(opt = {}) {
  // Merge supplied options with defaults, treating undefined/null as "use default".
  const merged = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (opt[k] !== undefined && opt[k] !== null) merged[k] = opt[k];
  }
  return merged;
}

export async function buildBlock(
  glyphIndex, category, glyphsList, axesValues,
  mirror, applyDraft, variableSize = true, slugOptions = {}
) {
  const activeFont = getActiveFont(axesValues);
  if (!activeFont) return null;

  const opts = resolveOptions(slugOptions);

  // ─── Master geometry constants (per-call, derived from options) ───
  const BODY_SIZE_MM = opts.bodySizeMM;
  const SLUG_HEIGHT  = opts.slugHeight;
  const RELIEF_HEIGHT = opts.reliefHeight;

  const u2mm  = BODY_SIZE_MM / activeFont.unitsPerEm;
  const beardPct = opts.beardEnabled ? opts.beardPercent : 0;
  const BEARD_UNITS = (beardPct / 100) * activeFont.unitsPerEm;
  const beard = BEARD_UNITS * u2mm;

  const slopeEnabled = applyDraft && opts.slopeEnabled && opts.slopeAngle > 0;
  const slopeAngleRad = (opts.slopeAngle * Math.PI) / 180;
  // Bevel offset = tan(angle) × relief depth → width of the chamfer-back per side
  const slopeBevelSize = slopeEnabled ? Math.tan(slopeAngleRad) * RELIEF_HEIGHT : 0;

  let blockMinX, blockMaxX, blockMinY, blockMaxY;
  let bY1 = 0, bY2 = 0;
  let activeGlyph = null;
  // Samsa-instantiated glyph (variated). Cached here so we compute it ONCE
  // and reuse it for both bounds calculation AND shape extraction below.
  let instanceGlyph = null;

  if (category === 'Spacing Quads') {
    const quad = glyphsList[glyphIndex];
    const widthUnits = activeFont.unitsPerEm * quad.fraction;
    blockMinX = 0;
    blockMaxX = widthUnits * u2mm;
    bY1 = activeFont.descender;
    bY2 = activeFont.ascender;
    blockMinY = bY1 * u2mm - beard;
    blockMaxY = bY2 * u2mm + beard;
  } else {
    activeGlyph = glyphsList[glyphIndex];

    // -------------------------------------------------------------------
    // STEP 1 — Build the variable instance of this glyph FIRST so that
    // every downstream size calculation uses the live geometry of
    // the selected axis combination, not the stale opentype.js defaults.
    // -------------------------------------------------------------------
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
        console.warn('Samsa glyph instantiation failed, falling back to opentype bounds:', e);
        instanceGlyph = null;
      }
    }

    // -------------------------------------------------------------------
    // STEP 2 — Bounding box from the instance's on-curve and Bezier
    // control points.
    // -------------------------------------------------------------------
    let gxMinUnits, gxMaxUnits, gyMinUnits, gyMaxUnits;
    if (instanceGlyph && instanceGlyph.endPts && instanceGlyph.endPts.length > 0 && instanceGlyph.points) {
      const lastIdx = instanceGlyph.endPts[instanceGlyph.endPts.length - 1];
      gxMinUnits = Infinity; gxMaxUnits = -Infinity;
      gyMinUnits = Infinity; gyMaxUnits = -Infinity;
      for (let i = 0; i <= lastIdx; i++) {
        const pt = instanceGlyph.points[i];
        if (!pt) continue;
        if (pt[0] < gxMinUnits) gxMinUnits = pt[0];
        if (pt[0] > gxMaxUnits) gxMaxUnits = pt[0];
        if (pt[1] < gyMinUnits) gyMinUnits = pt[1];
        if (pt[1] > gyMaxUnits) gyMaxUnits = pt[1];
      }
      if (!isFinite(gxMinUnits) || !isFinite(gxMaxUnits)) {
        gxMinUnits = activeGlyph.xMin || 0; gxMaxUnits = activeGlyph.xMax || 0;
      }
      if (!isFinite(gyMinUnits) || !isFinite(gyMaxUnits)) {
        gyMinUnits = activeGlyph.yMin || 0; gyMaxUnits = activeGlyph.yMax || 0;
      }
    } else {
      gxMinUnits = activeGlyph.xMin || 0;
      gxMaxUnits = activeGlyph.xMax || 0;
      gyMinUnits = activeGlyph.yMin || 0;
      gyMaxUnits = activeGlyph.yMax || 0;
    }

    // -------------------------------------------------------------------
    // STEP 3 — Apply mirror, then add the configurable beard space per side.
    // -------------------------------------------------------------------
    const gMinX = mirror ? -gxMaxUnits * u2mm : gxMinUnits * u2mm;
    const gMaxX = mirror ? -gxMinUnits * u2mm : gxMaxUnits * u2mm;
    blockMinX = gMinX - beard;
    blockMaxX = gMaxX + beard;

    // -------------------------------------------------------------------
    // STEP 4 — Vertical bounds.
    // -------------------------------------------------------------------
    const os2 = activeFont.tables.os2;
    const capHeight = os2 && os2.sCapHeight ? os2.sCapHeight : activeFont.ascender;
    const xHeight = os2 && os2.sxHeight ? os2.sxHeight : activeFont.unitsPerEm / 2;
    const gMinY = gyMinUnits;
    const gMaxY = gyMaxUnits;

    const THRESHOLD = 0.02 * activeFont.unitsPerEm;

    if (gMinY < -THRESHOLD) bY1 = activeFont.descender;
    else                    bY1 = 0;

    if (gMaxY > capHeight + THRESHOLD)      bY2 = activeFont.ascender;
    else if (gMaxY > xHeight + THRESHOLD)   bY2 = capHeight;
    else                                    bY2 = xHeight;

    if (!variableSize) {
      bY1 = activeFont.descender;
      bY2 = activeFont.ascender;
    }

    blockMinY = bY1 * u2mm - beard;
    blockMaxY = bY2 * u2mm + beard;
  }

  const blockWidth  = blockMaxX - blockMinX;
  const blockHeight = blockMaxY - blockMinY;
  if (blockWidth <= 0 || blockHeight <= 0) return null;

  // ─── Build slug body ────────────────────────────────────────────────
  const slugMesh = new THREE.Mesh(new THREE.BoxGeometry(blockWidth, blockHeight, SLUG_HEIGHT));
  slugMesh.position.set(blockMinX + blockWidth / 2, blockMinY + blockHeight / 2, SLUG_HEIGHT / 2);
  slugMesh.updateMatrix();
  let slugCSG = CSG.fromMesh(slugMesh);

  // ─── Foot chamfers (optional) ───────────────────────────────────────
  if (opts.chamferEnabled && opts.chamferSize > 0) {
    const chamf = opts.chamferSize;
    const makeChamfer = (w, h, d, x, y, z, rotX, rotY) => {
      const c = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
      c.rotation.set(rotX, rotY, 0);
      c.position.set(x, y, z);
      c.updateMatrix();
      slugCSG = slugCSG.subtract(CSG.fromMesh(c));
    };
    makeChamfer(blockWidth + 2, chamf * 2, chamf * 2, blockMinX + blockWidth / 2, blockMinY, 0, Math.PI / 4, 0);
    makeChamfer(blockWidth + 2, chamf * 2, chamf * 2, blockMinX + blockWidth / 2, blockMaxY, 0, Math.PI / 4, 0);
    makeChamfer(chamf * 2, blockHeight + 2, chamf * 2, blockMinX, blockMinY + blockHeight / 2, 0, 0, Math.PI / 4);
    makeChamfer(chamf * 2, blockHeight + 2, chamf * 2, blockMaxX, blockMinY + blockHeight / 2, 0, 0, Math.PI / 4);
  }

  // ─── Hollow core + drain hatches (optional) ─────────────────────────
  const wallThick = opts.wallThickness;
  const hollowW = blockWidth  - wallThick * 2;
  const hollowH = blockHeight - wallThick * 2;
  const hollowD = Math.max(SLUG_HEIGHT - 5.56, 0.1);
  const slugWideEnough = Math.min(blockWidth, blockHeight) >= opts.hollowMinWidth;

  if (opts.hollow && slugWideEnough && hollowW > 4 && hollowH > 4) {
    const hollow = new THREE.Mesh(new THREE.BoxGeometry(hollowW, hollowH, hollowD));
    hollow.position.set(blockMinX + blockWidth / 2, blockMinY + blockHeight / 2, hollowD / 2 - 0.1);
    hollow.updateMatrix();
    slugCSG = slugCSG.subtract(CSG.fromMesh(hollow));

    // Drains — only when hollow is present
    if (opts.drainEnabled && opts.drainSize > 0) {
      const drainR = opts.drainSize / 2;
      const drainX = new THREE.Mesh(new THREE.CylinderGeometry(drainR, drainR, blockWidth + 2, 16));
      drainX.rotation.z = Math.PI / 2;
      drainX.position.set(blockMinX + blockWidth / 2, blockMinY + blockHeight / 2, hollowD / 2);
      drainX.updateMatrix();
      slugCSG = slugCSG.subtract(CSG.fromMesh(drainX));

      const drainY = new THREE.Mesh(new THREE.CylinderGeometry(drainR, drainR, blockHeight + 2, 16));
      drainY.position.set(blockMinX + blockWidth / 2, blockMinY + blockHeight / 2, hollowD / 2);
      drainY.updateMatrix();
      slugCSG = slugCSG.subtract(CSG.fromMesh(drainY));
    }
  }

  // ─── Foot nick (ID groove on side of slug at the foot) ──────────────
  if (opts.footNickEnabled && opts.footNickRadius > 0) {
    const nick = new THREE.Mesh(
      new THREE.CylinderGeometry(opts.footNickRadius, opts.footNickRadius, blockWidth + 2, 24)
    );
    nick.rotation.z = Math.PI / 2;
    nick.position.set(blockMinX + blockWidth / 2, blockMinY, opts.footNickRadius * 3);
    nick.updateMatrix();
    slugCSG = slugCSG.subtract(CSG.fromMesh(nick));
  }

  // ─── Baseline nick (small semicircle at y=0, used when bY1 = descender) ──
  if (opts.baselineNickEnabled && opts.baselineNickRadius > 0 && !(variableSize && bY1 === 0)) {
    const blNick = new THREE.Mesh(
      new THREE.CylinderGeometry(opts.baselineNickRadius, opts.baselineNickRadius, blockWidth + 2, 16)
    );
    blNick.rotation.z = Math.PI / 2;
    blNick.position.set(blockMinX + blockWidth / 2, 0, 0);
    blNick.updateMatrix();
    slugCSG = slugCSG.subtract(CSG.fromMesh(blNick));
  }

  const finalSlug = CSG.toMesh(slugCSG, new THREE.Matrix4());
  finalSlug.material = new THREE.MeshStandardMaterial({
    color: 0x9090a8, roughness: 0.5, metalness: 0.5
  });

  const printGroup = new THREE.Group();
  printGroup.add(finalSlug);

  // ─── Glyph eye / relief ─────────────────────────────────────────────
  if (activeGlyph) {
    const shapePath = new THREE.ShapePath();

    if (instanceGlyph && instanceGlyph.endPts && instanceGlyph.points) {
      const finalGlyph = instanceGlyph;
      let startPt = 0;
      finalGlyph.endPts.forEach(endPt => {
        const contourLen = endPt - startPt + 1;
        const contour = [];
        for (let p = startPt; p <= endPt; p++) {
          const pt = finalGlyph.points[p];
          const nextPt = finalGlyph.points[(p - startPt + 1) % contourLen + startPt];
          contour.push(pt);
          if (!(pt[2] & 0x01 || nextPt[2] & 0x01)) {
            contour.push([(pt[0] + nextPt[0]) / 2, (pt[1] + nextPt[1]) / 2, 1]);
          }
        }
        if (!(contour[0][2] & 0x01)) contour.unshift(contour.pop());

        for (let p = 0; p < contour.length; p++) {
          const pt = contour[p];
          const x = pt[0] * u2mm;
          const y = pt[1] * u2mm;
          if (p === 0) {
            shapePath.moveTo(x, y);
          } else if (pt[2] & 0x01) {
            shapePath.lineTo(x, y);
          } else {
            const nextPt = contour[(p + 1) % contour.length];
            shapePath.quadraticCurveTo(x, y, nextPt[0] * u2mm, nextPt[1] * u2mm);
            p++;
          }
        }
        startPt = endPt + 1;
      });
    } else {
      const cmds = activeGlyph.path.commands;
      cmds.forEach(cmd => {
        if (cmd.type === 'M') shapePath.moveTo(cmd.x * u2mm, cmd.y * u2mm);
        else if (cmd.type === 'L') shapePath.lineTo(cmd.x * u2mm, cmd.y * u2mm);
        else if (cmd.type === 'Q') shapePath.quadraticCurveTo(cmd.x1 * u2mm, cmd.y1 * u2mm, cmd.x * u2mm, cmd.y * u2mm);
        else if (cmd.type === 'C') shapePath.bezierCurveTo(cmd.x1 * u2mm, cmd.y1 * u2mm, cmd.x2 * u2mm, cmd.y2 * u2mm, cmd.x * u2mm, cmd.y * u2mm);
      });
    }

    const shapes = shapePath.toShapes(false);
    if (shapes.length > 0) {
      const eyeGeo = new THREE.ExtrudeGeometry(shapes, {
        depth: slopeEnabled ? 0.001 : RELIEF_HEIGHT,
        bevelEnabled: slopeEnabled,
        bevelSegments: 1,
        bevelSize: slopeBevelSize,
        bevelThickness: slopeEnabled ? RELIEF_HEIGHT : 0,
        bevelOffset: 0,
      });

      const eyeMesh = new THREE.Mesh(eyeGeo, new THREE.MeshStandardMaterial({
        color: 0xb48afa, roughness: 0.4, metalness: 0.2
      }));
      eyeMesh.position.set(0, 0, SLUG_HEIGHT);
      if (mirror) eyeMesh.scale.x = -1;
      eyeMesh.updateMatrix();
      printGroup.add(eyeMesh);
    }
  }

  return {
    group: printGroup,
    w: blockWidth, h: blockHeight,
    minX: blockMinX, minY: blockMinY, maxY: blockMaxY,
  };
}
