import type { OpenCascadeInstance, TopoDS_Shape } from 'replicad-opencascadejs';
import type { InputHistory, ShapeHistory } from '@cardstock/types';
import { drainShapeList, indexOfShape, subShapes } from './topology.js';

/**
 * Capture how an operation mapped input sub-shapes onto output sub-shapes.
 *
 * Phase 4's topological naming resolves durable references by replaying exactly this.
 * Capturing it now, while each operation still has its builder in hand, is the only
 * chance — the information does not exist once the builder is gone.
 *
 * Verified present on this trimmed OCCT build in Phase 0 (ADR-0001): a fillet reports
 * the face it generated from an edge, and booleans report modified faces too.
 */
export interface HistoryBuilder {
  Generated(shape: TopoDS_Shape): { Size(): number; First(): TopoDS_Shape; RemoveFirst(): void };
  Modified(shape: TopoDS_Shape): { Size(): number; First(): TopoDS_Shape; RemoveFirst(): void };
  IsDeleted(shape: TopoDS_Shape): boolean;
}

export function captureHistory(
  oc: OpenCascadeInstance,
  builder: HistoryBuilder,
  inputs: readonly TopoDS_Shape[],
  result: TopoDS_Shape,
): ShapeHistory {
  const resultFaces = subShapes(oc, result, 'TopAbs_FACE');
  const perInput: InputHistory[] = [];

  for (const input of inputs) {
    const modifiedFaces = new Map<number, number[]>();
    const generatedFaces = new Map<number, number[]>();
    const deletedFaces: number[] = [];

    const inputFaces = subShapes(oc, input, 'TopAbs_FACE');
    inputFaces.forEach((face, faceIndex) => {
      try {
        if (builder.IsDeleted(face)) {
          deletedFaces.push(faceIndex);
          return;
        }
      } catch {
        // Some builders throw rather than answering for shapes they never saw.
      }

      try {
        const modified = drainShapeList(builder.Modified(face))
          .map((s) => indexOfShape(resultFaces, s))
          .filter((i) => i >= 0);
        if (modified.length > 0) modifiedFaces.set(faceIndex, modified);
      } catch { /* unchanged faces legitimately report nothing */ }
    });

    const inputEdges = subShapes(oc, input, 'TopAbs_EDGE');
    inputEdges.forEach((edge, edgeIndex) => {
      try {
        const generated = drainShapeList(builder.Generated(edge))
          .map((s) => indexOfShape(resultFaces, s))
          .filter((i) => i >= 0);
        if (generated.length > 0) generatedFaces.set(edgeIndex, generated);
      } catch { /* most edges generate nothing */ }
    });

    perInput.push({ modifiedFaces, generatedFaces, deletedFaces });
  }

  return { inputs: perInput };
}
