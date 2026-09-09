import { asFeatureId } from '@cardstock/types';
import { Document } from '@cardstock/document';
import { createWorkerKernel } from '@cardstock/kernel';
import { KeyboardCameraInput, Viewer } from '@cardstock/viewer';
import { rebuild } from './wiring/model-bridge.js';
import './style.css';

const root = document.getElementById('root')!;
root.innerHTML = `
  <canvas id="stage" tabindex="0"></canvas>
  <div id="hud" class="panel"></div>
  <div id="filter" class="panel"></div>
  <div id="params" class="panel">
    <div class="row"><label for="width">width</label><input id="width" type="range" min="20" max="90" step="1" value="60"><output id="width-out">60</output></div>
    <div class="row"><label for="depth">depth</label><input id="depth" type="range" min="20" max="80" step="1" value="40"><output id="depth-out">40</output></div>
    <div class="row"><label for="height">height</label><input id="height" type="range" min="5" max="60" step="1" value="18"><output id="height-out">18</output></div>
    <div class="row"><label for="hole">hole ⌀</label><input id="hole" type="range" min="2" max="30" step="0.5" value="10"><output id="hole-out">10</output></div>
    <div id="stats"></div>
  </div>
  <div id="keys" class="panel">
    <kbd>←→↑↓</kbd> orbit · <kbd>shift</kbd>+arrows 15° · <kbd>ctrl</kbd>+arrows pan ·
    <kbd>+</kbd><kbd>−</kbd> zoom · <kbd>1</kbd>–<kbd>7</kbd> views ·
    <kbd>.</kbd> pivot · <kbd>F</kbd> fit · <kbd>tab</kbd> filter · <kbd>esc</kbd> clear
  </div>
`;

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const filterEl = document.getElementById('filter')!;
const stats = document.getElementById('stats')!;

const viewer = new Viewer(canvas);
new KeyboardCameraInput(viewer).attach();

canvas.addEventListener('pointermove', (e) => viewer.setPointer(e.clientX, e.clientY));
canvas.addEventListener('pointerleave', () => viewer.clearPointer());
canvas.addEventListener('pointerdown', (e) => {
  canvas.focus();
  if (e.button === 0) viewer.clickAt(e.clientX, e.clientY, e.shiftKey);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // Phase 5: radial menu
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  viewer.controller.target.zoom *= Math.exp(Math.sign(e.deltaY) * 0.12);
}, { passive: false });

new ResizeObserver(() => viewer.resize()).observe(canvas);
addEventListener('resize', () => viewer.resize());

// ---------------------------------------------------------------- the model
const kernel = createWorkerKernel();
const doc = new Document(kernel);

doc.setParameter({ name: 'width', expression: '60', unit: 'mm' });
doc.setParameter({ name: 'depth', expression: '40', unit: 'mm' });
doc.setParameter({ name: 'height', expression: '18', unit: 'mm' });
doc.setParameter({ name: 'holeDia', expression: '10', unit: 'mm' });

doc.addFeature({
  id: asFeatureId('plate'), type: 'box', name: 'Plate',
  values: { dx: 'width', dy: 'depth', dz: 'height' }, inputs: {},
});
doc.addFeature({
  id: asFeatureId('drill'), type: 'cylinder', name: 'Drill',
  values: {
    radius: 'holeDia / 2', height: 'height + 10',
    x: 'width / 2', y: 'depth / 2', z: '-5',
  },
  inputs: {},
});
doc.addFeature({
  id: asFeatureId('hole'), type: 'cut', name: 'Hole',
  values: {}, inputs: { base: asFeatureId('plate'), tool: asFeatureId('drill') },
});

// ---------------------------------------------------------------- rebuild loop
let generation = 0;
let firstBuild = true;

async function refresh(): Promise<void> {
  const mine = ++generation;
  const report = await rebuild(doc, kernel, viewer);
  if (mine !== generation) return; // a newer edit already superseded this one

  if (report.body) {
    if (firstBuild) { viewer.fitAll(); viewer.controller.settle(); firstBuild = false; }
    stats.innerHTML =
      `<span class="dim">rebuild</span> ${report.rebuildMs.toFixed(0)}ms ` +
      `<span class="dim">mesh</span> ${report.tessellateMs.toFixed(0)}ms<br>` +
      `<span class="dim">${report.body.faceCount} faces · ${report.body.edgeCount} edges · ` +
      `${report.body.indices.length / 3} tris</span>` +
      (report.result.reused.length
        ? `<br><span class="dim">${report.result.reused.length} cached</span>` : '');
  }
  if (report.errors.length) {
    stats.innerHTML += `<br><span class="err">${report.errors[0]}</span>`;
  }
  render();
}

// ---------------------------------------------------------------- parameter sliders
const bind = (id: string, parameter: string) => {
  const input = document.getElementById(id) as HTMLInputElement;
  const output = document.getElementById(`${id}-out`) as HTMLOutputElement;
  input.addEventListener('input', () => {
    output.textContent = input.value;
    // Coalesce: a whole drag collapses into one undo step.
    doc.setParameter(
      { name: parameter, expression: input.value, unit: 'mm' },
      { label: `Set ${parameter}`, coalesceKey: `param:${parameter}` },
    );
    void refresh();
  });
};
bind('width', 'width');
bind('depth', 'depth');
bind('height', 'height');
bind('hole', 'holeDia');

// ---------------------------------------------------------------- readout
function render(): void {
  const { hover, selected, filter } = viewer.selection;
  filterEl.innerHTML = `filter <b>${filter}</b> <span class="dim">tab to cycle</span>`;
  const pick = viewer.lastPick;
  hud.innerHTML = hover && pick
    ? `<b>${hover.kind} #${hover.index}</b><br>` +
      `<span class="dim">at</span> ${pick.point.x.toFixed(2)}, ${pick.point.y.toFixed(2)}, ${pick.point.z.toFixed(2)}` +
      (pick.normal
        ? `<br><span class="dim">normal</span> ${pick.normal.x.toFixed(2)}, ${pick.normal.y.toFixed(2)}, ${pick.normal.z.toFixed(2)}`
        : '') +
      (selected.length ? `<br><span class="sel">${selected.length} selected</span>` : '')
    : `<span class="dim">point at the model${selected.length ? ` · ${selected.length} selected` : ''}</span>`;
}
viewer.selection.subscribe(render);

// ---------------------------------------------------------------- go
viewer.start();
render();
stats.innerHTML = '<span class="dim">booting geometry kernel…</span>';
const bootMs = await kernel.whenReady();
console.log(`[cardstock] OCCT booted in ${bootMs}ms`);
await refresh();

Object.assign(globalThis, { __viewer: viewer, __doc: doc, __kernel: kernel, __refresh: refresh });
