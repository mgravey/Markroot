// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { App } from './App.js';
import { SourceEditor } from './components/SourceEditor.js';

vi.mock('./components/SourceEditor.js', () => ({ SourceEditor: vi.fn(() => null) }));
vi.mock('@markroot/history', async (original) => {
  const actual = await original<typeof import('@markroot/history')>();
  return { ...actual, IndexedDBHistoryBackend: class { async load() { return undefined; } async save() {} } };
});
vi.mock('@markroot/settings', async (original) => {
  const actual = await original<typeof import('@markroot/settings')>();
  return { ...actual, loadSettings: vi.fn().mockResolvedValue(actual.defaultSettings()), loadRecentWorkspace: vi.fn().mockResolvedValue({ name: 'test' }), listRecentProjects: vi.fn().mockResolvedValue([]), rememberProject: vi.fn().mockResolvedValue(undefined), workspaceIdFor: vi.fn().mockResolvedValue('folder-id'), loadPendingSession: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('@markroot/workspace', async (original) => {
  const actual = await original<typeof import('@markroot/workspace')>();
  return { ...actual, ensureDirectoryPermission: vi.fn().mockResolvedValue('granted'), FileSystemAccessWorkspace: class extends actual.MemoryWorkspace { readonly skippedEntries = new Set<string>(); constructor() { super({ 'a.md': 'root' }); } } };
});

it('previews history read-only with source/rendered diffs, compares two versions and switches reversibly', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal('requestAnimationFrame', () => 0); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  Object.assign(window, { showDirectoryPicker: vi.fn() });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const source = () => vi.mocked(SourceEditor).mock.lastCall![0];
  const click = async (selector: string) => { const button = host.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull(); await act(async () => { button!.click(); }); };
  const shortcut = async (key: string) => { await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })); }); };
  try {
    await act(async () => { root.render(createElement(App)); }); await click('button[title="a.md"]');
    await act(async () => { source().onChange('first'); }); await shortcut('z'); expect(source().value).toBe('root');
    await act(async () => { source().onChange('second'); }); await click('button[aria-label="History"]');
    await act(async () => { await import('./panels/HistoryPanel.js'); });
    expect(host.querySelector('[role="tree"]')).not.toBeNull(); expect(host.textContent).toContain('Branch 2 of 2');
    await click('[data-history-id="h1"]');
    expect(source()).toMatchObject({ readOnly: true, value: 'first', comparisonBase: 'second', showTrackChanges: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    const viewer = host.querySelector('.preview')?.shadowRoot;
    expect(viewer?.querySelector('.render-track-insert')?.textContent).toBe('first');
    expect(viewer?.querySelector('.render-track-delete')?.textContent).toBe('second');
    const compare = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Compare with…')!;
    await act(async () => { compare.click(); }); await click('[data-history-id="h0"]');
    expect(source().comparisonBase).toBe('root'); expect(source().value).toBe('first');
    const switchVersion = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Switch to this version')!;
    await act(async () => { switchVersion.click(); }); expect(source()).toMatchObject({ readOnly: false, value: 'first' });
    await shortcut('z'); expect(source().value).toBe('second');
    const current = host.querySelector<HTMLButtonElement>('[aria-current="true"]')!; current.focus();
    act(() => { current.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(host.querySelector('[data-history-id="h1"]'));
  } finally {
    act(() => root.unmount()); host.remove(); delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
    vi.useRealTimers(); vi.unstubAllGlobals();
  }
});
