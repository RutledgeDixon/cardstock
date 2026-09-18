import { beforeEach, describe, expect, it } from 'vitest';
import { Sketch } from './sketch.js';
import { SketchTools } from './tools.js';

let sketch: Sketch;
let tools: SketchTools;

beforeEach(() => {
  sketch = new Sketch({ kind: 'origin', plane: 'xy' });
  tools = new SketchTools(sketch);
});

const lines = () => sketch.geometry.filter((e) => e.type === 'line');
const points = () => sketch.geometry.filter((e) => e.type === 'point');
const constraintTypes = () => sketch.constraints.map((c) => c.type).sort();

describe('the line tool', () => {
  beforeEach(() => tools.setTool('line'));

  it('needs two clicks to make a line', () => {
    expect(tools.click({ x: 0, y: 0 }).completed).toBe(false);
    expect(lines()).toHaveLength(0);
    tools.click({ x: 40, y: 0 });
    expect(lines()).toHaveLength(1);
  });

  it('continues as a polyline from the last point', () => {
    tools.click({ x: 0, y: 0 });
    tools.click({ x: 40, y: 0 });
    tools.click({ x: 40, y: 20 });
    expect(lines()).toHaveLength(2);
    expect(points()).toHaveLength(3); // the chain shares its joints
  });

  it('closes and finishes when the chain returns to its start', () => {
    tools.click({ x: 0, y: 0 });
    tools.click({ x: 40, y: 0 });
    tools.click({ x: 40, y: 20 });
    const result = tools.click({ x: 0, y: 0 }); // back onto the first point
    expect(result.completed).toBe(true);
    expect(tools.isDrawing).toBe(false);
    expect(lines()).toHaveLength(3);
    expect(points()).toHaveLength(3); // no duplicate at the join
  });

  it('infers horizontal for a line drawn nearly flat', () => {
    tools.click({ x: 0, y: 0 });
    tools.click({ x: 40, y: 0.5 });
    expect(constraintTypes()).toEqual(['horizontal']);
    // And snaps the point, so the drawing matches the constraint.
    expect(points().at(-1)).toMatchObject({ y: 0 });
  });

  it('infers nothing from a deliberate diagonal', () => {
    tools.click({ x: 0, y: 0 });
    tools.click({ x: 40, y: 25 });
    expect(sketch.constraints).toHaveLength(0);
  });

  it('reuses a nearby existing point instead of stacking a new one on top', () => {
    tools.click({ x: 0, y: 0 });
    tools.click({ x: 40, y: 0 });
    tools.setTool('line');
    tools.click({ x: 40.2, y: 0.1 }); // essentially the same place
    tools.click({ x: 40, y: 30 });
    // Three points, not four: the new line starts from the existing corner.
    expect(points()).toHaveLength(3);
  });
});

describe('the rectangle tool', () => {
  beforeEach(() => tools.setTool('rectangle'));

  it('builds four lines and four points from two clicks', () => {
    expect(tools.click({ x: 0, y: 0 }).completed).toBe(false);
    const result = tools.click({ x: 40, y: 20 });
    expect(result.completed).toBe(true);
    expect(lines()).toHaveLength(4);
    expect(points()).toHaveLength(4);
  });

  it('constrains it as a rectangle with the fewest rules: bottom, left, and two parallels', () => {
    // Without these the first drag turns it into an arbitrary quadrilateral.
    tools.click({ x: 0, y: 0 });
    tools.click({ x: 40, y: 20 });
    expect(constraintTypes()).toEqual(['horizontal', 'parallel', 'parallel', 'vertical']);
    const P = (id: string) => sketch.entity(id) as { x: number; y: number };
    const horizontal = sketch.constraints.find((c) => c.type === 'horizontal') as { line: string };
    const vertical = sketch.constraints.find((c) => c.type === 'vertical') as { line: string };
    const bottom = sketch.entity(horizontal.line) as { p1: string; p2: string };
    const left = sketch.entity(vertical.line) as { p1: string; p2: string };
    expect(P(bottom.p1).y).toBe(0);
    expect(P(bottom.p2).y).toBe(0);
    expect(P(left.p1).x).toBe(0);
    expect(P(left.p2).x).toBe(0);
  });

  it('puts the horizontal on the bottom and the vertical on the left whichever way it is dragged', () => {
    tools.click({ x: 40, y: 20 });
    tools.click({ x: 0, y: 0 });
    const P = (id: string) => sketch.entity(id) as { x: number; y: number };
    const horizontal = sketch.constraints.find((c) => c.type === 'horizontal') as { line: string };
    const vertical = sketch.constraints.find((c) => c.type === 'vertical') as { line: string };
    const bottom = sketch.entity(horizontal.line) as { p1: string; p2: string };
    const left = sketch.entity(vertical.line) as { p1: string; p2: string };
    expect(P(bottom.p1).y).toBe(0);
    expect(P(left.p1).x).toBe(0);
  });

  it('works when dragged from any corner', () => {
    tools.click({ x: 40, y: 20 });
    tools.click({ x: 0, y: 0 });
    expect(lines()).toHaveLength(4);
    const xs = points().map((p) => (p as { x: number }).x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0, 9);
    expect(xs.at(-1)).toBeCloseTo(40, 9);
  });
});

describe('the circle tool', () => {
  beforeEach(() => tools.setTool('circle'));

  it('takes a centre then a radius', () => {
    tools.click({ x: 10, y: 10 });
    expect(sketch.geometry.filter((e) => e.type === 'circle')).toHaveLength(0);
    const result = tools.click({ x: 15, y: 10 });
    expect(result.completed).toBe(true);
    expect(sketch.geometry.find((e) => e.type === 'circle')).toMatchObject({ radius: 5 });
  });

  it('ignores a second click on the centre, which would be a zero radius', () => {
    tools.click({ x: 10, y: 10 });
    const result = tools.click({ x: 10, y: 10 });
    expect(result.completed).toBe(false);
    expect(sketch.geometry.filter((e) => e.type === 'circle')).toHaveLength(0);
  });
});

describe('abandoning a shape', () => {
  it('removes a point left behind by a cancelled line', () => {
    // A stray point adds two degrees of freedom the user never asked for and cannot see.
    tools.setTool('line');
    tools.click({ x: 5, y: 5 });
    expect(points()).toHaveLength(1);
    tools.cancel();
    expect(points()).toHaveLength(0);
    expect(tools.isDrawing).toBe(false);
  });

  it('keeps points that something else is using', () => {
    tools.setTool('line');
    tools.click({ x: 0, y: 0 });
    tools.click({ x: 20, y: 0 });   // a real line now exists
    tools.cancel();
    expect(lines()).toHaveLength(1);
    expect(points()).toHaveLength(2);
  });

  it('abandons the shape in progress when the tool changes', () => {
    tools.setTool('circle');
    tools.click({ x: 5, y: 5 });
    tools.setTool('line');
    expect(tools.isDrawing).toBe(false);
    expect(points()).toHaveLength(0);
  });
});

describe('preview feedback', () => {
  it('rubber-bands from the last point', () => {
    tools.setTool('line');
    tools.click({ x: 0, y: 0 });
    const preview = tools.preview({ x: 30, y: 30 });
    expect(preview.segments).toHaveLength(1);
    expect(preview.segments[0]!.from).toEqual({ x: 0, y: 0 });
  });

  it('names the inference that is about to be applied', () => {
    tools.setTool('line');
    tools.click({ x: 0, y: 0 });
    expect(tools.preview({ x: 40, y: 0.4 }).inference).toBe('Horizontal');
    expect(tools.preview({ x: 0.4, y: 40 }).inference).toBe('Vertical');
    expect(tools.preview({ x: 30, y: 30 }).inference).toBeNull();
  });

  it('reports the point a click would snap to', () => {
    tools.setTool('line');
    tools.click({ x: 0, y: 0 });
    tools.click({ x: 40, y: 0 });
    tools.setTool('line');
    const preview = tools.preview({ x: 40.1, y: 0.1 });
    expect(preview.snapPoint).not.toBeNull();
    expect(preview.inference).toBe('Coincident');
  });

  it('previews a rectangle as four sides', () => {
    tools.setTool('rectangle');
    tools.click({ x: 0, y: 0 });
    expect(tools.preview({ x: 10, y: 5 }).segments).toHaveLength(4);
  });

  it('previews a circle with its live radius', () => {
    tools.setTool('circle');
    tools.click({ x: 0, y: 0 });
    expect(tools.preview({ x: 3, y: 4 }).circle).toMatchObject({ radius: 5 });
  });

  it('shows nothing before the first click', () => {
    tools.setTool('line');
    expect(tools.preview({ x: 5, y: 5 }).segments).toEqual([]);
  });
});

describe('the select tool', () => {
  it('creates nothing', () => {
    tools.setTool('select');
    expect(tools.click({ x: 5, y: 5 }).created).toEqual([]);
    expect(sketch.geometry).toHaveLength(0);
  });
});

describe('snapping is measured in pixels, not millimetres', () => {
  /**
   * The snap radius used to be a fixed 3 sketch units regardless of zoom. Zoomed out far
   * enough that is a two-pixel target, so clicking an existing vertex to continue a chain
   * appeared to do nothing and the profile stayed open — which is exactly what a user
   * reported after deleting an edge and trying to redraw it.
   */
  const vertexAt = (sketch: Sketch, x: number, y: number) => sketch.addPoint(x, y);

  it('reuses an existing vertex when the click is a few pixels away', () => {
    const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
    const corner = vertexAt(sketch, 40, 25);
    const tools = new SketchTools(sketch);

    // Zoomed out hard: one pixel is 1.5mm, so the old 3mm radius was two pixels.
    tools.setScale(1.5);
    tools.setTool('line');
    const before = sketch.geometry.filter((e) => e.type === 'point').length;
    tools.click({ x: 40 + 1.5 * 5, y: 25 }); // five pixels off
    const after = sketch.geometry.filter((e) => e.type === 'point').length;

    expect(after, 'a new point means the click missed the vertex').toBe(before);
    expect(sketch.entity(corner)).toBeDefined();
  });

  it('does not snap to a vertex that is far away on screen', () => {
    // The radius has to stay a radius: zoomed IN, a click 100 pixels away is a new point.
    const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
    vertexAt(sketch, 40, 25);
    const tools = new SketchTools(sketch);
    tools.setScale(0.05); // zoomed in: one pixel is a twentieth of a millimetre
    tools.setTool('line');

    const before = sketch.geometry.filter((e) => e.type === 'point').length;
    tools.click({ x: 40 + 0.05 * 100, y: 25 });
    expect(sketch.geometry.filter((e) => e.type === 'point').length).toBe(before + 1);
  });

  it('ignores a nonsense scale rather than disabling snapping', () => {
    // A zero or NaN viewport height early in boot must not silently turn snapping off.
    const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
    vertexAt(sketch, 10, 10);
    const tools = new SketchTools(sketch);
    tools.setScale(0.1);
    tools.setScale(0);
    tools.setScale(Number.NaN);
    tools.setTool('line');
    const before = sketch.geometry.filter((e) => e.type === 'point').length;
    tools.click({ x: 10 + 0.1 * 3, y: 10 });
    expect(sketch.geometry.filter((e) => e.type === 'point').length).toBe(before);
  });
});
