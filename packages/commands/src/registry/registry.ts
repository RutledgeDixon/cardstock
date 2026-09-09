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
  }

  get(id: string): Command | undefined { return this.#commands.get(id); }
  all(): Command[] { return [...this.#commands.values()]; }
  get size(): number { return this.#commands.size; }

  /** Commands for a context, in stable sector order. Includes disabled ones. */
  forContext(context: CommandContext, state: CommandState): ResolvedCommand[] {
    return [...this.#commands.values()]
      .filter((c) => c.contexts.includes(context) || c.contexts.includes('always'))
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
    return [...this.#commands.values()]
      .filter((c) => c.toolbar !== undefined)
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
