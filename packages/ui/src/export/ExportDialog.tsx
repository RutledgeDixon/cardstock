import { useEffect, useRef } from 'react';

/**
 * The export dialog.
 *
 * Quality is two typed numbers, not a slider, and the consequence — how many triangles
 * that makes, and whether the mesh is closed — is shown live before anything is written.
 * A watertight check here is the difference between "exported" and "printable": a
 * slicer refuses or silently repairs an open mesh, and either way it is not the part.
 *
 * Knows nothing about geometry: the host computes the stats and writes the file.
 */
export interface ExportFormatOption {
  readonly id: string;
  readonly label: string;
  /** Whether quality applies; STEP writes the B-rep and has no triangles. */
  readonly mesh: boolean;
}

export interface ExportQuality {
  /** Max deviation from the true surface, mm. */
  readonly linear: number;
  /** Max angle between neighbouring facets, degrees. */
  readonly angular: number;
}

export interface ExportStats {
  readonly triangles: number;
  readonly vertices: number;
  readonly watertight: boolean;
}

export const QUALITY_PRESETS: ReadonlyArray<{ label: string; quality: ExportQuality }> = [
  { label: 'Fine', quality: { linear: 0.005, angular: 5 } },
  { label: 'Standard', quality: { linear: 0.01, angular: 10 } },
  { label: 'Coarse', quality: { linear: 0.05, angular: 20 } },
];

export function ExportDialog({
  formats, format, onFormat,
  quality, onQuality,
  scope, onScope, bodyCount, selectedCount,
  stats, fileName, busy, onExport, onClose,
}: {
  formats: readonly ExportFormatOption[];
  format: string;
  onFormat: (id: string) => void;
  quality: ExportQuality;
  onQuality: (q: ExportQuality) => void;
  scope: 'all' | 'selected';
  onScope: (scope: 'all' | 'selected') => void;
  bodyCount: number;
  selectedCount: number;
  /** null while computing. */
  stats: ExportStats | null;
  fileName: string;
  busy: boolean;
  onExport: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const current = formats.find((f) => f.id === format);
  const isMesh = current?.mesh ?? true;
  const preset = QUALITY_PRESETS.find(
    (p) => p.quality.linear === quality.linear && p.quality.angular === quality.angular,
  );

  const number = (label: string, key: keyof ExportQuality, unit: string, step: number) => (
    <div className="field">
      <label htmlFor={`export-${key}`}>{label}</label>
      <div className="field-body">
        <input
          id={`export-${key}`}
          type="number"
          inputMode="decimal"
          min={0}
          step={step}
          value={quality[key]}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) onQuality({ ...quality, [key]: v });
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <span className="field-unit">{unit}</span>
      </div>
    </div>
  );

  return (
    <div className="about-scrim" onPointerDown={onClose}>
      <div
        ref={ref}
        className="about export"
        role="dialog"
        aria-modal="true"
        aria-label="Export"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && !busy && (e.target as HTMLElement).tagName !== 'BUTTON') onExport();
        }}
      >
        <div className="panel-head">
          <span className="panel-title">Export</span>
          <span className="panel-sub">{fileName}</span>
        </div>

        <div className="field">
          <label htmlFor="export-format">Format</label>
          <div className="field-body">
            <select id="export-format" value={format} onChange={(e) => onFormat(e.target.value)}>
              {formats.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
        </div>

        {bodyCount > 1 && (
          <div className="field">
            <label htmlFor="export-scope">Bodies</label>
            <div className="field-body">
              <select id="export-scope" value={scope} onChange={(e) => onScope(e.target.value as 'all' | 'selected')}>
                <option value="all">All {bodyCount} bodies</option>
                <option value="selected" disabled={selectedCount === 0}>
                  {selectedCount === 0 ? 'Selected (none selected)' : `Selected (${selectedCount})`}
                </option>
              </select>
            </div>
          </div>
        )}

        {isMesh && (
          <>
            <div className="field">
              <label htmlFor="export-preset">Quality</label>
              <div className="field-body">
                <select
                  id="export-preset"
                  value={preset?.label ?? 'custom'}
                  onChange={(e) => {
                    const p = QUALITY_PRESETS.find((q) => q.label === e.target.value);
                    if (p) onQuality(p.quality);
                  }}
                >
                  {QUALITY_PRESETS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
                  {!preset && <option value="custom">Custom</option>}
                </select>
              </div>
            </div>
            <div className="export-quality">
              {number('Max deviation', 'linear', 'mm', 0.005)}
              {number('Max facet angle', 'angular', '°', 1)}
            </div>
            <div className="export-stats" aria-live="polite">
              {stats === null ? (
                <span className="about-dim">Counting triangles…</span>
              ) : (
                <>
                  <span>{stats.triangles.toLocaleString()} triangles</span>
                  <span className="about-dim"> · {stats.vertices.toLocaleString()} vertices · </span>
                  <span className={stats.watertight ? 'export-ok' : 'export-bad'}>
                    {stats.watertight ? 'watertight' : 'NOT watertight'}
                  </span>
                </>
              )}
            </div>
          </>
        )}
        {!isMesh && (
          <div className="export-stats about-dim">
            Exact geometry, no triangles. Opens in any CAD program.
          </div>
        )}

        <div className="export-actions">
          <button type="button" className="about-close" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="about-close export-go"
            disabled={busy || (scope === 'selected' && selectedCount === 0)}
            onClick={onExport}
          >
            {busy ? 'Writing…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
