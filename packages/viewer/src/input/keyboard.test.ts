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
let fitCalls: number;
let pivotCalls: number;

beforeEach(() => {
  target = new EventTarget();
  controller = new CameraController({ azimuth: 0, elevation: 0, zoom: 50 });
  selection = new SelectionManager();
  fitCalls = 0;
  pivotCalls = 0;
  const viewer = {
    controller,
    selection,
    canvas: { ownerDocument: target },
    fitAll: () => { fitCalls++; },
    pivotToPointer: () => { pivotCalls++; return true; },
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

describe('ctrl+arrow pans', () => {
  // Regression: Control is deliberately not in the HANDLED set (we must never
  // preventDefault it), so tracking it as a held key silently never fired and pan
  // did nothing. Modifier state must come from the event.
  it('moves the pivot instead of orbiting', () => {
    const azBefore = controller.target.azimuth;
    down('ControlLeft', { ctrlKey: true });
    down('ArrowRight', { ctrlKey: true });
    step(0.5);
    expect(controller.target.pivot.length()).toBeGreaterThan(0);
    expect(controller.target.azimuth).toBeCloseTo(azBefore, 9);
  });

  it('pans only in the screen plane', () => {
    down('ControlLeft', { ctrlKey: true });
    down('ArrowUp', { ctrlKey: true });
    step(0.5);
    const { right, up: screenUp } = controller.screenBasis();
    const viewAxis = new Vector3().crossVectors(right, screenUp).normalize();
    expect(Math.abs(controller.target.pivot.dot(viewAxis))).toBeLessThan(1e-9);
  });

  it('returns to orbiting once ctrl is released', () => {
    down('ControlLeft', { ctrlKey: true });
    down('ArrowRight', { ctrlKey: true });
    step(0.2);
    up('ControlLeft', { ctrlKey: false });
    const pivotAfterPan = controller.target.pivot.clone();
    const azBefore = controller.target.azimuth;
    step(0.5);
    expect(controller.target.azimuth).toBeGreaterThan(azBefore);
    expect(controller.target.pivot.distanceTo(pivotAfterPan)).toBeLessThan(1e-9);
  });
});

describe('named views and commands', () => {
  it('maps number keys to views', () => {
    down('Digit1');
    expect(controller.target.azimuth).toBeCloseTo(-Math.PI / 2, 9);
    down('Digit5');
    expect(controller.target.elevation).toBeGreaterThan(1.5);
  });

  it('leaves non-navigation keys alone for the command system', () => {
    // Fit, pivot, filter and clear are Commands. Binding them here too would give one
    // key two owners, and whichever ran first would win by accident.
    selection.click({ bodyId: 'b' as never, kind: 'face', index: 1 });
    down('KeyF');
    down('Period');
    down('Tab');
    down('Escape');
    expect(fitCalls).toBe(0);
    expect(pivotCalls).toBe(0);
    expect(selection.filter).toBe('face');
    expect(selection.selected).toHaveLength(1);
  });
});

describe('focus safety', () => {
  it('ignores keys typed into a text field', () => {
    const azBefore = controller.target.azimuth;
    target.dispatchEvent(new FakeKeyEvent('keydown', {
      code: 'ArrowRight',
      target: { tagName: 'INPUT', isContentEditable: false },
    }));
    step(0.5);
    expect(controller.target.azimuth).toBeCloseTo(azBefore, 9);
  });

  it('stops orbiting when detached mid-hold', () => {
    // Otherwise a key held as the viewer unmounts orbits forever.
    down('ArrowRight');
    input.detach();
    const frozen = controller.target.azimuth;
    step(1);
    expect(controller.target.azimuth).toBeCloseTo(frozen, 9);
  });
});
