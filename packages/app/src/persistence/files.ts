import type { DocumentFile } from '@cardstock/document';

/**
 * Getting a `.card` in and out of the app.
 *
 * Two implementations behind one shape. Where the File System Access API exists (Chrome,
 * Edge) the app gets real Open and Save dialogs and a handle that lets "Save" overwrite
 * the file that was opened. Elsewhere, Open is a file input and Save is a download —
 * the same document, without the handle.
 *
 * A third implementation, backed by a desktop app's filesystem, slots in here when the
 * app is packaged; nothing above this file changes.
 */

export const CARD_EXTENSION = '.card';
const MIME = 'application/json';

/** An opened or saved file: its contents, its name, and — where possible — a handle. */
export interface OpenedFile {
  readonly name: string;
  readonly contents: DocumentFile;
  readonly handle: FileSystemFileHandle | null;
}

export interface FileAccess {
  /** True when Save can overwrite in place. Drives whether the UI says Save or Download. */
  readonly canOverwrite: boolean;
  open(): Promise<OpenedFile | null>;
  /** Write to an existing handle. Rejects when there is none: caller falls back to saveAs. */
  save(handle: FileSystemFileHandle, contents: DocumentFile): Promise<void>;
  saveAs(suggestedName: string, contents: DocumentFile): Promise<OpenedFile | null>;
  /** Re-open a file by a handle kept from a previous session, asking permission if needed. */
  reopen(handle: FileSystemFileHandle): Promise<OpenedFile | null>;
}

const serialise = (contents: DocumentFile) => JSON.stringify(contents, null, 2);

const baseName = (name: string) =>
  name.toLowerCase().endsWith(CARD_EXTENSION) ? name.slice(0, -CARD_EXTENSION.length) : name;

const withExtension = (name: string) =>
  name.toLowerCase().endsWith(CARD_EXTENSION) ? name : `${name}${CARD_EXTENSION}`;

async function parse(name: string, text: string): Promise<DocumentFile> {
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
      return { name: baseName(file.name), contents: await parse(file.name, await file.text()), handle };
    } catch (e) {
      if (cancelled(e)) return null;
      throw e;
    }
  },

  async save(handle, contents) {
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
    if (!(await ensurePermission(handle, 'read'))) return null;
    const file = await handle.getFile();
    return { name: baseName(file.name), contents: await parse(file.name, await file.text()), handle };
  },
};

// ---------------------------------------------------------------- fallback
/** Open through a file input; save through a download. No handles, so no overwrite. */
export const downloadFallback: FileAccess = {
  canOverwrite: false,

  open() {
    return new Promise<OpenedFile | null>((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = CARD_EXTENSION;
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) { resolve(null); return; }
        try {
          resolve({ name: baseName(file.name), contents: await parse(file.name, await file.text()), handle: null });
        } catch (e) { reject(e as Error); }
      };
      // No cancel event exists for file inputs; a dismissed dialog simply never resolves,
      // which is harmless because nothing awaits it with a timeout.
      input.click();
    });
  },

  async save() {
    throw new Error('This browser cannot overwrite files; use Save As');
  },

  async saveAs(suggestedName, contents) {
    const blob = new Blob([serialise(contents)], { type: MIME });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = withExtension(suggestedName);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { name: baseName(suggestedName), contents, handle: null };
  },

  async reopen() { return null; },
};

export function defaultFileAccess(): FileAccess {
  const win = globalThis as unknown as PickerWindow;
  return typeof win.showOpenFilePicker === 'function' && typeof win.showSaveFilePicker === 'function'
    ? fileSystemAccess
    : downloadFallback;
}
