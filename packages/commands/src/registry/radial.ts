import { RADIAL_SECTORS, type Command, type Enablement } from './command.js';
import type { ResolvedCommand } from './registry.js';

/**
 * Radial menu layout.
 *
 * Eight sectors, 0 = north, clockwise. A command's sector is DECLARED, not derived from
 * whatever happens to be in the list, so "fillet" is always in the same direction on an
 * edge whatever else is available. That fixed layout is the whole value of a pie menu:
 * once learned, you flick without reading.
 *
 * Overflow is flat, never nested. If more commands apply than there are sectors, the
 * last one becomes "More…", opening a searchable list. There are no submenus anywhere.
 */

export const MORE_COMMAND_ID = 'radial.more';

export interface RadialSlot {
  readonly sector: number;
  readonly command: Command | null;
  readonly enabled: Enablement;
  /** Present on the "More…" slot: everything that did not fit. */
  readonly overflow?: readonly ResolvedCommand[];
}

export function layoutRadial(resolved: readonly ResolvedCommand[]): RadialSlot[] {
  const slots = new Array<RadialSlot | null>(RADIAL_SECTORS).fill(null);
  const unplaced: ResolvedCommand[] = [];

  // Declared sectors win, always — that is the promise being kept.
  for (const entry of resolved) {
    if (entry.sector !== undefined && slots[entry.sector] === null) {
      slots[entry.sector] = { sector: entry.sector, command: entry.command, enabled: entry.enabled };
    } else {
      unplaced.push(entry);
    }
  }

  const freeSectors = () => slots.flatMap((slot, i) => (slot === null ? [i] : []));
  const needsOverflow = unplaced.length > freeSectors().length;

  // Reserve the last free sector for "More…" before filling, so overflow never displaces
  // a command that would otherwise have had a home.
  let overflowSector: number | null = null;
  if (needsOverflow) {
    const free = freeSectors();
    overflowSector = free.at(-1) ?? null;
  }

  for (const entry of unplaced) {
    const free = freeSectors().filter((i) => i !== overflowSector);
    const target = free[0];
    if (target === undefined) break;
    slots[target] = { sector: target, command: entry.command, enabled: entry.enabled };
  }

  if (overflowSector !== null) {
    const placed = new Set(
      slots.filter((s): s is RadialSlot => s !== null).map((s) => s.command?.id),
    );
    slots[overflowSector] = {
      sector: overflowSector,
      command: null,
      enabled: true,
      overflow: unplaced.filter((e) => !placed.has(e.command.id)),
    };
  }

  return slots.map((slot, sector) => slot ?? { sector, command: null, enabled: true });
}

/**
 * Which sector a flick points at.
 *
 * Screen coordinates: +x right, +y DOWN, so north is negative y. Supports press-flick-
 * release without waiting for the menu to draw.
 */
export function sectorFromVector(dx: number, dy: number): number | null {
  const distance = Math.hypot(dx, dy);
  if (distance < 12) return null; // too small to be a deliberate direction
  const angle = Math.atan2(dx, -dy); // 0 = north, clockwise
  const normalised = (angle + 2 * Math.PI) % (2 * Math.PI);
  return Math.round(normalised / ((2 * Math.PI) / RADIAL_SECTORS)) % RADIAL_SECTORS;
}

/** Centre of a sector, in radians clockwise from north. Used to place labels. */
export const sectorAngle = (sector: number): number =>
  (sector * 2 * Math.PI) / RADIAL_SECTORS;

/** Unit offset for a sector, in screen coordinates. */
export function sectorOffset(sector: number): { x: number; y: number } {
  const angle = sectorAngle(sector);
  return { x: Math.sin(angle), y: -Math.cos(angle) };
}
