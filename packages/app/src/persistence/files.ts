import type { DocumentFile } from '@cardstock/document';

/**
 * Getting a `.card` in and out of the app.
 *
 * Two implementations behind one shape. Where the File System Access API exists (Chrome,
 * Edge) the app gets real Open and Save dialogs and a handle that lets "Save" overwrite
 * the file that was opened. Elsewhere, Open is a file input and Save is a download —
 * the same document, without the handle.
 *
 * A third implementation, backed by the desktop app's filesystem, lives in `tauri-files.ts`
 * and refers to files by path; nothing above this file knows which one it is talking to.
 */

export const CARD_EXTENSION = '.card';
const MIME = 'application/json';

/**
 * Where a file lives, in whichever terms the backend can act on: a browser handle, or a
 * path on disk. A path is a plain string and so survives structured cloning into
 * IndexedDB; a handle only does in browsers that implement it, which is why the recent
 * list treats the location as optional.
 */
export type FileLocation = FileSystemFileHandle | { readonly path: string };

export const isPath = (location: FileLocation): location is { readonly path: string } =>
  typeof (location as { path?: unknown }).path === 'string';

/** A file brought in from outside: its bytes and its name. Never kept open. */
export interface ImportedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** An opened or saved file: its contents, its name, and — where possible — its location. */
export interface OpenedFile {
  readonly name: string;
  readonly contents: DocumentFile;
  readonly handle: FileLocation | null;
}

export interface FileAccess {
  /** True when Save can overwrite in place. Drives whether the UI says Save or Download. */
  readonly canOverwrite: boolean;
  open(): Promise<OpenedFile | null>;
  /** Write to an existing location. Rejects when there is none: caller falls back to saveAs. */
  save(handle: FileLocation, contents: DocumentFile): Promise<void>;
  saveAs(suggestedName: string, contents: DocumentFile): Promise<OpenedFile | null>;
  /** Re-open a file by a location kept from a previous session, asking permission if needed. */
  reopen(handle: FileLocation): Promise<OpenedFile | null>;
  /**
   * A yes/no question in whatever dialog the platform has. Optional: the browser
   * builds use `window.confirm`, which a desktop shell replaces with a native dialog.
   */
  confirm?(message: string): Promise<boolean>;
  /**
   * Hand the user a file that is not a `.card` — an STL, a STEP. Returns false when
   * they cancelled. `suggestedName` carries the extension.
   */
  exportBytes(suggestedName: string, bytes: Uint8Array, mime: string): Promise<boolean>;
  /** Pick a file to bring in, by extension (with the dot). Null when cancelled. */
  pickImport(extensions: readonly string[]): Promise<ImportedFile | null>;
  /**
   * The file the host was started with — a `.card` double-clicked while the app was
   * closed. Browsers have none. Resolves null when there was no such file or it could
   * not be read; a bad launch file is not worth refusing to start over.
   */
  launchFile?(): Promise<OpenedFile | null>;
  /**
   * Files the host is asked to open while running — a double-click when the app is
   * already up. The listener is called for each; the returned function unsubscribes.
   */
  onOpenRequest?(listener: (file: OpenedFile) => void): () => void;
}

export const serialise = (contents: DocumentFile) => JSON.stringify(contents, null, 2);

export const baseName = (name: string) =>
  name.toLowerCase().endsWith(CARD_EXTENSION) ? name.slice(0, -CARD_EXTENSION.length) : name;

export const withExtension = (name: string) =>
  name.toLowerCase().endsWith(CARD_EXTENSION) ? name : `${name}${CARD_EXTENSION}`;

export function parse(name: string, text: string): DocumentFile {
  try {
    return JSON.parse(text) as DocumentFile;
  } catch {
    throw new Error(`${name} is not a CARDstock file`);
  }
}

// ---------------------------------------------------------------- File System Access
type PickerWindow = Window & {
  showOpenFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle>;
};

const pickerTypes = [{ description: 'CARDstock part', accept: { [MIME]: [CARD_EXTENSION] } }];

/** The user cancelled a picker. Not an error; nothing to report. */
const cancelled = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

async function ensurePermission(handle: FileSystemFileHandle, mode: 'read' | 'readwrite') {
  const h = handle as FileSystemFileHandle & {
    queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
    requestPermission?: (o: { mode: string }) => Promise<PermissionState>;
  };
  if ((await h.queryPermission?.({ mode })) === 'granted') return true;
  return (await h.requestPermission?.({ mode })) === 'granted';
}

export const fileSystemAccess: FileAccess = {
  canOverwrite: true,

  async open() {
    const win = window as PickerWindow;
    try {
      const [handle] = await win.showOpenFilePicker!({ types: pickerTypes, multiple: false });
      if (!handle) return null;
      const file = await handle.getFile();
      return { name: baseName(file.name), contents: parse(file.name, await file.text()), handle };
    } catch (e) {
      if (cancelled(e)) return null;
      throw e;
    }
  },

  async save(handle, contents) {
    if (isPath(handle)) throw new Error('This file was saved by the desktop app; use Save As');
    if (!(await ensurePermission(handle, 'readwrite'))) {
      throw new Error('Permission to write the file was not granted');
    }
    const writable = await handle.createWritable();
    await writable.write(serialise(contents));
    await writable.close();
  },

  async saveAs(suggestedName, contents) {
    const win = window as PickerWindow;
    try {
      const handle = await win.showSaveFilePicker!({
        suggestedName: withExtension(suggestedName), types: pickerTypes,
      });
      await this.save(handle, contents);
      return { name: baseName(handle.name), contents, handle };
    } catch (e) {
      if (cancelled(e)) return null;
      throw e;
    }
  },

  async reopen(handle) {
    if (isPath(handle)) return null;
    if (!(await ensurePermission(handle, 'read'))) return null;
    const file = await handle.getFile();
    return { name: baseName(file.name), contents: parse(file.name, await file.text()), handle };
  },

  async exportBytes(suggestedName, bytes, mime) {
    const win = window as PickerWindow;
    const extension = suggestedName.slice(suggestedName.lastIndexOf('.'));
    try {
      const handle = await win.showSaveFilePicker!({
        suggestedName, types: [{ description: extension.slice(1).toUpperCase(), accept: { [mime]: [extension] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(bytes as unknown as BufferSource);
      await writable.close();
      return true;
    } catch (e) {
      if (cancelled(e)) return false;
      throw e;
    }
  },

  async pickImport(extensions) {
    const win = window as PickerWindow;
    try {
      const [handle] = await win.showOpenFilePicker!({
        types: [{ description: 'Model', accept: { 'application/octet-stream': [...extensions] } }],
        multiple: false,
      });
      if (!handle) return null;
      const file = await handle.getFile();
      return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    } catch (e) {
      if (cancelled(e)) return null;
      throw e;
    }
  },
};

/** Save through a download link. */
export function download(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke on the next tick: revoking synchronously can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Open through a file input. A dismissed dialog never resolves; nothing awaits it with a timeout. */
function pickThroughInput(accept: string): Promise<File | null> {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

// ---------------------------------------------------------------- fallback
/** Open through a file input; save through a download. No handles, so no overwrite. */
export const downloadFallback: FileAccess = {
  canOverwrite: false,

  async open() {
    const file = await pickThroughInput(CARD_EXTENSION);
    if (!file) return null;
    return { name: baseName(file.name), contents: parse(file.name, await file.text()), handle: null };
  },

  async save() {
    throw new Error('This browser cannot overwrite files; use Save As');
  },

  async saveAs(suggestedName, contents) {
    download(new TextEncoder().encode(serialise(contents)), withExtension(suggestedName), MIME);
    return { name: baseName(suggestedName), contents, handle: null };
  },

  async reopen() { return null; },

  async exportBytes(suggestedName, bytes, mime) {
    download(bytes, suggestedName, mime);
    return true;
  },

  async pickImport(extensions) {
    const file = await pickThroughInput(extensions.join(','));
    return file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
  },
};

/** True inside the Tauri desktop shell, which injects this before any script runs. */
export const inDesktopShell = () => '__TAURI_INTERNALS__' in globalThis;

export async function defaultFileAccess(): Promise<FileAccess> {
  if (inDesktopShell()) {
    // Loaded on demand so the browser build never pulls the Tauri bindings in.
    const { tauriFileAccess } = await import('./tauri-files.js');
    return tauriFileAccess();
  }
  const win = globalThis as unknown as PickerWindow;
  return typeof win.showOpenFilePicker === 'function' && typeof win.showSaveFilePicker === 'function'
    ? fileSystemAccess
    : downloadFallback;
}
