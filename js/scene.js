import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let scene, camera, renderer, controls;
let meshGroup;
let plateMesh = null;

// Lighting rigs. The default rig stays unchanged. The "bright" rig adds
// three more directional lights from different angles + a stronger
// ambient so shallow embossing cavities and fine glyph details are
// easier to read in the viewport.
let ambientLight = null;
let defaultDirLight = null;
const brightDirLights = [];
let brightModeOn = false;
let xrayModeOn = false;

export function updateBackground(theme) {
  if (scene) {
    scene.background = new THREE.Color(theme === 'light' ? 0xf9fafb : 0x0d0d12);
  }
}

export function initScene(viewportEl) {
  scene = new THREE.Scene();
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  scene.background = new THREE.Color(isLight ? 0xf9fafb : 0x0d0d12);

  const w = viewportEl.clientWidth;
  const h = viewportEl.clientHeight;
  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 2000);
  camera.position.set(0, -150, 150);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h);
  viewportEl.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 10);

  ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);
  defaultDirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  defaultDirLight.position.set(50, -50, 100);
  scene.add(defaultDirLight);

  // Three extra directional lights for "bright" inspection mode, parked
  // off-scene at intensity 0 so they exist but contribute nothing until
  // setLightMode('bright') is called.
  const brightPositions = [
    [-80, -60, 120],   // upper-left
    [ 80,  60, 120],   // upper-right rear
    [  0,  80,  60],   // top, behind
  ];
  for (const pos of brightPositions) {
    const dl = new THREE.DirectionalLight(0xffffff, 0);
    dl.position.set(pos[0], pos[1], pos[2]);
    scene.add(dl);
    brightDirLights.push(dl);
  }

  const grid = new THREE.GridHelper(400, 40, 0x2a2a3a, 0x1e1e2a);
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);

  meshGroup = new THREE.Group();
  meshGroup.name = 'MasterPrintGroup';
  scene.add(meshGroup);

  window.addEventListener('resize', () => {
    const w = viewportEl.clientWidth;
    const h = viewportEl.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });

  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();

  return { scene, camera, renderer, controls, meshGroup };
}

export function updatePlate(width, height) {
  if (plateMesh) {
    scene.remove(plateMesh);
    plateMesh = null;
  }
  if (width && height) {
    const plateGeo = new THREE.PlaneGeometry(width, height);
    const plateMat = new THREE.MeshBasicMaterial({
      color: 0x4a4a5a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.2
    });
    plateMesh = new THREE.Mesh(plateGeo, plateMat);
    plateMesh.position.set(0, 0, -0.1);
    scene.add(plateMesh);
  }
}

export function getMeshGroup() {
  return meshGroup;
}

export function resetMeshGroup() {
  if (meshGroup) {
    while (meshGroup.children.length > 0) {
      meshGroup.remove(meshGroup.children[0]);
    }
  }
}

// ─── View-mode helpers (lighting + X-ray) ─────────────────────────────────
export function setLightMode(mode) {
  brightModeOn = (mode === 'bright');
  if (!ambientLight || !defaultDirLight) return;
  if (brightModeOn) {
    ambientLight.intensity = 1.1;
    defaultDirLight.intensity = 0.9;
    brightDirLights.forEach(dl => { dl.intensity = 0.45; });
  } else {
    ambientLight.intensity = 0.6;
    defaultDirLight.intensity = 0.8;
    brightDirLights.forEach(dl => { dl.intensity = 0; });
  }
}

export function setXrayMode(enabled) {
  xrayModeOn = !!enabled;
  if (!meshGroup) return;
  meshGroup.traverse(applyViewModeToMesh);
}

// Apply current X-ray state to a single mesh. Called when the user toggles
// the X-ray button AND every time a new mesh is added to the group (via
// scene.resetMeshGroup → ui.js generate3D path).
export function applyViewModeToMesh(obj) {
  if (!obj || !obj.isMesh || !obj.material) return;
  const m = obj.material;
  if (xrayModeOn) {
    m.transparent = true;
    m.opacity = 0.42;
    m.depthWrite = false;
  } else {
    m.transparent = false;
    m.opacity = 1.0;
    m.depthWrite = true;
  }
  m.needsUpdate = true;
}

export function getViewState() {
  return { brightMode: brightModeOn, xrayMode: xrayModeOn };
}

export function frameGroup(group, hasPlate, pH) {
  if (hasPlate) {
    controls.target.set(0, 0, 0);
    camera.position.set(0, -pH - 100, 150);
  } else {
    const box = new THREE.Box3().setFromObject(group);
    if (!box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3());
      controls.target.copy(center);
      camera.position.set(center.x, center.y - 150, 150);
    }
  }
  controls.update();
}
