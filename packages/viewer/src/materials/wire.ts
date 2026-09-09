import { DataTexture, NearestFilter, RedFormat, ShaderMaterial, UnsignedByteType, Vector3 } from 'three';

/**
 * Shared material for edge line segments and topological vertex points.
 *
 * Same face-state trick as SolidMaterial: a 1-D texture indexed by entity id.
 * `uPointSize` is ignored by LineSegments and used by Points.
 */
export class WireMaterial extends ShaderMaterial {
  readonly state: Uint8Array;
  readonly stateTexture: DataTexture;

  constructor(count: number, opts: {
    base?: [number, number, number];
    hover?: [number, number, number];
    selected?: [number, number, number];
    pointSize?: number;
    depthTest?: boolean;
  } = {}) {
    const width = Math.max(1, count);
    const state = new Uint8Array(width);
    const tex = new DataTexture(state, width, 1, RedFormat, UnsignedByteType);
    tex.minFilter = NearestFilter;
    tex.magFilter = NearestFilter;
    tex.needsUpdate = true;

    super({
      uniforms: {
        uState: { value: tex },
        uCount: { value: width },
        uHoverId: { value: -1 },
        uBase: { value: new Vector3(...(opts.base ?? [0.09, 0.10, 0.13])) },
        uHover: { value: new Vector3(...(opts.hover ?? [0.38, 0.68, 1.0])) },
        uSelected: { value: new Vector3(...(opts.selected ?? [1.0, 0.62, 0.22])) },
        uPointSize: { value: opts.pointSize ?? 1.0 },
      },
      vertexShader: /* glsl */ `
        attribute float entityId;
        varying float vEntityId;
        uniform float uPointSize;
        void main() {
          vEntityId = entityId;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uPointSize;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uState;
        uniform float uCount, uHoverId;
        uniform vec3 uBase, uHover, uSelected;
        varying float vEntityId;
        void main() {
          vec3 c = uBase;
          float texel = (vEntityId + 0.5) / max(uCount, 1.0);
          bool isSelected = texture2D(uState, vec2(texel, 0.5)).r * 255.0 > 0.5;
          bool isHovered = abs(vEntityId - uHoverId) < 0.5;

          // Same rule as faces: selection outranks hover, and hovering something already
          // selected darkens it rather than replacing the colour.
          if (isSelected && isHovered) c = uSelected * 0.62;
          else if (isSelected)         c = uSelected;
          else if (isHovered)          c = uHover;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthTest: opts.depthTest ?? true,
    });

    this.state = state;
    this.stateTexture = tex;
  }

  setHovered(id: number): void { this.uniforms.uHoverId!.value = id; }

  setSelected(indices: readonly number[]): void {
    this.state.fill(0);
    for (const i of indices) if (i >= 0 && i < this.state.length) this.state[i] = 1;
    this.stateTexture.needsUpdate = true;
  }

  override dispose(): void {
    this.stateTexture.dispose();
    super.dispose();
  }
}
