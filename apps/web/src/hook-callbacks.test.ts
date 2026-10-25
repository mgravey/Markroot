// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { workspacePath } from '@markroot/core';
import { DocumentSession } from '@markroot/document';
import { MemoryWorkspace } from '@markroot/workspace';
import { mountHook } from './hooks/hook-test-utils.js';
import { useComments } from './hooks/useComments.js';

it('reports focus reload failures to the latest callback without restarting an open document load', async () => {
  const workspace = new MemoryWorkspace({ 'paper.md': 'Text' });
  const session = new DocumentSession(workspacePath('paper.md'), 'Text');
  const options = {
    workspace, session, snapshot: session.snapshot(), selection: { from: 0, to: 0 }, reviewing: false, git: undefined,
    profile: { actorId: 'author', displayName: 'Author' }, saveDocument: vi.fn(async () => undefined),
    setNotice: vi.fn(), onCommentsWritten: vi.fn(), reportError: vi.fn(),
  };
  const hook = mountHook(useComments, options);
  const latestError = vi.fn();
  const error = new Error('Focus reload failed');
  const load = vi.spyOn(hook.current.store!, 'loadWithIssues').mockRejectedValue(error);
  const request = hook.current.beginLoad();
  try {
    hook.render({ ...options, reportError: latestError });
    expect(hook.current.isCurrentLoad(request)).toBe(true);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(load).toHaveBeenCalledOnce();
    expect(latestError).toHaveBeenCalledExactlyOnceWith(error);
    expect(options.reportError).not.toHaveBeenCalled();
  } finally { hook.unmount(); load.mockRestore(); }
});
