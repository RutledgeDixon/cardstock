import type { DocumentFile } from '@cardstock/document';
import {
  baseName, parse, serialise, withExtension, CARD_EXTENSION,
  type FileAccess, type FileLocation, type OpenedFile, isPath,
} from './files.js';

/**
 * File access inside the desktop shell (Tauri).
 *
 * The shell owns a parts directory — `<Documents>/CARDstock` — where Open and Save As
 * start, so a fresh install has one obvious place for its files without hiding them in
 * an application-data folder nobody browses. Files are referred to by path, and reading
 * and writing go through two Rust commands rather than the filesystem plugin: a `.card`
 * double-clicked anywhere on disk must open, and a plugin scope that permits that is a
 * scope that permits everything anyway.
 *
 * The bindings are injected so the whole thing runs under test without a shell. The
 * production wiring, at the bottom, is the only place the Tauri packages are imported.
 */
export interface ShellBindings {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  openDialog(options: { defaultPath?: string; filters: DialogFilter[] }): Promise<string | null>;
  saveDialog(options: { defaultPath?: string; filters: DialogFilter[] }): Promise<string | null>;
  ask(message: string, options: { title: string; kind: 'warning' }): Promise<boolean>;
  listen(event: string, handler: (payload: string) => void): Promise<() => void>;
}

export interface DialogFilter {
  name: string;
  extensions: string[];
}

const FILTERS: DialogFilter[] = [{ name: 'CARDstock part', extensions: [CARD_EXTENSION.slice(1)] }];

/** The last path segment, on either separator: Windows paths reach here unchanged. */
export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function createTauriFileAccess(shell: ShellBindings): FileAccess {
  const partsDir = () => shell.invoke<string>('parts_directory');

  const read = async (path: string): Promise<OpenedFile> => {
    const text = await shell.invoke<string>('read_card', { path });
    const name = fileName(path);
    return { name: baseName(name), contents: parse(name, text), handle: { path } };
  };

  const write = (path: string, contents: DocumentFile) =>
    shell.invoke<void>('write_card', { path, contents: serialise(contents) });

  const access: FileAccess = {
    canOverwrite: true,

    async open() {
      const path = await shell.openDialog({ defaultPath: await partsDir(), filters: FILTERS });
      return path ? read(path) : null;
    },

    async save(handle, contents) {
      if (!isPath(handle)) throw new Error('This file came from a browser session; use Save As');
      await write(handle.path, contents);
    },

    async saveAs(suggestedName, contents) {
      const dir = await partsDir();
      const chosen = await shell.saveDialog({
        defaultPath: `${dir}/${withExtension(suggestedName)}`, filters: FILTERS,
      });
      if (!chosen) return null;
      // Dialogs on some platforms hand back whatever was typed; the extension is ours to add.
      const path = withExtension(chosen);
      await write(path, contents);
      return { name: baseName(fileName(path)), contents, handle: { path } };
    },

    async reopen(handle: FileLocation) {
      return isPath(handle) ? read(handle.path) : null;
    },

    confirm(message) {
      return shell.ask(message, { title: 'CARDstock', kind: 'warning' });
    },

    async launchFile() {
      const path = await shell.invoke<string | null>('launch_file').catch(() => null);
      if (!path) return null;
      return read(path).catch(() => null);
    },

    onOpenRequest(listener) {
      // Forwarded by the single-instance guard when a second launch is attempted.
      let active = true;
      const unlisten = shell.listen('open-file', (path) => {
        if (!active || !path) return;
        void read(path).then(listener, () => { /* reported when the user opens it by hand */ });
      });
      return () => {
        active = false;
        void unlisten.then((off) => off());
      };
    },
  };
  return access;
}

/** The real shell. Only ever called inside Tauri, so these imports are safe to resolve. */
export async function tauriFileAccess(): Promise<FileAccess> {
  const [{ invoke }, { open, save, ask }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/api/event'),
  ]);
  return createTauriFileAccess({
    invoke: (command, args) => invoke(command, args),
    openDialog: (o) => open({ ...o, multiple: false, directory: false }) as Promise<string | null>,
    saveDialog: (o) => save(o),
    ask: (message, o) => ask(message, o),
    listen: async (event, handler) => listen<string>(event, (e) => handler(e.payload)),
  });
}
