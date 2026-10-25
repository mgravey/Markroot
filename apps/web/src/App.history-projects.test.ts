// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { historyKey, UndoTree } from '@markroot/history';
import { App } from './App.js';
import { SourceEditor } from './components/SourceEditor.js';

const browser = vi.hoisted(() => ({
  one: { name: 'One', requestPermission: vi.fn().mockResolvedValue('granted') },
  two: { name: 'Two', requestPermission: vi.fn().mockResolvedValue('granted') },
  trees: new Map<string, unknown>(), loads: [] as string[],
}));
vi.mock('./components/SourceEditor.js', () => ({ SourceEditor: vi.fn(() => null) }));
vi.mock('@markroot/history', async (original) => {
  const actual = await original<typeof import('@markroot/history')>();
  return { ...actual, IndexedDBHistoryBackend: class {
    async load(key: string) { browser.loads.push(key); return browser.trees.get(key); }
    async save(key: string, value: unknown) { browser.trees.set(key, structuredClone(value)); }
  } };
});
vi.mock('@markroot/settings', async (original) => {
  const actual = await original<typeof import('@markroot/settings')>();
  const projects = [{ id: 'One', name: 'One', handle: browser.one, lastOpened: '2026-10-25' }, { id: 'Two', name: 'Two', handle: browser.two, lastOpened: '2026-10-25' }];
  return { ...actual, loadSettings: vi.fn().mockResolvedValue({ ...actual.defaultSettings(), autosave: false }),
    loadRecentWorkspace: vi.fn().mockResolvedValue(browser.one), listRecentProjects: vi.fn().mockResolvedValue(projects), rememberProject: vi.fn().mockResolvedValue(undefined),
    workspaceIdFor: vi.fn((handle: FileSystemDirectoryHandle) => Promise.resolve(handle.name)), loadPendingSession: vi.fn().mockResolvedValue(undefined), deletePendingSession: vi.fn().mockResolvedValue(undefined), savePendingSession: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('@markroot/workspace', async (original) => {
  const actual = await original<typeof import('@markroot/workspace')>();
  return { ...actual, ensureDirectoryPermission: vi.fn().mockResolvedValue('granted'), FileSystemAccessWorkspace: class extends actual.MemoryWorkspace {
    readonly skippedEntries = new Set<string>(); constructor(handle: FileSystemDirectoryHandle) { super({ 'a.md': `${handle.name} disk` }); }
  } };
});

it('flushes departing history, isolates project/file keys, restores branches and keeps project shortcuts independent', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('CSS', { escape: (value: string) => value }); vi.stubGlobal('requestAnimationFrame', () => 0); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(window, 'confirm').mockReturnValue(true); Object.assign(window, { showDirectoryPicker: vi.fn() });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const source = () => vi.mocked(SourceEditor).mock.lastCall![0];
  const click = async (selector: string) => { const button = host.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull(); await act(async () => { button!.click(); }); };
  const shortcut = async (key: string, extra: KeyboardEventInit = {}) => { await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...extra })); }); };
  const selectProject = async (name: string) => {
    await shortcut('O', { shiftKey: true }); expect(host.querySelector('[role="menu"]')).not.toBeNull();
    const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((button) => button.textContent === name)!;
    expect(item).toBeDefined(); await act(async () => { item.click(); }); await click('button[title="a.md"]');
  };
  try {
    await act(async () => { root.render(createElement(App)); }); await click('button[title="a.md"]');
    await act(async () => { source().onChange('One first'); }); await shortcut('z');
    await act(async () => { source().onChange('One second'); });
    await selectProject('Two');
    const saved = UndoTree.fromJSON(browser.trees.get(historyKey('One', 'a.md')));
    expect(saved.text).toBe('One second'); expect(saved.siblings()).toHaveLength(2);
    expect(source().value).toBe('Two disk');
    await act(async () => { source().onChange('Two draft'); }); await shortcut('z'); expect(source().value).toBe('Two disk');
    await selectProject('One'); expect(source().value).toBe('One disk');
    await shortcut('y'); expect(source().value).toBe('One second');
    await shortcut('[', { ctrlKey: false, altKey: true, code: 'BracketLeft' }); expect(source().value).toBe('One first');
    expect(browser.loads).toEqual([historyKey('One', 'a.md'), historyKey('Two', 'a.md'), historyKey('One', 'a.md')]);
    expect(browser.two.requestPermission).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount()); host.remove(); delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  }
});
