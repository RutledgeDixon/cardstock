import { describe, expect, it } from 'vitest';
import { Sketch } from './sketch.js';
import { faceExternals, originPlaneExternals, projectToPlane } from './external.js';

const xy = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xAxis: { x: 1, y: 0, z: 0 } };

describe('external geometry', () => {
  it('projects into the plane frame', () => {
    const tilted = { origin: { x: 10, y: 0, z: 5 }, normal: { x: 0, y: -1, z: 0 }, xAxis: { x: 1, y: 0, z: 0 } };
    // normal × x = (0,-1,0) × (1,0,0) = (0, 0, 1): plane Y is world Z.
    expect(projectToPlane({ x: 13, y: 0, z: 9 }, tilted)).toEqual({ x: 3, y: 4 });
  });

  it('shares corners between adjacent edges and keeps arcs and circles apart', () => {
    const items = faceExternals({ edges: [
      { kind: 'line', from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 } },
      { kind: 'line', from: { x: 10, y: 0, z: 0 }, to: { x: 10, y: 10, z: 0 } },
      { kind: 'circle', centre: { x: 20, y: 20, z: 0 }, radius: 3, from: { x: 23, y: 20, z: 0 }, to: { x: 23, y: 20, z: 0 }, closed: true },
    ] }, xy);
    const points = items.filter((i) => i.kind === 'point');
    expect(points).toHaveLength(3); // (0,0), (10,0) shared, (10,10)
    expect(items.filter((i) => i.kind === 'line')).toHaveLength(2);
    expect(items.find((i) => i.kind === 'circle')).toMatchObject({ key: 'edge:2', radius: 3 });
  });

  it('syncs into a sketch as fixed construction geometry, moves on update, and goes away when gone', () => {
    const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
    sketch.syncExternal(originPlaneExternals());
    const externals = () => sketch.geometry.filter((e) => e.external);
    expect(externals().map((e) => e.type).sort()).toEqual(['line', 'line', 'point', 'point', 'point', 'point']);
    expect(externals().every((e) => e.type !== 'point' ? e.construction : e.fixed)).toBe(true);
    const before = externals().map((e) => e.id);

    // The same keys again: same entities, no duplicates.
    sketch.syncExternal(originPlaneExternals());
    expect(externals().map((e) => e.id)).toEqual(before);

    // A moved corner moves the point; a constraint on it survives.
    const items = faceExternals({ edges: [{ kind: 'line', from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 } }] }, xy);
    sketch.syncExternal(items);
    const corner = sketch.geometry.find((e) => e.external === 'corner:0b')!;
    const mine = sketch.addPoint(9, 1);
    sketch.addConstraint({ type: 'coincident', a: mine, b: corner.id });
    sketch.syncExternal(faceExternals({ edges: [{ kind: 'line', from: { x: 0, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 } }] }, xy));
    expect(sketch.entity(corner.id)).toMatchObject({ x: 20, y: 0 });
    expect(sketch.constraints).toHaveLength(1);

    // Gone from outside: the point and its constraint go too.
    sketch.syncExternal([]);
    expect(externals()).toHaveLength(0);
    expect(sketch.constraints).toHaveLength(0);
  });
});
