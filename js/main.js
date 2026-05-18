import { initScene } from './scene.js';
import { initUI } from './ui.js';

document.addEventListener('DOMContentLoaded', () => {
  const viewport = document.getElementById('viewport');
  initScene(viewport);
  initUI();
});
