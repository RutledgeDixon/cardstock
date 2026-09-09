import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CommandRegistry, CommandState, ResolvedCommand } from '@cardstock/commands';

/**
 * The tool panel: a full-height strip down the right edge, like a desktop taskbar.
 *
 * Each entry is an icon with its name beneath, so the strip is readable without hovering
 * and stays scannable as it grows. Contents come straight from the command registry, so
 * there is no second list to keep in sync.
 *
 * Groups (New shape, Modify edge) open a one-level flyout. Deliberately the only nesting
 * in the app: a child may not itself be a group, and the registry enforces that.
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
      if (target.closest('.flyout')) return; // the flyout lives outside the panel now
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

  const hold = (id: string | null, anchor?: HTMLElement | null) => {
    window.clearTimeout(closeTimer.current);
    if (id === null) { setOpenGroup(null); return; }
    const rect = (anchor ?? panelRef.current)?.getBoundingClientRect();
    setOpenGroup({
      id,
      top: rect?.top ?? 0,
      right: window.innerWidth - (rect?.left ?? 0) + 6,
    });
  };
  // A short grace period so the pointer can cross the gap into the flyout.
  const release = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpenGroup(null), 220);
  };

  return (
    <div className="toolpanel" role="toolbar" aria-label="Tools" ref={panelRef}>
      {entries.map(({ command, enabled }, index) => {
        const previous = entries[index - 1]?.command.toolbar?.order ?? 0;
        // A gap in the declared order becomes a divider, which is how the strip stays
        // grouped without nesting anything.
        const divided = index > 0 && command.toolbar!.order - previous >= 10;
        const isGroup = registry.isGroup(command.id);
        const disabled = enabled !== true;
        const open = openGroup?.id === command.id;

        return (
          <div
            key={command.id}
            className={`toolslot${divided ? ' is-divided' : ''}`}
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

            {isGroup && open && createPortal(
              <Flyout
                items={registry.childrenOf(command.id, state)}
                at={{ top: openGroup!.top, right: openGroup!.right }}
                onRun={(id) => { onRun(id); setOpenGroup(null); }}
                onEnter={() => hold(command.id)}
                onLeave={release}
              />,
              document.body,
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Rendered into document.body rather than inside the panel.
 *
 * The panel scrolls vertically, and a box with `overflow-y: auto` computes `overflow-x`
 * as `auto` too whatever you ask for — so a flyout nested inside it is clipped away
 * entirely. A portal sidesteps that.
 */
function Flyout({
  items, at, onRun, onEnter, onLeave,
}: {
  items: readonly ResolvedCommand[];
  at: { top: number; right: number };
  onRun: (id: string) => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  return (
    <div
      className="flyout"
      style={{ top: at.top, right: at.right }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      {items.map(({ command, enabled }) => (
        <button
          key={command.id}
          type="button"
          disabled={enabled !== true}
          title={enabled !== true ? String(enabled) : (command.hint ?? '')}
          data-command={command.id}
          onClick={() => onRun(command.id)}
        >
          <span className="flyout-icon" aria-hidden="true">{command.icon}</span>
          <span>{command.title}</span>
        </button>
      ))}
    </div>
  );
}
