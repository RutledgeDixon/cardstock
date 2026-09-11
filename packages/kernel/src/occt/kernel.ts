import type { OpenCascadeInstance, TopoDS_Shape } from 'replicad-opencascadejs';
import {
  type BooleanOp, type Bounds, type BoxSpec, type CylinderSpec, type GeometryResult,
  type KernelPort, type MassProperties, type Matrix4, type ShapeHandle, type SphereSpec,
  type TessellatedBody, type TessellationQuality, type TopologyCounts, type BodyId,
  type ShapeDescription, type ProfileSpec, type Vec3,
  type ExportFormat, type ExportOptions, type ExportResult, type MeshStats,
  type OrientationOptions, type OrientationSuggestion, type FaceOutline,
  KernelError, EXPORT_QUALITY,
} from '@cardstock/types';
import {
  weld, triangleCount, isWatertight, encodeStlBinary, encodeStlAscii, encodeObj, encode3mf,
  scoreOrientations, type ExportMesh,
} from '../export/index.js';
import { ShapeRegistry } from './registry.js';
import { asWire, subShapes } from './topology.js';
import { captureHistory } from './history.js';
import { tessellate } from '../tessellate/tessellate.js';
import { describeShape } from './describe.js';
import { faceOutline } from './outline.js';
import { makeFace, makePath } from './profile.js';

/**
 * KernelPort over OpenCascade.
 *
 * Runs unchanged in Node and inside a Web Worker, which is deliberate: it means the real
 * geometry can be golden-tested headlessly, without a browser, a worker, or a bundler.
 */
export class OcctKernel implements KernelPort {
  readonly registry = new ShapeRegistry();

  constructor(private readonly oc: OpenCascadeInstance) {}

  // ---------------------------------------------------------------- helpers
  #point(v?: { x: number; y: number; z: number }) {
    return new this.oc.gp_Pnt(v?.x ?? 0, v?.y ?? 0, v?.z ?? 0);
  }

  #wrap(shape: TopoDS_Shape): ShapeHandle {
    return this.registry.add(shape);
  }

  /**
   * How many shapes are live inside the kernel.
   *
   * Worth surfacing because it is an invisible failure mode: OCCT objects are manually
   * managed, so a leak shows up as a shape count that climbs and never settles, long
   * before the tab runs out of memory. Under a scrubbed dimension this should plateau at
   * the document's cache limit.
   *
   * The WASM heap size is deliberately NOT reported: this build exposes neither HEAP8
   * nor wasmMemory on the module, and a number that is always zero is worse than no
   * number at all.
   */
  async stats(): Promise<{ shapes: number }> {
    return { shapes: this.registry.size };
  }

  async beginScope(): Promise<void> { this.registry.beginScope(); }

  async endScope(keep: readonly ShapeHandle[]): Promise<number> {
    return this.registry.endScope(keep);
  }

  /** Run a builder to completion and surface OCCT's own failure as a KernelError. */
  #build(builder: { Build(range: unknown): void; Shape(): TopoDS_Shape }, op: string): TopoDS_Shape {
    try {
      builder.Build(new this.oc.Message_ProgressRange());
      return builder.Shape();
    } catch (e) {
      throw new KernelError(describeOcctError(this.oc, e, op), op);
    }
  }

  // ---------------------------------------------------------------- primitives
  async makeBox(spec: BoxSpec): Promise<GeometryResult> {
    if (spec.dx <= 0 || spec.dy <= 0 || spec.dz <= 0) {
      throw new KernelError('box dimensions must be positive', 'makeBox');
    }
    const corner = this.#point(spec.origin);
    const maker = new this.oc.BRepPrimAPI_MakeBox(corner, spec.dx, spec.dy, spec.dz);
    return { handle: this.#wrap(maker.Shape()) };
  }

  async makeCylinder(spec: CylinderSpec): Promise<GeometryResult> {
    if (spec.radius <= 0 || spec.height <= 0) {
      throw new KernelError('cylinder radius and height must be positive', 'makeCylinder');
    }
    const axis = new this.oc.gp_Ax2(
      this.#point(spec.origin),
      new this.oc.gp_Dir(spec.axis?.x ?? 0, spec.axis?.y ?? 0, spec.axis?.z ?? 1),
    );
    const maker = new this.oc.BRepPrimAPI_MakeCylinder(axis, spec.radius, spec.height);
    return { handle: this.#wrap(maker.Shape()) };
  }

  async makeSphere(spec: SphereSpec): Promise<GeometryResult> {
    if (spec.radius <= 0) throw new KernelError('sphere radius must be positive', 'makeSphere');
    const maker = new this.oc.BRepPrimAPI_MakeSphere(this.#point(spec.origin), spec.radius);
    return { handle: this.#wrap(maker.Shape()) };
  }

  // ---------------------------------------------------------------- profiles
  async makeFace(profile: ProfileSpec): Promise<GeometryResult> {
    return { handle: this.#wrap(makeFace(this.oc, profile)) };
  }

  async makePath(profile: ProfileSpec): Promise<GeometryResult> {
    return { handle: this.#wrap(makePath(this.oc, profile)) };
  }

  /**
   * Sweep a face along its own normal.
   *
   * The direction comes from the face rather than being passed in, so an extrude cannot
   * end up skewed relative to the sketch it came from.
   */
  async extrude(shape: ShapeHandle, distance: number, symmetric = false): Promise<GeometryResult> {
    if (distance === 0) throw new KernelError('extrude distance must not be zero', 'extrude');
    let input = this.registry.get(shape);

    const normal = faceNormal(this.oc, input);
    if (!normal) {
      // Naming the likely cause matters: the usual way to get here is an open sketch,
      // which builds happily as a sweep path and only fails when something tries to
      // extrude it.
      const open = input.ShapeType() === this.oc.TopAbs_ShapeEnum.TopAbs_WIRE
        || input.ShapeType() === this.oc.TopAbs_ShapeEnum.TopAbs_EDGE;
      throw new KernelError(
        open
          ? 'extrude needs a closed profile — this sketch is an open path'
          : 'extrude needs a planar face',
        'extrude',
      );
    }

    if (symmetric) {
      // Start half a depth back, so the solid straddles the sketch plane.
      const back = new this.oc.gp_Trsf();
      back.SetTranslation(new this.oc.gp_Vec(
        -normal.x * distance / 2, -normal.y * distance / 2, -normal.z * distance / 2,
      ));
      input = new this.oc.BRepBuilderAPI_Transform(input, back, true).Shape();
    }

    const vector = new this.oc.gp_Vec(
      normal.x * distance, normal.y * distance, normal.z * distance,
    );
    const builder = new this.oc.BRepPrimAPI_MakePrism(input, vector, false, true);
    const result = builder.Shape();
    const history = captureHistory(this.oc, builder, [input], result);
    return { handle: this.#wrap(result), history };
  }

  async revolve(
    shape: ShapeHandle,
    axis: { origin: Vec3; direction: Vec3 },
    angle: number,
  ): Promise<GeometryResult> {
    if (angle === 0) throw new KernelError('revolve angle must not be zero', 'revolve');
    if (Math.abs(angle) > 360) {
      throw new KernelError('revolve angle cannot exceed 360 degrees', 'revolve');
    }
    const input = this.registry.get(shape);
    const gpAxis = new this.oc.gp_Ax1(
      new this.oc.gp_Pnt(axis.origin.x, axis.origin.y, axis.origin.z),
      new this.oc.gp_Dir(axis.direction.x, axis.direction.y, axis.direction.z),
    );
    const builder = new this.oc.BRepPrimAPI_MakeRevol(
      input, gpAxis, (angle * Math.PI) / 180, true,
    );
    const result = builder.Shape();
    const history = captureHistory(this.oc, builder, [input], result);
    return { handle: this.#wrap(result), history };
  }

  /**
   * Sweep a profile along a path.
   *
   * The path is taken as a wire from whatever shape is handed in — a sketch comes
   * through as a face, a datum as an edge — so a path sketch does not have to be
   * prepared differently from a profile sketch.
   */
  async sweep(profile: ShapeHandle, path: ShapeHandle): Promise<GeometryResult> {
    const face = this.registry.get(profile);
    const spine = asWire(this.oc, this.registry.get(path));
    if (!spine) throw new KernelError('the sweep path has no edges to follow', 'sweep');

    // The section must be a WIRE. MakePipeShell.Add rejects a face with
    // "BRepFill_Section: bad shape type of section", and sketches arrive as faces.
    const section = asWire(this.oc, face);
    if (!section) throw new KernelError('the sweep profile has no boundary', 'sweep');

    // MakePipe, the obvious choice, requires a G1-continuous spine and silently sweeps
    // only up to the first corner otherwise — a bent path came back as one straight leg,
    // the right volume for one leg, and no error at all. MakePipeShell handles corners,
    // given a transition mode.
    let builder;
    try {
      builder = new this.oc.BRepOffsetAPI_MakePipeShell(this.oc.TopoDS.Wire(spine));
      builder.SetTransitionMode(
        this.oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner,
      );
      // WithContact is FALSE deliberately: it translates the profile until it touches
      // the spine, which moved a section centred on a path of radius 20 out to 21 and
      // quietly changed the swept volume. The profile stays where it was drawn.
      builder.Add(section, false, false);
    } catch (e) {
      throw new KernelError(describeOcctError(this.oc, e, 'sweep'), 'sweep');
    }

    // Build() makes the shell; MakeSolid caps the ends. Its result is discarded because
    // Shape() is what changes, not the return value.
    this.#build(builder as never, 'sweep');
    if (!builder.MakeSolid()) {
      throw new KernelError('the sweep did not close into a solid', 'sweep');
    }
    const result = builder.Shape();
    const history = captureHistory(this.oc, builder as never, [face], result);
    return { handle: this.#wrap(result), history };
  }

  /**
   * Blend a run of profiles into one solid.
   *
   * `ruled` joins the sections with straight surfaces instead of a smooth approximation,
   * which is what you want when the shape is meant to have creases rather than curves.
   */
  async loft(
    profiles: readonly ShapeHandle[],
    options: { ruled?: boolean } = {},
  ): Promise<GeometryResult> {
    if (profiles.length < 2) {
      throw new KernelError('a loft needs at least two profiles', 'loft');
    }
    const shapes = profiles.map((p) => this.registry.get(p));
    const builder = new this.oc.BRepOffsetAPI_ThruSections(
      true, options.ruled ?? false, 1e-6,
    );
    for (const [index, shape] of shapes.entries()) {
      const wire = asWire(this.oc, shape);
      if (!wire) throw new KernelError(`loft profile ${index} has no boundary`, 'loft');
      builder.AddWire(this.oc.TopoDS.Wire(wire));
    }
    const result = this.#build(builder as never, 'loft');
    const history = captureHistory(this.oc, builder as never, shapes, result);
    return { handle: this.#wrap(result), history };
  }

  /**
   * Taper faces away from a neutral plane.
   *
   * OCCT reports a failed face through `AddDone()` rather than by throwing, and leaves
   * the algorithm in a state where Build() raises instead — so each face is checked as
   * it goes in and named in the error, which is the only way to say *which* face could
   * not be tapered.
   */
  async draft(
    shape: ShapeHandle,
    faces: readonly number[],
    angle: number,
    pull: Vec3,
    neutralPlane: { origin: Vec3; normal: Vec3 },
  ): Promise<GeometryResult> {
    if (angle === 0) throw new KernelError('draft angle must not be zero', 'draft');
    const input = this.registry.get(shape);
    const all = subShapes(this.oc, input, 'TopAbs_FACE');

    const builder = new this.oc.BRepOffsetAPI_DraftAngle(input);
    const direction = new this.oc.gp_Dir(pull.x, pull.y, pull.z);
    const plane = new this.oc.gp_Pln(
      new this.oc.gp_Pnt(neutralPlane.origin.x, neutralPlane.origin.y, neutralPlane.origin.z),
      new this.oc.gp_Dir(neutralPlane.normal.x, neutralPlane.normal.y, neutralPlane.normal.z),
    );

    for (const index of faces) {
      const face = all[index];
      if (!face) {
        throw new KernelError(
          `face ${index} does not exist (shape has ${all.length})`, 'draft',
        );
      }
      try {
        builder.Add(
          this.oc.TopoDS.Face(face), direction, (angle * Math.PI) / 180, plane, true,
        );
      } catch (e) {
        throw new KernelError(describeOcctError(this.oc, e, 'draft'), 'draft');
      }
      if (!builder.AddDone()) {
        throw new KernelError(
          `face ${index} cannot be drafted — only planar, cylindrical and conical faces can`,
          'draft',
        );
      }
    }

    const result = this.#build(builder as never, 'draft');
    const history = captureHistory(this.oc, builder as never, [input], result);
    return { handle: this.#wrap(result), history };
  }

  async shell(
    shape: ShapeHandle,
    openFaces: readonly number[],
    thickness: number,
  ): Promise<GeometryResult> {
    if (thickness === 0) throw new KernelError('shell thickness must not be zero', 'shell');
    const input = this.registry.get(shape);
    const faces = subShapes(this.oc, input, 'TopAbs_FACE');

    // TopTools_ListOfShape is not bound in this build; the NCollection template name is
    // (ADR-0001). Overloads dispatch by arity, so there are no _N suffixes either.
    const toRemove = new this.oc.NCollection_List_TopoDS_Shape();
    for (const index of openFaces) {
      const face = faces[index];
      if (!face) {
        throw new KernelError(
          `face ${index} does not exist (shape has ${faces.length})`, 'shell',
        );
      }
      toRemove.Append(face);
    }

    const builder = new this.oc.BRepOffsetAPI_MakeThickSolid();
    // MakeThickSolidByJoin can throw before Build() ever runs — an offset that would
    // self-intersect fails right here — so it needs the same wrapping as Build().
    try {
      builder.MakeThickSolidByJoin(
        input, toRemove, thickness, 1e-6,
        this.oc.BRepOffset_Mode.BRepOffset_Skin, false, false,
        this.oc.GeomAbs_JoinType.GeomAbs_Arc, false,
        new this.oc.Message_ProgressRange(),
      );
    } catch (e) {
      throw new KernelError(describeOcctError(this.oc, e, 'shell'), 'shell');
    }
    const result = this.#build(builder as never, 'shell');
    const history = captureHistory(this.oc, builder as never, [input], result);
    return { handle: this.#wrap(result), history };
  }

  async mirror(
    shape: ShapeHandle,
    plane: { origin: Vec3; normal: Vec3 },
  ): Promise<GeometryResult> {
    const input = this.registry.get(shape);
    const trsf = new this.oc.gp_Trsf();
    trsf.SetMirror(new this.oc.gp_Ax2(
      new this.oc.gp_Pnt(plane.origin.x, plane.origin.y, plane.origin.z),
      new this.oc.gp_Dir(plane.normal.x, plane.normal.y, plane.normal.z),
    ));
    const builder = new this.oc.BRepBuilderAPI_Transform(input, trsf, true);
    return { handle: this.#wrap(builder.Shape()) };
  }

  // ---------------------------------------------------------------- operations
  async boolean(op: BooleanOp, base: ShapeHandle, tool: ShapeHandle): Promise<GeometryResult> {
    const a = this.registry.get(base);
    const b = this.registry.get(tool);
    const builder =
      op === 'union' ? new this.oc.BRepAlgoAPI_Fuse(a, b)
      : op === 'cut' ? new this.oc.BRepAlgoAPI_Cut(a, b)
      : new this.oc.BRepAlgoAPI_Common(a, b);
    const shape = this.#build(builder, op);
    const history = captureHistory(this.oc, builder, [a, b], shape);
    return { handle: this.#wrap(shape), history };
  }

  /**
   * One boolean over many tools at once.
   *
   * N sequential pairwise booleans is O(n^2) and ruinously so in practice: fusing a
   * 150-copy pattern one union at a time took two minutes, because each fuse re-solved
   * the intersection graph of everything already fused. OCCT's multi-argument form
   * builds that graph once — the same result, in a fraction of the time.
   */
  /**
   * Apply several transforms to one shape in a single call.
   *
   * The kernel lives behind a worker, so a pattern that placed its copies one at a time
   * cost one round trip per copy — 99 messages for a 100-copy pattern, before any
   * geometry was built. The work itself is trivial; the crossing is not.
   */
  async transformMany(
    shape: ShapeHandle, matrices: readonly Matrix4[],
  ): Promise<GeometryResult[]> {
    const results: GeometryResult[] = [];
    for (const matrix of matrices) results.push(await this.transform(shape, matrix));
    return results;
  }

  async booleanMany(
    op: BooleanOp, base: ShapeHandle, tools: readonly ShapeHandle[],
  ): Promise<GeometryResult> {
    if (tools.length === 0) return { handle: base };
    if (tools.length === 1) return this.boolean(op, base, tools[0]!);

    const a = this.registry.get(base);
    const shapes = tools.map((t) => this.registry.get(t));

    const builder =
      op === 'union' ? new this.oc.BRepAlgoAPI_Fuse()
      : op === 'cut' ? new this.oc.BRepAlgoAPI_Cut()
      : new this.oc.BRepAlgoAPI_Common();

    const args = new this.oc.NCollection_List_TopoDS_Shape();
    args.Append(a);
    builder.SetArguments(args);

    const toolList = new this.oc.NCollection_List_TopoDS_Shape();
    for (const shape of shapes) toolList.Append(shape);
    builder.SetTools(toolList);

    const shape = this.#build(builder as never, op);
    const history = captureHistory(this.oc, builder as never, [a, ...shapes], shape);
    return { handle: this.#wrap(shape), history };
  }

  async fillet(
    shape: ShapeHandle, edges: readonly number[], radius: number,
  ): Promise<GeometryResult> {
    if (radius <= 0) throw new KernelError('fillet radius must be positive', 'fillet');
    if (edges.length === 0) throw new KernelError('fillet needs at least one edge', 'fillet');
    const input = this.registry.get(shape);
    const allEdges = subShapes(this.oc, input, 'TopAbs_EDGE');

    const builder = new this.oc.BRepFilletAPI_MakeFillet(
      input, this.oc.ChFi3d_FilletShape.ChFi3d_Rational,
    );
    for (const index of edges) {
      const edge = allEdges[index];
      if (!edge) {
        throw new KernelError(
          `edge ${index} does not exist (shape has ${allEdges.length})`, 'fillet',
        );
      }
      builder.Add(radius, this.oc.TopoDS.Edge(edge));
    }
    const result = this.#build(builder, 'fillet');
    const history = captureHistory(this.oc, builder, [input], result);
    return { handle: this.#wrap(result), history };
  }

  async chamfer(
    shape: ShapeHandle, edges: readonly number[], distance: number,
  ): Promise<GeometryResult> {
    if (distance <= 0) throw new KernelError('chamfer distance must be positive', 'chamfer');
    if (edges.length === 0) throw new KernelError('chamfer needs at least one edge', 'chamfer');
    const input = this.registry.get(shape);
    const allEdges = subShapes(this.oc, input, 'TopAbs_EDGE');

    const builder = new this.oc.BRepFilletAPI_MakeChamfer(input);
    for (const index of edges) {
      const edge = allEdges[index];
      if (!edge) {
        throw new KernelError(
          `edge ${index} does not exist (shape has ${allEdges.length})`, 'chamfer',
        );
      }
      builder.Add(distance, this.oc.TopoDS.Edge(edge));
    }
    const result = this.#build(builder, 'chamfer');
    const history = captureHistory(this.oc, builder, [input], result);
    return { handle: this.#wrap(result), history };
  }

  async transform(shape: ShapeHandle, matrix: Matrix4): Promise<GeometryResult> {
    const input = this.registry.get(shape);
    const trsf = new this.oc.gp_Trsf();
    // Matrix4 is column-major; SetValues takes row-major 3x4.
    trsf.SetValues(
      matrix[0]!, matrix[4]!, matrix[8]!, matrix[12]!,
      matrix[1]!, matrix[5]!, matrix[9]!, matrix[13]!,
      matrix[2]!, matrix[6]!, matrix[10]!, matrix[14]!,
    );
    const builder = new this.oc.BRepBuilderAPI_Transform(input, trsf, true);
    const result = builder.Shape();
    return { handle: this.#wrap(result) };
  }

  // ---------------------------------------------------------------- queries
  async tessellate(
    shape: ShapeHandle, bodyId: BodyId, quality: TessellationQuality,
  ): Promise<TessellatedBody> {
    return tessellate(this.oc, this.registry.get(shape), bodyId, quality);
  }

  async massProperties(shape: ShapeHandle): Promise<MassProperties> {
    const input = this.registry.get(shape);
    const volumeProps = new this.oc.GProp_GProps();
    this.oc.BRepGProp.VolumeProperties(input, volumeProps, false, false, false);
    const surfaceProps = new this.oc.GProp_GProps();
    this.oc.BRepGProp.SurfaceProperties(input, surfaceProps, false, false);
    const centre = volumeProps.CentreOfMass();
    const result: MassProperties = {
      volume: volumeProps.Mass(),
      surfaceArea: surfaceProps.Mass(),
      centreOfMass: { x: centre.X(), y: centre.Y(), z: centre.Z() },
    };
    volumeProps.delete();
    surfaceProps.delete();
    return result;
  }

  async describeShape(shape: ShapeHandle): Promise<ShapeDescription> {
    return describeShape(this.oc, this.registry.get(shape));
  }

  async faceOutline(shape: ShapeHandle, faceIndex: number): Promise<FaceOutline> {
    return faceOutline(this.oc, this.registry.get(shape), faceIndex);
  }

  async boundingBox(shape: ShapeHandle): Promise<Bounds> {
    const input = this.registry.get(shape);
    const box = new this.oc.Bnd_Box();
    this.oc.BRepBndLib.Add(input, box, true);
    // Bnd_Box carries a tolerance gap by default, which would report a 40mm box as
    // very slightly larger than 40mm. Zero it so bounds mean what they say.
    box.SetGap(0);
    if (box.IsVoid()) {
      box.delete();
      return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    }
    const low = box.CornerMin();
    const high = box.CornerMax();
    const bounds: Bounds = {
      min: { x: low.X(), y: low.Y(), z: low.Z() },
      max: { x: high.X(), y: high.Y(), z: high.Z() },
    };
    box.delete();
    return bounds;
  }

  async topologyCounts(shape: ShapeHandle): Promise<TopologyCounts> {
    const input = this.registry.get(shape);
    return {
      faces: subShapes(this.oc, input, 'TopAbs_FACE').length,
      edges: subShapes(this.oc, input, 'TopAbs_EDGE').length,
      vertices: subShapes(this.oc, input, 'TopAbs_VERTEX').length,
    };
  }

  /**
   * Encode as STL.
   *
   * Re-tessellates at EXPORT quality rather than reusing the display mesh: the screen
   * only needs to look right, a printed part needs to be right. OCCT writes through the
   * emscripten virtual filesystem, so the file is written, read back and unlinked.
   */
  /**
   * Gather several shapes into one, without fusing them.
   *
   * Export needs this: a part on the plate may be several separate bodies, and exporting
   * only the last one is a silently wrong file. A compound keeps them distinct — fusing
   * would change the geometry of bodies that merely touch — and a slicer is happy to
   * take several shells in one STL.
   */
  async compound(shapes: readonly ShapeHandle[]): Promise<GeometryResult> {
    if (shapes.length === 0) throw new KernelError('nothing to combine', 'compound');
    if (shapes.length === 1) return { handle: shapes[0]! };

    // TopoDS_Builder is the constructible one in this build; BRep_Builder is not bound.
    const builder = new this.oc.TopoDS_Builder();
    const compound = new this.oc.TopoDS_Compound();
    builder.MakeCompound(compound);
    for (const handle of shapes) builder.Add(compound, this.registry.get(handle));
    return { handle: this.#wrap(compound) };
  }

  async exportStl(
    shape: ShapeHandle,
    options: { quality?: TessellationQuality; binary?: boolean } = {},
  ): Promise<Uint8Array> {
    const input = this.registry.get(shape);
    const quality = options.quality ?? EXPORT_QUALITY;
    // BRepMesh_IncrementalMesh CACHES the triangulation on the shape, so a second call
    // at a different quality silently reuses the first. Without this Clean, exporting
    // after the viewer has display-tessellated writes the COARSE display mesh into the
    // STL — a visibly faceted print from a model that looked fine on screen.
    this.oc.BRepTools.Clean(input, true);
    new this.oc.BRepMesh_IncrementalMesh(
      input, quality.linearDeflection, false, quality.angularDeflection, false,
    );

    const path = `/export-${Date.now()}-${Math.random().toString(36).slice(2)}.stl`;
    // StlAPI.Write, not StlAPI_Writer: the writer's ASCIIMode is not actually bound to
    // the C++ field on this build — assigning it succeeds, changes nothing, and every
    // export came out ASCII, five times the size of the binary a slicer would rather
    // have. The static Write takes the mode as an argument, which does work.
    const ok = this.oc.StlAPI.Write(input, path, !(options.binary ?? true));
    if (!ok) throw new KernelError('OpenCascade refused to write the STL', 'exportStl');

    const bytes = this.oc.FS.readFile(path, { encoding: 'binary' }) as Uint8Array;
    this.oc.FS.unlink(path);
    if (bytes.length === 0) throw new KernelError('the exported STL was empty', 'exportStl');
    return bytes;
  }

  /** The welded export mesh of a shape at a quality. */
  #exportMesh(input: TopoDS_Shape, quality: TessellationQuality): ExportMesh {
    const body = tessellate(this.oc, input, 'export' as BodyId, quality);
    return weld(body.positions, body.indices);
  }

  async exportModel(
    shape: ShapeHandle, format: ExportFormat, options: ExportOptions = {},
  ): Promise<ExportResult> {
    const input = this.registry.get(shape);
    const name = options.name ?? 'part';
    if (format === 'step') return { bytes: this.#writeStep(input), triangles: 0 };

    const mesh = this.#exportMesh(input, options.quality ?? EXPORT_QUALITY);
    const triangles = triangleCount(mesh);
    if (triangles === 0) throw new KernelError('the shape has no surface to export', 'exportModel');
    const bytes = format === 'stl' ? encodeStlBinary(mesh, name)
      : format === 'stl-ascii' ? encodeStlAscii(mesh, name)
      : format === 'obj' ? encodeObj(mesh, name)
      : encode3mf(mesh, name);
    return { bytes, triangles };
  }

  async meshStats(shape: ShapeHandle, quality: TessellationQuality): Promise<MeshStats> {
    const mesh = this.#exportMesh(this.registry.get(shape), quality);
    return {
      triangles: triangleCount(mesh),
      vertices: mesh.positions.length / 3,
      watertight: isWatertight(mesh),
    };
  }

  async scoreOrientations(shape: ShapeHandle, options: OrientationOptions): Promise<OrientationSuggestion[]> {
    // Coarse on purpose: the ranking needs areas and heights, not a smooth surface.
    const mesh = this.#exportMesh(this.registry.get(shape), { linearDeflection: 0.2, angularDeflection: 0.5 });
    return scoreOrientations(mesh, options);
  }

  #writeStep(input: TopoDS_Shape): Uint8Array {
    const oc = this.oc;
    const writer = new oc.STEPControl_Writer();
    const done = oc.IFSelect_ReturnStatus.IFSelect_RetDone;
    const status = writer.Transfer(
      input, oc.STEPControl_StepModelType.STEPControl_AsIs, true, new oc.Message_ProgressRange(),
    );
    if (status !== done) throw new KernelError('OpenCascade could not translate the shape to STEP', 'exportModel');
    const path = this.#scratchPath('step');
    if (writer.Write(path) !== done) throw new KernelError('OpenCascade refused to write the STEP', 'exportModel');
    const bytes = oc.FS.readFile(path, { encoding: 'binary' }) as Uint8Array;
    oc.FS.unlink(path);
    writer.delete();
    return bytes;
  }

  #scratchPath(extension: string) {
    return `/scratch-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
  }

  async importStep(text: string): Promise<GeometryResult> {
    const oc = this.oc;
    const path = this.#scratchPath('step');
    oc.FS.writeFile(path, text);
    const reader = new oc.STEPControl_Reader();
    try {
      if (reader.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
        throw new KernelError('this is not a STEP file OpenCascade can read', 'importStep');
      }
      if (reader.TransferRoots(new oc.Message_ProgressRange()) === 0) {
        throw new KernelError('the STEP file contains no shapes', 'importStep');
      }
      const shape = reader.OneShape();
      if (shape.IsNull()) throw new KernelError('the STEP file produced no geometry', 'importStep');
      return { handle: this.#wrap(shape) };
    } finally {
      oc.FS.unlink(path);
      reader.delete();
    }
  }

  async importStl(bytes: Uint8Array): Promise<GeometryResult> {
    const oc = this.oc;
    const facets = stlTriangleCount(bytes);
    if (facets > STL_IMPORT_LIMIT) {
      throw new KernelError(
        `this STL has ${facets.toLocaleString()} triangles; sewing more than `
        + `${STL_IMPORT_LIMIT.toLocaleString()} into a solid would take minutes`,
        'importStl',
      );
    }
    const path = this.#scratchPath('stl');
    oc.FS.writeFile(path, bytes);
    try {
      const faces = new oc.TopoDS_Shape();
      if (!new oc.StlAPI_Reader().Read(faces, path)) {
        throw new KernelError('this is not an STL file OpenCascade can read', 'importStl');
      }
      // Each triangle came back as its own face. Sew them into one shell, then close it
      // into a solid so booleans and mass properties mean something.
      const sewing = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false);
      sewing.Add(faces);
      sewing.Perform(new oc.Message_ProgressRange());
      const sewn = sewing.SewedShape();
      if (sewn.IsNull()) throw new KernelError('the STL could not be sewn into a surface', 'importStl');
      const shells = subShapes(oc, sewn, 'TopAbs_SHELL');
      if (shells.length === 0) throw new KernelError('the STL has no closed surface', 'importStl');
      const builder = new oc.BRepBuilderAPI_MakeSolid();
      for (const shell of shells) builder.Add(oc.TopoDS.Shell(shell));
      const solid = this.#build(builder, 'importStl');
      // A mesh wound inside-out sews into a solid with negative volume; fix orientation.
      const fixer = new oc.ShapeFix_Solid(oc.TopoDS.Solid(solid));
      fixer.Perform(new oc.Message_ProgressRange());
      return { handle: this.#wrap(fixer.Shape()) };
    } finally {
      oc.FS.unlink(path);
    }
  }

  async release(shape: ShapeHandle): Promise<void> {
    this.registry.release(shape);
  }

  /** Free every shape. Call when tearing down a document. */
  dispose(): void { this.registry.clear(); }
}

/** Sewing is quadratic-ish in practice; past this a solid is not worth waiting for. */
const STL_IMPORT_LIMIT = 50_000;

/** Triangle count from the header (binary) or by counting facets (ASCII). */
function stlTriangleCount(bytes: Uint8Array): number {
  const head = new TextDecoder().decode(bytes.subarray(0, 5));
  if (bytes.length >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    // Binary if the size matches the count; ASCII files starting "solid" would not.
    if (84 + count * 50 === bytes.length) return count;
  }
  if (head !== 'solid') return 0;
  return (new TextDecoder().decode(bytes).match(/facet normal/g) ?? []).length;
}

/** Outward normal of the first planar face of a shape, or null if it has none. */
function faceNormal(oc: OpenCascadeInstance, shape: TopoDS_Shape): Vec3 | null {
  const faces = subShapes(oc, shape, 'TopAbs_FACE');
  const first = faces[0];
  if (!first) return null;
  try {
    const face = oc.TopoDS.Face(first);
    const gprop = new oc.BRepGProp_Face(face);
    const range = gprop.Bounds(0, 0, 0, 0);
    const point = new oc.gp_Pnt(0, 0, 0);
    const normal = new oc.gp_Vec(0, 0, 0);
    gprop.Normal((range.U1 + range.U2) / 2, (range.V1 + range.V2) / 2, point, normal);
    const magnitude = normal.Magnitude();
    if (magnitude < 1e-9) return null;
    return { x: normal.X() / magnitude, y: normal.Y() / magnitude, z: normal.Z() / magnitude };
  } catch {
    return null;
  }
}

/**
 * OCCT throws emscripten exception pointers, not Errors. Without this translation every
 * geometry failure surfaces as an opaque number.
 */
function describeOcctError(oc: OpenCascadeInstance, error: unknown, op: string): string {
  // Emscripten throws an OCCT failure as a raw pointer under legacy exceptions and as a
  // WebAssembly.Exception under the native ones. Both stringify to something useless
  // ("[object WebAssembly.Exception]"), so ask the runtime for the real message first.
  if (typeof error === 'number' || (typeof error === 'object' && error !== null
      && !(error instanceof Error))) {
    try {
      const message = (oc.getExceptionMessage as unknown as (p: unknown) => string)(error);
      if (message) return `${op}: ${message}`;
    } catch { /* fall through */ }
    return `${op} failed inside OpenCascade — the operation is not valid for this shape`;
  }
  return error instanceof Error ? error.message : `${op} failed: ${String(error)}`;
}
