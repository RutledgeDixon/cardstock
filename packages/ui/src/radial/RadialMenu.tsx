import { useEffect, useState } from 'react';
import {
  RADIAL_SECTORS,
  type CommandContext, type CommandRegistry, type CommandState,
  type ResolvedCommand, layoutRadial, sectorOffset,
} from '@cardstock/commands';
import { Submenu } from '../submenu/Submenu.js';

/**
 * The radial context menu.
 *
 * For things in 3D SPACE only, where there is room in every direction. The feature tree
 * opens a plain flyout instead: a ring centred on a row in the top-left corner was cut off
 * by two edges of the page.
 *
 * Right-click resolves what is under the cursor to a context, and the registry supplies
 * that context's commands in their DECLARED sectors — so a command is always in the same
 * direction and the flick becomes muscle memory. Overflow opens a flat searchable list.
 *
 * Each command is a segment of a ring rather than a floating pill: a wedge is a much
 * bigger target than a label, it shows exactly which direction it owns, and the ring
 * makes the fixed layout legible at a glance instead of something you infer from where
 * the labels happen to sit.
 */
export interface RadialMenuProps {
  registry: CommandRegistry;
  state: CommandState;
  context: CommandContext;
  at: { x: number; y: number };
  onRun: (id: string) => void;
  onClose: () => void;
}

const INNER = 48;
const OUTER = 116;
/** Where the icon and label sit: the middle of the band. */
const MID = (INNER + OUTER) / 2;
/** Half the gap between neighbouring wedges, in radians. */
const GAP = 0.03;
const SPAN = (Math.PI * 2) / RADIAL_SECTORS;

/** A point on the ring, in the SVG's own coordinates. Angle is clockwise from north. */
const point = (radius: number, angle: number) => ({
  x: radius * Math.sin(angle),
  y: -radius * Math.cos(angle),
});

/**
 * One wedge of the ring: an arc out at the rim, back along the inner edge.
 *
 * A 45-degree span never needs the large-arc flag; the sweep flags are 1 outbound and 0
 * back, which is what traces the band rather than a bow tie.
 */
function wedgePath(sector: number): string {
  const centre = sector * SPAN;
  const from = centre - SPAN / 2 + GAP;
  const to = centre + SPAN / 2 - GAP;

  const outerFrom = point(OUTER, from);
  const outerTo = point(OUTER, to);
  const innerTo = point(INNER, to);
  const innerFrom = point(INNER, from);

  return [
    `M ${outerFrom.x.toFixed(2)} ${outerFrom.y.toFixed(2)}`,
    `A ${OUTER} ${OUTER} 0 0 1 ${outerTo.x.toFixed(2)} ${outerTo.y.toFixed(2)}`,
    `L ${innerTo.x.toFixed(2)} ${innerTo.y.toFixed(2)}`,
    `A ${INNER} ${INNER} 0 0 0 ${innerFrom.x.toFixed(2)} ${innerFrom.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

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

  const extent = OUTER + 2;

  return (
    <div className="radial-scrim" onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        className="radial"
        style={{ left: at.x, top: at.y }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <svg
          className="radial-ring"
          width={extent * 2}
          height={extent * 2}
          viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`}
          role="menu"
          aria-label={`${context} actions`}
        >
          {slots.map((slot) => {
            if (!slot.command && !slot.overflow) return null;
            const offset = sectorOffset(slot.sector);
            const label = point(MID, slot.sector * SPAN);
            const flyoutAt = { x: offset.x * MID, y: offset.y * MID };

            const overflow = slot.overflow;
            const command = slot.command;
            const disabled = !overflow && slot.enabled !== true;
            const isGroup = !!command && registry.isGroup(command.id);

            const activate = () => {
              if (overflow) {
                setFlyout({ items: overflow, title: 'More', at: flyoutAt });
                return;
              }
              if (disabled) return;
              // A group opens its options in place rather than doing something.
              if (isGroup) {
                setFlyout({
                  items: registry.childrenOf(command!.id, state),
                  title: command!.title,
                  at: flyoutAt,
                });
                return;
              }
              onRun(command!.id);
              onClose();
            };

            const title = overflow ? 'More'
              : disabled ? String(slot.enabled)
              : (command!.hint ?? command!.title);

            return (
              <g
                key={overflow ? `more-${slot.sector}` : command!.id}
                className={`radial-item${disabled ? ' is-disabled' : ''}`}
                role="menuitem"
                tabIndex={disabled ? -1 : 0}
                aria-disabled={disabled || undefined}
                aria-label={overflow ? 'More' : command!.title}
                data-command={overflow ? undefined : command!.id}
                onClick={activate}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') activate(); }}
              >
                <title>{title}</title>
                <path className="radial-wedge" d={wedgePath(slot.sector)} />
                <text className="radial-icon" x={label.x} y={label.y - 7}>
                  {overflow ? '…' : command!.icon}
                </text>
                <text className="radial-label" x={label.x} y={label.y + 10}>
                  {overflow ? 'More' : `${command!.title}${isGroup ? ' ›' : ''}`}
                </text>
              </g>
            );
          })}
        </svg>

        {/* The hole in the middle names what was right-clicked. */}
        <div className="radial-context">{context}</div>
      </div>

      {flyout && (
        <Submenu
          items={flyout.items}
          title={flyout.title}
          // Beside the sector it came from, so the eye does not have to re-find the menu.
          anchor={flyout.at.x < 0
            ? { top: at.y + flyout.at.y, right: window.innerWidth - (at.x + flyout.at.x) + 64 }
            : { top: at.y + flyout.at.y, left: at.x + flyout.at.x + 64 }}
          onRun={(id) => { onRun(id); onClose(); }}
        />
      )}
    </div>
  );
}
