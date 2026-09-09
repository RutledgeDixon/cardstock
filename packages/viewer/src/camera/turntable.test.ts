import { describe, expect, it } from 'vitest';
import { OrthographicCamera, Vector3 } from 'three';
import {
  ELEVATION_LIMIT,
  ISO_ELEVATION,
  NAMED_VIEWS,
  applyToCamera,
  clampElevation,
  fitBounds,
  makeTurntableState,
  normalizeAzimuth,
  orbitDirection,
  viewFacing,
} from './turntable.js';

/** Screen basis vectors, read off the camera's world matrix. */
function screenBasis(azimuth: number, elevation: number, aspect = 16 / 9) {
  const camera = new OrthographicCamera();
  const state = makeTurntableState({ azimuth, elevation, zoom: 50 });
  applyToCamera(state, camera, aspect, 500);
  return {
    right: new Vector3().setFromMatrixColumn(camera.matrixWorld, 0),
    up: new Vector3().setFromMatrixColumn(camera.matrixWorld, 1),
    toCamera: new Vector3().setFromMatrixColumn(camera.matrixWorld, 2),
    camera,
  };
}

describe('roll-free guarantee', () => {
  // This is the project's central navigation claim, per docs/adr/0002. If it ever
  // fails, the turntable has stopped being a turntable.
  it('keeps screen-right horizontal at every orientation', () => {
    let worst = 0;
    for (let ai = 0; ai < 72; ai++) {
      for (let ei = -20; ei <= 20; ei++) {
        const az = (ai / 72) * 2 * Math.PI - Math.PI;
        const el = clampElevation((ei / 20) * (Math.PI / 2));
        worst = Math.max(worst, Math.abs(screenBasis(az, el).right.z));
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('keeps screen-up in the plane containing +Z (no tilt about the view axis)', () => {
    for (const [, v] of Object.entries(NAMED_VIEWS)) {
      const { up, right } = screenBasis(v.azimuth, v.elevation);
      // up must have no component along screen-right — that component IS roll.
      expect(Math.abs(up.dot(right))).toBeLessThan(1e-9);
      expect(up.z).toBeGreaterThan(-1e-9); // never upside down
    }
  });
});

describe('elevation clamping', () => {
  it('clamps to just short of the poles', () => {
    expect(clampElevation(Math.PI)).toBeCloseTo(ELEVATION_LIMIT, 12);
    expect(clampElevation(-Math.PI)).toBeCloseTo(-ELEVATION_LIMIT, 12);
    expect(clampElevation(0.3)).toBe(0.3);
  });

  it('never reaches a degenerate lookAt', () => {
    const { toCamera } = screenBasis(0, clampElevation(99));
    expect(Math.abs(toCamera.z)).toBeLessThan(1); // not exactly parallel to up
    expect(Number.isFinite(toCamera.x)).toBe(true);
  });
});

describe('named views', () => {
  // The ADR-0002 regression test. Top view built with azimuth 0 renders X vertical,
  // which is wrong by CAD convention and was visibly wrong on screen.
  it('top view puts X to the right and Y up', () => {
    const { right, up } = screenBasis(NAMED_VIEWS.top.azimuth, NAMED_VIEWS.top.elevation);
    expect(right.x).toBeCloseTo(1, 6);
    expect(right.y).toBeCloseTo(0, 6);
    expect(up.x).toBeCloseTo(0, 6);
    expect(up.y).toBeCloseTo(1, 2); // el is a hair off vertical, so y is ~0.99995
  });

  it('bottom view also puts X to the right', () => {
    const { right } = screenBasis(NAMED_VIEWS.bottom.azimuth, NAMED_VIEWS.bottom.elevation);
    expect(right.x).toBeCloseTo(1, 6);
  });

  it('front view looks along +Y with Z up', () => {
    const dir = orbitDirection(NAMED_VIEWS.front.azimuth, NAMED_VIEWS.front.elevation);
    expect(dir.x).toBeCloseTo(0, 6);
    expect(dir.y).toBeCloseTo(-1, 6); // camera sits at -Y
    expect(dir.z).toBeCloseTo(0, 6);
    const { up } = screenBasis(NAMED_VIEWS.front.azimuth, NAMED_VIEWS.front.elevation);
    expect(up.z).toBeCloseTo(1, 6);
  });

  it('right view looks along -X', () => {
    const dir = orbitDirection(NAMED_VIEWS.right.azimuth, NAMED_VIEWS.right.elevation);
    expect(dir.x).toBeCloseTo(1, 6);
    expect(dir.y).toBeCloseTo(0, 6);
  });

  it('iso is a true isometric: equal contribution from all three axes', () => {
    const dir = orbitDirection(NAMED_VIEWS.iso.azimuth, NAMED_VIEWS.iso.elevation);
    expect(Math.abs(dir.x)).toBeCloseTo(Math.abs(dir.y), 6);
    expect(Math.abs(dir.y)).toBeCloseTo(Math.abs(dir.z), 6);
    expect(ISO_ELEVATION).toBeCloseTo(0.6154797, 6);
  });
});

describe('azimuth normalization', () => {
  it('wraps into (-PI, PI] so repeated orbiting cannot drift unbounded', () => {
    expect(normalizeAzimuth(0)).toBeCloseTo(0, 12);
    expect(normalizeAzimuth(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(normalizeAzimuth(-3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(normalizeAzimuth(2 * Math.PI + 0.5)).toBeCloseTo(0.5, 12);
    for (let k = -10; k <= 10; k++) {
      const a = normalizeAzimuth(0.37 + k * 2 * Math.PI);
      expect(a).toBeCloseTo(0.37, 10);
    }
  });
});

describe('viewFacing (the "look at this face" command)', () => {
  it('puts the camera on the side the normal points', () => {
    const v = viewFacing(new Vector3(1, 0, 0)); // face pointing +X
    const dir = orbitDirection(v.azimuth, v.elevation);
    expect(dir.x).toBeCloseTo(1, 6); // camera ends up on the +X side
    expect(dir.z).toBeCloseTo(0, 6);
  });

  it('looks straight down at a top face, and up at a bottom face', () => {
    expect(viewFacing(new Vector3(0, 0, 1)).elevation).toBeCloseTo(ELEVATION_LIMIT, 12);
    expect(viewFacing(new Vector3(0, 0, -1)).elevation).toBeCloseTo(-ELEVATION_LIMIT, 12);
  });

  it('pins azimuth at the poles rather than leaving it arbitrary', () => {
    // The ADR-0002 trap: a +/-Z face normal leaves screen orientation undetermined.
    for (const n of [new Vector3(0, 0, 1), new Vector3(0, 0, -1)]) {
      const v = viewFacing(n);
      expect(v.azimuth).toBeCloseTo(-Math.PI / 2, 12);
      const { right } = screenBasis(v.azimuth, v.elevation);
      expect(right.x).toBeCloseTo(1, 6); // X still to the right
    }
  });

  it('is stable for a nearly-vertical normal', () => {
    const v = viewFacing(new Vector3(1e-9, 0, 1));
    expect(Number.isFinite(v.azimuth)).toBe(true);
    expect(Math.abs(v.elevation)).toBeLessThanOrEqual(ELEVATION_LIMIT);
  });
});

describe('fitBounds', () => {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 30, z: 20 } };

  it('centres the pivot on the model', () => {
    const { pivot } = fitBounds(bounds, 16 / 9);
    expect(pivot.x).toBeCloseTo(20, 6);
    expect(pivot.y).toBeCloseTo(15, 6);
    expect(pivot.z).toBeCloseTo(10, 6);
  });

  it('frames the bounding sphere so no orientation clips', () => {
    const radius = Math.hypot(40, 30, 20) / 2;
    const { zoom } = fitBounds(bounds, 16 / 9);
    expect(zoom).toBeGreaterThanOrEqual(radius);
  });

  it('zooms out further for a narrow viewport', () => {
    const wide = fitBounds(bounds, 2).zoom;
    const narrow = fitBounds(bounds, 0.5).zoom;
    expect(narrow).toBeGreaterThan(wide);
  });

  it('survives a degenerate aspect ratio', () => {
    // Panes report 0x0 while hidden (ADR-0002), so aspect can be NaN.
    for (const a of [0, NaN, Infinity, -1]) {
      const { zoom } = fitBounds(bounds, a);
      expect(Number.isFinite(zoom)).toBe(true);
      expect(zoom).toBeGreaterThan(0);
    }
  });

  it('survives zero-size bounds', () => {
    const degenerate = { min: { x: 5, y: 5, z: 5 }, max: { x: 5, y: 5, z: 5 } };
    const { zoom } = fitBounds(degenerate, 1);
    expect(zoom).toBeGreaterThan(0);
  });
});
