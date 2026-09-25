import { Color } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { TessellatedBody } from '@cardstock/types';

/**
 * A thicker orange line over the edges that are selected.
 *
 * A model's edges are drawn as plain LineSegments, and WebGL clamps `lineWidth` on those
 * to one pixel whatever is asked for — which is why the sketcher uses three's fat lines
 * instead. So a selected edge changed colour and nothing else, and against a shaded
 * surface a one-pixel orange line is easy to lose.
 *
 * Rather than convert every body edge to a fat line — which would mean porting the
 * per-entity state shader and the picking that goes with it — only the SELECTED edges
 * are redrawn, on top, as an overlay. Nothing about how bodies are built or picked
 * changes, and the sketch view is untouched.
 */

/**
 * Thicker than the one pixel it replaces, and deliberately thinner than the sketcher's
 * lines: in a sketch the geometry IS the subject, while here it is an edge of a solid
 * being pointed at.
 */
const SELECTED_EDGE_WIDTH = 3;

/** The orange WireMaterial uses for a selection, so the overlay matches what it covers. */
const SELECTED = new Color(1.0, 0.62, 0.22);

export class EdgeHighlight {
  readonly object = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({
    color: SELECTED, linewidth: SELECTED_EDGE_WIDTH, worldUnits: false,
  }));
  /** What the overlay currently shows, so an unchanged selection costs nothing. */
  #key = '\u0000';

  constructor() {
    this.object.name = 'selected-edges';
    // Above the bodies' own edges: the thin line sits inside this one, in the same
    // colour, so there is nothing to see through it.
    this.object.renderOrder = 2;
    this.object.material.resolution.set(1, 1);
    this.object.visible = false;
  }

  /** Fat lines are screen-space quads and need the viewport to size themselves. */
  setViewport(width: number, height: number): void {
    this.object.material.resolution.set(width, height);
  }

  /**
   * Redraw for the current selection.
   *
   * @param bodies the tessellation of every body on screen, by id
   * @param selected which edge indices are selected, by body id
   */
  update(
    bodies: Iterable<readonly [string, TessellatedBody]>,
    selected: ReadonlyMap<string, readonly number[]>,
  ): void {
    const key = [...selected].map(([id, indices]) => `${id}:${[...indices].sort().join(',')}`).sort().join('|');
    if (key === this.#key) return;
    this.#key = key;

    const positions: number[] = [];
    for (const [id, body] of bodies) {
      const wanted = selected.get(id);
      if (!wanted || wanted.length === 0) continue;
      const lit = new Set(wanted);
      // One entity id per SEGMENT, and each segment is two vertices — six floats.
      for (let segment = 0; segment < body.edgeSegmentId.length; segment++) {
        if (!lit.has(body.edgeSegmentId[segment]!)) continue;
        const at = segment * 6;
        for (let i = 0; i < 6; i++) positions.push(body.edgePositions[at + i]!);
      }
    }

    // A fresh geometry every time: three caches the instance count on first bind and
    // replacing the attributes does not invalidate it, so a reused geometry silently
    // draws the wrong number of segments. See the note in sketch-view.ts.
    this.object.geometry.dispose();
    const geometry = new LineSegmentsGeometry();
    if (positions.length > 0) geometry.setPositions(positions);
    this.object.geometry = geometry;
    this.object.visible = positions.length > 0;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.object.material.dispose();
  }
}
