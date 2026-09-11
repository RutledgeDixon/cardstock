import type { FeatureDefinition } from './feature.js';
import { base64ToBytes } from '../util/base64.js';

/**
 * Geometry brought in from another program, to model against.
 *
 * A `.card` stores no geometry of its own — the model is rebuilt from history — but an
 * import has no history to rebuild from, so the file's contents ride along inside the
 * feature: STEP as its text, STL as base64. That keeps a part self-contained at the cost
 * of a larger `.card`, which is the right trade for a file people will move between
 * machines. The recompute cache hashes the contents like any other value, so an import
 * is re-read only when it changes, which is never.
 */
export type ImportFormat = 'step' | 'stl';

export const IMPORT_EXTENSIONS: Readonly<Record<string, ImportFormat>> = {
  '.step': 'step', '.stp': 'step', '.stl': 'stl',
};

export const importFeature: FeatureDefinition = {
  type: 'import',
  label: 'Import',
  shapeInputs: [],
  valueKeys: [],
  compute: ({ kernel, feature }) => {
    const { format, data } = feature.values;
    if (!data) throw new Error('import has no file contents');
    if (format === 'step') return kernel.importStep(data);
    if (format === 'stl') return kernel.importStl(base64ToBytes(data));
    throw new Error(`unknown import format "${format}"`);
  },
};
