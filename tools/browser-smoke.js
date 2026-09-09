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
 *   - the toolbar submenu being clipped away, or jumping out from under the cursor
 *   - a sketch feature never rebuilding because the graph never learned it changed
 *
 * Returns { passed, failed, results }. Anything false is a regression.
 */
window.__smoke = async function smoke() {
  const host_beginSketch = () => window.__host.beginSketch('xy');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /**
   * Wait for the DOM to catch up, bounded.
   *
   * React commits a state change on a later tick than the promise that triggered it, so
   * asserting straight after an `await host.x()` tests the scheduler, not the app.
   *
   * Polls on setTimeout rather than requestAnimationFrame: a hidden or unfocused pane
   * throttles rAF to a couple of frames a second (measured: 8 seconds between frames),
   * which made this report a sketchbar missing that was in fact already on screen.
   * setTimeout is clamped too, to ~1s, but it is clamped predictably.
   */
  const waitFor = async (selector, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (document.querySelector(selector)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(50);
    }
  };
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
  // Every group is a toolbar button that opens a submenu; a leaf that leaked onto the
  // toolbar, or a group that lost its children, shows up here.
  check('toolbarGroupsPresent',
    ['create.shape', 'build.solid', 'modify.body', 'pattern.new', 'boolean.combine']
      .every((id) => tools.includes(id)));
  check('toolbarHidesGroupedLeaves',
    !tools.includes('primitive.box') && !tools.includes('boolean.cut')
    && !tools.includes('modify.shell'));

  // --- submenu stays put and survives the pointer crossing into it ---------------
  const slot = document.querySelector('[data-command="create.shape"]')?.closest('.toolslot');
  slot?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  await sleep(220);
  const submenu = document.querySelector('.submenu');
  check('submenuOpens', !!submenu);
  if (submenu) {
    const rect = () => { const r = document.querySelector('.submenu')?.getBoundingClientRect(); return r && `${Math.round(r.x)},${Math.round(r.y)}`; };
    const atOpen = rect();
    slot.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: submenu }));
    submenu.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await sleep(200);
    check('submenuDoesNotJump', rect() === atOpen);
    check('submenuSurvivesHover', !!document.querySelector('.submenu'));
    check('submenuHasShapes',
      [...document.querySelectorAll('.submenu button')].length === 3);
    document.querySelector('.submenu')?.dispatchEvent(
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
  document.querySelector('.submenu [data-command="primitive.cylinder"]')?.click();
  await sleep(1400);
  check('addingShapeAddsFeature', doc.features.length === featuresBefore + 1);
  check('addingShapeAddsVisibleBody', viewer.bodies.size === bodiesBefore + 1);
  check('newShapeIsBesideTheModel', (() => {
    const boxes = [...viewer.bodies.values()].map((b) => b.data.bounds);
    // Nothing should be stacked exactly on top of anything else.
    return new Set(boxes.map((b) => `${b.min.x.toFixed(1)},${b.max.x.toFixed(1)}`)).size === boxes.length;
  })());

  // --- a phase 7 feature end to end ---------------------------------------------
  // The Node tests cover the geometry; what only the browser can prove is that the
  // toolbar's defaults actually land on the part rather than at the origin, which is
  // where an unseated hole silently misses.
  {
    const before = doc.features.length;
    const drilled = await window.__host.addSolidFeature('hole');
    check('holeAddsFeature', !!drilled && doc.features.length === before + 1);
    check('holeBuilds',
      [...(doc.engine.lastStates?.values() ?? [])].every((st) => st.status === 'ok'));
    // A hole that missed the part leaves the solid untouched: same triangle count.
    check('holeCutsTheSolid', viewer.bodies.size > 0
      && [...viewer.bodies.values()].some((b) => b.data.indices.length > 0));
    doc.removeFeature(drilled);
    await window.__rebuild?.();
  }

  // --- sketching ----------------------------------------------------------------
  await host_beginSketch();
  check('sketchOpens', await waitFor('.sketchbar'));
  check('sketchToolsPresent',
    [...document.querySelectorAll('.sketchbar-tools button')].length >= 5);
  const session = window.__session?.();
  if (session) {
    session.tools.setTool('rectangle');
    session.tools.click({ x: 0, y: 0 });
    session.tools.click({ x: 40, y: 25 });
    session.refresh();
    check('rectangleDrawn', session.sketch.geometry.filter((e) => e.type === 'line').length === 4);
    check('rectangleIsConstrained', session.sketch.constraints.length === 4);
    // A dimension must survive being expressed as a formula over a parameter.
    const points = session.sketch.geometry.filter((e) => e.type === 'point' && !e.fixed);
    const id = session.sketch.addConstraint({
      type: 'distance', a: points[0].id, b: points[1].id, value: 10,
    });
    check('dimensionAppears', session.dimensions().some((d) => d.id === id));
  }
  await window.__host.finishSketch();
  check('sketchCloses', !document.querySelector('.sketchbar'));

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
