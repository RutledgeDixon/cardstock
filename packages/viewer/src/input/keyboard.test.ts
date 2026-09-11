import { beforeEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { CameraController } from '../camera/controller.js';
import { SelectionManager } from '../picking/selection.js';
import { KeyboardCameraInput } from './keyboard.js';
import type { Viewer } from '../scene/viewer.js';

/** Minimal key event that satisfies EventTarget without pulling in a DOM. */
class FakeKeyEvent extends Event {
  code = '';
  shiftKey = false;
  ctrlKey = false;
  target: unknown = null;
  preventDefault(): void {}
  constructor(type: string, init: Partial<FakeKeyEvent> = {}) {
    super(type);
    Object.assign(this, init);
  }
}

let target: EventTarget;
let controller: CameraController;
let selection: SelectionManager;
let input: KeyboardCameraInput;

beforeEach(() => {
  target = new EventTarget();
  controller = new CameraController({ azimuth: 0, elevation: 0, zoom: 50 });
  selection = new SelectionManager();
  const viewer = {
    controller,
    selection,
    canvas: { ownerDocument: target },
    fitAll: () => {},
    pivotToPointer: () => true,
  } as unknown as Viewer;
  input = new KeyboardCameraInput(viewer, { target });
  input.attach();
});

const down = (code: string, init: Partial<FakeKeyEvent> = {}) =>
  target.dispatchEvent(new FakeKeyEvent('keydown', { code, ...init }));
const up = (code: string, init: Partial<FakeKeyEvent> = {}) =>
  target.dispatchEvent(new FakeKeyEvent('keyup', { code, ...init }));
const step = (seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) controller.advance(1 / 60);
};

describe('orbit', () => {
  it('orbits while an arrow is held and stops on release', () => {
    down('ArrowRight');
    step(0.5);
    expect(controller.target.azimuth).toBeGreaterThan(0.5);
    up('ArrowRight');
    const frozen = controller.target.azimuth;
    step(1);
    expect(controller.target.azimuth).toBeCloseTo(frozen, 9);
  });

  it('snaps 15 degrees on shift+arrow without starting a continuous orbit', () => {
    down('ArrowRight', { shiftKey: true });
    expect(controller.target.azimuth).toBeCloseTo(Math.PI / 12, 9);
    const after = controller.target.azimuth;
    step(1);
    expect(controller.target.azimuth).toBeCloseTo(after, 9); // did not keep going
  });
});

describe('IJKL pans', () => {
  // Not Ctrl+arrows: Ctrl+W and Ctrl+S belong to the browser and to Save, and a
  // modifier that sometimes closes the tab is not one you can hold down.
  it('moves the pivot instead of orbiting', () => {
    const azBefore = controller.target.azimuth;
    down('KeyL');
    step(0.5);
    expect(controller.target.pivot.length()).toBeGreaterThan(0);
    expect(controller.target.azimuth).toBeCloseTo(azBefore, 9);
  });

  it('pans only in the screen plane', () => {
    down('KeyI');
    step(0.5);
    const { right, up: screenUp } = controller.screenBasis();
    const viewAxis = new Vector3().crossVectors(right, screenUp).normalize();
    expect(Math.abs(controller.target.pivot.dot(viewAxis))).toBeLessThan(1e-9);
  });

  it('stops on release and reads all four keys', () => {
    down('KeyJ');
    expect(controller.panInput.x).toBe(-1);
    up('KeyJ');
    expect(controller.panInput.x).toBe(0);
    down('KeyK');
    expect(controller.panInput.y).toBe(-1);
    up('KeyK');
    expect(controller.panInput.y).toBe(0);
  });

  it('leaves chords alone: ctrl+arrow is not the camera\'s', () => {
    down('ArrowRight', { ctrlKey: true });
    expect(controller.orbitInput.azimuth).toBe(0);
    expect(controller.panInput.x).toBe(0);
  });
});

describe('WASD', () => {
  /**
   * A second name for the arrow keys, aliased at the door.
   *
   * Asserted for every branch rather than just orbit, because the aliasing is only worth
   * anything if shift-snapping and release read WASD too — which is the
   * whole reason it is done once at the top rather than added to each set below.
   */
  it('orbits exactly as the arrow keys do', () => {
    down('KeyD');
    expect(controller.orbitInput.azimuth).toBe(1);
    up('KeyD');
    expect(controller.orbitInput.azimuth).toBe(0);

    down('KeyA');
    expect(controller.orbitInput.azimuth).toBe(-1);
    up('KeyA');

    down('KeyW');
    expect(controller.orbitInput.elevation).toBe(1);
    up('KeyW');

    down('KeyS');
    expect(controller.orbitInput.elevation).toBe(-1);
    up('KeyS');
    expect(controller.orbitInput.elevation).toBe(0);
  });

  it('snaps with shift, like the arrows', () => {
    down('KeyA', { shiftKey: true });
    expect(controller.target.azimuth).toBeCloseTo(-Math.PI / 12, 9);
    // A snap is discrete: it must not leave the key held and orbiting.
    expect(controller.orbitInput.azimuth).toBe(0);
  });

  it('mixes with the arrows without sticking', () => {
    // W and ArrowUp spell ONE held key, so releasing either has to cancel the press —
    // otherwise the camera orbits forever with nothing held down.
    down('KeyW');
    up('ArrowUp');
    expect(controller.orbitInput.elevation).toBe(0);
  });
});
