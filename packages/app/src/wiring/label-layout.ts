import type { Viewer } from '@cardstock/viewer';
import type { SketchSession } from './sketch-session.js';

/**
 * Put each sketch dimension label where its dimension is on screen.
 *
 * Called every frame. Labels follow the camera by writing transforms directly —
 * re-rendering React on every frame to move a few divs would be pure waste.
 */
export function layoutDimensionLabels(viewer: Viewer, layer: HTMLElement, session: SketchSession): void {
  const rect = viewer.canvas.getBoundingClientRect();
  // Every label's wanted position first, then nudge any that would sit on another
  // — down, then aside — so two dimensions near each other both stay readable.
  const placed: { node: HTMLElement; x: number; y: number; w: number; h: number; hidden: boolean }[] = [];
  for (const dimension of session.dimensions()) {
    const node = layer.querySelector<HTMLElement>(`[data-dimension="${dimension.id}"]`);
    if (!node) continue;
    const ndc = dimension.world.clone().project(viewer.camera);
    placed.push({
      node,
      x: ((ndc.x + 1) / 2) * rect.width,
      y: ((1 - ndc.y) / 2) * rect.height,
      w: node.offsetWidth || 40, h: node.offsetHeight || 22,
      // Behind the camera, or off screen: hide rather than draw a label in the wrong place.
      hidden: ndc.z > 1 || Math.abs(ndc.x) > 1.2 || Math.abs(ndc.y) > 1.2,
    });
  }
  const gap = 4;
  const overlaps = (a: (typeof placed)[number], b: (typeof placed)[number]) =>
    Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap;
  for (let i = 1; i < placed.length; i++) {
    const label = placed[i]!;
    for (let attempt = 0; attempt < 6; attempt++) {
      const clash = placed.slice(0, i).find((other) => !other.hidden && overlaps(label, other));
      if (!clash) break;
      // Below the one it clashes with, or beside it on alternate tries.
      if (attempt % 2 === 0) label.y = clash.y + (clash.h + label.h) / 2 + gap;
      else label.x = clash.x + (clash.w + label.w) / 2 + gap;
    }
  }
  for (const label of placed) {
    label.node.style.transform = `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)`;
    label.node.style.visibility = label.hidden ? 'hidden' : 'visible';
  }
}
