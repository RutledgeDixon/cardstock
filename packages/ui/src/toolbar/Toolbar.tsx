import { useRef, useState } from 'react';
import type { CommandRegistry, CommandState } from '@cardstock/commands';
import { PopMenu } from '../radial/PopMenu.js';
import { toPopItem } from '../radial/RadialMenu.js';
import type { Point } from '../radial/layout.js';

/**
 * The tool panel: a full-height strip down the right edge, like a desktop taskbar.
 *
 * Each entry is an icon with its name beneath, so the strip is readable without hovering.
 * Contents come straight from the command registry, so there is no second list to keep
 * in sync. It is kept to a handful of groups — sketch, create, modify, bodies, print,
 * file — so it fits a laptop screen at full size and never scrolls.
 *
 * Clicking a group grows its commands out of the button, through the same PopMenu every
 * other menu uses: the old flyout list, curved into an arc of slices round the button.
 * One level: a child may not itself be a group, and the registry enforces that.
 */
export function Toolbar({
  registry, state, onRun,
}: {
  registry: CommandRegistry;
  state: CommandState;
  onRun: (id: string) => void;
}) {
  const entries = registry.toolbar(state);
  const [openGroup, setOpenGroup] = useState<{ id: string; at: Point } | null>(null);
  const open = openGroup ? entries.find((e) => e.command.id === openGroup.id) : undefined;
  // The menu's backdrop closes it on pointer DOWN; the click that follows would land on
  // the group button and open it straight back up. Clicking an open group's button is
  // meant to close it, so a click right after that close is swallowed.
  const justClosed = useRef<{ id: string; at: number } | null>(null);
  const close = () => {
    if (openGroup) justClosed.current = { id: openGroup.id, at: performance.now() };
    setOpenGroup(null);
  };

  return (
    <div className="toolpanel" role="toolbar" aria-label="Tools">
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
        const isOpen = openGroup?.id === command.id;

        return (
          <div
            key={command.id}
            className={`toolslot${divided ? ' is-divided' : ''}${pinned ? ' is-pinned' : ''}`}
          >
            <button
              type="button"
              className={`tool${isOpen ? ' is-open' : ''}${isGroup ? ' is-group' : ''}${
                disabled ? ' is-unavailable' : ''}${
                command.toolbar?.compact ? ' is-compact' : ''}`}
              // A DISABLED group still opens. Its children carry the reasons they are
              // unavailable, and a button that does nothing and explains nothing is
              // worse than a greyed one you can look inside.
              disabled={disabled && !isGroup}
              title={disabled ? `${command.title} — ${enabled}` : (command.hint ?? command.title)}
              aria-label={command.title}
              aria-haspopup={isGroup || undefined}
              aria-expanded={isGroup ? isOpen : undefined}
              data-command={command.id}
              onClick={(e) => {
                if (!isGroup) { onRun(command.id); return; }
                if (isOpen) { close(); return; }
                const recent = justClosed.current;
                if (recent?.id === command.id && performance.now() - recent.at < 400) return;
                const r = e.currentTarget.getBoundingClientRect();
                setOpenGroup({ id: command.id, at: { x: r.left + r.width / 2, y: r.top + r.height / 2 } });
              }}
            >
              <span className="tool-icon" aria-hidden="true">{command.icon}</span>
              <span className="tool-name">{command.title}</span>
              {isGroup && <span className="tool-caret" aria-hidden="true">‹</span>}
            </button>
          </div>
        );
      })}

      {open && openGroup && (
        <PopMenu
          key={openGroup.id}
          items={registry.childrenOf(open.command.id, state).map((entry) => toPopItem(registry, entry))}
          origin={openGroup.at}
          shape={{ kind: 'arc' }}
          label={open.command.title}
          {...(open.enabled !== true ? { blocked: String(open.enabled) } : {})}
          onPick={(id) => { setOpenGroup(null); onRun(id); }}
          onClose={close}
        />
      )}
    </div>
  );
}
