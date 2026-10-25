import 'fake-indexeddb/auto';
import { forceCloseDatabase, IDBFactory } from 'fake-indexeddb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, listRecentProjects, loadPendingSession, loadSettings, rememberProject, savePendingSession, saveSettings, setSettingsBackend, workspaceIdFor } from './index.js';

// Real directory handles are structured-cloneable and compare asynchronously; keep fakes by reference.
const HANDLE = Symbol('fake-handle');
const nativeClone = globalThis.structuredClone;
const cloneKeepingHandles = (value: unknown): unknown => {
  if (value && typeof value === 'object' && HANDLE in value) return value;
  if (Array.isArray(value)) return value.map(cloneKeepingHandles);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneKeepingHandles(item)]));
  return nativeClone(value);
};
beforeAll(() => { globalThis.structuredClone = cloneKeepingHandles; });
afterAll(() => { globalThis.structuredClone = nativeClone; });
beforeEach(() => { setSettingsBackend(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('navigator', {}); });
afterEach(() => { setSettingsBackend(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function folder(name: string): FileSystemDirectoryHandle {
  const handle = {
    [HANDLE]: true, kind: 'directory', name,
    // Browsers resolve isSameEntry outside IndexedDB, which lets an open transaction auto-commit.
    isSameEntry: (other: unknown) => new Promise<boolean>((resolve) => setTimeout(() => resolve(other === handle), 0)),
  };
  return handle as unknown as FileSystemDirectoryHandle;
}

describe('recent projects in IndexedDB', () => {
  it('keeps every opened folder when comparing handles takes a real async turn', async () => {
    const first = folder('paper');
    const second = folder('thesis');
    const firstProject = await rememberProject(first);
    const secondProject = await rememberProject(second);
    expect(secondProject.id).not.toBe(firstProject.id);
    expect((await listRecentProjects()).map((project) => project.name)).toEqual(['thesis', 'paper']);
    await rememberProject(first);
    expect((await listRecentProjects()).map((project) => project.name)).toEqual(['paper', 'thesis']);
    expect(await workspaceIdFor(second)).toBe(secondProject.id);
    expect(await workspaceIdFor(folder('notes'))).not.toBe(firstProject.id);
  });

  it('ignores repeated recovery and settings saves during a registry comparison', async () => {
    const first = folder('paper');
    const project = await rememberProject(first);
    const compare = vi.spyOn(first, 'isSameEntry').mockImplementation(async () => {
      for (let index = 0; index < 12; index++) {
        await Promise.all([
          savePendingSession({ workspaceName: 'paper', workspaceId: project.id, path: 'a.md', source: `draft ${index}`, updatedAt: 'now' }),
          saveSettings(defaultSettings()),
        ]);
      }
      return false;
    });
    await expect(rememberProject(folder('notes'))).resolves.toMatchObject({ name: 'notes' });
    expect(compare).toHaveBeenCalledOnce();
    expect((await listRecentProjects()).map((item) => item.name)).toEqual(['notes', 'paper']);
    expect(await loadPendingSession({ id: project.id }, 'a.md')).toMatchObject({ source: 'draft 11' });
  });

  it('retries an identity update when another tab changes recent projects', async () => {
    const first = folder('paper');
    const project = await rememberProject(first);
    vi.resetModules();
    const tabB = await import('./index.js');
    const compare = vi.spyOn(first, 'isSameEntry').mockImplementationOnce(async () => {
      await tabB.renameProject(project.id, 'Renamed');
      return false;
    });
    try {
      await rememberProject(folder('notes'));
      expect(compare).toHaveBeenCalledTimes(2);
      expect((await listRecentProjects()).map((item) => item.name)).toEqual(['notes', 'Renamed']);
    } finally { tabB.setSettingsBackend(); }
  });
});

describe('IndexedDB connection', () => {
  it('reuses one connection across concurrent reads, writes and registry operations', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    await Promise.all([loadSettings(), savePendingSession({ workspaceName: 'paper', path: 'a.md', source: 'draft', updatedAt: 'now' })]);
    await listRecentProjects();
    await loadSettings();
    expect(open).toHaveBeenCalledOnce();
  });

  it('closes on a version change and reopens after database deletion', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    await loadSettings();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('markroot');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await loadSettings();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('reopens after an unexpected close', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    await loadSettings();
    forceCloseDatabase(open.mock.results[0]!.value.result);
    await loadSettings();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('resets the connection when replacing the backend and IndexedDB factory', async () => {
    const previous = await loadSettings();
    setSettingsBackend();
    vi.stubGlobal('indexedDB', new IDBFactory());
    expect((await loadSettings()).profile.actorId).not.toBe(previous.profile.actorId);
  });

  it('retries opening after an error', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      const request = { error: new Error('Unavailable'), onerror: undefined as (() => void) | undefined };
      queueMicrotask(() => request.onerror?.());
      return request as unknown as IDBOpenDBRequest;
    });
    await expect(loadSettings()).rejects.toThrow('Unavailable');
    await expect(loadSettings()).resolves.toMatchObject({ theme: 'system' });
  });

  it('closes a late connection after a blocked open and lets a later open succeed', async () => {
    const close = vi.fn();
    const request = { result: { close }, onblocked: undefined as (() => void) | undefined, onsuccess: undefined as (() => void) | undefined };
    vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      queueMicrotask(() => request.onblocked?.());
      return request as unknown as IDBOpenDBRequest;
    });
    await expect(loadSettings()).rejects.toThrow('Settings storage is blocked.');
    await loadSettings();
    request.onsuccess?.();
    expect(close).toHaveBeenCalledOnce();
    await expect(loadSettings()).resolves.toMatchObject({ theme: 'system' });
  });
});
