import * as THREE from 'three';
import { CSG } from 'three-csg-ts';
import { getActiveFont } from './font-parser.js';

const BODY_SIZE_MM = 54.14; 
const SLUG_HEIGHT = 20.56;
const RELIEF_HEIGHT = 3.00;

export async function buildBlock(glyphIndex, category, glyphsList, axesValues, mirror, applyDraft) {
  const activeFont = getActiveFont(axesValues);
  if (!activeFont) return null;

  const BEARD_UNITS = (24 / 1000) * activeFont.unitsPerEm;
  const u2mm = BODY_SIZE_MM / activeFont.unitsPerEm;
  const beard = BEARD_UNITS * u2mm;

  let blockMinX, blockMaxX, blockMinY, blockMaxY;
  let activeGlyph = null;

  if (category === 'Spacing Quads') {
    const quad = glyphsList[glyphIndex];
    const widthUnits = activeFont.unitsPerEm * quad.fraction;
    blockMinX = 0;
    blockMaxX = widthUnits * u2mm;
    blockMinY = activeFont.descender * u2mm - beard;
    blockMaxY = activeFont.ascender * u2mm + beard;
  } else {
    activeGlyph = glyphsList[glyphIndex];
    
    const gMinX = mirror ? -activeGlyph.xMax * u2mm : activeGlyph.xMin * u2mm;
    const gMaxX = mirror ? -activeGlyph.xMin * u2mm : activeGlyph.xMax * u2mm;
    blockMinX = gMinX - beard;
    blockMaxX = gMaxX + beard;

    const os2 = activeFont.tables.os2;
    const capHeight = os2 && os2.sCapHeight ? os2.sCapHeight : activeFont.ascender;
    const xHeight = os2 && os2.sxHeight ? os2.sxHeight : activeFont.unitsPerEm / 2;
    
    let bY1 = 0;
    let bY2 = capHeight;
    
    if (category === 'Uppercase' || category === 'Figures') {
      bY1 = 0;
      bY2 = capHeight;
    } else if (category === 'Lowercase') {
      bY1 = activeFont.descender;
      bY2 = activeFont.ascender; 
    } else if (category === 'Punctuation') {
      bY1 = activeFont.descender;
      bY2 = capHeight;
    } else {
      bY1 = activeFont.descender;
      bY2 = activeFont.ascender;
    }

    blockMinY = bY1 * u2mm - beard;
    blockMaxY = bY2 * u2mm + beard;
  }

  const blockWidth = blockMaxX - blockMinX;
  const blockHeight = blockMaxY - blockMinY;

  if (blockWidth <= 0 || blockHeight <= 0) return null;

  const slugMesh = new THREE.Mesh(new THREE.BoxGeometry(blockWidth, blockHeight, SLUG_HEIGHT));
  slugMesh.position.set(blockMinX + blockWidth / 2, blockMinY + blockHeight / 2, SLUG_HEIGHT / 2);
  slugMesh.updateMatrix();
  let slugCSG = CSG.fromMesh(slugMesh);

  const chamf = 1.0;
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

  const wallThick = 8.0; 
  const hollowW = blockWidth - wallThick * 2;
  const hollowH = blockHeight - wallThick * 2;
  const hollowD = SLUG_HEIGHT - 5.56; 

  if (hollowW > 4 && hollowH > 4) {
    const hollow = new THREE.Mesh(new THREE.BoxGeometry(hollowW, hollowH, hollowD));
    hollow.position.set(blockMinX + blockWidth / 2, blockMinY + blockHeight / 2, hollowD / 2 - 0.1);
    hollow.updateMatrix();
    slugCSG = slugCSG.subtract(CSG.fromMesh(hollow));

    const drainR = 4.0; // 8mm diameter = 4mm radius
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

  const nick = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, blockWidth + 2, 24));
  nick.rotation.z = Math.PI / 2;
  nick.position.set(blockMinX + blockWidth / 2, blockMinY, 6.0);
  nick.updateMatrix();
  slugCSG = slugCSG.subtract(CSG.fromMesh(nick));

  const blNick = new THREE.Mesh(new THREE.BoxGeometry(blockWidth + 2, 1.0, 1.0));
  blNick.position.set(blockMinX + blockWidth / 2, 0, 0.5);
  blNick.updateMatrix();
  slugCSG = slugCSG.subtract(CSG.fromMesh(blNick));

  const finalSlug = CSG.toMesh(slugCSG, new THREE.Matrix4());
  const mat = new THREE.MeshStandardMaterial({
    color: 0x9090a8,
    roughness: 0.5,
    metalness: 0.5
  });
  finalSlug.material = mat;

  const printGroup = new THREE.Group();
  printGroup.add(finalSlug);

  if (activeGlyph) {
    const cmds = activeGlyph.path.commands;
    const shapePath = new THREE.ShapePath();
    
    cmds.forEach(cmd => {
      if (cmd.type === 'M') shapePath.moveTo(cmd.x * u2mm, cmd.y * u2mm);
      else if (cmd.type === 'L') shapePath.lineTo(cmd.x * u2mm, cmd.y * u2mm);
      else if (cmd.type === 'Q') shapePath.quadraticCurveTo(cmd.x1 * u2mm, cmd.y1 * u2mm, cmd.x * u2mm, cmd.y * u2mm);
      else if (cmd.type === 'C') shapePath.bezierCurveTo(cmd.x1 * u2mm, cmd.y1 * u2mm, cmd.x2 * u2mm, cmd.y2 * u2mm, cmd.x * u2mm, cmd.y * u2mm);
    });

    const shapes = shapePath.toShapes(false);
    if (shapes.length > 0) {
      const eyeGeo = new THREE.ExtrudeGeometry(shapes, {
        depth: applyDraft ? 0.001 : RELIEF_HEIGHT,
        bevelEnabled: applyDraft,
        bevelSegments: 1, // Straight slope with no chamfer
        bevelSize: applyDraft ? 0.638 : 0, // 12-degree angle
        bevelThickness: applyDraft ? RELIEF_HEIGHT : 0, 
        bevelOffset: 0 // True to font outline at the very top
      });
      
      const eyeMesh = new THREE.Mesh(eyeGeo, new THREE.MeshStandardMaterial({
        color: 0xb48afa,
        roughness: 0.4,
        metalness: 0.2
      }));
      eyeMesh.position.set(0, 0, SLUG_HEIGHT);
      if (mirror) {
        eyeMesh.scale.x = -1;
      }
      eyeMesh.updateMatrix();
      
      printGroup.add(eyeMesh);
    }
  }

  return { group: printGroup, w: blockWidth, h: blockHeight, minX: blockMinX, minY: blockMinY, maxY: blockMaxY };
}
