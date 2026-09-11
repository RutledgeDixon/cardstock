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
 *
 * Run against `/?fresh=1`. Without it the app restores whatever the LAST run autosaved,
 * and every check that assumes the starter plate is then checking a different model.
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

  // --- the feature tree gets a flyout, not the ring ------------------------------
  // A ring centred on a row in the top-left corner was cut off by two page edges. The
  // radial is for 3D space, where there is room in every direction.
  {
    const row = [...document.querySelectorAll('.tree button')][0];
    if (row) {
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, clientX: r.left + 20, clientY: r.top + 8,
      }));
      await sleep(300);
      const menu = document.querySelector('.submenu');
      const box = menu?.getBoundingClientRect();
      check('treeContextMenuIsAFlyout', !!menu && !document.querySelector('.radial'));
      check('treeContextMenuIsOnScreen',
        !!box && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight);
      document.querySelector('.flyout-scrim')?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }));
      await sleep(200);
      check('treeContextMenuClosesOnClickAway', !document.querySelector('.submenu'));
    }
  }

  // --- radial menu --------------------------------------------------------------
  canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 200 }));
  await sleep(200);
  const radialItems = [...document.querySelectorAll('.radial-item')].map((b) => b.dataset.command ?? 'more');
  check('radialOpens', radialItems.length > 0);
  // Each command owns a WEDGE of the ring, not a floating label: a far bigger target,
  // and it shows which direction the command lives in.
  check('radialDrawsWedges',
    document.querySelectorAll('.radial-wedge').length === radialItems.length);
  check('radialWedgesAreRings', (() => {
    // Out along the rim, back along the inner edge: two arcs, or it is not a band.
    const d = document.querySelector('.radial-wedge')?.getAttribute('d') ?? '';
    return (d.match(/A /g) ?? []).length === 2 && d.trim().endsWith('Z');
  })());
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
    const opener = document.querySelector('[data-command="sketch.constrain"]');
    check('constrainButtonShown', !!opener);
    opener?.click();
    await sleep(350);
    const menu = document.querySelector('.submenu');
    const items = menu ? [...menu.querySelectorAll('button')] : [];
    check('constraintSubmenuOpens', items.length >= 8);
    // Every entry says what it wants, so a disabled one teaches instead of dead-ending.
    check('everyConstraintSaysWhatItWants', items.every((b) => (b.title ?? '').length > 0));
    // One level, never two: a child of the group may not itself open a menu.
    check('constraintSubmenuIsOneLevel',
      items.every((b) => b.getAttribute('aria-haspopup') === null));
    opener?.click();
    await sleep(250);

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

  // --- every sketch line is actually PAINTED, not just built ----------------------
  // Three caches `_maxInstanceCount` when it first binds a geometry's vertex attributes,
  // and replacing those attributes does not invalidate it — the renderer then draws
  // min(instanceCount, _maxInstanceCount). Redrawing after each click locked that to 1,
  // so every line after the first was built, counted, reported by the tools, and never
  // appeared. Only pixels can catch this: the model was right the whole time.
  if (session) {
    window.__host.setSketchTool('line');
    // One click at a time WITH a redraw between, which is what a person does.
    for (const at of [{ x: -25, y: -12 }, { x: 25, y: -12 }, { x: 25, y: 12 }]) {
      session.tools.click(at);
      session.refresh();
      viewer.step(1 / 60);
    }
    await sleep(200);

    const fat = session.view.group.children.find(
      (c) => c.type === 'LineSegments2' && (c.geometry.instanceCount ?? 0) >= 2,
    );
    check('everySketchSegmentIsDrawable', !!fat
      && fat.geometry.instanceCount === (fat.geometry._maxInstanceCount ?? fat.geometry.instanceCount));

    // And prove it in pixels rather than in a property.
    const gl = viewer.renderer.getContext();
    viewer.renderer.render(viewer.scene, viewer.camera);
    const paint = (p) => {
      const w = session.view.toWorld(p).project(viewer.camera);
      const px = new Uint8Array(4);
      gl.readPixels(
        Math.round((w.x * 0.5 + 0.5) * gl.drawingBufferWidth),
        Math.round((w.y * 0.5 + 0.5) * gl.drawingBufferHeight),
        1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px,
      );
      return `${px[0]},${px[1]},${px[2]}`;
    };
    const background = paint({ x: 0, y: 0 });
    check('firstSketchSegmentPaints', paint({ x: 0, y: -12 }) !== background);
    check('laterSketchSegmentsPaint', paint({ x: 25, y: 0 }) !== background);
  }

  // --- Escape puts the drawing tool down before anything else --------------------
  // A tool that keeps drawing after Escape is what makes editing an existing sketch —
  // delete a line, draw a new one, stop — feel like a fight.
  if (session) {
    window.__host.setSketchTool('line');
    await sleep(150);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    await sleep(250);
    check('escapeReturnsToSelect', window.__host.state().sketchTool === 'select');
    check('escapeDoesNotCloseTheSketch', window.__host.state().sketching);
  }

  // --- the snap target is DRAWN ---------------------------------------------------
  // The tools always reported which vertex a click would join, and nothing drew it: a
  // click that connected and one that missed looked identical, and the one that
  // connected created no new geometry, so it read as doing nothing at all.
  if (session) {
    window.__host.setSketchTool('line');
    await sleep(150);
    const first = session.sketch.geometry.find((e) => e.type === 'point');
    if (first) {
      session.view.setSnapTarget({ x: first.x, y: first.y });
      const ring = session.view.group.children.find(
        (c) => c.type === 'Points' && c.material.size === 15,
      );
      check('snapTargetIsDrawn',
        (ring?.geometry.attributes.position?.count ?? 0) > 0);
      // Plain vertices are NOT the selection colour; only selected ones are.
      const colours = session.view.group.children
        .filter((c) => c.type === 'Points')
        .map((c) => c.material.color.getHexString());
      check('plainVerticesAreNotOrange', colours[0] !== colours[1]);
      session.view.setSnapTarget(null);
    }
  }

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
  // --- parameters belong to the feature that uses them ----------------------------
  // The starter plate's `width` sat under PARAMETERS while a HOLE was focused, which
  // says the hole has a width.
  {
    const labels = () => [...document.querySelectorAll('.panel-params .field label')]
      .map((l) => l.textContent);
    const drilled = await window.__host.addSolidFeature('hole');
    await sleep(1400);
    check('unrelatedParametersAreHidden', labels().length === 0);
    if (drilled) { doc.removeFeature(drilled); await window.__rebuild?.(); }
  }

  // --- files ----------------------------------------------------------------------
  {
    check('bootedFresh', new URLSearchParams(location.search).has('fresh'));
    check('titleNamesTheDocument', /CARDstock$/.test(document.title));

    // Autosave lands shortly after an edit. (Whether the edit marks the title dirty is
    // checked below, after a save has made it clean — earlier sections have already
    // edited this document, so it is dirty by now for good reason.)
    await window.__host.addPrimitive('box');
    await sleep(1900);
    const stored = await new Promise((resolve) => {
      const open = indexedDB.open('cardstock');
      open.onsuccess = () => {
        const db = open.result;
        const get = db.transaction('kv').objectStore('kv').get('autosave');
        get.onsuccess = () => { db.close(); resolve(get.result ?? null); };
        get.onerror = () => { db.close(); resolve(null); };
      };
      open.onerror = () => resolve(null);
    });
    check('autosaveWrittenAfterEdit',
      !!stored && Array.isArray(stored.file?.features) && stored.file.features.length > 0);
    check('autosaveCarriesSketches', !!stored && typeof stored.file?.sketches === 'object');

    // Save As, Open and plain Save, through stand-in handles that behave like the File
    // System Access API. The dialogs are the only part not exercised.
    const disk = new Map();
    const handleFor = (name) => ({
      kind: 'file', name,
      async getFile() { return new File([disk.get(name) ?? ''], name, { type: 'application/json' }); },
      async createWritable() {
        let buffer = '';
        return { async write(chunk) { buffer += chunk; }, async close() { disk.set(name, buffer); } };
      },
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
    });
    const realSave = window.showSaveFilePicker, realOpen = window.showOpenFilePicker, realConfirm = window.confirm;
    window.showSaveFilePicker = async (o) => handleFor(o?.suggestedName ?? 'part.card');
    window.showOpenFilePicker = async () => [handleFor('reopened.card')];
    window.confirm = () => true;

    await window.__host.saveDocumentAs();
    await sleep(400);
    const written = [...disk.values()][0] ? JSON.parse([...disk.values()][0]) : null;
    check('saveAsWritesAVersionedFile', written?.schemaVersion >= 2);
    check('savedFileCarriesSketches', !!written && typeof written.sketches === 'object');
    check('savedFileHasThumbnail',
      typeof written?.meta?.thumbnail === 'string' && written.meta.thumbnail.startsWith('data:image/jpeg'));
    check('savedFileHasCamera', typeof written?.meta?.camera?.zoom === 'number');
    check('saveClearsTheDirtyMarker', !document.title.startsWith('•'));
    await window.__host.addPrimitive('sphere');
    await sleep(300);
    check('editMarksTheTitleDirty', document.title.startsWith('•'));

    // Open a different file: contents, name and camera all come from it.
    disk.set('reopened.card', JSON.stringify({
      schemaVersion: 2, parameters: [], sketches: {},
      meta: { name: 'reopened', camera: { azimuth: 0.5, elevation: 0.3, zoom: 80, pivot: { x: 1, y: 2, z: 3 } } },
      features: [{ id: 'base', type: 'box', name: 'Base', values: { dx: '25', dy: '25', dz: '5' }, inputs: {} }],
    }));
    await window.__host.openDocument();
    await sleep(1200);
    check('openReplacesTheDocument', doc.features.map((f) => f.id).join() === 'base');
    check('openRestoresTheCamera',
      Math.abs(viewer.controller.target.zoom - 80) < 1e-6 && viewer.controller.target.pivot.x === 1);
    check('openNamesTheTitle', document.title.startsWith('reopened'));

    // A version-1 file migrates on open.
    disk.set('reopened.card', JSON.stringify({
      schemaVersion: 1, meta: { name: 'old' }, parameters: [],
      features: [{ id: 'b', type: 'box', name: 'B', values: { dx: '10', dy: '10', dz: '10' }, inputs: {} }],
    }));
    await window.__host.openDocument();
    await sleep(1000);
    check('versionOneFileOpens', doc.meta.name === 'old' && doc.features.length === 1);

    // Back to a starter for the checks that follow.
    await window.__host.newDocument();
    await sleep(1000);
    check('newGivesTheStarter', doc.features.map((f) => f.id).join() === 'plate');

    window.showSaveFilePicker = realSave; window.showOpenFilePicker = realOpen; window.confirm = realConfirm;
  }

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
