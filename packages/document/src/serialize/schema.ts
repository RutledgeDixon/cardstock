import type { Feature } from '../features/feature.js';
import type { Parameter } from '../params/parameters.js';

/**
 * The `.card` file format.
 *
 * No geometry is stored — the model is fully recomputed on open. Files stay small and
 * diff readably in git, which matters for versioning real parts. The schema is versioned
 * from day one with a migration harness, because it will change.
 */

export const CURRENT_SCHEMA_VERSION = 1;

export interface DocumentFile {
  readonly schemaVersion: number;
  readonly meta: DocumentMeta;
  readonly parameters: readonly Parameter[];
  readonly features: readonly Feature[];
}

export interface DocumentMeta {
  readonly name: string;
  /** ISO 8601. */
  readonly created: string;
  readonly modified: string;
  /** Documents are millimetres. Recorded explicitly so a future unit switch is detectable. */
  readonly units: 'mm';
  readonly application: string;
}

export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migrations from version N to N+1, indexed by source version.
 *
 * Add one whenever the schema changes; never edit an existing migration, because files
 * already exist that depend on it behaving exactly as it did.
 */
export const MIGRATIONS = new Map<number, Migration>([
  // [1, (doc) => ({ ...doc, schemaVersion: 2, /* ... */ })],
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

  const meta = (doc.meta ?? {}) as Partial<DocumentMeta>;
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: {
      name: meta.name ?? 'Untitled',
      created: meta.created ?? new Date(0).toISOString(),
      modified: meta.modified ?? new Date(0).toISOString(),
      units: 'mm',
      application: meta.application ?? 'CARDstock',
    },
    parameters: parameters as Parameter[],
    features: features as Feature[],
  };
}
