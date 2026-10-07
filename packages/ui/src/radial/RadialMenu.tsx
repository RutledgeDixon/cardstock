import { useState } from 'react';
import {
  RADIAL_SECTORS,
  type CommandContext, type CommandRegistry, type CommandState,
  type ResolvedCommand, layoutRadial,
} from '@cardstock/commands';
import { PopMenu, type PopItem } from './PopMenu.js';
import type { Point } from './layout.js';

/**
 * The right-click menu.
 *
 * Right-click resolves what is under the cursor to a context, and the registry supplies
 * that context's commands in their DECLARED sectors — so a command is always in the same
 * direction and the flick becomes muscle memory. Near an edge the whole ring slides
 * inward rather than any command changing direction.
 *
 * A group, or the "More" that overflow collects into, opens as a ring of its own,
 * growing out of the slice that was clicked: one level, like every submenu in the app.
 */
export interface RadialMenuProps {
  registry: CommandRegistry;
  state: CommandState;
  context: CommandContext;
  at: { x: number; y: number };
  /**
   * Show exactly these instead of what the context resolves to — the constraints that
   * apply to a sketch selection, say. Sectors are laid out in the order given.
   */
  items?: readonly ResolvedCommand[];
  /** Read out for assistive tech in place of the context name. */
  label?: string;
  /** The word in the middle of the ring; the context name when omitted. */
  caption?: string;
  onRun: (id: string) => void;
  onClose: () => void;
}

/** A registry entry as a button. */
export function toPopItem(registry: CommandRegistry, { command, enabled, active }: ResolvedCommand): PopItem {
  return {
    id: command.id,
    icon: command.icon,
    title: command.title,
    ...(command.hint ? { hint: command.hint } : {}),
    ...(enabled !== true ? { unavailable: String(enabled) } : {}),
    ...(active ? { active } : {}),
    ...(registry.isGroup(command.id) ? { group: true } : {}),
  };
}

const MORE = '__more';

export function RadialMenu({
  registry, state, context, at, items, label, caption, onRun, onClose,
}: RadialMenuProps) {
  const [sub, setSub] = useState<{ items: readonly ResolvedCommand[]; title: string; from: Point } | null>(null);

  if (sub) {
    return (
      <PopMenu
        // A new key replays the pop-out, from the button that opened it.
        key={`${sub.title}@${sub.from.x},${sub.from.y}`}
        items={sub.items.map((entry) => toPopItem(registry, entry))}
        origin={sub.from}
        // The same band as the ring it came from, filled clockwise from straight up.
        shape={{
          kind: 'ring',
          sectors: sub.items.map((_, i) => i),
          count: Math.max(RADIAL_SECTORS, sub.items.length),
        }}
        label={sub.title}
        onPick={(id) => { onRun(id); onClose(); }}
        onClose={onClose}
      />
    );
  }

  const slots = layoutRadial(items ?? registry.forContext(context, state))
    .filter((slot) => slot.command || slot.overflow);

  const popItems: PopItem[] = slots.map((slot) => (slot.overflow
    ? { id: MORE, icon: '…', title: 'More', group: true }
    : toPopItem(registry, { command: slot.command!, enabled: slot.enabled })));

  return (
    <PopMenu
      items={popItems}
      origin={at}
      shape={{ kind: 'ring', sectors: slots.map((slot) => slot.sector), count: RADIAL_SECTORS }}
      label={label ?? `${context} actions`}
      caption={caption ?? context}
      onPick={(id, from) => {
        if (id === MORE) {
          const overflow = slots.find((slot) => slot.overflow)?.overflow ?? [];
          setSub({ items: overflow, title: 'More', from });
          return;
        }
        if (registry.isGroup(id)) {
          setSub({ items: registry.childrenOf(id, state), title: registry.get(id)?.title ?? id, from });
          return;
        }
        onRun(id);
        onClose();
      }}
      onClose={onClose}
    />
  );
}
