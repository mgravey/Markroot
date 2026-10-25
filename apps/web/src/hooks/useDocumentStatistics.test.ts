// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { workspacePath } from '@markroot/core';
import { DocumentSession } from '@markroot/document';
import type { RenderCitation } from '@markroot/rendering';
import { mountHook } from './hook-test-utils.js';
import { useDocumentStatistics } from './useDocumentStatistics.js';

const citations: readonly RenderCitation[] = [];
afterEach(() => vi.useRealTimers());

it('debounces edits, selection and caption options, cancels stale work and clears closed documents', () => {
  vi.useFakeTimers();
  const session = new DocumentSession(workspacePath('synthetic.qmd'), '# Title\n\nBody words.\n\n![Caption](x.png)');
  const initial = { snapshot: session.snapshot() as ReturnType<typeof session.snapshot> | undefined, selection: { from: 0, to: 0 }, includeCaptions: true };
  const hook = mountHook(({ snapshot, selection, includeCaptions }: typeof initial) => useDocumentStatistics(snapshot, selection, citations, includeCaptions), initial);
  try {
    expect(hook.current).toBeUndefined();
    act(() => { vi.advanceTimersByTime(299); }); expect(hook.current).toBeUndefined();
    act(() => { vi.advanceTimersByTime(1); }); expect(hook.current?.document.textOnly.words).toBe(4);
    const updated = { ...initial, snapshot: session.replace('# Title\n\nDifferent body words.\n\n![Caption](x.png)') };
    hook.render(updated); act(() => { vi.advanceTimersByTime(200); });
    hook.render({ ...updated, includeCaptions: false, selection: { from: 9, to: 23 } });
    act(() => { vi.advanceTimersByTime(200); }); expect(hook.current?.document.textOnly.words).toBe(4);
    act(() => { vi.advanceTimersByTime(100); });
    expect(hook.current?.document.textOnly.words).toBe(4);
    expect(hook.current?.selection?.textOnly.words).toBe(2);
    hook.render({ ...updated, snapshot: undefined }); expect(hook.current).toBeUndefined();
    hook.render({ ...updated, snapshot: new DocumentSession(workspacePath('other.md'), 'Other.').snapshot() });
    expect(hook.current).toBeUndefined();
    hook.unmount(); act(() => { vi.runAllTimers(); });
  } catch (error) { hook.unmount(); throw error; }
});
