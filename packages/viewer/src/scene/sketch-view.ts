import {
  BufferGeometry, Color, Float32BufferAttribute, Group, Line, LineBasicMaterial,
  Points, PointsMaterial, Vector3,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { PlanePlacement, SketchGeometry, Vec2 } from '@cardstock/types';

/**
 * Draws a sketch on its plane.
 *
 * Rebuilt wholesale whenever the sketch changes rather than diffed: a sketch is tens of
 * entities, the geometry is trivial to regenerate, and a diffing layer would be a source
 * of stale-state bugs for no measurable gain.
 *
 * Lines are three's FAT lines, not LineBasicMaterial. `linewidth` on LineBasicMaterial is
 * ignored by every WebGL implementation that matters — it renders one pixel wide whatever
 * you ask for — and the thing you are actively drawing needs to read more strongly than
 * the model behind it.
 */

const ARC_SEGMENTS = 64;
const LINE_WIDTH = 3.4;
/** Selected geometry is both recoloured and thickened: colour alone is easy to miss. */
const SELECTED_LINE_WIDTH = 5.5;
const DIMENSION_LINE_WIDTH = 1.9;
const EXTERNAL_LINE_WIDTH = 1.4;
const EXTERNAL_POINT_SIZE = 6;
const POINT_SIZE = 8;
const SELECTED_POINT_SIZE = 12;
/** Bigger than either, because it is a target you are aiming at. */
const SNAP_POINT_SIZE = 15;

export interface SketchViewColours {
  geometry: number;
  construction: number;
  point: number;
  preview: number;
  fullyConstrained: number;
  selected: number;
  snap: number;
  /** Dimension and extension lines: thin, dark blue, drawn under the geometry. */
  dimension: number;
  /** Reference geometry projected from the face or the origin axes: muted, fixed. */
  external: number;
}

export const DEFAULT_SKETCH_COLOURS: SketchViewColours = {
  geometry: 0xe8ecf4,
  construction: 0x6a7180,
  // Red, and deliberately not a colour the model uses: a neutral vertex disappeared
  // against the grey of the face being sketched on.
  // Darker than a plain red so it cannot be mistaken for the selection orange.
  point: 0xd42a2a,
  preview: 0x7fb2ff,
  fullyConstrained: 0x6fd39a,
  // The same orange the 3D selection uses, so "selected" means one thing across the app.
  selected: 0xff9e38,
  /** The vertex a click would connect to. Green reads as "go", and is not the selection. */
  snap: 0x6fd39a,
  dimension: 0x2b4f9e,
  external: 0x7d8fb0,
};

export class SketchView {
  readonly group = new Group();

  #solid = fatLine();
  #selectedLines = fatLine();
  #construction = fatLine();
  #preview = fatLine();
  /** Extension lines, dimension lines and arrowheads, in the engineering-drawing sense. */
  #dimensionLines = fatLine();
  #external = fatLine();
  #externalPoints = new Points(new BufferGeometry(), new PointsMaterial());
  #points = new Points(new BufferGeometry(), new PointsMaterial());
  #selectedPoints = new Points(new BufferGeometry(), new PointsMaterial());
  /**
   * The vertex the next click would connect to.
   *
   * The tools have always known this and nothing drew it, so a click that joined an
   * existing point and one that made a new point on top of it looked identical — and
   * the one that joined looked like it had done nothing at all.
   */
  #snapPoint = new Points(new BufferGeometry(), new PointsMaterial());
  #previewCircle = new Line(new BufferGeometry(), new LineBasicMaterial());

  /** Ids the user has selected. Drawn recoloured and thicker. */
  #selected: ReadonlySet<string> = new Set();
  /** Kept so a selection change can redraw without the caller re-supplying geometry. */
  #geometry: readonly SketchGeometry[] = [];

  constructor(
    public placement: PlanePlacement,
    private readonly colours: SketchViewColours = DEFAULT_SKETCH_COLOURS,
  ) {
    this.#solid.material.color = new Color(colours.geometry);
    this.#solid.material.linewidth = LINE_WIDTH;

    this.#selectedLines.material.color = new Color(colours.selected);
    this.#selectedLines.material.linewidth = SELECTED_LINE_WIDTH;

    this.#construction.material.color = new Color(colours.construction);
    this.#construction.material.linewidth = LINE_WIDTH * 0.7;
    this.#construction.material.transparent = true;
    this.#construction.material.opacity = 0.75;

    this.#preview.material.color = new Color(colours.preview);
    this.#preview.material.linewidth = LINE_WIDTH;

    this.#dimensionLines.material.color = new Color(colours.dimension);
    this.#dimensionLines.material.linewidth = DIMENSION_LINE_WIDTH;

    this.#external.material.color = new Color(colours.external);
    this.#external.material.linewidth = EXTERNAL_LINE_WIDTH;
    this.#external.material.transparent = true;
    this.#external.material.opacity = 0.8;
    const externalPoints = this.#externalPoints.material;
    externalPoints.color = new Color(colours.external);
    externalPoints.size = EXTERNAL_POINT_SIZE;
    externalPoints.sizeAttenuation = false;

    const points = this.#points.material;
    points.color = new Color(colours.point);
    points.size = POINT_SIZE;
    points.sizeAttenuation = false;

    const selectedPoints = this.#selectedPoints.material;
    selectedPoints.color = new Color(colours.selected);
    selectedPoints.size = SELECTED_POINT_SIZE;
    selectedPoints.sizeAttenuation = false;

    const snap = this.#snapPoint.material;
    snap.color = new Color(colours.snap);
    snap.size = SNAP_POINT_SIZE;
    snap.sizeAttenuation = false;

    (this.#previewCircle.material as LineBasicMaterial).color = new Color(colours.preview);

    // Draw over the solid: a sketch you cannot see through the body you are sketching on
    // is not much use. Selected geometry sits above the rest so a thick highlight is not
    // hidden by the ordinary line underneath it.
    for (const object of this.#all()) {
      object.renderOrder = 10;
      (object.material as { depthTest: boolean }).depthTest = false;
      this.group.add(object);
    }
    this.#dimensionLines.renderOrder = 9;
    this.#external.renderOrder = 8;
    this.#externalPoints.renderOrder = 8;
    this.#selectedLines.renderOrder = 11;
    this.#selectedPoints.renderOrder = 12;
    this.#snapPoint.renderOrder = 13;
    this.#points.renderOrder = 11;
  }

  #all(): (LineSegments2 | Points | Line)[] {
    return [
      this.#solid, this.#construction, this.#selectedLines, this.#preview, this.#dimensionLines,
      this.#external, this.#externalPoints,
      this.#points, this.#selectedPoints, this.#snapPoint, this.#previewCircle,
    ];
  }

  /**
   * Pixel width only means something once the material knows the canvas size.
   *
   * Without this fat lines render at a nonsense width that changes with the window, so
   * the viewer calls it on every resize.
   */
  setResolution(width: number, height: number): void {
    for (const line of [this.#solid, this.#selectedLines, this.#construction, this.#preview, this.#dimensionLines, this.#external]) {
      line.material.resolution.set(width, height);
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
    this.#solid.material.color = new Color(
      fully ? this.colours.fullyConstrained : this.colours.geometry,
    );
  }

  /** What the user has selected. Redraws from the geometry already held. */
  setSelection(ids: Iterable<string>): void {
    this.#selected = new Set(ids);
    this.update(this.#geometry);
  }

  update(geometry: readonly SketchGeometry[]): void {
    this.#geometry = geometry;
    const solid: number[] = [];
    const construction: number[] = [];
    const selectedLines: number[] = [];
    const points: number[] = [];
    const selectedPoints: number[] = [];
    const external: number[] = [];
    const externalPoints: number[] = [];

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
      const isSelected = this.#selected.has(entity.id);

      if (entity.type === 'point') {
        const world = this.toWorld({ x: entity.x, y: entity.y });
        (isSelected ? selectedPoints : entity.external ? externalPoints : points)
          .push(world.x, world.y, world.z);
        continue;
      }

      const into = isSelected ? selectedLines
        : entity.external ? external
        : entity.construction ? construction
        : solid;

      if (entity.type === 'line') {
        const a = positionOf(entity.p1);
        const b = positionOf(entity.p2);
        if (a && b) push(into, a, b);
        continue;
      }

      const centre = positionOf(entity.centre);
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

    setSegments(this.#solid, solid);
    setSegments(this.#construction, construction);
    setSegments(this.#selectedLines, selectedLines);
    setSegments(this.#external, external);
    setPositions(this.#externalPoints.geometry, externalPoints);
    setPositions(this.#points.geometry, points);
    setPositions(this.#selectedPoints.geometry, selectedPoints);
  }

  /** The lines that go with the dimensions: extension lines, dimension lines, arrows. */
  setDimensionLines(segments: readonly { from: Vec2; to: Vec2 }[]): void {
    const flat: number[] = [];
    for (const segment of segments) {
      const from = this.toWorld(segment.from);
      const to = this.toWorld(segment.to);
      flat.push(from.x, from.y, from.z, to.x, to.y, to.z);
    }
    // Called per frame alongside label placement; only rebuild the geometry on change.
    const previous = this.#lastDimensionLines;
    if (previous.length === flat.length && previous.every((v, i) => v === flat[i])) return;
    this.#lastDimensionLines = flat;
    setSegments(this.#dimensionLines, flat);
  }
  #lastDimensionLines: number[] = [];

  /** Mark the vertex a click would connect to, or clear it with null. */
  setSnapTarget(at: Vec2 | null): void {
    if (!at) { setPositions(this.#snapPoint.geometry, []); return; }
    const world = this.toWorld(at);
    setPositions(this.#snapPoint.geometry, [world.x, world.y, world.z]);
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
    setSegments(this.#preview, flat);

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
    for (const object of this.#all()) {
      object.geometry.dispose();
      (object.material as { dispose(): void }).dispose();
    }
    this.group.clear();
  }
}

function fatLine(): LineSegments2 {
  const line = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial());
  // Fat lines are screen-space quads; without this they are invisible until the viewer
  // reports its size.
  line.material.resolution.set(1, 1);
  return line;
}

/**
 * Feed a flat xyz list to a fat line, on a FRESH geometry every time.
 *
 * Reusing the geometry and calling `setPositions` again looks right and silently draws
 * the wrong number of segments. Three caches `_maxInstanceCount` on the geometry when it
 * first binds its vertex attributes, and replacing those attributes does not invalidate
 * it — the renderer then draws `min(instanceCount, _maxInstanceCount)` instances. A
 * sketch redrawn after its first line had instanceCount 3 and _maxInstanceCount 1, so
 * every line after the first was built, counted, and never painted.
 *
 * Disposing the old geometry is what drops those cached bindings; a new geometry then
 * binds cleanly. Sketches are tens of entities and are already redrawn wholesale, so the
 * allocation costs nothing worth measuring.
 *
 * An EMPTY list still short-circuits: setPositions on no points makes a degenerate
 * instanced geometry that three then tries to draw.
 */
function setSegments(line: LineSegments2, values: number[]): void {
  const previous = line.geometry;
  if (values.length === 0) {
    line.visible = false;
    return;
  }
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(values);
  line.geometry = geometry;
  line.visible = true;
  line.computeLineDistances();
  previous.dispose();
}

function setPositions(geometry: BufferGeometry, values: number[]): void {
  geometry.setAttribute('position', new Float32BufferAttribute(values, 3));
  geometry.computeBoundingSphere();
}
