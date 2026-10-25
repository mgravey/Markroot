import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listRecentProjects, rememberProject, workspaceIdFor } from './index.js';

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
});
