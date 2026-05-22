import * as THREE from 'three';
import { CSG } from 'three-csg-ts';
import { getActiveFont } from './font-parser.js';
import { fromFontGlyph, fromSpacingQuad } from './sources/glyph-source.js';

// ─── Defaults (every value is overridable via the slugOptions object) ───
const DEFAULTS = {
  bodySizeMM: 54.14,        // 144 didot pt
  slugHeight: 20.56,        // Continental shoulder height
  reliefHeight: 3.0,        // printing eye

  hollow: true,
  hollowMinWidth: 24,       // mm
  wallThickness: 8,         // mm

  // Internal support walls inside the hollow cavity.
  // Triggered when a hollow dimension exceeds 4 × wallThickness; the cavity
  // is then subdivided into a grid of cells whose span ≤ maxCellSpan.
  supportWallsEnabled: true,
  maxCellSpan: 15,          // mm — target maximum cell span in either axis

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

// ─── Public: legacy font-glyph entry point ─────────────────────────────────
// Kept so existing callers (ui.js generate3D loop, exporter.exportZIP) keep
// working. Internally this just builds a GlyphSource and delegates to
// buildSlugFromSource — the real engine.
export async function buildBlock(
  glyphIndex, category, glyphsList, axesValues,
  mirror, applyDraft, variableSize = true, slugOptions = {}
) {
  const activeFont = getActiveFont(axesValues);
  if (!activeFont) return null;

  const item = glyphsList[glyphIndex];
  if (!item) return null;

  const source = category === 'Spacing Quads'
    ? fromSpacingQuad(item, activeFont)
    : fromFontGlyph(item, activeFont, axesValues);

  return buildSlugFromSource(source, mirror, applyDraft, variableSize, slugOptions);
}

// ─── Public: source-agnostic entry point (font / vector / bitmap) ──────────
// Accepts any GlyphSource and emits the 3D slug + relief in a THREE.Group.
export async function buildSlugFromSource(
  source, mirror, applyDraft, variableSize = true, slugOptions = {}
) {
  if (!source) return null;

  const opts = resolveOptions(slugOptions);

  // ─── Master geometry constants ──────────────────────────────────────
  const BODY_SIZE_MM = opts.bodySizeMM;
  const SLUG_HEIGHT  = opts.slugHeight;
  const RELIEF_HEIGHT = opts.reliefHeight;

  const u2mm  = BODY_SIZE_MM / source.unitsPerEm;
  const beardPct = opts.beardEnabled ? opts.beardPercent : 0;
  const BEARD_UNITS = (beardPct / 100) * source.unitsPerEm;
  const beard = BEARD_UNITS * u2mm;

  const slopeEnabled = applyDraft && opts.slopeEnabled && opts.slopeAngle > 0;
  const slopeAngleRad = (opts.slopeAngle * Math.PI) / 180;
  // Bevel offset = tan(angle) × relief depth → width of the chamfer-back per side
  const slopeBevelSize = slopeEnabled ? Math.tan(slopeAngleRad) * RELIEF_HEIGHT : 0;

  // ─── STEP 1 — Bounds ────────────────────────────────────────────────
  // For graphic sources (kind ≠ font-glyph) the metrics collapse to
  // descender=0, ascender=1000, so STEP 4 below picks bY1=0, bY2=1000
  // naturally.
  const gxMinUnits = source.bounds ? source.bounds.xMin : 0;
  const gxMaxUnits = source.bounds ? source.bounds.xMax : 0;
  const gyMinUnits = source.bounds ? source.bounds.yMin : 0;
  const gyMaxUnits = source.bounds ? source.bounds.yMax : 0;

  let blockMinX, blockMaxX, blockMinY, blockMaxY;
  let bY1 = 0, bY2 = 0;

  if (source.kind === 'spacing-quad') {
    blockMinX = source.bounds.xMin * u2mm;
    blockMaxX = source.bounds.xMax * u2mm;
    bY1 = source.metrics.descender;
    bY2 = source.metrics.ascender;
    blockMinY = bY1 * u2mm - beard;
    blockMaxY = bY2 * u2mm + beard;
  } else {
    // STEP 2 — Apply mirror, then add the configurable beard space per side.
    const gMinX = mirror ? -gxMaxUnits * u2mm : gxMinUnits * u2mm;
    const gMaxX = mirror ? -gxMinUnits * u2mm : gxMaxUnits * u2mm;
    blockMinX = gMinX - beard;
    blockMaxX = gMaxX + beard;

    // STEP 3 — Vertical bounds via metric heuristic.
    const { descender, ascender, capHeight, xHeight } = source.metrics;
    const THRESHOLD = 0.02 * source.unitsPerEm;

    if (gyMinUnits < -THRESHOLD) bY1 = descender;
    else                         bY1 = 0;

    if (gyMaxUnits > capHeight + THRESHOLD)    bY2 = ascender;
    else if (gyMaxUnits > xHeight + THRESHOLD) bY2 = capHeight;
    else                                       bY2 = xHeight;

    if (!variableSize) {
      bY1 = descender;
      bY2 = ascender;
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

  // ─── Hollow core + internal support walls + drain hatches (optional) ───
  // For large sorts the single rectangular cavity would leave too long an
  // unsupported span across the top of the letter; SLA prints would sag
  // and FDM prints would lose adhesion. When a hollow dimension exceeds
  // 4 × wallThickness we therefore subdivide the cavity into a grid of
  // smaller cells, each ≤ maxCellSpan wide. Drains are then drilled once
  // per row (X) and once per column (Y), so every cell has a clear escape
  // path even though the interior walls now separate it from its
  // neighbours.
  const wallThick = opts.wallThickness;
  const hollowW = blockWidth  - wallThick * 2;
  const hollowH = blockHeight - wallThick * 2;
  const hollowD = Math.max(SLUG_HEIGHT - 5.56, 0.1);
  const slugWideEnough = Math.min(blockWidth, blockHeight) >= opts.hollowMinWidth;

  if (opts.hollow && slugWideEnough && hollowW > 4 && hollowH > 4) {
    const supportWalls = opts.supportWallsEnabled !== false;
    const maxCellSpan  = Math.max(4, opts.maxCellSpan || 15);
    // Subdivide trigger: hollow span larger than 4 × wallThickness
    const wallTrigger  = 4 * wallThick;

    // Number of cells along each axis. Solving
    //   hollowDim = N · cellSpan + (N − 1) · wallThick
    // for cellSpan = maxCellSpan gives:
    const cellsX = (supportWalls && hollowW > wallTrigger)
      ? Math.max(1, Math.ceil((hollowW + wallThick) / (maxCellSpan + wallThick)))
      : 1;
    const cellsY = (supportWalls && hollowH > wallTrigger)
      ? Math.max(1, Math.ceil((hollowH + wallThick) / (maxCellSpan + wallThick)))
      : 1;

    const cellW = (hollowW - (cellsX - 1) * wallThick) / cellsX;
    const cellH = (hollowH - (cellsY - 1) * wallThick) / cellsY;

    if (cellW > 0.1 && cellH > 0.1) {
      const hollowStartX = blockMinX + wallThick;
      const hollowStartY = blockMinY + wallThick;

      // Subtract each cell as its own box; the gaps between cells become
      // the internal vertical/horizontal support walls.
      for (let cx = 0; cx < cellsX; cx++) {
        for (let cy = 0; cy < cellsY; cy++) {
          const x0 = hollowStartX + cx * (cellW + wallThick);
          const y0 = hollowStartY + cy * (cellH + wallThick);
          const cellMesh = new THREE.Mesh(new THREE.BoxGeometry(cellW, cellH, hollowD));
          cellMesh.position.set(x0 + cellW / 2, y0 + cellH / 2, hollowD / 2 - 0.1);
          cellMesh.updateMatrix();
          slugCSG = slugCSG.subtract(CSG.fromMesh(cellMesh));
        }
      }

      // Drains — one per row (spans full block width) and one per column
      // (spans full block height). Each tunnel pierces the outer wall and
      // all interior walls in its lane, giving every cell at least one
      // X-aligned and one Y-aligned escape path.
      if (opts.drainEnabled && opts.drainSize > 0) {
        const drainR = opts.drainSize / 2;

        for (let cy = 0; cy < cellsY; cy++) {
          const y0 = hollowStartY + cy * (cellH + wallThick);
          const yCenter = y0 + cellH / 2;
          const drainX = new THREE.Mesh(new THREE.CylinderGeometry(drainR, drainR, blockWidth + 2, 16));
          drainX.rotation.z = Math.PI / 2;
          drainX.position.set(blockMinX + blockWidth / 2, yCenter, hollowD / 2);
          drainX.updateMatrix();
          slugCSG = slugCSG.subtract(CSG.fromMesh(drainX));
        }

        for (let cx = 0; cx < cellsX; cx++) {
          const x0 = hollowStartX + cx * (cellW + wallThick);
          const xCenter = x0 + cellW / 2;
          const drainY = new THREE.Mesh(new THREE.CylinderGeometry(drainR, drainR, blockHeight + 2, 16));
          drainY.position.set(xCenter, blockMinY + blockHeight / 2, hollowD / 2);
          drainY.updateMatrix();
          slugCSG = slugCSG.subtract(CSG.fromMesh(drainY));
        }
      }
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
  if (source.contours) {
    const shapePath = new THREE.ShapePath();
    buildShapePath(shapePath, source.contours, u2mm);

    const shapes = shapePath.toShapes(false);
    if (shapes.length > 0) {
      const eyeGeo = makeReliefExtrudeGeometry(shapes, {
        reliefHeight: RELIEF_HEIGHT,
        slopeBevelSize,
        baseOffset: 0,
        invertSlope: false,
        beveled: slopeEnabled,
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

// ─── Public: shared relief-extrusion helper ────────────────────────────────
// One ExtrudeGeometry call to rule them all. Used by `buildSlugFromSource`
// for the regular printing relief and by `js/embossing.js` for the matrix
// and counter relief / cavity pieces.
//
//   shapes          THREE.Shape[] — the 2D contours to extrude
//   reliefHeight    mm vertical extent of the relief
//   slopeBevelSize  mm horizontal flare per side (from slope angle × height)
//   baseOffset      mm uniform outward 2D offset of the base outline
//                   (used as paper-tolerance expansion for cavities)
//   invertSlope     false → base wide, top narrow  (normal letterpress)
//                   true  → base exact, top wider  (embossing/debossing)
//   beveled         false → flat extrusion of height=reliefHeight (no slope)
//
// Geometry contract:
//   • Normal slope, no offset, beveled:
//       depth = 0.001, bevelThickness = reliefHeight,
//       bevelSize = slopeBevelSize, bevelOffset = 0
//     → top face = shape exactly; bottom face = shape + slopeBevelSize.
//   • Inverted slope: the same extrusion is rotated/flipped post-build so
//     the bevel sits at the *base* end (base exact, top wider). The
//     uniform `baseOffset` is applied via THREE's `bevelOffset` so the
//     base outline gets pushed out by the paper tolerance.
export function makeReliefExtrudeGeometry(shapes, {
  reliefHeight,
  slopeBevelSize = 0,
  baseOffset = 0,
  invertSlope = false,
  beveled = true,
} = {}) {
  if (!beveled || slopeBevelSize <= 0) {
    if (baseOffset > 0) {
      // Flat extrusion with a uniform outward offset on the perimeter.
      return new THREE.ExtrudeGeometry(shapes, {
        depth: reliefHeight,
        bevelEnabled: true,
        bevelSegments: 1,
        bevelThickness: 0.001,
        bevelSize: 0,
        bevelOffset: baseOffset,
      });
    }
    return new THREE.ExtrudeGeometry(shapes, {
      depth: reliefHeight,
      bevelEnabled: false,
    });
  }

  // Beveled extrusion. The bevel acts as the slope face.
  // ─ Normal slope ─ THREE puts the flat shape at z=depth (top) and the
  //   bevel-expanded shape at z=0 (bottom). Top narrow, bottom wide. ✓
  // ─ Inverted slope ─ We want top wide, bottom exact. Trick: extrude in
  //   the normal direction, then flip the resulting geometry on the XY
  //   plane (negate Z, re-translate to z>=0). The bevel ends up at the
  //   top, the flat face at the bottom.
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth: 0.001,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelThickness: reliefHeight,
    bevelSize: slopeBevelSize,
    bevelOffset: baseOffset,
  });
  if (invertSlope) {
    // Mirror across the XY plane (Z → −Z), then re-translate back to
    // z ∈ [0, reliefHeight]. The bevel that was at the bottom (wide)
    // ends up at the top (wide), and the original z=depth flat face
    // (narrow / exact) lands at the bottom.
    geo.applyMatrix4(new THREE.Matrix4().makeScale(1, 1, -1));
    geo.translate(0, 0, reliefHeight + 0.001);
    // The Z-mirror reverses triangle winding order — every face now
    // points inward, which breaks both the renderer (back-face cull) and
    // any downstream CSG (it relies on consistent outward normals).
    // Swap two indices of each triangle to restore outward winding.
    reverseTriangleWinding(geo);
    geo.computeVertexNormals();
  }
  return geo;
}

function reverseTriangleWinding(geo) {
  const idx = geo.index;
  if (idx) {
    const arr = idx.array;
    for (let i = 0; i + 2 < arr.length; i += 3) {
      const t = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = t;
    }
    idx.needsUpdate = true;
    return;
  }
  // Non-indexed: swap pairs of vertices in every position-attribute triangle.
  const pos = geo.attributes.position;
  if (!pos) return;
  const arr = pos.array;
  const stride = pos.itemSize; // typically 3
  for (let t = 0; t + 2 < pos.count; t += 3) {
    for (let k = 0; k < stride; k++) {
      const a = (t + 1) * stride + k;
      const b = (t + 2) * stride + k;
      const tmp = arr[a]; arr[a] = arr[b]; arr[b] = tmp;
    }
  }
  pos.needsUpdate = true;
}

// ─── Shape extraction ──────────────────────────────────────────────────────
// Feeds a THREE.ShapePath with the source contours. Both formats (samsa
// points/endPts and opentype-style commands) are supported so that the
// well-tested font path keeps using the samsa walker while the new vector
// and bitmap pipelines emit commands.
export function buildShapePath(shapePath, contours, u2mm) {
  if (contours.format === 'samsa') {
    let startPt = 0;
    contours.endPts.forEach(endPt => {
      const contourLen = endPt - startPt + 1;
      const contour = [];
      for (let p = startPt; p <= endPt; p++) {
        const pt = contours.points[p];
        const nextPt = contours.points[(p - startPt + 1) % contourLen + startPt];
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
  } else if (contours.format === 'commands') {
    contours.commands.forEach(cmd => {
      if (cmd.type === 'M') shapePath.moveTo(cmd.x * u2mm, cmd.y * u2mm);
      else if (cmd.type === 'L') shapePath.lineTo(cmd.x * u2mm, cmd.y * u2mm);
      else if (cmd.type === 'Q') shapePath.quadraticCurveTo(cmd.x1 * u2mm, cmd.y1 * u2mm, cmd.x * u2mm, cmd.y * u2mm);
      else if (cmd.type === 'C') shapePath.bezierCurveTo(cmd.x1 * u2mm, cmd.y1 * u2mm, cmd.x2 * u2mm, cmd.y2 * u2mm, cmd.x * u2mm, cmd.y * u2mm);
      // 'Z' is implicit in THREE.ShapePath via subsequent moveTo
    });
  }
}
