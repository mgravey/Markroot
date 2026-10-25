// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { workspacePath } from '@markroot/core';
import { DocumentSession } from '@markroot/document';
import { MemoryWorkspace } from '@markroot/workspace';
import { usePreviewRender } from './usePreviewRender.js';

it('keeps displayed images alive during debounce and revokes URLs after DOM replacement and unmount', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  let nextUrl = 0;
  const host = document.createElement('div');
  document.body.append(host);
  const create = vi.fn(() => `blob:preview-${++nextUrl}`);
  const revoke = vi.fn((url: string) => { expect(host.querySelector(`img[src="${url}"]`)).toBeNull(); });
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  const root = createRoot(host);
  const workspace = new MemoryWorkspace({ 'image.png': 'image' });
  const citations: never[] = [];
  const reportError = vi.fn();
  // Keep snapshot stable across the hook's own state updates.
  const snapshots = new Map<string, ReturnType<DocumentSession['snapshot']>>();
  function StableHarness({ source }: { source: string }) {
    let snapshot = snapshots.get(source);
    if (!snapshot) { snapshot = new DocumentSession(workspacePath('a.md'), source).snapshot(); snapshots.set(source, snapshot); }
    const { rendered } = usePreviewRender({ workspace, previewSnapshot: snapshot, citations, allowRemoteResources: false, baseSource: undefined, reportError });
    return createElement('div', { dangerouslySetInnerHTML: { __html: rendered?.html ?? '' } });
  }
  try {
    act(() => root.render(createElement(StableHarness, { source: '![image](image.png)' })));
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:preview-1');
    act(() => root.render(createElement(StableHarness, { source: '![image](image.png) edited' })));
    expect(revoke).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    act(() => root.render(createElement(StableHarness, { source: 'No image' })));
    expect(host.querySelector('img')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(revoke).toHaveBeenCalledWith('blob:preview-1');
    act(() => root.render(createElement(StableHarness, { source: '![image](image.png)' })));
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    act(() => root.unmount());
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(reportError).not.toHaveBeenCalled();
  } finally { host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
