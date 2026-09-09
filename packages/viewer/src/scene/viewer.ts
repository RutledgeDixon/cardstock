import {
  Color, OrthographicCamera, Plane, Raycaster, Scene, Vector2, Vector3, WebGLRenderer,
} from 'three';

const _plane = new Plane();
const _raycaster = new Raycaster();
import type { EntityRef, TessellatedBody } from '@cardstock/types';
import { CameraController } from '../camera/controller.js';
import { Picker, type PickResult } from '../picking/picker.js';
import { SelectionManager } from '../picking/selection.js';
import { BodyView } from './body-view.js';
import { Grid } from './grid.js';

export interface ViewerOptions {
  background?: number;
  grid?: boolean;
}

/**
 * The 3D view. Framework-agnostic — construct it with a canvas; it knows nothing about
 * React, and @cardstock/ui drives it from the outside.
 */
export class Viewer {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera();
  readonly controller = new CameraController();
  readonly selection = new SelectionManager();
  readonly picker: Picker;
  readonly renderer: WebGLRenderer;

  readonly #bodies = new Map<string, BodyView>();
  readonly #grid: Grid | null;
  readonly #pointer = new Vector2(-2, -2);
  #pointerInside = false;
  #running = false;
  #lastTime = 0;
  #frameHandle = 0;
  #width = 1;
  #height = 1;
  /** Last pick, kept so "pivot to cursor" and "look at this face" can use it. */
  lastPick: PickResult | null = null;

  /**
   * Called at the end of every rendered frame.
   *
   * For overlays that have to follow the camera — dimension labels projected from 3D —
   * so they ride the existing loop instead of starting a second one that would drift out
   * of step with it.
   */
  readonly onFrame = new Set<() => void>();

  constructor(readonly canvas: HTMLCanvasElement, opts: ViewerOptions = {}) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.scene.background = new Color(opts.background ?? 0x14161a);

    this.#grid = opts.grid === false ? null : new Grid({ minor: 1, majorEvery: 10, extent: 200 });
    if (this.#grid) this.scene.add(this.#grid);

    this.picker = new Picker(() => this.#bodies.values());
    this.selection.subscribe(() => this.#syncHighlights());
    this.resize();
  }

  // ------------------------------------------------------------------ bodies
  setBody(body: TessellatedBody): BodyView {
    this.removeBody(body.bodyId);
    const view = new BodyView(body);
    this.#bodies.set(body.bodyId, view);
    this.scene.add(view.group);
    return view;
  }

  removeBody(bodyId: string): void {
    const existing = this.#bodies.get(bodyId);
    if (!existing) return;
    this.scene.remove(existing.group);
    existing.dispose();
    this.#bodies.delete(bodyId);
  }

  get bodies(): ReadonlyMap<string, BodyView> { return this.#bodies; }

  /** Frame everything currently loaded. */
  fitAll(): void {
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const b of this.#bodies.values()) {
      const { bounds } = b.data;
      min = [Math.min(min[0]!, bounds.min.x), Math.min(min[1]!, bounds.min.y), Math.min(min[2]!, bounds.min.z)];
      max = [Math.max(max[0]!, bounds.max.x), Math.max(max[1]!, bounds.max.y), Math.max(max[2]!, bounds.max.z)];
    }
    if (!Number.isFinite(min[0])) return;
    const bounds = {
      min: { x: min[0]!, y: min[1]!, z: min[2]! },
      max: { x: max[0]!, y: max[1]!, z: max[2]! },
    };
    this.controller.fit(bounds, this.aspect);
    // Keep the camera well clear of the model regardless of its size.
    const span = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
    this.controller.orbitRadius = Math.max(span * 8, 100);
  }

  // ------------------------------------------------------------------ viewport
  get aspect(): number {
    return this.#height > 0 ? this.#width / this.#height : 1;
  }

  /**
   * Recompute size from the canvas' client box.
   *
   * Guards against a zero-sized box: a hidden pane reports 0x0, which would make aspect
   * NaN and poison the projection matrix — every subsequent raycast then silently misses
   * (ADR-0002). Keeping the last good size is better than rendering nothing.
   */
  resize(width?: number, height?: number): void {
    const w = Math.floor(width ?? this.canvas.clientWidth);
    const h = Math.floor(height ?? this.canvas.clientHeight);
    if (w > 0 && h > 0) {
      this.#width = w;
      this.#height = h;
      this.renderer.setSize(w, h, false);
    }
  }

  get viewport(): { width: number; height: number } {
    return { width: this.#width, height: this.#height };
  }

  // ------------------------------------------------------------------ pointer
  setPointer(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.#pointer.set(
      ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
      -((clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
    );
    this.#pointerInside = true;
  }

  clearPointer(): void {
    this.#pointerInside = false;
    this.lastPick = null;
    this.selection.setHover(null);
  }

  /** Resolve whatever is currently under the cursor, honouring the selection filter. */
  pickAtPointer(): PickResult | null {
    if (!this.#pointerInside) return null;
    return this.picker.pick(this.#pointer, this.camera, this.selection.filter, this.viewport);
  }

  /** Click at the current pointer. `additive` for shift-click. */
  clickAtPointer(additive = false): EntityRef | null {
    const hit = this.pickAtPointer();
    this.selection.click(hit?.ref ?? null, additive);
    return hit?.ref ?? null;
  }

  /**
   * Click at explicit client coordinates.
   *
   * Prefer this over clickAtPointer for pointer events: it picks at the event's own
   * position rather than trusting that a pointermove arrived first. Touch taps and
   * synthetic clicks produce no move, so relying on the cached pointer silently
   * deselects instead of selecting.
   */
  clickAt(clientX: number, clientY: number, additive = false): EntityRef | null {
    this.setPointer(clientX, clientY);
    return this.clickAtPointer(additive);
  }

  /**
   * Where the cursor falls on a sketch plane, in sketch coordinates.
   *
   * Sketching happens in 2D, so every pointer position has to come back through the
   * plane. Returns null when the plane is edge-on and the ray never meets it.
   */
  pointerOnPlane(placement: {
    origin: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
    xAxis: { x: number; y: number; z: number };
  }): { x: number; y: number } | null {
    if (!this.#pointerInside) return null;
    const normal = new Vector3(placement.normal.x, placement.normal.y, placement.normal.z).normalize();
    const origin = new Vector3(placement.origin.x, placement.origin.y, placement.origin.z);
    _plane.setFromNormalAndCoplanarPoint(normal, origin);

    _raycaster.setFromCamera(this.#pointer, this.camera);
    const hit = _raycaster.ray.intersectPlane(_plane, new Vector3());
    if (!hit) return null;

    const xAxis = new Vector3(placement.xAxis.x, placement.xAxis.y, placement.xAxis.z).normalize();
    const yAxis = new Vector3().crossVectors(normal, xAxis);
    const delta = hit.sub(origin);
    return { x: delta.dot(xAxis), y: delta.dot(yAxis) };
  }

  /** Re-centre the orbit on whatever is under the cursor — the '.' key. */
  pivotToPointer(): boolean {
    const hit = this.lastPick ?? this.pickAtPointer();
    if (!hit) return false;
    this.controller.setPivot(hit.point);
    return true;
  }

  /** Look square at the hovered face — only meaningful for faces. */
  lookAtHoveredFace(): boolean {
    const hit = this.lastPick ?? this.pickAtPointer();
    if (!hit?.normal) return false;
    this.controller.faceView(hit.normal);
    return true;
  }

  // ------------------------------------------------------------------ frame
  /**
   * One deterministic step. Separate from the rAF driver so tests (and hidden panes,
   * where rAF never fires) can drive the viewer explicitly.
   */
  step(dt: number): void {
    this.controller.advance(dt);
    this.controller.applyTo(this.camera, this.aspect);

    const hit = this.pickAtPointer();
    this.lastPick = hit;
    this.selection.setHover(hit?.ref ?? null);

    this.renderer.render(this.scene, this.camera);
    for (const callback of this.onFrame) callback();
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.#running) return;
      const dt = (now - this.#lastTime) / 1000;
      this.#lastTime = now;
      // Schedule the next frame BEFORE stepping. If step throws — a bad pick, a
      // half-built body — scheduling afterwards would kill the loop permanently and the
      // app would freeze on its last drawn frame with no error anyone would connect to it.
      this.#frameHandle = requestAnimationFrame(loop);
      try {
        this.step(dt);
      } catch (error) {
        console.error('[viewer] frame failed', error);
      }
    };
    this.#frameHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    this.#running = false;
    if (this.#frameHandle) cancelAnimationFrame(this.#frameHandle);
    this.#frameHandle = 0;
  }

  // ------------------------------------------------------------------ internals
  #syncHighlights(): void {
    const { hover, filter } = this.selection;
    for (const body of this.#bodies.values()) {
      body.vertices.visible = filter === 'vertex';

      const isHovered = (kind: string) => hover?.bodyId === body.bodyId && hover.kind === kind;
      body.solidMaterial.setHoveredFace(isHovered('face') ? hover!.index : -1);
      body.edgeMaterial.setHovered(isHovered('edge') ? hover!.index : -1);
      body.vertexMaterial.setHovered(isHovered('vertex') ? hover!.index : -1);

      body.solidMaterial.setSelectedFaces(this.selection.indicesByBody('face').get(body.bodyId) ?? []);
      body.edgeMaterial.setSelected(this.selection.indicesByBody('edge').get(body.bodyId) ?? []);
      body.vertexMaterial.setSelected(this.selection.indicesByBody('vertex').get(body.bodyId) ?? []);
    }
  }

  dispose(): void {
    this.stop();
    for (const id of [...this.#bodies.keys()]) this.removeBody(id);
    this.#grid?.dispose();
    this.renderer.dispose();
  }
}
