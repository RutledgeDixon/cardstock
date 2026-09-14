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

    // The real Export button opens the dialog; the live count must arrive, and the
    // Export button in it must write a file. The save picker is stood in for, as the
    // file tests do: a dialog cannot be driven from here.
    let written = null;
    const realSavePicker = window.showSaveFilePicker;
    window.showSaveFilePicker = async (o) => ({
      kind: 'file', name: o?.suggestedName ?? 'part.stl',
      async createWritable() {
        return { async write(chunk) { written = new Uint8Array(chunk); }, async close() {} };
      },
    });
    document.querySelector('[data-command="file.export"]')?.click();
    check('exportOpensADialog', await waitFor('.export'));
    let statsText = '';
    for (let i = 0; i < 40; i++) {
      statsText = document.querySelector('.export-stats')?.textContent ?? '';
      if (/\d+ triangles/.test(statsText)) break;
      await sleep(250);
    }
    check('exportCountsTrianglesLive', /\d+ triangles/.test(statsText));
    check('exportReportsWatertight', /(^|\s)watertight/.test(statsText) && !/NOT/.test(statsText));
    document.querySelector('.export-go')?.click();
    for (let i = 0; i < 40 && !written; i++) await sleep(250);
    window.showSaveFilePicker = realSavePicker;
    if (document.querySelector('.export')) {
      document.querySelector('.export')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    const blob = written ? new Blob([written]) : null;

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
    // Four of the sketch's own; the origin axes come in as external construction lines.
    check('rectangleDrawn', session.sketch.geometry.filter((e) => e.type === 'line' && !e.external).length === 4);
    check('rectangleIsConstrained', session.sketch.constraints.length === 4);
    // A dimension must survive being expressed as a formula over a parameter.
    const points = session.sketch.geometry.filter((e) => e.type === 'point' && !e.fixed);
    const id = session.sketch.addConstraint({
      type: 'distance', a: points[0].id, b: points[1].id, value: 10,
    });
    check('dimensionAppears', session.dimensions().some((d) => d.id === id));
  }
  // --- constraints are a tool, and a ring ---------------------------------------
  // The Constrain button is a sketch tool: click geometry and a ring offers exactly the
  // constraints that apply to it. Nothing applying is said, not left as a missing ring.
  {
    const opener = document.querySelector('[data-command="sketch.constrain"]');
    check('constrainButtonShown', !!opener);
    opener?.click();
    await sleep(250);
    check('constrainIsATool', window.__host.state().sketchTool === 'constrain');

    if (session) {
      const line = session.sketch.geometry.find((e) => e.type === 'line' && !e.external);
      const P = (id) => session.sketch.entity(id);
      const mid = { x: (P(line.p1).x + P(line.p2).x) / 2, y: (P(line.p1).y + P(line.p2).y) / 2 };
      const v = session.view.toWorld(mid).project(viewer.camera);
      const r = viewer.canvas.getBoundingClientRect();
      const at = { clientX: r.left + ((v.x + 1) / 2) * r.width, clientY: r.top + ((1 - v.y) / 2) * r.height };
      viewer.canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 0, pointerId: 1, bubbles: true }));
      viewer.canvas.dispatchEvent(new PointerEvent('pointerup', { ...at, button: 0, pointerId: 1, bubbles: true }));
      await sleep(300);
      check('constrainClickSelects', session.selected.has(line.id));
      // A left click only gathers; the ring waits for the right button.
      check('leftClickDoesNotOpenRing', !document.querySelector('.radial-ring'));
      viewer.canvas.dispatchEvent(new MouseEvent('contextmenu', { ...at, button: 2, bubbles: true }));
      await sleep(300);
      const ring = document.querySelector('.radial-ring');
      check('constraintRingOpens', !!ring);
      const wedges = ring ? [...ring.querySelectorAll('[data-command]')] : [];
      const ids = wedges.map((w) => w.getAttribute('data-command'));
      // Only what applies to one line: horizontal and vertical, never coincident.
      check('ringShowsOnlyApplicable', ids.includes('constrain.horizontal') && !ids.includes('constrain.coincident'));
      // One line cannot be dimensioned; two points can, and the ring then offers it.
      check('ringHidesDimensionForOneLine', !ids.includes('constrain.dimension'));
      const before = session.sketch.constraints.length;
      // An SVG group has no click(): dispatch the event.
      wedges.find((w) => w.getAttribute('data-command') === 'constrain.vertical')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(700);
      check('ringAppliesConstraint', session.sketch.constraints.length === before + 1);
      check('ringClosesAfterApplying', !document.querySelector('.radial-ring'));
      check('selectionClearedAfterApplying', session.selected.size === 0);
      // Escape puts the tool down.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await sleep(200);
      check('escapeLeavesConstrainTool', window.__host.state().sketchTool === 'select');

      // Two points gathered by left clicks, then Dimension from the ring.
      document.querySelector('[data-command="sketch.constrain"]')?.click();
      await sleep(150);
      const pts = session.sketch.geometry.filter((e) => e.type === 'point' && !e.external && !e.fixed).slice(0, 2);
      for (const p of pts) {
        const pv = session.view.toWorld({ x: p.x, y: p.y }).project(viewer.camera);
        const pat = { clientX: r.left + ((pv.x + 1) / 2) * r.width, clientY: r.top + ((1 - pv.y) / 2) * r.height };
        viewer.canvas.dispatchEvent(new PointerEvent('pointerdown', { ...pat, button: 0, pointerId: 1, bubbles: true }));
        viewer.canvas.dispatchEvent(new PointerEvent('pointerup', { ...pat, button: 0, pointerId: 1, bubbles: true }));
        await sleep(150);
      }
      check('leftClicksGatherWithoutShift', session.selected.size === 2);
      viewer.canvas.dispatchEvent(new MouseEvent('contextmenu', { ...at, button: 2, bubbles: true }));
      await sleep(300);
      const dimWedge = document.querySelector('.radial-ring [data-command="constrain.dimension"]');
      check('ringOffersDimensionForTwoPoints', !!dimWedge);
      const dimsBefore = session.dimensions().length;
      dimWedge?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(700);
      check('ringPlacesADimension', session.dimensions().length === dimsBefore + 1);
      document.querySelector('.dimension input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await sleep(200);
    }
  }

  // --- the active tool says what it is waiting for -------------------------------
  check('toolHintInTooltip', !!document.querySelector('.sketchbar-tools button')?.title);

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
    const first = session.sketch.geometry.find((e) => e.type === 'point' && !e.external);
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

  // --- print-aware suite -----------------------------------------------------------
  // A mushroom: a plate on a narrower stem below it, so the plate's underside
  // overhangs. Overhang shading must paint it, the bed contact must read green, the
  // orientation scorer must want it upside down, and an applied orientation must
  // rotate the exported file and nothing else.
  {
    await window.__host.newDocument();
    await sleep(600);
    const plate = doc.features[0].id;
    doc.addFeature({ id: doc.newFeatureId('box'), type: 'box', name: 'Stem',
      values: { dx: '10', dy: '10', dz: '30', x: '25', y: '15', z: '-30' }, inputs: {} });
    const stem = doc.features.at(-1).id;
    doc.addFeature({ id: doc.newFeatureId('union'), type: 'union', name: 'Union', values: {},
      inputs: { base: plate, tool: stem } });
    await window.__rebuild();
    await sleep(1200);
    check('estimatesInStatusBar', /cm³ · \d+ g · [\d.]+ m solid/.test(
      document.querySelector('.status-right')?.textContent ?? ''));

    await registry.get('print.overhang').run();
    check('overhangToggleIsActive',
      registry.childrenOf('print.menu', window.__host.state()).find((c) => c.command.id === 'print.overhang')?.active === true);
    // Look from below, where the overhanging underside and the first layer are.
    viewer.clearPointer();
    viewer.controller.target.elevation = -0.5;
    viewer.controller.settle();
    window.__step(30);
    const readback = () => {
      viewer.renderer.render(viewer.scene, viewer.camera);
      const gl = viewer.renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let warm = 0, green = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        if (r > 60 && r > g * 1.8 && r > b * 1.8) warm++;
        if (g > 50 && g > r * 1.5 && g > b * 1.4) green++;
      }
      return { warm, green };
    };
    const shaded = readback();
    check('overhangIsPainted', shaded.warm > 500);
    check('firstLayerIsGreen', shaded.green > 50);
    await registry.get('print.overhang').run();
    const plain = readback();
    check('overhangShadingSwitchesOff', plain.warm < shaded.warm / 10);

    await registry.get('print.thickness').run();
    check('thicknessIsMeasured', Math.abs((viewer.minThickness() ?? 0) - 10) < 0.05);
    await registry.get('print.thickness').run();

    await registry.get('print.volume').run();
    const box = viewer.scene.children.find((c) => c.name === 'build-volume');
    check('buildVolumeDrawn', !!box && box.visible);
    doc.setParameter({ name: 'width', expression: '300', unit: 'mm' });
    await window.__rebuild();
    await sleep(1000);
    check('tooBigForBedWarns', /Does not fit/.test(document.querySelector('.status-print')?.textContent ?? ''));
    check('buildVolumeGoesRed', box.material.color.getHexString() === 'e0483a');
    doc.setParameter({ name: 'width', expression: '60', unit: 'mm' });
    await window.__rebuild();
    await sleep(1000);
    check('fitsAgain', !document.querySelector('.status-print'));
    await registry.get('print.volume').run();

    await registry.get('print.orient').run();
    for (let i = 0; i < 40 && !document.querySelector('.orient-table'); i++) await sleep(150);
    const firstRow = document.querySelector('.orient-table tbody tr');
    check('orientationPrefersPlateDown', /upside down/.test(firstRow?.textContent ?? ''));
    firstRow?.querySelector('button')?.click();
    await sleep(100);
    check('orientationApplies', !!document.querySelector('.orient-table tr.is-applied'));
    document.querySelector('.orient .export-actions button')?.click();

    let oriented = null;
    const realSavePicker = window.showSaveFilePicker;
    window.showSaveFilePicker = async (o) => ({
      kind: 'file', name: o?.suggestedName ?? 'part.stl',
      async createWritable() {
        return { async write(chunk) { oriented = new Uint8Array(chunk); }, async close() {} };
      },
    });
    document.querySelector('[data-command="file.export"]')?.click();
    await waitFor('.export');
    check('exportShowsOrientation', /Oriented/.test(document.querySelector('.export')?.textContent ?? ''));
    document.querySelector('.export-go')?.click();
    for (let i = 0; i < 40 && !oriented; i++) await sleep(200);
    window.showSaveFilePicker = realSavePicker;
    if (oriented) {
      const view = new DataView(oriented.buffer);
      const n = view.getUint32(80, true);
      let zmin = Infinity;
      for (let t = 0; t < n; t++) for (let c = 0; c < 3; c++) {
        zmin = Math.min(zmin, view.getFloat32(84 + t * 50 + 12 + c * 12 + 8, true));
      }
      // Flipped: the 18 mm plate is now the bottom, so the lowest point is −18, not −30.
      check('exportIsRotated', Math.abs(zmin + 18) < 0.01);
    } else {
      check('exportIsRotated', false);
    }
    // The model itself is untouched by the orientation.
    check('modelNotRotated', Math.abs(viewer.bounds().min.z + 30) < 0.01);

    // The printer's nozzle is an expression name; changing the printer rebuilds.
    // Set through the real dialog, so the check does not depend on what a previous
    // run left stored.
    const setNozzle = async (value) => {
      await registry.get('print.printer').run();
      await sleep(150);
      const field = document.querySelector('#printer-Nozzle');
      if (!field) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(50);
      document.querySelector('.printer .export-go')?.click();
      await sleep(1200);
      return true;
    };
    check('printerDialogOpens', await setNozzle('0.4'));
    doc.setParameter({ name: 'width', expression: 'nozzle * 100', unit: 'mm' });
    await window.__rebuild();
    await sleep(800);
    check('nozzleIsAnExpressionName', Math.abs(doc.parameters.value('width') - 40) < 1e-9);
    await setNozzle('0.6');
    check('printerChangeRebuilds', Math.abs(doc.parameters.value('width') - 60) < 1e-9);
    await setNozzle('0.4');
    viewer.controller.target.elevation = 0.6;
    viewer.controller.settle();
  }

  // --- sketch fixes from the second test round ---------------------------------
  {
    // Two triangles sharing a corner extrude to two solids, not one.
    await window.__host.newDocument();
    await sleep(500);
    await window.__host.beginSketch('xy');
    await sleep(300);
    const bow = window.__session();
    bow.tools.setTool('line');
    for (const p of [[0, 0], [-20, 10], [-20, -10], [0, 0]]) bow.tools.click({ x: p[0], y: p[1] });
    bow.tools.setTool('line');
    for (const p of [[0, 0], [20, 10], [20, -10], [0, 0]]) bow.tools.click({ x: p[0], y: p[1] });
    bow.refresh();
    await window.__host.finishSketch();
    await sleep(400);
    await window.__host.addSolidFeature('extrude');
    await sleep(1500);
    const bowState = doc.engine.lastStates.get(doc.features.at(-1).id);
    const bowVolume = bowState?.handle ? (await window.__kernel.massProperties(bowState.handle)).volume : 0;
    check('bowTieExtrudesBothTriangles', Math.abs(bowVolume - 4000) < 1e-3);

    // A vertex pressed with the select tool is selected (orange), not only dragged.
    await window.__host.beginSketch('xy');
    await sleep(300);
    const sk = window.__session();
    sk.tools.setTool('rectangle');
    sk.tools.click({ x: 0, y: 0 });
    sk.tools.click({ x: 40, y: 25 });
    sk.refresh();
    window.__host.setSketchTool('select');
    await sleep(100);
    // The corner a sketch line joins to the origin, so its dimension sits on the line.
    const corner = sk.sketch.geometry.find((e) => e.type === 'point' && Math.abs(e.x - 40) < 1e-6 && Math.abs(e.y) < 1e-6);
    const screen = (p) => {
      const v = sk.view.toWorld({ x: p.x, y: p.y }).project(viewer.camera);
      const r = viewer.canvas.getBoundingClientRect();
      return { clientX: r.left + ((v.x + 1) / 2) * r.width, clientY: r.top + ((1 - v.y) / 2) * r.height };
    };
    const press = async (p) => {
      viewer.canvas.dispatchEvent(new PointerEvent('pointerdown', { ...screen(p), button: 0, pointerId: 1, bubbles: true }));
      await sleep(30);
      viewer.canvas.dispatchEvent(new PointerEvent('pointerup', { ...screen(p), button: 0, pointerId: 1, bubbles: true }));
      await sleep(200);
    };
    await press(corner);
    check('vertexPressSelectsIt', sk.selected.size === 1 && sk.selected.has(corner.id));
    const orange = sk.view.group.children.find((c) => c.type === 'Points' && c.material.color.getHexString() === 'ff9e38');
    check('selectedVertexDrawnOrange', (orange?.geometry.attributes.position?.count ?? 0) === 1);

    // The sketch bar's right-hand side: DOF, then Constrain, then Finish.
    const barClasses = [...document.querySelector('.sketchbar').children].map((c) => c.className.split(' ')[0]);
    const at = (name) => barClasses.indexOf(name);
    check('sketchBarOrder', at('sketchbar-tools') < at('sketchbar-dof')
      && at('sketchbar-dof') < at('sketchbar-constraints')
      && at('sketchbar-constraints') < at('sketchbar-finish')
      && at('sketchbar-finish') === barClasses.length - 1);
    check('noInlineToolHint', !document.querySelector('.sketchbar-hint'));

    // A placed dimension is a reference until typed into; then it drives.
    window.__host.setSketchTool('dimension');
    await sleep(100);
    const origin = sk.sketch.geometry.find((e) => e.type === 'point' && e.x === 0 && e.y === 0);
    const dofBefore = sk.sketch.dof;
    await press(origin);
    await press(corner);
    await sleep(400);
    const placedDim = sk.sketch.constraints.find((c) => c.type === 'distance');
    check('dimensionStartsAsReference', placedDim?.reference === true && sk.sketch.dof === dofBefore);
    check('referenceDimensionLooksLikeOne', !!document.querySelector('.dimension.is-reference'));
    const dimInput = document.querySelector('.dimension input');
    if (dimInput) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(dimInput, '60');
      dimInput.dispatchEvent(new Event('input', { bubbles: true }));
      dimInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(1000);
    }
    check('typedDimensionDrives', sk.sketch.constraint(placedDim.id)?.reference !== true && sk.sketch.dof === dofBefore - 1);
    check('drivingDimensionIsGreen', !!document.querySelector('.dimension.is-driving'));
    // A dimension that is not along a sketch line gets drawn lines; one that is, does not.
    const blueLines = () => sk.view.group.children
      .filter((c) => c.material?.color?.getHexString?.() === '2b4f9e')
      .reduce((n, c) => n + (c.geometry.attributes.instanceStart?.count ?? 0), 0);
    check('dimensionAlongALineHasNoExtraLines', blueLines() === 0);
    // The corner diagonal from the origin: no sketch line joins them.
    const joinedToOrigin = new Set(sk.sketch.geometry
      .filter((e) => e.type === 'line' && (e.p1 === origin.id || e.p2 === origin.id))
      .flatMap((l) => [l.p1, l.p2]));
    const far = sk.sketch.geometry.find((e) => e.type === 'point' && !e.external && e.id !== origin.id && !joinedToOrigin.has(e.id));
    await press(origin);
    await press(far);
    await sleep(300);
    document.querySelector('.dimension input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(200);
    check('diagonalDimensionDrawsExtensionAndArrows', blueLines() >= 7);
    await window.__host.finishSketch();
    await sleep(300);

    // The sketch's panel lists its constraints and can remove one.
    const sketchRowNow = [...document.querySelectorAll('.tree-row')].find((r) => /Sketch 2/.test(r.textContent));
    sketchRowNow?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    await sleep(300);
    const listed = document.querySelectorAll('.constraint').length;
    check('sketchPanelListsConstraints', listed > 0 && listed === sk.sketch.constraints.length);
    document.querySelector('.constraint .constraint-remove')?.click();
    await sleep(600);
    check('sketchPanelRemovesAConstraint', sk.sketch.constraints.length === listed - 1);

    // IJKL pans; Ctrl+arrow is no longer the camera's.
    const pivot0 = viewer.controller.target.pivot.clone();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', key: 'l', bubbles: true }));
    window.__step(20);
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyL', key: 'l', bubbles: true }));
    check('ijklPans', viewer.controller.target.pivot.distanceTo(pivot0) > 1);
    const az0 = viewer.controller.target.azimuth;
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', key: 'ArrowRight', ctrlKey: true, bubbles: true }));
    window.__step(10);
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowRight', key: 'ArrowRight', ctrlKey: true, bubbles: true }));
    check('ctrlArrowLeavesCameraAlone', Math.abs(viewer.controller.target.azimuth - az0) < 1e-9);

    // Clicking a feature in the tree highlights the body it lives in.
    viewer.selection.clear();
    const sketchRow = [...document.querySelectorAll('.tree-row')].find((r) => /Sketch 1/.test(r.textContent));
    sketchRow?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    await sleep(200);
    check('treeClickHighlightsBody', viewer.selection.selected.some((r) => r.kind === 'body'));
    viewer.selection.clear();
  }

  // --- deleting, dragging as a whole, and the constraint list -------------------
  {
    await window.__host.newDocument();
    await sleep(500);
    await window.__host.beginSketch('xy');
    await sleep(300);
    const sk = window.__session();
    sk.tools.setTool('rectangle');
    sk.tools.click({ x: 10, y: 10 });
    sk.tools.click({ x: 50, y: 30 });
    sk.refresh();
    const P = (id) => sk.sketch.entity(id);
    const own = sk.sketch.geometry.filter((e) => e.type === 'point' && !e.fixed && !e.external);
    const bottom = sk.sketch.geometry.find((e) => e.type === 'line' && !e.external && P(e.p1).y === P(e.p2).y && P(e.p1).y === 10);
    const right = sk.sketch.geometry.find((e) => e.type === 'line' && !e.external && P(e.p1).x === P(e.p2).x && P(e.p1).x === 50);
    sk.sketch.addConstraint({ type: 'distance', a: bottom.p1, b: bottom.p2, value: 40 });
    sk.sketch.addConstraint({ type: 'distance', a: right.p1, b: right.p2, value: 20 });
    doc.markSketchChanged(sk.featureId);
    await window.__rebuild();
    await sleep(600);
    check('freeRectangleHasTwoDof', sk.sketch.dof === 2);

    // Dragging a corner of a shape constrained in itself moves the whole shape.
    window.__host.setSketchTool('select');
    const at = (p) => {
      const v = sk.view.toWorld(p).project(viewer.camera);
      const r = viewer.canvas.getBoundingClientRect();
      return { clientX: r.left + ((v.x + 1) / 2) * r.width, clientY: r.top + ((1 - v.y) / 2) * r.height };
    };
    const corner = own[0];
    const start = at(corner), end = at({ x: corner.x + 15, y: corner.y + 8 });
    viewer.canvas.dispatchEvent(new PointerEvent('pointerdown', { ...start, button: 0, pointerId: 1, bubbles: true }));
    await sleep(40);
    for (let i = 1; i <= 4; i++) {
      viewer.canvas.dispatchEvent(new PointerEvent('pointermove', {
        clientX: start.clientX + ((end.clientX - start.clientX) * i) / 4,
        clientY: start.clientY + ((end.clientY - start.clientY) * i) / 4,
        pointerId: 1, bubbles: true, buttons: 1,
      }));
      await sleep(80);
    }
    viewer.canvas.dispatchEvent(new PointerEvent('pointerup', { ...end, button: 0, pointerId: 1, bubbles: true }));
    await sleep(400);
    check('untiedShapeDragsAsAWhole', own.every((p) => {
      const q = P(p.id);
      return Math.abs(q.x - p.x - 15) < 0.05 && Math.abs(q.y - p.y - 8) < 0.05;
    }));

    // A constraint row picked in the panel is what Delete removes.
    const before = sk.sketch.constraints.length;
    document.querySelector('.constraint')?.click();
    await sleep(150);
    check('constraintRowSelects', !!document.querySelector('.constraint.is-selected'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true }));
    await sleep(700);
    check('deleteKeyRemovesPickedConstraint', sk.sketch.constraints.length === before - 1);

    // Deleting a vertex takes its lines and their constraints; DOF never goes negative.
    sk.toggleSelection(own[0].id, false);
    await registry.get('feature.delete').run();
    await sleep(800);
    const dangling = sk.sketch.geometry.filter((e) => e.type === 'line' && (!sk.sketch.entity(e.p1) || !sk.sketch.entity(e.p2)));
    check('deletingAVertexTakesItsLines', dangling.length === 0);
    check('dofNeverNegative', (sk.sketch.dof ?? 0) >= 0 && !/-\d/.test(document.querySelector('.sketchbar-dof')?.textContent ?? ''));

    // An endpoint cannot be constrained onto its own line.
    const line = sk.sketch.geometry.find((e) => e.type === 'line' && !e.external);
    sk.toggleSelection(line.p1, false);
    sk.toggleSelection(line.id, true);
    check('endpointOnOwnLineRefused', /already an end/.test(window.__host.sketchConstraintBlocker('pointOnLine') ?? ''));
    await window.__host.finishSketch();
    await sleep(300);
  }

  check('paletteFindsEveryCommand',
    registry.search('', registry.all()[0] && {
      selectionKind: null, selectionCount: 0, hoverKind: null, hasModel: true,
      featureCount: 1, bodyCount: 1, canUndo: true, canRedo: false, busy: false,
      focusedFeature: null, sketching: false, sketchTool: null,
      sketchSelectionCount: 0, analysis: 'none', buildVolume: false,
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
