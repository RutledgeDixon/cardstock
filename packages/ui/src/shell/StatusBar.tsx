/**
 * The status line: what is under the cursor, what the last rebuild cost, and any
 * problem. Errors sit here AND on the offending tree row, because a message that only
 * appears in a corner is a message people stop reading.
 */
export function StatusBar({
  hover, filter, selectionCount, rebuildMs, meshMs, triangles, faces, cached, error, busy,
}: {
  hover: string | null;
  filter: string;
  selectionCount: number;
  rebuildMs: number | null;
  meshMs: number | null;
  triangles: number | null;
  faces: number | null;
  cached: number;
  error: string | null;
  busy: boolean;
}) {
  return (
    <div className="status" role="status">
      <span className="status-left">
        {busy ? <span className="status-busy">rebuilding…</span> : hover ?? <span className="dim">point at the model</span>}
        {selectionCount > 0 && <span className="sel"> · {selectionCount} selected</span>}
      </span>

      <span className="status-mid">
        <span className="dim">filter</span> <b>{filter}</b>
        <span className="dim"> · tab to cycle · </span>
        <span className="dim">right-click for actions</span>
      </span>

      <span className="status-right">
        {faces !== null && <span className="dim">{faces}f · {triangles} tris </span>}
        {rebuildMs !== null && (
          <span className="dim">
            rebuild {rebuildMs.toFixed(0)}ms{meshMs !== null ? ` · mesh ${meshMs.toFixed(0)}ms` : ''}
            {cached > 0 ? ` · ${cached} cached` : ''}
          </span>
        )}
      </span>

      {error && <span className="status-error" title={error}>{error}</span>}
    </div>
  );
}
