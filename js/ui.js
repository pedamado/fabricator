import { parseFont, getAxes, getInstances, getGlyphsByCategory, getFont } from './font-parser.js';
import { buildBlock } from './builder.js';
import { updatePlate, resetMeshGroup, getMeshGroup, frameGroup, updateBackground } from './scene.js';
import { exportSTLFromGroup, exportOBJFromGroup, exportZIP } from './exporter.js';

let activeCategory = 'all';
let glyphsList = [];
const activeGlyphIndices = new Set();
const axesValues = {};
let isGenerating = false;

// ─── Slug customization options (persisted across the session) ────────────
const SLUG_OPTIONS_KEY = 'fabricator.slugOptions.v8';
const DIDOT_PT_TO_MM = 0.376065;

const DEFAULT_SLUG_OPTIONS = {
  fontSizePt: 144,
  bodySizeMM: +(144 * DIDOT_PT_TO_MM).toFixed(3), // ≈ 54.15mm
  slugHeight: 20.56,
  reliefHeight: 3.0,
  hollow: true,
  hollowMinWidth: 24,
  wallThickness: 8,
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
};

let slugOptions = { ...DEFAULT_SLUG_OPTIONS };

function loadSlugOptions() {
  try {
    const raw = sessionStorage.getItem(SLUG_OPTIONS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      slugOptions = { ...DEFAULT_SLUG_OPTIONS, ...parsed };
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
    if (group && activeGlyphIndices.size > 0) {
      downloadFile(exportSTLFromGroup(group), 'stl');
    }
  });

  btnOBJ.addEventListener('click', () => {
    const group = getMeshGroup();
    if (group && activeGlyphIndices.size > 0) {
      downloadFile(exportOBJFromGroup(group), 'obj');
    }
  });

  btnZIP.addEventListener('click', handleZipExport);

  // Bulk glyph select / deselect
  const btnSelectAll   = document.getElementById('btn-select-all');
  const btnDeselectAll = document.getElementById('btn-deselect-all');
  if (btnSelectAll) {
    btnSelectAll.addEventListener('click', () => {
      if (glyphsList.length === 0) return;
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
      if (activeGlyphIndices.size === 0) return;
      activeGlyphIndices.clear();
      glyphGrid.querySelectorAll('.glyph-btn').forEach(b => b.classList.remove('selected'));
      updateSelCount();
      updateButtons();
      resetMeshGroup();
    });
  }

  initAdvancedPanel();
  updateButtons();
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

async function handleFontLoaded(arrayBuffer, filename) {
  loading.classList.remove('hidden');
  loading.querySelector('span').textContent = 'Loading font data...';
  
  setTimeout(async () => {
    try {
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
  const disable = activeGlyphIndices.size === 0 || isGenerating;
  btnSTL.disabled = disable;
  btnOBJ.disabled = disable;
  btnZIP.disabled = glyphsList.length === 0 || isGenerating;
}

let regenDebounceTimer = null;
function generate3D() {
  if (regenDebounceTimer) clearTimeout(regenDebounceTimer);
  regenDebounceTimer = setTimeout(() => {
    perform3DGeneration();
  }, 100);
}

async function perform3DGeneration() {
  if (activeGlyphIndices.size === 0) {
    resetMeshGroup();
    return;
  }

  isGenerating = true;
  updateButtons();
  loading.classList.remove('hidden');
  loading.querySelector('span').textContent = `Building 3D sorts (${activeGlyphIndices.size} selected)...`;

  setTimeout(async () => {
    try {
      resetMeshGroup();
      const masterGroup = getMeshGroup();
      
      const size = plateSel.value;
      let pW = null, pH = null;
      if (size === '200x200') { pW = 200; pH = 200; }
      else if (size === '90x120') { pW = 90; pH = 120; }

      const margin = 5.0;
      const spacing = 2.0;
      let currentX = pW ? -pW / 2 + margin : 0;
      let currentY = pW ? pH / 2 - margin : 0;
      let rowMaxH = 0;

      const mirror = mirrorCheck.checked;
      const applyDraft = draftCheck.checked;
      const variableSize = variableSizeCheck.checked;

      for (let idx of activeGlyphIndices) {
        const blockData = await buildBlock(
          idx,
          activeCategory === 'spacing_quads' ? 'Spacing Quads' : activeCategory,
          glyphsList,
          axesValues,
          mirror,
          applyDraft,
          variableSize,
          slugOptions
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

function downloadFile(content, ext) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `letterpress_sorts.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}
