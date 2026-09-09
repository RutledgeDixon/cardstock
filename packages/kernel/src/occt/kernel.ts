import type { OpenCascadeInstance, TopoDS_Shape } from 'replicad-opencascadejs';
import {
  type BooleanOp, type Bounds, type BoxSpec, type CylinderSpec, type GeometryResult,
  type KernelPort, type MassProperties, type Matrix4, type ShapeHandle, type SphereSpec,
  type TessellatedBody, type TessellationQuality, type TopologyCounts, type BodyId,
  type ShapeDescription, type ProfileSpec, type Vec3,
  KernelError, EXPORT_QUALITY,
} from '@cardstock/types';
import { ShapeRegistry } from './registry.js';
import { subShapes } from './topology.js';
import { captureHistory } from './history.js';
import { tessellate } from '../tessellate/tessellate.js';
import { describeShape } from './describe.js';
import { makeFace } from './profile.js';

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
    if (!normal) throw new KernelError('extrude needs a planar face', 'extrude');

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
    const writer = new this.oc.StlAPI_Writer();
    // ASCIIMode is exposed as a getter method here, not a settable field, so the mode is
    // set through the underlying property when the binding allows it and otherwise left
    // at OCCT's default. The test asserts which format actually comes out.
    const modeSetter = (writer as unknown as Record<string, unknown>).set_ASCIIMode;
    if (typeof modeSetter === 'function') {
      (modeSetter as (v: boolean) => void).call(writer, !(options.binary ?? true));
    }
    const ok = writer.Write(input, path, new this.oc.Message_ProgressRange());
    if (!ok) throw new KernelError('OpenCascade refused to write the STL', 'exportStl');

    const bytes = this.oc.FS.readFile(path, { encoding: 'binary' }) as Uint8Array;
    this.oc.FS.unlink(path);
    if (bytes.length === 0) throw new KernelError('the exported STL was empty', 'exportStl');
    return bytes;
  }

  async release(shape: ShapeHandle): Promise<void> {
    this.registry.release(shape);
  }

  /** Free every shape. Call when tearing down a document. */
  dispose(): void { this.registry.clear(); }
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
