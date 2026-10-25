import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, deletePendingSession, loadPendingSession, loadSettings, normalizeSettings, savePendingSession, setSettingsBackend, workspaceIdFor, type SettingsBackend } from './index.js';

function memoryBackend(seed: Record<string, unknown> = {}): SettingsBackend & { readonly values: Map<string, unknown> } {
  const values = new Map(Object.entries(seed));
  return {
    values,
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async set<T>(key: string, value: T) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
  };
}
/** Handles compare by an underlying entry, like FileSystemHandle.isSameEntry. */
const handle = (name: string, entry: object) => ({ name, entry, isSameEntry: async (other: { entry?: object }) => other.entry === entry }) as unknown as FileSystemDirectoryHandle;

afterEach(() => setSettingsBackend());

describe('settings', () => {
  it('persists the generated profile so the actor id is stable across launches', async () => {
    const storage = memoryBackend();
    setSettingsBackend(storage);
    const first = await loadSettings();
    expect(storage.values.get('global')).toEqual(first);
    expect((await loadSettings()).profile.actorId).toBe(first.profile.actorId);
  });

  it('falls back field by field for invalid stored values', () => {
    const defaults = defaultSettings();
    const repaired = normalizeSettings({ theme: 'neon', autosave: 'yes', viewerJustified: true, sourceFont: 'comic', viewerFont: 'sans', sourceFontSize: '99', outlineDepth: 4, profile: { actorId: '', displayName: 'Ada', email: 3 } }, defaults);
    expect(repaired).toMatchObject({ theme: 'system', autosave: false, viewerJustified: true, sourceFont: 'mono', viewerFont: 'sans', sourceFontSize: 14, outlineDepth: 2 });
    expect(repaired.profile).toEqual({ actorId: defaults.profile.actorId, displayName: 'Ada' });
    expect(normalizeSettings(null, defaults)).toEqual(defaults);
  });

  it('keys pending sessions by stable workspace id so same-named folders do not collide', async () => {
    setSettingsBackend(memoryBackend());
    const a = handle('paper', {});
    const b = handle('paper', {});
    const idA = await workspaceIdFor(a);
    const idB = await workspaceIdFor(b);
    expect(idA).not.toBe(idB);
    expect(await workspaceIdFor(handle('paper', (a as unknown as { entry: object }).entry))).toBe(idA);
    await savePendingSession({ workspaceName: 'paper', workspaceId: idA, path: 'a.md', source: 'A', baseVersion: '1:1', updatedAt: 'now' });
    expect(await loadPendingSession({ id: idB }, 'a.md')).toBeUndefined();
    expect(await loadPendingSession({ id: idA }, 'a.md')).toMatchObject({ source: 'A', baseVersion: '1:1' });
    await deletePendingSession({ id: idA }, 'a.md');
    expect(await loadPendingSession({ id: idA }, 'a.md')).toBeUndefined();
  });

  it('still reads recovery data saved under the legacy folder-name key', async () => {
    setSettingsBackend(memoryBackend());
    await savePendingSession({ workspaceName: 'paper', path: 'a.md', source: 'old', updatedAt: 'then' });
    expect(await loadPendingSession('paper', 'a.md')).toMatchObject({ source: 'old' });
    expect(await loadPendingSession({ id: 'ws', name: 'paper' }, 'a.md')).toMatchObject({ source: 'old' });
    await deletePendingSession({ id: 'ws', name: 'paper' }, 'a.md');
    expect(await loadPendingSession('paper', 'a.md')).toBeUndefined();
  });
});
