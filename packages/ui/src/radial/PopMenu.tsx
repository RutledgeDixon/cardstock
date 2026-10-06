import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { placeFan, placeSectors, type Bounds, type Point } from './layout.js';

/**
 * THE pop-out menu.
 *
 * Every menu in the app opens through this: a right-click ring, a group opened from one,
 * a sidebar group, a feature's menu in the tree. The buttons start at the point the menu
 * came from — the cursor, or the middle of the button that was clicked — then spread out
 * and grow into place, over a soft dark glow that lifts them off the model.
 *
 * Placement is `layout.ts`: fixed compass directions for a right-click ring, a fan over
 * whatever arc stays on screen for everything else. Nothing is ever placed off screen or
 * under the sidebar.
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

export interface PopMenuProps {
  readonly items: readonly PopItem[];
  /** Where the buttons pop out from. */
  readonly origin: Point;
  /**
   * Fixed directions, one per item, for a right-click ring: sector k of `sectorCount`,
   * clockwise from straight up. Omit to fan the items out over the open arc instead.
   */
  readonly sectors?: readonly number[];
  readonly sectorCount?: number;
  /** Read out for assistive tech. */
  readonly label: string;
  /** A word in the middle of a ring — what was right-clicked. */
  readonly caption?: string;
  /** Why the whole group is unavailable, said where it can be read. */
  readonly blocked?: string;
  /** An item was chosen; `at` is the centre of its button, for a group to open from. */
  readonly onPick: (id: string, at: Point) => void;
  readonly onClose: () => void;
}

/** Every button's size. The CSS (`.radial-item`) must match. */
export const POP_BUTTON = { width: 104, height: 64 } as const;
const EDGE = 8;

/** The area menus may use: the window, less a margin and the sidebar. */
function availableBounds(): Bounds {
  const panel = document.querySelector('.toolpanel')?.getBoundingClientRect();
  const right = panel && panel.width > 0 ? panel.left : window.innerWidth;
  return { left: EDGE, top: EDGE, right: right - EDGE, bottom: window.innerHeight - EDGE };
}

export function PopMenu({
  items, origin, sectors, sectorCount = 8, label, caption, blocked, onPick, onClose,
}: PopMenuProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const bounds = availableBounds();
  const { centre, positions } = sectors
    ? placeSectors(origin, sectors, sectorCount, POP_BUTTON, bounds)
    : placeFan(origin, items.length, POP_BUTTON, bounds);

  // The glow covers the buttons, not the whole circle they might have used: a fan from
  // the sidebar would otherwise darken a disc half of which is empty.
  const xs = positions.map((p) => p.x), ys = positions.map((p) => p.y);
  const pad = 36;
  const box = positions.length === 0 ? null : {
    left: Math.min(...xs, centre.x) - POP_BUTTON.width / 2 - pad,
    top: Math.min(...ys, centre.y) - POP_BUTTON.height / 2 - pad,
    right: Math.max(...xs, centre.x) + POP_BUTTON.width / 2 + pad,
    bottom: Math.max(...ys, centre.y) + POP_BUTTON.height / 2 + pad,
  };

  return createPortal(
    <div
      className="radial-scrim"
      onPointerDown={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
    >
      {box && (
        <div
          className="radial-glow"
          aria-hidden="true"
          style={{
            left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top,
            transformOrigin: `${origin.x - box.left}px ${origin.y - box.top}px`,
          }}
        />
      )}
      <div className="radial radial-ring" role="menu" aria-label={label}>
        {caption && (
          <div className="radial-context" style={{ left: centre.x, top: centre.y }}>{caption}</div>
        )}
        {blocked && box && (
          <div
            className="radial-blocked"
            style={{ left: (box.left + box.right) / 2, top: Math.max(EDGE, box.top + pad / 2 - 14) }}
          >
            {blocked}
          </div>
        )}
        {items.map((item, index) => {
          const at = positions[index]!;
          const style = {
            '--x': `${at.x}px`, '--y': `${at.y}px`,
            '--ox': `${origin.x}px`, '--oy': `${origin.y}px`,
            // A slight stagger, so they visibly spread rather than appear.
            '--delay': `${Math.min(index * 14, 120)}ms`,
          } as CSSProperties;
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`radial-item${item.unavailable ? ' is-disabled' : ''}${
                item.active ? ' is-active' : ''}${item.group ? ' is-group' : ''}`}
              style={style}
              disabled={!!item.unavailable}
              aria-pressed={item.active}
              title={item.unavailable ?? item.hint ?? item.title}
              data-command={item.id}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onPick(item.id, at)}
            >
              <span className="radial-icon" aria-hidden="true">{item.icon}</span>
              <span className="radial-label">{item.title}{item.group ? ' ›' : ''}</span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
