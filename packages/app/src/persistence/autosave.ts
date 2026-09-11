import type { Document, DocumentFile } from '@cardstock/document';
import type { Store } from './store.js';

/**
 * Autosave: the document, written to the app's own storage shortly after every edit.
 *
 * This is what stands between a refresh and an hour of lost work. It is not a save —
 * the file the user chose is untouched — it is a snapshot the app offers to restore.
 * Debounced, because drawing a sketch is a stream of edits and one write per click is a
 * lot of writes for no benefit.
 */
export const AUTOSAVE_KEY = 'autosave';
const DELAY_MS = 1200;

export interface AutosaveSnapshot {
  readonly file: DocumentFile;
  readonly savedAt: string;
  /** The document revision this snapshot captured, so a restore prompt can be skipped
   *  when nothing was lost. */
  readonly revision: number;
}

export function startAutosave(
  doc: Document,
  store: Store,
  onError: (message: string) => void,
  /**
   * How to produce the file. The app passes the same function Save uses, so a recovered
   * document comes back with the camera where it was and a current thumbnail — not the
   * ones from whenever the file was last explicitly saved.
   */
  snapshot: () => DocumentFile = () => doc.toJSON(),
): () => void {
  let timer: number | undefined;
  const write = async () => {
    const snapshot_: AutosaveSnapshot = {
      file: snapshot(), savedAt: new Date().toISOString(), revision: doc.revision,
    };
    try {
      await store.set(AUTOSAVE_KEY, snapshot_);
    } catch (e) {
      // Loudly. Autosave failing quietly is exactly how people lose work.
      onError(`Autosave failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const unsubscribe = doc.subscribe(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void write(); }, DELAY_MS);
  });
  return () => { window.clearTimeout(timer); unsubscribe(); };
}

export async function readAutosave(store: Store): Promise<AutosaveSnapshot | null> {
  return (await store.get<AutosaveSnapshot>(AUTOSAVE_KEY)) ?? null;
}

export async function clearAutosave(store: Store): Promise<void> {
  await store.delete(AUTOSAVE_KEY);
}
