// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, loadRecentWorkspace, loadSettings } from '@markroot/settings';
import { MemoryWorkspace } from '@markroot/workspace';
import { resolveWorkspaceLink } from '../components/preview-utils.js';
import { useWorkspaceDocuments } from './useWorkspaceDocuments.js';
import { deferred, mountHook } from './hook-test-utils.js';

vi.mock('@markroot/settings', async (original) => ({
  ...await original<typeof import('@markroot/settings')>(),
  loadSettings: vi.fn(), loadRecentWorkspace: vi.fn(), workspaceIdFor: vi.fn().mockResolvedValue('folder-id'),
  loadPendingSession: vi.fn().mockResolvedValue(undefined), saveRecentWorkspace: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@markroot/workspace', async (original) => {
  const actual = await original<typeof import('@markroot/workspace')>();
  return { ...actual, ensureDirectoryPermission: vi.fn().mockResolvedValue('granted'),
    FileSystemAccessWorkspace: class extends actual.MemoryWorkspace {
      readonly skippedEntries = new Set<string>();
      constructor() { super({ 'docs/a.md': 'first', 'notes/b q.qmd': 'second', 'image.png': 'bytes' }); }
    },
  };
});

function setup() {
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
    onFolderReset: vi.fn(), onDocumentLoading: vi.fn(), onDocumentOpened: vi.fn(),
  };
  const hook = mountHook(useWorkspaceDocuments, options);
  return { hook, options, connected, authorAtConnect };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadRecentWorkspace).mockResolvedValue({ name: 'test' } as FileSystemDirectoryHandle);
});

describe('workspace restore and links', () => {
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
