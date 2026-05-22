import { parseFont, getAxes, getInstances, getGlyphsByCategory, getFont } from './font-parser.js';
import { buildBlock, buildSlugFromSource } from './builder.js';
import { buildEmbossingPair, buildEmbossingBlock } from './embossing.js';
import {
  parseSVG, traceBitmap,
  binarizeImage, traceImage, buildSourceFromSvg,
} from './sources/index.js';
import { updatePlate, resetMeshGroup, getMeshGroup, frameGroup, updateBackground, setLightMode, setXrayMode, getViewState } from './scene.js';
import { exportSTLFromGroup, exportOBJFromGroup, exportZIP } from './exporter.js';

let activeCategory = 'all';
let glyphsList = [];
const activeGlyphIndices = new Set();
const axesValues = {};
let isGenerating = false;

// Active non-font source (vector or bitmap). When set, the font-only panels
// are hidden and generate3D builds one sort directly from this source
// instead of looping over glyphsList.
let activeGraphicSource = null;

// ─── Slug customization options (persisted across the session) ────────────
const SLUG_OPTIONS_KEY = 'fabricator.slugOptions.v9.1.2';
const DIDOT_PT_TO_MM = 0.376065;

const DEFAULT_SLUG_OPTIONS = {
  fontSizePt: 144,
  bodySizeMM: +(144 * DIDOT_PT_TO_MM).toFixed(3), // ≈ 54.15mm
  slugHeight: 20.56,
  reliefHeight: 3.0,
  hollow: true,
  hollowMinWidth: 24,
  wallThickness: 8,
  supportWallsEnabled: true,
  maxCellSpan: 15,
  drainEnabled: true,
  drainSize: 5,
  chamferEnabled: true,
  chamferSize: 1.083,
  footNickEnabled: true,
  footNickRadius: 2.0,
  baselineNickEnabled: true,
  baselineNickRadius: 1.0,
  beardEnabled: true,
  beardPercent: 2.0,
  slopeEnabled: true,
  slopeAngle: 12,

  // v9.1 — Embossing & Debossing pair options. When `embossing.enabled` is
  // true, the regular single-matrix output is replaced by a matrix +
  // counter pair built by js/embossing.js.
  embossing: {
    enabled: false,
    mode: 'deboss',          // 'deboss' | 'emboss'
    handEmbosser: false,
    paperTolerance: 0.10,    // mm
    slopeAngle: 12,
    matrixReliefHeight: 0.6, // 0.3–2.0 mm; 0.6 mm = book-stock default
    counterBaseHeight: 1.0,
    counterReliefHeight: 0.6,
    plateShape: 'glyph',     // 'glyph' | 'rect' | 'round'
    plateWidth: 40,
    plateHeight: 40,
    lockAspect: true,
    glyphScale: 1.0,
    grayscaleLevels: 0,
  },
};

let slugOptions = { ...DEFAULT_SLUG_OPTIONS, embossing: { ...DEFAULT_SLUG_OPTIONS.embossing } };

function loadSlugOptions() {
  try {
    const raw = sessionStorage.getItem(SLUG_OPTIONS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      slugOptions = {
        ...DEFAULT_SLUG_OPTIONS,
        ...parsed,
        // Deep-merge the nested embossing block so a stored partial
        // object doesn't drop fields we added in a later version.
        embossing: {
          ...DEFAULT_SLUG_OPTIONS.embossing,
          ...(parsed.embossing || {}),
        },
      };
    }
  } catch (e) {
    console.warn('Could not restore slugOptions from sessionStorage:', e);
  }
}

function persistSlugOptions() {
  try {
    sessionStorage.setItem(SLUG_OPTIONS_KEY, JSON.stringify(slugOptions));
  } catch (e) {
    /* sessionStorage may be unavailable in some embed contexts — ignore */
  }
}

// DOM references
const dropzone = document.getElementById('dropzone');
const vectorDropzone = document.getElementById('vector-dropzone');
const bitmapDropzone = document.getElementById('bitmap-dropzone');
const controlsPanel = document.getElementById('controls');
const fontInfo = document.getElementById('font-info');
const fontNameTag = document.getElementById('font-name-tag');
const instanceSel = document.getElementById('instance-select');
const axesControls = document.getElementById('axes-controls');
const filterSel = document.getElementById('filter-select');
const customInput = document.getElementById('custom-input');
const glyphGrid = document.getElementById('glyph-grid');
const selCount = document.getElementById('selected-count');
const loading = document.getElementById('loading');
const emptyState = document.getElementById('empty-state');
const mirrorCheck = document.getElementById('mirror-x');
const draftCheck = document.getElementById('draft-check');
const variableSizeCheck = document.getElementById('variable-size');
const plateSel = document.getElementById('plate-select');
const btnSTL = document.getElementById('btn-export-stl');
const btnOBJ = document.getElementById('btn-export-obj');
const btnZIP = document.getElementById('btn-export-zip');

export function initUI() {
  loadSlugOptions();
  const themeToggle = document.getElementById('theme-toggle');
  
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    document.documentElement.setAttribute('data-theme', 'light');
    themeToggle.textContent = '◑';
    updateBackground('light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    themeToggle.textContent = '◐';
    updateBackground('dark');
  }

  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    themeToggle.textContent = next === 'dark' ? '◐' : '◑';
    updateBackground(next);
  });

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => {
    document.body.addEventListener(ev, e => e.preventDefault(), false);
  });

  dropzone.addEventListener('dragenter', () => dropzone.classList.add('dragover'));
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('dragover', () => dropzone.classList.add('dragover'));

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) { alert('No file detected.'); return; }
    if (!file.name.toLowerCase().endsWith('.ttf') && !file.name.toLowerCase().endsWith('.otf')) {
      alert('Please drop a .ttf or .otf font file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (evt) => handleFontLoaded(evt.target.result, file.name);
    reader.onerror = () => alert('Could not read file.');
    reader.readAsArrayBuffer(file);
  });

  dropzone.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ttf,.otf';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => handleFontLoaded(evt.target.result, file.name);
      reader.readAsArrayBuffer(file);
    };
    input.click();
  });

  // ─── Vector dropzone (.svg today; .pdf/.ai in v9.1) ─────────────────
  if (vectorDropzone) {
    vectorDropzone.addEventListener('dragenter', () => vectorDropzone.classList.add('dragover'));
    vectorDropzone.addEventListener('dragleave', () => vectorDropzone.classList.remove('dragover'));
    vectorDropzone.addEventListener('dragover',  () => vectorDropzone.classList.add('dragover'));
    vectorDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      vectorDropzone.classList.remove('dragover');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      handleVectorFile(file);
    });
    vectorDropzone.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.svg,.pdf,.ai,image/svg+xml,application/pdf';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) handleVectorFile(file);
      };
      input.click();
    });
  }

  // ─── Bitmap dropzone ────────────────────────────────────────────────
  if (bitmapDropzone) {
    bitmapDropzone.addEventListener('dragenter', () => bitmapDropzone.classList.add('dragover'));
    bitmapDropzone.addEventListener('dragleave', () => bitmapDropzone.classList.remove('dragover'));
    bitmapDropzone.addEventListener('dragover',  () => bitmapDropzone.classList.add('dragover'));
    bitmapDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      bitmapDropzone.classList.remove('dragover');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      handleBitmapFile(file);
    });
    bitmapDropzone.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) handleBitmapFile(file);
      };
      input.click();
    });
  }

  filterSel.addEventListener('change', () => {
    activeCategory = filterSel.value;
    activeGlyphIndices.clear();
    updateCategoryList();
  });

  plateSel.addEventListener('change', () => {
    const size = plateSel.value;
    let pW = null, pH = null;
    if (size === '200x200') { pW = 200; pH = 200; }
    else if (size === '90x120') { pW = 90; pH = 120; }
    updatePlate(pW, pH);
    generate3D();
  });

  mirrorCheck.addEventListener('change', generate3D);
  draftCheck.addEventListener('change', generate3D);
  variableSizeCheck.addEventListener('change', generate3D);

  btnSTL.addEventListener('click', () => {
    const group = getMeshGroup();
    const hasOutput = activeGraphicSource || activeGlyphIndices.size > 0;
    if (group && hasOutput) {
      const baseName = activeGraphicSource
        ? `letterpress_${activeGraphicSource.name}`
        : 'letterpress_sorts';
      downloadFile(exportSTLFromGroup(group), 'stl', baseName);
    }
  });

  btnOBJ.addEventListener('click', () => {
    const group = getMeshGroup();
    const hasOutput = activeGraphicSource || activeGlyphIndices.size > 0;
    if (group && hasOutput) {
      const baseName = activeGraphicSource
        ? `letterpress_${activeGraphicSource.name}`
        : 'letterpress_sorts';
      downloadFile(exportOBJFromGroup(group), 'obj', baseName);
    }
  });

  btnZIP.addEventListener('click', () => {
    if (activeGraphicSource) {
      handleSingleGraphicZip();
    } else {
      handleZipExport();
    }
  });

  // Bulk glyph select / deselect
  const btnSelectAll   = document.getElementById('btn-select-all');
  const btnDeselectAll = document.getElementById('btn-deselect-all');
  if (btnSelectAll) {
    btnSelectAll.addEventListener('click', () => {
      if (activeGraphicSource || glyphsList.length === 0) return;
      activeGlyphIndices.clear();
      for (let i = 0; i < glyphsList.length; i++) activeGlyphIndices.add(i);
      glyphGrid.querySelectorAll('.glyph-btn').forEach(b => b.classList.add('selected'));
      updateSelCount();
      updateButtons();
      generate3D();
    });
  }
  if (btnDeselectAll) {
    btnDeselectAll.addEventListener('click', () => {
      if (activeGraphicSource) return;
      if (activeGlyphIndices.size === 0) return;
      activeGlyphIndices.clear();
      glyphGrid.querySelectorAll('.glyph-btn').forEach(b => b.classList.remove('selected'));
      updateSelCount();
      updateButtons();
      resetMeshGroup();
    });
  }

  initAdvancedPanel();
  initEmbossingPanel();
  initViewToolbar();
  updateButtons();
}

// ─── Viewport overlay: bright lighting + X-ray toggles (v9.1.4) ───────────
function initViewToolbar() {
  const btnBright = document.getElementById('btn-bright');
  const btnXray   = document.getElementById('btn-xray');
  if (!btnBright || !btnXray) return;

  // Restore last state from sessionStorage
  let bright = false, xray = false;
  try {
    bright = sessionStorage.getItem('fabricator.viewBright') === '1';
    xray   = sessionStorage.getItem('fabricator.viewXray')   === '1';
  } catch (e) {}
  setLightMode(bright ? 'bright' : 'normal');
  setXrayMode(xray);
  btnBright.classList.toggle('active', bright);
  btnXray.classList.toggle('active',   xray);

  btnBright.addEventListener('click', () => {
    const cur = getViewState();
    const next = !cur.brightMode;
    setLightMode(next ? 'bright' : 'normal');
    btnBright.classList.toggle('active', next);
    try { sessionStorage.setItem('fabricator.viewBright', next ? '1' : '0'); } catch (e) {}
  });
  btnXray.addEventListener('click', () => {
    const cur = getViewState();
    const next = !cur.xrayMode;
    setXrayMode(next);
    btnXray.classList.toggle('active', next);
    try { sessionStorage.setItem('fabricator.viewXray', next ? '1' : '0'); } catch (e) {}
  });
}

// ─── Embossing & Debossing accordion (v9.1) ────────────────────────────────
function initEmbossingPanel() {
  const panel = document.getElementById('embossing-panel');
  if (!panel) return;
  const $ = (id) => document.getElementById(id);
  const el = {
    enabled:        $('emb-enabled'),
    modeDeboss:     $('emb-mode-deboss'),
    modeEmboss:     $('emb-mode-emboss'),
    hand:           $('emb-hand'),
    tol:            $('emb-tol'),
    tolVal:         $('emb-tol-val'),
    slope:          $('emb-slope'),
    slopeVal:       $('emb-slope-val'),
    matRelief:      $('emb-mat-relief'),
    matReliefVal:   $('emb-mat-relief-val'),
    cntBase:        $('emb-cnt-base'),
    cntBaseVal:     $('emb-cnt-base-val'),
    cntRelief:      $('emb-cnt-relief'),
    cntReliefVal:   $('emb-cnt-relief-val'),
    plateShape:     $('emb-plate-shape'),
    plateW:         $('emb-plate-w'),
    plateWVal:      $('emb-plate-w-val'),
    plateH:         $('emb-plate-h'),
    plateHVal:      $('emb-plate-h-val'),
    lockAspect:     $('emb-lock-aspect'),
    scale:          $('emb-scale'),
    scaleVal:       $('emb-scale-val'),
    grayLevels:     $('emb-gray-levels'),
    reset:          $('emb-reset'),
  };
  if (!el.enabled) return;

  // ── Push state → inputs ─────────────────────────────────────────────
  function pushState() {
    const e = slugOptions.embossing;
    el.enabled.checked = e.enabled;
    el.modeDeboss.checked = e.mode === 'deboss';
    el.modeEmboss.checked = e.mode === 'emboss';
    el.hand.checked = e.handEmbosser;
    el.tol.value = e.paperTolerance;
    el.tolVal.textContent = `${e.paperTolerance.toFixed(3)}mm`;
    el.slope.value = e.slopeAngle;
    el.slopeVal.textContent = `${e.slopeAngle}°`;
    el.matRelief.value = e.matrixReliefHeight;
    el.matReliefVal.textContent = `${e.matrixReliefHeight.toFixed(2)}mm`;
    el.cntBase.value = e.counterBaseHeight;
    el.cntBaseVal.textContent = `${e.counterBaseHeight.toFixed(2)}mm`;
    el.cntRelief.value = e.counterReliefHeight;
    el.cntReliefVal.textContent = `${e.counterReliefHeight.toFixed(2)}mm`;
    el.plateShape.value = e.plateShape;
    el.plateW.value = e.plateWidth;
    el.plateWVal.textContent = `${e.plateWidth.toFixed(1)}mm`;
    el.plateH.value = e.plateHeight;
    el.plateHVal.textContent = `${e.plateHeight.toFixed(1)}mm`;
    el.lockAspect.checked = e.lockAspect;
    el.scale.value = e.glyphScale;
    el.scaleVal.textContent = `${e.glyphScale.toFixed(2)}×`;
    el.grayLevels.value = String(e.grayscaleLevels || 0);
    syncDisabledStates();
  }

  function syncDisabledStates() {
    const enabled = slugOptions.embossing.enabled;
    panel.querySelectorAll('.adv-section').forEach(sec => {
      sec.classList.toggle('disabled', !enabled);
    });
    // Plate W/H rows are only useful when shape ≠ 'glyph'
    const plateLocked = slugOptions.embossing.plateShape === 'glyph';
    [el.plateW, el.plateH, el.lockAspect].forEach(c => {
      if (c) c.disabled = !enabled || plateLocked;
    });
  }

  function commit() { persistSlugOptions(); generate3D(); }

  // ── Event wiring ────────────────────────────────────────────────────
  el.enabled.addEventListener('change', () => {
    slugOptions.embossing.enabled = el.enabled.checked;
    syncDisabledStates();
    commit();
  });
  [el.modeDeboss, el.modeEmboss].forEach(r => r.addEventListener('change', () => {
    slugOptions.embossing.mode = el.modeEmboss.checked ? 'emboss' : 'deboss';
    commit();
  }));
  el.hand.addEventListener('change', () => {
    slugOptions.embossing.handEmbosser = el.hand.checked;
    commit();
  });
  el.tol.addEventListener('input', () => {
    slugOptions.embossing.paperTolerance = parseFloat(el.tol.value);
    el.tolVal.textContent = `${slugOptions.embossing.paperTolerance.toFixed(3)}mm`;
    commit();
  });
  el.slope.addEventListener('input', () => {
    slugOptions.embossing.slopeAngle = parseFloat(el.slope.value);
    el.slopeVal.textContent = `${slugOptions.embossing.slopeAngle}°`;
    commit();
  });
  el.matRelief.addEventListener('input', () => {
    slugOptions.embossing.matrixReliefHeight = parseFloat(el.matRelief.value);
    el.matReliefVal.textContent = `${slugOptions.embossing.matrixReliefHeight.toFixed(2)}mm`;
    commit();
  });
  el.cntBase.addEventListener('input', () => {
    slugOptions.embossing.counterBaseHeight = parseFloat(el.cntBase.value);
    el.cntBaseVal.textContent = `${slugOptions.embossing.counterBaseHeight.toFixed(2)}mm`;
    commit();
  });
  el.cntRelief.addEventListener('input', () => {
    slugOptions.embossing.counterReliefHeight = parseFloat(el.cntRelief.value);
    el.cntReliefVal.textContent = `${slugOptions.embossing.counterReliefHeight.toFixed(2)}mm`;
    commit();
  });
  el.plateShape.addEventListener('change', () => {
    slugOptions.embossing.plateShape = el.plateShape.value;
    syncDisabledStates();
    commit();
  });
  // Lock-aspect tie between plateWidth and plateHeight.
  const onPlateDim = (which, otherSlider, otherStorageKey, otherValEl) => () => {
    const v = parseFloat(which.value);
    if (which === el.plateW) {
      const oldW = slugOptions.embossing.plateWidth;
      slugOptions.embossing.plateWidth = v;
      el.plateWVal.textContent = `${v.toFixed(1)}mm`;
      if (slugOptions.embossing.lockAspect && oldW > 0) {
        const ratio = slugOptions.embossing.plateHeight / oldW;
        const newH = +(v * ratio).toFixed(1);
        slugOptions.embossing.plateHeight = newH;
        el.plateH.value = newH;
        el.plateHVal.textContent = `${newH.toFixed(1)}mm`;
      }
    } else {
      const oldH = slugOptions.embossing.plateHeight;
      slugOptions.embossing.plateHeight = v;
      el.plateHVal.textContent = `${v.toFixed(1)}mm`;
      if (slugOptions.embossing.lockAspect && oldH > 0) {
        const ratio = slugOptions.embossing.plateWidth / oldH;
        const newW = +(v * ratio).toFixed(1);
        slugOptions.embossing.plateWidth = newW;
        el.plateW.value = newW;
        el.plateWVal.textContent = `${newW.toFixed(1)}mm`;
      }
    }
    commit();
  };
  el.plateW.addEventListener('input', onPlateDim(el.plateW));
  el.plateH.addEventListener('input', onPlateDim(el.plateH));
  el.lockAspect.addEventListener('change', () => {
    slugOptions.embossing.lockAspect = el.lockAspect.checked;
    persistSlugOptions();
  });
  el.scale.addEventListener('input', () => {
    slugOptions.embossing.glyphScale = parseFloat(el.scale.value);
    el.scaleVal.textContent = `${slugOptions.embossing.glyphScale.toFixed(2)}×`;
    commit();
  });
  el.grayLevels.addEventListener('change', () => {
    slugOptions.embossing.grayscaleLevels = parseInt(el.grayLevels.value, 10) || 0;
    commit();
  });
  el.reset.addEventListener('click', () => {
    slugOptions.embossing = { ...DEFAULT_SLUG_OPTIONS.embossing };
    pushState();
    commit();
  });

  // Persist open/closed accordion state
  try {
    if (sessionStorage.getItem('fabricator.embossingPanelOpen') === '1') panel.open = true;
  } catch (e) {}
  panel.addEventListener('toggle', () => {
    try { sessionStorage.setItem('fabricator.embossingPanelOpen', panel.open ? '1' : '0'); } catch (e) {}
  });

  pushState();
}

// ─── Advanced customization panel wiring ───────────────────────────────
function initAdvancedPanel() {
  const advPanel        = document.getElementById('advanced-panel');
  const optFontSizeInput  = document.getElementById('opt-font-size-input');
  const optFontSizeSlider = document.getElementById('opt-font-size-slider');
  const optFontSizeMm     = document.getElementById('opt-font-size-mm');
  const optSlugHeightPreset = document.getElementById('opt-slug-height-preset');
  const optSlugHeight     = document.getElementById('opt-slug-height');
  const optSlugHeightVal  = document.getElementById('opt-slug-height-val');
  const optRelief         = document.getElementById('opt-relief');
  const optReliefVal      = document.getElementById('opt-relief-val');
  const optTotalHeight    = document.getElementById('opt-total-height');
  const optHollow         = document.getElementById('opt-hollow');
  const optHollowMin      = document.getElementById('opt-hollow-min');
  const optHollowMinVal   = document.getElementById('opt-hollow-min-val');
  const optWall           = document.getElementById('opt-wall');
  const optWallVal        = document.getElementById('opt-wall-val');
  const optSupportWalls   = document.getElementById('opt-support-walls');
  const optCellSpan       = document.getElementById('opt-cell-span');
  const optCellSpanVal    = document.getElementById('opt-cell-span-val');
  const optDrain          = document.getElementById('opt-drain');
  const optDrainSize      = document.getElementById('opt-drain-size');
  const optDrainVal       = document.getElementById('opt-drain-val');
  const optChamfer        = document.getElementById('opt-chamfer');
  const optChamferSize    = document.getElementById('opt-chamfer-size');
  const optChamferVal     = document.getElementById('opt-chamfer-val');
  const optFootNick       = document.getElementById('opt-foot-nick');
  const optFootNickSize   = document.getElementById('opt-foot-nick-size');
  const optFootNickVal    = document.getElementById('opt-foot-nick-val');
  const optBlNick         = document.getElementById('opt-bl-nick');
  const optBlNickSize     = document.getElementById('opt-bl-nick-size');
  const optBlNickVal      = document.getElementById('opt-bl-nick-val');
  const optBeardToggle    = document.getElementById('opt-beard-toggle');
  const optBeardSize      = document.getElementById('opt-beard-size');
  const optBeardVal       = document.getElementById('opt-beard-val');
  const optSlope          = document.getElementById('opt-slope');
  const optSlopeAngle     = document.getElementById('opt-slope-angle');
  const optSlopeVal       = document.getElementById('opt-slope-val');
  const optReset          = document.getElementById('opt-reset');

  if (!advPanel) return;

  // Helpers
  const PRESET_HEIGHTS = ['20.56', '20.32', '21.60', '21.85'];

  function toggleDisabledState(checkbox) {
    const section = checkbox.closest('.adv-section');
    if (!section) return;
    section.classList.toggle('disabled', !checkbox.checked);
  }

  function updateTotalHeightLabel() {
    if (!optTotalHeight) return;
    const total = slugOptions.slugHeight + slugOptions.reliefHeight;
    optTotalHeight.textContent = `${total.toFixed(2)}mm`;
  }

  function matchPresetFromValue() {
    if (!optSlugHeightPreset) return;
    const cur = slugOptions.slugHeight.toFixed(2);
    optSlugHeightPreset.value = PRESET_HEIGHTS.includes(cur) ? cur : 'custom';
  }

  function pushStateToInputs() {
    optFontSizeInput.value  = slugOptions.fontSizePt;
    optFontSizeSlider.value = slugOptions.fontSizePt;
    optFontSizeMm.textContent = `${slugOptions.bodySizeMM.toFixed(2)}mm`;

    optSlugHeight.value = slugOptions.slugHeight;
    optSlugHeightVal.textContent = `${slugOptions.slugHeight.toFixed(2)}mm`;
    matchPresetFromValue();

    optRelief.value = slugOptions.reliefHeight;
    optReliefVal.textContent = `${slugOptions.reliefHeight.toFixed(1)}mm`;
    updateTotalHeightLabel();

    optHollow.checked = slugOptions.hollow;
    optHollowMin.value = slugOptions.hollowMinWidth;
    optHollowMinVal.textContent = `${slugOptions.hollowMinWidth}mm`;
    optWall.value = slugOptions.wallThickness;
    optWallVal.textContent = `${slugOptions.wallThickness}mm`;
    if (optSupportWalls) optSupportWalls.checked = slugOptions.supportWallsEnabled;
    if (optCellSpan) {
      optCellSpan.value = slugOptions.maxCellSpan;
      optCellSpanVal.textContent = `${slugOptions.maxCellSpan}mm`;
    }
    toggleDisabledState(optHollow);

    optDrain.checked = slugOptions.drainEnabled;
    optDrainSize.value = slugOptions.drainSize;
    optDrainVal.textContent = `${slugOptions.drainSize}mm`;
    toggleDisabledState(optDrain);

    optChamfer.checked = slugOptions.chamferEnabled;
    optChamferSize.value = slugOptions.chamferSize;
    optChamferVal.textContent = `${slugOptions.chamferSize.toFixed(2)}mm`;
    toggleDisabledState(optChamfer);

    optFootNick.checked = slugOptions.footNickEnabled;
    optFootNickSize.value = slugOptions.footNickRadius;
    optFootNickVal.textContent = `${slugOptions.footNickRadius}mm`;
    toggleDisabledState(optFootNick);

    optBlNick.checked = slugOptions.baselineNickEnabled;
    optBlNickSize.value = slugOptions.baselineNickRadius;
    optBlNickVal.textContent = `${slugOptions.baselineNickRadius}mm`;
    toggleDisabledState(optBlNick);

    optBeardToggle.checked = slugOptions.beardEnabled;
    optBeardSize.value = slugOptions.beardPercent;
    optBeardVal.textContent = `${slugOptions.beardPercent.toFixed(1)}%`;
    toggleDisabledState(optBeardToggle);

    optSlope.checked = slugOptions.slopeEnabled;
    optSlopeAngle.value = slugOptions.slopeAngle;
    optSlopeVal.textContent = `${slugOptions.slopeAngle}°`;
    toggleDisabledState(optSlope);
  }

  function afterOptionChange() {
    persistSlugOptions();
    generate3D();
  }

  // Open/close state persisted
  try {
    if (sessionStorage.getItem('fabricator.advPanelOpen') === '1') advPanel.open = true;
  } catch (e) {}
  advPanel.addEventListener('toggle', () => {
    try { sessionStorage.setItem('fabricator.advPanelOpen', advPanel.open ? '1' : '0'); } catch (e) {}
  });

  // 1. Font size (number ↔ slider, computes mm)
  const onFontSize = (raw) => {
    let pt = Math.round(parseFloat(raw));
    if (!isFinite(pt)) pt = 144;
    pt = Math.max(10, Math.min(288, pt));
    optFontSizeInput.value = pt;
    optFontSizeSlider.value = pt;
    slugOptions.fontSizePt = pt;
    slugOptions.bodySizeMM = +(pt * DIDOT_PT_TO_MM).toFixed(3);
    optFontSizeMm.textContent = `${slugOptions.bodySizeMM.toFixed(2)}mm`;
    afterOptionChange();
  };
  optFontSizeInput.addEventListener('input',  e => onFontSize(e.target.value));
  optFontSizeSlider.addEventListener('input', e => onFontSize(e.target.value));

  // 2. Type height
  optSlugHeightPreset.addEventListener('change', () => {
    const v = optSlugHeightPreset.value;
    if (v === 'custom') return;
    slugOptions.slugHeight = parseFloat(v);
    optSlugHeight.value = slugOptions.slugHeight;
    optSlugHeightVal.textContent = `${slugOptions.slugHeight.toFixed(2)}mm`;
    updateTotalHeightLabel();
    afterOptionChange();
  });
  optSlugHeight.addEventListener('input', () => {
    slugOptions.slugHeight = parseFloat(optSlugHeight.value);
    optSlugHeightVal.textContent = `${slugOptions.slugHeight.toFixed(2)}mm`;
    matchPresetFromValue();
    updateTotalHeightLabel();
    afterOptionChange();
  });
  optRelief.addEventListener('input', () => {
    slugOptions.reliefHeight = parseFloat(optRelief.value);
    optReliefVal.textContent = `${slugOptions.reliefHeight.toFixed(1)}mm`;
    updateTotalHeightLabel();
    afterOptionChange();
  });

  // 3. Hollow
  optHollow.addEventListener('change', () => {
    slugOptions.hollow = optHollow.checked;
    toggleDisabledState(optHollow);
    afterOptionChange();
  });
  optHollowMin.addEventListener('input', () => {
    slugOptions.hollowMinWidth = parseFloat(optHollowMin.value);
    optHollowMinVal.textContent = `${slugOptions.hollowMinWidth}mm`;
    afterOptionChange();
  });
  optWall.addEventListener('input', () => {
    const v = parseFloat(optWall.value);
    slugOptions.wallThickness = v;
    optWallVal.textContent = `${v}mm`;
    // Max-end of the wall slider toggles hollow off (per spec)
    if (v >= parseFloat(optWall.max)) {
      slugOptions.hollow = false;
      optHollow.checked = false;
      toggleDisabledState(optHollow);
    }
    afterOptionChange();
  });
  if (optSupportWalls) {
    optSupportWalls.addEventListener('change', () => {
      slugOptions.supportWallsEnabled = optSupportWalls.checked;
      afterOptionChange();
    });
  }
  if (optCellSpan) {
    optCellSpan.addEventListener('input', () => {
      slugOptions.maxCellSpan = parseFloat(optCellSpan.value);
      optCellSpanVal.textContent = `${slugOptions.maxCellSpan}mm`;
      afterOptionChange();
    });
  }

  // 4. Drains
  optDrain.addEventListener('change', () => {
    slugOptions.drainEnabled = optDrain.checked;
    toggleDisabledState(optDrain);
    afterOptionChange();
  });
  optDrainSize.addEventListener('input', () => {
    slugOptions.drainSize = parseFloat(optDrainSize.value);
    optDrainVal.textContent = `${slugOptions.drainSize}mm`;
    if (slugOptions.drainSize === 0) {
      slugOptions.drainEnabled = false;
      optDrain.checked = false;
      toggleDisabledState(optDrain);
    }
    afterOptionChange();
  });

  // 5. Foot chamfer
  optChamfer.addEventListener('change', () => {
    slugOptions.chamferEnabled = optChamfer.checked;
    toggleDisabledState(optChamfer);
    afterOptionChange();
  });
  optChamferSize.addEventListener('input', () => {
    slugOptions.chamferSize = parseFloat(optChamferSize.value);
    optChamferVal.textContent = `${slugOptions.chamferSize.toFixed(2)}mm`;
    afterOptionChange();
  });

  // 6. Foot nick
  optFootNick.addEventListener('change', () => {
    slugOptions.footNickEnabled = optFootNick.checked;
    toggleDisabledState(optFootNick);
    afterOptionChange();
  });
  optFootNickSize.addEventListener('input', () => {
    slugOptions.footNickRadius = parseFloat(optFootNickSize.value);
    optFootNickVal.textContent = `${slugOptions.footNickRadius}mm`;
    afterOptionChange();
  });

  // 7. Baseline nick
  optBlNick.addEventListener('change', () => {
    slugOptions.baselineNickEnabled = optBlNick.checked;
    toggleDisabledState(optBlNick);
    afterOptionChange();
  });
  optBlNickSize.addEventListener('input', () => {
    slugOptions.baselineNickRadius = parseFloat(optBlNickSize.value);
    optBlNickVal.textContent = `${slugOptions.baselineNickRadius}mm`;
    afterOptionChange();
  });

  // 8. Beard
  optBeardToggle.addEventListener('change', () => {
    slugOptions.beardEnabled = optBeardToggle.checked;
    toggleDisabledState(optBeardToggle);
    afterOptionChange();
  });
  optBeardSize.addEventListener('input', () => {
    slugOptions.beardPercent = parseFloat(optBeardSize.value);
    optBeardVal.textContent = `${slugOptions.beardPercent.toFixed(1)}%`;
    afterOptionChange();
  });

  // 9. Slope
  optSlope.addEventListener('change', () => {
    slugOptions.slopeEnabled = optSlope.checked;
    toggleDisabledState(optSlope);
    // Keep the main "Apply Slope" toggle in sync (the simple Options panel)
    if (draftCheck) draftCheck.checked = optSlope.checked;
    afterOptionChange();
  });
  optSlopeAngle.addEventListener('input', () => {
    slugOptions.slopeAngle = parseFloat(optSlopeAngle.value);
    optSlopeVal.textContent = `${slugOptions.slopeAngle}°`;
    afterOptionChange();
  });

  // Reset
  if (optReset) {
    optReset.addEventListener('click', () => {
      slugOptions = { ...DEFAULT_SLUG_OPTIONS };
      pushStateToInputs();
      afterOptionChange();
    });
  }

  // Push restored / default state into the inputs on first render
  pushStateToInputs();
}

// ─── Graphic-source loaders (vector + bitmap) ──────────────────────────────
function setActiveGraphicSource(source, dropzoneEl, label) {
  activeGraphicSource = source;
  // Clear any prior font selection state — replace-on-drop semantics.
  activeGlyphIndices.clear();
  glyphsList = [];
  // Reflect "loaded" state on the relevant dropzone and reset siblings.
  [dropzone, vectorDropzone, bitmapDropzone].forEach(dz => {
    if (!dz) return;
    if (dz === dropzoneEl) {
      dz.classList.add('loaded');
      const span = dz.querySelector('span'); if (span) span.textContent = label;
      const icon = dz.querySelector('.drop-icon'); if (icon) icon.textContent = '✓';
    } else {
      dz.classList.remove('loaded');
    }
  });
  // Reset the font dropzone's label/icon if we just took it over.
  if (dropzoneEl !== dropzone) {
    const span = dropzone.querySelector('span'); if (span) span.textContent = 'Drop .ttf font file here';
    const icon = dropzone.querySelector('.drop-icon'); if (icon) icon.textContent = '⬇';
  }

  fontNameTag.textContent = `${source.kind === 'bitmap' ? 'Bitmap (traced):' : 'Vector:'} ${source.meta?.originalFilename || source.name}`;
  fontInfo.classList.remove('hidden');
  controlsPanel.classList.remove('hidden');
  emptyState.classList.add('hidden');

  setFontOnlyPanelsVisible(false);
  resetMeshGroup();
  generate3D();
}

function setFontOnlyPanelsVisible(visible) {
  document.querySelectorAll('.font-only').forEach(el => {
    el.classList.toggle('hidden', !visible);
  });
}

function clearActiveGraphicSource() {
  activeGraphicSource = null;
  setFontOnlyPanelsVisible(true);
  [vectorDropzone, bitmapDropzone].forEach(dz => {
    if (!dz) return;
    dz.classList.remove('loaded');
  });
}

async function handleVectorFile(file) {
  const ext = (file.name || '').toLowerCase();
  if (ext.endsWith('.pdf') || ext.endsWith('.ai')) {
    alert('PDF / AI support is coming in v9.1. For now, export your artwork as SVG from Illustrator (File → Export → Export As → SVG) and drop it here.');
    return;
  }
  if (!ext.endsWith('.svg') && file.type !== 'image/svg+xml') {
    alert('Vector dropzone accepts .svg files (and .pdf / .ai in v9.1).');
    return;
  }
  loading.classList.remove('hidden');
  loading.querySelector('span').textContent = `Parsing ${file.name}…`;
  try {
    const text = await readAsText(file);
    const source = parseSVG(text, stripExt(file.name));
    source.meta = { ...(source.meta || {}), originalFilename: file.name };
    setActiveGraphicSource(source, vectorDropzone, file.name);
  } catch (err) {
    console.error(err);
    alert('Could not parse SVG: ' + err.message);
  } finally {
    loading.classList.add('hidden');
  }
}

async function handleBitmapFile(file) {
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|gif|webp|tiff?|heif|heic|bmp)$/i.test(file.name)) {
    alert('Bitmap dropzone accepts image files (JPG, PNG, TIFF, HEIF, WebP, GIF).');
    return;
  }
  // Open the trace-options modal. The modal owns the binarize→trace→
  // preview→accept loop and calls back here with the final source.
  openTraceModal(file);
}

// ─── Trace-options modal ──────────────────────────────────────────────────
// One-shot lazy init: hook up controls the first time openTraceModal runs
// and then keep references in module scope.
let traceModalState = null;

function openTraceModal(file) {
  const modal = document.getElementById('trace-modal');
  if (!modal) {
    // Fallback to the direct pipeline if the modal markup is missing.
    return traceBitmap(file, stripExt(file.name))
      .then(src => setActiveGraphicSource(src, bitmapDropzone, file.name))
      .catch(err => alert('Could not trace image: ' + err.message));
  }
  if (!traceModalState) traceModalState = initTraceModal(modal);

  traceModalState.file = file;
  traceModalState.threshold = 128;
  traceModalState.invert = false;
  traceModalState.pathomit = 4;
  traceModalState.qtres = 0.5;

  // Sync UI to defaults
  traceModalState.threshInput.value = 128;
  traceModalState.threshVal.textContent = '128';
  traceModalState.pathomitInput.value = 4;
  traceModalState.pathomitVal.textContent = '4';
  traceModalState.qtresInput.value = 0.5;
  traceModalState.qtresVal.textContent = '0.5';
  traceModalState.invertInput.checked = false;
  traceModalState.resultBox.innerHTML = '<span class="trace-empty">Tracing…</span>';
  traceModalState.origBox.innerHTML  = '<span class="trace-empty">Loading…</span>';

  document.getElementById('trace-modal-title').textContent = `Trace Bitmap to Vector — ${file.name}`;
  modal.classList.remove('hidden');
  // Kick off the first trace
  scheduleTraceRefresh(0);
}

function initTraceModal(modal) {
  const state = {
    modal,
    file: null,
    threshold: 128,
    invert: false,
    pathomit: 4,
    qtres: 0.5,
    lastSvg: null,
    debounceTimer: null,
    busy: false,

    origBox:        document.getElementById('trace-orig'),
    resultBox:      document.getElementById('trace-result'),
    threshInput:    document.getElementById('trace-thresh'),
    threshVal:      document.getElementById('trace-thresh-val'),
    pathomitInput:  document.getElementById('trace-pathomit'),
    pathomitVal:    document.getElementById('trace-pathomit-val'),
    qtresInput:     document.getElementById('trace-qtres'),
    qtresVal:       document.getElementById('trace-qtres-val'),
    invertInput:    document.getElementById('trace-invert'),
    acceptBtn:      document.getElementById('trace-accept'),
    cancelBtn:      document.getElementById('trace-cancel'),
    closeBtn:       document.getElementById('trace-modal-close'),
    backdrop:       modal.querySelector('.modal-backdrop'),
  };

  state.threshInput.addEventListener('input', () => {
    state.threshold = parseInt(state.threshInput.value, 10) || 0;
    state.threshVal.textContent = state.threshold;
    scheduleTraceRefresh(120);
  });
  state.pathomitInput.addEventListener('input', () => {
    state.pathomit = parseInt(state.pathomitInput.value, 10) || 0;
    state.pathomitVal.textContent = state.pathomit;
    scheduleTraceRefresh(120);
  });
  state.qtresInput.addEventListener('input', () => {
    state.qtres = parseFloat(state.qtresInput.value);
    state.qtresVal.textContent = state.qtres.toFixed(2);
    scheduleTraceRefresh(120);
  });
  state.invertInput.addEventListener('change', () => {
    state.invert = state.invertInput.checked;
    scheduleTraceRefresh(0);
  });

  const close = () => modal.classList.add('hidden');
  state.cancelBtn.addEventListener('click', close);
  state.closeBtn.addEventListener('click', close);
  state.backdrop.addEventListener('click', close);

  state.acceptBtn.addEventListener('click', () => {
    if (!state.lastSvg || !state.file) return;
    try {
      const source = buildSourceFromSvg(state.lastSvg, stripExt(state.file.name), {
        tracedFrom: (state.file.type || '').split('/')[1] || 'image',
        originalFilename: state.file.name,
        threshold: state.threshold,
        invert: state.invert,
        pathomit: state.pathomit,
        qtres: state.qtres,
      });
      close();
      setActiveGraphicSource(source, bitmapDropzone, state.file.name);
    } catch (err) {
      console.error(err);
      alert('Could not build vector source from trace: ' + err.message);
    }
  });

  // Rebind the module-scope scheduler so all subsequent control changes
  // share this exact state object via closure.
  scheduleTraceRefresh = function (delay) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => runTraceRefresh(state), delay);
  };

  return state;
}

// Module-scope refresh scheduler. Initialised to a no-op so that the first
// call from openTraceModal (which fires before initTraceModal returns when
// it's the first invocation) doesn't throw. initTraceModal reassigns this
// to the real scheduler closed over the live state object.
let scheduleTraceRefresh = () => {};

async function runTraceRefresh(state) {
  if (state.busy || !state.file) return;
  state.busy = true;
  state.acceptBtn.disabled = true;
  state.resultBox.innerHTML = '<span class="trace-empty">Tracing…</span>';

  try {
    // Stage 1 — binarize. Shown as the "Binarized" preview.
    const { dataUrl } = await binarizeImage(state.file, state.threshold, state.invert);
    state.origBox.innerHTML = `<img alt="binarized preview" src="${dataUrl}">`;

    // Stage 2 — trace.
    const svg = await traceImage(dataUrl, {
      pathomit: state.pathomit,
      qtres:    state.qtres,
      // blurradius=0 — we already binarized so no need to blur.
      blurradius: 0,
    });
    state.lastSvg = svg;

    // Show the ink-only version (white paper layer stripped) in the
    // preview so the user sees the actual shape that will be extruded.
    const inkOnlySvg = svg.replace(
      /<path\b[^>]*fill\s*=\s*"rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)"[^>]*\/?>/g,
      ''
    );
    const hasInk = /<path\b/.test(inkOnlySvg);
    state.resultBox.innerHTML = hasInk
      ? inkOnlySvg
      : '<span class="trace-empty">No ink contours at this threshold — adjust the slider.</span>';
    state.acceptBtn.disabled = !hasInk;
  } catch (err) {
    console.error(err);
    state.resultBox.innerHTML = `<span class="trace-empty">Trace failed: ${err.message}</span>`;
  } finally {
    state.busy = false;
  }
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsText(file);
  });
}

function stripExt(name) {
  return (name || 'artwork').replace(/\.[^.]+$/, '');
}

async function handleFontLoaded(arrayBuffer, filename) {
  loading.classList.remove('hidden');
  loading.querySelector('span').textContent = 'Loading font data...';
  
  setTimeout(async () => {
    try {
      // Replace-on-drop: a new font wipes any active graphic source.
      clearActiveGraphicSource();
      await parseFont(arrayBuffer);

      const fontFace = new FontFace('UploadedFont', arrayBuffer, {
        weight: '100 1000',
        stretch: '1% 500%',
        style: 'oblique 0deg 20deg'
      });
      const loadedFace = await fontFace.load();
      document.fonts.add(loadedFace);
      
      glyphGrid.style.fontFamily = 'UploadedFont';
      customInput.style.fontFamily = 'UploadedFont';
      
      dropzone.classList.add('loaded');
      dropzone.querySelector('span').textContent = filename;
      dropzone.querySelector('.drop-icon').textContent = '✓';

      fontNameTag.textContent = filename;
      fontInfo.classList.remove('hidden');
      controlsPanel.classList.remove('hidden');
      emptyState.classList.add('hidden');

      setupAxesUI();
      updateCategoryList();
    } catch (err) {
      console.error(err);
      alert('Error parsing font: ' + err.message);
    } finally {
      loading.classList.add('hidden');
    }
  }, 50);
}

function setupAxesUI() {
  axesControls.innerHTML = '';
  instanceSel.innerHTML = '<option value="">Custom</option>';
  
  const axes = getAxes();
  if (axes.length > 0) {
    axes.forEach(axis => {
      axesValues[axis.tag] = axis.default;
      
      const wrap = document.createElement('div');
      wrap.className = 'axis-control';
      wrap.innerHTML = `
        <div class="axis-label">
          <strong>${axis.tag}</strong>
          <span class="axis-val" id="val-${axis.tag}">${axis.default}</span>
        </div>
        <input type="range"
          min="${axis.min}" max="${axis.max}"
          value="${axis.default}" step="1"
          data-axis="${axis.tag}">
      `;
      axesControls.appendChild(wrap);

      const slider = wrap.querySelector('input');
      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        document.getElementById(`val-${axis.tag}`).textContent = v;
        axesValues[axis.tag] = v;
        instanceSel.value = ''; // Set to custom
        
        const fvsString = Object.entries(axesValues).map(([t, val]) => `"${t}" ${val}`).join(', ');
        glyphGrid.style.fontVariationSettings = fvsString;
        customInput.style.fontVariationSettings = fvsString;
        glyphGrid.querySelectorAll('button').forEach(btn => {
          btn.style.fontVariationSettings = fvsString;
        });
        
        if (activeGlyphIndices.size > 0) {
          generate3D();
        }
      });
    });

    const instances = getInstances();
    if (instances.length > 0) {
      instances.forEach((inst, index) => {
        const opt = new Option(inst.name, index);
        instanceSel.appendChild(opt);
      });

      instanceSel.addEventListener('change', () => {
        const val = instanceSel.value;
        if (val === '') return;
        const inst = instances[parseInt(val)];
        if (!inst) return;
        
        Object.entries(inst.coordinates).forEach(([tag, v]) => {
          axesValues[tag] = v;
          const slider = document.querySelector(`input[data-axis="${tag}"]`);
          if (slider) {
            slider.value = v;
            document.getElementById(`val-${tag}`).textContent = v;
          }
        });
        
        const fvsString = Object.entries(axesValues).map(([t, val]) => `"${t}" ${val}`).join(', ');
        glyphGrid.style.fontVariationSettings = fvsString;
        customInput.style.fontVariationSettings = fvsString;
        glyphGrid.querySelectorAll('button').forEach(btn => {
          btn.style.fontVariationSettings = fvsString;
        });
        
        if (activeGlyphIndices.size > 0) {
          generate3D();
        }
      });
    }
  } else {
    axesControls.innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted)">No variable axes</span>';
  }
}

function updateCategoryList() {
  const fontObj = getFont();
  if (!fontObj) return;

  if (activeCategory === 'custom') {
    customInput.classList.remove('hidden');
    glyphGrid.innerHTML = '';
    
    customInput.oninput = () => {
      activeGlyphIndices.clear();
      const val = customInput.value;
      glyphsList = [];
      
      for (let i = 0; i < val.length; i++) {
        const char = val[i];
        const g = fontObj.charToGlyph(char);
        if (g && g.index > 0) {
          glyphsList.push(g);
          activeGlyphIndices.add(glyphsList.length - 1);
        }
      }
      renderGlyphGrid();
      updateButtons();
      generate3D();
    };
    
    glyphsList = [];
    renderGlyphGrid();
    updateButtons();
    resetMeshGroup();
    return;
  }

  customInput.classList.add('hidden');

  let catMapped = activeCategory;
  if (activeCategory === 'uppercase') catMapped = 'Uppercase';
  else if (activeCategory === 'lowercase') catMapped = 'Lowercase';
  else if (activeCategory === 'figures') catMapped = 'Figures';
  else if (activeCategory === 'punctuation') catMapped = 'Punctuation';
  else if (activeCategory === 'spacing_quads') catMapped = 'Spacing Quads';

  glyphsList = getGlyphsByCategory(catMapped, axesValues);
  
  const fvsString = Object.entries(axesValues)
    .map(([tag, val]) => `"${tag}" ${val}`)
    .join(', ');
  glyphGrid.style.fontVariationSettings = fvsString;
  customInput.style.fontVariationSettings = fvsString;
  
  activeGlyphIndices.clear();
  renderGlyphGrid();
  updateButtons();
  resetMeshGroup();
}

function renderGlyphGrid() {
  glyphGrid.innerHTML = '';
  glyphsList.forEach((g, i) => {
    const btn = document.createElement('button');
    btn.className = `glyph-btn ${activeGlyphIndices.has(i) ? 'selected' : ''}`;
    btn.title = g.name || 'Glyph';
    
    if (activeCategory === 'spacing_quads') {
      btn.textContent = g.name.substring(0, 2);
      btn.style.fontSize = '0.75rem';
    } else {
      btn.textContent = String.fromCharCode(g.unicode);
      btn.style.fontFamily = 'UploadedFont';
      
      const fvsString = Object.entries(axesValues).map(([t, val]) => `"${t}" ${val}`).join(', ');
      btn.style.fontVariationSettings = fvsString;
    }

    btn.addEventListener('click', () => {
      if (activeGlyphIndices.has(i)) {
        activeGlyphIndices.delete(i);
        btn.classList.remove('selected');
      } else {
        activeGlyphIndices.add(i);
        btn.classList.add('selected');
      }
      updateButtons();
      generate3D();
    });
    glyphGrid.appendChild(btn);
  });
  updateSelCount();
}

function updateSelCount() {
  selCount.textContent = `${activeGlyphIndices.size} glyphs selected`;
}

function updateButtons() {
  const hasOutput = activeGraphicSource || activeGlyphIndices.size > 0;
  const disable = !hasOutput || isGenerating;
  btnSTL.disabled = disable;
  btnOBJ.disabled = disable;
  // ZIP: graphic source = single STL bundle; font = batch over glyphsList.
  btnZIP.disabled = isGenerating || (!activeGraphicSource && glyphsList.length === 0);
}

let regenDebounceTimer = null;
function generate3D() {
  if (regenDebounceTimer) clearTimeout(regenDebounceTimer);
  regenDebounceTimer = setTimeout(() => {
    perform3DGeneration();
  }, 100);
}

async function perform3DGeneration() {
  // Three routes: (a) graphic source = one sort, (b) font with selection,
  // (c) nothing to do.
  if (!activeGraphicSource && activeGlyphIndices.size === 0) {
    resetMeshGroup();
    return;
  }

  isGenerating = true;
  updateButtons();
  loading.classList.remove('hidden');
  loading.querySelector('span').textContent = activeGraphicSource
    ? `Building 3D sort from ${activeGraphicSource.kind === 'bitmap' ? 'bitmap' : 'vector'} source…`
    : `Building 3D sorts (${activeGlyphIndices.size} selected)...`;

  setTimeout(async () => {
    try {
      resetMeshGroup();
      const masterGroup = getMeshGroup();

      const size = plateSel.value;
      let pW = null, pH = null;
      if (size === '200x200') { pW = 200; pH = 200; }
      else if (size === '90x120') { pW = 90; pH = 120; }

      const mirror = mirrorCheck.checked;
      const applyDraft = draftCheck.checked;
      const variableSize = variableSizeCheck.checked;

      const embossing = slugOptions.embossing && slugOptions.embossing.enabled;

      // ── Graphic-source route: one sort (or one pair), centred ──────
      if (activeGraphicSource) {
        if (embossing) {
          const pair = await buildEmbossingPair(
            activeGraphicSource, slugOptions, slugOptions.embossing, { mirror, applyDraft }
          );
          if (pair) {
            const spacing = 4;
            const { matrix, counter, plateW } = pair;
            matrix.group.position.x = -plateW / 2 - spacing / 2 - matrix.minX - matrix.w / 2;
            matrix.group.position.y = -matrix.minY - matrix.h / 2;
            counter.group.position.x =  plateW / 2 + spacing / 2 - counter.minX - counter.w / 2;
            counter.group.position.y = -counter.minY - counter.h / 2;
            masterGroup.add(matrix.group);
            masterGroup.add(counter.group);
          }
        } else {
          const blockData = await buildSlugFromSource(
            activeGraphicSource, mirror, applyDraft, variableSize, slugOptions
          );
          if (blockData) {
            const { group, w, h, minX, minY } = blockData;
            group.position.x = -minX - w / 2;
            group.position.y = -minY - h / 2;
            masterGroup.add(group);
          }
        }
        frameGroup(masterGroup, pW && pH, pH);
        return;
      }

      const margin = 5.0;
      const spacing = 2.0;
      let currentX = pW ? -pW / 2 + margin : 0;
      let currentY = pW ? pH / 2 - margin : 0;
      let rowMaxH = 0;

      for (let idx of activeGlyphIndices) {
        const category = activeCategory === 'spacing_quads' ? 'Spacing Quads' : activeCategory;

        if (embossing) {
          // Embossing route → pair output, lay out matrix + counter side-by-side
          // as if the pair were one wider sort. Row-wrap considers the full pair width.
          const pair = await buildEmbossingBlock(
            idx, category, glyphsList, axesValues,
            mirror, applyDraft, variableSize, slugOptions, slugOptions.embossing
          );
          if (!pair) continue;
          const { matrix, counter, plateW } = pair;
          const pairSpacing = 4;
          const pairW = plateW * 2 + pairSpacing;
          const pairH = Math.max(matrix.h, counter.h);
          if (pW && (currentX + pairW > pW / 2 - margin)) {
            currentX = -pW / 2 + margin;
            currentY -= (rowMaxH + spacing);
            rowMaxH = 0;
          }
          // Anchor the pair's bounding box top-left at (currentX, currentY)
          const anchorY = currentY - Math.max(matrix.maxY, counter.maxY);
          matrix.group.position.x  = currentX - matrix.minX;
          matrix.group.position.y  = anchorY - matrix.minY;
          counter.group.position.x = currentX - counter.minX + plateW + pairSpacing;
          counter.group.position.y = anchorY - counter.minY;
          masterGroup.add(matrix.group);
          masterGroup.add(counter.group);
          currentX += pairW + spacing;
          rowMaxH = Math.max(rowMaxH, pairH);
          continue;
        }

        const blockData = await buildBlock(
          idx, category, glyphsList, axesValues,
          mirror, applyDraft, variableSize, slugOptions
        );
        if (!blockData) continue;

        const { group, w, h, minX, minY, maxY } = blockData;

        // Layout Wrap Logic
        if (pW && (currentX + w > pW / 2 - margin)) {
          currentX = -pW / 2 + margin;
          currentY -= (rowMaxH + spacing);
          rowMaxH = 0;
        }

        // Center / position sort layout
        group.position.x = currentX - minX;
        group.position.y = currentY - maxY;
        masterGroup.add(group);

        currentX += w + spacing;
        rowMaxH = Math.max(rowMaxH, h);
      }

      frameGroup(masterGroup, pW && pH, pH);
      // Re-apply the current X-ray state to the freshly built meshes.
      if (getViewState().xrayMode) setXrayMode(true);

    } catch (err) {
      console.error(err);
      alert('Geometry construction failed: ' + err.message);
    } finally {
      isGenerating = false;
      loading.classList.add('hidden');
      updateButtons();
    }
  }, 50);
}

async function handleZipExport() {
  if (glyphsList.length === 0) return;
  
  isGenerating = true;
  updateButtons();
  loading.classList.remove('hidden');

  const mirror = mirrorCheck.checked;
  const applyDraft = draftCheck.checked;
  const variableSize = variableSizeCheck.checked;

  try {
    const { blob, folderName } = await exportZIP(
      glyphsList,
      activeCategory === 'spacing_quads' ? 'Spacing Quads' : activeCategory,
      axesValues,
      mirror,
      applyDraft,
      variableSize,
      slugOptions,
      (current, total, name) => {
        if (current) {
          loading.querySelector('span').textContent = `Exporting ${current}/${total}: ${name}...`;
        } else {
          loading.querySelector('span').textContent = name;
        }
      }
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${folderName}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    alert('ZIP Export failed: ' + err.message);
  } finally {
    isGenerating = false;
    loading.classList.add('hidden');
    updateButtons();
  }
}

async function handleSingleGraphicZip() {
  if (!activeGraphicSource) return;
  if (typeof JSZip === 'undefined') {
    alert('JSZip failed to load — ZIP export is unavailable.');
    return;
  }
  isGenerating = true;
  updateButtons();
  loading.classList.remove('hidden');
  loading.querySelector('span').textContent = `Packaging ${activeGraphicSource.name}.stl…`;

  try {
    const mirror = mirrorCheck.checked;
    const applyDraft = draftCheck.checked;
    const variableSize = variableSizeCheck.checked;
    const embossing = slugOptions.embossing && slugOptions.embossing.enabled;

    const zip = new JSZip();
    const baseTag = activeGraphicSource.kind === 'bitmap' ? 'Bitmap' : 'Vector';
    let folderName;

    if (embossing) {
      const pair = await buildEmbossingPair(
        activeGraphicSource, slugOptions, slugOptions.embossing,
        { mirror, applyDraft }
      );
      if (!pair || !pair.matrix || !pair.counter) throw new Error('Embossing pair build returned nothing.');
      folderName = `Letterpress_${baseTag}_${slugOptions.embossing.mode === 'emboss' ? 'Embossing' : 'Debossing'}_${activeGraphicSource.name}`;
      const f = zip.folder(folderName);
      pair.matrix.group.position.set(0, 0, 0);
      pair.matrix.group.updateMatrixWorld(true);
      f.file(`${activeGraphicSource.name}_matrix.stl`, exportSTLFromGroup(pair.matrix.group));
      pair.counter.group.position.set(0, 0, 0);
      pair.counter.group.updateMatrixWorld(true);
      f.file(`${activeGraphicSource.name}_counter.stl`, exportSTLFromGroup(pair.counter.group));
    } else {
      const blockData = await buildSlugFromSource(
        activeGraphicSource, mirror, applyDraft, variableSize, slugOptions
      );
      if (!blockData || !blockData.group) throw new Error('Geometry build returned nothing.');
      blockData.group.position.set(0, 0, 0);
      blockData.group.updateMatrixWorld(true);
      folderName = `Letterpress_${baseTag}_${activeGraphicSource.name}`;
      zip.folder(folderName).file(`${activeGraphicSource.name}.stl`, exportSTLFromGroup(blockData.group));
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${folderName}.zip`; a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    alert('ZIP export failed: ' + err.message);
  } finally {
    isGenerating = false;
    loading.classList.add('hidden');
    updateButtons();
  }
}

function downloadFile(content, ext, baseName = 'letterpress_sorts') {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}
