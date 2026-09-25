import { EXPORT_FORMATS, type ExportFormat, type FeatureId, type OrientationSuggestion, type ShapeHandle } from '@cardstock/types';
import type { Document, PrinterProfile } from '@cardstock/document';
import type { createWorkerKernel } from '@cardstock/kernel';
import type { Viewer } from '@cardstock/viewer';
import type { ExportQuality, ExportStats } from '@cardstock/ui';
import type { FileAccess } from '../persistence/files.js';
import { bodyFeatures } from './model-bridge.js';

export interface Exporter {
  stats: (quality: ExportQuality, scope: 'all' | 'selected') => Promise<ExportStats | null>;
  write: (
    format: ExportFormat, quality: ExportQuality, scope: 'all' | 'selected',
    orientation: OrientationSuggestion | null,
  ) => Promise<void>;
  orientations: () => Promise<OrientationSuggestion[]>;
}

export interface ExporterDeps {
  doc: Document;
  viewer: Viewer;
  kernel: ReturnType<typeof createWorkerKernel>;
  handles: ReadonlyMap<string, string>;
  /** Read at call time: the file backend is only resolved after boot. */
  files: () => FileAccess;
  printer: () => PrinterProfile;
  notify: (text: string, kind?: 'info' | 'error') => void;
  /** A file was written; the dialog can close. */
  onWritten: () => void;
}

export function createExporter({ doc, viewer, kernel, handles, files, printer, notify, onWritten }: ExporterDeps): Exporter {
  /** The shape to export: one body, or a compound of several. Compounds are
   *  temporary and must be released, or every export leaks a kernel shape. */
  const exportShape = async (scope: 'all' | 'selected') => {
    const chosen = scope === 'selected'
      ? [...new Set(viewer.selection.selected.filter((r) => r.kind === 'body').map((r) => r.bodyId as unknown as FeatureId))]
      : bodyFeatures(doc);
    const bodies = chosen.map((id) => handles.get(id)).filter((h): h is string => h !== undefined);
    if (bodies.length === 0) return null;
    if (bodies.length === 1) return { handle: bodies[0] as ShapeHandle, count: 1, release: () => {} };
    const { handle } = await kernel.compound(bodies as ShapeHandle[]);
    return { handle, count: bodies.length, release: () => { void kernel.release(handle); } };
  };
  const toKernelQuality = (q: ExportQuality) => ({
    linearDeflection: q.linear, angularDeflection: (q.angular * Math.PI) / 180,
  });
  return {
    stats: async (quality, scope) => {
      const shape = await exportShape(scope);
      if (!shape) return null;
      try {
        return await kernel.meshStats(shape.handle, toKernelQuality(quality));
      } finally { shape.release(); }
    },
    write: async (format, quality, scope, orientation) => {
      const shape = await exportShape(scope);
      if (!shape) { notify('Nothing to export', 'error'); return; }
      const spec = EXPORT_FORMATS[format];
      const name = doc.meta.name || 'part';
      let oriented: { handle: ShapeHandle; release: () => void } | null = null;
      try {
        if (orientation) {
          const { handle } = await kernel.transform(shape.handle, orientation.matrix);
          oriented = { handle, release: () => { void kernel.release(handle); } };
        }
        const result = await kernel.exportModel((oriented ?? shape).handle, format, {
          quality: toKernelQuality(quality), name,
        });
        const written = await files().exportBytes(`${name}${spec.extension}`, result.bytes, spec.mime);
        if (!written) return;
        const size = `${(result.bytes.length / 1024).toFixed(0)} kB`;
        notify(
          result.triangles > 0
            ? `Exported ${spec.label}: ${result.triangles.toLocaleString()} triangles, ${size}`
            : `Exported ${spec.label}: ${size}`,
        );
        onWritten();
      } catch (e) {
        notify(`Export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
      } finally { oriented?.release(); shape.release(); }
    },
    orientations: async () => {
      const shape = await exportShape('all');
      if (!shape) return [];
      try {
        return await kernel.scoreOrientations(shape.handle, {
          maxOverhangDeg: printer().maxOverhang, layer: printer().layer,
        });
      } finally { shape.release(); }
    },
  };
}
