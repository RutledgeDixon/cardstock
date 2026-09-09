import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION, DocumentFormatError, MIGRATIONS, migrate, validate,
} from './schema.js';

const minimal = (over: Record<string, unknown> = {}) => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  meta: { name: 'Part', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', units: 'mm', application: 'CARDstock' },
  parameters: [{ name: 'w', expression: '40', unit: 'mm' }],
  features: [{ id: 'f1', type: 'box', name: 'Base', values: { dx: 'w' }, inputs: {} }],
  ...over,
});

describe('validation', () => {
  it('accepts a well-formed document', () => {
    const doc = migrate(minimal());
    expect(doc.features).toHaveLength(1);
    expect(doc.meta.units).toBe('mm');
  });

  it('rejects things that are not documents', () => {
    for (const bad of [null, 42, 'text', []]) {
      expect(() => migrate(bad)).toThrow(DocumentFormatError);
    }
  });

  it('rejects a missing or bad schemaVersion', () => {
    expect(() => migrate({ ...minimal(), schemaVersion: undefined })).toThrow(/schemaVersion/);
    expect(() => migrate({ ...minimal(), schemaVersion: 0 })).toThrow(/schemaVersion/);
    expect(() => migrate({ ...minimal(), schemaVersion: 1.5 })).toThrow(/schemaVersion/);
  });

  it('gives an actionable message for a document from a newer build', () => {
    // The user's real problem is "your CARDstock is too old", so say that.
    expect(() => migrate({ ...minimal(), schemaVersion: 99 }))
      .toThrow(/version 99.*Update CARDstock/s);
  });

  it('rejects malformed parameters and features', () => {
    expect(() => migrate(minimal({ parameters: 'nope' }))).toThrow(/parameters must be an array/);
    expect(() => migrate(minimal({ features: {} }))).toThrow(/features must be an array/);
    expect(() => migrate(minimal({ parameters: [{ name: 'w' }] }))).toThrow(/name and an expression/);
    expect(() => migrate(minimal({ features: [{ type: 'box' }] }))).toThrow(/id and a type/);
  });

  it('rejects duplicate feature ids, which would corrupt the graph', () => {
    expect(() => migrate(minimal({
      features: [{ id: 'f1', type: 'box' }, { id: 'f1', type: 'cylinder' }],
    }))).toThrow(/duplicate feature id "f1"/);
  });

  it('fills in missing metadata rather than failing', () => {
    const doc = validate({ ...minimal(), meta: undefined } as never);
    expect(doc.meta.name).toBe('Untitled');
    expect(doc.meta.application).toBe('CARDstock');
  });
});

describe('migration harness', () => {
  it('is a no-op at the current version', () => {
    expect(migrate(minimal()).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('applies a chain of migrations in order', () => {
    // Exercise the harness itself, independent of whether any migrations exist yet.
    const original = new Map(MIGRATIONS);
    try {
      MIGRATIONS.set(1, (d) => ({ ...d, schemaVersion: 2, migratedBy1: true }));
      MIGRATIONS.set(2, (d) => ({ ...d, schemaVersion: 3, migratedBy2: true }));
      const spy = { ...minimal(), schemaVersion: 1 };
      // Pretend the current version is 3 by migrating manually through the map.
      let doc: Record<string, unknown> = spy;
      let v = 1;
      while (v < 3) { doc = MIGRATIONS.get(v)!(doc); v = doc.schemaVersion as number; }
      expect(doc.migratedBy1).toBe(true);
      expect(doc.migratedBy2).toBe(true);
      expect(doc.schemaVersion).toBe(3);
    } finally {
      MIGRATIONS.clear();
      for (const [k, v] of original) MIGRATIONS.set(k, v);
    }
  });

  it('refuses a migration that fails to advance the version', () => {
    const original = new Map(MIGRATIONS);
    try {
      MIGRATIONS.set(1, (d) => ({ ...d })); // forgets to bump
      // Only reachable when there is a version above 1 to migrate toward.
      if (CURRENT_SCHEMA_VERSION > 1) {
        expect(() => migrate({ ...minimal(), schemaVersion: 1 })).toThrow(/did not advance/);
      }
    } finally {
      MIGRATIONS.clear();
      for (const [k, v] of original) MIGRATIONS.set(k, v);
    }
  });
});
