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
  focusedFeature: null,
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
    const contexts: CommandContext[] = ['empty', 'body', 'face', 'edge', 'vertex', 'tree-item'];
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

  it('offers the two groups, and only those', () => {
    const registry = build();
    const groups = registry.all().filter((c) => registry.isGroup(c.id)).map((c) => c.id);
    expect(groups.sort()).toEqual(['create.shape', 'modify.edge']);
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
