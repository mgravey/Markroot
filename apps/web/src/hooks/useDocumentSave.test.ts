// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { workspacePath } from '@markroot/core';
import { DocumentSession } from '@markroot/document';
import { MemoryWorkspace } from '@markroot/workspace';
import { deletePendingSession } from '@markroot/settings';
import { useDocumentSave } from './useDocumentSave.js';
import { deferred, mountHook } from './hook-test-utils.js';

vi.mock('@markroot/settings', () => ({ deletePendingSession: vi.fn().mockResolvedValue(undefined) }));

async function setup() {
  vi.clearAllMocks();
  const workspace = new MemoryWorkspace({ 'a.md': 'original', 'b.md': 'other' });
  const path = workspacePath('a.md');
  const session = new DocumentSession(path, 'original');
  session.replace('first edit');
  const options: Parameters<typeof useDocumentSave>[0] = {
    workspace, session, activeSession: { current: session }, git: undefined,
    commentState: { legacy: { current: [] }, store: undefined, adopt: vi.fn() },
    documentRequest: { current: 1 }, fileVersionRef: { current: (await workspace.stat(path)).version },
    pendingWorkspace: 'test', setFileVersion: vi.fn(), setNotice: vi.fn(), reportError: vi.fn(),
    onCitationsChanged: vi.fn().mockResolvedValue(undefined), refreshStatus: vi.fn(),
  };
  const gate = deferred();
  const started = deferred();
  const original = workspace.writeFileGuarded.bind(workspace);
  const write = vi.spyOn(workspace, 'writeFileGuarded').mockImplementationOnce(async (...args) => {
    started.resolve(); await gate.promise; return original(...args);
  });
  const hook = mountHook(useDocumentSave, options);
  return { workspace, session, options, hook, gate, started, write };
}

describe('document saves', () => {
  it('serializes overlapping saves and uses the version written by the preceding save', async () => {
    const { workspace, session, options, hook, gate, started, write } = await setup();
    const first = hook.current();
    await started.promise;
    session.replace('second edit');
    const second = hook.current();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => { gate.resolve(); await Promise.all([first, second]); });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![2]).not.toBe(write.mock.calls[0]![2]);
    expect(await workspace.readFile(session.path)).toBe('second edit');
    expect(session.snapshot().dirty).toBe(false);
    expect(options.reportError).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('keeps edits typed during a save dirty and retains their recovery draft', async () => {
    const { session, options, hook, gate, started } = await setup();
    const save = hook.current();
    await started.promise;
    session.replace('typed while writing');
    await act(async () => { gate.resolve(); await save; });
    expect(session.snapshot()).toMatchObject({ dirty: true, source: 'typed while writing', savedRevision: 1 });
    expect(options.reportError).not.toHaveBeenCalled();
    expect(deletePendingSession).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('discards queued old saves and completion effects when documents switch mid-save', async () => {
    const { options, hook, gate, started, write } = await setup();
    const first = hook.current();
    await started.promise;
    const queued = hook.current();
    const next = new DocumentSession(workspacePath('b.md'), 'other');
    options.documentRequest.current += 1;
    options.activeSession.current = next;
    options.fileVersionRef.current = 'new-document-version';
    hook.render({ ...options, session: next });
    await act(async () => {
      gate.resolve();
      expect(await first).toBeUndefined();
      expect(await queued).toBeUndefined();
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(options.fileVersionRef.current).toBe('new-document-version');
    expect(options.setFileVersion).not.toHaveBeenCalled();
    expect(options.setNotice).not.toHaveBeenCalled();
    expect(next.snapshot()).toMatchObject({ savedRevision: 0, dirty: false });
    hook.unmount();
  });
});
