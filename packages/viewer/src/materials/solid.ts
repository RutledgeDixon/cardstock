import {
  DataTexture,
  NearestFilter,
  RedFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
} from 'three';

/**
 * Surface material with per-face hover and selection.
 *
 * Face state lives in a 1-D data texture indexed by face id rather than a uniform array,
 * because uniform arrays are size-capped and a real part can have hundreds of faces.
 * Each texel is one face: 0 = normal, 1 = selected.
 */

export const FACE_STATE_NORMAL = 0;
export const FACE_STATE_SELECTED = 1;

export interface SolidMaterialOptions {
  faceCount: number;
  base?: [number, number, number];
  hover?: [number, number, number];
  selected?: [number, number, number];
}

export class SolidMaterial extends ShaderMaterial {
  readonly faceState: Uint8Array;
  readonly faceStateTexture: DataTexture;

  constructor(opts: SolidMaterialOptions) {
    const width = Math.max(1, opts.faceCount);
    const faceState = new Uint8Array(width);
    const tex = new DataTexture(faceState, width, 1, RedFormat, UnsignedByteType);
    tex.minFilter = NearestFilter;
    tex.magFilter = NearestFilter;
    tex.needsUpdate = true;

    super({
      uniforms: {
        uFaceState: { value: tex },
        uFaceCount: { value: width },
        uHoverFace: { value: -1 },
        // Whole-body hover: 'body' is a container kind with no face index of its own.
        uHoverAll: { value: 0 },
        uBase: { value: new Vector3(...(opts.base ?? [0.60, 0.64, 0.71])) },
        uHover: { value: new Vector3(...(opts.hover ?? [0.38, 0.68, 1.0])) },
        uSelected: { value: new Vector3(...(opts.selected ?? [1.0, 0.62, 0.22])) },
        // Two-light setup: a key from over the viewer's shoulder and a cool fill from
        // below, so downward faces stay readable instead of going black.
        uKeyDir: { value: new Vector3(0.35, -0.45, 0.82).normalize() },
        uFillDir: { value: new Vector3(-0.4, 0.3, -0.6).normalize() },
      },
      vertexShader: /* glsl */ `
        attribute float faceId;
        varying float vFaceId;
        varying vec3 vNormal;
        void main() {
          vFaceId = faceId;
          // WORLD space, not view space. normalMatrix would give a headlight that swings
          // with the camera; lighting fixed in world space keeps "up" reading as up,
          // which is what you want when judging a part that will sit on a print bed.
          vNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uFaceState;
        uniform float uFaceCount;
        uniform float uHoverFace;
        uniform float uHoverAll;
        uniform vec3 uBase, uHover, uSelected, uKeyDir, uFillDir;
        varying float vFaceId;
        varying vec3 vNormal;

        void main() {
          vec3 n = normalize(vNormal);
          float key  = max(dot(n, uKeyDir), 0.0);
          float fill = max(dot(n, uFillDir), 0.0) * 0.35;
          float ambient = 0.28;

          vec3 tint = uBase;
          float texel = (vFaceId + 0.5) / max(uFaceCount, 1.0);
          bool isSelected = texture2D(uFaceState, vec2(texel, 0.5)).r * 255.0 > 0.5;
          bool isHovered = uHoverAll > 0.5 || abs(vFaceId - uHoverFace) < 0.5;

          // Selection wins over hover, because a selected face pointed at was reading as
          // merely hovered — it only turned orange once the pointer left, which made
          // clicking look like it had done nothing. Pointing at something already
          // selected DARKENS it instead, so the two states are both visible at once.
          if (isSelected && isHovered) tint = mix(tint, uSelected * 0.62, 0.85);
          else if (isSelected)        tint = mix(tint, uSelected, 0.75);
          else if (isHovered)         tint = mix(tint, uHover, 0.6);

          gl_FragColor = vec4(tint * (ambient + key * 0.8 + fill), 1.0);
        }
      `,
    });

    this.faceState = faceState;
    this.faceStateTexture = tex;
  }

  setHoveredFace(faceId: number): void {
    this.uniforms.uHoverFace!.value = faceId;
  }

  /** Light every face, for when the pointer is over the body as a whole. */
  setHoveredWholeBody(hovered: boolean): void {
    this.uniforms.uHoverAll!.value = hovered ? 1 : 0;
  }

  setSelectedFaces(indices: readonly number[]): void {
    this.faceState.fill(FACE_STATE_NORMAL);
    for (const i of indices) {
      if (i >= 0 && i < this.faceState.length) this.faceState[i] = FACE_STATE_SELECTED;
    }
    this.faceStateTexture.needsUpdate = true;
  }

  override dispose(): void {
    this.faceStateTexture.dispose();
    super.dispose();
  }
}
