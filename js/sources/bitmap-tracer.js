// ─── Bitmap → traced GlyphSource ───────────────────────────────────────────
// Two-stage pipeline:
//   1. binarizeImage(file, threshold, invert) → dataURL
//      Loads the image into an off-screen canvas and hard-binarizes every
//      pixel to pure black or pure white based on a luminance threshold.
//      This eliminates anti-aliasing artifacts that confuse ImageTracer's
//      built-in colour quantization on photographic or scanned source art.
//   2. traceImage(dataURL, options) → svgString
//      Runs ImageTracer with a forced 2-colour palette over the binarized
//      image. The result is a clean SVG with one black "ink" layer and one
//      white "paper" layer.
//
// The modal in ui.js drives these two steps interactively so the user can
// dial threshold + simplification before committing. `buildSourceFromSvg`
// takes the final SVG string, strips the white paper layer, hands the
// ink-only payload to the SVG parser, and re-tags the resulting source as
// kind:'bitmap'.

import { parseSVG } from './svg-parser.js';

export const DEFAULT_TRACE_OPTIONS = {
  ltres: 0.1,
  qtres: 0.5,
  pathomit: 4,
  rightangleenhance: true,
  // We hand ImageTracer a pre-binarized image, so colorsampling=0 (use
  // explicit palette) and a tight 2-colour palette is enough.
  colorsampling: 0,
  numberofcolors: 2,
  pal: [
    { r: 0,   g: 0,   b: 0,   a: 255 },  // ink
    { r: 255, g: 255, b: 255, a: 255 },  // paper
  ],
  mincolorratio: 0,
  colorquantcycles: 1,
  blurradius: 0,
  blurdelta: 20,
  strokewidth: 0,
  linefilter: false,
  scale: 1,
  roundcoords: 2,
  viewbox: true,
  desc: false,
};

// ─── Stage 1: pre-binarize ─────────────────────────────────────────────────
// `threshold`  — luminance cutoff in [0..255]. Pixels darker than this
//                become ink; lighter ones become paper.
// `invert`     — if true, swap ink ↔ paper (white-on-black source art).
// Returns a Promise resolving to { dataUrl, width, height }.
export async function binarizeImage(fileOrBlob, threshold = 128, invert = false) {
  const img = await loadImageBitmap(fileOrBlob);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  // Rec. 709 luminance with alpha as "make transparent pixels paper"
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    let lum;
    if (a < 16) {
      lum = 255; // transparent → paper
    } else {
      lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    const isInk = invert ? lum >= threshold : lum < threshold;
    const v = isInk ? 0 : 255;
    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return { dataUrl: canvas.toDataURL('image/png'), width: w, height: h };
}

// ─── Stage 2: trace ────────────────────────────────────────────────────────
// Returns a Promise resolving to the SVG string emitted by ImageTracer.
export function traceImage(dataUrl, options = {}) {
  if (typeof ImageTracer === 'undefined') {
    return Promise.reject(new Error('ImageTracer.js failed to load — bitmap tracing is unavailable.'));
  }
  const traceOpts = { ...DEFAULT_TRACE_OPTIONS, ...options };
  return new Promise((resolve, reject) => {
    try {
      ImageTracer.imageToSVG(dataUrl, (svg) => {
        if (!svg) reject(new Error('ImageTracer returned an empty SVG.'));
        else resolve(svg);
      }, traceOpts);
    } catch (e) {
      reject(e);
    }
  });
}

// ─── Final step: SVG string → bitmap-tagged GlyphSource ────────────────────
// Strips the white paper layer and re-tags the source as kind:'bitmap' so
// the UI pill and changelog still distinguish it from a hand-drawn SVG.
export function buildSourceFromSvg(svgString, name, meta = {}) {
  const inkOnly = stripWhitePaths(svgString);
  const source = parseSVG(inkOnly, name);
  source.kind = 'bitmap';
  source.meta = {
    ...(source.meta || {}),
    ...meta,
  };
  return source;
}

// ─── Convenience: full pipeline in one call (kept for back-compat) ─────────
// Used when no modal is desired (e.g. programmatic / batch flows).
export async function traceBitmap(fileOrBlob, displayName, opts = {}) {
  const { threshold = 128, invert = false, traceOptions = {} } = opts;
  const { dataUrl } = await binarizeImage(fileOrBlob, threshold, invert);
  const svg = await traceImage(dataUrl, traceOptions);
  return buildSourceFromSvg(svg, displayName || (fileOrBlob && fileOrBlob.name) || 'bitmap', {
    tracedFrom: detectFormat(fileOrBlob),
    originalFilename: displayName || (fileOrBlob && fileOrBlob.name) || 'bitmap',
    threshold, invert,
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function loadImageBitmap(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileOrBlob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error('Could not decode image.')); };
    img.src = url;
  });
}

// ImageTracer emits one <path fill="rgb(R,G,B)" ...> element per traced
// colour layer. With our 2-colour palette the paper layer is rgb(255,255,255);
// dropping that element leaves only the ink contours (counters inside
// glyphs survive because they are even-odd-encoded inside the ink path).
function stripWhitePaths(svgString) {
  return svgString.replace(
    /<path\b[^>]*fill\s*=\s*"rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)"[^>]*\/?>/g,
    ''
  );
}

function detectFormat(fileOrBlob) {
  const t = (fileOrBlob && fileOrBlob.type) || '';
  if (t.includes('png')) return 'png';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('webp')) return 'webp';
  if (t.includes('heif') || t.includes('heic')) return 'heif';
  if (t.includes('tiff')) return 'tif';
  if (t.includes('gif')) return 'gif';
  return 'image';
}
