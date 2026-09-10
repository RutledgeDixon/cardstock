import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ResolvedCommand } from '@cardstock/commands';

/**
 * THE submenu.
 *
 * Every flyout in the app — the toolbar's groups, the radial menu's groups and its
 * overflow — renders through this one component, so how submenus look and behave is
 * changed here once rather than in each place that opens one. Before this there were two
 * separate implementations that had already drifted apart.
 *
 * Rendered through a portal because the toolbar scrolls vertically, and a box with
 * `overflow-y: auto` computes `overflow-x` as `auto` too whatever you ask for, which
 * clips a nested flyout away entirely.
 */

/** Where to put it. Give `right` to grow leftwards, `left` to grow rightwards. */
export interface SubmenuAnchor {
  readonly top: number;
  readonly left?: number;
  readonly right?: number;
}

export interface SubmenuProps {
  readonly items: readonly ResolvedCommand[];
  readonly anchor: SubmenuAnchor;
  /** Shown above the items. Omit for an unlabelled flyout. */
  readonly title?: string;
  /**
   * Why the group that opened this is unavailable.
   *
   * Shown IN the flyout, because a group's tooltip is unreachable: hovering it opens the
   * menu instead of the tooltip, so the reason it was greyed out could never be read.
   */
  readonly blocked?: string;
  readonly onRun: (id: string) => void;
  readonly onEnter?: () => void;
  readonly onLeave?: () => void;
}

export function Submenu({
  items, anchor, title, blocked, onRun, onEnter, onLeave,
}: SubmenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.top);

  /**
   * Keep the flyout on screen.
   *
   * A group near the foot of the toolbar — Combine sits just above the pinned Export —
   * opened a menu that ran off the bottom of the window, with the last item unreachable.
   * Measured after layout rather than estimated from the item count, because the items
   * wrap.
   */
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    const margin = 8;
    const highest = margin;
    const lowest = Math.max(margin, window.innerHeight - height - margin);
    setTop(Math.min(Math.max(anchor.top, highest), lowest));
  }, [anchor.top, items.length]);

  return createPortal(
    <div
      ref={ref}
      className="submenu"
      style={{
        top,
        ...(anchor.left !== undefined ? { left: anchor.left } : {}),
        ...(anchor.right !== undefined ? { right: anchor.right } : {}),
      }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      // Stop the press reaching a scrim that would close the menu underneath it.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {title && <div className="submenu-title">{title}</div>}
      {blocked && <div className="submenu-blocked">{blocked}</div>}
      {items.map(({ command, enabled }) => {
        const disabled = enabled !== true;
        return (
          <button
            key={command.id}
            type="button"
            className="submenu-item"
            disabled={disabled}
            title={disabled ? String(enabled) : (command.hint ?? command.title)}
            data-command={command.id}
            onClick={() => onRun(command.id)}
          >
            <span className="submenu-icon" aria-hidden="true">{command.icon}</span>
            <span className="submenu-label">{command.title}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
