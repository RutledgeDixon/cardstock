import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineSegments,
  Mesh,
  Points,
} from 'three';
import { computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type { BodyId, TessellatedBody } from '@cardstock/types';
import { SolidMaterial } from '../materials/solid.js';
import { WireMaterial } from '../materials/wire.js';

/**
 * The three.js representation of one tessellated body: surface, edges, vertices.
 *
 * IMPORTANT (docs/adr/0002): the BVH is built with `{ indirect: true }`. Without it,
 * `computeBoundsTree()` reorders the index buffer in place and `hit.faceIndex` stops
 * corresponding to `triangleFaceId` — silently, still returning a valid but WRONG face.
 * With `indirect: true` the index order is preserved and `hit.faceIndex` needs no
 * remapping (do NOT also call `resolveTriangleIndex`, that double-maps). This was
 * measured: direct indexing agreed 4589/4589, remapping only 986/4589.
 */
export class BodyView {
  readonly bodyId: BodyId;
  readonly group = new Group();
  readonly solid: Mesh;
  readonly edges: LineSegments;
  readonly vertices: Points;
  readonly solidMaterial: SolidMaterial;
  readonly edgeMaterial: WireMaterial;
  readonly vertexMaterial: WireMaterial;
  readonly data: TessellatedBody;

  constructor(body: TessellatedBody) {
    this.bodyId = body.bodyId;
    this.data = body;

    // --- surface
    const geom = new BufferGeometry();
    geom.setAttribute('position', new Float32BufferAttribute(body.positions, 3));
    geom.setAttribute('normal', new Float32BufferAttribute(body.normals, 3));
    geom.setAttribute('faceId', new Float32BufferAttribute(body.vertexFaceId, 1));
    geom.setIndex(new BufferAttribute(body.indices, 1));
    geom.computeBoundsTree({ indirect: true });

    this.solidMaterial = new SolidMaterial({ faceCount: body.faceCount });
    this.solid = new Mesh(geom, this.solidMaterial);
    this.solid.name = `body:${body.bodyId}:solid`;
    this.solid.renderOrder = 0;

    // --- edges
    const edgeGeom = new BufferGeometry();
    edgeGeom.setAttribute('position', new Float32BufferAttribute(body.edgePositions, 3));
    // One id per segment, but attributes are per-vertex: duplicate for both endpoints.
    const edgeIds = new Float32Array(body.edgeSegmentId.length * 2);
    for (let i = 0; i < body.edgeSegmentId.length; i++) {
      edgeIds[i * 2] = body.edgeSegmentId[i]!;
      edgeIds[i * 2 + 1] = body.edgeSegmentId[i]!;
    }
    edgeGeom.setAttribute('entityId', new Float32BufferAttribute(edgeIds, 1));
    this.edgeMaterial = new WireMaterial(body.edgeCount);
    this.edges = new LineSegments(edgeGeom, this.edgeMaterial);
    this.edges.name = `body:${body.bodyId}:edges`;
    this.edges.renderOrder = 1;

    // --- topological vertices
    const vertGeom = new BufferGeometry();
    vertGeom.setAttribute('position', new Float32BufferAttribute(body.vertexPositions, 3));
    const vertIds = new Float32Array(body.vertexCount);
    for (let i = 0; i < body.vertexCount; i++) vertIds[i] = i;
    vertGeom.setAttribute('entityId', new Float32BufferAttribute(vertIds, 1));
    this.vertexMaterial = new WireMaterial(body.vertexCount, {
      base: [0.45, 0.48, 0.55],
      pointSize: 7,
    });
    this.vertices = new Points(vertGeom, this.vertexMaterial);
    this.vertices.name = `body:${body.bodyId}:vertices`;
    this.vertices.renderOrder = 2;
    this.vertices.visible = false; // only shown when the vertex filter is active

    this.group.add(this.solid, this.edges, this.vertices);
  }

  dispose(): void {
    (this.solid.geometry as BufferGeometry & { disposeBoundsTree?: () => void })
      .disposeBoundsTree?.();
    this.solid.geometry.dispose();
    this.edges.geometry.dispose();
    this.vertices.geometry.dispose();
    this.solidMaterial.dispose();
    this.edgeMaterial.dispose();
    this.vertexMaterial.dispose();
    this.group.clear();
  }
}

// Install the BVH extensions once, at import time.
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
