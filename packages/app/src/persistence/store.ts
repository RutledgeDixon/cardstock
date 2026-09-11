/**
 * The app's own storage: IndexedDB, wrapped as a small key-value store.
 *
 * Holds what has to survive a reload but is not a file the user chose: the autosave
 * snapshot, the recent-files list, and the file handles that make "Save" overwrite the
 * file you opened rather than download a new one. Handles are structured-cloneable, so
 * they go in as-is; permission has to be re-asked on the next visit, which is the
 * browser's rule, not ours.
 *
 * Every method swallows nothing: a storage failure surfaces to the caller, which decides
 * whether it matters. Autosave failing quietly is how people lose work.
 */

const DB_NAME = 'cardstock';
const DB_VERSION = 1;
const STORE = 'kv';

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open storage'));
  });
}

function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('storage request failed'));
    tx.oncomplete = () => db.close();
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('storage transaction aborted')); };
  }));
}

export const indexedDbStore: Store = {
  get: <T>(key: string) => transact<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
  set: (key, value) => transact('readwrite', (s) => s.put(value, key)).then(() => undefined),
  delete: (key) => transact('readwrite', (s) => s.delete(key)).then(() => undefined),
};

/**
 * In-memory stand-in for environments without IndexedDB (tests, or a browser that has
 * disabled site data). Nothing persists, and nothing pretends it does.
 */
export function memoryStore(): Store {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    set: async (key, value) => { map.set(key, value); },
    delete: async (key) => { map.delete(key); },
  };
}

export function defaultStore(): Store {
  return typeof indexedDB === 'undefined' ? memoryStore() : indexedDbStore;
}
