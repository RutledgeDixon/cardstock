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
  | 'sketch'      // a sketch is open for editing
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
  /**
   * Independent bodies — features whose output nothing else consumes.
   *
   * Distinct from featureCount, and the number booleans actually care about: a box with
   * a fillet on it is two features but one body, so offering "Cut" there would be a
   * button that fails the moment it is pressed.
   */
  readonly bodyCount: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly busy: boolean;
  readonly focusedFeature: FeatureId | null;
  /** A sketch is open for editing; most modelling commands stand aside while it is. */
  readonly sketching: boolean;
  /** Active drawing tool, when sketching. */
  readonly sketchTool: 'select' | 'line' | 'rectangle' | 'circle' | 'arc' | 'dimension' | 'constrain' | null;
  /**
   * Sketch entities selected, when sketching.
   *
   * Separate from `selectionCount`, which counts picked 3D topology. A sketch has its own
   * selection, and Delete needs to know which one it is about to act on.
   */
  readonly sketchSelectionCount: number;
  /** Which print analysis is shading the model, if any. */
  readonly analysis: 'none' | 'overhang' | 'thickness';
  /** The printer's build volume is drawn. */
  readonly buildVolume: boolean;
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
  /**
   * Presence puts it on the toolbar, ordered by this number.
   *
   * `pin: 'end'` sends it to the bottom of the strip, the way a desktop panel keeps its
   * tray there: Export is not part of the modelling flow and shouldn't be the thing that
   * scrolls off when the flow grows.
   */
  readonly toolbar?: {
    readonly order: number;
    readonly pin?: 'end';
    /**
     * Render small.
     *
     * For entries that are not modelling tools — About is a badge, not something you
     * reach for mid-part — so it does not claim the same weight as Sketch or Export,
     * and does not push them off a short window.
     */
    readonly compact?: boolean;
  };
  /** Chords like 'f', 'ctrl+k', 'shift+e'. */
  readonly keys?: readonly string[];
  /**
   * Command ids shown in a flyout under this one.
   *
   * Deliberately ONE level: a child may not itself have children, and the registry
   * enforces that. Submenus are otherwise how a toolbar rots into a tree, so this exists
   * only for the two cases where grouping genuinely reads better than a longer strip —
   * "New shape" and "Modify edge". A command listed as someone's child is hidden from
   * top-level listings, so it appears in exactly one place.
   */
  readonly children?: readonly string[];
  enabled(state: CommandState): Enablement;
  /** For toggles: whether the thing this switches is currently on. Drawn lit. */
  active?(state: CommandState): boolean;
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
