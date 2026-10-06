import { CommandRegistry } from './registry/registry.js';
import { createBuiltinCommands } from './registry/builtins.js';
import { layoutRadial } from './registry/radial.js';
const host = new Proxy({}, { get: () => () => null }) as never;
const r = new CommandRegistry(); r.registerAll(createBuiltinCommands(host));
const state = new Proxy({}, { get: () => 0 }) as never;
for (const ctx of ['empty', 'face', 'edge', 'vertex', 'body', 'tree-item', 'sketch'] as const) {
  const slots = layoutRadial(r.forContext(ctx, state));
  console.log(ctx.padEnd(10), slots.map((s) => s.command ? `${s.sector}:${s.command.id}${r.isGroup(s.command.id) ? '[' + r.childrenOf(s.command.id, state).map((c) => c.command.id).join(',') + ']' : ''}` : s.overflow ? `${s.sector}:MORE(${s.overflow.map((o) => o.command.id).join(',')})` : '').filter(Boolean).join('  '));
}
