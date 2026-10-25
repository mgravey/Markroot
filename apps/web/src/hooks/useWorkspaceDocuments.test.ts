// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, listRecentProjects, loadRecentWorkspace, loadSettings, rememberProject, forgetProject } from '@markroot/settings';
import { FileSystemAccessWorkspace, ensureDirectoryPermission, MemoryWorkspace } from '@markroot/workspace';
import { workspacePath } from '@markroot/core';
import { resolveWorkspaceLink } from '../components/preview-utils.js';
import { useComments } from './useComments.js';
import { useWorkspaceDocuments } from './useWorkspaceDocuments.js';
import { deferred, mountHook } from './hook-test-utils.js';

vi.mock('@markroot/settings', async (original) => ({
  ...await original<typeof import('@markroot/settings')>(),
  loadSettings: vi.fn(), loadRecentWorkspace: vi.fn(), listRecentProjects: vi.fn().mockResolvedValue([]),
  rememberProject: vi.fn(async (handle: FileSystemDirectoryHandle) => ({ id: `id-${handle.name}`, name: handle.name, handle, lastOpenedAt: 1 })),
  forgetProject: vi.fn().mockResolvedValue(undefined), workspaceIdFor: vi.fn().mockResolvedValue('folder-id'),
  loadPendingSession: vi.fn().mockResolvedValue(undefined), saveRecentWorkspace: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@markroot/workspace', async (original) => {
  const actual = await original<typeof import('@markroot/workspace')>();
  return { ...actual, ensureDirectoryPermission: vi.fn().mockResolvedValue('granted'),
    FileSystemAccessWorkspace: class extends actual.MemoryWorkspace {
      readonly skippedEntries = new Set<string>();
      constructor() { super({ 'docs/a.md': 'first', 'notes/b q.qmd': 'second', 'docs/c.md': 'third', 'image.png': 'bytes' }); }
    },
  };
});

function setup(realComments = false) {
  const connected = deferred();
  const settingsRef = { current: defaultSettings() };
  const authorAtConnect = vi.fn();
  const repository = { reset: vi.fn(), git: undefined, connect: vi.fn(async () => {
    authorAtConnect(settingsRef.current.profile); connected.resolve(); return undefined;
  }) };
  const comments = { writeBusy: { current: false }, clear: vi.fn(), store: { loadWithIssues: vi.fn().mockResolvedValue({ threads: [], broken: [] }) },
    beginLoad: vi.fn().mockReturnValue(1), isCurrentLoad: vi.fn().mockReturnValue(true), adopt: vi.fn() };
  const options: Parameters<typeof useWorkspaceDocuments>[0] = {
    comments: () => comments as unknown as ReturnType<Parameters<typeof useWorkspaceDocuments>[0]['comments']>,
    repository: () => repository as unknown as ReturnType<Parameters<typeof useWorkspaceDocuments>[0]['repository']>,
    settingsRef, setSettings: vi.fn(), updateSettings: vi.fn(), setNotice: vi.fn(), reportError: vi.fn(),
    saveBeforeSwitch: vi.fn(), onFolderReset: vi.fn(), onDocumentLoading: vi.fn(), onDocumentOpened: vi.fn(),
  };
  const hook = mountHook((props: typeof options) => {
    const documents = useWorkspaceDocuments({ ...props, comments: () => realComments ? commentState : props.comments() });
    const commentState = useComments({
      workspace: documents.workspace, session: documents.session, snapshot: documents.snapshot,
      selection: { from: 0, to: 0 }, reviewing: false, git: undefined, profile: settingsRef.current.profile,
      saveDocument: async () => documents.snapshot, setNotice: props.setNotice, reportError: props.reportError,
      onCommentsWritten: vi.fn(),
    });
    return documents;
  }, options);
  return { hook, options, connected, authorAtConnect };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listRecentProjects).mockResolvedValue([]);
  vi.mocked(ensureDirectoryPermission).mockResolvedValue('granted');
  vi.mocked(loadRecentWorkspace).mockResolvedValue({ name: 'test' } as FileSystemDirectoryHandle);
});

describe('workspace restore and links', () => {
  it('carries encoded fragments through a delayed document load', async () => {
    vi.mocked(loadSettings).mockResolvedValue(defaultSettings());
    const { hook, options, connected } = setup();
    try {
      await act(async () => { await connected.promise; });
      const loaded = deferred();
      vi.mocked(options.onDocumentOpened).mockImplementation(() => loaded.resolve());
      const target = resolveWorkspaceLink('../notes/b%20q.qmd#methods%20and%20results', 'docs/a.md')!;
      const gate = deferred<string>();
      const started = deferred();
      vi.spyOn(hook.current.workspace!, 'readFile').mockImplementationOnce(() => { started.resolve(); return gate.promise; });
      // Preview already supplies the path and fragment as separate callback arguments.
      await act(async () => { hook.current.openWorkspaceLink(target.path, target.fragment); await started.promise; });
      expect(options.onDocumentOpened).not.toHaveBeenCalled();
      await act(async () => { gate.resolve('second'); await loaded.promise; });
      expect(options.onDocumentOpened).toHaveBeenCalledWith('notes/b q.qmd', undefined, expect.any(String), target.fragment);
    } finally { hook.unmount(); }
  });

  it('loads settings before looking up or connecting the restored folder', async () => {
    const settings = deferred<ReturnType<typeof defaultSettings>>();
    vi.mocked(loadSettings).mockReturnValue(settings.promise);
    const { hook, options, connected, authorAtConnect } = setup();
    expect(loadRecentWorkspace).not.toHaveBeenCalled();
    const profile = { actorId: 'test-author', displayName: 'Restored author', email: 'author@example.org' };
    await act(async () => { settings.resolve({ ...defaultSettings(), profile }); await connected.promise; });
    expect(authorAtConnect).toHaveBeenCalledWith(profile);
    expect(options.setSettings).toHaveBeenCalledBefore(vi.mocked(loadRecentWorkspace));
    expect(hook.current.rootName).toBe('test');
    hook.unmount();
  });

  it('does not reconnect a remembered folder after unmount', async () => {
    const settings = deferred<ReturnType<typeof defaultSettings>>();
    vi.mocked(loadSettings).mockReturnValue(settings.promise);
    const { hook, options } = setup();
    hook.unmount();
    settings.resolve(defaultSettings());
    await act(async () => { await settings.promise; });
    expect(options.onFolderReset).not.toHaveBeenCalled();
  });

  it('opens resolved nested links through the real document loader and reports unsupported/missing files', async () => {
    vi.mocked(loadSettings).mockResolvedValue(defaultSettings());
    const { hook, options, connected } = setup();
    await act(async () => { await connected.promise; });
    const loaded = deferred();
    vi.mocked(options.onDocumentOpened).mockImplementation(() => loaded.resolve());
    const read = vi.spyOn(hook.current.workspace as MemoryWorkspace, 'readFile');
    const target = resolveWorkspaceLink('../notes/b%20q.qmd#intro', 'docs/a.md')!;
    await act(async () => { hook.current.openWorkspaceLink(target.path); await loaded.promise; });
    expect(read).toHaveBeenCalledWith('notes/b q.qmd');
    expect(hook.current.snapshot?.path).toBe('notes/b q.qmd');
    act(() => hook.current.openWorkspaceLink('image.png'));
    expect(options.setNotice).toHaveBeenLastCalledWith('image.png cannot be opened in Markroot.');
    act(() => hook.current.openWorkspaceLink('absent.md'));
    expect(options.setNotice).toHaveBeenLastCalledWith('absent.md is not a file in this folder.');
    expect(options.reportError).not.toHaveBeenCalled();
    hook.unmount();
  });
});

describe('document loads with real comment lifecycle effects', () => {
  async function connectedHook() {
    vi.mocked(loadSettings).mockResolvedValue(defaultSettings());
    const result = setup(true);
    await act(async () => { await result.connected.promise; });
    await act(async () => { await result.hook.current.openFile(workspacePath('docs/a.md')); });
    expect(result.hook.current.snapshot?.source).toBe('first');
    return result;
  }

  it('opens B after A while B reads asynchronously', async () => {
    const { hook, options } = await connectedHook();
    const gate = deferred<string>();
    const started = deferred();
    vi.spyOn(hook.current.workspace!, 'readFile').mockImplementationOnce(() => { started.resolve(); return gate.promise; });
    try {
      let opening!: Promise<void>;
      await act(async () => { opening = hook.current.openFile(workspacePath('notes/b q.qmd')); await started.promise; });
      await act(async () => { gate.resolve('second'); await opening; });
      expect(hook.current.snapshot).toMatchObject({ path: 'notes/b q.qmd', source: 'second' });
      expect(options.reportError).not.toHaveBeenCalled();
    } finally { hook.unmount(); }
  });

  it('keeps C open when an earlier B load finishes after it', async () => {
    const { hook } = await connectedHook();
    const gate = deferred<string>();
    const gateC = deferred<string>();
    const started = deferred();
    vi.spyOn(hook.current.workspace!, 'readFile')
      .mockImplementationOnce(() => gate.promise)
      .mockImplementationOnce(() => { started.resolve(); return gateC.promise; });
    try {
      let openingB!: Promise<void>;
      let openingC!: Promise<void>;
      await act(async () => {
        openingB = hook.current.openFile(workspacePath('notes/b q.qmd'));
        openingC = hook.current.openFile(workspacePath('docs/c.md'));
        await started.promise;
      });
      await act(async () => { gateC.resolve('third'); await openingC; });
      await act(async () => { gate.resolve('second'); await openingB; });
      expect(hook.current.snapshot).toMatchObject({ path: 'docs/c.md', source: 'third' });
    } finally { hook.unmount(); }
  });

  it('retains the open document after checkout-style refresh and delayed reload', async () => {
    const { hook } = await connectedHook();
    const path = hook.current.snapshot!.path;
    // Checkout updates the workspace, then App refreshes and reopens the same path.
    await hook.current.workspace!.writeFile(path, 'checked-out version');
    await act(async () => { await hook.current.refreshWorkspace(); });
    const gate = deferred<string>();
    const started = deferred();
    vi.spyOn(hook.current.workspace!, 'readFile').mockImplementationOnce(() => { started.resolve(); return gate.promise; });
    try {
      let reloading!: Promise<void>;
      await act(async () => { reloading = hook.current.openFile(path); await started.promise; });
      await act(async () => { gate.resolve('checked-out version'); await reloading; });
      expect(hook.current.snapshot).toMatchObject({ path, source: 'checked-out version' });
    } finally { hook.unmount(); }
  });
});

const project = (name: string, requestPermission = vi.fn().mockResolvedValue('granted')) => ({
  id: `id-${name}`, name, lastOpenedAt: 1, handle: { name, requestPermission } as unknown as FileSystemDirectoryHandle,
});

async function readyProject() {
  vi.mocked(loadSettings).mockResolvedValue(defaultSettings());
  const result = setup();
  await act(async () => { await result.connected.promise; });
  return result;
}

describe('project selection', () => {
  it('shows remembered projects without requesting permission on startup when access needs a click', async () => {
    const request = vi.fn().mockResolvedValue('granted');
    const recent = project('paper', request);
    vi.mocked(loadSettings).mockResolvedValue(defaultSettings());
    vi.mocked(loadRecentWorkspace).mockResolvedValue(recent.handle);
    vi.mocked(listRecentProjects).mockResolvedValue([recent]);
    vi.mocked(ensureDirectoryPermission).mockResolvedValue('prompt');
    const { hook, options } = setup();
    try {
      await act(async () => {});
      expect(hook.current.workspace).toBeUndefined();
      expect(hook.current.recentProjects).toEqual([recent]);
      expect(ensureDirectoryPermission).toHaveBeenCalledWith(recent.handle);
      expect(request).not.toHaveBeenCalled();
      expect(options.onFolderReset).not.toHaveBeenCalled();
    } finally { hook.unmount(); }
  });

  it('offers removal when the most recent project has disappeared during startup restore', async () => {
    const recent = project('missing');
    vi.mocked(loadSettings).mockResolvedValue(defaultSettings());
    vi.mocked(loadRecentWorkspace).mockResolvedValue(recent.handle);
    vi.mocked(listRecentProjects).mockResolvedValue([recent]);
    const list = vi.spyOn(FileSystemAccessWorkspace.prototype, 'listFiles').mockRejectedValueOnce(new DOMException('Missing', 'NotFoundError'));
    const { hook, options } = setup();
    try {
      await act(async () => {});
      expect(hook.current.workspace).toBeUndefined();
      expect(hook.current.unavailableProject).toBe(recent);
      expect(options.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('unavailable'));
      expect(options.onFolderReset).not.toHaveBeenCalled();
    } finally { list.mockRestore(); hook.unmount(); }
  });

  it('requests permission synchronously, then resets and remembers the selected folder', async () => {
    const { hook, options } = await readyProject();
    const permission = deferred<PermissionState>();
    const request = vi.fn(() => permission.promise);
    const recent = project('next', request);
    try {
      let opening!: Promise<void>;
      act(() => { opening = hook.current.selectProject(recent); expect(request).toHaveBeenCalledWith({ mode: 'readwrite' }); });
      expect(hook.current.rootName).toBe('test');
      await act(async () => { permission.resolve('granted'); await opening; });
      expect(hook.current.rootName).toBe('next');
      expect(hook.current.snapshot).toBeUndefined();
      expect(rememberProject).toHaveBeenCalledWith(recent.handle);
      expect(options.onFolderReset).toHaveBeenCalledTimes(2);
    } finally { hook.unmount(); }
  });

  it('retains the current folder when permission is denied and can forget the unavailable bookmark', async () => {
    const { hook, options } = await readyProject();
    const recent = project('denied', vi.fn().mockResolvedValue('denied'));
    try {
      await act(async () => { await hook.current.selectProject(recent); });
      expect(hook.current.rootName).toBe('test');
      expect(hook.current.unavailableProject).toBe(recent);
      expect(options.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('not granted'));
      await act(async () => { await hook.current.removeProject(recent.id); });
      expect(forgetProject).toHaveBeenCalledWith(recent.id);
      expect(hook.current.unavailableProject).toBeUndefined();
      expect(options.onFolderReset).toHaveBeenCalledOnce();
    } finally { hook.unmount(); }
  });

  it('offers removal for a missing directory without clearing the current document', async () => {
    const { hook, options } = await readyProject();
    await act(async () => { await hook.current.openFile(workspacePath('docs/a.md')); });
    const list = vi.spyOn(FileSystemAccessWorkspace.prototype, 'listFiles').mockRejectedValueOnce(new DOMException('Missing', 'NotFoundError'));
    const recent = project('missing');
    try {
      await act(async () => { await hook.current.selectProject(recent); });
      expect(hook.current.unavailableProject).toBe(recent);
      expect(hook.current.rootName).toBe('test');
      expect(hook.current.snapshot?.source).toBe('first');
      expect(options.onFolderReset).toHaveBeenCalledOnce();
    } finally { list.mockRestore(); hook.unmount(); }
  });

  it('asks before discarding edits, with cancellation leaving the handle untouched', async () => {
    const { hook } = await readyProject();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const request = vi.fn().mockResolvedValue('granted');
    try {
      await act(async () => { await hook.current.openFile(workspacePath('docs/a.md')); });
      act(() => { hook.current.session!.replace('unsaved', 'source'); });
      await act(async () => { await hook.current.selectProject(project('next', request)); });
      expect(confirm).toHaveBeenCalledWith('Discard unsaved edits and open another folder?');
      expect(request).not.toHaveBeenCalled();
      expect(hook.current.snapshot?.source).toBe('unsaved');
      confirm.mockReturnValue(true);
      await act(async () => { await hook.current.selectProject(project('next', request)); });
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(hook.current.rootName).toBe('next');
    } finally { confirm.mockRestore(); hook.unmount(); }
  });

  it('requests permission before autosaving and keeps edits open when saving fails', async () => {
    const { hook, options } = await readyProject();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const request = vi.fn().mockResolvedValue('granted');
    try {
      options.settingsRef.current = { ...options.settingsRef.current, autosave: true };
      await act(async () => { await hook.current.openFile(workspacePath('docs/a.md')); });
      act(() => { hook.current.session!.replace('unsaved', 'source'); });
      vi.mocked(options.saveBeforeSwitch).mockResolvedValue(undefined);
      await act(async () => { await hook.current.selectProject(project('next', request)); });
      expect(request).toHaveBeenCalledBefore(vi.mocked(options.saveBeforeSwitch));
      expect(confirm).not.toHaveBeenCalled();
      expect(hook.current.snapshot?.source).toBe('unsaved');
      expect(hook.current.rootName).toBe('test');
      vi.mocked(options.saveBeforeSwitch).mockImplementation(async () => {
        const current = hook.current.session!.snapshot();
        hook.current.session!.markSaved(current.revision);
        return current;
      });
      await act(async () => { await hook.current.selectProject(project('next', request)); });
      expect(hook.current.rootName).toBe('next');
    } finally { confirm.mockRestore(); hook.unmount(); }
  });

  it('lets the most recent selection win over a delayed permission result', async () => {
    const { hook } = await readyProject();
    const permission = deferred<PermissionState>();
    try {
      let earlier!: Promise<void>;
      act(() => { earlier = hook.current.selectProject(project('earlier', vi.fn(() => permission.promise))); });
      await act(async () => { await hook.current.selectProject(project('latest')); });
      await act(async () => { permission.resolve('granted'); await earlier; });
      expect(hook.current.rootName).toBe('latest');
    } finally { hook.unmount(); }
  });
});
