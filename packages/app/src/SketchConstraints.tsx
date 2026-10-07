import { isDimensional } from '@cardstock/types';
import type { Sketch } from '@cardstock/document';
import { CONSTRAINT_LABELS } from './labels.js';

/**
 * Every constraint on a sketch, in the panel, with a way to remove each.
 *
 * The sketch feature had nothing to show — no dimensions of its own — and this is what
 * it has: what pins the sketch down. A constraint you cannot see is one you cannot
 * remove when it is the reason the sketch will not move.
 */
export function SketchConstraints({ sketch, selected, selectedConstraint, flagged, onHover, onPick, onRemove }: {
  sketch: Sketch | null;
  /** Any change to this re-renders; the sketch itself is mutable and not React state. */
  revision: number;
  /** Entities selected in the open sketch, when this sketch is the one being edited. */
  selected: ReadonlySet<string> | null;
  /** The row picked in this list; Delete removes it. */
  selectedConstraint: string | null;
  /** Constraints the solver found redundant or contradictory. */
  flagged: ReadonlySet<string>;
  /** Point at a constraint (null when leaving): light what it ties. */
  onHover: (constraintId: string | null, ids: string[]) => void;
  /** Pick a constraint: select its row and the entities it ties. */
  onPick: (constraintId: string, ids: string[]) => void;
  onRemove: (constraintId: string) => void;
}) {
  if (!sketch) return null;
  const idsOf = (c: Record<string, unknown>) =>
    ['a', 'b', 'point', 'line', 'entity', 'circle']
      .map((k) => c[k]).filter((v): v is string => typeof v === 'string');
  // A line's constraints are also its endpoints' concern: selecting a vertex should
  // show the horizontal on the line it ends, since that is what stops it moving.
  const touches = (ids: string[]) => {
    if (!selected || selected.size === 0) return false;
    if (ids.some((id) => selected.has(id))) return true;
    return ids.some((id) => {
      const e = sketch.entity(id);
      return e?.type === 'line' && (selected.has(e.p1) || selected.has(e.p2));
    });
  };
  const all = sketch.constraints.map((c) => ({ c, ids: idsOf(c as unknown as Record<string, unknown>) }));
  const related = all.filter(({ ids }) => touches(ids));
  const row = ({ c, ids }: (typeof all)[number], isRelated: boolean) => {
    const raw = c as unknown as Record<string, unknown>;
    const value = raw.value;
    const reference = raw.reference === true;
    return (
      <div
        key={c.id}
        className={`constraint${reference ? ' is-reference' : ''}${isRelated ? ' is-related' : ''}${
          selectedConstraint === c.id ? ' is-selected' : ''}${flagged.has(c.id) ? ' is-flagged' : ''}`}
        data-constraint={c.id}
        title={flagged.has(c.id)
          ? 'The solver finds this redundant or contradictory — remove it'
          : 'Click to select; Delete removes it'}
        onClick={() => onPick(c.id, ids)}
        onPointerEnter={() => onHover(c.id, ids)}
        onPointerLeave={() => onHover(null, [])}
      >
        <span className="constraint-type">{CONSTRAINT_LABELS[c.type] ?? c.type}</span>
        <span className="constraint-entities">
          {ids.map((id) => sketch.entity(id)?.external ?? id).join(' · ')}
        </span>
        {value !== undefined && (
          <span className={`constraint-value${reference ? '' : ' is-driving'}`}>
            {String(value)}{reference ? ' (ref)' : ''}
          </span>
        )}
        <button
          type="button"
          className="constraint-remove"
          title="Remove this constraint"
          onClick={(e) => { e.stopPropagation(); onRemove(c.id); }}
        >×</button>
      </div>
    );
  };
  // Two kinds: dimensions (a number you can type) and logical rules. Within each,
  // what touches the selection comes first and is lit.
  const isDim = ({ c }: (typeof all)[number]) => isDimensional(c.type);
  const group = (title: string, items: typeof all) => (
    <>
      <div className="panel-section-title">
        {title} <span className="about-dim">· {items.length}</span>
      </div>
      {items.length === 0 && <div className="about-dim constraint-empty">None</div>}
      {[...items.filter((x) => related.includes(x)), ...items.filter((x) => !related.includes(x))]
        .map((x) => row(x, related.includes(x)))}
    </>
  );
  return (
    <div className="constraints">
      {selected && selected.size > 0 && related.length === 0 && (
        <div className="about-dim constraint-empty">Nothing holds the selection — it is free to move</div>
      )}
      {group('Dimensional', all.filter(isDim))}
      {group('Logical', all.filter((x) => !isDim(x)))}
    </div>
  );
}
