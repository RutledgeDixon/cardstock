import type { FeatureId } from '@cardstock/types';

/**
 * The feature tree.
 *
 * Rows carry their build status, so a broken reference or a failed operation is visible
 * where the feature lives rather than only in a status bar. Reordering rewires the
 * primary chain (Phase 2), and a move the model cannot take is refused with a reason.
 */
export interface FeatureRow {
  readonly id: FeatureId;
  readonly name: string;
  readonly type: string;
  /** How many features deep this one's origin chain goes; drives the indent. */
  readonly depth?: number;
  readonly status: 'ok' | 'error' | 'blocked' | 'suppressed';
  readonly message?: string;
}

export function FeatureTree({
  rows, focused, onFocus, onContextMenu, onReorder,
}: {
  rows: readonly FeatureRow[];
  focused: FeatureId | null;
  onFocus: (id: FeatureId) => void;
  onContextMenu: (id: FeatureId, at: { x: number; y: number }) => void;
  onReorder: (id: FeatureId, toIndex: number) => void;
}) {
  return (
    <div className="tree" aria-label="Feature tree">
      <div className="tree-title">Features</div>
      {rows.length === 0 && <div className="tree-empty">Nothing yet — add a box</div>}
      <ul>
        {rows.map((row, index) => (
          <li
            key={row.id}
            className={`tree-row status-${row.status}${row.id === focused ? ' is-focused' : ''}`}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/plain', row.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const dragged = e.dataTransfer.getData('text/plain') as FeatureId;
              if (dragged && dragged !== row.id) onReorder(dragged, index);
            }}
            onPointerDown={() => onFocus(row.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onFocus(row.id);
              onContextMenu(row.id, { x: e.clientX, y: e.clientY });
            }}
            title={row.message ?? `${row.type}`}
            style={{ paddingLeft: 4 + (row.depth ?? 0) * 14 }}
          >
            {(row.depth ?? 0) > 0 && <span className="tree-branch" aria-hidden="true">└</span>}
            <span className="tree-status" aria-hidden="true">
              {row.status === 'ok' ? '●'
                : row.status === 'suppressed' ? '○'
                : row.status === 'blocked' ? '◌' : '▲'}
            </span>
            <span className="tree-name">{row.name || row.type}</span>
            <span className="tree-type">{row.type}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
