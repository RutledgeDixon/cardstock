import { useEffect, useRef, useState } from 'react';
import type { CommandRegistry, CommandState } from '@cardstock/commands';
import { Submenu } from '../submenu/Submenu.js';

/**
 * The tool panel: a full-height strip down the right edge, like a desktop taskbar.
 *
 * Each entry is an icon with its name beneath, so the strip is readable without hovering
 * and stays scannable as it grows. Contents come straight from the command registry, so
 * there is no second list to keep in sync.
 *
 * Groups open a one-level submenu, through the shared Submenu component so every flyout
 * in the app looks and behaves the same. A child may not itself be a group; the registry
 * enforces that.
 */
export function Toolbar({
  registry, state, onRun,
}: {
  registry: CommandRegistry;
  state: CommandState;
  onRun: (id: string) => void;
}) {
  const entries = registry.toolbar(state);
  const [openGroup, setOpenGroup] = useState<{ id: string; top: number; right: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  // Close on a click anywhere else, and on Escape — a flyout that traps the pointer is
  // worse than no flyout.
  useEffect(() => {
    if (!openGroup) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (panelRef.current?.contains(target)) return;
      if (target.closest('.submenu')) return; // the submenu is portalled outside the panel
      setOpenGroup(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenGroup(null); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openGroup]);

  /**
   * Open a group, or keep it open.
   *
   * The position is measured ONCE, from the button that opened it. Re-measuring when the
   * pointer enters the flyout would move it — the flyout is not the button, so it has a
   * different rect — and a menu that jumps out from under the cursor then closes because
   * the cursor is no longer on it.
   */
  const hold = (id: string | null, anchor?: HTMLElement | null) => {
    window.clearTimeout(closeTimer.current);
    if (id === null) { setOpenGroup(null); return; }
    setOpenGroup((current) => {
      if (current?.id === id) return current; // already placed; leave it exactly where it is
      const rect = anchor?.getBoundingClientRect();
      return {
        id,
        top: rect?.top ?? 0,
        // Butt it right against the panel: a gap the pointer must cross is a gap it can
        // leave through.
        right: window.innerWidth - (rect?.left ?? 0),
      };
    });
  };
  // A grace period, so a diagonal move toward the flyout does not close it en route.
  const release = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpenGroup(null), 450);
  };

  return (
    <div className="toolpanel" role="toolbar" aria-label="Tools" ref={panelRef}>
      {entries.map(({ command, enabled }, index) => {
        const previous = entries[index - 1]?.command.toolbar?.order ?? 0;
        // A gap in the declared order becomes a divider, which is how the strip stays
        // grouped without nesting anything.
        const divided = index > 0 && command.toolbar!.order - previous >= 10;
        // The first pinned entry takes the slack, pushing it and anything after it to
        // the bottom of the strip.
        const pinned = command.toolbar?.pin === 'end'
          && entries[index - 1]?.command.toolbar?.pin !== 'end';
        const isGroup = registry.isGroup(command.id);
        const disabled = enabled !== true;
        const open = openGroup?.id === command.id;

        return (
          <div
            key={command.id}
            className={`toolslot${divided ? ' is-divided' : ''}${pinned ? ' is-pinned' : ''}`}
            onPointerEnter={(e) => { if (isGroup && !disabled) hold(command.id, e.currentTarget); }}
            onPointerLeave={release}
          >
            <button
              type="button"
              className={`tool${open ? ' is-open' : ''}${isGroup ? ' is-group' : ''}`}
              disabled={disabled}
              title={disabled ? `${command.title} — ${enabled}` : (command.hint ?? command.title)}
              aria-label={command.title}
              aria-haspopup={isGroup || undefined}
              aria-expanded={isGroup ? open : undefined}
              data-command={command.id}
              onClick={(e) => {
                if (isGroup) hold(open ? null : command.id, e.currentTarget.parentElement);
                else onRun(command.id);
              }}
            >
              <span className="tool-icon" aria-hidden="true">{command.icon}</span>
              <span className="tool-name">{command.title}</span>
              {isGroup && <span className="tool-caret" aria-hidden="true">‹</span>}
            </button>

            {isGroup && open && (
              <Submenu
                items={registry.childrenOf(command.id, state)}
                anchor={{ top: openGroup!.top, right: openGroup!.right }}
                onRun={(id) => { onRun(id); setOpenGroup(null); }}
                onEnter={() => hold(command.id)}
                onLeave={release}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
