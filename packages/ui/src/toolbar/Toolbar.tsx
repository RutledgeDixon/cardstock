import type { CommandState, CommandRegistry } from '@cardstock/commands';

/**
 * The toolbar: one level, right edge, no submenus.
 *
 * Contents come straight from the command registry, so there is no separate list to keep
 * in sync and no place a submenu could be added. Disabled buttons stay visible and their
 * tooltip says why — a button that vanishes teaches nothing, and a greyed one with no
 * explanation is a dead end.
 */
export function Toolbar({
  registry, state, onRun,
}: {
  registry: CommandRegistry;
  state: CommandState;
  onRun: (id: string) => void;
}) {
  const entries = registry.toolbar(state);

  return (
    <div className="toolbar" role="toolbar" aria-label="Tools">
      {entries.map(({ command, enabled }, index) => {
        const previous = entries[index - 1]?.command.toolbar?.order ?? 0;
        // A gap in the declared order becomes a visual group separator, which is how the
        // strip stays readable without nesting anything.
        const separated = command.toolbar!.order - previous >= 10 && index > 0;
        const disabled = enabled !== true;
        return (
          <button
            key={command.id}
            type="button"
            className={`tool${separated ? ' tool-grouped' : ''}`}
            disabled={disabled}
            title={disabled ? `${command.title} — ${enabled}` : (command.hint ?? command.title)}
            aria-label={command.title}
            data-command={command.id}
            onClick={() => onRun(command.id)}
          >
            <span className="tool-icon" aria-hidden="true">{command.icon}</span>
            <span className="tool-label">{command.title}</span>
          </button>
        );
      })}
    </div>
  );
}
