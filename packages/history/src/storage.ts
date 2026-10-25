import { HISTORY_MAX_BYTES, UndoTree, type HistoryJSON } from './tree.js';

export interface HistoryBackend { load(key: string): Promise<unknown>; save(key: string, value: HistoryJSON): Promise<void> }
export function historyKey(workspaceId: string, path: string): string { return JSON.stringify([workspaceId, path]); }

/** Browser-only adapter; the tree itself has no browser dependencies. */
export class IndexedDBHistoryBackend implements HistoryBackend {
  private database: Promise<IDBDatabase> | undefined;
  private open(): Promise<IDBDatabase> {
    return this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('markroot-history', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('trees'); };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); this.database = undefined; }; resolve(db); };
      request.onerror = () => { this.database = undefined; reject(request.error); };
      request.onblocked = () => { this.database = undefined; reject(new Error('History storage is blocked.')); };
    });
  }
  async load(key: string): Promise<unknown> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('trees', 'readonly'); const request = transaction.objectStore('trees').get(key);
      transaction.oncomplete = () => resolve(request.result as unknown);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('History read failed.'));
    });
  }
  async save(key: string, value: HistoryJSON): Promise<void> {
    // Protect browser quota even when the protected current/starred paths exceed the soft tree cap.
    if (JSON.stringify(value).length * 2 > HISTORY_MAX_BYTES * 2) throw new Error('History is too large to persist.');
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('trees', 'readwrite'); transaction.objectStore('trees').put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('History write failed.'));
    });
  }
}

/** Serialize writes per backend/key so a slow write or rapid file reopen cannot overwrite newer history. */
const writes = new WeakMap<HistoryBackend, Map<string, Promise<void>>>();
export function saveHistory(backend: HistoryBackend, key: string, tree: UndoTree): Promise<void> {
  let keys = writes.get(backend); if (!keys) { keys = new Map(); writes.set(backend, keys); }
  const value = tree.toJSON();
  const write = (keys.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => backend.save(key, value));
  keys.set(key, write); return write;
}
export async function loadHistory(backend: HistoryBackend, key: string): Promise<unknown> { await writes.get(backend)?.get(key)?.catch(() => undefined); return backend.load(key); }
