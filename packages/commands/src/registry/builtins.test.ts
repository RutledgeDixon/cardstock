import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from './registry.js';
import { createBuiltinCommands } from './builtins.js';
import { RADIAL_SECTORS, type CommandContext, type CommandState } from './command.js';
import type { CommandHost } from './host.js';

/**
 * The real command set, registered for real.
 *
 * The registry's guards only fire when something is actually registered, so without this
 * a sector clash or a dangling group child reaches the browser as a blank screen. That
 * happened once; this is why it will not happen twice.
 */
const stubHost = (): CommandHost => new Proxy({} as CommandHost, {
  get: () => vi.fn(async () => null),
});

const state: CommandState = {
  selectionKind: null, selectionCount: 0, hoverKind: null, hasModel: true,
  featureCount: 2, bodyCount: 2, canUndo: true, canRedo: true, busy: false,
  focusedFeature: null, sketching: false, sketchTool: null,
  sketchSelectionCount: 0, analysis: 'none', buildVolume: false,
};

const build = () => {
  const registry = new CommandRegistry();
  registry.registerAll(createBuiltinCommands(stubHost()));
  return registry;
};

describe('the built-in command set', () => {
  it('registers without a sector clash, a duplicate key or a dangling child', () => {
    expect(() => build()).not.toThrow();
  });

  it('gives every command a title and an icon', () => {
    for (const command of build().all()) {
      expect(command.title, command.id).toBeTruthy();
      expect(command.icon, command.id).toBeTruthy();
    }
  });

  it('lays out every context without losing a command to a full ring', () => {
    const registry = build();
    const contexts: CommandContext[] =
      ['empty', 'body', 'face', 'edge', 'vertex', 'tree-item', 'sketch'];
    for (const context of contexts) {
      const resolved = registry.forContext(context, state);
      const sectors = resolved
        .map((r) => r.sector)
        .filter((s): s is number => s !== undefined);
      expect(new Set(sectors).size, `${context} has a duplicate sector`).toBe(sectors.length);
      expect(sectors.every((s) => s >= 0 && s < RADIAL_SECTORS)).toBe(true);
    }
  });

  it('keeps every context menu short enough to read', () => {
    // The whole point of a radial menu is a glanceable set of options. Anything past a
    // ring plus overflow means the context is doing too much.
    const registry = build();
    for (const context of ['empty', 'body', 'face', 'edge', 'vertex'] as CommandContext[]) {
      expect(registry.forContext(context, state).length, context).toBeLessThanOrEqual(8);
    }
  });

  it('keeps every submenu exactly one level deep', () => {
    // The rule that keeps the toolbar readable: a group may hold leaves, never another
    // group. Asserting the shape rather than a fixed list of groups means adding a
    // submenu doesn't need this test edited — only breaking the rule does.
    const registry = build();
    const groups = registry.all().filter((c) => registry.isGroup(c.id));
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      for (const childId of group.children ?? []) {
        const child = registry.get(childId);
        expect(child, `${group.id} lists a child "${childId}" that does not exist`).toBeDefined();
        expect(registry.isGroup(childId), `${group.id} > ${childId} is a nested submenu`)
          .toBe(false);
        expect(child?.toolbar, `${childId} is both a submenu child and a toolbar button`)
          .toBeUndefined();
      }
    }
  });

  it('reaches every command from the toolbar, a context menu or a key', () => {
    // A command nobody can invoke is dead weight; this catches one dropped from a
    // group's children list during a reshuffle.
    const registry = build();
    const inGroup = new Set(registry.all().flatMap((c) => c.children ?? []));
    const contexts: CommandContext[] =
      ['sketch', 'empty', 'body', 'face', 'edge', 'vertex', 'tree-item'];
    const inSomeMenu = new Set(
      contexts.flatMap((c) => registry.forContext(c, state).map((r) => r.command.id)),
    );
    for (const command of registry.all()) {
      const reachable = command.toolbar !== undefined
        || inGroup.has(command.id)
        || inSomeMenu.has(command.id)
        || (command.keys?.length ?? 0) > 0;
      expect(reachable, `${command.id} cannot be invoked from anywhere`).toBe(true);
    }
  });

  it('puts every primitive behind the New shape group rather than on the toolbar', () => {
    const registry = build();
    const toolbarIds = registry.toolbar(state).map((r) => r.command.id);
    expect(toolbarIds).toContain('create.shape');
    expect(toolbarIds).not.toContain('primitive.box');
    expect(registry.childrenOf('create.shape', state).map((r) => r.command.id))
      .toEqual(['primitive.box', 'primitive.cylinder', 'primitive.sphere']);
  });

  it('puts fillet and chamfer behind Modify edge', () => {
    const registry = build();
    expect(registry.toolbar(state).map((r) => r.command.id)).not.toContain('modify.fillet');
    expect(registry.childrenOf('modify.edge', state).map((r) => r.command.id))
      .toEqual(['modify.fillet', 'modify.chamfer']);
  });

  it('reaches every command through the palette, including ones inside groups', () => {
    const registry = build();
    const reachable = registry.search('', state).map((r) => r.command.id);
    for (const command of registry.all()) expect(reachable).toContain(command.id);
  });
});
