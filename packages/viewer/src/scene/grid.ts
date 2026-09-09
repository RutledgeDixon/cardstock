import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
} from 'three';

/**
 * Ground grid on the XY plane (Z-up) with the three origin axes.
 *
 * Two line sets rather than one so major gridlines can read stronger than minor ones —
 * without that, a dense grid turns into grey mush and stops helping you judge scale.
 */
export interface GridOptions {
  /** Spacing of fine lines, mm. */
  minor?: number;
  /** Every Nth line is drawn as major. */
  majorEvery?: number;
  /** Half-width of the grid, mm. */
  extent?: number;
}

export class Grid extends Group {
  #minorLines: LineSegments;
  #majorLines: LineSegments;
  #axes: LineSegments;

  constructor(opts: GridOptions = {}) {
    super();
    const minor = opts.minor ?? 1;
    const majorEvery = opts.majorEvery ?? 10;
    const extent = opts.extent ?? 100;

    const minorPts: number[] = [];
    const majorPts: number[] = [];
    const steps = Math.floor(extent / minor);
    for (let i = -steps; i <= steps; i++) {
      const v = i * minor;
      const isMajor = i % majorEvery === 0;
      const target = isMajor ? majorPts : minorPts;
      if (i !== 0) {
        target.push(-extent, v, 0, extent, v, 0);
        target.push(v, -extent, 0, v, extent, 0);
      }
    }

    this.#minorLines = new LineSegments(
      geomFrom(minorPts),
      new LineBasicMaterial({ color: new Color(0x23262d), transparent: true, opacity: 0.85 }),
    );
    this.#majorLines = new LineSegments(
      geomFrom(majorPts),
      new LineBasicMaterial({ color: new Color(0x333843) }),
    );

    // Origin axes: X red, Y green, Z blue — the near-universal convention.
    const axisPts = [
      -extent, 0, 0, extent, 0, 0,
      0, -extent, 0, 0, extent, 0,
      0, 0, 0, 0, 0, extent * 0.25,
    ];
    const axisGeom = geomFrom(axisPts);
    axisGeom.setAttribute('color', new Float32BufferAttribute([
      0.55, 0.24, 0.26, 0.55, 0.24, 0.26,
      0.24, 0.50, 0.28, 0.24, 0.50, 0.28,
      0.26, 0.36, 0.62, 0.26, 0.36, 0.62,
    ], 3));
    this.#axes = new LineSegments(axisGeom, new LineBasicMaterial({ vertexColors: true }));

    this.#minorLines.renderOrder = -2;
    this.#majorLines.renderOrder = -2;
    this.#axes.renderOrder = -1;
    this.add(this.#minorLines, this.#majorLines, this.#axes);
  }

  dispose(): void {
    for (const l of [this.#minorLines, this.#majorLines, this.#axes]) {
      l.geometry.dispose();
      (l.material as LineBasicMaterial).dispose();
    }
    this.clear();
  }
}

function geomFrom(points: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(points, 3));
  return g;
}

/**
 * Pick a grid spacing that stays legible at the current zoom: aim for gridlines roughly
 * 8-40 px apart, snapping to a 1/2/5 x 10^n sequence so the numbers stay human.
 */
export function chooseGridSpacing(mmPerPixel: number): number {
  const targetMm = mmPerPixel * 16;
  const decade = 10 ** Math.floor(Math.log10(Math.max(targetMm, 1e-6)));
  for (const m of [1, 2, 5]) {
    if (decade * m >= targetMm) return decade * m;
  }
  return decade * 10;
}
