import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { CameraController, shortestAngleDelta } from './controller.js';
import { ELEVATION_LIMIT, NAMED_VIEWS } from './turntable.js';

const stepFor = (c: CameraController, seconds: number, dt = 1 / 60) => {
  for (let i = 0; i < Math.round(seconds / dt); i++) c.advance(dt);
};

describe('shortestAngleDelta', () => {
  it('takes the short way around the seam', () => {
    // Orbiting past PI must not spin the model 350 degrees backwards.
    expect(shortestAngleDelta(3.1, -3.1)).toBeCloseTo(0.0831853, 5);
    expect(shortestAngleDelta(-3.1, 3.1)).toBeCloseTo(-0.0831853, 5);
    expect(shortestAngleDelta(0, 0.5)).toBeCloseTo(0.5, 10);
  });
});

describe('easing', () => {
  it('settles on the target without overshooting', () => {
    const c = new CameraController({ azimuth: 0, elevation: 0 });
    c.setView('back'); // azimuth +PI/2
    let maxAzimuth = -Infinity;
    for (let i = 0; i < 600; i++) {
      c.advance(1 / 60);
      maxAzimuth = Math.max(maxAzimuth, c.current.azimuth);
    }
    expect(c.current.azimuth).toBeCloseTo(NAMED_VIEWS.back.azimuth, 5);
    // Critically damped: never goes past the target.
    expect(maxAzimuth).toBeLessThanOrEqual(NAMED_VIEWS.back.azimuth + 1e-9);
    expect(c.isSettled()).toBe(true);
  });

  it('crosses the +/-PI seam the short way', () => {
    const c = new CameraController({ azimuth: 3.0, elevation: 0 });
    c.target.azimuth = -3.0; // 0.283 rad away across the seam
    const visited: number[] = [];
    for (let i = 0; i < 240; i++) { c.advance(1 / 60); visited.push(c.current.azimuth); }
    expect(c.current.azimuth).toBeCloseTo(-3.0, 4);
    // Going the long way would pass through 0; going the short way never does.
    expect(visited.every((a) => Math.abs(a) > 2.9)).toBe(true);
  });

  it('does not teleport after a long frame gap', () => {
    // Tab away and back: dt could be many seconds. Clamped, so the view still eases.
    const c = new CameraController({ azimuth: 0, elevation: 0 });
    c.setView('back');
    c.advance(30);
    expect(c.current.azimuth).toBeLessThan(NAMED_VIEWS.back.azimuth);
  });

  it('is stable at dt = 0', () => {
    const c = new CameraController({ azimuth: 0.4, elevation: 0.2 });
    c.setView('top');
    c.advance(0);
    expect(c.current.azimuth).toBeCloseTo(0.4, 12);
    expect(Number.isFinite(c.current.zoom)).toBe(true);
  });
});

describe('continuous orbit input', () => {
  it('orbits while held and stops when released', () => {
    const c = new CameraController({ azimuth: 0, elevation: 0 });
    c.orbitInput.azimuth = 1;
    stepFor(c, 1);
    const moved = c.current.azimuth;
    expect(moved).toBeGreaterThan(0.5); // ~2.2 rad/s target, current lags behind
    c.orbitInput.azimuth = 0;
    stepFor(c, 2);
    expect(c.current.azimuth).toBeCloseTo(c.target.azimuth, 4); // catches up, then holds
  });

  it('cannot orbit past the elevation limit no matter how long it is held', () => {
    const c = new CameraController({ azimuth: 0, elevation: 0 });
    c.orbitInput.elevation = 1;
    stepFor(c, 20);
    expect(c.current.elevation).toBeLessThanOrEqual(ELEVATION_LIMIT + 1e-9);
    expect(c.target.elevation).toBeCloseTo(ELEVATION_LIMIT, 9);
  });

  it('keeps azimuth bounded under sustained orbiting', () => {
    const c = new CameraController({ azimuth: 0, elevation: 0 });
    c.orbitInput.azimuth = 1;
    stepFor(c, 60); // a full minute of holding the key
    expect(Math.abs(c.current.azimuth)).toBeLessThanOrEqual(Math.PI + 1e-9);
    expect(Math.abs(c.target.azimuth)).toBeLessThanOrEqual(Math.PI + 1e-9);
  });
});

describe('snap orbit', () => {
  it('steps in exact 15 degree increments', () => {
    const c = new CameraController({ azimuth: 0, elevation: 0 });
    for (let i = 0; i < 6; i++) c.snapOrbit(1, 0);
    expect(c.target.azimuth).toBeCloseTo(Math.PI / 2, 10); // 6 x 15 = 90 degrees
    c.settle();
    expect(c.current.azimuth).toBeCloseTo(Math.PI / 2, 10);
  });

  it('clamps elevation when snapping into a pole', () => {
    const c = new CameraController({ azimuth: 0, elevation: 0 });
    for (let i = 0; i < 20; i++) c.snapOrbit(0, 1);
    expect(c.target.elevation).toBeCloseTo(ELEVATION_LIMIT, 12);
  });
});

describe('zoom', () => {
  it('zooms in while held and never reaches zero', () => {
    const c = new CameraController({ zoom: 50 });
    c.zoomInput = 1;
    stepFor(c, 3);
    expect(c.target.zoom).toBeLessThan(50);
    expect(c.target.zoom).toBeGreaterThan(0);
  });

  it('is symmetric: equal in and out returns to the start', () => {
    const c = new CameraController({ zoom: 50 });
    c.zoomInput = 1; stepFor(c, 2);
    c.zoomInput = -1; stepFor(c, 2);
    expect(c.target.zoom).toBeCloseTo(50, 6);
  });
});

describe('pan', () => {
  it('moves the pivot in the screen plane, never along the view axis', () => {
    const c = new CameraController({ azimuth: 0.7, elevation: 0.4, zoom: 40 });
    c.settle();
    const before = c.target.pivot.clone();
    const { right, up } = c.screenBasis();
    const viewAxis = right.clone().cross(up).normalize();
    c.panInput.x = 1;
    stepFor(c, 0.5);
    const delta = c.target.pivot.clone().sub(before);
    expect(delta.length()).toBeGreaterThan(0);
    expect(Math.abs(delta.dot(viewAxis))).toBeLessThan(1e-9);
  });

  it('scales with zoom so it feels constant on screen', () => {
    const near = new CameraController({ zoom: 10 });
    const far = new CameraController({ zoom: 100 });
    for (const c of [near, far]) { c.settle(); c.panInput.x = 1; stepFor(c, 0.5); }
    const ratio = far.target.pivot.length() / near.target.pivot.length();
    expect(ratio).toBeGreaterThan(5); // roughly the 10x zoom ratio
  });
});

describe('pivot and fit', () => {
  it('re-centres the orbit on a picked point', () => {
    const c = new CameraController();
    c.setPivot(new Vector3(10, 20, 30));
    c.settle();
    expect(c.current.pivot.toArray()).toEqual([10, 20, 30]);
  });

  it('frames bounds', () => {
    const c = new CameraController();
    c.fit({ min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 30, z: 20 } }, 16 / 9);
    c.settle();
    expect(c.current.pivot.x).toBeCloseTo(20, 6);
    expect(c.current.zoom).toBeGreaterThan(0);
  });
});

describe('faceView', () => {
  it('looks at a top face without leaving the screen orientation arbitrary', () => {
    const c = new CameraController();
    c.faceView(new Vector3(0, 0, 1));
    c.settle();
    expect(c.current.elevation).toBeCloseTo(ELEVATION_LIMIT, 9);
    expect(c.current.azimuth).toBeCloseTo(-Math.PI / 2, 9);
  });
});
