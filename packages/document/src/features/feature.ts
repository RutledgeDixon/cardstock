import type { FeatureId } from '@cardstock/types';
import type { GeometryResult, KernelPort, ShapeHandle, SolverPort } from '@cardstock/types';
import type { Sketch } from '../sketch/sketch.js';
import type { TopoRef } from '../toporef/types.js';

/**
 * A feature: one step in the model's history.
 *
 * Numeric inputs are stored as expression STRINGS, not numbers, so a dimension can read
 * `wall * 3` and follow its parameters. Shape inputs reference other features by id,
 * which is what makes the history a DAG rather than a flat list.
 */
export interface Feature {
  readonly id: FeatureId;
  readonly type: string;
  readonly name: string;
  readonly suppressed?: boolean;
  /** Expression-valued numeric inputs, e.g. { dx: '40', radius: 'boltM3 / 2' }. */
  readonly values: Readonly<Record<string, string>>;
  /** Shape inputs, by role: { base: <id>, tool: <id> }. */
  readonly inputs: Readonly<Record<string, FeatureId>>;
  /**
   * Topological selections, e.g. which edges to fillet.
   *
   * Durable references, not indices. The engine resolves them against the feature's
   * input shape on every rebuild and hands `compute` plain indices, so feature
   * definitions never deal with naming. See docs/toponaming.md.
   */
  readonly selections?: Readonly<Record<string, readonly TopoRef[]>>;
  /**
   * The sketch this feature draws from, for sketch-based features.
   *
   * Sketches live in the document's own table rather than inline, because they are large
   * mutable objects with their own editing session, while a Feature is a small
   * declarative record the engine hashes on every rebuild.
   */
  readonly sketchId?: string;
}

export interface ComputeContext {
  readonly kernel: KernelPort;
  /** For sketch-based features. */
  readonly solver: SolverPort;
  /** The feature's sketch, already looked up, when it has one. */
  readonly sketch: Sketch | null;
  /** Document parameters, for solving sketch dimensions that name one. */
  readonly parameters: Readonly<Record<string, number>>;
  readonly feature: Feature;
  /** Value expressions, already evaluated against the parameter table. */
  readonly values: Readonly<Record<string, number>>;
  /** Resolved shape inputs. */
  readonly shapes: Readonly<Record<string, ShapeHandle>>;
  /** Already resolved to indices in the input shape — definitions never see a TopoRef. */
  readonly selections: Readonly<Record<string, readonly number[]>>;
}

export interface FeatureDefinition {
  readonly type: string;
  /** Human label for the UI and error messages. */
  readonly label: string;
  /** Roles this feature reads shapes from, in order. All are required. */
  readonly shapeInputs: readonly string[];
  /**
   * Roles resolved when present but which do not block when absent.
   *
   * A sketch on an origin plane needs no body; a sketch on a face needs the body it
   * sits on. Declaring that input as required would block every origin-plane sketch,
   * and declaring it nowhere would leave the face-based one unable to find its plane.
   */
  readonly optionalShapeInputs?: readonly string[];
  /**
   * Which shape input the output falls back to when compute fails.
   *
   * A failed fillet should leave the un-filleted solid on screen and let downstream
   * features carry on, rather than blanking the model. Root primitives have no fallback,
   * so their failure blocks everything downstream — correctly.
   */
  readonly primaryInput?: string;
  /** Numeric inputs this feature expects. */
  readonly valueKeys: readonly string[];
  compute(ctx: ComputeContext): Promise<GeometryResult>;
}

export class FeatureRegistry {
  readonly #defs = new Map<string, FeatureDefinition>();

  register(def: FeatureDefinition): void {
    if (this.#defs.has(def.type)) throw new Error(`feature type "${def.type}" already registered`);
    this.#defs.set(def.type, def);
  }

  get(type: string): FeatureDefinition | undefined { return this.#defs.get(type); }
  has(type: string): boolean { return this.#defs.has(type); }
  types(): string[] { return [...this.#defs.keys()]; }
}
