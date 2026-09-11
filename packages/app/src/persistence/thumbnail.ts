/**
 * A small JPEG of what the viewer is showing, for the file and the recent-files list.
 *
 * Read straight off the WebGL canvas, which only works if the frame is still in the
 * drawing buffer — so the caller renders first. Scaled down through a 2D canvas rather
 * than asking WebGL for a smaller frame, because a 200px-wide JPEG is a few kilobytes
 * and a full-resolution PNG in every file is not.
 */
export const THUMBNAIL_WIDTH = 240;

export function captureThumbnail(source: HTMLCanvasElement): string | null {
  if (source.width === 0 || source.height === 0) return null;
  const scale = THUMBNAIL_WIDTH / source.width;
  const canvas = document.createElement('canvas');
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    // A tainted or lost context throws; a file without a thumbnail is still a file.
    return null;
  }
}
