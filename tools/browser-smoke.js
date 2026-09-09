/**
 * Browser smoke test.
 *
 * Paste into the dev console (or run through the browser tooling) against a freshly
 * loaded app. Every check here corresponds to something that has actually broken during
 * development, which is the only reason any of them are worth running:
 *
 *   - the render loop dying so nothing drew at all (StrictMode double-invoke)
 *   - a second shape being invisible (one body id reused for every tessellation)
 *   - camera keys going dead (keyboard not re-attached on effect re-run)
 *   - the radial menu flooding with irrelevant commands
 *   - the toolbar flyout being clipped away, or jumping out from under the cursor
 *   - a sketch feature never rebuilding because the graph never learned it changed
 *
 * Returns { passed, failed, results }. Anything false is a regression.
 */
window.__smoke = async function smoke() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = {};
  const check = (name, value) => { results[name] = value; return value; };

  const viewer = window.__viewer;
  const doc = window.__doc;
  const registry = window.__registry;
  const canvas = document.getElementById('stage');
  if (!viewer || !doc || !registry) return { passed: 0, failed: 1, results: { booted: false } };

  // --- the render loop is actually running -------------------------------------
  // Stepping manually would hide a dead loop, which is exactly how this got missed.
  // Bounded, because an unfocused pane can throttle requestAnimationFrame so hard that
  // waiting on it never returns — which would hang the whole check rather than fail it.
  const framesBefore = viewer.renderer.info.render.frame;
  await Promise.race([
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    sleep(2000),
  ]);
  check('renderLoopRunning', viewer.renderer.info.render.frame > framesBefore);
  results.__note_frameRate = document.hasFocus()
    ? 'pane focused'
    : 'pane unfocused: rAF is throttled, so frame-timed checks are unreliable here';

  // --- something is on screen ---------------------------------------------------
  check('hasBody', viewer.bodies.size > 0);
  check('bodyHasTriangles', [...viewer.bodies.values()].every((b) => b.data.indices.length > 0));
  check('allFeaturesBuilt',
    [...(doc.engine.lastStates?.values() ?? [])].every((s) => s.status === 'ok'));

  // --- camera keys --------------------------------------------------------------
  const key = (code, init = {}) => {
    const event = { code, key: init.key ?? code, bubbles: true, ...init };
    document.dispatchEvent(new KeyboardEvent('keydown', event));
    window.dispatchEvent(new KeyboardEvent('keydown', event));
  };
  const release = (code) => document.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));

  // Held keys are checked in two halves rather than by waiting for frames: an
  // unfocused browser pane throttles requestAnimationFrame to a few frames a second,
  // so a wall-clock wait measures the pane's focus state, not the app.
  key('ArrowRight');
  check('arrowKeyReachesController', viewer.controller.orbitInput.azimuth === 1);
  const azimuthBefore = viewer.controller.target.azimuth;
  viewer.controller.advance(0.25);
  check('orbitAdvancesTheCamera', viewer.controller.target.azimuth !== azimuthBefore);
  release('ArrowRight');
  check('releasingStopsTheOrbit', viewer.controller.orbitInput.azimuth === 0);

  key('Digit1');
  check('numberKeysSnapToViews',
    Math.abs(viewer.controller.target.azimuth + Math.PI / 2) < 1e-6);

  viewer.controller.target.zoom = 3;
  key('KeyF', { key: 'f' });
  check('fFitsToScreen', viewer.controller.target.zoom > 10);

  const zoomBefore = viewer.controller.target.zoom;
  key('Equal', { key: '=' });
  viewer.controller.advance(0.25);
  check('plusZooms', viewer.controller.target.zoom < zoomBefore);
  release('Equal');

  // --- toolbar ------------------------------------------------------------------
  const tools = [...document.querySelectorAll('.tool')].map((b) => b.dataset.command);
  check('toolbarPopulated', tools.length >= 8);
  check('toolbarHasSketchAndExport',
    tools.includes('sketch.new') && tools.includes('file.export'));

  // --- flyout stays put and survives the pointer crossing into it ---------------
  const slot = document.querySelector('[data-command="create.shape"]')?.closest('.toolslot');
  slot?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  await sleep(220);
  const flyout = document.querySelector('.flyout');
  check('flyoutOpens', !!flyout);
  if (flyout) {
    const rect = () => { const r = document.querySelector('.flyout')?.getBoundingClientRect(); return r && `${Math.round(r.x)},${Math.round(r.y)}`; };
    const atOpen = rect();
    slot.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: flyout }));
    flyout.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await sleep(200);
    check('flyoutDoesNotJump', rect() === atOpen);
    check('flyoutSurvivesHover', !!document.querySelector('.flyout'));
    check('flyoutHasShapes',
      [...document.querySelectorAll('.flyout button')].length === 3);
    document.querySelector('.flyout')?.dispatchEvent(
      new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    await sleep(600);
  }

  // --- radial menu --------------------------------------------------------------
  canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 200 }));
  await sleep(200);
  const radialItems = [...document.querySelectorAll('.radial-item')].map((b) => b.dataset.command ?? 'more');
  check('radialOpens', radialItems.length > 0);
  // It flooded once with Export STL and the palette; a context menu has to stay short.
  check('radialIsShort', radialItems.length <= 8);
  document.querySelector('.radial-scrim')?.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true }));
  await sleep(150);
  check('radialCloses', !document.querySelector('.radial'));

  // --- adding a shape puts a NEW body on screen ---------------------------------
  const bodiesBefore = viewer.bodies.size;
  const featuresBefore = doc.features.length;
  document.querySelector('[data-command="create.shape"]')?.closest('.toolslot')
    ?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  await sleep(220);
  document.querySelector('.flyout [data-command="primitive.cylinder"]')?.click();
  await sleep(1400);
  check('addingShapeAddsFeature', doc.features.length === featuresBefore + 1);
  check('addingShapeAddsVisibleBody', viewer.bodies.size === bodiesBefore + 1);
  check('newShapeIsBesideTheModel', (() => {
    const boxes = [...viewer.bodies.values()].map((b) => b.data.bounds);
    // Nothing should be stacked exactly on top of anything else.
    return new Set(boxes.map((b) => `${b.min.x.toFixed(1)},${b.max.x.toFixed(1)}`)).size === boxes.length;
  })());

  // --- palette ------------------------------------------------------------------
  check('paletteFindsEveryCommand',
    registry.search('', registry.all()[0] && {
      selectionKind: null, selectionCount: 0, hoverKind: null, hasModel: true,
      featureCount: 1, bodyCount: 1, canUndo: true, canRedo: false, busy: false,
      focusedFeature: null, sketching: false, sketchTool: null,
    }).length === registry.size);

  const failed = Object.entries(results)
    .filter(([name]) => !name.startsWith('__'))
    .filter(([, ok]) => !ok);
  return {
    passed: Object.entries(results)
      .filter(([name]) => !name.startsWith('__')).filter(([, ok]) => ok).length,
    failed: failed.length,
    failures: failed.map(([name]) => name),
    results,
  };
};
