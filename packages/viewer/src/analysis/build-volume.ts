import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments } from 'three';

/**
 * The printer's build volume, as a wireframe box on the bed.
 *
 * Centred on the origin in X and Y, from the bed up in Z — the grid is the bed. It is
 * a reference, not a constraint: the part is free to sit anywhere, and whether it FITS
 * is judged by its dimensions, since the slicer will place it. The box goes red when
 * it does not.
 */
export class BuildVolume extends LineSegments<BufferGeometry, LineBasicMaterial> {
  constructor() {
    super(new BufferGeometry(), new LineBasicMaterial({ color: 0x3f6fb0, transparent: true, opacity: 0.55 }));
    this.name = 'build-volume';
    this.renderOrder = -1;
    this.setSize({ x: 220, y: 220, z: 250 });
  }

  setSize(bed: { x: number; y: number; z: number }): void {
    const hx = bed.x / 2, hy = bed.y / 2, z = bed.z;
    const c = [
      [-hx, -hy, 0], [hx, -hy, 0], [hx, hy, 0], [-hx, hy, 0],
      [-hx, -hy, z], [hx, -hy, z], [hx, hy, z], [-hx, hy, z],
    ];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const points: number[] = [];
    for (const [a, b] of edges) points.push(...c[a!]!, ...c[b!]!);
    this.geometry.dispose();
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
  }

  setFits(fits: boolean): void {
    this.material.color.set(fits ? 0x3f6fb0 : 0xe0483a);
    this.material.opacity = fits ? 0.55 : 0.9;
  }
}
