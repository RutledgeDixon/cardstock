import { describe, expect, it } from 'vitest';
import { DependencyGraph } from './dependency-graph.js';

const g = () => new DependencyGraph();

describe('topological order', () => {
  it('places dependencies before dependents', () => {
    const graph = g();
    graph.addEdge('a', 'b');
    graph.addEdge('b', 'c');
    const { order, cyclic } = graph.topologicalOrder();
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
    expect(cyclic).toEqual([]);
  });

  it('honours priority when breaking ties', () => {
    const graph = g();
    graph.addNode('x');
    graph.addNode('y');
    graph.setPriority('y', 0);
    graph.setPriority('x', 1);
    expect(graph.topologicalOrder().order).toEqual(['y', 'x']);
  });

  it('is deterministic across repeated builds', () => {
    const build = () => {
      const graph = g();
      for (const [from, to] of [['a', 'd'], ['b', 'd'], ['c', 'd'], ['d', 'e']]) {
        graph.addEdge(from!, to!);
      }
      return graph.topologicalOrder().order;
    };
    expect(build()).toEqual(build());
  });

  it('reports cyclic nodes instead of dropping them', () => {
    const graph = g();
    graph.addEdge('a', 'b');
    graph.addEdge('b', 'a');
    graph.addEdge('ok', 'fine');
    const { order, cyclic } = graph.topologicalOrder();
    expect(cyclic.sort()).toEqual(['a', 'b']);
    expect(order).toContain('ok'); // the healthy part still builds
  });

  it('handles a self-loop', () => {
    const graph = g();
    graph.addEdge('a', 'a');
    expect(graph.topologicalOrder().cyclic).toEqual(['a']);
  });

  it('handles an empty graph', () => {
    expect(g().topologicalOrder()).toEqual({ order: [], cyclic: [] });
  });
});

describe('dirty propagation', () => {
  //   a ──> b ──> d
  //   c ─────────┘
  const diamond = () => {
    const graph = g();
    graph.addEdge('a', 'b');
    graph.addEdge('b', 'd');
    graph.addEdge('c', 'd');
    return graph;
  };

  it('includes the changed node and everything downstream', () => {
    expect([...diamond().dirtyFrom(['a'])].sort()).toEqual(['a', 'b', 'd']);
  });

  it('excludes independent branches', () => {
    expect([...diamond().dirtyFrom(['a'])]).not.toContain('c');
  });

  it('does not walk upstream', () => {
    expect([...diamond().dirtyFrom(['d'])]).toEqual(['d']);
  });

  it('merges multiple changed nodes', () => {
    expect([...diamond().dirtyFrom(['a', 'c'])].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('terminates on a cycle', () => {
    const graph = g();
    graph.addEdge('a', 'b');
    graph.addEdge('b', 'a');
    expect([...graph.dirtyFrom(['a'])].sort()).toEqual(['a', 'b']);
  });
});

describe('ancestors', () => {
  it('walks transitively upstream', () => {
    const graph = g();
    graph.addEdge('a', 'b');
    graph.addEdge('b', 'c');
    expect([...graph.ancestorsOf('c')].sort()).toEqual(['a', 'b']);
  });
});
