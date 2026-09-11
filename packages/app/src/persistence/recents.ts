import type { Store } from './store.js';

/**
 * The recent-files list.
 *
 * Most recent first, capped, deduplicated by name. Carries the thumbnail so the list can
 * show a picture without opening anything, and the handle so a click reopens the file
 * in place where the browser allows it.
 */
export interface RecentEntry {
  readonly name: string;
  readonly opened: string;
  readonly thumbnail?: string;
  readonly handle?: FileSystemFileHandle;
}

const KEY = 'recents';
const LIMIT = 12;

export async function listRecents(store: Store): Promise<RecentEntry[]> {
  return (await store.get<RecentEntry[]>(KEY)) ?? [];
}

export async function rememberRecent(store: Store, entry: RecentEntry): Promise<void> {
  const current = await listRecents(store);
  const next = [entry, ...current.filter((r) => r.name !== entry.name)].slice(0, LIMIT);
  await store.set(KEY, next);
}

export async function forgetRecent(store: Store, name: string): Promise<void> {
  const current = await listRecents(store);
  await store.set(KEY, current.filter((r) => r.name !== name));
}
