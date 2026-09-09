import type { EntityKind } from '@cardstock/types';
import type { CommandContext } from '../registry/command.js';

/**
 * What the pointer is over, as a command context.
 *
 * Hover wins over selection: a right-click acts on what is under the cursor, which is
 * what the gesture means. Falling back to the selection would make the same click do
 * different things depending on invisible state.
 */
export function contextForSelection(
  hoverKind: EntityKind | null,
  selectionKind: EntityKind | null,
): CommandContext {
  const kind = hoverKind ?? selectionKind;
  switch (kind) {
    case 'face': return 'face';
    case 'edge': return 'edge';
    case 'vertex': return 'vertex';
    case 'body': return 'body';
    default: return 'empty';
  }
}
