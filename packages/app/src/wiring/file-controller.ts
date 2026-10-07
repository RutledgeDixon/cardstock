import type { Document } from '@cardstock/document';
import type { Viewer } from '@cardstock/viewer';
import type { Store } from '../persistence/store.js';
import { defaultFileAccess, downloadFallback, type FileAccess, type FileLocation, type OpenedFile } from '../persistence/files.js';
import { captureThumbnail } from '../persistence/thumbnail.js';
import { listRecents, rememberRecent, forgetRecent, type RecentEntry } from '../persistence/recents.js';
import { clearAutosave, readAutosave, startAutosave } from '../persistence/autosave.js';
import { loadStarter } from './boot.js';

/**
 * Where the document lives, and whether it has changed since.
 *
 * `handle` is the file it came from, when the browser can hand one over; without it
 * Save behaves as Save As. `savedRevision` against `doc.revision` is what "unsaved
 * changes" means — a counter rather than a flag because autosave compares too.
 */
export interface FileRef {
  handle: FileLocation | null;
  savedRevision: number;
}

export interface FileControllerDeps {
  doc: Document;
  viewer: Viewer;
  store: Store;
  /** Lives in the component, so it survives the controller being rebuilt. */
  fileRef: { current: FileRef };
  notify: (text: string, kind?: 'info' | 'error') => void;
  rebuild: () => Promise<void>;
  onFileState: (state: { name: string; dirty: boolean }) => void;
  onRecents: (recents: RecentEntry[]) => void;
  /** A different file is now open; whatever was focused belonged to the old one. */
  onOpened: () => void;
}

/**
 * The file side of the app: new, open, save, recents, and what the app boots into.
 *
 * Framework-free: React state reaches it only through the callbacks it is given.
 */
export function createFileController(deps: FileControllerDeps) {
  const { doc, viewer, store, fileRef, notify, rebuild } = deps;
  // Which backend depends on where we are running; it is resolved in boot(), below.
  // Until then nothing can save, and the fallback is the honest placeholder.
  let files: FileAccess = downloadFallback;

  /** The file as it should be written: the model, plus where the camera is and what
   *  it sees. Rendered first so the thumbnail is of the current frame, not a stale one. */
  const snapshotForSave = () => {
    viewer.renderer.render(viewer.scene, viewer.camera);
    const thumbnail = captureThumbnail(viewer.canvas);
    const c = viewer.controller.target;
    doc.setSavedView({
      camera: { azimuth: c.azimuth, elevation: c.elevation, zoom: c.zoom, pivot: { ...c.pivot } },
      ...(thumbnail ? { thumbnail } : {}),
    });
    return doc.toJSON();
  };

  const syncFileState = () => deps.onFileState({
    name: doc.meta.name || 'Untitled',
    dirty: doc.revision !== fileRef.current.savedRevision,
  });

  const markSaved = (name: string) => {
    fileRef.current.savedRevision = doc.revision;
    // A saved file supersedes the autosave; keeping both means the next boot offers
    // to "restore" work that is already safely in the file.
    void clearAutosave(store);
    deps.onFileState({ name, dirty: false });
  };

  /** Ask before throwing away unsaved work. True means go ahead. */
  const confirmDiscard = async () => {
    if (doc.revision === fileRef.current.savedRevision) return true;
    const message = `${doc.meta.name || 'This part'} has unsaved changes. Discard them?`;
    return files.confirm ? files.confirm(message) : window.confirm(message);
  };

  /** Put an opened file's contents in place: model, camera, recents, title. */
  const takeFile = async (opened: OpenedFile) => {
    try {
      doc.load(opened.contents);
    } catch (e) {
      notify(`Could not open ${opened.name}: ${e instanceof Error ? e.message : String(e)}`, 'error');
      return;
    }
    fileRef.current = { handle: opened.handle, savedRevision: doc.revision };
    deps.onOpened();
    syncFileState();
    await rebuild();
    const saved = doc.meta.camera;
    if (saved) {
      Object.assign(viewer.controller.target, {
        azimuth: saved.azimuth, elevation: saved.elevation, zoom: saved.zoom,
      });
      Object.assign(viewer.controller.target.pivot, saved.pivot);
      viewer.controller.settle();
    } else {
      viewer.fitAll();
    }
    await remember(opened.name, opened.handle);
    notify(`Opened ${opened.name}`);
  };

  /**
   * Note a file in the recent list. Never fatal: the list is a convenience, and an
   * open that succeeded must not be reported as failed because a bookkeeping write
   * could not clone a handle.
   */
  const remember = async (name: string, handle: FileLocation | null) => {
    try {
      await rememberRecent(store, {
        name, opened: new Date().toISOString(),
        ...(doc.meta.thumbnail ? { thumbnail: doc.meta.thumbnail } : {}),
        ...(handle ? { handle } : {}),
      });
      deps.onRecents(await listRecents(store));
    } catch {
      // Fall back to an entry without the handle; the name and picture still help.
      try {
        await rememberRecent(store, {
          name, opened: new Date().toISOString(),
          ...(doc.meta.thumbnail ? { thumbnail: doc.meta.thumbnail } : {}),
        });
        deps.onRecents(await listRecents(store));
      } catch { /* storage itself is unavailable; nothing to record */ }
    }
  };

  /** Reopen something from the recent list, by handle where we have one. */
  const openRecent = async (entry: RecentEntry) => {
    if (!(await confirmDiscard())) return;
    if (!entry.handle) {
      notify(`${entry.name} was downloaded, not saved in place — use Open to find it`, 'error');
      return;
    }
    try {
      const opened = await files.reopen(entry.handle);
      if (!opened) { notify('Permission to read the file was not granted', 'error'); return; }
      await takeFile(opened);
    } catch (e) {
      // The file has moved or gone; the entry is now a lie, so drop it.
      await forgetRecent(store, entry.name);
      deps.onRecents(await listRecents(store));
      notify(`Could not reopen ${entry.name}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const newDocument = async () => {
    if (!(await confirmDiscard())) return;
    loadStarter(doc);
    fileRef.current = { handle: null, savedRevision: doc.revision };
    syncFileState();
    await rebuild();
    viewer.fitAll();
  };

  const openDocument = async () => {
    if (!(await confirmDiscard())) return;
    let opened: OpenedFile | null;
    try {
      opened = await files.open();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
      return;
    }
    if (opened) await takeFile(opened);
  };

  const saveDocument = async () => {
    const { handle } = fileRef.current;
    if (!handle || !files.canOverwrite) { await saveDocumentAs(); return; }
    try {
      await files.save(handle, snapshotForSave());
      markSaved(doc.meta.name);
      notify(`Saved ${doc.meta.name}`);
    } catch (e) {
      notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const saveDocumentAs = async () => {
    try {
      const saved = await files.saveAs(doc.meta.name || 'part', snapshotForSave());
      if (!saved) return;
      doc.rename(saved.name);
      fileRef.current.handle = saved.handle;
      markSaved(saved.name);
      await remember(saved.name, saved.handle);
      notify(files.canOverwrite ? `Saved ${saved.name}` : `Downloaded ${saved.name}.card`);
    } catch (e) {
      notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  let stopAutosave: (() => void) | undefined;
  let stopDirtyWatch: (() => void) | undefined;
  let stopOpenRequests: (() => void) | null = null;

  /**
   * Resolve the file backend and load whatever the app should start with: a file the
   * shell was launched with, else unsaved work from last time, else the starter plate.
   * Then start autosave. Call once the kernel is ready.
   */
  const boot = async () => {
    files = await defaultFileAccess();

    // Unsaved work from last time comes back by itself; that is what an autosave is
    // for. `?fresh` skips it, for a clean slate and for the verification harness.
    const fresh = new URLSearchParams(window.location.search).has('fresh');
    const recovered = fresh ? null : await readAutosave(store).catch(() => null);
    // A file the desktop shell was launched with outranks both: the double-click IS
    // the instruction. Requests that arrive while running go through the discard prompt.
    const launched = await files.launchFile?.();
    stopOpenRequests = files.onOpenRequest?.((opened) => {
      void confirmDiscard().then((ok) => { if (ok) return takeFile(opened); });
    }) ?? null;
    if (launched) {
      await takeFile(launched);
    } else if (recovered && recovered.file.features.length > 0) {
      try {
        doc.load(recovered.file);
        notify(`Restored unsaved work from ${new Date(recovered.savedAt).toLocaleTimeString()}`);
      } catch {
        loadStarter(doc);
      }
    } else {
      loadStarter(doc);
    }
    if (!launched) {
      // Whatever we booted into is the baseline: it is not "unsaved" until it changes.
      fileRef.current = { handle: null, savedRevision: doc.revision };
      syncFileState();
      await rebuild();
      const saved = doc.meta.camera;
      if (recovered && saved) {
        Object.assign(viewer.controller.target, {
          azimuth: saved.azimuth, elevation: saved.elevation, zoom: saved.zoom,
        });
        Object.assign(viewer.controller.target.pivot, saved.pivot);
      } else {
        viewer.fitAll();
      }
      viewer.controller.settle();
    }
    deps.onRecents(await listRecents(store).catch(() => []));

    stopAutosave = startAutosave(doc, store, (message) => notify(message, 'error'), snapshotForSave);
    stopDirtyWatch = doc.subscribe(() => syncFileState());
  };

  /** Stop what boot() started — whatever of it has started by now. */
  const dispose = () => {
    stopAutosave?.();
    stopDirtyWatch?.();
    stopOpenRequests?.();
  };

  return {
    /** The platform's file backend; the download fallback until boot() resolves it. */
    files: () => files,
    boot, dispose,
    openRecent, newDocument, openDocument, saveDocument, saveDocumentAs,
  };
}
