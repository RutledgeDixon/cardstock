import { Vector3, type OrthographicCamera } from 'three';
import type { Bounds } from '@cardstock/types';
import { boundsCenter, boundsRadius } from '@cardstock/types';

/**
 * The turntable camera model.
 *
 * Orientation is two numbers — azimuth and elevation about a pivot — with the up-vector
 * permanently locked to +Z. Roll is therefore not *representable*, which is the whole
 * point: CARDstock's navigation stance is that SolidWorks/FreeCAD orbit feels wrong
 * because their trackballs let the model tumble and you lose which way is up.
 *
 * Elevation is clamped just short of the poles. Exactly at a pole the up-vector would be
 * parallel to the view direction and the orientation undefined; see `viewLookingAlong`
 * for how azimuth is chosen there.
 */

/** Just short of straight up/down, where lookAt would degenerate. */
export const ELEVATION_LIMIT = Math.PI / 2 - 0.01;

/** True isometric elevation: atan(1/sqrt(2)) ~= 35.264 degrees. */
export const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);

export const clampElevation = (el: number): number =>
  Math.min(ELEVATION_LIMIT, Math.max(-ELEVATION_LIMIT, el));

/** Wrap to (-PI, PI] so azimuth never grows without bound after repeated orbiting. */
export function normalizeAzimuth(az: number): number {
  const wrapped = ((az + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  // (-PI, PI]: map the -PI boundary to +PI so the value is canonical.
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

export interface TurntableState {
  /** Rotation about +Z, radians. 0 looks from +X toward the origin. */
  azimuth: number;
  /** Angle above the XY plane, radians, clamped to +/- ELEVATION_LIMIT. */
  elevation: number;
  pivot: Vector3;
  /** Half-height of the orthographic frustum, in mm. Smaller = more zoomed in. */
  zoom: number;
}

/**
 * Named views.
 *
 * Azimuth conventions (Z-up, right-handed): 0 looks from +X, -PI/2 from -Y ("front").
 *
 * Top and bottom use az = -PI/2 deliberately. At the poles the locked +Z up-vector is
 * nearly parallel to the view direction, so screen orientation is decided entirely by
 * azimuth — it works out to screen-right = (-sin az, cos az, 0). Only az = -PI/2 gives
 * the CAD convention of X to the right and Y up. See docs/adr/0002.
 */
export const NAMED_VIEWS = {
  front: { azimuth: -Math.PI / 2, elevation: 0 },
  back: { azimuth: Math.PI / 2, elevation: 0 },
  right: { azimuth: 0, elevation: 0 },
  left: { azimuth: Math.PI, elevation: 0 },
  top: { azimuth: -Math.PI / 2, elevation: ELEVATION_LIMIT },
  bottom: { azimuth: -Math.PI / 2, elevation: -ELEVATION_LIMIT },
  iso: { azimuth: -Math.PI / 4, elevation: ISO_ELEVATION },
} as const satisfies Record<string, { azimuth: number; elevation: number }>;

export type NamedView = keyof typeof NAMED_VIEWS;

/**
 * Azimuth/elevation that puts the camera ON the side `normal` points, looking back at it.
 * This is the "look at this face" operation — pass the outward face normal.
 *
 * When `normal` is within a hair of +/-Z the azimuth is otherwise arbitrary, so it is
 * pinned to -PI/2 for the same reason the top view is: it is the only choice that puts
 * X to the right. This is the trap ADR-0002 warns about, and it applies to any face
 * whose normal is vertical.
 */
export function viewFacing(normal: Vector3): { azimuth: number; elevation: number } {
  const n = normal.clone().normalize();
  const horizontal = Math.hypot(n.x, n.y);
  if (horizontal < 1e-6) {
    return { azimuth: -Math.PI / 2, elevation: n.z >= 0 ? ELEVATION_LIMIT : -ELEVATION_LIMIT };
  }
  return {
    azimuth: normalizeAzimuth(Math.atan2(n.y, n.x)),
    elevation: clampElevation(Math.atan2(n.z, horizontal)),
  };
}

/** Unit vector from pivot toward the camera, for the given orientation. */
export function orbitDirection(azimuth: number, elevation: number, out = new Vector3()): Vector3 {
  const ce = Math.cos(elevation);
  return out.set(ce * Math.cos(azimuth), ce * Math.sin(azimuth), Math.sin(elevation));
}

export function makeTurntableState(partial: Partial<TurntableState> = {}): TurntableState {
  return {
    azimuth: partial.azimuth ?? NAMED_VIEWS.iso.azimuth,
    elevation: partial.elevation ?? NAMED_VIEWS.iso.elevation,
    pivot: partial.pivot?.clone() ?? new Vector3(),
    zoom: partial.zoom ?? 50,
  };
}

/**
 * Push turntable state onto a three.js orthographic camera.
 *
 * `orbitRadius` only positions the camera along the view axis; with an orthographic
 * projection it does not affect apparent size (that is `zoom`). It must simply be large
 * enough that the near plane clears the model.
 */
export function applyToCamera(
  state: TurntableState,
  camera: OrthographicCamera,
  aspect: number,
  orbitRadius: number,
): void {
  orbitDirection(state.azimuth, state.elevation, _dir);
  camera.position.copy(state.pivot).addScaledVector(_dir, orbitRadius);
  camera.up.set(0, 0, 1); // locked — the reason roll cannot occur
  camera.lookAt(state.pivot);

  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  camera.left = -state.zoom * safeAspect;
  camera.right = state.zoom * safeAspect;
  camera.top = state.zoom;
  camera.bottom = -state.zoom;
  camera.near = 0.01;
  camera.far = orbitRadius * 4;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}
const _dir = new Vector3();

/** Pivot and zoom that frame `bounds` with a little breathing room. */
export function fitBounds(
  bounds: Bounds,
  aspect: number,
  margin = 1.15,
): { pivot: Vector3; zoom: number } {
  const c = boundsCenter(bounds);
  const radius = boundsRadius(bounds);
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  // Fit the bounding sphere in the narrower screen axis so nothing is clipped at any
  // orientation — the model can be orbited freely without needing to re-fit.
  const zoom = (radius * margin) / Math.min(1, safeAspect);
  return {
    pivot: new Vector3(c.x, c.y, c.z),
    zoom: Math.max(zoom, 1e-3),
  };
}
