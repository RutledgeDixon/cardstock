import { Vector3, type OrthographicCamera } from 'three';
import type { Bounds } from '@cardstock/types';
import {
  type NamedView,
  type TurntableState,
  NAMED_VIEWS,
  applyToCamera,
  clampElevation,
  fitBounds,
  makeTurntableState,
  normalizeAzimuth,
  orbitDirection,
  viewFacing,
} from './turntable.js';

/**
 * The camera motion model: current state easing toward a target.
 *
 * Deliberately free of DOM and input concerns so that (a) it is testable in Node, and
 * (b) Phase 5's command system can drive it directly instead of synthesising key events.
 * `KeyboardCameraInput` is the thin adapter that binds actual keys to it.
 */

/** Signed shortest angular distance from `a` to `b`, in (-PI, PI]. */
export function shortestAngleDelta(a: number, b: number): number {
  return normalizeAzimuth(b - a);
}

export interface CameraTuning {
  /** Orbit speed while an arrow key is held, radians/second. */
  orbitRate: number;
  /** Step taken by shift+arrow, radians. */
  snapStep: number;
  /** Zoom rate while +/- is held, as a fraction per second. */
  zoomRate: number;
  /** Pan speed while ctrl+arrow is held, in screen-heights per second. */
  panRate: number;
  /**
   * Easing stiffness. Higher converges faster. The response is critically damped, so
   * the view never overshoots or oscillates — it settles.
   */
  stiffness: number;
}

export const DEFAULT_TUNING: CameraTuning = {
  orbitRate: 2.2,
  snapStep: Math.PI / 12, // 15 degrees
  zoomRate: 1.5,
  panRate: 0.9,
  stiffness: 12,
};

export class CameraController {
  /** What the camera is showing right now. */
  readonly current: TurntableState;
  /** What it is easing toward. */
  readonly target: TurntableState;
  readonly tuning: CameraTuning;

  /** Continuous input, -1..1, set by whatever is driving the controller. */
  orbitInput = { azimuth: 0, elevation: 0 };
  panInput = { x: 0, y: 0 };
  zoomInput = 0;

  /** How far the camera sits from the pivot. Only affects clipping, not apparent size. */
  orbitRadius = 500;

  constructor(initial?: Partial<TurntableState>, tuning: Partial<CameraTuning> = {}) {
    this.current = makeTurntableState(initial);
    this.target = makeTurntableState(initial);
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
  }

  // ------------------------------------------------------------------ commands
  setView(view: NamedView): void {
    const v = NAMED_VIEWS[view];
    this.target.azimuth = v.azimuth;
    this.target.elevation = v.elevation;
  }

  /** Point the camera at a face, given its outward normal. */
  faceView(normal: Vector3): void {
    const v = viewFacing(normal);
    this.target.azimuth = v.azimuth;
    this.target.elevation = v.elevation;
  }

  /** Discrete orbit step, e.g. shift+arrow. */
  snapOrbit(azimuthSteps: number, elevationSteps: number): void {
    this.target.azimuth += azimuthSteps * this.tuning.snapStep;
    this.target.elevation = clampElevation(
      this.target.elevation + elevationSteps * this.tuning.snapStep,
    );
  }

  /**
   * Re-centre the orbit on a point — the move that makes keyboard navigation pleasant,
   * because it lets you orbit around what you are actually looking at.
   */
  setPivot(point: Vector3): void {
    this.target.pivot.copy(point);
  }

  /** Frame the given bounds. Used by zoom-to-fit and on first load. */
  fit(bounds: Bounds, aspect: number, margin?: number): void {
    const { pivot, zoom } = fitBounds(bounds, aspect, margin);
    this.target.pivot.copy(pivot);
    this.target.zoom = zoom;
  }

  /** Jump straight to the target with no easing (initial load, tests). */
  settle(): void {
    this.current.azimuth = this.target.azimuth;
    this.current.elevation = this.target.elevation;
    this.current.zoom = this.target.zoom;
    this.current.pivot.copy(this.target.pivot);
  }

  // ------------------------------------------------------------------ per frame
  /**
   * Advance by `dt` seconds. Split out from any render loop so it can be stepped
   * deterministically in tests — requestAnimationFrame does not run while a pane is
   * hidden (ADR-0002), so anything that waits on frames will hang.
   */
  advance(dt: number): void {
    const t = this.tuning;
    const step = Math.min(Math.max(dt, 0), 0.1); // clamp: tab-out must not teleport

    // --- continuous input feeds the target
    this.target.azimuth += this.orbitInput.azimuth * t.orbitRate * step;
    this.target.elevation = clampElevation(
      this.target.elevation + this.orbitInput.elevation * t.orbitRate * step,
    );
    if (this.zoomInput !== 0) {
      this.target.zoom *= Math.exp(-this.zoomInput * t.zoomRate * step);
      this.target.zoom = Math.max(this.target.zoom, 1e-3);
    }
    if (this.panInput.x !== 0 || this.panInput.y !== 0) {
      // Pan in the screen plane, scaled by zoom so it feels constant on screen.
      const amount = t.panRate * step * this.target.zoom;
      const { right, up } = this.screenBasis();
      this.target.pivot
        .addScaledVector(right, -this.panInput.x * amount)
        .addScaledVector(up, -this.panInput.y * amount);
    }

    // --- current eases toward target (critically damped: settles, never overshoots)
    const k = 1 - Math.exp(-t.stiffness * step);
    // Shortest-arc, so orbiting across the +/-PI seam does not spin the long way round.
    this.current.azimuth = normalizeAzimuth(
      this.current.azimuth + shortestAngleDelta(this.current.azimuth, this.target.azimuth) * k,
    );
    this.current.elevation += (this.target.elevation - this.current.elevation) * k;
    this.current.zoom += (this.target.zoom - this.current.zoom) * k;
    this.current.pivot.lerp(this.target.pivot, k);

    this.target.azimuth = normalizeAzimuth(this.target.azimuth);
  }

  /** True once the camera has essentially arrived, so rendering can idle. */
  isSettled(): boolean {
    return (
      Math.abs(shortestAngleDelta(this.current.azimuth, this.target.azimuth)) < 1e-4 &&
      Math.abs(this.current.elevation - this.target.elevation) < 1e-4 &&
      Math.abs(this.current.zoom - this.target.zoom) / Math.max(this.target.zoom, 1e-6) < 1e-4 &&
      this.current.pivot.distanceToSquared(this.target.pivot) < 1e-8
    );
  }

  screenBasis(): { right: Vector3; up: Vector3 } {
    const toCamera = orbitDirection(this.current.azimuth, this.current.elevation);
    const right = new Vector3(0, 0, 1).cross(toCamera).normalize();
    const up = toCamera.clone().cross(right).normalize();
    return { right, up };
  }

  applyTo(camera: OrthographicCamera, aspect: number): void {
    applyToCamera(this.current, camera, aspect, this.orbitRadius);
  }
}
