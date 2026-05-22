import * as THREE from 'three';
import { buildBlock } from './builder.js';
import { buildEmbossingBlock } from './embossing.js';

export function exportSTLFromGroup(group) {
  let stl = 'solid letterpress\n';
  group.traverse((child) => {
    if (child.isMesh) {
      const geom = child.geometry.clone();
      geom.applyMatrix4(child.matrixWorld);
      geom.computeVertexNormals();
      const pos = geom.attributes.position;
      const index = geom.index;
      const reverseWinding = child.matrixWorld.determinant() < 0;

      const writeTriangle = (a, b, c) => {
        const vA = reverseWinding ? a : a;
        const vB = reverseWinding ? c : b;
        const vC = reverseWinding ? b : c;
        
        const vecA = new THREE.Vector3(pos.getX(vA), pos.getY(vA), pos.getZ(vA));
        const vecB = new THREE.Vector3(pos.getX(vB), pos.getY(vB), pos.getZ(vB));
        const vecC = new THREE.Vector3(pos.getX(vC), pos.getY(vC), pos.getZ(vC));
        const cb = new THREE.Vector3().subVectors(vecC, vecB);
        const ab = new THREE.Vector3().subVectors(vecA, vecB);
        const normal = cb.cross(ab).normalize();

        stl += `facet normal ${normal.x} ${normal.y} ${normal.z}\nouter loop\n`;
        stl += `vertex ${vecA.x} ${vecA.y} ${vecA.z}\n`;
        stl += `vertex ${vecB.x} ${vecB.y} ${vecB.z}\n`;
        stl += `vertex ${vecC.x} ${vecC.y} ${vecC.z}\n`;
        stl += `endloop\nendfacet\n`;
      };

      if (index) {
        for (let i = 0; i < index.count; i += 3) {
          writeTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2));
        }
      } else {
        for (let i = 0; i < pos.count; i += 3) {
          writeTriangle(i, i + 1, i + 2);
        }
      }
    }
  });
  stl += 'endsolid letterpress\n';
  return stl;
}

export function exportOBJFromGroup(group) {
  let obj = '# Computational Letterpress Sorts\n';
  let vertexOffset = 1;
  group.traverse((child) => {
    if (child.isMesh) {
      const geom = child.geometry.clone();
      geom.applyMatrix4(child.matrixWorld);
      const pos = geom.attributes.position;
      const index = geom.index;
      const reverseWinding = child.matrixWorld.determinant() < 0;

      for (let i = 0; i < pos.count; i++) {
        obj += `v ${pos.getX(i)} ${pos.getY(i)} ${pos.getZ(i)}\n`;
      }

      const writeFace = (a, b, c) => {
        const vA = (reverseWinding ? a : a) + vertexOffset;
        const vB = (reverseWinding ? c : b) + vertexOffset;
        const vC = (reverseWinding ? b : c) + vertexOffset;
        obj += `f ${vA} ${vB} ${vC}\n`;
      };

      if (index) {
        for (let i = 0; i < index.count; i += 3) {
          writeFace(index.getX(i), index.getX(i + 1), index.getX(i + 2));
        }
      } else {
        for (let i = 0; i < pos.count; i += 3) {
          writeFace(i, i + 1, i + 2);
        }
      }
      vertexOffset += pos.count;
    }
  });
  return obj;
}

export async function exportZIP(glyphsList, category, axesValues, mirror, applyDraft, variableSize, slugOptions, onProgress) {
  if (typeof JSZip === 'undefined') {
    throw new Error('JSZip is not loaded.');
  }
  const zip = new JSZip();
  const embossing = slugOptions && slugOptions.embossing && slugOptions.embossing.enabled;
  const folderName = embossing
    ? `Letterpress_${category.replace(/\s+/g, '_')}_${slugOptions.embossing.mode === 'emboss' ? 'Embossing' : 'Debossing'}`
    : `Letterpress_${category.replace(/\s+/g, '_')}`;
  const folder = zip.folder(folderName);

  for (let i = 0; i < glyphsList.length; i++) {
    const charName = category === 'Spacing Quads'
      ? glyphsList[i].name.replace(/\W+/g, '_')
      : (glyphsList[i].name || `glyph_${i}`);

    if (onProgress) {
      onProgress(i + 1, glyphsList.length, charName);
    }

    await new Promise(resolve => setTimeout(resolve, 10));

    try {
      if (embossing) {
        const pair = await buildEmbossingBlock(
          i, category, glyphsList, axesValues,
          mirror, applyDraft, variableSize, slugOptions, slugOptions.embossing
        );
        if (pair && pair.matrix && pair.counter) {
          pair.matrix.group.position.set(0, 0, 0);
          pair.matrix.group.updateMatrixWorld(true);
          folder.file(`${charName}_matrix.stl`, exportSTLFromGroup(pair.matrix.group));
          pair.counter.group.position.set(0, 0, 0);
          pair.counter.group.updateMatrixWorld(true);
          folder.file(`${charName}_counter.stl`, exportSTLFromGroup(pair.counter.group));
        }
      } else {
        const blockData = await buildBlock(i, category, glyphsList, axesValues, mirror, applyDraft, variableSize, slugOptions);
        if (blockData && blockData.group) {
          blockData.group.position.set(0, 0, 0);
          blockData.group.updateMatrixWorld(true);
          const stl = exportSTLFromGroup(blockData.group);
          folder.file(`${charName}.stl`, stl);
        }
      }
    } catch (err) {
      console.warn(`Skipped ${charName} due to geometry error:`, err);
    }
  }

  if (onProgress) {
    onProgress(null, null, 'Compressing ZIP Archive...');
  }
  await new Promise(resolve => setTimeout(resolve, 10));

  const blob = await zip.generateAsync({ type: 'blob' });
  return { blob, folderName };
}
