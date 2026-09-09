import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chordFromEvent, normaliseChord, type Command, type CommandState } from './command.js';
import { CommandRegistry } from './registry.js';

const state: CommandState = {
  selectionKind: null, selectionCount: 0, hoverKind: null,
  hasModel: true, featureCount: 2, bodyCount: 2, canUndo: false, canRedo: false,
  busy: false, focusedFeature: null,
};

const cmd = (over: Partial<Command> & { id: string }): Command => ({
  title: over.id, icon: '·', contexts: ['always'], enabled: () => true, run: () => {},
  ...over,
});

let registry: CommandRegistry;
beforeEach(() => { registry = new CommandRegistry(); });

describe('registration guards', () => {
  it('rejects a duplicate id', () => {
    registry.register(cmd({ id: 'a' }));
    expect(() => registry.register(cmd({ id: 'a' }))).toThrow(/already registered/);
  });

  it('rejects two commands claiming the same sector in one context', () => {
    // A clash makes the radial layout non-deterministic, which destroys exactly the
    // muscle memory the fixed layout exists to build. Fail at registration, not at render.
    registry.register(cmd({ id: 'a', contexts: ['edge'], sector: { edge: 2 } }));
    expect(() => registry.register(cmd({ id: 'b', contexts: ['edge'], sector: { edge: 2 } })))
      .toThrow(/both claim sector 2 in context "edge"/);
  });

  it('allows the same sector in different contexts', () => {
    registry.register(cmd({ id: 'a', contexts: ['edge'], sector: { edge: 2 } }));
    expect(() => registry.register(cmd({ id: 'b', contexts: ['face'], sector: { face: 2 } })))
      .not.toThrow();
  });

  it('rejects a sector outside the ring', () => {
    expect(() => registry.register(cmd({ id: 'a', contexts: ['edge'], sector: { edge: 9 } })))
      .toThrow(/sectors are 0\.\.7/);
  });

  it('rejects a duplicate key binding', () => {
    registry.register(cmd({ id: 'a', keys: ['ctrl+e'] }));
    expect(() => registry.register(cmd({ id: 'b', keys: ['Ctrl+E'] })))
      .toThrow(/already bound to "a"/);
  });
});

describe('context filtering', () => {
  beforeEach(() => {
    registry.registerAll([
      cmd({ id: 'fillet', contexts: ['edge'], sector: { edge: 0 } }),
      cmd({ id: 'chamfer', contexts: ['edge'], sector: { edge: 2 } }),
      cmd({ id: 'sketch', contexts: ['face'] }),
      cmd({ id: 'undo', contexts: ['always'] }),
    ]);
  });

  it('returns commands for the context plus the always-available ones', () => {
    const ids = registry.forContext('edge', state).map((r) => r.command.id);
    expect(ids).toContain('fillet');
    expect(ids).toContain('undo');
    expect(ids).not.toContain('sketch');
  });

  it('orders by sector, then alphabetically', () => {
    const ids = registry.forContext('edge', state).map((r) => r.command.id);
    expect(ids.slice(0, 2)).toEqual(['fillet', 'chamfer']);
  });
});

describe('enablement carries a reason', () => {
  it('reports why a command is unavailable', () => {
    // Disabled buttons stay visible and say why; a greyed button with no explanation is
    // just a dead end.
    registry.register(cmd({ id: 'x', enabled: () => 'Select an edge first' }));
    expect(registry.forContext('edge', state)[0]!.enabled).toBe('Select an edge first');
  });

  it('re-evaluates against the state it is given', () => {
    registry.register(cmd({ id: 'x', enabled: (s) => (s.canUndo ? true : 'Nothing to undo') }));
    expect(registry.forContext('always', state)[0]!.enabled).toBe('Nothing to undo');
    expect(registry.forContext('always', { ...state, canUndo: true })[0]!.enabled).toBe(true);
  });
});

describe('toolbar', () => {
  it('is ordered by declared order and includes only toolbar commands', () => {
    registry.registerAll([
      cmd({ id: 'export', toolbar: { order: 90 } }),
      cmd({ id: 'box', toolbar: { order: 20 } }),
      cmd({ id: 'hidden' }),
    ]);
    expect(registry.toolbar(state).map((r) => r.command.id)).toEqual(['box', 'export']);
  });

  it('keeps disabled commands visible', () => {
    registry.register(cmd({ id: 'x', toolbar: { order: 1 }, enabled: () => 'nope' }));
    expect(registry.toolbar(state)).toHaveLength(1);
  });
});

describe('palette search', () => {
  beforeEach(() => {
    registry.registerAll([
      cmd({ id: 'modify.fillet', title: 'Fillet' }),
      cmd({ id: 'modify.chamfer', title: 'Chamfer' }),
      cmd({ id: 'file.export', title: 'Export STL' }),
    ]);
  });

  it('lists everything for an empty query', () => {
    expect(registry.search('', state)).toHaveLength(3);
  });

  it('ranks a prefix match first', () => {
    expect(registry.search('fil', state)[0]!.command.id).toBe('modify.fillet');
  });

  it('matches a subsequence', () => {
    expect(registry.search('expstl', state).map((r) => r.command.id)).toContain('file.export');
  });

  it('excludes non-matches', () => {
    expect(registry.search('zzz', state)).toHaveLength(0);
  });
});

describe('key chords', () => {
  it('normalises modifier order and case', () => {
    expect(normaliseChord('Shift+Ctrl+K')).toBe(normaliseChord('ctrl+shift+k'));
  });

  it('reads a chord off an event', () => {
    expect(chordFromEvent({
      key: 'K', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false,
    })).toBe('ctrl+shift+k');
  });

  it('resolves a chord to its command', () => {
    const run = vi.fn();
    registry.register(cmd({ id: 'palette', keys: ['ctrl+k'], run }));
    registry.commandForChord('Ctrl+K')!.run();
    expect(run).toHaveBeenCalled();
  });

  it('exposes the full keymap', () => {
    registry.register(cmd({ id: 'a', keys: ['f', 'shift+f'] }));
    expect([...registry.keymap().keys()].sort()).toEqual(['f', 'shift+f']);
  });
});
