import { parse, referencedNames } from '../params/expression.js';
import type { ParameterTable } from '../params/parameters.js';
import type { Feature } from '../features/feature.js';
import { DependencyGraph, featureNode, paramNode } from './dependency-graph.js';

/**
 * Wire a graph from the current parameters and features.
 *
 * `sketches` is how a sketch feature declares its parameter dependencies. A sketch has no
 * feature `values` at all — its dimensions live inside its constraints — so without this
 * the graph cannot see that a sketch depends on `width`, and editing `width` rebuilds
 * everything except the sketch that was drawn from it.
 */
export function buildGraph(
  params: ParameterTable,
  features: readonly Feature[],
  sketches?: (id: string) => { referencedParameters(): string[] } | null,
): DependencyGraph {
  const graph = new DependencyGraph();

  // Parameters rank ahead of every feature; features rank by document position, so
  // independent branches rebuild in the order the user sees in the tree.
  const paramNames = [...params.names()].sort();
  paramNames.forEach((name, i) => graph.setPriority(paramNode(name), i));
  features.forEach((f, i) => graph.setPriority(featureNode(f.id), paramNames.length + i));

  for (const name of params.names()) {
    graph.addNode(paramNode(name));
    for (const dep of params.dependenciesOf(name)) graph.addEdge(paramNode(dep), paramNode(name));
  }

  const known = new Set(features.map((f) => f.id as string));
  for (const feature of features) {
    const node = featureNode(feature.id);
    graph.addNode(node);

    // Parameters read by this feature's value expressions.
    for (const expression of Object.values(feature.values)) {
      let names: string[];
      try {
        names = referencedNames(parse(expression));
      } catch {
        continue; // a malformed expression surfaces as a compute error, not a graph error
      }
      for (const name of names) {
        if (params.has(name)) graph.addEdge(paramNode(name), node);
      }
    }

    // Parameters a sketch's dimensions name.
    if (feature.sketchId && sketches) {
      for (const name of sketches(feature.sketchId)?.referencedParameters() ?? []) {
        if (params.has(name)) graph.addEdge(paramNode(name), node);
      }
    }

    // Shape inputs from other features.
    for (const upstream of Object.values(feature.inputs)) {
      if (known.has(upstream as string)) graph.addEdge(featureNode(upstream), node);
    }
  }

  return graph;
}
