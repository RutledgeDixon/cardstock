import type {
  BooleanOp, Bounds, BoxSpec, CylinderSpec, GeometryResult, KernelPort, MassProperties,
  Matrix4, ShapeHandle, SphereSpec, TessellatedBody, TessellationQuality, TopologyCounts,
  BodyId, EntityFingerprint, ShapeDescription, ProfileSpec,
} from '@cardstock/types';
import { KernelError } from '@cardstock/types';

/**
 * An in-memory stand-in for the geometry kernel.
 *
 * This is the reason @cardstock/document is forbidden from importing OCCT: the recompute
 * graph, dirty propagation, caching and topological naming are all logic that can be
 * pinned down exactly in Node, in milliseconds, without WASM. The mock records every
 * call so a test can assert not just the final state but WHICH features rebuilt and in
 * WHAT order — which is the actual contract of an incremental engine.
 *
 * Volumes combine arithmetically (a cut subtracts the tool's full volume regardless of
 * overlap). That is deliberately not physically accurate: it is *predictable*, which is
 * what makes assertions meaningful. Real geometry is Phase 3's job.
 */

interface MockShape {
  readonly volume: number;
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
  readonly description: string;
}

export interface MockCall {
  readonly op: string;
  readonly detail: string;
}

export class MockKernel implements KernelPort {
  readonly calls: MockCall[] = [];
  readonly released: ShapeHandle[] = [];
  #shapes = new Map<string, MockShape>();
  #scopes: ShapeHandle[][] = [];
  #next = 0;
  /** op name -> how many more times it should throw. */
  #failures = new Map<string, number>();
  /** Artificial latency, for testing cancellation. */
  latencyMs = 0;

  // ---------------------------------------------------------------- test controls
  /** Make the next `times` calls to `op` fail. */
  failOn(op: string, times = 1): void {
    this.#failures.set(op, times);
  }

  clearFailures(): void { this.#failures.clear(); }

  reset(): void {
    this.calls.length = 0;
    this.released.length = 0;
    this.#shapes.clear();
    this.#failures.clear();
    this.#next = 0;
  }

  /** Ops in call order — the primary assertion surface for recompute tests. */
  opLog(): string[] { return this.calls.map((c) => c.op); }
  detailLog(): string[] { return this.calls.map((c) => `${c.op}(${c.detail})`); }
  callsTo(op: string): number { return this.calls.filter((c) => c.op === op).length; }

  shape(handle: ShapeHandle): MockShape | undefined { return this.#shapes.get(handle); }
  volumeOf(handle: ShapeHandle): number | undefined { return this.#shapes.get(handle)?.volume; }
  describe(handle: ShapeHandle): string { return this.#shapes.get(handle)?.description ?? '<gone>'; }
  get liveShapes(): number { return this.#shapes.size; }

  /** Is this handle still usable? What a consumer asks before tessellating. */
  hasShape(handle: ShapeHandle): boolean { return this.#shapes.has(handle); }

  // ---------------------------------------------------------------- internals
  async #record(op: string, detail: string): Promise<void> {
    this.calls.push({ op, detail });
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const remaining = this.#failures.get(op);
    if (remaining && remaining > 0) {
      this.#failures.set(op, remaining - 1);
      throw new KernelError(`mock failure in ${op}`, op);
    }
  }

  #create(shape: MockShape): GeometryResult {
    const handle = `mock-${this.#next++}` as ShapeHandle;
    this.#shapes.set(handle, shape);
    this.#scopes[this.#scopes.length - 1]?.push(handle);
    return { handle };
  }

  /**
   * Mirrors the real kernel's allocation scopes, so a test can assert that a feature's
   * intermediates are freed — that is a document-level contract, not an OCCT detail.
   */
  async stats(): Promise<{ shapes: number }> {
    return { shapes: this.#shapes.size };
  }

  async beginScope(): Promise<void> {
    this.calls.push({ op: 'beginScope', detail: '' });
    this.#scopes.push([]);
  }

  async endScope(keep: readonly ShapeHandle[]): Promise<number> {
    const allocated = this.#scopes.pop() ?? [];
    const kept = new Set(keep);
    let freed = 0;
    for (const handle of allocated) {
      if (kept.has(handle)) {
        this.#scopes[this.#scopes.length - 1]?.push(handle);
        continue;
      }
      if (this.#shapes.delete(handle)) { this.released.push(handle); freed++; }
    }
    this.calls.push({ op: 'endScope', detail: `freed ${freed}` });
    return freed;
  }

  #require(handle: ShapeHandle, op: string): MockShape {
    const shape = this.#shapes.get(handle);
    if (!shape) throw new KernelError(`unknown shape handle "${handle}"`, op);
    return shape;
  }

  // ---------------------------------------------------------------- primitives
  async makeBox(spec: BoxSpec): Promise<GeometryResult> {
    await this.#record('makeBox', `${spec.dx}x${spec.dy}x${spec.dz}`);
    return this.#create({
      volume: spec.dx * spec.dy * spec.dz,
      faces: 6, edges: 12, vertices: 8,
      description: `box(${spec.dx}x${spec.dy}x${spec.dz})`,
    });
  }

  async makeCylinder(spec: CylinderSpec): Promise<GeometryResult> {
    await this.#record('makeCylinder', `r${spec.radius}h${spec.height}`);
    return this.#create({
      volume: Math.PI * spec.radius ** 2 * spec.height,
      faces: 3, edges: 3, vertices: 2,
      description: `cyl(r${spec.radius},h${spec.height})`,
    });
  }

  async makeSphere(spec: SphereSpec): Promise<GeometryResult> {
    await this.#record('makeSphere', `r${spec.radius}`);
    return this.#create({
      volume: (4 / 3) * Math.PI * spec.radius ** 3,
      faces: 1, edges: 2, vertices: 2,
      description: `sphere(r${spec.radius})`,
    });
  }

  async makeFace(profile: ProfileSpec): Promise<GeometryResult> {
    await this.#record('makeFace', `${profile.loops.length} loop(s)`);
    if (profile.loops.length === 0) {
      throw new KernelError('a face needs at least one closed loop', 'makeFace');
    }
    // Outer minus holes, which is what the real kernel produces.
    const area = profile.loops.reduce(
      (total, loop, index) => total + (index === 0 ? 1 : -1) * Math.abs(loop.signedArea), 0);
    return this.#create({
      volume: 0, faces: 1,
      edges: profile.loops.reduce((n, l) => n + l.segments.length, 0),
      vertices: profile.loops.reduce((n, l) => n + l.segments.length, 0),
      description: `face(${area.toFixed(2)})`,
    });
  }

  async makePath(profile: ProfileSpec): Promise<GeometryResult> {
    await this.#record('makePath', `${profile.loops[0]?.segments.length ?? 0} segment(s)`);
    const loop = profile.loops[0];
    if (!loop || loop.segments.length === 0) {
      throw new KernelError('a path needs at least one segment', 'makePath');
    }
    return this.#create({
      volume: 0, faces: 0,
      edges: loop.segments.length, vertices: loop.segments.length + 1,
      description: `path(${loop.segments.length})`,
    });
  }

  async extrude(shape: ShapeHandle, distance: number, symmetric = false): Promise<GeometryResult> {
    await this.#record('extrude', `${distance}${symmetric ? ' symmetric' : ''}`);
    const s = this.#require(shape, 'extrude');
    if (distance === 0) throw new KernelError('extrude distance must not be zero', 'extrude');
    if (s.description.startsWith('path(')) {
      throw new KernelError(
        'extrude needs a closed profile — this sketch is an open path', 'extrude',
      );
    }
    // The mock records face area in `description`; recover it to give a plausible volume.
    const area = Number(/face\(([-\d.]+)\)/.exec(s.description)?.[1] ?? 1);
    return this.#create({
      volume: area * Math.abs(distance),
      faces: s.faces + s.edges + 1,
      edges: s.edges * 3,
      vertices: s.vertices * 2,
      description: `extrude(${s.description},${distance})`,
    });
  }

  async revolve(shape: ShapeHandle, _axis: unknown, angle: number): Promise<GeometryResult> {
    await this.#record('revolve', `${angle}deg`);
    const s = this.#require(shape, 'revolve');
    if (angle === 0) throw new KernelError('revolve angle must not be zero', 'revolve');
    const area = Number(/face\(([-\d.]+)\)/.exec(s.description)?.[1] ?? 1);
    return this.#create({
      volume: area * Math.abs(angle) / 360 * 10,
      faces: s.faces + 3, edges: s.edges * 2, vertices: s.vertices * 2,
      description: `revolve(${s.description},${angle})`,
    });
  }

  async sweep(profile: ShapeHandle, path: ShapeHandle): Promise<GeometryResult> {
    await this.#record('sweep', `${this.describe(profile)} along ${this.describe(path)}`);
    const p = this.#require(profile, 'sweep');
    const along = this.#require(path, 'sweep');
    const area = Number(/face\(([-\d.]+)\)/.exec(p.description)?.[1] ?? 1);
    return this.#create({
      // Length is not something the mock can know, so it stands in with the path's own
      // edge count: monotone in the thing that would make a real sweep longer.
      volume: area * Math.max(1, along.edges),
      faces: p.faces + p.edges, edges: p.edges * 3, vertices: p.vertices * 2,
      description: `sweep(${p.description},${along.description})`,
    });
  }

  async loft(
    profiles: readonly ShapeHandle[], options: { ruled?: boolean } = {},
  ): Promise<GeometryResult> {
    await this.#record('loft', profiles.map((h) => this.describe(h)).join(','));
    if (profiles.length < 2) {
      throw new KernelError('a loft needs at least two profiles', 'loft');
    }
    const sections = profiles.map((h) => this.#require(h, 'loft'));
    const areas = sections.map(
      (s) => Number(/face\(([-\d.]+)\)/.exec(s.description)?.[1] ?? 1),
    );
    return this.#create({
      // Average section area over a unit run between each pair: the prismatoid rule
      // without the geometry, which keeps the volume monotone in the sections.
      volume: areas.slice(1).reduce((sum, a, i) => sum + (a + areas[i]!) / 2, 0),
      faces: sections.reduce((n, s) => n + s.edges, 0) + 2,
      edges: sections.reduce((n, s) => n + s.edges * 2, 0),
      vertices: sections.reduce((n, s) => n + s.vertices, 0),
      description: `loft(${sections.map((s) => s.description).join(',')}${options.ruled ? ',ruled' : ''})`,
    });
  }

  async draft(
    shape: ShapeHandle, faces: readonly number[], angle: number,
    _pull: unknown, _neutralPlane: unknown,
  ): Promise<GeometryResult> {
    await this.#record('draft', `${angle}deg on [${faces.join(',')}]`);
    const s = this.#require(shape, 'draft');
    if (angle === 0) throw new KernelError('draft angle must not be zero', 'draft');
    for (const index of faces) {
      if (index >= s.faces) {
        throw new KernelError(
          `face ${index} does not exist (shape has ${s.faces})`, 'draft',
        );
      }
    }
    return this.#create({
      // Tapering removes a wedge; the sign follows the angle so an inward draft shrinks.
      volume: s.volume * (1 - Math.tan((angle * Math.PI) / 180) * 0.1 * faces.length),
      faces: s.faces, edges: s.edges, vertices: s.vertices,
      description: `draft(${s.description},${angle})`,
    });
  }

  async transformMany(
    shape: ShapeHandle, matrices: readonly Matrix4[],
  ): Promise<GeometryResult[]> {
    await this.#record('transformMany', `${matrices.length}`);
    const out: GeometryResult[] = [];
    for (const matrix of matrices) out.push(await this.transform(shape, matrix));
    return out;
  }

  async booleanMany(
    op: BooleanOp, base: ShapeHandle, tools: readonly ShapeHandle[],
  ): Promise<GeometryResult> {
    await this.#record(`${op}Many`, `${tools.length} tool(s)`);
    if (tools.length === 0) return { handle: base };
    let result: GeometryResult = { handle: base };
    for (const tool of tools) result = await this.boolean(op, result.handle, tool);
    return result;
  }

  async compound(shapes: readonly ShapeHandle[]): Promise<GeometryResult> {
    await this.#record('compound', `${shapes.length} shape(s)`);
    if (shapes.length === 0) throw new KernelError('nothing to combine', 'compound');
    if (shapes.length === 1) return { handle: shapes[0]! };
    const parts = shapes.map((h) => this.#require(h, 'compound'));
    return this.#create({
      volume: parts.reduce((v, p) => v + p.volume, 0),
      faces: parts.reduce((n, p) => n + p.faces, 0),
      edges: parts.reduce((n, p) => n + p.edges, 0),
      vertices: parts.reduce((n, p) => n + p.vertices, 0),
      description: `compound(${parts.map((p) => p.description).join(',')})`,
    });
  }

  async shell(
    shape: ShapeHandle, openFaces: readonly number[], thickness: number,
  ): Promise<GeometryResult> {
    await this.#record('shell', `t${thickness} open [${openFaces.join(',')}]`);
    const s = this.#require(shape, 'shell');
    if (thickness === 0) throw new KernelError('shell thickness must not be zero', 'shell');
    for (const index of openFaces) {
      if (index >= s.faces) {
        throw new KernelError(
          `face ${index} does not exist (shape has ${s.faces})`, 'shell',
        );
      }
    }
    return this.#create({
      // A shell keeps a wall of the given thickness: a plausible, monotone stand-in.
      volume: s.volume * Math.min(0.9, Math.abs(thickness) / 10),
      faces: s.faces * 2 - openFaces.length,
      edges: s.edges * 2, vertices: s.vertices * 2,
      description: `shell(${s.description},${thickness})`,
    });
  }

  async mirror(shape: ShapeHandle, _plane: unknown): Promise<GeometryResult> {
    await this.#record('mirror', this.describe(shape));
    const s = this.#require(shape, 'mirror');
    return { ...this.#create({ ...s, description: `mirrored(${s.description})` }) };
  }

  // ---------------------------------------------------------------- operations
  async boolean(op: BooleanOp, base: ShapeHandle, tool: ShapeHandle): Promise<GeometryResult> {
    await this.#record(op, `${this.describe(base)},${this.describe(tool)}`);
    const a = this.#require(base, op);
    const b = this.#require(tool, op);
    const volume = op === 'union' ? a.volume + b.volume
      : op === 'cut' ? a.volume - b.volume
      : Math.min(a.volume, b.volume);
    return this.#create({
      volume,
      faces: op === 'cut' ? a.faces + b.faces - 1 : a.faces + b.faces - 2,
      edges: a.edges + b.edges,
      vertices: a.vertices + b.vertices,
      description: `${op}(${a.description},${b.description})`,
    });
  }

  async fillet(shape: ShapeHandle, edges: readonly number[], radius: number): Promise<GeometryResult> {
    await this.#record('fillet', `r${radius} on [${edges.join(',')}]`);
    const s = this.#require(shape, 'fillet');
    if (radius <= 0) throw new KernelError('fillet radius must be positive', 'fillet');
    return this.#create({
      // A fillet removes a deterministic sliver; the exact figure is not meaningful,
      // only that it is stable and smaller.
      volume: s.volume - radius ** 2 * edges.length,
      faces: s.faces + edges.length,
      edges: s.edges + edges.length,
      vertices: s.vertices,
      description: `fillet(${s.description},r${radius},[${edges.join(',')}])`,
    });
  }

  async chamfer(shape: ShapeHandle, edges: readonly number[], distance: number): Promise<GeometryResult> {
    await this.#record('chamfer', `d${distance} on [${edges.join(',')}]`);
    const s = this.#require(shape, 'chamfer');
    if (distance <= 0) throw new KernelError('chamfer distance must be positive', 'chamfer');
    return this.#create({
      volume: s.volume - distance ** 2 * edges.length * 0.5,
      faces: s.faces + edges.length,
      edges: s.edges + edges.length,
      vertices: s.vertices,
      description: `chamfer(${s.description},d${distance})`,
    });
  }

  async transform(shape: ShapeHandle, matrix: Matrix4): Promise<GeometryResult> {
    await this.#record('transform', `[${matrix[12]},${matrix[13]},${matrix[14]}]`);
    const s = this.#require(shape, 'transform');
    return this.#create({ ...s, description: `moved(${s.description})` });
  }

  // ---------------------------------------------------------------- queries
  async tessellate(
    shape: ShapeHandle, bodyId: BodyId, _quality: TessellationQuality,
  ): Promise<TessellatedBody> {
    await this.#record('tessellate', this.describe(shape));
    const s = this.#require(shape, 'tessellate');
    const empty = new Float32Array(0);
    return {
      bodyId,
      positions: empty, normals: empty,
      indices: new Uint32Array(0), triangleFaceId: new Uint32Array(0),
      vertexFaceId: empty, faceCount: s.faces,
      edgePositions: empty, edgeSegmentId: new Uint32Array(0), edgeCount: s.edges,
      vertexPositions: empty, vertexCount: s.vertices,
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    };
  }

  /**
   * Synthetic fingerprints.
   *
   * Deliberately a function of the entity INDEX alone, never of how many entities the
   * shape has: a reference to edge 3 then resolves to edge 3 in any mock shape that has
   * one, which keeps recompute tests about the graph rather than about fingerprint
   * arithmetic. Resolver unit tests build ShapeDescriptions by hand instead, so they can
   * pose the exact ambiguities that matter.
   */
  async describeShape(shape: ShapeHandle): Promise<ShapeDescription> {
    await this.#record('describeShape', this.describe(shape));
    const s = this.#require(shape, 'describeShape');
    return {
      faces: Array.from({ length: s.faces }, (_, i) => mockFingerprint('face', i)),
      edges: Array.from({ length: s.edges }, (_, i) => mockFingerprint('edge', i)),
      vertices: Array.from({ length: s.vertices }, (_, i) => mockFingerprint('vertex', i)),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    };
  }

  async massProperties(shape: ShapeHandle): Promise<MassProperties> {
    await this.#record('massProperties', this.describe(shape));
    const s = this.#require(shape, 'massProperties');
    return { volume: s.volume, surfaceArea: s.faces * 10, centreOfMass: { x: 0, y: 0, z: 0 } };
  }

  async boundingBox(shape: ShapeHandle): Promise<Bounds> {
    await this.#record('boundingBox', this.describe(shape));
    this.#require(shape, 'boundingBox');
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  }

  async topologyCounts(shape: ShapeHandle): Promise<TopologyCounts> {
    await this.#record('topologyCounts', this.describe(shape));
    const s = this.#require(shape, 'topologyCounts');
    return { faces: s.faces, edges: s.edges, vertices: s.vertices };
  }

  async exportStl(shape: ShapeHandle): Promise<Uint8Array> {
    await this.#record('exportStl', this.describe(shape));
    const s = this.#require(shape, 'exportStl');
    // A plausible binary STL header plus a triangle count, so callers can assert shape
    // without the mock pretending to do geometry.
    const bytes = new Uint8Array(84);
    new DataView(bytes.buffer).setUint32(80, s.faces * 2, true);
    return bytes;
  }

  async release(shape: ShapeHandle): Promise<void> {
    this.calls.push({ op: 'release', detail: this.describe(shape) });
    this.released.push(shape);
    this.#shapes.delete(shape);
  }
}

/** The fingerprint MockKernel generates for a given entity. Exported so tests can mint
 *  references that resolve against it. */
export function mockFingerprint(
  kind: EntityFingerprint['kind'],
  index: number,
): EntityFingerprint {
  // Spread indices around the unit cube so neighbours are distinguishable, and vary the
  // direction so opposite entities do not collide.
  const t = (index % 16) / 16;
  return {
    kind,
    index,
    geometryType: kind === 'face' ? 'plane' : kind === 'edge' ? 'line' : 'point',
    centroid: { x: t, y: (index % 4) / 4, z: (index % 3) / 3 },
    centroidNormalised: { x: t, y: (index % 4) / 4, z: (index % 3) / 3 },
    direction: kind === 'vertex' ? null : { x: 0, y: 0, z: 1 },
    measure: 1,
    measureRatio: 0.1,
    neighbourTypes: kind === 'edge' ? ['plane', 'plane'] : [],
  };
}

/** A TopoRef that resolves to `index` against any MockKernel shape that has one. */
export function mockTopoRef(
  featureId: string,
  kind: EntityFingerprint['kind'],
  index: number,
): {
  kind: EntityFingerprint['kind'];
  origin: { featureId: string; index: number };
  fingerprint: EntityFingerprint;
} {
  return { kind, origin: { featureId, index }, fingerprint: mockFingerprint(kind, index) };
}
