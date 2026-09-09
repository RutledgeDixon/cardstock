/**
 * Opaque string ids.
 *
 * Strings rather than numbers throughout: PlaneGCS dispatches on `typeof === 'string'`
 * for entity references (ADR-0003), and opaque ids resist accidental arithmetic.
 */
export type BodyId = string & { readonly __brand: 'BodyId' };
export type FeatureId = string & { readonly __brand: 'FeatureId' };
export type SketchId = string & { readonly __brand: 'SketchId' };
export type ParamId = string & { readonly __brand: 'ParamId' };

export const asBodyId = (s: string): BodyId => s as BodyId;
export const asFeatureId = (s: string): FeatureId => s as FeatureId;
export const asSketchId = (s: string): SketchId => s as SketchId;
export const asParamId = (s: string): ParamId => s as ParamId;
