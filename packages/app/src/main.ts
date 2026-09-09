import { KeyboardCameraInput, Viewer } from '@cardstock/viewer';
import { loadFixture } from './fixture.js';
import './style.css';

const root = document.getElementById('root')!;
root.innerHTML = `
  <canvas id="stage" tabindex="0"></canvas>
  <div id="hud" class="panel"></div>
  <div id="filter" class="panel"></div>
  <div id="keys" class="panel">
    <kbd>←→↑↓</kbd> orbit · <kbd>shift</kbd>+arrows 15° · <kbd>ctrl</kbd>+arrows pan ·
    <kbd>+</kbd><kbd>−</kbd> zoom · <kbd>1</kbd>–<kbd>7</kbd> views ·
    <kbd>.</kbd> pivot · <kbd>F</kbd> fit · <kbd>tab</kbd> filter · <kbd>esc</kbd> clear
  </div>
`;

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const filterEl = document.getElementById('filter')!;

const viewer = new Viewer(canvas);
const keyboard = new KeyboardCameraInput(viewer);
keyboard.attach();

// --- pointer
canvas.addEventListener('pointermove', (e) => viewer.setPointer(e.clientX, e.clientY));
canvas.addEventListener('pointerleave', () => viewer.clearPointer());
canvas.addEventListener('pointerdown', (e) => {
  // Focus the canvas so keyboard navigation is scoped to the viewer rather than the
  // whole document — matters once panels and text fields exist.
  canvas.focus();
  if (e.button === 0) viewer.clickAt(e.clientX, e.clientY, e.shiftKey);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // Phase 5: radial menu
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  viewer.controller.target.zoom *= Math.exp(Math.sign(e.deltaY) * 0.12);
}, { passive: false });

// --- resize
const observer = new ResizeObserver(() => viewer.resize());
observer.observe(canvas);
addEventListener('resize', () => viewer.resize());

// --- readout
function render() {
  const { hover, selected, filter } = viewer.selection;
  filterEl.innerHTML = `filter <b>${filter}</b> <span class="dim">tab to cycle</span>`;
  const pick = viewer.lastPick;
  hud.innerHTML = hover && pick
    ? `<b>${hover.kind} #${hover.index}</b>
       <span class="dim">of ${countOf(hover.kind)}</span><br>
       <span class="dim">at</span> ${fmt(pick.point.x)}, ${fmt(pick.point.y)}, ${fmt(pick.point.z)}
       ${pick.normal ? `<br><span class="dim">normal</span> ${fmt(pick.normal.x)}, ${fmt(pick.normal.y)}, ${fmt(pick.normal.z)}` : ''}
       ${selected.length ? `<br><span class="sel">${selected.length} selected</span>` : ''}`
    : `<span class="dim">point at the model${selected.length ? ` · ${selected.length} selected` : ''}</span>`;
}
const fmt = (n: number) => n.toFixed(2);
function countOf(kind: string): number {
  const body = [...viewer.bodies.values()][0];
  if (!body) return 0;
  return kind === 'face' ? body.data.faceCount
    : kind === 'edge' ? body.data.edgeCount
    : kind === 'vertex' ? body.data.vertexCount : 1;
}
viewer.selection.subscribe(render);

// --- go
const body = await loadFixture('/bracket.json');
viewer.setBody(body);
viewer.fitAll();
viewer.controller.settle();
viewer.resize();
viewer.start();
render();

// Exposed for the Phase 1 verification harness (rAF is paused while a pane is hidden).
Object.assign(globalThis, {
  __viewer: viewer,
  __step: (steps = 60, dt = 1 / 60) => { for (let i = 0; i < steps; i++) viewer.step(dt); },
});

console.log(
  `[cardstock] ${body.faceCount} faces, ${body.edgeCount} edges, ${body.vertexCount} vertices, ` +
  `${body.indices.length / 3} triangles`,
);
