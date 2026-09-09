import type { OpenCascadeInstance, TopoDS_Shape } from 'replicad-opencascadejs';

/**
 * Topology traversal helpers.
 *
 * Every quirk encoded here was measured in Phase 0 and is documented in
 * docs/adr/0001-geometry-kernel.md. None of it is in any OCCT documentation, and all of
 * it is the kind of thing that looks like noise until it silently corrupts a model.
 */

export type ShapeKind =
  | 'TopAbs_FACE' | 'TopAbs_EDGE' | 'TopAbs_VERTEX' | 'TopAbs_SOLID' | 'TopAbs_WIRE';

/**
 * Unique sub-shapes in deterministic traversal order.
 *
 * Two traps here. `TopExp_Explorer` yields DUPLICATES — a box reports 24 edge visits for
 * 12 edges, one per adjacent face — so results must be deduped. And the natural tool for
 * that, `NCollection_IndexedMap`, is exported by this build but NOT constructible
 * (unbound base type `NCollection_BaseMap`), so dedupe goes through `IsSame`. That is
 * O(n^2), which is fine at part scale; revisit if a shape ever reaches thousands of faces.
 */
export function subShapes(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  kind: ShapeKind,
): TopoDS_Shape[] {
  const out: TopoDS_Shape[] = [];
  // Bucketed dedupe. Comparing each visit against everything kept so far is O(n^2) and
  // it dominated everything that enumerates topology: a 150-copy pattern spent 2.5s in
  // tessellation and 3.4s in describeShape, almost all of it in IsSame. Bucketing by
  // bounding box makes the comparison local — IsSame still DECIDES, so semantics are
  // unchanged and coincident-but-distinct shapes (a cylinder's seam edge) stay distinct;
  // the box only narrows who is worth asking about.
  const buckets = new Map<string, TopoDS_Shape[]>();
  const box = new oc.Bnd_Box();

  const explorer = new oc.TopExp_Explorer(
    shape,
    oc.TopAbs_ShapeEnum[kind],
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  for (; explorer.More(); explorer.Next()) {
    const current = explorer.Current();
    const key = bucketKey(oc, box, current);
    const bucket = buckets.get(key);
    if (bucket) {
      if (bucket.some((s) => s.IsSame(current))) continue;
      bucket.push(current);
    } else {
      buckets.set(key, [current]);
    }
    out.push(current);
  }
  explorer.delete();
  box.delete();
  return out;
}

/**
 * A cheap, exact-enough bucket key: the sub-shape's bounding box, quantised.
 *
 * Quantised coarsely on purpose. A key that is too precise would split two genuinely
 * identical visits into different buckets and let a duplicate through, which is far
 * worse than a bucket holding a few extra candidates — those cost one IsSame each.
 */
function bucketKey(
  oc: OpenCascadeInstance,
  box: { SetVoid(): void; SetGap(g: number): void; IsVoid(): boolean;
         CornerMin(): { X(): number; Y(): number; Z(): number };
         CornerMax(): { X(): number; Y(): number; Z(): number } },
  shape: TopoDS_Shape,
): string {
  box.SetVoid();
  oc.BRepBndLib.Add(shape, box as never, false);
  if (box.IsVoid()) return 'void';
  const low = box.CornerMin();
  const high = box.CornerMax();
  const q = (v: number) => Math.round(v * 1e3);
  return `${q(low.X())},${q(low.Y())},${q(low.Z())},${q(high.X())},${q(high.Y())},${q(high.Z())}`;
}

/**
 * The wire to sweep along, or the outer boundary of a profile.
 *
 * Sketches arrive as faces and paths as edges or wires, and every sweeping operation
 * wants a wire either way, so the conversion lives here rather than at each call site.
 * The first wire of a face is its outer boundary — the same convention makeFace builds
 * to, where later loops are holes.
 */
export function asWire(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
): TopoDS_Shape | null {
  if (shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE) return shape;

  const wires = subShapes(oc, shape, 'TopAbs_WIRE');
  if (wires.length > 0) return wires[0]!;

  // A bare edge is a legitimate path; wrap it so the sweep can take it.
  const edges = subShapes(oc, shape, 'TopAbs_EDGE');
  if (edges.length === 0) return null;
  const builder = new oc.BRepBuilderAPI_MakeWire();
  for (const edge of edges) builder.Add(oc.TopoDS.Edge(edge));
  return builder.IsDone() ? builder.Wire() : null;
}

export function countSubShapes(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  kind: ShapeKind,
): number {
  return subShapes(oc, shape, kind).length;
}

/**
 * Drain an `NCollection_List_TopoDS_Shape` into an array.
 *
 * No list iterator class is bound in this build, so iteration is destructive via
 * `First()`/`RemoveFirst()`. Safe because OCCT's history calls return a fresh list on
 * every invocation.
 */
export function drainShapeList(list: {
  Size(): number;
  First(): TopoDS_Shape;
  RemoveFirst(): void;
}): TopoDS_Shape[] {
  const out: TopoDS_Shape[] = [];
  while (list.Size() > 0) {
    out.push(list.First());
    list.RemoveFirst();
  }
  return out;
}

/** Index of `needle` within `haystack` by geometric identity, or -1. */
export function indexOfShape(haystack: readonly TopoDS_Shape[], needle: TopoDS_Shape): number {
  return haystack.findIndex((s) => s.IsSame(needle));
}

/**
 * A reusable "which index is this shape?" lookup.
 *
 * `indexOfShape` is a linear scan, which is fine once and quadratic in a loop — building
 * the edge/face adjacency map with it cost more than the entire rest of describeShape on
 * a large part. This buckets the haystack once, by the same bounding-box key the dedupe
 * uses, so each lookup compares against a handful of candidates instead of all of them.
 * `IsSame` still decides.
 */
export function shapeIndexer(
  oc: OpenCascadeInstance,
  haystack: readonly TopoDS_Shape[],
): (needle: TopoDS_Shape) => number {
  const box = new oc.Bnd_Box();
  const buckets = new Map<string, number[]>();
  haystack.forEach((shape, index) => {
    const key = bucketKey(oc, box, shape);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  });

  return (needle) => {
    const candidates = buckets.get(bucketKey(oc, box, needle));
    if (!candidates) return -1;
    for (const index of candidates) {
      if (haystack[index]!.IsSame(needle)) return index;
    }
    return -1;
  };
}
