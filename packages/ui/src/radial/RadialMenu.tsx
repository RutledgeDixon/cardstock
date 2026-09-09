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
  const [overflow, setOverflow] = useState<readonly ResolvedCommand[] | null>(null);
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
                onClick={() => setOverflow(slot.overflow!)}
              >
                <span className="radial-icon">…</span>
                <span className="radial-label">More</span>
              </button>
            );
          }

          const disabled = slot.enabled !== true;
          return (
            <button
              key={slot.command!.id}
              type="button"
              className="radial-item"
              style={style}
              disabled={disabled}
              title={disabled ? String(slot.enabled) : (slot.command!.hint ?? '')}
              data-command={slot.command!.id}
              onClick={() => { onRun(slot.command!.id); onClose(); }}
            >
              <span className="radial-icon" aria-hidden="true">{slot.command!.icon}</span>
              <span className="radial-label">{slot.command!.title}</span>
            </button>
          );
        })}
      </div>

      {overflow && (
        <div
          className="radial-overflow"
          style={{ left: at.x + RADIUS, top: at.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {overflow.map(({ command, enabled }) => (
            <button
              key={command.id}
              type="button"
              disabled={enabled !== true}
              title={enabled !== true ? String(enabled) : ''}
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
