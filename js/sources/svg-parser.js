// ─── SVG → command-list GlyphSource ────────────────────────────────────────
// Parses an SVG text payload, flattens every shape into opentype.js-style
// path commands, computes the combined bbox, flips Y (SVG is Y-down, font /
// builder convention is Y-up), and normalizes to a 1000-unit EM square.
//
// Supported elements:
//   <path>     full d-attribute grammar (M m L l H h V v C c S s Q q T t A a Z z)
//   <polygon>  M + L sequence + Z
//   <polyline> M + L sequence
//   <rect>     M + 3×L + Z  (sharp corners; rx/ry deferred to v9.1)
//   <circle>   4-cubic-bezier approximation (k = 0.5522847498)
//   <ellipse>  same approximation, separate rx/ry
//   <line>     M + L
//
// Transforms (`transform="..."`) are flattened by accumulating the chain
// from the root <svg> down to the element, multiplying matrices in DOM
// order.

import { fromCommandList } from './glyph-source.js';

const KAPPA = 0.5522847498;  // cubic-bezier circle approximation constant

// ─── Public entry point ────────────────────────────────────────────────────
export function parseSVG(svgText, name = 'vector') {
  if (typeof svgText !== 'string' || !svgText.length) {
    throw new Error('SVG parser received an empty payload.');
  }
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const errNode = doc.querySelector('parsererror');
  if (errNode) throw new Error('SVG could not be parsed: ' + errNode.textContent);

  const svg = doc.documentElement;
  if (!svg || svg.tagName.toLowerCase() !== 'svg') {
    throw new Error('Root element is not <svg>.');
  }

  // Collect every shape's commands, transformed by accumulated CTM.
  const rawCommands = [];
  const rootCTM = [1, 0, 0, 1, 0, 0]; // identity
  walk(svg, rootCTM, rawCommands);

  if (rawCommands.length === 0) {
    throw new Error('No drawable shapes found in the SVG.');
  }

  // Compute raw bbox (still in SVG coordinate space, Y-down).
  const rawBounds = bbox(rawCommands);
  if (rawBounds.xMax <= rawBounds.xMin || rawBounds.yMax <= rawBounds.yMin) {
    throw new Error('SVG bounding box is empty.');
  }

  // Normalize: scale uniformly so that the artwork height = 1000 EM units.
  // Translate so bbox bottom-left sits at (0, 0). Flip Y to make it Y-up.
  const targetHeight = 1000;
  const scale = targetHeight / (rawBounds.yMax - rawBounds.yMin);
  const offsetX = -rawBounds.xMin;
  const offsetYflipped = rawBounds.yMax; // after flip, yMax becomes the top

  const commands = rawCommands.map(cmd => transformCommand(cmd, (x, y) => ({
    x: (x + offsetX) * scale,
    y: (offsetYflipped - y) * scale,
  })));

  return fromCommandList(commands, name, 'vector', {
    sourceFilename: name,
    width:  (rawBounds.xMax - rawBounds.xMin) * scale,
    height: targetHeight,
  });
}

// ─── DOM walk: accumulate transforms, dispatch on tag ──────────────────────
function walk(node, parentCTM, out) {
  if (node.nodeType !== 1) return; // element nodes only

  const localT = parseTransform(node.getAttribute && node.getAttribute('transform'));
  const ctm = multiply(parentCTM, localT);
  const tag = node.tagName.toLowerCase();

  switch (tag) {
    case 'svg':
    case 'g':
    case 'symbol':
    case 'defs':  // <defs> children are usually <use>-referenced; we skip
      if (tag !== 'defs') {
        for (const child of node.children) walk(child, ctm, out);
      }
      break;
    case 'path':     emitPath(node.getAttribute('d') || '', ctm, out); break;
    case 'rect':     emitRect(node, ctm, out); break;
    case 'circle':   emitCircle(node, ctm, out); break;
    case 'ellipse':  emitEllipse(node, ctm, out); break;
    case 'line':     emitLine(node, ctm, out); break;
    case 'polyline': emitPoly(node, ctm, out, false); break;
    case 'polygon':  emitPoly(node, ctm, out, true); break;
    default:
      // Unknown element; recurse in case it wraps shapes.
      for (const child of node.children) walk(child, ctm, out);
  }
}

// ─── Element emitters ──────────────────────────────────────────────────────
function emitRect(el, ctm, out) {
  const x = num(el.getAttribute('x'));
  const y = num(el.getAttribute('y'));
  const w = num(el.getAttribute('width'));
  const h = num(el.getAttribute('height'));
  if (w <= 0 || h <= 0) return;
  pushPoint('M', ctm, out, x, y);
  pushPoint('L', ctm, out, x + w, y);
  pushPoint('L', ctm, out, x + w, y + h);
  pushPoint('L', ctm, out, x, y + h);
  out.push({ type: 'Z' });
}

function emitLine(el, ctm, out) {
  const x1 = num(el.getAttribute('x1'));
  const y1 = num(el.getAttribute('y1'));
  const x2 = num(el.getAttribute('x2'));
  const y2 = num(el.getAttribute('y2'));
  pushPoint('M', ctm, out, x1, y1);
  pushPoint('L', ctm, out, x2, y2);
}

function emitPoly(el, ctm, out, closed) {
  const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
  if (pts.length < 4) return;
  pushPoint('M', ctm, out, pts[0], pts[1]);
  for (let i = 2; i < pts.length - 1; i += 2) {
    pushPoint('L', ctm, out, pts[i], pts[i + 1]);
  }
  if (closed) out.push({ type: 'Z' });
}

function emitCircle(el, ctm, out) {
  const cx = num(el.getAttribute('cx'));
  const cy = num(el.getAttribute('cy'));
  const r  = num(el.getAttribute('r'));
  if (r <= 0) return;
  emitEllipseCommon(cx, cy, r, r, ctm, out);
}

function emitEllipse(el, ctm, out) {
  const cx = num(el.getAttribute('cx'));
  const cy = num(el.getAttribute('cy'));
  const rx = num(el.getAttribute('rx'));
  const ry = num(el.getAttribute('ry'));
  if (rx <= 0 || ry <= 0) return;
  emitEllipseCommon(cx, cy, rx, ry, ctm, out);
}

function emitEllipseCommon(cx, cy, rx, ry, ctm, out) {
  // 4 cubic bezier arcs approximating the ellipse, starting at the right.
  const kx = rx * KAPPA, ky = ry * KAPPA;
  pushPoint('M', ctm, out, cx + rx, cy);
  pushCubic(ctm, out, cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry);
  pushCubic(ctm, out, cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy);
  pushCubic(ctm, out, cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry);
  pushCubic(ctm, out, cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy);
  out.push({ type: 'Z' });
}

// ─── <path d="..."> tokenizer + interpreter ────────────────────────────────
function emitPath(d, ctm, out) {
  const tokens = tokenizePathData(d);
  if (tokens.length === 0) return;

  let x = 0, y = 0;        // current point
  let startX = 0, startY = 0; // subpath start (for Z)
  let lastCtrlX = 0, lastCtrlY = 0; // for S/T smooth continuation
  let lastCmd = '';

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const cmd = typeof tok === 'string' ? tok : null;
    if (cmd) { i++; } // consume command letter; arguments follow as numbers

    const c = cmd || implicitContinuation(lastCmd);
    if (!c) { i++; continue; }
    const isRel = c === c.toLowerCase();
    const C = c.toUpperCase();

    switch (C) {
      case 'M': {
        let nx = num(tokens[i++]); let ny = num(tokens[i++]);
        if (isRel) { nx += x; ny += y; }
        pushPoint('M', ctm, out, nx, ny);
        x = nx; y = ny;
        startX = x; startY = y;
        // Subsequent coord pairs after an M are implicit L
        while (i < tokens.length && typeof tokens[i] === 'number') {
          let lx = num(tokens[i++]); let ly = num(tokens[i++]);
          if (isRel) { lx += x; ly += y; }
          pushPoint('L', ctm, out, lx, ly);
          x = lx; y = ly;
        }
        lastCmd = isRel ? 'l' : 'L';
        break;
      }
      case 'L': {
        let nx = num(tokens[i++]); let ny = num(tokens[i++]);
        if (isRel) { nx += x; ny += y; }
        pushPoint('L', ctm, out, nx, ny);
        x = nx; y = ny;
        lastCmd = c;
        break;
      }
      case 'H': {
        let nx = num(tokens[i++]);
        if (isRel) nx += x;
        pushPoint('L', ctm, out, nx, y);
        x = nx;
        lastCmd = c;
        break;
      }
      case 'V': {
        let ny = num(tokens[i++]);
        if (isRel) ny += y;
        pushPoint('L', ctm, out, x, ny);
        y = ny;
        lastCmd = c;
        break;
      }
      case 'C': {
        let x1 = num(tokens[i++]), y1 = num(tokens[i++]);
        let x2 = num(tokens[i++]), y2 = num(tokens[i++]);
        let nx = num(tokens[i++]), ny = num(tokens[i++]);
        if (isRel) { x1 += x; y1 += y; x2 += x; y2 += y; nx += x; ny += y; }
        pushCubic(ctm, out, x1, y1, x2, y2, nx, ny);
        lastCtrlX = x2; lastCtrlY = y2;
        x = nx; y = ny;
        lastCmd = c;
        break;
      }
      case 'S': {
        // Reflect previous control point if last was C/S; else use current.
        const reflect = /[CcSs]/.test(lastCmd);
        const x1 = reflect ? 2 * x - lastCtrlX : x;
        const y1 = reflect ? 2 * y - lastCtrlY : y;
        let x2 = num(tokens[i++]), y2 = num(tokens[i++]);
        let nx = num(tokens[i++]), ny = num(tokens[i++]);
        if (isRel) { x2 += x; y2 += y; nx += x; ny += y; }
        pushCubic(ctm, out, x1, y1, x2, y2, nx, ny);
        lastCtrlX = x2; lastCtrlY = y2;
        x = nx; y = ny;
        lastCmd = c;
        break;
      }
      case 'Q': {
        let x1 = num(tokens[i++]), y1 = num(tokens[i++]);
        let nx = num(tokens[i++]), ny = num(tokens[i++]);
        if (isRel) { x1 += x; y1 += y; nx += x; ny += y; }
        pushQuad(ctm, out, x1, y1, nx, ny);
        lastCtrlX = x1; lastCtrlY = y1;
        x = nx; y = ny;
        lastCmd = c;
        break;
      }
      case 'T': {
        const reflect = /[QqTt]/.test(lastCmd);
        const x1 = reflect ? 2 * x - lastCtrlX : x;
        const y1 = reflect ? 2 * y - lastCtrlY : y;
        let nx = num(tokens[i++]), ny = num(tokens[i++]);
        if (isRel) { nx += x; ny += y; }
        pushQuad(ctm, out, x1, y1, nx, ny);
        lastCtrlX = x1; lastCtrlY = y1;
        x = nx; y = ny;
        lastCmd = c;
        break;
      }
      case 'A': {
        const rx = num(tokens[i++]);
        const ry = num(tokens[i++]);
        const xRot = num(tokens[i++]);
        const largeArc = num(tokens[i++]);
        const sweep = num(tokens[i++]);
        let nx = num(tokens[i++]), ny = num(tokens[i++]);
        if (isRel) { nx += x; ny += y; }
        // Convert to a chain of cubic beziers and emit them.
        const cubics = arcToCubic(x, y, nx, ny, rx, ry, xRot * Math.PI / 180, largeArc, sweep);
        cubics.forEach(c => pushCubic(ctm, out, c[0], c[1], c[2], c[3], c[4], c[5]));
        x = nx; y = ny;
        lastCmd = c;
        break;
      }
      case 'Z': {
        out.push({ type: 'Z' });
        x = startX; y = startY;
        lastCmd = c;
        break;
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

function pushPoint(type, ctm, out, x, y) {
  const p = apply(ctm, x, y);
  out.push({ type, x: p.x, y: p.y });
}

function pushCubic(ctm, out, x1, y1, x2, y2, x, y) {
  const p1 = apply(ctm, x1, y1);
  const p2 = apply(ctm, x2, y2);
  const p  = apply(ctm, x,  y);
  out.push({ type: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y });
}

function pushQuad(ctm, out, x1, y1, x, y) {
  const p1 = apply(ctm, x1, y1);
  const p  = apply(ctm, x,  y);
  out.push({ type: 'Q', x1: p1.x, y1: p1.y, x: p.x, y: p.y });
}

// After an M/L/H/V the same command may continue with more coordinate
// pairs without a fresh letter. For others (C, S, Q, T) the same letter
// implicitly repeats. Return the implicit continuation letter.
function implicitContinuation(last) {
  if (!last) return null;
  if (/^[mM]$/.test(last)) return last === 'M' ? 'L' : 'l';
  return last;
}

// Apply a 2D affine matrix [a, b, c, d, e, f] (SVG convention: x' = a·x + c·y + e).
function apply(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function parseTransform(str) {
  if (!str) return [1, 0, 0, 1, 0, 0];
  let m = [1, 0, 0, 1, 0, 0];
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(str)) !== null) {
    const name = match[1];
    const args = match[2].trim().split(/[\s,]+/).map(Number);
    let t = [1, 0, 0, 1, 0, 0];
    switch (name) {
      case 'matrix':    t = [args[0], args[1], args[2], args[3], args[4], args[5]]; break;
      case 'translate': t = [1, 0, 0, 1, args[0] || 0, args[1] || 0]; break;
      case 'scale':     t = [args[0], 0, 0, args.length > 1 ? args[1] : args[0], 0, 0]; break;
      case 'rotate': {
        const a = (args[0] || 0) * Math.PI / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        if (args.length === 3) {
          const cx = args[1], cy = args[2];
          // translate(cx,cy) · rotate(a) · translate(-cx,-cy)
          m = multiply(m, [1, 0, 0, 1, cx, cy]);
          m = multiply(m, [cos, sin, -sin, cos, 0, 0]);
          m = multiply(m, [1, 0, 0, 1, -cx, -cy]);
          continue;
        }
        t = [cos, sin, -sin, cos, 0, 0];
        break;
      }
      case 'skewX': t = [1, 0, Math.tan((args[0] || 0) * Math.PI / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan((args[0] || 0) * Math.PI / 180), 0, 1, 0, 0]; break;
    }
    m = multiply(m, t);
  }
  return m;
}

// Split d-attribute into a flat token stream of command letters + numbers.
function tokenizePathData(d) {
  const out = [];
  const re = /[MLHVCSQTAZmlhvcsqtaz]|-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/g;
  let match;
  while ((match = re.exec(d)) !== null) {
    const t = match[0];
    out.push(/[a-zA-Z]/.test(t) ? t : parseFloat(t));
  }
  return out;
}

// SVG elliptical arc → cubic beziers. Adapted from the W3C implementation.
function arcToCubic(x1, y1, x2, y2, rx, ry, phi, largeArc, sweep) {
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  rx = Math.abs(rx); ry = Math.abs(ry);

  // Conversion from endpoint to center parameterization.
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p =  cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  let rxSq = rx * rx, rySq = ry * ry;
  const x1pSq = x1p * x1p, y1pSq = y1p * y1p;
  const lam = x1pSq / rxSq + y1pSq / rySq;
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; rxSq = rx * rx; rySq = ry * ry; }

  const sign = largeArc === sweep ? -1 : 1;
  const sq = Math.max(0, (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / (rxSq * y1pSq + rySq * x1pSq));
  const coef = sign * Math.sqrt(sq);
  const cxp = coef *  (rx * y1p) / ry;
  const cyp = coef * -(ry * x1p) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta  = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (sweep && dtheta < 0) dtheta += 2 * Math.PI;

  const segments = Math.ceil(Math.abs(dtheta) / (Math.PI / 2));
  const delta = dtheta / segments;
  const t = (4 / 3) * Math.tan(delta / 4);

  const cubics = [];
  let theta = theta1;
  let startX = x1, startY = y1;
  for (let s = 0; s < segments; s++) {
    const theta2 = theta + delta;
    const cosT1 = Math.cos(theta), sinT1 = Math.sin(theta);
    const cosT2 = Math.cos(theta2), sinT2 = Math.sin(theta2);
    const e1x = -rx * cosPhi * sinT1 - ry * sinPhi * cosT1;
    const e1y = -rx * sinPhi * sinT1 + ry * cosPhi * cosT1;
    const e2x = -rx * cosPhi * sinT2 - ry * sinPhi * cosT2;
    const e2y = -rx * sinPhi * sinT2 + ry * cosPhi * cosT2;
    const endX = rx * cosPhi * cosT2 - ry * sinPhi * sinT2 + cx;
    const endY = rx * sinPhi * cosT2 + ry * cosPhi * sinT2 + cy;
    cubics.push([
      startX + t * e1x, startY + t * e1y,
      endX   - t * e2x, endY   - t * e2y,
      endX,             endY,
    ]);
    startX = endX; startY = endY;
    theta = theta2;
  }
  return cubics;
}

function bbox(commands) {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const c of commands) {
    const pts = [];
    if (c.type === 'M' || c.type === 'L') pts.push([c.x, c.y]);
    else if (c.type === 'Q') { pts.push([c.x1, c.y1], [c.x, c.y]); }
    else if (c.type === 'C') { pts.push([c.x1, c.y1], [c.x2, c.y2], [c.x, c.y]); }
    for (const [x, y] of pts) {
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
  }
  if (!isFinite(xMin)) return { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
  return { xMin, xMax, yMin, yMax };
}

// Apply a coordinate transform fn(x, y) → {x, y} to every control point of a command.
function transformCommand(cmd, fn) {
  switch (cmd.type) {
    case 'M':
    case 'L': {
      const p = fn(cmd.x, cmd.y);
      return { type: cmd.type, x: p.x, y: p.y };
    }
    case 'Q': {
      const p1 = fn(cmd.x1, cmd.y1);
      const p  = fn(cmd.x,  cmd.y);
      return { type: 'Q', x1: p1.x, y1: p1.y, x: p.x, y: p.y };
    }
    case 'C': {
      const p1 = fn(cmd.x1, cmd.y1);
      const p2 = fn(cmd.x2, cmd.y2);
      const p  = fn(cmd.x,  cmd.y);
      return { type: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y };
    }
    case 'Z':
    default:
      return { ...cmd };
  }
}
