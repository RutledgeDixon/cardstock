/**
 * The printer the part is going to.
 *
 * Kept outside the document: a part is designed against a nozzle and a bed, but it is
 * the machine that has those, not the file. Two of its values reach expressions as the
 * environment names `nozzle` and `layer`, so `wall = nozzle * 3` follows the printer.
 */
export interface PrinterProfile {
  readonly name: string;
  /** Build volume, mm. */
  readonly bed: { readonly x: number; readonly y: number; readonly z: number };
  /** Nozzle diameter, mm. */
  readonly nozzle: number;
  /** Layer height, mm. */
  readonly layer: number;
  /** Steepest overhang that prints without support, degrees from vertical. */
  readonly maxOverhang: number;
  /** Filament diameter, mm. */
  readonly filamentDiameter: number;
  /** Filament density, g/cm³. PLA is about 1.24. */
  readonly density: number;
}

export const DEFAULT_PRINTER: PrinterProfile = {
  name: 'Generic 220×220',
  bed: { x: 220, y: 220, z: 250 },
  nozzle: 0.4,
  layer: 0.2,
  maxOverhang: 45,
  filamentDiameter: 1.75,
  density: 1.24,
};

/** What the expression environment sees. */
export const profileEnvironment = (p: PrinterProfile): Record<string, number> => ({
  nozzle: p.nozzle,
  layer: p.layer,
});

/** Take whatever was stored and make a profile of it, defaulting anything missing or bad. */
export function normaliseProfile(raw: unknown): PrinterProfile {
  const r = (raw ?? {}) as Partial<Record<keyof PrinterProfile, unknown>>;
  const num = (v: unknown, fallback: number, min = 0) =>
    typeof v === 'number' && Number.isFinite(v) && v > min ? v : fallback;
  const bed = (r.bed ?? {}) as Partial<Record<'x' | 'y' | 'z', unknown>>;
  return {
    name: typeof r.name === 'string' && r.name.trim() ? r.name : DEFAULT_PRINTER.name,
    bed: {
      x: num(bed.x, DEFAULT_PRINTER.bed.x),
      y: num(bed.y, DEFAULT_PRINTER.bed.y),
      z: num(bed.z, DEFAULT_PRINTER.bed.z),
    },
    nozzle: num(r.nozzle, DEFAULT_PRINTER.nozzle),
    layer: num(r.layer, DEFAULT_PRINTER.layer),
    maxOverhang: Math.min(89, num(r.maxOverhang, DEFAULT_PRINTER.maxOverhang)),
    filamentDiameter: num(r.filamentDiameter, DEFAULT_PRINTER.filamentDiameter),
    density: num(r.density, DEFAULT_PRINTER.density),
  };
}

/** Whether a part of these dimensions fits the bed in ANY axis-aligned orientation. */
export function fitsBed(
  size: { readonly x: number; readonly y: number; readonly z: number },
  profile: PrinterProfile,
): boolean {
  const part = [size.x, size.y, size.z].sort((a, b) => a - b);
  const bed = [profile.bed.x, profile.bed.y, profile.bed.z].sort((a, b) => a - b);
  return part.every((d, i) => d <= bed[i]!);
}

/**
 * Mass and filament for a solid part. "Solid" is said out loud: a real print has infill
 * and this number is the ceiling, not the estimate a slicer will give.
 */
export function printEstimates(volumeMm3: number, profile: PrinterProfile) {
  const cm3 = volumeMm3 / 1000;
  const grams = cm3 * profile.density;
  const filamentArea = Math.PI * (profile.filamentDiameter / 2) ** 2;
  const metres = volumeMm3 / filamentArea / 1000;
  return { cm3, grams, metres };
}
