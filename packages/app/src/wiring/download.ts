/**
 * Hand the user a file.
 *
 * An object URL rather than a data URI: an STL of any real part is megabytes, and data
 * URIs are both slower and size-capped in some browsers.
 */
export function downloadStl(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoke on the next tick: revoking synchronously can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
