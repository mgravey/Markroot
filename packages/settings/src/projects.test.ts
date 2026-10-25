import { afterEach, describe, expect, it } from 'vitest';
import { forgetProject, listRecentProjects, loadPendingSession, loadRecentWorkspace, rememberProject, renameProject, savePendingSession, saveRecentWorkspace, setSettingsBackend, workspaceIdFor, type SettingsBackend } from './index.js';

function memoryBackend(seed: Record<string, unknown> = {}): SettingsBackend & { values: Map<string, unknown> } {
  const values = new Map(Object.entries(seed));
  return { values, async get<T>(key: string) { return values.get(key) as T | undefined; }, async set<T>(key: string, value: T) { values.set(key, value); }, async delete(key: string) { values.delete(key); } };
}
const folder = (name: string, entry = {}) => ({ name, entry, async isSameEntry(other: { entry: object }) { await Promise.resolve(); return other.entry === entry; } }) as unknown as FileSystemDirectoryHandle;
afterEach(() => setSettingsBackend());

describe('recent projects', () => {
  it('migrates the legacy folder once, retaining its workspace identity and compatibility APIs', async () => {
    const handle = folder('paper');
    const storage = memoryBackend({ 'recent-workspace': handle, 'workspace-ids': [{ id: 'existing', handle }] });
    setSettingsBackend(storage);
    expect(await listRecentProjects()).toEqual([{ id: 'existing', name: 'paper', handle, lastOpenedAt: expect.any(Number) }]);
    expect(await loadRecentWorkspace()).toBe(handle);
    expect(storage.values.has('recent-workspace')).toBe(false);
    await forgetProject('existing');
    expect(await listRecentProjects()).toEqual([]);
    expect(await loadRecentWorkspace()).toBeUndefined();
    await saveRecentWorkspace(handle);
    expect((await listRecentProjects())[0]?.id).toBe('existing');
  });

  it('serializes concurrent remembers and identity assignments, deduplicating equivalent handles', async () => {
    const storage = memoryBackend();
    setSettingsBackend(storage);
    const entry = {};
    const [first, second, same, id] = await Promise.all([
      rememberProject(folder('paper', entry)), rememberProject(folder('paper')), rememberProject(folder('paper', entry)), workspaceIdFor(folder('paper', entry)),
    ]);
    expect(same.id).toBe(first.id);
    expect(id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect((await listRecentProjects()).map((item) => item.id)).toEqual([first.id, second.id]);
    expect(storage.values.get('workspace-ids')).toHaveLength(2);
  });

  it('moves opened projects first, caps the list at twelve, and preserves display labels', async () => {
    setSettingsBackend(memoryBackend());
    const handles = Array.from({ length: 14 }, (_, index) => folder(`paper-${index}`));
    const first = await rememberProject(handles[0]!);
    await renameProject(first.id, '  My manuscript  ');
    expect((await rememberProject(handles[0]!)).name).toBe('My manuscript');
    await renameProject(first.id, '');
    expect((await listRecentProjects())[0]?.name).toBe('paper-0');
    for (const handle of handles.slice(1)) await rememberProject(handle);
    expect((await listRecentProjects()).map((item) => item.name)).toEqual(handles.slice(2).reverse().map((handle) => handle.name));
    await rememberProject(handles[8]!);
    expect(await listRecentProjects()).toHaveLength(12);
    expect((await listRecentProjects())[0]?.name).toBe('paper-8');
  });

  it('forgets only the bookmark, retaining drafts and stable identity for a later reopening', async () => {
    setSettingsBackend(memoryBackend());
    const handle = folder('paper');
    const project = await rememberProject(handle);
    await savePendingSession({ workspaceId: project.id, workspaceName: 'paper', path: 'a.md', source: 'draft', updatedAt: 'now' });
    await forgetProject(project.id);
    expect(await listRecentProjects()).toEqual([]);
    expect(await loadPendingSession({ id: project.id }, 'a.md')).toMatchObject({ source: 'draft' });
    expect((await rememberProject(handle)).id).toBe(project.id);
  });
});
