import type { EntityKind, FeatureId } from '@cardstock/types';

/**
 * Every user-invocable action is one Command.
 *
 * The toolbar, the radial menu, the keybindings and the palette are all *views over this
 * one registry*. That is how "one level deep, no submenus" stays true by construction
 * rather than by discipline: there is nowhere for a submenu to live. A command either
 * applies in a context or it does not, and feature variants (extrude blind vs through-all)
 * belong in the feature's own parameter panel, not in a nested menu.
 */

/** What the user is pointing at, or the absence of a target. */
export type CommandContext =
  | 'always'      // available regardless of selection
  | 'empty'       // right-clicked background
  | 'body'
  | 'face'
  | 'edge'
  | 'vertex'
  | 'tree-item';  // right-clicked a row in the feature tree

export const RADIAL_SECTORS = 8;

/** Read-only view of the app that commands test against. */
export interface CommandState {
  readonly selectionKind: EntityKind | null;
  readonly selectionCount: number;
  readonly hoverKind: EntityKind | null;
  readonly hasModel: boolean;
  readonly featureCount: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly busy: boolean;
  readonly focusedFeature: FeatureId | null;
}

/** `true` to enable, or a sentence saying WHY not — shown in the tooltip. */
export type Enablement = true | string;

export interface Command {
  readonly id: string;
  readonly title: string;
  /** One line for the tooltip and the palette. */
  readonly hint?: string;
  /** A short glyph. Real icons come later; the registry does not care. */
  readonly icon: string;
  readonly contexts: readonly CommandContext[];
  /**
   * Fixed radial direction per context, 0 = north, clockwise.
   *
   * Declared on the command rather than derived from the filtered list, so a command
   * sits in the same direction every time and the gesture becomes muscle memory. Two
   * commands may not claim the same sector in the same context.
   */
  readonly sector?: Readonly<Partial<Record<CommandContext, number>>>;
  /** Presence puts it on the toolbar, ordered by this number. */
  readonly toolbar?: { readonly order: number };
  /** Chords like 'f', 'ctrl+k', 'shift+e'. */
  readonly keys?: readonly string[];
  enabled(state: CommandState): Enablement;
  run(): void | Promise<void>;
}

/** Normalise a chord so 'Ctrl+Shift+K' and 'shift+ctrl+k' are the same key. */
export function normaliseChord(chord: string): string {
  const parts = chord.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  const modifiers = ['ctrl', 'alt', 'shift', 'meta'];
  const held = modifiers.filter((m) => parts.includes(m));
  const key = parts.find((p) => !modifiers.includes(p)) ?? '';
  return [...held, key].filter(Boolean).join('+');
}

/** The chord a keyboard event represents. */
export function chordFromEvent(event: {
  key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean;
}): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey) parts.push('meta');
  parts.push(event.key.toLowerCase());
  return normaliseChord(parts.join('+'));
}
