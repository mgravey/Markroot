// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BasicDocumentEngine, type RenderArtifact } from '@markroot/rendering';
import { App } from './App.js';
import { SourceEditor } from './components/SourceEditor.js';
import { deferred } from './hooks/hook-test-utils.js';

vi.mock('./components/SourceEditor.js', () => ({ SourceEditor: vi.fn(() => null) }));
vi.mock('@markroot/settings', async (original) => {
  const actual = await original<typeof import('@markroot/settings')>();
  return { ...actual, loadSettings: vi.fn().mockResolvedValue(actual.defaultSettings()),
    loadRecentWorkspace: vi.fn().mockResolvedValue({ name: 'test' }), workspaceIdFor: vi.fn().mockResolvedValue('folder-id'),
    loadPendingSession: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('@markroot/workspace', async (original) => {
  const actual = await original<typeof import('@markroot/workspace')>();
  return { ...actual, ensureDirectoryPermission: vi.fn().mockResolvedValue('granted'),
    FileSystemAccessWorkspace: class extends actual.MemoryWorkspace {
      readonly skippedEntries = new Set<string>();
      constructor() { super({ 'a.md': '[Methods](b.qmd#methods%20alias)', 'b.qmd': '# Intro\n\nIntro text.\n\n## Methods\n\nMethods text.' }); }
    },
  };
});

it('opens a workspace fragment through Preview only after the target render is ready, including alias anchors', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^\w-]/g, '\\$&') });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  Object.assign(window, { showDirectoryPicker: vi.fn() });
  const pending = deferred<RenderArtifact>();
  let targetArtifact!: RenderArtifact;
  let targetOffset!: number;
  const render = vi.spyOn(BasicDocumentEngine.prototype, 'render').mockImplementation((request) => {
    const block = request.snapshot.blocks[0]!;
    if (request.snapshot.path === 'a.md') return Promise.resolve({
      revision: 0, engine: 'test', warnings: [], anchors: [],
      // A matching alias in the previous document must never receive target navigation.
      html: `<p data-block-id="${block.id}" data-source-from="0"><span id="methods alias"></span><a href="b.qmd#methods%20alias">Methods</a></p>`,
    });
    const methods = request.snapshot.blocks.find((item) => item.text.includes('## Methods'))!;
    targetOffset = methods.from;
    targetArtifact = { revision: 0, engine: 'test', warnings: [], anchors: [],
      html: `<h2 data-block-id="${methods.id}" data-source-from="${methods.from}" id="sec-methods"><span id="methods alias"></span>Methods</h2>`,
    };
    return pending.promise;
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(App)); });
    const open = host.querySelector<HTMLButtonElement>('button[title="a.md"]')!;
    expect(open).not.toBeNull();
    await act(async () => { open.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    const viewer = () => host.querySelector('.preview')?.shadowRoot;
    const link = viewer()?.querySelector<HTMLAnchorElement>('a');
    expect(link).toBeDefined();
    expect(link).not.toBeNull();
    await act(async () => { link!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(render).toHaveBeenCalledTimes(2);
    expect(vi.mocked(SourceEditor).mock.lastCall?.[0]).toMatchObject({ path: 'b.qmd', cursorTarget: undefined });
    await act(async () => { pending.resolve(targetArtifact); await pending.promise; });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(viewer()?.querySelector('#sec-methods')?.textContent).toBe('Methods');
    expect(vi.mocked(SourceEditor).mock.lastCall?.[0]).toMatchObject({ path: 'b.qmd', cursorTarget: targetOffset });
  } finally {
    act(() => root.unmount()); host.remove(); render.mockRestore();
    delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
    vi.useRealTimers(); vi.unstubAllGlobals();
  }
});
