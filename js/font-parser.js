import opentype from 'opentype.js';
import { SamsaFont, SamsaBuffer } from '../src/samsa-core.js';

let font = null;
let samsaFont = null;
let fontBuffer = null;

export async function parseFont(buffer) {
  fontBuffer = buffer;
  font = opentype.parse(buffer);
  
  samsaFont = null;
  if (typeof SamsaFont !== 'undefined') {
    try {
      samsaFont = new SamsaFont(new SamsaBuffer(buffer));
    } catch (e) {
      console.error("SamsaFont parsing error:", e);
      alert("SamsaFont failed to parse! Error: " + e.message);
    }
  }
  return { font, samsaFont };
}

export function getFont() {
  return font;
}

export function getSamsaFont() {
  return samsaFont;
}

export function getAxes() {
  if (samsaFont && typeof samsaFont.axes === 'function') {
    return samsaFont.axes().map(axis => ({
      tag: axis.axisTag,
      name: axis.axisTag,
      min: axis.minValue,
      max: axis.maxValue,
      default: axis.defaultValue
    }));
  } else if (font && font.tables.fvar) {
    return font.tables.fvar.axes.map(axis => ({
      tag: axis.tag,
      name: axis.tag,
      min: axis.minValue,
      max: axis.maxValue,
      default: axis.defaultValue
    }));
  }
  return [];
}

export function getInstances() {
  if (samsaFont && typeof samsaFont.instances === 'function') {
    return samsaFont.instances().map((inst, index) => {
      const raw = inst.name;
      const name = raw
        ? (typeof raw === 'object' ? (raw['en'] || Object.values(raw)[0] || `Instance ${index + 1}`) : raw)
        : `Instance ${index + 1}`;
      
      // Map tuple indices back to tags
      const coordinates = {};
      samsaFont.axes().forEach((axis, aIdx) => {
        coordinates[axis.axisTag] = inst.coordinates[aIdx] !== undefined ? inst.coordinates[aIdx] : axis.defaultValue;
      });
      
      return { name, coordinates };
    });
  } else if (font && font.tables.fvar && font.tables.fvar.instances) {
    return font.tables.fvar.instances.map((inst, index) => {
      let name = `Instance ${index + 1}`;
      if (font.names && font.names.subfamily) {
        name = font.names.subfamily[font.names.subfamily.hasOwnProperty('en') ? 'en' : Object.keys(font.names.subfamily)[0]] || name;
      }
      return { name, coordinates: inst.coordinates };
    });
  }
  return [];
}

export function getActiveFont(axesValues) {
  if (!font) return null;
  return font.getVariation ? font.getVariation(axesValues) : font;
}

export function reloadActiveFont(axesValues) {
  if (!fontBuffer) return null;
  
  // Re-parse entirely from scratch to bypass the opentype.js caching issues
  const freshFont = opentype.parse(fontBuffer);
  
  // Apply variations
  font = freshFont.getVariation ? freshFont.getVariation(axesValues) : freshFont;
  return font;
}

export function getGlyphsByCategory(category, axesValues) {
  if (!font) return [];
  const activeFont = getActiveFont(axesValues);
  
  if (category === 'Spacing Quads') {
    return [
      { name: '2 Em Quad', fraction: 2, isSpacing: true },
      { name: 'Em Quad', fraction: 1, isSpacing: true },
      { name: 'En Quad (1/2)', fraction: 0.5, isSpacing: true },
      { name: 'Thick Space (1/3)', fraction: 0.3333, isSpacing: true },
      { name: 'Mid Space (1/4)', fraction: 0.25, isSpacing: true },
      { name: 'Thin Space (1/6)', fraction: 0.1666, isSpacing: true },
      { name: 'Hair Space (1/12)', fraction: 0.0833, isSpacing: true }
    ];
  }

  const list = [];
  for (let i = 0; i < activeFont.numGlyphs; i++) {
    const g = activeFont.glyphs.get(i);
    if (!g.unicode) continue;
    const char = String.fromCharCode(g.unicode);
    
    let matches = false;
    if (category === 'all') {
      matches = true;
    } else if (category === 'Uppercase') {
      matches = /[A-Z]/.test(char);
    } else if (category === 'Lowercase') {
      matches = /[a-z]/.test(char);
    } else if (category === 'Figures') {
      matches = /[0-9]/.test(char);
    } else if (category === 'Punctuation') {
      matches = /[.,!?;:'"()[\]{}\-_@#$%^&*\/\\<>]/.test(char);
    }
    
    if (matches) {
      list.push(g);
    }
  }
  return list;
}
