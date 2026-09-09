import type { OpenCascadeInstance, TopoDS_Shape } from 'replicad-opencascadejs';

/**
 * Topology traversal helpers.
 *
 * Every quirk encoded here was measured in Phase 0 and is documented in
 * docs/adr/0001-geometry-kernel.md. None of it is in any OCCT documentation, and all of
 * it is the kind of thing that looks like noise until it silently corrupts a model.
 */

export type ShapeKind = 'TopAbs_FACE' | 'TopAbs_EDGE' | 'TopAbs_VERTEX' | 'TopAbs_SOLID';

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
  const explorer = new oc.TopExp_Explorer(
    shape,
    oc.TopAbs_ShapeEnum[kind],
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  for (; explorer.More(); explorer.Next()) {
    const current = explorer.Current();
    if (!out.some((s) => s.IsSame(current))) out.push(current);
  }
  explorer.delete();
  return out;
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
