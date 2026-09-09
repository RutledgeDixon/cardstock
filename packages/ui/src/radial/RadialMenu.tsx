import { useEffect, useState } from 'react';
import {
  type CommandContext, type CommandRegistry, type CommandState,
  type ResolvedCommand, layoutRadial, sectorOffset,
} from '@cardstock/commands';

/**
 * The radial context menu.
 *
 * Right-click resolves what is under the cursor to a context, and the registry supplies
 * that context's commands in their DECLARED sectors — so a command is always in the same
 * direction and the flick becomes muscle memory. Overflow opens a flat searchable list.
 * There are no submenus.
 */
export interface RadialMenuProps {
  registry: CommandRegistry;
  state: CommandState;
  context: CommandContext;
  at: { x: number; y: number };
  onRun: (id: string) => void;
  onClose: () => void;
}

const RADIUS = 92;

export function RadialMenu({ registry, state, context, at, onRun, onClose }: RadialMenuProps) {
  const [flyout, setFlyout] = useState<{
    items: readonly ResolvedCommand[]; title: string; at: { x: number; y: number };
  } | null>(null);
  const slots = layoutRadial(registry.forContext(context, state));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="radial-scrim" onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        className="radial"
        style={{ left: at.x, top: at.y }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="radial-context">{context}</div>

        {slots.map((slot) => {
          if (!slot.command && !slot.overflow) return null;
          const offset = sectorOffset(slot.sector);
          const style = {
            left: offset.x * RADIUS,
            top: offset.y * RADIUS,
          };

          if (slot.overflow) {
            return (
              <button
                key={`more-${slot.sector}`}
                type="button"
                className="radial-item radial-more"
                style={style}
                onClick={() => setFlyout({
                  items: slot.overflow!, title: 'More',
                  at: { x: offset.x * RADIUS, y: offset.y * RADIUS },
                })}
              >
                <span className="radial-icon">…</span>
                <span className="radial-label">More</span>
              </button>
            );
          }

          const disabled = slot.enabled !== true;
          const isGroup = registry.isGroup(slot.command!.id);
          return (
            <button
              key={slot.command!.id}
              type="button"
              className="radial-item"
              style={style}
              disabled={disabled}
              title={disabled ? String(slot.enabled) : (slot.command!.hint ?? '')}
              data-command={slot.command!.id}
              onClick={() => {
                // A group opens its options in place rather than doing something.
                if (isGroup) {
                  setFlyout({
                    items: registry.childrenOf(slot.command!.id, state),
                    title: slot.command!.title,
                    at: { x: offset.x * RADIUS, y: offset.y * RADIUS },
                  });
                  return;
                }
                onRun(slot.command!.id);
                onClose();
              }}
            >
              <span className="radial-icon" aria-hidden="true">{slot.command!.icon}</span>
              <span className="radial-label">
                {slot.command!.title}{isGroup ? ' ›' : ''}
              </span>
            </button>
          );
        })}
      </div>

      {flyout && (
        <div
          className="radial-overflow"
          style={{
            // Anchor beside the sector it came from, so the eye does not have to
            // re-find the menu.
            left: at.x + flyout.at.x + (flyout.at.x < 0 ? -140 : 44),
            top: at.y + flyout.at.y,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="radial-overflow-title">{flyout.title}</div>
          {flyout.items.map(({ command, enabled }) => (
            <button
              key={command.id}
              type="button"
              disabled={enabled !== true}
              title={enabled !== true ? String(enabled) : (command.hint ?? '')}
              data-command={command.id}
              onClick={() => { onRun(command.id); onClose(); }}
            >
              <span aria-hidden="true">{command.icon}</span> {command.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
