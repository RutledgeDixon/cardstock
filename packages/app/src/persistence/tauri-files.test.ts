import { describe, expect, it } from 'vitest';
import { createTauriFileAccess, fileName, type ShellBindings } from './tauri-files.js';
import type { DocumentFile } from '@cardstock/document';

/**
 * The desktop backend against a fake shell. The Rust side is exercised by its own tests;
 * what this covers is the contract between them — which commands are called with what,
 * and what the frontend makes of the answers.
 */
const doc = (name: string): DocumentFile => ({
  schemaVersion: 2, meta: { name, units: 'mm' }, parameters: {}, features: [], sketches: {},
} as unknown as DocumentFile);

function fakeShell(overrides: Partial<ShellBindings> & { disk?: Map<string, string> } = {}) {
  const disk = overrides.disk ?? new Map<string, string>();
  const calls: Array<[string, unknown]> = [];
  const listeners = new Map<string, (p: string) => void>();
  let launch: string | null = null;
  const shell: ShellBindings & { disk: Map<string, string>; calls: typeof calls; fire: (e: string, p: string) => void; setLaunch: (p: string | null) => void } = {
    disk, calls,
    fire: (e, p) => listeners.get(e)?.(p),
    setLaunch: (p) => { launch = p; },
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push([command, args]);
      switch (command) {
        case 'parts_directory': return '/home/u/Documents/CARDstock' as T;
        case 'read_card': {
          const text = disk.get(args!.path as string);
          if (text === undefined) throw new Error(`Could not read ${String(args!.path)}`);
          return text as T;
        }
        case 'write_card': disk.set(args!.path as string, args!.contents as string); return undefined as T;
        case 'launch_file': { const p = launch; launch = null; return p as T; }
        default: throw new Error(`unknown command ${command}`);
      }
    },
    invokeBytes: async (command, bytes, headers) => {
      calls.push([command, headers]);
      disk.set(decodeURIComponent(headers.path!), `<${bytes.length} bytes>`);
    },
    invokeForBytes: async (command, args) => {
      calls.push([command, args]);
      const text = disk.get(args.path as string);
      if (text === undefined) throw new Error('missing');
      return new TextEncoder().encode(text);
    },
    openDialog: async () => null,
    saveDialog: async () => null,
    ask: async () => true,
    listen: async (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event); },
    ...overrides,
  };
  return shell;
}

describe('desktop file access', () => {
  it('opens through the dialog, starting in the parts directory', async () => {
    const shell = fakeShell({ openDialog: async (o) => `${o.defaultPath}/bracket.card` });
    shell.disk.set('/home/u/Documents/CARDstock/bracket.card', JSON.stringify(doc('bracket')));
    const opened = await createTauriFileAccess(shell).open();
    expect(opened?.name).toBe('bracket');
    expect(opened?.handle).toEqual({ path: '/home/u/Documents/CARDstock/bracket.card' });
    expect(opened?.contents.meta.name).toBe('bracket');
  });

  it('a cancelled dialog opens nothing', async () => {
    expect(await createTauriFileAccess(fakeShell()).open()).toBeNull();
  });

  it('save as adds the extension and writes by path; save overwrites the same path', async () => {
    const shell = fakeShell({ saveDialog: async () => '/parts/lid' });
    const files = createTauriFileAccess(shell);
    const saved = await files.saveAs('lid', doc('lid'));
    expect(saved?.handle).toEqual({ path: '/parts/lid.card' });
    expect(JSON.parse(shell.disk.get('/parts/lid.card')!).meta.name).toBe('lid');

    await files.save(saved!.handle!, doc('lid v2'));
    expect(JSON.parse(shell.disk.get('/parts/lid.card')!).meta.name).toBe('lid v2');
    expect(shell.disk.size).toBe(1);
  });

  it('refuses to save to a browser handle', async () => {
    const files = createTauriFileAccess(fakeShell());
    await expect(files.save({} as FileSystemFileHandle, doc('x'))).rejects.toThrow(/Save As/);
  });

  it('a recent entry reopens by path', async () => {
    const shell = fakeShell();
    shell.disk.set('/p/a.card', JSON.stringify(doc('a')));
    const opened = await createTauriFileAccess(shell).reopen({ path: '/p/a.card' });
    expect(opened?.name).toBe('a');
  });

  it('a file that is not JSON is refused by name', async () => {
    const shell = fakeShell();
    shell.disk.set('/p/junk.card', 'not json');
    await expect(createTauriFileAccess(shell).reopen({ path: '/p/junk.card' })).rejects.toThrow(
      'junk.card is not a CARDstock file',
    );
  });

  it('the launch file is read once and a bad one is ignored', async () => {
    const shell = fakeShell();
    shell.disk.set('/p/launched.card', JSON.stringify(doc('launched')));
    const files = createTauriFileAccess(shell);
    shell.setLaunch('/p/launched.card');
    expect((await files.launchFile!())?.name).toBe('launched');
    expect(await files.launchFile!()).toBeNull();
    shell.setLaunch('/p/missing.card');
    expect(await files.launchFile!()).toBeNull();
  });

  it('open requests while running arrive through the event, until unsubscribed', async () => {
    const shell = fakeShell();
    shell.disk.set('/p/event.card', JSON.stringify(doc('event')));
    const received: string[] = [];
    const off = createTauriFileAccess(shell).onOpenRequest!((f) => received.push(f.name));
    await Promise.resolve();
    shell.fire('open-file', '/p/event.card');
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toEqual(['event']);
    off();
    shell.fire('open-file', '/p/event.card');
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toEqual(['event']);
  });

  it('exports bytes to a chosen path, adding the extension', async () => {
    const shell = fakeShell({ saveDialog: async () => '/parts/lid' });
    const ok = await createTauriFileAccess(shell).exportBytes('lid.stl', new Uint8Array(10), 'model/stl');
    expect(ok).toBe(true);
    expect(shell.disk.get('/parts/lid.stl')).toBe('<10 bytes>');
  });

  it('imports by picking a path and reading its bytes', async () => {
    const shell = fakeShell({ openDialog: async () => '/parts/ref.step' });
    shell.disk.set('/parts/ref.step', 'ISO-10303-21;');
    const file = await createTauriFileAccess(shell).pickImport(['.step', '.stp']);
    expect(file?.name).toBe('ref.step');
    expect(new TextDecoder().decode(file!.bytes)).toBe('ISO-10303-21;');
  });

  it('confirm goes through the native dialog', async () => {
    const asked: string[] = [];
    const shell = fakeShell({ ask: async (m) => { asked.push(m); return false; } });
    expect(await createTauriFileAccess(shell).confirm!('Discard?')).toBe(false);
    expect(asked).toEqual(['Discard?']);
  });

  it('file names come off either separator', () => {
    expect(fileName('/a/b/c.card')).toBe('c.card');
    expect(fileName('C:\\a\\b\\c.card')).toBe('c.card');
    expect(fileName('c.card')).toBe('c.card');
  });
});
