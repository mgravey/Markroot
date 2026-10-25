import { afterEach, expect, it, vi } from 'vitest';

/** A small IDB scheduler: transactions serialize, and commit once their request queue empties. */
function indexedDbFixture() {
  const values = new Map<string, unknown>();
  const operations: { transaction: number; mode: IDBTransactionMode; kind: string }[] = [];
  const queue: (() => void)[] = [];
  let busy = false;
  let nextId = 0;
  const advance = () => { busy = false; queue.shift()?.(); };
  const db = {
    close() {},
    transaction(_store: string, mode: IDBTransactionMode) {
      const id = ++nextId;
      let active = false;
      let finished = false;
      let pending = 0;
      const waiting: (() => void)[] = [];
      const transaction = {
        oncomplete: undefined as (() => void) | undefined,
        onerror: undefined as (() => void) | undefined,
        onabort: undefined as (() => void) | undefined,
        error: null,
        abort() { finished = true; setTimeout(() => { transaction.onabort?.(); advance(); }, 0); },
        objectStore() {
          const request = (kind: string, key: string, value?: unknown) => {
            if (finished) throw new Error('TransactionInactiveError');
            if (kind !== 'get' && mode !== 'readwrite') throw new Error('ReadOnlyError');
            pending++;
            operations.push({ transaction: id, mode, kind });
            const result = { result: undefined as unknown, onsuccess: undefined as (() => void) | undefined };
            const run = () => setTimeout(() => {
              if (finished) return;
              if (kind === 'put') values.set(key, value);
              if (kind === 'delete') values.delete(key);
              result.result = kind === 'get' ? values.get(key) : undefined;
              result.onsuccess?.();
              pending--;
              // IDB allows promise microtasks in a request handler, but not unrelated async work.
              queueMicrotask(() => {
                if (pending || finished) return;
                finished = true;
                transaction.oncomplete?.();
                advance();
              });
            }, 0);
            if (active) run(); else waiting.push(run);
            return result;
          };
          return { get: (key: string) => request('get', key), put: (value: unknown, key: string) => request('put', key, value), delete: (key: string) => request('delete', key) };
        },
      };
      const start = () => { busy = true; active = true; waiting.splice(0).forEach((run) => run()); };
      if (busy) queue.push(start); else start();
      return transaction;
    },
  };
  return {
    values, operations,
    open() {
      const request = { result: db, onsuccess: undefined as (() => void) | undefined };
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    },
  };
}

const folder = (entry: string) => ({
  name: 'paper', entry,
  async isSameEntry(other: { entry: string }) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return other.entry === entry;
  },
}) as unknown as FileSystemDirectoryHandle;

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('atomically assigns workspace ids across tabs without Web Locks, including async handle comparisons', async () => {
  const db = indexedDbFixture();
  vi.stubGlobal('indexedDB', db);
  vi.stubGlobal('navigator', {});
  const tabA = await import('./index.js');
  vi.resetModules();
  const tabB = await import('./index.js');
  const [a, same, b] = await Promise.all([
    tabA.workspaceIdFor(folder('a')), tabB.workspaceIdFor(folder('a')), tabB.workspaceIdFor(folder('b')),
  ]);
  expect(same).toBe(a);
  expect(b).not.toBe(a);
  expect(db.values.get('workspace-ids')).toHaveLength(2);
  expect(db.operations.every((operation) => operation.mode === 'readwrite')).toBe(true);
  for (const put of db.operations.filter((operation) => operation.kind === 'put')) {
    expect(db.operations).toContainEqual({ ...put, kind: 'get' });
  }
});

it('wraps the complete registry read and write in a shared Web Lock', async () => {
  const request = vi.fn(async (_name: string, _options: unknown, run: () => Promise<unknown>) => run());
  vi.stubGlobal('navigator', { locks: { request } });
  const settings = await import('./index.js');
  const values = new Map<string, unknown>();
  settings.setSettingsBackend({
    async get<T>(key: string) { expect(request).toHaveBeenCalledOnce(); return values.get(key) as T | undefined; },
    async set<T>(key: string, value: T) { expect(request).toHaveBeenCalledOnce(); values.set(key, value); },
    async delete(key: string) { values.delete(key); },
  });
  await settings.workspaceIdFor(folder('a'));
  expect(request).toHaveBeenCalledWith('markroot:workspace-ids', { mode: 'exclusive' }, expect.any(Function));
});
