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
const sourceText = '# Intro\n\nBody words.\n\n# Results\n\n![Caption](figure.png)';
vi.mock('@markroot/workspace', async (original) => {
  const actual = await original<typeof import('@markroot/workspace')>();
  return { ...actual, ensureDirectoryPermission: vi.fn().mockResolvedValue('granted'), FileSystemAccessWorkspace: class extends actual.MemoryWorkspace { readonly skippedEntries = new Set<string>(); constructor() { super({ 'synthetic.qmd': '# Intro\n\nBody words.\n\n# Results\n\n![Caption](figure.png)' }); } } };
});

it('opens counts from the status bar, counts source selections, toggles captions, navigates H1s and shows build info', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal('requestAnimationFrame', () => 0); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  Object.assign(window, { showDirectoryPicker: vi.fn() });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const source = () => vi.mocked(SourceEditor).mock.lastCall![0];
  const click = async (selector: string) => { const button = host.querySelector<HTMLElement>(selector); expect(button).not.toBeNull(); await act(async () => { button!.click(); }); };
  try {
    await act(async () => { root.render(createElement(App)); });
    expect(host.querySelector('.welcome-footer')?.textContent).toContain('Markroot · build dev');
    await click('button[title="synthetic.qmd"]');
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(host.querySelector('.status-bar')?.textContent).toContain('5 words');
    await click('button[aria-label="Open document statistics"]');
    await act(async () => { await import('./panels/StatisticsPanel.js'); });
    expect(host.querySelector('aside[aria-label="Statistics"]')?.textContent).toContain('Words (incl. citations)');
    const captions = host.querySelector<HTMLInputElement>('.statistics-panel input[type="checkbox"]')!;
    await act(async () => { captions.click(); await vi.advanceTimersByTimeAsync(300); });
    expect(host.querySelector('.status-bar')?.textContent).toContain('4 words');
    await act(async () => { source().onSelection({ from: sourceText.indexOf('Body'), to: sourceText.indexOf('Body') + 10 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const selection = host.querySelector('[aria-label="Selection statistics"]');
    expect(selection?.querySelector('dd')?.textContent).toBe('2');
    await click('button[title="Go to Results"]');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(source().cursorTarget).toBe(sourceText.indexOf('# Results'));
    await click('button[aria-label="Settings"]');
    await act(async () => { await import('./panels/SettingsPanel.js'); });
    expect(host.querySelector('.settings-build')?.textContent).toContain('Markroot · build dev');
  } finally {
    act(() => root.unmount()); host.remove(); delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
    vi.useRealTimers(); vi.unstubAllGlobals();
  }
});
