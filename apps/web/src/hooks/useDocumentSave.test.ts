// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { workspacePath } from '@markroot/core';
import { DocumentSession } from '@markroot/document';
import { FileSystemAccessWorkspace, MemoryWorkspace, type GuardedWorkspace } from '@markroot/workspace';
import { defaultSettings, deletePendingSession } from '@markroot/settings';
import type { IsomorphicGitRepository } from '@markroot/git';
import { ChromeCommitMessageGenerator } from '../commit-message.js';
import { useAiCommit } from './useAiCommit.js';
import { useDocumentSave } from './useDocumentSave.js';
import { deferred, mountHook } from './hook-test-utils.js';

vi.mock('@markroot/settings', async (original) => ({ ...await original<typeof import('@markroot/settings')>(), deletePendingSession: vi.fn().mockResolvedValue(undefined) }));

async function setup(workspace: GuardedWorkspace = new MemoryWorkspace({ 'a.md': 'original', 'b.md': 'other' })) {
  vi.clearAllMocks();
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
  it('preserves the guarded-write baseline after rejecting a clean save with unchanged disk metadata', async () => {
    let disk = 'first edit';
    const file = {
      async getFile() {
        const bytes = new TextEncoder().encode(disk);
        return { size: bytes.length, lastModified: 1000, arrayBuffer: async () => bytes.slice().buffer };
      },
      async createWritable() {
        return { write: async (bytes: Uint8Array) => { disk = new TextDecoder().decode(bytes); }, close: async () => undefined, abort: async () => undefined };
      },
    };
    const workspace = new FileSystemAccessWorkspace({ name: 'test', getFileHandle: async () => file } as unknown as FileSystemDirectoryHandle);
    const path = workspacePath('a.md');
    await workspace.readFile(path); // Establish the real workspace's guarded-write baseline.
    const { session, options, hook, write } = await setup(workspace);
    write.mockRestore();
    session.markSaved(session.snapshot().revision);
    disk = 'disk edits'; // Same size and timestamp as the editor's saved source.
    try {
      expect(await hook.current()).toBeUndefined();
      session.replace('my next edit');
      expect(await hook.current()).toBeUndefined();
      expect(options.reportError).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONFLICT' }));
      expect(disk).toBe('disk edits');
    } finally { hook.unmount(); }
  });

  it('returns an unchanged clean snapshot without rewriting the file', async () => {
    const { workspace, session, options, hook, write } = await setup();
    await workspace.writeFile(session.path, session.snapshot().source);
    options.fileVersionRef.current = (await workspace.stat(session.path)).version;
    session.markSaved(session.snapshot().revision);
    try {
      expect(await hook.current()).toMatchObject({ path: 'a.md', source: 'first edit', dirty: false });
      expect(write).not.toHaveBeenCalled();
      expect(options.setNotice).not.toHaveBeenCalled();
    } finally { hook.unmount(); }
  });

  it.each(['document switch', 'edit'])('discards clean-save verification completed after a %s', async (change) => {
    const { workspace, session, options, hook } = await setup();
    session.markSaved(session.snapshot().revision);
    const stat = await workspace.stat(session.path);
    const gate = deferred<typeof stat>();
    const started = deferred();
    vi.spyOn(workspace, 'stat').mockImplementationOnce(() => { started.resolve(); return gate.promise; });
    const save = hook.current();
    await started.promise;
    if (change === 'document switch') {
      const next = new DocumentSession(workspacePath('b.md'), 'other');
      options.documentRequest.current += 1;
      options.activeSession.current = next;
      hook.render({ ...options, session: next });
    } else session.replace('typed during verification');
    try {
      gate.resolve(stat);
      expect(await save).toBeUndefined();
      expect(options.setNotice).not.toHaveBeenCalled();
      expect(options.reportError).not.toHaveBeenCalled();
    } finally { hook.unmount(); }
  });

  it.each([false, true])('aborts AI commit preparation for a clean document changed on disk (unchanged stat: %s)', async (sameVersion) => {
    const { workspace, session, options, hook } = await setup();
    session.markSaved(session.snapshot().revision);
    await workspace.writeFile(session.path, 'first edit');
    const originalStat = await workspace.stat(session.path);
    options.fileVersionRef.current = originalStat.version;
    await workspace.writeFile(session.path, 'disk edits');
    if (sameVersion) vi.spyOn(workspace, 'stat').mockResolvedValue(originalStat);
    const prepareCommitCandidate = vi.fn().mockResolvedValue(undefined);
    const prepared = { destroy: vi.fn(), generate: vi.fn() };
    const prepare = vi.spyOn(ChromeCommitMessageGenerator.prototype, 'prepare').mockResolvedValue(prepared);
    const settings = defaultSettings();
    const ai = mountHook(useAiCommit, {
      git: { prepareCommitCandidate } as unknown as IsomorphicGitRepository,
      settings: { ...settings, aiCommitSuggestions: true, profile: { ...settings.profile, email: 'author@example.org' } },
      updateSettings: vi.fn(), commentStore: undefined, saveDocument: hook.current,
      setNotice: options.setNotice, openGitPanel: vi.fn(), onCommitted: vi.fn(),
    });
    try {
      await act(async () => { await ai.current.explicitSave(); });
      expect(prepareCommitCandidate).not.toHaveBeenCalled();
      expect(options.setNotice).toHaveBeenCalledWith('a.md changed outside Markroot. Reload or compare before saving.');
      expect(ai.current.commitDialog).toBeUndefined();
      expect(prepared.destroy).toHaveBeenCalledOnce();
      expect(session.snapshot().source).toBe('first edit');
      expect(await workspace.readFile(session.path)).toBe('disk edits');
    } finally { ai.unmount(); hook.unmount(); prepare.mockRestore(); }
  });

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
