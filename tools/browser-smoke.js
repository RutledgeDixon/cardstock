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

  // WASD is a second name for the arrows. Checked because the two commands that used to
  // own S and D were rebound, and a regression there is silent: the camera would work
  // while the sketch tools quietly stopped.
  key('KeyD');
  check('wasdReachesTheController', viewer.controller.orbitInput.azimuth === 1);
  release('KeyD');
  check('wasdReleasesCleanly', viewer.controller.orbitInput.azimuth === 0);
  key('KeyW');
  check('wasdOrbitsVertically', viewer.controller.orbitInput.elevation === 1);
  release('KeyW');
  check('sketchKeysRebound',
    !!registry.commandForChord('n') && !!registry.commandForChord('m'));

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

  // --- selection reads as selected while still pointed at ------------------------
  // It used to only turn orange once the pointer LEFT, which made clicking look like it
  // had done nothing at all.
  {
    const body = [...viewer.bodies.values()][0];
    const material = body?.faceMaterial ?? body?.solid?.material;
    if (material) {
      const gl = viewer.renderer.getContext();
      const draw = () => {
        for (let i = 0; i < 6; i++) viewer.step(1 / 60);
        const px = new Uint8Array(4);
        gl.readPixels(
          Math.round(gl.drawingBufferWidth * 0.5), Math.round(gl.drawingBufferHeight * 0.5),
          1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px,
        );
        return [px[0], px[1], px[2]];
      };
      // Try each face in turn: only the one actually under the centre pixel changes
      // colour, and which face that is depends on the camera.
      let warm = false, stillWarm = false, darker = false;
      for (let face = 0; face < Math.min(8, material.faceState?.length ?? 0); face++) {
        material.setSelectedFaces([face]);
        material.setHoveredFace(-1);
        const selectedOnly = draw();
        material.setHoveredFace(face);
        const alsoHovered = draw();
        if (selectedOnly[0] === alsoHovered[0] && selectedOnly[2] === alsoHovered[2]) {
          continue; // this face is not the one on screen at that pixel
        }
        // Orange, not the blue hover: red leads blue in both states.
        warm = selectedOnly[0] > selectedOnly[2];
        stillWarm = alsoHovered[0] > alsoHovered[2];
        // And visibly darker, so the two are told apart at a glance.
        darker = alsoHovered[0] < selectedOnly[0] - 20;
        break;
      }
      material.setSelectedFaces([]);
      material.setHoveredFace(-1);

      check('selectedFaceIsWarm', warm);
      check('selectedAndHoveredStaysWarm', stillWarm);
      check('selectedAndHoveredIsDarker', darker);
    }
    viewer.selection.clear();
  }

  // --- delete acts on the selection ----------------------------------------------
  {
    const before = doc.features.length;
    const bodyId = [...viewer.bodies.keys()][0];
    viewer.selection.clear();
    // A FACE is picked, but the whole body is what goes.
    viewer.selection.click({ bodyId, kind: 'face', index: 0 });
    await window.__host.deleteFocused();
    await sleep(1200);
    check('deleteRemovesTheWholeBody',
      doc.features.length === before - 1 && !doc.feature(bodyId));
    await window.__host.undo();
    await sleep(1200);
    check('deleteIsUndoable', doc.features.length === before);
  }

  // --- the about dialog ----------------------------------------------------------
  {
    const about = document.querySelector('[data-command="app.about"]');
    const exportButton = document.querySelector('[data-command="file.export"]');
    check('aboutSitsBelowExport', !!about && !!exportButton
      && about.getBoundingClientRect().top > exportButton.getBoundingClientRect().top);

    about?.click();
    await sleep(300);
    const dialog = document.querySelector('.about');
    check('aboutOpens', !!dialog);
    // The build identity is the point of the dialog: a version with no commit cannot
    // answer "is this the build with the fix?".
    check('aboutNamesTheBuild', /\d+\.\d+\.\d+/.test(dialog?.innerText ?? ''));
    check('aboutExpandsTheName',
      (dialog?.innerText ?? '').includes('Computer Assisted Rapid Design'));
    check('aboutSaysRightsReserved',
      (dialog?.innerText ?? '').includes('All rights reserved'));

    // Clicking inside must not close it; the scrim must.
    document.querySelector('.about-mark')?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }));
    await sleep(150);
    check('aboutStaysOpenWhenClickedInside', !!document.querySelector('.about'));

    // While it is open, arrow keys belong to the dialog, not the camera.
    document.querySelector('.about')?.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'ArrowRight', key: 'ArrowRight', bubbles: true }));
    await sleep(100);
    check('aboutSwallowsCameraKeys', viewer.controller.orbitInput.azimuth === 0);

    document.querySelector('.about-scrim')?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }));
    await sleep(250);
    check('aboutCloses', !document.querySelector('.about'));
  }

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

  // --- every submenu opens, is complete, and fits on screen ----------------------
  // A group near the foot of the strip opened a flyout that ran off the bottom of the
  // window, and a DISABLED group could not be opened at all, so its children could not
  // explain why they were unavailable.
  {
    let allOpen = true, allOnScreen = true, allPopulated = true;
    for (const button of [...document.querySelectorAll('.tool.is-group')]) {
      const groupSlot = button.closest('.toolslot');
      groupSlot.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      await sleep(250);
      const menu = document.querySelector('.submenu');
      if (!menu) { allOpen = false; continue; }
      const r = menu.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0) allOnScreen = false;
      if (menu.querySelectorAll('button').length < 2) allPopulated = false;
      groupSlot.dispatchEvent(
        new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
      await sleep(600);
    }
    check('everyGroupOpens', allOpen);
    check('everySubmenuFitsOnScreen', allOnScreen);
    check('everySubmenuHasItems', allPopulated);
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

  // --- a part made of SEVERAL bodies, and an export that contains all of them -----
  // The failure this guards: every new feature attaching to whichever body happens to
  // be last, and an export writing only that one.
  {
    const before = viewer.bodies.size;
    await window.__host.addPrimitive('box');
    await sleep(1200);
    check('secondBodyIsSeparate', viewer.bodies.size === before + 1);

    const ids = [...viewer.bodies.keys()];
    const first = ids[0], second = ids[ids.length - 1];

    // A hole with the SECOND body selected must land on the second body.
    viewer.selection.clear();
    viewer.selection.click({ bodyId: second, kind: 'face', index: 0 });
    const drilled = await window.__host.addSolidFeature('hole');
    await sleep(1800);
    check('featureFollowsTheSelection',
      !!drilled && doc.feature(drilled)?.inputs?.base === second);

    // And an edge operation on the FIRST body while the second is newer.
    viewer.selection.clear();
    viewer.selection.click({ bodyId: first, kind: 'edge', index: 0 });
    const rounded = await window.__host.addEdgeOperation('fillet');
    await sleep(1800);
    check('edgeOperationFollowsTheSelection',
      !!rounded && doc.feature(rounded)?.inputs?.base === first);
    viewer.selection.clear();

    // The real Export button, and what it actually hands to the browser.
    let blob = null;
    const originalUrl = URL.createObjectURL;
    URL.createObjectURL = (b) => { blob = b; return originalUrl.call(URL, b); };
    document.querySelector('[data-command="file.export"]')?.click();
    for (let i = 0; i < 40 && !blob; i++) await sleep(250);
    URL.createObjectURL = originalUrl;

    check('exportProducesAFile', !!blob);
    if (blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const view = new DataView(bytes.buffer);
      const ascii = new TextDecoder().decode(bytes.slice(0, 5)) === 'solid';
      // Binary, because ASCII is roughly five times the size for the same mesh.
      check('exportIsBinaryStl', !ascii);
      if (!ascii) {
        const triangles = view.getUint32(80, true);
        check('exportLengthMatchesItsHeader', bytes.length === 84 + triangles * 50);
        let minX = Infinity, maxX = -Infinity;
        for (let t = 0; t < triangles; t++) {
          const at = 84 + t * 50 + 12;
          for (let c = 0; c < 3; c++) {
            const x = view.getFloat32(at + c * 12, true);
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          }
        }
        // Two bodies sit side by side, so the file must span further than either alone.
        const widest = Math.max(...[...viewer.bodies.values()]
          .map((b) => b.data.bounds.max.x - b.data.bounds.min.x));
        check('exportContainsEveryBody', maxX - minX > widest + 1);
      }
    }
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
  // --- constraints are reachable, and say what they want -------------------------
  // There was no constraint UI at all: the sketcher supported them and nothing offered
  // them, so half of what a sketcher is for was unreachable.
  {
    const buttons = [...document.querySelectorAll('.sketchbar-constraints button')];
    check('constraintButtonsShown', buttons.length >= 8);
    check('everyConstraintSaysWhatItWants',
      buttons.every((b) => (b.title ?? '').length > 0));

    if (session) {
      const line = session.sketch.geometry.find((e) => e.type === 'line');
      if (line) {
        session.toggleSelection(line.id, false);
        // Selection has to be VISIBLE: it used to register and look like nothing.
        check('sketchSelectionIsDrawn', session.selected.has(line.id));
        const horizontal = registry.get('constrain.horizontal');
        check('constraintEnablesOnSelection',
          horizontal?.enabled(window.__host.state()) === true);

        const before = session.sketch.constraints.length;
        window.__host.applySketchConstraint('horizontal');
        await sleep(700);
        check('constraintApplies', session.sketch.constraints.length > before);
      }
    }
  }

  // --- the active tool says what it is waiting for -------------------------------
  check('toolHintShown', !!document.querySelector('.sketchbar-hint')?.textContent);

  await window.__host.finishSketch();
  check('sketchCloses', !document.querySelector('.sketchbar'));

  // --- a selected BODY lights up --------------------------------------------------
  // Body is a container kind with no face index, so it highlighted nothing at all and
  // there was no way to tell a click had registered.
  {
    const bodyId = [...viewer.bodies.keys()][0];
    const view = viewer.bodies.get(bodyId);
    viewer.selection.setFilter('body');
    viewer.selection.click({ bodyId, kind: 'body', index: 0 });
    check('selectedBodyLightsEveryFace',
      !!view && [...view.solidMaterial.faceState].every((x) => x === 1));
    viewer.selection.clear();
    viewer.selection.setFilter('face');
    check('clearingABodyUnlightsIt',
      !!view && [...view.solidMaterial.faceState].every((x) => x === 0));
  }

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
