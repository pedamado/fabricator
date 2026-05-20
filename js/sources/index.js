// Barrel export for the source pipeline modules.
export { fromFontGlyph, fromSpacingQuad, fromCommandList } from './glyph-source.js';
export { parseSVG } from './svg-parser.js';
export {
  traceBitmap,
  binarizeImage,
  traceImage,
  buildSourceFromSvg,
  DEFAULT_TRACE_OPTIONS,
} from './bitmap-tracer.js';
