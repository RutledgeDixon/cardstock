import type { Vec3 } from '@cardstock/types';
import type { Feature } from '../features/feature.js';
import type { Parameter } from '../params/parameters.js';
import type { SketchData } from '../sketch/sketch.js';

/**
 * The `.card` file format.
 *
 * No geometry is stored — the model is fully recomputed on open. Files stay small and
 * diff readably in git, which matters for versioning real parts. The schema is versioned
 * from day one with a migration harness, because it will change.
 */

/**
 * Version history:
 *   1 — parameters, features, meta.
 *   2 — sketches. Version 1 never wrote them, so a sketched part could not be rebuilt
 *       from its own file; the migration adds an empty table, which is honest about
 *       what those files contain. Also the optional thumbnail and camera on meta.
 */
export const CURRENT_SCHEMA_VERSION = 2;

export interface DocumentFile {
  readonly schemaVersion: number;
  readonly meta: DocumentMeta;
  readonly parameters: readonly Parameter[];
  readonly features: readonly Feature[];
  /** Sketch geometry and constraints, by the id a feature's `sketchId` names. */
  readonly sketches: Readonly<Record<string, SketchData>>;
}

/** Where the camera was when the file was saved, so reopening picks up where you left. */
export interface SavedCamera {
  readonly azimuth: number;
  readonly elevation: number;
  readonly zoom: number;
  readonly pivot: Vec3;
}

export interface DocumentMeta {
  readonly name: string;
  /** ISO 8601. */
  readonly created: string;
  readonly modified: string;
  /** Documents are millimetres. Recorded explicitly so a future unit switch is detectable. */
  readonly units: 'mm';
  readonly application: string;
  /**
   * A small JPEG data URL of the model as last saved.
   *
   * Cached in the file so a recent-files list can show it without rebuilding the part.
   * Never authoritative: it is whatever the viewer showed at save time.
   */
  readonly thumbnail?: string;
  readonly camera?: SavedCamera;
}

export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migrations from version N to N+1, indexed by source version.
 *
 * Add one whenever the schema changes; never edit an existing migration, because files
 * already exist that depend on it behaving exactly as it did.
 */
export const MIGRATIONS = new Map<number, Migration>([
  // 1 -> 2: sketches were never written, so there are none to recover.
  [1, (doc) => ({ ...doc, schemaVersion: 2, sketches: {} })],
]);

export class DocumentFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentFormatError';
  }
}

/** Bring any supported version up to the current one. */
export function migrate(raw: unknown): DocumentFile {
  if (typeof raw !== 'object' || raw === null) {
    throw new DocumentFormatError('not a CARDstock document');
  }
  let doc = raw as Record<string, unknown>;

  const version = doc.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new DocumentFormatError('missing or invalid schemaVersion');
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new DocumentFormatError(
      `document is version ${version}, but this build understands up to ` +
      `${CURRENT_SCHEMA_VERSION}. Update CARDstock to open it.`,
    );
  }

  let current = version;
  while (current < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS.get(current);
    if (!step) throw new DocumentFormatError(`no migration from schema version ${current}`);
    doc = step(doc);
    const next = doc.schemaVersion;
    if (typeof next !== 'number' || next <= current) {
      throw new DocumentFormatError(`migration from ${current} did not advance the version`);
    }
    current = next;
  }

  return validate(doc);
}

/** Structural validation. Rejects malformed input rather than failing deep in a rebuild. */
export function validate(doc: Record<string, unknown>): DocumentFile {
  const parameters = doc.parameters;
  const features = doc.features;
  if (!Array.isArray(parameters)) throw new DocumentFormatError('parameters must be an array');
  if (!Array.isArray(features)) throw new DocumentFormatError('features must be an array');

  for (const p of parameters) {
    if (typeof p?.name !== 'string' || typeof p?.expression !== 'string') {
      throw new DocumentFormatError('each parameter needs a name and an expression');
    }
  }

  const ids = new Set<string>();
  for (const f of features) {
    if (typeof f?.id !== 'string' || typeof f?.type !== 'string') {
      throw new DocumentFormatError('each feature needs an id and a type');
    }
    if (ids.has(f.id)) throw new DocumentFormatError(`duplicate feature id "${f.id}"`);
    ids.add(f.id);
  }

  const sketches = doc.sketches ?? {};
  if (typeof sketches !== 'object' || sketches === null || Array.isArray(sketches)) {
    throw new DocumentFormatError('sketches must be a table keyed by sketch id');
  }
  for (const [id, sketch] of Object.entries(sketches as Record<string, unknown>)) {
    const data = sketch as Partial<SketchData> | null;
    if (!data || !Array.isArray(data.geometry) || !Array.isArray(data.constraints) || !data.plane) {
      throw new DocumentFormatError(`sketch "${id}" needs a plane, geometry and constraints`);
    }
  }
  // A feature that names a sketch the file does not carry would fail on every rebuild
  // with a message about a missing sketch; better to refuse the file with a reason.
  for (const f of features) {
    if (typeof f.sketchId === 'string' && !(f.sketchId in (sketches as object))) {
      throw new DocumentFormatError(
        `feature "${f.id}" refers to sketch "${f.sketchId}", which is not in the file`,
      );
    }
  }

  const meta = (doc.meta ?? {}) as Partial<DocumentMeta>;
  const camera = meta.camera;
  const cameraOk = camera
    && ['azimuth', 'elevation', 'zoom'].every(
      (k) => typeof (camera as unknown as Record<string, unknown>)[k] === 'number')
    && typeof camera.pivot === 'object';
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: {
      name: meta.name ?? 'Untitled',
      created: meta.created ?? new Date(0).toISOString(),
      modified: meta.modified ?? new Date(0).toISOString(),
      units: 'mm',
      application: meta.application ?? 'CARDstock',
      // Only carried when well-formed: a bad thumbnail is a broken image, a bad camera
      // is a NaN projection and a viewport that silently stops picking (ADR-0002).
      ...(typeof meta.thumbnail === 'string' && meta.thumbnail.startsWith('data:image/')
        ? { thumbnail: meta.thumbnail } : {}),
      ...(cameraOk ? { camera } : {}),
    },
    parameters: parameters as Parameter[],
    features: features as Feature[],
    sketches: sketches as Record<string, SketchData>,
  };
}
