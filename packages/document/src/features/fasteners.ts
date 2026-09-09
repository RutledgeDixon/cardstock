/**
 * Fastener sizes.
 *
 * The point of this table is that nobody should be looking up "what drill for an M4
 * clearance hole" in a browser tab while modelling. Sizes are the common ISO/ASME values
 * for socket head cap screws and standard clearance holes; they are a sensible default,
 * not a substitute for a spec when one matters, and every hole can still be given an
 * explicit diameter instead.
 */

export type HoleFit = 'close' | 'normal' | 'loose' | 'tap';

export interface Fastener {
  readonly name: string;
  /** Nominal thread diameter, mm. */
  readonly nominal: number;
  /** Drill size for cutting a thread, mm. */
  readonly tap: number;
  /** Clearance holes, mm — ISO 273 fine / medium / coarse. */
  readonly close: number;
  readonly normal: number;
  readonly loose: number;
  /** Socket head cap screw head, for a counterbore. */
  readonly headDiameter: number;
  readonly headHeight: number;
  /** Flat head diameter, for a countersink. Angle is 90 degrees included. */
  readonly countersinkDiameter: number;
}

export const FASTENERS: readonly Fastener[] = [
  { name: 'M2',   nominal: 2,    tap: 1.6, close: 2.2, normal: 2.4, loose: 2.6, headDiameter: 3.8,  headHeight: 2,   countersinkDiameter: 4 },
  { name: 'M2.5', nominal: 2.5,  tap: 2.05, close: 2.7, normal: 2.9, loose: 3.1, headDiameter: 4.5, headHeight: 2.5, countersinkDiameter: 5 },
  { name: 'M3',   nominal: 3,    tap: 2.5, close: 3.2, normal: 3.4, loose: 3.6, headDiameter: 5.5,  headHeight: 3,   countersinkDiameter: 6 },
  { name: 'M4',   nominal: 4,    tap: 3.3, close: 4.3, normal: 4.5, loose: 4.8, headDiameter: 7,    headHeight: 4,   countersinkDiameter: 8 },
  { name: 'M5',   nominal: 5,    tap: 4.2, close: 5.3, normal: 5.5, loose: 5.8, headDiameter: 8.5,  headHeight: 5,   countersinkDiameter: 10 },
  { name: 'M6',   nominal: 6,    tap: 5,   close: 6.4, normal: 6.6, loose: 7,   headDiameter: 10,   headHeight: 6,   countersinkDiameter: 12 },
  { name: 'M8',   nominal: 8,    tap: 6.8, close: 8.4, normal: 9,   loose: 10,  headDiameter: 13,   headHeight: 8,   countersinkDiameter: 16 },
  { name: 'M10',  nominal: 10,   tap: 8.5, close: 10.5, normal: 11, loose: 12,  headDiameter: 16,   headHeight: 10,  countersinkDiameter: 20 },
  // Imperial, in millimetres, because the model is millimetres and converting at the
  // point of use is how mistakes happen.
  { name: '#4-40',  nominal: 2.845, tap: 2.26, close: 3.05, normal: 3.26, loose: 3.57, headDiameter: 5.5, headHeight: 2.84, countersinkDiameter: 5.9 },
  { name: '#6-32',  nominal: 3.505, tap: 2.7,  close: 3.68, normal: 3.97, loose: 4.37, headDiameter: 6.4, headHeight: 3.51, countersinkDiameter: 7.2 },
  { name: '#8-32',  nominal: 4.166, tap: 3.4,  close: 4.34, normal: 4.6,  loose: 5.0,  headDiameter: 7.4, headHeight: 4.17, countersinkDiameter: 8.4 },
  { name: '#10-24', nominal: 4.826, tap: 3.9,  close: 5.0,  normal: 5.31, loose: 5.61, headDiameter: 8.6, headHeight: 4.83, countersinkDiameter: 9.7 },
  { name: '1/4-20', nominal: 6.35,  tap: 5.11, close: 6.63, normal: 6.94, loose: 7.54, headDiameter: 11,  headHeight: 6.35, countersinkDiameter: 12.7 },
];

export const fastenerNames = (): string[] => FASTENERS.map((f) => f.name);

export const findFastener = (name: string): Fastener | undefined =>
  FASTENERS.find((f) => f.name.toLowerCase() === name.trim().toLowerCase());

/** Hole diameter for a fastener and fit. */
export function holeDiameter(fastener: Fastener, fit: HoleFit): number {
  switch (fit) {
    case 'tap': return fastener.tap;
    case 'close': return fastener.close;
    case 'loose': return fastener.loose;
    case 'normal': return fastener.normal;
  }
}

/**
 * FDM printers pull holes undersize: the extrusion shrinks as it cools and the polygonal
 * approximation of a circle sits inside the true one. Small holes suffer most, so the
 * compensation is a diameter offset that matters at M3 and is negligible by M10.
 *
 * A default, not a law — every printer differs, and the value is a document parameter.
 */
export function compensatedDiameter(diameter: number, compensation: number): number {
  return diameter + compensation;
}

/** Holes below this print noticeably undersize and are worth flagging. */
export const SMALL_HOLE_THRESHOLD = 6;
