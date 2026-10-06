import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  placeArc, placeRing, sliceBox, sliceMiddle, type Bounds, type Point, type Slice,
} from './layout.js';

/**
 * THE pop-out menu.
 *
 * Every menu in the app opens through this: a right-click ring, a group opened from one,
 * a sidebar group, a feature's menu in the tree. Each command is a SLICE of a band — a
 * far bigger target than a label, and it shows which direction it owns — and the slices
 * grow out of the point the menu came from (the cursor, or the middle of the sidebar
 * button that was clicked) over a soft dark glow that lifts them off the model.
 *
 * Placement is `layout.ts`: a ring in fixed directions, or for a sidebar group the old
 * list curved into an arc round its button. Nothing lands off screen or under the
 * sidebar.
 */

export interface PopItem {
  readonly id: string;
  readonly icon: string;
  readonly title: string;
  readonly hint?: string;
  /** Why it cannot be used now; it is drawn, greyed, with this as its tooltip. */
  readonly unavailable?: string;
  /** A toggle that is on. */
  readonly active?: boolean;
  /** Opens more options rather than doing something. */
  readonly group?: boolean;
}

export type PopShape =
  /** Fixed directions: sector k of `count`, clockwise from straight up, one per item. */
  | { readonly kind: 'ring'; readonly sectors: readonly number[]; readonly count: number }
  /** A sidebar group: an arc of rows round the button, to its left. */
  | { readonly kind: 'arc' };

export interface PopMenuProps {
  readonly items: readonly PopItem[];
  /** Where the slices grow out from. */
  readonly origin: Point;
  readonly shape: PopShape;
  /** Read out for assistive tech. */
  readonly label: string;
  /** A word in the middle of a ring — what was right-clicked. */
  readonly caption?: string;
  /** Why the whole group is unavailable, said where it can be read. */
  readonly blocked?: string;
  /** An item was chosen; `at` is the middle of its slice, for a group to open from. */
  readonly onPick: (id: string, at: Point) => void;
  readonly onClose: () => void;
}

const EDGE = 8;

/** The area menus may use: the window, less a margin and the sidebar. */
function availableBounds(): Bounds {
  const panel = document.querySelector('.toolpanel')?.getBoundingClientRect();
  const right = panel && panel.width > 0 ? panel.left : window.innerWidth;
  return { left: EDGE, top: EDGE, right: right - EDGE, bottom: window.innerHeight - EDGE };
}

/**
 * One slice: an arc out at the rim, back along the inner edge. The large-arc flag is
 * only needed past a half turn; the sweep flags are 1 outbound and 0 back, which traces
 * the band rather than a bow tie.
 */
function slicePath(s: Slice): string {
  const large = s.to - s.from > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => {
    const x = s.centre.x + r * Math.sin(a), y = s.centre.y - r * Math.cos(a);
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  };
  return [
    `M ${p(s.outer, s.from)}`,
    `A ${s.outer} ${s.outer} 0 ${large} 1 ${p(s.outer, s.to)}`,
    `L ${p(s.inner, s.to)}`,
    `A ${s.inner} ${s.inner} 0 ${large} 0 ${p(s.inner, s.from)}`,
    'Z',
  ].join(' ');
}

export function PopMenu({ items, origin, shape, label, caption, blocked, onPick, onClose }: PopMenuProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const bounds = availableBounds();
  const arc = shape.kind === 'arc';
  const { centre, slices } = shape.kind === 'ring'
    ? placeRing(origin, shape.sectors, shape.count, bounds)
    : { centre: origin, slices: placeArc(origin, items.length, bounds) };
  const width = window.innerWidth, height = window.innerHeight;
  // The glow hugs the slices: an ellipse over their extent, a little larger.
  const boxes = slices.map(sliceBox);
  const glow = boxes.length === 0 ? null : {
    left: Math.min(...boxes.map((b) => b.left)), right: Math.max(...boxes.map((b) => b.right)),
    top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map((b) => b.bottom)),
  };

  return createPortal(
    <div
      className="radial-scrim"
      onPointerDown={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
    >
      <svg
        className={`radial radial-ring${arc ? ' is-arc' : ''}`}
        width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        role="menu" aria-label={label}
      >
        <defs>
          <radialGradient id="radial-glow-fill">
            {/* In style, not attributes: a presentation attribute does not resolve var(). */}
            <stop offset="0%" style={{ stopColor: 'var(--menu-glow)' }} />
            <stop offset="70%" style={{ stopColor: 'var(--menu-glow)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--menu-glow)', stopOpacity: 0 }} />
          </radialGradient>
          {/* The glow round a sidebar arc must not darken the sidebar itself. */}
          <clipPath id="radial-glow-clip">
            <rect x={0} y={0} width={bounds.right + EDGE} height={height} />
          </clipPath>
        </defs>
        {glow && (
          <ellipse
            className="radial-glow"
            cx={(glow.left + glow.right) / 2} cy={(glow.top + glow.bottom) / 2}
            rx={(glow.right - glow.left) / 2 + 34} ry={(glow.bottom - glow.top) / 2 + 34}
            fill="url(#radial-glow-fill)" clipPath="url(#radial-glow-clip)"
            style={{ transformOrigin: `${origin.x}px ${origin.y}px` }}
          />
        )}
        {caption && !arc && (
          <text className="radial-context" x={centre.x} y={centre.y}>{caption}</text>
        )}
        {items.map((item, index) => {
          const slice = slices[index];
          if (!slice) return null;
          const mid = sliceMiddle(slice);
          const pick = () => { if (!item.unavailable) onPick(item.id, mid); };
          return (
            <g
              key={item.id}
              className={`radial-item${item.unavailable ? ' is-disabled' : ''}${
                item.active ? ' is-active' : ''}${item.group ? ' is-group' : ''}`}
              role="menuitem"
              tabIndex={item.unavailable ? -1 : 0}
              aria-disabled={item.unavailable ? true : undefined}
              aria-pressed={item.active}
              aria-label={item.title}
              data-command={item.id}
              // Each slice grows out of the point the menu came from, a beat after the
              // one before, so they visibly spread rather than appear.
              style={{
                transformOrigin: `${origin.x}px ${origin.y}px`,
                animationDelay: `${Math.min(index * 18, 140)}ms`,
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={pick}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}
            >
              <title>{item.unavailable ?? item.hint ?? item.title}</title>
              <path className="radial-wedge" d={slicePath(slice)} />
              {arc ? (
                // A list row, curved: icon and name on one line, as the flyout had them.
                <text className="radial-row" x={mid.x} y={mid.y}>
                  <tspan className="radial-icon">{item.icon}</tspan>
                  <tspan dx={6}>{item.title}{item.group ? ' ›' : ''}</tspan>
                </text>
              ) : (
                <>
                  <text className="radial-icon" x={mid.x} y={mid.y - 7}>{item.icon}</text>
                  <text className="radial-label" x={mid.x} y={mid.y + 10}>
                    {item.title}{item.group ? ' ›' : ''}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      {blocked && slices.length > 0 && (
        <div
          className="radial-blocked"
          style={{
            left: glow ? (glow.left + glow.right) / 2 : centre.x,
            top: Math.max(EDGE + 12, (glow?.top ?? centre.y) - 16),
          }}
        >
          {blocked}
        </div>
      )}
    </div>,
    document.body,
  );
}
