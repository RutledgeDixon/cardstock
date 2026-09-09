import {
  BufferGeometry, Color, Float32BufferAttribute, Group, Line, LineBasicMaterial,
  LineSegments, Points, PointsMaterial, Vector3,
} from 'three';
import type { PlanePlacement, SketchGeometry, Vec2 } from '@cardstock/types';

/**
 * Draws a sketch on its plane.
 *
 * Rebuilt wholesale whenever the sketch changes rather than diffed: a sketch is tens of
 * entities, the geometry is trivial to regenerate, and a diffing layer would be a source
 * of stale-state bugs for no measurable gain.
 */

const ARC_SEGMENTS = 64;

export interface SketchViewColours {
  geometry: number;
  construction: number;
  point: number;
  preview: number;
  fullyConstrained: number;
}

export const DEFAULT_SKETCH_COLOURS: SketchViewColours = {
  geometry: 0xe8ecf4,
  construction: 0x6a7180,
  point: 0xffa03a,
  preview: 0x7fb2ff,
  fullyConstrained: 0x6fd39a,
};

export class SketchView {
  readonly group = new Group();

  #solid = new LineSegments(new BufferGeometry(), new LineBasicMaterial());
  #construction = new LineSegments(new BufferGeometry(), new LineBasicMaterial());
  #points = new Points(new BufferGeometry(), new PointsMaterial());
  #preview = new LineSegments(new BufferGeometry(), new LineBasicMaterial());
  #previewCircle = new Line(new BufferGeometry(), new LineBasicMaterial());

  constructor(
    public placement: PlanePlacement,
    private readonly colours: SketchViewColours = DEFAULT_SKETCH_COLOURS,
  ) {
    (this.#solid.material as LineBasicMaterial).color = new Color(colours.geometry);
    const construction = this.#construction.material as LineBasicMaterial;
    construction.color = new Color(colours.construction);
    construction.transparent = true;
    construction.opacity = 0.75;

    const points = this.#points.material as PointsMaterial;
    points.color = new Color(colours.point);
    points.size = 7;
    points.sizeAttenuation = false;

    for (const line of [this.#preview, this.#previewCircle]) {
      (line.material as LineBasicMaterial).color = new Color(colours.preview);
    }

    // Draw over the solid: a sketch you cannot see through the body you are sketching on
    // is not much use.
    for (const object of [this.#solid, this.#construction, this.#points, this.#preview, this.#previewCircle]) {
      object.renderOrder = 10;
      (object.material as LineBasicMaterial).depthTest = false;
      this.group.add(object);
    }
  }

  /** Sketch coordinates to world, through the plane placement. */
  toWorld(p: Vec2): Vector3 {
    const { origin, normal, xAxis } = this.placement;
    const y = new Vector3(normal.x, normal.y, normal.z)
      .cross(new Vector3(xAxis.x, xAxis.y, xAxis.z));
    return new Vector3(
      origin.x + xAxis.x * p.x + y.x * p.y,
      origin.y + xAxis.y * p.x + y.y * p.y,
      origin.z + xAxis.z * p.x + y.z * p.y,
    );
  }

  /** Colour the geometry by how pinned down the sketch is — the state you always want. */
  setFullyConstrained(fully: boolean): void {
    (this.#solid.material as LineBasicMaterial).color = new Color(
      fully ? this.colours.fullyConstrained : this.colours.geometry,
    );
  }

  update(geometry: readonly SketchGeometry[]): void {
    const solid: number[] = [];
    const construction: number[] = [];
    const points: number[] = [];

    const positionOf = (id: string): Vec2 | null => {
      const entity = geometry.find((e) => e.id === id);
      return entity?.type === 'point' ? { x: entity.x, y: entity.y } : null;
    };

    const push = (into: number[], a: Vec2, b: Vec2) => {
      const from = this.toWorld(a);
      const to = this.toWorld(b);
      into.push(from.x, from.y, from.z, to.x, to.y, to.z);
    };

    for (const entity of geometry) {
      if (entity.type === 'point') {
        const world = this.toWorld({ x: entity.x, y: entity.y });
        points.push(world.x, world.y, world.z);
        continue;
      }

      const into = entity.construction ? construction : solid;

      if (entity.type === 'line') {
        const a = positionOf(entity.p1);
        const b = positionOf(entity.p2);
        if (a && b) push(into, a, b);
        continue;
      }

      const centre = positionOf(entity.type === 'circle' ? entity.centre : entity.centre);
      if (!centre) continue;
      const from = entity.type === 'circle' ? 0 : entity.startAngle;
      let to = entity.type === 'circle' ? Math.PI * 2 : entity.endAngle;
      while (to <= from) to += Math.PI * 2;

      let previous: Vec2 | null = null;
      for (let i = 0; i <= ARC_SEGMENTS; i++) {
        const angle = from + ((to - from) * i) / ARC_SEGMENTS;
        const current = {
          x: centre.x + entity.radius * Math.cos(angle),
          y: centre.y + entity.radius * Math.sin(angle),
        };
        if (previous) push(into, previous, current);
        previous = current;
      }
    }

    setPositions(this.#solid.geometry, solid);
    setPositions(this.#construction.geometry, construction);
    setPositions(this.#points.geometry, points);
  }

  /** Rubber-band feedback while drawing. */
  setPreview(
    segments: readonly { from: Vec2; to: Vec2 }[],
    circle?: { centre: Vec2; radius: number },
  ): void {
    const flat: number[] = [];
    for (const segment of segments) {
      const from = this.toWorld(segment.from);
      const to = this.toWorld(segment.to);
      flat.push(from.x, from.y, from.z, to.x, to.y, to.z);
    }
    setPositions(this.#preview.geometry, flat);

    const ring: number[] = [];
    if (circle && circle.radius > 1e-9) {
      for (let i = 0; i <= ARC_SEGMENTS; i++) {
        const angle = (Math.PI * 2 * i) / ARC_SEGMENTS;
        const world = this.toWorld({
          x: circle.centre.x + circle.radius * Math.cos(angle),
          y: circle.centre.y + circle.radius * Math.sin(angle),
        });
        ring.push(world.x, world.y, world.z);
      }
    }
    setPositions(this.#previewCircle.geometry, ring);
  }

  clearPreview(): void { this.setPreview([]); }

  dispose(): void {
    for (const object of [this.#solid, this.#construction, this.#points, this.#preview, this.#previewCircle]) {
      object.geometry.dispose();
      (object.material as LineBasicMaterial).dispose();
    }
    this.group.clear();
  }
}

function setPositions(geometry: BufferGeometry, values: number[]): void {
  geometry.setAttribute('position', new Float32BufferAttribute(values, 3));
  geometry.computeBoundingSphere();
}
