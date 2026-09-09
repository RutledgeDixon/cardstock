import type {
  BooleanOp, Bounds, BoxSpec, CylinderSpec, GeometryResult, KernelPort, MassProperties,
  Matrix4, ShapeHandle, SphereSpec, TessellatedBody, TessellationQuality, TopologyCounts,
  BodyId, EntityFingerprint, ShapeDescription,
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
    return { handle };
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
   * Synthetic fingerprints, spread deterministically through the unit cube.
   *
   * Enough to satisfy the interface and drive integration tests. Resolver unit tests
   * build ShapeDescriptions by hand instead, so they can pose the exact ambiguities that
   * matter rather than whatever this happens to generate.
   */
  async describeShape(shape: ShapeHandle): Promise<ShapeDescription> {
    await this.#record('describeShape', this.describe(shape));
    const s = this.#require(shape, 'describeShape');
    const spread = (i: number, n: number) => (n <= 1 ? 0.5 : i / (n - 1));

    const make = (
      kind: EntityFingerprint['kind'], index: number, count: number, type: string,
    ): EntityFingerprint => ({
      kind,
      index,
      geometryType: type,
      centroid: { x: spread(index, count), y: 0, z: 0 },
      centroidNormalised: { x: spread(index, count), y: 0, z: 0 },
      direction: kind === 'vertex' ? null : { x: 1, y: 0, z: 0 },
      measure: 1,
      measureRatio: 1 / Math.max(count, 1),
      neighbourTypes: kind === 'edge' ? ['plane', 'plane'] : [],
    });

    return {
      faces: Array.from({ length: s.faces }, (_, i) => make('face', i, s.faces, 'plane')),
      edges: Array.from({ length: s.edges }, (_, i) => make('edge', i, s.edges, 'line')),
      vertices: Array.from({ length: s.vertices }, (_, i) => make('vertex', i, s.vertices, 'point')),
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

  async release(shape: ShapeHandle): Promise<void> {
    this.calls.push({ op: 'release', detail: this.describe(shape) });
    this.released.push(shape);
    this.#shapes.delete(shape);
  }
}
