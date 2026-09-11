import type { Viewer } from '../scene/viewer.js';
import type { NamedView } from '../camera/turntable.js';

/**
 * Binds keys to the viewer.
 *
 * Deliberately thin: it only translates key events into calls the controller and viewer
 * already expose. Phase 5's command system will drive the same entry points directly, so
 * keyboard navigation and menu commands stay one behaviour rather than two.
 */

export const VIEW_KEYS: Record<string, NamedView> = {
  Digit1: 'front',
  Digit2: 'back',
  Digit3: 'left',
  Digit4: 'right',
  Digit5: 'top',
  Digit6: 'bottom',
  Digit7: 'iso',
  Digit0: 'iso',
};

const ORBIT_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
/**
 * IJKL pans. Not Ctrl+arrows: Ctrl+W and Ctrl+S belong to the browser and to Save,
 * and a modifier that sometimes closes the tab is not a modifier you can hold down.
 */
const PAN_KEYS = new Set(['KeyI', 'KeyJ', 'KeyK', 'KeyL']);

/**
 * WASD, as a second name for the arrow keys.
 *
 * Aliased at the door rather than added to every set and branch below, so the two spell
 * one behaviour: shift-snapping, ctrl-panning and held-key release all work identically
 * without knowing WASD exists. The commands that used to hold S and D were rebound.
 */
const KEY_ALIASES: Record<string, string> = {
  KeyW: 'ArrowUp',
  KeyA: 'ArrowLeft',
  KeyS: 'ArrowDown',
  KeyD: 'ArrowRight',
};

/** The code this adapter acts on: WASD reads as its arrow. */
const codeOf = (e: KeyboardEvent): string => KEY_ALIASES[e.code] ?? e.code;
/**
 * Keys this adapter owns.
 *
 * Deliberately only NAVIGATION: orbit, pan, zoom and named views. Everything else — fit,
 * pivot, selection filter, clearing — is a Command, so there is exactly one place a key
 * is bound and the two systems cannot fight over one. Phase 5.
 */
const HANDLED = new Set([...ORBIT_KEYS, ...PAN_KEYS, 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract',
  ...Object.keys(VIEW_KEYS)]);

export interface KeyboardOptions {
  /** Where to listen. Defaults to the viewer canvas' owner document. */
  target?: EventTarget;
}

export class KeyboardCameraInput {
  #held = new Set<string>();
  #target: EventTarget;
  #bound = false;

  constructor(private readonly viewer: Viewer, opts: KeyboardOptions = {}) {
    this.#target = opts.target ?? viewer.canvas.ownerDocument ?? globalThis;
  }

  attach(): () => void {
    if (this.#bound) return () => this.detach();
    this.#target.addEventListener('keydown', this.#onKeyDown as EventListener);
    this.#target.addEventListener('keyup', this.#onKeyUp as EventListener);
    globalThis.addEventListener?.('blur', this.#onBlur);
    this.#bound = true;
    return () => this.detach();
  }

  detach(): void {
    this.#target.removeEventListener('keydown', this.#onKeyDown as EventListener);
    this.#target.removeEventListener('keyup', this.#onKeyUp as EventListener);
    globalThis.removeEventListener?.('blur', this.#onBlur);
    this.#held.clear();
    this.#applyHeld();
    this.#bound = false;
  }

  /** Releasing focus must clear held keys, or the model orbits forever. */
  #onBlur = (): void => {
    this.#held.clear();
    this.#applyHeld();
  };

  #onKeyDown = (e: KeyboardEvent): void => {
    // Never steal keys from a text field.
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

    // Chords belong to commands (Ctrl+S is Save); the camera only takes bare keys.
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const { viewer } = this;
    const code = codeOf(e);
    const view = VIEW_KEYS[code];
    if (view) { viewer.controller.setView(view); e.preventDefault(); return; }

    if (e.shiftKey && ORBIT_KEYS.has(code)) {
      // Discrete 15-degree step rather than a continuous hold.
      viewer.controller.snapOrbit(
        code === 'ArrowRight' ? 1 : code === 'ArrowLeft' ? -1 : 0,
        code === 'ArrowUp' ? 1 : code === 'ArrowDown' ? -1 : 0,
      );
      this.#held.delete(code);
      this.#applyHeld();
      e.preventDefault();
      return;
    }

    if (HANDLED.has(code)) {
      this.#held.add(code);
      this.#applyHeld();
      e.preventDefault();
    }
  };

  #onKeyUp = (e: KeyboardEvent): void => {
    if (this.#held.delete(codeOf(e))) this.#applyHeld();
  };

  #applyHeld(): void {
    const c = this.viewer.controller;
    const held = this.#held;

    c.orbitInput.azimuth = (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0);
    c.orbitInput.elevation = (held.has('ArrowUp') ? 1 : 0) - (held.has('ArrowDown') ? 1 : 0);
    c.panInput.x = (held.has('KeyL') ? 1 : 0) - (held.has('KeyJ') ? 1 : 0);
    c.panInput.y = (held.has('KeyI') ? 1 : 0) - (held.has('KeyK') ? 1 : 0);

    c.zoomInput =
      (held.has('Equal') || held.has('NumpadAdd') ? 1 : 0) -
      (held.has('Minus') || held.has('NumpadSubtract') ? 1 : 0);
  }
}
