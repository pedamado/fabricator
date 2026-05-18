import { parseFont, getAxes, getInstances, getGlyphsByCategory, getFont } from './font-parser.js';
import { buildBlock } from './builder.js';
import { updatePlate, resetMeshGroup, getMeshGroup, frameGroup, updateBackground } from './scene.js';
import { exportSTLFromGroup, exportOBJFromGroup, exportZIP } from './exporter.js';

let activeCategory = 'all';
let glyphsList = [];
const activeGlyphIndices = new Set();
const axesValues = {};
let isGenerating = false;

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
const plateSel = document.getElementById('plate-select');
const btnSTL = document.getElementById('btn-export-stl');
const btnOBJ = document.getElementById('btn-export-obj');
const btnZIP = document.getElementById('btn-export-zip');

export function initUI() {
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

  updateButtons();
}

async function handleFontLoaded(arrayBuffer, filename) {
  loading.classList.remove('hidden');
  loading.querySelector('span').textContent = 'Loading font data...';
  
  setTimeout(async () => {
    try {
      await parseFont(arrayBuffer);
      
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
        updateCategoryList();
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
        updateCategoryList();
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

      for (let idx of activeGlyphIndices) {
        const blockData = await buildBlock(idx, activeCategory === 'spacing_quads' ? 'Spacing Quads' : activeCategory, glyphsList, axesValues, mirror, applyDraft);
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

  try {
    const { blob, folderName } = await exportZIP(
      glyphsList,
      activeCategory === 'spacing_quads' ? 'Spacing Quads' : activeCategory,
      axesValues,
      mirror,
      applyDraft,
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
