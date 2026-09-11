import { useEffect, useRef } from 'react';

/**
 * The best few ways up, with the numbers behind the ranking.
 *
 * Each row can be applied to the export, so the STL leaves the app already the right
 * way round; nothing about the model changes. The host computes the list.
 */
export interface OrientationRow {
  readonly down: readonly [number, number, number];
  readonly overhangArea: number;
  readonly supportVolume: number;
  readonly contactArea: number;
  readonly height: number;
  readonly score: number;
}

/** A readable name for a direction: "−Z" for the axes, the components otherwise. */
export function describeDown(down: readonly [number, number, number]): string {
  const axes: Array<[string, readonly [number, number, number]]> = [
    ['−Z (as modelled)', [0, 0, -1]], ['+Z (upside down)', [0, 0, 1]],
    ['+X face', [1, 0, 0]], ['−X face', [-1, 0, 0]], ['+Y face', [0, 1, 0]], ['−Y face', [0, -1, 0]],
  ];
  for (const [name, axis] of axes) {
    if (axis[0] * down[0] + axis[1] * down[1] + axis[2] * down[2] > 0.999) return name;
  }
  return `(${down.map((c) => c.toFixed(2)).join(', ')}) down`;
}

export function OrientationDialog({
  rows, applied, onApply, onClear, onClose,
}: {
  /** null while computing. */
  rows: readonly OrientationRow[] | null;
  /** Index of the row currently applied to export, if any. */
  applied: number | null;
  onApply: (index: number) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <div className="about-scrim" onPointerDown={onClose}>
      <div
        ref={ref}
        className="about export orient"
        role="dialog"
        aria-modal="true"
        aria-label="Orientation"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}
      >
        <div className="panel-head">
          <span className="panel-title">Orientation</span>
          <span className="panel-sub">which way up to print it</span>
        </div>

        {rows === null && <div className="export-stats about-dim">Scoring…</div>}
        {rows !== null && rows.length === 0 && <div className="export-stats about-dim">Nothing to orient.</div>}
        {rows !== null && rows.length > 0 && (
          <table className="orient-table">
            <thead>
              <tr>
                <th>Put down</th><th>Overhang</th><th>Support</th><th>On bed</th><th>Height</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className={applied === i ? 'is-applied' : ''}>
                  <td>{describeDown(row.down)}</td>
                  <td className={row.overhangArea > 0 ? 'export-bad' : 'export-ok'}>
                    {row.overhangArea > 0 ? `${(row.overhangArea / 100).toFixed(1)} cm²` : 'none'}
                  </td>
                  <td>{row.supportVolume > 0 ? `~${(row.supportVolume / 1000).toFixed(1)} cm³` : '—'}</td>
                  <td>{(row.contactArea / 100).toFixed(1)} cm²</td>
                  <td>{row.height.toFixed(1)} mm</td>
                  <td>
                    {applied === i
                      ? <button type="button" className="about-close" onClick={onClear}>Applied ✓</button>
                      : <button type="button" className="about-close" onClick={() => onApply(i)}>Use for export</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="about-line about-dim">
          Applying an orientation rotates the exported file only; the model is untouched.
          Support is the column under overhanging surface, before the slicer thins it.
        </p>
        <div className="export-actions">
          <button type="button" className="about-close" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
