import {
  type Command, type CommandContext, type CommandState, type Enablement,
  RADIAL_SECTORS, normaliseChord,
} from './command.js';

/** A command paired with whether it is currently available. */
export interface ResolvedCommand {
  readonly command: Command;
  readonly enabled: Enablement;
  /** Radial position in this context, when it has one. */
  readonly sector?: number;
}

export class CommandRegistry {
  readonly #commands = new Map<string, Command>();
  readonly #byChord = new Map<string, string>();

  register(command: Command): void {
    if (this.#commands.has(command.id)) {
      throw new Error(`command "${command.id}" is already registered`);
    }
    // Sector clashes make the radial menu non-deterministic, which destroys the muscle
    // memory the fixed layout exists to build. Fail at registration, not at render.
    for (const [context, sector] of Object.entries(command.sector ?? {})) {
      if (sector < 0 || sector >= RADIAL_SECTORS) {
        throw new Error(
          `command "${command.id}" claims sector ${sector} in "${context}"; ` +
          `sectors are 0..${RADIAL_SECTORS - 1}`,
        );
      }
      const clash = [...this.#commands.values()].find(
        (c) => c.sector?.[context as CommandContext] === sector,
      );
      if (clash) {
        throw new Error(
          `commands "${command.id}" and "${clash.id}" both claim sector ${sector} ` +
          `in context "${context}"`,
        );
      }
    }

    for (const chord of command.keys ?? []) {
      const key = normaliseChord(chord);
      const existing = this.#byChord.get(key);
      if (existing) {
        throw new Error(`key "${key}" is already bound to "${existing}"`);
      }
      this.#byChord.set(key, command.id);
    }

    this.#commands.set(command.id, command);
  }

  registerAll(commands: Iterable<Command>): void {
    for (const command of commands) this.register(command);
    this.#validateGroups();
  }

  /**
   * Groups are one level deep, and every child must exist.
   *
   * Checked after registration rather than during it, because a group is usually
   * declared before its children. A missing child would otherwise silently disappear
   * from the UI: hidden from top level for being a child, absent from the flyout for
   * not existing.
   */
  #validateGroups(): void {
    for (const command of this.#commands.values()) {
      for (const childId of command.children ?? []) {
        const child = this.#commands.get(childId);
        if (!child) {
          throw new Error(`command "${command.id}" lists unknown child "${childId}"`);
        }
        if (child.children?.length) {
          throw new Error(
            `command "${childId}" cannot be both a group and a child of "${command.id}" — ` +
            'submenus are one level deep',
          );
        }
        if (child.sector) {
          // A child never appears at a context menu's top level, so a sector it claims
          // can never be used — and worse, it RESERVES that direction, so its own group
          // cannot take it. That is how "modify.body" ended up with nowhere to sit in
          // the face menu while its child held the slot.
          throw new Error(
            `command "${childId}" claims a radial sector but is a child of ` +
            `"${command.id}"; the group carries the sector`,
          );
        }
        if (child.toolbar) {
          throw new Error(
            `command "${childId}" claims a toolbar slot but is a child of ` +
            `"${command.id}"; a command belongs in one place`,
          );
        }
      }
    }
  }

  /** Ids that appear inside some group, and so must not appear at top level too. */
  #childIds(): Set<string> {
    const ids = new Set<string>();
    for (const command of this.#commands.values()) {
      for (const child of command.children ?? []) ids.add(child);
    }
    return ids;
  }

  /** A group's contents, resolved against the current state. */
  childrenOf(id: string, state: CommandState): ResolvedCommand[] {
    const parent = this.#commands.get(id);
    if (!parent?.children) return [];
    return parent.children
      .map((childId) => this.#commands.get(childId))
      .filter((c): c is Command => c !== undefined)
      .map((command) => ({ command, enabled: command.enabled(state) }));
  }

  /** True when this command opens a flyout rather than doing something itself. */
  isGroup(id: string): boolean {
    return (this.#commands.get(id)?.children?.length ?? 0) > 0;
  }

  get(id: string): Command | undefined { return this.#commands.get(id); }
  all(): Command[] { return [...this.#commands.values()]; }
  get size(): number { return this.#commands.size; }

  /**
   * Commands for a context, in stable sector order. Includes disabled ones.
   *
   * An `always` command is available to the palette and its keybinding everywhere, but
   * only reaches the radial menu if it declares a SECTOR for that context. Without that
   * rule every menu fills with Export, Undo and the palette itself, and a right-click
   * stops being a short list of the things you might do to what you clicked.
   */
  forContext(context: CommandContext, state: CommandState): ResolvedCommand[] {
    const children = this.#childIds();
    return [...this.#commands.values()]
      .filter((c) => !children.has(c.id))
      .filter((c) => c.contexts.includes(context)
        || (c.contexts.includes('always') && c.sector?.[context] !== undefined))
      .map((command) => ({
        command,
        enabled: command.enabled(state),
        ...(command.sector?.[context] !== undefined ? { sector: command.sector[context] } : {}),
      }))
      .sort((a, b) => {
        // Sectored commands first, in sector order; the rest alphabetically, so overflow
        // into the "More…" list is at least predictable.
        if (a.sector !== undefined && b.sector !== undefined) return a.sector - b.sector;
        if (a.sector !== undefined) return -1;
        if (b.sector !== undefined) return 1;
        return a.command.title.localeCompare(b.command.title);
      });
  }

  /** Toolbar contents, in declared order. Disabled entries stay visible with a reason. */
  toolbar(state: CommandState): ResolvedCommand[] {
    const children = this.#childIds();
    return [...this.#commands.values()]
      .filter((c) => c.toolbar !== undefined && !children.has(c.id))
      .map((command) => ({ command, enabled: command.enabled(state) }))
      .sort((a, b) => a.command.toolbar!.order - b.command.toolbar!.order);
  }

  /** Everything, for the palette. Ranked by a simple subsequence match. */
  search(query: string, state: CommandState): ResolvedCommand[] {
    const needle = query.trim().toLowerCase();
    const scored = [...this.#commands.values()]
      .map((command) => ({
        command,
        enabled: command.enabled(state),
        score: needle === '' ? 0 : fuzzyScore(needle, command),
      }))
      .filter((r) => needle === '' || r.score > 0);

    scored.sort((a, b) => (b.score - a.score) || a.command.title.localeCompare(b.command.title));
    return scored.map(({ command, enabled }) => ({ command, enabled }));
  }

  commandForChord(chord: string): Command | undefined {
    const id = this.#byChord.get(normaliseChord(chord));
    return id ? this.#commands.get(id) : undefined;
  }

  /** Every bound chord, for the shortcut list. */
  keymap(): Map<string, Command> {
    const out = new Map<string, Command>();
    for (const [chord, id] of this.#byChord) {
      const command = this.#commands.get(id);
      if (command) out.set(chord, command);
    }
    return out;
  }
}

/**
 * Subsequence match over title and id, favouring earlier and tighter matches.
 *
 * The title is weighted above the id because that is what the user is looking at:
 * searching "fil" should find Fillet, not file.export.
 */
function fuzzyScore(needle: string, command: Command): number {
  const haystacks: readonly [string, number][] = [
    [command.title.toLowerCase(), 1],
    [command.id.toLowerCase(), 0.6],
    [(command.hint ?? '').toLowerCase(), 0.3],
  ];

  let best = 0;
  for (const [haystack, weight] of haystacks) {
    if (haystack === '') continue;
    let score = 0;
    if (haystack.startsWith(needle)) {
      score = 100;
    } else if (haystack.includes(needle)) {
      score = 70;
    } else {
      let index = 0;
      let gaps = 0;
      for (const char of needle) {
        const found = haystack.indexOf(char, index);
        if (found < 0) { index = -1; break; }
        gaps += found - index;
        index = found + 1;
      }
      if (index >= 0) score = Math.max(1, 50 - gaps);
    }
    best = Math.max(best, score * weight);
  }
  return best;
}
