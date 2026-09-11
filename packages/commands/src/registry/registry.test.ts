import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chordFromEvent, normaliseChord, type Command, type CommandState } from './command.js';
import { CommandRegistry } from './registry.js';

const state: CommandState = {
  selectionKind: null, selectionCount: 0, hoverKind: null,
  hasModel: true, featureCount: 2, bodyCount: 2, canUndo: false, canRedo: false,
  busy: false, focusedFeature: null, sketching: false, sketchTool: null,
  sketchSelectionCount: 0, analysis: 'none', buildVolume: false,
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

  it('returns only the commands that belong to the context', () => {
    const ids = registry.forContext('edge', state).map((r) => r.command.id);
    expect(ids).toContain('fillet');
    expect(ids).not.toContain('sketch');
    // 'undo' is always available to the palette and its key, but declares no sector for
    // edges, so it stays out of the edge menu. See the flooding tests below.
    expect(ids).not.toContain('undo');
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
    registry.register(cmd({
      id: 'x', contexts: ['edge'], enabled: () => 'Select an edge first',
    }));
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

describe('groups are one level deep', () => {
  const group = (id: string, children: string[]) =>
    cmd({ id, children, contexts: ['empty'] });

  it('exposes a group\'s children', () => {
    registry.registerAll([
      group('create.shape', ['box', 'cyl']),
      cmd({ id: 'box', contexts: ['empty'] }),
      cmd({ id: 'cyl', contexts: ['empty'] }),
    ]);
    expect(registry.isGroup('create.shape')).toBe(true);
    expect(registry.childrenOf('create.shape', state).map((r) => r.command.id))
      .toEqual(['box', 'cyl']);
  });

  it('hides children from top-level listings, so each appears in exactly one place', () => {
    registry.registerAll([
      cmd({ id: 'create.shape', children: ['box'], contexts: ['empty'], toolbar: { order: 1 } }),
      cmd({ id: 'box', contexts: ['empty'] }),
    ]);
    // The group stands in for its child in both places; the child appears in neither.
    expect(registry.forContext('empty', state).map((r) => r.command.id)).toEqual(['create.shape']);
    expect(registry.toolbar(state).map((r) => r.command.id)).toEqual(['create.shape']);
  });

  it('rejects a child that also claims a toolbar slot or a radial sector', () => {
    // Both are unreachable on a child — it never appears at top level — and a claimed
    // sector is worse than useless: it RESERVES that direction, so the child's own group
    // cannot take it.
    expect(() => registry.registerAll([
      group('create.shape', ['box']),
      cmd({ id: 'box', contexts: ['empty'], toolbar: { order: 1 } }),
    ])).toThrow(/claims a toolbar slot but is a child/);

    const second = new CommandRegistry();
    expect(() => second.registerAll([
      group('modify', ['move']),
      cmd({ id: 'move', contexts: ['body'], sector: { body: 2 } }),
    ])).toThrow(/claims a radial sector but is a child/);
  });

  it('rejects a group nested inside a group', () => {
    // Submenus are one level. Without this the toolbar quietly grows into a tree.
    expect(() => registry.registerAll([
      group('outer', ['inner']),
      group('inner', ['leaf']),
      cmd({ id: 'leaf', contexts: ['empty'] }),
    ])).toThrow(/cannot be both a group and a child/);
  });

  it('rejects a group listing a child that does not exist', () => {
    // Otherwise the child vanishes twice over: hidden from top level for being a child,
    // absent from the flyout for not existing.
    expect(() => registry.registerAll([group('outer', ['ghost'])]))
      .toThrow(/unknown child "ghost"/);
  });

  it('reports non-groups as not groups', () => {
    registry.register(cmd({ id: 'plain' }));
    expect(registry.isGroup('plain')).toBe(false);
    expect(registry.childrenOf('plain', state)).toEqual([]);
  });
});

describe('always-commands do not flood every context menu', () => {
  it('keeps a sectorless always-command out of the radial', () => {
    // Otherwise a right-click on an edge offers Export STL and the palette, and stops
    // being a short list of things you might do to that edge.
    registry.registerAll([
      cmd({ id: 'file.export', contexts: ['always'] }),
      cmd({ id: 'modify.edge', contexts: ['edge'], sector: { edge: 0 } }),
    ]);
    expect(registry.forContext('edge', state).map((r) => r.command.id)).toEqual(['modify.edge']);
  });

  it('still admits an always-command that declares a sector for the context', () => {
    registry.register(cmd({ id: 'view.fit', contexts: ['always'], sector: { empty: 6 } }));
    expect(registry.forContext('empty', state).map((r) => r.command.id)).toEqual(['view.fit']);
    expect(registry.forContext('edge', state)).toEqual([]);
  });

  it('leaves the palette able to find it regardless', () => {
    registry.register(cmd({ id: 'file.export', title: 'Export STL', contexts: ['always'] }));
    expect(registry.search('export', state).map((r) => r.command.id)).toEqual(['file.export']);
  });
});
